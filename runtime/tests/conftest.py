from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
import pytest

RUNTIME = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RUNTIME))
# Tests never talk to Claude, Twilio, Google or Supabase.
os.environ["BRAIN_MODE"] = "mock"
os.environ.pop("ANTHROPIC_API_KEY", None)

from sim import harness  # noqa: E402


@pytest.fixture
def sim(tmp_path):
    return harness.build(tmp_path)


@pytest.fixture
def demo_raw() -> dict:
    return json.loads((harness.TENANTS_DIR / "demo-hvac.json").read_text())


class FakePostgrest:
    """Just enough PostgREST for the store contract: eq./is. filters, return=representation, 2 RPCs."""

    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.creds: dict[tuple[str, str], str] = {}
        self.auth_headers: list[str] = []

    @staticmethod
    def _match(row: dict, params: dict[str, str]) -> bool:
        for k, v in params.items():
            if k == "select":
                continue
            if v == "is.null":
                if row.get(k) is not None:
                    return False
            elif v in ("is.true", "is.false"):
                if row.get(k) is not (v == "is.true"):
                    return False
            elif str(row.get(k)) != v.removeprefix("eq."):
                return False
        return True

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.auth_headers.append(request.headers.get("authorization", ""))
        path = request.url.path.removeprefix("/rest/v1/")
        params = dict(parse_qsl(request.url.query.decode()))
        if path.startswith("rpc/"):
            body = json.loads(request.content or b"{}")
            name = path[4:]
            if name == "ping":
                return httpx.Response(200, json=True)
            if name == "runtime_put_credential":
                self.creds[(body["p_tenant_id"], body["p_provider"])] = body["p_ciphertext"]
                return httpx.Response(200, content=b"null")
            if name == "runtime_get_credential":
                return httpx.Response(200, json=self.creds.get((body["p_tenant_id"], body["p_provider"])))
            return httpx.Response(404, json={"code": "PGRST202"})
        rows = self.tables.setdefault(path, [])
        if request.method == "GET":
            return httpx.Response(200, json=[r for r in rows if self._match(r, params)])
        if request.method == "POST":
            row = {"id": str(uuid.uuid4()), **json.loads(request.content)}
            rows.append(row)
            return httpx.Response(201, json=[row])
        if request.method == "PATCH":
            patch = json.loads(request.content)
            hit = [r for r in rows if self._match(r, params)]
            for r in hit:
                r.update(patch)
            return httpx.Response(200, json=hit)
        if request.method == "DELETE":
            hit = [r for r in rows if self._match(r, params)]
            self.tables[path] = [r for r in rows if r not in hit]
            return httpx.Response(200, json=hit)
        return httpx.Response(405)


@pytest.fixture
def postgrest():
    return FakePostgrest()
