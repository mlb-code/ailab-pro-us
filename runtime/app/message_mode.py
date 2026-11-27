"""Message-only service for FirstRing plan tenants (trial ended unpaid, cancelled after the paid period, past due beyond
the grace period, paused, the trial's minutes used up, or the plan's included minutes used up): the line never goes dead
for callers, but it stops costing AI minutes. It takes the caller's name, number and reason and e-mails them to the
owner; it does not book visits or answer other questions.

Voice: one short fixed greeting with the call notice, one speech turn for name + number + reason, a thank-you, hang up
(plain <Say>/<Gather>: no ConversationRelay, no Claude, no booking). The notice plays in full before we listen, so words
said over it are not heard: when the turn comes back empty, the caller is asked once more (RETRY, can be talked over),
and a second empty turn ends with NO_MESSAGE, never with "We've passed your message on". The message goes to the owner as a normal lead
alert (e-mail; SMS once texting is live). SMS and the website chat get one fixed reply and the same owner alert.
Quote clients (no `config.plan`) never enter this mode: a paused quote tenant behaves as before.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from twilio.twiml.voice_response import VoiceResponse

from . import guard
from . import plans as plans_mod

log = logging.getLogger("rt.message_mode")

VOICE = "Polly.Joanna-Neural"
THANKS = "Thank you. We've passed your message on, and someone will call you back. Goodbye."
RETRY = "Sorry, I didn't catch that. Please say your name, your phone number and what you need."
NO_MESSAGE = "Sorry, we didn't get a message. Please call again when you're ready. Goodbye."
TEXT_REPLY = "Thanks for your message. We've passed it on, and someone from our team will get back to you soon."
REASONS = ("trial_ended", "canceled", "past_due", "paused", "trial_minutes_used", "plan_minutes_used", "message_only")


def greeting(name: str, sms: bool = False) -> str:
    """sms = settings.sms_enabled: the notice's texting clause only while texting is on (`guard.disclosure`)."""
    return (f"Thanks for calling {name}. {guard.disclosure(sms)} We can't take your call live right now. "
            "Please say your name, your phone number and what you need, and someone will call you back.")


def reason(tenant: Any, usage: Any, now: datetime) -> str:
    """Why this tenant is in message-only mode right now ('' = full service). Plan tenants only."""
    t = plans_mod.terms(tenant.config)
    if t is None:
        return ""
    if t.service == "message_only":
        return t.reason or "message_only"
    if not tenant.active:  # the client pressed "Pause AI": callers are still served, without AI minutes
        return "paused"
    if plans_mod.usage_cap_mode() == "message" and usage is not None:
        return usage.cap_reached(tenant, now)
    return ""


def _flag(call_sid: str) -> str:
    return f"mmcall:{call_sid}"


def _listen(vr: VoiceResponse) -> Any:
    """The caller's speech turn (actionOnEmptyResult: silence also comes back to /voice/message-mode)."""
    return vr.gather(input="speech", action="/voice/message-mode", method="POST", speech_model="phone_call",
                     enhanced=True, speech_timeout="auto", action_on_empty_result=True, language="en-US")


