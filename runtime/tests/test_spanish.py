"""ADD-ES: language detection at start and on switch, Spanish greeting/notice, Spanish TTS voice + STT language per
turn (gather TwiML and the relay <Language> element / `language` frame), Spanish SMS templates and compliance keywords."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app import guard
from app.sms_outbound import confirmation_text, reminder_text, textback_text
from app.tenants import load_record
from app.voice import greeting, twiml_for, voice_for, VoiceTurn
from sim import harness
from sim.fake_twilio import parse_twiml

MON_9 = datetime(2026, 10, 12, 14, 0, tzinfo=timezone.utc)  # 09:00 Chicago


def es_tenant(demo_raw, **voice):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["voice"].update({"languages": ["en", "es"], **voice})
    return load_record(raw)


@pytest.mark.parametrize("text, lang", [
    ("Hola, necesito ayuda, el aire acondicionado no funciona", "es"),
    ("Buenas tardes, quisiera una cita para mañana", "es"),
    ("My AC is broken, can you come today?", "en"),
    ("ok", None), ("77005", None),
    ("Thanks! Gracias", None),  # one marker each: tie keeps the current language
])
def test_detect_language(text, lang):
    assert guard.detect_language(text) == lang


@pytest.mark.parametrize("word, kind", [("PARAR", "stop"), ("alto", "stop"), ("Cancelar", "stop"), ("INICIAR", "start"),
                                        ("sí", "start"), ("AYUDA", "help"), ("información", "help"),
                                        ("no me envíen más mensajes", "stop")])
def test_spanish_keywords(word, kind):
    assert guard.sms_keyword(word) == kind and guard.keyword_lang(word) == "es"
    assert guard.keyword_lang("STOP") == "en"


def test_spanish_fixed_texts_carry_business_phone_and_opt_out_word():
    s = guard.stop_confirmation_es("Cool Breeze HVAC", "+17135550100")
    assert "Cool Breeze HVAC" in s and "+17135550100" in s and "INICIAR" in s
    assert "PARAR" in guard.help_text_es("Cool Breeze HVAC", "+17135550100") and "+17135550100" in guard.help_text_es("x", "+17135550100")
    assert "PARAR" in guard.start_confirmation_es("x") and "asistente virtual" in guard.robot_answer_es("x")
    assert guard.consent_answer_es("Sí, claro") == "yes" and guard.consent_answer_es("No, mejor no") == "no"
    assert guard.consent_answer_es("no me mande mensajes") == "no" and guard.consent_answer_es("quizás") is None


def test_greeting_adds_the_spanish_notice_only_with_the_addon(demo_raw):
    en = greeting(load_record(demo_raw))
    assert "grabada" not in en
    es = greeting(es_tenant(demo_raw))
    assert es.startswith(en) and guard.SPANISH_INVITE in es and guard.DISCLOSURE_ES in es
    custom = greeting(es_tenant(demo_raw, greeting_es="Hola, gracias por llamar a Cool Breeze."))
    assert "Hola, gracias por llamar a Cool Breeze." in custom and guard.DISCLOSURE_ES in custom  # notice never removable


def test_voice_and_language_per_turn(demo_raw):
    t = es_tenant(demo_raw, tts_voice_es="Polly.Lupe-Neural")
    assert voice_for(t, None) == ("Polly.Joanna-Neural", "en-US")
    assert voice_for(t, "es") == ("Polly.Lupe-Neural", "es-US")
    assert voice_for(load_record(demo_raw), "es") == ("Polly.Joanna-Neural", "en-US")  # no add-on: English voice stays
    tw = parse_twiml(twiml_for(VoiceTurn("¿Cuál es el código postal?", lang="es"), t))
    assert tw.lang == "es-US" and 'voice="Polly.Lupe-Neural"' in twiml_for(VoiceTurn("hola", lang="es"), t)
    assert parse_twiml(twiml_for(VoiceTurn("Hi there"), t)).lang in (None, "en-US")
    bye = twiml_for(VoiceTurn("Hasta luego.", end=True, lang="es"), t)
    assert 'language="es-US"' in bye and "<Hangup" in bye


def test_relay_twiml_declares_the_spanish_language(tmp_path, demo_raw):
    sim = harness.build(tmp_path, VOICE_MODE="stream")
    sim.store.upsert_tenant(es_tenant(demo_raw))
    _, resp = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, harness.CALLER)
    tw = parse_twiml(resp.text)
    assert tw.relay["language"] == "en-US" and tw.relay_langs == ["es-US"]
    assert 'voice="Lupe-Neural"' in resp.text and 'ttsProvider="Amazon"' in resp.text
    sim.store.upsert_tenant(load_record(demo_raw))
    _, resp = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, "+17135550124")
    assert parse_twiml(resp.text).relay_langs == []


def test_engine_detects_switches_and_remembers_the_language(tmp_path, demo_raw):
    sim = harness.build(tmp_path, clock=harness.FakeClock(MON_9))
    tenant = sim.store.upsert_tenant(es_tenant(demo_raw))
    eng = sim.rt.engine
    r1 = eng.handle(tenant, "sms", harness.CALLER, "Hola, necesito ayuda, el aire no funciona", "s1", MON_9)
    assert "lang:es" in r1.guard and r1.lang == "es"
    assert sim.rt.state.get(f"lang:{tenant.id}:{eng._who(harness.CALLER)}") == "es"
    ctx = eng.find_convo(tenant, "sms", "s1").messages[0]["content"][0]["text"]
    assert "reply in Spanish" in ctx
    r2 = eng.handle(tenant, "sms", harness.CALLER, "Actually, can you do it in English please?", "s1", MON_9)
    assert "lang:en" in r2.guard and r2.lang == "en"
    assert sim.rt.outbound.contact_lang(tenant, harness.CALLER) == "en"
    # the robot question, in Spanish, gets the Spanish answer without Claude
    eng.handle(tenant, "sms", harness.CALLER, "Hola otra vez, necesito una cita por favor", "s1", MON_9)
    r3 = eng.handle(tenant, "sms", harness.CALLER, "Hola, por favor, are you a robot?", "s1", MON_9)  # mostly Spanish
    assert "robot_question" in r3.guard and r3.reply.startswith("Soy el asistente virtual")


def test_spanish_sms_templates_follow_the_number(tmp_path, demo_raw):
    sim = harness.build(tmp_path, clock=harness.FakeClock(MON_9))
    tenant = sim.store.upsert_tenant(es_tenant(demo_raw))
    booking = {"label": "Monday Oct 12, 1 PM to 3 PM", "start": "2026-10-12T13:00:00-05:00", "event_id": "e1"}
    assert textback_text(tenant) .startswith("Hi, this is") and "STOP" in textback_text(tenant)
    assert textback_text(tenant, "es").startswith("Hola, le habla Cool Breeze HVAC") and "PARAR" in textback_text(tenant, "es")
    assert "su cita está confirmada para Monday Oct 12, 1 PM to 3 PM" in confirmation_text(tenant, booking, "es")
    assert "recordatorio de su visita" in reminder_text(tenant, booking, "es") and guard.sms_segments(reminder_text(tenant, booking, "es")) <= 3
    sim.rt.state.put(f"lang:{tenant.id}:{sim.rt.engine._who(harness.CALLER)}", "es", tenant.id)
    assert sim.rt.outbound.contact_lang(tenant, harness.CALLER) == "es"
    res = sim.rt.outbound.confirm_booking(tenant, harness.CALLER, booking, MON_9)
    assert res["sent"] and "su cita está confirmada" in sim.twilio_client.outbox[-1]["body"]
    plain = sim.store.upsert_tenant(load_record(demo_raw))  # add-on off: English even if the state says es
    assert sim.rt.outbound.contact_lang(plain, harness.CALLER) == "en"


def test_without_the_addon_nothing_changes(tmp_path, demo_raw):
    sim = harness.build(tmp_path, clock=harness.FakeClock(MON_9))
    tenant = sim.tenant("demo-hvac")
    r = sim.rt.engine.handle(tenant, "sms", harness.CALLER, "Hola, necesito ayuda, el aire no funciona", "s1", MON_9)
    assert "language" in r.guard and r.lang is None and "only help in English" in r.reply
    assert "PARAR" in guard.STOP_WORDS_ES  # keywords are honoured for everyone (carriers do too), the reply is English
    r2 = sim.rt.engine.handle(tenant, "sms", "+17135550124", "PARAR", "s2", MON_9)
    assert "unsubscribed" in r2.reply
