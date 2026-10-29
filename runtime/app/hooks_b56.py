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
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
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

# Re-entrant: `hub_for` builds the delivery queue (`queue_for`) for its new hub while it holds this lock. With a plain
# Lock that self-deadlocked on the first real (Google/Calendly) calendar call and then blocked every alert, emit and
# /jobs/tick in the process for good (incident 2026-10-28).
_lock = threading.RLock()
_hubs: dict[Any, CalendarHub] = {}
_notifiers: "weakref.WeakKeyDictionary[Store, Notifier]" = weakref.WeakKeyDictionary()
_zaps: "weakref.WeakKeyDictionary[Store, ZapierClient]" = weakref.WeakKeyDictionary()
_queues: "weakref.WeakKeyDictionary[Store, DeliveryQueue]" = weakref.WeakKeyDictionary()
_crm: "weakref.WeakKeyDictionary[Store, dict[str, Any]]" = weakref.WeakKeyDictionary()  # ADD-CRM clients per provider


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


def crm_for(store: Store, state: StateStore, provider: str, settings: Any | None = None) -> Any:
    """ADD-CRM: one CRM client per store + provider (tests inject `_crm[store] = {provider: client}`)."""
    from .crm import CredentialBox, make_client
    with _lock:
        clients = _crm.setdefault(store, {})
        c = clients.get(provider)
        if c is None:
            settings = settings or _settings_of(state)
            c = make_client(provider, CredentialBox(store, settings.cred_key), store, state)
            clients[provider] = c
        return c


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


# Hard upper bound for one calendar operation inside a live turn (chat, SMS, voice). Each HTTP request already has a
# 10 s timeout and loops are bounded, but a turn must never wait on a provider (or on a lock) without limit: past the
# deadline the turn gets "calendar unavailable" and the assistant takes a message instead.
CALENDAR_READ_DEADLINE_S = 12.0
CALENDAR_WRITE_DEADLINE_S = 25.0
_cal_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="calendar")


class CalendarTimeout(RuntimeError):
    """A calendar operation did not finish within its deadline (the worker thread is left to finish on its own)."""


def _bounded(what: str, deadline_s: float, fn, *args, **kwargs):
    fut = _cal_pool.submit(fn, *args, **kwargs)
    try:
        return fut.result(timeout=deadline_s)
    except FutureTimeout:
        log.error("calendar %s exceeded %.0f s: the turn continues without the calendar", what, deadline_s)
        raise CalendarTimeout(f"calendar {what} timed out") from None


class TenantCalendars:
    """Engine-facing dispatcher (same surface as the stub, plus cancel and reschedule).

    Every call runs under a deadline (`_bounded`): availability raises `CalendarTimeout` (the engine answers
    `calendar_unavailable`), writes return `{"ok": False, "reason": "calendar_unavailable"}`."""

    def __init__(self, settings: Any, resolve=None, read_deadline_s: float | None = None,
                 write_deadline_s: float | None = None):
        self.settings = settings
        self.resolve = resolve or (lambda tenant_id, cfg: get_provider(tenant_id, cfg, settings))
        self.read_deadline_s = read_deadline_s or CALENDAR_READ_DEADLINE_S
        self.write_deadline_s = write_deadline_s or CALENDAR_WRITE_DEADLINE_S

    def _write(self, what: str, fn) -> dict[str, Any]:
        try:
            return _bounded(what, self.write_deadline_s, fn)
        except CalendarTimeout:
            return {"ok": False, "reason": "calendar_unavailable"}

    def availability(self, tenant_id, cfg, now: datetime, date_from: date | None = None, limit: int = 6):
        return _bounded("availability", self.read_deadline_s, lambda: self.resolve(tenant_id, cfg).availability(
            tenant_id, cfg, now, date_from=date_from, limit=limit))

    def book(self, tenant_id, cfg, now, slot_id, details):
        return self._write("book", lambda: self.resolve(tenant_id, cfg).book(tenant_id, cfg, now, slot_id, details))

    def cancel(self, tenant_id, cfg, event_id, reason="", now=None):
        def run():
            p = self.resolve(tenant_id, cfg)
            if not hasattr(p, "cancel"):
                return {"ok": False, "reason": "not_supported"}
            return p.cancel(tenant_id, cfg, event_id, reason, now)
        return self._write("cancel", run)

    def reschedule(self, tenant_id, cfg, now, event_id, slot_id, details):
        def run():
            p = self.resolve(tenant_id, cfg)
            if not hasattr(p, "reschedule"):
                return {"ok": False, "reason": "not_supported"}
            return p.reschedule(tenant_id, cfg, now, event_id, slot_id, details)
        return self._write("reschedule", run)


def _convo_from_store(store: Store, tenant: Any, alert: dict[str, Any]) -> Any:
    """Enrich a booking alert with the booking row (name, address, job, time) when there is one."""
    contact = alert.get("contact") or ""
    booking = None
    if alert.get("kind") == "booking" and contact:
        ts = store.for_tenant(tenant.id)
        rows = ts.select("bookings", contact_e164=contact)
        if not rows and alert.get("convo_id"):
            # Web chat: the alert's contact is the session id (`web-...`) while the booking row is keyed by the
            # number the customer typed. The saved conversation knows what it booked (event id, phone).
            key = f"convo:{tenant.id}:{alert.get('channel', '')}:{alert['convo_id']}"
            saved = store.select("runtime_state", key=key)
            booked = ((saved[0].get("value") or {}).get("booking") or {}) if saved else {}
            if booked.get("event_id"):
                rows = ts.select("bookings", provider_event_id=booked["event_id"])
            if not rows and booked.get("phone"):
                rows = ts.select("bookings", contact_e164=booked["phone"])
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

            def h_crm(job):
                # ADD-CRM: one job per (provider, event); the client decides sent / retry / failed.
                from .crm import build_lead
                tenant = _load_tenant(store, job["tenant_id"])
                if tenant is None:
                    return "dead", 0.0
                p = job["payload"]
                provider = p["provider"]
                client = crm_for(store, state, provider)
                if not client.connected(tenant.id):
                    flag = f"crm:notconn:{tenant.id}:{provider}"
                    if not state.get(flag):
                        state.put(flag, True, tenant.id)
                        store.for_tenant(tenant.id).log_event("crm.not_connected", {"provider": provider, "event": p["event"]})
                    return "dead", 0.0
                lead = build_lead(state, tenant, p["data"])
                res = client.sync(tenant, p["event"], lead, idem=p["key"], attempt=job["attempt"])
                if res["status"] == "retry":
                    return "retry", float(res.get("delay") or 0.0)
                return ("done", 0.0) if res["status"] in ("sent", "skipped") else ("dead", 0.0)

            q = DeliveryQueue(store, state, {"alert": h_alert, "calendar_alert": h_calendar, "zapier": h_zapier,
                                             "crm": h_crm}, autostart=autostart)
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
    try:  # ADD-CRM: one job per enabled CRM link subscribed to this event
        from .crm import links_for
        for provider in links_for(tenant, event):
            queue_for(store, state).enqueue("crm", {"provider": provider, "event": event, "key": idempotency_key,
                                                    "data": payload}, tenant.id)
    except Exception:  # noqa: BLE001
        log.exception("crm enqueue failed")
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
