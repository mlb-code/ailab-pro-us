"""ADD-CRM: direct CRM links. Shared contract for every CRM client (HubSpot, Jobber; GHL / Housecall Pro later).

- Credentials (one access token per tenant + provider) are stored encrypted exactly like calendar tokens:
  `app.crypto.encrypt(cred_key, json, tenant_id, provider)` -> `store.put_credential`. Plaintext never leaves
  `CredentialBox` and is never logged or echoed by an endpoint.
- `CrmClient.sync(tenant, event, lead, idem=..., attempt=...)` returns a status dict:
      {"status": "sent",    ...ids}                      synced (contact upserted + note / request / deal)
      {"status": "skipped", "reason": "duplicate"}      the same (event, idem) was synced before
      {"status": "retry",   "delay": seconds}           429 / 5xx / network: the delivery queue retries
      {"status": "failed",  "reason": "auth" | ...}     401/403 (an `events` row `crm.auth_failed`) or other 4xx
      {"status": "dead",    "reason": "not_connected"}  no credential stored
- Lead shape (built from the stored conversation by `build_lead`):
      {name, phone, email?, address, job_type, urgency, summary, channel, convo_id,
       booking: {start, end, label}?, qualification: {...}?}
- Exactly once: `crm:<tenant>:<provider>:<event>:<idem>` in `runtime_state`.
- Logs carry only tenant slug, provider and status: never a phone number, e-mail or token.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Protocol

import httpx

from .. import crypto
from ..store import StateStore, Store

log = logging.getLogger("rt.crm")

PROVIDERS = ("hubspot", "jobber")  # + "follow_up_boss" (real estate, configured under real_estate.follow_up_boss)
ALL_PROVIDERS = PROVIDERS + ("follow_up_boss",)
EVENTS = ("lead.created", "booking.created")
BACKOFF_S = (2.0, 8.0, 30.0)  # same schedule as Zapier / the delivery queue
TIMEOUT_S = 10.0


class CrmError(RuntimeError):
    pass


class CredentialBox:
    """Encrypted token storage per (tenant, provider). `delete` stores an empty ciphertext (the store has
    no delete RPC); an empty or undecryptable record reads as "not connected"."""

    def __init__(self, store: Store, cred_key: str):
        self.store = store
        self.cred_key = cred_key

    def save(self, tenant_id: str, provider: str, token: str, meta: dict[str, Any] | None = None) -> None:
        token = (token or "").strip()
        if not token:
            raise CrmError("empty token")
        record = {"access_token": token, "meta": dict(meta or {})}
        cipher = crypto.encrypt(self.cred_key, json.dumps(record), tenant_id, provider)
        self.store.put_credential(tenant_id, provider, cipher, None)

    def load(self, tenant_id: str, provider: str) -> dict[str, Any] | None:
        cipher = self.store.get_credential(tenant_id, provider)
        if not cipher:
            return None
        try:
            rec = json.loads(crypto.decrypt(self.cred_key, cipher, tenant_id, provider))
        except (crypto.CryptoError, ValueError):
            log.warning("crm credential for provider %s cannot be decrypted", provider)
            return None
        return rec if isinstance(rec, dict) and rec.get("access_token") else None

    def token(self, tenant_id: str, provider: str) -> str | None:
        rec = self.load(tenant_id, provider)
        return str(rec["access_token"]) if rec else None

    def connected(self, tenant_id: str, provider: str) -> bool:
        return self.load(tenant_id, provider) is not None

    def delete(self, tenant_id: str, provider: str) -> None:
        self.store.put_credential(tenant_id, provider, "", None)


class CrmClient(Protocol):
    provider: str

    def connected(self, tenant_id: str) -> bool: ...

    def sync(self, tenant: Any, event: str, lead: dict[str, Any], idem: str | None = None,
             attempt: int = 0) -> dict[str, Any]: ...

    def check(self, tenant: Any) -> dict[str, Any]: ...


# --- lead -------------------------------------------------------------------------------------------------------
def _booking_label(start: str, end: str) -> str:
    try:
        from ..calendar.base import label
        return label(datetime.fromisoformat(start), datetime.fromisoformat(end))
    except (ValueError, TypeError):
        return f"{start} to {end}"


def build_lead(state: StateStore | None, tenant: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """The lead for a CRM from the `emit` payload + the stored conversation (`convo:<tenant>:<channel>:<id>`).
    The payload alone is enough for a minimal record (contact, channel, outcome); the conversation adds name,
    address, job type, summary, booking window and real-estate screening answers (meta["lead"])."""
    payload = dict(payload or {})
    channel = str(payload.get("channel") or "")
    convo_id = str(payload.get("convo_id") or "")
    raw: dict[str, Any] = {}
    if state is not None and channel and convo_id:
        try:
            raw = dict(state.get(f"convo:{tenant.id}:{channel}:{convo_id}") or {})
        except Exception:  # noqa: BLE001 - a missing conversation must not block the sync
            raw = {}
    from ..notify.core import lead_from  # local import: notify.core imports the calendar package
    convo = SimpleNamespace(booking=raw.get("booking") or {k: payload.get(k) for k in ("name", "address", "job_type",
                                                                                      "urgency", "start", "end")},
                            message=raw.get("message") or {}, collected=raw.get("collected") or {},
                            contact=raw.get("contact") or payload.get("contact") or "", channel=channel,
                            urgency=raw.get("urgency") or payload.get("urgency") or "normal",
                            transcript=[], meta=raw.get("meta") or {})
    base = lead_from(convo, {"contact": payload.get("contact", ""), "channel": channel})
    meta = raw.get("meta") or {}
    screening = meta.get("lead") if isinstance(meta.get("lead"), dict) else None
    lead: dict[str, Any] = {
        "name": base.get("name") or "",
        "phone": base.get("phone") or "",
        "email": (screening or {}).get("email") or (raw.get("collected") or {}).get("email") or "",
        "address": base.get("address") or "",
        "job_type": base.get("job_type") or "",
        "urgency": base.get("urgency") or "normal",
        "summary": base.get("summary") or str(payload.get("outcome") or ""),
        "channel": channel,
        "convo_id": convo_id,
    }
    if base.get("booking"):
        b = base["booking"]
        lead["booking"] = {"start": b["start"], "end": b["end"], "label": base.get("booking_label")
                           or _booking_label(b["start"], b["end"])}
    if screening:
        lead["qualification"] = {k: v for k, v in screening.items() if k not in ("email",)}
    return lead


def split_name(name: str) -> tuple[str, str]:
    parts = (name or "").strip().split()
    if not parts:
        return "", ""
    return parts[0], " ".join(parts[1:])


def note_text(lead: dict[str, Any], event: str) -> str:
    lines = [f"Event: {event}", f"Channel: {lead.get('channel') or '-'}"]
    for key, title in (("job_type", "Job"), ("urgency", "Urgency"), ("address", "Address"), ("summary", "Summary")):
        if lead.get(key):
            lines.append(f"{title}: {lead[key]}")
    if lead.get("booking"):
        lines.append(f"Booked: {lead['booking'].get('label') or lead['booking'].get('start')}")
    q = lead.get("qualification") or {}
    for k, v in q.items():
        if v not in (None, "", []):
            lines.append(f"{str(k).replace('_', ' ').capitalize()}: {v}")
    return "\n".join(lines)


# --- shared HTTP plumbing ----------------------------------------------------------------------------------------
class BaseCrmClient:
    """Idempotency, status classification and the audit rows; subclasses implement `_sync` and `_check`."""

    provider = "base"

    def __init__(self, box: CredentialBox, store: Store, state: StateStore, http: httpx.Client | None = None):
        self.box = box
        self.store = store
        self.state = state
        self.http = http or httpx.Client(timeout=TIMEOUT_S)

    def connected(self, tenant_id: str) -> bool:
        return self.box.connected(tenant_id, self.provider)

    def _idem_key(self, tenant: Any, event: str, idem: str) -> str:
        return f"crm:{tenant.id}:{self.provider}:{event}:{idem}"

    def sync(self, tenant: Any, event: str, lead: dict[str, Any], idem: str | None = None,
             attempt: int = 0) -> dict[str, Any]:
        idem = idem or str(lead.get("convo_id") or "")
        key = self._idem_key(tenant, event, idem) if idem else None
        if key and self.state.get(key):
            return {"status": "skipped", "reason": "duplicate"}
        token = self.box.token(tenant.id, self.provider)
        if not token:
            return {"status": "dead", "reason": "not_connected"}
        try:
            res = self._sync(tenant, token, event, lead)
        except _Retry as exc:
            res = {"status": "retry", "reason": exc.reason, "delay": BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)]}
        except _Failed as exc:
            res = {"status": "failed", "reason": exc.reason}
            if exc.reason == "auth":
                self.store.for_tenant(tenant.id).log_event("crm.auth_failed", {"provider": self.provider, "event": event})
        if res.get("status") == "sent":
            if key:
                self.state.put(key, True, tenant.id)
            self.store.for_tenant(tenant.id).log_event("crm.synced", {"provider": self.provider, "event": event,
                                                                      **{k: v for k, v in res.items() if k.endswith("_id")}})
        log.info("crm %s %s tenant=%s status=%s", self.provider, event, getattr(tenant, "slug", "?"), res.get("status"))
        return res

    def check(self, tenant: Any) -> dict[str, Any]:
        token = self.box.token(tenant.id, self.provider)
        if not token:
            return {"ok": False, "status": "dead", "reason": "not_connected"}
        try:
            info = self._check(token)
        except _Retry as exc:
            return {"ok": False, "status": "retry", "reason": exc.reason}
        except _Failed as exc:
            return {"ok": False, "status": "failed", "reason": exc.reason}
        return {"ok": True, "status": "sent", **info}

    # --- helpers for subclasses -----------------------------------------------------------------------------------
    def _request(self, method: str, url: str, token: str, **kw: Any) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", **kw.pop("headers", {})}
        try:
            resp = self.http.request(method, url, headers=headers, **kw)
        except httpx.HTTPError as exc:
            raise _Retry(type(exc).__name__) from None
        classify(resp)
        return resp

    def _sync(self, tenant: Any, token: str, event: str, lead: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def _check(self, token: str) -> dict[str, Any]:
        raise NotImplementedError


class _Retry(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _Failed(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def classify(resp: httpx.Response) -> None:
    """401/403 -> failed(auth); 408/429/5xx -> retry; other 4xx -> failed(http_<code>)."""
    code = resp.status_code
    if code < 300:
        return
    if code in (401, 403):
        raise _Failed("auth")
    if code >= 500 or code in (408, 429):
        raise _Retry(f"http_{code}")
    raise _Failed(f"http_{code}")


def json_of(resp: httpx.Response) -> dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
