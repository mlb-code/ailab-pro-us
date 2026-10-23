"""Notifier: turns engine `actions` into owner SMS + e-mail, Zapier events and admin notices (task B6).

Input = the `actions` list of `TurnResult` (and the `Convo` it came from). Alert kinds:
  lead / booking / urgent / human_needed -> `lead_alert` to the owner (SMS + e-mail) + Zapier
                                           `lead.created` (once per conversation) and `booking.created`
  usage_80 / usage_100                   -> owner notice (no automatic billing, ever) + Hebrew note to Meir
  calendar_reconnect                     -> owner "reconnect" + immediate admin alert
  admin_budget                           -> immediate admin alert (runtime fault)
  rate_limit / muted                     -> recorded only (no owner spam)
Exactly once: every send has an idempotency key (call_sid / message thread id + kind + channel +
recipient) remembered in `runtime_state`; a retry of the same turn sends nothing new.
Failures are logged in `events` (`notify.failed`) and never raise into the call/SMS flow.

Owner = the client's alert contacts (`notify.sms`, `notify.email`). Lead alerts and usage alerts
(80% / 100%, e-mail + SMS) are operational and always go out. Only the daily summary and the monthly
report wait for `client_emails_enabled` (SPEC 5: off until Meir approves the copy); they are still
generated and stored for the portal. Owner-alert SMS are written to `sms_messages` and counted in
`usage:<tenant>:<month>:owner_sms_segments`, separately from the client's included usage. Meir's notices: Hebrew, 08:00-23:00 in the admin timezone (brand.json owner.timezone); outside those hours
non-fault notices wait for the morning `admin_daily` (SPEC 10.8).
"""
from __future__ import annotations

import hashlib
import logging
import os
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from ..calendar.base import label as slot_label
from ..settings import brand
from ..store import StateStore, Store, StoreError
from ..tenants import TenantConfigError, TenantRecord, load_record, sms_business_name
from ..guard import sms_segments
from ..zapier import ZapierClient
from .calllog import record_sms
from . import templates as T
from .channels import Email, EmailSender, SmsSender

log = logging.getLogger("rt.notify")

LEAD_KINDS = ("lead", "booking", "urgent", "human_needed")
URGENT_ADMIN = ("calendar_reconnect", "admin_budget", "notify_failed")


@dataclass
class NotifyPolicy:
    client_emails_enabled: bool = False
    admin_email: str = ""
    admin_tz: str = "UTC"  # real value: brand.json owner.timezone
    admin_hours: tuple[int, int] = (8, 23)

    @classmethod
    def from_env(cls, settings: Any, env: dict[str, str] | None = None) -> "NotifyPolicy":
        env = dict(os.environ if env is None else env)
        owner = brand().get("owner") or {}
        flag = env.get("CLIENT_EMAILS_ENABLED")
        enabled = (flag.lower() in ("1", "true", "yes")) if flag else bool(getattr(settings, "is_sim", False))
        return cls(client_emails_enabled=enabled,
                   admin_email=env.get("ADMIN_EMAIL") or str(owner.get("admin_email") or ""),
                   admin_tz=str(owner.get("timezone") or "UTC"))


