"""Persistent background delivery queue (owner alerts, Zapier events). Review fix B3-B6 #1.

Call and SMS webhooks only *enqueue* (one `runtime_state` write) and return at once; every
network call (Resend, Twilio owner SMS, Zapier) and every retry runs here, on a background thread,
never inside a Twilio webhook.

- Jobs live in `runtime_state` (`outq:<id>` + the index `outq:index`), so pending work and
  scheduled retries survive a restart: the worker reloads them at start, and `POST /jobs/tick`
  drains due jobs too.
- A handler returns ("done" | "retry" | "dead", delay_s). Retries back off 2 s, 8 s, 30 s
  (Zapier's schedule); after the last one the job is dropped and recorded (`delivery.dead`).
- One worker thread per queue; `drain()` is also callable directly (tests, cron).
- Never twice: `drain()` holds a per-queue lock (the worker and `/jobs/tick` share the queue object),
  and each job is *claimed* before it runs: a lease token is swapped in with compare-and-set on
  `value->>lease` (Supabase: one conditional PATCH, atomic across processes; JSON store: under the
  store's lock). A claim that loses the race skips the job; an expired lease (crashed worker) can
  be taken over after LEASE_S.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Callable

from ..store import StateStore, Store, StoreError, SupabaseStore, utcnow_iso

log = logging.getLogger("rt.queue")

INDEX = "outq:index"
BACKOFF_S = (2.0, 8.0, 30.0)
MAX_ATTEMPTS = len(BACKOFF_S) + 1
LEASE_S = 120.0
_CAS_LOCK = threading.RLock()  # JSON store: one lock for every queue object in the process
Handler = Callable[[dict[str, Any]], tuple[str, float]]


class DeliveryQueue:
    def __init__(self, store: Store, state: StateStore, handlers: dict[str, Handler],
                 clock: Callable[[], float] = time.time, autostart: bool = True, idle_s: float = 1.0):
        self.store = store
        self.state = state
        self.handlers = handlers
        self.clock = clock
        self.autostart = autostart
        self.idle_s = idle_s
        self._lock = threading.RLock()
        self._drain_lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._stop = False

    # --- producer side (inside webhooks: must stay fast) --------------------------------------
    def enqueue(self, kind: str, payload: dict[str, Any], tenant_id: str | None = None) -> str:
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "kind": kind, "tenant_id": tenant_id, "payload": payload, "attempt": 0,
               "next_at": self.clock(), "lease": "", "lease_until": 0.0}
        with self._lock:
            self.state.put(f"outq:{job_id}", job, tenant_id)
            index = list(self.state.get(INDEX) or [])
            index.append(job_id)
            self.state.put(INDEX, index)
        if self.autostart:
            self.start()
        self._wake.set()
        return job_id

    def pending(self) -> list[dict[str, Any]]:
        jobs = []
        for job_id in list(self.state.get(INDEX) or []):
            job = self.state.get(f"outq:{job_id}")
            if job:
                jobs.append(job)
        return jobs

    # --- consumer side ---------------------------------------------------------------------------
    def _finish(self, job: dict[str, Any]) -> None:
        with self._lock:
            self.state.put(f"outq:{job['id']}", None, job.get("tenant_id"))
            self.state.put(INDEX, [j for j in (self.state.get(INDEX) or []) if j != job["id"]])

    def _cas(self, job: dict[str, Any], new: dict[str, Any]) -> bool:
        """Replace the stored job with `new` only if its lease is still `job['lease']`."""
        key = f"outq:{job['id']}"
        if isinstance(self.store, SupabaseStore) and not self.state.degraded:
            resp = self.store._client.patch("/runtime_state", params={
                "key": f"eq.{key}", "value->>lease": f"eq.{job.get('lease') or ''}"},
                json={"value": new, "updated_at": utcnow_iso()}, headers={"Prefer": "return=representation"})
            return resp.status_code < 300 and bool(resp.json())
        with _CAS_LOCK:  # JSON store / memory: single process, the lock makes read-compare-write atomic
            cur = self.state.get(key)
            if not cur or (cur.get("lease") or "") != (job.get("lease") or ""):
                return False
            self.state.put(key, new, job.get("tenant_id"))
            return True

    def claim(self, job: dict[str, Any], now: float) -> dict[str, Any] | None:
        if job.get("lease") and float(job.get("lease_until") or 0) > now:
            return None  # someone else is running it
        mine = dict(job, lease=uuid.uuid4().hex, lease_until=now + LEASE_S)
        return mine if self._cas(job, mine) else None

    def drain(self, now: float | None = None, max_jobs: int = 200) -> list[dict[str, Any]]:
        """Run every due job once. Returns [{id, kind, result}]. A concurrent drain returns []."""
        if not self._drain_lock.acquire(blocking=False):
            return []
        try:
            return self._drain(now, max_jobs)
        finally:
            self._drain_lock.release()

    def _drain(self, now: float | None, max_jobs: int) -> list[dict[str, Any]]:
        now = self.clock() if now is None else now
        out: list[dict[str, Any]] = []
        for job in self.pending()[:max_jobs]:
            if job["next_at"] > now:
                continue
            job = self.claim(job, now)
            if job is None:
                continue
            handler = self.handlers.get(job["kind"])
            try:
                result, delay = handler(job) if handler else ("dead", 0.0)
            except Exception:  # noqa: BLE001 - a broken job must not stop the queue
                log.exception("delivery job %s failed", job["kind"])
                result, delay = "retry", BACKOFF_S[min(job["attempt"], len(BACKOFF_S) - 1)]
            job["attempt"] += 1
            if result == "retry" and job["attempt"] < MAX_ATTEMPTS:
                job["next_at"] = now + (delay or BACKOFF_S[min(job["attempt"] - 1, len(BACKOFF_S) - 1)])
                self._cas(job, dict(job, lease="", lease_until=0.0))  # release the lease
            else:
                if result != "done":
                    result = "dead"
                    try:
                        self.store.log_event("runtime", "tenant", job.get("tenant_id"), "delivery.dead",
                                             {"kind": job["kind"], "attempts": job["attempt"]})
                    except StoreError:
                        log.exception("could not record delivery.dead")
                self._finish(job)
            out.append({"id": job["id"], "kind": job["kind"], "result": result, "attempt": job["attempt"]})
        return out

    def next_due_in(self) -> float:
        jobs = self.pending()
        if not jobs:
            return self.idle_s
        return max(0.0, min(j["next_at"] for j in jobs) - self.clock())

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop = False
            self._thread = threading.Thread(target=self._run, name="delivery-queue", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop = True
        self._wake.set()

    def _run(self) -> None:
        while not self._stop:
            try:
                self.drain()
                wait = min(self.next_due_in(), self.idle_s)
            except Exception:  # noqa: BLE001 - store hiccup: back off and keep going
                log.exception("delivery queue tick failed")
                wait = self.idle_s
            self._wake.wait(timeout=wait)
            self._wake.clear()
