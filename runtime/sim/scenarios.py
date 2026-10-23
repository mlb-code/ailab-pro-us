"""Scenario runner: YAML conversations with expected outcomes (SPEC 6.9).

Each scenario runs the real conversation engine (guard + brain + tool executor + fake
calendar + JSON store) against Claude in mock, replay or record mode.
"""
from __future__ import annotations

import copy
import json
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from app.conversation import Engine
from app.llm import LLMClient
from app.mock_brain import MockBrain
from app.store import JsonStore
from app.tenants import load_record

from . import harness
from .fake_calendar import FakeCalendar

SCENARIOS_DIR = harness.SIM_DIR / "scenarios"


def deep_merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in patch.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data.setdefault("name", path.stem)
    return data


def all_scenarios() -> list[Path]:
    return sorted(SCENARIOS_DIR.glob("*.yaml"))


@dataclass
class Outcome:
    name: str
    failures: list[str] = field(default_factory=list)
    transcript: list[tuple[str, str]] = field(default_factory=list)
    claude_calls: int = 0
    outcome: str | None = None
    notes: list[str] = field(default_factory=list)
    kind: str = "engine"
    channel: str = "sms"

    @property
    def ok(self) -> bool:
        return not self.failures


def run(path: Path, mode: str = "replay", source: str = "mock", data_dir: Path | None = None,
        voice_modes: list[str] | None = None) -> Outcome:
    sc = load(path)
    if sc.get("kind") == "flow":
        return _run_flow(sc, mode, source, data_dir, voice_modes)
    out = Outcome(sc["name"], channel=sc.get("channel", "sms"))
    data_dir = Path(data_dir or tempfile.mkdtemp(prefix="ailab-scn-"))
    settings = harness.sim_settings(data_dir, BRAIN_MODE="mock")
    store = JsonStore(data_dir)
    raw = json.loads((harness.TENANTS_DIR / f"{sc.get('tenant', 'demo-hvac')}.json").read_text())
    tenant = store.upsert_tenant(load_record(deep_merge(raw, sc.get("patch") or {})))

    script = sc.get("script") or []
    # A `script:` is a deliberately misbehaving model (guard tests): always recorded from the mock.
    live_call = MockBrain(script).respond if (mode == "record" and (source == "mock" or script)) else None
    llm = LLMClient(settings, namespace=out.name, script=script, mode=mode, live_call=live_call)
    engine = Engine(store, llm, FakeCalendar(), settings)

    setup = sc.get("setup") or {}
    now = datetime.fromisoformat(sc.get("now", "2026-10-12T09:00:00-05:00"))
    contact = sc.get("from", harness.CALLER)
    day = engine.local_day(tenant, now)
    if "tenant_spend_usd" in setup:
        engine.state.put(f"spend:{tenant.id}:{day}", float(setup["tenant_spend_usd"]), tenant.id)
    if "global_spend_usd" in setup:
        engine.state.put(f"spend:global:{day}", float(setup["global_spend_usd"]))
    if setup.get("opted_out"):
        store.for_tenant(tenant.id).opt_out(contact)
    if setup.get("prior_booking_slot"):
        slots = engine.calendar.availability(tenant.id, tenant.config, now)
        engine.calendar.book(tenant.id, tenant.config, now, slots[0]["slot_id"], {"phone": contact, "name": "Earlier"})

    if setup.get("existing_booking"):  # appointment manager: a visit we booked earlier for this caller
        eb = setup["existing_booking"]
        slot = engine.calendar.availability(tenant.id, tenant.config, now, limit=10)[int(eb.get("slot", 0))]
        who = eb.get("phone", contact)
        res = engine.calendar.book(tenant.id, tenant.config, now, slot["slot_id"], {"phone": who, "name": eb["name"]})
        store.for_tenant(tenant.id).insert("bookings", {
            "customer_name": eb["name"], "contact_e164": who, "address": eb.get("address", ""), "job_type": eb.get("job_type"),
            "urgency": "normal", "start_at": res["start"], "end_at": res["end"], "provider_event_id": res["event_id"],
            "status": "confirmed"})

    channel = sc.get("channel", "sms")
    convo_id = sc.get("convo_id", f"{channel}-{out.name}")
    replies: list[str] = []
    all_actions: list[dict] = []
    for i, turn in enumerate(sc.get("turns", []), 1):
        now += timedelta(minutes=float(turn.get("advance_minutes", 1 if i > 1 else 0)))
        res = engine.handle(tenant, channel, contact, turn.get("say", ""), convo_id, now,
                            num_media=int(turn.get("num_media", 0)))
        out.transcript += [("customer", turn.get("say", "")), ("assistant", res.reply)]
        replies.append(res.reply)
        all_actions += res.actions
        _check_turn(out, i, turn.get("expect") or {}, res)

    c = engine.convos.get((tenant.id, channel, convo_id))
    out.claude_calls = llm.calls
    out.outcome = c.outcome if c else None
    _check_final(out, sc.get("expect") or {}, replies, all_actions, store, tenant, contact, engine)
    return out


