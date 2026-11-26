"""FirstRing phase 2 (owner decision 2026-11-25), runtime side:
  1. the receptionist's number is released after the service ended: 7-day warning e-mail, release 30 days after the end
     of service (dates from the database), resubscribe cancels it, the runtime re-checks the subscription right before,
     dry run unless TWILIO_RELEASE_LIVE=1 (English note to Meir with the number), retries then a loud failure;
  2. ONE scripted conversation on the real model before go-live (GOLIVE_LIVE_AI_CHECK=1; a fake model here): pass,
     fail (job failed + transcript to Meir), model error / timeout (retries, then held for manual approval);
  3. Spanish on Pro/Business with the customer's remembered on/off choice (voice.spanish_off).
Twilio is httpx.MockTransport and the model a fake: nothing here reaches the network or spends credit."""
from __future__ import annotations

import copy
import json
import re
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app import mock_brain
from app import plans as plans_mod
from app import settings as settings_mod
from app.golive import live_ai_check, live_ai_enabled, run_checks
from app.llm import LLMClient, LLMError
from app.notify import templates as T
from app.provisioning import Provisioner, TwilioNumbers, release_eligible, release_live
from app.store import JsonStore
from app.tenants import json_schema, load_record
from sim import harness

NOW = datetime(2026, 11, 25, 15, 0, tzinfo=timezone.utc)
SID = "AC" + "0" * 32
NUMBER = "+17135551234"
iso = lambda d: d.isoformat()  # noqa: E731


class Settings:
    is_sim = False
    public_base_url = "https://rt.example.test"
    twilio_account_sid = SID
    twilio_auth_token = "test-token"


# ====================================================================================== 1. number release
class FakeTwilio:
    """IncomingPhoneNumbers lookup by PhoneNumber + DELETE, recording every request."""

    def __init__(self, owned=(NUMBER,), fail=0):
        self.owned = {n: f"PN{i}" for i, n in enumerate(owned)}
        self.fail = fail
        self.reqs: list[httpx.Request] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.reqs.append(req)
        if self.fail:
            self.fail -= 1
            return httpx.Response(500, json={"code": 20500})
        if req.method == "GET" and req.url.path.endswith("/IncomingPhoneNumbers.json"):
            n = req.url.params.get("PhoneNumber")
            return httpx.Response(200, json={"incoming_phone_numbers": [{"sid": self.owned[n], "phone_number": n}] if n in self.owned else []})
        m = re.search(r"/IncomingPhoneNumbers/(PN\w+)\.json$", req.url.path)
        if req.method == "DELETE" and m:
            for n, sid in list(self.owned.items()):
                if sid == m.group(1):
                    del self.owned[n]
                    return httpx.Response(204)
            return httpx.Response(404, json={"code": 20404})
        return httpx.Response(404, json={"code": 20404})

    def deletes(self):
        return [r for r in self.reqs if r.method == "DELETE"]


def _sub(**kw):
    base = {"client_id": "c1", "plan_code": "FR_PRO", "status": "canceled", "created_at": iso(NOW - timedelta(days=90)),
            "canceled_at": iso(NOW - timedelta(days=40)), "ends_at": iso(NOW - timedelta(days=30)),
            "trial_ends_at": None, "current_period_end": iso(NOW - timedelta(days=30)), "cancel_at_period_end": False}
    return {**base, **kw}


@pytest.fixture
def rstore(tmp_path, demo_raw):
    s = JsonStore(tmp_path)
    row = copy.deepcopy(demo_raw)
    row.update(id="t1", slug="cool-breeze", client_id="c1", twilio_number=NUMBER, status="live")
    row["config"]["plan"] = {"code": "FR_PRO", "status": "canceled", "period_start": "2026-09-25", "service": "message_only",
                             "service_reason": "canceled"}
    s.insert("tenants", row)
    s.insert("subscriptions", _sub())
    return s


def release_row(store, **kw):
    ended = NOW - timedelta(days=30)
    base = {"tenant_id": "t1", "client_id": "c1", "number": NUMBER, "reason": "canceled", "status": "scheduled",
            "service_ended_at": iso(ended), "warn_at": iso(ended + timedelta(days=23)), "release_at": iso(ended + timedelta(days=30)),
            "warned_at": None, "force": False, "attempts": 0, "next_attempt_at": None, "dry_run": False, "result": {}}
    return store.insert("number_releases", {**base, **kw})


