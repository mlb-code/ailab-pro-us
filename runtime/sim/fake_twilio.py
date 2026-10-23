"""Fake Twilio for the simulator.

- `FakeTwilio` sends webhooks exactly like Twilio does: form-encoded POST with an
  X-Twilio-Signature computed from the full URL + params with the account auth token.
  It "speaks" text: a caller turn is a SpeechResult string, a reply is parsed from TwiML.
- `FakeTwilioClient` mimics the REST client surface the runtime uses for outbound work
  (`messages.create`, `lookups.v2.phone_numbers(n).fetch`) and records everything in `outbox`.
"""
from __future__ import annotations

import secrets
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Protocol

from twilio.request_validator import RequestValidator

FAKE_ACCOUNT_SID = "AC" + "0" * 32


class _Poster(Protocol):
    def post(self, url: str, data: dict | None = None, headers: dict | None = None) -> Any: ...


def sid(prefix: str) -> str:
    return prefix + secrets.token_hex(16)


@dataclass
class Twiml:
    says: list[str] = field(default_factory=list)
    gather: bool = False
    gather_action: str | None = None
    dial: str | None = None
    hangup: bool = False
    messages: list[str] = field(default_factory=list)
    redirect: str | None = None
    dial_action: str | None = None
    dial_url: str | None = None  # <Number url> = the whisper document for the callee (ADD-DISPATCH)
    rejected: bool = False
    relay_url: str | None = None
    relay: dict[str, str] = field(default_factory=dict)
    connect_action: str | None = None
    lang: str | None = None          # <Gather language> / <Say language> of this TwiML (ADD-ES)
    relay_langs: list[str] = field(default_factory=list)  # <Language code> children of <ConversationRelay>

    @property
    def text(self) -> str:
        return " ".join(self.says + self.messages).strip()


def parse_twiml(xml: str) -> Twiml:
    root = ET.fromstring(xml)
    out = Twiml()
    for el in root.iter():
        tag = el.tag
        if tag == "Say":
            out.says.append((el.text or "").strip())
            out.lang = el.get("language") or out.lang
        elif tag == "Gather":
            out.gather = True
            out.gather_action = el.get("action")
            out.lang = el.get("language") or out.lang
        elif tag == "Language":
            out.relay_langs.append(el.get("code") or "")
        elif tag == "Dial":
            num = el.find("Number")
            out.dial = (num.text if num is not None else el.text or "").strip()
            out.dial_url = num.get("url") if num is not None else None
            out.dial_action = el.get("action")
        elif tag == "Reject":
            out.rejected = True
        elif tag == "Connect":
            out.connect_action = el.get("action")
        elif tag == "ConversationRelay":
            out.relay = dict(el.attrib)
            out.relay_url = el.get("url")
            if el.get("welcomeGreeting"):
                out.says.append(el.get("welcomeGreeting").strip())
        elif tag == "Hangup":
            out.hangup = True
        elif tag == "Message":
            body = el.find("Body")
            out.messages.append(((body.text if body is not None else el.text) or "").strip())
        elif tag == "Redirect":
            out.redirect = (el.text or "").strip()
    return out


