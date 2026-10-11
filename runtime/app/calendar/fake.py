"""In-memory provider for tests and demo tenants. Same rules as the real providers (base class)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from ..store import StateStore, Store
from .base import AlertFn, CalendarAuthError, CalendarError, CalendarProvider, FreeInfo, event_text


class FakeProvider(CalendarProvider):
    name = "fake"

    def __init__(self, store: Store, state: StateStore | None = None, alert: AlertFn | None = None):
        super().__init__(store, state, alert)
        self.busy: dict[str, list[tuple[datetime, datetime]]] = {}
        self.events: dict[str, dict[str, Any]] = {}
        self.fail: str | None = None  # None | "auth" | "down"

    def add_busy(self, tenant_id: str, start: datetime, end: datetime) -> None:
        self.busy.setdefault(tenant_id, []).append((start, end))

    def _check(self) -> None:
        if self.fail == "auth":
            raise CalendarAuthError("fake: refresh token revoked")
        if self.fail == "down":
            raise CalendarError("fake: provider down")

    def _free_info(self, tenant_id, cfg, start, end, now):
        self._check()
        return FreeInfo(busy=list(self.busy.get(tenant_id, [])))

    def _create_event(self, tenant_id, cfg, slot, details):
        self._check()
        summary, description = event_text(details)
        event_id = "fake-" + uuid.uuid4().hex[:12]
        self.events[event_id] = {"tenant_id": tenant_id, "summary": summary, "description": description,
                                 "start": slot["start"], "end": slot["end"], "location": details.get("address")}
        return event_id

    def _delete_event(self, tenant_id, cfg, event_id, reason):
        self._check()
        self.events.pop(event_id, None)
