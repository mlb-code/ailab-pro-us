"""B2: brain + engine. All SPEC 6.9 scenarios in replay mode (no network), plus loop/fallback edges."""
from __future__ import annotations

import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app import brain, llm as llm_mod
from app.conversation import FALLBACK_TEXT, Engine
from app.llm import LLMClient, LLMError, cost_usd
from app.store import JsonStore
from app.tenants import load_record
from sim import harness, scenarios
from sim.fake_calendar import FakeCalendar

PATHS = scenarios.all_scenarios()
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))


def test_at_least_20_scenarios():
    assert len(PATHS) >= 20


@pytest.mark.parametrize("path", PATHS, ids=[p.stem for p in PATHS])
def test_scenario_replay(path, tmp_path):
    res = scenarios.run(path, mode="replay", data_dir=tmp_path)
    assert res.ok, "\n".join(res.failures)


@pytest.mark.parametrize("path", PATHS, ids=[p.stem for p in PATHS])
def test_scenario_mock(path, tmp_path):
    res = scenarios.run(path, mode="mock", data_dir=tmp_path)
    assert res.ok, "\n".join(res.failures)


def test_injection_never_yields_price_or_discount(tmp_path):
    res = scenarios.run(scenarios.SCENARIOS_DIR / "16-prompt-injection-discount.yaml", "replay", data_dir=tmp_path)
    replies = [t for who, t in res.transcript if who == "assistant"]
    assert res.ok and not any(re.search(r"\$\s?\d|\d+\s?%", r) for r in replies)


def test_budget_exceeded_makes_zero_claude_calls(tmp_path):
    res = scenarios.run(scenarios.SCENARIOS_DIR / "17-budget-exceeded.yaml", "replay", data_dir=tmp_path)
    assert res.ok and res.claude_calls == 0


# --- engine / brain edges ---------------------------------------------------------------

def _engine(tmp_path, demo_raw, mode="mock", script=None, live_call=None, **cfg_patch):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"].update(cfg_patch)
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(raw))
    client = LLMClient(settings, script=script, mode=mode, live_call=live_call)
    return Engine(store, client, FakeCalendar(), settings), tenant, client


def test_llm_error_falls_back_to_take_message(tmp_path, demo_raw):
    def boom(_req):
        raise LLMError("down")
    eng, t, _ = _engine(tmp_path, demo_raw, mode="live", live_call=boom)
    r = eng.handle(t, "sms", harness.CALLER, "my ac broke", "c1", MON_9)
    assert r.reply == FALLBACK_TEXT and r.outcome == "message" and "fallback:llm: LLMError" in r.guard
    assert any(a.get("kind") == "lead" for a in r.actions)


def test_refusal_falls_back(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw, script=[{"content": [], "stop_reason": "refusal"}])
    r = eng.handle(t, "sms", harness.CALLER, "hello", "c1", MON_9)
    assert r.reply == FALLBACK_TEXT and "fallback:refusal" in r.guard


def test_tool_loop_is_bounded(tmp_path, demo_raw):
    loop = {"content": [{"type": "tool_use", "id": "t1", "name": "end_conversation", "input": {"outcome": "no_action"}}],
            "stop_reason": "tool_use"}
    eng, t, client = _engine(tmp_path, demo_raw, script=[loop] * 10)
    r = eng.handle(t, "sms", harness.CALLER, "hello", "c1", MON_9)
    assert "fallback:too_many_iterations" in r.guard and client.calls == brain.MAX_ITERATIONS


def test_replay_miss_is_loud_and_safe(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw, mode="replay")
    eng.llm.namespace = "does-not-exist"
    r = eng.handle(t, "sms", harness.CALLER, "hello", "c1", MON_9)
    assert r.reply == FALLBACK_TEXT and "fallback:llm: ReplayMissing" in r.guard


