"""Tenant config (SPEC 6.6): pydantic model, JSON schema, readable validation errors.

`tenant_schema.json` is generated from `TenantConfig` so the two never drift:
    python -m app.tenants --write-schema      # regenerate
    python -m app.tenants --check-schema      # exit 1 on drift (also covered by tests)

Validation happens twice on purpose: the JSON schema (used by the admin JSON editor in B7)
and the pydantic model (used by the runtime, adds cross-field checks such as open < close).
"""
from __future__ import annotations

import json
import sys
from datetime import time
from pathlib import Path
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import jsonschema
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

SCHEMA_PATH = Path(__file__).resolve().parent / "tenant_schema.json"

E164 = Annotated[str, Field(pattern=r"^\+[1-9]\d{7,14}$", description="Phone number in E.164, e.g. +17135550100")]
HHMM = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="24h time HH:MM")]
ZIP = Annotated[str, Field(pattern=r"^\d{5}$")]
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _check_span(span: list[str] | tuple[str, str] | None, where: str) -> None:
    if span is None:
        return
    if time.fromisoformat(span[0]) >= time.fromisoformat(span[1]):
        raise ValueError(f"{where}: opening time {span[0]} must be before closing time {span[1]}")


class Business(_Strict):
    name: str = Field(min_length=1, max_length=120)
    niche: Literal["home_services", "real_estate", "dental"]
    trade: str = Field(default="", max_length=60, description="e.g. 'HVAC', 'plumbing'; used in the prompt")
    timezone: str
    service_area_zips: list[ZIP] = Field(default_factory=list, max_length=500,
                                         description="Empty list = no ZIP restriction")
    main_phone: E164

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"unknown timezone {v!r} (use an IANA name like 'America/Chicago')") from None
        return v


class Voice(_Strict):
    tts_voice: str = "Polly.Joanna-Neural"
    greeting: str = Field(default="", max_length=400, description="Empty = generated from business name")
    languages: list[Literal["en", "es"]] = Field(default_factory=lambda: ["en"], min_length=1)

    @field_validator("languages")
    @classmethod
    def _english_first(cls, v: list[str]) -> list[str]:
        if "en" not in v:
            raise ValueError("'en' must always be enabled ('es' requires the ADD-ES add-on)")
        return v


class Hours(_Strict):
    mon: tuple[HHMM, HHMM] | None = None
    tue: tuple[HHMM, HHMM] | None = None
    wed: tuple[HHMM, HHMM] | None = None
    thu: tuple[HHMM, HHMM] | None = None
    fri: tuple[HHMM, HHMM] | None = None
    sat: tuple[HHMM, HHMM] | None = None
    sun: tuple[HHMM, HHMM] | None = None

    @model_validator(mode="after")
    def _spans(self) -> "Hours":
        for d in DAYS:
            _check_span(getattr(self, d), f"hours.{d}")
        return self


class AfterHours(_Strict):
    mode: Literal["book_next_day", "message_only", "emergency_dial"] = "book_next_day"


class Booking(_Strict):
    provider: Literal["google", "calendly", "fake"] = Field(
        default="calendly", description="Calendly is the default integration (TASKS Addendum 2); Google second")
    calendar_id: str = "primary"
    windows: list[tuple[HHMM, HHMM]] = Field(min_length=1, max_length=8)
    lead_time_hours: float = Field(default=2, ge=0, le=168)
    max_per_window: int = Field(default=3, ge=1, le=50)
    days_ahead: int = Field(default=7, ge=1, le=30)
    job_types: list[str] = Field(min_length=1, max_length=30)
    booking_link: str | None = Field(default=None, description="Public self-booking link used in text-back")

    @model_validator(mode="after")
    def _windows(self) -> "Booking":
        for i, w in enumerate(self.windows):
            _check_span(w, f"booking.windows[{i}]")
        return self


class PriceItem(_Strict):
    name: str = Field(min_length=1, max_length=80)
    price_usd: float = Field(ge=0, le=100000)
    note: str = Field(default="", max_length=160)


class Pricing(_Strict):
    mode: Literal["none", "listed"] = "none"
    items: list[PriceItem] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def _listed_needs_items(self) -> "Pricing":
        if self.mode == "listed" and not self.items:
            raise ValueError("pricing.mode 'listed' needs at least one item in pricing.items")
        return self


class FaqItem(_Strict):
    q: str = Field(min_length=1, max_length=300)
    a: str = Field(min_length=1, max_length=600)


class Emergency(_Strict):
    keywords: list[str] = Field(default_factory=list, max_length=40)
    dial: E164 | None = None


class Handoff(_Strict):
    mode: Literal["dial", "message"] = "message"
    number: E164 | None = None
    hours: Literal["business", "always"] = "business"

    @model_validator(mode="after")
    def _dial_needs_number(self) -> "Handoff":
        if self.mode == "dial" and not self.number:
            raise ValueError("handoff.mode 'dial' needs handoff.number")
        return self


