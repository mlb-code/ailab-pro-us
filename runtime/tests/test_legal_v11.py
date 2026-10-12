"""Legal v1.1 (2026-10-12): the product side of the residual-risk memos (docs/reports/legal-residual/02-*.md).

Call notice in every greeting, texting consent asked at booking and logged, revocation by any reasonable means
(SMS sentence or spoken), recording objection = no transcript, the texting window in the business's AND the
caller's time zone, locked SMS templates, consent log rows."""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app import guard, sms_outbound
from app.area_codes import timezone_for
from app.tenants import load_file
from app.voice import DISCLOSURE, greeting, has_disclosure
from sim import harness
from sim.fake_twilio import parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
CFG = load_file(harness.TENANTS_DIR / "demo-hvac.json").config
ASK = "My furnace stopped working, I'm in 77019"
PICK = "The afternoon one please, this is Carlos Reyes at 45 Westheimer Rd Houston 77019"


def build(tmp_path, now=MON_9, mode="gather", **env):
    clock = harness.FakeClock(now)
    return harness.build(tmp_path, clock=clock, VOICE_MODE=mode, **env), clock


def consent_rows(sim, type_=None):
    rows = sim.store.select("sms_consent")
    return [r for r in rows if type_ is None or r["consent_type"] == type_]


def booked_call(sim):
    call = sim.call()
    call.start()
    call.say(ASK)
    turn = call.say(PICK)
    assert "all set" in turn.text and turn.text.endswith(guard.SMS_CONSENT_Q_VOICE) and not turn.end
    return call


def sms(sim, body, frm=harness.CALLER):
    r = sim.twilio.sms(sim.tenant("demo-hvac").twilio_number, frm, body)
    assert r.status_code == 200
    return parse_twiml(r.text).text


# --- 1. the call notice --------------------------------------------------------------------------------------

def test_disclosure_is_the_memo_sentence_and_in_every_default_greeting():
    assert DISCLOSURE == ("This call may be recorded and transcribed by us and our service providers, "
                          "and we may text you about it.")
    t = load_file(harness.TENANTS_DIR / "demo-hvac.json")
    g = greeting(t)
    assert DISCLOSURE in g and "virtual assistant" in g and "AI" in g and has_disclosure(g)


@pytest.mark.parametrize("text,ok", [
    (DISCLOSURE, True),
    ("Calls are recorded and transcribed by our service providers, and we may text you.", True),
    ("This call may be transcribed.", False),
    ("Calls may be recorded for quality.", False),
    ("This call may be recorded and transcribed by our service providers.", False),  # no texting notice
    ("We may text you. This call is recorded.", False),
])
def test_custom_greeting_needs_every_part(text, ok):
    assert has_disclosure(text) is ok


def test_safe_mode_greeting_has_the_disclosure_before_listening():
    from app.voice_safe import safe_greeting
    assert DISCLOSURE in safe_greeting("Acme")


def test_stream_mode_holds_speech_until_the_greeting_has_played(tmp_path):
    """welcomeGreetingInterruptible=none + a prompt sent during the greeting is processed only after its end."""
    sim, _ = build(tmp_path, mode="stream", VOICE_TTS_WPS="40", VOICE_GREETING_HOLD="1")
    words = len(greeting(sim.tenant("demo-hvac")).split())
    call = sim.call()
    call.start()
    t0 = time.perf_counter()
    call.say("Hi, my AC is broken")
    assert time.perf_counter() - t0 >= words / 40 * 0.8
    call.hangup()


# --- 2. texting consent at booking -----------------------------------------------------------------------------

