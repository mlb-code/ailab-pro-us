"""B4: SMS flow - keywords before Claude, opt-out across every outbound path, text-back, quiet hours,
reminders, segments, idempotency, status callbacks, jobs endpoint."""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app import guard, settings as settings_mod, sms_outbound
from app.main import create_app
from app.store import JsonStore
from sim import harness
from sim.fake_twilio import FakeTwilioClient, parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
BOOKING_STEPS = ["Hi, my AC is blowing warm air", "77005", "The first one works", "My name is Dana Miller",
                 "2100 Rice Blvd, Houston 77005"]


def build(tmp_path, now=MON_9, **env):
    clock = harness.FakeClock(now)
    return harness.build(tmp_path, clock=clock, **env), clock


def text(sim, body, frm=harness.CALLER, **kw):
    r = sim.twilio.sms(sim.tenant("demo-hvac").twilio_number, frm, body, **kw)
    assert r.status_code == 200
    return parse_twiml(r.text).text


def events(sim, type_):
    return [e for e in sim.store.select("events") if e["type"] == type_]


def book_by_text(sim, clock, demo_raw, lead_time=26, consent="Yes"):
    """Book by text; the confirmation reply asks about a reminder text (SA §8 item 3b) and `consent` answers it."""
    demo_raw["config"]["booking"]["lead_time_hours"] = lead_time
    sim.store.upsert_tenant(demo_raw)
    for line in BOOKING_STEPS:
        clock.advance(minutes=1)
        reply = text(sim, line)
    assert "all set" in reply and guard.SMS_CONSENT_Q_SMS in reply
    if consent:
        clock.advance(minutes=1)
        answer = text(sim, consent)
        assert answer in (guard.CONSENT_YES_SMS, guard.CONSENT_NO_SMS)
    return sim.tenant("demo-hvac")


# --- STOP silences every outbound path ------------------------------------------------------------

def test_after_stop_nothing_is_sent_textback_reminder_or_reply(tmp_path, demo_raw):
    # gather mode: no relay socket, so every step finishes before the next one (no background threads)
    sim, clock = build(tmp_path, VOICE_MODE="gather")
    t = book_by_text(sim, clock, demo_raw)
    assert [j["kind"] for j in sim.rt.outbound.jobs(t)] == ["reminder"]
    assert "unsubscribed" in text(sim, "STOP")
    assert text(sim, "is my visit still on?") == ""                 # Claude reply: none
    call = sim.call()                                                # missed call: no text-back
    call.start()
    call.hangup(4)
    clock.advance(minutes=60 * 4)                                    # reminder time
    assert sim.tick().status_code == 200
    assert sim.twilio_client.outbox == []
    assert [e["payload"]["reason"] for e in events(sim, "sms.textback")] == ["opted_out"]
    assert [(e["payload"]["kind"], e["payload"]["reason"]) for e in events(sim, "sms.not_sent")] == \
        [("reminder", "opted_out")]


@pytest.mark.parametrize("word", ["STOP", "stop", "Unsubscribe", "CANCEL", "end", "QUIT", "STOPALL", " stop. "])
def test_stop_words_before_claude(tmp_path, word):
    sim, _ = build(tmp_path)
    assert "unsubscribed" in text(sim, word)
    assert sim.store.is_opted_out(sim.tenant("demo-hvac").id, harness.CALLER)
    assert sim.rt.engine.llm.calls == 0


@pytest.mark.parametrize("word", ["START", "unstop", "Yes"])
def test_start_words_resubscribe_only_opted_out(tmp_path, word):
    sim, _ = build(tmp_path)
    text(sim, "STOP")
    assert "resubscribed" in text(sim, word)
    assert not sim.store.is_opted_out(sim.tenant("demo-hvac").id, harness.CALLER)


def test_yes_from_subscribed_number_goes_to_the_conversation(tmp_path):
    sim, _ = build(tmp_path)
    reply = text(sim, "yes")
    assert "resubscribed" not in reply and sim.rt.engine.llm.calls == 1


@pytest.mark.parametrize("word", ["HELP", "info"])
def test_help(tmp_path, word):
    sim, _ = build(tmp_path)
    reply = text(sim, word)
    assert "Reply STOP" in reply and "+17135550100" in reply and sim.rt.engine.llm.calls == 0


