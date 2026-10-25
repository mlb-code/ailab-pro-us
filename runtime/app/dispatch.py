"""ADD-DISPATCH, the on-call dispatcher: warm transfer of urgent calls to the technician on duty, a waterfall of
up to 3 numbers, and alerts when nobody takes the call.

Flow (voice only; the 911 sentence for life-safety words always comes first and is unchanged, `app.conversation`):
1. An urgent call (`guard.detect_emergency` == "urgent") while dispatch is active (`active`: enabled, and closed
   now or `daytime_too`) and someone is on call (`plan`): the assistant asks for the caller's first name and ZIP
   (one question, skipped for what it already knows), then says it is connecting them and the call leaves the AI.
2. Each leg is `<Dial callerId=the caller's own number (tenant number if unknown) timeout<=20><Number url=/voice/dispatch/whisper>` (Twilio "whisper"):
   when the technician picks up, only they hear the one-sentence brief ("Urgent call for {business}: {issue}, ZIP
   {zip}, caller {first name}. Press 1 to take the call.") and must press 1 within 8 s; then the two are bridged.
   No 1 (voicemail, no answer, other key) -> that leg ends and the next number rings; between legs the caller
   hears "still connecting you". Total wait is capped at `MAX_WAIT_S` (75 s) and `tenants.DISPATCH_MAX_LEGS` (3).
3. Nobody accepted: the caller hears that a technician will call back within `dispatch.callback_minutes`, the
   call ends as an urgent message (owner lead alert as today), and the on-call contact + managers who gave a
   written opt-in get an alert: a voice call with the brief (press 1 = "I've got it" and connects them to the
   caller), or an SMS when `dispatch.sms_alerts` AND the global flag `DISPATCH_SMS_ALERTS=1` are both on (off by
   default: staff SMS waits for the A2P 10DLC campaign). The alert repeats once after `ALERT_RETRY` (5 min,
   an Outbound job run by /jobs/tick) unless someone pressed/replied 1 or the owner clicked "Handled" in the
   portal (a `dispatch_events` row with result 'handled', written by the mark_dispatch_handled RPC).

Every step is a row in `dispatch_events` (no phone numbers; contact first name only) for the portal's dispatch
log and the reports. Alerts carry only the caller's first name, ZIP and job type (no number, no address); STOP
from a staff number is honored (`Outbound.send`, and voice alerts skip opted-out numbers) and flags the portal.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from twilio.twiml.voice_response import VoiceResponse

from . import crypto, guard
from .store import StoreError
from .tenants import DAYS, DISPATCH_MAX_LEGS, TenantConfig, TenantConfigError, TenantRecord, load_record

if TYPE_CHECKING:  # runtime_ctx imports the engine, which imports this module
    from .runtime_ctx import Runtime

log = logging.getLogger("rt.dispatch")

TWIML = "application/xml"
MAX_WAIT_S = 75
LEG_RING_S = 20
MIN_RING_S = 8
WHISPER_WAIT_S = 8
ALERT_RETRY = timedelta(minutes=5)
TOKEN_TTL_S = 2 * 3600
ALERT_RING_S = 25
EVENT_RESULTS = ("no_answer", "declined", "accepted", "alert_sent", "acknowledged", "handled", "opted_out")

CONNECTING_TEXT = "Thanks{name}. I'm connecting you with our on-call technician now. Please stay on the line."
URGENT_CONNECT_TEXT = "This sounds urgent. I'm connecting you with our on-call technician now. Please stay on the line."
HOLD_TEXT = "Still connecting you to a technician. Please hold."
ACCEPT_TEXT = "Connecting you now."
ALERT_ACCEPT_TEXT = "Thanks. Connecting you to the customer now."
ALERT_NO_CALLER_TEXT = "Thanks, it's marked as yours. The customer's details are in the portal. Goodbye."
SMS_ACK_TEXT = "Thanks, it's marked as yours. The customer's details are in your lead alert and the portal."


def ask_text(need_name: bool, need_zip: bool) -> str:
    what = " and ".join(x for x, on in (("your first name", need_name), ("your ZIP code", need_zip)) if on)
    head = "This sounds urgent. I'll get our on-call technician on the line."
    return f"{head} Quickly, what's {what}?" if what else head


def nobody_text(minutes: int) -> str:
    return (f"Sorry, I couldn't reach a technician right away. I've sent them your details, and a technician "
            f"will call you back within {minutes} minutes. Goodbye.")


# --- pure rules ----------------------------------------------------------------------------------

def who(number: str) -> str:
    """Same non-reversible id as runtime_ctx.who (state keys)."""
    return hashlib.sha256((number or "").encode()).hexdigest()[:16]


def _local(cfg: TenantConfig, now: datetime) -> datetime:
    return now.astimezone(ZoneInfo(cfg.business.timezone))


def _on(shift_day: str, start: str, end: str, local: datetime) -> bool:
    """Is `local` inside this shift? end <= start = overnight (the part after midnight belongs to the next day)."""
    today = DAYS[local.weekday()]
    yesterday = DAYS[(local.weekday() - 1) % 7]
    t = local.time().replace(second=0, microsecond=0)
    s, e = time.fromisoformat(start), time.fromisoformat(end)
    if s < e:
        return shift_day == today and s <= t < e
    return (shift_day == today and t >= s) or (shift_day == yesterday and t < e)


def on_shift(cfg: TenantConfig, now: datetime) -> list[Any]:
    """Contacts on duty now, in the order of the matching shift rows (first match first, no repeats)."""
    d = cfg.dispatch
    by_id = {c.id: c for c in d.contacts}
    local = _local(cfg, now)
    out: list[Any] = []
    for s in d.schedule:
        if _on(s.day, s.start, s.end, local):
            for ref in s.contacts:
                c = by_id.get(ref)
                if c is not None and c not in out:
                    out.append(c)
    return out


def active(cfg: TenantConfig, now: datetime) -> bool:
    d = cfg.dispatch
    return bool(d.enabled and d.contacts) and (d.daytime_too or not guard.is_open(cfg, now))


def plan(cfg: TenantConfig, now: datetime) -> list[dict[str, str]]:
    """Ordered legs for an urgent call now: [office line while open (daytime mode)] + on-duty contacts, then the
    managers (the fallback when nobody is scheduled); no repeated number, at most DISPATCH_MAX_LEGS. [] = inactive."""
    if not active(cfg, now):
        return []
    legs: list[dict[str, str]] = []
    if guard.is_open(cfg, now) and cfg.handoff.number:
        legs.append({"id": "office", "name": "Office", "phone": cfg.handoff.number, "role": "office"})
    people = on_shift(cfg, now) + [c for c in cfg.dispatch.contacts if c.role == "manager"]
    for c in people:
        if all(x["phone"] != c.phone for x in legs):
            legs.append({"id": c.id, "name": c.name, "phone": c.phone, "role": c.role})
    return legs[:DISPATCH_MAX_LEGS]


_LABELS = ((re.compile(r"\bburst pipe\b", re.I), "burst pipe"), (re.compile(r"\bwater everywhere\b", re.I), "water everywhere"),
           (re.compile(r"\bflood\w*\b|\binundaci", re.I), "flooding"), (guard.NO_HEAT, "no heat"))


def issue_label(text: str, cfg: TenantConfig) -> str:
    """Short job type for the brief: the urgent phrase the caller used, never their own words beyond it."""
    t = text or ""
    for rx, label in _LABELS:
        if rx.search(t):
            return label
    low = t.lower()
    for k in cfg.emergency.keywords:
        if k.strip() and k.lower() in low:
            return k.strip().lower()[:40]
    return "urgent job"


_NAME_LEAD = re.compile(r"\b(?:my name is|my name's|name is|this is|it'?s|i'?m|i am|call me)\s+([A-Za-z][A-Za-z'-]{1,24})", re.I)
_NOT_NAMES = {"yes", "yeah", "yep", "ok", "okay", "sure", "um", "uh", "hi", "hello", "the", "and", "my", "zip", "code",
              "is", "its", "it's", "it", "name", "first", "i", "im", "i'm", "this", "a", "zero", "oh", "one", "two",
              "three", "four", "five", "six", "seven", "eight", "nine", "so", "well", "please", "hurry", "flooding",
              "water", "no", "not", "just", "uhm", "hey", "thanks", "thank", "you", "we", "our", "in", "at", "for"}


def parse_name(text: str) -> str:
    """Caller's first name from a short spoken answer ("It's Tess, 77005"); '' when unsure."""
    t = re.sub(r"\d", " ", text or "")
    m = _NAME_LEAD.search(t)
    cands = [m.group(1)] if m else re.findall(r"[A-Za-z][A-Za-z'-]{1,24}", t)
    for w in cands:
        if w.lower() not in _NOT_NAMES and not _NOT_NAMES.intersection({w.lower().strip("'")}):
            return w[:1].upper() + w[1:].lower()
    return ""