def releaser(store, env=None, rest=None):
    alerts, mails = [], []
    numbers = TwilioNumbers(SID, "test-token", transport=httpx.MockTransport(rest)) if rest else None
    p = Provisioner(store, Settings(), admin_alert=lambda *a: alerts.append(a), numbers=numbers,
                    env=env if env is not None else {}, owner_email=lambda *a: mails.append(a) or True)
    return p, alerts, mails


def rel(store):
    return store.select("number_releases")[0]


@pytest.mark.parametrize("sub, plan, ok", [
    (_sub(status="active", ends_at=None, canceled_at=None, current_period_end=iso(NOW + timedelta(days=10))),
     {"service": "full"}, False),
    (_sub(status="trialing", trial_ends_at=iso(NOW + timedelta(days=3)), ends_at=None), {"service": "full"}, False),
    (_sub(status="past_due", ends_at=None), {"service": "full"}, False),                                   # in grace
    (_sub(status="past_due", ends_at=None), {"service": "message_only", "service_reason": "past_due"}, False),  # never
    (_sub(status="paused", ends_at=None), {"service": "message_only", "service_reason": "paused"}, False),
    (_sub(ends_at=iso(NOW + timedelta(days=5))), {"service": "full"}, False),         # cancelled, paid time not over
    (_sub(ends_at=iso(NOW + timedelta(days=5))), {"service": "message_only", "service_reason": "canceled"}, False),
    (_sub(), {"service": "message_only", "service_reason": "canceled"}, True),
    (_sub(status="trialing", trial_ends_at=iso(NOW - timedelta(days=31)), ends_at=None),
     {"service": "message_only", "service_reason": "trial_ended"}, True),
    (_sub(status="active", cancel_at_period_end=True, ends_at=None, current_period_end=iso(NOW - timedelta(days=31))),
     {"service": "message_only", "service_reason": "canceled"}, True),
    (_sub(), {"service": "full"}, False),   # the database says full service (e.g. a fresh resubscribe): never
    (None, {"service": "message_only", "service_reason": "canceled"}, False),
])
def test_release_only_after_the_service_really_ended(sub, plan, ok):
    assert release_eligible(sub, plan, NOW)[0] is ok


def test_flag_is_off_by_default():
    assert release_live({}) is False and release_live({"TWILIO_RELEASE_LIVE": "1"}) is True
    assert live_ai_enabled({}) is False and live_ai_enabled({"GOLIVE_LIVE_AI_CHECK": "on"}) is True


def test_warning_once_seven_days_before_then_dry_run_release_with_a_note(rstore):
    rest = FakeTwilio()
    release_row(rstore, warn_at=iso(NOW - timedelta(hours=1)), release_at=iso(NOW + timedelta(days=7)))
    p, alerts, mails = releaser(rstore, rest=rest)
    assert p.run_releases(NOW)["warned"] == 1
    assert rel(rstore)["warned_at"] and rel(rstore)["status"] == "scheduled" and len(mails) == 1
    tenant_row, subject, text, _html, key, to = mails[0]
    assert tenant_row["id"] == "t1" and "(713) 555-1234" in subject and "December 2, 2026" in subject
    assert to == ["owner@example.com"]  # the JSON store has no accounts: the alert addresses only
    assert "turn off call forwarding" in text and "Restart your plan" in text and "transfer" in text
    assert p.run_releases(NOW + timedelta(days=1)) == {"warned": 0, "released": 0, "held": 0, "canceled": 0, "failed": 0, "retry": 0}
    assert len(mails) == 1  # once
    out = p.run_releases(NOW + timedelta(days=7, minutes=1))
    assert out["held"] == 1 and rest.reqs == []  # dry run: nothing reaches Twilio
    row = rel(rstore)
    assert (row["status"], row["dry_run"], row["result"]["would_release"]) == ("held", True, NUMBER)
    assert rstore.select("tenants", id="t1")[0]["twilio_number"] == NUMBER
    assert [a[0] for a in alerts] == ["number_release_dry_run"] and NUMBER in alerts[0][3] and "TWILIO_RELEASE_LIVE" in alerts[0][3]
    assert p.run_releases(NOW + timedelta(days=8))["held"] == 0  # held rows are not picked again


