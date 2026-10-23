"""A deterministic fake phone call that follows whatever TwiML the runtime returns.

- `<Gather>` (turn-based mode): each caller utterance is a signed POST to the Gather action with
  `SpeechResult`; silence is the same POST without it (Gather actionOnEmptyResult).
- `<Connect><ConversationRelay>` (streaming mode): opens the WebSocket like Twilio (signed
  handshake), sends `setup`, then one `prompt` per utterance; silence = sending nothing and
  waiting for the server's silence timer. An `end` frame makes the fake request the Connect
  action with `HandoffData`, exactly like Twilio, and follow the TwiML it gets (`<Dial>`,
  `<Hangup>`, or `<Gather>` = fall back to turn-based on the same call).
- `<Dial>`: `dial(status)` posts the Dial action with `DialCallStatus`.
- `hangup()` closes the socket and posts the call status callback with `CallDuration` taken
  from the simulator clock.

Latency: `CallTurn.latency_ms` is the client-side wall time from sending the utterance to
receiving the reply (in the simulator Claude is mocked/replayed, so this is server time).
"""
from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from .fake_twilio import FakeTwilio, Twiml, parse_twiml, sid

WAIT_S = 10.0


@dataclass
class CallTurn:
    text: str = ""
    end: bool = False
    dial: str | None = None
    rejected: bool = False
    latency_ms: float = 0.0
    mode: str = ""
    lang: str | None = None  # TTS/STT language of this turn as Twilio would apply it (gather attr / relay `language` frame)