def brief_text(business: str, b: dict[str, Any]) -> str:
    return (f"Urgent call for {business}: {b.get('issue') or 'urgent job'}, ZIP {b.get('zip') or 'unknown'}, "
            f"caller {b.get('name') or 'unknown'}.")


def alert_sms(business: str, b: dict[str, Any]) -> str:
    """Locked template (staff alert): first name, ZIP and job type only."""
    return (f"{business} on-call alert: urgent call, {b.get('issue') or 'urgent job'}, ZIP {b.get('zip') or 'unknown'}, "
            f"caller {b.get('name') or 'unknown'}. Nobody took it yet. Reply 1 if you're handling it. "
            "Reply STOP to opt out.")


def alert_say(business: str, b: dict[str, Any]) -> str:
    return (f"This is an on-call alert from {business}. {brief_text(business, b)} Nobody has taken it yet. "
            "Press 1 to call the customer back now.")


# --- runtime --------------------------------------------------------------------------------------

class Dispatcher:
    def __init__(self, rt: "Runtime"):
        self.rt = rt

    # tokens bind a Twilio callback to (tenant, parent call, leg | alert contact)
    def token(self, tenant: TenantRecord, call_sid: str, **claims: Any) -> str:
        return crypto.sign(self.rt.settings.cred_key, {"t": tenant.id, "c": call_sid, **claims}, ttl_s=TOKEN_TTL_S)

    def claims(self, token: str) -> dict[str, Any] | None:
        if not (token and self.rt.settings.cred_key):
            return None
        try:
            return crypto.verify(self.rt.settings.cred_key, token)
        except crypto.CryptoError:
            return None

    def tenant_of(self, claims: dict[str, Any]) -> TenantRecord | None:
        rows = self.rt.store.select("tenants", id=claims.get("t"))
        try:
            return load_record(rows[0]) if rows else None
        except TenantConfigError:
            return None

    def log(self, tenant: TenantRecord, call_sid: str, result: str, leg: int | None = None, contact: str = "",
            wait_s: int | None = None, detail: str = "", now: datetime | None = None) -> None:
        """One `dispatch_events` row (first name only, never a phone number). Never breaks a call."""
        c = self.rt.engine.find_convo(tenant, "voice", call_sid) if call_sid else None
        row = {"call_sid": call_sid or None, "call_id": (c.meta.get("call_row_id") if c else None), "leg": leg,
               "contact_name": (contact or "")[:60] or None, "result": result, "wait_s": wait_s,
               "detail": detail[:80] or None, "at": (now or self.rt.now()).isoformat()}
        try:
            self.rt.store.for_tenant(tenant.id).insert("dispatch_events", row)
        except StoreError:
            log.warning("dispatch event not stored (%s)", result)

    # --- warm transfer -------------------------------------------------------------------------
    def start(self, tenant: TenantRecord, c: Any, now: datetime) -> bool:
        """Called by the voice flow on the turn that hands the call over (mutates c.meta; the flow persists it)."""
        pend = c.meta.get("dispatch_collect") or {}
        legs = pend.get("legs") or plan(tenant.config, now)
        if not legs:
            return False
        c.meta["dispatch"] = {"legs": legs, "leg": 0, "state": "dialing", "started_at": now.isoformat(),
                              "brief": {k: pend.get(k) or "" for k in ("issue", "zip", "name")}, "declined": []}
        tenant_ts = self.rt.store.for_tenant(tenant.id)
        tenant_ts.log_event("dispatch.started", {"call_sid": c.convo_id, "legs": len(legs)})
        return True

    def leg_twiml(self, tenant: TenantRecord, call_sid: str, say: str = "") -> str:
        c = self.rt.engine.find_convo(tenant, "voice", call_sid)
        d = (c.meta.get("dispatch") if c else None) or {}
        vr = VoiceResponse()
        voice = tenant.config.voice.tts_voice
        if say:
            vr.say(say, voice=voice)
        legs, i = d.get("legs") or [], int(d.get("leg", 0))
        if i >= len(legs):
            vr.hangup()
            return str(vr)
        elapsed = (self.rt.now() - datetime.fromisoformat(d["started_at"])).total_seconds()
        ring = int(max(MIN_RING_S, min(LEG_RING_S, MAX_WAIT_S - elapsed)))
        # the technician sees the customer's own number (Meir 25.10), so he knows who it is and can call back;
        # Twilio allows passing the inbound caller through on a <Dial> from the same call
        caller = (c.contact if c else "") or ""
        shown = caller if re.fullmatch(r"\+[1-9]\d{7,14}", caller) else (tenant.twilio_number or None)
        dial = vr.dial(timeout=ring, action=f"/voice/dial-result?leg={i}", method="POST", caller_id=shown)
        dial.number(legs[i]["phone"], url=f"/voice/dispatch/whisper?d={self.token(tenant, call_sid, l=i)}",
                    method="POST")
        return str(vr)

    def whisper_twiml(self, claims: dict[str, Any], tenant: TenantRecord) -> str:
        c = self.rt.engine.find_convo(tenant, "voice", claims["c"])
        d = (c.meta.get("dispatch") if c else None) or {}
        vr = VoiceResponse()
        if d.get("state") != "dialing" or int(d.get("leg", -1)) != int(claims.get("l", -2)):
            vr.hangup()  # stale leg (the caller hung up, or a later leg is ringing)
            return str(vr)
        line = f"{brief_text(tenant.config.business.name, d['brief'])} Press 1 to take the call."
        g = vr.gather(num_digits=1, timeout=WHISPER_WAIT_S, method="POST",
                      action=f"/voice/dispatch/whisper-ack?d={self.token(tenant, claims['c'], l=claims['l'])}")
        g.say(line, voice=tenant.config.voice.tts_voice)
        g.pause(length=1)
        g.say(line, voice=tenant.config.voice.tts_voice)
        vr.hangup()
        return str(vr)

    def whisper_ack(self, claims: dict[str, Any], tenant: TenantRecord, digits: str, now: datetime) -> str:
        call_sid, leg = claims["c"], int(claims.get("l", -1))
        vr = VoiceResponse()
        with self.rt.flow._lock(call_sid):
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            d = (c.meta.get("dispatch") if c else None) or {}
            if d.get("state") != "dialing" or int(d.get("leg", -1)) != leg:
                vr.hangup()
                return str(vr)
            if (digits or "").strip() != "1":
                d.setdefault("declined", []).append(leg)
                self.rt.engine.save_convo(c)
                vr.hangup()
                return str(vr)
            wait = int((now - datetime.fromisoformat(d["started_at"])).total_seconds())
            d.update({"accepted_leg": leg, "accepted_at": now.isoformat(), "wait_s": wait, "state": "connected"})
            self.rt.engine.save_convo(c)
        self.log(tenant, call_sid, "accepted", leg, d["legs"][leg]["name"], wait, now=now)
        vr.say(ACCEPT_TEXT, voice=tenant.config.voice.tts_voice)
        return str(vr)  # end of the whisper document = Twilio bridges the technician to the caller

    def leg_result(self, tenant: TenantRecord, call_sid: str, leg: int, status: str, now: datetime) -> str:
        """Dial action of leg `leg`: connected call over -> hang up; else next leg, or the callback promise."""
        voice = tenant.config.voice.tts_voice
        with self.rt.flow._lock(call_sid):
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            d = (c.meta.get("dispatch") if c else None) or {}
            if not d or int(d.get("leg", -1)) != leg:
                vr = VoiceResponse()
                vr.hangup()
                return str(vr)
            if d.get("state") == "connected" and d.get("accepted_leg") == leg:
                d["dial_status"] = status
                self.rt.engine.save_convo(c)
                vr = VoiceResponse()
                vr.hangup()
                return str(vr)
            person = d["legs"][leg]["name"]
            result = "declined" if leg in (d.get("declined") or []) else "no_answer"
            d["leg"] = leg + 1
            elapsed = (now - datetime.fromisoformat(d["started_at"])).total_seconds()
            more = d["leg"] < len(d["legs"]) and elapsed < MAX_WAIT_S
            self.rt.engine.save_convo(c)
        self.log(tenant, call_sid, result, leg, person, detail=status[:20], now=now)
        if more:
            return self.leg_twiml(tenant, call_sid, HOLD_TEXT)
        text = nobody_text(tenant.config.dispatch.callback_minutes)
        self.escalate(tenant, call_sid, now, say=text)
        vr = VoiceResponse()
        vr.say(text, voice=voice)
        vr.hangup()
        return str(vr)

    # --- escalation ----------------------------------------------------------------------------
    def _alert_key(self, tenant: TenantRecord, call_sid: str) -> str:
        return f"dispatch:alert:{tenant.id}:{call_sid}"

    def _open_key(self, tenant: TenantRecord, phone: str) -> str:
        return f"dispatch:open:{tenant.id}:{who(phone)}"

    def targets(self, tenant: TenantRecord, d: dict[str, Any]) -> list[dict[str, str]]:
        """The on-call contact (first scheduled person tried) and the managers, with a written opt-in only."""
        contacts = {c.id: c for c in tenant.config.dispatch.contacts}
        first = next((contacts[x["id"]] for x in d.get("legs") or [] if x.get("id") in contacts), None)
        people = ([first] if first else []) + [c for c in tenant.config.dispatch.contacts if c.role == "manager"]
        out: list[dict[str, str]] = []
        for p in people:
            if p.alerts_opt_in_at and all(o["phone"] != p.phone for o in out):
                out.append({"id": p.id, "name": p.name, "phone": p.phone})
        return out

    def escalate(self, tenant: TenantRecord, call_sid: str, now: datetime, say: str = "") -> bool:
        """Nobody accepted (or the caller hung up while we were dialing): urgent message + staff alerts. Once."""
        with self.rt.flow._lock(call_sid):
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            d = (c.meta.get("dispatch") if c else None) or {}
            if not d or d.get("state") in ("alerting", "connected"):
                return False
            d["state"] = "alerting"
            if say:
                c.transcript.append({"who": "assistant", "text": say})
            actions = self.rt.engine.close(tenant, c, "message", "lead",
                                           "Urgent call: no on-call technician took the call; call the customer back")
            targets = self.targets(tenant, d)
            self.rt.flow._persist(tenant, c)
        self.rt.deliver(tenant, actions, call_sid)
        self.rt.state.put(self._alert_key(tenant, call_sid), {
            "status": "open", "brief": d["brief"], "targets": targets, "caller": c.contact,
            "created_at": now.isoformat()}, tenant.id)
        for t in targets:
            self.rt.state.put(self._open_key(tenant, t["phone"]), call_sid, tenant.id)
        if not targets:
            self.rt.store.for_tenant(tenant.id).log_event("dispatch.no_alert_targets", {"call_sid": call_sid})
            return True
        self.rt._submit(self.send_round, tenant, call_sid, 1, now)
        self.rt.outbound._add_job(tenant, {"kind": "dispatch_alert", "contact": "", "call_sid": call_sid, "attempt": 2,
                                           "due": (now + ALERT_RETRY).isoformat(), "dedupe": f"dispatch_alert:{call_sid}:2"})
        return True

    def on_finalize(self, tenant: TenantRecord, call_sid: str, now: datetime) -> None:
        """Caller hung up while the legs were ringing: still alert the team (no one took it)."""
        c = self.rt.engine.find_convo(tenant, "voice", call_sid)
        d = (c.meta.get("dispatch") if c else None) or {}
        if d.get("state") == "dialing":
            self.escalate(tenant, call_sid, now)

    def is_handled(self, tenant: TenantRecord, call_sid: str) -> bool:
        try:
            return bool(self.rt.store.for_tenant(tenant.id).select("dispatch_events", call_sid=call_sid, result="handled"))
        except StoreError:
            return False

    def alert_state(self, tenant: TenantRecord, call_sid: str) -> dict[str, Any] | None:
        a = self.rt.state.get(self._alert_key(tenant, call_sid))
        if a and a.get("status") == "open" and self.is_handled(tenant, call_sid):
            a["status"] = "handled"
            self.rt.state.put(self._alert_key(tenant, call_sid), a, tenant.id)
        return a

    def sms_enabled(self, tenant: TenantRecord) -> bool:
        return bool(self.rt.settings.dispatch_sms_alerts and tenant.config.dispatch.sms_alerts)

    def send_round(self, tenant: TenantRecord, call_sid: str, attempt: int, now: datetime) -> dict[str, Any]:
        a = self.alert_state(tenant, call_sid)
        if not a or a.get("status") != "open":
            return {"sent": 0, "reason": (a or {}).get("status", "no_alert")}
        ts = self.rt.store.for_tenant(tenant.id)
        business = tenant.config.business.name
        sent = 0
        for t in a.get("targets") or []:
            if ts.is_opted_out(t["phone"]) or guard.is_blocked(t["phone"], tenant.config):
                continue
            if self.sms_enabled(tenant):
                res = self.rt.outbound.send(tenant, t["phone"], alert_sms(business, a["brief"]), "staff_alert", now)
                ok, how = bool(res.get("sent")), "sms"
            else:
                ok, how = self._alert_call(tenant, call_sid, t), "call"
            if ok:
                sent += 1
                self.log(tenant, call_sid, "alert_sent", None, t["name"], detail=f"{how} {attempt}", now=now)
        ts.log_event("dispatch.alert_round", {"call_sid": call_sid, "attempt": attempt, "sent": sent})
        return {"sent": sent}

    def _alert_call(self, tenant: TenantRecord, call_sid: str, target: dict[str, str]) -> bool:
        client, base = self.rt.outbound.client, self.rt.settings.public_base_url
        if client is None or not tenant.twilio_number or not base or not hasattr(client, "calls"):
            self.rt.store.for_tenant(tenant.id).log_event("dispatch.alert_not_sent", {"reason": "no_voice_client"})
            return False
        url = f"{base}/voice/dispatch/alert?d={self.token(tenant, call_sid, i=target['id'])}"
        try:
            client.calls.create(to=target["phone"], from_=tenant.twilio_number, url=url, method="POST",
                                timeout=ALERT_RING_S)
        except Exception as exc:  # noqa: BLE001 - provider errors never break the flow
            self.rt.store.for_tenant(tenant.id).log_event("dispatch.alert_failed", {"error": type(exc).__name__})
            return False
        return True

    def run_job(self, tenant: TenantRecord, job: dict[str, Any], now: datetime) -> dict[str, Any]:
        return self.send_round(tenant, job["call_sid"], int(job.get("attempt", 2)), now)

    def acknowledge(self, tenant: TenantRecord, call_sid: str, name: str, how: str, now: datetime) -> bool:
        a = self.alert_state(tenant, call_sid)
        if not a or a.get("status") != "open":
            return False
        a.update({"status": "acknowledged", "by": name, "at": now.isoformat()})
        self.rt.state.put(self._alert_key(tenant, call_sid), a, tenant.id)
        for t in a.get("targets") or []:
            self.rt.state.put(self._open_key(tenant, t["phone"]), None, tenant.id)
        self.log(tenant, call_sid, "acknowledged", None, name, detail=how, now=now)
        return True

    def alert_twiml(self, claims: dict[str, Any], tenant: TenantRecord) -> str:
        a = self.alert_state(tenant, claims["c"]) or {}
        vr = VoiceResponse()
        if a.get("status") != "open":
            vr.say("This on-call alert is already taken care of. Thank you. Goodbye.", voice=tenant.config.voice.tts_voice)
            vr.hangup()
            return str(vr)
        line = alert_say(tenant.config.business.name, a["brief"])
        g = vr.gather(num_digits=1, timeout=WHISPER_WAIT_S, method="POST",
                      action=f"/voice/dispatch/alert-ack?d={self.token(tenant, claims['c'], i=claims.get('i'))}")
        g.say(line, voice=tenant.config.voice.tts_voice)
        g.pause(length=1)
        g.say(line, voice=tenant.config.voice.tts_voice)
        vr.hangup()
        return str(vr)

    def alert_ack(self, claims: dict[str, Any], tenant: TenantRecord, digits: str, now: datetime) -> str:
        vr = VoiceResponse()
        voice = tenant.config.voice.tts_voice
        a = self.alert_state(tenant, claims["c"]) or {}
        target = next((t for t in a.get("targets") or [] if t["id"] == claims.get("i")), None)
        if (digits or "").strip() != "1" or target is None or not self.acknowledge(tenant, claims["c"], target["name"], "call", now):
            vr.hangup()
            return str(vr)
        caller = a.get("caller") or ""
        if re.fullmatch(r"\+[1-9]\d{7,14}", caller):
            vr.say(ALERT_ACCEPT_TEXT, voice=voice)
            vr.dial(caller, caller_id=tenant.twilio_number or None, timeout=30)  # live call, the customer asked for it
        else:
            vr.say(ALERT_NO_CALLER_TEXT, voice=voice)
        vr.hangup()
        return str(vr)

    # --- SMS from staff ------------------------------------------------------------------------
    def staff_contact(self, tenant: TenantRecord, phone: str) -> Any:
        return next((c for c in tenant.config.dispatch.contacts if c.phone == phone), None)

    def ack_sms(self, tenant: TenantRecord, phone: str, now: datetime) -> bool:
        person = self.staff_contact(tenant, phone)
        call_sid = self.rt.state.get(self._open_key(tenant, phone)) if person else None
        return bool(call_sid) and self.acknowledge(tenant, call_sid, person.name, "sms", now)

    def note_opt_out(self, tenant: TenantRecord, phone: str, now: datetime) -> None:
        """A staff number texted STOP: no more alerts to it (send-time check) and a flag in the portal log."""
        person = self.staff_contact(tenant, phone)
        if person is None or not self.rt.store.for_tenant(tenant.id).is_opted_out(phone):
            return
        flag = f"dispatch:optout:{tenant.id}:{who(phone)}"
        if self.rt.state.get(flag):
            return
        self.rt.state.put(flag, now.isoformat(), tenant.id)
        self.log(tenant, "", "opted_out", None, person.name, detail="sms", now=now)


