"""Real estate: Follow Up Boss "Events" API (https://docs.followupboss.com/reference/events-post), direct.

Optional: the included Zapier webhook already reaches Follow Up Boss ("Webhooks by Zapier -> Follow Up Boss: create
lead"). The direct link skips Zapier: one `POST /v1/events` per lead/booking with the screening answers. FUB
de-duplicates people by phone / e-mail itself, so a second event for the same caller updates the existing person
and adds the inquiry to their timeline (never a duplicate contact).

Auth: HTTP Basic, the client's FUB API key as the user name and an empty password (stored encrypted, provider
`follow_up_boss`). `X-System` / `X-System-Key` identify us; FUB asks every integration to send them (the key is
optional for the Events endpoint; env FUB_SYSTEM_KEY when registered). Payload documented in docs/follow-up-boss.md.
"""
from __future__ import annotations

import base64
import os
from typing import Any

from ..settings import brand
from .base import BaseCrmClient, json_of, note_text, split_name

BASE_URL = "https://api.followupboss.com/v1"
EVENT_TYPE = {"buyer": "Property Inquiry", "seller": "Seller Inquiry", "renter": "General Inquiry"}


def _basic(api_key: str) -> str:
    return "Basic " + base64.b64encode(f"{api_key}:".encode()).decode()


def event_payload(tenant: Any, event: str, lead: dict[str, Any]) -> dict[str, Any]:
    """The FUB event body (documented in docs/follow-up-boss.md)."""
    q = dict(lead.get("qualification") or {})
    re_cfg = tenant.config.real_estate
    first, last = split_name(lead.get("name") or "")
    system = str(brand().get("name") or "Receptionist")
    person: dict[str, Any] = {"firstName": first or "Unknown", "lastName": last,
                              "tags": [f"{system} lead", f"{lead.get('channel') or 'phone'} lead"]}
    if lead.get("phone"):
        person["phones"] = [{"value": lead["phone"], "type": "mobile"}]
    if lead.get("email"):
        person["emails"] = [{"value": lead["email"]}]
    if re_cfg.follow_up_boss.assigned_to:
        person["assignedTo"] = re_cfg.follow_up_boss.assigned_to
    if q.get("intent"):
        person["tags"].append(str(q["intent"]))
    if q.get("timeline"):
        person["timeframeId"] = None  # FUB expects an id from its own list; the text goes in the message
    if q.get("price_range"):
        person["price"] = str(q["price_range"])
    etype = EVENT_TYPE.get(str(q.get("intent") or ""), "General Inquiry")
    if event == "booking.created":
        etype = "Property Inquiry" if q.get("intent") in ("buyer", None) else etype
    body: dict[str, Any] = {
        "source": re_cfg.follow_up_boss.source or system,
        "system": system,
        "type": etype,
        "message": lead.get("summary") or f"{event} via the AI lead assistant",
        "description": note_text(lead, event),
        "person": {k: v for k, v in person.items() if v not in (None, "", [])},
    }
    address = q.get("property_address") or (lead.get("address") if q.get("intent") in ("seller", "buyer") else "")
    if address:
        body["property"] = {"street": address}
    return body


class FollowUpBossClient(BaseCrmClient):
    provider = "follow_up_boss"

    def __init__(self, *args: Any, base_url: str = BASE_URL, **kw: Any):
        super().__init__(*args, **kw)
        self.base_url = base_url.rstrip("/")

    def _headers(self, token: str) -> dict[str, str]:
        h = {"Authorization": _basic(token), "X-System": str(brand().get("name") or "Receptionist").replace(" ", "")}
        if os.environ.get("FUB_SYSTEM_KEY"):
            h["X-System-Key"] = os.environ["FUB_SYSTEM_KEY"]
        return h

    def _sync(self, tenant: Any, token: str, event: str, lead: dict[str, Any]) -> dict[str, Any]:
        resp = self._request("POST", f"{self.base_url}/events", token, json=event_payload(tenant, event, lead),
                             headers=self._headers(token))
        data = json_of(resp)
        return {"status": "sent", "event_id": data.get("id"), "person_id": (data.get("person") or {}).get("id")}

    def _check(self, token: str) -> dict[str, Any]:
        resp = self._request("GET", f"{self.base_url}/me", token, headers=self._headers(token))
        return {"provider": self.provider, "account": (json_of(resp).get("name") or "")[:60]}
