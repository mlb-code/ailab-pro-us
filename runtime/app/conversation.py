"""Conversation engine: guard -> brain -> tool executor -> reply check, for one channel turn.

Channel-agnostic: the voice flow (B3) and SMS flow (B4) wrap `Engine.handle()` in TwiML and
persist `Convo.transcript` / outcome into `calls` / `sms_messages`. Owner alerts are returned
as `actions` for the notifier (B6) to deliver; nothing here sends anything.

Rate-limit state, spend, monthly usage and every conversation (Claude history, offered slots,
flags, transcript) are persisted through `StateStore` (table `runtime_state`, key
`convo:<tenant>:<channel>:<convo_id>`; in-memory fallback only in sim), so a restart or another
worker continues the same conversation. The voice/SMS layers also write transcripts and outcomes
to `calls` / `sms_messages`. All row access goes through `store.for_tenant()`.
"""
from __future__ import annotations

import re

import hashlib
import logging
import time
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from . import appointments as appt
from . import dispatch, guard
from .brain import run_turn
from .llm import LLMClient
from .settings import Settings
from .speech import TOOL_FILLERS, Speaker
from .store import StateStore, Store, StoreError, TenantStore
from .tenants import TenantRecord, sms_business_name
from .usage import UsageMeter

log = logging.getLogger("rt.conversation")

FALLBACK_TEXT = ("Sorry, I'm having trouble on my end. I've passed your message to the team "
                 "and someone will get back to you soon.")
PAUSED_TEXT = "Thanks for reaching out. Our team will get back to you soon."
REPROMPT_TEXT = "Sorry, I didn't catch that. Could you say that again?"
_QUESTION = re.compile(r"[^.?!]*\?")


def reprompt_for(transcript: list[dict]) -> str:
    """Silence reprompt that repeats the assistant's last open question (e.g. the ZIP), so a caller who pauses
    to look something up is not sent back to "what can we help you with?"; generic ask when there was none."""
    for turn in reversed(transcript or []):
        if turn.get("who") == "assistant":
            qs = _QUESTION.findall(turn.get("text") or "")
            if qs and qs[-1].strip():
                return "Sorry, I didn't catch that. " + qs[-1].strip()
            break
    return REPROMPT_TEXT
SILENT_END_TEXT = "Sorry, I can't hear you. Someone from our team will call you back. Goodbye."
CONFIRMED_DANGER_TEXT = guard.CONFIRMED_DANGER_TEXT
URGENT_DIAL_TEXT = "This sounds urgent. I'm connecting you with our on-call technician now."
OUTCOME_RANK = {"booked": 6, "emergency": 5, "handoff": 4, "message": 3, "spam": 2, "abandoned": 1}


@dataclass
class Convo:
    tenant_id: str
    channel: str
    contact: str
    convo_id: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    transcript: list[dict[str, str]] = field(default_factory=list)
    offered: dict[str, dict] = field(default_factory=dict)
    outcome: str | None = None
    booking: dict | None = None
    message: dict | None = None
    urgency: str = "normal"
    silent_in_a_row: int = 0
    ever_spoke: bool = False
    ended: bool = False
    awaiting_safety: bool = False
    alerted: set[str] = field(default_factory=set)
    cost_usd: float = 0.0
    claude_calls: int = 0
    prior: str = ""          # what we sent before the customer wrote (e.g. the missed-call text-back)
    meta: dict[str, Any] = field(default_factory=dict)  # channel data: call row id, turn timings, flags
    collected: dict[str, str] = field(default_factory=dict)  # name/address/job_type/zip seen in any tool call so far

    def collect(self, **details: Any) -> None:
        """Remember customer details from a tool call (even one that failed), so a hang-up or a message
        after them still reaches the owner with the name, address and job type already given."""
        for k, v in details.items():
            v = str(v or "").strip()
            if v:
                self.collected[k] = v[:200]

    def set_outcome(self, outcome: str) -> None:
        if OUTCOME_RANK.get(outcome, 0) > OUTCOME_RANK.get(self.outcome or "", 0):
            self.outcome = outcome

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["alerted"] = sorted(self.alerted)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Convo":
        names = {f.name for f in fields(cls)}
        c = cls(**{k: v for k, v in d.items() if k in names})
        c.alerted = set(c.alerted or ())
        return c


def _backing(c: "Convo") -> dict[str, bool]:
    """What the reply check may let through: a booking made or moved here, a move/cancel a tool really did."""
    change = (c.meta or {}).get("appt") or {}
    out = {"booked": c.booking is not None or change.get("kind") == "rescheduled"}
    if change:  # passed only when true: callers of check_reply that predate it keep working
        out["changed"] = True
    return out


@dataclass
class TurnResult:
    reply: str
    end: bool = False
    outcome: str | None = None
    actions: list[dict[str, Any]] = field(default_factory=list)
    guard: list[str] = field(default_factory=list)
    claude_calls: int = 0
    cost_usd: float = 0.0
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    llm_ms: float = 0.0
    streamed: bool = False             # voice: the reply already went to `on_sentence`, sentence by sentence
    first_sentence_ms: float | None = None   # voice: turn start -> first sentence handed to TTS
    first_sentence_llm_ms: float | None = None  # ... of which Claude time (server time = the difference)
    timings: list[dict[str, Any]] = field(default_factory=list)


MEMORY_CONVOS = 500  # in-process cache size; the state store is the source of truth