def test_executor_rules(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw)
    c = eng.convo(t, "sms", harness.CALLER, "c1")
    ex = lambda name, args, policy="open": eng._execute(t, eng.store.for_tenant(t.id), c, "sms", MON_9, policy, [], name, args)  # noqa: E731
    assert ex("get_availability", {"job_type": "Pool cleaning", "zip": "77005"})["reason"] == "unknown_job_type"
    assert ex("get_availability", {"job_type": "AC repair", "zip": "77005"}, "message_only")["reason"] == "after_hours_message_only"
    assert ex("book_slot", {"slot_id": "2026-10-12T12:00-16:00"})["reason"] == "unknown_slot"   # never offered
    slots = ex("get_availability", {"job_type": "AC repair", "zip": "77005", "date_from": "not-a-date"})["slots"]
    assert ex("book_slot", {"slot_id": slots[0]["slot_id"], "address": "1 Main St 90210"})["reason"] == "out_of_area"
    ok = ex("book_slot", {"slot_id": slots[0]["slot_id"], "name": "A", "address": "1 Main St 77005",
                          "job_type": "Bogus", "urgency": "normal", "phone": "+15550001111", "notes": None})
    assert ok["ok"] and c.booking["job_type"] == "AC repair" and c.booking["phone"] == harness.CALLER
    assert c.booking["alt_phone"] == "+15550001111"
    assert ex("book_slot", {"slot_id": slots[1]["slot_id"]})["reason"] == "already_booked"
    assert ex("nope", {})["reason"] == "unknown_tool"
    assert ex("handoff", {"reason": "x"})["action"] == "message"   # SMS never dials


def test_slot_taken_between_offer_and_booking(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw, booking={**demo_raw["config"]["booking"], "max_per_window": 1})
    c = eng.convo(t, "sms", harness.CALLER, "c1")
    slots = eng._execute(t, eng.store.for_tenant(t.id), c, "sms", MON_9, "open", [], "get_availability", {"job_type": "AC repair", "zip": "77005"})["slots"]
    eng.calendar.book(t.id, t.config, MON_9, slots[0]["slot_id"], {"phone": "+15550009999"})
    r = eng._execute(t, eng.store.for_tenant(t.id), c, "sms", MON_9, "open", [], "book_slot", {"slot_id": slots[0]["slot_id"], "address": ""})
    assert r == {"ok": False, "reason": "slot_unavailable"}


def test_urgent_voice_dials_emergency_line(tmp_path, demo_raw):
    eng, t, client = _engine(tmp_path, demo_raw)
    r = eng.handle(t, "voice", harness.CALLER, "the basement is flooding", "c1", MON_9)
    assert {"type": "dial", "number": "+17135550111", "reason": "urgent"} in r.actions
    assert r.end and r.outcome == "emergency" and client.calls == 0


def test_silence_after_speaking_ends_quietly(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw)
    eng.handle(t, "voice", harness.CALLER, "hi there", "c1", MON_9)
    eng.handle(t, "voice", harness.CALLER, "", "c1", MON_9)
    r = eng.handle(t, "voice", harness.CALLER, "", "c1", MON_9)
    assert r.end and r.outcome == "message" and "silence:end_quiet" in r.guard


def test_global_budget_alerts_admin_once(tmp_path, demo_raw):
    eng, t, client = _engine(tmp_path, demo_raw)
    eng.state.put(f"spend:global:{eng.local_day(t, MON_9)}", 99)
    a = eng.handle(t, "sms", harness.CALLER, "hi", "c1", MON_9)
    b = eng.handle(t, "sms", "+17135550124", "hi", "c2", MON_9)
    kinds = [x.get("kind") for x in a.actions + b.actions]
    assert kinds.count("admin_budget") == 1 and client.calls == 0


def test_muted_number_gets_mute_alert(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw, guard={"daily_budget_usd": 3, "blocklist": [], "max_replies_10min": 1,
                                                   "max_replies_day": 1})
    from datetime import timedelta
    eng.handle(t, "sms", harness.CALLER, "hi", "c1", MON_9)
    eng.handle(t, "sms", harness.CALLER, "hi", "c1", MON_9 + timedelta(minutes=1))           # first episode
    r = eng.handle(t, "sms", harness.CALLER, "hi", "c1", MON_9 + timedelta(minutes=12))      # second episode -> mute
    assert r.reply == "" and any(a.get("kind") == "muted" for a in r.actions)


