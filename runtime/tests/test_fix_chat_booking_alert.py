"""Fix 29.10: owner alerts for web-chat bookings arrived without the customer's name, address, job and time. The
alert's contact is the chat session id (`web-...`) while the bookings row is keyed by the number the customer typed,
so the lookup by contact found nothing. The saved conversation knows what it booked; phone/SMS alerts are unchanged."""
from __future__ import annotations

from app import _stubs_b56, hooks_b56
from app.conversation import Convo

from test_b6_hooks import _drain, _tenant

DANA = "+17135550123"
ROW = {"customer_name": "Dana Miller", "contact_e164": DANA, "address": "2100 Rice Blvd, Houston, TX 77005",
       "job_type": "AC repair", "start_at": "2026-10-13T08:00:00-05:00", "end_at": "2026-10-13T12:00:00-05:00",
       "provider_event_id": "evt-1", "status": "confirmed"}


def _chat_alert(convo_id="chat-abc123"):
    return {"type": "alert", "kind": "booking", "summary": "New booking: AC repair Tue 8-12", "urgency": "normal",
            "contact": "web-abc123", "channel": "chat", "convo_id": convo_id}


def _save_chat_convo(state, t, booking, convo_id="chat-abc123"):
    c = Convo(t.id, "chat", "web-abc123", convo_id, booking=booking)
    state.put(f"convo:{t.id}:chat:{convo_id}", c.to_dict(), t.id)


def test_chat_booking_alert_is_enriched_from_the_saved_conversation(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw)
    store.for_tenant(t.id).insert("bookings", ROW)
    _save_chat_convo(state, t, {"name": "Dana Miller", "phone": DANA, "event_id": "evt-1"})
    convo = hooks_b56._convo_from_store(store, t, _chat_alert())
    assert convo.booking == {"name": "Dana Miller", "address": ROW["address"], "job_type": "AC repair", "urgency": None,
                             "start": ROW["start_at"], "end": ROW["end_at"]}
    _stubs_b56.owner_alert(store, state, t, _chat_alert(), "chat-abc123:booking")
    _drain(store, state)
    mail = next(e for e in store.select("events") if e["type"] == "email.outbox")["payload"]
    assert mail["subject"] == "New lead: AC repair · Dana Miller · Houston" and "Tuesday Oct 13" in mail["text"]


def test_chat_booking_alert_falls_back_to_the_number_the_customer_gave(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw)
    store.for_tenant(t.id).insert("bookings", {**ROW, "provider_event_id": "other-event"})
    _save_chat_convo(state, t, {"name": "Dana Miller", "phone": DANA})  # no event id saved
    convo = hooks_b56._convo_from_store(store, t, _chat_alert())
    assert convo.booking and convo.booking["name"] == "Dana Miller" and convo.booking["job_type"] == "AC repair"


def test_phone_booking_alert_still_enriches_by_caller_id(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw)
    store.for_tenant(t.id).insert("bookings", ROW)
    alert = {"type": "alert", "kind": "booking", "summary": "New booking", "contact": DANA, "channel": "voice",
             "convo_id": "CA1"}
    convo = hooks_b56._convo_from_store(store, t, alert)
    assert convo.booking["name"] == "Dana Miller" and convo.booking["start"] == ROW["start_at"]
    assert not store.select("runtime_state")  # nothing consulted or written beyond the bookings row


def test_no_booking_anywhere_leaves_booking_none(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw)
    assert hooks_b56._convo_from_store(store, t, _chat_alert()).booking is None  # no saved conversation at all
    _save_chat_convo(state, t, None)  # a saved conversation that booked nothing
    assert hooks_b56._convo_from_store(store, t, _chat_alert()).booking is None
    _save_chat_convo(state, t, {"name": "Dana Miller", "phone": DANA, "event_id": "evt-1"})  # booked, row gone
    assert hooks_b56._convo_from_store(store, t, _chat_alert()).booking is None
    _stubs_b56.owner_alert(store, state, t, _chat_alert(), "chat-abc123:booking")
    _drain(store, state)
    assert any(e["type"] == "email.outbox" for e in store.select("events"))  # the alert still goes out
