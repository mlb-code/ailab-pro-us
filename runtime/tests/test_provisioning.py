"""Automatic provisioning (2026-11-25): number purchase behind TWILIO_PROVISION_LIVE (dry run by default), the four
webhooks, idempotent retries, failures -> retry -> `failed` + English note to Meir, the go-live simulator job against the
client's real config, /jobs/tick and /admin/sim-run. Twilio is always httpx.MockTransport here: no network."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl

import httpx
import pytest

from app.golive import run_checks
from app.notify.routes import SIM_ADMIN_TOKEN
from app.provisioning import Provisioner, TwilioNumbers, simulated_number, webhooks
from app.store import JsonStore
from sim import harness

NOW = datetime(2026, 11, 25, 15, 0, tzinfo=timezone.utc)
BASE = "https://rt.example.test"


class Settings:
    is_sim = False
    public_base_url = BASE
    twilio_account_sid = "AC" + "0" * 32
    twilio_auth_token = "test-token"


class FakeTwilioRest:
    """AvailablePhoneNumbers + IncomingPhoneNumbers, recording every request."""

    def __init__(self, available=("+17135551234", "+17135555678"), owned=None, fail=0):
        self.available, self.owned, self.fail = list(available), dict(owned or {}), fail
        self.reqs: list[httpx.Request] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.reqs.append(req)
        if self.fail:
            self.fail -= 1
            return httpx.Response(500, json={"code": 20500})
        q = dict(parse_qsl(req.url.query.decode()))
        if req.url.path.endswith("/AvailablePhoneNumbers/US/Local.json"):
            nums = [n for n in self.available if not q.get("AreaCode") or n.startswith("+1" + q["AreaCode"])]
            return httpx.Response(200, json={"available_phone_numbers": [{"phone_number": n} for n in nums]})
        if req.url.path.endswith("/IncomingPhoneNumbers.json") and req.method == "GET":
            n = self.owned.get(q.get("FriendlyName"))
            return httpx.Response(200, json={"incoming_phone_numbers": [{"phone_number": n}] if n else []})
        if req.url.path.endswith("/IncomingPhoneNumbers.json") and req.method == "POST":
            form = dict(parse_qsl(req.content.decode()))
            self.owned[form["FriendlyName"]] = form["PhoneNumber"]
            return httpx.Response(201, json={"sid": "PN1", "phone_number": form["PhoneNumber"]})
        return httpx.Response(404, json={"code": 20404})

    def buys(self):
        return [dict(parse_qsl(r.content.decode())) for r in self.reqs if r.method == "POST"]


@pytest.fixture
def store(tmp_path, demo_raw):
    s = JsonStore(tmp_path)
    row = copy.deepcopy(demo_raw)
    row.update(id="t-new", slug="new-hvac", twilio_number=None)
    row["config"]["business"]["main_phone"] = "+17135550100"
    s.insert("tenants", row)
    return s


def job(store, kind="number", **kw):
    return store.insert("provisioning_jobs", {"tenant_id": "t-new", "client_id": "c1", "kind": kind, "status": "pending",
                                              "attempts": 0, "next_attempt_at": None, **kw})


def prov(store, env=None, rest=None, settings=None, **kw):
    alerts: list[tuple] = []
    numbers = TwilioNumbers("AC" + "0" * 32, "test-token", transport=httpx.MockTransport(rest)) if rest else None
    p = Provisioner(store, settings or Settings(), admin_alert=lambda *a: alerts.append(a), numbers=numbers,
                    env=env if env is not None else {}, **kw)
    return p, alerts


def tenant(store):
    return store.select("tenants", id="t-new")[0]


def test_dry_run_is_the_default_and_never_calls_twilio_in_production(store):
    rest = FakeTwilioRest()
    j = job(store)
    p, alerts = prov(store, env={}, rest=rest)
    assert p.run_due(NOW) == {"done": 0, "held": 1, "failed": 0, "retry": 0}
    row = store.select("provisioning_jobs", id=j["id"])[0]
    assert (row["status"], row["dry_run"], tenant(store)["twilio_number"]) == ("held", True, None)
    assert row["result"]["would_buy"].startswith("+1713555") and rest.reqs == []
    assert alerts and alerts[0][0] == "number_dry_run" and "TWILIO_PROVISION_LIVE" in alerts[0][3]


def test_simulator_dry_run_writes_a_fictional_number_once(store):
    class Sim(Settings):
        is_sim = True
    job(store)
    p, _ = prov(store, settings=Sim())
    assert p.run_due(NOW)["done"] == 1
    n = tenant(store)["twilio_number"]
    assert n.startswith("+171355501") and len(n) == 12 and n != "+17135550100"  # never the client's own business line
    job(store)  # a second job for the same tenant (e.g. admin retry) keeps the number
    p.run_due(NOW)
    assert tenant(store)["twilio_number"] == n


def test_fictional_numbers_are_unique():
    taken = {simulated_number("713", "same-seed", set())}
    assert simulated_number("713", "same-seed", taken) not in taken


def test_live_purchase_near_the_area_code_with_the_four_webhooks(store):
    rest = FakeTwilioRest()
    job(store)
    p, alerts = prov(store, env={"TWILIO_PROVISION_LIVE": "1"}, rest=rest)
    assert p.run_due(NOW)["done"] == 1
    assert tenant(store)["twilio_number"] == "+17135551234" and alerts == []
    [buy] = rest.buys()
    assert {k: buy[k] for k in webhooks(BASE)} == webhooks(BASE)
    assert buy["VoiceUrl"] == f"{BASE}/voice/incoming" and buy["SmsUrl"] == f"{BASE}/sms/incoming"
    assert buy["StatusCallback"] == f"{BASE}/voice/status" and buy["VoiceFallbackUrl"] == f"{BASE}/voice/fallback"
    assert buy["FriendlyName"] == "new-hvac"
    search = [r for r in rest.reqs if "AvailablePhoneNumbers" in r.url.path][0]
    assert dict(parse_qsl(search.url.query.decode()))["AreaCode"] == "713"


def test_live_retry_after_a_crash_reuses_the_number_bought_before(store):
    rest = FakeTwilioRest(owned={"new-hvac": "+17135559999"})
    job(store)
    p, _ = prov(store, env={"TWILIO_PROVISION_LIVE": "1"}, rest=rest)
    p.run_due(NOW)
    assert tenant(store)["twilio_number"] == "+17135559999" and rest.buys() == []


def test_live_falls_back_to_a_nearby_number(store):
    rest = FakeTwilioRest(available=("+12815550001",))
    job(store)
    p, _ = prov(store, env={"TWILIO_PROVISION_LIVE": "1"}, rest=rest)
    p.run_due(NOW)
    assert tenant(store)["twilio_number"] == "+12815550001"
    near = [dict(parse_qsl(r.url.query.decode())) for r in rest.reqs if "AvailablePhoneNumbers" in r.url.path]
    assert near[1].get("NearNumber") == "+17135550100"


def test_failures_retry_then_fail_loudly(store):
    class NoUrl(Settings):
        public_base_url = ""
    j = job(store)
    p, alerts = prov(store, env={"TWILIO_PROVISION_LIVE": "1"}, rest=FakeTwilioRest(), settings=NoUrl())
    assert p.run_due(NOW)["retry"] == 1
    row = store.select("provisioning_jobs", id=j["id"])[0]
    assert row["status"] == "pending" and "PUBLIC_BASE_URL" in row["last_error"]
    assert p.run_due(NOW)["retry"] == 0  # backoff: not due yet
    p.run_due(NOW + timedelta(minutes=6))
    p.run_due(NOW + timedelta(minutes=30))
    row = store.select("provisioning_jobs", id=j["id"])[0]
    assert (row["status"], row["attempts"]) == ("failed", 3)
    assert [a[0] for a in alerts] == ["provisioning_failed"] and "failed 3 times" in alerts[0][3]


def test_twilio_error_is_retried(store):
    rest = FakeTwilioRest(fail=1)
    job(store)
    p, _ = prov(store, env={"TWILIO_PROVISION_LIVE": "1"}, rest=rest)
    assert p.run_due(NOW)["retry"] == 1
    assert p.run_due(NOW + timedelta(minutes=6))["done"] == 1


def test_stale_running_job_is_picked_up_again(store):
    job(store, status="running", updated_at=(NOW - timedelta(hours=1)).isoformat())
    p, _ = prov(store)
    assert p.run_due(NOW)["held"] == 1


def test_golive_job_passes_on_a_good_config_and_fails_with_a_note(store, demo_raw):
    job(store, kind="golive_sim")
    store.update("tenants", "t-new", {"twilio_number": "+17135551234"})
    p, alerts = prov(store)
    assert p.run_due(NOW)["done"] == 1
    res = store.select("provisioning_jobs", kind="golive_sim")[0]["result"]
    assert res["passed"] is True and {c["name"] for c in res["checks"]} >= {"booking", "greeting", "life_safety", "stop_keyword"}
    bad = copy.deepcopy(tenant(store))
    bad["config"]["booking"]["provider"] = "calendly"  # chose Calendly but never connected it
    store.update("tenants", "t-new", {"config": bad["config"]})
    j2 = job(store, kind="golive_sim")
    p.run_due(NOW)
    row = store.select("provisioning_jobs", id=j2["id"])[0]
    assert row["status"] == "failed" and row["result"]["failed"] == ["calendar_connected"]
    assert [a[0] for a in alerts] == ["golive_check_failed"]


def test_golive_checks_messages_only_and_broken_config(demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["booking"]["enabled"] = False
    rep = run_checks(raw, now=NOW)
    assert rep["passed"] and "no_booking" in {c["name"] for c in rep["checks"]}
    raw["config"]["faq"] = [{"q": "x", "a": "y" * 700}]
    rep = run_checks(raw, now=NOW)
    assert rep["passed"] is False and rep["failed"] == ["config_valid"] and "faq[0].a" in rep["checks"][0]["detail"]
    assert "y" * 20 not in json.dumps(rep)  # field paths only, never the client's values


def test_jobs_tick_runs_provisioning_and_sim_run_needs_the_admin_token(tmp_path):
    s = harness.build(tmp_path)
    t = s.tenant("demo-hvac")
    s.store.insert("provisioning_jobs", {"tenant_id": t.id, "client_id": "c", "kind": "golive_sim", "status": "pending",
                                         "attempts": 0})
    out = s.tick().json()
    assert out["provisioning"] == {"done": 1, "held": 0, "failed": 0, "retry": 0}
    assert s.client.post("/admin/sim-run/demo-hvac").status_code == 401
    r = s.client.post("/admin/sim-run/demo-hvac", headers={"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"})
    assert r.status_code == 200 and r.json()["passed"] is True
    assert s.client.post("/admin/sim-run/nope", headers={"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}).status_code == 404
    assert s.store.select("bookings") == []  # the checks never touch the real store
