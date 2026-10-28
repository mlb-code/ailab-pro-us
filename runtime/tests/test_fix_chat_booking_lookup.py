"""Fix 28.10: find_my_booking on the web chat searched by the chat session id (`web-...`), found nothing and told the
customer "no booking under this number". Chat has no caller id: the number the customer gave is the key, and with
none the tool asks for it. Voice and SMS keep using the caller id."""
from __future__ import annotations

from app import brain
from app.tenants import load_record

from test_appointments import CALLER, MON_9, OTHER, Ctx, cfg_of

DANA = "+17135550187"
MSG = "Hi, this is Dana Miller. I need to cancel my plumbing visit tomorrow. My mobile is (713) 555-0187."


def chat(x, key="abc123"):
    return x.engine.convo(x.tenant, "chat", "web-" + key, key)


def test_chat_with_the_number_given_finds_it_on_the_first_call(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(phone=DANA, name="Dana Miller")
    c = chat(x)
    res, _ = x.run(c, "find_my_booking", {"phone": "(713) 555-0187", "name": "Dana Miller"})
    assert res["ok"] and res["bookings"][0]["booking_id"] == "B1"
    res, actions = x.run(c, "cancel_booking", {"booking_id": "B1", "reason": None})
    assert res["ok"]
    assert "web chat" in actions[0]["summary"] and "different number" not in actions[0]["summary"]
    assert actions[0]["contact"] == c.contact  # the alert still goes out; the event carries the booking's number
    assert c.meta["appt_events"][0]["contact"] == DANA


def test_chat_without_a_number_asks_for_it_and_never_searches_by_the_session_id(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(phone="web-abc123", name="Dana Miller")  # a row keyed by the session id must never be found
    c = chat(x)
    res, _ = x.run(c, "find_my_booking", {"phone": None, "name": "Dana Miller"})
    assert res["ok"] is False and res["reason"] == "need_phone" and "mobile number" in res["note"]
    assert "my_bookings" not in c.meta
    assert x.run(c, "find_my_booking", {"phone": "713 555 0187", "name": None})[0]["reason"] == "name_needed"
    assert x.run(c, "find_my_booking", {"phone": "12", "name": "Dana"})[0]["reason"] == "bad_phone"


def test_chat_number_needs_the_matching_name(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(phone=DANA, name="Dana Miller")
    c = chat(x)
    assert x.run(c, "find_my_booking", {"phone": DANA, "name": "Paul Jones"})[0]["reason"] == "no_booking"
    assert x.run(c, "find_my_booking", {"phone": DANA, "name": "dana"})[0]["ok"]


def test_chat_end_to_end_first_lookup_finds_the_booking(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(phone=DANA, name="Dana Miller", job="Plumbing")
    res = x.engine.handle(x.tenant, "chat", "web-e2e", MSG, "e2e", MON_9)
    finds = [t for t in res.tool_calls if t.get("name") == "find_my_booking"]
    assert finds, res.tool_calls
    assert "can't find" not in res.reply.lower() and "cancel it?" in res.reply


def test_chat_end_to_end_without_a_number_asks_for_it(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(phone=DANA, name="Dana Miller", job="Plumbing")
    res = x.engine.handle(x.tenant, "chat", "web-e2e2", "Hi, I need to cancel my visit tomorrow.", "e2e2", MON_9)
    assert "mobile number" in res.reply and "can't find" not in res.reply.lower()
    res = x.engine.handle(x.tenant, "chat", "web-e2e2", "It's under Dana Miller, (713) 555-0187", "e2e2",
                          MON_9.replace(minute=1))
    assert "cancel it?" in res.reply


def test_voice_and_sms_still_use_the_caller_id(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking()
    for ch in ("voice", "sms"):
        res, _ = x.run(x.convo(ch), "find_my_booking", {"phone": None, "name": None})
        assert res["ok"] and res["bookings"][0]["booking_id"] == "B1", ch
    x.booking(phone=OTHER, name="Dana Miller", slot=3)
    res, actions = x.run(x.convo("sms"), "find_my_booking", {"phone": OTHER, "name": "Dana Miller"})
    assert res["ok"]


def test_prompt_and_tools_change_only_on_chat(demo_raw):
    on = load_record(cfg_of(demo_raw, self_service=True)).config
    old = ("call find_my_booking (it uses the number they contact us from; only if they say the booking is under "
           "another number, pass that number and the name on the booking)")
    for ch in ("voice", "sms"):
        assert old in brain.system_prompt(on, ch)
        find = next(t for t in brain.tools(on, ch) if t["name"] == "find_my_booking")
        assert "another number" in find["input_schema"]["properties"]["phone"]["description"]
    p = brain.system_prompt(on, "chat")
    assert old not in p and "mobile number the booking is under" in p and "ask for them first" in p
    find = next(t for t in brain.tools(on, "chat") if t["name"] == "find_my_booking")
    assert "required in the chat box" in find["input_schema"]["properties"]["phone"]["description"]
    assert brain._manage_text(on) == brain._manage_text(on, "sms") == brain._manage_text(on, "voice")
