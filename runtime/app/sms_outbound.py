"""Every SMS we send that is not a direct TwiML reply goes through `Outbound.send` (one choke point).

Rules enforced here for all kinds (text-back, booking confirmation, reminder), SA §8:
- never to a number that opted out (STOP, a sentence, or "don't text me" on a call) or is on the tenant
  blocklist, checked at send time;
- texting window, checked in the business's AND the caller's area-code time zone (`guard.WINDOWS`):
  the missed-call text-back goes out right after the call but not 21:00-08:00; if it has to wait, it is
  queued for the 09:00-20:00 window (Sunday 12:00-20:00) and dropped if the caller called back; the
  booking confirmation after a call is the direct response to the caller's yes and goes out right away;
  the 24-hour reminder only 09:00-20:00 (Sunday 12:00-20:00). A send attempted outside its window is refused;
- booking confirmation + reminder only after the caller said yes to the texting question (`after_turn`);
- fixed wording (locked templates): the client can change only the business name; no links, offers or
  sales content in any automated text;
- text-back only to numbers Lookup does not report as landline / toll-free / pager (result cached
  30 days), at most one per number per local day;
- every message is logged in `sms_messages` and its segments counted toward monthly usage; every
  text-back and consent decision is also logged in the consent log (`sms_consent`, 5 years).

Jobs (text-back after an abandoned call, one reminder 24 h before a booking) live in
`runtime_state` under `jobs:<tenant_id>` and run from `run_due(now)`: right after the event that
queued them (background task) and from the cron `POST /jobs/tick` (B6 route, RUNTIME_ADMIN_TOKEN).
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, timedelta
from typing import Any

from . import _stubs_b56 as hooks
from . import guard
from .runtime_ctx import who
from .tenants import TenantConfigError, TenantRecord, load_record, sms_business_name

log = logging.getLogger("rt.sms_out")

NO_TEXT_LINE_TYPES = {"landline", "tollFree", "premium", "sharedCost", "uan", "voicemail", "pager"}
LOOKUP_TTL = timedelta(days=30)
THREAD_IDLE = timedelta(hours=24)
REMINDER_BEFORE = timedelta(hours=24)


# Locked templates (SA §8 item 3): only the business name varies (`sms_business_name`: business.sms_display_name,
# else business.name). No links, prices, offers or review requests:
# one promotional sentence would turn an informational text into telemarketing (memo 02, A.2).
# ADD-ES: the same locked templates in Spanish, used for a number that spoke/wrote Spanish (`contact_lang`); the slot
# label stays as the calendar wrote it.
def textback_text(tenant: TenantRecord, lang: str = "en") -> str:
    if lang == "es":
        return (f"Hola, le habla {sms_business_name(tenant)}. ¡Lamentamos no haber contestado su llamada! ¿En qué podemos "
                "ayudarle? Responda PARAR para no recibir más mensajes.")
    return (f"Hi, this is {sms_business_name(tenant)}. Sorry we missed your call! What can we help with? "
            "Reply STOP to opt out.")


# Appointment manager (SMS_BOOKING_REPLIES=1 and booking.self_service): one-letter replies, still 1 segment with a 44-char
# SMS name and the longest slot label. CANCEL is a carrier opt-out word, so cancelling is X.
REPLY_LINE = "Reply C=confirm, R=change, X=cancel, STOP=opt out."
REPLY_LINE_ES = "Responda C=confirmar, R=cambiar, X=cancelar, STOP=baja."  # ADD-ES


def confirmation_text(tenant: TenantRecord, booking: dict[str, Any], replies: bool = False, lang: str = "en") -> str:
    when = booking.get('label') or booking.get('start')
    if lang == "es":
        tail = REPLY_LINE_ES if replies else "Escríbanos aquí si necesita algo. Responda PARAR para no recibir más mensajes."
        return f"{sms_business_name(tenant)}: su cita está confirmada para {when}. {tail}"
    if replies:
        return f"{sms_business_name(tenant)}: you're booked for {when}. {REPLY_LINE}"
    return f"{sms_business_name(tenant)}: you're booked for {when}. Reply here if you need anything. Reply STOP to opt out."


def reminder_text(tenant: TenantRecord, booking: dict[str, Any], replies: bool = False, lang: str = "en") -> str:
    when = booking.get('label') or booking.get('start')
    if lang == "es":
        tail = REPLY_LINE_ES if replies else "Escríbanos aquí para cambiarla. Responda PARAR para no recibir más mensajes."
        return f"{sms_business_name(tenant)}: recordatorio de su visita {when}. {tail}"
    if replies:
        return f"{sms_business_name(tenant)}: reminder of your visit {when}. {REPLY_LINE}"
    return f"{sms_business_name(tenant)}: reminder of your visit {when}. Reply here to change it. Reply STOP to opt out."  # short: 1 segment with a 44-char SMS name


def booking_replies(settings: Any, tenant: TenantRecord) -> bool:
    """Two-way booking texts: global switch (off until 10DLC) AND the tenant's appointment manager."""
    return bool(getattr(settings, "sms_booking_replies", False)) and tenant.config.booking.self_service


