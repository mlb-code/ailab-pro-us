"""Voice flow (SPEC 6.2, 6.5): shared call logic + the turn-based TwiML transport.

Two transports share `VoiceFlow` (same caps, same engine, same persistence):
- stream (production default, `app.voice_stream`): `<Connect><ConversationRelay>`; Twilio does
  streaming STT/TTS and talks to us over a WebSocket. Target < 1 s from end of speech to voice.
- gather (simulator fallback, and automatic fallback when a relay session fails):
  `<Gather input="speech">` + `<Say>` (Polly Neural) per turn, posting to `/voice/turn`.

Routes here: /voice/incoming, /voice/turn, /voice/dial-result, /voice/status, /voice/fallback.

Per call: 12 customer turns or 6 minutes, two silent turns end the call (engine), handoff via
`<Dial>` with a 20 s timeout and a message if nobody answers, emergencies say the 911 line first
(engine), and a hang-up before the caller said anything = `abandoned` -> SMS text-back job.
Per caller number: at most 3 answered calls per 10 minutes and 10 per day; the first call over
the cap hears one short sentence (+ one owner alert a day), later ones are rejected (busy), so
50 calls in a minute cost at most 4 answered calls and no extra Claude calls.
Billable minutes come from Twilio's status callback (CallDuration, rounded up per call) and feed
the monthly usage meter (80% / 100% alerts).

Call notice (SA §8 item 2, legal v1.1): every call starts with `DISCLOSURE` (AI assistant, recorded and
transcribed by us and our service providers, we may text you). A tenant's custom greeting that lacks any part
of it gets the full sentence appended; it cannot be removed. The caller's speech is not processed before the
greeting ends: gather mode plays the greeting with <Say> BEFORE <Gather> (no barge-in), stream mode sets
welcomeGreetingInterruptible="none" and holds the first prompt until the greeting's estimated end
(`voice_stream`). A caller who objects to recording ends the call with no transcript kept
(`transcript_withheld`), and the transcript keeps only the greeting as proof of the notice.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import Response
from fastapi.concurrency import run_in_threadpool
from twilio.twiml.voice_response import VoiceResponse

from . import _stubs_b56 as hooks
from . import guard
from .conversation import Convo
from .runtime_ctx import Runtime, who
from .sms_outbound import after_turn
from .tenants import TenantRecord

log = logging.getLogger("rt.voice")

TWIML = "application/xml"
NOT_IN_SERVICE = "Sorry, this number is not in service. Goodbye."
UNAVAILABLE = "Sorry, we can't take your call right now. Please call back later. Goodbye."
CALL_CAP_TEXT = "Thanks for calling. Our team has your number and will call you back. Goodbye."
TURN_CAP_TEXT = ("I want to make sure the team gets your details, so I'll stop here. "
                 "Someone will call you back shortly. Goodbye.")
DIAL_NO_ANSWER_TEXT = ("Sorry, no one could pick up right now. I've passed your details to the team "
                       "and someone will call you back soon. Goodbye.")
FALLBACK_TEXT = "Sorry, we're having trouble right now. Someone from our team will call you back soon. Goodbye."
REPEAT_TEXT = "Sorry, could you say that again?"
DISCLOSURE = guard.DISCLOSURE
# every part of the notice must be in the greeting (a custom greeting that only says "calls may be recorded for
# quality" would drop the service providers and the texting notice)
DISCLOSURE_PARTS = (re.compile(r"\brecorded\b", re.I), re.compile(r"\btranscribed\b", re.I),
                    re.compile(r"\bservice providers?\b", re.I), re.compile(r"\btext\b", re.I))

MAX_TURNS = 12
MAX_CALL = timedelta(minutes=6)
DIAL_TIMEOUT_S = 20
CALLS_PER_10MIN = 3
CALLS_PER_DAY = 10
TERMINAL = {"completed", "busy", "no-answer", "failed", "canceled"}


def has_disclosure(text: str) -> bool:
    return all(p.search(text or "") for p in DISCLOSURE_PARTS)


def default_greeting(cfg: Any) -> str:
    """Generated greeting per niche (the call notice is added by `greeting`)."""
    if cfg.business.niche == "real_estate":
        agent = (cfg.real_estate.agent_name or "").strip()
        who = f"{agent}'s virtual assistant at {cfg.business.name}" if agent else f"the virtual assistant for {cfg.business.name}"
        missed = f"Sorry {agent.split()[0]} missed you! " if agent else "Sorry we missed your call! "
        return f"Hi, this is {who}, an AI. {missed}{DISCLOSURE} What are you calling about?"
    return f"Thanks for calling {cfg.business.name}. I'm the virtual assistant, an AI. {DISCLOSURE} How can I help?"


def greeting(tenant: TenantRecord) -> str:
    cfg = tenant.config
    text = (cfg.voice.greeting or "").strip() or default_greeting(cfg)
    return text if has_disclosure(text) else f"{text} {DISCLOSURE}"


@dataclass
class VoiceTurn:
    reply: str
    end: bool = False
    dial: str | None = None
    outcome: str | None = None
    actions: list[dict[str, Any]] = field(default_factory=list)
    streamed: bool = False  # the reply was already sent sentence by sentence (relay); only `last` remains


def _first_sentence_stats(rows: list[list[float]]) -> dict[str, float]:
    """Time to first spoken sentence per Claude turn: total and server share (= total - Claude time)."""
    if not rows:
        return {}
    server = [t - llm for t, llm in rows]
    return {"first_sentence_ms_p50": round(percentile([t for t, _ in rows], 50), 2),
            "first_sentence_ms_p95": round(percentile([t for t, _ in rows], 95), 2),
            "first_sentence_server_ms_p95": round(percentile(server, 95), 2)}


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(pct / 100 * len(s)) - 1))]


class VoiceFlow:
    def __init__(self, rt: Runtime):
        self.rt = rt
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, call_sid: str) -> threading.Lock:
        with self._guard:
            if len(self._locks) > 2000:
                self._locks.clear()
            return self._locks.setdefault(call_sid, threading.Lock())

    # --- admission: blocklist + per-number call cap -------------------------------------------
    def admit(self, tenant: TenantRecord, caller: str, now: datetime) -> str:
        """'ok' | 'capped' (one short sentence, then hang up) | 'reject' (busy, no answer)."""
        cfg = tenant.config
        if caller in cfg.guard.blocklist:
            return "reject"
        key = f"callcap:{tenant.id}:{who(caller)}"
        st = self.rt.state.get(key) or {"times": [], "capped_day": None, "rejected": 0}
        times = [t for t in st["times"] if now - datetime.fromisoformat(t) < timedelta(hours=24)]
        recent = [t for t in times if now - datetime.fromisoformat(t) < timedelta(minutes=10)]
        day = now.astimezone(ZoneInfo(cfg.business.timezone)).date().isoformat()
        if len(recent) < CALLS_PER_10MIN and len(times) < CALLS_PER_DAY:
            st["times"] = times + [now.isoformat()]
            self.rt.state.put(key, st, tenant.id)
            return "ok"
        if st.get("capped_day") != day:
            st["capped_day"] = day
            st["times"] = times
            self.rt.state.put(key, st, tenant.id)
            ts = self.rt.store.for_tenant(tenant.id)
            ts.log_event("voice.call_cap", {"caller": who(caller), "recent": len(recent), "today": len(times)})
            self.rt.deliver(tenant, [{"type": "alert", "kind": "call_cap", "channel": "voice", "contact": caller,
                                      "summary": "Same number called too many times; extra calls are not answered"}],
                            f"callcap:{who(caller)}:{day}")
            return "capped"
        st["rejected"] = int(st.get("rejected", 0)) + 1
        st["times"] = times
        self.rt.state.put(key, st, tenant.id)
        return "reject"

    # --- call lifecycle --------------------------------------------------------------------------
    def start(self, tenant: TenantRecord, call_sid: str, caller: str, now: datetime, mode: str) -> Convo:
        eng = self.rt.engine
        c = eng.convo(tenant, "voice", caller, call_sid)
        if c.meta.get("call_row_id"):
            return c  # Twilio retried the webhook
        ts = self.rt.store.for_tenant(tenant.id)
        existing = ts.select("calls", call_sid=call_sid)
        row = existing[0] if existing else ts.insert("calls", {
            "call_sid": call_sid, "from_e164": caller, "started_at": now.isoformat(), "transcript": [],
            "outcome": None})
        c.meta.update({"call_row_id": row["id"], "started_at": now.isoformat(), "mode": mode, "turns": 0,
                       "timing": []})
        c.transcript.append({"who": "assistant", "text": greeting(tenant)})
        eng.save_convo(c)
        ts.log_event("voice.incoming", {"call_sid": call_sid, "mode": mode})
        if eng.llm.mode == "live" and eng.llm.prompt_cache:
            # While the greeting plays: warm the API connection and the tools+system prompt cache, so the
            # caller's first turn does not pay the cold start (~$0.0003 cache write per call, Haiku).
            threading.Thread(target=self._prewarm, args=(tenant,), daemon=True).start()
        return c

    def _prewarm(self, tenant: TenantRecord) -> None:
        from .brain import prewarm
        try:
            prewarm(self.rt.engine.llm, tenant.config, "voice")
        except Exception:  # noqa: BLE001 - best effort, never affects the call
            log.warning("prewarm crashed")

    def turn(self, tenant: TenantRecord, call_sid: str, caller: str, text: str, now: datetime,
             on_sentence: Any = None) -> VoiceTurn:
        """One caller utterance ("" = silence). Thread-safe per call. `on_sentence` (stream mode) receives
        each guarded sentence of Claude's reply as soon as it is ready."""
        with self._lock(call_sid):
            return self._turn(tenant, call_sid, caller, text, now, on_sentence)

    def _turn(self, tenant: TenantRecord, call_sid: str, caller: str, text: str, now: datetime,
              on_sentence: Any = None) -> VoiceTurn:
        t0 = time.perf_counter()
        eng = self.rt.engine
        c = eng.convo(tenant, "voice", caller, call_sid)
        if not c.meta.get("call_row_id"):
            c = self.start(tenant, call_sid, caller, now, "gather")
        if c.ended:
            return VoiceTurn("", end=True, outcome=c.outcome)
        started = datetime.fromisoformat(c.meta["started_at"])
        if c.meta.get("turns", 0) >= MAX_TURNS or now - started >= MAX_CALL:
            actions = eng.close(tenant, c, "message", "lead", "Call reached the length limit; please call back")
            c.transcript.append({"who": "assistant", "text": TURN_CAP_TEXT})
            self._persist(tenant, c)
            self.rt.deliver(tenant, actions, call_sid)
            return VoiceTurn(TURN_CAP_TEXT, end=True, outcome=c.outcome, actions=actions)

        res = eng.handle(tenant, "voice", caller, text, call_sid, now, on_sentence=on_sentence)
        c = eng.convo(tenant, "voice", caller, call_sid)
        c.meta["turns"] = c.meta.get("turns", 0) + 1
        dial = next((a["number"] for a in res.actions if a.get("type") == "dial"), None)
        if dial:
            c.meta["dialing"] = {"number": dial, "reason": next(a.get("reason") for a in res.actions if a.get("type") == "dial")}
        reply, end = res.reply, res.end
        if not reply and not end:  # e.g. over the reply limit: never leave a caller in dead air
            reply, end = CALL_CAP_TEXT, True
            c.transcript.append({"who": "assistant", "text": reply})
        self.rt.deliver(tenant, res.actions, call_sid)
        after_turn(self.rt, tenant, c, now)
        total_ms = (time.perf_counter() - t0) * 1000
        c.meta["timing"] = (c.meta.get("timing") or []) + [[round(total_ms, 2), round(res.llm_ms, 2)]]
        if res.first_sentence_ms is not None:  # Claude turns: [to first sentence, Claude share of it] ms
            c.meta["first_sentence"] = (c.meta.get("first_sentence") or []) + [
                [res.first_sentence_ms, res.first_sentence_llm_ms or 0.0]]
        self._persist(tenant, c)
        streamed = res.streamed and reply == res.reply
        return VoiceTurn(reply, end=end, dial=dial, outcome=c.outcome, actions=res.actions, streamed=streamed)

    # --- relay socket lost (streaming mode) ---------------------------------------------------------
    def relay_lost(self, tenant: TenantRecord, call_sid: str, now: datetime) -> None:
        """The relay socket closed without our `end`. The caller may still be on the line: Twilio next
        requests /voice/relay-end (-> continue with <Gather>, same conversation) or, if the caller hung
        up, sends the status callback (-> finalize). Nothing is closed here; a grace timer finalizes only
        if neither arrives."""
        with self._lock(call_sid):
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            if c is None or c.meta.get("finalized") or c.meta.get("relay_resumed") or c.ended:
                return
            c.meta["relay_lost"] = now.isoformat()
            self.rt.engine.save_convo(c)
        t = threading.Timer(self.rt.settings.voice_relay_grace_s, self._relay_grace, args=(tenant, call_sid))
        t.daemon = True
        t.start()

    def _relay_grace(self, tenant: TenantRecord, call_sid: str) -> None:
        try:
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            if c is not None and not c.meta.get("relay_resumed") and not c.meta.get("finalized"):
                self.finalize(tenant, call_sid, self.rt.now())
                self.rt.outbound.run_due(self.rt.now(), tenant)
        except Exception:  # noqa: BLE001 - a timer must never crash the worker
            log.exception("relay grace finalize failed")

    def resume_gather(self, tenant: TenantRecord, call_sid: str) -> bool:
        """Relay session ended without handoff data while the call is live: continue turn by turn."""
        with self._lock(call_sid):
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            if c is None or c.ended or c.meta.get("finalized"):
                return False
            c.meta.update({"relay_resumed": True, "mode": "gather-fallback"})
            c.meta.pop("relay_lost", None)
            self.rt.engine.save_convo(c)
            return True

    def dial_result(self, tenant: TenantRecord, call_sid: str, status: str, now: datetime) -> VoiceTurn:
        with self._lock(call_sid):
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            if c is None:
                return VoiceTurn("", end=True)
            info = c.meta.pop("dialing", None) or {}
            c.meta["dial_status"] = status
            if status == "completed":
                self.rt.engine.save_convo(c)
                return VoiceTurn("", end=True, outcome=c.outcome)
            if info.get("reason") == "handoff" or c.outcome == "handoff":
                actions = self.rt.engine.close(tenant, c, "message", "human_needed",
                                               "HUMAN NEEDED: caller asked for a person; nobody answered the call",
                                               force=True)
            else:  # urgent dial: outcome stays "emergency", the urgent alert already went out
                actions = self.rt.engine.close(tenant, c, "message", "lead", "Urgent call: on-call line did not answer")
            c.transcript.append({"who": "assistant", "text": DIAL_NO_ANSWER_TEXT})
            self._persist(tenant, c)
            self.rt.deliver(tenant, actions, call_sid)
            return VoiceTurn(DIAL_NO_ANSWER_TEXT, end=True, outcome=c.outcome, actions=actions)

    def finalize(self, tenant: TenantRecord, call_sid: str, now: datetime) -> dict[str, Any]:
        """Call is over (caller hung up, we hung up, or Twilio reports a terminal status). Idempotent."""
        with self._lock(call_sid):
            eng = self.rt.engine
            c = eng.find_convo(tenant, "voice", call_sid)
            if c is None or c.meta.get("finalized"):
                return {}
            out: dict[str, Any] = {}
            actions: list[dict] = []
            if c.meta.get("sms_consent") == "asked":  # hung up before answering the texting question: no texts
                c.meta["sms_consent"] = "no_answer"
                self.rt.store.for_tenant(tenant.id).record_consent(c.contact, "voice", "booking_texts", "no_answer", "",
                                                                   call_sid, guard.CONSENT_PROMPT_VERSION)
            if c.outcome is None:
                if not c.ever_spoke:
                    c.outcome = "abandoned"
                    out["textback"] = self.rt.outbound.enqueue_textback(tenant, c.contact, call_sid, now)
                else:
                    actions = eng.close(tenant, c, "message", "lead", "Caller hung up before finishing; please call back")
            c.ended = True
            c.meta["finalized"] = True
            c.meta.setdefault("duration_s", int((now - datetime.fromisoformat(c.meta["started_at"])).total_seconds()))
            self._persist(tenant, c)
            self.rt.deliver(tenant, actions, call_sid)
            after_turn(self.rt, tenant, c, now)
            timing = c.meta.get("timing") or []
            server = [t - llm for t, llm in timing]
            ts = self.rt.store.for_tenant(tenant.id)
            ts.log_event("voice.latency", {"call_sid": call_sid, "mode": c.meta.get("mode"), "turns": len(timing),
                                           "server_ms_p50": round(percentile(server, 50), 2),
                                           "server_ms_p95": round(percentile(server, 95), 2),
                                           "total_ms_p95": round(percentile([t for t, _ in timing], 95), 2),
                                           **_first_sentence_stats(c.meta.get("first_sentence") or [])})
            self.rt.emit(tenant, "call.completed", {"call_sid": call_sid, "outcome": c.outcome,
                                                    "duration_s": c.meta["duration_s"], "summary": summary(c)},
                         call_sid)
            out["outcome"] = c.outcome
            return out

    def record_minutes(self, tenant: TenantRecord, call_sid: str, duration_s: int, now: datetime) -> list[dict]:
        """Billable minutes from Twilio's CallDuration (rounded up), once per call."""
        flag = f"callusage:{tenant.id}:{call_sid}"
        if duration_s <= 0 or self.rt.state.get(flag):
            return []
        self.rt.state.put(flag, True, tenant.id)
        ts = self.rt.store.for_tenant(tenant.id)
        c = self.rt.engine.find_convo(tenant, "voice", call_sid)
        if c is not None and c.meta.get("call_row_id"):
            # B6 cost hook: Twilio minutes + Claude cost into the calls row and the daily cost counter, one
            # JSON log line with p50/p95 turn times (no transcript content in logs).
            hooks.record_call(self.rt.store, self.rt.state, tenant, call_sid=call_sid, from_e164=c.contact,
                              started_at=datetime.fromisoformat(c.meta["started_at"]), duration_s=int(duration_s),
                              outcome=c.outcome or "abandoned", transcript=c.transcript, summary=summary(c),
                              claude_cost_usd=c.cost_usd, claude_calls=c.claude_calls,
                              turn_ms=[t - llm for t, llm in c.meta.get("timing") or []])
        else:
            rows = ts.select("calls", call_sid=call_sid)
            if rows:
                ts.update("calls", rows[0]["id"], {"duration_s": int(duration_s)})
        actions: list[dict] = []
        self.rt.engine._usage(tenant, ts, "voice", math.ceil(duration_s / 60), now, actions)
        self.rt.deliver(tenant, actions, f"usage:{now:%Y-%m}")
        return actions

    def _persist(self, tenant: TenantRecord, c: Convo) -> None:
        self.rt.engine.save_convo(c)
        row_id = c.meta.get("call_row_id")
        if row_id:
            patch = {"transcript": c.transcript, "outcome": c.outcome, "summary": summary(c),
                     "cost_usd": round(c.cost_usd, 4)}
            if c.meta.get("transcript_withheld"):
                patch["transcript_withheld"] = True
            if "duration_s" in c.meta:
                patch["duration_s"] = c.meta["duration_s"]
            self.rt.store.for_tenant(tenant.id).update("calls", row_id, patch)


