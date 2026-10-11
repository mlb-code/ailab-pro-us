"""Fake calendar for the simulator (SQLite, in memory by default).

Applies the booking rules from SPEC 6.4 so the simulator behaves like the real providers
will (B5 wraps this behind the shared provider contract):
- slots only inside `booking.windows`, only on days the business is open,
- at least `lead_time_hours` from now, at most `max_per_window` bookings per window,
- a booking must use a slot id that availability returns right now,
- one booking per phone number per local day (duplicate guard).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.tenants import DAYS, TenantConfig


class FakeCalendar:
    def __init__(self, path: str = ":memory:"):
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        self._db.execute("""create table if not exists events (
            id text primary key, tenant_id text, slot_id text, local_day text,
            start_at text, end_at text, phone text, details text, created_at text)""")

    # --- availability -----------------------------------------------------------
    def _count(self, tenant_id: str, slot_id: str) -> int:
        return self._db.execute("select count(*) from events where tenant_id=? and slot_id=?",
                                (tenant_id, slot_id)).fetchone()[0]

    def availability(self, tenant_id: str, cfg: TenantConfig, now: datetime,
                     date_from: date | None = None, limit: int = 6) -> list[dict]:
        tz = ZoneInfo(cfg.business.timezone)
        local_now = now.astimezone(tz)
        earliest = local_now + timedelta(hours=cfg.booking.lead_time_hours)
        day = max(date_from or local_now.date(), local_now.date())
        last_day = local_now.date() + timedelta(days=cfg.booking.days_ahead)
        out: list[dict] = []
        while day <= last_day and len(out) < limit:
            if getattr(cfg.hours, DAYS[day.weekday()]) is not None:
                for w_start, w_end in cfg.booking.windows:
                    start = datetime.combine(day, time.fromisoformat(w_start), tz)
                    end = datetime.combine(day, time.fromisoformat(w_end), tz)
                    slot_id = f"{day.isoformat()}T{w_start}-{w_end}"
                    if start < earliest or self._count(tenant_id, slot_id) >= cfg.booking.max_per_window:
                        continue
                    out.append({"slot_id": slot_id, "start": start.isoformat(), "end": end.isoformat(),
                                "label": f"{start:%A %b} {start.day}, {_ampm(start)} to {_ampm(end)}"})
                    if len(out) >= limit:
                        break
            day += timedelta(days=1)
        return out

    # --- booking ---------------------------------------------------------------
    def book(self, tenant_id: str, cfg: TenantConfig, now: datetime, slot_id: str, details: dict) -> dict:
        with self._lock:
            slots = {s["slot_id"]: s for s in self.availability(tenant_id, cfg, now, limit=500)}
            slot = slots.get(slot_id)
            if not slot:
                return {"ok": False, "reason": "slot_unavailable"}
            phone = details.get("phone", "")
            local_day = slot_id[:10]
            dup = self._db.execute("select 1 from events where tenant_id=? and phone=? and local_day=?",
                                   (tenant_id, phone, local_day)).fetchone()
            if phone and dup:
                return {"ok": False, "reason": "duplicate"}
            event_id = "fake-" + uuid.uuid4().hex[:12]
            desc = dict(details, booked_by="Booked by AI receptionist")
            self._db.execute("insert into events values (?,?,?,?,?,?,?,?,?)",
                             (event_id, tenant_id, slot_id, local_day, slot["start"], slot["end"], phone,
                              json.dumps(desc), datetime.now(timezone.utc).isoformat()))
            self._db.commit()
            return {"ok": True, "event_id": event_id, "start": slot["start"], "end": slot["end"], "label": slot["label"]}

    def events(self, tenant_id: str) -> list[dict]:
        rows = self._db.execute("select id, slot_id, start_at, end_at, phone, details from events where tenant_id=? "
                                "order by start_at", (tenant_id,)).fetchall()
        return [{"id": r[0], "slot_id": r[1], "start": r[2], "end": r[3], "phone": r[4], "details": json.loads(r[5])}
                for r in rows]


def _ampm(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}{'' if dt.minute == 0 else f':{dt.minute:02d}'} {'AM' if dt.hour < 12 else 'PM'}"
