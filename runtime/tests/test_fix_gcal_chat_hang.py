"""Incident 2026-10-28: the first chat turn that checked a REAL (Google) calendar never returned.

Root cause: `hooks_b56.hub_for` held the module lock (a plain, non-reentrant `threading.Lock`) while it called
`queue_for`, which takes the same lock -> the thread deadlocked on itself, and from then on every `hub_for`,
`queue_for` (owner alerts, Zapier/CRM emits, /jobs/tick), `notifier_for` ... in the process blocked for good.
Fake-calendar tenants never build a hub, which is why the simulator and the fake-calendar runs never saw it.

These tests run in a worker thread with a join timeout, so the old code fails them instead of hanging the suite.

    cd runtime && .venv/bin/python -m pytest -q tests/test_fix_gcal_chat_hang.py
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app import hooks_b56
from app import settings as settings_mod
from app.calendar import build_hub
from app.conversation import Engine
from app.llm import LLMClient
from app.store import JsonStore
from app.tenants import load_record
from sim import harness

from test_b5_calendar_contract import OAUTH_ENV
from test_b5_support import MON_9

TZ = "Asia/Jerusalem"


def _in_thread(fn, timeout: float = 8.0):
    out: dict = {}

    def run():
        try:
            out["value"] = fn()
        except BaseException as exc:  # noqa: BLE001
            out["error"] = exc
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "call did not return (deadlock / hang)"
    if "error" in out:
        raise out["error"]
    return out.get("value")


@pytest.fixture
def prod_settings(tmp_path):
    s = settings_mod.load({"RUNTIME_MODE": "prod", "STORE_BACKEND": "json", "DATA_DIR": str(tmp_path),
                           "CRED_KEY": settings_mod.SIM_CRED_KEY, "BRAIN_MODE": "mock"})
    yield s
    hub = hooks_b56._hubs.pop(s, None)
    if hub is not None:
        q = hooks_b56._queues.pop(hub.providers["google"].store, None)
        if q is not None:
            q.stop()


def test_first_real_calendar_hub_does_not_deadlock(prod_settings, demo_raw):
    hub = _in_thread(lambda: hooks_b56.hub_for(prod_settings))
    assert hub is _in_thread(lambda: hooks_b56.hub_for(prod_settings))  # cached, and the lock was released
    assert hooks_b56._lock.acquire(timeout=1)
    hooks_b56._lock.release()


def test_tenant_calendars_google_availability_returns(prod_settings, demo_raw):
    """The exact production path of the hung chat turn: engine-facing TenantCalendars -> get_provider -> hub_for ->
    Google provider (here not connected: an auth failure, empty slots and a reconnect flag, but it RETURNS)."""
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["booking"]["provider"] = "google"
    raw["config"]["business"]["timezone"] = TZ
    tenant = load_record(raw)
    cals = hooks_b56.TenantCalendars(prod_settings)
    assert _in_thread(lambda: cals.availability(tenant.id, tenant.config, MON_9, limit=3)) == []
    # alerts/emits for every other tenant (demo voice included) still go through the hooks lock
    store = hooks_b56._hubs[prod_settings].providers["google"].store
    assert _in_thread(lambda: hooks_b56.queue_for(store, hooks_b56.StateStore(store), autostart=False)) is not None


# --- Google events.list as Google really answers it (BUSY_FIELDS shape, all-day event, pages) ------------------

class GoogleShape:
    def __init__(self, repeat_token: bool = False, status: int = 200):
        self.lists = 0
        self.repeat_token = repeat_token
        self.status = status

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth2.googleapis.com":
            form = parse_qs(request.content.decode())
            if form.get("grant_type") == ["authorization_code"]:
                return httpx.Response(200, json={"access_token": "ya29.A", "refresh_token": "1//R", "expires_in": 3599,
                                                 "scope": "https://www.googleapis.com/auth/calendar.events",
                                                 "token_type": "Bearer"})
            return httpx.Response(200, json={"access_token": "ya29.B", "expires_in": 3599, "token_type": "Bearer"})
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": self.status, "message": "nope"}})
        assert request.url.params["fields"].startswith("nextPageToken,items(")
        self.lists += 1
        page = request.url.params.get("pageToken")
        if self.repeat_token:  # a broken upstream that keeps returning the same token
            return httpx.Response(200, json={"items": [], "nextPageToken": "same"})
        if page is None:
            return httpx.Response(200, json={"items": [
                {"status": "confirmed", "start": {"date": "2026-10-29"}, "end": {"date": "2026-10-30"}},  # all day
                {"status": "confirmed", "transparency": "transparent",
                 "start": {"dateTime": "2026-10-30T08:00:00+02:00"}, "end": {"dateTime": "2026-10-30T12:00:00+02:00"}},
            ], "nextPageToken": "p2"})
        return httpx.Response(200, json={"items": [
            {"status": "confirmed", "start": {"dateTime": "2026-11-01T06:00:00Z", "timeZone": TZ},
             "end": {"dateTime": "2026-11-01T12:00:00Z", "timeZone": TZ}},
            {"status": "confirmed", "extendedProperties": {"private": {"ailab_booking": "1", "slot_id": "x"}},
             "start": {"dateTime": "2026-11-02T08:00:00+02:00"}, "end": {"dateTime": "2026-11-02T12:00:00+02:00"}},
        ]})


def _google_env(tmp_path, demo_raw, up: GoogleShape):
    store = JsonStore(tmp_path)
    settings = harness.sim_settings(tmp_path, PUBLIC_BASE_URL="https://rt.example.test")
    alerts: list = []
    hub = build_hub(store, settings, alert=lambda t, a: alerts.append(a),
                    http=httpx.Client(transport=httpx.MockTransport(up.handle)), env=OAUTH_ENV)
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["booking"]["provider"] = "google"
    raw["config"]["business"]["timezone"] = TZ
    tenant = store.upsert_tenant(load_record(raw))
    url = hub.tokens.authorize_url(tenant.id, "google")
    hub.tokens.handle_callback("google", "code", parse_qs(urlparse(url).query)["state"][0])
    return hub, tenant, alerts


NOW = datetime(2026, 10, 28, 10, 28, tzinfo=timezone.utc)  # the incident: Wednesday, Jerusalem


def test_google_pages_all_day_and_our_own_events(tmp_path, demo_raw):
    up = GoogleShape()
    hub, t, _ = _google_env(tmp_path, demo_raw, up)
    slots = _in_thread(lambda: hub.availability(t.id, t.config, NOW, limit=50))
    assert up.lists == 2  # followed nextPageToken once, then stopped
    days = {s["slot_id"][:10] for s in slots}
    assert "2026-10-29" not in days  # the all-day event blocks the whole day


def test_google_repeating_page_token_cannot_loop(tmp_path, demo_raw):
    up = GoogleShape(repeat_token=True)
    hub, t, _ = _google_env(tmp_path, demo_raw, up)
    _in_thread(lambda: hub.availability(t.id, t.config, NOW))
    assert up.lists == 2


@pytest.mark.parametrize("status,flagged", [(403, True), (500, False)])
def test_google_errors_return_no_slots_quickly(tmp_path, demo_raw, status, flagged):
    up = GoogleShape(status=status)
    hub, t, alerts = _google_env(tmp_path, demo_raw, up)
    assert _in_thread(lambda: hub.availability(t.id, t.config, NOW)) == []
    assert hub.needs_reconnect(t.id, t.config) is flagged


# --- hard upper bound: a provider that never answers cannot hang a turn ------------------------------------------

def test_hung_provider_is_cut_off_by_the_deadline(demo_raw):
    gate = threading.Event()

    class Stuck:
        def availability(self, *a, **k):
            gate.wait(30)
            return []

        def book(self, *a, **k):
            gate.wait(30)
            return {"ok": True}

    tenant = load_record(json.loads(json.dumps(demo_raw)))
    cals = hooks_b56.TenantCalendars(None, resolve=lambda tid, cfg: Stuck(), read_deadline_s=0.3, write_deadline_s=0.3)
    try:
        t0 = time.monotonic()
        with pytest.raises(hooks_b56.CalendarTimeout):
            cals.availability(tenant.id, tenant.config, MON_9)
        assert cals.book(tenant.id, tenant.config, MON_9, "s", {}) == {"ok": False, "reason": "calendar_unavailable"}
        assert time.monotonic() - t0 < 3
    finally:
        gate.set()


def test_engine_takes_a_message_when_availability_fails(tmp_path, demo_raw):
    class Broken:
        def availability(self, *a, **k):
            raise hooks_b56.CalendarTimeout("calendar availability timed out")

    store = JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(json.loads(json.dumps(demo_raw))))
    settings = harness.sim_settings(tmp_path)
    eng = Engine(store, LLMClient(settings, mode="mock"), Broken(), settings)
    results = []
    orig = eng._execute

    def spy(*a, **k):
        res = orig(*a, **k)
        results.append((a[-2], res))
        return res
    eng._execute = spy
    for i, text in enumerate(["Hi, my AC is blowing warm air", "77005"]):
        r = _in_thread(lambda text=text, i=i: eng.handle(tenant, "chat", "web-x", text, "chat-x",
                                                          MON_9 + timedelta(minutes=i)))
    avail = [res for name, res in results if name == "get_availability"]
    assert avail and avail[-1]["reason"] == "calendar_unavailable"
    assert r.reply
