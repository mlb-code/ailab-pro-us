"""Encryption for tenant credentials (OAuth refresh tokens) and signed values (OAuth state).

- `encrypt`/`decrypt`: AES-256-GCM with `CRED_KEY` (base64, 32 bytes; Railway secret only).
  Associated data binds a ciphertext to its tenant + provider, so a row copied to another
  tenant fails to decrypt. Format: "v1." + urlsafe-base64(nonce || ciphertext+tag).
- `sign`/`verify`: HMAC-SHA256 over a JSON payload with an expiry; used for OAuth `state`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VERSION = "v1"


class CryptoError(ValueError):
    pass


def _key(cred_key: str) -> bytes:
    if not cred_key:
        raise CryptoError("CRED_KEY is not configured")
    try:
        raw = base64.b64decode(cred_key, validate=True)
    except ValueError:
        raise CryptoError("CRED_KEY must be base64") from None
    if len(raw) != 32:
        raise CryptoError("CRED_KEY must decode to exactly 32 bytes")
    return raw


def _aad(tenant_id: str, provider: str) -> bytes:
    return f"{tenant_id}|{provider}".encode()


def encrypt(cred_key: str, plaintext: str, tenant_id: str, provider: str) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(_key(cred_key)).encrypt(nonce, plaintext.encode(), _aad(tenant_id, provider))
    return f"{VERSION}." + base64.urlsafe_b64encode(nonce + ct).decode().rstrip("=")


def decrypt(cred_key: str, token: str, tenant_id: str, provider: str) -> str:
    try:
        version, body = token.split(".", 1)
        if version != VERSION:
            raise CryptoError(f"unsupported ciphertext version {version!r}")
        blob = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        return AESGCM(_key(cred_key)).decrypt(blob[:12], blob[12:], _aad(tenant_id, provider)).decode()
    except CryptoError:
        raise
    except Exception:  # wrong key, wrong tenant, tampered data
        raise CryptoError("could not decrypt credential") from None


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def sign(cred_key: str, payload: dict[str, Any], ttl_s: int = 600, now: float | None = None) -> str:
    body = dict(payload, exp=int((now or time.time()) + ttl_s))
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    mac = hmac.new(_key(cred_key), raw, hashlib.sha256).digest()
    return f"{_b64(raw)}.{_b64(mac)}"


def verify(cred_key: str, token: str, now: float | None = None) -> dict[str, Any]:
    try:
        raw_b64, mac_b64 = token.split(".", 1)
        raw = base64.urlsafe_b64decode(raw_b64 + "=" * (-len(raw_b64) % 4))
        mac = base64.urlsafe_b64decode(mac_b64 + "=" * (-len(mac_b64) % 4))
    except ValueError:
        raise CryptoError("malformed signed value") from None
    if not hmac.compare_digest(mac, hmac.new(_key(cred_key), raw, hashlib.sha256).digest()):
        raise CryptoError("bad signature")
    body = json.loads(raw)
    if int(body.get("exp", 0)) < (now or time.time()):
        raise CryptoError("signed value expired")
    return body
