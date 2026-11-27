"""Legal decisions 2026-11-27 (docs/legal-decisions-2026-11-27.md, section 3), runtime items:

- 11: health details. Every prompt says never ask about health and save only "caller reports a health-related urgency";
  the tool executor enforces it on what is saved (take_message summary, booking notes, qualify_lead answers), and the
  lead e-mail's transcript excerpt and the call summary leave the detail out.
- 12: real estate. The fair-housing rule names the characteristics state and local laws add and forbids comments on
  schools, crime or safety, screening or scoring callers and opinions on value; the reply guard backs it up.
- 19: relay calls. The voice prompts treat a relay call as a normal call; once detected, the silence wait doubles.
- 20: no voiceprints. No speaker identification, diarization or voice biometrics is switched on anywhere.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app import brain, guard
from app.conversation import Engine
from app.llm import LLMClient
from app.notify import templates as T
from app.notify.core import lead_from
from app.store import JsonStore
from app.tenants import load_file, load_record
from app.voice import RELAY_GATHER_TIMEOUT_S, summary
from sim import harness
from sim.fake_calendar import FakeCalendar
from sim.fake_twilio import parse_twiml

MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))
HVAC = load_file(harness.TENANTS_DIR / "demo-hvac.json").config
REALTY_RAW = json.loads((harness.TENANTS_DIR / "demo-realty.json").read_text())
REALTY = load_record(REALTY_RAW).config
OXYGEN = "My mom is on oxygen and the AC is out"


def tool(name: str, inp: dict, tid: str = "t1") -> dict:
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def resp(*blocks: dict) -> dict:
    return {"content": list(blocks), "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"}


def engine(tmp_path, raw, script):
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(json.loads(json.dumps(raw))))
    return Engine(store, LLMClient(settings, script=script, mode="mock"), FakeCalendar(), settings), tenant


# --- 11. health details -------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("cfg", [HVAC, REALTY], ids=["home_services", "real_estate"])
@pytest.mark.parametrize("channel", ["voice", "sms", "chat"])
def test_every_prompt_carries_the_health_rule(cfg, channel):
    p = brain.system_prompt(cfg, channel)
    assert brain.HEALTH_RULE in p
    assert "never ask about anyone's health, medical condition, disability or medications" in p
    assert '"caller reports a health-related urgency"' in p and "please hang up and call 911" in p


@pytest.mark.parametrize("raw, want", [
    (OXYGEN, "The AC is out. Caller reports a health-related urgency."),
    ("AC out; elderly mother on oxygen. Please call back", "AC out. Please call back. Caller reports a health-related urgency."),
    ("Caller is pregnant, needs heat today", "Needs heat today. Caller reports a health-related urgency."),
    ("Dad uses a CPAP machine", "Caller reports a health-related urgency."),
    ("Furnace broken, 77019, after 3 pm", "Furnace broken, 77019, after 3 pm"),                 # nothing to remove
    ("The AC is out. Caller reports a health-related urgency.", "The AC is out. Caller reports a health-related urgency."),
])
def test_scrub_health_keeps_the_job_and_drops_the_health_detail(raw, want):
    assert guard.scrub_health(raw) == want


def test_take_message_and_the_lead_email_never_carry_the_health_detail(tmp_path, demo_raw):
    """Memo test: a caller says 'my mom is on oxygen and the AC is out'; the message to the business has no 'oxygen',
    even when the model writes it into take_message."""
    script = [resp(text("I'll pass this to the team right away."),
                   tool("take_message", {"summary": "Mom is on oxygen and the AC is out, needs someone today",
                                         "urgency": "urgent", "name": "Dana", "address": None, "job_type": None})),
              resp(text("The team has your message and will call you back soon."))]
    eng, t = engine(tmp_path, demo_raw, script)
    res = eng.handle(t, "sms", harness.CALLER, OXYGEN.lower(), "s1", MON_9)
    c = eng.find_convo(t, "sms", "s1")
    assert "oxygen" not in c.message["summary"].lower() and "health-related urgency" in c.message["summary"]
    alert = next(a for a in res.actions if a.get("type") == "alert")
    assert "oxygen" not in json.dumps(alert).lower()
    lead = lead_from(c, alert)
    subject, body, html_, sms = T.lead_alert("Cool Breeze HVAC", "urgent", lead)
    for part in (subject, body, html_, sms):
        assert "oxygen" not in part.lower(), part
    assert "AC is out" in html_ and "health-related urgency" in html_       # the job stays, the detail does not


def test_booking_notes_and_screening_answers_are_scrubbed(tmp_path, demo_raw):
    eng, t = engine(tmp_path, demo_raw, [])
    c = eng.convo(t, "voice", harness.CALLER, "CA1")
    c.offered["slot-1"] = {"slot_id": "slot-1", "label": "Mon 2 PM"}
    ts = eng.store.for_tenant(t.id)
    eng.calendar.book = lambda *a, **k: {"ok": True, "start": "2026-10-12T14:00:00-05:00", "end": "2026-10-12T16:00:00-05:00",
                                         "label": "Mon 2 PM", "event_id": "e1"}
    out = eng._execute(t, ts, c, "voice", MON_9, "open", [], "book_slot",
                       {"slot_id": "slot-1", "name": "Dana", "address": "45 Westheimer Rd Houston 77019",
                        "job_type": t.config.booking.job_types[0], "urgency": "urgent",
                        "notes": "Grandpa is on dialysis and the heat is out", "phone": None})
    assert out["ok"] and "dialysis" not in c.booking["notes"] and c.booking["notes"].startswith("The heat is out.")
    re_eng, re_t = engine(tmp_path / "re", REALTY_RAW, [])
    rc = re_eng.convo(re_t, "sms", harness.CALLER, "s2")
    re_eng._execute(re_t, re_eng.store.for_tenant(re_t.id), rc, "sms", MON_9, "open", [], "qualify_lead",
                    {"intent": "buyer", "area": "East Austin, near the hospital since my wife is pregnant",
                     "timeline": "3 months", "price_range": None, "pre_approval": None, "property_address": None,
                     "has_agent": "no", "name": "Alex", "email": None})
    assert "pregnant" not in json.dumps(rc.meta["lead"]) and rc.meta["lead"]["area"].startswith("East Austin")


def test_call_summary_without_a_message_leaves_the_health_detail_out(tmp_path, demo_raw):
    eng, t = engine(tmp_path, demo_raw, [])
    c = eng.convo(t, "voice", harness.CALLER, "CA9")
    c.transcript += [{"who": "assistant", "text": "Hi"}, {"who": "customer", "text": OXYGEN}]
    assert "oxygen" not in summary(c) and "AC is out" in summary(c)


# --- 12. fair housing (real estate) ----------------------------------------------------------------------------------------
def test_fair_housing_rule_adds_state_and_local_characteristics_and_the_new_limits():
    rule = brain.RE_FAIR_HOUSING_RULE
    assert ("source of income (for example a housing voucher or benefits), age, marital status, sexual orientation, "
            "gender identity, military or veteran status, immigration or citizenship status, criminal history, genetic "
            "information") in rule
    for words in ("Never comment on school quality, crime or safety of an area, or who lives there; say the agent can "
                  "share public sources.",
                  "Never tell a caller they do not qualify, never refuse to pass on a lead, and never score or rank callers: "
                  "pass every lead to the agent.",
                  "Never give an opinion on a property's value, price or an offer; say the agent will discuss it."):
        assert words in rule
    for channel in ("voice", "sms", "chat"):
        assert rule in brain.system_prompt(REALTY, channel)
    assert rule not in brain.system_prompt(HVAC, "voice")


@pytest.mark.parametrize("question, bad_reply", [
    ("Are the schools good around the Mueller listing?", "Mueller has some of the best schools in Austin."),
    ("Is it a safe area?", "Crime there is very low, it's a safe area."),
    ("I have a Section 8 voucher, can I rent there?", "Sorry, with a Section 8 voucher you don't qualify for that rental."),
])
def test_the_three_memo_questions_never_get_a_steering_answer(tmp_path, question, bad_reply):
    """Memo item 12 test: schools, 'safe area?', a Section 8 voucher. Even if the model answered badly, the reply guard
    replaces it with the neutral line (real-estate tenants)."""
    eng, t = engine(tmp_path, REALTY_RAW, [resp(text(bad_reply))])
    res = eng.handle(t, "sms", harness.CALLER, question, "s1", MON_9)
    assert "reply:fair_housing" in res.guard and res.reply.startswith(guard.FAIR_HOUSING_TEXT.split(".")[0])
    assert not re.search(r"schools|crime|safe|qualify|voucher", res.reply, re.I)


@pytest.mark.parametrize("reply", [
    "Those homes carry a genetic risk disclosure.", "The crime rate there is low.", "It's in a high-crime part of town.",
    "Westlake has top-rated schools.", "You wouldn't qualify for that unit.",
])
def test_fair_housing_guard_blocks_the_item_12_wording(reply):
    out = guard.check_reply(reply, REALTY, "sms")
    assert "fair_housing" in out.violations and out.text == guard.FAIR_HOUSING_TEXT


@pytest.mark.parametrize("reply", [
    "The Mueller listing is in the Austin ISD school district.",
    "Jenna can meet you Monday at 3 PM.",
    "The open house is Saturday at 10.",
])
def test_fair_housing_guard_keeps_listing_facts(reply):
    assert "fair_housing" not in guard.check_reply(reply, REALTY, "sms").violations


# --- 19. relay calls ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("cfg", [HVAC, REALTY], ids=["home_services", "real_estate"])
def test_voice_prompts_carry_the_relay_rule_and_text_prompts_do_not(cfg):
    assert brain.RELAY_RULE in brain.system_prompt(cfg, "voice")
    assert "treat it as a normal call, use short sentences, and wait for replies" in brain.RELAY_RULE
    assert brain.RELAY_RULE not in brain.system_prompt(cfg, "sms") and brain.RELAY_RULE not in brain.system_prompt(cfg, "chat")


@pytest.mark.parametrize("said, relay", [("Hello, this is a relay call for Cool Breeze", True),
                                         ("This is the relay operator, I have a caller on the line", True),
                                         ("Hi, I'm calling through the video relay service", True),
                                         ("My AC is broken, I'm in 77019", False),
                                         ("The relay switch on my furnace clicks", False)])
def test_relay_call_detection(said, relay):
    assert guard.is_relay_call(said) is relay


def test_gather_relay_call_waits_twice_as_long_for_replies(tmp_path):
    sim = harness.build(tmp_path, VOICE_MODE="gather")
    call = sim.call()
    call.start()
    resp_ = sim.twilio.say(call.to, call.caller, call.call_sid, "Hello, this is a relay call. The caller says their AC is broken.")
    g = parse_twiml(resp_.text)
    assert g.gather and f'timeout="{RELAY_GATHER_TIMEOUT_S}"' in resp_.text and RELAY_GATHER_TIMEOUT_S == 10
    other = harness.build(tmp_path / "plain", VOICE_MODE="gather").call()
    other.start()
    plain = other.twilio.say(other.to, other.caller, other.call_sid, "My AC is broken, I'm in 77019")
    assert "timeout=" not in plain.text                              # Twilio's default 5 s on a normal call


def test_stream_relay_call_doubles_the_silence_wait(tmp_path):
    """VOICE_SILENCE_SECONDS=1 in the simulator: a normal call counts a silent turn after ~1 s; a relay call after ~2 s."""
    import time
    sim = harness.build(tmp_path)
    call = sim.call()
    call.start()
    call.say("Hello, this is a relay call. The caller says their AC is broken.")
    t0 = time.perf_counter()
    call.silence()
    waited = time.perf_counter() - t0
    assert waited >= 1.8, waited
    call.hangup()


# --- 20. no voiceprints ------------------------------------------------------------------------------------------------------
def test_no_speaker_identification_is_switched_on_anywhere(tmp_path):
    """Transcription only: no diarization, speaker recognition, voiceprint or voice biometrics in the runtime code or in
    the TwiML it sends (Privacy Policy 3.2: 'We do not create voiceprints or use anyone's voice to identify them.')."""
    app_dir = Path(__file__).resolve().parents[1] / "app"
    code = "\n".join(p.read_text(encoding="utf-8") for p in app_dir.rglob("*.py"))
    assert not re.search(r"diariz|voiceprint|voice_?print|speaker_?(id|identification|recognition|verification)|"
                         r"biometric|voice_?id\b", code, re.I)
    sim = harness.build(tmp_path)
    _, r = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, harness.CALLER)
    assert not re.search(r"diariz|speaker|biometric|voiceprint", r.text, re.I)
