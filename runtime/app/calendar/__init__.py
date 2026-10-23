"""Calendar providers (task B5). Calendly is the default integration, Google Calendar second.

`CalendarHub` has the same interface as each provider (and as the simulator's FakeCalendar),
and routes every call by the tenant's `booking.provider`, so the engine takes one object:

    hub = build_hub(store, settings, alert=notifier.calendar_alert)
    Engine(store, llm, hub, settings)
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

import httpx

from ..store import StateStore, Store
from ..tenants import TenantConfig
from .base import (BOOKED_BY, AlertFn, CalendarAuthError, CalendarError, CalendarProvider, FreeInfo,
                   candidate_windows, event_text)
from .calendly import CalendlyProvider
from .fake import FakeProvider
from .google import GoogleCalendarProvider
from .oauth import PROVIDERS, OAuthClient, TokenManager, clients_from_env

DEFAULT_PROVIDER = "calendly"

__all__ = ["BOOKED_BY", "CalendarAuthError", "CalendarError", "CalendarHub", "CalendarProvider",
           "CalendlyProvider", "DEFAULT_PROVIDER", "FakeProvider", "FreeInfo", "GoogleCalendarProvider",
           "OAuthClient", "PROVIDERS", "TokenManager", "build_hub", "candidate_windows", "clients_from_env",
           "event_text"]


class CalendarHub:
    def __init__(self, providers: dict[str, CalendarProvider], tokens: TokenManager | None = None):
        self.providers = providers
        self.tokens = tokens

    def provider(self, cfg: TenantConfig) -> CalendarProvider | None:
        return self.providers.get(cfg.booking.provider)

    def availability(self, tenant_id: str, cfg: TenantConfig, now: datetime, date_from: date | None = None,
                     limit: int = 6) -> list[dict[str, Any]]:
        p = self.provider(cfg)
        return p.availability(tenant_id, cfg, now, date_from=date_from, limit=limit) if p else []

    def book(self, tenant_id: str, cfg: TenantConfig, now: datetime, slot_id: str,
             details: dict[str, Any]) -> dict[str, Any]:
        p = self.provider(cfg)
        return p.book(tenant_id, cfg, now, slot_id, details) if p else {"ok": False, "reason": "calendar_unavailable"}

    def cancel(self, tenant_id: str, cfg: TenantConfig, event_id: str, reason: str = "",
               now: datetime | None = None) -> dict[str, Any]:
        p = self.provider(cfg)
        return p.cancel(tenant_id, cfg, event_id, reason, now) if p else {"ok": False, "reason": "calendar_unavailable"}

    def reschedule(self, tenant_id: str, cfg: TenantConfig, now: datetime, event_id: str, slot_id: str,
                   details: dict[str, Any]) -> dict[str, Any]:
        p = self.provider(cfg)
        return p.reschedule(tenant_id, cfg, now, event_id, slot_id, details) if p else \
            {"ok": False, "reason": "calendar_unavailable"}

    def needs_reconnect(self, tenant_id: str, cfg: TenantConfig) -> bool:
        p = self.provider(cfg)
        return bool(p and p.needs_reconnect(tenant_id))

    def connected(self, tenant_id: str, provider: str) -> None:
        """Called after a successful OAuth callback: clears the reconnect flag."""
        if provider in self.providers:
            self.providers[provider].clear_reconnect(tenant_id)


def build_hub(store: Store, settings: Any, state: StateStore | None = None, alert: AlertFn | None = None,
              http: httpx.Client | None = None, env: dict[str, str] | None = None) -> CalendarHub:
    state = state or StateStore(store, memory_fallback=getattr(settings, "is_sim", False))
    tokens = TokenManager(store, settings.cred_key, clients_from_env(settings.public_base_url, env), http=http,
                          state=state)
    providers: dict[str, CalendarProvider] = {
        "calendly": CalendlyProvider(store, tokens, state, alert, http),
        "google": GoogleCalendarProvider(store, tokens, state, alert, http),
        "fake": FakeProvider(store, state, alert),
    }
    return CalendarHub(providers, tokens)
