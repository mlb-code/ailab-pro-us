"""Launch fixes (2026-11-27, legal review + promise-vs-reality audit), before the first paying customer:

1. AI disclosure: the fixed call notice says "AI assistant" (Spanish: "IA"), a client greeting without the AI wording
   gets the notice added, and "are you a person?" gets a direct "I'm an AI assistant, not a person" (all voice modes,
   message mode, safe mode).
2. SMS master switch `SMS_ENABLED` (off by default in production): no outbound SMS anywhere, no texting-consent
   question or text promise on the call, owner alerts by e-mail only, inbound texts get no reply; /health shows it.
4. Recording objection: webhooks / Zapier / CRM carry only name + phone, flagged `recording_declined`.
"""
from __future__ import annotations

import json
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app import guard, message_mode, settings as settings_mod
from app.crm.base import build_lead
from app.notify import Notifier, NotifyPolicy, TwilioSms
from app.notify.core import lead_from
from app.store import JsonStore, StateStore
from app.tenants import load_file, load_record
from app.voice import greeting, has_disclosure
from app.voice_safe import safe_greeting
from sim import harness
from sim.fake_twilio import FakeTwilioClient, parse_twiml

DISCLOSURE = guard.DISCLOSURE_SMS  # the simulator runs with SMS_ENABLED on unless a test switches it off
TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
ASK = "My furnace stopped working, I'm in 77019"
PICK = "The afternoon one please, this is Carlos Reyes at 45 Westheimer Rd Houston 77019"
TEXT_PROMISE = ("text your confirmation", "I'll text", "text you", "reminder")


def build(tmp_path, mode="gather", now=MON_9, **env):
    clock = harness.FakeClock(now)
    return harness.build(tmp_path, clock=clock, VOICE_MODE=mode, **env), clock


def zaps(sim, event):
    return [e["payload"] for e in sim.store.select("events") if e["type"] == "zapier.pending"
            and e["payload"]["event"] == event]


# --- 1. AI disclosure ------------------------------------------------------------------------------------------

@pytest.mark.parametrize("sms", [True, False])
def test_disclosure_says_ai_assistant_in_english_and_ia_in_spanish(sms):
    en, es = guard.disclosure(sms), guard.disclosure_es(sms)
    assert en.startswith("You're speaking with an AI assistant. ")
    assert "recorded and transcribed by us and our service providers" in en  # the recording notice stays
    assert es.startswith("Está hablando con un asistente de IA (inteligencia artificial). ")
    assert "grabada y transcrita" in es
    assert guard.DISCLOSURE_VERSION == "2026-11-27"  # consent-log rows that rely on the new notice say which one


def test_robot_answer_is_direct():
    assert guard.robot_answer("Cool Breeze HVAC") == ("I'm an AI assistant, not a person. I work for Cool Breeze HVAC "
                                                      "and can get you booked or take a message for the team.")
    assert guard.robot_answer_es("X").startswith("Soy un asistente de IA (inteligencia artificial), no una persona.")


@pytest.mark.parametrize("text", [
    "Thanks for calling Cool Breeze. Calls are recorded and transcribed by our service providers, and we may text you.",
    "Thanks for calling AI Plumbing. Calls are recorded and transcribed by our service providers, and we may text you.",
    "Hi, I'm the virtual assistant. Calls are recorded and transcribed by our service providers, and we may text you.",
])
def test_greeting_without_ai_wording_is_not_a_disclosure(text):
    assert not has_disclosure(text) and not has_disclosure(text, sms=True)


@pytest.mark.parametrize("mode", ["stream", "gather"])
def test_client_greeting_without_ai_gets_the_standard_notice_in_both_voice_modes(tmp_path, demo_raw, mode):
    custom = "Thanks for calling Cool Breeze. Calls are recorded and transcribed by our service providers, and we may text you."
    demo_raw["config"]["voice"]["greeting"] = custom
    sim, _ = build(tmp_path, mode)
    t = sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    assert parse_twiml(r.text).text == f"{custom} {DISCLOSURE}"


