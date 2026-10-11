"""Simulator CLI.

    python -m sim serve [--port 8000]            run the runtime locally (no external accounts)
    python -m sim selftest                       offline smoke checks, exit 1 on failure
    python -m sim validate FILE...               validate tenant JSON files, readable errors
    python -m sim call --tenant demo-hvac --say "my ac is broken"
    python -m sim sms  --tenant demo-hvac --text "can someone come tomorrow?"
    python -m sim run [--all | NAME...] [--mode replay|mock]   run scenarios (default: replay)
    python -m sim record --all [--source mock|live]            refresh sim/replays/ (live spends API credit)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from app.tenants import TenantConfigError, load_file

from . import harness
from .fake_twilio import parse_twiml

RUNTIME_DIR = Path(__file__).resolve().parent.parent


def cmd_serve(args) -> int:
    import uvicorn

    data_dir = Path(args.data or RUNTIME_DIR / ".simdata")
    os.environ.update({"RUNTIME_MODE": "sim", "STORE_BACKEND": "json", "DATA_DIR": str(data_dir)})
    os.environ.setdefault("BRAIN_MODE", "mock")
    from app.main import create_app
    from app.settings import load
    from app.store import JsonStore

    store = JsonStore(data_dir)
    seeded = harness.seed_tenants(store)
    print(f"sim: {len(seeded)} tenant(s) seeded into {data_dir}: {', '.join(t.slug for t in seeded)}")
    uvicorn.run(create_app(load(), store), host=args.host, port=args.port, log_level="info")
    return 0


def cmd_validate(args) -> int:
    bad = 0
    for path in args.files:
        try:
            rec = load_file(path)
            print(f"OK   {path} ({rec.slug})")
        except TenantConfigError as exc:
            bad += 1
            print(f"FAIL {path}\n{exc}")
    return 1 if bad else 0


def _print_turn(who: str, text: str) -> None:
    print(f"{who:>9}: {text}")


def cmd_call(args) -> int:
    sim = harness.build()
    tenant = sim.tenant(args.tenant)
    call_sid, resp = sim.twilio.start_call(tenant.twilio_number, args.caller)
    _print_turn("assistant", parse_twiml(resp.text).text)
    for line in args.say:
        _print_turn("caller", line)
        resp = sim.twilio.say(tenant.twilio_number, args.caller, call_sid, line)
        if resp.status_code == 404:
            print("(voice turn handler arrives in task B3; brain conversation via `python -m sim sms`)")
            return 0
        _print_turn("assistant", parse_twiml(resp.text).text)
    return 0


def cmd_sms(args) -> int:
    sim = harness.build()
    tenant = sim.tenant(args.tenant)
    for line in args.text:
        _print_turn("customer", line)
        resp = sim.twilio.sms(tenant.twilio_number, args.caller, line)
        reply = parse_twiml(resp.text).text if resp.status_code == 200 else f"[HTTP {resp.status_code}]"
        _print_turn("assistant", reply or "(no reply)")
    return 0


def _pick(args):
    from . import scenarios
    paths = scenarios.all_scenarios()
    if not args.all and args.names:
        paths = [p for p in paths if any(n in p.stem for n in args.names)]
    return paths


def cmd_run(args) -> int:
    from . import scenarios
    failed = 0
    paths = _pick(args)
    for p in paths:
        res = scenarios.run(p, mode=args.mode)
        failed += not res.ok
        print(f"{'✅' if res.ok else '❌'} {res.name:34} outcome={res.outcome} claude_calls={res.claude_calls}")
        for f in res.failures:
            print(f"     - {f}")
        if args.verbose:
            for who, text in res.transcript:
                _print_turn(who, text)
    print(f"\n{len(paths) - failed}/{len(paths)} scenarios passed ({args.mode})")
    return 1 if failed else 0


def cmd_record(args) -> int:
    from app.settings import load
    from . import scenarios
    from .replay import ReplayStore
    paths = _pick(args)
    if args.source == "live" and not args.yes:
        print("live recording spends Anthropic API credit; re-run with --yes to confirm")
        return 2
    replay_dir = load({"RUNTIME_MODE": "sim"}).replay_dir
    for p in paths:
        ReplayStore(replay_dir, scenarios.load(p)["name"]).clear()
        res = scenarios.run(p, mode="record", source=args.source)
        print(f"{'✅' if res.ok else '❌'} recorded {res.name} ({res.claude_calls} calls, source={args.source})")
        for f in res.failures:
            print(f"     - {f}")
    return 0


def cmd_selftest(_args) -> int:
    results: list[tuple[bool, str]] = []

    def check(ok: bool, label: str) -> None:
        results.append((bool(ok), label))
        print(("✅ " if ok else "❌ ") + label)

    sim = harness.build(Path(tempfile.mkdtemp(prefix="ailab-selftest-")))
    h = sim.client.get("/health")
    check(h.status_code == 200 and h.json().get("ok") and h.json().get("mode") == "sim", "GET /health ok in sim mode")
    check("sim-auth" not in h.text, "/health exposes no secret values")
    tenant = sim.tenant("demo-hvac")
    check(tenant.config.business.name == "Cool Breeze HVAC", "demo-hvac tenant seeded and valid")

    _, resp = sim.twilio.start_call(tenant.twilio_number, harness.CALLER)
    tw = parse_twiml(resp.text)
    check(resp.status_code == 200 and tw.gather and "virtual assistant" in tw.text, "signed /voice/incoming answers with greeting")
    check("transcribed" in tw.text, "greeting discloses transcription")
    bad = sim.twilio.post("/voice/incoming", sim.twilio.call_params(tenant.twilio_number, harness.CALLER, "CA1"), signed=False)
    check(bad.status_code == 403, "unsigned webhook rejected (403)")
    forged = sim.twilio.post("/sms/incoming", {"To": tenant.twilio_number, "Body": "hi"}, signature="Zm9yZ2Vk")
    check(forged.status_code == 403, "forged signature rejected (403)")
    _, unknown = sim.twilio.start_call("+19995550000", harness.CALLER)
    check("not in service" in parse_twiml(unknown.text).text, "unknown number -> not in service")

    raw = json.loads((harness.TENANTS_DIR / "demo-hvac.json").read_text())
    raw["config"]["hours"]["mon"] = ["18:00", "07:00"]
    raw["config"]["business"]["timezone"] = "Mars/Olympus"
    try:
        from app.tenants import load_record
        load_record(raw)
        check(False, "invalid tenant config rejected")
    except TenantConfigError as exc:
        check("hours.mon" in str(exc) and "timezone" in str(exc), "invalid tenant config rejected with readable errors")

    now = datetime.now(timezone.utc)
    slots = sim.calendar.availability(tenant.id, tenant.config, now)
    check(len(slots) > 0, f"fake calendar offers slots ({len(slots)})")
    booked = sim.calendar.book(tenant.id, tenant.config, now, slots[0]["slot_id"], {"phone": harness.CALLER, "name": "Test"})
    again = sim.calendar.book(tenant.id, tenant.config, now, slots[0]["slot_id"], {"phone": harness.CALLER, "name": "Test"})
    check(booked["ok"] and again == {"ok": False, "reason": "duplicate"}, "fake calendar books once, blocks duplicate")

    failed = sum(1 for ok, _ in results if not ok)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m sim", description="Receptionist runtime simulator")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--data", help="data directory for the JSON store (default runtime/.simdata)")
    s.set_defaults(fn=cmd_serve)
    sub.add_parser("selftest").set_defaults(fn=cmd_selftest)
    for name, fn in (("run", cmd_run), ("record", cmd_record)):
        r = sub.add_parser(name)
        r.add_argument("names", nargs="*")
        r.add_argument("--all", action="store_true")
        if name == "run":
            r.add_argument("--mode", choices=["replay", "mock"], default="replay")
            r.add_argument("-v", "--verbose", action="store_true")
        else:
            r.add_argument("--source", choices=["mock", "live"], default="mock")
            r.add_argument("--yes", action="store_true")
        r.set_defaults(fn=fn)
    v = sub.add_parser("validate")
    v.add_argument("files", nargs="+")
    v.set_defaults(fn=cmd_validate)
    for name, flag, fn in (("call", "--say", cmd_call), ("sms", "--text", cmd_sms)):
        c = sub.add_parser(name)
        c.add_argument("--tenant", default="demo-hvac")
        c.add_argument("--from", dest="caller", default=harness.CALLER)
        c.add_argument(flag, dest=flag.strip("-"), action="append", required=True, help="repeat for more turns")
        c.set_defaults(fn=fn)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
