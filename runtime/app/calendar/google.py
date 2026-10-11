"""Google Calendar provider (second option after Calendly).

Busy time comes from `events.list` (single events, opaque, not cancelled) rather than the
`freeBusy` endpoint, because freeBusy merges overlapping blocks and the per-window capacity
(`max_per_window`) needs the number of jobs, not just "busy or not". Our own events carry a
private extended property and are counted from the ledger instead, never twice.
Scope: `calendar.events` only.
"""
from __future__ import annotations

from datetime import datetime, time
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx

from ..store import StateStore, Store
from ..tenants import TenantConfig
from .api import AuthedApi
from .base import AlertFn, CalendarError, CalendarProvider, FreeInfo, event_text
from .oauth import TokenManager

API = "https://www.googleapis.com/calendar/v3"
OUR_TAG = "ailab_booking"


def _parse(point: dict[str, Any], tz: ZoneInfo) -> datetime | None:
    if point.get("dateTime"):
        return datetime.fromisoformat(point["dateTime"].replace("Z", "+00:00"))
    if point.get("date"):  # all-day event: midnight in the tenant's timezone
        return datetime.combine(datetime.fromisoformat(point["date"]).date(), time(0), tz)
    return None


class GoogleCalendarProvider(CalendarProvider):
    name = "google"

    def __init__(self, store: Store, tokens: TokenManager, state: StateStore | None = None,
                 alert: AlertFn | None = None, http: httpx.Client | None = None):
        super().__init__(store, state, alert)
        self.api = AuthedApi("google", API, tokens, http)

    @staticmethod
    def _cal(cfg: TenantConfig) -> str:
        return quote(cfg.booking.calendar_id or "primary", safe="")

    def _free_info(self, tenant_id, cfg, start, end, now):
        tz = ZoneInfo(cfg.business.timezone)
        busy: list[tuple[datetime, datetime]] = []
        page: str | None = None
        for _ in range(10):  # at most 2,500 events in the horizon
            params = {"timeMin": start.isoformat(), "timeMax": end.isoformat(), "singleEvents": "true",
                      "orderBy": "startTime", "maxResults": 250, "showDeleted": "false"}
            if page:
                params["pageToken"] = page
            body = self.api.call(tenant_id, "GET", f"/calendars/{self._cal(cfg)}/events", params=params)
            for ev in body.get("items") or []:
                if ev.get("status") == "cancelled" or ev.get("transparency") == "transparent":
                    continue
                if ((ev.get("extendedProperties") or {}).get("private") or {}).get(OUR_TAG):
                    continue
                s, e = _parse(ev.get("start") or {}, tz), _parse(ev.get("end") or {}, tz)
                if s and e:
                    busy.append((s, e))
            page = body.get("nextPageToken")
            if not page:
                break
        return FreeInfo(busy=busy)

    def _create_event(self, tenant_id, cfg, slot, details):
        summary, description = event_text(details)
        tz = cfg.business.timezone
        body = {
            "summary": summary,
            "description": description,
            "location": details.get("address") or "",
            "start": {"dateTime": slot["start"], "timeZone": tz},
            "end": {"dateTime": slot["end"], "timeZone": tz},
            "extendedProperties": {"private": {OUR_TAG: "1", "slot_id": slot["slot_id"]}},
            "reminders": {"useDefault": True},
        }
        res = self.api.call(tenant_id, "POST", f"/calendars/{self._cal(cfg)}/events",
                            params={"sendUpdates": "none"}, json=body)
        if not res.get("id"):
            raise CalendarError("google returned no event id")
        return res["id"]

    def _delete_event(self, tenant_id, cfg, event_id, reason):
        self.api.call(tenant_id, "DELETE", f"/calendars/{self._cal(cfg)}/events/{quote(event_id, safe='')}",
                      params={"sendUpdates": "none"}, ok_missing=True)