def test_twilio_advanced_opt_out_is_silent(tmp_path):
    sim, _ = build(tmp_path)
    t = sim.tenant("demo-hvac")
    params = {"AccountSid": "AC" + "0" * 32, "MessageSid": "SM" + "1" * 32, "From": harness.CALLER,
              "To": t.twilio_number, "Body": "STOP", "OptOutType": "STOP"}
    r = sim.twilio.post("/sms/incoming", params)
    assert parse_twiml(r.text).text == "" and sim.store.is_opted_out(t.id, harness.CALLER)


# --- replies ----------------------------------------------------------------------------------------

def test_reply_max_320_chars(tmp_path):
    long = "We can help with that. " * 30
    from app.llm import LLMClient
    clock = harness.FakeClock(MON_9)
    settings = harness.sim_settings(tmp_path)
    llm = LLMClient(settings, script=[{"content": [{"type": "text", "text": long}], "stop_reason": "end_turn"}], mode="mock")
    sim = harness.build(tmp_path, clock=clock, llm=llm)
    reply = text(sim, "Do you do duct cleaning?")
    assert 0 < len(reply) <= 320


def test_duplicate_message_sid_is_ignored(tmp_path):
    sim, _ = build(tmp_path)
    t = sim.tenant("demo-hvac")
    r1 = sim.twilio.sms(t.twilio_number, harness.CALLER, "Hi, my AC is blowing warm air", message_sid="SM" + "7" * 32)
    r2 = sim.twilio.sms(t.twilio_number, harness.CALLER, "Hi, my AC is blowing warm air", message_sid="SM" + "7" * 32)
    assert parse_twiml(r1.text).text and parse_twiml(r2.text).text == ""
    assert sim.rt.engine.llm.calls == 1
    assert len(sim.store.select("sms_messages", direction="inbound")) == 1


def test_unknown_number_and_messages_logged(tmp_path):
    sim, _ = build(tmp_path)
    r = sim.twilio.sms("+19995550000", harness.CALLER, "hi")
    assert parse_twiml(r.text).text == ""
    text(sim, "Hi, my AC is blowing warm air")
    rows = sim.store.select("sms_messages")
    assert [r["direction"] for r in rows] == ["inbound", "outbound"]


def test_segments_counted(tmp_path):
    sim, clock = build(tmp_path)
    t = sim.tenant("demo-hvac")
    text(sim, "x" * 200)  # 2 segments in
    used = sim.rt.engine.usage.used(t, "sms", clock())
    assert used >= 3  # 2 in + >= 1 out


def test_mms_gets_fixed_reply_without_claude(tmp_path):
    sim, _ = build(tmp_path)
    assert text(sim, "", num_media=1) == guard.MEDIA_TEXT and sim.rt.engine.llm.calls == 0


def test_thread_rolls_over_after_a_day(tmp_path):
    sim, clock = build(tmp_path)
    t = sim.tenant("demo-hvac")
    a = sms_outbound.thread_id(sim.rt.state, t, harness.CALLER, clock())
    b = sms_outbound.thread_id(sim.rt.state, t, harness.CALLER, clock.advance(minutes=600))
    c = sms_outbound.thread_id(sim.rt.state, t, harness.CALLER, clock.advance(minutes=60 * 25))
    assert a == b != c


# --- outbound rules -----------------------------------------------------------------------------------

def test_quiet_hours_only_for_non_replies(tmp_path):
    night = datetime(2026, 10, 12, 22, 0, tzinfo=TZ)
    sim, _ = build(tmp_path, now=night)
    t = sim.tenant("demo-hvac")
    out = sim.rt.outbound
    assert out.send(t, harness.CALLER, "hi", "test", night) == {"sent": False, "reason": "quiet_hours"}
    assert out.send(t, harness.CALLER, "hi", "test", night, direct_reply=True)["sent"]
    assert text(sim, "Hi, my AC is blowing warm air")  # a direct reply at 10 pm is fine