def test_spend_is_tracked(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw)
    r = eng.handle(t, "sms", harness.CALLER, "hello", "c1", MON_9)
    assert r.cost_usd > 0 and eng.tenant_spend(t, "2026-10-12") == pytest.approx(r.cost_usd)


def test_no_pii_in_events(tmp_path, demo_raw):
    eng, t, _ = _engine(tmp_path, demo_raw)
    eng.handle(t, "sms", harness.CALLER, "STOP", "c1", MON_9)
    eng.handle(t, "sms", harness.CALLER, "my AC at 2100 Rice Blvd", "c1", MON_9)
    blob = json.dumps(eng.store.select("events"))
    assert harness.CALLER not in blob and "Rice" not in blob


def test_system_prompt_cached_and_stable(demo_raw):
    cfg = load_record(demo_raw).config
    a, b = brain.system_prompt(cfg, "voice"), brain.system_prompt(cfg, "voice")
    assert a is b and "2 short sentences" in a and "Never say any price" in a
    assert "320 characters" in brain.system_prompt(cfg, "sms")
    assert "2026" not in a  # no timestamps in the cached prefix


def test_tools_are_strict(demo_raw):
    cfg = load_record(demo_raw).config
    for tool in brain.tools(cfg):
        s = tool["input_schema"]
        assert tool["strict"] is True and s["additionalProperties"] is False
        assert sorted(s["required"]) == sorted(s["properties"])
    names = [t["name"] for t in brain.tools(cfg)]
    assert names == ["get_availability", "book_slot", "take_message", "handoff", "end_conversation"]


def test_prompt_for_listed_pricing_and_spanish(demo_raw):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["pricing"] = {"mode": "listed", "items": [{"name": "Service call", "price_usd": 89, "note": "waived with repair"}]}
    raw["config"]["voice"]["languages"] = ["en", "es"]
    raw["config"]["faq"] = []
    p = brain.system_prompt(load_record(raw).config, "sms")
    assert "- Service call: $89 (waived with repair)" in p and "English or Spanish" in p and "(none)" in p


def test_llm_modes_and_cost(tmp_path):
    s = harness.sim_settings(tmp_path)
    assert cost_usd(s.model, {"input_tokens": 1_000_000, "output_tokens": 0}) == pytest.approx(4.0)
    with pytest.raises(LLMError):
        LLMClient(s, mode="weird").create("s", [], [])
    rec = LLMClient(s, namespace="t-record", mode="record",
                    live_call=lambda req: {"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn",
                                           "usage": {"input_tokens": 10, "output_tokens": 2}})
    rec.settings = harness.sim_settings(tmp_path, REPLAY_DIR=str(tmp_path / "rp"))
    rec.create("sys", [{"role": "user", "content": "x"}], [])
    rp = LLMClient(rec.settings, namespace="t-record", mode="replay")
    assert rp.create("sys", [{"role": "user", "content": "x"}], [])["content"][0]["text"] == "hi"


def test_key_lookup_never_needs_real_key(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    f = tmp_path / "s.env"
    f.write_text("OTHER=1\nANTHROPIC_API_KEY='test-not-real'\n")
    assert llm_mod._read_key(f) == "test-not-real"
    with pytest.raises(LLMError):
        llm_mod._read_key(tmp_path / "missing.env")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    assert llm_mod._read_key(f) == "from-env"


def test_sim_cli_run(capsys):
    from sim.__main__ import main
    assert main(["run", "01", "05"]) == 0
    assert main(["record", "--all", "--source", "live"]) == 2   # refuses to spend without --yes
    assert "2/2 scenarios passed" in capsys.readouterr().out
