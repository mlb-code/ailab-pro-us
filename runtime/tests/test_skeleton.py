"""B1 acceptance: skeleton, settings, signature validation, tenant config, store, crypto, sim core."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import jsonschema
import pytest
from fastapi.testclient import TestClient

from app import crypto, settings as settings_mod
from app.main import create_app
from app.store import JsonStore, StoreError, SupabaseStore
from app.tenants import TenantConfigError, json_schema, load_record, validate_config, SCHEMA_PATH
from sim import harness
from sim.__main__ import main as sim_main
from sim.fake_calendar import FakeCalendar
from sim.fake_twilio import FakeTwilio, FakeTwilioClient, parse_twiml
from sim.replay import ReplayMissing, ReplayStore, request_key

TZ = ZoneInfo("America/Chicago")


# --- settings ------------------------------------------------------------------

def test_prod_defaults_fail_closed():
    s = settings_mod.load({})
    assert s.mode == "prod" and s.brain_mode == "live"
    assert s.twilio_auth_token == "" and s.cred_key == ""


def test_sim_defaults():
    s = settings_mod.load({"RUNTIME_MODE": "sim"})
    assert s.is_sim and s.brain_mode == "mock" and s.twilio_auth_token and s.cred_key
    assert settings_mod.load({"RUNTIME_MODE": "sim", "CLAUDE_MODE": "replay"}).brain_mode == "replay"


@pytest.mark.parametrize("env", [{"RUNTIME_MODE": "dev"}, {"STORE_BACKEND": "mongo"},
                                 {"BRAIN_MODE": "yolo"}, {"STORE_BACKEND": "supabase"}])
def test_bad_settings_rejected(env):
    with pytest.raises(settings_mod.SettingsError):
        settings_mod.load(env)


def test_model_comes_from_config_default():
    assert settings_mod.load({}).model.startswith("claude-")
    assert settings_mod.load({"CLAUDE_MODEL": "claude-x"}).model == "claude-x"


# --- health + app ------------------------------------------------------------------

def test_health(sim):
    r = sim.client.get("/health")
    body = r.json()
    assert r.status_code == 200 and body["ok"] and body["store"] == "json" and body["brain_mode"] == "mock"
    assert sim.settings.twilio_auth_token not in r.text and sim.settings.cred_key not in r.text


def test_health_503_when_store_down(tmp_path):
    class Down(JsonStore):
        def ping(self):
            raise RuntimeError("down")
    s = harness.sim_settings(tmp_path)
    r = TestClient(create_app(s, Down(tmp_path))).get("/health")
    assert r.status_code == 503 and r.json()["ok"] is False


def test_importing_main_has_no_side_effects():
    import app.main as m
    assert m.app.inner is None


def test_lazy_app_builds_on_first_request(monkeypatch, tmp_path):
    import app.main as m
    monkeypatch.setenv("RUNTIME_MODE", "sim")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    lazy = m._LazyApp()
    assert TestClient(lazy).get("/health").status_code == 200 and lazy.inner is not None


# --- twilio signature ------------------------------------------------------------------

def test_signed_voice_incoming_greets(sim):
    """Production default = streaming (ConversationRelay); greeting + disclosure in welcomeGreeting."""
    t = sim.tenant("demo-hvac")
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    tw = parse_twiml(r.text)
    assert r.status_code == 200 and tw.relay_url.startswith("ws://testserver/voice/relay?t=")
    assert tw.connect_action == "/voice/relay-end"
    assert "Cool Breeze HVAC" in tw.text and "virtual assistant" in tw.text and "transcribed" in tw.text
    assert sim.store.select("events", type="voice.incoming")


def test_signed_voice_incoming_greets_gather_mode(tmp_path):
    sim = harness.build(tmp_path, VOICE_MODE="gather")
    t = sim.tenant("demo-hvac")
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    tw = parse_twiml(r.text)
    assert r.status_code == 200 and tw.gather and tw.gather_action == "/voice/turn"
    assert "Cool Breeze HVAC" in tw.text and "transcribed" in tw.text


def test_custom_greeting(sim, demo_raw):
    """A custom greeting that already has every part of the notice is used as written."""
    from app.voice import DISCLOSURE
    demo_raw["config"]["voice"]["greeting"] = f"Hello from the test line. {DISCLOSURE}"
    t = sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    assert parse_twiml(r.text).text == f"Hello from the test line. {DISCLOSURE}"


@pytest.mark.parametrize("custom", [
    "Hello from the test line. This call may be transcribed.",          # old notice: no providers, no texting
    "Hello! Calls may be recorded for quality.",                        # 'recorded' alone is not enough
    "Hi. This call may be recorded and transcribed by our service providers.",  # texting notice missing
])
def test_custom_greeting_missing_any_part_gets_full_disclosure(sim, demo_raw, custom):
    from app.voice import DISCLOSURE
    demo_raw["config"]["voice"]["greeting"] = custom
    t = sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    assert parse_twiml(r.text).text == f"{custom} {DISCLOSURE}"


def test_unsigned_and_forged_rejected(sim):
    t = sim.tenant("demo-hvac")
    params = sim.twilio.call_params(t.twilio_number, harness.CALLER, "CA1")
    assert sim.twilio.post("/voice/incoming", params, signed=False).status_code == 403
    assert sim.twilio.post("/voice/incoming", params, signature="bm9wZQ==").status_code == 403
    tampered = dict(params, From="+15550000000")
    assert sim.twilio.post("/voice/incoming", tampered, signature=sim.twilio.sign("/voice/incoming", params)).status_code == 403


def test_signature_with_other_token_rejected(sim):
    other = FakeTwilio(sim.client, "another-token")
    assert other.sms("+17135550199", harness.CALLER, "hi").status_code == 403


def test_unprotected_paths_need_no_signature(sim):
    assert sim.client.get("/health").status_code == 200


def test_prod_without_token_is_503(tmp_path):
    s = settings_mod.load({"STORE_BACKEND": "json", "DATA_DIR": str(tmp_path)})
    client = TestClient(create_app(s, JsonStore(tmp_path)))
    assert client.post("/sms/incoming", data={"Body": "hi"}).status_code == 503


def test_public_base_url_is_what_gets_signed(tmp_path):
    env = {"RUNTIME_MODE": "sim", "DATA_DIR": str(tmp_path), "PUBLIC_BASE_URL": "https://rt.example.com"}
    s = settings_mod.load(env)
    store = JsonStore(tmp_path)
    harness.seed_tenants(store)
    client = TestClient(create_app(s, store))
    good = FakeTwilio(client, s.twilio_auth_token, base_url="https://rt.example.com")
    # FakeTwilio posts to the public URL; TestClient routes any host to the app.
    assert good.sms("+17135550199", harness.CALLER, "hi").status_code == 200
    local = FakeTwilio(client, s.twilio_auth_token)  # signs http://testserver/... -> mismatch
    assert local.sms("+17135550199", harness.CALLER, "hi").status_code == 403


def test_signature_with_query_string(sim):
    t = sim.tenant("demo-hvac")
    params = sim.twilio.call_params(t.twilio_number, harness.CALLER, "CA2")
    path = "/voice/incoming?attempt=2"
    r = sim.twilio.post(path, params)
    assert r.status_code == 200


# --- tenant routing -------------------------------------------------------------

def test_unknown_number_not_in_service(sim):
    _, r = sim.twilio.start_call("+19995550000", harness.CALLER)
    tw = parse_twiml(r.text)
    assert "not in service" in tw.text and tw.hangup


def test_paused_tenant_unavailable(sim, demo_raw):
    demo_raw["config"]["paused"] = True
    t = sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    assert "can't take your call" in parse_twiml(r.text).text


def test_invalid_config_in_store_degrades_politely(sim, demo_raw):
    rows = sim.store.select("tenants", slug="demo-hvac")
    sim.store.update("tenants", rows[0]["id"], {"config": {**demo_raw["config"], "hours": {"mon": ["9", "5"]}}})
    _, r = sim.twilio.start_call(demo_raw["twilio_number"], harness.CALLER)
    tw = parse_twiml(r.text)  # safe mode (B12 #2): polite sentence + name/number message, never a dead line
    assert r.status_code == 200 and "Cool Breeze HVAC" in tw.text and "your name" in tw.text and tw.gather


def test_sms_incoming_skeleton(sim):
    t = sim.tenant("demo-hvac")
    r = sim.twilio.sms(t.twilio_number, harness.CALLER, "hello")
    assert r.status_code == 200 and r.text.startswith("<?xml")
    assert sim.store.select("events", type="sms.incoming")


# --- tenant config validation -------------------------------------------------------

def test_schema_file_matches_model():
    assert json.loads(SCHEMA_PATH.read_text()) == json_schema()


def test_demo_valid_against_json_schema(demo_raw):
    jsonschema.Draft202012Validator(json_schema()).validate(demo_raw["config"])
    assert validate_config(demo_raw["config"]).business.niche == "home_services"


def _broken(demo_raw, path, value):
    cfg = copy.deepcopy(demo_raw["config"])
    node = cfg
    for p in path[:-1]:
        node = node[p]
    if value is KeyError:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return cfg


@pytest.mark.parametrize("path,value,expect", [
    (("business", "timezone"), "Mars/Olympus", "business.timezone"),
    (("business", "main_phone"), "713-555-0100", "business.main_phone"),
    (("business", "service_area_zips"), ["7700"], "business.service_area_zips[0]"),
    (("business", "niche"), "law", "business.niche"),
    (("business", "niche"), "hvac", "business.niche"),
    (("hours", "mon"), ["18:00", "07:00"], "hours.mon"),
    (("hours", "tue"), ["7am", "6pm"], "hours.tue"),
    (("booking", "windows"), [], "booking.windows"),
    (("booking", "windows"), [["12:00", "08:00"]], "booking.windows[0]"),
    (("pricing",), {"mode": "listed", "items": []}, "pricing"),
    (("handoff",), {"mode": "dial", "number": None, "hours": "business"}, "handoff"),
    (("notify",), {"sms": [], "email": [], "daily_summary": "19:00"}, "notify"),
    (("voice", "languages"), ["es"], "voice.languages"),
    (("zapier", "webhook_url"), "http://insecure.example.com", "zapier.webhook_url"),
    (("guard", "daily_budget_usd"), 0, "guard.daily_budget_usd"),
    (("business",), KeyError, "business"),
    (("surprise",), 1, "surprise"),
])
def test_invalid_configs_rejected_readably(demo_raw, path, value, expect):
    with pytest.raises(TenantConfigError) as ei:
        validate_config(_broken(demo_raw, path, value), "demo-hvac")
    msg = str(ei.value)
    assert msg.startswith("Invalid tenant config for 'demo-hvac'")
    assert expect in msg, msg


def test_faq_limit_25(demo_raw):
    cfg = _broken(demo_raw, ("faq",), [{"q": f"q{i}", "a": "a"} for i in range(26)])
    with pytest.raises(TenantConfigError, match="faq"):
        validate_config(cfg)


def test_non_object_config_rejected():
    with pytest.raises(TenantConfigError, match="JSON object"):
        validate_config(["nope"])


def test_record_level_errors(demo_raw):
    bad = dict(demo_raw, slug="Bad Slug!")
    with pytest.raises(TenantConfigError, match="slug"):
        load_record(bad)


def test_cli_validate(tmp_path, demo_raw, capsys):
    good = tmp_path / "good.json"
    good.write_text(json.dumps(demo_raw))
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({**demo_raw, "config": _broken(demo_raw, ("hours", "mon"), ["18:00", "07:00"])}))
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    assert sim_main(["validate", str(good)]) == 0
    assert sim_main(["validate", str(good), str(bad), str(broken)]) == 1
    out = capsys.readouterr().out
    assert "OK   " in out and "hours.mon: opening time 18:00 must be before closing time 07:00" in out
    assert "not valid JSON" in out


def test_schema_cli(capsys):
    from app.tenants import _main
    assert _main(["--check-schema"]) == 0
    assert _main([]) == 2


# --- store contract (JSON + Supabase behind one interface) --------------------------------

@pytest.fixture(params=["json", "supabase"])
def store(request, tmp_path, postgrest):
    if request.param == "json":
        return JsonStore(tmp_path)
    return SupabaseStore("https://x.supabase.co", "service-role-test", transport=httpx.MockTransport(postgrest.handler))


def test_store_contract(store, demo_raw):
    assert store.ping()
    t = store.upsert_tenant(demo_raw)
    assert store.tenant_by_number("+17135550199").slug == "demo-hvac"
    assert store.tenant_by_slug("demo-hvac").id == t.id
    assert store.tenant_by_number("+10000000000") is None
    # upsert again updates in place
    changed = copy.deepcopy(demo_raw)
    changed["config"]["paused"] = True
    store.upsert_tenant(changed)
    assert len(store.select("tenants")) == 1 and store.tenant_by_slug("demo-hvac").config.paused

    row = store.insert("calls", {"tenant_id": t.id, "call_sid": "CA1", "outcome": None})
    assert row["id"] and store.select("calls", call_sid="CA1")[0]["tenant_id"] == t.id
    assert store.select("calls", outcome=None)
    assert store.update("calls", row["id"], {"outcome": "booked"})["outcome"] == "booked"
    assert store.update("calls", "missing-id", {"outcome": "x"}) is None

    assert not store.is_opted_out(t.id, "+15550001111")
    store.opt_out(t.id, "+15550001111")
    store.opt_out(t.id, "+15550001111")
    assert store.is_opted_out(t.id, "+15550001111") and len(store.select("opt_outs")) == 1
    store.opt_in(t.id, "+15550001111")
    assert not store.is_opted_out(t.id, "+15550001111")

    ev = store.log_event("runtime", "tenant", t.id, "test.event", {"k": 1})
    assert store.select("events", type="test.event")[0]["payload"] == {"k": 1} and ev

    assert store.get_credential(t.id, "google") is None
    store.put_credential(t.id, "google", "v1.cipher")
    store.put_credential(t.id, "google", "v1.cipher2")
    assert store.get_credential(t.id, "google") == "v1.cipher2"

    with pytest.raises(StoreError):
        store.select("profiles")


def test_supabase_store_sends_service_role_and_maps_errors(postgrest):
    st = SupabaseStore("https://x.supabase.co/", "service-role-test", transport=httpx.MockTransport(postgrest.handler))
    st.select("calls", flagged=True)
    assert postgrest.auth_headers[-1] == "Bearer service-role-test"
    with pytest.raises(StoreError, match="404"):
        st._ok(st._client.post("/rpc/nope", json={}))
    with pytest.raises(StoreError, match="filter"):
        st.delete("calls")
    with pytest.raises(StoreError):
        SupabaseStore("", "")


def test_supabase_error_without_json_body():
    st = SupabaseStore("https://x.supabase.co", "k", transport=httpx.MockTransport(lambda r: httpx.Response(500, text="boom")))
    with pytest.raises(StoreError, match="500"):
        st.select("calls")
    assert st.ping() is False


def test_supabase_ping_network_error():
    def boom(_):
        raise httpx.ConnectError("offline")
    st = SupabaseStore("https://x.supabase.co", "k", transport=httpx.MockTransport(boom))
    assert st.ping() is False


def test_from_settings_supabase():
    from app.store import from_settings
    s = settings_mod.load({"STORE_BACKEND": "supabase", "SUPABASE_URL": "https://x.supabase.co",
                           "SUPABASE_SERVICE_ROLE_KEY": "k"})
    assert isinstance(from_settings(s), SupabaseStore)


def test_supabase_accepts_new_style_secret_key():
    """22.10.2026: SUPABASE_SERVICE_ROLE_KEY may hold a new-style sb_secret_... key (not a JWT). Nothing parses it;
    it is sent as-is in both apikey and Authorization headers, and /health never shows it."""
    from app.store import from_settings
    key = "sb_secret_" + "x" * 30   # shape only, not a real key
    s = settings_mod.load({"STORE_BACKEND": "supabase", "SUPABASE_URL": "https://x.supabase.co/",
                           "SUPABASE_SERVICE_ROLE_KEY": key})
    assert s.supabase_service_key == key and s.supabase_url == "https://x.supabase.co"
    assert key not in repr(s) and key not in str(s.public())
    seen = {}

    def handler(req):
        seen["apikey"] = req.headers.get("apikey")
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json="ok")
    st = SupabaseStore(s.supabase_url, s.supabase_service_key, transport=httpx.MockTransport(handler))
    assert isinstance(from_settings(s), SupabaseStore)
    assert st.ping() is True
    assert seen == {"apikey": key, "auth": f"Bearer {key}"}


def test_json_store_corrupt_file(tmp_path):
    (tmp_path / "calls.json").write_text("{oops")
    with pytest.raises(StoreError, match="not valid JSON"):
        JsonStore(tmp_path).select("calls")


# --- crypto -------------------------------------------------------------------------

KEY = settings_mod.SIM_CRED_KEY


def test_encrypt_roundtrip_and_binding():
    ct = crypto.encrypt(KEY, "refresh-token-123", "tenant-a", "google")
    assert "refresh-token-123" not in ct and ct.startswith("v1.")
    assert crypto.decrypt(KEY, ct, "tenant-a", "google") == "refresh-token-123"
    for args in (("tenant-b", "google"), ("tenant-a", "calendly")):
        with pytest.raises(crypto.CryptoError):
            crypto.decrypt(KEY, ct, *args)
    with pytest.raises(crypto.CryptoError, match="version"):
        crypto.decrypt(KEY, "v9." + ct[3:], "tenant-a", "google")
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(KEY, ct[:-4] + "AAAA", "tenant-a", "google")


@pytest.mark.parametrize("key,match", [("", "not configured"), ("***", "base64"), ("c2hvcnQ=", "32 bytes")])
def test_bad_keys(key, match):
    with pytest.raises(crypto.CryptoError, match=match):
        crypto.encrypt(key, "x", "t", "p")


def test_sign_verify():
    tok = crypto.sign(KEY, {"tenant": "t1"}, ttl_s=60, now=1000)
    assert crypto.verify(KEY, tok, now=1030)["tenant"] == "t1"
    with pytest.raises(crypto.CryptoError, match="expired"):
        crypto.verify(KEY, tok, now=2000)
    with pytest.raises(crypto.CryptoError, match="bad signature"):
        crypto.verify(KEY, tok[:-3] + "xyz", now=1030)
    with pytest.raises(crypto.CryptoError, match="malformed"):
        crypto.verify(KEY, "no-dot-here", now=1030)


# --- fake calendar -----------------------------------------------------------------

def _cfg(demo_raw, **booking):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["booking"].update(booking)
    return load_record(raw)


def test_calendar_respects_lead_time_windows_and_closed_days(demo_raw):
    t = _cfg(demo_raw)
    cal = FakeCalendar()
    now = datetime(2026, 10, 10, 9, 0, tzinfo=TZ)  # Saturday 9 AM
    slots = cal.availability(t.id, t.config, now)
    # Saturday 08-12 is inside lead time (2h) -> skipped; Sunday is closed; Monday has both windows.
    days = [s["slot_id"][:10] for s in slots]
    assert "2026-10-11" not in days and slots[0]["slot_id"].startswith("2026-10-10T12:00")
    assert slots[1]["slot_id"] == "2026-10-12T08:00-12:00"
    assert "Monday Oct 12, 8 AM to 12 PM" == slots[1]["label"]


def test_calendar_max_per_window_and_unknown_slot(demo_raw):
    t = _cfg(demo_raw, max_per_window=2)
    cal = FakeCalendar()
    now = datetime(2026, 10, 12, 6, 0, tzinfo=TZ)
    sid = cal.availability(t.id, t.config, now)[0]["slot_id"]
    assert cal.book(t.id, t.config, now, sid, {"phone": "+15550000001"})["ok"]
    assert cal.book(t.id, t.config, now, sid, {"phone": "+15550000002"})["ok"]
    assert cal.book(t.id, t.config, now, sid, {"phone": "+15550000003"}) == {"ok": False, "reason": "slot_unavailable"}
    assert sid not in [s["slot_id"] for s in cal.availability(t.id, t.config, now)]
    assert cal.book(t.id, t.config, now, "2030-01-01T08:00-12:00", {})["reason"] == "slot_unavailable"
    ev = cal.events(t.id)
    assert len(ev) == 2 and ev[0]["details"]["booked_by"] == "Booked by AI receptionist"


def test_calendar_limit_and_date_from(demo_raw):
    t = _cfg(demo_raw, windows=[["08:00", "09:30"], ["13:15", "14:00"]])
    cal = FakeCalendar()
    now = datetime(2026, 10, 12, 6, 0, tzinfo=TZ)
    slots = cal.availability(t.id, t.config, now, date_from=(now + timedelta(days=2)).date(), limit=1)
    assert len(slots) == 1 and slots[0]["slot_id"].startswith("2026-10-14T08:00")
    assert "9:30 AM" in slots[0]["label"]
    later = cal.availability(t.id, t.config, now, limit=4)
    assert "1:15 PM to 2 PM" in later[1]["label"]


# --- fake twilio + replay ------------------------------------------------------------

def test_fake_twilio_client_and_twiml_parser():
    c = FakeTwilioClient(landlines={"+15550000009"})
    c.messages.create(to="+15550000001", from_="+15550000002", body="hi")
    assert c.outbox[0]["body"] == "hi" and c.outbox[0]["sid"].startswith("SM")
    assert c.lookups.v2.phone_numbers("+15550000009").fetch().line_type_intelligence["type"] == "landline"
    assert c.lookups.v2.phone_numbers("+15550000001").fetch().line_type_intelligence["type"] == "mobile"
    tw = parse_twiml('<Response><Say>a</Say><Dial><Number>+1555</Number></Dial>'
                     '<Message><Body>b</Body></Message><Redirect>/x</Redirect><Hangup/></Response>')
    assert tw.dial == "+1555" and tw.messages == ["b"] and tw.redirect == "/x" and tw.hangup and tw.text == "a b"


def test_fake_twilio_mms_params(sim):
    t = sim.tenant("demo-hvac")
    assert sim.twilio.sms(t.twilio_number, harness.CALLER, "", num_media=2).status_code == 200


def test_replay_store(tmp_path):
    rs = ReplayStore(tmp_path, "scenario-x")
    req = {"model": "m", "system": "s", "messages": [{"role": "user", "content": "hi"}], "tools": []}
    with pytest.raises(ReplayMissing):
        rs.get(req)
    key = rs.put(req, {"content": [{"type": "text", "text": "hello"}]})
    assert key == request_key(req) and rs.get(req)["content"][0]["text"] == "hello"
    assert request_key({**req, "messages": []}) != key
    rs.clear()
    rs.clear()
    assert not rs.path.exists()


# --- simulator CLI -------------------------------------------------------------------

def test_sim_selftest_passes(capsys):
    assert sim_main(["selftest"]) == 0
    assert "checks passed" in capsys.readouterr().out


def test_sim_call_and_sms_cli(capsys):
    assert sim_main(["call", "--tenant", "demo-hvac", "--say", "my ac is broken"]) == 0
    assert sim_main(["sms", "--tenant", "demo-hvac", "--text", "hello"]) == 0
    out = capsys.readouterr().out
    assert "virtual assistant" in out and "customer: hello" in out


def test_booking_provider_defaults_to_calendly(demo_raw):
    cfg = copy.deepcopy(demo_raw["config"])
    del cfg["booking"]["provider"]
    assert validate_config(cfg).booking.provider == "calendly"
    assert json_schema()["$defs"]["Booking"]["properties"]["provider"]["default"] == "calendly"
