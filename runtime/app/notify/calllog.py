"""Structured call / SMS logging with cost tracking (SPEC 6.7, task B6).

Wired: B3/B4 call these through `app._stubs_b56.record_call` / `record_sms` (real bodies in
`app.hooks_b56`); the notifier records owner-alert SMS itself (tracked separately from client usage).
- `record_call` writes (or updates, keyed by call_sid) one `calls` row: transcript, outcome,
  summary, duration and `cost_usd` = Claude cost + estimated Twilio voice cost.
- `record_sms` writes one `sms_messages` row per message (keyed by twilio_sid).
- Both emit one JSON log line for Railway with NO personal data (no numbers, names, text):
  tenant slug, a short hash of the sid, outcome, counts, cost and turn latency p50/p95.
Twilio rates are estimates for the monthly cost report, overridable by env
(TWILIO_VOICE_USD_PER_MIN, TWILIO_SMS_USD_PER_SEGMENT).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from ..store import StateStore, Store
from ..tenants import TenantRecord

log = logging.getLogger("rt.calllog")

DEFAULT_VOICE_PER_MIN = 0.0085 + 0.004  # inbound local minute + speech recognition, rough
DEFAULT_SMS_PER_SEGMENT = 0.0083 + 0.003  # outbound segment + typical carrier fee


def rates(env: dict[str, str] | None = None) -> dict[str, float]:
    env = dict(os.environ if env is None else env)
    return {"voice_per_min": float(env.get("TWILIO_VOICE_USD_PER_MIN") or DEFAULT_VOICE_PER_MIN),
            "sms_per_segment": float(env.get("TWILIO_SMS_USD_PER_SEGMENT") or DEFAULT_SMS_PER_SEGMENT)}


def short(sid: str) -> str:
    return hashlib.sha256((sid or "").encode()).hexdigest()[:10]


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * pct / 100
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)


def log_line(kind: str, **fields: Any) -> str:
    line = json.dumps({"log": kind, **fields}, separators=(",", ":"), sort_keys=True, default=str)
    log.info(line)
    return line


def twilio_cost_key(tenant_id: str, day: str) -> str:
    return f"cost:twilio:{tenant_id}:{day}"


def local_day(tenant: TenantRecord, when: datetime | None = None) -> str:
    """The tenant's calendar day (so admin_daily's "yesterday" includes that evening's calls)."""
    return (when or datetime.now(timezone.utc)).astimezone(ZoneInfo(tenant.config.business.timezone)).date().isoformat()


def _add_cost(state: StateStore | None, tenant: TenantRecord, usd: float, when: datetime | None = None) -> None:
    if state is not None and usd:
        state.incr(twilio_cost_key(tenant.id, local_day(tenant, when)), usd, tenant.id)


def record_call(store: Store, tenant: TenantRecord, *, call_sid: str, from_e164: str, started_at: datetime,
                duration_s: int, outcome: str, transcript: list[dict[str, str]], summary: str = "",
                claude_cost_usd: float = 0.0, claude_calls: int = 0, turn_ms: list[float] | None = None,
                guard_rules: list[str] | None = None, env: dict[str, str] | None = None,
                state: StateStore | None = None) -> dict[str, Any]:
    ts = store.for_tenant(tenant.id)
    minutes = max(1, -(-int(duration_s) // 60)) if duration_s else 0  # Twilio bills whole minutes
    twilio_usd = round(minutes * rates(env)["voice_per_min"], 4)
    cost = round(claude_cost_usd + twilio_usd, 4)
    row = {"call_sid": call_sid, "from_e164": from_e164, "started_at": started_at.astimezone(timezone.utc).isoformat(),
           "duration_s": int(duration_s), "outcome": outcome, "transcript": transcript, "summary": summary[:500],
           "cost_usd": cost}
    existing = ts.select("calls", call_sid=call_sid)
    saved = ts.update("calls", existing[0]["id"], row) if existing else ts.insert("calls", row)
    # Twilio minutes count once per call, whether the row was inserted here or earlier (B3 inserts at start).
    if state is None or not state.get(f"cost:call:{tenant.id}:{call_sid}"):
        _add_cost(state, tenant, twilio_usd, started_at)
        if state is not None:
            state.put(f"cost:call:{tenant.id}:{call_sid}", True, tenant.id)
    turn_ms = turn_ms or []
    log_line("call", tenant=tenant.slug, call=short(call_sid), outcome=outcome, duration_s=int(duration_s),
             turns=sum(1 for t in transcript if t.get("who") == "customer"), claude_calls=claude_calls,
             claude_usd=round(claude_cost_usd, 4), twilio_usd=twilio_usd,
             p50_turn_ms=percentile(turn_ms, 50), p95_turn_ms=percentile(turn_ms, 95),
             guard=sorted(set(guard_rules or [])))
    return saved or row


def record_sms(store: Store, tenant: TenantRecord, *, twilio_sid: str, contact_e164: str, direction: str,
               body: str, segments: int = 1, claude_cost_usd: float = 0.0, guard_rules: list[str] | None = None,
               env: dict[str, str] | None = None, state: StateStore | None = None) -> dict[str, Any]:
    """`sms_messages` has no cost column (A1 schema): the Twilio estimate goes to runtime_state."""
    ts = store.for_tenant(tenant.id)
    twilio_usd = round(max(segments, 0) * rates(env)["sms_per_segment"], 4) if direction == "outbound" else 0.0
    existing = ts.select("sms_messages", twilio_sid=twilio_sid) if twilio_sid else []
    row = {"contact_e164": contact_e164, "direction": direction, "body": body, "twilio_sid": twilio_sid,
           "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    saved = existing[0] if existing else ts.insert("sms_messages", row)
    if not existing:
        _add_cost(state, tenant, twilio_usd)
        log_line("sms", tenant=tenant.slug, msg=short(twilio_sid), direction=direction, segments=segments,
                 claude_usd=round(claude_cost_usd, 4), twilio_usd=twilio_usd, guard=sorted(set(guard_rules or [])))
    return saved
