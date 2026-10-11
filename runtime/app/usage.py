"""Monthly usage metering per tenant against the price book's included usage (RCP).

Counts voice minutes and SMS segments per tenant per calendar month (tenant timezone).
At 80% and 100% of the included amount it emits one alert each (event + owner notice).
It never blocks and never bills: past 100% the receptionist keeps answering and the month is
flagged `needs_addon_approval` for Meir to decide on an ADD-USAGE block or overage.
Included amounts come from `pricebook.json` (rules.included_usage), synced next to the app.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

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

    def key(self, tenant: TenantRecord, kind: str, now: datetime) -> str:
        return f"usage:{tenant.id}:{self.month(tenant, now)}:{KINDS[kind]}"

    def used(self, tenant: TenantRecord, kind: str, now: datetime) -> float:
        return float(self.state.get(self.key(tenant, kind, now), 0) or 0)

    def record(self, tenant: TenantRecord, kind: str, amount: float, now: datetime) -> list[dict[str, Any]]:
        """Add usage; return alert actions for thresholds crossed by this addition (each once a month)."""
        if amount <= 0:
            return []
        key = self.key(tenant, kind, now)
        before = float(self.state.get(key, 0) or 0)
        after = self.state.incr(key, amount, tenant.id)
        limit = self.included[KINDS[kind]]
        actions = []
        for pct in THRESHOLDS:
            mark = limit * pct / 100
            flag = f"{key}:alerted:{pct}"
            if before < mark <= after and not self.state.get(flag):
                self.state.put(flag, True, tenant.id)
                actions.append({"type": "alert", "kind": f"usage_{pct}", "tenant": tenant.slug,
                                "summary": f"{KINDS[kind].replace('_', ' ')} at {pct}% of included ({after:g}/{limit:g})",
                                "usage_kind": KINDS[kind], "used": after, "included": limit})
                if pct >= 100:
                    self.state.put(f"usage:{tenant.id}:{self.month(tenant, now)}:needs_addon_approval", True, tenant.id)
        return actions

    def needs_addon_approval(self, tenant: TenantRecord, now: datetime) -> bool:
        return bool(self.state.get(f"usage:{tenant.id}:{self.month(tenant, now)}:needs_addon_approval"))
