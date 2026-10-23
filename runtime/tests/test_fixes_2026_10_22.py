"""Fixes from the 22.10 live test call: the goodbye spoken twice, and a lead alert after a hang-up / message
that lost the name, address and job type the caller had already given."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from app import brain, guard
from app.conversation import Engine
from app.llm import LLMClient
from app.notify.core import lead_from
from app.notify import templates as T
from app.speech import TOOL_FILLERS, Speaker
from app.store import JsonStore
from app.tenants import load_file, load_record
from app.voice import summary
from sim import harness
from sim.fake_calendar import FakeCalendar

MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))
CFG = load_file(harness.TENANTS_DIR / "demo-hvac.json").config
BYE = "Thanks for calling Copperleaf Air & Plumbing, Tess. Goodbye."
BYE_SENTENCES = ["Thanks for calling Copperleaf Air & Plumbing, Tess.", "Goodbye."]  # as the speaker cuts it


def tool(name: str, inp: dict, tid: str = "t1") -> dict:
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def resp(*blocks: dict) -> dict:
    stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
    return {"content": list(blocks), "stop_reason": stop}


def engine(tmp_path, demo_raw, script):
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(json.loads(json.dumps(demo_raw))))
    return Engine(store, LLMClient(settings, script=script, mode="mock"), FakeCalendar(), settings), tenant


# --- 1. the goodbye is spoken once --------------------------------------------------------------------

def test_speaker_drops_a_sentence_already_spoken_this_turn():
    sp = Speaker(lambda s: guard.check_reply(s, CFG, "voice"), fillers=TOOL_FILLERS)
    sp.feed(BYE + "\n")
    sp.tool_started("end_conversation")
    sp.end_response("tool_use")
    sp.feed(BYE)              # Claude writes the same goodbye again after the tool result
    sp.end_response("end_turn")
    assert sp.spoken == BYE_SENTENCES and sp.repeated == BYE_SENTENCES and sp.text == BYE
    sp2 = Speaker(lambda s: guard.check_reply(s, CFG, "voice"), fillers=TOOL_FILLERS)
    sp2.tool_started("book_slot")       # filler "One moment."
    sp2.feed("one moment! Let me check that. ")
    assert sp2.spoken == ["One moment.", "Let me check that."]  # same words, other punctuation/case: still once


def test_voice_turn_says_goodbye_once_in_audio_and_transcript(tmp_path, demo_raw):
    script = [resp(text(BYE), tool("end_conversation", {"outcome": "no_action"})), resp(text(BYE))]
    eng, t = engine(tmp_path, demo_raw, script)
    heard: list[str] = []
    res = eng.handle(t, "voice", harness.CALLER, "no that's all, thanks", "CA1", MON_9, on_sentence=heard.append)
    assert heard == BYE_SENTENCES and res.reply == BYE and res.end  # heard once, in audio and in the transcript
    c = eng.find_convo(t, "voice", "CA1")
    assert [x["text"] for x in c.transcript if x["who"] == "assistant"] == [BYE]


def test_goodbye_after_a_silent_end_conversation_is_still_spoken(tmp_path, demo_raw):
    script = [resp(tool("end_conversation", {"outcome": "no_action"})), resp(text(BYE))]
    eng, t = engine(tmp_path, demo_raw, script)
    heard: list[str] = []
    res = eng.handle(t, "voice", harness.CALLER, "bye", "CA2", MON_9, on_sentence=heard.append)
    assert heard == BYE_SENTENCES and res.reply == BYE


def test_prompts_tell_claude_to_say_goodbye_once_and_pass_known_details():
    for channel in ("voice", "sms"):
        p = brain.system_prompt(CFG, channel)
        assert "Say goodbye once, in the same reply as end_conversation" in p
        assert "any name, address and job type" in p
    props = next(t for t in brain.tools(CFG, "voice") if t["name"] == "take_message")["input_schema"]["properties"]
    assert set(props) == {"summary", "urgency", "name", "address", "job_type"}


# --- 2. a message or hang-up keeps what the caller already gave ----------------------------------------

def test_take_message_carries_name_address_and_job_type_into_the_alert(tmp_path, demo_raw):
    script = [resp(tool("take_message", {"summary": "AC not cooling, wants a callback", "urgency": "normal",
                                         "name": "Tess", "address": "123 Main Street, Houston, TX 77002",
                                         "job_type": "AC repair"})),
              resp(text("I've passed your message to the team."))]
    eng, t = engine(tmp_path, demo_raw, script)
    res = eng.handle(t, "sms", harness.CALLER, "AC not cooling, call me back", "S1", MON_9)
    c = eng.find_convo(t, "sms", "S1")
    assert res.outcome == "message" and c.message["name"] == "Tess" and c.message["job_type"] == "AC repair"
    lead = lead_from(c, res.actions[0])
    assert (lead["name"], lead["address"], lead["job_type"]) == ("Tess", "123 Main Street, Houston, TX 77002", "AC repair")
    subject, body, _, sms = T.lead_alert("Copperleaf", "lead", lead)
    assert subject == "New lead: AC repair · Tess · Houston" and "Address: 123 Main Street, Houston, TX 77002" in body
    assert sms.startswith("New lead: Tess, ")


def test_hang_up_after_name_and_address_keeps_them_in_alert_and_summary(tmp_path, demo_raw):
    # turn 1: Claude looks up slots (job type + ZIP are now known); turn 2: book_slot with name + address fails
    # (slot gone); then the caller hangs up -> close() must not report "Unknown caller".
    script = [resp(text("Let me check the schedule."), tool("get_availability", {"job_type": "AC repair", "zip": "77002",
                                                                                 "date_from": None})),
              resp(text("I can do Monday morning. Does that work?")),
              resp(tool("book_slot", {"slot_id": "gone", "name": "Tess", "phone": None,
                                      "address": "123 Main Street, Houston, TX 77002", "job_type": "AC repair",
                                      "urgency": "normal", "notes": None}, "t2")),
              resp(text("Sorry, that time was just taken. Would another time work?"))]
    eng, t = engine(tmp_path, demo_raw, script)
    eng.handle(t, "voice", harness.CALLER, "My AC is not cooling, 77002", "CA3", MON_9)
    eng.handle(t, "voice", harness.CALLER, "Monday morning, Tess, 123 Main Street Houston Texas 77002", "CA3", MON_9)
    c = eng.find_convo(t, "voice", "CA3")
    assert c.collected == {"job_type": "AC repair", "zip": "77002", "name": "Tess",
                           "address": "123 Main Street, Houston, TX 77002"}
    actions = eng.close(t, c, "message", "lead", "Caller hung up before finishing; please call back")
    assert c.message["name"] == "Tess" and c.message["address"].startswith("123 Main") and c.message["job_type"] == "AC repair"
    lead = lead_from(c, actions[0])
    assert (lead["name"], lead["job_type"]) == ("Tess", "AC repair") and lead["address"].startswith("123 Main")
    assert T.lead_alert("Copperleaf", "lead", lead)[0] == "New lead: AC repair · Tess · Houston"
    assert summary(c) == ("Message (normal): Caller hung up before finishing; please call back "
                          "(Tess, AC repair, 123 Main Street, Houston, TX 77002)")
    # persisted and restored: the details survive a restart / another worker
    eng.save_convo(c)
    assert eng.find_convo(t, "voice", "CA3").collected["name"] == "Tess"


def test_recording_objection_keeps_nothing_collected(tmp_path, demo_raw):
    script = [resp(text("Sure."), tool("get_availability", {"job_type": "AC repair", "zip": "77002", "date_from": None})),
              resp(text("Monday morning works?"))]
    eng, t = engine(tmp_path, demo_raw, script)
    eng.handle(t, "voice", harness.CALLER, "AC repair at 77002", "CA4", MON_9)
    res = eng.handle(t, "voice", harness.CALLER, "do not record this call", "CA4", MON_9)
    c = eng.find_convo(t, "voice", "CA4")
    assert res.outcome == "message" and c.meta["transcript_withheld"]
    assert lead_from(c, res.actions[0])["job_type"] == "" and "AC repair" not in summary(c)