def test_next_allowed():
    cfg = harness.load_file(harness.TENANTS_DIR / "demo-hvac.json").config
    assert sms_outbound.next_allowed(cfg, MON_9) == MON_9
    late = datetime(2026, 10, 12, 23, 30, tzinfo=TZ)
    early = datetime(2026, 10, 13, 6, 0, tzinfo=TZ)
    assert sms_outbound.next_allowed(cfg, late) == datetime(2026, 10, 13, 8, 0, tzinfo=TZ)
    assert sms_outbound.next_allowed(cfg, early) == datetime(2026, 10, 13, 8, 0, tzinfo=TZ)


def test_landline_no_textback_and_lookup_cached(tmp_path):
    sim, clock = build(tmp_path, VOICE_MODE="gather")
    sim.twilio_client.landlines.add(harness.CALLER)
    t = sim.tenant("demo-hvac")
    assert sim.rt.outbound.line_type(t, harness.CALLER, clock()) == "landline"
    sim.twilio_client.landlines.clear()
    assert sim.rt.outbound.line_type(t, harness.CALLER, clock()) == "landline"  # cached 30 days
    call = sim.call()
    call.start()
    call.hangup(3)
    assert sim.twilio_client.outbox == []
    assert events(sim, "sms.textback")[0]["payload"]["reason"] == "line_type:landline"


def test_lookup_failure_still_sends(tmp_path):
    sim, clock = build(tmp_path)

    class Broken(FakeTwilioClient):
        def _lookup(self, number):
            raise RuntimeError("lookup down")
    sim.rt.outbound.client = Broken()
    assert sim.rt.outbound.line_type(sim.tenant("demo-hvac"), harness.CALLER, clock()) == "unknown"