def summary(c: Convo) -> str:
    if c.meta.get("transcript_withheld") and not c.booking:
        return "Caller objected to recording; transcript not kept. Call them back."
    if c.booking:
        return f"Booked: {c.booking.get('job_type')} {c.booking.get('label') or c.booking.get('start')}"[:400]
    if c.message:
        details = [v for v in (c.message.get("name"), c.message.get("job_type"), c.message.get("address")) if v]
        if not details and not c.meta.get("transcript_withheld"):
            details = [c.collected.get(k) for k in ("name", "job_type", "address") if c.collected.get(k)]
        tail = f" ({', '.join(details)})" if details else ""
        return f"Message ({c.message.get('urgency', 'normal')}): {c.message.get('summary', '')}{tail}"[:400]
    said = next((t["text"] for t in c.transcript if t["who"] == "customer"), "")
    return (f"Caller said: {said}" if said else "No speech")[:400]


# --- TwiML ---------------------------------------------------------------------------------------

def twiml_say_hangup(text: str, voice: str | None = None) -> str:
    vr = VoiceResponse()
    if text:
        vr.say(text, voice=voice) if voice else vr.say(text)
    vr.hangup()
    return str(vr)


def twiml_gather(text: str, voice: str, barge_in: bool = True) -> str:
    """Speak `text` and listen. `barge_in=False` (the greeting with the call notice): <Say> before <Gather>, so the
    caller cannot cut the notice off and nothing they say is processed before it ends."""
    vr = VoiceResponse()
    if not barge_in:
        vr.say(text, voice=voice)
    g = vr.gather(input="speech", action="/voice/turn", method="POST", speech_model="phone_call", enhanced=True,
                  speech_timeout="auto", action_on_empty_result=True, language="en-US")
    if barge_in:
        g.say(text, voice=voice)
    return str(vr)