class FakeCall:
    def __init__(self, twilio: FakeTwilio, to: str, caller: str, clock: Callable[[], datetime] | None = None,
                 call_sid: str | None = None, settled: Callable[[str], bool] | None = None):
        self.twilio, self.to, self.caller = twilio, to, caller
        self.settled = settled  # call_sid -> True once the runtime finished handling the closed socket
        self.clock = clock
        self.call_sid = call_sid or sid("CA")
        self.mode = ""
        self.action: str | None = None
        self.dial_action: str | None = None
        self.connect_action: str | None = None
        self.started_at: datetime | None = None
        self.ended = False
        self.hung_up = False
        self._ws_cm = None
        self._ws = None
        self._frames: queue.Queue = queue.Queue()
        self.turns: list[CallTurn] = []
        self.lang: str | None = None  # stream mode: last `language` frame

    # --- helpers -----------------------------------------------------------------------------
    def _from_twiml(self, tw: Twiml, latency_ms: float = 0.0) -> CallTurn:
        if tw.rejected:
            self.ended = True
            return self._keep(CallTurn(rejected=True, end=True, mode=self.mode))
        if tw.relay_url:
            self.mode = "stream"
            self.connect_action = tw.connect_action
            self._open(tw.relay_url)
            return self._keep(CallTurn(text=tw.text, mode="stream", lang=tw.relay.get("language") or "en-US"))
        if tw.gather:
            self.mode = self.mode if self.mode == "gather-fallback" else "gather"
            self.action = tw.gather_action
        if tw.dial:
            self.dial_action = tw.dial_action
        end = bool(tw.hangup) or (not tw.gather and not tw.dial)
        self.ended = end
        return self._keep(CallTurn(text=tw.text, end=end, dial=tw.dial or None, latency_ms=latency_ms,
                                   mode=self.mode, lang=tw.lang or "en-US"))

    def _keep(self, turn: CallTurn) -> CallTurn:
        self.turns.append(turn)
        return turn

    def _open(self, url: str) -> None:
        self._ws_cm = self.twilio.open_relay(url)
        self._ws = self._ws_cm.__enter__()
        threading.Thread(target=self._reader, daemon=True).start()
        self._ws.send_text(json.dumps({"type": "setup", "sessionId": sid("VX"), "callSid": self.call_sid,
                                       "from": self.caller, "to": self.to, "direction": "inbound"}))

    def _reader(self) -> None:
        try:
            while True:
                self._frames.put(json.loads(self._ws.receive_text()))
        except Exception:  # noqa: BLE001 - socket closed
            self._frames.put(None)

    def _close_ws(self) -> None:
        if self._ws_cm is not None:
            try:
                self._ws_cm.__exit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
            self._ws_cm = self._ws = None

    def _stream_reply(self, t0: float) -> CallTurn:
        """Collect frames for one reply: text (last) [+ end when the text is not interruptible]."""
        texts: list[str] = []
        latency = 0.0
        while True:
            frame = self._frames.get(timeout=WAIT_S)
            if frame is None:
                self.ended = True
                self._close_ws()
                return self._keep(CallTurn(text="".join(texts), end=True, mode="stream"))
            if frame.get("type") == "language":
                self.lang = frame.get("ttsLanguage")
                continue
            if frame.get("type") == "text":
                latency = latency or (time.perf_counter() - t0) * 1000
                texts.append(frame.get("token", ""))
                if frame.get("last") and frame.get("interruptible", True):
                    # tokens are concatenated as sent (like Twilio TTS): streamed sentences carry their own spaces
                    return self._keep(CallTurn(text="".join(texts).strip(), latency_ms=latency, mode="stream",
                                               lang=self.lang or "en-US"))
            elif frame.get("type") == "end":
                latency = latency or (time.perf_counter() - t0) * 1000
                handoff = frame.get("handoffData")
                self._close_ws()
                resp = self.twilio.relay_end(self.to, self.caller, self.call_sid, self.connect_action or "/voice/relay-end",
                                             handoff, session_status="ended")
                after = self._from_twiml(parse_twiml(resp.text))
                self.turns.pop()
                turn = CallTurn(text=" ".join(["".join(texts), after.text]).strip(), end=after.end, dial=after.dial,
                                latency_ms=latency, mode="stream", lang=self.lang or "en-US")
                return self._keep(turn)

    # --- the caller's actions -------------------------------------------------------------------
    def start(self) -> CallTurn:
        self.started_at = self.clock() if self.clock else None
        resp = self.twilio.post("/voice/incoming", self.twilio.call_params(self.to, self.caller, self.call_sid,
                                                                            CallStatus="ringing"))
        assert resp.status_code == 200, resp.status_code
        return self._from_twiml(parse_twiml(resp.text))

    def say(self, text: str) -> CallTurn:
        assert not self.ended, "call already ended"
        t0 = time.perf_counter()
        if self.mode == "stream":
            self._ws.send_text(json.dumps({"type": "prompt", "voicePrompt": text, "lang": "en-US", "last": True}))
            return self._stream_reply(t0)
        resp = self.twilio.say(self.to, self.caller, self.call_sid, text, path=self.action or "/voice/turn")
        assert resp.status_code == 200, resp.status_code
        return self._from_twiml(parse_twiml(resp.text), (time.perf_counter() - t0) * 1000)

    def silence(self) -> CallTurn:
        if self.mode == "stream":
            return self._stream_reply(time.perf_counter())
        return self.say("")

    def dial(self, status: str) -> CallTurn:
        resp = self.twilio.dial_result(self.to, self.caller, self.call_sid, status,
                                       path=self.dial_action or "/voice/dial-result")
        return self._from_twiml(parse_twiml(resp.text))

    def _twilio_closes_socket(self) -> None:
        """Twilio's side closes the socket; wait until the runtime has handled it (no task cancellation)."""
        if self._ws is None:
            return
        try:
            self._ws.close(1011)
        except Exception:  # noqa: BLE001
            pass
        deadline = time.monotonic() + 3.0
        while self.settled and not self.settled(self.call_sid) and time.monotonic() < deadline:
            time.sleep(0.005)

    def relay_failed(self, order: str = "close_first", session_status: str = "failed") -> CallTurn:
        """Twilio ends the relay session without our `end` while the caller is still on the line.
        Real order: socket closes, then Twilio requests the Connect action (relay-end). `order="end_first"`
        replays the reverse order. Either way the runtime must continue the call with <Gather>."""
        if order == "close_first":
            self._twilio_closes_socket()
        resp = self.twilio.relay_end(self.to, self.caller, self.call_sid, self.connect_action or "/voice/relay-end",
                                     None, session_status=session_status, error_code="64101")
        if order != "close_first":
            self._twilio_closes_socket()
        self._close_ws()
        self.mode = "gather-fallback"
        return self._from_twiml(parse_twiml(resp.text))

    def hangup(self, duration_s: int | None = None) -> Any:
        if self._ws is not None and not self.ended:
            # Caller hangs up: Twilio closes the socket, then sends the status callback. Let the runtime
            # handle the close before the test client tears the session down (its __exit__ cancels the
            # server task), so nothing keeps running in the background while the scenario continues.
            self._twilio_closes_socket()
        self._close_ws()
        if duration_s is None:
            duration_s = int((self.clock() - self.started_at).total_seconds()) if self.clock and self.started_at else 30
        self.ended = self.hung_up = True
        return self.twilio.status(self.to, self.caller, self.call_sid, "completed", duration_s)
