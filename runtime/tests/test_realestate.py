"""Real-estate Lead Assistant: niche prompt + qualify_lead tool, screening order from config, fair-housing guard,
greeting, owner alert / Zapier payload with the screening answers, direct Follow Up Boss events (mock transport)."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from app import brain, guard
from app.conversation import Engine
from app.crm import FollowUpBossClient, CredentialBox, links_for, make_client
from app.crm.follow_up_boss import event_payload
from app.llm import LLMClient
from app.notify import templates as T
from app.notify.core import lead_from
from app.settings import SIM_CRED_KEY
from app.sms_outbound import after_turn
from app.store import JsonStore, StateStore
from app.tenants import TenantConfigError, load_file, load_record, validate_config
from app.voice import greeting
from sim import harness
from sim.fake_calendar import FakeCalendar

MON_10 = datetime(2026, 10, 12, 10, 0, tzinfo=ZoneInfo("America/Chicago"))
RAW = json.loads((harness.TENANTS_DIR / "demo-realty.json").read_text())
CFG = load_file(harness.TENANTS_DIR / "demo-realty.json").config


def tenant_with(**patch):
    raw = json.loads(json.dumps(RAW))
    for k, v in patch.items():
        raw["config"][k] = {**raw["config"].get(k, {}), **v} if isinstance(v, dict) else v
    return load_record(raw)


def engine(tmp_path, record, script=None):
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(record)
    llm = LLMClient(settings, script=script, mode="mock")
    return Engine(store, llm, FakeCalendar(), settings), tenant, store


def tool(name, inp, tid="t1"):
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def resp(*blocks):
    return {"content": list(blocks), "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"}


# --- prompt + tools --------------------------------------------------------------------------------------------
def test_prompt_is_the_lead_assistant_with_the_configured_screening_order():
    for channel in ("sms", "voice", "chat"):
        p = brain.system_prompt(CFG, channel)
        assert "lead assistant" in p and "Jenna Harper at Maple & Main Realty" in p and brain.LEAD_MARKER in p
        assert "Fair housing" in p and "familial status" in p and "never steer" in p
        assert p.index("buying, selling or renting") < p.index("timeline") < p.index("working with an agent")
        assert "renters: do not screen further" in p  # renters off for this tenant
    assert "qualify_lead" in [t["name"] for t in brain.tools(CFG, "sms")]
    assert "qualify_lead" not in [t["name"] for t in brain.tools(load_file(harness.TENANTS_DIR / "demo-hvac.json").config, "sms")]
    assert "lead assistant" not in brain.system_prompt(load_file(harness.TENANTS_DIR / "demo-hvac.json").config, "sms")


def test_screening_order_and_subset_come_from_config():
    rec = tenant_with(real_estate={"screening": ["has_agent", "intent", "area"], "renters": True})
    p = brain.system_prompt(rec.config, "sms")
    assert p.index("working with an agent") < p.index("buying, selling or renting") < p.index("area, neighborhood")
    assert "timeline" not in p.split(brain.LEAD_MARKER, 1)[1].split("## How", 1)[0]
    assert "renters: do not screen" not in p


def test_meeting_types_from_config_or_by_name():
    m = brain.meeting_types(CFG)
    assert m == {"showing": "Home showing", "buyer": "Buyer consultation", "seller": "Listing consultation",
                 "renter": "Rental consultation"}
    rec = tenant_with(real_estate={"meetings": {}}, booking={**RAW["config"]["booking"], "job_types": ["Call with Jenna", "Showing"]})
    m2 = brain.meeting_types(rec.config)
    assert m2["showing"] == "Showing" and m2["buyer"] == "Call with Jenna" and m2["seller"] == "Call with Jenna"


def test_meetings_must_be_job_types_and_screening_unique():
    with pytest.raises(TenantConfigError, match="real_estate.meetings"):
        validate_config({**RAW["config"], "real_estate": {**RAW["config"]["real_estate"], "meetings": {"buyer": "Tea party"}}})
    with pytest.raises(TenantConfigError, match="at most once"):
        validate_config({**RAW["config"], "real_estate": {**RAW["config"]["real_estate"], "screening": ["intent", "intent"]}})


# --- executor: qualify_lead ------------------------------------------------------------------------------------
def test_qualify_lead_is_remembered_and_steers_to_the_right_meeting(tmp_path):
    eng, tenant, store = engine(tmp_path, tenant_with(), script=[
        resp(tool("qualify_lead", {"intent": "buyer", "area": "East Austin", "timeline": "3 months", "price_range": "500k",
                                   "pre_approval": "pre_approved", "property_address": None, "motivation": None,
                                   "has_agent": "no", "name": "Chris Kim", "email": "chris@example.com"})),
        resp({"type": "text", "text": "Thanks Chris. Let me check the calendar."})])
    res = eng.handle(tenant, "sms", "+15125550182", "hi", "s1", MON_10)
    out = res.tool_calls[0]["result"]
    assert out["ok"] and out["meeting_type"] == "Buyer consultation" and "note" not in out
    c = eng.find_convo(tenant, "sms", "s1")
    assert c.meta["lead"]["intent"] == "buyer" and c.meta["lead"]["has_agent"] == "no" and c.collected["name"] == "Chris Kim"
    assert "property_address" not in c.meta["lead"]  # null answers are not stored


@pytest.mark.parametrize("args, note", [
    ({"intent": "renter"}, "renters are not screened"),
    ({"intent": "buyer", "has_agent": "yes"}, "already working with an agent"),
])
def test_qualify_lead_notes_when_the_agent_does_not_want_the_lead_booked(tmp_path, args, note):
    eng, tenant, _ = engine(tmp_path, tenant_with(), script=[resp(tool("qualify_lead", args)), resp({"type": "text", "text": "Ok."})])
    res = eng.handle(tenant, "sms", "+15125550182", "hi", "s1", MON_10)
    assert note in res.tool_calls[0]["result"]["note"]


def test_renters_on_gets_a_rental_meeting(tmp_path):
    eng, tenant, _ = engine(tmp_path, tenant_with(real_estate={"renters": True}),
                            script=[resp(tool("qualify_lead", {"intent": "renter"})), resp({"type": "text", "text": "Ok."})])
    res = eng.handle(tenant, "sms", "+15125550182", "hi", "s1", MON_10)
    assert res.tool_calls[0]["result"]["meeting_type"] == "Rental consultation"


# --- fair housing guard ----------------------------------------------------------------------------------------
@pytest.mark.parametrize("text", [
    "Mueller is great for families with kids and has good schools.",
    "That part of town is mostly Hispanic.",
    "It's a safe neighborhood, you'd fit right in.",
    "No kids allowed in that building, but it's perfect for singles.",
])
def test_fair_housing_guard_blocks_steering_for_real_estate(text):
    out = guard.check_reply(text, CFG, "sms")
    assert "fair_housing" in out.violations and out.text == guard.FAIR_HOUSING_TEXT


def test_fair_housing_guard_lets_facts_through_and_ignores_home_services():
    ok = guard.check_reply("1420 Oak Ridge Dr is still active. Jenna can show it Saturday at 10.", CFG, "sms")
    assert not ok.violations
    hvac = load_file(harness.TENANTS_DIR / "demo-hvac.json").config
    assert "fair_housing" not in guard.check_reply("We're a family business and service the whole area for families with kids.", hvac, "sms").violations


# --- greeting ----------------------------------------------------------------------------------------------------
def test_greeting_names_the_agent_and_keeps_the_notice():
    g = greeting(tenant_with())
    assert g.startswith("Hi, this is Jenna Harper's virtual assistant at Maple & Main Realty, an AI. Sorry Jenna missed you!")
    assert guard.DISCLOSURE in g
    g2 = greeting(tenant_with(real_estate={"agent_name": ""}))
    assert "the virtual assistant for Maple & Main Realty" in g2 and "Sorry we missed your call" in g2


# --- owner alert + Zapier payload ---------------------------------------------------------------------------------
def test_lead_alert_and_zapier_payload_carry_the_screening_answers(tmp_path):
    eng, tenant, store = engine(tmp_path, tenant_with(), script=[
        resp(tool("qualify_lead", {"intent": "seller", "area": "Mueller", "timeline": "later this year", "motivation": "relocating",
                                   "property_address": "4512 Berkman Dr, Austin 78723", "has_agent": "no", "name": "Linda Torres"})),
        resp(tool("take_message", {"summary": "Seller in Mueller, wants a listing consult", "urgency": "normal", "name": "Linda Torres",
                                   "address": "4512 Berkman Dr, Austin 78723", "job_type": "Listing consultation"}, "t2")),
        resp({"type": "text", "text": "Passed to Jenna."})])
    res = eng.handle(tenant, "sms", "+15125550183", "selling", "s2", MON_10)
    c = eng.find_convo(tenant, "sms", "s2")
    lead = lead_from(c, res.actions[0])
    assert lead["qualification"] == {"intent": "seller", "area": "Mueller", "timeline": "later this year", "motivation": "relocating",
                                     "property_address": "4512 Berkman Dr, Austin 78723", "has_agent": "no"}
    subject, text, html, sms = T.lead_alert("Maple & Main Realty", "lead", lead)
    assert subject.startswith("New lead: Seller · Listing consultation · Linda Torres")
    assert "Lead type: seller" in text and "Property address: 4512 Berkman Dr" in text and "Working with an agent: no" in text
    assert "(Mueller, later this year, no)" in sms
    emitted = []
    rt = type("RT", (), {"emit": lambda self, t, ev, data, key: emitted.append((ev, data)), "engine": eng, "outbound": None,
                         "store": store, "settings": eng.settings})()
    after_turn(rt, tenant, c, MON_10)
    ev, data = emitted[0]
    assert ev == "lead.created" and data["qualification"]["intent"] == "seller" and data["name"] == "Linda Torres"
    assert data["contact"] == "+15125550183" and data["address"] == "4512 Berkman Dr, Austin 78723"


def test_home_services_alert_unchanged_without_qualification():
    lead = {"name": "Dana", "phone": "+17135550123", "job_type": "AC repair", "summary": "AC out", "channel": "voice"}
    subject, text, _, sms = T.lead_alert("Cool Breeze HVAC", "lead", lead)
    assert subject == "New lead: AC repair · Dana · -" and "Lead type" not in text and "(" not in sms.split("Details")[0]


# --- Follow Up Boss direct ----------------------------------------------------------------------------------------
LEAD = {"name": "Chris Kim", "phone": "+15125550182", "email": "chris@example.com", "address": "", "job_type": "Buyer consultation",
        "urgency": "normal", "summary": "Buyer, East Austin, pre-approved", "channel": "voice", "convo_id": "CA1",
        "booking": {"start": "2026-10-12T13:00:00-05:00", "end": "2026-10-12T15:00:00-05:00", "label": "Monday Oct 12, 1 PM to 3 PM"},
        "qualification": {"intent": "buyer", "area": "East Austin", "timeline": "next 3 months", "price_range": "450k to 700k",
                          "pre_approval": "pre_approved", "has_agent": "no"}}


def test_fub_event_payload_is_documented_shape():
    body = event_payload(tenant_with(real_estate={"follow_up_boss": {"enabled": True, "source": "Sign calls", "assigned_to": "jenna@example.com"}}),
                         "lead.created", LEAD)
    assert body["source"] == "Sign calls" and body["type"] == "Property Inquiry" and body["system"]
    p = body["person"]
    assert p["firstName"] == "Chris" and p["lastName"] == "Kim" and p["phones"] == [{"value": "+15125550182", "type": "mobile"}]
    assert p["emails"] == [{"value": "chris@example.com"}] and "buyer" in p["tags"] and p["assignedTo"] == "jenna@example.com"
    assert p["price"] == "450k to 700k" and "Pre approval: pre_approved" in body["description"] and "Booked: Monday Oct 12" in body["description"]
    seller = event_payload(tenant_with(), "lead.created", {**LEAD, "qualification": {"intent": "seller", "property_address": "4512 Berkman Dr"}})
    assert seller["type"] == "Seller Inquiry" and seller["property"] == {"street": "4512 Berkman Dr"} and "assignedTo" not in seller["person"]


def test_fub_client_posts_events_with_basic_auth_and_is_exactly_once(tmp_path):
    store, state = JsonStore(tmp_path), None
    state = StateStore(store, memory_fallback=True)
    tenant = store.upsert_tenant(tenant_with(real_estate={"follow_up_boss": {"enabled": True}}))
    seen = []

    def api(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/me":
            return httpx.Response(200, json={"name": "Jenna Harper"})
        return httpx.Response(201, json={"id": 991, "person": {"id": 42}})

    box = CredentialBox(store, SIM_CRED_KEY)
    box.save(tenant.id, "follow_up_boss", "fub-api-key-not-real")
    client = make_client("follow_up_boss", box, store, state, http=httpx.Client(transport=httpx.MockTransport(api)))
    assert isinstance(client, FollowUpBossClient)
    res = client.sync(tenant, "lead.created", LEAD, idem="CA1")
    assert res == {"status": "sent", "event_id": 991, "person_id": 42}
    req = seen[0]
    assert req.url == "https://api.followupboss.com/v1/events" and req.headers["Authorization"].startswith("Basic ")
    assert "fub-api-key-not-real" not in req.headers["Authorization"] and json.loads(req.content)["person"]["firstName"] == "Chris"
    assert client.sync(tenant, "lead.created", LEAD, idem="CA1") == {"status": "skipped", "reason": "duplicate"}
    assert client.check(tenant)["account"] == "Jenna Harper"
    assert "fub-api-key-not-real" not in " ".join(p.read_text() for p in tmp_path.glob("*.json"))


def test_fub_link_enqueues_only_for_real_estate_tenants_with_the_flag():
    assert links_for(tenant_with(real_estate={"follow_up_boss": {"enabled": True}}), "lead.created") == ["follow_up_boss"]
    assert links_for(tenant_with(), "lead.created") == []
    assert links_for(tenant_with(real_estate={"follow_up_boss": {"enabled": True}}), "call.completed") == []
    hvac = json.loads((harness.TENANTS_DIR / "demo-hvac.json").read_text())
    hvac["config"]["real_estate"] = {"follow_up_boss": {"enabled": True}}
    assert links_for(load_record(hvac), "lead.created") == []  # not a real-estate tenant
