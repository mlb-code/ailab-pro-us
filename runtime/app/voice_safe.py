"""Safe mode for a tenant whose stored config does not validate (`invalid_config`).

The line must never go dead silently. Without a valid config there is no brain, calendar or owner
settings, so the runtime falls back to the minimum that is always safe:
- voice: one short, polite sentence, then it records the caller's name and number (one speech turn),
  thanks them and hangs up. When the call ends, the caller gets an SMS text-back (opt-out, blocklist
  and quiet hours are checked; at most one a day per number);
- SMS: STOP/START/HELP still work. Any other text gets one minimal reply and is logged;
- every time: event `tenant_config_invalid` and an admin alert to Meir (Hebrew, via notify) once a
  day per tenant. Caller messages go to the admin as well, because the owner's alert settings are
  part of the broken config.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from twilio.twiml.messaging_response import MessagingResponse
from twilio.twiml.voice_response import VoiceResponse

from . import guard
from .runtime_ctx import Runtime, who
from .tenants import TenantConfigError, load_record

log = logging.getLogger("rt.safe")

KIND = "tenant_config_invalid"
SAFE_VOICE = "Polly.Joanna-Neural"
FALLBACK_TZ = "America/New_York"


def safe_greeting(name: str) -> str:
    return (f"Thanks for calling {name}. Sorry we missed you. This call may be recorded. "
            "Please say your name and the best number to reach you, and someone will call you back.")


SAFE_THANKS = "Thank you. Someone from our team will call you back soon. Goodbye."
SAFE_SMS_REPLY = "Thanks for your message. Someone from our team will get back to you soon. Reply STOP to opt out."


def safe_textback(name: str) -> str:
    return f"Hi, this is {name}. Sorry we missed your call! Someone will get back to you soon. Reply STOP to opt out."


@dataclass
class BrokenTenant:
    id: str
    slug: str
    name: str
    twilio_number: str
    main_phone: str
    timezone: str
    problems: list[str] = field(default_factory=list)


def broken_tenant(rt: Runtime, number: str) -> BrokenTenant | None:
    """The raw row behind an `invalid_config` lookup, with whatever is still readable."""
    rows = rt.store.select("tenants", twilio_number=number)
    if not rows:
        return None
    row = rows[0]
    try:
        load_record(row)
        problems: list[str] = []
    except TenantConfigError as exc:
        problems = exc.problems
    cfg = row.get("config") if isinstance(row.get("config"), dict) else {}
    biz = cfg.get("business") if isinstance(cfg.get("business"), dict) else {}
    name = biz.get("name") if isinstance(biz.get("name"), str) and biz.get("name").strip() else "our team"
    tz = biz.get("timezone") if isinstance(biz.get("timezone"), str) else FALLBACK_TZ
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        tz = FALLBACK_TZ
    phone = biz.get("main_phone") if isinstance(biz.get("main_phone"), str) else ""
    return BrokenTenant(str(row.get("id")), str(row.get("slug") or "?"), name[:120], number, phone, tz, problems)


def _admin_send(rt: Runtime, bt: BrokenTenant, summary: str, key: str, now: datetime) -> None:
    """Hebrew admin alert through B6's notifier (urgent: the line is degraded). Runs off the webhook."""
    try:
        from .hooks_b56 import notifier_for
        from .notify import templates as T
    except ImportError:  # pragma: no cover - B6 always present in this repo
        return
    n = notifier_for(rt.store, rt.state)
    subject, text, html = T.admin_alert(KIND, bt.name, bt.slug, summary)
    n._admin_send(KIND, subject, text, html, now, key=f"{bt.id}:{key}", urgent=True)


