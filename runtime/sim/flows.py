"""Flow scenarios (`kind: flow`): whole calls and text threads through the HTTP/WebSocket runtime.

Unlike the engine scenarios (one engine, direct calls), a flow drives the real app the way Twilio
would: signed webhooks, the ConversationRelay socket or <Gather> turns, the status callback,
outbound SMS through the fake REST client, the jobs runner, and app restarts. Voice flows run in
both voice modes (stream + gather) unless the scenario sets `modes:`.

Steps (one key each, optional `advance_minutes` / `advance_seconds` before the step, `expect`):
  call: {from?}          start a call            say: "text"      caller speaks
  silence: true          caller says nothing     hangup: {duration_s?}
  dial: no-answer|completed                      sms: "text" (inbound text)
  jobs: true             POST /jobs/tick (cron)  restart: true (new app, same data)
  burst_calls: {count, within_s, say?}           many calls from one number
Final `expect`: outcome, bookings, sms_sent, sms_sent_contains, sms_sent_max, alerts, no_alerts,
  events {type: n}, claude_calls_max, latency_p95_ms_max, opted_out, burst {answered_max, capped,
  rejected_min}, usage_voice_min.
"""
from __future__ import annotations

import json
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from app.llm import LLMClient
from app.mock_brain import MockBrain
from app.runtime_ctx import who
from app.tenants import load_record
from app.voice import CALL_CAP_TEXT, percentile

from . import harness
from .fake_calendar import FakeCalendar
from .fake_call import CallTurn, FakeCall
from .fake_twilio import FakeTwilioClient, parse_twiml


def modes_for(sc: dict[str, Any]) -> list[str]:
    if sc.get("channel") != "voice":
        return ["-"]
    return list(sc.get("modes") or ["stream", "gather"])


