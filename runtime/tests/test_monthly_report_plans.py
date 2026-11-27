"""Monthly report for FirstRing PLAN tenants (fix 2026-11-27): the report covers a calendar month, plan clients are
metered per billing period (`usage:<tenant>:p<period start>:*`). The report now shows the minutes of the calls in that
calendar month, the plan's included minutes (per billing period, or the free trial's total) and the plan's monthly
price from the price book; never the RCP allowance (400 minutes) or the RCP fee ($300). RCP / quote clients unchanged."""
from __future__ import annotations

import copy
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app import plans
from app.notify import templates as T
from app.reports import avg_job_value_key, monthly_roi_data
from app.usage import UsageMeter

from test_b6_reports import R
from test_firstring_plans import FIXTURE

CHI = ZoneInfo("America/Chicago")


@pytest.fixture(autouse=True)
def catalog():
    plans.set_catalog(FIXTURE, {"trial_minutes": 100})
    yield
    plans.set_catalog(None)


def plan_raw(demo_raw: dict, **plan) -> dict:
    raw = copy.deepcopy(demo_raw)
    raw["config"]["plan"] = {"code": "FR_STARTER", "status": "active", "period_start": "2026-11-15",
                             "period_end": "2026-12-15T00:00:00+00:00", **plan}
    return raw


def metered_call(r: R, when: datetime, sid: str, duration_s: int, outcome: str = "booked") -> None:
    """A call as production leaves it: a calls row with Twilio's duration, and the minutes in the usage meter (plan
    clients: the plan period's counter)."""
    r.ts.insert("calls", {"call_sid": sid, "from_e164": "+17135550123", "started_at": when.isoformat(),
                          "duration_s": duration_s, "outcome": outcome, "transcript": [], "summary": ""})
    UsageMeter(r.state).record(r.tenant, "voice", -(-duration_s // 60), when)


def seed_november(r: R) -> None:
    metered_call(r, datetime(2026, 11, 3, 10, 0, tzinfo=CHI), "CA1", 125)            # 3 min
    metered_call(r, datetime(2026, 11, 20, 11, 0, tzinfo=CHI), "CA2", 240, "message")  # 4 min
    metered_call(r, datetime(2026, 11, 30, 23, 0, tzinfo=CHI), "CA3", 61)             # 2 min (last evening)
    metered_call(r, datetime(2026, 12, 1, 0, 30, tzinfo=CHI), "CA4", 600)             # December: not counted
    r.ts.insert("calls", {"call_sid": "CA5", "from_e164": "+17135550124",              # rang, never connected
                          "started_at": datetime(2026, 11, 21, 9, 0, tzinfo=CHI).isoformat(), "duration_s": 0,
                          "outcome": "abandoned", "transcript": [], "summary": ""})
    r.booking(datetime(2026, 11, 3, 10, 5, tzinfo=CHI))


def test_plan_report_shows_the_months_minutes_the_plan_allowance_and_the_plan_price(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw))
    seed_november(r)
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)
    assert r.state.get(f"usage:{r.tenant.id}:p2026-11-15:voice_minutes") == 19  # the meter counts per plan period (incl. Dec 1)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    assert data["usage"]["voice_minutes"] == 9  # 3 + 4 + 2: November's calls, rounded up per call like the meter
    assert data["plan"] == {"code": "FR_STARTER", "name": "Starter", "status": "active", "trial": False,
                            "included_minutes": 200.0, "monthly_price_usd": 149.0}
    assert data["monthly_fee_usd"] == 149.0 and data["roi_multiple"] == round(450 / 149, 2)
    _, text, html = T.monthly_roi("Cool Breeze HVAC", data)
    assert "Voice minutes used: 9 (your Starter plan includes 200 minutes each billing period)" in text
    assert "Value vs. your Starter plan price ($149/month): 3.0x" in text
    assert "of 400" not in text and "$300" not in text and "SMS segments" not in text
    assert "Your plan's included minutes start over on each billing date" in text
    assert "Starter plan includes 200 minutes each billing period" in html


