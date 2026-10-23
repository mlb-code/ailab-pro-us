"""Shared per-app context for the voice and SMS flows (built once in `main.create_app`)."""
from __future__ import annotations

import hashlib
import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from . import _stubs_b56 as hooks
from .conversation import Engine
from .settings import Settings
from .store import Store
from .tenants import TenantConfigError, TenantRecord

log = logging.getLogger("rt.ctx")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def who(number: str) -> str:
    """Stable, non-reversible id for a phone number (state keys, logs)."""
    return hashlib.sha256((number or "").encode()).hexdigest()[:16]


@dataclass
class Runtime:
    settings: Settings
    store: Store
    engine: Engine
    outbound: Any  # app.sms_outbound.Outbound
    clock: Callable[[], datetime] = utcnow
    flow: Any = None  # app.voice.VoiceFlow
    dispatcher: Any = None  # app.dispatch.Dispatcher (ADD-DISPATCH)
    alert_log: list[dict[str, Any]] | None = None  # simulator/tests: every alert handed to the notifier
    # Owner alerts and Zapier events never run inside a Twilio webhook: they go to this pool and the
    # webhook answers right away (Zapier retries / e-mail / SMS can take seconds; Twilio waits 15 s max).
    _pool: ThreadPoolExecutor | None = field(default=None, repr=False)
    _pending: set = field(default_factory=set, repr=False)
    _plock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _submit(self, fn: Callable[..., Any], *args: Any) -> None:
        # B6's real hooks (app.hooks_b56) only enqueue into their durable delivery queue and return at once;
        # running them inline keeps ordering deterministic. Anything else (stub, unknown hook) goes to the pool.
        if getattr(fn, "non_blocking", getattr(fn, "__module__", "") == "app.hooks_b56"):
            self._safe(fn, *args)
            return
        with self._plock:
            if self._pool is None:
                self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="deliver")
            fut = self._pool.submit(self._safe, fn, *args)
            self._pending.add(fut)
        fut.add_done_callback(self._done)

    def _done(self, fut: Future) -> None:
        with self._plock:
            self._pending.discard(fut)

    @staticmethod
    def _safe(fn: Callable[..., Any], *args: Any) -> None:
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - delivery problems must never surface in a call or text
            log.exception("background delivery failed")

    def drain(self, timeout: float = 10.0) -> bool:
        """Wait for queued deliveries (tests, shutdown). True if all finished."""
        with self._plock:
            pending = list(self._pending)
        return not wait(pending, timeout=timeout).not_done if pending else True

    def now(self) -> datetime:
        return self.clock()

    @property
    def state(self):
        return self.engine.state

    def resolve_tenant(self, to_number: str) -> tuple[TenantRecord | None, str]:
        """(tenant, problem). problem in {'', 'unknown', 'invalid_config'}."""
        try:
            tenant = self.store.tenant_by_number(to_number)
        except TenantConfigError:
            return None, "invalid_config"
        return (tenant, "") if tenant else (None, "unknown")

    def deliver(self, tenant: TenantRecord, actions: list[dict[str, Any]], ref: str) -> None:
        """Hand every alert action to the notifier (B6); each kind once per conversation/ref."""
        for a in actions:
            if a.get("type") == "alert":
                if self.alert_log is not None:
                    self.alert_log.append({**a, "tenant_id": tenant.id, "ref": ref})
                self._submit(hooks.owner_alert, self.store, self.state, tenant, a, f"{ref}:{a.get('kind')}")

    def emit(self, tenant: TenantRecord, event: str, payload: dict[str, Any], key: str) -> None:
        """Lifecycle event for Zapier/reports (B6 decides whether the tenant subscribed to it)."""
        self._submit(hooks.emit, self.store, self.state, tenant, event, payload, key)
