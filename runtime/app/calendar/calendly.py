"""Calendly provider: the default calendar integration (no Google verification needed).

API v2 (api.calendly.com):
- availability: `GET /event_type_available_times` (Calendly already applies the owner's
  connected calendars, buffers and limits); queried in chunks of at most 7 days.
- booking: `POST /invitees` (Calendly Scheduling API; needs a paid Calendly plan on the
  owner's side). The booked start is the first open Calendly time inside our arrival window.
- cancel: `POST /scheduled_events/{uuid}/cancellation`.

Event type: `booking.calendar_id` may hold an event type URI; otherwise the first active
event type of the connected user is picked once and remembered (encrypted, with the token).
Invitee e-mail: Calendly requires one and callers rarely give it, so the invitee is the
customer's name with the owner's first alert e-mail; the phone and every job detail go into
the location/notes (Calendly shows them on the event).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ..store import StateStore, Store
from ..tenants import TenantConfig
from .api import AuthedApi
from .base import AlertFn, CalendarError, CalendarProvider, FreeInfo, event_text
from .oauth import TokenManager

API = "https://api.calendly.com"
EVENT_TYPE_PREFIX = f"{API}/event_types/"
MAX_RANGE = timedelta(days=7)


def _z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000Z")


class CalendlyProvider(CalendarProvider):
    name = "calendly"

    def __init__(self, store: Store, tokens: TokenManager, state: StateStore | None = None,
                 alert: AlertFn | None = None, http: httpx.Client | None = None):
        super().__init__(store, state, alert)
        self.tokens = tokens
        self.api = AuthedApi("calendly", API, tokens, http)

    def event_type(self, tenant_id: str, cfg: TenantConfig) -> str:
        if cfg.booking.calendar_id.startswith(EVENT_TYPE_PREFIX):
            return cfg.booking.calendar_id
        meta = self.tokens.meta(tenant_id, "calendly")
        if meta.get("event_type"):
            return meta["event_type"]
        me = self.api.call(tenant_id, "GET", "/users/me").get("resource") or {}
        user = me.get("uri")
        if not user:
            raise CalendarError("calendly: no user uri")
        types = self.api.call(tenant_id, "GET", "/event_types",
                              params={"user": user, "active": "true", "count": 20}).get("collection") or []
        if not types:
            raise CalendarError("calendly: the connected account has no active event type")
        self.tokens.set_meta(tenant_id, "calendly", user=user, event_type=types[0]["uri"])
        return types[0]["uri"]

    def _free_info(self, tenant_id, cfg, start, end, now):
        et = self.event_type(tenant_id, cfg)
        # UTC arithmetic: a 7-day step in local wall time is 7 days + 1 hour across a DST change.
        cursor = max(start, now + timedelta(minutes=1)).astimezone(timezone.utc)  # no start times in the past
        end = end.astimezone(timezone.utc)
        opens: list[datetime] = []
        while cursor < end:
            stop = min(cursor + MAX_RANGE, end)
            body = self.api.call(tenant_id, "GET", "/event_type_available_times",
                                 params={"event_type": et, "start_time": _z(cursor), "end_time": _z(stop)})
            for item in body.get("collection") or []:
                if item.get("status", "available") == "available" and item.get("start_time"):
                    opens.append(datetime.fromisoformat(item["start_time"].replace("Z", "+00:00")))
            cursor = stop
        return FreeInfo(busy=[], open_starts=opens)

    def _create_event(self, tenant_id, cfg, slot, details):
        if not cfg.notify.email:
            raise CalendarError("calendly booking needs an owner e-mail in notify.email")
        summary, description = event_text(details)
        body = {
            "event_type": self.event_type(tenant_id, cfg),
            "start_time": _z(datetime.fromisoformat(slot["provider_start"])),
            "invitee": {"name": str(details.get("name") or "Customer")[:80], "email": cfg.notify.email[0],
                        "timezone": cfg.business.timezone},
            "location": {"kind": "physical", "location": str(details.get("address") or "")[:200] or "Phone"},
            "questions_and_answers": [{"question": "Job details", "answer": f"{summary}\n{description}"[:1000],
                                       "position": 0}],
        }
        res = self.api.call(tenant_id, "POST", "/invitees", json=body).get("resource") or {}
        event = res.get("event")
        if not event:
            raise CalendarError("calendly returned no scheduled event")
        return event

    def _delete_event(self, tenant_id, cfg, event_id, reason):
        if not event_id.startswith(f"{API}/scheduled_events/"):
            raise CalendarError("not a Calendly scheduled event")
        self.api.call(tenant_id, "POST", f"{event_id}/cancellation", json={"reason": reason[:200]},
                      ok_missing=True)