@pytest.mark.parametrize("mode", ["stream", "gather"])
def test_default_greeting_says_ai_once_in_both_voice_modes(tmp_path, mode):
    sim, _ = build(tmp_path, mode)
    _, r = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, harness.CALLER)
    text = parse_twiml(r.text).text
    assert text == f"Thanks for calling Cool Breeze HVAC. {DISCLOSURE} How can I help?"


@pytest.mark.parametrize("sms", [True, False])
def test_spanish_greeting_carries_the_ia_notice(demo_raw, sms):
    demo_raw["config"]["voice"]["languages"] = ["en", "es"]
    g = greeting(load_record(demo_raw), sms=sms)
    assert guard.disclosure(sms) in g and guard.disclosure_es(sms) in g and "asistente de IA" in g


@pytest.mark.parametrize("sms", [True, False])
def test_message_mode_and_safe_mode_greetings_say_ai(sms):
    for g in (message_mode.greeting("Acme", sms=sms), safe_greeting("Acme", sms=sms)):
        assert guard.disclosure(sms) in g and "AI assistant" in g


@pytest.mark.parametrize("mode", ["stream", "gather"])
@pytest.mark.parametrize("question", ["Are you a real person?", "Am I talking to a human?", "Are you a robot?"])
def test_are_you_a_person_gets_ai_not_a_person(tmp_path, mode, question):
    sim, _ = build(tmp_path, mode)
    call = sim.call()
    call.start()
    calls = sim.rt.engine.llm.calls
    turn = call.say(question)
    assert turn.text.startswith("I'm an AI assistant, not a person.") and sim.rt.engine.llm.calls == calls
    call.hangup()


def test_chat_box_greeting_keeps_the_ai_line_and_drops_the_phone_notice(tmp_path):
    from app.chat_widget import greeting as chat_greeting
    sim, _ = build(tmp_path)
    g = chat_greeting(sim.tenant("demo-hvac"))
    assert g == "Welcome to Cool Breeze HVAC. I'm an AI assistant. How can I help?"


def test_prompts_tell_the_model_to_say_ai_not_a_person():
    from app import brain
    cfg = load_file(harness.TENANTS_DIR / "demo-hvac.json").config
    for channel in ("voice", "sms", "chat"):
        p = brain.system_prompt(cfg, channel)
        assert "AI assistant, not a person" in p and "virtual assistant for" not in p and "Never promise" in p


# --- 2. SMS master switch --------------------------------------------------------------------------------------

def test_sms_enabled_defaults_off_in_production_and_shows_in_health():
    prod = settings_mod.load({"RUNTIME_MODE": "prod"})
    assert prod.sms_enabled is False and prod.public()["sms_enabled"] is False
    assert settings_mod.load({"RUNTIME_MODE": "prod", "SMS_ENABLED": "1"}).sms_enabled is True
    assert settings_mod.load({"RUNTIME_MODE": "prod", "SMS_ENABLED": "off"}).sms_enabled is False
    assert settings_mod.load({"RUNTIME_MODE": "sim"}).sms_enabled is True        # fake Twilio: nothing leaves
    assert settings_mod.load({"RUNTIME_MODE": "sim", "SMS_ENABLED": "0"}).sms_enabled is False


def test_health_reports_the_switch_as_a_boolean(tmp_path):
    sim, _ = build(tmp_path, SMS_ENABLED="0")
    body = sim.client.get("/health").json()
    assert body["sms_enabled"] is False
    sim2, _ = build(tmp_path / "on")
    assert sim2.client.get("/health").json()["sms_enabled"] is True


