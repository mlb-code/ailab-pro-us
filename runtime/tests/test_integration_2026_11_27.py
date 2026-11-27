"""Launch integration follow-ups (2026-11-27), after the copy/legal and runtime branches were merged:

- Daily summary: the texting rows ("Text conversations", "Missed callers texted back") show only with SMS_ENABLED on.
- Chat box notice: says the visitor is chatting with an AI assistant and that the chat is saved to help the business.
- Children: a caller who says or clearly appears to be under 13 is not asked for personal details.
- Real estate: the fair-housing guard names every protected characteristic; no motivation question.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from app.notify import templates as T

from test_b6_reports import R, seed_day

CHI = ZoneInfo("America/Chicago")
DAY = {"calls_answered": 3, "booked": 1, "messages": 1, "urgent": 0, "sms_threads": 2, "text_backs": 1,
       "date": "2026-10-12", "leads": []}
SMS_ROWS = ("Text conversations", "Missed callers texted back")


# --- daily summary vs SMS_ENABLED --------------------------------------------------------------------------------
def test_daily_summary_hides_texting_rows_when_sms_is_off():
    _, text, html = T.daily_summary("Cool Breeze HVAC", DAY, sms_enabled=False)
    for row in SMS_ROWS:
        assert row not in text and row not in html
    assert "Calls answered: 3" in text and "Jobs booked: 1" in text and "Messages taken: 1" in text


def test_daily_summary_default_is_off_like_production():
    _, text, _ = T.daily_summary("Cool Breeze HVAC", DAY)
    assert not any(row in text for row in SMS_ROWS)


def test_daily_summary_shows_texting_rows_when_sms_is_on():
    _, text, html = T.daily_summary("Cool Breeze HVAC", DAY, sms_enabled=True)
    assert "Text conversations: 2" in text and "Missed callers texted back: 1" in text
    assert all(row in html for row in SMS_ROWS)


def _daily_text(tmp_path, demo_raw, sms_on: bool) -> str:
    r = R(tmp_path, demo_raw)
    r.notifier.policy.sms_enabled = sms_on
    day = datetime(2026, 10, 12, 0, 0, tzinfo=CHI)
    seed_day(r, day)
    res = r.rep.daily(r.tenant, day.replace(hour=19, minute=5))
    assert res and res["sent"][0]["status"] == "sent"
    return [m.text for m, _ in r.email.sent if m.subject.startswith("Today:")][-1]


def test_reporter_passes_the_switch_off(tmp_path, demo_raw):
    text = _daily_text(tmp_path, demo_raw, sms_on=False)
    assert "Calls answered:" in text and not any(row in text for row in SMS_ROWS)


def test_reporter_passes_the_switch_on(tmp_path, demo_raw):
    text = _daily_text(tmp_path, demo_raw, sms_on=True)
    assert "Text conversations: 1" in text and "Missed callers texted back:" in text


# --- chat box notice ----------------------------------------------------------------------------------------------
def test_chat_notice_is_one_short_sentence_about_ai_and_saving():
    from app.chat_widget import NOTICE
    assert NOTICE.startswith("You're chatting with an AI assistant")
    assert "saved to help the business respond" in NOTICE
    assert NOTICE.count(".") == 1 and NOTICE.endswith(".") and len(NOTICE) <= 140


# --- children under 13 -------------------------------------------------------------------------------------------
import json  # noqa: E402

import pytest  # noqa: E402

from app import brain, guard  # noqa: E402
from app.tenants import load_file, load_record, validate_config  # noqa: E402
from sim import harness  # noqa: E402

HVAC = load_file(harness.TENANTS_DIR / "demo-hvac.json").config
REALTY_RAW = json.loads((harness.TENANTS_DIR / "demo-realty.json").read_text())
REALTY = load_record(REALTY_RAW).config


@pytest.mark.parametrize("cfg", [HVAC, REALTY], ids=["home_services", "real_estate"])
@pytest.mark.parametrize("channel", ["voice", "sms", "chat"])
def test_every_prompt_carries_the_child_rule(cfg, channel):
    p = brain.system_prompt(cfg, channel)
    assert brain.CHILD_RULE in p
    assert "under 13" in p and "parent or guardian" in p and "child caller" in p


@pytest.mark.parametrize("scenario", ["66-voice-child-caller", "67-re-sms-child-caller"])
def test_child_caller_scenarios_pass_in_mock_mode(tmp_path, scenario):
    """The scenario files assert: take_message only, no name / ZIP / address / screening question, the parent line."""
    from sim import scenarios
    res = scenarios.run(scenarios.SCENARIOS_DIR / f"{scenario}.yaml", mode="mock", data_dir=tmp_path)
    assert res.ok, res.failures
    replies = [t or "" for who, t in res.transcript if who != "customer"]
    assert any("parent or guardian" in t for t in replies) and not any("Timmy" in t for t in replies)


# --- fair housing: protected characteristics + no motivation question ----------------------------------------------
def test_fair_housing_rule_names_every_protected_characteristic():
    rule = brain.RE_FAIR_HOUSING_RULE
    for word in ("race or color", "religion", "national origin", "sex", "familial status", "disability", "source of income"):
        assert word in rule, word
    assert "never ask why someone is moving" in rule and "do not save it in qualify_lead" in rule
    for channel in ("voice", "sms", "chat"):
        assert rule in brain.system_prompt(REALTY, channel)


@pytest.mark.parametrize("text", [
    "That building doesn't take Section 8 vouchers.",
    "Do you get any government assistance?",
    "How many kids do you have?",
    "Congratulations, are you pregnant?",
    "Mueller is popular with single moms.",
    "What's your nationality?",
    "It's a mostly Caucasian area.",
    "Is anyone in the household mentally ill?",
    "What's prompting the move?",
    "Why are you selling?",
    "Which religion do you practice?",
])
def test_fair_housing_guard_blocks_the_new_characteristics(text):
    out = guard.check_reply(text, REALTY, "sms")
    assert "fair_housing" in out.violations and out.text == guard.FAIR_HOUSING_TEXT


@pytest.mark.parametrize("text", [
    "1420 Oak Ridge Dr has an accent wall and new blinds.",
    "The open house in Temple is Saturday at 10.",
    "Jenna can meet you Monday at 3 PM. What's the property address?",
])
def test_fair_housing_guard_lets_listing_facts_through(text):
    assert "fair_housing" not in guard.check_reply(text, REALTY, "sms").violations


def test_motivation_is_never_asked_offered_or_kept():
    p = brain.system_prompt(REALTY, "sms")
    assert "why they are selling" not in p and "prompting the move" not in p
    qualify = next(t for t in brain.tools(REALTY, "sms") if t["name"] == "qualify_lead")
    assert "motivation" not in qualify["input_schema"]["properties"]
    # a config saved before the change still validates (schema + SQL accept the old value) and loads without it
    old = json.loads(json.dumps(REALTY_RAW["config"]))
    old["real_estate"]["screening"] = ["intent", "area", "motivation", "has_agent"]
    assert validate_config(old).real_estate.screening == ["intent", "area", "has_agent"]
    from app.tenants import SCREENING_QUESTIONS, RealEstate
    assert "motivation" not in SCREENING_QUESTIONS and "motivation" not in RealEstate().screening