def test_send_failure_and_missing_client_do_not_raise(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = sim.tenant("demo-hvac")

    class Failing(FakeTwilioClient):
        def _create_message(self, **kw):
            raise RuntimeError("twilio 500")
    sim.rt.outbound.client = Failing()
    assert sim.rt.outbound.send(t, harness.CALLER, "hi", "test", clock()) == {"sent": False, "reason": "send_failed"}
    sim.rt.outbound.client = None
    assert sim.rt.outbound.send(t, harness.CALLER, "hi", "test", clock())["reason"] == "no_twilio_client"
    assert sim.rt.outbound.send(t, "+17135550666", "hi", "test", clock())["reason"] == "blocklist"
    demo_raw["config"]["paused"] = True
    t = sim.store.upsert_tenant(demo_raw)
    assert sim.rt.outbound.send(t, harness.CALLER, "hi", "test", clock())["reason"] == "tenant_paused"


def test_reminder_sent_once_and_skipped_when_cancelled(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = book_by_text(sim, clock, demo_raw)
    job = sim.rt.outbound.jobs(t)[0]
    assert datetime.fromisoformat(job["due"]) == datetime(2026, 10, 12, 12, 0, tzinfo=TZ)
    clock.advance(minutes=60 * 4)
    assert sim.tick().json()["sms_jobs"] == 1 and len(sim.twilio_client.outbox) == 1
    assert sim.tick().json()["sms_jobs"] == 0 and len(sim.twilio_client.outbox) == 1
    # a booking cancelled before its reminder gets no reminder
    sim2, clock2 = build(tmp_path / "b")
    book_by_text(sim2, clock2, demo_raw)
    row = sim2.store.select("bookings")[0]
    sim2.store.update("bookings", row["id"], {"status": "cancelled"})
    clock2.advance(minutes=60 * 4)
    sim2.tick()
    assert sim2.twilio_client.outbox == [] and events(sim2, "sms.reminder")[0]["payload"]["reason"] == "booking_gone"


def test_no_reminder_for_same_day_booking(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = book_by_text(sim, clock, demo_raw, lead_time=2)
    assert sim.rt.outbound.jobs(t) == []


def test_job_found_in_quiet_hours_is_deferred(tmp_path):
    night = datetime(2026, 10, 12, 23, 0, tzinfo=TZ)
    sim, clock = build(tmp_path, now=night)
    t = sim.tenant("demo-hvac")
    out = sim.rt.outbound
    out._add_job(t, {"kind": "textback", "contact": harness.CALLER, "call_sid": "CA1", "due": night.isoformat(),
                     "dedupe": "textback:CA1"})
    assert out.run_due(night)[0]["reason"] == "deferred"
    assert datetime.fromisoformat(out.jobs(t)[0]["due"]) == datetime(2026, 10, 13, 8, 0, tzinfo=TZ)
    start = (night + timedelta(hours=8, minutes=30)).isoformat()
    out._add_job(t, {"kind": "reminder", "contact": harness.CALLER, "due": night.isoformat(), "dedupe": "r1",
                     "booking": {"start": start, "label": "x", "event_id": "e1"}})
    res = {r["job"]: r["reason"] for r in out.run_due(night)}
    assert res["reminder"] == "too_late"


# --- status callback, jobs endpoint ---------------------------------------------------------------

def test_status_callback_carrier_opt_out(tmp_path):
    sim, _ = build(tmp_path)
    t = sim.tenant("demo-hvac")
    params = {"AccountSid": "AC" + "0" * 32, "MessageSid": "SM1", "MessageStatus": "undelivered",
              "ErrorCode": "21610", "From": t.twilio_number, "To": harness.CALLER}
    assert sim.twilio.post("/sms/status", params).status_code == 204
    assert sim.store.is_opted_out(t.id, harness.CALLER)
    ok = dict(params, ErrorCode="", MessageStatus="delivered", To="+17135550999")
    assert sim.twilio.post("/sms/status", ok).status_code == 204
    assert not sim.store.is_opted_out(t.id, "+17135550999") and len(events(sim, "sms.status")) == 2


def test_single_cron_endpoint(tmp_path, monkeypatch):
    """/jobs/run is gone: the only cron is /jobs/tick (RUNTIME_ADMIN_TOKEN); it runs the SMS jobs too."""
    monkeypatch.setenv("RUNTIME_ADMIN_TOKEN", "secret-123")
    s = settings_mod.load({"STORE_BACKEND": "json", "DATA_DIR": str(tmp_path), "TWILIO_AUTH_TOKEN": "t"})
    c = TestClient(create_app(s, JsonStore(tmp_path)))
    assert c.post("/jobs/run").status_code in (404, 405)
    assert c.post("/jobs/tick").status_code == 401
    assert "sms_jobs" in c.post("/jobs/tick", headers={"Authorization": "Bearer secret-123"}).json()


def test_tick_uses_runtime_clock_for_quiet_hours(tmp_path):
    night = datetime(2026, 10, 12, 23, 0, tzinfo=TZ)
    sim, clock = build(tmp_path, now=night, VOICE_MODE="gather")
    call = sim.call()
    call.start()
    call.hangup(3)
    assert sim.tick().json()["sms_jobs"] == 0 and sim.twilio_client.outbox == []
    clock.advance(minutes=9 * 60 + 5)  # 08:05 next morning: a queued text-back waits for 09:00
    assert sim.tick().json()["sms_jobs"] == 0 and sim.twilio_client.outbox == []
    clock.advance(minutes=60)          # 09:05
    assert sim.tick().json()["sms_jobs"] == 1 and len(sim.twilio_client.outbox) == 1


def test_jobs_loop_runs_in_lifespan(tmp_path):
    s = settings_mod.load({"RUNTIME_MODE": "sim", "DATA_DIR": str(tmp_path), "JOBS_LOOP_SECONDS": "0.01"})
    store = JsonStore(tmp_path)
    harness.seed_tenants(store)
    with TestClient(create_app(s, store)) as c:
        import time
        time.sleep(0.05)
        assert c.get("/health").status_code == 200


def test_call_booking_texts_need_consent_and_the_window(tmp_path):
    """Legal v1.1 replaces the 2026-10-11 decision: the booking confirmation after a call needs the caller's yes and
    follows the 09-20 window (Sunday 12-20); full coverage in tests/test_legal_v11.py."""
    night = datetime(2026, 10, 11, 22, 30, tzinfo=TZ)
    sim, _ = build(tmp_path, now=night, VOICE_MODE="gather")
    call = sim.call()
    call.start()
    call.say("My AC is blowing warm air, zip 77002")
    turn = call.say("The morning one, my name is Ann Lee, 900 Main St Houston 77002")
    assert "all set" in turn.text and guard.SMS_CONSENT_Q_VOICE in turn.text
    call.hangup()
    assert sim.twilio_client.outbox == []
    t = sim.tenant("demo-hvac")
    assert sim.rt.outbound.send(t, harness.CALLER, "x", "reminder", night) == {"sent": False, "reason": "quiet_hours"}