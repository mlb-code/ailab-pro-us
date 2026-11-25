"""Usage metering per tenant against what the client's package includes (RCP quote clients and FirstRing plans).

Counts voice minutes and SMS segments per tenant per period. At 80% and 100% of the included amount it emits one alert
each (event + owner notice). It never bills: nobody is ever charged per minute. Past 100% the period is flagged
`needs_addon_approval`. Quote clients: the receptionist keeps answering (Meir offers an ADD-USAGE block). Plan clients:
calls go to message mode (app.message_mode) until the next period or an upgrade; the e-mail carries the upgrade link.

Period and allowance:
  - quote clients (no `config.plan`): calendar month in the tenant's time zone (`usage:<tenant>:<YYYY-MM>:<kind>`),
    allowance = price book `rules.included_usage` (voice minutes + SMS segments);
  - FirstRing plan clients (`config.plan`, app.plans): the subscription's current period
    (`usage:<tenant>:p<YYYY-MM-DD period start>:<kind>`), voice allowance = the plan's `included_usage.voice_minutes`,
    and while trialing the trial cap (`trial_minutes`). Plans include no SMS allowance, so SMS is counted but never
    alerted. `cap_reached` tells the voice route to use the short message flow (USAGE_CAP_MODE=message, default):
    trial minutes used up -> until the trial ends or the paid plan starts; plan minutes used up -> until the next billing
    period or an upgrade. Nobody is ever charged for extra minutes.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from . import plans as plans_mod
from .settings import REPO_DIR
from .store import StateStore
from .tenants import TenantRecord

THRESHOLDS = (80, 100)
KINDS = {"sms": "sms_segments", "voice": "voice_minutes"}


def included_usage() -> dict[str, float]:
    for path in (Path(__file__).resolve().parent / "pricebook.json", REPO_DIR / "config" / "pricebook.json"):
        try:
            rules = json.loads(path.read_text(encoding="utf-8")).get("rules") or {}
        except (OSError, ValueError):
            continue
        inc = rules.get("included_usage") or {}
        if inc.get("voice_minutes") and inc.get("sms_segments"):
            return {"voice_minutes": float(inc["voice_minutes"]), "sms_segments": float(inc["sms_segments"])}
    raise RuntimeError("pricebook.json rules.included_usage missing: run tools/sync_config.py")


class UsageMeter:
    def __init__(self, state: StateStore, included: dict[str, float] | None = None):
        self.state = state
        self.included = included or included_usage()

    @staticmethod
    def month(tenant: TenantRecord, now: datetime) -> str:
        return now.astimezone(ZoneInfo(tenant.config.business.timezone)).strftime("%Y-%m")

    def period(self, tenant: TenantRecord, now: datetime) -> str:
        """The metering period label: 'pYYYY-MM-DD' (plan period start) or the calendar month 'YYYY-MM'."""
        t = plans_mod.terms(tenant.config)
        return t.period if t and t.period else self.month(tenant, now)

    def key(self, tenant: TenantRecord, kind: str, now: datetime) -> str:
        return f"usage:{tenant.id}:{self.period(tenant, now)}:{KINDS[kind]}"

    def limit(self, tenant: TenantRecord, kind: str) -> float | None:
        """Included amount for this period; None = no allowance to alert on (plan SMS)."""
        t = plans_mod.terms(tenant.config)
        if t is None or t.included_minutes is None:  # quote client, or a plan the price book does not know yet
            return self.included[KINDS[kind]]
        return t.included_minutes if kind == "voice" else None

    def used(self, tenant: TenantRecord, kind: str, now: datetime) -> float:
        return float(self.state.get(self.key(tenant, kind, now), 0) or 0)

    def record(self, tenant: TenantRecord, kind: str, amount: float, now: datetime) -> list[dict[str, Any]]:
        """Add usage; return alert actions for thresholds crossed by this addition (each once a period)."""
        if amount <= 0:
            return []
        key = self.key(tenant, kind, now)
        before = float(self.state.get(key, 0) or 0)
        after = self.state.incr(key, amount, tenant.id)
        limit = self.limit(tenant, kind)
        if not limit:
            return []
        t = plans_mod.terms(tenant.config)
        period = self.period(tenant, now)
        actions = []
        for pct in THRESHOLDS:
            mark = limit * pct / 100
            flag = f"{key}:alerted:{pct}"
            if before < mark <= after and not self.state.get(flag):
                self.state.put(flag, True, tenant.id)
                a = {"type": "alert", "kind": f"usage_{pct}", "tenant": tenant.slug,
                     "summary": f"{KINDS[kind].replace('_', ' ')} at {pct}% of included ({after:g}/{limit:g})",
                     "usage_kind": KINDS[kind], "used": after, "included": limit, "period": period}
                if t is not None:
                    a.update(plan_code=t.code, trial=t.trialing, period_end=t.period_end)
                actions.append(a)
                if pct >= 100:
                    self.state.put(f"usage:{tenant.id}:{period}:needs_addon_approval", True, tenant.id)
        return actions

    def needs_addon_approval(self, tenant: TenantRecord, now: datetime) -> bool:
        return bool(self.state.get(f"usage:{tenant.id}:{self.period(tenant, now)}:needs_addon_approval"))

    def trial_cap_reached(self, tenant: TenantRecord, now: datetime) -> bool:
        t = plans_mod.terms(tenant.config)
        if t is None or not t.trialing or not t.included_minutes:
            return False
        return self.used(tenant, "voice", now) >= t.included_minutes

    def cap_reached(self, tenant: TenantRecord, now: datetime) -> str:
        """'trial_minutes_used' | 'plan_minutes_used' | '' (plan clients only; this period's counter, so the next
        billing period or a bigger plan ends it)."""
        t = plans_mod.terms(tenant.config)
        if t is None or not t.known or not t.included_minutes:
            return ""
        if self.used(tenant, "voice", now) < t.included_minutes:
            return ""
        return "trial_minutes_used" if t.trialing else "plan_minutes_used"
