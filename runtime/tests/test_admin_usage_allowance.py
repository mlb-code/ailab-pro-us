"""Admin Tenants tab, usage table (site/start/assets/admin-tenants.js, fix 2026-11-28): a tenant's minutes are measured
against the same allowance the runtime uses (UsageMeter.limit: the monthly report, the daily admin digest, the usage
alerts): a FirstRing plan client = the plan's minutes (trialing: the trial minutes), no SMS allowance; a quote client, or a
plan the price book does not know = rules.included_usage. It used to divide every tenant by the quote allowance (400).
Parity: AdminTenants.allowanceOf is evaluated by node on the same configs and the real price book."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app import plans
from app.tenants import load_record
from app.usage import UsageMeter, included_usage

REPO = Path(__file__).resolve().parents[2]
JS = REPO / "site" / "start" / "assets" / "admin-tenants.js"
PB = REPO / "config" / "pricebook.json"


class _State:
    def get(self, key, default=None):
        return default


def _configs(demo_raw: dict) -> dict[str, dict]:
    def with_plan(**plan):
        raw = json.loads(json.dumps(demo_raw))
        raw["config"]["plan"] = {"code": "FR_STARTER", "status": "active", "period_start": "2026-11-15",
                                 "period_end": "2026-12-15T00:00:00+00:00", **plan}
        return raw
    return {
        "quote client": json.loads(json.dumps(demo_raw)),
        "FR_STARTER active": with_plan(),
        "FR_PRO active": with_plan(code="FR_PRO"),
        "FR_BUSINESS past_due": with_plan(code="FR_BUSINESS", status="past_due"),
        "FR_PRO trialing": with_plan(code="FR_PRO", status="trialing"),
        "unknown plan": with_plan(code="FR_GONE"),
    }


def _node_allowances(configs: dict[str, dict]) -> dict[str, dict]:
    script = """
const fs = require('fs'), vm = require('vm');
const [js, pb, cfgs] = process.argv.slice(1);
const win = { TenantSchema: {} };
vm.runInNewContext(fs.readFileSync(js, 'utf8'), { window: win });
const PB = JSON.parse(fs.readFileSync(pb, 'utf8')), C = JSON.parse(cfgs), out = {};
for (const k of Object.keys(C)) out[k] = win.AdminTenants.allowanceOf(C[k], PB);
process.stdout.write(JSON.stringify(out));
"""
    cfgs = json.dumps({k: raw["config"] for k, raw in configs.items()})
    r = subprocess.run(["node", "-e", script, str(JS), str(PB), cfgs], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_admin_usage_table_uses_the_allowance_the_runtime_uses(demo_raw):
    plans.set_catalog(None)   # the real price book, as the admin page loads it
    configs = _configs(demo_raw)
    js = _node_allowances(configs)
    meter = UsageMeter(_State(), included_usage())
    for name, raw in configs.items():
        tenant = load_record(raw)
        want = {"voice": meter.limit(tenant, "voice"), "sms": meter.limit(tenant, "sms")}
        got = js[name]
        assert (got["voice"], got["sms"]) == (want["voice"], want["sms"]), name
    pb = json.loads(PB.read_text())
    pro = next(p for p in pb["plans"] if p["code"] == "FR_PRO")
    assert js["FR_PRO active"] == {"voice": pro["included_usage"]["voice_minutes"], "sms": None}
    assert js["FR_PRO trialing"]["voice"] == (pro.get("trial_minutes") or pb["rules"]["subscription"]["trial_minutes"])
    assert js["quote client"] == {"voice": pb["rules"]["included_usage"]["voice_minutes"], "sms": pb["rules"]["included_usage"]["sms_segments"]}
    assert js["FR_PRO active"]["voice"] != pb["rules"]["included_usage"]["voice_minutes"], "no longer the quote allowance"
