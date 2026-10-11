"""OAuth 2.0 for calendar providers (authorization code + PKCE), token storage and refresh.

- `state` = HMAC-signed {tenant, provider, encrypted PKCE verifier, nonce}, 10-minute expiry (`app.crypto`).
  Tickets and states are single use: the nonce is consumed in `runtime_state` on first use.
- Tokens are stored encrypted (AES-GCM, `CRED_KEY`, bound to tenant + provider) through
  `store.put_credential` -> `private.tenant_credentials`. Plaintext never leaves this module.
- Refresh: the access token is refreshed when < 60 s remain or after a 401. A refused refresh
  (`invalid_grant`, revoked) raises `CalendarAuthError` -> the tenant is flagged for reconnect.
  Network trouble during refresh raises `CalendarError` (temporary, nothing is flagged).

Client IDs/secrets come from the environment only (Railway):
  GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET (fallback GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
  CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET
Redirect URI = PUBLIC_BASE_URL + /oauth/<provider>/callback.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlencode

import httpx

from .. import crypto
from ..store import StateStore, Store
from .base import CalendarAuthError, CalendarError

PROVIDERS = ("calendly", "google")  # Calendly first: it is the default (TASKS Addendum 2)


@dataclass(frozen=True)
class Endpoints:
    authorize_url: str
    token_url: str
    scopes: tuple[str, ...] = ()
    extra_auth: dict[str, str] = field(default_factory=dict)


ENDPOINTS: dict[str, Endpoints] = {
    "google": Endpoints(
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        # Only events on the owner's calendars. Sensitive scope -> Google verification (see runbook).
        scopes=("https://www.googleapis.com/auth/calendar.events",),
        extra_auth={"access_type": "offline", "prompt": "consent", "include_granted_scopes": "true"},
    ),
    "calendly": Endpoints(
        authorize_url="https://auth.calendly.com/oauth/authorize",
        token_url="https://auth.calendly.com/oauth/token",
    ),
}


@dataclass(frozen=True)
class OAuthClient:
    client_id: str
    client_secret: str = field(repr=False)
    redirect_uri: str


def clients_from_env(public_base_url: str, env: dict[str, str] | None = None) -> dict[str, OAuthClient]:
    env = dict(os.environ if env is None else env)
    pairs = {
        "google": (env.get("GOOGLE_CALENDAR_CLIENT_ID") or env.get("GOOGLE_CLIENT_ID", ""),
                   env.get("GOOGLE_CALENDAR_CLIENT_SECRET") or env.get("GOOGLE_CLIENT_SECRET", "")),
        "calendly": (env.get("CALENDLY_CLIENT_ID", ""), env.get("CALENDLY_CLIENT_SECRET", "")),
    }
    base = (public_base_url or "").rstrip("/")
    return {p: OAuthClient(cid, sec, f"{base}/oauth/{p}/callback") for p, (cid, sec) in pairs.items() if cid and sec}


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


class TokenManager:
    def __init__(self, store: Store, cred_key: str, clients: dict[str, OAuthClient],
                 http: httpx.Client | None = None, clock: Callable[[], float] = time.time,
                 state: StateStore | None = None):
        self.store = store
        self.state = state or StateStore(store)
        self.cred_key = cred_key
        self.clients = clients
        self.http = http or httpx.Client(timeout=10.0)
        self.clock = clock

    # --- connect flow ------------------------------------------------------------------
    def configured(self, provider: str) -> bool:
        return provider in self.clients

    def _client(self, provider: str) -> OAuthClient:
        if provider not in ENDPOINTS:
            raise CalendarAuthError(f"unknown provider {provider!r}")
        if provider not in self.clients:
            raise CalendarAuthError(f"{provider} OAuth client is not configured")
        return self.clients[provider]

    def ticket(self, tenant_id: str, provider: str, ttl_s: int = 900) -> str:
        """Short-lived signed permission to start the connect flow (issued to the portal/admin)."""
        self._client(provider)
        return crypto.sign(self.cred_key, {"k": "ticket", "t": tenant_id, "p": provider,
                                           "n": secrets.token_urlsafe(12)}, ttl_s, now=self.clock())

    def _consume(self, body: dict[str, Any]) -> None:
        """Single use: the first verification wins, any replay is refused."""
        key = f"oauth:nonce:{body.get('k')}:{body.get('n')}"
        if not body.get("n") or self.state.get(key):
            raise crypto.CryptoError("link already used")
        self.state.put(key, int(body.get("exp") or 0), body.get("t"))

    def check_ticket(self, ticket: str, provider: str) -> str:
        body = crypto.verify(self.cred_key, ticket, now=self.clock())
        if body.get("k") != "ticket" or body.get("p") != provider or not body.get("t"):
            raise crypto.CryptoError("ticket does not match this provider")
        self._consume(body)
        return str(body["t"])

    def authorize_url(self, tenant_id: str, provider: str) -> str:
        client = self._client(provider)
        ep = ENDPOINTS[provider]
        verifier, challenge = _pkce()
        state = crypto.sign(self.cred_key, {
            "k": "state", "t": tenant_id, "p": provider, "n": secrets.token_urlsafe(12),
            "v": crypto.encrypt(self.cred_key, verifier, tenant_id, f"pkce:{provider}")}, 600, now=self.clock())
        params = {"client_id": client.client_id, "redirect_uri": client.redirect_uri, "response_type": "code",
                  "state": state, "code_challenge": challenge, "code_challenge_method": "S256", **ep.extra_auth}
        if ep.scopes:
            params["scope"] = " ".join(ep.scopes)
        return f"{ep.authorize_url}?{urlencode(params)}"

    def handle_callback(self, provider: str, code: str, state: str) -> str:
        """Verify state, exchange the code, store tokens. Returns the tenant id."""
        body = crypto.verify(self.cred_key, state, now=self.clock())
        if body.get("k") != "state" or body.get("p") != provider:
            raise crypto.CryptoError("state does not match this provider")
        self._consume(body)
        tenant_id = str(body["t"])
        verifier = crypto.decrypt(self.cred_key, body["v"], tenant_id, f"pkce:{provider}")
        client = self._client(provider)
        tok = self._token_request(provider, {
            "grant_type": "authorization_code", "code": code, "redirect_uri": client.redirect_uri,
            "code_verifier": verifier})
        if not tok.get("refresh_token"):
            raise CalendarAuthError("provider returned no refresh token")
        self.save(tenant_id, provider, tok)
        return tenant_id

    # --- storage -----------------------------------------------------------------------
    def save(self, tenant_id: str, provider: str, tok: dict[str, Any], meta: dict[str, Any] | None = None) -> None:
        old = self.load(tenant_id, provider) or {}
        expires_at = self.clock() + float(tok.get("expires_in") or 3600)
        record = {
            "access_token": tok.get("access_token", ""),
            "refresh_token": tok.get("refresh_token") or old.get("refresh_token", ""),
            "expires_at": expires_at,
            "scope": tok.get("scope") or old.get("scope", ""),
            "meta": {**(old.get("meta") or {}), **{k: tok[k] for k in ("owner", "organization") if tok.get(k)},
                     **(meta or {})},
        }
        cipher = crypto.encrypt(self.cred_key, json.dumps(record), tenant_id, provider)
        self.store.put_credential(tenant_id, provider, cipher, None)

    def load(self, tenant_id: str, provider: str) -> dict[str, Any] | None:
        cipher = self.store.get_credential(tenant_id, provider)
        if not cipher:
            return None
        try:
            return json.loads(crypto.decrypt(self.cred_key, cipher, tenant_id, provider))
        except (crypto.CryptoError, ValueError):
            raise CalendarAuthError("stored credential cannot be decrypted") from None

    def set_meta(self, tenant_id: str, provider: str, **meta: Any) -> None:
        rec = self.load(tenant_id, provider)
        if rec is None:
            raise CalendarAuthError(f"{provider} is not connected")
        rec["meta"] = {**(rec.get("meta") or {}), **meta}
        self.store.put_credential(tenant_id, provider,
                                  crypto.encrypt(self.cred_key, json.dumps(rec), tenant_id, provider), None)

    def meta(self, tenant_id: str, provider: str) -> dict[str, Any]:
        return dict((self.load(tenant_id, provider) or {}).get("meta") or {})

    # --- tokens ------------------------------------------------------------------------
    def access_token(self, tenant_id: str, provider: str, force_refresh: bool = False) -> str:
        rec = self.load(tenant_id, provider)
        if rec is None:
            raise CalendarAuthError(f"{provider} calendar is not connected")
        if not force_refresh and rec.get("access_token") and float(rec.get("expires_at") or 0) - 60 > self.clock():
            return rec["access_token"]
        if not rec.get("refresh_token"):
            raise CalendarAuthError("no refresh token stored")
        tok = self._token_request(provider, {"grant_type": "refresh_token", "refresh_token": rec["refresh_token"]})
        self.save(tenant_id, provider, tok)
        return tok["access_token"]

    def _token_request(self, provider: str, data: dict[str, str]) -> dict[str, Any]:
        client = self._client(provider)
        form = {**data, "client_id": client.client_id, "client_secret": client.client_secret}
        try:
            resp = self.http.post(ENDPOINTS[provider].token_url, data=form,
                                  headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise CalendarError(f"{provider} token endpoint unreachable: {type(exc).__name__}") from None
        if resp.status_code >= 500 or resp.status_code == 429:
            raise CalendarError(f"{provider} token endpoint {resp.status_code}")
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if resp.status_code >= 400 or not body.get("access_token"):
            # invalid_grant / unauthorized_client / revoked: the owner has to reconnect.
            raise CalendarAuthError(f"{provider} refused the token request ({body.get('error') or resp.status_code})")
        return body
