"""Call notice follows the SMS master switch (SMS_ENABLED, off at launch until A2P 10DLC is approved).

Off: the notice says AI assistant + recorded and transcribed by us and our service providers, and nothing about
texting (English and Spanish; default greetings, custom greetings, message mode, safe mode). On: the texting clause
("and we may text you about it") is spoken, because the missed-call text-back relies on it. The consent log stores
the variant the caller actually heard (text + version id), and the go-live greeting check works in both states.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from app import guard, message_mode, plans
from app.golive import run_checks
from app.tenants import load_record
from app.voice import greeting, has_disclosure
from app.voice_safe import safe_greeting
from sim import harness
from sim.fake_twilio import parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
NOW = datetime(2026, 11, 25, 15, 0, tzinfo=timezone.utc)
AI = "You're speaking with an AI assistant."
RECORDING = "This call may be recorded and transcribed by us and our service providers"


def build(tmp_path, mode="gather", **env):
    return harness.build(tmp_path, clock=harness.FakeClock(MON_9), VOICE_MODE=mode, **env)


def greeting_heard(sim, slug="demo-hvac"):
    _, r = sim.twilio.start_call(sim.tenant(slug).twilio_number, harness.CALLER)
    return parse_twiml(r.text).text


# --- the two sentences ------------------------------------------------------------------------------------------

def test_no_sms_notice_has_no_texting_clause_in_either_language():
    assert guard.DISCLOSURE_NO_SMS == f"{AI} {RECORDING}."
    assert guard.DISCLOSURE_SMS == f"{AI} {RECORDING}, and we may text you about it."
    assert "text" not in guard.DISCLOSURE_NO_SMS.lower()
    assert "texto" not in guard.DISCLOSURE_ES_NO_SMS and "mensajes" not in guard.DISCLOSURE_ES_NO_SMS
    assert guard.DISCLOSURE_ES_SMS.endswith("y podemos enviarle mensajes de texto.")
    assert guard.DISCLOSURE_ES_NO_SMS == ("Está hablando con un asistente de IA (inteligencia artificial). Esta llamada "
                                          "puede ser grabada y transcrita por nosotros y nuestros proveedores de servicio.")
    assert guard.disclosure(False) == guard.DISCLOSURE_NO_SMS and guard.disclosure(True) == guard.DISCLOSURE_SMS
    assert guard.disclosure_es(False) == guard.DISCLOSURE_ES_NO_SMS and guard.disclosure_es(True) == guard.DISCLOSURE_ES_SMS
    assert guard.disclosure_version(True) == "2026-11-27" and guard.disclosure_version(False) == "2026-11-27-nosms"


# --- what the caller hears ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("mode", ["stream", "gather"])
def test_default_greeting_without_texting_when_sms_is_off(tmp_path, mode):
    text = greeting_heard(build(tmp_path, mode, SMS_ENABLED="0"))
    assert text == f"Thanks for calling Cool Breeze HVAC. {guard.DISCLOSURE_NO_SMS} How can I help?"
    assert "text" not in text.lower()


@pytest.mark.parametrize("mode", ["stream", "gather"])
def test_default_greeting_keeps_the_texting_clause_when_sms_is_on(tmp_path, mode):
    text = greeting_heard(build(tmp_path, mode, SMS_ENABLED="1"))
    assert text == f"Thanks for calling Cool Breeze HVAC. {guard.DISCLOSURE_SMS} How can I help?"


def test_spanish_line_without_texting_when_sms_is_off(tmp_path, demo_raw):
    demo_raw["config"]["voice"]["languages"] = ["en", "es"]
    sim = build(tmp_path, SMS_ENABLED="0")
    t = sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(t.twilio_number, harness.CALLER)
    text = parse_twiml(r.text).text
    assert guard.DISCLOSURE_NO_SMS in text and guard.DISCLOSURE_ES_NO_SMS in text
    assert "text" not in text.lower().replace("texto", "") and "mensajes de texto" not in text
    on = greeting(load_record(demo_raw), sms=True)
    assert guard.DISCLOSURE_SMS in on and guard.DISCLOSURE_ES_SMS in on


def test_custom_greeting_without_texting_is_complete_only_while_sms_is_off(tmp_path, demo_raw):
    custom = f"Hello from Cool Breeze. {guard.DISCLOSURE_NO_SMS}"
    assert has_disclosure(custom) and has_disclosure(custom, sms=False) and not has_disclosure(custom, sms=True)
    demo_raw["config"]["voice"]["greeting"] = custom
    off = build(tmp_path / "off", SMS_ENABLED="0")
    off.store.upsert_tenant(copy.deepcopy(demo_raw))
    assert greeting_heard(off) == custom  # used as written
    on = build(tmp_path / "on", SMS_ENABLED="1")
    on.store.upsert_tenant(copy.deepcopy(demo_raw))
    assert greeting_heard(on) == f"{custom} {guard.DISCLOSURE_SMS}"  # texting on: the full notice is added


@pytest.mark.parametrize("sms", [True, False])
def test_message_mode_and_safe_mode_follow_the_switch(sms):
    for g in (message_mode.greeting("Acme", sms=sms), safe_greeting("Acme", sms=sms)):
        assert AI in g and RECORDING in g
        assert ("text you" in g) is sms
    assert "text" not in message_mode.greeting("Acme") and "text" not in safe_greeting("Acme")  # default: launch (off)


@pytest.mark.parametrize("sms", ["0", "1"])
def test_message_mode_call_follows_the_switch(tmp_path, demo_raw, sms):
    from test_firstring_plans import FIXTURE, with_plan
    plans.set_catalog(FIXTURE, {"trial_minutes": 100})
    try:
        raw = with_plan(demo_raw, status="canceled", service="message_only", service_reason="canceled")
        s = harness.build(tmp_path, SMS_ENABLED=sms)
        rec = s.store.upsert_tenant(load_record(raw))
        first = s.call(rec.slug).start()
    finally:
        plans.set_catalog(None)
    assert "can't take your call live" in first.text
    assert guard.disclosure(sms == "1") in first.text and ("text you" in first.text) is (sms == "1")


@pytest.mark.parametrize("sms", ["0", "1"])
def test_safe_mode_call_follows_the_switch(tmp_path, demo_raw, sms):
    sim = build(tmp_path, SMS_ENABLED=sms)
    row = sim.store.select("tenants", slug="demo-hvac")[0]
    sim.store.update("tenants", row["id"], {"config": {**demo_raw["config"], "hours": {"mon": ["9", "5"]}}})  # invalid
    first = sim.call().start()
    assert guard.disclosure(sms == "1") in first.text and "Sorry we missed you" in first.text
    assert ("text you" in first.text) is (sms == "1")


# --- consent log -------------------------------------------------------------------------------------------------

def test_textback_consent_row_names_the_texting_variant_that_was_heard(tmp_path):
    sim = build(tmp_path, SMS_ENABLED="1")
    call = sim.call()
    call.start()
    call.hangup(3)
    sim.tick()
    rows = [r for r in sim.store.select("sms_consent") if r["consent_type"] == "text_back"]
    assert len(rows) == 1
    assert rows[0]["evidence"] == guard.DISCLOSURE_SMS and rows[0]["prompt_version"] == guard.DISCLOSURE_VERSION


def test_spoken_disclosure_reads_the_variant_from_the_stored_greeting():
    off = f"Thanks for calling Acme. {guard.DISCLOSURE_NO_SMS} How can I help?"
    on = f"Thanks for calling Acme. {guard.DISCLOSURE_SMS} How can I help?"
    # the switch was flipped after the greeting played: the record follows what the caller heard
    assert guard.spoken_disclosure(off, sms=True) == (guard.DISCLOSURE_NO_SMS, "2026-11-27-nosms")
    assert guard.spoken_disclosure(on, sms=False) == (guard.DISCLOSURE_SMS, "2026-11-27")
    assert guard.spoken_disclosure(None, sms=True) == (guard.DISCLOSURE_SMS, "2026-11-27")  # no stored greeting
    assert guard.call_greeting({"transcript": [{"who": "assistant", "text": on}]}) == on
    assert guard.call_greeting({"transcript": [{"who": "customer", "text": "hi"}]}) is None
    assert guard.call_greeting({"transcript": "not a list"}) is None and guard.call_greeting(None) is None


# --- go-live greeting check ----------------------------------------------------------------------------------------

def _greeting_check(rep):
    return next(c for c in rep["checks"] if c["name"] == "greeting")


@pytest.mark.parametrize("sms", [True, False])
def test_golive_greeting_check_passes_the_default_greeting_in_both_states(demo_raw, sms):
    assert _greeting_check(run_checks(copy.deepcopy(demo_raw), now=NOW, sms=sms))["ok"] is True


def test_golive_flags_a_custom_greeting_that_promises_texts_while_sms_is_off(demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["voice"]["greeting"] = f"Hello from Cool Breeze HVAC. {guard.DISCLOSURE_SMS}"
    off = _greeting_check(run_checks(copy.deepcopy(raw), now=NOW, sms=False))
    assert off["ok"] is False and "texting" in off["detail"]
    assert _greeting_check(run_checks(copy.deepcopy(raw), now=NOW, sms=True))["ok"] is True
