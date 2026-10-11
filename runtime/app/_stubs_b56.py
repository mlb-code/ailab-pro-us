"""Temporary hooks for B5 (calendar providers) and B6 (notifications / Zapier), written by B3/B4.

The voice and SMS flows call ONLY these functions (+ record_call / record_sms for costs). B5/B6 replace the bodies (or make them
delegate to `app.calendar` / `app.notify` / `app.zapier`) without touching voice.py / sms.py:

    get_provider(tenant_id, cfg, settings) -> provider with .availability(...) and .book(...)
    owner_alert(store, state, tenant, alert, idempotency_key) -> None
    emit(store, state, tenant, event, payload, idempotency_key) -> None

Until then: alerts and Zapier events are recorded as `events` rows (`alert.pending`,
`zapier.pending`) exactly once per idempotency key; nothing is sent. Calendars: the fake provider
in the simulator (or when a tenant has booking.provider == "fake"); otherwise a provider with no
slots, so the brain takes a message instead of booking.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

log = logging.getLogger("rt.hooks")

_FAKE = None


def _fake_calendar():
    global _FAKE
    if _FAKE is None:
        from sim.fake_calendar import FakeCalendar  # simulator only
        _FAKE = FakeCalendar()
    return _FAKE


class NullCalendar:
    """No calendar connected yet: no slots, bookings refused (the brain falls back to take_message)."""

    def availability(self, tenant_id: str, cfg: Any, now: datetime, date_from: date | None = None,
                     limit: int = 6) -> list[dict]:
        return []

    def book(self, tenant_id: str, cfg: Any, now: datetime, slot_id: str, details: dict) -> dict:
        return {"ok": False, "reason": "calendar_not_connected"}


def get_provider(tenant_id: str, cfg: Any, settings: Any) -> Any:
    """B5 replaces this with `app.calendar.get_provider(...)` (Calendly default, Google second)."""
    if settings.is_sim or cfg.booking.provider == "fake":
        return _fake_calendar()
    return NullCalendar()


class TenantCalendars:
    """What the conversation engine calls: dispatches each call to the tenant's provider."""

    def __init__(self, settings: Any, resolve=None):
        self.settings = settings
        self.resolve = resolve or (lambda tenant_id, cfg: get_provider(tenant_id, cfg, settings))

    def availability(self, tenant_id, cfg, now, date_from=None, limit=6):
        return self.resolve(tenant_id, cfg).availability(tenant_id, cfg, now, date_from=date_from, limit=limit)

    def book(self, tenant_id, cfg, now, slot_id, details):
        return self.resolve(tenant_id, cfg).book(tenant_id, cfg, now, slot_id, details)


def _once(state: Any, key: str, tenant_id: str) -> bool:
    flag = f"once:{key}"
    if state.get(flag):
        return False
    state.put(flag, True, tenant_id)
    return True


def owner_alert(store: Any, state: Any, tenant: Any, alert: dict[str, Any], idempotency_key: str) -> None:
    """B6: owner SMS + email `lead_alert` (and admin alerts to Meir). Stub: one `alert.pending` event."""
    if not _once(state, f"alert:{idempotency_key}", tenant.id):
        return
    payload = {k: alert.get(k) for k in ("kind", "summary", "urgency", "channel", "convo_id", "contact",
                                          "usage_kind", "used", "included") if alert.get(k) is not None}
    store.for_tenant(tenant.id).log_event("alert.pending", {**payload, "key": idempotency_key})


def emit(store: Any, state: Any, tenant: Any, event: str, payload: dict[str, Any], idempotency_key: str) -> None:
    """B6: Zapier webhook (`lead.created`, `booking.created`, `call.completed`). Stub: one event row."""
    if not _once(state, f"zap:{event}:{idempotency_key}", tenant.id):
        return
    store.for_tenant(tenant.id).log_event("zapier.pending", {"event": event, "key": idempotency_key, **payload})


def record_call(store: Any, state: Any, tenant: Any, **fields: Any) -> None:
    """Cost + log line for a finished call (B6 `notify.calllog`). Called once per call_sid by B3, from the
    status callback with Twilio's CallDuration. The calls row already exists (B3 inserts it at call start),
    so the Twilio cost is added here once instead of relying on calllog's insert-only path."""
    from .notify import calllog
    calllog.record_call(store, tenant, state=state, **fields)
    minutes = -(-int(fields.get("duration_s") or 0) // 60)
    calllog._add_cost(state, tenant, round(minutes * calllog.rates()["voice_per_min"], 4))


def record_sms(store: Any, state: Any, tenant: Any, **fields: Any) -> None:
    """One `sms_messages` row + Twilio cost estimate per message (B6 `notify.calllog.record_sms`)."""
    from .notify import calllog
    calllog.record_sms(store, tenant, state=state, **fields)


# --- B5/B6: the real implementations take precedence (app/hooks_b56.py; same names and signatures) ---
# The stub bodies stay as the audit record (`alert.pending` / `zapier.pending`, once per key) that the
# real hooks write first, so existing B3/B4 checks keep working; delivery happens in hooks_b56.
record_alert, record_emit = owner_alert, emit
from .hooks_b56 import TenantCalendars, emit, get_provider, owner_alert  # noqa: E402,F401,F811
try:  # B6 may provide its own record_call / record_sms with the same names and signatures
    from .hooks_b56 import record_call, record_sms  # noqa: E402,F401,F811
except ImportError:
    pass
