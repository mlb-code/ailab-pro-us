"""Storage behind one interface.

- `JsonStore`: one JSON file per table under a directory (simulator, tests). Thread-safe.
- `SupabaseStore`: PostgREST with the service role key (production). Only the runtime
  writes `calls`, `sms_messages`, `bookings`, `opt_outs` (SPEC section 4).

Tables follow SPEC section 4. Credentials (`private.tenant_credentials`) are not exposed by
PostgREST, so the Supabase adapter reaches them through two service-role-only RPCs
(`runtime_get_credential`, `runtime_put_credential`) that A1's migrations must provide.
Values are always ciphertext from `app.crypto`; the store never sees plaintext tokens.

Tenant isolation: the service role bypasses RLS, so isolation is enforced here. Request
handling code must use `store.for_tenant(tenant_id)` (a `TenantStore`), which adds the tenant
filter to every select/update/delete and stamps it on every insert. The raw table methods are
for tenant lookup by number, admin/setup code and tests.

Runtime state (rate limits, spend, usage counters) lives in table `runtime_state`
(key, tenant_id, value jsonb, updated_at) through `StateStore`; A1 must add that table.
"""
from __future__ import annotations

import json
import logging
import threading
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .tenants import TenantRecord, load_record

# httpx/httpx2 log full URLs at INFO, and PostgREST filters carry phone numbers: keep them out of logs.
for _name in ("httpx", "httpx2", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

TABLES = ("tenants", "calls", "sms_messages", "bookings", "opt_outs", "events", "tenant_credentials", "runtime_state")
# Column that ties each table to a tenant (used by TenantStore).
TENANT_COLUMN = {"tenants": "id", "events": "entity_id"}


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class StoreError(RuntimeError):
    pass


class Store(ABC):
    """The interface every adapter implements. Rows are plain dicts."""

    name = "abstract"

    # --- generic rows --------------------------------------------------------
    @abstractmethod
    def insert(self, table: str, row: dict[str, Any]) -> dict[str, Any]: ...

    @abstractmethod
    def update(self, table: str, row_id: str, patch: dict[str, Any]) -> dict[str, Any] | None: ...

    @abstractmethod
    def select(self, table: str, **eq: Any) -> list[dict[str, Any]]: ...

    @abstractmethod
    def delete(self, table: str, **eq: Any) -> int: ...

    @abstractmethod
    def ping(self) -> bool: ...

    # --- credentials (ciphertext only) -----------------------------------------
    @abstractmethod
    def put_credential(self, tenant_id: str, provider: str, ciphertext: str, expires_at: str | None = None) -> None: ...

    @abstractmethod
    def get_credential(self, tenant_id: str, provider: str) -> str | None: ...

    # --- helpers shared by all adapters -----------------------------------------
    def _check_table(self, table: str) -> None:
        if table not in TABLES:
            raise StoreError(f"unknown table {table!r}")

    @staticmethod
    def _require_filter(eq: dict[str, Any]) -> None:
        if not eq:
            raise StoreError("refusing to delete without a filter")

    def for_tenant(self, tenant_id: str) -> "TenantStore":
        return TenantStore(self, tenant_id)

    def tenant_by_number(self, e164: str) -> TenantRecord | None:
        rows = self.select("tenants", twilio_number=e164)
        return load_record(rows[0]) if rows else None

    def tenant_by_slug(self, slug: str) -> TenantRecord | None:
        rows = self.select("tenants", slug=slug)
        return load_record(rows[0]) if rows else None

    def upsert_tenant(self, record: TenantRecord | dict[str, Any]) -> TenantRecord:
        rec = record if isinstance(record, TenantRecord) else load_record(record)
        row = rec.model_dump(mode="json")
        if self.select("tenants", id=rec.id):
            self.update("tenants", rec.id, row)
        else:
            self.insert("tenants", row)
        return rec

    def is_opted_out(self, tenant_id: str, contact_e164: str) -> bool:
        return bool(self.select("opt_outs", tenant_id=tenant_id, contact_e164=contact_e164))

    def opt_out(self, tenant_id: str, contact_e164: str) -> None:
        if not self.is_opted_out(tenant_id, contact_e164):
            self.insert("opt_outs", {"tenant_id": tenant_id, "contact_e164": contact_e164, "opted_out_at": utcnow_iso()})

    def opt_in(self, tenant_id: str, contact_e164: str) -> None:
        self.delete("opt_outs", tenant_id=tenant_id, contact_e164=contact_e164)

    def log_event(self, actor: str, entity: str, entity_id: str | None, type_: str,
                  payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.insert("events", {"actor": actor, "entity": entity, "entity_id": entity_id,
                                      "type": type_, "payload": payload or {}})


class JsonStore(Store):
    name = "json"

    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, table: str) -> Path:
        self._check_table(table)
        return self.dir / f"{table}.json"

    def _read(self, table: str) -> list[dict[str, Any]]:
        p = self._path(table)
        if not p.exists():
            return []
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise StoreError(f"{p.name} is not valid JSON: {exc}") from None

    def _write(self, table: str, rows: list[dict[str, Any]]) -> None:
        p = self._path(table)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)

    def insert(self, table, row):
        with self._lock:
            rows = self._read(table)
            new = {"id": str(uuid.uuid4()), "created_at": utcnow_iso(), **row}
            rows.append(new)
            self._write(table, rows)
            return new

    def update(self, table, row_id, patch):
        with self._lock:
            rows = self._read(table)
            for r in rows:
                if r.get("id") == row_id:
                    r.update(patch)
                    self._write(table, rows)
                    return r
            return None

    def select(self, table, **eq):
        with self._lock:
            return [r for r in self._read(table) if all(r.get(k) == v for k, v in eq.items())]

    def delete(self, table, **eq):
        self._require_filter(eq)
        with self._lock:
            rows = self._read(table)
            keep = [r for r in rows if not all(r.get(k) == v for k, v in eq.items())]
            self._write(table, keep)
            return len(rows) - len(keep)

    def ping(self):
        return self.dir.is_dir()

    def put_credential(self, tenant_id, provider, ciphertext, expires_at=None):
        with self._lock:
            self.delete("tenant_credentials", tenant_id=tenant_id, provider=provider)
            self.insert("tenant_credentials", {"tenant_id": tenant_id, "provider": provider,
                                               "ciphertext": ciphertext, "expires_at": expires_at})

    def get_credential(self, tenant_id, provider):
        rows = self.select("tenant_credentials", tenant_id=tenant_id, provider=provider)
        return rows[0]["ciphertext"] if rows else None