def run_flow(sc: dict[str, Any], out, mode: str = "replay", source: str = "mock", voice_mode: str = "stream",
             data_dir: Path | None = None) -> None:
    from .scenarios import deep_merge  # local import: scenarios imports this module

    data_dir = Path(data_dir or tempfile.mkdtemp(prefix="ailab-flow-"))
    clock = harness.FakeClock(datetime.fromisoformat(sc.get("now", "2026-10-12T09:00:00-05:00")))
    script = sc.get("script") or []
    calendar, twilio_client = FakeCalendar(), FakeTwilioClient()
    llms: list[LLMClient] = []
    vm = voice_mode if voice_mode != "-" else "gather"

    def boot(seed: bool):
        settings = harness.sim_settings(data_dir, BRAIN_MODE="mock", VOICE_MODE=vm)
        live_call = MockBrain(script).respond if (mode == "record" and source == "mock") else None
        llm = LLMClient(settings, namespace=sc["name"], script=script, mode=mode, live_call=live_call)
        llms.append(llm)
        return harness.build(data_dir, clock=clock, llm=llm, calendar=calendar, twilio_client=twilio_client,
                             seed=seed, VOICE_MODE=vm)

    alert_log: list[dict] = []
    sim = boot(seed=True)
    sim.rt.alert_log = alert_log
    raw = json.loads((harness.TENANTS_DIR / f"{sc.get('tenant', 'demo-hvac')}.json").read_text())
    tenant = sim.store.upsert_tenant(load_record(deep_merge(raw, sc.get("patch") or {})))
    contact = sc.get("from", harness.CALLER)
    setup = sc.get("setup") or {}
    if setup.get("opted_out"):
        sim.store.for_tenant(tenant.id).opt_out(contact)
    if setup.get("landline"):
        twilio_client.landlines.add(contact)
    if "voice_minutes_used" in setup:
        rt = sim.rt
        rt.state.put(rt.engine.usage.key(tenant, "voice", clock()), float(setup["voice_minutes_used"]), tenant.id)

    call: FakeCall | None = None
    latencies: list[float] = []
    burst: dict[str, int] = {}
    for i, step in enumerate(sc.get("steps") or [], 1):
        clock.advance(minutes=float(step.get("advance_minutes", 0)), seconds=float(step.get("advance_seconds", 0)))
        exp = step.get("expect") or {}
        turn: CallTurn | None = None
        reply = None
        if "call" in step:
            call = FakeCall(sim.twilio, tenant.twilio_number, (step.get("call") or {}).get("from", contact),
                            clock=clock, settled=sim.settled(tenant.slug))
            turn = call.start()
        elif "say" in step:
            turn = call.say(str(step["say"]))
        elif "silence" in step:
            turn = call.silence()
        elif "dial" in step:
            turn = call.dial(str(step["dial"]))
        elif "hangup" in step:
            call.hangup((step.get("hangup") or {}).get("duration_s"))
        elif "sms" in step:
            resp = sim.twilio.sms(tenant.twilio_number, contact, str(step["sms"]))
            reply = parse_twiml(resp.text).text if resp.status_code == 200 else f"[HTTP {resp.status_code}]"
            out.transcript += [("customer", str(step["sms"])), ("assistant", reply)]
        elif "jobs" in step:
            assert sim.tick().status_code == 200
        elif "restart" in step:
            sim = boot(seed=False)
            sim.rt.alert_log = alert_log
        elif "burst_calls" in step:
            burst = _burst(sim, tenant, contact, clock, step["burst_calls"])
        if turn is not None:
            if "say" in step or "silence" in step:
                out.transcript.append(("caller", str(step.get("say", "(silence)"))))
            out.transcript.append(("assistant", turn.text))
            if turn.latency_ms:
                latencies.append(turn.latency_ms)
            reply = turn.text
        _check_step(out, i, exp, reply, turn)

    rt = sim.rt
    out.claude_calls = sum(x.calls for x in llms)
    if sc.get("channel") == "voice" and call is not None:
        rows = sim.store.select("calls", tenant_id=tenant.id, call_sid=call.call_sid)
        out.outcome = rows[0]["outcome"] if rows else None
    else:
        th = rt.state.get(f"smsthread:{tenant.id}:{who(contact)}")
        c = rt.engine.find_convo(tenant, "sms", f"sms-{who(contact)}-{th['n']}") if th else None
        out.outcome = c.outcome if c else None
    _check_final(out, sc.get("expect") or {}, sim, tenant, contact, latencies, burst, clock, alert_log)


def _burst(sim, tenant, contact, clock, spec: dict[str, Any]) -> dict[str, int]:
    count, within = int(spec.get("count", 50)), float(spec.get("within_s", 60))
    res = {"answered": 0, "capped": 0, "rejected": 0}
    for _ in range(count):
        clock.advance(seconds=within / count)
        call = FakeCall(sim.twilio, tenant.twilio_number, contact, clock=clock, settled=sim.settled(tenant.slug))
        first = call.start()
        if first.rejected:
            res["rejected"] += 1
            sim.twilio.status(tenant.twilio_number, contact, call.call_sid, "busy", 0)
            continue
        if first.end and CALL_CAP_TEXT in first.text:
            res["capped"] += 1
            call.hangup(5)
            continue
        res["answered"] += 1
        if spec.get("say"):
            call.say(str(spec["say"]))
        call.hangup(15)
    return res


def _has(text: str | None, needle: str) -> bool:
    return needle.lower() in (text or "").lower()


