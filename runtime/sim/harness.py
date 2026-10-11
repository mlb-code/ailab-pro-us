"""In-process simulator environment, shared by the CLI and the tests."""
from __future__ import annotations

import tempfile
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app import settings as settings_mod
from app._stubs_b56 import TenantCalendars
from app.main import create_app
from app.store import JsonStore
from app.tenants import TenantConfigError, TenantRecord, load_file

from .fake_calendar import FakeCalendar
from .fake_call import FakeCall
from .fake_twilio import FakeTwilio, FakeTwilioClient

SIM_DIR = Path(__file__).resolve().parent
TENANTS_DIR = SIM_DIR / "tenants"
CALLER = "+17135550123"


# Simulator voice timing: 1 s of silence counts as a silent turn; speaking time is not simulated.
SIM_VOICE_ENV = {"VOICE_SILENCE_SECONDS": "1.0", "VOICE_TTS_WPS": "1000", "VOICE_RELAY_GRACE_SECONDS": "1.0"}


def sim_settings(data_dir: Path, **env: str) -> settings_mod.Settings:
    return settings_mod.load({"RUNTIME_MODE": "sim", "STORE_BACKEND": "json", "DATA_DIR": str(data_dir),
                              **SIM_VOICE_ENV, **env})


class FakeClock:
    """The runtime's clock in the simulator: starts at `start`, moves only when told to."""

    def __init__(self, start: datetime | None = None):
        self.t = start or datetime.now(timezone.utc)
        self._lock = threading.Lock()

    def __call__(self) -> datetime:
        with self._lock:
            return self.t

    def advance(self, seconds: float = 0, minutes: float = 0) -> datetime:
        with self._lock:
            self.t += timedelta(seconds=seconds, minutes=minutes)
            return self.t


def seed_tenants(store: JsonStore, directory: Path = TENANTS_DIR) -> list[TenantRecord]:
    return [store.upsert_tenant(load_file(p)) for p in sorted(directory.glob("*.json"))]


@dataclass
class Sim:
    data_dir: Path
    settings: settings_mod.Settings
    store: JsonStore
    client: TestClient
    twilio: FakeTwilio
    calendar: FakeCalendar = field(default_factory=FakeCalendar)
    twilio_client: FakeTwilioClient = field(default_factory=FakeTwilioClient)
    tenants: list[TenantRecord] = field(default_factory=list)
    clock: Any = None
    app: Any = None

    @property
    def rt(self):
        return self.app.state.rt

    def tick(self):
        """POST /jobs/tick (the single cron endpoint) with the simulator's admin token."""
        from app.notify.routes import SIM_ADMIN_TOKEN
        return self.client.post("/jobs/tick", headers={"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"})

    def settled(self, slug: str = "demo-hvac"):
        """call_sid -> whether the runtime has finished the call (used by FakeCall.hangup)."""
        def check(call_sid: str) -> bool:
            try:
                tenant = self.tenant(slug)
            except TenantConfigError:  # safe mode: no relay session to wait for
                return True
            c = self.rt.engine.find_convo(tenant, "voice", call_sid)
            return c is None or bool(c.meta.get("finalized") or c.meta.get("relay_lost") or c.ended)
        return check

    def call(self, slug: str = "demo-hvac", caller: str = CALLER, **kw) -> FakeCall:
        number = self.store.select("tenants", slug=slug)[0]["twilio_number"]  # works for an invalid config too
        return FakeCall(self.twilio, number, caller, clock=self.clock,
                        settled=self.settled(slug), **kw)

    def tenant(self, slug: str) -> TenantRecord:
        rec = self.store.tenant_by_slug(slug)
        if rec is None:
            raise KeyError(f"no tenant {slug!r}; known: {[t.slug for t in self.tenants]}")
        return rec


def build(data_dir: Path | None = None, *, clock: Any = None, llm: Any = None, calendar: FakeCalendar | None = None,
          twilio_client: FakeTwilioClient | None = None, seed: bool = True, **env: str) -> Sim:
    """In-process runtime + fakes. Pass the same data_dir/calendar/twilio_client again to "restart"."""
    data_dir = Path(data_dir or tempfile.mkdtemp(prefix="ailab-sim-"))
    settings = sim_settings(data_dir, **env)
    store = JsonStore(data_dir)
    tenants = seed_tenants(store) if seed else []
    calendar = calendar or FakeCalendar()
    twilio_client = twilio_client or FakeTwilioClient()
    app = create_app(settings, store, llm=llm, calendar=TenantCalendars(settings, resolve=lambda *_: calendar),
                     twilio_client=twilio_client, clock=clock)
    app.state.rt.alert_log = []  # what the runtime handed to the notifier (B6), for assertions
    client = TestClient(app)
    return Sim(data_dir=data_dir, settings=settings, store=store, client=client,
               twilio=FakeTwilio(client, settings.twilio_auth_token), calendar=calendar,
               twilio_client=twilio_client, tenants=tenants, clock=clock, app=app)