def test_plan_report_is_sent_with_the_plan_numbers(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw, code="FR_PRO"))
    seed_november(r)
    res = r.rep.monthly(r.tenant, datetime(2026, 12, 1, 9, 0, tzinfo=CHI))
    assert res["month"] == "2026-11" and res["sent"][0]["status"] == "sent"
    body = r.email.sent[0][0].text
    assert "Voice minutes used: 9 (your Pro plan includes 500 minutes each billing period)" in body
    assert "Value vs." not in body  # no average job value set yet: no value line at all
    stored = [e for e in r.ts.select("events") if e["type"] == "report.monthly_roi"]
    assert stored[0]["payload"]["plan"]["included_minutes"] == 500.0


@pytest.mark.parametrize("code,minutes,price", [("FR_STARTER", 200, 149), ("FR_PRO", 500, 249),
                                                ("FR_BUSINESS", 1000, 399)])
def test_every_plan_uses_its_own_minutes_and_price(tmp_path, demo_raw, code, minutes, price):
    r = R(tmp_path, plan_raw(demo_raw, code=code))
    seed_november(r)
    r.state.put(avg_job_value_key(r.tenant.id), 1000.0)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    _, text, _ = T.monthly_roi("Cool Breeze HVAC", data)
    assert f"includes {minutes:,} minutes each billing period" in text
    assert f"plan price (${price}/month): {1000 / price:.1f}x" in text


def test_trial_report_counts_against_the_trial_minutes_and_never_against_a_fee(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw, status="trialing", period_start="2026-11-20T1500",
                             trial_ends_at="2026-12-04T15:00:00+00:00", period_end="2026-12-04T15:00:00+00:00"))
    metered_call(r, datetime(2026, 11, 22, 10, 0, tzinfo=CHI), "CA1", 300)
    r.booking(datetime(2026, 11, 22, 10, 5, tzinfo=CHI))
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    assert data["usage"]["voice_minutes"] == 5 and data["plan"]["trial"] is True
    assert data["plan"]["included_minutes"] == 100.0
    assert data["monthly_fee_usd"] is None and data["roi_multiple"] is None
    _, text, _ = T.monthly_roi("Cool Breeze HVAC", data)
    assert "Voice minutes used: 5 (your free trial includes 100 minutes in total)" in text
    assert "Estimated value of booked jobs: $450 (1 x $450 average job)" in text
    assert "Value vs." not in text and "$149" not in text


def test_month_spent_entirely_in_the_trial_is_not_compared_with_the_fee_paid_afterwards(tmp_path, demo_raw):
    """Trial Nov 17 - Dec 1, first charge Dec 1 before the report: November cost the client nothing."""
    r = R(tmp_path, plan_raw(demo_raw, status="active", period_start="2026-12-01T1500",
                             trial_ends_at="2026-12-01T15:00:00+00:00", period_end="2027-01-01T15:00:00+00:00"))
    metered_call(r, datetime(2026, 11, 22, 10, 0, tzinfo=CHI), "CA1", 300)
    r.booking(datetime(2026, 11, 22, 10, 5, tzinfo=CHI))
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    assert data["plan"]["monthly_price_usd"] == 149.0 and data["roi_multiple"] is None
    _, text, _ = T.monthly_roi("Cool Breeze HVAC", data)
    assert "Voice minutes used: 5 (your Starter plan includes 200 minutes each billing period)" in text
    assert "Value vs." not in text
    # the month the trial ended in (Nov 24): a fee was paid in that month, so the comparison is shown
    r2 = R(tmp_path / "b", plan_raw(demo_raw, trial_ends_at="2026-11-24T15:00:00+00:00", period_start="2026-11-24T1500"))
    r2.booking(datetime(2026, 11, 25, 10, 5, tzinfo=CHI))
    r2.state.put(avg_job_value_key(r2.tenant.id), 450.0)
    assert monthly_roi_data(r2.store, r2.state, r2.tenant, "2026-11")["roi_multiple"] == round(450 / 149, 2)


@pytest.mark.parametrize("status", ["past_due", "paused", "canceled"])
def test_unpaid_or_ended_plan_has_no_fee_comparison(tmp_path, demo_raw, status):
    r = R(tmp_path, plan_raw(demo_raw, status=status))
    seed_november(r)
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    assert data["roi_multiple"] is None and data["monthly_fee_usd"] is None
    assert "Value vs." not in T.monthly_roi("Cool Breeze HVAC", data)[1]


