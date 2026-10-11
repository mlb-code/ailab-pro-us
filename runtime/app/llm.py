"""The single module through which every Claude call goes.

BRAIN_MODE (alias CLAUDE_MODE):
- mock   : deterministic local responder (`app.mock_brain`). No network, no key. Default in sim/tests.
- replay : recorded responses from `sim/replays/<namespace>.json`; a miss raises ReplayMissing.
- record : live call, response saved for replay.            [spends API credit]
- live   : live call (production).                           [spends API credit]

The API key is read lazily, only in live/record mode: ANTHROPIC_API_KEY from the environment
(Railway), else the `ANTHROPIC_API_KEY=` line of `ailab-pro-us/.secrets.env`. It is never logged.

Model: `LLMClient.model` = claude.voice_model (every realtime turn). Live calls stream (`on_text` / `on_tool`
callbacks, so voice can speak sentence by sentence), cache the tools+system prefix and the conversation
(`cache_control`), and use a small `max_tokens`; `prewarm()` warms connection + cache at call start.

Responses are normalized to plain dicts so mock, replay and live look identical:
    {"content": [{"type": "text", ...} | {"type": "tool_use", "id", "name", "input"} | ...],
     "stop_reason": str, "usage": {"input_tokens": int, "output_tokens": int}, "cost_usd": float}
Live responses keep every content block (including thinking blocks) so the tool loop can send
the assistant turn back unchanged.
"""
from __future__ import annotations

import inspect
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

from . import mock_brain
from .settings import Settings

log = logging.getLogger("rt.llm")

# Prices (USD per million tokens: input, output, cache read, cache write 5m) come from brand.json
# claude.price_usd_per_mtok, keyed by model. Unknown model -> the Opus-tier list price (conservative).
DEFAULT_PRICE_PER_MTOK = (4.0, 20.0, 0.20, 5.0)
MAX_TOKENS = 2048
FALLBACK_BETA = "server-side-fallback-2026-07-01"
STREAM_CHUNK_WORDS = 3  # mock/replay: text is replayed to `on_text` in small chunks, like a live stream


class LLMError(RuntimeError):
    pass


def price_per_mtok(model: str) -> tuple[float, float, float, float]:
    from .settings import brand
    table = ((brand().get("claude") or {}).get("price_usd_per_mtok") or {})
    p = table.get(model)
    return tuple(float(x) for x in p) if isinstance(p, list) and len(p) == 4 else DEFAULT_PRICE_PER_MTOK  # type: ignore[return-value]


def cost_usd(model: str, usage: dict[str, int]) -> float:
    p_in, p_out, p_cr, p_cw = price_per_mtok(model)
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


TextSink = Callable[[str], None]


def _accepts(fn: Callable[..., Any], name: str) -> bool:
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def replay_stream(content: list[dict[str, Any]], on_text: TextSink | None, on_tool: TextSink | None = None) -> None:
    """Feed a finished response to the stream callbacks in block order, like a live stream: text in small
    chunks plus a newline when a text block ends, and the name of each tool_use block as it starts."""
    for block in content:
        if block.get("type") == "tool_use":
            if on_tool is not None:
                on_tool(block.get("name", ""))
            continue
        if block.get("type") != "text" or on_text is None:
            continue
        words = re.split(r"(\s+)", block.get("text", ""))
        for i in range(0, len(words), STREAM_CHUNK_WORDS * 2):
            chunk = "".join(words[i:i + STREAM_CHUNK_WORDS * 2])
            if chunk:
                on_text(chunk)
        on_text("\n")