class Engine:
    def __init__(self, store: Store, llm: LLMClient, calendar: Any, settings: Settings,
                 state: StateStore | None = None):
        self.store = store
        self.llm = llm
        self.calendar = calendar
        self.settings = settings
        self.state = state or StateStore(store, memory_fallback=settings.is_sim)
        self.usage = UsageMeter(self.state)
        self.convos: dict[tuple[str, str, str], Convo] = {}

    # --- persisted state (runtime_state) ----------------------------------------------------
    @staticmethod
    def _who(contact: str) -> str:
        return hashlib.sha256(contact.encode()).hexdigest()[:16]

    def _limit_key(self, tenant: TenantRecord, contact: str) -> str:
        return f"limit:{tenant.id}:{self._who(contact)}"

    def limit_state(self, tenant: TenantRecord, contact: str) -> guard.LimitState:
        raw = self.state.get(self._limit_key(tenant, contact))
        if not raw:
            return guard.LimitState()
        ts = lambda v: datetime.fromisoformat(v) if v else None  # noqa: E731
        return guard.LimitState(reply_times=tuple(datetime.fromisoformat(t) for t in raw["reply_times"]),
                                day=raw["day"], episodes=raw["episodes"], last_over_at=ts(raw["last_over_at"]),
                                muted_until=ts(raw["muted_until"]))

    def save_limit_state(self, tenant: TenantRecord, contact: str, st: guard.LimitState) -> None:
        iso = lambda v: v.isoformat() if v else None  # noqa: E731
        self.state.put(self._limit_key(tenant, contact), {
            "reply_times": [t.isoformat() for t in st.reply_times], "day": st.day, "episodes": st.episodes,
            "last_over_at": iso(st.last_over_at), "muted_until": iso(st.muted_until)}, tenant.id)

    def tenant_spend(self, tenant: TenantRecord, day: str) -> float:
        return float(self.state.get(f"spend:{tenant.id}:{day}", 0) or 0)

    def global_spend(self, day: str) -> float:
        return float(self.state.get(f"spend:global:{day}", 0) or 0)

    def add_spend(self, tenant: TenantRecord, day: str, usd: float) -> None:
        if usd:
            self.state.incr(f"spend:{tenant.id}:{day}", usd, tenant.id)
            self.state.incr(f"spend:global:{day}", usd)

    # ------------------------------------------------------------------------------------------
    @staticmethod
    def _convo_key(tenant_id: str, channel: str, convo_id: str) -> str:
        return f"convo:{tenant_id}:{channel}:{convo_id}"

    def convo(self, tenant: TenantRecord, channel: str, contact: str, convo_id: str) -> Convo:
        """The conversation, from the state store first (survives restarts, shared by workers)."""
        key = (tenant.id, channel, convo_id)
        raw = self.state.get(self._convo_key(tenant.id, channel, convo_id))
        if raw:
            self.convos[key] = Convo.from_dict(raw)
        elif key not in self.convos:
            self.convos[key] = Convo(tenant.id, channel, contact, convo_id)
        if len(self.convos) > MEMORY_CONVOS:
            self.convos.pop(next(iter(self.convos)))
        return self.convos[key]

    def find_convo(self, tenant: TenantRecord, channel: str, convo_id: str) -> Convo | None:
        raw = self.state.get(self._convo_key(tenant.id, channel, convo_id))
        return Convo.from_dict(raw) if raw else self.convos.get((tenant.id, channel, convo_id))

    def save_convo(self, c: Convo) -> None:
        self.convos[(c.tenant_id, c.channel, c.convo_id)] = c
        self.state.put(self._convo_key(c.tenant_id, c.channel, c.convo_id), c.to_dict(), c.tenant_id)

    def close(self, tenant: TenantRecord, c: Convo, outcome: str, alert_kind: str | None, summary: str,
              force: bool = False) -> list[dict[str, Any]]:
        """End a conversation from outside a customer turn (hang-up, caps, unanswered dial)."""
        actions: list[dict[str, Any]] = []
        if force:
            c.outcome = outcome
        else:
            c.set_outcome(outcome)
        if alert_kind:
            if outcome == "message" and not c.message and not c.booking:
                c.message = {"summary": summary[:300], "urgency": c.urgency, **self._details(c)}
            self._alert(c, actions, alert_kind, summary)
        c.ended = True
        self.save_convo(c)
        return actions

    def note_outbound(self, tenant: TenantRecord, channel: str, contact: str, convo_id: str, text: str,
                      prior: str = "") -> Convo:
        """Record a message we sent proactively (text-back, reminder) in the thread."""
        c = self.convo(tenant, channel, contact, convo_id)
        c.transcript.append({"who": "assistant", "text": text})
        if prior:
            c.prior = prior
        self.save_convo(c)
        return c

    @staticmethod
    def local_day(tenant: TenantRecord, now: datetime) -> str:
        return now.astimezone(ZoneInfo(tenant.config.business.timezone)).date().isoformat()

    @staticmethod
    def _details(c: Convo, **given: Any) -> dict[str, str | None]:
        """name / address / job_type for a message: what this tool call gave, else what earlier calls collected."""
        out: dict[str, str | None] = {}
        for k in ("name", "address", "job_type"):
            v = str(given.get(k) or "").strip() or c.collected.get(k) or ""
            out[k] = v[:200] or None
        return out

    def _alert(self, c: Convo, actions: list, kind: str, summary: str) -> None:
        if kind in c.alerted:
            return
        c.alerted.add(kind)
        actions.append({"type": "alert", "kind": kind, "summary": summary, "urgency": c.urgency,
                        "contact": c.contact, "channel": c.channel, "convo_id": c.convo_id})

    def _usage(self, tenant: TenantRecord, ts: TenantStore, kind: str, amount: float, now: datetime,
               actions: list) -> None:
        for a in self.usage.record(tenant, kind, amount, now):
            actions.append(a)
            ts.log_event("usage_threshold", {k: a[k] for k in ("kind", "usage_kind", "used", "included")})

    # ------------------------------------------------------------------------------------------
    def handle(self, tenant: TenantRecord, channel: str, contact: str, text: str, convo_id: str,
               now: datetime, num_media: int = 0, on_sentence: Any = None) -> TurnResult:
        """One customer turn. Voice + `on_sentence`: each guarded sentence of Claude's reply is handed
        to `on_sentence` as soon as it is complete (`TurnResult.streamed`); fixed replies are returned only."""
        t_start = time.perf_counter()
        cfg = tenant.config
        ts = self.store.for_tenant(tenant.id)
        c = self.convo(tenant, channel, contact, convo_id)
        actions: list[dict[str, Any]] = []
        notes: list[str] = []
        text = text or ""
        day = self.local_day(tenant, now)
        sms = channel == "sms"
        if sms:
            self._usage(tenant, ts, "sms", guard.sms_segments(text) or (1 if num_media else 0), now, actions)

        def done(reply: str, end: bool = False, outcome: str | None = None, counted: bool = True,
                 **kw: Any) -> TurnResult:
            if outcome:
                c.set_outcome(outcome)
            c.ended = c.ended or end
            if reply:
                c.transcript.append({"who": "assistant", "text": reply})
                if counted and (sms or kw.get("claude_calls")):
                    self.save_limit_state(tenant, contact, guard.record_reply(self.limit_state(tenant, contact), now, day))
                if sms:
                    self._usage(tenant, ts, "sms", guard.sms_segments(reply), now, actions)
            if notes:
                ts.log_event("guard", {"convo_id": convo_id, "channel": channel, "rules": notes})
            self.save_convo(c)
            return TurnResult(reply=reply, end=c.ended, outcome=c.outcome, actions=actions, guard=notes, **kw)

        def gate() -> TurnResult | None:
            """Per-number cap on replies (every reply on SMS; Claude replies on voice)."""
            st = self.limit_state(tenant, contact)
            reason = guard.rate_reason(st, now, cfg.guard.max_replies_10min, cfg.guard.max_replies_day, day)
            if not reason:
                return None
            decision, st = guard.register_over_limit(st, now, day)
            self.save_limit_state(tenant, contact, st)
            notes.append(f"rate:{reason}:{decision}")
            if decision == "first":
                self._alert(c, actions, "rate_limit", "Number went over the reply limit")
                return done(guard.LIMIT_TEXT, outcome="message", counted=False)
            if decision == "mute":
                actions.append({"type": "alert", "kind": "muted", "summary": "Number muted for 24 hours",
                                "contact": contact, "channel": channel, "convo_id": convo_id})
            return done("")

        # 8: blocklist -> no reply at all
        if guard.is_blocked(contact, cfg):
            notes.append("blocklist")
            return done("", end=True, outcome="spam")

        kw = guard.sms_keyword(text) if sms else None
        if kw == "start" and not ts.is_opted_out(contact):
            kw = None  # "yes" / "start" from a subscribed number is just a normal message
        if kw == "stop":  # the only reply that is never rate limited
            notes.append("stop")
            new = ts.opt_out(contact, "sms", text)
            if c.meta.get("sms_consent") == "asked":
                c.meta["sms_consent"] = "no"
            # exactly one confirmation (47 C.F.R. 64.1200(a)(12)); a repeat STOP gets nothing
            return done(guard.stop_confirmation(sms_business_name(cfg), cfg.business.main_phone) if new else "", end=True,
                        counted=False)
        if kw == "start":
            notes.append("start")
            ts.opt_in(contact, "sms", text)
        elif sms and ts.is_opted_out(contact):
            notes.append("opted_out")
            return done("", end=True)

        if sms and (blocked := gate()):
            return blocked
        if kw == "start":
            return done(guard.start_confirmation(sms_business_name(cfg)))
        if not tenant.active:
            notes.append("tenant_paused")
            return done(PAUSED_TEXT, end=True)

        if sms:
            if kw == "help":
                notes.append("help")
                return done(guard.help_text(sms_business_name(cfg), cfg.business.main_phone))
            fixed, reason = guard.inbound_fixed_reply(text, num_media)
            if fixed:
                notes.append(reason)
                return done(fixed)
            if c.meta.get("booking_prompt") and self.settings.sms_booking_replies and cfg.booking.self_service:
                fixed = self._booking_text_reply(tenant, ts, c, text, now, actions, notes)
                if fixed:
                    c.ever_spoke = True
                    c.transcript.append({"who": "customer", "text": text})
                    return done(fixed)
        elif not text.strip():
            c.silent_in_a_row += 1
            policy = guard.silence_policy(c.silent_in_a_row, c.ever_spoke)
            notes.append(f"silence:{policy}")
            if policy == "reprompt":
                return done(reprompt_for(c.transcript))
            if policy == "end_spam":
                return done("", end=True, outcome="spam")
            self._alert(c, actions, "lead", "Caller went silent before finishing")
            return done(SILENT_END_TEXT, end=True, outcome="message")
        else:
            c.silent_in_a_row = 0

        c.ever_spoke = True
        c.transcript.append({"who": "customer", "text": text})

        # emergencies: 911 first, then the conversation continues unless danger is confirmed
        if c.awaiting_safety:
            c.awaiting_safety = False
            if guard.confirms_danger(text):
                notes.append("danger_confirmed")
                return done(CONFIRMED_DANGER_TEXT, end=True, outcome="emergency")
        emergency = guard.detect_emergency(text, cfg)
        if emergency == "life_safety":
            c.urgency = "urgent"
            c.awaiting_safety = True
            notes.append("life_safety")
            self._alert(c, actions, "urgent", "Possible life-safety emergency reported")
            return done(guard.life_safety_reply(text), outcome="emergency")
        if emergency == "urgent":
            c.urgency = "urgent"
            notes.append("urgent")
            c.set_outcome("emergency")
            self._alert(c, actions, "urgent", "Urgent issue reported")
            if channel == "voice" and "dispatch_collect" not in c.meta and (legs := dispatch.plan(cfg, now)):
                # ADD-DISPATCH: warm transfer to the on-call technician; first the caller's first name + ZIP
                pend = {"legs": legs, "issue": dispatch.issue_label(text, cfg),
                        "zip": guard.find_zip(text) or c.collected.get("zip") or "",
                        "name": (c.collected.get("name") or "").split(" ")[0]}
                c.meta["dispatch_collect"] = pend
                notes.append("dispatch:collect")
                if not (pend["zip"] and pend["name"]):
                    return done(dispatch.ask_text(not pend["name"], not pend["zip"]))
                pend["started"] = True
                actions.append({"type": "dispatch"})
                return done(dispatch.URGENT_CONNECT_TEXT, end=True)
            if channel == "voice" and "dispatch_collect" not in c.meta and cfg.emergency.dial:
                actions.append({"type": "dial", "number": cfg.emergency.dial, "reason": "urgent"})
                return done(URGENT_DIAL_TEXT, end=True)

        # consent rules (SA §8): recording objection, the texting-consent answer, "don't text me" on a call
        consent = self._consent_rules(tenant, ts, c, channel, text, actions, notes)
        if consent is not None:
            reply, end, outcome = consent
            return done(reply, end=end, outcome=outcome)

        # ADD-DISPATCH: the answer to "first name and ZIP" -> hand the call to the on-call technician
        pend = c.meta.get("dispatch_collect")
        if channel == "voice" and pend and not pend.get("started"):
            pend["zip"] = pend.get("zip") or guard.find_zip(text) or ""
            pend["name"] = pend.get("name") or dispatch.parse_name(text)
            pend["started"] = True
            c.collect(zip=pend["zip"], name=pend["name"])
            notes.append("dispatch:connect")
            actions.append({"type": "dispatch"})
            name = f", {pend['name']}" if pend["name"] else ""
            return done(dispatch.CONNECTING_TEXT.format(name=name), end=True)

        # 10: honest about being an AI, no Claude needed
        if guard.is_robot_question(text):
            notes.append("robot_question")
            return done(guard.robot_answer(sms_business_name(cfg) if sms else cfg.business.name))

        # 9: language
        lang = guard.language_fixed_reply(text, cfg)
        if lang:
            notes.append("language")
            self._alert(c, actions, "lead", "Customer wrote in Spanish; please call back")
            return done(lang, outcome="message")

        # 5: per-number limit before any Claude call (voice too)
        if not sms and (blocked := gate()):
            return blocked

        # 6: budgets -> message-only mode, zero Claude calls
        breason = guard.budget_reason(self.tenant_spend(tenant, day), cfg.guard.daily_budget_usd,
                                      self.global_spend(day), self.settings.global_daily_budget_usd)
        if breason:
            notes.append(f"budget:{breason}")
            self._alert(c, actions, "lead", "Message-only mode (budget reached)")
            flag = f"admin_budget:{breason}:{tenant.id if breason == 'tenant' else 'global'}:{day}"
            if not self.state.get(flag):
                self.state.put(flag, True, tenant.id if breason == "tenant" else None)
                actions.append({"type": "alert", "kind": "admin_budget", "summary": f"{breason} daily budget reached",
                                "tenant": tenant.slug})
            return done(guard.BUDGET_TEXT, outcome="message")

        # Claude
        policy = guard.after_hours_policy(cfg, now)
        caller_ctx = self._caller_context(tenant, ts, c, now)
        if not sms:
            return self._voice_claude(tenant, ts, c, channel, now, policy, actions, notes, text, day, done,
                                      on_sentence, t_start, caller_ctx)
        result = run_turn(self.llm, cfg, channel, c.messages, self._user_content(tenant, channel, text, now, policy, c, caller_ctx),
                          lambda name, args: self._execute(tenant, ts, c, channel, now, policy, actions, name, args))
        c.claude_calls += result.claude_calls
        c.cost_usd += result.cost_usd
        self.add_spend(tenant, day, result.cost_usd)
        extra = dict(claude_calls=result.claude_calls, cost_usd=result.cost_usd, tool_calls=result.tool_calls,
                     llm_ms=result.llm_ms, timings=result.timings)

        if result.error:
            notes.append(f"fallback:{result.error}")
            if not c.message and not c.booking:
                c.message = {"summary": "Assistant error; customer needs a callback", "urgency": c.urgency}
            self._alert(c, actions, "lead", "Assistant could not finish; please call back")
            return done(FALLBACK_TEXT, outcome="message", **extra)

        c.messages = result.messages
        self._out_of_area_lead(c, actions, notes, text, cfg)
        checked = guard.check_reply(result.text, cfg, channel, **_backing(c))
        notes.extend(f"reply:{v}" for v in checked.violations)
        if "unbacked_action" in checked.violations:
            self._alert(c, actions, "lead", "Customer asked for a change the assistant cannot make")
            c.set_outcome("message")
        dialing = any(a["type"] == "dial" for a in actions)
        reply = checked.text
        if self._should_ask_consent(ts, c):  # by text the reply is the confirmation; ask only about the reminder
            notes.append("sms_consent:asked")
            c.meta["sms_consent"] = "asked"
            q = guard.SMS_CONSENT_Q_SMS
            if len(reply) + 1 + len(q) > guard.SMS_REPLY_MAX:
                reply = reply[:guard.SMS_REPLY_MAX - len(q) - 2].rstrip() + "…"
            reply = f"{reply} {q}"
        return done(reply, end=c.ended or dialing, **extra)

    # --- consent (SA §8) ---------------------------------------------------------------------------
    @staticmethod
    def _should_ask_consent(ts: TenantStore, c: Convo) -> bool:
        """A booking was made and the caller was not asked yet (and has not opted out)."""
        return bool(c.booking) and "sms_consent" not in c.meta and not ts.is_opted_out(c.contact)

    def _withhold_transcript(self, c: Convo) -> None:
        """Caller objected to recording/transcription: keep only the greeting (proof of the notice) and a marker.
        Claude's history goes too, so nothing the caller said is kept anywhere in the conversation state."""
        greeting = [t for t in c.transcript[:1] if t.get("who") == "assistant"]
        c.transcript = greeting + [{"who": "system", "text": "Transcript withheld: the caller objected to recording."}]
        c.messages = []
        c.meta["transcript_withheld"] = True

    def _consent_rules(self, tenant: TenantRecord, ts: TenantStore, c: Convo, channel: str, text: str,
                       actions: list, notes: list[str]) -> tuple[str, bool, str | None] | None:
        """(reply, end, outcome) for a turn the consent rules answer without Claude, else None."""
        voice = channel == "voice"
        call_sid = c.convo_id if voice else None
        if voice and guard.objects_to_recording(text):
            notes.append("recording_objection")
            self._withhold_transcript(c)
            if not c.message and not c.booking:
                c.message = {"summary": "Caller objected to recording; call them back", "urgency": c.urgency, "name": None,
                             "address": None, "job_type": None}  # nothing collected is kept either
            self._alert(c, actions, "lead", "Caller asked not to be recorded; please call them back")
            return guard.RECORDING_OBJECTION_TEXT, True, "message"
        if c.meta.get("sms_consent") == "asked":
            ans = guard.consent_answer(text)
            c.meta["sms_consent"] = ans or "unclear"
            ts.record_consent(c.contact, channel, "booking_texts", ans or "unclear", text, call_sid,
                              guard.CONSENT_PROMPT_VERSION)
            notes.append(f"sms_consent:{ans or 'unclear'}")
            if ans and voice and guard.wants_no_texts(text):
                ts.opt_out(c.contact, "voice", text, call_sid)
            bye = voice and bool(c.meta.pop("end_after_consent", False))
            if ans == "yes":
                return (guard.consent_yes_voice(bye) if voice else guard.CONSENT_YES_SMS), bye, None
            if ans == "no":
                if not voice:
                    return guard.CONSENT_NO_SMS, False, None
                return guard.consent_no_voice((c.booking or {}).get("label"), bye), bye, None
            # unclear: no texts; the turn goes on as a normal turn
        if voice and guard.wants_no_texts(text):
            ts.opt_out(c.contact, "voice", text, call_sid)
            notes.append("voice_opt_out")
            if c.meta.get("sms_consent") in (None, "asked"):
                c.meta["sms_consent"] = "no"
            return guard.VOICE_NO_TEXT_TEXT, False, None
        return None

    def _voice_claude(self, tenant: TenantRecord, ts: TenantStore, c: Convo, channel: str, now: datetime, policy: str,
                      actions: list, notes: list[str], text: str, day: str, done: Any, on_sentence: Any,
                      t_start: float, caller_ctx: str = "") -> TurnResult:
        """Voice: stream Claude's text, guard and speak it sentence by sentence (see app.speech)."""
        cfg = tenant.config
        llm_done = [0.0]   # Claude seconds of finished calls (for the server share of time-to-first-sentence)
        call_start = [0.0]
        speaker = Speaker(lambda s: guard.check_reply(s, cfg, channel, **_backing(c)), on_sentence,
                          fillers=TOOL_FILLERS if self.settings.voice_fillers else None)
        first_llm: list[float] = []

        def on_call() -> None:
            call_start[0] = time.perf_counter()

        def streamed(fn: Any) -> Any:
            def wrapped(arg: str) -> None:
                had = speaker.first_at is not None
                fn(arg)
                if not had and speaker.first_at is not None:
                    first_llm.append(llm_done[0] + (speaker.first_at - call_start[0]))
            return wrapped

        on_text, on_tool = streamed(speaker.feed), streamed(speaker.tool_started)

        def on_response(stop_reason: str | None) -> None:
            llm_done[0] += time.perf_counter() - call_start[0]
            had = speaker.first_at is not None
            speaker.end_response(stop_reason)
            if not had and speaker.first_at is not None:
                first_llm.append(llm_done[0])

        def execute(name: str, args: dict[str, Any]) -> dict[str, Any]:
            return self._execute(tenant, ts, c, channel, now, policy, actions, name, args)

        result = run_turn(self.llm, cfg, channel, c.messages, self._user_content(tenant, channel, text, now, policy, c, caller_ctx),
                          execute, on_text=on_text, on_response=on_response, on_call=on_call,
                          on_tool=on_tool)
        c.claude_calls += result.claude_calls
        c.cost_usd += result.cost_usd
        self.add_spend(tenant, day, result.cost_usd)
        extra = dict(claude_calls=result.claude_calls, cost_usd=result.cost_usd, tool_calls=result.tool_calls,
                     llm_ms=result.llm_ms, timings=result.timings, streamed=on_sentence is not None)

        def finish(**kw: Any) -> TurnResult:
            if speaker.first_at is not None:
                kw["first_sentence_ms"] = round((speaker.first_at - t_start) * 1000, 2)
                kw["first_sentence_llm_ms"] = round(first_llm[0] * 1000, 2) if first_llm else 0.0
            return done(speaker.text, **kw, **extra)

        notes.extend(f"reply:{v}" for v in speaker.violations)
        if "unbacked_action" in speaker.violations:
            self._alert(c, actions, "lead", "Customer asked for a change the assistant cannot make")
            c.set_outcome("message")
        if result.error:
            notes.append(f"fallback:{result.error}")
            if not c.message and not c.booking:
                c.message = {"summary": "Assistant error; customer needs a callback", "urgency": c.urgency}
            self._alert(c, actions, "lead", "Assistant could not finish; please call back")
            speaker.say(FALLBACK_TEXT)
            return finish(outcome="message")

        c.messages = result.messages
        self._out_of_area_lead(c, actions, notes, text, cfg)
        if not speaker.spoken:  # Claude said nothing (e.g. only a tool call): same fixed line as before
            checked = guard.check_reply("", cfg, channel, **_backing(c))
            notes.extend(f"reply:{v}" for v in checked.violations)
            speaker.say(checked.text)
        elif not speaker.blocked:  # final pass over the whole reply: rules that span two sentences
            late = [v for v in guard.check_reply(speaker.text, cfg, channel, **_backing(c)).violations]
            notes.extend(f"reply_late:{v}" for v in late)
            if "unbacked_action" in late:
                self._alert(c, actions, "lead", "Customer asked for a change the assistant cannot make")
                c.set_outcome("message")
        dialing = any(a["type"] == "dial" for a in actions)
        if not dialing and self._should_ask_consent(ts, c):
            # SA §8 item 3b: no confirmation or reminder text without a yes; the question follows the confirmation,
            # and the call stays open for the answer (even if Claude already called end_conversation).
            notes.append("sms_consent:asked")
            c.meta["sms_consent"] = "asked"
            c.meta["end_after_consent"] = c.ended  # Claude had closed the call: close it after the answer
            c.ended = False
            speaker.say(guard.SMS_CONSENT_Q_VOICE)
        return finish(end=c.ended or dialing)

    def _out_of_area_lead(self, c: Convo, actions: list, notes: list[str], text: str, cfg: Any) -> None:
        """Safety net (live runs: the fast model sometimes asks "want me to pass this on?" instead of calling
        take_message): a customer ZIP outside the service area always becomes a lead for the team."""
        zip_code = guard.find_zip(text)
        if not zip_code or guard.zip_in_area(zip_code, cfg) or c.booking or c.message:
            return
        c.message = {"summary": f"Customer outside the service area (ZIP {zip_code})", "urgency": c.urgency,
                     **self._details(c)}
        c.set_outcome("message")
        notes.append("out_of_area_lead")
        self._alert(c, actions, "lead", c.message["summary"])

    # ------------------------------------------------------------------------------------------
    @staticmethod
    def _user_content(tenant: TenantRecord, channel: str, text: str, now: datetime, policy: str, c: Convo,
                      extra: str = "") -> list:
        local = now.astimezone(ZoneInfo(tenant.config.business.timezone))
        hours = {
            "open": "The business is open now.",
            "book_next_day": "The business is closed now: offer the next available slots.",
            "message_only": "The business is closed now: do not book; take a message.",
            "emergency_dial": "The business is closed now: take a message; urgent issues are escalated automatically.",
        }[policy]
        urgent = " The customer reported an urgent issue; the owner was alerted." if c.urgency == "urgent" else ""
        prior = f" Before this, we sent the customer: \"{c.prior}\"" if c.prior else ""
        ctx = (f"[context] Channel: {channel}. Local time: {local:%A %b} {local.day} {local.year}, {local:%I:%M %p}. "
               f"{hours}{urgent} The customer's phone number is already known.{prior}{extra}")
        return [{"type": "text", "text": ctx}, {"type": "text", "text": "Customer: " + guard.as_data(text)}]

    # --- appointment manager (2026-10-23; booking.self_service / booking.recognize_callers) ------------------
    def _caller_context(self, tenant: TenantRecord, ts: TenantStore, c: Convo, now: datetime) -> str:
        """Extra context for this Claude turn: the returning-caller fact (once per conversation, first Claude turn
        only) and the note left by an R reply. Never after a recording objection; never for blocked/opted-out numbers."""
        note = str(c.meta.pop("booking_note", "") or "")
        cfg = tenant.config
        if not cfg.booking.recognize_callers or "known_caller" in c.meta or c.meta.get("transcript_withheld"):
            return note
        info = appt.known_caller(ts, cfg, c.contact, now, c.convo_id if c.channel == "voice" else None)
        c.meta["known_caller"] = bool(info)
        if info and c.meta.get("call_row_id"):
            try:
                ts.update("calls", c.meta["call_row_id"], {"known_caller": True})
            except StoreError:
                log.warning("could not flag the call as a known caller")
        return appt.caller_fact(info) + note

    def _note_change(self, ts: TenantStore, c: Convo, kind: str, row: dict, new: dict | None, actions: list,
                     other_number: bool, cfg: Any) -> None:
        old_label = appt.row_label(row, cfg)
        job, name = row.get("job_type") or "Job", row.get("customer_name") or "Customer"
        what = f"moved from {old_label} to {new['label']}" if new else f"cancelled ({old_label})"
        summary = f"Booking {what} by the customer: {job}, {name}" + \
            (". Asked from a different number than the booking's" if other_number else "")
        c.meta["appt"] = {"kind": kind, "label": (new or {}).get("label") or old_label}
        c.meta.setdefault("appt_events", []).append({
            "kind": kind, "key": f"{row.get('id')}:{kind}", "contact": row.get("contact_e164") or c.contact,
            "name": name, "job_type": job, "old": {"start": row.get("start_at"), "end": row.get("end_at"), "label": old_label},
            "new": {k: (new or {}).get(k) for k in ("start", "end", "label", "event_id")} if new else None})
        c.collect(name=name, job_type=job if job in cfg.booking.job_types else "")
        ts.log_event(f"appointment.{kind}", {"channel": c.channel, "other_number": other_number})
        self._alert(c, actions, "booking_change", summary)

    def _cancel_row(self, tenant: TenantRecord, ts: TenantStore, c: Convo, row: dict, reason: str, now: datetime,
                    actions: list, other_number: bool = False) -> dict[str, Any]:
        if not hasattr(self.calendar, "cancel"):
            return {"ok": False, "reason": "not_supported"}
        res = self.calendar.cancel(tenant.id, tenant.config, row["provider_event_id"], reason, now)
        if not res.get("ok"):
            return {"ok": False, "reason": res.get("reason", "cancel_failed")}
        appt.update_row(ts, row["id"], {"status": "cancelled"})
        self._note_change(ts, c, "cancelled", row, None, actions, other_number, tenant.config)
        return {"ok": True, "label": appt.row_label(row, tenant.config)}

    def _booking_text_reply(self, tenant: TenantRecord, ts: TenantStore, c: Convo, text: str, now: datetime,
                            actions: list, notes: list[str]) -> str | None:
        """C / R / X to a confirmation or reminder text (SMS_BOOKING_REPLIES). R returns None: the conversation goes on
        with Claude, which is told which booking to change."""
        kind = appt.parse_reply(text)
        if not kind:
            return None
        cfg = tenant.config
        biz = sms_business_name(cfg)
        prompt = c.meta.pop("booking_prompt", None) or {}
        row = appt.booking_row(ts, prompt.get("booking_id", ""))
        notes.append(f"booking_reply:{kind}")
        if not row or row.get("status") != "confirmed" or row.get("contact_e164") != c.contact:
            return f"{biz}: that visit is no longer on the schedule. Reply here if you need a new time."
        label = appt.row_label(row, cfg)
        if kind == "confirm":
            appt.update_row(ts, row["id"], {"confirmed_at": now.isoformat()})
            ts.log_event("appointment.confirmed", {"channel": "sms"})
            return f"{biz}: thanks, your visit {label} is confirmed."
        if kind == "cancel":
            res = self._cancel_row(tenant, ts, c, row, "Cancelled by text reply", now, actions)
            if not res.get("ok"):
                self._alert(c, actions, "lead", f"Customer replied X to cancel {label}; the calendar could not be updated")
                return f"{biz}: got it. Our team will confirm the cancellation."
            c.set_outcome("message")
            return f"{biz}: your visit {label} is cancelled. Reply here if you'd like a new time."
        c.meta["booking_note"] = (f" The customer replied R to their booking text: they want to change the visit {label} "
                                  f"({row.get('job_type') or 'job'}). Call find_my_booking, then offer new times.")
        return None

    def _manage(self, tenant: TenantRecord, ts: TenantStore, c: Convo, now: datetime, actions: list, name: str,
                args: dict[str, Any]) -> dict[str, Any]:
        """find_my_booking / reschedule_booking / cancel_booking. Only the caller's own bookings that we made."""
        cfg = tenant.config
        if name == "find_my_booking":
            raw = str(args.get("phone") or "").strip()
            other = appt.e164(raw) if raw else None
            if raw and not other:
                return {"ok": False, "reason": "bad_phone"}
            if other and other != c.contact:
                if not str(args.get("name") or "").strip():
                    return {"ok": False, "reason": "name_needed"}
                rows = [r for r in appt.upcoming(ts, other, now) if appt.names_match(r.get("customer_name"), args.get("name"))]
            else:
                other, rows = None, appt.upcoming(ts, c.contact, now)
            if not rows:
                return {"ok": False, "reason": "no_booking"}
            c.meta["my_bookings"] = {f"B{i}": {"row": r["id"], "other": bool(other)} for i, r in enumerate(rows, 1)}
            c.collect(name=rows[0].get("customer_name"))
            return {"ok": True, "bookings": [{"booking_id": f"B{i}", "label": appt.row_label(r, cfg),
                                              "job_type": r.get("job_type") or "",
                                              "zip": guard.find_zip(r.get("address") or "") or ""}
                                             for i, r in enumerate(rows, 1)]}
        ref = (c.meta.get("my_bookings") or {}).get(str(args.get("booking_id") or "").strip().upper())
        if not ref:
            return {"ok": False, "reason": "unknown_booking"}
        row = appt.booking_row(ts, ref["row"])
        if not row or row.get("status") != "confirmed" or not row.get("provider_event_id"):
            return {"ok": False, "reason": "booking_gone"}
        if name == "cancel_booking":
            res = self._cancel_row(tenant, ts, c, row, str(args.get("reason") or "Cancelled by the customer")[:200], now,
                                   actions, ref["other"])
            if res.get("ok"):
                c.set_outcome("message")
            return res
        slot_id = str(args.get("slot_id") or "")
        if slot_id not in c.offered:
            return {"ok": False, "reason": "unknown_slot"}
        if not hasattr(self.calendar, "reschedule"):
            return {"ok": False, "reason": "not_supported"}
        old_label = appt.row_label(row, cfg)
        details = {"name": str(row.get("customer_name") or "")[:80], "phone": row.get("contact_e164") or c.contact,
                   "address": str(row.get("address") or "")[:200], "job_type": row.get("job_type") or cfg.booking.job_types[0],
                   "urgency": row.get("urgency") or "normal", "notes": f"Moved by the customer from {old_label}"}
        res = self.calendar.reschedule(tenant.id, cfg, now, row["provider_event_id"], slot_id, details)
        if not res.get("ok"):
            return {"ok": False, "reason": res.get("reason", "reschedule_failed")}
        new = ts.insert("bookings", {
            "call_id": c.meta.get("call_row_id"), "customer_name": row.get("customer_name"), "contact_e164": row.get("contact_e164"),
            "address": row.get("address"), "job_type": row.get("job_type"), "urgency": row.get("urgency"),
            "start_at": res["start"], "end_at": res["end"], "provider_event_id": res["event_id"], "status": "confirmed",
            "rescheduled_from_id": row["id"]})
        appt.update_row(ts, row["id"], {"status": "rescheduled"})
        ref["row"] = new.get("id") or ref["row"]
        if c.booking and c.booking.get("event_id") == row.get("provider_event_id"):
            c.booking.update({"slot_id": slot_id, "start": res["start"], "end": res["end"], "label": res["label"],
                              "event_id": res["event_id"]})
        self._note_change(ts, c, "rescheduled", row, res, actions, ref["other"], cfg)
        c.set_outcome("booked")
        return {"ok": True, "label": res["label"]}

    def _execute(self, tenant: TenantRecord, ts: TenantStore, c: Convo, channel: str, now: datetime, policy: str,
                 actions: list, name: str, args: dict[str, Any]) -> dict[str, Any]:
        cfg = tenant.config
        if name == "get_availability":
            if args.get("job_type") in cfg.booking.job_types:
                c.collect(job_type=args.get("job_type"))
            c.collect(zip=guard.find_zip(str(args.get("zip") or "")))
            if args.get("job_type") not in cfg.booking.job_types:
                return {"ok": False, "reason": "unknown_job_type", "job_types": list(cfg.booking.job_types)}
            if not guard.zip_in_area(str(args.get("zip") or ""), cfg):
                return {"ok": False, "reason": "out_of_area"}
            if policy in ("message_only", "emergency_dial"):
                return {"ok": False, "reason": "after_hours_message_only"}
            try:
                date_from = date.fromisoformat(str(args["date_from"])) if args.get("date_from") else None
            except ValueError:
                date_from = None
            slots = self.calendar.availability(tenant.id, cfg, now, date_from=date_from, limit=3)
            if c.meta.get("my_bookings"):  # moving a visit: never offer the time it already has
                slots = appt.without_own(slots, ts, c.meta["my_bookings"])
            for s in slots:
                c.offered[s["slot_id"]] = s
            return {"ok": True, "slots": [{"slot_id": s["slot_id"], "label": s["label"]} for s in slots]}

        if name == "book_slot":
            slot_id = str(args.get("slot_id") or "")
            c.collect(name=args.get("name"), address=args.get("address"),
                      job_type=args.get("job_type") if args.get("job_type") in cfg.booking.job_types else "")
            if slot_id not in c.offered:
                return {"ok": False, "reason": "unknown_slot"}
            if c.booking:
                return {"ok": False, "reason": "already_booked"}
            address = str(args.get("address") or "")
            zip_code = guard.find_zip(address)
            if zip_code and not guard.zip_in_area(zip_code, cfg):
                return {"ok": False, "reason": "out_of_area"}
            alt_phone = args.get("phone")
            details = {"name": str(args.get("name") or "")[:80], "phone": c.contact, "address": address[:200],
                       "job_type": args.get("job_type") if args.get("job_type") in cfg.booking.job_types
                       else cfg.booking.job_types[0],
                       "urgency": "urgent" if c.urgency == "urgent" or args.get("urgency") == "urgent" else "normal",
                       "notes": str(args.get("notes") or "")[:300],
                       **({"alt_phone": str(alt_phone)[:20]} if alt_phone else {})}
            res = self.calendar.book(tenant.id, cfg, now, slot_id, details)
            if not res.get("ok"):
                if res.get("reason") == "duplicate" and not c.message:
                    # Same number already booked that day: never a second booking, always a lead for the team
                    # (enforced here; the model may not call take_message on its own).
                    c.message = {"summary": "Customer already booked that day and called again", "urgency": c.urgency,
                                 **self._details(c, **details)}
                    c.set_outcome("message")
                    self._alert(c, actions, "lead", c.message["summary"])
                return {"ok": False, "reason": res.get("reason", "booking_failed")}
            c.booking = {**details, "slot_id": slot_id, "start": res["start"], "end": res["end"],
                         "label": res["label"], "event_id": res["event_id"]}
            ts.insert("bookings", {
                "call_id": c.meta.get("call_row_id"), "customer_name": details["name"], "contact_e164": c.contact,
                "address": details["address"], "job_type": details["job_type"], "urgency": details["urgency"],
                "start_at": res["start"], "end_at": res["end"], "provider_event_id": res["event_id"],
                "status": "confirmed"})
            c.set_outcome("booked")
            self._alert(c, actions, "booking", f"New booking: {details['job_type']} {res['label']}")
            return {"ok": True, "label": res["label"]}

        if name == "take_message":
            urgency = "urgent" if c.urgency == "urgent" or args.get("urgency") == "urgent" else "normal"
            c.collect(name=args.get("name"), address=args.get("address"),
                      job_type=args.get("job_type") if args.get("job_type") in cfg.booking.job_types else "")
            c.message = {"summary": str(args.get("summary") or "")[:300], "urgency": urgency, **self._details(c)}
            c.set_outcome("message")
            self._alert(c, actions, "lead", c.message["summary"])
            out = {"ok": True}
            if c.offered == {} and "outside" in c.message["summary"].lower():
                out["reason"] = "out_of_area"
            return out

        if name == "handoff":
            if channel == "voice" and cfg.handoff.mode == "dial" and cfg.handoff.number and guard.on_call(cfg, now):
                actions.append({"type": "dial", "number": cfg.handoff.number, "reason": "handoff"})
                c.set_outcome("handoff")
                return {"ok": True, "action": "dial"}
            c.set_outcome("message")
            self._alert(c, actions, "human_needed", f"HUMAN NEEDED: {str(args.get('reason') or '')[:200]}")
            return {"ok": True, "action": "message"}

        if name == "end_conversation":
            c.ended = True
            return {"ok": True}

        if name in ("find_my_booking", "reschedule_booking", "cancel_booking") and cfg.booking.self_service:
            return self._manage(tenant, ts, c, now, actions, name, args)

        return {"ok": False, "reason": "unknown_tool"}
