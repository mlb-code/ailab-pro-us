"""Shared calendar-provider logic (SPEC 6.4, task B5).

Every provider (Calendly = default, Google Calendar, fake) exposes the interface the
conversation engine already uses:

    availability(tenant_id, cfg, now, date_from=None, limit=6) -> [slot]
    book(tenant_id, cfg, now, slot_id, details)               -> {"ok", "event_id", "start", "end", "label"} | {"ok": False, "reason"}
    cancel(tenant_id, cfg, event_id, reason="")               -> {"ok": True} | {"ok": False, "reason"}
    reschedule(tenant_id, cfg, now, event_id, slot_id, details) -> like book (new event), old event removed

The booking rules live here, once, so every provider enforces them the same way:
- slots are the tenant's arrival windows (`booking.windows`) on open days, in the tenant's
  timezone, at least `lead_time_hours` ahead and at most `days_ahead` days out;
- a window is full after `max_per_window` jobs (our bookings + the owner's own busy events);
  an owner event that covers the whole window blocks it;
- a booking must use a slot that availability returns *right now* (re-checked under a lock);
- one booking per phone number per local day (duplicate guard);
- only events we created can be cancelled or moved (the AI never deletes or moves the owner's events).

Our bookings are kept in a small per-tenant ledger in `runtime_state` (phone numbers hashed),
so the rules hold across restarts and do not depend on who writes the `bookings` row.

Auth failures (revoked/expired refresh token) flag the tenant `needs_reconnect`, emit one
`calendar_reconnect` alert, and make availability empty / booking fail with
`calendar_unavailable`, so the assistant falls back to `take_message`.
"""
from __future__ import annotations

import hashlib
import logging
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from ..store import StateStore, Store, StoreError
from ..tenants import DAYS, TenantConfig

log = logging.getLogger("rt.calendar")

BOOKED_BY = "Booked by AI receptionist"
LEDGER_KEEP_DAYS = 2  # ledger entries are dropped this long after their window ended

AlertFn = Callable[[str, dict[str, Any]], None]


class CalendarError(RuntimeError):
    """Upstream problem that is probably temporary (network, 5xx, rate limit)."""


class CalendarAuthError(CalendarError):
    """Not connected, or the refresh token no longer works: the owner must reconnect."""


@dataclass(frozen=True)
class Window:
    slot_id: str
    start: datetime
    end: datetime

    @property
    def local_day(self) -> str:
        return self.slot_id[:10]


@dataclass
class FreeInfo:
    """What the provider knows about free time in a range.

    `busy`: the owner's own blocking events (not ours) as (start, end).
    `open_starts`: bookable start times (Calendly); None means "any time in the window works".
    """
    busy: list[tuple[datetime, datetime]] = field(default_factory=list)
    open_starts: list[datetime] | None = None


def ampm(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}{'' if dt.minute == 0 else f':{dt.minute:02d}'} {'AM' if dt.hour < 12 else 'PM'}"


def label(start: datetime, end: datetime) -> str:
    return f"{start:%A %b} {start.day}, {ampm(start)} to {ampm(end)}"


def phone_hash(phone: str) -> str:
    return hashlib.sha256((phone or "").encode()).hexdigest()[:16]


def candidate_windows(cfg: TenantConfig, now: datetime, date_from: date | None = None) -> list[Window]:
    """All arrival windows that satisfy hours, lead time and the booking horizon (tenant timezone)."""
    tz = ZoneInfo(cfg.business.timezone)
    local_now = now.astimezone(tz)
    earliest = local_now + timedelta(hours=cfg.booking.lead_time_hours)
    day = max(date_from or local_now.date(), local_now.date())
    last_day = local_now.date() + timedelta(days=cfg.booking.days_ahead)
    out: list[Window] = []
    while day <= last_day:
        if getattr(cfg.hours, DAYS[day.weekday()]) is not None:
            for w_start, w_end in cfg.booking.windows:
                start = datetime.combine(day, time.fromisoformat(w_start), tz)
                end = datetime.combine(day, time.fromisoformat(w_end), tz)
                if start >= earliest:
                    out.append(Window(f"{day.isoformat()}T{w_start}-{w_end}", start, end))
        day += timedelta(days=1)
    return out