def review_text(tenant: TenantRecord, url: str) -> str:
    """ADD-REV (shipped disabled, see app.reviews): the one template that carries a link, the client's own Google
    review page. No prices or offers; one segment with a short SMS name."""
    return (f"{sms_business_name(tenant)}: thanks for choosing us! If you have a minute, a Google review helps a lot: "
            f"{url} Reply STOP to opt out.")


WINDOW_OF = {"textback": "textback", "confirmation": "scheduled", "reminder": "scheduled", "review": "scheduled"}
REVIEW_GAP = timedelta(days=90)  # at most one review text per contact per 90 days
REVIEW_CONSENT_VERSION = "review-2026-10-23"


def next_allowed(cfg, t: datetime, contact: str = "", window: str = "textback") -> datetime:
    """`t` if inside the texting window (business + caller zone), else the first time it is."""
    return guard.next_window(guard.window_zones(cfg.business.timezone, contact), t, window)


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

    def contact_lang(self, tenant: TenantRecord, contact: str) -> str:
        """'es' when this number used Spanish on a call or by text and the tenant has ADD-ES, else 'en'."""
        if "es" not in tenant.config.voice.languages:
            return "en"
        return "es" if self.state.get(f"lang:{tenant.id}:{who(contact)}") == "es" else "en"

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
        elif not direct_reply and kind != "staff_alert" and not guard.send_window_ok(cfg, now, to, WINDOW_OF.get(kind, "scheduled")):
            reason = "quiet_hours"
        elif self.client is None or not tenant.twilio_number:
            reason = "no_twilio_client"
        elif kind in ("confirmation", "reminder") and (line := self.line_type(tenant, to, now)) in NO_TEXT_LINE_TYPES:
            reason = f"line_type:{line}"  # SA §8 item 6: never text a landline
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
        """Right after the call if inside the text-back window (08:00-21:00, both zones). Otherwise it becomes a
        queued message (memo 02, R2-3/R2-6): it waits for the scheduled window (09:00-20:00, Sunday 12:00-20:00,
        both zones) and is dropped if the caller called back in the meantime."""
        if guard.send_window_ok(tenant.config, now, contact, "textback"):
            due, window = now, "textback"
        else:
            due, window = next_allowed(tenant.config, now, contact, "scheduled"), "scheduled"
        return self._add_job(tenant, {"kind": "textback", "contact": contact, "call_sid": call_sid,
                                      "missed_at": now.isoformat(), "window": window,
                                      "due": due.isoformat(), "dedupe": f"textback:{call_sid}"})

    def confirm_booking(self, tenant: TenantRecord, contact: str, booking: dict[str, Any], now: datetime,
                        call_sid: str | None = None) -> dict[str, Any]:
        """Booking confirmation after a call: sent right away, at any hour. It is the direct response to the yes the
        caller has just given on the call (SA §8 item 5), so the 09:00-20:00 window does not apply to it; opt-out,
        blocklist and the landline check still do (`send`). Only the 24-hour reminder is bound by the window."""
        replies = booking_replies(self.settings, tenant)
        lang = self.contact_lang(tenant, contact)
        res = self.send(tenant, contact, confirmation_text(tenant, booking, replies, lang), "confirmation", now, direct_reply=True)
        if replies and res.get("sent"):
            self._open_reply_thread(tenant, contact, booking, confirmation_text(tenant, booking, replies, lang), now)
        return res

    def _open_reply_thread(self, tenant: TenantRecord, contact: str, booking: dict[str, Any], body: str,
                           now: datetime) -> None:
        """The text asked for C/R/X: remember in its SMS thread which booking a reply is about."""
        rows = self.store.for_tenant(tenant.id).select("bookings", provider_event_id=booking.get("event_id")) \
            if booking.get("event_id") else []
        if not rows:
            return
        tid = thread_id(self.state, tenant, contact, now)
        c = self.rt.engine.note_outbound(tenant, "sms", contact, tid, body)
        c.meta["booking_prompt"] = {"booking_id": rows[-1]["id"], "at": now.isoformat()}
        self.rt.engine.save_convo(c)

    def enqueue_reminder(self, tenant: TenantRecord, contact: str, booking: dict[str, Any], now: datetime) -> dict[str, Any]:
        start = datetime.fromisoformat(booking["start"])
        due = next_allowed(tenant.config, start - REMINDER_BEFORE, contact, "scheduled")
        if due < now + timedelta(hours=1) or due > start - timedelta(hours=1):
            return {}  # booked less than a day ahead: the confirmation is enough
        return self._add_job(tenant, {"kind": "reminder", "contact": contact, "due": due.isoformat(),
                                      "booking": {k: booking.get(k) for k in ("start", "label", "event_id")},
                                      "dedupe": f"reminder:{booking.get('event_id')}"})

    # --- ADD-REV: post-job review request (DISABLED by default: env + tenant switch, see app.reviews) --------
    def _review_key(self, tenant: TenantRecord, contact: str) -> str:
        return f"review:{tenant.id}:{who(contact)}"

    def review_enabled(self, tenant: TenantRecord) -> tuple[bool, str]:
        """Both switches: REVIEW_REQUESTS_ENABLED (env kill switch) and the tenant's `review_requests.enabled`."""
        rv = tenant.config.review_requests
        if not self.settings.review_requests_enabled:
            return False, "env_disabled"
        if not rv.enabled:
            return False, "tenant_disabled"
        if not rv.google_review_url:
            return False, "no_review_url"
        return True, ""

    def _review_block(self, tenant: TenantRecord, ts, contact: str, now: datetime) -> str:
        """Why no review text may go to this number right now ('' = fine). Checked when queueing and again at send."""
        ok, reason = self.review_enabled(tenant)
        if not ok:
            return reason
        if guard.is_blocked(contact, tenant.config):
            return "blocklist"
        if ts.is_opted_out(contact):
            return "opted_out"
        last = self.state.get(self._review_key(tenant, contact))
        if isinstance(last, str) and now - datetime.fromisoformat(last) < REVIEW_GAP:
            return "already_asked_90d"
        return ""

    def enqueue_review(self, tenant: TenantRecord, contact: str, now: datetime, job: dict[str, Any]) -> dict[str, Any]:
        """Queue the one review text `delay_hours` after the job was completed, inside the 09-20 window (both zones).
        Consent: a `booking_texts` = yes row for the number (the customer said yes to texts at booking), or the client
        attests it on this request (`consent: true` + `consent_text`), which is then written to the consent log."""
        ts = self.store.for_tenant(tenant.id)
        if reason := self._review_block(tenant, ts, contact, now):
            return {"queued": False, "reason": reason}
        if not any(r.get("decision") == "yes" for r in ts.consent(contact, "booking_texts")):
            text = str(job.get("consent_text") or "").strip()
            if not (job.get("consent") is True and text):
                return {"queued": False, "reason": "no_consent"}
            ts.record_consent(contact, "manual", "booking_texts", "yes", text, None, REVIEW_CONSENT_VERSION)
        cfg = tenant.config
        due = next_allowed(cfg, now + timedelta(hours=cfg.review_requests.delay_hours), contact, "scheduled")
        ref = str(job.get("job_ref") or "").strip() or now.strftime("%Y%m%d%H%M%S")
        added = self._add_job(tenant, {"kind": "review", "contact": contact, "due": due.isoformat(),
                                       "job": {k: job.get(k) for k in ("name", "job_type", "job_ref")},
                                       "dedupe": f"review:{who(contact)}:{ref}"})
        if not added:
            return {"queued": False, "reason": "duplicate"}
        return {"queued": True, "due": due.isoformat(), "job_id": added["id"]}

    def _run_review(self, tenant: TenantRecord, job: dict[str, Any], now: datetime) -> dict[str, Any]:
        """Send time: both switches, opt-out, blocklist, landline and the 90-day rule are checked again."""
        contact = job["contact"]
        ts = self.store.for_tenant(tenant.id)
        if reason := self._review_block(tenant, ts, contact, now):
            res = {"sent": False, "reason": reason}
        elif (line := self.line_type(tenant, contact, now)) in NO_TEXT_LINE_TYPES:
            res = {"sent": False, "reason": f"line_type:{line}"}
        else:
            res = self.send(tenant, contact, review_text(tenant, tenant.config.review_requests.google_review_url),
                            "review", now)
            if res["sent"]:
                self.state.put(self._review_key(tenant, contact), now.isoformat(), tenant.id)
        ts.log_event("sms.review", {"job_ref": (job.get("job") or {}).get("job_ref"),
                                    **{k: v for k, v in res.items() if k != "sid"}})
        return res

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

    @staticmethod
    def _called_back(ts, job: dict[str, Any]) -> bool:
        """A later call from the same number since the missed one (a queued text-back is then pointless)."""
        missed = job.get("missed_at")
        if not missed:
            return False
        return any(r.get("call_sid") != job.get("call_sid") and str(r.get("started_at") or "") > missed
                   for r in ts.select("calls", from_e164=job["contact"]))

    def _run(self, tenant: TenantRecord, job: dict[str, Any], now: datetime) -> dict[str, Any]:
        if job["kind"] == "dispatch_alert":  # ADD-DISPATCH: the one repeat of the on-call alert (app.dispatch)
            return self.rt.dispatcher.run_job(tenant, job, now)
        cfg = tenant.config
        contact = job["contact"]
        ts = self.store.for_tenant(tenant.id)
        window = job.get("window") or WINDOW_OF.get(job["kind"], "scheduled")
        if job["kind"] == "textback" and window == "scheduled" and self._called_back(ts, job):
            ts.log_event("sms.textback", {"call_sid": job.get("call_sid"), "sent": False, "reason": "called_back"})
            return {"sent": False, "reason": "called_back"}
        if not guard.send_window_ok(cfg, now, contact, window):  # e.g. the loop was down overnight: wait again
            nxt = next_allowed(cfg, now, contact, window)
            if (job["kind"] not in ("textback", "review") and job.get("booking")
                    and nxt > datetime.fromisoformat(job["booking"]["start"]) - timedelta(hours=1)):
                return {"sent": False, "reason": "too_late"}
            self._add_job(tenant, {**{k: v for k, v in job.items() if k != "id"}, "due": nxt.isoformat()})
            return {"sent": False, "reason": "deferred"}
        if job["kind"] == "textback":
            # SA §8 item 3a: at most one text-back per number in any 24 hours (rolling, not per calendar day)
            day_flag = f"textback:{tenant.id}:{who(contact)}"
            last = self.state.get(day_flag)
            if ts.is_opted_out(contact) or guard.is_blocked(contact, cfg):
                res = {"sent": False, "reason": "opted_out" if ts.is_opted_out(contact) else "blocklist"}
            elif isinstance(last, str) and now - datetime.fromisoformat(last) < timedelta(hours=24):
                res = {"sent": False, "reason": "already_texted_today"}
            elif (line := self.line_type(tenant, contact, now)) in NO_TEXT_LINE_TYPES:
                res = {"sent": False, "reason": f"line_type:{line}"}
            else:
                body = textback_text(tenant, self.contact_lang(tenant, contact))
                res = self.send(tenant, contact, body, "textback", now)
                if res["sent"]:
                    self.state.put(day_flag, now.isoformat(), tenant.id)
                    # consent basis: the caller's own call + the texting notice in the greeting (SA §8 items 2, 3a)
                    ts.record_consent(contact, "voice", "text_back", "notice", guard.DISCLOSURE, job.get("call_sid"),
                                      guard.DISCLOSURE_VERSION)
                    tid = thread_id(self.state, tenant, contact, now)
                    self.rt.engine.note_outbound(tenant, "sms", contact, tid, body, prior=body)
            ts.log_event("sms.textback", {"call_sid": job.get("call_sid"), **{k: v for k, v in res.items() if k != "sid"}})
            return res
        if job["kind"] == "review":
            return self._run_review(tenant, job, now)
        # confirmation / reminder: only if the booking still stands
        b = job["booking"]
        live = [r for r in ts.select("bookings", provider_event_id=b.get("event_id")) if r.get("status") == "confirmed"]
        replies, lang = booking_replies(self.settings, tenant), self.contact_lang(tenant, contact)
        text = confirmation_text(tenant, b, replies, lang) if job["kind"] == "confirmation" else reminder_text(tenant, b, replies, lang)
        res = self.send(tenant, contact, text, job["kind"], now) if live else {"sent": False, "reason": "booking_gone"}
        if replies and res.get("sent"):
            self._open_reply_thread(tenant, contact, b, text, now)
        ts.log_event(f"sms.{job['kind']}", {k: v for k, v in res.items() if k != "sid"})
        return res


