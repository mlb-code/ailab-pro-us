"""ADD-DISPATCH (app.dispatch): on-call schedule, warm transfer with whisper, waterfall, 75 s cap, escalation alerts,
acknowledgement (call / SMS / portal "handled"), STOP from staff, SMS flag off by default, 911 line still first."""
from __future__ import annotations

import copy
from datetime import datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import pytest

from app import dispatch
from app.tenants import TenantConfigError, load_record
from sim import harness
from sim.fake_twilio import parse_twiml

CHI = ZoneInfo("America/Chicago")
MON_23 = datetime(2026, 10, 12, 23, 0, tzinfo=CHI)   # closed (hours Mon-Fri 07-18)
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=CHI)     # open
MODES = ["stream", "gather"]
OPT_IN = "2026-10-01T10:00:00+00:00"
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DAN, BO, MARIA = "+17135550201", "+17135550202", "+17135550203"


def dispatch_cfg(**over):
    d = {"enabled": True, "callback_minutes": 15,
         "contacts": [{"id": "dan", "name": "Dan", "phone": DAN, "role": "tech", "alerts_opt_in_at": OPT_IN},
                      {"id": "bo", "name": "Bo", "phone": BO, "role": "tech"},
                      {"id": "maria", "name": "Maria", "phone": MARIA, "role": "manager", "alerts_opt_in_at": OPT_IN}],
         "schedule": [{"day": d, "start": "18:00", "end": "07:00", "contacts": ["dan", "bo"]} for d in DAYS]}
    d.update(over)
    return d


def tenant_raw(demo_raw, **over):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["dispatch"] = dispatch_cfg(**over)
    return raw


def build(tmp_path, demo_raw, mode="stream", now=MON_23, dispatch_over=None, **env):
    clock = harness.FakeClock(now)
    sim = harness.build(tmp_path, clock=clock, VOICE_MODE=mode, PUBLIC_BASE_URL="http://testserver", **env)
    sim.store.upsert_tenant(tenant_raw(demo_raw, **(dispatch_over or {})))
    return sim, clock


def events(sim, result=None):
    rows = sim.store.select("dispatch_events")
    return [r for r in rows if result is None or r["result"] == result]


def alerts(sim):
    sim.rt.drain(5)
    return [a["kind"] for a in sim.rt.alert_log]


def start_urgent(sim):
    call = sim.call()
    call.start()
    turn = call.say("My basement is flooding")
    assert "first name" in turn.text and "ZIP" in turn.text and not turn.end
    return call


# --- pure rules -----------------------------------------------------------------------------------

def cfg_of(demo_raw, **over):
    return load_record(tenant_raw(demo_raw, **over)).config


def test_schedule_crosses_midnight_and_time_zones(demo_raw):
    cfg = cfg_of(demo_raw, schedule=[{"day": "mon", "start": "18:00", "end": "07:00", "contacts": ["dan"]},
                                     {"day": "tue", "start": "07:00", "end": "18:00", "contacts": ["bo"]}])
    names = lambda t: [c.name for c in dispatch.on_shift(cfg, t)]  # noqa: E731
    assert names(datetime(2026, 10, 12, 23, 30, tzinfo=CHI)) == ["Dan"]           # Monday night
    assert names(datetime(2026, 10, 13, 2, 0, tzinfo=CHI)) == ["Dan"]             # after midnight = Monday's shift
    assert names(datetime(2026, 10, 13, 7, 0, tzinfo=CHI)) == ["Bo"]              # 07:00 exactly: next shift
    assert names(datetime(2026, 10, 13, 18, 0, tzinfo=CHI)) == []                 # Tuesday night: nobody scheduled
    assert names(datetime(2026, 10, 13, 4, 30, tzinfo=ZoneInfo("UTC"))) == ["Dan"]  # 23:30 Chicago, given in UTC
    assert names(datetime(2026, 10, 12, 17, 59, tzinfo=CHI)) == []


