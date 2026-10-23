"""ADD-CRM: direct CRM links (HubSpot, Jobber). See base.py for the contract and docs/crm-links.md."""
from __future__ import annotations

from typing import Any

import httpx

from ..store import StateStore, Store
from .base import EVENTS, PROVIDERS, BaseCrmClient, CredentialBox, CrmClient, CrmError, build_lead
from .hubspot import HubSpotClient
from .jobber import JobberClient

CLIENTS: dict[str, type[BaseCrmClient]] = {"hubspot": HubSpotClient, "jobber": JobberClient}


def make_client(provider: str, box: CredentialBox, store: Store, state: StateStore,
                http: httpx.Client | None = None) -> BaseCrmClient:
    cls = CLIENTS.get(provider)
    if cls is None:
        raise CrmError(f"unknown CRM provider {provider!r}")
    return cls(box, store, state, http=http)


def links_for(tenant: Any, event: str) -> list[str]:
    """Providers whose link is enabled for this tenant and subscribed to `event`."""
    crm = getattr(getattr(tenant, "config", None), "crm", None)
    out = []
    for p in PROVIDERS:
        link = getattr(crm, p, None)
        if link is not None and getattr(link, "enabled", False) and event in (getattr(link, "events", None) or []):
            out.append(p)
    return out


__all__ = ["EVENTS", "PROVIDERS", "BaseCrmClient", "CredentialBox", "CrmClient", "CrmError", "HubSpotClient",
           "JobberClient", "build_lead", "links_for", "make_client"]