def test_a_warning_that_could_not_be_sent_tells_meir(rstore):
    release_row(rstore, warn_at=iso(NOW - timedelta(hours=1)), release_at=iso(NOW + timedelta(days=7)))
    alerts = []
    p = Provisioner(rstore, Settings(), admin_alert=lambda *a: alerts.append(a), env={}, owner_email=lambda *a: False)
    assert p.run_releases(NOW)["warned"] == 1
    assert rel(rstore)["result"]["warning_sent"] is False
    assert [a[0] for a in alerts] == ["number_release_warn_failed"] and NUMBER in alerts[0][3]


def test_live_release_deletes_the_number_and_clears_the_tenant(rstore):
    rest = FakeTwilio()
    release_row(rstore, warned_at=iso(NOW - timedelta(days=7)))
    p, alerts, _ = releaser(rstore, env={"TWILIO_RELEASE_LIVE": "1"}, rest=rest)
    assert p.run_releases(NOW)["released"] == 1
    assert len(rest.deletes()) == 1 and NUMBER not in rest.owned
    assert rstore.select("tenants", id="t1")[0]["twilio_number"] is None
    row = rel(rstore)
    assert row["status"] == "released" and row["released_at"] and row["dry_run"] is False
    assert [a[0] for a in alerts] == ["number_released"]


def test_never_released_before_the_customer_was_warned(rstore):
    rest = FakeTwilio()
    release_row(rstore)  # due now, but no warning went out (e.g. the runtime was down that day)
    p, _, mails = releaser(rstore, env={"TWILIO_RELEASE_LIVE": "1"}, rest=rest)
    assert p.run_releases(NOW)["warned"] == 1 and len(mails) == 1 and rest.deletes() == []
    assert datetime.fromisoformat(rel(rstore)["release_at"]) == NOW + timedelta(days=7)
    assert "December 2, 2026" in mails[0][1]  # the e-mail names the new date
    assert p.run_releases(NOW + timedelta(days=6))["released"] == 0
    assert p.run_releases(NOW + timedelta(days=7))["released"] == 1


def test_release_now_from_the_admin_skips_the_wait(rstore):
    rest = FakeTwilio()
    release_row(rstore, force=True, release_at=iso(NOW - timedelta(minutes=1)), warn_at=iso(NOW + timedelta(days=3)))
    p, _, mails = releaser(rstore, env={"TWILIO_RELEASE_LIVE": "1"}, rest=rest)
    assert p.run_releases(NOW)["released"] == 1 and mails == []


@pytest.mark.parametrize("what", ["resubscribed", "number_changed", "db_says_full"])
def test_resubscribe_or_any_doubt_cancels_and_never_calls_twilio(rstore, what):
    rest = FakeTwilio()
    release_row(rstore, warned_at=iso(NOW - timedelta(days=7)))
    if what == "resubscribed":  # a new subscription row for the same client (resubscribe keeps the same line)
        rstore.insert("subscriptions", _sub(status="active", created_at=iso(NOW - timedelta(hours=1)), ends_at=None,
                                            canceled_at=None, current_period_end=iso(NOW + timedelta(days=30))))
    elif what == "number_changed":
        rstore.update("tenants", "t1", {"twilio_number": "+17135550000"})
    else:
        t = rstore.select("tenants", id="t1")[0]
        rstore.update("tenants", "t1", {"config": {**t["config"], "plan": {**t["config"]["plan"], "service": "full", "service_reason": ""}}})
    p, alerts, _ = releaser(rstore, env={"TWILIO_RELEASE_LIVE": "1"}, rest=rest)
    assert p.run_releases(NOW)["canceled"] == 1
    assert rest.reqs == [] and rel(rstore)["status"] == "canceled" and rel(rstore)["cancel_reason"]
    assert alerts == []


def test_twilio_errors_retry_then_fail_loudly(rstore):
    rest = FakeTwilio(fail=10)
    release_row(rstore, warned_at=iso(NOW - timedelta(days=7)))
    p, alerts, _ = releaser(rstore, env={"TWILIO_RELEASE_LIVE": "1"}, rest=rest)
    assert p.run_releases(NOW)["retry"] == 1
    assert p.run_releases(NOW)["retry"] == 0  # backoff
    p.run_releases(NOW + timedelta(minutes=6))
    assert p.run_releases(NOW + timedelta(minutes=30))["failed"] == 1
    assert rel(rstore)["status"] == "failed" and rstore.select("tenants", id="t1")[0]["twilio_number"] == NUMBER
    assert [a[0] for a in alerts] == ["number_release_failed"] and "3 times" in alerts[0][3]


