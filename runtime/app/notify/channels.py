"""Delivery channels for owner/admin notifications: e-mail (Resend) and SMS (Twilio).

- `ResendEmail`: POST https://api.resend.com/emails with an `Idempotency-Key`, key from RESEND_API_KEY.
- `OutboxEmail` / `OutboxSms`: simulator and "not configured yet": nothing leaves the machine, every
  message is recorded in `events` (type `email.outbox` / `sms.outbox`) so tests and the sim can read it.
- `TwilioSms`: wraps a Twilio REST client (`client.messages.create(to=, from_=, body=)`); tests pass
  the simulator's `FakeTwilioClient`.
Senders return {"ok": bool, "id"?: str, "error"?: str} and never raise.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ..store import Store, StoreError

log = logging.getLogger("rt.notify")

RESEND_URL = "https://api.resend.com/emails"


@dataclass(frozen=True)
class Email:
    to: tuple[str, ...]
    subject: str
    text: str
    html: str
    sender: str
    reply_to: str = ""
    tag: str = ""
    lang: str = "en"


class EmailSender(Protocol):
    name: str

    def send(self, msg: Email, idem: str) -> dict[str, Any]: ...


class SmsSender(Protocol):
    name: str

    def send(self, to: str, from_: str, body: str, idem: str) -> dict[str, Any]: ...


class ResendEmail:
    name = "resend"

    def __init__(self, api_key: str, http: httpx.Client | None = None):
        self._key = api_key
        self.http = http or httpx.Client(timeout=10.0)

    def send(self, msg: Email, idem: str) -> dict[str, Any]:
        body: dict[str, Any] = {"from": msg.sender, "to": list(msg.to), "subject": msg.subject,
                                "html": msg.html, "text": msg.text}
        if msg.reply_to:
            body["reply_to"] = msg.reply_to
        if msg.tag:
            body["tags"] = [{"name": "kind", "value": msg.tag}]
        try:
            resp = self.http.post(RESEND_URL, json=body, headers={
                "Authorization": f"Bearer {self._key}", "Idempotency-Key": idem[:256]})
        except httpx.HTTPError as exc:
            return {"ok": False, "error": type(exc).__name__}
        if resp.status_code >= 300:
            return {"ok": False, "error": f"resend {resp.status_code}"}
        try:
            return {"ok": True, "id": resp.json().get("id", "")}
        except ValueError:
            return {"ok": True}


class OutboxEmail:
    name = "outbox"

    def __init__(self, store: Store):
        self.store = store

    def send(self, msg: Email, idem: str) -> dict[str, Any]:
        try:
            self.store.log_event("runtime", "email", None, "email.outbox", {
                "to": list(msg.to), "subject": msg.subject, "text": msg.text, "tag": msg.tag, "lang": msg.lang,
                "idem": idem})
        except StoreError as exc:
            return {"ok": False, "error": str(exc)[:80]}
        return {"ok": True, "id": f"outbox:{idem}"}


class TwilioSms:
    name = "twilio"

    def __init__(self, client: Any):
        self.client = client

    def send(self, to: str, from_: str, body: str, idem: str) -> dict[str, Any]:
        try:
            msg = self.client.messages.create(to=to, from_=from_, body=body)
        except Exception as exc:  # noqa: BLE001 - Twilio raises its own exception types
            return {"ok": False, "error": type(exc).__name__}
        return {"ok": True, "id": getattr(msg, "sid", "")}


class OutboxSms:
    name = "outbox"

    def __init__(self, store: Store):
        self.store = store

    def send(self, to: str, from_: str, body: str, idem: str) -> dict[str, Any]:
        try:
            self.store.log_event("runtime", "sms", None, "sms.outbox", {"to": to, "body": body, "idem": idem})
        except StoreError as exc:
            return {"ok": False, "error": str(exc)[:80]}
        return {"ok": True, "id": f"outbox:{idem}"}


def email_from_env(store: Store, settings: Any, env: dict[str, str] | None = None) -> EmailSender:
    env = dict(os.environ if env is None else env)
    if not getattr(settings, "is_sim", False) and env.get("RESEND_API_KEY"):
        return ResendEmail(env["RESEND_API_KEY"])
    return OutboxEmail(store)


def sms_from_env(store: Store, settings: Any, env: dict[str, str] | None = None) -> SmsSender:
    env = dict(os.environ if env is None else env)
    sid = env.get("TWILIO_ACCOUNT_SID", "")
    if not getattr(settings, "is_sim", False) and sid and settings.twilio_auth_token:
        from twilio.rest import Client  # imported lazily: only production needs it

        return TwilioSms(Client(sid, settings.twilio_auth_token))
    return OutboxSms(store)
