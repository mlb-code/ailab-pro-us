"""Fix 28.10 (found while scripting chat demos): on the text channels Claude sometimes wrote the booking/cancel
confirmation next to the tool call, then "Goodbye, Dana!" next to end_conversation. Only the last text reached the
customer, so the confirmation was lost (2 of 4 runs). Every sentence Claude writes in the turn must reach the
customer, in order, once."""
from __future__ import annotations

import json

from app import brain, guard
from app.conversation import Engine
from app.llm import LLMClient
from app.store import JsonStore
from app.tenants import load_record
from sim import harness
from sim.fake_calendar import FakeCalendar
from tests.test_fixes_2026_10_22 import CFG, MON_9, resp, text, tool

CONFIRM = "You're booked for Monday morning at 12 Oak St, Dana."
BYE = "Thanks for choosing Copperleaf Air & Plumbing. Goodbye, Dana!"


def engine(tmp_path, demo_raw, script):
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(json.loads(json.dumps(demo_raw))))
    return Engine(store, LLMClient(settings, script=script, mode="mock"), FakeCalendar(), settings), tenant


def first_slot(tenant) -> str:
    return FakeCalendar().availability(tenant.id, tenant.config, MON_9)[0]["slot_id"]


def booking_script(slot: str, phone: str | None = None, *, bye_again: bool = False, final: list | None = None) -> list:
    book = {"slot_id": slot, "name": "Dana", "phone": phone, "address": "12 Oak St, Houston TX 77002",
            "job_type": CFG.booking.job_types[0], "urgency": "normal", "notes": None}
    return [resp(tool("get_availability", {"job_type": CFG.booking.job_types[0], "zip": "77002", "date_from": None})),
            resp(text(CONFIRM), tool("book_slot", book, "t2")),
            resp(text(BYE), tool("end_conversation", {"outcome": "booked"}, "t3")),
            resp(*(final if final is not None else ([text(BYE)] if bye_again else [])))]


# --- brain level --------------------------------------------------------------------------------------

class FakeLLM:
    def __init__(self, script: list):
        self.script = list(script)

    def create(self, system, messages, tools, effort, on_text=None, on_tool=None):
        r = self.script.pop(0)
        for b in r["content"]:
            if b["type"] == "text" and on_text:
                on_text(b["text"])
            if b["type"] == "tool_use" and on_tool:
                on_tool(b["name"])
        return {**r, "cost_usd": 0.0}


def run(script: list, channel: str = "sms", fail: set[str] = frozenset()) -> brain.BrainResult:
    def execute(name: str, args: dict) -> dict:
        return {"ok": name not in fail, **({"reason": "unknown_slot"} if name in fail else {})}
    return brain.run_turn(FakeLLM(script), CFG, channel, [], [{"type": "text", "text": "hi"}], execute)


def test_text_next_to_a_tool_call_is_kept_before_the_goodbye():
    for channel in ("sms", "chat", "voice"):
        out = run([resp(text(CONFIRM), tool("book_slot", {})), resp(text(BYE), tool("end_conversation", {}, "t2")),
                   resp()], channel)
        assert out.text == f"{CONFIRM} {BYE}", channel


def test_a_repeated_sentence_is_kept_once():
    out = run([resp(text(CONFIRM), tool("book_slot", {})), resp(text(BYE), tool("end_conversation", {}, "t2")),
               resp(text(BYE))])
    assert out.text == f"{CONFIRM} {BYE}"
    out = run([resp(text(CONFIRM), tool("book_slot", {})), resp(text(f"{CONFIRM.upper()} {BYE}"))])
    assert out.text == f"{CONFIRM} {BYE}"  # same words, other case: once


def test_text_next_to_a_failed_tool_is_replaced_by_the_correction():
    fix = "Sorry, that time was just taken. Would Tuesday morning work?"
    out = run([resp(text(CONFIRM), tool("book_slot", {})), resp(text(fix))], fail={"book_slot"})
    assert out.text == fix
    out = run([resp(text(CONFIRM), tool("book_slot", {})), resp()], fail={"book_slot"})
    assert out.text == CONFIRM  # nothing better came after it: as before, the guard decides (UNBOOKED_TEXT)