class LLMClient:
    """`model` = claude.voice_model: every realtime turn (voice, SMS, web chat) runs on it."""

    def __init__(self, settings: Settings, namespace: str = "default",
                 script: list[dict[str, Any]] | None = None, mode: str | None = None,
                 live_call: Callable[..., dict[str, Any]] | None = None):
        self.settings = settings
        self.mode = mode or settings.brain_mode
        self.model = settings.voice_model or settings.model
        self.max_tokens = settings.voice_max_tokens or MAX_TOKENS
        self.thinking = settings.voice_thinking
        self.prompt_cache = settings.prompt_cache
        self.namespace = namespace
        self.mock = mock_brain.MockBrain(script)
        self.calls = 0
        self._live_call = live_call
        self._sdk = None

    def _replays(self):
        from sim.replay import ReplayStore  # sim is only needed for replay/record
        return ReplayStore(self.settings.replay_dir, self.namespace)

    def create(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
               effort: str = "low", on_text: TextSink | None = None,
               on_tool: TextSink | None = None) -> dict[str, Any]:
        """One Claude call. `on_text` receives text deltas as they are generated and `on_tool` the name of each
        tool call as it starts (live: real streaming; mock/replay: the finished response replayed in order),
        so the caller can speak sentence by sentence."""
        request = {"model": self.model, "system": system, "messages": messages, "tools": tools, "effort": effort}
        self.calls += 1
        streamed = False
        if self.mode == "mock":
            resp = self.mock.respond(request)
        elif self.mode == "replay":
            resp = self._replays().get(request)
        elif self.mode in ("live", "record"):
            call = self._live_call or self._call_api
            if (on_text is not None or on_tool is not None) and _accepts(call, "on_text"):
                kw: dict[str, Any] = {"on_text": on_text}
                if _accepts(call, "on_tool"):
                    kw["on_tool"] = on_tool
                resp, streamed = call(request, **kw), True
            else:
                resp = call(request)
            if self.mode == "record":
                self._replays().put(request, resp)
        else:
            raise LLMError(f"unknown brain mode {self.mode!r}")
        if (on_text is not None or on_tool is not None) and not streamed:
            replay_stream(resp.get("content") or [], on_text, on_tool)
        resp.setdefault("usage", {})
        resp["cost_usd"] = cost_usd(self.model, resp["usage"])
        return resp

    def params(self, request: dict[str, Any]) -> dict[str, Any]:
        """The Messages API request body (without `betas`/`fallbacks`)."""
        system: dict[str, Any] = {"type": "text", "text": request["system"]}
        params: dict[str, Any] = dict(model=request["model"], max_tokens=self.max_tokens, messages=request["messages"],
                                      tools=request["tools"], tool_choice={"type": "auto"},
                                      output_config={"effort": request["effort"]})
        if self.prompt_cache:
            # Stable prefix (tools -> system) cached by the breakpoint on the system block; the top-level
            # breakpoint caches the growing conversation (last block), so each turn re-reads the previous one.
            system["cache_control"] = {"type": "ephemeral"}
            params["cache_control"] = {"type": "ephemeral"}
        params["system"] = [system]
        if self.thinking == "disabled":
            params["thinking"] = {"type": "disabled"}
        return params

    def prewarm(self, system: str, tools: list[dict[str, Any]], effort: str = "low") -> dict[str, Any] | None:
        """live only: `max_tokens: 0` request at call start (while the greeting plays) so the first turn finds a
        warm connection and a cached tools+system prefix. Not a turn: not counted in `calls`, no replay."""
        if self.mode != "live" or not self.prompt_cache or self._live_call is not None:
            return None
        request = {"model": self.model, "system": system, "messages": [{"role": "user", "content": "."}],
                   "tools": tools, "effort": effort}
        try:
            resp = self._call_prewarm(request)
        except LLMError as exc:
            log.warning("prewarm failed: %s", exc)
            return None
        resp["cost_usd"] = cost_usd(self.model, resp.get("usage") or {})
        return resp

    def _call_prewarm(self, request: dict[str, Any]) -> dict[str, Any]:  # pragma: no cover - network
        import anthropic

        if self._sdk is None:
            self._sdk = anthropic.Anthropic(api_key=_read_key(self.settings.secrets_file), timeout=20.0, max_retries=1)
        params = self.params(request)
        params.pop("cache_control", None)  # only the tools+system breakpoint is shared across calls
        params["max_tokens"] = 0           # prefill only: writes the cache, no output tokens
        t0 = time.perf_counter()
        try:
            msg = self._sdk.beta.messages.create(**params)
        except anthropic.APIStatusError as exc:
            raise LLMError(f"anthropic api status {exc.status_code}") from None
        except anthropic.APIConnectionError:
            raise LLMError("anthropic api connection error") from None
        usage = msg.to_dict().get("usage") or {}
        return {"usage": {k: int(usage.get(k) or 0) for k in
                          ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")},
                "timing": {"total_ms": round((time.perf_counter() - t0) * 1000, 1)}}

    # --- the only place that talks to the Anthropic API ------------------------------------
    def _call_api(self, request: dict[str, Any], on_text: TextSink | None = None,
                  on_tool: TextSink | None = None) -> dict[str, Any]:  # pragma: no cover - network
        import anthropic

        if self._sdk is None:
            self._sdk = anthropic.Anthropic(api_key=_read_key(self.settings.secrets_file), timeout=20.0, max_retries=1)
        params = self.params(request)
        if "haiku" not in request["model"]:  # no server-side refusal fallback exists for the Haiku tier
            params.update(betas=[FALLBACK_BETA], fallbacks="default")
        t0 = time.perf_counter()
        first_event = first_text = None
        kinds: dict[int, str] = {}
        try:
            with self._sdk.beta.messages.stream(**params) as stream:
                for event in stream:
                    if event.type == "content_block_start":
                        kinds[event.index] = event.content_block.type
                        if first_event is None:
                            first_event = time.perf_counter()
                        if event.content_block.type == "tool_use" and on_tool is not None:
                            on_tool(event.content_block.name)
                    elif event.type == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
                        if first_text is None:
                            first_text = time.perf_counter()
                        if on_text is not None:
                            on_text(event.delta.text)
                    elif event.type == "content_block_stop" and kinds.get(event.index) == "text" and on_text is not None:
                        on_text("\n")  # a text block ended (e.g. a preamble before a tool call): its last sentence is complete
                msg = stream.get_final_message()
        except anthropic.APIStatusError as exc:
            raise LLMError(f"anthropic api status {exc.status_code}") from None
        except anthropic.APIConnectionError:
            raise LLMError("anthropic api connection error") from None
        done = time.perf_counter()
        data = msg.to_dict()
        usage = data.get("usage") or {}
        ms = lambda t: round((t - t0) * 1000, 1) if t else None  # noqa: E731
        return {"content": data.get("content", []), "stop_reason": data.get("stop_reason"),
                "usage": {k: int(usage.get(k) or 0) for k in
                          ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")},
                "timing": {"first_block_ms": ms(first_event), "first_text_ms": ms(first_text), "total_ms": ms(done)}}
