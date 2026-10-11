"""The single module through which every Claude call goes.

BRAIN_MODE (alias CLAUDE_MODE):
- mock   : deterministic local responder (`app.mock_brain`). No network, no key. Default in sim/tests.
- replay : recorded responses from `sim/replays/<namespace>.json`; a miss raises ReplayMissing.
- record : live call, response saved for replay.            [spends API credit]
- live   : live call (production).                           [spends API credit]

The API key is read lazily, only in live/record mode: ANTHROPIC_API_KEY from the environment
(Railway), else the `ANTHROPIC_API_KEY=` line of `ailab-pro-us/.secrets.env`. It is never logged.

Responses are normalized to plain dicts so mock, replay and live look identical:
    {"content": [{"type": "text", ...} | {"type": "tool_use", "id", "name", "input"} | ...],
     "stop_reason": str, "usage": {"input_tokens": int, "output_tokens": int}, "cost_usd": float}
Live responses keep every content block (including thinking blocks) so the tool loop can send
the assistant turn back unchanged.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable

from . import mock_brain
from .settings import Settings

log = logging.getLogger("rt.llm")

# USD per million tokens (input, output, cache read, cache write 5m) for the configured model
# (brand.json claude.model, Opus tier list price). Update together with the model.
PRICE_PER_MTOK = (4.0, 20.0, 0.20, 5.0)
MAX_TOKENS = 2048
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(RuntimeError):
    pass


def cost_usd(model: str, usage: dict[str, int]) -> float:
    p_in, p_out, p_cr, p_cw = PRICE_PER_MTOK
    return round((usage.get("input_tokens", 0) * p_in + usage.get("output_tokens", 0) * p_out
                  + usage.get("cache_read_input_tokens", 0) * p_cr
                  + usage.get("cache_creation_input_tokens", 0) * p_cw) / 1_000_000, 6)


def _read_key(secrets_file: Path) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    try:
        for line in secrets_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    raise LLMError("ANTHROPIC_API_KEY is not configured (env or .secrets.env)")


class LLMClient:
    def __init__(self, settings: Settings, namespace: str = "default",
                 script: list[dict[str, Any]] | None = None, mode: str | None = None,
                 live_call: Callable[[dict[str, Any]], dict[str, Any]] | None = None):
        self.settings = settings
        self.mode = mode or settings.brain_mode
        self.model = settings.model
        self.namespace = namespace
        self.mock = mock_brain.MockBrain(script)
        self.calls = 0
        self._live_call = live_call
        self._sdk = None

    def _replays(self):
        from sim.replay import ReplayStore  # sim is only needed for replay/record
        return ReplayStore(self.settings.replay_dir, self.namespace)

    def create(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
               effort: str = "low") -> dict[str, Any]:
        request = {"model": self.model, "system": system, "messages": messages, "tools": tools, "effort": effort}
        self.calls += 1
        if self.mode == "mock":
            resp = self.mock.respond(request)
        elif self.mode == "replay":
            resp = self._replays().get(request)
        elif self.mode in ("live", "record"):
            resp = (self._live_call or self._call_api)(request)
            if self.mode == "record":
                self._replays().put(request, resp)
        else:
            raise LLMError(f"unknown brain mode {self.mode!r}")
        resp.setdefault("usage", {})
        resp["cost_usd"] = cost_usd(self.model, resp["usage"])
        return resp

    # --- the only place that talks to the Anthropic API ------------------------------------
    def _call_api(self, request: dict[str, Any]) -> dict[str, Any]:  # pragma: no cover - network
        import anthropic

        if self._sdk is None:
            self._sdk = anthropic.Anthropic(api_key=_read_key(self.settings.secrets_file), timeout=20.0, max_retries=1)
        try:
            msg = self._sdk.beta.messages.create(
                model=request["model"],
                max_tokens=MAX_TOKENS,
                system=[{"type": "text", "text": request["system"], "cache_control": {"type": "ephemeral"}}],
                messages=request["messages"],
                tools=request["tools"],
                tool_choice={"type": "auto"},
                output_config={"effort": request["effort"]},
                betas=[FALLBACK_BETA],
                fallbacks="default",
            )
        except anthropic.APIStatusError as exc:
            raise LLMError(f"anthropic api status {exc.status_code}") from None
        except anthropic.APIConnectionError:
            raise LLMError("anthropic api connection error") from None
        data = msg.to_dict()
        usage = data.get("usage") or {}
        return {"content": data.get("content", []), "stop_reason": data.get("stop_reason"),
                "usage": {k: int(usage.get(k) or 0) for k in
                          ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")}}