# --- routes (Twilio-signed: /voice/ prefix; plus the signed token bound to the call) -------------------

router = APIRouter()


def _xml(body: str) -> Response:
    return Response(body, media_type=TWIML)


def _hangup() -> Response:
    vr = VoiceResponse()
    vr.hangup()
    return _xml(str(vr))


async def _ctx(request: Request) -> tuple["Runtime", dict[str, Any] | None, TenantRecord | None, Any]:
    rt = request.app.state.rt
    form = await request.form()
    claims = rt.dispatcher.claims(request.query_params.get("d", ""))
    tenant = await run_in_threadpool(rt.dispatcher.tenant_of, claims) if claims else None
    return rt, claims, tenant, form


@router.post("/voice/dispatch/whisper")
async def dispatch_whisper(request: Request) -> Response:
    rt, claims, tenant, _ = await _ctx(request)
    if not (claims and tenant and "l" in claims):
        return _hangup()
    return _xml(await run_in_threadpool(rt.dispatcher.whisper_twiml, claims, tenant))


@router.post("/voice/dispatch/whisper-ack")
async def dispatch_whisper_ack(request: Request) -> Response:
    rt, claims, tenant, form = await _ctx(request)
    if not (claims and tenant and "l" in claims):
        return _hangup()
    return _xml(await run_in_threadpool(rt.dispatcher.whisper_ack, claims, tenant, str(form.get("Digits", "")), rt.now()))


@router.post("/voice/dispatch/alert")
async def dispatch_alert(request: Request) -> Response:
    rt, claims, tenant, _ = await _ctx(request)
    if not (claims and tenant and "i" in claims):
        return _hangup()
    return _xml(await run_in_threadpool(rt.dispatcher.alert_twiml, claims, tenant))


@router.post("/voice/dispatch/alert-ack")
async def dispatch_alert_ack(request: Request) -> Response:
    rt, claims, tenant, form = await _ctx(request)
    if not (claims and tenant and "i" in claims):
        return _hangup()
    return _xml(await run_in_threadpool(rt.dispatcher.alert_ack, claims, tenant, str(form.get("Digits", "")), rt.now()))
