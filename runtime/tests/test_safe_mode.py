"""B12 #2: a tenant whose stored config does not validate never drops calls or texts silently."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app import voice_safe
from app.notify import calllog
from app.notify.routes import SIM_ADMIN_TOKEN
from sim import harness
from sim.fake_twilio import parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_10 = datetime(2026, 10, 12, 10, 0, tzinfo=TZ)


def broken(tmp_path, demo_raw, now=MON_10, mode="gather"):
    clock = harness.FakeClock(now)
    sim = harness.build(tmp_path, clock=clock, VOICE_MODE=mode)
    row = sim.store.select("tenants", slug="demo-hvac")[0]
    sim.store.update("tenants", row["id"], {"config": {**demo_raw["config"], "hours": {"mon": ["9", "5"]}}})
    return sim, clock


def events(sim, type_):
    return [e for e in sim.store.select("events") if e["type"] == type_]


@pytest.mark.parametrize("mode", ["stream", "gather"])
def test_call_takes_a_message_then_text_back(tmp_path, demo_raw, mode):
    sim, _ = broken(tmp_path, demo_raw, mode=mode)
    call = sim.call()
    first = call.start()
    assert "Thanks for calling Cool Breeze HVAC" in first.text and not first.end and call.mode == "gather"
    done = call.say("This is Dana Miller, call me at 713 555 0123")
    assert done.end and "call you back" in done.text
    call.hangup(25)
    row = sim.store.select("calls")[0]
    assert row["outcome"] == "message" and "Dana Miller" in row["summary"] and row["duration_s"] == 25
    assert [m["body"][:20] for m in sim.twilio_client.outbox] == ["Hi, this is Cool Bre"]
    assert len(events(sim, "tenant_config_invalid")) == 1 and events(sim, "safe_mode.message")


def test_hangup_without_speech_is_abandoned_with_one_textback_a_day(tmp_path, demo_raw):
    sim, clock = broken(tmp_path, demo_raw)
    for _ in range(2):
        call = sim.call()
        call.start()
        call.hangup(3)
        clock.advance(minutes=20)
    assert [r["outcome"] for r in sim.store.select("calls")] == ["abandoned", "abandoned"]
    assert len(sim.twilio_client.outbox) == 1


def test_textback_respects_opt_out_and_quiet_hours(tmp_path, demo_raw):
    sim, clock = broken(tmp_path, demo_raw, now=datetime(2026, 10, 12, 22, 30, tzinfo=TZ))
    call = sim.call()
    call.start()
    call.hangup(3)
    assert sim.twilio_client.outbox == [] and events(sim, "sms.not_sent")[0]["payload"]["reason"] == "quiet_hours"
    sim.store.for_tenant(sim.store.select("tenants")[0]["id"]).opt_out(harness.CALLER)
    clock.advance(minutes=60 * 12)
    call = sim.call()
    call.start()
    call.hangup(3)
    assert sim.twilio_client.outbox == []


def test_sms_minimal_reply_stop_help_and_logging(tmp_path, demo_raw):
    sim, _ = broken(tmp_path, demo_raw)
    num = demo_raw["twilio_number"]

    def text(body, **kw):
        return parse_twiml(sim.twilio.sms(num, harness.CALLER, body, **kw).text).text
    assert text("Hi, my AC is broken") == voice_safe.SAFE_SMS_REPLY
    assert "+17135550100" in text("HELP")
    assert "unsubscribed" in text("STOP") and text("hello?") == ""
    assert "resubscribed" in text("START")
    dirs = [r["direction"] for r in sim.store.select("sms_messages")]
    assert dirs.count("inbound") == 5 and dirs.count("outbound") == 4
    assert len(events(sim, "tenant_config_invalid")) == 1  # once a day, voice and SMS together


def test_event_and_admin_alert_once_a_day_per_tenant(tmp_path, demo_raw, monkeypatch):
    sent = []
    monkeypatch.setattr(voice_safe, "_admin_send", lambda rt, bt, summary, key, now: sent.append(key))
    sim, clock = broken(tmp_path, demo_raw)
    for _ in range(3):
        call = sim.call()
        call.start()
        call.hangup(2)
    clock.advance(minutes=60 * 24)
    call = sim.call()
    call.start()
    assert sim.rt.drain(5)
    assert [k for k in sent if k.startswith("tenant_config_invalid")] == [
        "tenant_config_invalid:2026-10-12", "tenant_config_invalid:2026-10-13"]
    ev = events(sim, "tenant_config_invalid")
    assert len(ev) == 2 and "hours.mon" in " ".join(ev[0]["payload"]["problems"])


def test_admin_alert_reaches_notify_in_hebrew(tmp_path, demo_raw):
    sim, _ = broken(tmp_path, demo_raw)
    sim.call().start()
    assert sim.rt.drain(5)
    rows = [e for e in sim.store.select("events") if e["type"] in ("email.outbox", "notify.admin_unset")]
    assert rows and "קונפיג לקוח לא תקין" in str(rows[-1]["payload"])


def test_health_deep_lists_invalid_tenants(tmp_path, demo_raw):
    sim, _ = broken(tmp_path, demo_raw)
    auth = {"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}
    assert sim.client.get("/health/deep").status_code == 401
    assert sim.client.get("/health/deep", headers={"Authorization": "Bearer wrong"}).status_code == 401
    r = sim.client.get("/health/deep", headers=auth)
    body = r.json()
    assert body["checks"]["tenant_configs"] is False
    assert body["tenants_invalid"] == [{"slug": "demo-hvac", "fields": ["hours.mon", "hours.mon[0]", "hours.mon[1]"]}]
    # no tenant value of any kind in the response (phones, e-mails, FAQ, hours, names)
    for value in ("+1713555", "owner@example.com", "Trane", "Cool Breeze", "'9'", '"9"', "77005"):
        assert value not in r.text, value
    ok = harness.build(tmp_path / "ok").client.get("/health/deep", headers=auth).json()
    assert ok["checks"]["tenant_configs"] is True and ok["tenants_invalid"] == []


def test_voice_rate_env_and_stream_default(monkeypatch):
    assert calllog.rates({})["voice_per_min"] == pytest.approx(0.0785)
    assert calllog.rates({"VOICE_MODE": "gather"})["voice_per_min"] == pytest.approx(0.0125)
    assert calllog.rates({"TWILIO_VOICE_USD_PER_MIN": "0.05"})["voice_per_min"] == 0.05


def test_record_call_uses_the_voice_rate(tmp_path, demo_raw, monkeypatch):
    monkeypatch.setenv("TWILIO_VOICE_USD_PER_MIN", "0.1")
    clock = harness.FakeClock(MON_10)
    sim = harness.build(tmp_path, clock=clock, VOICE_MODE="gather")
    call = sim.call()
    call.start()
    call.say("Do you service Trane units?")
    call.hangup(125)  # 3 billed minutes
    row = sim.store.select("calls")[0]
    assert row["cost_usd"] >= 0.3
    t = sim.tenant("demo-hvac")
    assert sim.rt.state.get(calllog.twilio_cost_key(t.id, "2026-10-12")) >= 0.3  # 3 min x 0.1 (+ any SMS)