def after_turn(rt, tenant: TenantRecord, c, now: datetime) -> None:
    """Follow-ups once per conversation: `booking.created`; booking confirmation (voice) + reminder job only once
    the caller said yes to the texting question (SA §8 item 3b; a "no" or no answer = no texts, the booking
    stands); `lead.created` once the conversation has a real outcome."""
    changed = False
    if c.booking and c.meta.get("sms_consent") == "yes" and not c.meta.get("booking_texts"):
        c.meta["booking_texts"] = True
        changed = True
        if c.channel == "voice":  # by text, the reply itself is the confirmation
            # Sent right away at any hour: the direct response to the yes just given on the call (SA §8 item 5).
            # Only the 24-hour reminder follows the 09-20 window (Sunday 12-20) in both time zones.
            rt.outbound.confirm_booking(tenant, c.contact, c.booking, now, c.convo_id)
        rt.outbound.enqueue_reminder(tenant, c.contact, c.booking, now)
    # Real-estate screening answers (qualify_lead) ride along on both events. Chat visitors have no caller id, so the
    # contact is the phone (or e-mail) they typed. Payloads: docs/zapier-payloads.md.
    lead = {k: v for k, v in (c.meta.get("lead") or {}).items() if v}
    extra = {"qualification": lead} if lead else {}
    contact = c.contact if c.contact.startswith("+") else (c.collected.get("phone") or c.collected.get("email") or "")
    if c.booking and not c.meta.get("booking_followup"):
        c.meta["booking_followup"] = True
        changed = True
        rt.emit(tenant, "booking.created", {"channel": c.channel, "convo_id": c.convo_id,
                                            "contact": c.booking.get("phone") or contact,
                                            **{k: c.booking.get(k) for k in ("name", "address", "job_type", "urgency",
                                                                              "start", "end", "event_id")}, **extra},
                str(c.booking.get("event_id")))
    if c.outcome in ("booked", "message", "handoff", "emergency") and not c.meta.get("lead_emitted"):
        c.meta["lead_emitted"] = True
        changed = True
        details = {k: c.collected.get(k) for k in ("name", "address", "job_type", "email") if c.collected.get(k)}
        rt.emit(tenant, "lead.created", {"channel": c.channel, "convo_id": c.convo_id, "contact": contact,
                                         "outcome": c.outcome, "urgency": c.urgency, **details, **extra}, c.convo_id)
    changed = _appointment_followups(rt, tenant, c, now) or changed
    if changed:
        rt.engine.save_convo(c)


