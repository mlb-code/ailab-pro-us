"""10DLC: `business.sms_display_name` replaces the business name in every outbound SMS; voice and e-mail keep
`business.name`. Absent = the old behaviour (business.name everywhere)."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

import jsonschema
import pytest

from app import guard, sms_outbound
from app.notify import templates as T
from app.tenants import SCHEMA_PATH, TenantConfigError, load_record, sms_business_name
from sim import harness
from sim.fake_twilio import parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
MON_10 = datetime(2026, 10, 12, 10, 0, tzinfo=TZ)
VOICE_NAME = "Copperleaf Air & Plumbing"
SMS_NAME = "AI Lab Pro demo (Copperleaf Air & Plumbing)"
LABEL = "Tue Oct 20, 10:00 AM"


def demo(demo_raw, sms_name=SMS_NAME):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["business"]["name"] = VOICE_NAME
    if sms_name is not None:
        raw["config"]["business"]["sms_display_name"] = sms_name
    return raw


def build(tmp_path, raw, now=MON_9):
    sim = harness.build(tmp_path, clock=harness.FakeClock(now), VOICE_MODE="gather")
    sim.store.upsert_tenant(raw)
    return sim


def text(sim, body):
    r = sim.twilio.sms(sim.tenant("demo-hvac").twilio_number, harness.CALLER, body)
    assert r.status_code == 200
    return parse_twiml(r.text).text


def gsm7(s: str) -> bool:
    return all(ord(ch) < 128 for ch in s)


# --- helper + validation ----------------------------------------------------------------------------------

def test_helper_falls_back_to_business_name(demo_raw):
    with_name, without = load_record(demo(demo_raw)), load_record(demo(demo_raw, sms_name=None))
    assert sms_business_name(with_name) == sms_business_name(with_name.config) == SMS_NAME
    assert sms_business_name(without) == VOICE_NAME and without.config.business.sms_display_name is None
    assert sms_business_name(load_record(demo_raw)) == "Cool Breeze HVAC"  # the untouched fixture


@pytest.mark.parametrize("bad", ["", "x" * 81, 7])
def test_invalid_display_name_is_rejected_by_model_and_schema(demo_raw, bad):
    raw = demo(demo_raw, sms_name=bad)
    with pytest.raises(TenantConfigError):
        load_record(raw)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(raw["config"], json.loads(SCHEMA_PATH.read_text()))


def test_display_name_is_accepted_by_the_schema(demo_raw):
    jsonschema.validate(demo(demo_raw)["config"], json.loads(SCHEMA_PATH.read_text()))


# --- the locked templates ---------------------------------------------------------------------------------

def test_templates_with_display_name(demo_raw):
    t = load_record(demo(demo_raw))
    phone = t.config.business.main_phone
    texts = {
        "textback": sms_outbound.textback_text(t),
        "confirmation": sms_outbound.confirmation_text(t, {"label": LABEL}),
        "reminder": sms_outbound.reminder_text(t, {"label": LABEL}),
        "help": guard.help_text(sms_business_name(t), phone),
        "stop": guard.stop_confirmation(sms_business_name(t), phone),
        "start": guard.start_confirmation(sms_business_name(t)),
    }
    assert texts["textback"] == (f"Hi, this is {SMS_NAME}. Sorry we missed your call! What can we help with? "
                                 "Reply STOP to opt out.")
    for kind, body in texts.items():
        assert SMS_NAME in body and gsm7(body), kind
        # The STOP confirmation names the appointment phone and was already 2 segments with the bare Copperleaf name
        # (162 chars); on the 10DLC line Twilio Advanced Opt-Out answers STOP itself (OptOutType -> no reply from us).
        assert guard.sms_segments(body) == (2 if kind == "stop" else 1), (kind, len(body))


def test_confirmation_and_reminder_stay_one_segment_with_the_longest_label(demo_raw):
    from app.calendar.base import label
    t = load_record(demo(demo_raw))
    longest = label(datetime(2026, 10, 21, 10, 30, tzinfo=TZ), datetime(2026, 10, 21, 12, 30, tzinfo=TZ))
    assert longest == "Wednesday Oct 21, 10:30 AM to 12:30 PM"
    for body in (sms_outbound.confirmation_text(t, {"label": longest}), sms_outbound.reminder_text(t, {"label": longest})):
        assert SMS_NAME in body and guard.sms_segments(body) == 1, len(body)


def test_templates_without_display_name_use_the_business_name(demo_raw):
    t = load_record(demo(demo_raw, sms_name=None))
    assert sms_outbound.textback_text(t) == (f"Hi, this is {VOICE_NAME}. Sorry we missed your call! "
                                             "What can we help with? Reply STOP to opt out.")
    assert sms_outbound.confirmation_text(t, {"label": LABEL}).startswith(f"{VOICE_NAME}: you're booked")
    assert sms_outbound.reminder_text(t, {"label": LABEL}).startswith(f"{VOICE_NAME}: reminder")


# --- end to end in the simulator ----------------------------------------------------------------------------

@pytest.mark.parametrize("sms_name, expected", [(SMS_NAME, SMS_NAME), (None, VOICE_NAME)])
def test_help_and_missed_call_text(tmp_path, demo_raw, sms_name, expected):
    sim = build(tmp_path, demo(demo_raw, sms_name=sms_name))
    help_reply = text(sim, "HELP")
    assert help_reply.startswith(f"{expected} virtual assistant.") and "Reply STOP" in help_reply
    assert text(sim, "STOP").startswith(f"{expected}: you're unsubscribed")
    assert text(sim, "START") == f"{expected}: you're resubscribed. Reply STOP to opt out."

    call = sim.call(caller="+17135550177")
    first = call.start()
    assert f"Thanks for calling {VOICE_NAME}." in first.text  # voice keeps the business name
    if sms_name:
        assert SMS_NAME not in first.text
    call.hangup(3)
    sim.tick()
    bodies = [m["body"] for m in sim.twilio_client.outbox]
    assert bodies == [f"Hi, this is {expected}. Sorry we missed your call! What can we help with? Reply STOP to opt out."]
    assert len(bodies[0]) <= 160


def test_robot_question_by_text_uses_display_name_but_not_on_voice(demo_raw):
    cfg = load_record(demo(demo_raw)).config
    assert SMS_NAME in guard.check_reply("Yes, I'm a real person.", cfg, "sms").text
    voice = guard.check_reply("Yes, I'm a real person.", cfg, "voice").text
    assert VOICE_NAME in voice and SMS_NAME not in voice


def test_robot_question_by_sms_conversation(tmp_path, demo_raw):
    sim = build(tmp_path, demo(demo_raw))
    assert SMS_NAME in text(sim, "Are you a robot?")


# --- safe mode (stored config does not validate) ---------------------------------------------------------

def test_safe_mode_sms_use_display_name(tmp_path, demo_raw):
    raw = demo(demo_raw)
    sim = harness.build(tmp_path, clock=harness.FakeClock(MON_10), VOICE_MODE="gather")
    row = sim.store.select("tenants", slug="demo-hvac")[0]
    sim.store.update("tenants", row["id"], {"config": {**raw["config"], "hours": {"mon": ["9", "5"]}}})
    num = demo_raw["twilio_number"]

    def sms(body):
        return parse_twiml(sim.twilio.sms(num, harness.CALLER, body).text).text
    assert sms("HELP").startswith(f"{SMS_NAME} virtual assistant.")
    assert sms("STOP").startswith(f"{SMS_NAME}: you're unsubscribed")
    assert sms("START").startswith(f"{SMS_NAME}: you're resubscribed")
    call = sim.call(caller="+17135550177")
    assert f"Thanks for calling {VOICE_NAME}." in call.start().text
    call.hangup(3)
    assert [m["body"][:len(SMS_NAME) + 12] for m in sim.twilio_client.outbox] == [f"Hi, this is {SMS_NAME}"]


# --- owner SMS alerts (sent from the tenant's number too) --------------------------------------------------

def test_owner_sms_templates_use_display_name_email_keeps_name():
    a = {"kind": "usage_80", "usage_kind": "voice_minutes", "used": 320, "included": 400}
    _, text_, _, sms = T.usage_owner(VOICE_NAME, a, sms_business=SMS_NAME)
    assert sms.startswith(f"{SMS_NAME}: 80%") and VOICE_NAME in text_ and SMS_NAME not in text_
    assert T.usage_owner(VOICE_NAME, a)[3].startswith(f"{VOICE_NAME}: 80%")


def test_owner_calendar_sms_through_the_notifier(tmp_path, demo_raw):
    from test_b6_notify import Ctx
    ctx = Ctx(tmp_path, demo(demo_raw))
    ctx.notifier.calendar_alert(ctx.tenant, {"provider": "google", "summary": "token revoked"}, now=MON_9)
    assert [m["body"][:len(SMS_NAME) + 1] for m in ctx.twilio.outbox] == [f"{SMS_NAME}:"]
