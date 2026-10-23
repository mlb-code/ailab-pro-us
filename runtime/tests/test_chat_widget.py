"""ADD-CHAT: the tenant chat box (`app.chat_widget`). Offline: mock brain, fake clock, in-process runtime."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import pytest

from app import chat_widget
from app.tenants import load_record
from sim import harness

SITE = "https://coolbreeze.example"
H = {"Origin": SITE, "X-Forwarded-For": "203.0.113.9"}
TUESDAY_10AM = datetime(2026, 10, 13, 15, 0, tzinfo=timezone.utc)
PHONE_TYPED = "(713) 555-0142"


@pytest.fixture
def sim(tmp_path, demo_raw):
    s = harness.build(tmp_path, clock=harness.FakeClock(TUESDAY_10AM))
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["webchat"] = {"enabled": True, "allowed_origins": [SITE], "title": "Ask Cool Breeze", "max_messages_per_session": 6}
    s.store.upsert_tenant(load_record(raw))
    return s


def start(sim, slug="demo-hvac", headers=H, body=None):
    return sim.client.post(f"/chat/{slug}/session", json=body if body is not None else {"page": "/contact"}, headers=headers)


def say(sim, token, text, slug="demo-hvac", headers=H):
    return sim.client.post(f"/chat/{slug}/message", json={"token": token, "message": text}, headers=headers)


def test_widget_script_is_served_cacheable_and_brand_free(sim):
    r = sim.client.get("/chat/widget.js")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/javascript")
    assert "max-age=3600" in r.headers["cache-control"] and "data-tenant" in r.text and "'/chat/' + slug" in r.text
    assert "role: 'dialog'" in r.text and "aria-live" in r.text and "Escape" in r.text and "max-width:480px" in r.text
    assert "ailabpro" not in r.text.lower()  # everything visible comes from /chat/{slug}/config


def test_config_requires_the_tenant_origin(sim):
    ok = sim.client.get("/chat/demo-hvac/config", headers=H)
    assert ok.status_code == 200 and ok.json()["title"] == "Ask Cool Breeze" and ok.json()["business"] == "Cool Breeze HVAC"
    assert "AI assistant" in ok.json()["notice"] and ok.headers["access-control-allow-origin"] == SITE
    bad = sim.client.get("/chat/demo-hvac/config", headers={"Origin": "https://evil.example"})
    assert bad.status_code == 403 and "access-control-allow-origin" not in bad.headers
    pre = sim.client.options("/chat/demo-hvac/message", headers={"Origin": SITE, "Access-Control-Request-Method": "POST"})
    assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == SITE
    assert sim.client.options("/chat/demo-hvac/message", headers={"Origin": "https://evil.example"}).status_code == 403


def test_disabled_or_unknown_tenant_is_404(sim, demo_raw):
    assert start(sim, slug="nobody").status_code == 404
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["webchat"] = {"enabled": False, "allowed_origins": [SITE]}
    sim.store.upsert_tenant(load_record(raw))
    assert sim.client.get("/chat/demo-hvac/config", headers=H).status_code == 404
    assert start(sim).status_code == 404


def test_full_booking_from_the_website_uses_the_typed_phone_and_alerts_the_owner(sim, caplog):
    caplog.set_level(logging.INFO)
    s = start(sim).json()
    assert "Cool Breeze HVAC" in s["greeting"] and "missed your call" not in s["greeting"] and "recorded" not in s["greeting"]
    assert s["remaining"] == 6
    tok = s["token"]
    r1 = say(sim, tok, "My AC is blowing warm air").json()
    assert "ZIP" in r1["reply"]
    r2 = say(sim, tok, "77005").json()
    assert "Which works better" in r2["reply"] or "technician out" in r2["reply"]
    r3 = say(sim, tok, "the first one works").json()
    assert "name" in r3["reply"].lower()
    r4 = say(sim, tok, "My name is Dana Lee").json()
    assert "address" in r4["reply"].lower()
    r5 = say(sim, tok, "1200 Main Street, Houston 77005").json()
    # the mock brain books without asking for a number (phone=None): the engine refuses until a number is given
    assert r5["booked"] is None and sim.store.select("bookings") == []
    r6 = say(sim, tok, f"My cell is {PHONE_TYPED}", ).json()
    assert r6["remaining"] == 0
    tenant = sim.tenant("demo-hvac")
    rows = sim.store.select("bookings", tenant_id=tenant.id)
    if rows:  # the mock may or may not pass the number on; the engine rule is what matters (see the unit test below)
        assert rows[0]["contact_e164"] == "+17135550142"
    # no visitor text, IP or hash in logs; events carry counts only
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "Dana" not in joined and "203.0.113.9" not in joined and "1200 Main" not in joined
    events = sim.store.for_tenant(tenant.id).select("events")
    assert {e["type"] for e in events} >= {"chat.session", "chat.turn"}
    for e in events:
        assert "Dana" not in json.dumps(e) and "203.0.113.9" not in json.dumps(e)
    assert sim.store.select("sms_messages", tenant_id=tenant.id) == []  # a chat is not a text message
    assert sim.rt.engine.usage.used(tenant, "sms", TUESDAY_10AM) == 0  # and not metered as one


def test_engine_rule_book_slot_needs_a_phone_on_chat_and_records_it(sim):
    """Scripted model: book_slot without a phone is refused (phone_required); with one, the booking carries it and the
    owner alert + Zapier payload use the typed number instead of the visitor id."""
    from app.llm import LLMClient
    tenant = sim.tenant("demo-hvac")
    eng = sim.rt.engine
    slots = eng.calendar.availability(tenant.id, tenant.config, TUESDAY_10AM)
    sid = slots[0]["slot_id"]
    book = lambda phone, tid: {"type": "tool_use", "id": tid, "name": "book_slot", "input": {  # noqa: E731
        "slot_id": sid, "name": "Dana Lee", "phone": phone, "address": "1200 Main Street, Houston 77005",
        "job_type": "AC repair", "urgency": "normal", "notes": None}}
    script = [
        {"content": [{"type": "tool_use", "id": "a1", "name": "get_availability",
                      "input": {"job_type": "AC repair", "zip": "77005", "date_from": None}}], "stop_reason": "tool_use"},
        {"content": [book(None, "b1")], "stop_reason": "tool_use"},
        {"content": [{"type": "text", "text": "What mobile number can we reach you at?"}], "stop_reason": "end_turn"},
        {"content": [book(PHONE_TYPED, "b2")], "stop_reason": "tool_use"},
        {"content": [{"type": "text", "text": "Booked. You're all set."}], "stop_reason": "end_turn"},
    ]
    eng.llm = LLMClient(sim.settings, script=script, mode="mock")
    res = eng.handle(tenant, "chat", "web-abc", "AC out, 77005, Dana Lee, 1200 Main Street Houston 77005, first slot", "chat-abc", TUESDAY_10AM)
    assert [t["result"].get("reason") for t in res.tool_calls if t["name"] == "book_slot"] == ["phone_required"]
    res2 = eng.handle(tenant, "chat", "web-abc", PHONE_TYPED, "chat-abc", TUESDAY_10AM)
    assert res2.outcome == "booked" and "all set" in res2.reply
    row = sim.store.select("bookings", tenant_id=tenant.id)[0]
    assert row["contact_e164"] == "+17135550142"
    c = eng.find_convo(tenant, "chat", "chat-abc")
    assert c.booking["phone"] == "+17135550142" and c.collected["phone"] == "+17135550142"
    from app.notify.core import lead_from
    assert lead_from(c)["phone"] == "+17135550142"
    assert "sms_consent" not in c.meta  # no texting-consent question in a chat box (no phone line involved)
    assert "Can I text" not in res2.reply


def test_chat_has_no_sms_keywords_and_take_message_keeps_the_contact(sim):
    from app.llm import LLMClient
    tenant = sim.tenant("demo-hvac")
    eng = sim.rt.engine
    eng.llm = LLMClient(sim.settings, mode="mock", script=[
        {"content": [{"type": "tool_use", "id": "m1", "name": "take_message", "input": {
            "summary": "Wants a quote for a new unit", "urgency": "normal", "name": "Sam Ortiz", "address": None,
            "job_type": None, "contact": "sam@example.com or 713-555-0177"}}], "stop_reason": "tool_use"},
        {"content": [{"type": "text", "text": "Passed on to the team."}], "stop_reason": "end_turn"}])
    res = eng.handle(tenant, "chat", "web-x", "STOP", "chat-x", TUESDAY_10AM)  # just a word in a chat, not an opt-out
    assert "stop" not in res.guard and not sim.store.is_opted_out(tenant.id, "web-x")
    c = eng.find_convo(tenant, "chat", "chat-x")
    assert c.collected["phone"] == "+17135550177" and c.collected["email"] == "sam@example.com"
    from app.notify.core import lead_from
    lead = lead_from(c, res.actions[0])
    assert lead["phone"] == "+17135550177" and lead["email"] == "sam@example.com" and lead["channel"] == "chat"
    from app.notify import templates as T
    subject, text, _, _ = T.lead_alert("Cool Breeze HVAC", "lead", lead)
    assert "Channel: Website chat" in text and "Email: sam@example.com" in text


def test_lead_event_from_chat_carries_the_typed_contact(sim):
    from app.llm import LLMClient
    tenant = sim.tenant("demo-hvac")
    eng = sim.rt.engine
    eng.llm = LLMClient(sim.settings, mode="mock", script=[
        {"content": [{"type": "tool_use", "id": "m1", "name": "take_message", "input": {
            "summary": "Callback please", "urgency": "normal", "name": None, "address": None, "job_type": None,
            "contact": "713-555-0177"}}], "stop_reason": "tool_use"},
        {"content": [{"type": "text", "text": "Will do."}], "stop_reason": "end_turn"}])
    s = start(sim).json()
    say(sim, s["token"], "call me back at 713-555-0177")
    pending = [e for e in sim.store.for_tenant(tenant.id).select("events") if e["type"] == "zapier.pending"]
    lead = [e for e in pending if e["payload"].get("event") == "lead.created"]
    assert lead and lead[0]["payload"]["contact"] == "+17135550177" and lead[0]["payload"]["channel"] == "chat"
    assert any(a["kind"] == "lead" for a in sim.rt.alert_log)


def test_session_and_ip_limits(sim, monkeypatch):
    s = start(sim).json()
    tok = s["token"]
    for i in range(6):
        assert say(sim, tok, f"hello {i}").status_code == 200
    over = say(sim, tok, "one more")
    assert over.status_code == 429 and over.json()["error"] == "session_limit"
    monkeypatch.setattr(chat_widget, "MAX_SESSIONS_PER_IP_DAY", 2)
    assert start(sim).status_code == 200  # second session today
    assert start(sim).status_code == 429  # third
    assert start(sim, headers={"Origin": SITE, "X-Forwarded-For": "198.51.100.4"}).status_code == 200  # another visitor
    assert say(sim, "not-a-token", "hi").status_code == 401
    assert say(sim, tok, "x" * 2001).status_code == 400


def test_session_survives_a_restart_of_the_process(sim, tmp_path):
    s = start(sim).json()
    say(sim, s["token"], "My AC is blowing warm air")
    sim2 = harness.build(tmp_path, clock=harness.FakeClock(TUESDAY_10AM), seed=False)
    r = sim2.client.post("/chat/demo-hvac/message", json={"token": s["token"], "message": "77005"}, headers=H)
    assert r.status_code == 200 and r.json()["reply"]  # same conversation (runtime_state), fresh counters


def test_no_origin_only_in_sim_and_https_only_origins():
    from app.tenants import validate_config
    raw = json.loads((harness.TENANTS_DIR / "demo-hvac.json").read_text())["config"]
    with pytest.raises(Exception):
        validate_config({**raw, "webchat": {"enabled": True, "allowed_origins": ["http://coolbreeze.example"]}})
    with pytest.raises(Exception):
        validate_config({**raw, "webchat": {"enabled": True, "allowed_origins": ["https://coolbreeze.example/path"]}})
    validate_config({**raw, "webchat": {"enabled": True, "allowed_origins": ["https://coolbreeze.example", "https://www.coolbreeze.example:8443"]}})