class SupabaseStore(Store):
    """PostgREST adapter. `transport` lets tests inject `httpx.MockTransport`."""

    name = "supabase"

    def __init__(self, url: str, service_key: str, transport: httpx.BaseTransport | None = None, timeout: float = 10.0):
        if not url or not service_key:
            raise StoreError("SupabaseStore needs a URL and a service role key")
        self._client = httpx.Client(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}",
                     "Content-Type": "application/json"},
            timeout=timeout, transport=transport)

    @staticmethod
    def _filters(eq: dict[str, Any]) -> dict[str, str]:
        out = {}
        for k, v in eq.items():
            if v is None:
                out[k] = "is.null"
            elif isinstance(v, bool):
                out[k] = f"is.{str(v).lower()}"
            else:
                out[k] = f"eq.{v}"
        return out

    def _ok(self, resp: httpx.Response) -> httpx.Response:
        if resp.status_code >= 400:
            # Body may echo values; keep only the status and PostgREST error code.
            code = ""
            try:
                code = resp.json().get("code", "")
            except ValueError:
                pass
            raise StoreError(f"supabase {resp.request.method} {resp.request.url.path} -> {resp.status_code} {code}".strip())
        return resp

    def insert(self, table, row):
        self._check_table(table)
        resp = self._ok(self._client.post(f"/{table}", json=row, headers={"Prefer": "return=representation"}))
        data = resp.json()
        return data[0] if isinstance(data, list) and data else row

    def update(self, table, row_id, patch):
        self._check_table(table)
        resp = self._ok(self._client.patch(f"/{table}", params={"id": f"eq.{row_id}"}, json=patch,
                                           headers={"Prefer": "return=representation"}))
        data = resp.json()
        return data[0] if data else None

    def select(self, table, **eq):
        self._check_table(table)
        return self._ok(self._client.get(f"/{table}", params={"select": "*", **self._filters(eq)})).json()

    def delete(self, table, **eq):
        self._check_table(table)
        self._require_filter(eq)
        resp = self._ok(self._client.delete(f"/{table}", params=self._filters(eq),
                                            headers={"Prefer": "return=representation"}))
        return len(resp.json())

    def ping(self):
        try:
            return self._client.post("/rpc/ping", json={}).status_code < 400
        except httpx.HTTPError:
            return False

    def put_credential(self, tenant_id, provider, ciphertext, expires_at=None):
        self._ok(self._client.post("/rpc/runtime_put_credential", json={
            "p_tenant_id": tenant_id, "p_provider": provider, "p_ciphertext": ciphertext, "p_expires_at": expires_at}))

    def get_credential(self, tenant_id, provider):
        resp = self._ok(self._client.post("/rpc/runtime_get_credential",
                                          json={"p_tenant_id": tenant_id, "p_provider": provider}))
        return (resp.json() if resp.content else None) or None


