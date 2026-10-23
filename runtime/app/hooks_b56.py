"""Real B5/B6 implementations of the hooks that B3/B4 call through `app._stubs_b56`.

Same names and signatures as the stub; the stub imports these at its end, so they take precedence:

    get_provider(tenant_id, cfg, settings)                       -> calendar provider (Calendly default, Google, fake)
    TenantCalendars(settings, resolve=None)                      -> what the engine calls
    owner_alert(store, state, tenant, alert, idempotency_key)    -> owner SMS + e-mail, admin notices, usage alerts
    emit(store, state, tenant, event, payload, idempotency_key)  -> signed Zapier webhook, exactly once per key

Non-blocking (review B3-B6 #1): `owner_alert`, `emit` and calendar alerts only write the audit row and
enqueue a job (`app.notify.queue.DeliveryQueue`, persisted in runtime_state); Resend, the owner SMS and
Zapier (with its 2/8/30 s retries) run on the queue's background thread, never inside a webhook.
`record_call` / `record_sms` are the cost hooks (calls / sms_messages rows + Twilio cost estimate).

Zapier events are emitted only through `emit` (B3/B4 call it for lead.created / booking.created /
call.completed), so `owner_alert` uses a Notifier without Zapier: no event is sent twice.
In the simulator (and for tenants with booking.provider == "fake") the simulator's shared
FakeCalendar stays in use, exactly like the stub did, so B3/B4 scenarios behave the same.
"""
from __future__ import annotations

import logging
import os
import threading
import weakref
from datetime import date, datetime
from types import SimpleNamespace
from typing import Any

from . import store as store_mod
from .calendar import CalendarHub, build_hub
from .notify import calllog
from .notify.channels import email_from_env, sms_from_env
from .notify.core import Notifier, NotifyPolicy
from .notify.queue import DeliveryQueue
from .tenants import TenantConfigError, load_record
from .store import StateStore, Store
from .zapier import ZapierClient, signing_secret

log = logging.getLogger("rt.hooks")

_lock = threading.Lock()
_hubs: dict[Any, CalendarHub] = {}
_notifiers: "weakref.WeakKeyDictionary[Store, Notifier]" = weakref.WeakKeyDictionary()
_zaps: "weakref.WeakKeyDictionary[Store, ZapierClient]" = weakref.WeakKeyDictionary()
_queues: "weakref.WeakKeyDictionary[Store, DeliveryQueue]" = weakref.WeakKeyDictionary()


def _settings_of(state: Any) -> Any:
    """The hooks get no settings; the runtime's StateStore has memory_fallback only in the simulator."""
    from . import settings as settings_mod
    sim = bool(getattr(state, "memory_fallback", False))
    return settings_mod.load(dict(os.environ, RUNTIME_MODE="sim") if sim else None)


def notifier_for(store: Store, state: StateStore, settings: Any | None = None) -> Notifier:
    with _lock:
        n = _notifiers.get(store)
        if n is None:
            settings = settings or _settings_of(state)
            n = Notifier(store, state, email_from_env(store, settings), sms_from_env(store, settings), None,
                         NotifyPolicy.from_env(settings))
            _notifiers[store] = n
        return n


def zapier_for(store: Store, state: StateStore, settings: Any | None = None) -> ZapierClient:
    with _lock:
        z = _zaps.get(store)
        if z is None:
            z = ZapierClient(store, state, signing_secret(settings or _settings_of(state)))
            _zaps[store] = z
        return z


def hub_for(settings: Any) -> CalendarHub:
    with _lock:
        hub = _hubs.get(settings)
        if hub is None:
            store = store_mod.from_settings(settings)
            state = StateStore(store, memory_fallback=settings.is_sim)
            q = queue_for(store, state)
            hub = build_hub(store, settings, state,
                            alert=lambda tid, a: q.enqueue("calendar_alert", {"alert": a}, tid))
            _hubs[settings] = hub
        return hub


def get_provider(tenant_id: str, cfg: Any, settings: Any) -> Any:
    if settings.is_sim or cfg.booking.provider == "fake":
        from . import _stubs_b56
        return _stubs_b56._fake_calendar()
    hub = hub_for(settings)
    return hub.provider(cfg) or hub


class TenantCalendars:
    """Engine-facing dispatcher (same surface as the stub, plus cancel and reschedule)."""

    def __init__(self, settings: Any, resolve=None):
        self.settings = settings
        self.resolve = resolve or (lambda tenant_id, cfg: get_provider(tenant_id, cfg, settings))

    def availability(self, tenant_id, cfg, now: datetime, date_from: date | None = None, limit: int = 6):
        return self.resolve(tenant_id, cfg).availability(tenant_id, cfg, now, date_from=date_from, limit=limit)

    def book(self, tenant_id, cfg, now, slot_id, details):
        return self.resolve(tenant_id, cfg).book(tenant_id, cfg, now, slot_id, details)

    def cancel(self, tenant_id, cfg, event_id, reason="", now=None):
        p = self.resolve(tenant_id, cfg)
        if not hasattr(p, "cancel"):
            return {"ok": False, "reason": "not_supported"}
        return p.cancel(tenant_id, cfg, event_id, reason, now)

    def reschedule(self, tenant_id, cfg, now, event_id, slot_id, details):
        p = self.resolve(tenant_id, cfg)
        if not hasattr(p, "reschedule"):
            return {"ok": False, "reason": "not_supported"}
        return p.reschedule(tenant_id, cfg, now, event_id, slot_id, details)


