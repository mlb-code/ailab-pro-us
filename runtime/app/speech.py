"""Sentence-level speech for voice turns: Claude's streamed text -> guarded sentences -> TTS.

The voice brain streams text; `Speaker.feed()` cuts it into sentences (same rule as the guard's
voice shortening: `.`, `!` or `?` followed by whitespace) and runs `guard.check_reply` on EACH
sentence before it is handed to the sink (ConversationRelay `text` token). Guard semantics:

- A sentence that fails the guard is never spoken. Its fixed safe replacement is spoken instead
  and nothing after it in this turn is spoken (later Claude text and tool rounds are muted).
- `booked` is evaluated when the sentence is ready, so a booking claim spoken before `book_slot`
  really succeeded is blocked (stricter than checking the whole reply after the tools ran).
- At most VOICE_MAX_SENTENCES sentences per Claude response (a one-sentence preamble before a
  tool call, e.g. "Let me check the schedule.", is spoken while the tool runs).
- Tool fillers: when Claude starts a tool call before anything was said in this turn, a fixed,
  guard-safe line ("Let me check the schedule." / "One moment.") is spoken at once, so the caller
  hears something while the tool and the next Claude call run (one per turn; `claude.voice.tool_fillers`).
- A sentence already spoken in this turn is dropped (`Speaker.repeated`): in the live runs Claude
  wrote the goodbye next to `end_conversation` and once more after the tool result.
- A final pass over the full spoken reply catches anything spanning two sentences. It can no
  longer stop the audio; it is logged (`reply_late:<rule>`) and its side effects (alerts) apply.
  Trade-off accepted for latency; every single-sentence rule still blocks before speaking.

The same class runs in gather mode (no sink): the reply is identical, only delivered at the end.
"""
from __future__ import annotations

import re
import time
from typing import Callable

from .guard import VOICE_MAX_SENTENCES, ReplyCheck

_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
_NORM = re.compile(r"[^a-z0-9]+")


def _norm(sentence: str) -> str:
    """Comparison key for the repeat guard: letters and digits only, lower case."""
    return _NORM.sub(" ", sentence.lower()).strip()
TOOL_FILLERS = {"get_availability": "Let me check the schedule.", "book_slot": "One moment.",
                "take_message": "One moment.", "handoff": "One moment."}


class Speaker:
    def __init__(self, check: Callable[[str], ReplyCheck], sink: Callable[[str], None] | None = None,
                 max_sentences: int = VOICE_MAX_SENTENCES, fillers: dict[str, str] | None = None):
        self.check = check
        self.fillers = fillers or {}
        self._filled = False
        self.sink = sink
        self.max_sentences = max_sentences
        self.spoken: list[str] = []
        self.violations: list[str] = []
        self.blocked = False
        self.first_at: float | None = None  # perf_counter when the first sentence was handed to the sink
        self._buf = ""
        self._count = 0  # sentences of the current Claude response
        self._said: set[str] = set()  # normalized sentences already spoken this turn (repeat guard)
        self.repeated: list[str] = []  # Claude sentences dropped because they were already spoken

    # --- streaming input ---------------------------------------------------------------------
    def feed(self, delta: str) -> None:
        self._buf += delta
        while True:
            m = _BOUNDARY.search(self._buf)
            if not m:
                return
            sentence, self._buf = self._buf[:m.start()], self._buf[m.end():]
            self._sentence(sentence)

    def end_response(self, stop_reason: str | None = None) -> None:
        """One Claude response finished: its last sentence has no trailing space. A reply cut by
        max_tokens ends mid-sentence, so that fragment is dropped."""
        rest, self._buf = self._buf, ""
        if stop_reason != "max_tokens":
            self._sentence(rest)
        self._count = 0

    def tool_started(self, name: str) -> None:
        """Claude began a tool call. Nothing said yet this turn -> speak the fixed filler for that tool."""
        filler = self.fillers.get(name)
        if filler and not self.spoken and not self._buf.strip() and not self.blocked and not self._filled:
            self._filled = True
            self.say(filler)

    # --- output ------------------------------------------------------------------------------
    def say(self, text: str) -> None:
        """Speak a fixed (already safe) sentence, bypassing the per-response cap."""
        if not text:
            return
        self.spoken.append(text)
        self._said.add(_norm(text))
        if self.first_at is None:
            self.first_at = time.perf_counter()
        if self.sink is not None:
            self.sink(text)

    @property
    def text(self) -> str:
        return " ".join(self.spoken)

    def _sentence(self, sentence: str) -> None:
        sentence = sentence.strip()
        if not sentence or self.blocked or self._count >= self.max_sentences:
            return
        if _norm(sentence) in self._said:
            # Live run 22.10: Claude wrote the goodbye next to end_conversation and again after the tool result,
            # so the caller heard "Thanks for calling... Goodbye." twice. A sentence already spoken in this
            # turn is never spoken (or transcribed) again.
            self.repeated.append(sentence)
            return
        self._count += 1
        checked = self.check(sentence)
        if checked.violations:
            self.violations.extend(checked.violations)
            self.blocked = True
        self.say(checked.text)
