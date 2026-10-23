"""ADD-CRM: HubSpot (CRM v3) with a private-app access token.

Per event: find the contact by phone (`phone` / `mobilephone`) or e-mail -> PATCH it, else POST a new one;
then one note (associated to the contact, association type 202 = note -> contact); for `booking.created`
also a deal ("<job_type> - <name>", closedate = booked start, association type 3 = deal -> contact).
Scopes the private app needs: crm.objects.contacts.read/write, crm.objects.deals.read/write (notes are
covered by the contacts scopes). See docs/crm-links.md.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .base import BaseCrmClient, _Failed, json_of, note_text, split_name

BASE_URL = "https://api.hubapi.com"
NOTE_TO_CONTACT = 202
DEAL_TO_CONTACT = 3


def _ms(iso: str | None) -> int:
    try:
        dt = datetime.fromisoformat(iso) if iso else datetime.now(timezone.utc)
    except (TypeError, ValueError):
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _assoc(contact_id: str, type_id: int) -> list[dict[str, Any]]:
    return [{"to": {"id": contact_id},
             "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": type_id}]}]


class HubSpotClient(BaseCrmClient):
    provider = "hubspot"

    def __init__(self, *args: Any, base_url: str = BASE_URL, **kw: Any):
        super().__init__(*args, **kw)
        self.base_url = base_url.rstrip("/")

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    # --- contact ----------------------------------------------------------------------------------------------
    def _properties(self, lead: dict[str, Any]) -> dict[str, str]:
        first, last = split_name(lead.get("name") or "")
        props = {"phone": lead.get("phone") or "", "firstname": first, "lastname": last,
                 "address": lead.get("address") or "", "lifecyclestage": "lead"}
        if lead.get("email"):
            props["email"] = lead["email"]
        return {k: v for k, v in props.items() if v}

    def _find_contact(self, token: str, lead: dict[str, Any]) -> str | None:
        groups = []
        phone = lead.get("phone") or ""
        if phone:
            for prop in ("phone", "mobilephone"):
                groups.append({"filters": [{"propertyName": prop, "operator": "EQ", "value": phone}]})
        if lead.get("email"):
            groups.append({"filters": [{"propertyName": "email", "operator": "EQ", "value": lead["email"]}]})
        if not groups:
            return None
        resp = self._request("POST", self._url("/crm/v3/objects/contacts/search"), token,
                             json={"filterGroups": groups, "properties": ["phone", "email"], "limit": 1})
        results = json_of(resp).get("results") or []
        return str(results[0].get("id")) if results and results[0].get("id") else None

    def _upsert_contact(self, token: str, lead: dict[str, Any]) -> tuple[str, bool]:
        props = self._properties(lead)
        cid = self._find_contact(token, lead)
        if cid:
            self._request("PATCH", self._url(f"/crm/v3/objects/contacts/{cid}"), token, json={"properties": props})
            return cid, False
        resp = self._request("POST", self._url("/crm/v3/objects/contacts"), token, json={"properties": props})
        new_id = json_of(resp).get("id")
        if not new_id:
            raise _Failed("no_contact_id")
        return str(new_id), True

    # --- note / deal ------------------------------------------------------------------------------------------
    def _note(self, token: str, cid: str, lead: dict[str, Any], event: str) -> str | None:
        resp = self._request("POST", self._url("/crm/v3/objects/notes"), token, json={
            "properties": {"hs_note_body": note_text(lead, event), "hs_timestamp": _ms(None)},
            "associations": _assoc(cid, NOTE_TO_CONTACT)})
        return json_of(resp).get("id")

    def _deal(self, token: str, cid: str, lead: dict[str, Any]) -> str | None:
        booking = lead.get("booking") or {}
        name = " - ".join(x for x in (lead.get("job_type") or "Service call", lead.get("name") or "") if x)
        resp = self._request("POST", self._url("/crm/v3/objects/deals"), token, json={
            "properties": {"dealname": name, "closedate": _ms(booking.get("start")), "dealstage": "appointmentscheduled",
                           "pipeline": "default"},
            "associations": _assoc(cid, DEAL_TO_CONTACT)})
        return json_of(resp).get("id")

    # --- contract ---------------------------------------------------------------------------------------------
    def _sync(self, tenant: Any, token: str, event: str, lead: dict[str, Any]) -> dict[str, Any]:
        cid, created = self._upsert_contact(token, lead)
        out: dict[str, Any] = {"status": "sent", "contact_id": cid, "created": created}
        out["note_id"] = self._note(token, cid, lead, event)
        if event == "booking.created":
            out["deal_id"] = self._deal(token, cid, lead)
        return out

    def _check(self, token: str) -> dict[str, Any]:
        self._request("GET", self._url("/crm/v3/objects/contacts"), token, params={"limit": 1})
        return {"provider": self.provider}