def twiml_dial(text: str, voice: str, number: str) -> str:
    vr = VoiceResponse()
    if text:
        vr.say(text, voice=voice)
    vr.dial(number, timeout=DIAL_TIMEOUT_S, action="/voice/dial-result", method="POST")
    return str(vr)


def twiml_for(turn: VoiceTurn, tenant: TenantRecord) -> str:
    voice = tenant.config.voice.tts_voice
    if turn.dial:
        return twiml_dial(turn.reply, voice, turn.dial)
    if turn.end:
        return twiml_say_hangup(turn.reply, voice)
    return twiml_gather(turn.reply, voice)


def twiml_reject() -> str:
    vr = VoiceResponse()
    vr.reject(reason="busy")
    return str(vr)


# --- routes --------------------------------------------------------------------------------------

router = APIRouter()


def _rt(request: Request) -> Runtime:
    return request.app.state.rt


def _xml(body: str) -> Response:
    return Response(body, media_type=TWIML)


@router.post("/voice/incoming")
async def voice_incoming(request: Request) -> Response:
    rt = _rt(request)
    form = await request.form()
    caller, call_sid = str(form.get("From", "")), str(form.get("CallSid", ""))
    tenant, problem = rt.resolve_tenant(str(form.get("To", "")))
    if problem == "unknown":
        return _xml(twiml_say_hangup(NOT_IN_SERVICE))
    if problem == "invalid_config":
        return _xml(await _safe_voice(rt, form, "incoming"))
    if not tenant.active:
        return _xml(twiml_say_hangup(UNAVAILABLE))
    now = rt.now()
    admitted = await run_in_threadpool(rt.flow.admit, tenant, caller, now)
    if admitted == "reject":
        return _xml(twiml_reject())
    if admitted == "capped":
        return _xml(twiml_say_hangup(CALL_CAP_TEXT, tenant.config.voice.tts_voice))
    mode = rt.settings.voice_mode
    await run_in_threadpool(rt.flow.start, tenant, call_sid, caller, now, mode)
    if mode == "stream":
        from .voice_stream import relay_twiml
        return _xml(relay_twiml(rt, request, tenant, call_sid))
    return _xml(twiml_gather(greeting(tenant), tenant.config.voice.tts_voice, barge_in=False))


