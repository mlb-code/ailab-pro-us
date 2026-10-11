"""Twilio webhook signature validation (X-Twilio-Signature), as pure ASGI middleware.

On in every mode. In the simulator the fake Twilio signs with the sim token, so the exact
same code path runs locally and in production. Requests to protected prefixes without a
valid signature get 403; with no auth token configured they get 503 (fail closed).

The URL Twilio signed is the public URL. Behind Railway's proxy the app sees an internal
URL, so PUBLIC_BASE_URL (e.g. https://rt.example.com) is used when set.
"""
from __future__ import annotations

import logging
from urllib.parse import parse_qsl

from twilio.request_validator import RequestValidator

log = logging.getLogger("rt.twilio_auth")


def request_url(scope: dict, public_base_url: str) -> str:
    path = scope.get("path", "")
    query = scope.get("query_string", b"").decode("latin-1")
    if public_base_url:
        base = public_base_url
    else:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        host = headers.get("host", "localhost")
        scheme = headers.get("x-forwarded-proto", scope.get("scheme", "http"))
        base = f"{scheme}://{host}"
    return f"{base}{path}" + (f"?{query}" if query else "")


def is_valid(auth_token: str, url: str, form: dict[str, str], signature: str) -> bool:
    if not auth_token or not signature:
        return False
    return RequestValidator(auth_token).validate(url, form, signature)


class TwilioSignatureMiddleware:
    def __init__(self, app, settings):
        self.app = app
        self.settings = settings

    def _protected(self, scope) -> bool:
        return scope["type"] == "http" and any(
            scope.get("path", "").startswith(p) for p in self.settings.twilio_protected_prefixes)

    async def __call__(self, scope, receive, send):
        if not self._protected(scope):
            return await self.app(scope, receive, send)

        body = b""
        more = True
        while more:
            msg = await receive()
            body += msg.get("body", b"")
            more = msg.get("more_body", False)

        status = 0
        if not self.settings.twilio_auth_token:
            status = 503
            log.error("twilio webhook refused: TWILIO_AUTH_TOKEN is not configured")
        else:
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            form = dict(parse_qsl(body.decode("utf-8", "replace"), keep_blank_values=True))
            url = request_url(scope, self.settings.public_base_url)
            if not is_valid(self.settings.twilio_auth_token, url, form, headers.get("x-twilio-signature", "")):
                status = 403
                log.warning("twilio webhook refused: bad signature path=%s", scope.get("path"))

        if status:
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"forbidden" if status == 403 else b"unavailable"})
            return

        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)