def _overlaps(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> bool:
    return a0 < b1 and b0 < a1


class CalendarProvider(ABC):
    """Template for providers. Subclasses implement `_free_info`, `_create_event`, `_delete_event`."""

    name = "abstract"

    def __init__(self, store: Store, state: StateStore | None = None, alert: AlertFn | None = None):
        self.store = store
        self.state = state or StateStore(store)
        self.alert = alert
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()

    # --- provider hooks ------------------------------------------------------------------
    @abstractmethod
    def _free_info(self, tenant_id: str, cfg: TenantConfig, start: datetime, end: datetime,
                   now: datetime) -> FreeInfo: ...

    @abstractmethod
    def _create_event(self, tenant_id: str, cfg: TenantConfig, slot: dict[str, Any],
                      details: dict[str, Any]) -> str: ...

    @abstractmethod
    def _delete_event(self, tenant_id: str, cfg: TenantConfig, event_id: str, reason: str) -> None: ...

    # --- reconnect flag ------------------------------------------------------------------
    def _flag_key(self, tenant_id: str) -> str:
        return f"cal:{tenant_id}:needs_reconnect"

    def needs_reconnect(self, tenant_id: str) -> bool:
        flag = self.state.get(self._flag_key(tenant_id))
        return bool(flag) and flag.get("provider") == self.name

    def flag_reconnect(self, tenant_id: str, reason: str) -> None:
        if self.needs_reconnect(tenant_id):
            return
        self.state.put(self._flag_key(tenant_id), {"provider": self.name, "reason": reason[:120],
                                                    "at": datetime.now(timezone.utc).isoformat()}, tenant_id)
        alert = {"type": "alert", "kind": "calendar_reconnect", "provider": self.name,
                 "summary": f"{self.name.title()} calendar disconnected: bookings paused, messages are taken instead"}
        try:
            self.store.for_tenant(tenant_id).log_event("calendar.reconnect_needed", {"provider": self.name,
                                                                                    "reason": reason[:120]})
        except StoreError:
            log.exception("could not log calendar.reconnect_needed")
        log.warning("calendar %s needs reconnect (tenant %s): %s", self.name, tenant_id[:8], reason[:80])
        if self.alert:
            try:
                self.alert(tenant_id, alert)
            except Exception:  # noqa: BLE001 - an alert failure must not break booking fallback
                log.exception("calendar alert delivery failed")

    def clear_reconnect(self, tenant_id: str) -> None:
        self.state.put(self._flag_key(tenant_id), None, tenant_id)

    # --- ledger of our bookings ----------------------------------------------------------
    def _ledger_key(self, tenant_id: str) -> str:
        return f"cal:{tenant_id}:ledger"

    def ledger(self, tenant_id: str) -> list[dict[str, Any]]:
        return list(self.state.get(self._ledger_key(tenant_id)) or [])

    def _save_ledger(self, tenant_id: str, rows: list[dict[str, Any]], now: datetime) -> None:
        cutoff = now - timedelta(days=LEDGER_KEEP_DAYS)
        keep = [r for r in rows if datetime.fromisoformat(r["end"]) >= cutoff]
        self.state.put(self._ledger_key(tenant_id), keep, tenant_id)

    def _lock(self, tenant_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(tenant_id, threading.RLock())

    # --- engine interface ----------------------------------------------------------------
    def availability(self, tenant_id: str, cfg: TenantConfig, now: datetime,
                     date_from: date | None = None, limit: int = 6) -> list[dict[str, Any]]:
        return self._slots(tenant_id, cfg, now, date_from, limit)[0]

    def _slots(self, tenant_id: str, cfg: TenantConfig, now: datetime, date_from: date | None,
               limit: int) -> tuple[list[dict[str, Any]], str | None]:
        """(slots, problem); problem is None, 'auth' (flagged) or 'down' (temporary)."""
        if self.needs_reconnect(tenant_id):
            return [], "auth"
        windows = candidate_windows(cfg, now, date_from)
        if not windows:
            return [], None
        try:
            info = self._free_info(tenant_id, cfg, windows[0].start, windows[-1].end, now)
        except CalendarAuthError as exc:
            self.flag_reconnect(tenant_id, str(exc))
            return [], "auth"
        except CalendarError as exc:
            log.warning("calendar %s unavailable: %s", self.name, str(exc)[:120])
            return [], "down"
        ours = [r for r in self.ledger(tenant_id) if r.get("status") == "booked"]
        earliest = now + timedelta(hours=cfg.booking.lead_time_hours)
        out: list[dict[str, Any]] = []
        for w in windows:
            taken = sum(1 for r in ours if r["slot_id"] == w.slot_id)
            foreign = [b for b in info.busy if _overlaps(w.start, w.end, b[0], b[1])]
            if any(b[0] <= w.start and b[1] >= w.end for b in foreign):
                continue  # the owner blocked the whole window
            if taken + len(foreign) >= cfg.booking.max_per_window:
                continue
            slot = {"slot_id": w.slot_id, "start": w.start.isoformat(), "end": w.end.isoformat(),
                    "label": label(w.start, w.end)}
            if info.open_starts is not None:
                starts = sorted(s for s in info.open_starts if w.start <= s < w.end and s >= earliest)
                if not starts:
                    continue
                slot["provider_start"] = starts[0].isoformat()
            out.append(slot)
            if len(out) >= limit:
                break
        return out, None

    def book(self, tenant_id: str, cfg: TenantConfig, now: datetime, slot_id: str,
             details: dict[str, Any]) -> dict[str, Any]:
        with self._lock(tenant_id):
            return self._book_locked(tenant_id, cfg, now, slot_id, details)

    def _book_locked(self, tenant_id: str, cfg: TenantConfig, now: datetime, slot_id: str,
                     details: dict[str, Any], replaces: str | None = None) -> dict[str, Any]:
        """`replaces`: the event a reschedule moves away from (not counted by the one-per-day duplicate guard)."""
        found, problem = self._slots(tenant_id, cfg, now, None, 500)
        if problem:
            return {"ok": False, "reason": "calendar_unavailable"}
        slot = {s["slot_id"]: s for s in found}.get(slot_id)
        if not slot:
            return {"ok": False, "reason": "slot_unavailable"}
        phone = str(details.get("phone") or "")
        rows = self.ledger(tenant_id)
        who = phone_hash(phone)
        if phone and any(r["phone"] == who and r["local_day"] == slot_id[:10] and r.get("status") == "booked"
                         and r["event_id"] != replaces for r in rows):
            return {"ok": False, "reason": "duplicate"}
        try:
            event_id = self._create_event(tenant_id, cfg, slot, dict(details, booked_by=BOOKED_BY))
        except CalendarAuthError as exc:
            self.flag_reconnect(tenant_id, str(exc))
            return {"ok": False, "reason": "calendar_unavailable"}
        except CalendarError as exc:
            log.warning("calendar %s booking failed: %s", self.name, str(exc)[:120])
            return {"ok": False, "reason": "calendar_unavailable"}
        rows.append({"event_id": event_id, "slot_id": slot_id, "local_day": slot_id[:10], "phone": who,
                     "start": slot["start"], "end": slot["end"], "status": "booked"})
        self._save_ledger(tenant_id, rows, now)
        log.info("calendar %s booked slot %s (tenant %s)", self.name, slot_id, tenant_id[:8])
        return {"ok": True, "event_id": event_id, "start": slot["start"], "end": slot["end"],
                "label": slot["label"]}

    def reschedule(self, tenant_id: str, cfg: TenantConfig, now: datetime, event_id: str, slot_id: str,
                   details: dict[str, Any]) -> dict[str, Any]:
        """Move one of OUR bookings to `slot_id` (a slot availability returns now) in one locked operation.

        Book first, then remove the old event, so the customer never ends up with no visit: if the new slot fails,
        nothing changed; if removing the old event fails, the new event is removed again (rollback) and the old one
        stands. Every provider gets it from the same two hooks (Google: new event + delete; Calendly: new invitee +
        cancellation of the old scheduled event, so the event link changes and Calendly sends its own notices).
        Only events in our ledger can be moved; the owner's own events never."""
        with self._lock(tenant_id):
            rows = self.ledger(tenant_id)
            old = next((r for r in rows if r["event_id"] == event_id and r.get("status") == "booked"), None)
            if not old:
                return {"ok": False, "reason": "not_found"}
            if old["slot_id"] == slot_id:
                return {"ok": False, "reason": "same_slot"}
            res = self._book_locked(tenant_id, cfg, now, slot_id, details, replaces=event_id)
            if not res.get("ok"):
                return res
            try:
                self._delete_event(tenant_id, cfg, event_id, "Moved to another time by the customer")
            except CalendarError as exc:  # includes auth errors: undo the new booking, keep the old one
                log.warning("calendar %s reschedule rollback: %s", self.name, str(exc)[:120])
                try:
                    self._delete_event(tenant_id, cfg, res["event_id"], "Reschedule rolled back")
                except CalendarError:
                    log.exception("calendar %s rollback could not remove the new event", self.name)
                rows = self.ledger(tenant_id)
                rows = [r for r in rows if r["event_id"] != res["event_id"]]
                self._save_ledger(tenant_id, rows, now)
                if isinstance(exc, CalendarAuthError):
                    self.flag_reconnect(tenant_id, str(exc))
                return {"ok": False, "reason": "calendar_unavailable"}
            rows = self.ledger(tenant_id)
            for r in rows:
                if r["event_id"] == event_id:
                    r["status"] = "rescheduled"
            self._save_ledger(tenant_id, rows, now)
        self.store.for_tenant(tenant_id).log_event("booking.rescheduled", {"provider": self.name, "from": old["slot_id"],
                                                                         "to": slot_id})
        return res

    def cancel(self, tenant_id: str, cfg: TenantConfig, event_id: str, reason: str = "",
               now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(timezone.utc)
        with self._lock(tenant_id):
            rows = self.ledger(tenant_id)
            hit = next((r for r in rows if r["event_id"] == event_id and r.get("status") == "booked"), None)
            if not hit:
                return {"ok": False, "reason": "not_found"}
            try:
                self._delete_event(tenant_id, cfg, event_id, reason or "Cancelled by the customer")
            except CalendarAuthError as exc:
                self.flag_reconnect(tenant_id, str(exc))
                return {"ok": False, "reason": "calendar_unavailable"}
            except CalendarError:
                return {"ok": False, "reason": "calendar_unavailable"}
            hit["status"] = "cancelled"
            self._save_ledger(tenant_id, rows, now)
        ts = self.store.for_tenant(tenant_id)
        for row in ts.select("bookings", provider_event_id=event_id):
            ts.update("bookings", row["id"], {"status": "cancelled"})
        ts.log_event("booking.cancelled", {"provider": self.name, "slot_id": hit["slot_id"]})
        return {"ok": True}


def event_text(details: dict[str, Any]) -> tuple[str, str]:
    """(summary, description) for a calendar event, with every job detail."""
    job = details.get("job_type") or "Service call"
    name = details.get("name") or "Customer"
    urgent = str(details.get("urgency") or "normal").lower() == "urgent"
    summary = f"{'URGENT: ' if urgent else ''}{job}: {name}"
    lines = [
        f"Customer: {name}",
        f"Phone: {details.get('phone') or '-'}",
        *([f"Alternate phone: {details['alt_phone']}"] if details.get("alt_phone") else []),
        f"Address: {details.get('address') or '-'}",
        f"Job type: {job}",
        f"Urgency: {details.get('urgency') or 'normal'}",
        f"Notes: {details.get('notes') or '-'}",
        "",
        details.get("booked_by") or BOOKED_BY,
    ]
    return summary, "\n".join(lines)
