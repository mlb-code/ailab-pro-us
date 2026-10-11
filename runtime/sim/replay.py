"""Recorded Claude responses for cost-free, deterministic test runs.

A request is keyed by a hash of everything that shapes the answer (model, system prompt,
messages, tools). One JSON file per namespace (normally one scenario) under `sim/replays/`:
    {"<key>": {"request": {...summary...}, "response": {...normalized response...}}}
Recording happens through `app.llm` in `record` mode; replay misses raise `ReplayMissing`
so a stale recording is loud, never silently answered by a live call.
"""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any


class ReplayMissing(LookupError):
    pass


def request_key(request: dict[str, Any]) -> str:
    keep = {k: request.get(k) for k in ("model", "system", "messages", "tools")}
    raw = json.dumps(keep, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


class ReplayStore:
    def __init__(self, directory: str | Path, namespace: str = "default"):
        self.dir = Path(directory)
        self.namespace = namespace
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self.dir / f"{self.namespace}.json"

    def _load(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}

    def get(self, request: dict[str, Any]) -> dict[str, Any]:
        key = request_key(request)
        entry = self._load().get(key)
        if entry is None:
            raise ReplayMissing(f"no recorded response {key} in {self.path.name}; re-record with `python -m sim record`")
        return entry["response"]

    def put(self, request: dict[str, Any], response: dict[str, Any]) -> str:
        key = request_key(request)
        with self._lock:
            data = self._load()
            last = request.get("messages", [])[-1:] or [{}]
            data[key] = {"request": {"model": request.get("model"), "last_message": last[0]}, "response": response}
            self.dir.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
        return key

    def clear(self) -> None:
        if self.path.exists():
            self.path.unlink()
