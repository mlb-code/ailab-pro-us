"""Sound-alike words from speech-to-text (first live customer test, 2026-11-27): the FAQ "Do you service Trane units?"
was heard as "Do you service train units?". Deterministic parts: the tenant's own names, services and FAQ terms go to
Twilio as speech recognition hints (ConversationRelay + <Gather>), and the voice prompt tells the model that a sound-alike
word means the configured term, while answers stay limited to the configured facts. Whether the live model then answers
from the FAQ is a live-model behavior; it is not checked here (no live call in tests)."""
from __future__ import annotations

import copy
import json
import xml.etree.ElementTree as ET
from datetime import datetime
from zoneinfo import ZoneInfo

from app import brain, guard, voice
from app.tenants import load_record
from sim import harness

MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))
TRANE = {"q": "Do you service Trane units?", "a": "Yes, we service all major brands, including Trane."}


def cfg_with(demo_raw, faq=None, **business):
    raw = copy.deepcopy(demo_raw)
    if faq is not None:
        raw["config"]["faq"] = faq
    raw["config"]["business"].update(business)
    return load_record(raw).config


def test_hints_are_the_tenants_own_names_services_and_faq_terms(demo_raw):
    cfg = cfg_with(demo_raw, faq=[TRANE, {"q": "Do you work in Katy?", "a": "Yes, Katy and Sugar Land."}],
                   service_area_places=["Houston", "Cypress"])
    hints = voice.speech_hints(cfg).split(",")
    assert hints[0] == cfg.business.name
    assert set(cfg.booking.job_types) <= set(hints) and {"Houston", "Cypress", "Trane", "Katy", "Sugar"} <= set(hints)
    assert not {"Do", "Yes"} & set(hints)  # sentence-initial words are not names
    assert len([h for h in hints if h.lower() == "trane"]) == 1  # deduplicated


def test_hints_are_bounded_and_comma_safe(demo_raw):
    many = [{"q": f"Do you carry Brand{i:02d} parts?", "a": "Yes."} for i in range(25)]
    cfg = cfg_with(demo_raw, faq=many, name="Smith, Sons & Co HVAC")
    text = voice.speech_hints(cfg)
    parts = text.split(",")
    assert parts[0] == "Smith Sons & Co HVAC"  # a comma inside a phrase would split it
    assert len(parts) <= voice.HINTS_MAX and len(text) <= voice.HINTS_MAX_CHARS and all(parts)


def test_relay_and_gather_twiml_carry_the_hints(tmp_path, demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["faq"] = [TRANE]
    for mode in ("stream", "gather"):
        sim = harness.build(tmp_path / mode, clock=harness.FakeClock(MON_9), VOICE_MODE=mode)
        sim.store.upsert_tenant(raw)
        _, r = sim.twilio.start_call(raw["twilio_number"], harness.CALLER, "CA" + "2" * 32)
        root = ET.fromstring(r.text)
        node = root.find("Connect/ConversationRelay") if mode == "stream" else root.find("Gather")
        assert node is not None and "Trane" in node.get("hints", "").split(","), (mode, r.text)
    cfg = load_record(raw)
    g = ET.fromstring(voice.twiml_for(voice.VoiceTurn("Anything else?"), cfg)).find("Gather")
    assert "Trane" in g.get("hints").split(",")


def test_no_hints_attribute_when_there_is_nothing_to_hint():
    assert ET.fromstring(voice.twiml_gather("Hi", "Polly.Joanna-Neural")).find("Gather").get("hints") is None


def test_voice_prompts_explain_sound_alikes_and_keep_the_guardrail(demo_raw):
    cfg = cfg_with(demo_raw, faq=[TRANE])
    p = brain.system_prompt(cfg, "voice")
    assert brain.VOICE_SOUND_ALIKE_RULE in p and "answer only from these" in p
    assert "If nothing above matches, do not guess: offer to take a message." in brain.VOICE_SOUND_ALIKE_RULE
    assert p.index("Q: Do you service Trane units?") < p.index(brain.VOICE_SOUND_ALIKE_RULE)
    re_raw = json.loads((harness.TENANTS_DIR / "demo-realty.json").read_text())
    assert brain.VOICE_SOUND_ALIKE_RULE in brain.system_prompt(load_record(re_raw).config, "voice")
    for channel in ("sms", "chat"):  # typed text: no speech-to-text, prompt unchanged
        assert brain.VOICE_SOUND_ALIKE_RULE not in brain.system_prompt(cfg, channel)


def test_the_faq_answer_passes_the_reply_guard(demo_raw):
    cfg = cfg_with(demo_raw, faq=[TRANE])
    chk = guard.check_reply(TRANE["a"], cfg, "voice")
    assert chk.violations == [] and chk.text == TRANE["a"]