def _check_step(out, i: int, exp: dict[str, Any], reply: str | None, turn: CallTurn | None) -> None:
    f = out.failures
    for needle in exp.get("reply_contains", []):
        if not _has(reply, needle):
            f.append(f"step {i}: reply lacks {needle!r}: {reply!r}")
    for pat in exp.get("reply_not_matches", []):
        if re.search(pat, reply or "", re.I):
            f.append(f"step {i}: reply matches forbidden /{pat}/: {reply!r}")
    if "reply_starts_with" in exp and not (reply or "").startswith(exp["reply_starts_with"]):
        f.append(f"step {i}: reply does not start with {exp['reply_starts_with']!r}: {reply!r}")
    if exp.get("reply_empty") and reply:
        f.append(f"step {i}: expected no reply, got {reply!r}")
    if turn is not None:
        if "end" in exp and turn.end != bool(exp["end"]):
            f.append(f"step {i}: end {turn.end} != {exp['end']}")
        if "dial" in exp and turn.dial != exp["dial"]:
            f.append(f"step {i}: dial {turn.dial!r} != {exp['dial']!r}")
        if "rejected" in exp and turn.rejected != bool(exp["rejected"]):
            f.append(f"step {i}: rejected {turn.rejected} != {exp['rejected']}")


def _check_final(out, exp: dict[str, Any], sim, tenant, contact, latencies, burst, clock, alert_log) -> None:
    f = out.failures
    if "outcome" in exp and out.outcome != exp["outcome"]:
        f.append(f"outcome {out.outcome!r} != {exp['outcome']!r}")
    if "bookings" in exp:
        n = len(sim.store.select("bookings", tenant_id=tenant.id))
        if n != exp["bookings"]:
            f.append(f"bookings {n} != {exp['bookings']}")
    sent = [m for m in sim.twilio_client.outbox if m["to"] == contact]
    if "sms_sent" in exp and len(sent) != exp["sms_sent"]:
        f.append(f"outbound SMS {len(sent)} != {exp['sms_sent']}: {[m['body'][:50] for m in sent]}")
    if "sms_sent_max" in exp and len(sent) > exp["sms_sent_max"]:
        f.append(f"outbound SMS {len(sent)} > {exp['sms_sent_max']}")
    for needle in exp.get("sms_sent_contains", []):
        if not any(_has(m["body"], needle) for m in sent):
            f.append(f"no outbound SMS contains {needle!r}: {[m['body'][:60] for m in sent]}")
    events = sim.store.select("events")
    alerts = {a.get("kind") for a in alert_log}
    for k in exp.get("alerts", []):
        if k not in alerts:
            f.append(f"alert {k!r} missing (got {sorted(a for a in alerts if a)})")
    for k in exp.get("no_alerts", []):
        if k in alerts:
            f.append(f"unexpected alert {k!r}")
    for etype, n in (exp.get("events") or {}).items():
        got = sum(1 for e in events if e["type"] == etype)
        if got != n:
            f.append(f"events {etype}: {got} != {n}")
    if "claude_calls_max" in exp and out.claude_calls > exp["claude_calls_max"]:
        f.append(f"claude calls {out.claude_calls} > {exp['claude_calls_max']}")
    if "latency_p95_ms_max" in exp:
        p95 = percentile(latencies, 95)
        out.notes.append(f"turn latency p95 {p95:.1f} ms over {len(latencies)} turns")
        if not latencies or p95 > exp["latency_p95_ms_max"]:
            f.append(f"turn latency p95 {p95:.1f} ms > {exp['latency_p95_ms_max']} ms")
    if "opted_out" in exp and sim.store.is_opted_out(tenant.id, contact) != exp["opted_out"]:
        f.append(f"opted_out != {exp['opted_out']}")
    b = exp.get("burst") or {}
    if b:
        out.notes.append(f"burst {burst}")
        if burst.get("answered", 0) > b.get("answered_max", 10**6):
            f.append(f"burst answered {burst.get('answered')} > {b['answered_max']}")
        if "capped" in b and burst.get("capped") != b["capped"]:
            f.append(f"burst capped {burst.get('capped')} != {b['capped']}")
        if burst.get("rejected", 0) < b.get("rejected_min", 0):
            f.append(f"burst rejected {burst.get('rejected')} < {b['rejected_min']}")
    if "usage_voice_min" in exp:
        used = sim.rt.engine.usage.used(tenant, "voice", clock())
        if used < exp["usage_voice_min"]:
            f.append(f"voice minutes {used} < {exp['usage_voice_min']}")