def test_already_gone_at_twilio_counts_as_released(rstore):
    rest = FakeTwilio(owned=())
    release_row(rstore, warned_at=iso(NOW - timedelta(days=7)))
    p, _, _ = releaser(rstore, env={"TWILIO_RELEASE_LIVE": "1"}, rest=rest)
    assert p.run_releases(NOW)["released"] == 1 and rel(rstore)["result"]["was_on_account"] is False


def test_jobs_tick_runs_the_releases(tmp_path):
    s = harness.build(tmp_path)
    t = s.tenant("demo-hvac")
    raw = s.store.select("tenants", id=t.id)[0]
    raw["config"]["plan"] = {"code": "FR_PRO", "status": "canceled", "service": "message_only", "service_reason": "canceled"}
    s.store.update("tenants", t.id, {"config": raw["config"], "client_id": "c9"})
    s.store.insert("subscriptions", _sub(client_id="c9"))
    s.store.insert("number_releases", {"tenant_id": t.id, "client_id": "c9", "number": t.twilio_number, "status": "scheduled",
                                       "warn_at": "2000-01-01T00:00:00+00:00", "release_at": "2999-01-01T00:00:00+00:00",
                                       "warned_at": None, "attempts": 0, "result": {}})
    s.store.account_email = lambda cid: "Account.Owner@CoolBreeze.test" if cid == "c9" else None  # = RPC runtime_account_email
    out = s.tick().json()
    assert out["number_releases"]["warned"] == 1
    row = s.store.select("number_releases")[0]
    assert row["warned_at"] and row["result"]["warning_sent"] is True   # through the real notifier (sim e-mail outbox)
    sent = [e["payload"] for e in s.store.select("events", type="email.outbox") if e["payload"].get("tag") == "number_release"]
    assert len(sent) == 1 and sent[0]["to"] == [*raw["config"]["notify"]["email"], "Account.Owner@CoolBreeze.test"]


# ====================================================================================== 1b. the warning also reaches the account
def _with_alerts(store, emails):
    t = store.select("tenants", id="t1")[0]
    store.update("tenants", "t1", {"config": {**t["config"], "notify": {**t["config"]["notify"], "email": emails}}})


def warner(store, account, send_ok=True):
    alerts, mails = [], []
    p = Provisioner(store, Settings(), admin_alert=lambda *a: alerts.append(a), env={},
                    owner_email=lambda *a: mails.append(a) or send_ok, account_email=account)
    return p, alerts, mails


@pytest.mark.parametrize("alert_emails, account, expected", [
    (["owner@example.com"], "dana@spanishair.test", ["owner@example.com", "dana@spanishair.test"]),
    (["owner@example.com", "Dana@SpanishAir.test"], "dana@spanishair.test", ["owner@example.com", "Dana@SpanishAir.test"]),  # dedupe
    (["owner@example.com", "OWNER@example.com"], None, ["owner@example.com"]),
    ([], "dana@spanishair.test", ["dana@spanishair.test"]),          # no alert address: the account still gets it
    (["owner@example.com"], "  ", ["owner@example.com"]),
])
def test_warning_goes_to_the_alert_addresses_and_the_account_email(rstore, alert_emails, account, expected):
    _with_alerts(rstore, alert_emails)
    release_row(rstore, warn_at=iso(NOW - timedelta(hours=1)), release_at=iso(NOW + timedelta(days=7)))
    asked = []
    p, alerts, mails = warner(rstore, lambda cid: asked.append(cid) or account)
    assert p.run_releases(NOW)["warned"] == 1
    assert asked == ["c1"] and len(mails) == 1 and mails[0][5] == expected
    assert rel(rstore)["result"]["warning_sent"] is True and alerts == []


def test_no_address_at_all_tells_meir(rstore):
    _with_alerts(rstore, [])
    release_row(rstore, warn_at=iso(NOW - timedelta(hours=1)), release_at=iso(NOW + timedelta(days=7)))
    p, alerts, mails = warner(rstore, lambda cid: None)
    assert p.run_releases(NOW)["warned"] == 1
    assert mails == [] and rel(rstore)["result"]["warning_sent"] is False
    assert [a[0] for a in alerts] == ["number_release_warn_failed"] and "no alert address and no account email" in alerts[0][3] and NUMBER in alerts[0][3]