class FakeTwilio:
    """Signs and sends webhooks to the runtime. `http` = TestClient or httpx.Client."""

    def __init__(self, http: _Poster, auth_token: str, base_url: str = "http://testserver"):
        self.http = http
        self.validator = RequestValidator(auth_token)
        self.base_url = base_url.rstrip("/")

    def sign(self, path: str, params: dict[str, str]) -> str:
        return self.validator.compute_signature(self.base_url + path, params)

    def post(self, path: str, params: dict[str, str], signed: bool = True, signature: str | None = None):
        headers = {}
        if signed:
            headers["X-Twilio-Signature"] = signature or self.sign(path, params)
        return self.http.post(self.base_url + path, data=params, headers=headers)

    # --- voice -------------------------------------------------------------
    def call_params(self, to: str, from_: str, call_sid: str, **extra: str) -> dict[str, str]:
        return {"AccountSid": FAKE_ACCOUNT_SID, "CallSid": call_sid, "From": from_, "To": to,
                "Direction": "inbound", "CallStatus": "in-progress", "ApiVersion": "2010-04-01", **extra}

    def start_call(self, to: str, from_: str, call_sid: str | None = None):
        call_sid = call_sid or sid("CA")
        resp = self.post("/voice/incoming", self.call_params(to, from_, call_sid, CallStatus="ringing"))
        return call_sid, resp

    def say(self, to: str, from_: str, call_sid: str, text: str, path: str = "/voice/turn"):
        extra = {"SpeechResult": text, "Confidence": "0.92"} if text else {}  # silence: no SpeechResult
        params = self.call_params(to, from_, call_sid, **extra)
        return self.post(path, params)

    def status(self, to: str, from_: str, call_sid: str, status: str = "completed", duration_s: int = 0):
        return self.post("/voice/status", self.call_params(to, from_, call_sid, CallStatus=status,
                                                            CallDuration=str(int(duration_s))))

    def dial_result(self, to: str, from_: str, call_sid: str, dial_status: str, path: str = "/voice/dial-result"):
        return self.post(path, self.call_params(to, from_, call_sid, DialCallStatus=dial_status))

    def relay_end(self, to: str, from_: str, call_sid: str, path: str, handoff: str | None,
                  session_status: str = "completed", error_code: str = ""):
        extra = {"SessionStatus": session_status}
        if handoff is not None:
            extra["HandoffData"] = handoff
        if error_code:
            extra["ErrorCode"] = error_code
        return self.post(path, self.call_params(to, from_, call_sid, **extra))

    def open_relay(self, ws_url: str):
        """Open the ConversationRelay WebSocket the way Twilio does: signed handshake, no params."""
        headers = {"X-Twilio-Signature": self.validator.compute_signature(ws_url, {})}
        return self.http.websocket_connect(ws_url, headers=headers)

    # --- sms ---------------------------------------------------------------
    def sms(self, to: str, from_: str, body: str, num_media: int = 0, message_sid: str | None = None):
        params = {"AccountSid": FAKE_ACCOUNT_SID, "MessageSid": message_sid or sid("SM"), "From": from_,
                  "To": to, "Body": body, "NumMedia": str(num_media), "NumSegments": "1"}
        for i in range(num_media):
            params[f"MediaUrl{i}"] = f"https://example.invalid/media/{i}.jpg"
            params[f"MediaContentType{i}"] = "image/jpeg"
        return self.post("/sms/incoming", params)


class FakeTwilioClient:
    """Outbound REST surface. `landlines` = numbers Lookup reports as landline."""

    def __init__(self, landlines: set[str] | None = None):
        self.outbox: list[dict[str, Any]] = []
        self.landlines = set(landlines or ())
        self.messages = SimpleNamespace(create=self._create_message)
        self.calls_out: list[dict[str, Any]] = []
        self.calls = SimpleNamespace(create=self._create_call)
        self.lookups = SimpleNamespace(v2=SimpleNamespace(phone_numbers=self._lookup))

    def _create_message(self, to: str, from_: str, body: str, **kw: Any):
        msg = {"sid": sid("SM"), "to": to, "from": from_, "body": body, **kw}
        self.outbox.append(msg)
        return SimpleNamespace(**msg)

    def _create_call(self, to: str, from_: str, url: str, **kw: Any):
        call = {"sid": sid("CA"), "to": to, "from": from_, "url": url, **kw}
        self.calls_out.append(call)
        return SimpleNamespace(**call)

    def _lookup(self, number: str):
        kind = "landline" if number in self.landlines else "mobile"
        return SimpleNamespace(fetch=lambda **_: SimpleNamespace(
            phone_number=number, line_type_intelligence={"type": kind}))