def _convo_from_store(store: Store, tenant: Any, alert: dict[str, Any]) -> Any:
    """Enrich a booking alert with the booking row (name, address, job, time) when there is one."""
    contact = alert.get("contact") or ""
    booking = None
    if alert.get("kind") == "booking" and contact:
        rows = store.for_tenant(tenant.id).select("bookings", contact_e164=contact)
        if rows:
            b = sorted(rows, key=lambda r: str(r.get("created_at") or ""))[-1]
            booking = {"name": b.get("customer_name"), "address": b.get("address"), "job_type": b.get("job_type"),
                       "urgency": b.get("urgency"), "start": b.get("start_at"), "end": b.get("end_at")}
            if not (booking["start"] and booking["end"]):
                booking.pop("start"), booking.pop("end")
    return SimpleNamespace(booking=booking, message={"summary": alert.get("summary", ""), "urgency": alert.get("urgency")},
                           contact=contact, channel=alert.get("channel", ""), urgency=alert.get("urgency", "normal"),
                           transcript=[], convo_id=alert.get("convo_id", ""))


def _load_tenant(store: Store, tenant_id: str | None):
    rows = store.select("tenants", id=tenant_id) if tenant_id else []
    try:
        return load_record(rows[0]) if rows else None
    except TenantConfigError:
        return None


def queue_for(store: Store, state: StateStore, autostart: bool = True) -> DeliveryQueue:
    """One persistent delivery queue per store (handlers below run on its background thread)."""
    with _lock:
        q = _queues.get(store)
        if q is None:
            def h_alert(job):
                tenant = _load_tenant(store, job["tenant_id"])
                if tenant is None:
                    return "dead", 0.0
                p = job["payload"]
                alert = p["alert"]
                convo = _convo_from_store(store, tenant, alert) if alert.get("kind") in (
                    "lead", "booking", "urgent", "human_needed") else None
                res = notifier_for(store, state).deliver(tenant, [alert], convo, idem=p["key"])
                return ("retry", 0.0) if any(r.get("status") == "failed" for r in res) else ("done", 0.0)

            def h_calendar(job):
                tenant = _load_tenant(store, job["tenant_id"])
                if tenant is None:
                    return "dead", 0.0
                res = notifier_for(store, state).calendar_alert(tenant, job["payload"]["alert"])
                return ("retry", 0.0) if any(r.get("status") == "failed" for r in res) else ("done", 0.0)

            def h_zapier(job):
                tenant = _load_tenant(store, job["tenant_id"])
                if tenant is None:
                    return "dead", 0.0
                p = job["payload"]
                res = zapier_for(store, state).attempt(tenant, p["event"], p["key"], p["data"], job["attempt"])
                return ("retry", res["delay"]) if res["status"] == "retry" else ("done", 0.0)

            q = DeliveryQueue(store, state, {"alert": h_alert, "calendar_alert": h_calendar, "zapier": h_zapier},
                              autostart=autostart)
            _queues[store] = q
        return q


def owner_alert(store: Store, state: Any, tenant: Any, alert: dict[str, Any], idempotency_key: str) -> None:
    """Audit row + enqueue; returns at once. Delivery (and retries) happen on the queue thread."""
    from . import _stubs_b56
    _stubs_b56.record_alert(store, state, tenant, alert, idempotency_key)  # audit row, once per key
    try:
        queue_for(store, state).enqueue("alert", {"alert": alert, "key": idempotency_key}, tenant.id)
    except Exception:  # noqa: BLE001 - an alert problem must never break a call or a text
        log.exception("owner_alert enqueue failed")


def emit(store: Store, state: Any, tenant: Any, event: str, payload: dict[str, Any], idempotency_key: str) -> None:
    """Audit row + enqueue a signed Zapier delivery; returns at once."""
    from . import _stubs_b56
    _stubs_b56.record_emit(store, state, tenant, event, payload, idempotency_key)  # audit row, once per key
    if not tenant.config.zapier.webhook_url or event not in tenant.config.zapier.events:
        return
    try:
        queue_for(store, state).enqueue("zapier", {"event": event, "key": idempotency_key, "data": payload}, tenant.id)
    except Exception:  # noqa: BLE001
        log.exception("zapier enqueue failed")


def record_call(store: Store, state: Any, tenant: Any, **fields: Any) -> None:
    """Cost hook for B3: calls row (insert or update by call_sid) + Twilio minutes once per call + JSON log line."""
    try:
        calllog.record_call(store, tenant, state=state, **fields)
    except Exception:  # noqa: BLE001 - cost tracking must never break a call
        log.exception("record_call failed")


def record_sms(store: Store, state: Any, tenant: Any, **fields: Any) -> None:
    """Cost hook for B4: one sms_messages row + Twilio segment cost (outbound) + JSON log line."""
    try:
        calllog.record_sms(store, tenant, state=state, **fields)
    except Exception:  # noqa: BLE001
        log.exception("record_sms failed")
