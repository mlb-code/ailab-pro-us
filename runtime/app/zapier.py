"""Outgoing Zapier webhook (one per tenant, RCP includes 1). Task B6; payloads in docs/zapier-payloads.md.

- Events: `lead.created`, `booking.created`, `call.completed` (tenant chooses in `zapier.events`),
  plus `test.ping` from the admin/portal "send test" button.
- Body: JSON {id, event, created_at, tenant: {slug, business}, data}.
- Signature: `X-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Timestamp>.<raw body>")>`. The secret
  is per tenant, derived from ZAPIER_SIGNING_SECRET (env) and the tenant id, so one tenant's secret
  can't sign for another. `tenant_secret()` shows it to the admin for the receiving side.
- Exactly once: idempotency key (call_sid / message_sid / convo id) per event, remembered in
  `runtime_state`; the same key is sent as `X-Idempotency-Key` and as the payload `id`.
- Delivery: `attempt()` makes one POST (5 s timeout). Call flows never call it directly: the
  persistent background queue (`app.notify.queue`) runs 1 try + 3 retries (2 s, 8 s, 30 s) on network
  errors, 408, 429 and 5xx. Other 4xx are final. After the last failure the payload goes to `events`
  as `zapier.dead_letter`. `emit()` (blocking, in-line retries) is only for admin/test paths.
- URL safety: https only (schema), and no localhost / private / link-local IP literals.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from .store import StateStore, Store
from .tenants import TenantRecord

log = logging.getLogger("rt.zapier")

EVENTS = ("lead.created", "booking.created", "call.completed")
TEST_EVENT = "test.ping"
RETRIES = 3
BACKOFF_S = (2.0, 8.0, 30.0)
SIM_SIGNING_SECRET = "sim-zapier-signing-secret-not-a-secret"


def signing_secret(settings: Any, env: dict[str, str] | None = None) -> str:
    env = dict(os.environ if env is None else env)
    return env.get("ZAPIER_SIGNING_SECRET") or (SIM_SIGNING_SECRET if getattr(settings, "is_sim", False) else "")


def tenant_secret(master: str, tenant_id: str) -> str:
    return hmac.new(master.encode(), f"zapier:{tenant_id}".encode(), hashlib.sha256).hexdigest()


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify(secret: str, timestamp: str, body: bytes, signature: str, now: float | None = None,
           tolerance_s: int = 300) -> bool:
    """For receivers (and tests): constant-time compare + replay window."""
    try:
        fresh = abs((now or time.time()) - int(timestamp)) <= tolerance_s
    except ValueError:
        return False
    return fresh and hmac.compare_digest(sign(secret, timestamp, body), signature)


def url_allowed(url: str) -> bool:
    parsed = urlparse(url or "")
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".internal"):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True
    return ip.is_global


class ZapierClient:
    def __init__(self, store: Store, state: StateStore, master_secret: str, http: httpx.Client | None = None,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time):
        self.store = store
        self.state = state
        self.master = master_secret
        self.http = http or httpx.Client(timeout=5.0)
        self.sleep = sleep
        self.clock = clock

    def wants(self, tenant: TenantRecord, event: str) -> bool:
        z = tenant.config.zapier
        return bool(z.webhook_url) and (event == TEST_EVENT or event in z.events)

    def payload(self, tenant: TenantRecord, event: str, idem: str, data: dict[str, Any]) -> dict[str, Any]:
        return {"id": f"{event}:{idem}", "event": event,
                "created_at": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(timespec="seconds"),
                "tenant": {"slug": tenant.slug, "business": tenant.config.business.name}, "data": data}

    def emit(self, tenant: TenantRecord, event: str, idem: str, data: dict[str, Any]) -> dict[str, Any]:
        """Blocking send with in-line retries. Only for admin/test paths and tests: call flows go through
        the delivery queue (`app.notify.queue`), which calls `attempt()` once per try, in the background."""
        for n in range(RETRIES + 1):
            res = self.attempt(tenant, event, idem, data, n)
            if res["status"] != "retry":
                return res
            self.sleep(res["delay"])
        return res  # pragma: no cover - attempt() dead-letters on the last try

    def attempt(self, tenant: TenantRecord, event: str, idem: str, data: dict[str, Any],
                attempt_no: int = 0) -> dict[str, Any]:
        """One POST. Returns status sent|duplicate|skipped|dead_letter, or retry with `delay` (seconds)."""
        if not self.wants(tenant, event):
            return {"status": "skipped", "reason": "not_subscribed"}
        url = tenant.config.zapier.webhook_url or ""
        ts = self.store.for_tenant(tenant.id)
        if not self.master:
            ts.log_event("zapier.dead_letter", {"event": event, "reason": "signing_secret_missing"})
            return {"status": "dead_letter", "reason": "signing_secret_missing"}
        if not url_allowed(url):
            ts.log_event("zapier.dead_letter", {"event": event, "reason": "url_not_allowed"})
            return {"status": "dead_letter", "reason": "url_not_allowed"}
        key = f"zap:{tenant.id}:{event}:{idem}"
        if event != TEST_EVENT and self.state.get(key):
            return {"status": "duplicate"}
        payload = self.payload(tenant, event, idem, data)
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        stamp = str(int(self.clock()))
        headers = {"Content-Type": "application/json", "X-Event": event, "X-Timestamp": stamp,
                   "X-Idempotency-Key": payload["id"], "X-Signature": sign(tenant_secret(self.master, tenant.id), stamp, body),
                   "User-Agent": "receptionist-webhooks/1"}
        retryable = True
        try:
            resp = self.http.post(url, content=body, headers=headers)
            last = str(resp.status_code)
            if resp.status_code < 300:
                if event != TEST_EVENT:
                    self.state.put(key, True, tenant.id)
                ts.log_event("zapier.sent", {"event": event, "attempts": attempt_no + 1, "status": resp.status_code})
                return {"status": "sent", "attempts": attempt_no + 1}
            retryable = resp.status_code >= 500 or resp.status_code in (408, 429)
        except httpx.HTTPError as exc:
            last = type(exc).__name__
        if retryable and attempt_no < RETRIES:
            return {"status": "retry", "reason": last, "delay": BACKOFF_S[min(attempt_no, len(BACKOFF_S) - 1)]}
        log.warning("zapier %s dead-lettered for tenant %s (%s)", event, tenant.slug, last)
        ts.log_event("zapier.dead_letter", {"event": event, "reason": last, "payload": payload})
        if event != TEST_EVENT:
            self.state.put(key, "dead_letter", tenant.id)
        return {"status": "dead_letter", "reason": last}