class Notify(_Strict):
    sms: list[E164] = Field(default_factory=list, max_length=5)
    email: list[Annotated[str, Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")]] = Field(default_factory=list, max_length=5)
    daily_summary: HHMM | None = "19:00"

    @model_validator(mode="after")
    def _someone(self) -> "Notify":
        if not self.sms and not self.email:
            raise ValueError("notify needs at least one SMS number or email to send lead alerts to")
        return self


class Zapier(_Strict):
    webhook_url: Annotated[str, Field(pattern=r"^https://")] | None = None
    events: list[Literal["lead.created", "booking.created", "call.completed"]] = Field(
        default_factory=lambda: ["lead.created", "booking.created"])


class Guard(_Strict):
    daily_budget_usd: float = Field(default=3, gt=0, le=100)
    blocklist: list[E164] = Field(default_factory=list, max_length=1000)
    max_replies_10min: int = Field(default=8, ge=1, le=100)
    max_replies_day: int = Field(default=30, ge=1, le=500)


class TenantConfig(_Strict):
    """`tenants.config` jsonb. Field names follow SPEC 6.6."""
    business: Business
    voice: Voice = Field(default_factory=Voice)
    hours: Hours
    after_hours: AfterHours = Field(default_factory=AfterHours)
    booking: Booking
    pricing: Pricing = Field(default_factory=Pricing)
    faq: list[FaqItem] = Field(default_factory=list, max_length=25)
    emergency: Emergency = Field(default_factory=Emergency)
    handoff: Handoff = Field(default_factory=Handoff)
    notify: Notify
    zapier: Zapier = Field(default_factory=Zapier)
    guard: Guard = Field(default_factory=Guard)
    paused: bool = False


class TenantRecord(BaseModel):
    """A `tenants` row as the runtime sees it (other row columns such as created_at are ignored)."""
    model_config = ConfigDict(extra="ignore", frozen=True)
    id: str
    slug: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")]
    status: Literal["sandbox", "live", "paused"] = "sandbox"
    twilio_number: E164 | None = None
    client_id: str | None = None
    config: TenantConfig

    @property
    def active(self) -> bool:
        return self.status != "paused" and not self.config.paused


class TenantConfigError(ValueError):
    """Invalid tenant config. `str(err)` is a readable, multi-line list of problems."""

    def __init__(self, problems: list[str], slug: str | None = None):
        self.problems = problems
        head = f"Invalid tenant config{f' for {slug!r}' if slug else ''} ({len(problems)} problem(s)):"
        super().__init__("\n".join([head, *[f"  - {p}" for p in problems]]))


def _loc(parts: Any) -> str:
    out = ""
    for p in parts:
        out += f"[{p}]" if isinstance(p, int) else (f".{p}" if out else str(p))
    return out or "(root)"


def json_schema() -> dict[str, Any]:
    schema = TenantConfig.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "https://ailab.pro/schemas/tenant-config.json"
    return schema


def _file_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_config(data: Any, slug: str | None = None) -> TenantConfig:
    """Validate against the JSON schema and the pydantic model; raise TenantConfigError."""
    problems: list[str] = []
    if not isinstance(data, dict):
        raise TenantConfigError(["config must be a JSON object"], slug)
    validator = jsonschema.Draft202012Validator(_file_schema())
    for err in sorted(validator.iter_errors(data), key=lambda e: list(map(str, e.absolute_path))):
        problems.append(f"{_loc(err.absolute_path)}: {err.message}")
    try:
        cfg = TenantConfig.model_validate(data)
    except ValidationError as exc:
        for e in exc.errors():
            msg = e["msg"].removeprefix("Value error, ")
            line = f"{_loc(e['loc'])}: {msg}"
            if line not in problems:
                problems.append(line)
        cfg = None
    if problems or cfg is None:
        raise TenantConfigError(problems, slug)
    return cfg


def load_record(data: dict[str, Any]) -> TenantRecord:
    """Build a TenantRecord from a stored row; config errors are reported readably."""
    slug = data.get("slug") if isinstance(data, dict) else None
    cfg = validate_config((data or {}).get("config"), slug)
    try:
        return TenantRecord.model_validate({**data, "config": cfg})
    except ValidationError as exc:
        raise TenantConfigError([f"{_loc(e['loc'])}: {e['msg']}" for e in exc.errors()], slug) from None


def load_file(path: str | Path) -> TenantRecord:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except ValueError as exc:
        raise TenantConfigError([f"{path}: not valid JSON ({exc})"]) from None
    return load_record(data)


def _main(argv: list[str]) -> int:
    if argv[:1] == ["--write-schema"]:
        SCHEMA_PATH.write_text(json.dumps(json_schema(), indent=2) + "\n", encoding="utf-8")
        print(f"wrote {SCHEMA_PATH}")
        return 0
    if argv[:1] == ["--check-schema"]:
        ok = _file_schema() == json_schema()
        print("tenant_schema.json is up to date" if ok else "tenant_schema.json drifted: run --write-schema")
        return 0 if ok else 1
    print("usage: python -m app.tenants --write-schema | --check-schema")
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