def _h(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()[:10]


def lead_from(convo: Any, action: dict[str, Any] | None = None) -> dict[str, Any]:
    """Lead details from an engine `Convo` (duck-typed, so voice and SMS flows can pass theirs)."""
    action = action or {}
    b = dict(getattr(convo, "booking", None) or {})
    m = dict(getattr(convo, "message", None) or {})
    k = dict(getattr(convo, "collected", None) or {})  # details from earlier tool calls (hang-up after a name/address)
    meta = dict(getattr(convo, "meta", None) or {})
    if meta.get("transcript_withheld"):
        k = {}
    contact = str(getattr(convo, "contact", "") or action.get("contact", "") or "")
    if not contact.startswith("+"):  # chat box: the visitor id is not a phone number; use what they typed
        contact = ""
    q = dict(meta.get("lead") or {}) if not meta.get("transcript_withheld") else {}  # real-estate screening answers
    lead = {"name": b.get("name") or m.get("name") or k.get("name") or q.get("name") or "",
            "phone": b.get("phone") if b.get("phone") and str(b["phone"]).startswith("+") else (k.get("phone") or contact),
            "email": k.get("email") or q.get("email") or "",
            "qualification": {x: y for x, y in q.items() if x not in ("name", "email") and y},
            "address": b.get("address") or m.get("address") or k.get("address") or "",
            "job_type": b.get("job_type") or m.get("job_type") or k.get("job_type") or "",
            "urgency": b.get("urgency") or m.get("urgency") or getattr(convo, "urgency", "normal"),
            "summary": m.get("summary") or action.get("summary") or "",
            "channel": getattr(convo, "channel", "") or action.get("channel", ""),
            "transcript": list(getattr(convo, "transcript", None) or [])}
    if b.get("start") and b.get("end"):
        lead["booking"] = {"start": b["start"], "end": b["end"]}
        lead["booking_label"] = slot_label(datetime.fromisoformat(b["start"]), datetime.fromisoformat(b["end"]))
    return lead


class Notifier:
    def __init__(self, store: Store, state: StateStore, email: EmailSender, sms: SmsSender,
                 zapier: ZapierClient | None = None, policy: NotifyPolicy | None = None,
                 executor: Executor | None = None, clock: Callable[[], datetime] | None = None):
        self.store = store
        self.state = state
        self.email = email
        self.sms = sms
        self.zapier = zapier
        self.policy = policy or NotifyPolicy()
        self.executor = executor
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    # --- public ------------------------------------------------------------------------------
    def deliver_async(self, *args: Any, **kw: Any) -> None:
        """Fire-and-forget for webhook handlers (Zapier retries must not hold up Twilio)."""
        if self.executor is None:
            self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="notify")
        self.executor.submit(self._safe, *args, **kw)

    def _safe(self, *args: Any, **kw: Any) -> None:
        try:
            self.deliver(*args, **kw)
        except Exception:  # noqa: BLE001 - background work must never crash the worker
            log.exception("notify delivery failed")

    def deliver(self, tenant: TenantRecord, actions: list[dict[str, Any]], convo: Any = None,
                idem: str | None = None, now: datetime | None = None) -> list[dict[str, Any]]:
        now = now or self.clock()
        idem = idem or str(getattr(convo, "convo_id", "") or "")
        out: list[dict[str, Any]] = []
        for a in actions or []:
            if a.get("type") != "alert":
                continue
            kind = a.get("kind", "")
            if kind in LEAD_KINDS:
                out += self._lead(tenant, kind, a, convo, idem or a.get("convo_id", ""), now)
            elif kind in ("usage_80", "usage_100"):
                out += self.usage_alert(tenant, a, now)
            elif kind == "calendar_reconnect":
                out += self.calendar_alert(tenant, a, now)
            elif kind == "admin_budget":
                out += self._admin(kind, tenant, a.get("summary", ""), now, key=f"{kind}:{a.get('summary')}:{now.date()}")
            else:
                self._event(tenant, "notify.recorded", {"kind": kind})
        return out

    def call_completed(self, tenant: TenantRecord, call_sid: str, outcome: str, duration_s: int,
                       convo: Any = None) -> dict[str, Any]:
        """Zapier `call.completed` (voice flow calls this once per call)."""
        if not self.zapier:
            return {"status": "skipped"}
        lead = lead_from(convo) if convo is not None else {}
        data = {"call_sid": call_sid, "outcome": outcome, "duration_s": int(duration_s),
                **{k: lead[k] for k in ("name", "phone", "job_type", "urgency", "summary") if lead.get(k)}}
        return self.zapier.emit(tenant, "call.completed", call_sid, data)

    def calendar_alert(self, tenant: TenantRecord | str, alert: dict[str, Any],
                       now: datetime | None = None) -> list[dict[str, Any]]:
        """Also usable as the calendar hub's `alert` callback (tenant id + alert dict)."""
        now = now or self.clock()
        tenant = self._tenant(tenant)
        if tenant is None:
            return []
        provider = alert.get("provider", "calendar")
        subject, text, html, sms = T.calendar_owner(sms_business_name(tenant), provider)  # the name is only in the SMS
        key = f"calendar:{provider}:{now.date()}"
        out = self._owner_email(tenant, "calendar_reconnect", subject, text, html, key)
        out += self._owner_sms(tenant, "calendar_reconnect", sms, key)
        out += self._admin("calendar_reconnect", tenant, alert.get("summary", ""), now, key=key)
        return out

    def usage_alert(self, tenant: TenantRecord, a: dict[str, Any], now: datetime | None = None) -> list[dict[str, Any]]:
        now = now or self.clock()
        business = tenant.config.business.name
        month = now.astimezone(ZoneInfo(tenant.config.business.timezone)).strftime("%Y-%m")
        key = f"{a['kind']}:{a.get('usage_kind')}:{month}"
        self._event(tenant, "usage.alert", {k: a.get(k) for k in ("kind", "usage_kind", "used", "included")},
                    client_visible=True)
        out: list[dict[str, Any]] = []
        subject, text, html, sms = T.usage_owner(business, a, sms_business=sms_business_name(tenant))  # operational: not gated by client_emails_enabled
        out += self._owner_email(tenant, "usage", subject, text, html, key)
        out += self._owner_sms(tenant, "usage", sms, key)
        subject, text, html = T.usage_admin(business, tenant.slug, a)
        out += self._admin_send("usage", subject, text, html, now, key=f"{tenant.id}:{key}", urgent=False)
        return out

    # --- lead alerts ----------------------------------------------------------------------------
    def _lead(self, tenant: TenantRecord, kind: str, a: dict[str, Any], convo: Any, idem: str,
              now: datetime) -> list[dict[str, Any]]:
        lead = lead_from(convo, a) if convo is not None else {
            "phone": a.get("contact", ""), "summary": a.get("summary", ""), "channel": a.get("channel", ""),
            "urgency": a.get("urgency", "normal")}
        if kind == "urgent":
            lead["urgency"] = "urgent"
        subject, text, html, sms = T.lead_alert(tenant.config.business.name, kind, lead)
        key = f"{kind}:{idem}"
        out = self._owner_email(tenant, "lead_alert", subject, text, html, key)
        out += self._owner_sms(tenant, "lead_alert", sms, key)
        if self.zapier:
            data = {k: lead.get(k) for k in ("name", "phone", "address", "job_type", "urgency", "summary", "channel")}
            data["kind"] = kind
            data["conversation_id"] = idem
            out.append({"channel": "zapier", "event": "lead.created",
                        **self.zapier.emit(tenant, "lead.created", idem, data)})
            if kind == "booking" and lead.get("booking"):
                out.append({"channel": "zapier", "event": "booking.created",
                            **self.zapier.emit(tenant, "booking.created", idem, {**data, **lead["booking"]})})
        return out

    # --- channels -------------------------------------------------------------------------------
    def _once(self, key: str) -> bool:
        return bool(self.state.get(f"sent:{key}"))

    def _mark(self, key: str, tenant_id: str | None) -> None:
        self.state.put(f"sent:{key}", True, tenant_id)

    def _owner_email(self, tenant: TenantRecord, tag: str, subject: str, text: str, html: str,
                     key: str) -> list[dict[str, Any]]:
        to = tuple(tenant.config.notify.email)
        if not to:
            return []
        k = f"{tenant.id}:{tag}:{key}:email"
        if self._once(k):
            return [{"channel": "email", "tag": tag, "status": "duplicate"}]
        senders = brand().get("senders") or {}
        msg = Email(to=to, subject=subject, text=text, html=html, tag=tag,
                    sender=str(senders.get("alerts") or senders.get("transactional") or ""),
                    reply_to=str(senders.get("reply_to") or ""))
        res = self.email.send(msg, _h(k))
        return [self._result(tenant, "email", tag, k, res)]

    def _owner_sms(self, tenant: TenantRecord, tag: str, body: str, key: str) -> list[dict[str, Any]]:
        out = []
        if not tenant.config.notify.sms:
            return out
        if not tenant.twilio_number:
            self._event(tenant, "notify.skipped", {"channel": "sms", "tag": tag, "reason": "no_twilio_number"})
            return [{"channel": "sms", "tag": tag, "status": "skipped", "reason": "no_twilio_number"}]
        ts = self.store.for_tenant(tenant.id)
        for number in tenant.config.notify.sms:
            k = f"{tenant.id}:{tag}:{key}:sms:{_h(number)}"
            if self._once(k):
                out.append({"channel": "sms", "tag": tag, "status": "duplicate"})
                continue
            if ts.is_opted_out(number):  # the owner texted STOP to the line: honour it
                out.append({"channel": "sms", "tag": tag, "status": "skipped", "reason": "opted_out"})
                continue
            res = self.sms.send(number, tenant.twilio_number, body[: T.SMS_MAX], _h(k))
            out.append(self._result(tenant, "sms", tag, k, res))
            if res.get("ok"):
                self._log_owner_sms(tenant, number, body[: T.SMS_MAX], str(res.get("id") or ""))
        return out

    def _log_owner_sms(self, tenant: TenantRecord, number: str, body: str, sid: str) -> None:
        """Owner SMS cost: sms_messages row + Twilio estimate; counted apart from the client's included usage."""
        segments = sms_segments(body)
        try:
            record_sms(self.store, tenant, twilio_sid=sid or None, contact_e164=number, direction="outbound",
                       body=body, segments=segments, state=self.state)
            month = self.clock().astimezone(ZoneInfo(tenant.config.business.timezone)).strftime("%Y-%m")
            self.state.incr(f"usage:{tenant.id}:{month}:owner_sms_segments", segments, tenant.id)
        except StoreError:
            log.exception("could not record owner sms")

    def _result(self, tenant: TenantRecord, channel: str, tag: str, key: str, res: dict[str, Any]) -> dict[str, Any]:
        if res.get("ok"):
            self._mark(key, tenant.id)
            self._event(tenant, "notify.sent", {"channel": channel, "tag": tag, "via": getattr(
                self.email if channel == "email" else self.sms, "name", "")})
            return {"channel": channel, "tag": tag, "status": "sent", "id": res.get("id", "")}
        self._event(tenant, "notify.failed", {"channel": channel, "tag": tag, "error": res.get("error", "")})
        log.warning("notify %s %s failed for %s: %s", channel, tag, tenant.slug, res.get("error"))
        return {"channel": channel, "tag": tag, "status": "failed", "error": res.get("error", "")}

    # --- admin (Meir, Hebrew) --------------------------------------------------------------------
    def _admin(self, kind: str, tenant: TenantRecord, summary: str, now: datetime, key: str) -> list[dict[str, Any]]:
        subject, text, html = T.admin_alert(kind, tenant.config.business.name, tenant.slug, summary)
        return self._admin_send(kind, subject, text, html, now, key=f"{tenant.id}:{key}", urgent=kind in URGENT_ADMIN)

    def admin_awake(self, now: datetime) -> bool:
        h = now.astimezone(ZoneInfo(self.policy.admin_tz)).hour
        return self.policy.admin_hours[0] <= h < self.policy.admin_hours[1]

    def _admin_send(self, tag: str, subject: str, text: str, html: str, now: datetime, key: str,
                    urgent: bool) -> list[dict[str, Any]]:
        k = f"admin:{tag}:{key}"
        if self._once(k):
            return [{"channel": "admin_email", "tag": tag, "status": "duplicate"}]
        if not urgent and not self.admin_awake(now):
            pending = list(self.state.get("admin:deferred") or [])
            pending.append(subject)
            self.state.put("admin:deferred", pending[-50:])
            self._mark(k, None)
            return [{"channel": "admin_email", "tag": tag, "status": "deferred"}]
        if not self.policy.admin_email:
            self.store.log_event("runtime", "admin", None, "notify.admin_unset", {"tag": tag, "subject": subject})
            return [{"channel": "admin_email", "tag": tag, "status": "skipped", "reason": "admin_email_unset"}]
        senders = brand().get("senders") or {}
        res = self.email.send(Email(to=(self.policy.admin_email,), subject=subject, text=text, html=html, tag=tag,
                                    sender=str(senders.get("alerts") or senders.get("transactional") or ""),
                                    lang="he"), _h(k))
        if res.get("ok"):
            self._mark(k, None)
            return [{"channel": "admin_email", "tag": tag, "status": "sent"}]
        self.store.log_event("runtime", "admin", None, "notify.failed", {"channel": "admin_email", "tag": tag,
                                                                         "error": res.get("error", "")})
        return [{"channel": "admin_email", "tag": tag, "status": "failed"}]

    def send_admin_report(self, subject: str, text: str, html: str, key: str) -> dict[str, Any]:
        """admin_daily: always sent (it is the morning digest)."""
        return self._admin_send("admin_daily", subject, text, html, self.clock(), key=key, urgent=True)[0]

    def send_owner_report(self, tenant: TenantRecord, tag: str, subject: str, text: str, html: str,
                          key: str) -> list[dict[str, Any]]:
        if not self.policy.client_emails_enabled:
            return [{"channel": "email", "tag": tag, "status": "skipped", "reason": "client_emails_disabled"}]
        return self._owner_email(tenant, tag, subject, text, html, key)

    # --- helpers ---------------------------------------------------------------------------------------
    def _tenant(self, tenant: TenantRecord | str) -> TenantRecord | None:
        if isinstance(tenant, TenantRecord):
            return tenant
        try:
            rows = self.store.select("tenants", id=tenant)
            return load_record(rows[0]) if rows else None
        except (StoreError, TenantConfigError):
            log.exception("calendar alert: tenant lookup failed")
            return None

    def _event(self, tenant: TenantRecord, type_: str, payload: dict[str, Any], client_visible: bool = False) -> None:
        try:
            row = {"actor": "runtime", "entity": "tenant", "type": type_, "payload": payload}
            if client_visible:
                row["client_visible"] = True
            self.store.for_tenant(tenant.id).insert("events", row)
        except StoreError:
            log.exception("could not record %s", type_)