@pytest.mark.parametrize("mode", ["stream", "gather"])
def test_sms_off_booking_call_never_asks_or_promises_a_text(tmp_path, demo_raw, mode):
    sim, clock = build(tmp_path, mode, SMS_ENABLED="0")
    demo_raw["config"]["booking"]["lead_time_hours"] = 26  # a visit tomorrow: with SMS on a reminder would be queued
    sim.store.upsert_tenant(demo_raw)
    call = sim.call()
    call.start()
    call.say(ASK)
    turn = call.say(PICK)
    assert "all set" in turn.text and guard.SMS_CONSENT_Q_VOICE not in turn.text
    assert not any(p in turn.text for p in TEXT_PROMISE)
    call.hangup()
    clock.advance(minutes=30 * 60)
    sim.tick()
    assert sim.twilio_client.outbox == []
    assert sim.rt.outbound.jobs(sim.tenant("demo-hvac")) == []
    assert [r for r in sim.store.select("sms_consent") if r["consent_type"] == "booking_texts"] == []
    assert len(sim.store.select("bookings")) == 1  # the booking itself stands


def test_sms_off_abandoned_call_queues_no_textback(tmp_path):
    sim, clock = build(tmp_path, SMS_ENABLED="0")
    call = sim.call()
    call.start()
    call.hangup(3)
    clock.advance(minutes=60)
    sim.tick()
    t = sim.tenant("demo-hvac")
    assert sim.twilio_client.outbox == [] and sim.rt.outbound.jobs(t) == []
    assert any(e["type"] == "sms.not_queued" and e["payload"]["reason"] == "sms_disabled" for e in sim.store.select("events"))


def test_sms_off_outbound_send_refuses(tmp_path):
    sim, _ = build(tmp_path, SMS_ENABLED="0")
    t = sim.tenant("demo-hvac")
    assert sim.rt.outbound.send(t, harness.CALLER, "hi", "confirmation", MON_9, direct_reply=True) == \
        {"sent": False, "reason": "sms_disabled"}
    assert sim.rt.outbound.send(t, "+17135550111", "alert", "staff_alert", MON_9)["reason"] == "sms_disabled"
    assert sim.twilio_client.outbox == []


def test_sms_off_dispatch_staff_alerts_are_voice_calls(tmp_path, demo_raw):
    demo_raw["config"]["dispatch"] = {"enabled": True, "sms_alerts": True,
                                      "contacts": [{"id": "tom", "name": "Tom", "phone": "+17135550155"}]}
    sim, _ = build(tmp_path, SMS_ENABLED="0", DISPATCH_SMS_ALERTS="1")
    assert sim.rt.dispatcher.sms_enabled(sim.store.upsert_tenant(demo_raw)) is False
    sim_on, _ = build(tmp_path / "on", DISPATCH_SMS_ALERTS="1")
    assert sim_on.rt.dispatcher.sms_enabled(sim_on.store.upsert_tenant(demo_raw)) is True


def sms_in(sim, body, frm=harness.CALLER):
    number = sim.store.select("tenants", slug="demo-hvac")[0]["twilio_number"]  # works for an invalid config too
    r = sim.twilio.sms(number, frm, body)
    assert r.status_code == 200
    return parse_twiml(r.text).text


def test_sms_off_inbound_text_gets_no_reply_but_the_owner_hears_about_it(tmp_path):
    sim, _ = build(tmp_path, SMS_ENABLED="0")
    calls = sim.rt.engine.llm.calls
    assert sms_in(sim, "Hi, my AC is blowing warm air") == ""
    assert sim.rt.engine.llm.calls == calls  # no Claude
    leads = [a for a in sim.rt.alert_log if a["kind"] == "lead"]
    assert len(leads) == 1 and "texting is off" in leads[0]["summary"] and "warm air" in leads[0]["summary"]
    inbound = [m for m in sim.store.select("sms_messages") if m["direction"] == "inbound"]
    outbound = [m for m in sim.store.select("sms_messages") if m["direction"] == "outbound"]
    assert len(inbound) == 1 and outbound == [] and sim.twilio_client.outbox == []