async def _safe_voice(rt: Runtime, form: Any, step: str) -> str:
    """Tenant config does not validate: polite sentence + name/number message (app.voice_safe)."""
    from .voice_safe import SafeMode, broken_tenant
    bt = await run_in_threadpool(broken_tenant, rt, str(form.get("To", "")))
    if bt is None:
        return twiml_say_hangup(UNAVAILABLE)
    safe, now = SafeMode(rt), rt.now()
    call_sid, caller = str(form.get("CallSid", "")), str(form.get("From", ""))
    if step == "message":
        return await run_in_threadpool(safe.voice_message, bt, call_sid, caller, str(form.get("SpeechResult", "") or ""), now)
    return await run_in_threadpool(safe.voice_incoming, bt, call_sid, caller, now)


@router.post("/voice/safe-message")
async def voice_safe_message(request: Request) -> Response:
    rt = _rt(request)
    form = await request.form()
    return _xml(await _safe_voice(rt, form, "message"))


@router.post("/voice/turn")
async def voice_turn(request: Request) -> Response:
    rt = _rt(request)
    form = await request.form()
    tenant, problem = rt.resolve_tenant(str(form.get("To", "")))
    if problem == "invalid_config":  # config broke mid-call: switch to the safe message
        return _xml(await _safe_voice(rt, form, "incoming"))
    if problem or not tenant:
        return _xml(twiml_say_hangup(UNAVAILABLE))
    turn = await run_in_threadpool(rt.flow.turn, tenant, str(form.get("CallSid", "")), str(form.get("From", "")),
                                   str(form.get("SpeechResult", "") or ""), rt.now())
    return _xml(twiml_for(turn, tenant))