def _run_flow(sc: dict, mode: str, source: str, data_dir: Path | None, voice_modes: list[str] | None) -> Outcome:
    from .flows import modes_for, run_flow
    total = Outcome(sc["name"], kind="flow", channel=sc.get("channel", "sms"))
    for vm in modes_for(sc):
        if voice_modes and vm != "-" and vm not in voice_modes:
            continue
        one = Outcome(sc["name"])
        sub = Path(data_dir) / vm if data_dir else None
        run_flow(sc, one, mode=mode, source=source, voice_mode=vm, data_dir=sub)
        tag = f"[{vm}] " if vm != "-" else ""
        total.failures += [tag + x for x in one.failures]
        total.notes += [tag + x for x in one.notes]
        total.transcript += one.transcript if not total.transcript else []
        total.claude_calls = max(total.claude_calls, one.claude_calls)
        total.outcome = one.outcome
    return total


def _has(text: str, needle: str) -> bool:
    return needle.lower() in (text or "").lower()


def _check_turn(out: Outcome, i: int, exp: dict, res) -> None:
    f = out.failures
    for needle in exp.get("reply_contains", []):
        if not _has(res.reply, needle):
            f.append(f"turn {i}: reply lacks {needle!r}: {res.reply!r}")
    for pat in exp.get("reply_not_matches", []):
        if re.search(pat, res.reply or "", re.I):
            f.append(f"turn {i}: reply matches forbidden /{pat}/: {res.reply!r}")
    for pat in exp.get("reply_matches", []):
        if not re.search(pat, res.reply or "", re.I):
            f.append(f"turn {i}: reply does not match /{pat}/: {res.reply!r}")
    if exp.get("reply_empty") and res.reply:
        f.append(f"turn {i}: expected no reply, got {res.reply!r}")
    if "claude_calls" in exp and res.claude_calls != exp["claude_calls"]:
        f.append(f"turn {i}: claude_calls {res.claude_calls} != {exp['claude_calls']}")
    for note in exp.get("guard", []):
        if not any(g.startswith(note) for g in res.guard):
            f.append(f"turn {i}: guard note {note!r} missing in {res.guard}")
    if "end" in exp and bool(res.end) != bool(exp["end"]):
        f.append(f"turn {i}: end {res.end} != {exp['end']}")
    for tool in exp.get("tools", []):
        if tool not in [t["name"] for t in res.tool_calls]:
            f.append(f"turn {i}: tool {tool!r} not called ({[t['name'] for t in res.tool_calls]})")
    if exp.get("tools_any") and not set(exp["tools_any"]) & {t["name"] for t in res.tool_calls}:
        f.append(f"turn {i}: none of {exp['tools_any']} called ({[t['name'] for t in res.tool_calls]})")


def _check_final(out: Outcome, exp: dict, replies: list[str], actions: list[dict], store, tenant, contact, engine) -> None:
    f = out.failures
    if "outcome" in exp and out.outcome != exp["outcome"]:
        f.append(f"outcome {out.outcome!r} != {exp['outcome']!r}")
    if "bookings" in exp:
        n = len(store.select("bookings", tenant_id=tenant.id))
        if n != exp["bookings"]:
            f.append(f"bookings {n} != {exp['bookings']}")
    if "claude_calls_total" in exp and out.claude_calls != exp["claude_calls_total"]:
        f.append(f"claude calls {out.claude_calls} != {exp['claude_calls_total']}")
    if "booking_statuses" in exp:
        got: dict[str, int] = {}
        for r in store.select("bookings", tenant_id=tenant.id):
            got[r.get("status")] = got.get(r.get("status"), 0) + 1
        if got != exp["booking_statuses"]:
            f.append(f"booking statuses {got} != {exp['booking_statuses']}")
    convo = next((c for c in engine.convos.values() if c.contact == contact), None)
    for k in exp.get("meta_absent", []):
        if convo is not None and k in convo.meta:
            f.append(f"conversation meta has {k!r}")
    kinds = {a.get("kind") or a["type"] for a in actions}
    for k in exp.get("actions", []):
        if k not in kinds:
            f.append(f"action {k!r} missing (got {sorted(kinds)})")
    for k in exp.get("no_actions", []):
        if k in kinds:
            f.append(f"unexpected action {k!r}")
    for pat in exp.get("reply_never_matches", []):
        for r in replies:
            if re.search(pat, r or "", re.I):
                f.append(f"a reply matches forbidden /{pat}/: {r!r}")
    if "opted_out" in exp and store.is_opted_out(tenant.id, contact) != exp["opted_out"]:
        f.append(f"opted_out != {exp['opted_out']}")
    for pat in exp.get("dial", []):
        if pat not in [a.get("number") for a in actions if a["type"] == "dial"]:
            f.append(f"no dial to {pat}")
