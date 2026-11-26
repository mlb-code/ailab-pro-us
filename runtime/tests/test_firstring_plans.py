"""FirstRing monthly plans (2026-11-25): plan terms from the price book, features per plan, minutes per plan with the
trial cap, 80%/100% alerts to the CUSTOMER with the upgrade link (+ English note to Meir), message-only service
(trial ended / cancelled / past due / paused / trial minutes used), ForwardedFrom on calls, booking switched off.
Plans come from a fixture (same shape as config/pricebook.json `plans`), never from typed numbers in the code."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone

import pytest

from app import plans
from app.conversation import Engine
from app.llm import LLMClient
from app.notify import Notifier, NotifyPolicy, TwilioSms
from app.notify import templates as T
from app.store import JsonStore, StateStore, StoreError
from app.tenants import load_record
from app.usage import UsageMeter
from sim import harness
from sim.fake_calendar import FakeCalendar
from sim.fake_call import FakeCall
from sim.fake_twilio import FakeTwilioClient

from test_b6_notify import ADMIN, RecEmail

NOW = datetime(2026, 11, 25, 15, 0, tzinfo=timezone.utc)  # Wednesday 9:00 in Houston
FIXTURE = [
    {"code": "FR_STARTER", "name": "Starter", "monthly_cents": 14900, "included_usage": {"voice_minutes": 200},
     "trial_days": 14, "trial_minutes": 100, "features": ["answer_calls", "calendar_booking"], "upgrade_to": "FR_PRO"},
    {"code": "FR_PRO", "name": "Pro", "monthly_cents": 24900, "included_usage": {"voice_minutes": 500},
     "trial_days": 14, "trial_minutes": 100, "features": ["answer_calls", "calendar_booking", "spanish", "web_chat"],
     "upgrade_to": "FR_BUSINESS"},
    {"code": "FR_BUSINESS", "name": "Business", "monthly_cents": 39900, "included_usage": {"voice_minutes": 1000},
     "trial_days": 14, "trial_minutes": 100, "features": ["answer_calls", "calendar_booking", "spanish", "web_chat",
                                                          "dispatch", "second_line", "crm_link"], "upgrade_to": None}]


@pytest.fixture(autouse=True)
def catalog():
    plans.set_catalog(FIXTURE, {"trial_minutes": 100})
    yield
    plans.set_catalog(None)


def with_plan(raw: dict, **plan) -> dict:
    raw = copy.deepcopy(raw)
    raw["config"]["plan"] = {"code": "FR_STARTER", "status": "active", "period_start": "2026-11-10",
                             "period_end": "2026-12-10T00:00:00+00:00", **plan}
    return raw


# --- terms + features ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("code,status,minutes", [("FR_STARTER", "active", 200), ("FR_PRO", "active", 500),
                                                 ("FR_BUSINESS", "active", 1000), ("FR_BUSINESS", "trialing", 100)])
def test_included_minutes_per_plan_and_trial_cap(demo_raw, code, status, minutes):
    t = plans.terms(load_record(with_plan(demo_raw, code=code, status=status)).config)
    assert (t.included_minutes, t.trialing, t.period) == (minutes, status == "trialing", "p2026-11-10")


def test_quote_client_has_no_plan_terms_and_keeps_its_config(demo_raw):
    rec = load_record(demo_raw)
    assert plans.terms(rec.config) is None and rec.config.voice.languages == load_record(demo_raw).config.voice.languages


def test_features_are_switched_by_the_plan(demo_raw):
    raw = with_plan(demo_raw, code="FR_STARTER")
    raw["config"]["voice"] = {"languages": ["en", "es"]}
    raw["config"]["webchat"] = {"enabled": True, "allowed_origins": ["https://coolbreeze.example"]}
    raw["config"]["crm"] = {"hubspot": {"enabled": True}}
    cfg = load_record(raw).config
    assert (cfg.voice.languages, cfg.webchat.enabled, cfg.crm.hubspot.enabled, cfg.dispatch.enabled) == (["en"], False, False, False)
    pro = load_record(with_plan(demo_raw, code="FR_PRO")).config
    assert (pro.voice.languages, pro.webchat.enabled, pro.dispatch.enabled) == (["en", "es"], True, False)
    biz = with_plan(demo_raw, code="FR_BUSINESS")
    assert load_record(biz).config.dispatch.enabled is False  # no on-call contacts yet: stays off (schema rule)
    biz["config"]["dispatch"] = {"contacts": [{"id": "dan", "name": "Dan", "phone": "+17135550201"}],
                                 "schedule": [{"day": "mon", "start": "18:00", "end": "07:00", "contacts": ["dan"]}]}
    assert load_record(biz).config.dispatch.enabled is True


def test_unknown_plan_code_fails_open(tmp_path, demo_raw):
    raw = with_plan(demo_raw, code="FR_FUTURE")
    raw["config"]["voice"] = {"languages": ["en", "es"]}
    cfg = load_record(raw).config
    assert cfg.voice.languages == ["en", "es"]
    assert UsageMeter(StateStore(JsonStore(tmp_path)), {"voice_minutes": 400, "sms_segments": 1000}).limit(
        load_record(raw), "voice") == 400  # falls back to the quote allowance, never "unlimited/blocked"


def test_plan_block_rejects_bad_values(demo_raw):
    from app.tenants import TenantConfigError
    for bad in ({"code": "fr starter"}, {"status": "free"}, {"service": "off"}, {"period_start": "Nov 10"}):
        with pytest.raises(TenantConfigError):
            load_record(with_plan(demo_raw, **bad))


# --- usage per plan -------------------------------------------------------------------------------------------------
def meter_for(tmp_path):
    return UsageMeter(StateStore(JsonStore(tmp_path)), {"voice_minutes": 400, "sms_segments": 1000})


@pytest.mark.parametrize("code,included", [("FR_STARTER", 200), ("FR_PRO", 500), ("FR_BUSINESS", 1000)])
def test_alert_thresholds_per_plan(tmp_path, demo_raw, code, included):
    m, rec = meter_for(tmp_path), load_record(with_plan(demo_raw, code=code))
    assert m.record(rec, "voice", included * 0.8 - 1, NOW) == []
    a80 = m.record(rec, "voice", 1, NOW)
    assert [a["kind"] for a in a80] == ["usage_80"] and a80[0]["included"] == included and a80[0]["plan_code"] == code
    assert [a["kind"] for a in m.record(rec, "voice", included * 0.2, NOW)] == ["usage_100"]
    assert m.needs_addon_approval(rec, NOW) and m.record(rec, "voice", 50, NOW) == []  # each threshold once


def test_trial_cap_is_the_trial_minutes_and_resets_with_the_paid_period(tmp_path, demo_raw):
    m = meter_for(tmp_path)
    trial = load_record(with_plan(demo_raw, status="trialing", period_start="2026-11-20"))
    kinds = [a["kind"] for a in m.record(trial, "voice", 100, NOW)]
    assert kinds == ["usage_80", "usage_100"] and m.trial_cap_reached(trial, NOW)
    paid = load_record(with_plan(demo_raw, status="active", period_start="2026-12-04"))
    assert m.used(paid, "voice", NOW) == 0 and not m.trial_cap_reached(paid, NOW)  # new period, new counter
    assert m.key(paid, "voice", NOW).endswith(":p2026-12-04:voice_minutes")


def test_plan_sms_is_counted_but_never_alerted(tmp_path, demo_raw):
    m, rec = meter_for(tmp_path), load_record(with_plan(demo_raw))
    assert m.record(rec, "sms", 5000, NOW) == [] and m.used(rec, "sms", NOW) == 5000


def test_quote_client_meter_is_unchanged(tmp_path, demo_raw):
    m, rec = meter_for(tmp_path), load_record(demo_raw)
    assert m.key(rec, "voice", NOW).endswith(":2026-11:voice_minutes")
    assert [a["kind"] for a in m.record(rec, "voice", 320, NOW)] == ["usage_80"]


# --- the alerts reach the customer (not gated by CLIENT_EMAILS_ENABLED) + Meir ----------------------------------------
def notifier(tmp_path, demo_raw, **plan):
    store = JsonStore(tmp_path)
    raw = with_plan(demo_raw, **plan)
    rec = store.upsert_tenant(load_record(raw))
    state, email, tw = StateStore(store), RecEmail(), FakeTwilioClient()
    n = Notifier(store, state, email, TwilioSms(tw), None, NotifyPolicy(client_emails_enabled=False, admin_email=ADMIN,
                                                                       admin_tz="UTC"))
    return n, UsageMeter(state, {"voice_minutes": 400, "sms_segments": 1000}), rec, email


def test_usage_emails_go_to_the_customer_with_the_upgrade_link(tmp_path, demo_raw):
    n, m, rec, email = notifier(tmp_path, demo_raw, code="FR_STARTER")
    n.deliver(rec, m.record(rec, "voice", 160, NOW), now=NOW)
    n.deliver(rec, m.record(rec, "voice", 40, NOW), now=NOW)
    owner = [x for x, _ in email.sent if x.to == ("owner@example.com",)]
    admin = [x for x, _ in email.sent if x.to == (ADMIN,)]
    assert [x.subject for x in owner] == ["You've used 80% of this month's Starter minutes",
                                         "You've used 100% of this month's Starter minutes"]
    assert all("?upgrade=FR_PRO#billing" in x.text and "Upgrade to Pro (500 minutes" in x.text for x in owner)
    assert "$249/month" in owner[1].text and "never charge per minute" in owner[1].text
    assert "in message mode" in owner[1].text and "until your next billing date (2026-12-10) or until you upgrade" in owner[1].text
    assert "message mode" not in owner[0].text
    assert len(admin) == 2 and admin[0].lang == "en" and "FR_STARTER" in admin[0].text and "upgrade" in admin[0].text


def test_trial_100_email_explains_message_mode_and_start_now(tmp_path, demo_raw):
    n, m, rec, email = notifier(tmp_path, demo_raw, status="trialing")
    n.deliver(rec, m.record(rec, "voice", 100, NOW), now=NOW)
    owner = [x for x, _ in email.sent if x.to == ("owner@example.com",)]
    assert [x.subject for x in owner] == ["You've used 80% of your free-trial minutes", "You've used 100% of your free-trial minutes"]
    assert "in message mode" in owner[1].text and "until your trial ends or you start your paid plan" in owner[1].text
    assert "start your plan now" in owner[1].text


def test_business_plan_100_has_no_upgrade_target(tmp_path, demo_raw):
    n, m, rec, email = notifier(tmp_path, demo_raw, code="FR_BUSINESS")
    n.deliver(rec, m.record(rec, "voice", 1000, NOW), now=NOW)
    last = [x for x, _ in email.sent if x.to == ("owner@example.com",)][-1]
    assert "Need more minutes? Reply to this e-mail" in last.text and "Upgrade to" not in last.text


# --- message-only service ------------------------------------------------------------------------------------------------
def sim_with(tmp_path, raw, **env):
    s = harness.build(tmp_path, **env)
    rec = s.store.upsert_tenant(load_record(raw))
    return s, rec


@pytest.mark.parametrize("mode", ["stream", "gather"])
@pytest.mark.parametrize("plan", [{"status": "canceled", "service": "message_only", "service_reason": "canceled"},
                                  {"status": "trialing", "service": "message_only", "service_reason": "trial_ended"},
                                  {"status": "past_due", "service": "message_only", "service_reason": "past_due"},
                                  {"status": "paused", "service": "message_only", "service_reason": "paused"}])
def test_message_mode_answers_takes_a_message_and_alerts_the_owner(tmp_path, demo_raw, mode, plan):
    s, rec = sim_with(tmp_path, with_plan(demo_raw, **plan), VOICE_MODE=mode)
    call = s.call(rec.slug)
    first = call.start()
    assert "can't take your call live" in first.text and "recorded and transcribed" in first.text
    assert "Cool Breeze HVAC" in first.text
    bye = call.say("This is Dana, 713 555 0123, my AC stopped")
    assert "passed your message on" in bye.text and bye.end
    call.hangup(50)
    row = s.store.select("calls", call_sid=call.call_sid)[0]
    assert (row["outcome"], row["duration_s"]) == ("message", 50)
    assert [a["kind"] for a in s.rt.alert_log] == ["lead"] and "Dana" in s.rt.alert_log[0]["summary"]
    assert s.rt.engine.llm.calls == 0 and not s.store.select("bookings")
    assert s.rt.engine.usage.used(rec, "voice", s.rt.now()) == 1


def test_paused_plan_client_keeps_callers_served_but_quote_client_does_not_change(tmp_path, demo_raw):
    raw = with_plan(demo_raw)
    raw["config"]["paused"] = True
    s, rec = sim_with(tmp_path, raw)
    assert "can't take your call live" in s.call(rec.slug).start().text
    old = copy.deepcopy(demo_raw)
    old["config"]["paused"] = True
    s2, rec2 = sim_with(tmp_path / "b", old)
    assert "can't take your call right now" in s2.call(rec2.slug).start().text  # quote clients: as before


def test_message_mode_silence_is_abandoned_and_blocklist_still_rejected(tmp_path, demo_raw):
    raw = with_plan(demo_raw, status="canceled", service="message_only", service_reason="canceled")
    raw["config"]["guard"] = {"blocklist": ["+17135550666"]}
    s, rec = sim_with(tmp_path, raw, VOICE_MODE="gather")
    call = s.call(rec.slug)
    call.start()
    call.silence()
    call.hangup(12)
    assert s.store.select("calls", call_sid=call.call_sid)[0]["outcome"] == "abandoned" and s.rt.alert_log == []
    resp = s.twilio.post("/voice/incoming", s.twilio.call_params(rec.twilio_number, "+17135550666", "CAblocked"))
    assert "<Reject" in resp.text


def test_trial_minutes_used_switches_calls_to_message_mode_unless_keep(tmp_path, demo_raw, monkeypatch):
    raw = with_plan(demo_raw, status="trialing", period_start="2026-11-20")
    s, rec = sim_with(tmp_path, raw)
    s.rt.state.put(s.rt.engine.usage.key(rec, "voice", s.rt.now()), 100.0, rec.id)
    assert "can't take your call live" in s.call(rec.slug).start().text
    monkeypatch.setenv("TRIAL_CAP_MODE", "keep")
    assert "can't take your call live" not in s.call(rec.slug, caller="+17135550199").start().text


def test_sms_in_message_mode_replies_once_and_alerts(tmp_path, demo_raw):
    s, rec = sim_with(tmp_path, with_plan(demo_raw, status="past_due", service="message_only", service_reason="past_due"))
    eng = s.rt.engine
    r = eng.handle(rec, "sms", "+17135550123", "Can you come tomorrow?", "t1", NOW)
    assert "passed it on" in r.reply and r.guard == ["message_mode:past_due"] and eng.llm.calls == 0
    assert [a["kind"] for a in r.actions] == ["lead"]
    stop = eng.handle(rec, "sms", "+17135550124", "STOP", "t2", NOW)
    assert "unsubscribed" in stop.reply.lower() or stop.guard == ["stop"]  # STOP still works first


# --- ForwardedFrom ----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("given,stored", [("+17135550100", "+17135550100"), ("7135550100", "+17135550100"),
                                          ("17135550100", "+17135550100"), ("", None), ("anonymous", None)])
def test_forwarded_from_is_stored_on_the_call(tmp_path, demo_raw, given, stored):
    s = harness.build(tmp_path, VOICE_MODE="gather")
    call = FakeCall(s.twilio, s.tenant("demo-hvac").twilio_number, "+12815550177", forwarded_from=given)
    call.start()
    assert s.store.select("calls", call_sid=call.call_sid)[0].get("forwarded_from") == stored


def test_call_is_saved_even_if_the_database_lacks_forwarded_from(tmp_path, demo_raw):
    from app.message_mode import insert_call

    class Old:
        rows: list = []

        def insert(self, table, row):
            if "forwarded_from" in row:
                raise StoreError("supabase POST /rest/v1/calls -> 400 PGRST204")
            self.rows.append(row)
            return row
    ts = Old()
    insert_call(ts, {"call_sid": "CA1", "forwarded_from": "+17135550100"})
    assert ts.rows == [{"call_sid": "CA1"}]


# --- booking switched off ("take messages only") -------------------------------------------------------------------------
def test_messages_only_client_never_books(tmp_path, demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["booking"]["enabled"] = False
    store = JsonStore(tmp_path)
    rec = store.upsert_tenant(load_record(raw))
    settings = harness.sim_settings(tmp_path)
    eng = Engine(store, LLMClient(settings, mode="mock"), FakeCalendar(), settings)
    for i, text in enumerate(["Hi, my AC is blowing warm air, ZIP 77005", "The first one works", "My name is Dana Miller"]):
        eng.handle(rec, "sms", "+17135550123", text, "nb", NOW + timedelta(minutes=i))
    c = eng.convos[(rec.id, "sms", "nb")]
    assert not c.booking and not store.select("bookings")
    assert any("booking_off" in json.dumps(m) for m in c.messages)


def test_places_join_the_prompt_only_when_set(demo_raw):
    from app.brain import system_prompt
    base = load_record(demo_raw).config
    assert "also served" not in system_prompt(base, "voice")
    raw = copy.deepcopy(demo_raw)
    raw["config"]["business"]["service_area_places"] = ["Bellaire", "Harris County"]
    p = system_prompt(load_record(raw).config, "voice")
    assert "also served: Bellaire, Harris County" in p and "77005" in p


def test_upgrade_url_points_at_billing():
    assert T.upgrade_url("FR_PRO").endswith("/start/?upgrade=FR_PRO#billing")


def test_plan_minutes_used_up_means_message_mode_until_next_period_or_upgrade(tmp_path, demo_raw, monkeypatch):
    s, rec = sim_with(tmp_path, with_plan(demo_raw, code="FR_STARTER"))
    s.rt.state.put(s.rt.engine.usage.key(rec, "voice", s.rt.now()), 200.0, rec.id)
    assert "can't take your call live" in s.call(rec.slug).start().text
    up = s.store.upsert_tenant(load_record(with_plan(demo_raw, code="FR_PRO")))  # upgrade: 500 included
    assert "can't take your call live" not in s.call(up.slug, caller="+17135550191").start().text
    nxt = s.store.upsert_tenant(load_record(with_plan(demo_raw, code="FR_STARTER", period_start="2026-12-10")))
    assert "can't take your call live" not in s.call(nxt.slug, caller="+17135550192").start().text  # next period
    s.store.upsert_tenant(load_record(with_plan(demo_raw, code="FR_STARTER")))
    monkeypatch.setenv("USAGE_CAP_MODE", "keep")
    assert "can't take your call live" not in s.call(rec.slug, caller="+17135550193").start().text


def test_quote_client_over_100_percent_keeps_full_answering(tmp_path, demo_raw):
    s = harness.build(tmp_path)
    rec = s.tenant("demo-hvac")
    s.rt.state.put(s.rt.engine.usage.key(rec, "voice", s.rt.now()), 5000.0, rec.id)
    assert "can't take your call live" not in s.call("demo-hvac").start().text