class MessageMode:
    def __init__(self, rt: Any):
        self.rt = rt

    def voice_incoming(self, tenant: Any, call_sid: str, caller: str, why: str, now: datetime,
                       forwarded_from: str = "") -> str:
        ts = self.rt.store.for_tenant(tenant.id)
        text = greeting(tenant.config.business.name, bool(getattr(self.rt.settings, "sms_enabled", False)))
        if not ts.select("calls", call_sid=call_sid):
            row = {"call_sid": call_sid, "from_e164": caller, "started_at": now.isoformat(),
                   "transcript": [{"who": "assistant", "text": text}], "outcome": None,
                   **notice_record(bool(getattr(self.rt.settings, "sms_enabled", False)))}
            if forwarded_from:
                row["forwarded_from"] = forwarded_from
            insert_call(ts, row)
            ts.log_event("message_mode.call", {"call_sid": call_sid, "reason": why})
        self.rt.state.put(_flag(call_sid), {"reason": why}, tenant.id)
        vr = VoiceResponse()
        vr.say(text, voice=VOICE)  # the notice plays in full before we listen
        _listen(vr)
        return str(vr)

    def voice_message(self, tenant: Any, call_sid: str, caller: str, speech: str, now: datetime) -> str:
        ts = self.rt.store.for_tenant(tenant.id)
        said = (speech or "").strip()[:500]
        flag = self.rt.state.get(_flag(call_sid)) or {}
        retry = not said and not (isinstance(flag, dict) and flag.get("retried"))  # nothing heard: ask once more
        reply = THANKS if said else RETRY if retry else NO_MESSAGE
        rows = ts.select("calls", call_sid=call_sid)
        if rows:
            notice_completed(ts, rows[0], now)  # this turn comes only after the <Say> with the notice
            transcript = list(rows[0].get("transcript") or [])
            if said:
                transcript.append({"who": "customer", "text": said})
            transcript.append({"who": "assistant", "text": reply})
            ts.update("calls", rows[0]["id"], {"transcript": transcript, "outcome": "message" if said else None,
                                               "summary": f"Message: {said}"[:400] if said else "No speech"})
        vr = VoiceResponse()
        if retry:
            self.rt.state.put(_flag(call_sid), {**(flag if isinstance(flag, dict) else {}), "retried": True}, tenant.id)
            _listen(vr).say(reply, voice=VOICE)  # the notice was heard already: the caller may talk over this line
            return str(vr)
        if said:
            self.alert(tenant, caller, "voice", f"Message taken (your receptionist is in message-only mode): {said}",
                       f"mm:{call_sid}")
        vr.say(reply, voice=VOICE)
        vr.hangup()
        return str(vr)

    def is_call(self, call_sid: str) -> bool:
        return bool(self.rt.state.get(_flag(call_sid)))

    def voice_finished(self, tenant: Any, call_sid: str, duration_s: int, now: datetime) -> None:
        """Status callback of a message-mode call: duration, abandoned outcome, minutes into the usage meter."""
        ts = self.rt.store.for_tenant(tenant.id)
        rows = ts.select("calls", call_sid=call_sid)
        if rows:
            patch: dict[str, Any] = {"duration_s": int(duration_s)}
            if rows[0].get("outcome") is None:
                patch["outcome"] = "abandoned"
            ts.update("calls", rows[0]["id"], patch)
        flag = f"callusage:{tenant.id}:{call_sid}"
        if duration_s > 0 and not self.rt.state.get(flag):
            self.rt.state.put(flag, True, tenant.id)
            actions: list[dict] = []
            self.rt.engine._usage(tenant, ts, "voice", -(-int(duration_s) // 60), now, actions)
            self.rt.deliver(tenant, actions, f"usage:{now:%Y-%m}")

    def alert(self, tenant: Any, contact: str, channel: str, summary: str, ref: str) -> None:
        self.rt.deliver(tenant, [{"type": "alert", "kind": "lead", "summary": summary[:300], "urgency": "normal",
                                  "contact": contact, "channel": channel}], ref)


# calls columns added by later migrations: dropped from the insert if the database does not have them yet, so a runtime
# deployed before its migration never loses a call (forwarded_from: 2026-11-25; the notice record: 2026-11-30)
OPTIONAL_CALL_COLUMNS = ("forwarded_from", "notice_version", "notice_lang")


def insert_call(ts: Any, row: dict[str, Any]) -> dict[str, Any]:
    """Insert a calls row; OPTIONAL_CALL_COLUMNS are dropped if the database does not accept them yet."""
    from .store import StoreError
    try:
        return ts.insert("calls", row)
    except StoreError:
        if not any(k in row for k in OPTIONAL_CALL_COLUMNS):
            raise
        log.warning("calls: newer columns not accepted by the store; saved the call without them")
        return ts.insert("calls", {k: v for k, v in row.items() if k not in OPTIONAL_CALL_COLUMNS})


def notice_record(sms: bool, spanish: bool = False) -> dict[str, str]:
    """The call notice a call plays, for its calls row (legal decisions 2026-11-27, item 2): the version id of the variant
    (`guard.disclosure_version`, with or without the texting clause) and its languages ("en", or "en+es" when the
    Spanish notice is played too). Kept with the call record (the row outlives the 90-day transcript purge)."""
    return {"notice_version": guard.disclosure_version(sms), "notice_lang": "en+es" if spanish else "en"}


def notice_completed(ts: Any, row: dict[str, Any] | None, now: Any) -> None:
    """Stamp calls.notice_completed_at once: the first moment we know the notice had finished playing (the relay session
    started, which Twilio does only after the <Say>; or the first speech turn, which comes only after the <Say>).
    Never fails the call (a database without the column yet)."""
    from .store import StoreError
    if not row or row.get("notice_completed_at"):
        return
    try:
        ts.update("calls", row["id"], {"notice_completed_at": now.isoformat()})
    except StoreError:
        log.warning("calls.notice_completed_at not accepted by the store")