class SafeMode:
    def __init__(self, rt: Runtime):
        self.rt = rt

    def _day(self, bt: BrokenTenant, now: datetime) -> str:
        return now.astimezone(ZoneInfo(bt.timezone)).date().isoformat()

    def report(self, bt: BrokenTenant, channel: str, now: datetime) -> None:
        """Event + admin alert, once a day per tenant."""
        flag = f"cfginvalid:{bt.id}:{self._day(bt, now)}"
        if self.rt.state.get(flag):
            return
        self.rt.state.put(flag, True, bt.id)
        self.rt.store.for_tenant(bt.id).log_event(KIND, {"slug": bt.slug, "channel": channel,
                                                         "problems": bt.problems[:5]})
        summary = ("הקונפיג של הלקוח לא עובר ולידציה. הקו עונה במצב חירום: לוקח שם וטלפון ושולח text-back. "
                   f"בעיות: {'; '.join(bt.problems[:3])}")
        self.rt._submit(_admin_send, self.rt, bt, summary, f"{KIND}:{self._day(bt, now)}", now)

    # --- voice -------------------------------------------------------------------------------------
    def voice_incoming(self, bt: BrokenTenant, call_sid: str, caller: str, now: datetime) -> str:
        self.report(bt, "voice", now)
        ts = self.rt.store.for_tenant(bt.id)
        if not ts.select("calls", call_sid=call_sid):
            ts.insert("calls", {"call_sid": call_sid, "from_e164": caller, "started_at": now.isoformat(),
                                "transcript": [{"who": "assistant", "text": safe_greeting(bt.name)}], "outcome": None})
        vr = VoiceResponse()
        g = vr.gather(input="speech", action="/voice/safe-message", method="POST", speech_model="phone_call",
                      enhanced=True, speech_timeout="auto", action_on_empty_result=True, language="en-US")
        g.say(safe_greeting(bt.name), voice=SAFE_VOICE)
        return str(vr)

    def voice_message(self, bt: BrokenTenant, call_sid: str, caller: str, speech: str, now: datetime) -> str:
        ts = self.rt.store.for_tenant(bt.id)
        rows = ts.select("calls", call_sid=call_sid)
        said = (speech or "").strip()[:300]
        if rows:
            transcript = list(rows[0].get("transcript") or [])
            if said:
                transcript.append({"who": "customer", "text": said})
            transcript.append({"who": "assistant", "text": SAFE_THANKS})
            ts.update("calls", rows[0]["id"], {"transcript": transcript, "outcome": "message" if said else None,
                                               "summary": f"Message (safe mode): {said}" if said else "No speech"})
        if said:
            ts.log_event("safe_mode.message", {"call_sid": call_sid})
            summary = f"הודעה ממתקשר (הקו במצב חירום). מספר: {caller}. נאמר: {said}"
            self.rt._submit(_admin_send, self.rt, bt, summary, f"msg:{call_sid}", now)
        vr = VoiceResponse()
        vr.say(SAFE_THANKS, voice=SAFE_VOICE)
        vr.hangup()
        return str(vr)

    def voice_finished(self, bt: BrokenTenant, call_sid: str, caller: str, duration_s: int, now: datetime) -> None:
        ts = self.rt.store.for_tenant(bt.id)
        rows = ts.select("calls", call_sid=call_sid)
        if rows:
            patch: dict[str, Any] = {"duration_s": int(duration_s)}
            if rows[0].get("outcome") is None:
                patch["outcome"] = "abandoned"
            ts.update("calls", rows[0]["id"], patch)
        flag = f"safetextback:{bt.id}:{who(caller)}:{self._day(bt, now)}"
        if caller and not self.rt.state.get(flag):
            self.rt.state.put(flag, True, bt.id)
            self.send(bt, caller, safe_textback(bt.name), now)

    # --- sms ---------------------------------------------------------------------------------------
    def send(self, bt: BrokenTenant, to: str, body: str, now: datetime) -> dict[str, Any]:
        """Proactive SMS without a valid config: opt-out + quiet hours (tenant tz, else Eastern)."""
        ts = self.rt.store.for_tenant(bt.id)
        h = now.astimezone(ZoneInfo(bt.timezone)).hour
        reason = ("opted_out" if ts.is_opted_out(to) else "quiet_hours" if (h >= 21 or h < 8)
                  else "no_twilio_client" if self.rt.outbound.client is None else "")
        if reason:
            ts.log_event("sms.not_sent", {"kind": "safe_textback", "reason": reason})
            return {"sent": False, "reason": reason}
        try:
            msg = self.rt.outbound.client.messages.create(to=to, from_=bt.twilio_number, body=body)
        except Exception as exc:  # noqa: BLE001
            ts.log_event("sms.send_failed", {"kind": "safe_textback", "error": type(exc).__name__})
            return {"sent": False, "reason": "send_failed"}
        ts.insert("sms_messages", {"contact_e164": to, "direction": "outbound", "body": body,
                                   "twilio_sid": getattr(msg, "sid", None)})
        ts.log_event("sms.sent", {"kind": "safe_textback"})
        return {"sent": True}

    def sms(self, bt: BrokenTenant, form: dict[str, str], now: datetime) -> str:
        reply = self._sms_reply(bt, form, now)
        if reply:
            self.rt.store.for_tenant(bt.id).insert("sms_messages", {
                "contact_e164": form.get("From", ""), "direction": "outbound", "body": reply, "twilio_sid": None})
        return reply

    def _sms_reply(self, bt: BrokenTenant, form: dict[str, str], now: datetime) -> str:
        self.report(bt, "sms", now)
        ts = self.rt.store.for_tenant(bt.id)
        contact, sid, body = form.get("From", ""), form.get("MessageSid", ""), form.get("Body", "") or ""
        if sid and ts.select("sms_messages", twilio_sid=sid):
            return ""
        ts.insert("sms_messages", {"contact_e164": contact, "direction": "inbound", "body": body[:2000],
                                   "twilio_sid": sid or None})
        kw = guard.sms_keyword(body)
        if kw == "stop" or form.get("OptOutType", "").upper() == "STOP":
            was = ts.is_opted_out(contact)
            ts.opt_out(contact)
            return "" if (was or form.get("OptOutType")) else guard.stop_confirmation(bt.name)
        if kw == "start" and ts.is_opted_out(contact):
            ts.opt_in(contact)
            return guard.start_confirmation(bt.name)
        if ts.is_opted_out(contact):
            return ""
        if kw == "help":
            reply = guard.help_text(bt.name, bt.main_phone) if bt.main_phone else SAFE_SMS_REPLY
        else:
            reply = SAFE_SMS_REPLY
            if body.strip():
                summary = f"SMS ממספר {contact} (הקו במצב חירום): {body.strip()[:300]}"
                self.rt._submit(_admin_send, self.rt, bt, summary, f"sms:{sid or who(contact)}", now)
        return reply


def sms_twiml(reply: str) -> str:
    resp = MessagingResponse()
    if reply:
        resp.message(reply)
    return str(resp)