def test_a_lookup_preamble_gives_way_when_the_sms_would_be_too_long():
    offer = "I have " + ", ".join(f"slot number {i} on Monday morning" for i in range(8)) + ". Which works for you?"
    offer += " " + "x" * (guard.SMS_REPLY_MAX - 10 - len(offer)) + "."
    assert len(offer) <= guard.SMS_REPLY_MAX < len(offer) + len(" Let me check the schedule.")
    out = run([resp(text("Let me check the schedule."), tool("get_availability", {})), resp(text(offer))])
    assert out.text == offer
    out = run([resp(text("Let me check the schedule."), tool("get_availability", {})), resp(text("Monday at 9?"))])
    assert out.text == "Let me check the schedule. Monday at 9?"  # fits: nothing dropped


# --- engine level (what the customer gets) --------------------------------------------------------------

def test_sms_booking_confirmation_reaches_the_customer_with_the_goodbye(tmp_path, demo_raw):
    eng, t = engine(tmp_path, demo_raw, [])
    eng.llm.mock.script = booking_script(first_slot(t))
    res = eng.handle(t, "sms", harness.CALLER, "Monday morning works, Dana, 12 Oak St 77002", "S1", MON_9)
    assert res.reply.startswith(f"{CONFIRM} {BYE}"), res.reply
    assert res.reply.count("Goodbye") == 1
    assert len(res.reply) <= guard.SMS_REPLY_MAX and guard.sms_segments(res.reply) <= 3


def test_chat_booking_confirmation_reaches_the_visitor(tmp_path, demo_raw):
    eng, t = engine(tmp_path, demo_raw, [])
    eng.llm.mock.script = booking_script(first_slot(t), phone="+17135550188", bye_again=True)
    res = eng.handle(t, "chat", "web:abc", "Monday works, Dana, 12 Oak St 77002, 713-555-0188", "W1", MON_9)
    assert res.reply == f"{CONFIRM} {BYE}", res.reply
    assert len(res.reply) <= guard.SMS_REPLY_MAX


def test_long_confirmation_and_goodbye_still_fit_one_text(tmp_path, demo_raw):
    eng, t = engine(tmp_path, demo_raw, [])
    long_bye = "Thanks again for reaching out to Copperleaf Air & Plumbing today, we really appreciate it. " * 3
    eng.llm.mock.script = booking_script(first_slot(t), final=[])
    eng.llm.mock.script[2] = resp(text(long_bye), tool("end_conversation", {"outcome": "booked"}, "t3"))
    res = eng.handle(t, "sms", harness.CALLER, "Monday works", "S2", MON_9)
    assert res.reply.startswith(CONFIRM) and len(res.reply) <= guard.SMS_REPLY_MAX


def test_voice_speaks_the_message_confirmation_and_the_goodbye_once(tmp_path, demo_raw):
    """Voice already speaks text next to a tool call as it streams (app.speech); with the fix in place the closing
    line is still spoken once (22.10 fixes). A booking claim streamed before book_slot returns stays blocked on
    voice by design (the sentence is checked when it is ready)."""
    sent = "I passed your message to the team, Dana."
    script = [resp(text(sent), tool("take_message", {"summary": "AC broken", "urgency": "normal", "name": "Dana",
                                                       "address": None, "job_type": None})),
              resp(text(BYE), tool("end_conversation", {"outcome": "message"}, "t2")),
              resp(text(BYE))]
    eng, t = engine(tmp_path, demo_raw, script)
    heard: list[str] = []
    res = eng.handle(t, "voice", harness.CALLER, "just take a message", "CA9", MON_9, on_sentence=heard.append)
    assert heard == [sent, "Thanks for choosing Copperleaf Air & Plumbing.", "Goodbye, Dana!"]
    assert res.reply == " ".join(heard) and res.end