def test_plan_order_manager_fallback_and_cap(demo_raw):
    cfg = cfg_of(demo_raw)
    assert [x["name"] for x in dispatch.plan(cfg, MON_23)] == ["Dan", "Bo", "Maria"]
    nobody = cfg_of(demo_raw, schedule=[])
    assert [x["name"] for x in dispatch.plan(nobody, MON_23)] == ["Maria"]       # fallback = manager
    five = cfg_of(demo_raw, contacts=[{"id": f"c{i}", "name": f"P{i}", "phone": f"+1713555030{i}"} for i in range(5)],
                  schedule=[{"day": "mon", "start": "18:00", "end": "07:00", "contacts": [f"c{i}" for i in range(5)]}])
    assert len(dispatch.plan(five, MON_23)) == 3                                  # waterfall of at most 3
    assert dispatch.plan(cfg, MON_9) == []                                        # open, daytime mode off
    day = cfg_of(demo_raw, daytime_too=True,
                 schedule=[{"day": "mon", "start": "07:00", "end": "18:00", "contacts": ["bo"]}])
    assert [x["phone"] for x in dispatch.plan(day, MON_9)] == ["+17135550111", BO, MARIA]  # office line first
    assert dispatch.plan(cfg_of(demo_raw, enabled=False), MON_23) == []


def test_config_validation(demo_raw):
    bad = [dict(schedule=[{"day": "mon", "start": "18:00", "end": "07:00", "contacts": ["ghost"]}]),
           dict(contacts=[{"id": "a", "name": "A", "phone": DAN}, {"id": "b", "name": "B", "phone": DAN}]),
           dict(contacts=[{"id": "a", "name": "A", "phone": DAN}, {"id": "a", "name": "B", "phone": BO}], schedule=[]),
           dict(contacts=[], schedule=[]),
           dict(callback_minutes=2)]
    for over in bad:
        with pytest.raises(TenantConfigError):
            load_record(tenant_raw(demo_raw, **over))
    raw = copy.deepcopy(demo_raw)
    assert load_record(raw).config.dispatch.enabled is False                      # absent section = off


def test_name_and_issue_parsing(demo_raw):
    cfg = cfg_of(demo_raw)
    assert dispatch.parse_name("It's Tess, 77005") == "Tess"
    assert dispatch.parse_name("my name is tess and the zip is 77005") == "Tess"
    assert dispatch.parse_name("Tess 77005") == "Tess"
    assert dispatch.parse_name("uh 77005") == ""
    assert dispatch.issue_label("the basement is flooding", cfg) == "flooding"
    assert dispatch.issue_label("I have a burst pipe", cfg) == "burst pipe"
    assert dispatch.issue_label("there's a gas smell", cfg) == "gas smell"
    assert dispatch.issue_label("help", cfg) == "urgent job"
    sms = dispatch.alert_sms("Cool Breeze HVAC", {"issue": "flooding", "zip": "77005", "name": "Tess"})
    assert "Reply STOP" in sms and "+1" not in sms and len(sms) <= 320


# --- warm transfer ----------------------------------------------------------------------------------

@pytest.mark.parametrize("mode", MODES)
def test_night_flood_whisper_accept_connects(tmp_path, demo_raw, mode):
    sim, clock = build(tmp_path, demo_raw, mode)
    call = start_urgent(sim)
    turn = call.say("It's Tess, 77005")
    assert turn.dial == DAN and "connecting you" in turn.text and "Tess" in turn.text
    assert call.dial_url.startswith("/voice/dispatch/whisper?d=") and call.dial_action == "/voice/dial-result?leg=0"
    clock.advance(seconds=9)
    tw = call.whisper("")  # what Dan hears before pressing anything
    assert tw.gather and "Urgent call for Cool Breeze HVAC: flooding, ZIP 77005, caller Tess." in tw.text
    assert "Press 1" in tw.text and "+1" not in tw.text and "basement" not in tw.text
    assert "Connecting you now" in call.whisper("1").text
    assert call.dial("completed").end
    call.hangup()
    assert [r["result"] for r in events(sim)] == ["accepted"]
    assert events(sim)[0]["contact_name"] == "Dan" and events(sim)[0]["wait_s"] == 9
    assert sim.store.select("calls")[0]["outcome"] == "emergency"
    assert "lead" not in alerts(sim) and "urgent" in alerts(sim)
    assert sim.twilio_client.calls_out == []                                      # no escalation


