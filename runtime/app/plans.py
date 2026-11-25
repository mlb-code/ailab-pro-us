"""FirstRing monthly plans (owner decision 2026-11-25): what each plan includes, read from the price book.

The price book (`config/pricebook.json`, synced to `app/pricebook.json`) lists `plans` = [{code, name, monthly_cents,
included_usage.voice_minutes, features[], trial_days, trial_minutes, go_live_business_days, upgrade_to}]. Nothing here
types a price or a minute count: every number comes from that file.

A subscription tenant carries `config.plan` (written by the database from `public.subscriptions`, never by the client):
the plan code, the subscription status, the current period and the service mode. This module turns that block into the
terms the runtime enforces:
  - included voice minutes for the period (the trial cap while `status == "trialing"`),
  - the features the plan switches on or off (`apply`): Spanish, website chat, on-call dispatch, CRM links,
  - the message-only service mode (trial ended, cancelled, past due beyond the grace period, paused) and, when
    USAGE_CAP_MODE is `message` (default), once the trial minutes or the plan's included minutes are used up (until the
    trial ends / the paid plan starts, or until the next billing period / an upgrade).
A tenant without `config.plan` (the old quote / deposit clients) is untouched: same included usage as before
(`rules.included_usage`), same features as its config says.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .settings import REPO_DIR

# Feature keys in the price book's plans[].features (labels in pricebook plan_features).
SPANISH, WEB_CHAT, DISPATCH, SECOND_LINE, CRM_LINK = "spanish", "web_chat", "dispatch", "second_line", "crm_link"

_PATHS = (Path(__file__).resolve().parent / "pricebook.json", REPO_DIR / "config" / "pricebook.json")
_cache: dict[str, Any] = {"key": None, "plans": {}, "subscription": {}}
_override: dict[str, Any] | None = None  # tests: set_catalog()


def set_catalog(plans: list[dict[str, Any]] | None, subscription: dict[str, Any] | None = None) -> None:
    """Tests / fixtures: use this plan list instead of the price book (None = back to the price book)."""
    global _override
    _override = None if plans is None else {"plans": {p["code"]: p for p in plans}, "subscription": subscription or {}}


def _load() -> dict[str, Any]:
    if _override is not None:
        return _override
    key = []
    for p in _PATHS:
        try:
            key.append(p.stat().st_mtime_ns)
        except OSError:
            key.append(None)
    if _cache["key"] == key:
        return _cache
    plans: dict[str, Any] = {}
    sub: dict[str, Any] = {}
    for p in _PATHS:  # the synced copy first; the config file when the copy has no plans yet
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("plans"):
            plans = {x["code"]: x for x in data["plans"] if isinstance(x, dict) and x.get("code")}
            sub = (data.get("rules") or {}).get("subscription") or {}
            break
    _cache.update(key=key, plans=plans, subscription=sub)
    return _cache


def catalog() -> dict[str, dict[str, Any]]:
    return dict(_load()["plans"])


def plan(code: str | None) -> dict[str, Any] | None:
    return _load()["plans"].get(code or "")


def features(code: str | None) -> set[str]:
    p = plan(code)
    return set(p.get("features") or []) if p else set()


def usage_cap_mode(env: dict[str, str] | None = None) -> str:
    """USAGE_CAP_MODE (old name TRIAL_CAP_MODE): 'message' (default, owner decision 2026-11-25 + legal text): once the
    trial's minutes or the plan's included minutes are used up, calls get the short message flow (name, number, reason,
    e-mailed to the owner) until the trial ends / the paid plan starts, or until the next billing period / an upgrade.
    'keep' = keep full answering past 100% (alerts only)."""
    e = os.environ if env is None else env
    v = (e.get("USAGE_CAP_MODE") or e.get("TRIAL_CAP_MODE") or "message").strip().lower()
    return "keep" if v == "keep" else "message"


trial_cap_mode = usage_cap_mode  # backwards-compatible name


@dataclass(frozen=True)
class Terms:
    code: str
    known: bool                 # the code is in the price book
    status: str
    trialing: bool
    included_minutes: float | None   # this period's allowance (trial cap while trialing); None = unknown plan
    features: frozenset[str]
    period: str | None          # usage period label "pYYYY-MM-DD" (None = calendar month)
    period_end: str | None
    service: str                # "full" | "message_only"
    reason: str                 # why message_only ("" when full)
    name: str = ""
    upgrade_to: str | None = None


def terms(cfg: Any) -> Terms | None:
    """The plan terms of a TenantConfig (None = not a subscription tenant)."""
    p = getattr(cfg, "plan", None)
    if p is None:
        return None
    row = plan(p.code)
    trialing = p.status == "trialing"
    sub = _load()["subscription"]
    if row is None:
        inc = None
    elif trialing:
        inc = float(row.get("trial_minutes") or sub.get("trial_minutes") or 0) or None
    else:
        inc = float((row.get("included_usage") or {}).get("voice_minutes") or 0) or None
    period = f"p{p.period_start}" if p.period_start else None  # 'pYYYY-MM-DD' or 'pYYYY-MM-DDTHHMM' (database)
    return Terms(code=p.code, known=row is not None, status=p.status, trialing=trialing, included_minutes=inc,
                 features=frozenset(row.get("features") or []) if row else frozenset(),
                 period=period, period_end=p.period_end, service=p.service, reason=p.service_reason,
                 name=str((row or {}).get("name") or p.code), upgrade_to=(row or {}).get("upgrade_to"))


def apply(cfg: Any) -> Any:
    """Switch the plan's features on/off in a TenantConfig (returns a new frozen config). Unknown plan code or no
    plan: unchanged (fail open: a price book that is not synced yet must never silence a line)."""
    t = terms(cfg)
    if t is None or not t.known:
        return cfg
    f = t.features
    upd: dict[str, Any] = {}
    langs = spanish_languages(f, cfg.voice.spanish_off)
    if list(cfg.voice.languages) != langs:
        upd["voice"] = cfg.voice.model_copy(update={"languages": langs})
    chat = WEB_CHAT in f
    if cfg.webchat.enabled != chat:
        upd["webchat"] = cfg.webchat.model_copy(update={"enabled": chat})
    disp = DISPATCH in f and cfg.business.niche == "home_services" and bool(cfg.dispatch.contacts)
    if cfg.dispatch.enabled != disp:
        upd["dispatch"] = cfg.dispatch.model_copy(update={"enabled": disp})
    if CRM_LINK not in f:
        crm = cfg.crm
        if crm.hubspot.enabled or crm.jobber.enabled:
            upd["crm"] = crm.model_copy(update={"hubspot": crm.hubspot.model_copy(update={"enabled": False}),
                                                "jobber": crm.jobber.model_copy(update={"enabled": False})})
        fub = cfg.real_estate.follow_up_boss
        if fub.enabled:
            upd["real_estate"] = cfg.real_estate.model_copy(
                update={"follow_up_boss": fub.model_copy(update={"enabled": False})})
    return cfg.model_copy(update=upd) if upd else cfg


def spanish_languages(plan_features: Any, spanish_off: bool) -> list[str]:
    """voice.languages for a plan tenant: Spanish comes with plans whose features include `spanish` (Pro, Business),
    unless the customer switched it off in the portal (voice.spanish_off, remembered across plan changes). Downgrade to a
    plan without it -> English only; upgrade -> Spanish back on unless the customer had switched it off. Mirrored by the
    database trigger private.tenant_plan_spanish (supabase/migrations/*_us_firstring_p2.sql)."""
    return ["en", "es"] if SPANISH in set(plan_features or ()) and not spanish_off else ["en"]


def upgrade_target(code: str | None) -> dict[str, Any] | None:
    p = plan(code)
    return plan(p.get("upgrade_to")) if p and p.get("upgrade_to") else None