def test_a_failed_send_to_both_tells_meir(rstore):
    release_row(rstore, warn_at=iso(NOW - timedelta(hours=1)), release_at=iso(NOW + timedelta(days=7)))
    p, alerts, mails = warner(rstore, lambda cid: "dana@spanishair.test", send_ok=False)
    assert p.run_releases(NOW)["warned"] == 1
    assert mails[0][5] == ["owner@example.com", "dana@spanishair.test"]
    assert [a[0] for a in alerts] == ["number_release_warn_failed"]


def test_account_lookup_error_still_warns_the_alert_addresses(rstore):
    release_row(rstore, warn_at=iso(NOW - timedelta(hours=1)), release_at=iso(NOW + timedelta(days=7)))

    def boom(cid):
        raise RuntimeError("supabase down")
    p, alerts, mails = warner(rstore, boom)
    assert p.run_releases(NOW)["warned"] == 1 and mails[0][5] == ["owner@example.com"] and alerts == []


def test_supabase_store_reads_the_account_email_through_the_service_role_rpc():
    from app.store import SupabaseStore
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content or b"{}")
        seen.append((req.url.path, body, req.headers.get("authorization")))
        return httpx.Response(200, json="owner@coolbreeze.test" if body.get("p_client") == "c1" else None)
    s = SupabaseStore("https://x.supabase.co", "service-test", transport=httpx.MockTransport(handler))
    assert s.account_email("c1") == "owner@coolbreeze.test" and s.account_email("c2") is None and s.account_email(None) is None
    assert [x[0] for x in seen] == ["/rest/v1/rpc/runtime_account_email"] * 2 and seen[0][1] == {"p_client": "c1"}
    assert seen[0][2] == "Bearer service-test"
    assert Provisioner(s, Settings(), env={}).account_email("c1") == "owner@coolbreeze.test"  # the default wiring


def test_admin_notes_keep_the_transcript_lines_and_escape_values():
    subject, text, html = T.admin_alert("golive_check_failed", "Bee <Plumbing>", "bee", "failed\n\nCall transcript:\nCaller: hi <b>")
    assert "Bee &lt;Plumbing&gt;" in html and "hi &lt;b&gt;" in html and "<br>" in html and "Caller: hi <b>" in text


# ====================================================================================== 2. live AI check before go-live
SIM = settings_mod.load({"RUNTIME_MODE": "sim", "BRAIN_MODE": "mock"})


def good_model(req):
    """A well-behaved receptionist: the deterministic mock brain, kept to two sentences per reply (like the voice cap)."""
    r = mock_brain.MockBrain().respond(req)
    for b in r["content"]:
        if b.get("type") == "text":
            b["text"] = " ".join(re.split(r"(?<=[.!?])\s+", b["text"])[-2:])
    r["usage"] = {"input_tokens": 1500, "output_tokens": 50}
    return r


def bad_model(req):
    """Says a price although prices are hidden, promises, and sends the caller to another company."""
    return {"content": [{"type": "text", "text": "Sure, that's $99 and I guarantee it. You could also try another company."}],
            "stop_reason": "end_turn", "usage": {"input_tokens": 900, "output_tokens": 30}}


class Counter:
    def __init__(self, fn):
        self.fn, self.n = fn, 0

    def __call__(self, req):
        self.n += 1
        return self.fn(req)


def model(fn):
    return LLMClient(SIM, namespace="p2", mode="live", live_call=fn)


def ai(fn, **env):
    return {"model": model(fn), "env": {"GOLIVE_AI_RETRIES": "2", "GOLIVE_AI_TIMEOUT_S": "20", **env}}


def test_live_ai_check_passes_on_a_good_receptionist(demo_raw):
    rep = run_checks(demo_raw, now=NOW, ai=ai(good_model))
    a = rep["ai_check"]
    assert rep["passed"] and a["status"] == "passed" and a["problems"] == [] and a["attempts"] == 1
    assert a["offered"] and a["transcript"][0]["who"] == "assistant" and "Cool Breeze HVAC" in a["transcript"][0]["text"]
    assert any(t["who"] == "customer" for t in a["transcript"])
    assert a["cost_usd"] > 0 and a["tokens"]["input_tokens"] >= 1500 and a["model_calls"] >= 5  # cost estimate logged
    assert {c["name"] for c in rep["checks"]} >= {"booking", "pricing", "live_ai"}
    assert len(rep["checks"]) == len(run_checks(demo_raw, now=NOW)["checks"]) + 1  # the simulated checks all still run