@pytest.mark.parametrize("body", ["STOP", "please stop texting me"])
def test_sms_off_opt_outs_are_still_recorded_silently(tmp_path, body):
    sim, _ = build(tmp_path, SMS_ENABLED="0")
    assert sms_in(sim, body) == ""
    ts = sim.store.for_tenant(sim.tenant("demo-hvac").id)
    assert ts.is_opted_out(harness.CALLER)
    assert sms_in(sim, "START") == "" and not ts.is_opted_out(harness.CALLER)
    assert sms_in(sim, "HELP") == "" and sim.twilio_client.outbox == []
    assert not [a for a in sim.rt.alert_log if a["kind"] == "lead"]  # keywords are not leads


def broken(tmp_path, demo_raw, **env):
    sim, clock = build(tmp_path, **env)
    row = sim.store.select("tenants", slug="demo-hvac")[0]
    sim.store.update("tenants", row["id"], {"config": {**demo_raw["config"], "hours": {"mon": ["9", "5"]}}})
    return sim, clock


def test_sms_off_safe_mode_sends_no_textback_and_no_reply(tmp_path, demo_raw):
    sim, _ = broken(tmp_path, demo_raw, SMS_ENABLED="0")
    call = sim.call()
    first = call.start()
    assert guard.DISCLOSURE_NO_SMS in first.text and "text" not in first.text  # texting off: no texting notice
    call.hangup(3)
    assert sim.twilio_client.outbox == []
    assert sms_in(sim, "is anyone there?") == ""
    assert sms_in(sim, "STOP") == ""
    assert sim.store.for_tenant(sim.store.select("tenants", slug="demo-hvac")[0]["id"]).is_opted_out(harness.CALLER)
    assert not [m for m in sim.store.select("sms_messages") if m["direction"] == "outbound"]


class RecEmail:
    name = "rec"

    def __init__(self):
        self.sent = []

    def send(self, msg, idem):
        self.sent.append(msg)
        return {"ok": True, "id": f"em{len(self.sent)}"}


def notifier(tmp_path, demo_raw, sms_enabled, account_email=None, **notify):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["notify"].update(notify)
    raw["client_id"] = "client-1"
    store = JsonStore(tmp_path)
    store.account_email = lambda cid: account_email  # production: RPC runtime_account_email
    tenant = store.upsert_tenant(load_record(raw))
    email, tw = RecEmail(), FakeTwilioClient()
    n = Notifier(store, StateStore(store), email, TwilioSms(tw), None,
                 NotifyPolicy(sms_enabled=sms_enabled, admin_email="meir@example.com", admin_tz="UTC"),
                 clock=lambda: datetime(2026, 10, 12, 14, 0, tzinfo=ZoneInfo("UTC")))
    return n, tenant, email, tw


ALERT = {"type": "alert", "kind": "lead", "summary": "Caller needs a callback", "urgency": "normal",
         "contact": harness.CALLER, "channel": "voice", "convo_id": "CA1"}


def test_sms_off_owner_alert_goes_by_email_only(tmp_path, demo_raw):
    n, tenant, email, tw = notifier(tmp_path, demo_raw, sms_enabled=False)
    out = n.deliver(tenant, [ALERT])
    assert tw.outbox == [] and [m.to for m in email.sent] == [("owner@example.com",)]
    assert {"channel": "sms", "tag": "lead_alert", "status": "skipped", "reason": "sms_disabled"} in out
    n2, tenant2, _e, tw2 = notifier(tmp_path / "on", demo_raw, sms_enabled=True)
    n2.deliver(tenant2, [ALERT])
    assert [m["to"] for m in tw2.outbox] == ["+17135550111"]  # with SMS on the owner SMS still goes out


def test_sms_off_owner_with_sms_only_gets_the_lead_at_the_account_email(tmp_path, demo_raw):
    n, tenant, email, tw = notifier(tmp_path, demo_raw, sms_enabled=False, account_email="acct@example.com", email=[])
    n.deliver(tenant, [ALERT])
    assert tw.outbox == [] and [m.to for m in email.sent] == [("acct@example.com",)]
    assert email.sent[0].tag == "lead_alert"


