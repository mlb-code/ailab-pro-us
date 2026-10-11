"""Every SMS we send that is not a direct TwiML reply goes through `Outbound.send` (one choke point).

Rules enforced here for all kinds (text-back, booking confirmation, reminder):
- never to a number that opted out (STOP) or is on the tenant blocklist, checked at send time;
- quiet hours 21:00-08:00 tenant time for anything that is not a direct reply (SPEC 6.3): queued
  jobs wait for 08:00; a send attempted inside quiet hours is refused;
- text-back only to numbers Lookup does not report as landline / toll-free / pager (result cached
  30 days), at most one per number per local day;
- every message is logged in `sms_messages` and its segments counted toward monthly usage.

Jobs (text-back after an abandoned call, one reminder 24 h before a booking) live in
`runtime_state` under `jobs:<tenant_id>` and run from `run_due(now)`: right after the event that
queued them (background task) and from the cron `POST /jobs/tick` (B6 route, RUNTIME_ADMIN_TOKEN).
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from . import _stubs_b56 as hooks
from . import guard
from .runtime_ctx import who
from .tenants import TenantConfigError, TenantRecord, load_record

log = logging.getLogger("rt.sms_out")

NO_TEXT_LINE_TYPES = {"landline", "tollFree", "premium", "sharedCost", "uan", "voicemail", "pager"}
LOOKUP_TTL = timedelta(days=30)
THREAD_IDLE = timedelta(hours=24)
REMINDER_BEFORE = timedelta(hours=24)


def textback_text(tenant: TenantRecord) -> str:
    cfg = tenant.config
    link = f" You can also book here: {cfg.booking.booking_link}." if cfg.booking.booking_link else ""
    return (f"Hi, this is {cfg.business.name}. Sorry we missed your call! What can we help with?{link} "
            "Reply STOP to opt out.")


def confirmation_text(tenant: TenantRecord, booking: dict[str, Any]) -> str:
    return (f"{tenant.config.business.name}: you're booked for {booking.get('label') or booking.get('start')}. "
            "Reply here if you need anything. Reply STOP to opt out.")


def reminder_text(tenant: TenantRecord, booking: dict[str, Any]) -> str:
    return (f"{tenant.config.business.name}: reminder of your visit {booking.get('label') or booking.get('start')}. "
            "Reply here if you need to change it. Reply STOP to opt out.")


def next_allowed(cfg, t: datetime) -> datetime:
    """`t` if outside quiet hours, else the next 08:00 tenant time."""
    if not guard.quiet_hours(cfg, t):
        return t
    tz = ZoneInfo(cfg.business.timezone)
    local = t.astimezone(tz)
    day = local.date() if local.hour < 8 else local.date() + timedelta(days=1)
    return datetime.combine(day, time(8, 0), tz)


def thread_id(state, tenant: TenantRecord, contact: str, now: datetime) -> str:
    """SMS conversation id per number; a new thread starts after 24 h without messages."""
    key = f"smsthread:{tenant.id}:{who(contact)}"
    cur = state.get(key) or {"n": 0, "last": None}
    if cur["last"] is None or now - datetime.fromisoformat(cur["last"]) > THREAD_IDLE:
        cur["n"] += 1
    cur["last"] = now.isoformat()
    state.put(key, cur, tenant.id)
    return f"sms-{who(contact)}-{cur['n']}"


def rest_client(settings) -> Any:
    """Twilio REST client: the recording fake in the simulator, the real one in production."""
    if settings.is_sim:
        from sim.fake_twilio import FakeTwilioClient
        return FakeTwilioClient()
    if settings.twilio_account_sid and settings.twilio_auth_token:  # pragma: no cover - real network client
        from twilio.rest import Client
        return Client(settings.twilio_account_sid, settings.twilio_auth_token)
    return None


class Outbound:
    def __init__(self, settings, store, client: Any = None):
        self.settings = settings
        self.store = store
        self.client = client
        self.rt = None  # set by main.create_app (usage + alert delivery)
        self._lock = threading.Lock()

    @property
    def state(self):
        return self.rt.state

    # --- sending ----------------------------------------------------------------------------
    def send(self, tenant: TenantRecord, to: str, body: str, kind: str, now: datetime,
             direct_reply: bool = False) -> dict[str, Any]:
        cfg = tenant.config
        ts = self.store.for_tenant(tenant.id)
        reason = ""
        if guard.is_blocked(to, cfg):
            reason = "blocklist"
        elif ts.is_opted_out(to):
            reason = "opted_out"
        elif not tenant.active:
            reason = "tenant_paused"
        elif not direct_reply and guard.quiet_hours(cfg, now):
            reason = "quiet_hours"
        elif self.client is None or not tenant.twilio_number:
            reason = "no_twilio_client"
        if reason:
            ts.log_event("sms.not_sent", {"kind": kind, "reason": reason})
            return {"sent": False, "reason": reason}
        extra = {"status_callback": f"{self.settings.public_base_url}/sms/status"} if self.settings.public_base_url else {}
        try:
            msg = self.client.messages.create(to=to, from_=tenant.twilio_number, body=body, **extra)
        except Exception as exc:  # noqa: BLE001 - provider errors must not break the call flow
            ts.log_event("sms.send_failed", {"kind": kind, "error": type(exc).__name__})
            return {"sent": False, "reason": "send_failed"}
        hooks.record_sms(self.store, self.state, tenant, twilio_sid=getattr(msg, "sid", None), contact_e164=to,
                         direction="outbound", body=body[:2000], segments=guard.sms_segments(body))
        ts.log_event("sms.sent", {"kind": kind, "sid": getattr(msg, "sid", None)})
        actions: list[dict] = []
        self.rt.engine._usage(tenant, ts, "sms", guard.sms_segments(body), now, actions)
        self.rt.deliver(tenant, actions, f"usage:{now:%Y-%m}")
        return {"sent": True, "sid": getattr(msg, "sid", None)}

    def line_type(self, tenant: TenantRecord, number: str, now: datetime) -> str:
        key = f"lookup:{who(number)}"
        cached = self.state.get(key)
        if cached and now - datetime.fromisoformat(cached["at"]) < LOOKUP_TTL:
            return cached["type"]
        try:
            res = self.client.lookups.v2.phone_numbers(number).fetch(fields="line_type_intelligence")
            kind = str((res.line_type_intelligence or {}).get("type") or "unknown")
        except Exception:  # noqa: BLE001 - lookup failure: try to send anyway
            return "unknown"
        self.state.put(key, {"type": kind, "at": now.isoformat()})
        return kind

    # --- jobs -------------------------------------------------------------------------------
    def _jobs_key(self, tenant_id: str) -> str:
        return f"jobs:{tenant_id}"

    def jobs(self, tenant: TenantRecord) -> list[dict[str, Any]]:
        return list(self.state.get(self._jobs_key(tenant.id)) or [])

    def _add_job(self, tenant: TenantRecord, job: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            jobs = self.jobs(tenant)
            if any(j.get("dedupe") == job["dedupe"] for j in jobs):
                return {}
            job = {"id": uuid.uuid4().hex[:12], **job}
            jobs.append(job)
            self.state.put(self._jobs_key(tenant.id), jobs, tenant.id)
            return job

    def enqueue_textback(self, tenant: TenantRecord, contact: str, call_sid: str, now: datetime) -> dict[str, Any]:
        due = next_allowed(tenant.config, now)
        return self._add_job(tenant, {"kind": "textback", "contact": contact, "call_sid": call_sid,
                                      "due": due.isoformat(), "dedupe": f"textback:{call_sid}"})

    def enqueue_reminder(self, tenant: TenantRecord, contact: str, booking: dict[str, Any], now: datetime) -> dict[str, Any]:
        start = datetime.fromisoformat(booking["start"])
        due = next_allowed(tenant.config, start - REMINDER_BEFORE)
        if due < now + timedelta(hours=1) or due > start - timedelta(hours=1):
            return {}  # booked less than a day ahead: the confirmation is enough
        return self._add_job(tenant, {"kind": "reminder", "contact": contact, "due": due.isoformat(),
                                      "booking": {k: booking.get(k) for k in ("start", "label", "event_id")},
                                      "dedupe": f"reminder:{booking.get('event_id')}"})

    def run_due(self, now: datetime, tenant: TenantRecord | None = None) -> list[dict[str, Any]]:
        tenants = [tenant] if tenant else self._all_tenants()
        done: list[dict[str, Any]] = []
        for t in tenants:
            with self._lock:
                jobs = self.jobs(t)
                due = [j for j in jobs if datetime.fromisoformat(j["due"]) <= now]
                if not due:
                    continue
                self.state.put(self._jobs_key(t.id), [j for j in jobs if j not in due], t.id)
            for job in due:
                done.append({"job": job["kind"], **self._run(t, job, now)})
        return done

    def _all_tenants(self) -> list[TenantRecord]:
        out = []
        for row in self.store.select("tenants"):
            try:
                out.append(load_record(row))
            except TenantConfigError:
                continue
        return out

    def _run(self, tenant: TenantRecord, job: dict[str, Any], now: datetime) -> dict[str, Any]:
        cfg = tenant.config
        contact = job["contact"]
        ts = self.store.for_tenant(tenant.id)
        if guard.quiet_hours(cfg, now):  # e.g. the loop was down overnight: wait for 08:00 again
            if job["kind"] == "reminder" and next_allowed(cfg, now) > datetime.fromisoformat(job["booking"]["start"]) - timedelta(hours=1):
                return {"sent": False, "reason": "too_late"}
            self._add_job(tenant, {**{k: v for k, v in job.items() if k != "id"}, "due": next_allowed(cfg, now).isoformat()})
            return {"sent": False, "reason": "deferred"}
        if job["kind"] == "textback":
            day_flag = f"textback:{tenant.id}:{who(contact)}:{now.astimezone(ZoneInfo(cfg.business.timezone)).date()}"
            if ts.is_opted_out(contact) or guard.is_blocked(contact, cfg):
                res = {"sent": False, "reason": "opted_out" if ts.is_opted_out(contact) else "blocklist"}
            elif self.state.get(day_flag):
                res = {"sent": False, "reason": "already_texted_today"}
            elif (line := self.line_type(tenant, contact, now)) in NO_TEXT_LINE_TYPES:
                res = {"sent": False, "reason": f"line_type:{line}"}
            else:
                body = textback_text(tenant)
                res = self.send(tenant, contact, body, "textback", now)
                if res["sent"]:
                    self.state.put(day_flag, True, tenant.id)
                    tid = thread_id(self.state, tenant, contact, now)
                    self.rt.engine.note_outbound(tenant, "sms", contact, tid, body, prior=body)
            ts.log_event("sms.textback", {"call_sid": job.get("call_sid"), **{k: v for k, v in res.items() if k != "sid"}})
            return res
        # reminder: only if the booking still stands
        b = job["booking"]
        live = [r for r in ts.select("bookings", provider_event_id=b.get("event_id")) if r.get("status") == "confirmed"]
        res = self.send(tenant, contact, reminder_text(tenant, b), "reminder", now) if live else \
            {"sent": False, "reason": "booking_gone"}
        ts.log_event("sms.reminder", {k: v for k, v in res.items() if k != "sid"})
        return res


def after_turn(rt, tenant: TenantRecord, c, now: datetime) -> None:
    """Follow-ups once per conversation: booking confirmation (voice) + reminder job +
    `booking.created`; `lead.created` once the conversation has a real outcome."""
    changed = False
    if c.booking and not c.meta.get("booking_followup"):
        c.meta["booking_followup"] = True
        changed = True
        if c.channel == "voice":  # by text, the reply itself is the confirmation
            # Owner decision (2026-10-11): the booking confirmation after a call is an immediate response to
            # an interaction the caller started, not marketing, so it goes out even in quiet hours (21-08).
            # Reminders and every other proactive message do respect quiet hours.
            rt.outbound.send(tenant, c.contact, confirmation_text(tenant, c.booking), "confirmation", now,
                             direct_reply=True)
        rt.outbound.enqueue_reminder(tenant, c.contact, c.booking, now)
        rt.emit(tenant, "booking.created", {"channel": c.channel, "convo_id": c.convo_id, "contact": c.contact,
                                            **{k: c.booking.get(k) for k in ("name", "address", "job_type", "urgency",
                                                                              "start", "end", "event_id")}},
                str(c.booking.get("event_id")))
    if c.outcome in ("booked", "message", "handoff", "emergency") and not c.meta.get("lead_emitted"):
        c.meta["lead_emitted"] = True
        changed = True
        rt.emit(tenant, "lead.created", {"channel": c.channel, "convo_id": c.convo_id, "contact": c.contact,
                                         "outcome": c.outcome, "urgency": c.urgency}, c.convo_id)
    if changed:
        rt.engine.save_convo(c)