def test_live_ai_check_messages_only_takes_a_message(demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["booking"]["enabled"] = False
    a = run_checks(raw, now=NOW, ai=ai(good_model))["ai_check"]
    assert a["status"] == "passed" and a["message"] and not a["offered"]


def test_live_ai_check_real_estate(tmp_path):
    raw = json.loads((harness.TENANTS_DIR / "demo-realty.json").read_text())
    assert run_checks(raw, now=NOW, ai=ai(good_model))["ai_check"]["status"] == "passed"


def test_live_ai_check_fails_on_forbidden_content(demo_raw):
    rep = run_checks(demo_raw, now=NOW, ai=ai(bad_model))
    a = rep["ai_check"]
    assert rep["passed"] is False and rep["failed"] == ["live_ai"] and a["status"] == "failed"
    assert {"price", "promise", "other_business", "details", "booking"} <= set(a["problems"])
    # the plain-words list for Meir (key name is historical): English, one per problem code, never the raw code
    assert len(a["problems_he"]) == len(a["problems"]) and all(
        p and not re.search(r"[\u0590-\u05FF]", p) and p not in a["problems"] for p in a["problems_he"])


def test_live_ai_check_names_of_other_businesses(demo_raw):
    def names_rival(req):
        r = good_model(req)
        for b in r["content"]:
            if b.get("type") == "text":
                b["text"] = b["text"].replace("Our team", "Bee Plumbing")
        return r
    rec = load_record(demo_raw)
    a = live_ai_check(demo_raw, rec, NOW + timedelta(days=1, hours=1), model=model(names_rival), env={},
                      other_names=["Bee Plumbing", "Cool Breeze HVAC"])
    assert "other_business" in a["problems"]


def test_listed_prices_are_allowed(demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["pricing"] = {"mode": "listed", "items": [{"name": "Service call", "price_usd": 89}]}
    assert run_checks(raw, now=NOW, ai=ai(good_model))["ai_check"]["status"] == "passed"


def test_model_error_retries_then_manual_approval(demo_raw):
    def down(req):
        raise LLMError("anthropic api status 529")
    c = Counter(down)
    a = run_checks(demo_raw, now=NOW, ai=ai(c, GOLIVE_AI_RETRIES="2"))["ai_check"]
    assert a["status"] == "error" and a["attempts"] == 3 and c.n == 3 and "model error" in a["error"]


def test_timeout_never_blocks(demo_raw):
    def slow(req):
        time.sleep(1.5)
        return good_model(req)
    t0 = time.monotonic()
    a = run_checks(demo_raw, now=NOW, ai=ai(slow, GOLIVE_AI_RETRIES="1", GOLIVE_AI_TIMEOUT_S="0.3"))["ai_check"]
    assert a["status"] == "error" and a["attempts"] == 2 and "timeout" in a["error"]
    assert time.monotonic() - t0 < 10


@pytest.fixture
def gstore(tmp_path, demo_raw):
    s = JsonStore(tmp_path)
    row = copy.deepcopy(demo_raw)
    row.update(id="t-new", slug="new-hvac")
    s.insert("tenants", row)
    s.insert("provisioning_jobs", {"tenant_id": "t-new", "client_id": "c1", "kind": "golive_sim", "status": "pending",
                                   "attempts": 0, "next_attempt_at": None})
    return s


def gprov(store, fn, env):
    alerts = []
    p = Provisioner(store, SIM, admin_alert=lambda *a: alerts.append(a), env=env, ai_model=model(fn) if fn else None)
    return p, alerts


def test_flag_off_no_model_call_and_simulator_only(gstore):
    c = Counter(good_model)
    p, _ = gprov(gstore, c, {})
    assert p.run_due(NOW)["done"] == 1 and c.n == 0
    assert "ai_check" not in gstore.select("provisioning_jobs")[0]["result"]


def test_flag_on_pass_goes_live_path(gstore):
    p, alerts = gprov(gstore, good_model, {"GOLIVE_LIVE_AI_CHECK": "1"})
    assert p.run_due(NOW)["done"] == 1 and alerts == []
    res = gstore.select("provisioning_jobs")[0]["result"]
    assert res["passed"] is True and res["ai_check"]["status"] == "passed"


def test_flag_on_fail_keeps_testing_and_mails_the_transcript(gstore):
    p, alerts = gprov(gstore, bad_model, {"GOLIVE_LIVE_AI_CHECK": "1"})
    assert p.run_due(NOW)["failed"] == 1
    job = gstore.select("provisioning_jobs")[0]
    assert job["status"] == "failed" and job["result"]["passed"] is False  # the database keeps the client in testing
    [(kind, _biz, _slug, summary, _key)] = alerts
    assert kind == "golive_check_failed" and "Call transcript" in summary and "$99" in summary and "Go live manually" in summary


def test_flag_on_model_down_holds_for_manual_approval(gstore):
    def down(req):
        raise LLMError("anthropic api connection error")
    p, alerts = gprov(gstore, down, {"GOLIVE_LIVE_AI_CHECK": "1", "GOLIVE_AI_RETRIES": "1"})
    assert p.run_due(NOW)["held"] == 1
    job = gstore.select("provisioning_jobs")[0]
    assert job["status"] == "held" and job["result"]["ai_check"]["attempts"] == 2
    assert [a[0] for a in alerts] == ["golive_ai_manual"] and "To approve by hand" in alerts[0][3]
    assert p.run_due(NOW + timedelta(hours=2)) == {"done": 0, "held": 0, "failed": 0, "retry": 0}  # not retried forever


# ====================================================================================== 3. Spanish on Pro / Business
def plan_raw(demo_raw, code, **voice):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["plan"] = {"code": code, "status": "active", "period_start": "2026-11-01", "service": "full"}
    raw["config"]["voice"].update(voice)
    return raw


@pytest.mark.parametrize("code, voice, langs", [
    ("FR_STARTER", {}, ["en"]),
    ("FR_STARTER", {"languages": ["en", "es"]}, ["en"]),                 # downgrade: off, whatever was stored
    ("FR_PRO", {}, ["en", "es"]),                                        # on automatically
    ("FR_BUSINESS", {"languages": ["en"]}, ["en", "es"]),               # upgrade: back on ...
    ("FR_PRO", {"spanish_off": True}, ["en"]),                          # ... unless the customer switched it off
    ("FR_BUSINESS", {"spanish_off": True, "languages": ["en", "es"]}, ["en"]),
])
def test_spanish_follows_the_plan_and_the_customers_choice(demo_raw, code, voice, langs):
    assert list(load_record(plan_raw(demo_raw, code, **voice)).config.voice.languages) == langs


def test_spanish_choice_is_remembered_across_a_downgrade_and_upgrade(demo_raw):
    raw = plan_raw(demo_raw, "FR_PRO", spanish_off=True)
    for code, langs in (("FR_STARTER", ["en"]), ("FR_BUSINESS", ["en"])):
        raw["config"]["plan"]["code"] = code
        rec = load_record(raw)
        assert list(rec.config.voice.languages) == langs and rec.config.voice.spanish_off is True
    raw["config"]["voice"]["spanish_off"] = False  # the customer switches it back on
    assert list(load_record(raw).config.voice.languages) == ["en", "es"]


def test_quote_clients_are_untouched_and_the_schema_knows_the_choice(demo_raw):
    raw = copy.deepcopy(demo_raw)
    raw["config"]["voice"].update(languages=["en", "es"], spanish_off=True)  # no plan: ADD-ES as stored
    assert list(load_record(raw).config.voice.languages) == ["en", "es"]
    props = json_schema()["$defs"]["Voice"]["properties"]
    assert props["spanish_off"]["type"] == "boolean" and props["spanish_off"]["default"] is False


def test_spanish_plan_list_matches_the_price_book_and_the_sql():
    """The database trigger (private.plan_has_spanish in *_us_firstring_p2.sql) names the same plans as the price book."""
    from pathlib import Path
    sql = next((Path(__file__).resolve().parents[2] / "supabase" / "migrations").glob("*_us_firstring_p2.sql")).read_text()
    body = sql.split("create or replace function private.plan_has_spanish", 1)[1].split("$$;", 1)[0]
    in_sql = set(re.findall(r"'(FR_[A-Z_]+)'", body))
    in_book = {c for c, p in plans_mod.catalog().items() if plans_mod.SPANISH in (p.get("features") or [])}
    assert in_sql == in_book and in_book  # FR_PRO, FR_BUSINESS
