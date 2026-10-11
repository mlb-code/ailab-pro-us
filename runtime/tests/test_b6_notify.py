"""B6: owner/admin notifications (SMS + e-mail), usage alerts delivery, Resend adapter, call/SMS logging."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.calendar import build_hub
from app.conversation import Engine
from app.llm import LLMClient
from app.notify import Email, Notifier, NotifyPolicy, OutboxEmail, ResendEmail, TwilioSms, record_call, record_sms
from app.notify import templates as T
from app.notify.calllog import percentile, twilio_cost_key
from app.store import JsonStore, StateStore
from app.tenants import load_record
from app.usage import UsageMeter
from app.zapier import ZapierClient
from sim import harness
from sim.fake_twilio import FakeTwilioClient

from test_b5_support import MON_9

OWNER_SMS = "+17135550111"
ADMIN = "meir@example.com"


class RecEmail:
    name = "rec"

    def __init__(self, fail: int = 0):
        self.sent: list[tuple[Email, str]] = []
        self.fail = fail

    def send(self, msg, idem):
        if self.fail:
            self.fail -= 1
            return {"ok": False, "error": "boom"}
        self.sent.append((msg, idem))
        return {"ok": True, "id": f"em{len(self.sent)}"}


class Ctx:
    def __init__(self, tmp_path, demo_raw, enabled=True, live=True, **cfg):
        raw = json.loads(json.dumps(demo_raw))
        raw["status"] = "live" if live else "sandbox"
        raw["config"].update(cfg)
        self.settings = harness.sim_settings(tmp_path)
        self.store = JsonStore(tmp_path)
        self.tenant = self.store.upsert_tenant(load_record(raw))
        self.state = StateStore(self.store)
        self.email = RecEmail()
        self.twilio = FakeTwilioClient()
        self.posts: list[httpx.Request] = []
        self.zap = ZapierClient(self.store, self.state, "master-test-secret",
                                http=httpx.Client(transport=httpx.MockTransport(self._zap)), sleep=lambda s: None)
        self.notifier = Notifier(self.store, self.state, self.email, TwilioSms(self.twilio), self.zap,
                                 NotifyPolicy(client_emails_enabled=enabled, admin_email=ADMIN,
                                                  admin_tz="Asia/Jerusalem"))

    def _zap(self, request):
        self.posts.append(request)
        return httpx.Response(200, json={"status": "success"})

    def events(self, type_=None):
        return [e for e in self.store.select("events") if type_ is None or e["type"] == type_]


@pytest.fixture
def ctx(tmp_path, demo_raw):
    return Ctx(tmp_path, demo_raw, zapier={"webhook_url": "https://hooks.zapier.com/hooks/catch/1/abc/",
                                          "events": ["lead.created", "booking.created", "call.completed"]})


# --- end to end from the engine --------------------------------------------------------------

TURNS = ["Hi, my AC is blowing warm air", "77005", "The first one works", "My name is Dana Miller",
         "2100 Rice Blvd, Houston, TX 77005", "Thanks"]


def run_booking(c: Ctx, thread="SMthread1"):
    hub = build_hub(c.store, c.settings, c.state)
    eng = Engine(c.store, LLMClient(c.settings, mode="mock"), hub, c.settings, state=c.state)
    out = []
    for i, text in enumerate(TURNS):
        r = eng.handle(c.tenant, "sms", harness.CALLER, text, thread, MON_9 + timedelta(minutes=i))
        out += c.notifier.deliver(c.tenant, r.actions, eng.convo(c.tenant, "sms", harness.CALLER, thread),
                                  idem=thread, now=MON_9)
    return eng, out


def test_booking_conversation_alerts_owner_once_by_sms_email_and_zapier(ctx):
    raw = json.loads(json.dumps(ctx.tenant.model_dump(mode="json")))
    raw["config"]["booking"]["provider"] = "fake"
    ctx.tenant = ctx.store.upsert_tenant(load_record(raw))
    eng, out = run_booking(ctx)
    subjects = [m.subject for m, _ in ctx.email.sent]
    assert subjects == ["New lead: AC repair · Dana Miller · Houston"]
    msg = ctx.email.sent[0][0]
    assert msg.to == ("owner@example.com",) and "Booked" in msg.text and "2100 Rice Blvd" in msg.html
    assert [m["to"] for m in ctx.twilio.outbox] == [OWNER_SMS]
    sms = ctx.twilio.outbox[0]
    assert sms["from"] == ctx.tenant.twilio_number and len(sms["body"]) <= 320 and sms["body"].startswith("New booking")
    assert [r.headers["X-Event"] for r in ctx.posts] == ["lead.created", "booking.created"]
    body = json.loads(ctx.posts[1].content)
    assert body["data"]["name"] == "Dana Miller" and body["data"]["start"] and body["id"] == "booking.created:SMthread1"
    # replaying the same actions sends nothing new
    again = ctx.notifier.deliver(ctx.tenant, [{"type": "alert", "kind": "booking", "summary": "x"}],
                                 eng.convo(ctx.tenant, "sms", harness.CALLER, "SMthread1"), idem="SMthread1")
    assert {r["status"] for r in again} == {"duplicate"}
    assert len(ctx.email.sent) == 1 and len(ctx.twilio.outbox) == 1 and len(ctx.posts) == 2


def test_call_completed_fires_once_per_call_sid(ctx):
    assert ctx.notifier.call_completed(ctx.tenant, "CA123", "message", 95)["status"] == "sent"
    assert ctx.notifier.call_completed(ctx.tenant, "CA123", "message", 95)["status"] == "duplicate"
    assert json.loads(ctx.posts[0].content)["data"] == {"call_sid": "CA123", "outcome": "message", "duration_s": 95}


@pytest.mark.parametrize("kind,prefix,sms_head", [("urgent", "[URGENT] New lead:", "URGENT lead"),
                                                  ("human_needed", "[HUMAN NEEDED] New lead:", "Call back requested"),
                                                  ("lead", "New lead:", "New lead")])
def test_alert_kinds(ctx, kind, prefix, sms_head):
    a = {"type": "alert", "kind": kind, "summary": "Gas smell in the kitchen", "contact": "+17135550123",
         "channel": "voice", "convo_id": "CA9"}
    ctx.notifier.deliver(ctx.tenant, [a], idem="CA9")
    assert ctx.email.sent[0][0].subject.startswith(prefix)
    assert ctx.twilio.outbox[0]["body"].startswith(sms_head)
    assert json.loads(ctx.posts[0].content)["data"]["kind"] == kind


def test_rate_limit_and_dial_actions_do_not_alert_the_owner(ctx):
    ctx.notifier.deliver(ctx.tenant, [{"type": "alert", "kind": "rate_limit", "summary": "x"},
                                      {"type": "dial", "number": "+17135550111"}], idem="SM1")
    assert ctx.email.sent == [] and ctx.twilio.outbox == [] and ctx.events("notify.recorded")


def test_owner_who_texted_stop_gets_no_sms(ctx):
    ctx.store.for_tenant(ctx.tenant.id).opt_out(OWNER_SMS)
    out = ctx.notifier.deliver(ctx.tenant, [{"type": "alert", "kind": "lead", "summary": "x"}], idem="SM2")
    assert ctx.twilio.outbox == [] and {"channel": "sms", "tag": "lead_alert", "status": "skipped",
                                        "reason": "opted_out"} in out


def test_no_twilio_number_skips_sms_but_still_emails(tmp_path, demo_raw):
    raw = json.loads(json.dumps(demo_raw))
    raw["twilio_number"] = None
    c = Ctx(tmp_path, raw)
    c.notifier.deliver(c.tenant, [{"type": "alert", "kind": "lead", "summary": "x"}], idem="SM3")
    assert c.twilio.outbox == [] and len(c.email.sent) == 1 and c.events("notify.skipped")


def test_failed_email_is_logged_not_raised_and_retried_later(ctx):
    ctx.email.fail = 1
    a = [{"type": "alert", "kind": "lead", "summary": "x"}]
    out = ctx.notifier.deliver(ctx.tenant, a, idem="SM4")
    assert any(r["status"] == "failed" for r in out) and ctx.events("notify.failed")
    out = ctx.notifier.deliver(ctx.tenant, a, idem="SM4")
    assert [r["status"] for r in out if r["channel"] == "email"] == ["sent"]
    assert [r["status"] for r in out if r["channel"] == "sms"] == ["duplicate"]


def test_customer_values_are_escaped_in_html(ctx):
    a = {"type": "alert", "kind": "lead", "summary": "<script>alert(1)</script>", "contact": "+1"}
    ctx.notifier.deliver(ctx.tenant, [a], idem="SM5")
    html = ctx.email.sent[0][0].html
    assert "<script>" not in html and "&lt;script&gt;" in html


def test_deliver_async_runs_in_background(ctx):
    from concurrent.futures import ThreadPoolExecutor
    ctx.notifier.executor = ThreadPoolExecutor(max_workers=1)
    ctx.notifier.deliver_async(ctx.tenant, [{"type": "alert", "kind": "lead", "summary": "x"}], idem="SM6")
    ctx.notifier.executor.shutdown(wait=True)
    assert len(ctx.email.sent) == 1


# --- usage alerts (80% / 100%), no automatic billing ------------------------------------------------

def usage_actions(c: Ctx, amount: float):
    meter = UsageMeter(c.state, included={"voice_minutes": 10, "sms_segments": 1000})
    return meter.record(c.tenant, "voice", amount, MON_9)


def test_usage_80_and_100_reach_owner_and_admin(ctx):
    out80 = ctx.notifier.deliver(ctx.tenant, usage_actions(ctx, 8), now=MON_9)
    out100 = ctx.notifier.deliver(ctx.tenant, usage_actions(ctx, 2), now=MON_9)
    owner = [m for m, _ in ctx.email.sent if m.to == ("owner@example.com",)]
    admin = [m for m, _ in ctx.email.sent if m.to == (ADMIN,)]
    assert [m.subject for m in owner] == ["You've used 80% of this month's included voice minutes",
                                         "You've used 100% of this month's included voice minutes"]
    assert "never add charges without your approval" in owner[1].text
    block = T.pricebook_item("ADD-USAGE")["monthly_cents"] / 100
    assert f"${block:,.0f}/month" in owner[1].text
    assert [("80%" in m["body"], "100%" in m["body"]) for m in ctx.twilio.outbox] == [(True, False), (False, True)]
    assert [m.subject for m in admin] == ["שימוש 80%: Cool Breeze HVAC · דקות שיחה", "שימוש 100%: Cool Breeze HVAC · דקות שיחה"]
    assert admin[0].lang == "he" and "needs_addon_approval" in admin[1].text
    visible = [e for e in ctx.events("usage.alert") if e.get("client_visible")]
    assert [e["payload"]["kind"] for e in visible] == ["usage_80", "usage_100"]
    assert out80 and out100
    assert ctx.notifier.deliver(ctx.tenant, usage_actions(ctx, 5), now=MON_9) == []  # each threshold once a month


def test_usage_alerts_reach_the_client_even_with_client_emails_off(tmp_path, demo_raw):
    """Usage alerts are operational: CLIENT_EMAILS_ENABLED only gates summaries/reports (review #5)."""
    c = Ctx(tmp_path, demo_raw, enabled=False)
    c.notifier.deliver(c.tenant, usage_actions(c, 8), now=MON_9)
    assert sorted(m.to for m, _ in c.email.sent) == [("meir@example.com",), ("owner@example.com",)]
    assert len(c.twilio.outbox) == 1


def test_owner_sms_is_logged_and_counted_apart_from_client_usage(ctx):
    ctx.notifier.deliver(ctx.tenant, [{"type": "alert", "kind": "lead", "summary": "x"}], idem="SMo", now=MON_9)
    rows = ctx.store.for_tenant(ctx.tenant.id).select("sms_messages")
    assert [(r["contact_e164"], r["direction"]) for r in rows] == [(OWNER_SMS, "outbound")]
    month = datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m")
    assert ctx.state.get(f"usage:{ctx.tenant.id}:{month}:owner_sms_segments") == 1
    assert not ctx.state.get(f"usage:{ctx.tenant.id}:{month}:sms_segments")  # client's included usage untouched


def test_usage_alert_from_a_live_sms_conversation(tmp_path, demo_raw):
    c = Ctx(tmp_path, demo_raw)
    eng = Engine(c.store, LLMClient(c.settings, mode="mock"), build_hub(c.store, c.settings, c.state), c.settings,
                 state=c.state)
    eng.usage = UsageMeter(c.state, included={"voice_minutes": 400, "sms_segments": 3})
    kinds = []
    for i, text in enumerate(["Hi, my AC is blowing warm air", "77005"]):
        r = eng.handle(c.tenant, "sms", harness.CALLER, text, "SMu", MON_9 + timedelta(minutes=i))
        kinds += [a["kind"] for a in r.actions]
        c.notifier.deliver(c.tenant, r.actions, idem="SMu", now=MON_9)
    assert "usage_80" in kinds and any("80%" in m.subject for m, _ in c.email.sent)


def test_admin_notices_wait_for_morning_but_faults_do_not(ctx):
    night = datetime(2026, 10, 13, 2, 0, tzinfo=ZoneInfo("Asia/Jerusalem"))
    ctx.notifier.deliver(ctx.tenant, usage_actions(ctx, 8), now=night)
    assert not [m for m, _ in ctx.email.sent if m.to == (ADMIN,)]
    assert ctx.state.get("admin:deferred") == ["שימוש 80%: Cool Breeze HVAC · דקות שיחה"]
    ctx.notifier.deliver(ctx.tenant, [{"type": "alert", "kind": "admin_budget", "summary": "tenant daily budget reached",
                                       "tenant": "demo-hvac"}], now=night)
    assert [m.subject for m, _ in ctx.email.sent if m.to == (ADMIN,)] == ["תקציב יומי נוצל: Cool Breeze HVAC"]


def test_admin_email_unset_is_recorded(tmp_path, demo_raw):
    c = Ctx(tmp_path, demo_raw)
    c.notifier.policy.admin_email = ""
    out = c.notifier.deliver(c.tenant, [{"type": "alert", "kind": "admin_budget", "summary": "x"}], now=MON_9)
    assert out[0]["reason"] == "admin_email_unset" and c.events("notify.admin_unset")


def test_calendar_disconnect_alerts_owner_and_admin_once(ctx):
    raw = json.loads(json.dumps(ctx.tenant.model_dump(mode="json")))
    raw["config"]["booking"]["provider"] = "google"  # never connected -> auth failure
    ctx.tenant = ctx.store.upsert_tenant(load_record(raw))
    hub = build_hub(ctx.store, ctx.settings, ctx.state, alert=ctx.notifier.calendar_alert)
    assert hub.availability(ctx.tenant.id, ctx.tenant.config, MON_9) == []
    hub.availability(ctx.tenant.id, ctx.tenant.config, MON_9)
    subjects = [m.subject for m, _ in ctx.email.sent]
    assert subjects.count("Action needed: reconnect your Google Calendar") == 1
    assert subjects.count("היומן התנתק: Cool Breeze HVAC") == 1
    assert "reconnect" in ctx.twilio.outbox[0]["body"].lower() or "Reconnect" in ctx.twilio.outbox[0]["body"]


# --- channels ---------------------------------------------------------------------------------

def test_resend_adapter_sends_idempotent_request():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"id": "re-msg-1"})
    sender = ResendEmail("test-key-not-real", http=httpx.Client(transport=httpx.MockTransport(handler)))
    res = sender.send(Email(to=("a@example.com",), subject="S", text="T", html="<p>T</p>", sender="X <x@example.com>",
                            reply_to="r@example.com", tag="lead_alert"), "idem-1")
    assert res == {"ok": True, "id": "re-msg-1"}
    req = seen[0]
    assert str(req.url) == "https://api.resend.com/emails" and req.headers["Idempotency-Key"] == "idem-1"
    assert req.headers["Authorization"] == "Bearer test-key-not-real"
    body = json.loads(req.content)
    assert body["to"] == ["a@example.com"] and body["reply_to"] == "r@example.com" and body["text"] == "T"


