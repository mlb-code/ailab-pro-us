"""Appointment manager (2026-10-23): reschedule/cancel tools, returning callers, C/R/X text replies, Results numbers."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app import appointments as appt
from app import brain, guard, sms_outbound
from app.calendar.base import CalendarError, label
from app.calendar.fake import FakeProvider
from app.conversation import Engine
from app.llm import LLMClient
from app.notify import Notifier, NotifyPolicy, TwilioSms
from app.reports import (Reporter, activity, change_pct, is_after_hours, results_data, worth_calling_back)
from app.store import JsonStore, StateStore
from app.tenants import load_record
from sim import harness
from sim.fake_calendar import FakeCalendar
from sim.fake_twilio import FakeTwilioClient, parse_twiml

from test_b6_notify import ADMIN, RecEmail

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
CALLER = harness.CALLER
OTHER = "+17135550177"
SMS_NAME = "Copperleaf Comfort Heating and Air Services"  # 44 characters


def cfg_of(demo_raw, **booking):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["booking"].update(booking)
    return raw


# --- calendar layer: reschedule = book + remove, with rollback -------------------------------------------------

@pytest.fixture
def fake(tmp_path, demo_raw):
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(demo_raw))
    return FakeProvider(store, StateStore(store)), tenant, store


def _slots(p, t):
    return p.availability(t.id, t.config, MON_9, limit=10)


def test_reschedule_moves_our_booking(fake):
    p, t, store = fake
    s = _slots(p, t)
    first = p.book(t.id, t.config, MON_9, s[0]["slot_id"], {"phone": CALLER, "name": "Tess"})
    moved = p.reschedule(t.id, t.config, MON_9, first["event_id"], s[1]["slot_id"], {"phone": CALLER, "name": "Tess"})
    assert moved["ok"] and moved["event_id"] != first["event_id"]
    assert first["event_id"] not in p.events and moved["event_id"] in p.events
    statuses = {r["event_id"]: r["status"] for r in p.ledger(t.id)}
    assert statuses == {first["event_id"]: "rescheduled", moved["event_id"]: "booked"}
    assert any(e["type"] == "booking.rescheduled" for e in store.select("events"))


def test_reschedule_same_local_day_is_not_a_duplicate(fake):
    p, t, _ = fake
    s = _slots(p, t)[1:]
    assert s[0]["slot_id"][:10] == s[1]["slot_id"][:10]  # two windows on the same day (Tuesday)
    first = p.book(t.id, t.config, MON_9, s[0]["slot_id"], {"phone": CALLER})
    assert p.book(t.id, t.config, MON_9, s[1]["slot_id"], {"phone": CALLER})["reason"] == "duplicate"
    assert p.reschedule(t.id, t.config, MON_9, first["event_id"], s[1]["slot_id"], {"phone": CALLER})["ok"]


def test_reschedule_rollback_when_the_old_event_cannot_be_removed(fake, monkeypatch):
    p, t, _ = fake
    s = _slots(p, t)
    first = p.book(t.id, t.config, MON_9, s[0]["slot_id"], {"phone": CALLER})
    real_delete = p._delete_event

    def delete(tenant_id, cfg, event_id, reason):
        if event_id == first["event_id"]:
            raise CalendarError("provider down")
        return real_delete(tenant_id, cfg, event_id, reason)

    monkeypatch.setattr(p, "_delete_event", delete)
    res = p.reschedule(t.id, t.config, MON_9, first["event_id"], s[2]["slot_id"], {"phone": CALLER})
    assert res == {"ok": False, "reason": "calendar_unavailable"}
    assert list(p.events) == [first["event_id"]]  # the new event was removed again, the old one stands
    assert [(r["event_id"], r["status"]) for r in p.ledger(t.id)] == [(first["event_id"], "booked")]


def test_reschedule_new_slot_failure_changes_nothing(fake):
    p, t, _ = fake
    s = _slots(p, t)
    first = p.book(t.id, t.config, MON_9, s[0]["slot_id"], {"phone": CALLER})
    assert p.reschedule(t.id, t.config, MON_9, first["event_id"], "2099-01-01T08:00-12:00", {})["reason"] == "slot_unavailable"
    assert p.reschedule(t.id, t.config, MON_9, first["event_id"], s[0]["slot_id"], {})["reason"] == "same_slot"
    p.fail = "down"
    assert p.reschedule(t.id, t.config, MON_9, first["event_id"], s[1]["slot_id"], {})["reason"] == "calendar_unavailable"
    p.fail = None
    assert list(p.events) == [first["event_id"]] and p.ledger(t.id)[0]["status"] == "booked"


def test_owner_events_cannot_be_moved(fake):
    p, t, _ = fake
    s = _slots(p, t)
    assert p.reschedule(t.id, t.config, MON_9, "owner-event-123", s[1]["slot_id"], {})["reason"] == "not_found"


# --- the flag keeps every other tenant byte-identical -----------------------------------------------------------

def test_tools_and_prompt_unchanged_when_off(demo_raw):
    off = load_record(demo_raw).config
    on = load_record(cfg_of(demo_raw, self_service=True)).config
    for ch in ("sms", "voice"):
        names = [t["name"] for t in brain.tools(off, ch)]
        assert names == ["get_availability", "book_slot", "take_message", "handoff", "end_conversation"]
        assert [t["name"] for t in brain.tools(on, ch)][-3:] == ["find_my_booking", "reschedule_booking", "cancel_booking"]
        assert "find_my_booking" not in brain.system_prompt(off, ch)
        assert "find_my_booking" in brain.system_prompt(on, ch)
    assert set(brain._VOICE_TOOL_TEXT) >= {t["name"] for t in brain.tools(on, "voice")}


def test_reply_check_backs_moves_but_never_refunds(demo_raw):
    cfg = load_record(demo_raw).config
    assert "unbacked_action" in guard.check_reply("I moved your visit to Friday.", cfg, "sms").violations
    assert guard.check_reply("Done, I moved your visit to Friday.", cfg, "sms", booked=True, changed=True).violations == []
    assert "unbacked_action" in guard.check_reply("I moved it and refunded you.", cfg, "sms", changed=True).violations


# --- engine: find / move / cancel only the caller's own bookings --------------------------------------------------

class Ctx:
    def __init__(self, tmp_path, demo_raw, **booking):
        self.store = JsonStore(tmp_path)
        self.tenant = self.store.upsert_tenant(load_record(cfg_of(demo_raw, **{"self_service": True,
                                                                             "recognize_callers": True, **booking})))
        settings = harness.sim_settings(tmp_path, BRAIN_MODE="mock")
        self.engine = Engine(self.store, LLMClient(settings, namespace="appt", mode="mock"), FakeCalendar(), settings)
        self.ts = self.store.for_tenant(self.tenant.id)

    def booking(self, phone=CALLER, name="Tess Brown", slot=0, address="500 Elm St Houston 77019", job="Maintenance"):
        cal, t = self.engine.calendar, self.tenant
        s = cal.availability(t.id, t.config, MON_9, limit=10)[slot]
        res = cal.book(t.id, t.config, MON_9, s["slot_id"], {"phone": phone, "name": name})
        return self.ts.insert("bookings", {"customer_name": name, "contact_e164": phone, "address": address,
                                           "job_type": job, "start_at": res["start"], "end_at": res["end"],
                                           "provider_event_id": res["event_id"], "status": "confirmed"})

    def convo(self, channel="voice", contact=CALLER):
        return self.engine.convo(self.tenant, channel, contact, f"{channel}-test")

    def run(self, c, name, args, now=MON_9):
        actions: list = []
        return self.engine._execute(self.tenant, self.ts, c, c.channel, now, "open", actions, name, args), actions


def test_find_returns_refs_not_addresses_or_numbers(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking()
    res, _ = x.run(x.convo(), "find_my_booking", {"phone": None, "name": None})
    assert res["ok"] and res["bookings"][0]["booking_id"] == "B1"
    out = json.dumps(res)
    assert "Elm" not in out and CALLER not in out and res["bookings"][0]["zip"] == "77019"


def test_other_number_needs_the_name_on_the_booking(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(phone=OTHER, name="Dana Miller")
    c = x.convo()
    assert x.run(c, "find_my_booking", {"phone": None, "name": None})[0]["reason"] == "no_booking"
    assert x.run(c, "find_my_booking", {"phone": "713-555-0177", "name": None})[0]["reason"] == "name_needed"
    assert x.run(c, "find_my_booking", {"phone": "713-555-0177", "name": "Paul Jones"})[0]["reason"] == "no_booking"
    assert x.run(c, "find_my_booking", {"phone": "nope", "name": "Dana"})[0]["reason"] == "bad_phone"
    res, _ = x.run(c, "find_my_booking", {"phone": "(713) 555-0177", "name": "dana miller"})
    assert res["ok"]
    res, actions = x.run(c, "cancel_booking", {"booking_id": "B1", "reason": None})
    assert res["ok"] and "different number" in actions[0]["summary"] and actions[0]["kind"] == "booking_change"


def test_unknown_booking_ref_and_unoffered_slot_are_refused(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking()
    c = x.convo()
    assert x.run(c, "reschedule_booking", {"booking_id": "B1", "slot_id": "x"})[0]["reason"] == "unknown_booking"
    x.run(c, "find_my_booking", {"phone": None, "name": None})
    assert x.run(c, "reschedule_booking", {"booking_id": "B1", "slot_id": "2026-10-13T08:00-12:00"})[0]["reason"] == "unknown_slot"
    assert x.run(c, "cancel_booking", {"booking_id": "B7", "reason": None})[0]["reason"] == "unknown_booking"


def test_tools_refused_when_the_tenant_has_it_off(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw, self_service=False)
    x.booking()
    assert x.run(x.convo(), "find_my_booking", {"phone": None, "name": None})[0]["reason"] == "unknown_tool"


def test_reschedule_writes_rows_offers_other_times_and_backs_the_reply(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    old = x.booking()
    c = x.convo()
    x.run(c, "find_my_booking", {"phone": None, "name": None})
    av, _ = x.run(c, "get_availability", {"job_type": "Maintenance", "zip": "77019", "date_from": None})
    assert all(s["slot_id"] != c.offered.get(s["slot_id"], {}).get("x") for s in av["slots"])
    assert old["start_at"] not in [c.offered[s["slot_id"]]["start"] for s in av["slots"]]  # current time not offered
    res, actions = x.run(c, "reschedule_booking", {"booking_id": "B1", "slot_id": av["slots"][0]["slot_id"]})
    assert res["ok"]
    rows = {r["id"]: r for r in x.ts.select("bookings")}
    assert rows[old["id"]]["status"] == "rescheduled"
    new = next(r for r in rows.values() if r.get("rescheduled_from_id") == old["id"])
    assert new["status"] == "confirmed" and new["contact_e164"] == CALLER
    assert c.outcome == "booked" and c.meta["appt"]["kind"] == "rescheduled" and actions[0]["kind"] == "booking_change"
    assert any(e["type"] == "appointment.rescheduled" for e in x.ts.select("events"))
    # moving it again works on the new row
    av2, _ = x.run(c, "get_availability", {"job_type": "Maintenance", "zip": "77019", "date_from": None})
    assert x.run(c, "reschedule_booking", {"booking_id": "B1", "slot_id": av2["slots"][-1]["slot_id"]})[0]["ok"]


def test_known_caller_context_rules(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking(name="Tess Brown")
    info = appt.known_caller(x.ts, x.tenant.config, CALLER, MON_9)
    assert info["name"] == "Tess" and info["next"].startswith("Monday Oct 12")
    fact = appt.caller_fact(info)
    assert "Tess" in fact and "Elm" not in fact and CALLER not in fact
    # nothing for an opted-out or blocked number, nothing older than 90 days, the current call does not count
    x.ts.opt_out(CALLER, "sms", "STOP")
    assert appt.known_caller(x.ts, x.tenant.config, CALLER, MON_9) is None
    assert appt.known_caller(x.ts, x.tenant.config, "+17135550111", MON_9) is None
    x.ts.insert("calls", {"call_sid": "CA-now", "from_e164": "+17135550111", "started_at": MON_9.isoformat()})
    assert appt.known_caller(x.ts, x.tenant.config, "+17135550111", MON_9, "CA-now") is None
    x.ts.insert("calls", {"call_sid": "CA-old", "from_e164": "+17135550112",
                          "started_at": (MON_9 - timedelta(days=120)).isoformat()})
    assert appt.known_caller(x.ts, x.tenant.config, "+17135550112", MON_9) is None


def test_returning_caller_fact_only_once_and_only_when_enabled(tmp_path, demo_raw):
    x = Ctx(tmp_path, demo_raw)
    x.booking()
    res = x.engine.handle(x.tenant, "sms", CALLER, "Hi there", "sms-known", MON_9)
    assert res.reply.startswith("Hi Tess")
    c = x.engine.find_convo(x.tenant, "sms", "sms-known")
    first_ctx = c.messages[0]["content"][0]["text"]
    assert "Returning caller" in first_ctx and "Tess" in first_ctx
    x.engine.handle(x.tenant, "sms", CALLER, "My AC is broken, 77019", "sms-known", MON_9 + timedelta(minutes=1))
    c = x.engine.find_convo(x.tenant, "sms", "sms-known")
    later = [m for m in c.messages if m["role"] == "user" and isinstance(m["content"], list)
             and m["content"][0].get("text", "").startswith("[context]")]
    assert sum("Returning caller" in m["content"][0]["text"] for m in later) == 1
    y = Ctx(tmp_path / "off", demo_raw, recognize_callers=False)
    y.booking()
    y.engine.handle(y.tenant, "sms", CALLER, "Hi there", "sms-known", MON_9)
    assert "Returning caller" not in y.engine.find_convo(y.tenant, "sms", "sms-known").messages[0]["content"][0]["text"]


# --- text replies C / R / X (SMS_BOOKING_REPLIES) ---------------------------------------------------------------

@pytest.mark.parametrize("text,kind", [("C", "confirm"), ("c", "confirm"), (" Confirm ", "confirm"), ("yes", "confirm"),
                                       ("Y", "confirm"), ("R", "change"), ("r.", "change"), ("reschedule", "change"),
                                       ("X", "cancel"), ("x", "cancel"), ("cancel", None), ("C is fine but", None)])
def test_parse_reply(text, kind):
    assert appt.parse_reply(text) == kind


def test_cancel_word_stays_an_opt_out():
    assert guard.sms_keyword("CANCEL") == "stop" and guard.sms_keyword("cancel") == "stop"


def test_templates_one_segment_and_unchanged_when_off(demo_raw):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["business"]["sms_display_name"] = SMS_NAME
    t = load_record(raw)
    longest = label(datetime(2026, 10, 21, 10, 30, tzinfo=TZ), datetime(2026, 10, 21, 12, 30, tzinfo=TZ))
    for fn in (sms_outbound.confirmation_text, sms_outbound.reminder_text):
        on = fn(t, {"label": longest}, True)
        assert sms_outbound.REPLY_LINE in on and SMS_NAME in on and guard.sms_segments(on) == 1, len(on)
        assert "STOP" in on and "http" not in on
        assert fn(t, {"label": longest}) == fn(t, {"label": longest}, False) and "C=confirm" not in fn(t, {"label": longest})


def sms_sim(tmp_path, demo_raw, on=True):
    clock = harness.FakeClock(MON_9)
    sim = harness.build(tmp_path, clock=clock, **({"SMS_BOOKING_REPLIES": "1"} if on else {}))
    raw = cfg_of(demo_raw, self_service=True, lead_time_hours=26)
    sim.store.upsert_tenant(raw)
    return sim, clock


def text(sim, body, frm=CALLER):
    r = sim.twilio.sms(sim.tenant("demo-hvac").twilio_number, frm, body)
    assert r.status_code == 200
    return parse_twiml(r.text).text


def book_and_remind(sim, clock):
    for line in ["Hi, my AC is blowing warm air", "77005", "The first one works", "My name is Dana Miller",
                 "2100 Rice Blvd, Houston 77005", "Yes"]:
        clock.advance(minutes=1)
        text(sim, line)
    clock.advance(minutes=60 * 4)
    sim.tick()
    return sim.twilio_client.outbox[-1]


def test_reminder_asks_for_c_r_x_and_c_confirms(tmp_path, demo_raw):
    sim, clock = sms_sim(tmp_path, demo_raw)
    sent = book_and_remind(sim, clock)
    assert sms_outbound.REPLY_LINE in sent["body"]
    clock.advance(minutes=5)
    reply = text(sim, "c")
    assert "is confirmed" in reply
    row = sim.store.select("bookings")[0]
    assert row["confirmed_at"] and row["status"] == "confirmed"
    # a second C has no open prompt any more: it is just a normal message
    clock.advance(minutes=1)
    assert "is confirmed" not in text(sim, "C")


def test_x_cancels_and_tells_the_owner(tmp_path, demo_raw):
    sim, clock = sms_sim(tmp_path, demo_raw)
    book_and_remind(sim, clock)
    clock.advance(minutes=5)
    assert "is cancelled" in text(sim, "X")
    assert sim.store.select("bookings")[0]["status"] == "cancelled"
    assert sim.calendar.events(sim.tenant("demo-hvac").id) == []
    assert any(a["kind"] == "booking_change" for a in sim.rt.alert_log)
    zaps = [e for e in sim.store.select("events") if e["type"] == "zapier.pending"]
    assert any(z["payload"]["event"] == "booking.cancelled" for z in zaps)


def test_r_opens_the_change_conversation(tmp_path, demo_raw):
    sim, clock = sms_sim(tmp_path, demo_raw)
    book_and_remind(sim, clock)
    clock.advance(minutes=5)
    assert "Which works better" in text(sim, "R")
    clock.advance(minutes=1)
    assert "moved your visit" in text(sim, "The second one")
    statuses = sorted(r["status"] for r in sim.store.select("bookings"))
    assert statuses == ["confirmed", "rescheduled"]
    # the moved visit gets its own reminder job (texting yes on record); the old reminder is gone
    jobs = sim.rt.outbound.jobs(sim.tenant("demo-hvac"))
    new = next(r for r in sim.store.select("bookings") if r["status"] == "confirmed")
    assert [j["booking"]["event_id"] for j in jobs if j["kind"] == "reminder"] == [new["provider_event_id"]]


def test_stop_still_wins_over_an_open_prompt(tmp_path, demo_raw):
    sim, clock = sms_sim(tmp_path, demo_raw)
    book_and_remind(sim, clock)
    clock.advance(minutes=5)
    text(sim, "STOP")
    assert sim.store.for_tenant(sim.tenant("demo-hvac").id).is_opted_out(CALLER)
    assert sim.store.select("bookings")[0]["status"] == "confirmed"


def test_flag_off_keeps_the_old_texts_and_no_letter_replies(tmp_path, demo_raw):
    sim, clock = sms_sim(tmp_path, demo_raw, on=False)
    sent = book_and_remind(sim, clock)
    assert "C=confirm" not in sent["body"] and "Reply here to change it" in sent["body"]
    clock.advance(minutes=5)
    assert "is cancelled" not in text(sim, "X")
    assert sim.store.select("bookings")[0]["status"] == "confirmed"


# --- reports: Results numbers, worth calling back, weekly e-mail ----------------------------------------------------

class Rep:
    def __init__(self, tmp_path, demo_raw, weekly=False):
        raw = json.loads(json.dumps(demo_raw))
        raw["status"] = "live"
        self.store = JsonStore(tmp_path)
        self.tenant = self.store.upsert_tenant(load_record(raw))
        self.state = StateStore(self.store)
        self.email = RecEmail()
        notifier = Notifier(self.store, self.state, self.email, TwilioSms(FakeTwilioClient()), None,
                            NotifyPolicy(client_emails_enabled=True, admin_email=ADMIN, admin_tz="Asia/Jerusalem"))
        self.rep = Reporter(self.store, self.state, notifier, weekly_enabled=weekly)
        self.ts = self.store.for_tenant(self.tenant.id)

    def call(self, when, outcome, num, job=None, sid=None):
        self.ts.insert("calls", {"call_sid": sid or f"CA{num}{when:%d%H}", "from_e164": num, "started_at": when.isoformat(),
                                 "outcome": outcome, "job_type": job, "summary": "s"})

    def booking(self, when, num, status="confirmed", **extra):
        row = self.ts.insert("bookings", {"contact_e164": num, "customer_name": "N", "start_at": when.isoformat(),
                                          "status": status, **extra})
        self.store.update("bookings", row["id"], {"created_at": when.isoformat()})
        return row


def test_worth_calling_back_excludes_numbers_that_booked_later(tmp_path, demo_raw):
    r = Rep(tmp_path, demo_raw)
    d = datetime(2026, 10, 14, 10, 0, tzinfo=TZ)
    r.call(d, "message", "+17135550101", "AC repair")
    r.call(d + timedelta(hours=1), "message", "+17135550102", "Maintenance")
    r.booking(d + timedelta(hours=3), "+17135550102")              # booked later -> not worth calling back
    r.call(d + timedelta(hours=2), "message", "+17135550103")       # no job type
    r.call(d + timedelta(hours=4), "booked", "+17135550104", "AC repair")
    r.call(d - timedelta(hours=1), "message", "+17135550101", "AC repair")  # same number: listed once
    r.booking(d - timedelta(days=3), "+17135550101")                 # booked BEFORE the call: still listed
    start, end = d.replace(day=1, hour=0), d.replace(day=31, hour=0)
    out = worth_calling_back(r.store, r.tenant, start, end)
    assert [x["phone"] for x in out] == ["+17135550101"] and out[0]["job_type"] == "AC repair"


def test_results_month_over_month_and_appointment_counts(tmp_path, demo_raw):
    r = Rep(tmp_path, demo_raw)
    oct_ = datetime(2026, 10, 14, 10, 0, tzinfo=TZ)
    sep = datetime(2026, 9, 14, 10, 0, tzinfo=TZ)
    for i in range(2):
        r.call(sep + timedelta(hours=i), "message", f"+1713555020{i}", "AC repair")
    for i in range(3):
        r.call(oct_ + timedelta(hours=i), "message", f"+1713555030{i}", "AC repair")
    old = r.booking(oct_, "+17135550400", status="rescheduled")
    r.booking(oct_ + timedelta(hours=1), "+17135550400", rescheduled_from_id=old["id"], confirmed_at=oct_.isoformat())
    r.booking(oct_ - timedelta(days=1), "+17135550401", status="no_show")
    r.booking(oct_, "+17135550402", status="cancelled")
    r.ts.log_event("appointment.rescheduled", {})
    for e in r.store.select("events"):
        r.store.update("events", e["id"], {"created_at": oct_.isoformat()})
    data = results_data(r.store, r.state, r.tenant, "2026-10")
    assert data["calls_answered"] == 3 and data["previous"]["calls_answered"] == 2
    assert data["change_pct"]["calls_answered"] == 50 and data["change_pct"]["booked"] is None
    assert data["booked"] == 2  # the moved visit once, the no-show; the cancelled one is not a booking
    assert (data["confirmations"], data["reschedules"], data["no_shows"]) == (1, 1, 1)
    assert len(data["worth_calling_back"]) == 3
    assert change_pct(5, 4) == 25 and change_pct(3, 4) == -25 and change_pct(1, 0) is None


def test_after_hours_classification_unchanged(tmp_path, demo_raw):
    r = Rep(tmp_path, demo_raw)
    assert not is_after_hours(r.tenant, datetime(2026, 10, 12, 9, 0, tzinfo=TZ))
    assert is_after_hours(r.tenant, datetime(2026, 10, 12, 19, 0, tzinfo=TZ))
    assert is_after_hours(r.tenant, datetime(2026, 10, 18, 10, 0, tzinfo=TZ))  # Sunday closed
    d = datetime(2026, 10, 12, 0, 0, tzinfo=TZ)
    r.call(d.replace(hour=10), "message", "+17135550101")
    r.call(d.replace(hour=20), "message", "+17135550102")
    assert activity(r.store, r.tenant, d, d + timedelta(days=1))["after_hours_calls"] == 1


def test_weekly_email_off_by_default_then_once_a_week(tmp_path, demo_raw):
    mon = datetime(2026, 10, 19, 9, 5, tzinfo=TZ)
    off = Rep(tmp_path / "off", demo_raw)
    off.call(mon - timedelta(days=2), "message", "+17135550101", "AC repair")
    assert off.rep.weekly(off.tenant, mon) is None
    r = Rep(tmp_path / "on", demo_raw, weekly=True)
    r.call(mon - timedelta(days=2), "message", "+17135550101", "AC repair")
    assert r.rep.weekly(r.tenant, mon - timedelta(hours=1)) is None      # before 09:00
    assert r.rep.weekly(r.tenant, mon + timedelta(days=1)) is None       # not Monday
    res = r.rep.weekly(r.tenant, mon)
    assert res["week"] == "2026-W43" and res["sent"][0]["status"] == "sent"
    subject = r.email.sent[-1][0].subject
    assert subject.startswith("Your week: 1 calls answered")
    assert "Worth calling back" in r.email.sent[-1][0].text and "+17135550101" in r.email.sent[-1][0].text
    assert r.rep.weekly(r.tenant, mon + timedelta(minutes=30)) is None   # once per week
    assert "SMS" not in r.email.sent[-1][0].text and "text" not in subject.lower()
