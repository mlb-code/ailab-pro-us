"""B5: OAuth connect flow (state, PKCE, encrypted storage) and the /oauth/* endpoints, all offline."""
from __future__ import annotations

import base64
import hashlib
import json
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import crypto
from app.calendar import CalendarAuthError
from app.main import create_app
from app.notify.routes import SIM_ADMIN_TOKEN, build_services, router
from app.store import JsonStore
from app.tenants import load_record
from sim import harness

from test_b5_calendar_contract import OAUTH_ENV, make_env
from test_b5_support import MON_9, FakeUpstream


def q(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


@pytest.mark.parametrize("provider", ["google", "calendly"])
def test_authorize_url_has_pkce_state_and_redirect(provider, tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    url = e.hub.tokens.authorize_url(e.tid, provider)
    p = q(url)
    assert p["client_id"] == OAUTH_ENV["GOOGLE_CALENDAR_CLIENT_ID" if provider == "google" else "CALENDLY_CLIENT_ID"]
    assert p["redirect_uri"] == f"https://rt.example.test/oauth/{provider}/callback"
    assert p["code_challenge_method"] == "S256" and len(p["code_challenge"]) == 43 and p["response_type"] == "code"
    body = crypto.verify(harness.sim_settings(tmp_path).cred_key, p["state"], now=MON_9.timestamp())
    assert body["t"] == e.tid and body["p"] == provider and e.tid not in body["v"]
    if provider == "google":
        assert p["scope"] == "https://www.googleapis.com/auth/calendar.events"
        assert p["access_type"] == "offline" and p["prompt"] == "consent"
    else:
        assert url.startswith("https://auth.calendly.com/oauth/authorize?")


def test_callback_sends_the_matching_pkce_verifier(tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    e.up = FakeUpstream()
    seen = {}

    def spy(req):
        if req.url.host == "oauth2.googleapis.com":
            seen.update(parse_qs(req.content.decode()))
        return None
    e.up.extra = spy
    e.hub.tokens.http = e.up.client()
    p = q(e.hub.tokens.authorize_url(e.tid, "google"))
    e.hub.tokens.handle_callback("google", "good-code", p["state"])
    verifier = seen["code_verifier"][0]
    assert base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=") == p["code_challenge"]
    assert seen["redirect_uri"] == ["https://rt.example.test/oauth/google/callback"]


def test_state_tampered_expired_or_wrong_provider_is_refused(tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    state = q(e.hub.tokens.authorize_url(e.tid, "google"))["state"]
    with pytest.raises(crypto.CryptoError):
        e.hub.tokens.handle_callback("calendly", "good-code", state)
    with pytest.raises(crypto.CryptoError):
        e.hub.tokens.handle_callback("google", "good-code", state[:-3] + "AAA")
    e.advance(11 * 60)
    with pytest.raises(crypto.CryptoError):
        e.hub.tokens.handle_callback("google", "good-code", state)


def test_bad_code_is_an_auth_error_and_stores_nothing(tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    state = q(e.hub.tokens.authorize_url(e.tid, "google"))["state"]
    with pytest.raises(CalendarAuthError):
        e.hub.tokens.handle_callback("google", "bad-code", state)
    assert e.store.get_credential(e.tid, "google") is None


def test_credentials_are_bound_to_tenant_and_provider(tmp_path, demo_raw):
    e = make_env("google", tmp_path, demo_raw)
    cipher = e.store.get_credential(e.tid, "google")
    key = harness.sim_settings(tmp_path).cred_key
    assert json.loads(crypto.decrypt(key, cipher, e.tid, "google"))["refresh_token"] == "1//FAKE-refresh-google"
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(key, cipher, "another-tenant", "google")
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(key, cipher, e.tid, "calendly")


def test_unconfigured_client_is_refused(tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    e.hub.tokens.clients.pop("google")
    with pytest.raises(CalendarAuthError):
        e.hub.tokens.authorize_url(e.tid, "google")


def test_calendly_event_type_is_resolved_once_and_remembered(tmp_path, demo_raw):
    e = make_env("calendly", tmp_path, demo_raw)
    assert e.hub.availability(e.tid, e.cfg, MON_9)
    assert e.hub.tokens.meta(e.tid, "calendly")["event_type"].endswith("/event_types/FAKEET0001")
    n = sum(1 for r in e.up.requests if r.url.path == "/users/me")
    e.hub.availability(e.tid, e.cfg, MON_9)
    assert sum(1 for r in e.up.requests if r.url.path == "/users/me") == n == 1


# --- HTTP endpoints ------------------------------------------------------------------------

@pytest.fixture
def web(tmp_path, demo_raw):
    settings = harness.sim_settings(tmp_path, PUBLIC_BASE_URL="https://rt.example.test")
    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(demo_raw))
    up = FakeUpstream()
    app = create_app(settings, store)
    app.include_router(router)
    app.state.b56 = build_services(settings, store, env=dict(OAUTH_ENV), http=up.client())
    return TestClient(app), app.state.b56, tenant


AUTH = {"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}


def test_ticket_needs_the_admin_token(web):
    client, svc, tenant = web
    assert client.post("/oauth/google/ticket", json={"tenant_id": tenant.id}).status_code == 401
    assert client.post("/oauth/google/ticket", json={"tenant_id": tenant.id},
                       headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/oauth/outlook/ticket", json={"tenant_id": tenant.id}, headers=AUTH).status_code == 404
    assert client.post("/oauth/google/ticket", json={"tenant_id": "nobody"}, headers=AUTH).status_code == 404
    svc.admin_token = ""
    assert client.post("/oauth/google/ticket", json={"tenant_id": tenant.id}, headers=AUTH).status_code == 503


@pytest.mark.parametrize("provider", ["calendly", "google"])
def test_full_connect_flow_over_http(provider, web):
    client, svc, tenant = web
    start = client.post(f"/oauth/{provider}/ticket", json={"tenant_id": tenant.id}, headers=AUTH).json()["url"]
    assert start.startswith(f"https://rt.example.test/oauth/{provider}/start?ticket=")
    r = client.get(urlparse(start).path + "?" + urlparse(start).query, follow_redirects=False)
    assert r.status_code == 302
    state = q(r.headers["location"])["state"]
    cb = client.get(f"/oauth/{provider}/callback", params={"code": "good-code", "state": state}, follow_redirects=False)
    assert cb.status_code == 302 and "result=connected" in cb.headers["location"]
    assert "/start/?" in cb.headers["location"]
    assert svc.store.get_credential(tenant.id, provider)
    assert any(e["type"] == "calendar.connected" for e in svc.store.for_tenant(tenant.id).select("events"))


def test_start_and_callback_refuse_bad_input(web):
    client, svc, tenant = web
    assert client.get("/oauth/google/start", params={"ticket": "x.y"}).status_code == 400
    assert client.get("/oauth/zoom/start").status_code == 404
    ticket = svc.calendar.tokens.ticket(tenant.id, "calendly")
    assert client.get("/oauth/google/start", params={"ticket": ticket}).status_code == 400  # wrong provider
    r = client.get("/oauth/google/callback", params={"error": "access_denied"}, follow_redirects=False)
    assert r.status_code == 302 and "result=cancelled" in r.headers["location"]
    assert client.get("/oauth/google/callback", params={"code": "good-code", "state": "bad.state"}).status_code == 400
    state = q(svc.calendar.tokens.authorize_url(tenant.id, "google"))["state"]
    r = client.get("/oauth/google/callback", params={"code": "bad-code", "state": state}, follow_redirects=False)
    assert r.status_code == 302 and "result=error" in r.headers["location"]


def test_state_and_ticket_are_single_use(web):
    client, svc, tenant = web
    tokens = svc.calendar.tokens
    ticket = tokens.ticket(tenant.id, "google")
    r = client.get("/oauth/google/start", params={"ticket": ticket}, follow_redirects=False)
    assert r.status_code == 302
    assert client.get("/oauth/google/start", params={"ticket": ticket}).status_code == 400  # replayed ticket
    state = q(r.headers["location"])["state"]
    ok = client.get("/oauth/google/callback", params={"code": "good-code", "state": state}, follow_redirects=False)
    assert ok.status_code == 302 and "result=connected" in ok.headers["location"]
    again = client.get("/oauth/google/callback", params={"code": "good-code", "state": state})
    assert again.status_code == 400  # replayed state


def test_state_replay_refused_at_the_token_manager(tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    state = q(e.hub.tokens.authorize_url(e.tid, "google"))["state"]
    e.hub.tokens.handle_callback("google", "good-code", state)
    with pytest.raises(crypto.CryptoError):
        e.hub.tokens.handle_callback("google", "good-code", state)
