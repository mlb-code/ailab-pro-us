"""B5: the shared calendar-provider contract, run against fake, Google (fake HTTP) and Calendly (fake HTTP).

    cd runtime && .venv/bin/python -m pytest -q tests/test_b5_calendar_contract.py
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, time
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import pytest

from app.calendar import BOOKED_BY, CalendarHub, build_hub
from app.conversation import Engine
from app.llm import LLMClient
from app.store import JsonStore
from app.tenants import TenantRecord, load_record
from sim import harness

from test_b5_support import MON_9, FakeUpstream

OAUTH_ENV = {"GOOGLE_CALENDAR_CLIENT_ID": "gcal-client.apps.example", "GOOGLE_CALENDAR_CLIENT_SECRET": "test-only-g",
             "CALENDLY_CLIENT_ID": "calendly-client", "CALENDLY_CLIENT_SECRET": "test-only-c"}
PROVIDERS = ["fake", "google", "calendly"]


@dataclass
class Env:
    provider: str
    store: JsonStore
    hub: CalendarHub
    tenant: TenantRecord
    up: FakeUpstream
    alerts: list = field(default_factory=list)
    clock: list = field(default_factory=list)

    @property
    def cfg(self):
        return self.tenant.config

    @property
    def tid(self):
        return self.tenant.id

    def busy(self, start: datetime, end: datetime) -> None:
        if self.provider == "fake":
            self.hub.providers["fake"].add_busy(self.tid, start, end)
        else:
            self.up.owner_busy(start, end, self.provider)

    def created(self) -> list[dict[str, Any]]:
        if self.provider == "fake":
            return list(self.hub.providers["fake"].events.values())
        return self.up.created(self.provider)

    def revoke(self) -> None:
        if self.provider == "fake":
            self.hub.providers["fake"].fail = "auth"
            return
        if self.provider == "google":
            self.up.g_revoked = True
            self.up.g_valid.clear()
        else:
            self.up.c_revoked = True
            self.up.c_valid.clear()

    def advance(self, seconds: float) -> None:
        self.clock[0] += seconds


def connect(hub: CalendarHub, tenant_id: str, provider: str) -> None:
    """Run the real OAuth flow against the fake token endpoint."""
    url = hub.tokens.authorize_url(tenant_id, provider)
    state = parse_qs(urlparse(url).query)["state"][0]
    assert hub.tokens.handle_callback(provider, "good-code", state) == tenant_id


def make_env(provider: str, tmp_path, demo_raw, tz: str = "America/Chicago", **booking) -> Env:
    store = JsonStore(tmp_path)
    settings = harness.sim_settings(tmp_path, PUBLIC_BASE_URL="https://rt.example.test")
    up = FakeUpstream(tz)
    env = Env(provider, store, None, None, up, clock=[MON_9.timestamp()])  # type: ignore[arg-type]
    hub = build_hub(store, settings, alert=lambda t, a: env.alerts.append((t, a)), http=up.client(), env=OAUTH_ENV)
    hub.tokens.clock = lambda: env.clock[0]
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["booking"].update(provider=provider, **booking)
    raw["config"]["business"]["timezone"] = tz
    env.hub, env.tenant = hub, store.upsert_tenant(load_record(raw))
    if provider != "fake":
        connect(hub, env.tid, provider)
    return env


@pytest.fixture(params=PROVIDERS)
def env(request, tmp_path, demo_raw) -> Env:
    return make_env(request.param, tmp_path, demo_raw)


# --- availability rules ----------------------------------------------------------------------

def test_slots_follow_windows_hours_lead_time_and_horizon(env):
    slots = env.hub.availability(env.tid, env.cfg, MON_9, limit=100)
    tz = ZoneInfo(env.cfg.business.timezone)
    assert slots, "provider offers slots"
    assert slots[0]["slot_id"] == "2026-10-12T12:00-16:00"  # 08:00 window is inside the 2 h lead time
    windows = {tuple(w) for w in env.cfg.booking.windows}
    starts = []
    for s in slots:
        start, end = datetime.fromisoformat(s["start"]), datetime.fromisoformat(s["end"])
        local = start.astimezone(tz)
        assert start.tzinfo is not None and start >= MON_9 + timedelta(hours=2)
        assert (local.strftime("%H:%M"), end.astimezone(tz).strftime("%H:%M")) in windows
        assert local.weekday() != 6, "closed on Sunday"
        assert local.date() <= (MON_9 + timedelta(days=env.cfg.booking.days_ahead)).date()
        assert s["label"] and s["slot_id"].startswith(local.date().isoformat())
        starts.append(start)
    assert starts == sorted(starts)
    assert len(env.hub.availability(env.tid, env.cfg, MON_9, limit=3)) == 3


def test_date_from_moves_the_first_slot(env):
    slots = env.hub.availability(env.tid, env.cfg, MON_9, date_from=MON_9.date() + timedelta(days=2))
    assert slots[0]["slot_id"].startswith("2026-10-14T08:00")


def test_owner_event_covering_a_window_blocks_it(env):
    tz = ZoneInfo(env.cfg.business.timezone)
    day = MON_9.date() + timedelta(days=1)
    env.busy(datetime.combine(day, time(8), tz), datetime.combine(day, time(12), tz))
    ids = [s["slot_id"] for s in env.hub.availability(env.tid, env.cfg, MON_9, limit=100)]
    assert "2026-10-13T08:00-12:00" not in ids and "2026-10-13T12:00-16:00" in ids


# --- booking ---------------------------------------------------------------------------------

DETAILS = {"name": "Dana Miller", "phone": "+17135550123", "address": "2100 Rice Blvd, Houston, TX 77005",
           "job_type": "AC repair", "urgency": "normal", "notes": "Blowing warm air"}


def test_book_creates_one_event_with_all_job_details(env):
    slot = env.hub.availability(env.tid, env.cfg, MON_9)[0]
    res = env.hub.book(env.tid, env.cfg, MON_9, slot["slot_id"], dict(DETAILS))
    assert res["ok"] and res["event_id"] and res["start"] == slot["start"] and res["label"] == slot["label"]
    created = env.created()
    assert len(created) == 1
    blob = json.dumps(created[0])
    for v in ("Dana Miller", "+17135550123", "2100 Rice Blvd", "AC repair", "Blowing warm air", BOOKED_BY):
        assert v in blob, v


def test_book_rejects_a_slot_that_is_not_offered(env):
    assert env.hub.book(env.tid, env.cfg, MON_9, "2026-10-12T08:00-12:00", dict(DETAILS)) == \
        {"ok": False, "reason": "slot_unavailable"}  # inside lead time
    assert env.hub.book(env.tid, env.cfg, MON_9, "2026-10-18T08:00-12:00", dict(DETAILS))["reason"] == "slot_unavailable"
    assert env.hub.book(env.tid, env.cfg, MON_9, "nonsense", dict(DETAILS))["reason"] == "slot_unavailable"
    assert env.created() == []


def test_duplicate_guard_same_phone_same_day(env):
    slots = env.hub.availability(env.tid, env.cfg, MON_9, date_from=MON_9.date() + timedelta(days=1))
    assert env.hub.book(env.tid, env.cfg, MON_9, slots[0]["slot_id"], dict(DETAILS))["ok"]
    again = env.hub.book(env.tid, env.cfg, MON_9, slots[1]["slot_id"], dict(DETAILS))
    assert again == {"ok": False, "reason": "duplicate"}
    other_day = env.hub.availability(env.tid, env.cfg, MON_9, date_from=MON_9.date() + timedelta(days=2))[0]
    assert env.hub.book(env.tid, env.cfg, MON_9, other_day["slot_id"], dict(DETAILS))["ok"]
    assert len(env.created()) == 2


def test_max_per_window(env):
    slot_id = "2026-10-13T08:00-12:00"
    for i in range(env.cfg.booking.max_per_window):
        assert env.hub.book(env.tid, env.cfg, MON_9, slot_id, dict(DETAILS, phone=f"+1713555020{i}"))["ok"]
    ids = [s["slot_id"] for s in env.hub.availability(env.tid, env.cfg, MON_9, limit=100)]
    assert slot_id not in ids
    assert env.hub.book(env.tid, env.cfg, MON_9, slot_id, dict(DETAILS, phone="+17135550299"))["reason"] == "slot_unavailable"


def test_ledger_survives_a_new_hub(env, tmp_path):
    slot_id = "2026-10-13T08:00-12:00"
    assert env.hub.book(env.tid, env.cfg, MON_9, slot_id, dict(DETAILS))["ok"]
    fresh = build_hub(env.store, harness.sim_settings(tmp_path), http=env.up.client(), env=OAUTH_ENV)
    fresh.tokens.clock = env.hub.tokens.clock
    assert fresh.book(env.tid, env.cfg, MON_9, "2026-10-13T12:00-16:00", dict(DETAILS))["reason"] == "duplicate"


# --- cancellation ----------------------------------------------------------------------------

def test_cancel_frees_the_slot_and_marks_the_booking(env):
    slot_id = "2026-10-13T08:00-12:00"
    ts = env.store.for_tenant(env.tid)
    ids = []
    for i in range(env.cfg.booking.max_per_window):
        r = env.hub.book(env.tid, env.cfg, MON_9, slot_id, dict(DETAILS, phone=f"+1713555030{i}"))
        ts.insert("bookings", {"contact_e164": f"+1713555030{i}", "provider_event_id": r["event_id"],
                               "start_at": r["start"], "end_at": r["end"], "status": "confirmed"})
        ids.append(r["event_id"])
    assert slot_id not in [s["slot_id"] for s in env.hub.availability(env.tid, env.cfg, MON_9, limit=100)]
    assert env.hub.cancel(env.tid, env.cfg, ids[0], "Customer cancelled by text", now=MON_9) == {"ok": True}
    assert slot_id in [s["slot_id"] for s in env.hub.availability(env.tid, env.cfg, MON_9, limit=100)]
    assert [b["status"] for b in ts.select("bookings", provider_event_id=ids[0])] == ["cancelled"]
    assert env.hub.cancel(env.tid, env.cfg, ids[0], now=MON_9) == {"ok": False, "reason": "not_found"}
    assert any(e["type"] == "booking.cancelled" for e in ts.select("events"))


def test_cancel_refuses_events_we_did_not_create(env):
    assert env.hub.cancel(env.tid, env.cfg, "someone-elses-event", now=MON_9) == {"ok": False, "reason": "not_found"}


# --- auth failure -> reconnect flag, alert once, take_message fallback --------------------------

def test_refresh_failure_flags_tenant_and_falls_back(env):
    env.revoke()
    env.advance(3 * 3600)  # access token expired -> refresh -> refused
    assert env.hub.availability(env.tid, env.cfg, MON_9) == []
    assert env.hub.needs_reconnect(env.tid, env.cfg)
    assert env.hub.book(env.tid, env.cfg, MON_9, "2026-10-13T08:00-12:00", dict(DETAILS)) == \
        {"ok": False, "reason": "calendar_unavailable"}
    env.hub.availability(env.tid, env.cfg, MON_9)
    assert [a["kind"] for _, a in env.alerts] == ["calendar_reconnect"]  # exactly one alert
    assert env.alerts[0][0] == env.tid
    events = [e["type"] for e in env.store.for_tenant(env.tid).select("events")]
    assert events.count("calendar.reconnect_needed") == 1


def test_temporary_outage_does_not_flag(env):
    if env.provider == "fake":
        env.hub.providers["fake"].fail = "down"
    else:
        env.up.down = True
    assert env.hub.availability(env.tid, env.cfg, MON_9) == []
    assert env.hub.book(env.tid, env.cfg, MON_9, "2026-10-13T08:00-12:00", dict(DETAILS))["reason"] == "calendar_unavailable"
    assert not env.hub.needs_reconnect(env.tid, env.cfg) and env.alerts == []
    env.up.down = False
    if env.provider == "fake":
        env.hub.providers["fake"].fail = None
    assert env.hub.availability(env.tid, env.cfg, MON_9)


@pytest.mark.parametrize("provider", ["google", "calendly"])
def test_expired_access_token_is_refreshed_and_stored_encrypted(provider, tmp_path, demo_raw):
    e = make_env(provider, tmp_path, demo_raw)
    e.advance(3 * 3600)
    assert e.hub.availability(e.tid, e.cfg, MON_9)
    assert (e.up.g_refreshes if provider == "google" else e.up.c_refreshes) == 1
    cipher = e.store.get_credential(e.tid, provider)
    assert cipher.startswith("v1.") and "FAKE" not in cipher and "refresh" not in cipher
    rec = e.hub.tokens.load(e.tid, provider)
    assert rec["refresh_token"]  # Google keeps the old refresh token; Calendly rotates it
    if provider == "calendly":
        assert rec["refresh_token"] == "FAKE-calendly-refresh-2"


@pytest.mark.parametrize("provider", ["google", "calendly"])
def test_401_triggers_one_forced_refresh(provider, tmp_path, demo_raw):
    e = make_env(provider, tmp_path, demo_raw)
    (e.up.g_valid if provider == "google" else e.up.c_valid).discard(
        "ya29.FAKE-access-1" if provider == "google" else "eyFAKE.calendly.access.1")
    assert e.hub.availability(e.tid, e.cfg, MON_9)
    assert not e.hub.needs_reconnect(e.tid, e.cfg)


def test_reconnect_clears_the_flag(tmp_path, demo_raw):
    e = make_env("google", tmp_path, demo_raw)
    e.revoke()
    e.advance(3 * 3600)
    assert e.hub.availability(e.tid, e.cfg, MON_9) == [] and e.hub.needs_reconnect(e.tid, e.cfg)
    e.up.g_revoked = False
    e.up.g_valid.update({"ya29.FAKE-access-1", "ya29.FAKE-access-refreshed"})
    connect(e.hub, e.tid, "google")
    e.hub.connected(e.tid, "google")
    assert not e.hub.needs_reconnect(e.tid, e.cfg) and e.hub.availability(e.tid, e.cfg, MON_9)


def test_not_connected_is_an_auth_failure(tmp_path, demo_raw):
    e = make_env("fake", tmp_path, demo_raw)
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["booking"]["provider"] = "google"
    t = e.store.upsert_tenant(load_record(raw))
    assert e.hub.availability(t.id, t.config, MON_9) == []
    assert e.hub.needs_reconnect(t.id, t.config)


# --- timezones -------------------------------------------------------------------------------

@pytest.mark.parametrize("provider", PROVIDERS)
def test_timezone_and_dst(provider, tmp_path, demo_raw):
    """Los Angeles tenant across the DST change (Sun 2026-11-01): offsets follow the local clock."""
    e = make_env(provider, tmp_path, demo_raw, tz="America/Los_Angeles")
    now = datetime(2026, 10, 31, 20, 0, tzinfo=ZoneInfo("UTC"))  # Sat 13:00 PDT
    slots = e.hub.availability(e.tid, e.cfg, now, limit=4)
    assert slots[0]["slot_id"] == "2026-11-02T08:00-12:00"  # Sat 12-16 is inside lead time; Sunday closed
    assert slots[0]["start"].endswith("-08:00")  # PST after the change
    friday = e.hub.availability(e.tid, e.cfg, datetime(2026, 10, 30, 13, 0, tzinfo=ZoneInfo("UTC")), limit=1)
    assert friday[0]["slot_id"] == "2026-10-30T08:00-12:00" and friday[0]["start"].endswith("-07:00")
    assert e.hub.book(e.tid, e.cfg, now, slots[0]["slot_id"], dict(DETAILS))["ok"]


# --- engine integration ------------------------------------------------------------------------

def _engine(e: Env, tmp_path) -> Engine:
    settings = harness.sim_settings(tmp_path)
    return Engine(e.store, LLMClient(settings, mode="mock"), e.hub, settings)


TURNS = ["Hi, my AC is blowing warm air", "77005", "The first one works", "My name is Dana Miller",
         "2100 Rice Blvd, Houston 77005", "Thanks"]


@pytest.mark.parametrize("provider", PROVIDERS)
def test_engine_books_through_the_hub(provider, tmp_path, demo_raw):
    e = make_env(provider, tmp_path, demo_raw)
    eng = _engine(e, tmp_path)
    kinds = []
    for i, text in enumerate(TURNS):
        r = eng.handle(e.tenant, "sms", harness.CALLER, text, "SMthread1", MON_9 + timedelta(minutes=i))
        kinds += [a.get("kind") for a in r.actions]
    assert r.outcome == "booked" and "booking" in kinds
    assert len(e.created()) == 1
    rows = e.store.for_tenant(e.tid).select("bookings")
    assert len(rows) == 1 and rows[0]["provider_event_id"]


@pytest.mark.parametrize("provider", PROVIDERS)
def test_engine_takes_a_message_when_the_calendar_is_disconnected(provider, tmp_path, demo_raw):
    e = make_env(provider, tmp_path, demo_raw)
    e.revoke()
    e.advance(3 * 3600)
    eng = _engine(e, tmp_path)
    for i, text in enumerate(TURNS[:3]):
        r = eng.handle(e.tenant, "sms", harness.CALLER, text, "SMthread2", MON_9 + timedelta(minutes=i))
    assert r.outcome == "message" and e.created() == []
    assert [a["kind"] for _, a in e.alerts] == ["calendar_reconnect"]


def test_google_reads_only_busy_time_fields_and_one_scope(tmp_path, demo_raw):
    """OAuth verification (2026-10-25): least data. events.list asks Google only for status / transparency / start / end /
    our private tag, never titles, descriptions, attendees or locations; the consent asks for calendar.events only."""
    from app.calendar.oauth import ENDPOINTS
    assert ENDPOINTS["google"].scopes == ("https://www.googleapis.com/auth/calendar.events",)
    e = make_env("google", tmp_path, demo_raw)
    assert e.hub.availability(e.tid, e.cfg, MON_9)
    lists = [r for r in e.up.requests if r.method == "GET" and r.url.path.endswith("/events")]
    assert lists, "events.list was called"
    for r in lists:
        fields = r.url.params.get("fields", "")
        assert fields == "nextPageToken,items(status,transparency,start,end,extendedProperties/private)"
        for never in ("summary", "description", "attendees", "location", "creator", "organizer", "htmlLink"):
            assert never not in fields