def test_plan_changed_mid_month_uses_the_months_calls_and_the_current_plan(tmp_path, demo_raw):
    """Starter from Nov 15, upgraded to Pro on Nov 20 (a new period and counter from Nov 20): the minutes are November's
    calls from both periods, compared with the plan the client has now."""
    r = R(tmp_path, plan_raw(demo_raw, code="FR_PRO", period_start="2026-11-20", period_end="2026-12-20T00:00:00+00:00"))
    r.ts.insert("calls", {"call_sid": "CA1", "from_e164": "+17135550123",  # on Starter, counted in the old period
                          "started_at": datetime(2026, 11, 17, 10, 0, tzinfo=CHI).isoformat(), "duration_s": 600,
                          "outcome": "booked", "transcript": [], "summary": ""})
    r.state.put(f"usage:{r.tenant.id}:p2026-11-15:voice_minutes", 10.0)
    metered_call(r, datetime(2026, 11, 25, 10, 0, tzinfo=CHI), "CA2", 420)  # on Pro: 7 min
    assert r.state.get(f"usage:{r.tenant.id}:p2026-11-20:voice_minutes") == 7
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    assert data["usage"]["voice_minutes"] == 17
    _, text, _ = T.monthly_roi("Cool Breeze HVAC", data)
    assert "Voice minutes used: 17 (your Pro plan includes 500 minutes each billing period)" in text


def test_unknown_plan_code_shows_the_minutes_without_a_comparison(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw, code="FR_LEGACY"))
    seed_november(r)
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    _, text, _ = T.monthly_roi("Cool Breeze HVAC", data)
    assert "Voice minutes used: 9\n" in text and "Value vs." not in text and "of 400" not in text


def test_plan_report_with_sms_on_still_has_no_sms_allowance_row(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw))
    seed_november(r)
    r.ts.insert("calls", {"call_sid": "CA9", "from_e164": "+17135550999",
                          "started_at": datetime(2026, 11, 5, 10, 0, tzinfo=CHI).isoformat(), "duration_s": 0,
                          "outcome": "abandoned", "transcript": [], "summary": ""})
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-11")
    on = T.monthly_roi("Cool Breeze HVAC", data, sms_enabled=True)[1]
    off = T.monthly_roi("Cool Breeze HVAC", data, sms_enabled=False)[1]
    assert "Missed callers texted back: 2" in on and "SMS segments" not in on  # plans include no SMS allowance
    assert "texted back" not in off and "SMS" not in off


def test_idle_plan_month_is_not_emailed(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw))
    UsageMeter(r.state).record(r.tenant, "voice", 30, datetime(2026, 12, 2, 10, 0, tzinfo=CHI))  # December only
    res = r.rep.monthly(r.tenant, datetime(2026, 12, 3, 9, 0, tzinfo=CHI))
    assert res["sent"][0]["reason"] == "no_activity" and r.email.sent == []


# --- RCP / quote clients: byte-for-byte as before -------------------------------------------------------------------
def rcp_month(r: R) -> None:
    day = datetime(2026, 9, 15, 0, 0, tzinfo=CHI)
    r.call(day.replace(hour=9), "booked", "CA1")
    r.call(day.replace(hour=10), "message", "CA2")
    r.call(day.replace(hour=20), "emergency", "CA3")
    r.call(day.replace(hour=12), "abandoned", "CA5")
    r.booking(day.replace(hour=9, minute=5))
    r.state.put(f"usage:{r.tenant.id}:2026-09:voice_minutes", 120.0)
    r.state.put(f"usage:{r.tenant.id}:2026-09:sms_segments", 300.0)
    r.state.put(avg_job_value_key(r.tenant.id), 450.0)


RCP_TEXT_SMS_OFF = """Your September 2026 report: 3 calls answered, 1 booked
Cool Breeze HVAC

Calls answered by the AI receptionist: 3
of them after hours: 1
Jobs booked: 1
Estimated value of booked jobs: $450 (1 x $450 average job)
Value vs. your monthly fee: 1.5x
Messages taken for call-back: 1
Urgent requests flagged: 1
Voice minutes used: 120 of 400

Estimated value uses the average job value you set; it is an estimate, not revenue.
Portal: """

