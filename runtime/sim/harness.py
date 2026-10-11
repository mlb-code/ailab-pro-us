"""In-process simulator environment, shared by the CLI and the tests."""
from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from fastapi.testclient import TestClient

from app import settings as settings_mod
from app.main import create_app
from app.store import JsonStore
from app.tenants import TenantRecord, load_file

from .fake_calendar import FakeCalendar
from .fake_twilio import FakeTwilio, FakeTwilioClient

SIM_DIR = Path(__file__).resolve().parent
TENANTS_DIR = SIM_DIR / "tenants"
CALLER = "+17135550123"


def sim_settings(data_dir: Path, **env: str) -> settings_mod.Settings:
    return settings_mod.load({"RUNTIME_MODE": "sim", "STORE_BACKEND": "json", "DATA_DIR": str(data_dir), **env})


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

    def tenant(self, slug: str) -> TenantRecord:
        rec = self.store.tenant_by_slug(slug)
        if rec is None:
            raise KeyError(f"no tenant {slug!r}; known: {[t.slug for t in self.tenants]}")
        return rec


def build(data_dir: Path | None = None, **env: str) -> Sim:
    data_dir = Path(data_dir or tempfile.mkdtemp(prefix="ailab-sim-"))
    settings = sim_settings(data_dir, **env)
    store = JsonStore(data_dir)
    tenants = seed_tenants(store)
    app = create_app(settings, store)
    client = TestClient(app)
    return Sim(data_dir=data_dir, settings=settings, store=store, client=client,
               twilio=FakeTwilio(client, settings.twilio_auth_token), tenants=tenants)