def test_voice_yes_sends_confirmation_and_queues_reminder_and_logs_consent(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    demo_raw["config"]["booking"]["lead_time_hours"] = 26              # a visit tomorrow: a reminder is due
    sim.store.upsert_tenant(demo_raw)
    call = booked_call(sim)
    assert sim.twilio_client.outbox == []                       # nothing before the answer
    clock.advance(seconds=5)
    assert call.say("Yes please").text == guard.CONSENT_YES_VOICE
    assert [m["body"][:30] for m in sim.twilio_client.outbox] == ["Cool Breeze HVAC: you're booke"]
    t = sim.tenant("demo-hvac")
    assert [j["kind"] for j in sim.rt.outbound.jobs(t)] == ["reminder"]
    rows = consent_rows(sim, "booking_texts")
    assert len(rows) == 1 and rows[0]["decision"] == "yes" and rows[0]["evidence"] == "Yes please"
    assert rows[0]["channel"] == "voice" and rows[0]["call_sid"] == call.call_sid
    assert rows[0]["prompt_version"] == guard.CONSENT_PROMPT_VERSION and rows[0]["contact_e164"] == harness.CALLER
    call.hangup()


def test_voice_no_means_no_texts_but_the_booking_stands(tmp_path):
    sim, clock = build(tmp_path)
    call = booked_call(sim)
    reply = call.say("No thanks").text
    assert reply.startswith("No problem, I won't text you. Your visit is ") and "Anything else" in reply
    call.hangup()
    clock.advance(minutes=30 * 60)
    sim.tick()
    assert sim.twilio_client.outbox == []
    assert len(sim.store.select("bookings")) == 1
    assert [r["decision"] for r in consent_rows(sim, "booking_texts")] == ["no"]


def test_voice_hangup_before_answering_means_no_texts(tmp_path):
    sim, clock = build(tmp_path)
    call = booked_call(sim)
    call.hangup()
    clock.advance(minutes=30 * 60)
    sim.tick()
    assert sim.twilio_client.outbox == []
    assert [r["decision"] for r in consent_rows(sim, "booking_texts")] == ["no_answer"]


def test_voice_unclear_answer_is_no_and_the_turn_goes_on(tmp_path):
    sim, _ = build(tmp_path)
    call = booked_call(sim)
    turn = call.say("What should I do before the technician comes?")
    assert turn.text and turn.text != guard.CONSENT_YES_VOICE
    call.hangup()
    assert sim.twilio_client.outbox == []
    assert [r["decision"] for r in consent_rows(sim, "booking_texts")] == ["unclear"]


def test_sms_booking_asks_about_the_reminder_only(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    demo_raw["config"]["booking"]["lead_time_hours"] = 26
    sim.store.upsert_tenant(demo_raw)
    for line in ["Hi, my AC is blowing warm air", "77005", "The first one works", "My name is Dana Miller"]:
        clock.advance(minutes=1)
        sms(sim, line)
    reply = sms(sim, "2100 Rice Blvd, Houston 77005")
    assert "all set" in reply and reply.endswith(guard.SMS_CONSENT_Q_SMS) and len(reply) <= guard.SMS_REPLY_MAX
    assert sim.rt.outbound.jobs(sim.tenant("demo-hvac")) == []  # no reminder before the yes
    assert sms(sim, "nope") == guard.CONSENT_NO_SMS
    assert sim.rt.outbound.jobs(sim.tenant("demo-hvac")) == []
    assert [(r["channel"], r["decision"]) for r in consent_rows(sim, "booking_texts")] == [("sms", "no")]


def test_no_question_for_an_opted_out_number(tmp_path):
    sim, _ = build(tmp_path)
    sim.store.for_tenant(sim.tenant("demo-hvac").id).opt_out(harness.CALLER)
    call = sim.call()
    call.start()
    call.say(ASK)
    turn = call.say(PICK)
    assert "all set" in turn.text and guard.SMS_CONSENT_Q_VOICE not in turn.text


# --- 3. recording objection --------------------------------------------------------------------------------

@pytest.mark.parametrize("said", ["Don't record this call", "I don't consent to that", "Please stop recording",
                                  "I don't want to be recorded", "I'm not okay with being recorded"])
def test_recording_objection_ends_call_and_keeps_no_transcript(tmp_path, said):
    sim, _ = build(tmp_path)
    call = sim.call()
    call.start()
    call.say("My AC is broken, my name is Carlos Reyes")
    calls_before = sim.rt.engine.llm.calls
    turn = call.say(said)
    assert turn.text == guard.RECORDING_OBJECTION_TEXT and turn.end
    assert sim.rt.engine.llm.calls == calls_before                      # no Claude for the objection
    call.hangup()
    row = sim.store.select("calls")[0]
    assert row["transcript_withheld"] is True and row["outcome"] == "message"
    said_by_caller = [t for t in row["transcript"] if t["who"] == "customer"]
    assert said_by_caller == [] and row["transcript"][0]["who"] == "assistant" and DISCLOSURE in row["transcript"][0]["text"]
    assert "Carlos" not in str(row) and "Carlos" not in row["summary"]
    assert "lead" in [a["kind"] for a in sim.rt.alert_log]


def test_objection_detector_ignores_ordinary_words():
    for t in ["my recorder is broken", "can you record my address", "I agree", "the record player", "no problem"]:
        assert not guard.objects_to_recording(t), t


# --- 4. revocation by any reasonable means --------------------------------------------------------------------

@pytest.mark.parametrize("body", ["REVOKE", "opt out", "OPT-OUT", "Please stop texting me", "don't text me anymore",
                                  "remove me from your list", "I don't want any more texts", "Stop please",
                                  "unsubscribe me", "wrong number"])
def test_sms_revocation_words_and_sentences(tmp_path, body):
    sim, _ = build(tmp_path)
    first = sms(sim, body)
    assert "unsubscribed" in first and "Reply START" in first and "+17135550100" in first
    assert sms(sim, body) == ""                                          # one confirmation only
    assert sim.store.is_opted_out(sim.tenant("demo-hvac").id, harness.CALLER)
    assert sim.rt.engine.llm.calls == 0
    rows = consent_rows(sim, "opt_out")
    assert len(rows) == 1 and rows[0]["decision"] == "revoked" and rows[0]["evidence"] == body


@pytest.mark.parametrize("body", ["I need to cancel my appointment on Friday", "my AC stopped working",
                                  "please don't send anyone before noon", "Can you text me the address?"])
def test_ordinary_messages_are_not_revocations(tmp_path, body):
    sim, _ = build(tmp_path)
    assert guard.sms_keyword(body) is None
    sms(sim, body)
    assert not sim.store.is_opted_out(sim.tenant("demo-hvac").id, harness.CALLER)


def test_spoken_dont_text_me_opts_out_and_stops_the_textback(tmp_path):
    sim, clock = build(tmp_path)
    call = sim.call()
    call.start()
    assert call.say("Please don't text me, just call").text == guard.VOICE_NO_TEXT_TEXT
    call.hangup()
    clock.advance(minutes=5)
    sim.tick()
    assert sim.twilio_client.outbox == []
    rows = consent_rows(sim, "opt_out")
    assert [(r["channel"], r["decision"]) for r in rows] == [("voice", "revoked")]
    assert sim.store.is_opted_out(sim.tenant("demo-hvac").id, harness.CALLER)


def test_start_after_stop_is_logged(tmp_path):
    sim, _ = build(tmp_path)
    sms(sim, "STOP")
    assert "resubscribed" in sms(sim, "START")
    assert [r["consent_type"] for r in consent_rows(sim)] == ["opt_out", "opt_in"]


# --- 5. texting window in both time zones ----------------------------------------------------------------------

def test_area_code_time_zones():
    assert timezone_for("+12135550100") == "America/Los_Angeles"
    assert timezone_for("+17135550100") == "America/Chicago"
    assert timezone_for("+12125550100") == "America/New_York"
    assert timezone_for("+16025550100") == "America/Phoenix"
    assert timezone_for("+19995550100") is None and timezone_for("+442071234567") is None and timezone_for("") is None


def test_scheduled_window_checks_business_and_caller_zone():
    la = "+12135550100"
    mon_930 = datetime(2026, 10, 12, 9, 30, tzinfo=TZ)                     # 7:30 in Los Angeles
    assert guard.send_window_ok(CFG, mon_930, "", "scheduled")             # business zone alone: fine
    assert not guard.send_window_ok(CFG, mon_930, la, "scheduled")         # caller zone: too early
    nxt = guard.next_window(guard.window_zones(CFG.business.timezone, la), mon_930, "scheduled")
    assert nxt.astimezone(ZoneInfo("America/Los_Angeles")).hour == 9 and nxt.astimezone(TZ).hour == 11
    assert not guard.send_window_ok(CFG, datetime(2026, 10, 12, 20, 0, tzinfo=TZ), "", "scheduled")
    sun = datetime(2026, 10, 11, 11, 30, tzinfo=TZ)
    assert not guard.send_window_ok(CFG, sun, "", "scheduled") and guard.send_window_ok(CFG, sun + timedelta(hours=1), "", "scheduled")
    # unknown area code: business zone only
    assert guard.window_zones("America/Chicago", "+19995550100") == ["America/Chicago"]


def test_textback_window_is_8_to_21_in_both_zones():
    ny_caller = "+12125550100"
    chi_2030 = datetime(2026, 10, 12, 20, 30, tzinfo=TZ)                   # 21:30 in New York
    assert guard.send_window_ok(CFG, chi_2030, "", "textback")
    assert not guard.send_window_ok(CFG, chi_2030, ny_caller, "textback")
    assert guard.quiet_hours(CFG, chi_2030, ny_caller)


def test_textback_to_east_coast_caller_waits_for_their_morning(tmp_path):
    """Missed at 21:30 New York: outside the text-back window, so it becomes a queued message and waits for the
    scheduled window (09:00-20:00) in both zones (memo 02, R2-6): 09:00 Chicago = 10:00 New York."""
    late = datetime(2026, 10, 12, 20, 30, tzinfo=TZ)
    sim, clock = build(tmp_path, now=late)
    call = sim.call(caller="+12125550100")
    call.start()
    call.hangup(3)
    sim.tick()
    assert sim.twilio_client.outbox == []
    job = sim.rt.outbound.jobs(sim.tenant("demo-hvac"))[0]
    due = datetime.fromisoformat(job["due"])
    assert job["window"] == "scheduled"
    assert due.astimezone(TZ).hour == 9 and due.astimezone(ZoneInfo("America/New_York")).hour == 10


def test_queued_textback_is_dropped_if_the_caller_called_back(tmp_path):
    late = datetime(2026, 10, 12, 22, 30, tzinfo=TZ)
    sim, clock = build(tmp_path, now=late)
    call = sim.call()
    call.start()
    call.hangup(3)
    sim.tick()
    clock.advance(minutes=8 * 60)                                         # 06:30: calls again, hangs up again
    again = sim.call(call_sid="CA-again")
    again.start()
    again.hangup(3)
    clock.advance(minutes=3 * 60)                                         # 09:30: both queued jobs are due
    sim.tick()
    assert len(sim.twilio_client.outbox) == 1                            # only for the latest missed call
    reasons = [e["payload"].get("reason") for e in sim.store.select("events") if e["type"] == "sms.textback"]
    assert "called_back" in reasons


NY = ZoneInfo("America/New_York")


def ny(day, hour, minute=0):
    return datetime(2026, 10, day, hour, minute, tzinfo=NY)


def test_window_cases_business_new_york():
    zones = lambda caller: guard.window_zones("America/New_York", caller)  # noqa: E731
    # LA caller at 19:30 NY = 16:30 LA: inside the scheduled window
    assert guard.in_window(zones("+12135550100"), ny(13, 19, 30), "scheduled")
    # Hawaii caller at 09:30 NY = 03:30 HI: deferred until both zones are open (09:00 HI = 15:00 NY)
    hi = zones("+18085550100")
    assert not guard.in_window(hi, ny(13, 9, 30), "scheduled")
    assert guard.next_window(hi, ny(13, 9, 30), "scheduled") == ny(13, 15, 0)
    # Sunday 11:00 (Oct 11, 2026 is a Sunday): deferred until 12:00
    assert not guard.in_window(zones(""), ny(11, 11), "scheduled")
    assert guard.next_window(zones(""), ny(11, 11), "scheduled") == ny(11, 12)
    # unknown area code: business zone only
    assert zones("+19995550100") == ["America/New_York"]
    # missed call at 23:00: no text-back now; queued for the 09:00 scheduled window
    assert not guard.in_window(zones(""), ny(13, 23), "textback")
    assert guard.next_window(zones(""), ny(13, 23), "scheduled") == ny(14, 9)


def test_night_booking_confirmation_is_sent_right_away(tmp_path):
    """A yes at 22:30: the confirmation is the direct response to that yes, so it goes out at once; the reminder
    stays bound by the 09-20 window."""
    night = datetime(2026, 10, 11, 22, 30, tzinfo=TZ)
    sim, clock = build(tmp_path, now=night)
    call = sim.call()
    call.start()
    call.say("My AC is blowing warm air, zip 77002")
    assert "all set" in call.say("The morning one, my name is Ann Lee, 900 Main St Houston 77002").text
    call.say("Yes")
    call.hangup()
    assert [m["body"][:30] for m in sim.twilio_client.outbox] == ["Cool Breeze HVAC: you're booke"]
    t = sim.tenant("demo-hvac")
    assert sim.rt.outbound.send(t, harness.CALLER, "x", "reminder", night) == {"sent": False, "reason": "quiet_hours"}
    assert not [j for j in sim.rt.outbound.jobs(t) if j["kind"] == "confirmation"]


def test_confirmation_is_not_sent_to_a_landline_even_at_night(tmp_path):
    night = datetime(2026, 10, 12, 22, 0, tzinfo=TZ)
    sim, clock = build(tmp_path, now=night)
    t = sim.tenant("demo-hvac")
    sim.twilio_client.landlines.add(harness.CALLER)
    res = sim.rt.outbound.confirm_booking(t, harness.CALLER, {"start": "2026-10-13T14:00:00-05:00", "label": "Tue 2 PM",
                                                              "event_id": "e9"}, night)
    assert res == {"sent": False, "reason": "line_type:landline"} and sim.twilio_client.outbox == []


# --- 6. locked templates -----------------------------------------------------------------------------------

def test_textback_template_is_fixed_and_has_no_link(demo_raw):
    from app.tenants import load_record
    demo_raw["config"]["booking"]["booking_link"] = "https://calendly.com/promo"
    t = load_record(demo_raw)
    body = sms_outbound.textback_text(t)
    assert body == ("Hi, this is Cool Breeze HVAC. Sorry we missed your call! What can we help with? "
                    "Reply STOP to opt out.")
    for text in (body, sms_outbound.confirmation_text(t, {"label": "x"}), sms_outbound.reminder_text(t, {"label": "x"})):
        assert "Reply STOP to opt out." in text and "http" not in text and "%" not in text and "$" not in text


def test_textback_is_logged_in_the_consent_log(tmp_path):
    sim, clock = build(tmp_path)
    call = sim.call()
    call.start()
    call.hangup(3)
    sim.tick()
    rows = consent_rows(sim, "text_back")
    assert len(sim.twilio_client.outbox) == 1 and len(rows) == 1
    assert rows[0]["decision"] == "notice" and rows[0]["evidence"] == DISCLOSURE
    assert rows[0]["prompt_version"] == guard.DISCLOSURE_VERSION and rows[0]["call_sid"] == call.call_sid


def test_consent_record_rejects_unknown_values(tmp_path):
    from app.store import JsonStore, StoreError
    ts = JsonStore(tmp_path).for_tenant("t1")
    with pytest.raises(StoreError):
        ts.record_consent("+17135550123", "voice", "marketing", "yes")
