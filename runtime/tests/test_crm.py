"""ADD-CRM: direct CRM links (HubSpot, Jobber): encrypted credentials, upsert + note + deal, retries,
exactly-once, the delivery-queue hook and the admin endpoints. Offline: every API is an httpx.MockTransport."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import crypto, hooks_b56
from app.crm import CredentialBox, HubSpotClient, JobberClient, build_lead, links_for, make_client
from app.crm.base import CrmError, note_text, split_name
from app.main import create_app
from app.notify.routes import SIM_ADMIN_TOKEN, build_services, router
from app.settings import SIM_CRED_KEY
from app.store import JsonStore, StateStore
from app.tenants import load_record
from sim import harness

PHONE = "+17135550123"
TOKEN = "pat-na1-not-a-real-token-0000"
BOOKING = {"name": "Dana Miller", "address": "2100 Rice Blvd, Houston, TX 77005", "job_type": "AC repair",
           "urgency": "normal", "start": "2026-10-13T08:00:00-05:00", "end": "2026-10-13T12:00:00-05:00",
           "event_id": "evt-1"}


def _setup(tmp_path, demo_raw, **crm):
    raw = json.loads(json.dumps(demo_raw))
    if crm:
        raw["config"]["crm"] = crm
    store = JsonStore(tmp_path)
    state = StateStore(store, memory_fallback=True)
    tenant = store.upsert_tenant(load_record(raw))
    return store, state, tenant


def _convo(state, tenant, channel="sms", convo_id="SM1", **extra):
    raw = {"tenant_id": tenant.id, "channel": channel, "contact": PHONE, "convo_id": convo_id, "booking": None,
           "message": {"summary": "AC not cooling since last night", "job_type": "AC repair", "name": "Dana Miller",
                       "address": "2100 Rice Blvd, Houston, TX 77005"},
           "collected": {}, "meta": {}, "urgency": "normal", "transcript": []}
    raw.update(extra)
    state.put(f"convo:{tenant.id}:{channel}:{convo_id}", raw, tenant.id)
    return {"channel": channel, "convo_id": convo_id, "contact": PHONE, "outcome": "message", "urgency": "normal"}


class Api:
    """Scripted CRM API: `routes[(METHOD, path)]` -> response or callable; records every request."""

    def __init__(self, routes=None, default=None):
        self.routes = dict(routes or {})
        self.default = default
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        hit = self.routes.get((request.method, request.url.path), self.default)
        if callable(hit):
            hit = hit(request)
        if isinstance(hit, Exception):
            raise hit
        return hit if hit is not None else httpx.Response(200, json={"id": "new"})

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))

    def bodies(self, method, path):
        return [json.loads(r.content) for r in self.requests if r.method == method and r.url.path == path]


def _hubspot(store, state, api: Api, token=TOKEN) -> HubSpotClient:
    box = CredentialBox(store, SIM_CRED_KEY)
    if token:
        box.save("00000000-0000-4000-8000-000000000001", "hubspot", token)
    return HubSpotClient(box, store, state, http=api.client())


# --- credentials ----------------------------------------------------------------------------------------------
def test_credentials_are_encrypted_on_disk_and_bound_to_tenant_and_provider(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    box = CredentialBox(store, SIM_CRED_KEY)
    assert box.load(t.id, "hubspot") is None and not box.connected(t.id, "hubspot")
    box.save(t.id, "hubspot", TOKEN, {"label": "private app"})
    on_disk = (tmp_path / "tenant_credentials.json").read_text()
    assert TOKEN not in on_disk and "v1." in on_disk
    assert box.load(t.id, "hubspot") == {"access_token": TOKEN, "meta": {"label": "private app"}}
    assert box.token(t.id, "hubspot") == TOKEN
    # the same ciphertext does not open for another tenant / provider (AES-GCM associated data)
    cipher = store.get_credential(t.id, "hubspot")
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(SIM_CRED_KEY, cipher, "other-tenant", "hubspot")
    assert box.load(t.id, "jobber") is None
    box.delete(t.id, "hubspot")
    assert box.load(t.id, "hubspot") is None and not box.connected(t.id, "hubspot")
    with pytest.raises(CrmError):
        box.save(t.id, "hubspot", "   ")


def test_lead_is_built_from_the_stored_conversation(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    payload = _convo(state, t, meta={"lead": {"email": "dana@example.com", "property_type": "condo", "budget": "450k"}})
    lead = build_lead(state, t, payload)
    assert lead["name"] == "Dana Miller" and lead["phone"] == PHONE and lead["email"] == "dana@example.com"
    assert lead["job_type"] == "AC repair" and lead["summary"] == "AC not cooling since last night"
    assert lead["qualification"] == {"property_type": "condo", "budget": "450k"} and "booking" not in lead
    # booking: window + label; and a payload without a stored conversation still yields a usable lead
    payload = _convo(state, t, convo_id="CA2", channel="voice", booking=BOOKING)
    lead = build_lead(state, t, payload)
    assert lead["booking"] == {"start": BOOKING["start"], "end": BOOKING["end"], "label": "Tuesday Oct 13, 8 AM to 12 PM"}
    bare = build_lead(state, t, {"channel": "sms", "convo_id": "nope", "contact": PHONE, "outcome": "handoff"})
    assert bare["phone"] == PHONE and bare["summary"] == "handoff" and bare["name"] == ""
    assert split_name("Dana Lee Miller") == ("Dana", "Lee Miller") and split_name("") == ("", "")
    assert "Booked: Tuesday Oct 13, 8 AM to 12 PM" in note_text(lead, "booking.created") and PHONE not in note_text(lead, "x")


# --- HubSpot ---------------------------------------------------------------------------------------------------
def test_hubspot_match_by_phone_updates_the_contact_and_adds_a_note(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api({("POST", "/crm/v3/objects/contacts/search"): httpx.Response(200, json={"results": [{"id": "501"}]}),
               ("PATCH", "/crm/v3/objects/contacts/501"): httpx.Response(200, json={"id": "501"}),
               ("POST", "/crm/v3/objects/notes"): httpx.Response(201, json={"id": "n1"})})
    lead = build_lead(state, t, _convo(state, t))
    res = _hubspot(store, state, api).sync(t, "lead.created", lead, idem="SM1")
    assert res == {"status": "sent", "contact_id": "501", "created": False, "note_id": "n1"}
    search = api.bodies("POST", "/crm/v3/objects/contacts/search")[0]
    props = {g["filters"][0]["propertyName"]: g["filters"][0]["value"] for g in search["filterGroups"]}
    assert props == {"phone": PHONE, "mobilephone": PHONE}
    patch = api.bodies("PATCH", "/crm/v3/objects/contacts/501")[0]["properties"]
    assert patch["firstname"] == "Dana" and patch["lastname"] == "Miller" and patch["phone"] == PHONE
    note = api.bodies("POST", "/crm/v3/objects/notes")[0]
    assert "AC not cooling" in note["properties"]["hs_note_body"] and isinstance(note["properties"]["hs_timestamp"], int)
    assert note["associations"] == [{"to": {"id": "501"}, "types": [{"associationCategory": "HUBSPOT_DEFINED",
                                                                      "associationTypeId": 202}]}]
    assert all(r.headers["Authorization"] == f"Bearer {TOKEN}" for r in api.requests)
    assert [r.method for r in api.requests] == ["POST", "PATCH", "POST"]  # no deal for a plain lead
    assert [e["type"] for e in store.select("events")] == ["crm.synced"]


def test_hubspot_no_match_creates_the_contact_and_an_email_filter_when_known(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api({("POST", "/crm/v3/objects/contacts/search"): httpx.Response(200, json={"results": []}),
               ("POST", "/crm/v3/objects/contacts"): httpx.Response(201, json={"id": "777"})})
    lead = build_lead(state, t, _convo(state, t, meta={"lead": {"email": "dana@example.com"}}))
    res = _hubspot(store, state, api).sync(t, "lead.created", lead, idem="SM1")
    assert res["status"] == "sent" and res["contact_id"] == "777" and res["created"] is True
    search = api.bodies("POST", "/crm/v3/objects/contacts/search")[0]
    assert [g["filters"][0]["propertyName"] for g in search["filterGroups"]] == ["phone", "mobilephone", "email"]
    created = api.bodies("POST", "/crm/v3/objects/contacts")[0]["properties"]
    assert created["email"] == "dana@example.com" and created["lifecyclestage"] == "lead"
    assert not any(r.method == "PATCH" for r in api.requests)


def test_hubspot_booking_creates_a_deal_associated_to_the_contact(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api({("POST", "/crm/v3/objects/contacts/search"): httpx.Response(200, json={"results": [{"id": "9"}]}),
               ("POST", "/crm/v3/objects/deals"): httpx.Response(201, json={"id": "d1"})})
    payload = _convo(state, t, convo_id="CA1", channel="voice", booking=BOOKING)
    res = _hubspot(store, state, api).sync(t, "booking.created", build_lead(state, t, payload), idem="evt-1")
    assert res["status"] == "sent" and res["deal_id"] == "d1"
    deal = api.bodies("POST", "/crm/v3/objects/deals")[0]
    assert deal["properties"]["dealname"] == "AC repair - Dana Miller"
    assert deal["properties"]["closedate"] == 1_791_896_400_000  # 2026-10-13T08:00-05:00 in ms
    assert deal["associations"][0]["types"][0]["associationTypeId"] == 3 and deal["associations"][0]["to"] == {"id": "9"}


def test_hubspot_401_is_an_auth_failure_with_an_event_row(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api(default=httpx.Response(401, json={"category": "INVALID_AUTHENTICATION"}))
    res = _hubspot(store, state, api).sync(t, "lead.created", build_lead(state, t, _convo(state, t)), idem="SM1")
    assert res == {"status": "failed", "reason": "auth"}
    ev = store.select("events")
    assert [e["type"] for e in ev] == ["crm.auth_failed"] and ev[0]["payload"] == {"provider": "hubspot", "event": "lead.created"}
    assert PHONE not in json.dumps(ev)
    # 403 and 404 are final too; 404 is not an auth problem
    api = Api(default=httpx.Response(404))
    assert _hubspot(store, state, api).sync(t, "lead.created", {"phone": PHONE}, idem="SM2")["reason"] == "http_404"


def test_hubspot_429_and_5xx_and_network_errors_ask_for_a_retry_with_backoff(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    lead = build_lead(state, t, _convo(state, t))
    for attempt, delay in ((0, 2.0), (1, 8.0), (5, 30.0)):
        res = _hubspot(store, state, Api(default=httpx.Response(429))).sync(t, "lead.created", lead, idem="SM1", attempt=attempt)
        assert res == {"status": "retry", "reason": "http_429", "delay": delay}
    assert _hubspot(store, state, Api(default=httpx.Response(503))).sync(t, "lead.created", lead, idem="SM1")["status"] == "retry"
    res = _hubspot(store, state, Api(default=httpx.ConnectError("boom"))).sync(t, "lead.created", lead, idem="SM1")
    assert res["status"] == "retry" and res["reason"] == "ConnectError"
    assert state.get(f"crm:{t.id}:hubspot:lead.created:SM1") is None  # nothing marked as done


def test_hubspot_same_event_never_syncs_twice(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api({("POST", "/crm/v3/objects/contacts/search"): httpx.Response(200, json={"results": []})})
    c = _hubspot(store, state, api)
    lead = build_lead(state, t, _convo(state, t))
    assert c.sync(t, "lead.created", lead, idem="SM1")["status"] == "sent"
    n = len(api.requests)
    assert c.sync(t, "lead.created", lead, idem="SM1") == {"status": "skipped", "reason": "duplicate"}
    assert len(api.requests) == n and state.get(f"crm:{t.id}:hubspot:lead.created:SM1") is True
    assert c.sync(t, "booking.created", lead, idem="SM1")["status"] == "sent"  # another event: fine


def test_hubspot_without_a_credential_is_dead_and_check_reports_it(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api()
    c = _hubspot(store, state, api, token=None)
    assert not c.connected(t.id)
    assert c.sync(t, "lead.created", {"phone": PHONE}, idem="x") == {"status": "dead", "reason": "not_connected"}
    assert c.check(t) == {"ok": False, "status": "dead", "reason": "not_connected"} and api.requests == []


def test_hubspot_check_is_a_read_only_contacts_call(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Api({("GET", "/crm/v3/objects/contacts"): httpx.Response(200, json={"results": []})})
    assert _hubspot(store, state, api).check(t) == {"ok": True, "status": "sent", "provider": "hubspot"}
    assert api.requests[0].method == "GET" and api.requests[0].url.params["limit"] == "1"
    api = Api(default=httpx.Response(401))
    assert _hubspot(store, state, api).check(t) == {"ok": False, "status": "failed", "reason": "auth"}


# --- Jobber ----------------------------------------------------------------------------------------------------
class Gql(Api):
    """Jobber GraphQL: dispatch on the operation name inside the query."""

    def __init__(self, ops: dict, status=200):
        super().__init__()
        self.ops = ops
        self.status = status

    def __call__(self, request):
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"errors": [{"message": "no"}]})
        body = json.loads(request.content)
        head = body["query"].split("{", 1)[0].split()  # ["query", "FindClient($term:", ...] or ["query"]
        op = head[1].split("(")[0] if len(head) > 1 else "account"
        data = self.ops[op]
        return httpx.Response(200, json=data(body["variables"]) if callable(data) else data)

    def variables(self, op):
        return [json.loads(r.content)["variables"] for r in self.requests if op in json.loads(r.content)["query"].split("{", 1)[0]]


def _jobber(store, state, api, token=TOKEN):
    box = CredentialBox(store, SIM_CRED_KEY)
    if token:
        box.save("00000000-0000-4000-8000-000000000001", "jobber", token)
    return JobberClient(box, store, state, http=api.client())


def test_jobber_search_hit_reuses_the_client_then_creates_a_request_and_a_note(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Gql({"FindClient": {"data": {"clients": {"nodes": [{"id": "Q2xpZW50OjE=", "name": "Dana Miller"}]}}},
               "CreateRequest": {"data": {"requestCreate": {"request": {"id": "req-1"}, "userErrors": []}}},
               "NoteClient": {"data": {"clientCreateNote": {"clientNote": {"id": "note-1"}, "userErrors": []}}}})
    payload = _convo(state, t, convo_id="CA1", channel="voice", booking=BOOKING)
    res = _jobber(store, state, api).sync(t, "booking.created", build_lead(state, t, payload), idem="evt-1")
    assert res == {"status": "sent", "client_id": "Q2xpZW50OjE=", "created": False, "request_id": "req-1", "note_id": "note-1"}
    assert api.variables("FindClient") == [{"term": PHONE}]
    req = api.variables("CreateRequest")[0]["input"]
    assert req == {"clientId": "Q2xpZW50OjE=", "title": "AC repair (Tuesday Oct 13, 8 AM to 12 PM)"}
    assert "Booked: Tuesday Oct 13" in api.variables("NoteClient")[0]["input"]["message"]
    for r in api.requests:
        assert r.url == "https://api.getjobber.com/api/graphql" and r.headers["X-JOBBER-GRAPHQL-VERSION"] == "2025-01-20"
        assert r.headers["Authorization"] == f"Bearer {TOKEN}"


def test_jobber_no_match_creates_the_client_with_split_name_phone_and_email(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    api = Gql({"FindClient": {"data": {"clients": {"nodes": []}}},
               "CreateClient": {"data": {"clientCreate": {"client": {"id": "c-new"}, "userErrors": []}}},
               "CreateRequest": {"data": {"requestCreate": {"request": {"id": "req-2"}, "userErrors": []}}},
               "NoteClient": {"data": {"clientCreateNote": {"clientNote": {"id": "n-2"}, "userErrors": []}}}})
    lead = build_lead(state, t, _convo(state, t, meta={"lead": {"email": "dana@example.com"}}))
    res = _jobber(store, state, api).sync(t, "lead.created", lead, idem="SM1")
    assert res["status"] == "sent" and res["created"] is True and res["client_id"] == "c-new"
    inp = api.variables("CreateClient")[0]["input"]
    assert inp["firstName"] == "Dana" and inp["lastName"] == "Miller"
    assert inp["phones"] == [{"number": PHONE, "primary": True, "description": "MAIN"}]
    assert inp["emails"] == [{"address": "dana@example.com", "primary": True, "description": "MAIN"}]
    assert api.variables("CreateRequest")[0]["input"]["title"] == "AC repair"


def test_jobber_user_errors_graphql_errors_and_http_statuses(tmp_path, demo_raw):
    store, state, t = _setup(tmp_path, demo_raw)
    lead = build_lead(state, t, _convo(state, t))
    api = Gql({"FindClient": {"data": {"clients": {"nodes": []}}},
               "CreateClient": {"data": {"clientCreate": {"client": None, "userErrors": [{"message": "phone invalid", "path": ["phones"]}]}}}})
    assert _jobber(store, state, api).sync(t, "lead.created", lead, idem="a") == {"status": "failed", "reason": "clientCreate_rejected"}
    api = Gql({"FindClient": {"errors": [{"message": "expired", "extensions": {"code": "UNAUTHENTICATED"}}]}})
    assert _jobber(store, state, api).sync(t, "lead.created", lead, idem="b")["reason"] == "auth"
    assert [e["type"] for e in store.select("events")] == ["crm.auth_failed"]
    assert _jobber(store, state, Gql({}, status=429)).sync(t, "lead.created", lead, idem="c")["status"] == "retry"
    assert _jobber(store, state, Gql({}, status=401)).sync(t, "lead.created", lead, idem="d")["reason"] == "auth"
    api = Gql({"account": {"data": {"account": {"id": "A", "name": "Cool Breeze"}}}})
    assert _jobber(store, state, api).check(t) == {"ok": True, "status": "sent", "provider": "jobber", "account": "Cool Breeze"}


# --- hooks + queue ---------------------------------------------------------------------------------------------
def _hooked(tmp_path, demo_raw, **crm):
    store, state, t = _setup(tmp_path, demo_raw, **crm)
    hooks_b56.queue_for(store, state, autostart=False)
    return store, state, t


def test_emit_enqueues_a_crm_job_only_for_enabled_links_subscribed_to_the_event(tmp_path, demo_raw):
    store, state, t = _hooked(tmp_path, demo_raw)
    hooks_b56.emit(store, state, t, "lead.created", {"channel": "sms", "convo_id": "SM1", "contact": PHONE}, "SM1")
    assert hooks_b56.queue_for(store, state).pending() == []  # crm off by default, no zapier either
    store, state, t = _hooked(tmp_path / "b", demo_raw, hubspot={"enabled": True, "events": ["booking.created"]},
                              jobber={"enabled": True})
    assert links_for(t, "lead.created") == ["jobber"] and links_for(t, "booking.created") == ["hubspot", "jobber"]
    hooks_b56.emit(store, state, t, "lead.created", {"channel": "sms", "convo_id": "SM1", "contact": PHONE}, "SM1")
    jobs = hooks_b56.queue_for(store, state).pending()
    assert [(j["kind"], j["payload"]["provider"], j["payload"]["event"], j["payload"]["key"]) for j in jobs] == [
        ("crm", "jobber", "lead.created", "SM1")]
    hooks_b56.emit(store, state, t, "booking.created", {"channel": "sms", "convo_id": "SM1", "contact": PHONE}, "evt-1")
    assert sorted(j["payload"]["provider"] for j in hooks_b56.queue_for(store, state).pending()) == ["hubspot", "jobber", "jobber"]
    assert hooks_b56.emit(store, state, t, "call.completed", {}, "CA9") is None  # not a CRM event: no job


def test_queue_handler_syncs_end_to_end_and_marks_the_job_done(tmp_path, demo_raw):
    store, state, t = _hooked(tmp_path, demo_raw, hubspot={"enabled": True})
    api = Api({("POST", "/crm/v3/objects/contacts/search"): httpx.Response(200, json={"results": []}),
               ("POST", "/crm/v3/objects/contacts"): httpx.Response(201, json={"id": "42"})})
    hooks_b56._crm[store] = {"hubspot": _hubspot(store, state, api)}
    payload = _convo(state, t)
    hooks_b56.emit(store, state, t, "lead.created", payload, "SM1")
    out = hooks_b56.queue_for(store, state).drain()
    assert [(o["kind"], o["result"]) for o in out] == [("crm", "done")]
    assert [r.url.path for r in api.requests] == ["/crm/v3/objects/contacts/search", "/crm/v3/objects/contacts",
                                                  "/crm/v3/objects/notes"]
    assert hooks_b56.queue_for(store, state).pending() == []
    assert "crm.synced" in [e["type"] for e in store.select("events")]
    # a second emit with the same key: the job runs but the client skips it (no new API call)
    hooks_b56.emit(store, state, t, "lead.created", payload, "SM1")
    assert hooks_b56.queue_for(store, state).drain()[0]["result"] == "done" and len(api.requests) == 3


def test_queue_handler_retries_with_the_client_delay_then_dead_letters(tmp_path, demo_raw):
    store, state, t = _hooked(tmp_path, demo_raw, hubspot={"enabled": True})
    api = Api(default=httpx.Response(503))
    hooks_b56._crm[store] = {"hubspot": _hubspot(store, state, api)}
    hooks_b56.emit(store, state, t, "lead.created", _convo(state, t), "SM1")
    q = hooks_b56.queue_for(store, state)
    now = q.pending()[0]["next_at"]  # the job is due the moment it was enqueued
    assert q.drain(now)[0]["result"] == "retry"
    job = q.pending()[0]
    assert job["attempt"] == 1 and job["next_at"] == now + 2.0
    assert q.drain(now + 1) == [] and q.drain(now + 2)[0]["result"] == "retry"
    assert q.pending()[0]["next_at"] == now + 2 + 8.0
    q.drain(now + 10)
    out = q.drain(now + 41)
    assert out[0]["result"] == "dead" and q.pending() == []
    assert "delivery.dead" in [e["type"] for e in store.select("events")]


def test_queue_handler_without_a_credential_dead_letters_and_notes_not_connected_once(tmp_path, demo_raw):
    store, state, t = _hooked(tmp_path, demo_raw, jobber={"enabled": True})
    api = Gql({})
    hooks_b56._crm[store] = {"jobber": _jobber(store, state, api, token=None)}
    for key in ("SM1", "SM2"):
        hooks_b56.emit(store, state, t, "lead.created", _convo(state, t, convo_id=key), key)
    out = hooks_b56.queue_for(store, state).drain()
    assert [o["result"] for o in out] == ["dead", "dead"] and api.requests == []
    types = [e["type"] for e in store.select("events")]
    assert types.count("crm.not_connected") == 1 and types.count("delivery.dead") == 2


def test_hubspot_auth_failure_in_the_queue_is_final(tmp_path, demo_raw):
    store, state, t = _hooked(tmp_path, demo_raw, hubspot={"enabled": True})
    api = Api(default=httpx.Response(403))
    hooks_b56._crm[store] = {"hubspot": _hubspot(store, state, api)}
    hooks_b56.emit(store, state, t, "lead.created", _convo(state, t), "SM1")
    assert hooks_b56.queue_for(store, state).drain()[0]["result"] == "dead" and len(api.requests) == 1
    assert "crm.auth_failed" in [e["type"] for e in store.select("events")]


def test_crm_for_builds_real_clients_from_settings(tmp_path, demo_raw):
    store, state, t = _hooked(tmp_path, demo_raw)
    c = hooks_b56.crm_for(store, state, "hubspot")
    assert isinstance(c, HubSpotClient) and hooks_b56.crm_for(store, state, "hubspot") is c
    assert isinstance(hooks_b56.crm_for(store, state, "jobber"), JobberClient)
    with pytest.raises(CrmError):
        make_client("salesforce", c.box, store, state)


# --- admin endpoints -------------------------------------------------------------------------------------------
def _app(tmp_path, demo_raw, api: Api, **crm):
    raw = json.loads(json.dumps(demo_raw))
    if crm:
        raw["config"]["crm"] = crm
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(raw))
    app = create_app(settings, store)
    app.include_router(router)
    app.state.b56 = build_services(settings, store, StateStore(store), env={}, http=api.client())
    return TestClient(app), store, tenant, {"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}


def test_admin_crm_endpoints_require_the_token_and_a_known_tenant_and_provider(tmp_path, demo_raw):
    client, store, t, auth = _app(tmp_path, demo_raw, Api())
    assert client.get("/crm/demo-hvac").status_code == 401
    assert client.put("/crm/demo-hvac/hubspot", json={"token": TOKEN}).status_code == 401
    assert client.delete("/crm/demo-hvac/hubspot").status_code == 401
    assert client.post("/crm/demo-hvac/hubspot/test").status_code == 401
    assert client.get("/crm/nope", headers=auth).status_code == 404
    assert client.put("/crm/demo-hvac/salesforce", headers=auth, json={"token": TOKEN}).status_code == 404
    assert client.put("/crm/demo-hvac/hubspot", headers=auth, json={"token": ""}).status_code == 400
    assert client.put("/crm/demo-hvac/hubspot", headers=auth, json={"token": "has space"}).status_code == 400
    assert client.put("/crm/demo-hvac/hubspot", headers=auth, content=b"not json").status_code == 400
    assert store.get_credential(t.id, "hubspot") is None


def test_admin_stores_tests_and_deletes_a_credential_without_echoing_it(tmp_path, demo_raw):
    api = Api({("GET", "/crm/v3/objects/contacts"): httpx.Response(200, json={"results": []})})
    client, store, t, auth = _app(tmp_path, demo_raw, api, hubspot={"enabled": True})
    assert client.get("/crm/demo-hvac", headers=auth).json() == {"hubspot": {"connected": False, "enabled": True},
                                                                  "jobber": {"connected": False, "enabled": False}}
    r = client.put("/crm/demo-hvac/hubspot", headers=auth, json={"token": TOKEN})
    assert r.status_code == 200 and r.json() == {"ok": True, "provider": "hubspot"} and TOKEN not in r.text
    cipher = store.get_credential(t.id, "hubspot")
    assert cipher and TOKEN not in cipher and TOKEN not in (tmp_path / "events.json").read_text()
    assert client.get("/crm/demo-hvac", headers=auth).json()["hubspot"] == {"connected": True, "enabled": True}
    r = client.post("/crm/demo-hvac/hubspot/test", headers=auth)
    assert r.status_code == 200 and r.json() == {"ok": True, "status": "sent", "provider": "hubspot"}
    assert api.requests[-1].headers["Authorization"] == f"Bearer {TOKEN}" and api.requests[-1].method == "GET"
    assert client.delete("/crm/demo-hvac/hubspot", headers=auth).json() == {"ok": True, "provider": "hubspot"}
    assert client.get("/crm/demo-hvac", headers=auth).json()["hubspot"]["connected"] is False
    r = client.post("/crm/demo-hvac/hubspot/test", headers=auth)
    assert r.status_code == 502 and r.json()["reason"] == "not_connected"
    types = [e["type"] for e in store.select("events")]
    assert types == ["crm.connected", "crm.disconnected"]


def test_admin_test_reports_a_bad_jobber_token(tmp_path, demo_raw):
    client, store, t, auth = _app(tmp_path, demo_raw, Gql({}, status=401))
    assert client.put("/crm/demo-hvac/jobber", headers=auth, json={"token": TOKEN}).status_code == 200
    r = client.post("/crm/demo-hvac/jobber/test", headers=auth)
    assert r.status_code == 502 and r.json() == {"ok": False, "status": "failed", "reason": "auth"}