def _has_text_consent(ts, c, contact: str) -> bool:
    if contact == c.contact and c.meta.get("sms_consent") in ("yes", "no"):
        return c.meta["sms_consent"] == "yes"
    rows = sorted(ts.consent(contact, "booking_texts"), key=lambda r: str(r.get("created_at") or ""))
    return bool(rows) and rows[-1].get("decision") == "yes"


def _appointment_followups(rt, tenant: TenantRecord, c, now: datetime) -> bool:
    """Appointment manager: Zapier `booking.rescheduled` / `booking.cancelled` once per change; a moved booking gets a
    new confirmation (voice) + reminder only with SMS_BOOKING_REPLIES and the customer's texting yes on record; the
    call row keeps the job type (for "worth calling back") and whether the caller was known."""
    changed = False
    ts = rt.store.for_tenant(tenant.id)
    for ev in c.meta.get("appt_events") or []:
        if ev.get("emitted"):
            continue
        ev["emitted"] = changed = True
        rt.emit(tenant, f"booking.{ev['kind']}", {"channel": c.channel, "convo_id": c.convo_id, "contact": ev["contact"],
                                                  "name": ev.get("name"), "job_type": ev.get("job_type"),
                                                  "previous": ev.get("old"), "new": ev.get("new")}, ev["key"])
        new = ev.get("new")
        if ev["kind"] == "rescheduled" and new and booking_replies(rt.settings, tenant) \
                and _has_text_consent(ts, c, ev["contact"]):
            if c.channel == "voice":
                rt.outbound.confirm_booking(tenant, ev["contact"], new, now, c.convo_id)
            rt.outbound.enqueue_reminder(tenant, ev["contact"], new, now)
    row_id = c.meta.get("call_row_id")
    job = (c.message or {}).get("job_type") or (c.booking or {}).get("job_type") or (c.collected or {}).get("job_type")
    if c.channel == "voice" and row_id and job and c.meta.get("call_job_type") != job \
            and not c.meta.get("transcript_withheld"):
        c.meta["call_job_type"] = job
        changed = True
        try:
            ts.update("calls", row_id, {"job_type": str(job)[:200]})
        except Exception:  # noqa: BLE001 - reporting detail; never break a call (column added by the 2026-10-23 migration)
            log.warning("could not store the call's job type")
    return changed