@router.post("/voice/dial-result")
async def voice_dial_result(request: Request) -> Response:
    rt = _rt(request)
    form = await request.form()
    tenant, problem = rt.resolve_tenant(str(form.get("To", "")))
    if problem or not tenant:
        return _xml(twiml_say_hangup(""))
    turn = await run_in_threadpool(rt.flow.dial_result, tenant, str(form.get("CallSid", "")),
                                   str(form.get("DialCallStatus", "")), rt.now())
    return _xml(twiml_say_hangup(turn.reply, tenant.config.voice.tts_voice))


@router.post("/voice/status")
async def voice_status(request: Request, background: BackgroundTasks) -> Response:
    rt = _rt(request)
    form = await request.form()
    tenant, problem = rt.resolve_tenant(str(form.get("To", "")))
    status = str(form.get("CallStatus", ""))
    if problem == "invalid_config" and status in TERMINAL:
        from .voice_safe import SafeMode, broken_tenant
        bt = await run_in_threadpool(broken_tenant, rt, str(form.get("To", "")))
        if bt is not None:
            try:
                duration = int(form.get("CallDuration") or 0)
            except ValueError:
                duration = 0
            background.add_task(SafeMode(rt).voice_finished, bt, str(form.get("CallSid", "")),
                                str(form.get("From", "")), duration, rt.now())
    if tenant and not problem and status in TERMINAL:
        now, call_sid = rt.now(), str(form.get("CallSid", ""))
        try:
            duration = int(form.get("CallDuration") or 0)
        except ValueError:
            duration = 0
        await run_in_threadpool(rt.flow.finalize, tenant, call_sid, now)
        await run_in_threadpool(rt.flow.record_minutes, tenant, call_sid, duration, now)
        background.add_task(rt.outbound.run_due, now, tenant)
    return Response(status_code=204)


@router.post("/voice/fallback")
async def voice_fallback(request: Request) -> Response:
    """Twilio's fallback URL for this runtime: an error in the primary handler. Never raises."""
    rt = _rt(request)
    try:
        form = await request.form()
        tenant, problem = rt.resolve_tenant(str(form.get("To", "")))
        if tenant and not problem:
            rt.store.for_tenant(tenant.id).log_event("voice.fallback", {"call_sid": str(form.get("CallSid", "")),
                                                                        "error": str(form.get("ErrorCode", ""))})
    except Exception:  # noqa: BLE001 - the fallback must always answer
        log.exception("voice fallback logging failed")
    return _xml(twiml_say_hangup(FALLBACK_TEXT))
