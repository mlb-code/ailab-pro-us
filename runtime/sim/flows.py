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
  if_open: true on a say/silence/dial step skips it when the call already ended (live model may close first)
Step `expect`: reply_contains, reply_matches (regex), reply_not_matches, reply_starts_with, reply_empty, end, dial, rejected.
Final `expect`: outcome, bookings, sms_sent, sms_sent_contains, sms_sent_max, alerts, no_alerts,
  events {type: n}, claude_calls_max, latency_p95_ms_max, opted_out, consent {type: decision},
  transcript_withheld, burst {answered_max, capped,
  rejected_min}, usage_voice_min, first_sentence {server_p95_ms_max, client_p95_ms_max, total_p95_ms_min}.
Scenario `slow_model: {first_ms, rest_ms}`: the mock model streams like a live one (first text after
first_ms, then rest_ms before the rest of the reply) in every mode; nothing is recorded or replayed.
In stream mode `latency_p95_ms_max` measures the time to the first text frame (first spoken sentence).
"""
from __future__ import annotations

import json
import re
import tempfile
import time
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


class SlowStreamModel:
    """MockBrain behind a live-like stream: `first_ms` before the first block, then the first sentence of a
    text reply at once and `rest_ms` before the rest. Tool calls are announced as soon as they start."""

    def __init__(self, brain: MockBrain, first_ms: float = 0, rest_ms: float = 600):
        self.brain, self.first_s, self.rest_s = brain, first_ms / 1000, rest_ms / 1000

    def __call__(self, request: dict[str, Any], on_text=None, on_tool=None) -> dict[str, Any]:
        resp = self.brain.respond(request)
        time.sleep(self.first_s)
        for block in resp.get("content") or []:
            if block.get("type") == "tool_use":
                if on_tool:
                    on_tool(block["name"])
            elif block.get("type") == "text" and on_text:
                text = block.get("text", "")
                m = re.search(r"(?<=[.!?])\s+", text)
                head, tail = (text[:m.end()], text[m.end():]) if m else (text, "")
                on_text(head)
                if tail:
                    time.sleep(self.rest_s)
                    on_text(tail)
                on_text("\n")
        return resp


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

    slow = sc.get("slow_model")

    def boot(seed: bool):
        settings = harness.sim_settings(data_dir, BRAIN_MODE="mock", VOICE_MODE=vm)
        live_call = MockBrain(script).respond if (mode == "record" and (source == "mock" or script)) else None
        llm_mode = mode
        if slow:  # a deterministic model that streams with live-like delays (latency scenarios)
            live_call, llm_mode = SlowStreamModel(MockBrain(script), **slow), "live"
        llm = LLMClient(settings, namespace=sc["name"], script=script, mode=llm_mode, live_call=live_call)
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
        if call is not None and call.ended and any(k in step for k in ("say", "silence", "dial")):
            if step.get("if_open"):  # optional caller line; the assistant may already have ended the call
                continue
            out.failures.append(f"step {i}: call already ended before this step")
            break
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
    for pat in exp.get("reply_matches", []):
        if not re.search(pat, reply or "", re.I):
            f.append(f"step {i}: reply does not match /{pat}/: {reply!r}")
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
    fs = exp.get("first_sentence") or {}
    if fs:
        lat = [e["payload"] for e in events if e["type"] == "voice.latency"]
        got = lat[-1] if lat else {}
        out.notes.append(f"first sentence: server p95 {got.get('first_sentence_server_ms_p95')} ms, "
                         f"turn total p95 {got.get('total_ms_p95')} ms, client p95 {percentile(latencies, 95):.1f} ms")
        if "server_p95_ms_max" in fs and not (got.get("first_sentence_server_ms_p95", 1e9) <= fs["server_p95_ms_max"]):
            f.append(f"first sentence server p95 {got.get('first_sentence_server_ms_p95')} > {fs['server_p95_ms_max']} ms")
        if "client_p95_ms_max" in fs and not (latencies and percentile(latencies, 95) <= fs["client_p95_ms_max"]):
            f.append(f"first sentence client p95 {percentile(latencies, 95):.1f} > {fs['client_p95_ms_max']} ms")
        if "total_p95_ms_min" in fs and not (got.get("total_ms_p95", 0) >= fs["total_p95_ms_min"]):
            f.append(f"turn total p95 {got.get('total_ms_p95')} < {fs['total_p95_ms_min']} ms (reply not streamed?)")
    if "opted_out" in exp and sim.store.is_opted_out(tenant.id, contact) != exp["opted_out"]:
        f.append(f"opted_out != {exp['opted_out']}")
    # consent log (SA §8 item 7): {consent_type: last decision} for this caller
    for ctype, decision in (exp.get("consent") or {}).items():
        rows = sim.store.select("sms_consent", tenant_id=tenant.id, contact_e164=contact, consent_type=ctype)
        got = rows[-1]["decision"] if rows else None
        if got != decision:
            f.append(f"consent {ctype}: {got!r} != {decision!r}")
    if "transcript_withheld" in exp:
        rows = sim.store.select("calls", tenant_id=tenant.id)
        withheld = bool(rows) and all(r.get("transcript_withheld") is True and
                                      not any(t.get("who") == "customer" for t in (r.get("transcript") or []))
                                      for r in rows)
        if withheld != exp["transcript_withheld"]:
            f.append(f"transcript_withheld {withheld} != {exp['transcript_withheld']}")
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