class TenantStore:
    """Tenant-scoped view of a Store: every read, write, update and delete is limited to one tenant."""

    def __init__(self, store: Store, tenant_id: str):
        if not tenant_id:
            raise StoreError("tenant_id is required")
        self.store = store
        self.tenant_id = tenant_id

    def _col(self, table: str) -> str:
        return TENANT_COLUMN.get(table, "tenant_id")

    def _scoped(self, table: str, eq: dict[str, Any]) -> dict[str, Any]:
        col = self._col(table)
        if col in eq and eq[col] != self.tenant_id:
            raise StoreError(f"cross-tenant access refused on {table}")
        return {**eq, col: self.tenant_id}

    def select(self, table: str, **eq: Any) -> list[dict[str, Any]]:
        return self.store.select(table, **self._scoped(table, eq))

    def insert(self, table: str, row: dict[str, Any]) -> dict[str, Any]:
        if table == "tenants":
            raise StoreError("tenant rows are not created through a tenant scope")
        return self.store.insert(table, self._scoped(table, row))

    def update(self, table: str, row_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        col = self._col(table)
        if col in patch and patch[col] != self.tenant_id:
            raise StoreError(f"cross-tenant access refused on {table}")
        if not self.select(table, id=row_id):
            return None
        return self.store.update(table, row_id, patch)

    def delete(self, table: str, **eq: Any) -> int:
        self.store._require_filter(eq)
        return self.store.delete(table, **self._scoped(table, eq))

    def is_opted_out(self, contact_e164: str) -> bool:
        return bool(self.select("opt_outs", contact_e164=contact_e164))

    def opt_out(self, contact_e164: str) -> None:
        if not self.is_opted_out(contact_e164):
            self.insert("opt_outs", {"contact_e164": contact_e164, "opted_out_at": utcnow_iso()})

    def opt_in(self, contact_e164: str) -> None:
        self.delete("opt_outs", contact_e164=contact_e164)

    def log_event(self, type_: str, payload: dict[str, Any] | None = None, actor: str = "runtime") -> dict[str, Any]:
        return self.insert("events", {"actor": actor, "entity": "tenant", "type": type_, "payload": payload or {}})

    def put_credential(self, provider: str, ciphertext: str, expires_at: str | None = None) -> None:
        self.store.put_credential(self.tenant_id, provider, ciphertext, expires_at)

    def get_credential(self, provider: str) -> str | None:
        return self.store.get_credential(self.tenant_id, provider)


class StateStore:
    """Small durable key/value state (rate limits, spend, usage) in table `runtime_state`.

    If the backing store fails and `memory_fallback` is on (simulator), values live in memory
    instead; in production a store failure raises so limits are never silently reset.
    """

    def __init__(self, store: Store, memory_fallback: bool = False):
        self.store = store
        self.memory_fallback = memory_fallback
        self.memory: dict[str, Any] = {}
        self.degraded = False
        self._lock = threading.RLock()

    def _rows(self, key: str) -> list[dict[str, Any]]:
        return self.store.select("runtime_state", key=key)

    def get(self, key: str, default: Any = None) -> Any:
        if self.degraded:
            return self.memory.get(key, default)
        try:
            rows = self._rows(key)
        except StoreError:
            if not self.memory_fallback:
                raise
            self.degraded = True
            return self.memory.get(key, default)
        return rows[0]["value"] if rows else default

    def put(self, key: str, value: Any, tenant_id: str | None = None) -> None:
        with self._lock:
            if not self.degraded:
                try:
                    rows = self._rows(key)
                    row = {"value": value, "updated_at": utcnow_iso()}
                    if rows:
                        self.store.update("runtime_state", rows[0]["id"], row)
                    else:
                        self.store.insert("runtime_state", {"key": key, "tenant_id": tenant_id, **row})
                    return
                except StoreError:
                    if not self.memory_fallback:
                        raise
                    self.degraded = True
            self.memory[key] = value

    def incr(self, key: str, amount: float, tenant_id: str | None = None) -> float:
        with self._lock:
            value = float(self.get(key, 0) or 0) + amount
            self.put(key, value, tenant_id)
            return value


def from_settings(settings) -> Store:
    if settings.store_backend == "supabase":
        return SupabaseStore(settings.supabase_url, settings.supabase_service_key)
    return JsonStore(settings.data_dir)
