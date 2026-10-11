"""Offline fakes for B5/B6 tests: Google Calendar, Calendly, their token endpoints, Resend, Zapier.

Response bodies start from recorded-shape fixtures in tests/fixtures/b5/ and are filled in with the
fake's state, so the adapters are exercised against realistic payloads. No real network, ever:
everything goes through httpx.MockTransport. (No tests in this module; helpers only.)
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timedelta, time, timezone
from pathlib import Path
from urllib.parse import parse_qsl
from zoneinfo import ZoneInfo

import httpx

FIX = Path(__file__).resolve().parent / "fixtures" / "b5"
CAL_API = "https://api.calendly.com"
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))


def fixture(name: str) -> dict:
    return json.loads((FIX / f"{name}.json").read_text())


def _dt(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


class FakeUpstream:
    """One MockTransport handler for Google + Calendly + token endpoints (+ optional extra hosts)."""

    def __init__(self, tz: str = "America/Chicago"):
        self.tz = ZoneInfo(tz)
        self.requests: list[httpx.Request] = []
        # google
        self.g_valid = {"ya29.FAKE-access-1", "ya29.FAKE-access-refreshed"}
        self.g_revoked = False
        self.g_events: dict[str, dict] = {}
        self.g_refreshes = 0
        # calendly
        self.c_valid = {"eyFAKE.calendly.access.1"}
        self.c_revoked = False
        self.c_refreshes = 0
        self.c_busy: list[tuple[datetime, datetime]] = []
        self.c_events: dict[str, dict] = {}
        self.c_invitees: list[dict] = []
        self.down = False
        self.extra = None  # callable(request) -> Response | None

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport)

    # --- helpers for tests ---------------------------------------------------------------------
    def owner_busy(self, start: datetime, end: datetime, provider: str) -> None:
        if provider == "google":
            ev = fixture("google_event_template")
            ev.update(id=f"owner{uuid.uuid4().hex[:8]}", summary="Owner block",
                      start={"dateTime": start.isoformat()}, end={"dateTime": end.isoformat()})
            self.g_events[ev["id"]] = ev
        else:
            self.c_busy.append((start, end))

    def created(self, provider: str) -> list[dict]:
        if provider == "google":
            return [e for e in self.g_events.values() if e.get("extendedProperties")]
        return [dict(i, status=self.c_events[i["event"]]["status"]) for i in self.c_invitees]

    # --- dispatcher ------------------------------------------------------------------------------
    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.extra:
            resp = self.extra(request)
            if resp is not None:
                return resp
        if self.down:
            return httpx.Response(503)
        host, path = request.url.host, request.url.path
        if host == "oauth2.googleapis.com":
            return self._g_token(request)
        if host == "auth.calendly.com":
            return self._c_token(request)
        if host == "www.googleapis.com":
            return self._google(request, path)
        if host == "api.calendly.com":
            return self._calendly(request, path)
        return httpx.Response(404)

    # --- google ----------------------------------------------------------------------------------
    def _g_token(self, request):
        form = dict(parse_qsl(request.content.decode()))
        if form.get("grant_type") == "authorization_code":
            if form.get("code") != "good-code" or not form.get("code_verifier"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json=fixture("google_token_code"))
        if form.get("grant_type") == "refresh_token":
            self.g_refreshes += 1
            if self.g_revoked or form.get("refresh_token") != "1//FAKE-refresh-google":
                return httpx.Response(400, json=fixture("google_token_invalid_grant"))
            return httpx.Response(200, json=fixture("google_token_refresh"))
        return httpx.Response(400, json={"error": "unsupported_grant_type"})

    def _google(self, request, path):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in self.g_valid:
            return httpx.Response(401, json={"error": {"code": 401, "message": "Invalid Credentials"}})
        prefix = "/calendar/v3/calendars/primary/events"
        if not path.startswith(prefix):
            return httpx.Response(404)
        rest = path[len(prefix):].strip("/")
        q = dict(request.url.params)
        if request.method == "GET" and not rest:
            lo, hi = _dt(q["timeMin"]), _dt(q["timeMax"])
            body = fixture("google_events_list")
            body["items"] = [e for e in self.g_events.values()
                             if e["status"] != "cancelled" and _dt(e["start"]["dateTime"]) < hi
                             and _dt(e["end"]["dateTime"]) > lo]
            return httpx.Response(200, json=body)
        if request.method == "POST" and not rest:
            data = json.loads(request.content)
            ev = fixture("google_event_template")
            ev.update(data, id=uuid.uuid4().hex[:20])
            self.g_events[ev["id"]] = ev
            return httpx.Response(200, json=ev)
        if request.method == "DELETE" and rest:
            ev = self.g_events.get(rest)
            if not ev or ev["status"] == "cancelled":
                return httpx.Response(410, json={"error": {"code": 410, "message": "Resource has been deleted"}})
            ev["status"] = "cancelled"
            return httpx.Response(204)
        return httpx.Response(405)

    # --- calendly --------------------------------------------------------------------------------
    def _c_token(self, request):
        form = dict(parse_qsl(request.content.decode()))
        if form.get("grant_type") == "authorization_code":
            if form.get("code") != "good-code":
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json=fixture("calendly_token_code"))
        if form.get("grant_type") == "refresh_token":
            self.c_refreshes += 1
            if self.c_revoked:
                return httpx.Response(400, json={"error": "invalid_grant", "error_description": "revoked"})
            new = f"eyFAKE.calendly.access.{self.c_refreshes + 1}"
            self.c_valid.add(new)
            tok = fixture("calendly_token_code")
            tok.update(access_token=new, refresh_token=f"FAKE-calendly-refresh-{self.c_refreshes + 1}")
            return httpx.Response(200, json=tok)
        return httpx.Response(400)

    def _open_starts(self, lo: datetime, hi: datetime) -> list[datetime]:
        out, day = [], lo.astimezone(self.tz).date()
        while datetime.combine(day, time(0), self.tz) < hi:
            if day.weekday() < 6:  # Calendly event type: Mon-Sat 07:00-17:30, every 30 min, 60-min visits
                t = datetime.combine(day, time(7), self.tz)
                while t.time() <= time(17, 30):
                    end = t + timedelta(hours=1)
                    taken = any(e["status"] == "active" and _dt(e["start_time"]) < end and _dt(e["end_time"]) > t
                                for e in self.c_events.values())
                    busy = any(b0 < end and b1 > t for b0, b1 in self.c_busy)
                    if lo <= t < hi and not taken and not busy:
                        out.append(t)
                    t += timedelta(minutes=30)
            day += timedelta(days=1)
        return out

    def _calendly(self, request, path):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in self.c_valid:
            return httpx.Response(401, json={"title": "Unauthenticated", "message": "The access token is invalid"})
        q = dict(request.url.params)
        if path == "/users/me":
            return httpx.Response(200, json=fixture("calendly_users_me"))
        if path == "/event_types":
            return httpx.Response(200, json=fixture("calendly_event_types"))
        if path == "/event_type_available_times":
            lo, hi = _dt(q["start_time"]), _dt(q["end_time"])
            if hi - lo > timedelta(days=7) or q.get("event_type") != f"{CAL_API}/event_types/FAKEET0001":
                return httpx.Response(400, json={"title": "Invalid Argument"})
            coll = [{"status": "available", "invitees_remaining": 1,
                     "start_time": s.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "scheduling_url": "https://calendly.com/dani-owner/service-visit"} for s in self._open_starts(lo, hi)]
            return httpx.Response(200, json={"collection": coll})
        if path == "/invitees" and request.method == "POST":
            data = json.loads(request.content)
            start = _dt(data["start_time"])
            if not data.get("invitee", {}).get("email") or start not in self._open_starts(start, start + timedelta(minutes=1)):
                return httpx.Response(400, json={"title": "Invalid Argument", "message": "time not available"})
            ev_uri = f"{CAL_API}/scheduled_events/{uuid.uuid4().hex[:16]}"
            self.c_events[ev_uri] = {"status": "active", "start_time": data["start_time"],
                                     "end_time": (start + timedelta(hours=1)).isoformat()}
            res = copy.deepcopy(fixture("calendly_invitee_created"))
            res["resource"].update(uri=f"{ev_uri}/invitees/{uuid.uuid4().hex[:8]}", event=ev_uri,
                                   name=data["invitee"]["name"], email=data["invitee"]["email"])
            self.c_invitees.append({**data, "event": ev_uri})
            return httpx.Response(201, json=res)
        if path.startswith("/scheduled_events/") and path.endswith("/cancellation"):
            uri = f"{CAL_API}{path.removesuffix('/cancellation')}"
            ev = self.c_events.get(uri)
            if not ev or ev["status"] != "active":
                return httpx.Response(404, json={"title": "Resource Not Found"})
            ev["status"] = "canceled"
            return httpx.Response(201, json={"resource": {"canceled_by": "AI receptionist", "reason": "x"}})
        return httpx.Response(404)