RCP_TEXT_SMS_ON_ROWS = ("Urgent requests flagged: 1\nMissed callers texted back: 1\nVoice minutes used: 120 of 400\n"
                        "SMS segments used: 300 of 1000\n")


def test_rcp_report_is_unchanged(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    rcp_month(r)
    data = monthly_roi_data(r.store, r.state, r.tenant, "2026-09")
    assert "plan" not in data
    assert data["usage"] == {"sms_segments": 300.0, "voice_minutes": 120.0}
    assert data["included"] == {"voice_minutes": 400.0, "sms_segments": 1000.0}
    assert data["needs_addon_approval"] is False and data["monthly_fee_usd"] == 300.0
    subject, text, html = T.monthly_roi("Cool Breeze HVAC", data)
    assert text == RCP_TEXT_SMS_OFF + T.portal_url()
    assert RCP_TEXT_SMS_ON_ROWS in T.monthly_roi("Cool Breeze HVAC", data, sms_enabled=True)[1]
    assert ">Voice minutes used</td><td style=\"padding:4px 0\">120 of 400</td>" in html


def test_rcp_report_ignores_call_durations(tmp_path, demo_raw):
    """Quote clients keep reading the calendar-month counter (the calls' durations are not used for them)."""
    r = R(tmp_path, demo_raw)
    rcp_month(r)
    r.ts.insert("calls", {"call_sid": "CA8", "from_e164": "+17135550123",
                          "started_at": datetime(2026, 9, 16, 10, 0, tzinfo=CHI).isoformat(), "duration_s": 3600,
                          "outcome": "booked", "transcript": [], "summary": ""})
    assert monthly_roi_data(r.store, r.state, r.tenant, "2026-09")["usage"]["voice_minutes"] == 120.0


# --- neighbour: Meir's admin daily e-mail read the calendar-month counter too -------------------------------------
IL = ZoneInfo("Asia/Jerusalem")


def test_admin_daily_shows_a_plan_clients_current_period_against_the_plan(tmp_path, demo_raw):
    r = R(tmp_path, plan_raw(demo_raw))
    UsageMeter(r.state).record(r.tenant, "voice", 170, datetime(2026, 11, 20, 10, 0, tzinfo=CHI))  # 85% of 200
    UsageMeter(r.state).record(r.tenant, "sms", 40, datetime(2026, 11, 20, 10, 0, tzinfo=CHI))
    row = r.rep.admin_daily_data([r.tenant], datetime(2026, 11, 26, 8, 0, tzinfo=IL))["tenants"][0]
    assert (row["voice_pct"], row["sms_pct"], row["flags"]) == (85, None, [])
    UsageMeter(r.state).record(r.tenant, "voice", 30, datetime(2026, 11, 26, 10, 0, tzinfo=CHI))
    data = r.rep.admin_daily_data([r.tenant], datetime(2026, 11, 27, 8, 0, tzinfo=IL))
    assert data["tenants"][0]["voice_pct"] == 100 and data["tenants"][0]["flags"] == ["plan_minutes_used_up"]
    assert "<td>100% / -</td>" in T.admin_daily(data)[2]


def test_admin_daily_for_an_rcp_client_is_unchanged(tmp_path, demo_raw):
    r = R(tmp_path, demo_raw)
    r.state.put(f"usage:{r.tenant.id}:2026-10:voice_minutes", 100.0)
    r.state.put(f"usage:{r.tenant.id}:2026-10:sms_segments", 250.0)
    r.state.put(f"usage:{r.tenant.id}:2026-10:needs_addon_approval", True)
    data = r.rep.admin_daily_data([r.tenant], datetime(2026, 10, 13, 8, 0, tzinfo=IL))
    row = data["tenants"][0]
    assert (row["voice_pct"], row["sms_pct"], row["flags"]) == (25, 25, ["needs_addon_approval"])
    assert "<td>25% / 25%</td>" in T.admin_daily(data)[2]