@pytest.mark.parametrize("mode", MODES)
def test_waterfall_then_callback_promise_and_alerts(tmp_path, demo_raw, mode):
    sim, clock = build(tmp_path, demo_raw, mode)
    call = start_urgent(sim)
    assert call.say("Tess 77005").dial == DAN
    clock.advance(seconds=20)
    turn = call.dial("no-answer")
    assert turn.dial == BO and dispatch.HOLD_TEXT in turn.text and call.dial_action.endswith("leg=1")
    assert call.whisper("9").hangup                                               # Bo presses another key
    clock.advance(seconds=10)
    turn = call.dial("completed")                                                 # his leg ended without a bridge
    assert turn.dial == MARIA
    clock.advance(seconds=20)
    turn = call.dial("no-answer")
    assert turn.end and "call you back within 15 minutes" in turn.text
    call.hangup()
    assert [(r["result"], r["contact_name"]) for r in events(sim) if r["leg"] is not None] == [
        ("no_answer", "Dan"), ("declined", "Bo"), ("no_answer", "Maria")]
    assert {"urgent", "lead"} <= set(alerts(sim))                                 # owner gets the urgent lead
    assert sorted(c["to"] for c in sim.twilio_client.calls_out) == [DAN, MARIA]   # opted in; Bo has no opt-in
    assert sorted(r["contact_name"] for r in events(sim, "alert_sent")) == ["Dan", "Maria"]
    assert sim.store.select("calls")[0]["outcome"] == "emergency"
    assert not [m for m in sim.twilio_client.outbox if m["to"] in (DAN, MARIA)]   # SMS flag off: calls, no texts


def test_total_wait_capped_at_75s(tmp_path, demo_raw):
    sim, clock = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    call.say("Tess 77005")
    clock.advance(seconds=30)
    assert call.dial("no-answer").dial == BO
    clock.advance(seconds=46)                                                     # 76 s since the transfer began
    turn = call.dial("no-answer")
    assert turn.end and "call you back" in turn.text and len(events(sim, "no_answer")) == 2


def test_second_leg_rings_only_the_time_left(tmp_path, demo_raw):
    sim, clock = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    call.say("Tess 77005")
    clock.advance(seconds=62)
    resp = sim.twilio.dial_result(call.to, call.caller, call.call_sid, "no-answer", path=call.dial_action)
    import xml.etree.ElementTree as ET
    assert ET.fromstring(resp.text).find("Dial").get("timeout") == "13"


def test_alert_retry_once_then_ack_by_call_connects_caller(tmp_path, demo_raw):
    sim, clock = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    call.say("Tess 77005")
    for _ in range(3):
        if call.ended:
            break
        call.dial("no-answer")
    call.hangup()
    sim.rt.drain(5)
    assert len(sim.twilio_client.calls_out) == 2
    sim.tick()
    assert len(sim.twilio_client.calls_out) == 2                                  # retry is due after 5 minutes
    clock.advance(minutes=5)
    sim.tick()
    assert len(sim.twilio_client.calls_out) == 4                                  # repeated once
    clock.advance(minutes=10)
    sim.tick()
    assert len(sim.twilio_client.calls_out) == 4                                  # ... and only once
    alert = next(c for c in sim.twilio_client.calls_out if c["to"] == MARIA)
    path = urlsplit(alert["url"]).path + "?" + urlsplit(alert["url"]).query
    params = sim.twilio.call_params(MARIA, sim.tenant("demo-hvac").twilio_number, "CA" + "7" * 32)
    tw = parse_twiml(sim.twilio.post(path, params).text)
    assert tw.gather and "Urgent call for Cool Breeze HVAC: flooding, ZIP 77005, caller Tess." in tw.text
    ack = parse_twiml(sim.twilio.post(tw.gather_action, {**params, "Digits": "1"}).text)
    assert ack.dial == harness.CALLER and "Connecting you to the customer" in ack.text
    assert [r["contact_name"] for r in events(sim, "acknowledged")] == ["Maria"]
    again = parse_twiml(sim.twilio.post(path, params).text)                       # Dan's alert call, answered late
    assert not again.gather and "already taken care of" in again.text


