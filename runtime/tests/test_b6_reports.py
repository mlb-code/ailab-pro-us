"""B6: daily summary (tenant timezone), monthly ROI report, admin_daily, /jobs/tick, /reports, /health/deep."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app import settings as settings_mod
from app.main import create_app
from app.notify import Notifier, NotifyPolicy, TwilioSms
from app.notify import templates as T
from app.notify.calllog import twilio_cost_key
from app.notify.routes import SIM_ADMIN_TOKEN, build_services, router
from app.reports import Reporter, avg_job_value_key, monthly_roi_data
from app.store import JsonStore, StateStore
from app.tenants import load_record
from sim import harness
from sim.fake_twilio import FakeTwilioClient

from test_b6_notify import ADMIN, RecEmail

CHI = ZoneInfo("America/Chicago")
IL = ZoneInfo("Asia/Jerusalem")


class R:
    def __init__(self, tmp_path, demo_raw, live=True, enabled=True):
        raw = json.loads(json.dumps(demo_raw))
        raw["status"] = "live" if live else "sandbox"
        self.store = JsonStore(tmp_path)
        self.tenant = self.store.upsert_tenant(load_record(raw))
        self.state = StateStore(self.store)
        self.email = RecEmail()
        self.notifier = Notifier(self.store, self.state, self.email, TwilioSms(FakeTwilioClient()), None,
                                 NotifyPolicy(client_emails_enabled=enabled, admin_email=ADMIN,
                                                  admin_tz="Asia/Jerusalem"))
        self.rep = Reporter(self.store, self.state, self.notifier)
        self.ts = self.store.for_tenant(self.tenant.id)

    def call(self, when: datetime, outcome: str, sid: str):
        self.ts.insert("calls", {"call_sid": sid, "from_e164": "+17135550123", "started_at": when.isoformat(),
                                 "duration_s": 90, "outcome": outcome, "transcript": [], "summary": ""})

    def booking(self, when: datetime, name="Dana Miller", status="confirmed"):
        row = self.ts.insert("bookings", {"customer_name": name, "contact_e164": "+17135550123", "job_type": "AC repair",
                                          "start_at": (when + timedelta(days=1)).isoformat(), "status": status})
        self.store.update("bookings", row["id"], {"created_at": when.isoformat()})

    def subjects(self, to):
        return [m.subject for m, _ in self.email.sent if m.to == to]


def seed_day(r: R, day: datetime):
    r.call(day.replace(hour=9), "booked", "CA1")
    r.call(day.replace(hour=10), "message", "CA2")
    r.call(day.replace(hour=20), "emergency", "CA3")  # after hours (closes 18:00)
    r.call(day.replace(hour=11), "spam", "CA4")
    r.call(day.replace(hour=12), "abandoned", "CA5")
    r.booking(day.replace(hour=9, minute=5))
    r.booking(day.replace(hour=9, minute=30), name="Cancelled Guy", status="cancelled")
    r.ts.insert("sms_messages", {"contact_e164": "+17135550999", "direction": "inbound", "body": "hi",
                                 "twilio_sid": "SM1", "created_at": day.replace(hour=13).isoformat()})


def test_daily_summary_waits_for_local_time_runs_once_and_counts(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    day = datetime(2026, 10, 12, 0, 0, tzinfo=CHI)
    r.call(day.replace(hour=9), "booked", "CA1")
    r.call(day.replace(hour=10), "message", "CA2")
    r.call(day.replace(hour=11), "spam", "CA4")
    r.booking(day.replace(hour=9, minute=5))
    assert r.rep.daily(r.tenant, day.replace(hour=18, minute=59)) is None  # 19:00 Chicago not reached
    res = r.rep.daily(r.tenant, day.replace(hour=19, minute=1))
    assert res["sent"][0]["status"] == "sent"
    assert r.subjects(("owner@example.com",)) == ["Today: 2 calls answered, 1 booked"]
    assert r.rep.daily(r.tenant, day.replace(hour=21)) is None
    stored = [e for e in r.ts.select("events") if e["type"] == "report.daily_summary"]
    assert len(stored) == 1 and stored[0]["client_visible"] and stored[0]["payload"]["messages"] == 1
    # a call after the summary is counted in the next day's summary, not lost
    r.call(day.replace(hour=20), "message", "CA9")
    nxt = r.rep.daily(r.tenant, (day + timedelta(days=1)).replace(hour=19, minute=5))
    assert nxt and r.subjects(("owner@example.com",))[-1] == "Today: 1 calls answered, 0 booked"


def test_daily_summary_respects_each_tenant_timezone(tmp_path, demo_raw):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["business"]["timezone"] = "America/Los_Angeles"
    r = R(tmp_path, raw)
    t = datetime(2026, 10, 12, 19, 30, tzinfo=CHI)  # 17:30 in Los Angeles
    assert r.rep.daily(r.tenant, t) is None
    assert r.rep.daily(r.tenant, t + timedelta(hours=2)) is not None


def test_daily_summary_not_emailed_when_not_live_or_disabled(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw, live=False)
    res = r.rep.daily(r.tenant, datetime(2026, 10, 12, 19, 30, tzinfo=CHI))
    assert res["sent"][0]["reason"] == "tenant_not_live" and r.email.sent == []
    assert any(e["type"] == "report.daily_summary" for e in r.ts.select("events"))
    r2 = R(tmp_path / "b", demo_raw, enabled=False)
    res = r2.rep.daily(r2.tenant, datetime(2026, 10, 12, 19, 30, tzinfo=CHI))
    assert res["sent"][0]["reason"] == "client_emails_disabled" and r2.email.sent == []


def test_monthly_roi_report(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    seed_day(r, datetime(2026, 9, 15, 0, 0, tzinfo=CHI))
    r.call(datetime(2026, 10, 1, 9, 0, tzinfo=CHI), "booked", "CA-oct")  # next month, not counted
    r.state.put(f"usage:{r.tenant.id}:2026-09:voice_minutes", 120.0)
    r.state.put(f"usage:{r.tenant.id}:2026-09:sms_segments", 300.0)
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)
    assert r.rep.monthly(r.tenant, datetime(2026, 10, 1, 8, 59, tzinfo=CHI)) is None
    res = r.rep.monthly(r.tenant, datetime(2026, 10, 1, 9, 0, tzinfo=CHI))
    assert res["month"] == "2026-09"
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-09")
    fee = T.pricebook_item("RCP")["monthly_cents"] / 100
    assert data["calls_answered"] == 3 and data["after_hours_calls"] == 1 and data["booked"] == 1
    assert data["messages"] == 1 and data["urgent"] == 1 and data["text_backs"] == 1 and data["spam"] == 1
    assert data["usage"] == {"sms_segments": 300.0, "voice_minutes": 120.0}
    assert data["included"] == {"voice_minutes": 400.0, "sms_segments": 1000.0}
    assert data["est_value_usd"] == 450.0 and data["roi_multiple"] == round(450 / fee, 2)
    assert r.subjects(("owner@example.com",)) == ["Your September 2026 report: 3 calls answered, 1 booked"]
    body = r.email.sent[0][0].text
    assert "120 of 400" in body and "estimate, not revenue" in body
    assert r.rep.monthly(r.tenant, datetime(2026, 10, 20, 9, 0, tzinfo=CHI)) is None  # once per month
    stored = [e for e in r.ts.select("events") if e["type"] == "report.monthly_roi"]
    assert len(stored) == 1 and stored[0]["client_visible"]


def test_monthly_without_job_value_or_activity(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    res = r.rep.monthly(r.tenant, datetime(2026, 10, 2, 12, 0, tzinfo=CHI))
    assert res["sent"][0]["reason"] == "no_activity"
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-09")
    assert data["est_value_usd"] is None and data["roi_multiple"] is None
    subject, text, _ = T.monthly_roi("Cool Breeze HVAC", data)
    assert "set your average job value" in text


def test_admin_daily_in_hebrew_at_eight_israel_time(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    seed_day(r, datetime(2026, 10, 12, 0, 0, tzinfo=CHI))
    r.state.put(f"spend:{r.tenant.id}:2026-10-12", 0.42)
    r.state.put(twilio_cost_key(r.tenant.id, "2026-10-12"), 0.11)
    r.state.put(f"usage:{r.tenant.id}:2026-10:needs_addon_approval", True)
    r.state.put(f"cal:{r.tenant.id}:needs_reconnect", {"provider": "google"})
    r.state.put("admin:deferred", ["שימוש 80%: Cool Breeze HVAC · דקות שיחה"])
    assert r.rep.admin_daily(datetime(2026, 10, 13, 7, 59, tzinfo=IL)) is None
    res = r.rep.admin_daily(datetime(2026, 10, 13, 8, 0, tzinfo=IL))
    assert res["sent"]["status"] == "sent"
    msg = r.email.sent[0][0]
    assert msg.to == (ADMIN,) and msg.lang == "he" and 'dir="rtl"' in msg.html
    assert msg.subject.startswith("סיכום יומי 2026-10-13:") and "עלות $0.53" in msg.subject
    assert "needs_addon_approval" in msg.text and "calendar_reconnect:google" in msg.text
    assert "שימוש 80%" in msg.text and '<span dir="ltr">$0.42</span>' in msg.html
    assert r.state.get("admin:deferred") == []
    assert r.rep.admin_daily(datetime(2026, 10, 13, 12, 0, tzinfo=IL)) is None


def test_run_due_isolates_failures(tmp_path, demo_raw, monkeypatch):
    r = R(tmp_path, demo_raw)
    monkeypatch.setattr(r.rep, "monthly", lambda t, now: (_ for _ in ()).throw(RuntimeError("x")))
    ran = r.rep.run_due(datetime(2026, 10, 12, 19, 30, tzinfo=CHI))
    jobs = {(x["job"], bool(x.get("error"))) for x in ran}
    assert ("daily_summary", False) in jobs and ("<lambda>", True) in jobs  # 03:30 in Israel: no admin_daily yet
    assert not any(x["job"] == "admin_daily" for x in ran)


# --- endpoints ------------------------------------------------------------------------------

@pytest.fixture
def web(tmp_path, demo_raw):
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    store.upsert_tenant(load_record(demo_raw))
    app = create_app(settings, store)
    app.include_router(router)
    return TestClient(app), app


AUTH = {"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}


def test_report_endpoints(web):
    client, app = web
    assert client.post("/jobs/tick").status_code == 401
    assert isinstance(client.post("/jobs/tick", headers=AUTH).json()["ran"], list)
    assert client.get("/reports/demo-hvac/daily", params={"date": "2026-10-12"}, headers=AUTH).json()["calls_answered"] == 0
    assert client.get("/reports/demo-hvac/daily", params={"date": "12/10"}, headers=AUTH).status_code == 400
    assert client.get("/reports/nope/daily", headers=AUTH).status_code == 404
    assert client.get("/reports/demo-hvac/monthly", params={"month": "2026-9x"}, headers=AUTH).status_code == 400
    assert client.put("/reports/demo-hvac/settings", json={"avg_job_value_usd": "abc"}, headers=AUTH).status_code == 400
    assert client.put("/reports/demo-hvac/settings", json={"avg_job_value_usd": -5}, headers=AUTH).status_code == 400
    assert client.put("/reports/demo-hvac/settings", json={"avg_job_value_usd": 350}, headers=AUTH).json()["ok"]
    m = client.get("/reports/demo-hvac/monthly", params={"month": "2026-10"}, headers=AUTH).json()
    assert m["avg_job_value_usd"] == 350.0 and m["est_value_usd"] == 0.0


def test_health_deep_sim_ok_and_prod_reports_missing_config_without_values(tmp_path, demo_raw):
    client, _ = None, None
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    app = create_app(settings, store)
    app.include_router(router)
    r = TestClient(app).get("/health/deep")
    assert r.status_code == 200 and r.json()["ok"]
    prod = settings_mod.load({"RUNTIME_MODE": "prod", "STORE_BACKEND": "json", "DATA_DIR": str(tmp_path / "p"),
                              "TWILIO_AUTH_TOKEN": "tok-value-should-not-leak", "BRAIN_MODE": "mock"})
    app2 = create_app(prod, JsonStore(tmp_path / "p"))
    app2.include_router(router)
    app2.state.b56 = build_services(prod, app2.state.store, env={})
    r2 = TestClient(app2).get("/health/deep")
    assert r2.status_code == 503
    body = r2.json()
    assert body["checks"]["twilio_auth_token"] is True and body["checks"]["cred_key"] is False
    assert body["checks"]["admin_token"] is False and "tok-value-should-not-leak" not in r2.text
    assert TestClient(app2).post("/jobs/tick", headers=AUTH).status_code == 503  # no admin token in prod


def test_failed_report_send_is_retried_on_the_next_tick(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    r.email.fail = 1
    t = datetime(2026, 10, 12, 19, 30, tzinfo=CHI)
    first = r.rep.daily(r.tenant, t)
    assert first["retry"] and r.email.sent == []
    second = r.rep.daily(r.tenant, t + timedelta(minutes=10))
    assert second["sent"][0]["status"] == "sent" and r.rep.daily(r.tenant, t + timedelta(minutes=20)) is None
    assert len([e for e in r.ts.select("events") if e["type"] == "report.daily_summary"]) == 1  # stored once
    r.email.fail = 1
    il = datetime(2026, 10, 13, 8, 0, tzinfo=IL)
    assert r.rep.admin_daily(il)["retry"]
    assert r.rep.admin_daily(il + timedelta(minutes=10))["sent"]["status"] == "sent"


def test_jobs_tick_is_the_single_cron_endpoint(web):
    client, app = web
    body = client.post("/jobs/tick", headers=AUTH).json()
    assert set(body) >= {"sms_jobs", "deliveries", "ran"}


def test_health_deep_pings_claude_in_live_mode(tmp_path, monkeypatch):
    import sys
    import types
    from app.notify import routes as routes_mod
    calls = []

    class FakeModels:
        def retrieve(self, model):
            calls.append(model)
            return {"id": model}

    class FakeAnthropic:
        def __init__(self, **kw):
            self.models = FakeModels()
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=FakeAnthropic))
    routes_mod._PING.clear()
    live = settings_mod.load({"RUNTIME_MODE": "sim", "STORE_BACKEND": "json", "DATA_DIR": str(tmp_path),
                              "BRAIN_MODE": "live"})
    assert routes_mod.claude_ping(live) and routes_mod.claude_ping(live) and len(calls) == 1  # cached
    routes_mod._PING.clear()

    class Down(FakeAnthropic):
        def __init__(self, **kw):
            raise RuntimeError("no key")
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=Down))
    assert routes_mod.claude_ping(live) is False
    mock = settings_mod.load({"RUNTIME_MODE": "sim", "STORE_BACKEND": "json", "DATA_DIR": str(tmp_path)})
    assert routes_mod.claude_ping(mock) is True  # simulated in mock/replay
    routes_mod._PING.clear()
