"""Authenticated JSON calls for provider REST APIs, with one forced token refresh on 401."""
from __future__ import annotations

from typing import Any

import httpx

from .base import CalendarAuthError, CalendarError
from .oauth import TokenManager


class AuthedApi:
    def __init__(self, provider: str, base_url: str, tokens: TokenManager, http: httpx.Client | None = None):
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.tokens = tokens
        self.http = http or tokens.http

    def call(self, tenant_id: str, method: str, path: str, *, params: dict[str, Any] | None = None,
             json: dict[str, Any] | None = None, ok_missing: bool = False) -> dict[str, Any]:
        url = path if path.startswith("https://") else f"{self.base_url}{path}"
        if not url.startswith(self.base_url):
            raise CalendarError(f"refusing a {self.provider} call outside its API")
        for attempt in (0, 1):
            token = self.tokens.access_token(tenant_id, self.provider, force_refresh=attempt == 1)
            try:
                resp = self.http.request(method, url, params=params, json=json,
                                         headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
            except httpx.HTTPError as exc:
                raise CalendarError(f"{self.provider} unreachable: {type(exc).__name__}") from None
            if resp.status_code == 401 and attempt == 0:
                continue
            if resp.status_code == 401:
                raise CalendarAuthError(f"{self.provider} rejected a fresh access token")
            if resp.status_code == 403:
                raise CalendarAuthError(f"{self.provider} permission denied (scope or calendar access)")
            if ok_missing and resp.status_code in (404, 410):
                return {}
            if resp.status_code >= 400:
                raise CalendarError(f"{self.provider} {method} {resp.request.url.path} -> {resp.status_code}")
            return resp.json() if resp.content else {}
        raise CalendarError("unreachable")  # pragma: no cover