def test_sms_off_owner_with_no_email_at_all_alerts_meir_without_caller_details(tmp_path, demo_raw):
    n, tenant, email, tw = notifier(tmp_path, demo_raw, sms_enabled=False, account_email=None, email=[])
    n.deliver(tenant, [ALERT])
    assert tw.outbox == [] and [m.to for m in email.sent] == [("meir@example.com",)]
    assert harness.CALLER not in email.sent[0].text and "no alert e-mail" in email.sent[0].text


# --- 4. recording objection: name + phone only leave -------------------------------------------------------------

def test_objection_after_details_sends_only_name_and_phone(tmp_path):
    sim, _ = build(tmp_path)
    tenant = sim.tenant("demo-hvac")
    call = sim.call()
    call.start()
    call.say("My AC is broken")
    # what the tools collected before the objection (name, address, job, e-mail) and a message already taken
    c = sim.rt.engine.find_convo(tenant, "voice", call.call_sid)
    c.collect(name="Carlos Reyes", address="45 Westheimer Rd Houston 77019", job_type="AC repair",
              email="carlos@example.com", zip="77019")
    c.message = {"summary": "AC blowing warm air, elderly mother at home", "urgency": "normal", "name": "Carlos Reyes",
                 "address": "45 Westheimer Rd Houston 77019", "job_type": "AC repair"}
    c.meta["lead"] = {"timeline": "asap"}
    sim.rt.engine.save_convo(c)
    turn = call.say("Please don't record this call")
    assert turn.text == guard.RECORDING_OBJECTION_TEXT and turn.end
    call.hangup()
    saved = sim.rt.engine.find_convo(tenant, "voice", call.call_sid)
    assert saved.collected == {"name": "Carlos Reyes"} and "lead" not in saved.meta
    assert saved.message == {"summary": guard.RECORDING_DECLINED_SUMMARY, "urgency": "normal", "name": "Carlos Reyes"}
    raw_state = json.dumps(sim.store.select("runtime_state", key=f"convo:{tenant.id}:voice:{call.call_sid}"))
    for secret in ("Westheimer", "AC repair", "carlos@example.com", "elderly", "77019", "asap"):
        assert secret not in raw_state
    lead = zaps(sim, "lead.created")
    assert len(lead) == 1
    p = lead[0]
    assert p["contact"] == harness.CALLER and p["name"] == "Carlos Reyes" and p["recording_declined"] is True
    assert p["summary"] == guard.RECORDING_DECLINED_SUMMARY
    assert not {"address", "job_type", "email", "qualification"} & set(p)
    done = zaps(sim, "call.completed")
    assert done and "Westheimer" not in json.dumps(done) and "AC repair" not in json.dumps(done)
    # CRM sync builds its lead from the stored conversation: name + phone + flag only
    crm = build_lead(sim.rt.state, tenant, {**p, "convo_id": call.call_sid, "channel": "voice"})
    assert crm["name"] == "Carlos Reyes" and crm["phone"] == harness.CALLER and crm["recording_declined"] is True
    assert crm["address"] == "" and crm["job_type"] == "" and crm["email"] == "" and "qualification" not in crm
    assert crm["summary"] == guard.RECORDING_DECLINED_SUMMARY


def test_lead_from_a_withheld_conversation_is_minimal():
    convo = SimpleNamespace(booking={"name": "Dana", "address": "1 Main St", "job_type": "AC", "start": "2026-10-12T12:00",
                                     "end": "2026-10-12T16:00"},
                            message={"summary": "long story", "address": "1 Main St"}, collected={"email": "d@x.co"},
                            meta={"transcript_withheld": True, "lead": {"budget": "1M"}}, contact=harness.CALLER,
                            channel="voice", urgency="normal", transcript=[{"who": "customer", "text": "secret"}])
    lead = lead_from(convo)
    assert lead["name"] == "Dana" and lead["phone"] == harness.CALLER and lead["recording_declined"] is True
    assert lead["address"] == lead["job_type"] == lead["email"] == "" and lead["qualification"] == {}
    assert lead["transcript"] == [] and lead["summary"] == guard.RECORDING_DECLINED_SUMMARY and "booking" not in lead