def test_sms_alerts_need_both_flags_and_reply_1_acknowledges(tmp_path, demo_raw):
    sim, clock = build(tmp_path, demo_raw, "gather", dispatch_over={"sms_alerts": True}, DISPATCH_SMS_ALERTS="1")
    call = start_urgent(sim)
    call.say("Tess 77005")
    for _ in range(3):
        if not call.ended:
            call.dial("no-answer")
    call.hangup()
    sim.rt.drain(5)
    texts = [m for m in sim.twilio_client.outbox if m["to"] in (DAN, MARIA)]
    assert sorted(m["to"] for m in texts) == [DAN, MARIA] and not sim.twilio_client.calls_out
    assert all("Reply 1" in m["body"] and "STOP" in m["body"] and harness.CALLER not in m["body"] for m in texts)
    r = sim.twilio.sms(sim.tenant("demo-hvac").twilio_number, DAN, "1")
    assert "marked as yours" in parse_twiml(r.text).text
    clock.advance(minutes=6)
    sim.tick()
    assert len([m for m in sim.twilio_client.outbox if m["to"] in (DAN, MARIA)]) == 2   # no repeat after the ack
    assert [r["contact_name"] for r in events(sim, "acknowledged")] == ["Dan"]


def test_tenant_sms_flag_alone_still_calls(tmp_path, demo_raw):
    sim, _ = build(tmp_path, demo_raw, "gather", dispatch_over={"sms_alerts": True})
    call = start_urgent(sim)
    call.say("Tess 77005")
    for _ in range(3):
        if not call.ended:
            call.dial("no-answer")
    sim.rt.drain(5)
    assert len(sim.twilio_client.calls_out) == 2
    assert not [m for m in sim.twilio_client.outbox if m["to"] in (DAN, MARIA)]


def test_portal_handled_stops_the_repeat(tmp_path, demo_raw):
    sim, clock = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    call.say("Tess 77005")
    for _ in range(3):
        if not call.ended:
            call.dial("no-answer")
    sim.rt.drain(5)
    tenant = sim.tenant("demo-hvac")
    sim.store.for_tenant(tenant.id).insert("dispatch_events", {"call_sid": call.call_sid, "result": "handled",
                                                               "at": clock().isoformat()})  # mark_dispatch_handled RPC
    clock.advance(minutes=5)
    sim.tick()
    assert len(sim.twilio_client.calls_out) == 2


def test_staff_stop_removes_from_alerts_and_flags_portal(tmp_path, demo_raw):
    sim, _ = build(tmp_path, demo_raw, "gather", dispatch_over={"sms_alerts": True}, DISPATCH_SMS_ALERTS="1")
    number = sim.tenant("demo-hvac").twilio_number
    sim.twilio.sms(number, MARIA, "STOP")
    assert [r["contact_name"] for r in events(sim, "opted_out")] == ["Maria"]
    sim.twilio.sms(number, MARIA, "STOP")
    assert len(events(sim, "opted_out")) == 1
    call = start_urgent(sim)
    call.say("Tess 77005")
    for _ in range(3):
        if not call.ended:
            call.dial("no-answer")
    sim.rt.drain(5)
    assert [m["to"] for m in sim.twilio_client.outbox if m["to"] in (DAN, MARIA)] == [DAN]


@pytest.mark.parametrize("mode", MODES)
def test_caller_hangs_up_while_ringing_still_alerts(tmp_path, demo_raw, mode):
    sim, _ = build(tmp_path, demo_raw, mode)
    call = start_urgent(sim)
    call.say("Tess 77005")
    call.hangup()
    sim.rt.drain(5)
    assert sorted(c["to"] for c in sim.twilio_client.calls_out) == [DAN, MARIA]
    assert "lead" in alerts(sim)


