"""ADD-CRM: Jobber (GraphQL API) with an access token.

Per event: `clients(searchTerm:)` by phone -> reuse the client, else `clientCreate` (name split into
first/last, phone, e-mail); then `requestCreate` (the lead or booking as a client request: title = job type)
and `clientCreateNote` with the summary and the booked window. Every call is one POST to the GraphQL
endpoint with `X-JOBBER-GRAPHQL-VERSION`. GraphQL `errors` / `userErrors` are final failures unless the
transport status says auth (401/403) or retry (429/5xx).

Production dependency (see docs/crm-links.md): Jobber only issues tokens to an approved developer app
through OAuth; until that approval the admin stores a token obtained manually, which expires.
"""
from __future__ import annotations

from typing import Any

from .base import BaseCrmClient, _Failed, json_of, note_text, split_name

GRAPHQL_URL = "https://api.getjobber.com/api/graphql"
API_VERSION = "2025-01-20"

Q_SEARCH = """query FindClient($term: String!) {
  clients(searchTerm: $term, first: 1) { nodes { id name } }
}"""
M_CLIENT_CREATE = """mutation CreateClient($input: ClientCreateInput!) {
  clientCreate(input: $input) { client { id } userErrors { message path } }
}"""
M_REQUEST_CREATE = """mutation CreateRequest($input: RequestCreateInput!) {
  requestCreate(input: $input) { request { id } userErrors { message path } }
}"""
M_CLIENT_NOTE = """mutation NoteClient($clientId: EncodedId!, $input: ClientNoteCreateInput!) {
  clientCreateNote(clientId: $clientId, input: $input) { clientNote { id } userErrors { message path } }
}"""
Q_ACCOUNT = "query { account { id name } }"


class JobberClient(BaseCrmClient):
    provider = "jobber"

    def __init__(self, *args: Any, url: str = GRAPHQL_URL, **kw: Any):
        super().__init__(*args, **kw)
        self.url = url

    def _gql(self, token: str, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = self._request("POST", self.url, token, json={"query": query, "variables": variables or {}},
                             headers={"X-JOBBER-GRAPHQL-VERSION": API_VERSION, "Content-Type": "application/json"})
        body = json_of(resp)
        if body.get("errors"):
            codes = {str((e.get("extensions") or {}).get("code") or "") for e in body["errors"] if isinstance(e, dict)}
            if codes & {"UNAUTHENTICATED", "UNAUTHORIZED"}:
                raise _Failed("auth")
            raise _Failed("graphql_error")
        return body.get("data") or {}

    @staticmethod
    def _result(data: dict[str, Any], field: str, obj: str) -> str | None:
        payload = data.get(field) or {}
        if payload.get("userErrors"):
            raise _Failed(f"{field}_rejected")
        return ((payload.get(obj) or {}).get("id")) or None

    # --- steps --------------------------------------------------------------------------------------------------
    def _find_client(self, token: str, lead: dict[str, Any]) -> str | None:
        term = lead.get("phone") or lead.get("email") or ""
        if not term:
            return None
        nodes = ((self._gql(token, Q_SEARCH, {"term": term}).get("clients") or {}).get("nodes")) or []
        return str(nodes[0]["id"]) if nodes and nodes[0].get("id") else None

    def _create_client(self, token: str, lead: dict[str, Any]) -> str:
        first, last = split_name(lead.get("name") or "")
        inp: dict[str, Any] = {"firstName": first or "Unknown", "lastName": last or "Caller"}
        if lead.get("phone"):
            inp["phones"] = [{"number": lead["phone"], "primary": True, "description": "MAIN"}]
        if lead.get("email"):
            inp["emails"] = [{"address": lead["email"], "primary": True, "description": "MAIN"}]
        if lead.get("address"):
            inp["billingAddress"] = {"street1": lead["address"]}
        cid = self._result(self._gql(token, M_CLIENT_CREATE, {"input": inp}), "clientCreate", "client")
        if not cid:
            raise _Failed("no_client_id")
        return cid

    def _create_request(self, token: str, cid: str, lead: dict[str, Any]) -> str | None:
        title = lead.get("job_type") or "Service request"
        if lead.get("booking"):
            title = f"{title} ({lead['booking'].get('label') or lead['booking'].get('start')})"
        return self._result(self._gql(token, M_REQUEST_CREATE, {"input": {"clientId": cid, "title": title[:120]}}),
                            "requestCreate", "request")

    def _note(self, token: str, cid: str, lead: dict[str, Any], event: str) -> str | None:
        return self._result(self._gql(token, M_CLIENT_NOTE, {"clientId": cid, "input": {"message": note_text(lead, event)}}),
                            "clientCreateNote", "clientNote")

    # --- contract -----------------------------------------------------------------------------------------------
    def _sync(self, tenant: Any, token: str, event: str, lead: dict[str, Any]) -> dict[str, Any]:
        cid = self._find_client(token, lead)
        created = cid is None
        if created:
            cid = self._create_client(token, lead)
        return {"status": "sent", "client_id": cid, "created": created,
                "request_id": self._create_request(token, cid, lead),
                "note_id": self._note(token, cid, lead, event)}

    def _check(self, token: str) -> dict[str, Any]:
        account = self._gql(token, Q_ACCOUNT).get("account") or {}
        return {"provider": self.provider, "account": str(account.get("name") or "")}