@pytest.mark.parametrize("resp", [httpx.Response(500), httpx.ConnectError("x")])
def test_resend_failures_return_not_ok(resp):
    def handler(req):
        if isinstance(resp, Exception):
            raise resp
        return resp
    sender = ResendEmail("k", http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert sender.send(Email(("a@example.com",), "S", "T", "H", "x@example.com"), "i")["ok"] is False


def test_outbox_email_records_instead_of_sending(tmp_path):
    store = JsonStore(tmp_path)
    assert OutboxEmail(store).send(Email(("a@example.com",), "S", "T", "H", "x@example.com"), "i")["ok"]
    assert store.select("events")[0]["type"] == "email.outbox"


def test_twilio_sms_errors_are_caught():
    class Boom:
        class messages:  # noqa: N801
            @staticmethod
            def create(**_):
                raise RuntimeError("twilio down")
    assert TwilioSms(Boom()).send("+1", "+2", "hi", "i") == {"ok": False, "error": "RuntimeError"}


# --- structured logging + cost -----------------------------------------------------------------

def test_record_call_is_idempotent_costed_and_logs_no_pii(ctx, caplog):
    caplog.set_level(logging.INFO, logger="rt.calllog")
    transcript = [{"who": "customer", "text": "my ac is broken, I'm Dana at 555-0123"},
                  {"who": "assistant", "text": "Sorry to hear that"}]
    row = record_call(ctx.store, ctx.tenant, call_sid="CAabc", from_e164="+17135550123", started_at=MON_9,
                      duration_s=125, outcome="message", transcript=transcript, summary="AC broken",
                      claude_cost_usd=0.05, claude_calls=2, turn_ms=[120, 80, 300], state=ctx.state,
                      env={"TWILIO_VOICE_USD_PER_MIN": "0.01"})
    assert row["cost_usd"] == pytest.approx(0.08)  # 3 billed minutes x 0.01 + 0.05
    record_call(ctx.store, ctx.tenant, call_sid="CAabc", from_e164="+17135550123", started_at=MON_9,
                duration_s=125, outcome="booked", transcript=transcript, state=ctx.state,
                env={"TWILIO_VOICE_USD_PER_MIN": "0.01"})
    rows = ctx.store.for_tenant(ctx.tenant.id).select("calls")
    assert len(rows) == 1 and rows[0]["outcome"] == "booked"
    assert ctx.state.get(twilio_cost_key(ctx.tenant.id, "2026-10-12")) == pytest.approx(0.03)  # once, tenant day
    lines = [r.getMessage() for r in caplog.records if r.name == "rt.calllog"]
    assert lines and all("7135550123" not in l and "Dana" not in l and "CAabc" not in l for l in lines)
    first = json.loads(lines[0])
    assert first["p95_turn_ms"] == pytest.approx(282.0) and first["p50_turn_ms"] == 120.0 and first["turns"] == 1


def test_record_sms_matches_schema_and_tracks_cost(ctx, caplog):
    caplog.set_level(logging.INFO, logger="rt.calllog")
    row = record_sms(ctx.store, ctx.tenant, twilio_sid="SMx1", contact_e164="+17135550123", direction="outbound",
                     body="Hi, this is Cool Breeze HVAC", segments=2, state=ctx.state,
                     env={"TWILIO_SMS_USD_PER_SEGMENT": "0.01"})
    assert set(row) >= {"contact_e164", "direction", "body", "twilio_sid"} and "cost_usd" not in row
    record_sms(ctx.store, ctx.tenant, twilio_sid="SMx1", contact_e164="+17135550123", direction="outbound",
               body="dup", segments=2, state=ctx.state)
    assert len(ctx.store.for_tenant(ctx.tenant.id).select("sms_messages")) == 1
    day = datetime.now(ZoneInfo("America/Chicago")).date().isoformat()
    assert ctx.state.get(twilio_cost_key(ctx.tenant.id, day)) == pytest.approx(0.02)
    assert all("Cool Breeze" not in r.getMessage() for r in caplog.records)


def test_percentile_edges():
    assert percentile([], 95) is None and percentile([5], 50) == 5 and percentile([1, 2, 3, 4], 50) == 2.5


def test_city_parsing():
    assert T.city_of("2100 Rice Blvd, Houston, TX 77005") == "Houston"
    assert T.city_of("2100 Rice Blvd, Houston 77005") == "Houston"
    assert T.city_of("2100 Rice Blvd 77005") == "ZIP 77005"
    assert T.city_of("") == "-"


def test_evening_call_cost_lands_on_the_tenant_day_for_admin_daily(ctx):
    """A 22:30 Chicago call is 03:30 UTC the next day: it must count for the Chicago day (review)."""
    from app.reports import Reporter
    evening = datetime(2026, 10, 12, 22, 30, tzinfo=ZoneInfo("America/Chicago"))
    record_call(ctx.store, ctx.tenant, call_sid="CAeve", from_e164="+17135550123", started_at=evening,
                duration_s=300, outcome="message", transcript=[], state=ctx.state,
                env={"TWILIO_VOICE_USD_PER_MIN": "0.01"})
    rep = Reporter(ctx.store, ctx.state, ctx.notifier)
    data = rep.admin_daily_data([ctx.tenant], datetime(2026, 10, 13, 8, 0, tzinfo=ZoneInfo("Asia/Jerusalem")))
    assert data["tenants"][0]["twilio_usd"] > 0 and data["tenants"][0]["calls"] == 1