@pytest.mark.parametrize("mode", MODES)
def test_911_line_still_first(tmp_path, demo_raw, mode):
    sim, _ = build(tmp_path, demo_raw, mode)
    call = sim.call()
    call.start()
    turn = call.say("I smell gas in the kitchen")
    assert turn.text.startswith("If anyone is in danger, please hang up and call 911 now.") and not turn.dial
    assert "dispatch_collect" not in sim.rt.engine.find_convo(sim.tenant("demo-hvac"), "voice", call.call_sid).meta


@pytest.mark.parametrize("mode", MODES)
def test_open_hours_keep_the_existing_urgent_dial(tmp_path, demo_raw, mode):
    sim, _ = build(tmp_path, demo_raw, mode, now=MON_9)
    call = sim.call()
    call.start()
    turn = call.say("The basement is flooding")
    assert turn.dial == "+17135550111" and call.dial_action == "/voice/dial-result" and not call.dial_url


def test_known_name_and_zip_connect_at_once(tmp_path, demo_raw):
    sim, _ = build(tmp_path, demo_raw, "gather")
    call = sim.call()
    call.start()
    turn = call.say("This is Tess, my basement is flooding, zip 77005")
    assert "first name" in turn.text  # name not known from a tool call yet: asked once
    turn = call.say("Tess")
    assert turn.dial == DAN


def test_bad_or_stale_tokens_hang_up(tmp_path, demo_raw):
    sim, _ = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    call.say("Tess 77005")
    params = sim.twilio.call_params(DAN, call.caller, "CA" + "8" * 32)
    for path in ("/voice/dispatch/whisper?d=bad", "/voice/dispatch/whisper-ack?d=bad", "/voice/dispatch/alert?d=x",
                 "/voice/dispatch/alert-ack", "/voice/dispatch/whisper"):
        assert parse_twiml(sim.twilio.post(path, params).text).hangup
    assert sim.twilio.post(call.dial_url, params, signed=False).status_code == 403
    stale = call.dial_url
    call.dial("no-answer")                                                        # leg 1 is ringing now
    assert parse_twiml(sim.twilio.post(stale, params).text).hangup


def test_reports_count_dispatch(tmp_path, demo_raw):
    from app import reports
    sim, clock = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    call.say("Tess 77005")
    clock.advance(seconds=12)
    call.whisper("1")
    call.dial("completed")
    call.hangup()
    tenant = sim.tenant("demo-hvac")
    d = reports.activity(sim.store, tenant, datetime(2026, 10, 12, tzinfo=CHI), datetime(2026, 10, 14, tzinfo=CHI))
    assert d["dispatch"] == {"urgent_transfers": 1, "connected": 1, "avg_accept_s": 12, "alerts_sent": 0}


def test_report_templates_show_dispatch_lines_only_when_on():
    from app.notify import templates as T
    base = {"calls_answered": 3, "booked": 1, "messages": 1, "urgent": 1, "sms_threads": 0, "text_backs": 0,
            "date": "2026-10-12", "leads": []}
    _, text, _ = T.daily_summary("Cool Breeze HVAC", base)
    assert "on-call" not in text
    _, text, _ = T.daily_summary("Cool Breeze HVAC", {**base, "dispatch": {"urgent_transfers": 2, "connected": 1,
                                                                            "avg_accept_s": 14, "alerts_sent": 2}})
    assert "Urgent calls sent to your on-call team: 2" in text and "average time to pick up: 14 seconds" in text


def test_technician_sees_the_callers_number(tmp_path, demo_raw):
    sim, clock = build(tmp_path, demo_raw, "gather")
    call = start_urgent(sim)
    resp_turn = call.say("Tess 77005")
    import xml.etree.ElementTree as ET
    resp = sim.twilio.dial_result(call.to, call.caller, call.call_sid, "no-answer", path=call.dial_action)
    assert ET.fromstring(resp.text).find("Dial").get("callerId") == call.caller
