"""B6: Zapier outgoing webhook: HMAC signature, retries with backoff, dead letter, exactly-once."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.notify.routes import SIM_ADMIN_TOKEN, build_services, router
from app.store import JsonStore, StateStore
from app.tenants import load_record
from app.zapier import ZapierClient, sign, tenant_secret, url_allowed, verify
from sim import harness

HOOK = "https://hooks.zapier.com/hooks/catch/123/abcdef/"
NOW = 1_791_820_000.0


class Hook:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request):
        self.requests.append(request)
        r = self.responses.pop(0) if self.responses else httpx.Response(200)
        if isinstance(r, Exception):
            raise r
        return r


def setup(tmp_path, demo_raw, hook, events=("lead.created", "booking.created"), url=HOOK, master="master-secret"):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["zapier"] = {"webhook_url": url, "events": list(events)}
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(raw))
    sleeps: list[float] = []
    z = ZapierClient(store, StateStore(store), master, http=httpx.Client(transport=httpx.MockTransport(hook)),
                     sleep=sleeps.append, clock=lambda: NOW)
    return z, tenant, store, sleeps


def test_payload_is_signed_per_tenant(tmp_path, demo_raw):
    hook = Hook()
    z, t, store, _ = setup(tmp_path, demo_raw, hook)
    assert z.emit(t, "lead.created", "CA1", {"name": "Dana"}) == {"status": "sent", "attempts": 1}
    req = hook.requests[0]
    body, stamp, sig = req.content, req.headers["X-Timestamp"], req.headers["X-Signature"]
    secret = tenant_secret("master-secret", t.id)
    assert sig.startswith("sha256=") and verify(secret, stamp, body, sig, now=NOW)
    assert not verify(tenant_secret("master-secret", "other-tenant"), stamp, body, sig, now=NOW)
    assert not verify(secret, stamp, body.replace(b"Dana", b"Evil"), sig, now=NOW)
    assert not verify(secret, stamp, body, sig, now=NOW + 3600)  # replay window
    assert not verify(secret, "not-a-number", body, sig, now=NOW)
    payload = json.loads(body)
    assert payload == {"id": "lead.created:CA1", "event": "lead.created", "created_at": payload["created_at"],
                       "tenant": {"slug": "demo-hvac", "business": "Cool Breeze HVAC"}, "data": {"name": "Dana"}}
    assert req.headers["X-Idempotency-Key"] == "lead.created:CA1" and req.headers["X-Event"] == "lead.created"
    assert sign(secret, stamp, body) == sig


def test_exactly_once_per_idempotency_key(tmp_path, demo_raw):
    hook = Hook()
    z, t, *_ = setup(tmp_path, demo_raw, hook)
    assert z.emit(t, "lead.created", "SM1", {})["status"] == "sent"
    assert z.emit(t, "lead.created", "SM1", {})["status"] == "duplicate"
    assert z.emit(t, "booking.created", "SM1", {})["status"] == "sent"
    assert len(hook.requests) == 2


def test_retries_with_backoff_then_success(tmp_path, demo_raw):
    hook = Hook(httpx.Response(500), httpx.ConnectError("boom"), httpx.Response(429), httpx.Response(200))
    z, t, store, sleeps = setup(tmp_path, demo_raw, hook)
    assert z.emit(t, "lead.created", "CA2", {}) == {"status": "sent", "attempts": 4}
    assert sleeps == [2.0, 8.0, 30.0]
    assert [e["type"] for e in store.select("events")] == ["zapier.sent"]


def test_dead_letter_after_three_retries(tmp_path, demo_raw):
    hook = Hook(*[httpx.Response(503)] * 4)
    z, t, store, sleeps = setup(tmp_path, demo_raw, hook)
    assert z.emit(t, "lead.created", "CA3", {"name": "Dana"}) == {"status": "dead_letter", "reason": "503"}
    assert len(hook.requests) == 4 and len(sleeps) == 3
    dead = [e for e in store.select("events") if e["type"] == "zapier.dead_letter"]
    assert len(dead) == 1 and dead[0]["payload"]["payload"]["data"] == {"name": "Dana"}
    assert z.emit(t, "lead.created", "CA3", {})["status"] == "duplicate"  # not retried forever


def test_client_errors_are_not_retried(tmp_path, demo_raw):
    hook = Hook(httpx.Response(410))
    z, t, store, sleeps = setup(tmp_path, demo_raw, hook)
    assert z.emit(t, "lead.created", "CA4", {})["status"] == "dead_letter"
    assert len(hook.requests) == 1 and sleeps == []


def test_unsubscribed_or_missing_webhook_is_skipped(tmp_path, demo_raw):
    hook = Hook()
    z, t, *_ = setup(tmp_path, demo_raw, hook, events=("booking.created",))
    assert z.emit(t, "lead.created", "x", {})["status"] == "skipped"
    z2, t2, *_ = setup(tmp_path / "b", demo_raw, hook, url=None)
    assert z2.emit(t2, "booking.created", "x", {})["status"] == "skipped"
    assert hook.requests == []


def test_missing_signing_secret_never_sends_unsigned(tmp_path, demo_raw):
    hook = Hook()
    z, t, store, _ = setup(tmp_path, demo_raw, hook, master="")
    assert z.emit(t, "lead.created", "x", {})["reason"] == "signing_secret_missing" and hook.requests == []


@pytest.mark.parametrize("url,ok", [
    (HOOK, True), ("https://example.com/hook", True), ("http://hooks.zapier.com/x", False),
    ("https://localhost/x", False), ("https://127.0.0.1/x", False), ("https://10.0.0.5/x", False),
    ("https://169.254.169.254/latest/meta-data", False), ("https://[::1]/x", False), ("https://api.internal/x", False),
    ("", False)])
def test_url_guard(url, ok):
    assert url_allowed(url) is ok


def test_private_ip_webhook_is_dead_lettered_without_a_request(tmp_path, demo_raw):
    hook = Hook()
    z, t, store, _ = setup(tmp_path, demo_raw, hook, url="https://192.168.1.10/hook")
    assert z.emit(t, "lead.created", "x", {})["reason"] == "url_not_allowed" and hook.requests == []


def test_admin_test_and_secret_endpoints(tmp_path, demo_raw):
    hook = Hook()
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["zapier"] = {"webhook_url": HOOK, "events": ["lead.created"]}
    settings = harness.sim_settings(tmp_path)
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(raw))
    app = create_app(settings, store)
    app.include_router(router)
    state = StateStore(store)
    zap = ZapierClient(store, state, "master-secret", http=httpx.Client(transport=httpx.MockTransport(hook)),
                       sleep=lambda s: None)
    app.state.b56 = build_services(settings, store, state, env={}, zapier=zap)
    client = TestClient(app)
    auth = {"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}
    assert client.post("/zapier/demo-hvac/test").status_code == 401
    assert client.post("/zapier/nope/test", headers=auth).status_code == 404
    r = client.post("/zapier/demo-hvac/test", headers=auth)
    assert r.json()["status"] == "sent" and hook.requests[0].headers["X-Event"] == "test.ping"
    assert client.post("/zapier/demo-hvac/test", headers=auth).json()["status"] == "sent"  # tests may repeat
    sec = client.get("/zapier/demo-hvac/secret", headers=auth).json()
    assert sec["signing_secret"] == tenant_secret("master-secret", tenant.id) and sec["header"] == "X-Signature"
