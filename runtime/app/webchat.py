"""B8: live chat demo for the landing pages (`/demo/*`), a web-chat front for the real brain.

Anonymous visitors talk to the same `Engine` (guard -> brain -> tool executor -> reply check) that answers
SMS, through demo tenants that exist only in this module. Nothing here can reach a real customer system:
- the demo Engine has its own in-memory store, state and `FakeProvider` calendar (never Google/Calendly),
- engine `actions` (owner alerts, dial) are dropped: no SMS, e-mail, Zapier or call is ever started,
- the Twilio client / Outbound of the runtime are never used.

The channel is "sms" on purpose: the browser demo looks like a text thread (SPEC 2.2), so the brain uses its
text-message prompt and every SMS guard rule (length, rate, STOP, injection as data, reply check) applies
unchanged. guard.py and brain.py are not modified.

Limits (brand.json `demo.*`, defaults below): messages per session, messages per IP per hour, sessions per IP
per day, concurrent turns, and one daily USD budget across all demo niches, kept durable in `runtime_state`
(key `demo:spend:<utc day>`). Over a limit -> HTTP 429/503 with `{"paused": true, "reason": ...}` and the page
falls back to the scripted demo. Kill switch: env `DEMO_LIVE=0`.

Privacy: no IP or raw session id is stored (salted hashes, salt per process; IPv6 limited per /64). Everything
a visitor typed lives only in the demo's in-memory store. A sweeper thread (every DEMO_SWEEP_SECONDS, 60) deletes
a session's transcript, booking row, fake calendar event and ledger entry 5 minutes after the token expires
(35 min with the default TTL) and rebuilds the whole demo backend every `retention_hours` (<= 24), with or
without traffic. Nothing about the conversation is logged. Demo spend also counts toward GLOBAL_DAILY_BUDGET_USD.

Endpoints: GET /demo/status · POST /demo/session {niche} · POST /demo/chat {token, message} · OPTIONS (CORS).
CORS: brand `site_url`, its www variant and `demo.allowed_origins`; localhost only when RUNTIME_MODE=sim.
"""
from __future__ import annotations

import hashlib
import ipaddress
import logging
import os
import secrets
import threading
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ValidationError

from . import crypto
from . import settings as settings_mod
from .calendar.fake import FakeProvider
from .conversation import Engine
from .store import JsonStore, StateStore, StoreError
from .tenants import TenantRecord, load_record

log = logging.getLogger("rt.webchat")
router = APIRouter()

CHANNEL = "sms"  # text-thread prompt + SMS guard rules (see module docstring)
TOKEN_PURPOSE = "webchat"
DEFAULTS: dict[str, Any] = {
    "daily_budget_usd": 3.0,
    "max_messages_per_session": 20,
    "max_messages_per_ip_hour": 60,
    "max_sessions_per_ip_day": 60,
    "max_concurrent": 4,
    "session_ttl_minutes": 30,
    "retention_hours": 24,
    "live_niches": ["home_services", "real_estate"],
    "allowed_origins": [],
}
LIVE_CAPABLE = ("home_services", "real_estate")  # dental stays scripted-only (no BAA, early access)
MAX_MESSAGE_CHARS = 2000  # transport cap; guard answers anything over 600 chars with a fixed reply

PAUSED_NOTE = "Live demo paused"


def demo_config() -> dict[str, Any]:
    """brand.json `demo` merged over DEFAULTS, with types coerced and caps clamped to sane ranges."""
    raw = settings_mod.brand().get("demo") or {}
    cfg = dict(DEFAULTS)
    if isinstance(raw, dict):
        cfg.update({k: v for k, v in raw.items() if k in DEFAULTS})

    def num(key: str, lo: float, hi: float, cast=float):
        try:
            return cast(min(hi, max(lo, float(cfg[key]))))
        except (TypeError, ValueError):
            return cast(DEFAULTS[key])

    cfg["daily_budget_usd"] = num("daily_budget_usd", 0, 50)
    cfg["max_messages_per_session"] = num("max_messages_per_session", 1, 100, int)
    cfg["max_messages_per_ip_hour"] = num("max_messages_per_ip_hour", 1, 1000, int)
    cfg["max_sessions_per_ip_day"] = num("max_sessions_per_ip_day", 1, 1000, int)
    cfg["max_concurrent"] = num("max_concurrent", 1, 32, int)
    cfg["session_ttl_minutes"] = num("session_ttl_minutes", 5, 240, int)
    cfg["retention_hours"] = num("retention_hours", 1, 24)
    niches = cfg["live_niches"] if isinstance(cfg["live_niches"], list) else DEFAULTS["live_niches"]
    cfg["live_niches"] = [n for n in niches if n in LIVE_CAPABLE]
    extra = cfg["allowed_origins"] if isinstance(cfg["allowed_origins"], list) else []
    cfg["allowed_origins"] = [str(o).rstrip("/") for o in extra if str(o).startswith("https://")]
    return cfg


# --- demo tenants (they exist only here; never in the tenants table) --------------------------------------
def _tenant(niche: str, budget: float, max_session: int) -> TenantRecord:
    common = {
        "voice": {"tts_voice": "Polly.Joanna-Neural", "greeting": "", "languages": ["en"]},
        "after_hours": {"mode": "book_next_day"},
        "pricing": {"mode": "none", "items": []},
        "handoff": {"mode": "message", "number": None, "hours": "business"},
        "notify": {"sms": [], "email": ["demo@example.com"], "daily_summary": None},  # never delivered
        "zapier": {"webhook_url": None, "events": []},
        # The engine's own per-tenant budget mirrors the demo budget (defense in depth); per-contact reply caps
        # sit above the session cap so the session cap is what visitors meet.
        "guard": {"daily_budget_usd": max(budget, 0.01), "blocklist": [],
                  "max_replies_10min": max_session + 5, "max_replies_day": max_session + 10},
        "paused": False,
    }
    if niche == "home_services":
        cfg = {
            "business": {"name": "Copperleaf Air & Plumbing", "niche": "home_services", "trade": "heating, air and plumbing",
                         "timezone": "America/Chicago", "main_phone": "+17135550100",
                         "service_area_zips": ["77002", "77003", "77004", "77005", "77006", "77007", "77008",
                                               "77019", "77024", "77027", "77030", "77056", "77057", "77098"]},
            "hours": {"mon": ["07:00", "19:00"], "tue": ["07:00", "19:00"], "wed": ["07:00", "19:00"],
                      "thu": ["07:00", "19:00"], "fri": ["07:00", "19:00"], "sat": ["08:00", "14:00"], "sun": None},
            "booking": {"provider": "fake", "calendar_id": "primary", "windows": [["08:00", "12:00"], ["12:00", "16:00"]],
                        "lead_time_hours": 2, "max_per_window": 3, "days_ahead": 7,
                        "job_types": ["AC repair", "Heating repair", "Plumbing repair", "Water heater service",
                                      "Maintenance", "New system estimate"], "booking_link": None},
            "faq": [
                {"q": "Which brands do you service?", "a": "All major brands, including Trane, Carrier, Lennox and Rheem."},
                {"q": "Do you offer maintenance plans?", "a": "Yes, a yearly plan with two tune-ups."},
                {"q": "Are you licensed and insured?", "a": "Yes, licensed and insured in Texas."},
            ],
            "emergency": {"keywords": ["gas smell", "carbon monoxide"], "dial": None},
        }
    else:
        cfg = {
            "business": {"name": "Maple & Main Realty", "niche": "real_estate", "trade": "real estate",
                         "timezone": "America/Chicago", "main_phone": "+15125550180",
                         "service_area_zips": ["78701", "78702", "78703", "78704", "78705", "78723", "78731",
                                               "78745", "78746", "78751", "78756", "78757"]},
            "hours": {"mon": ["09:00", "18:00"], "tue": ["09:00", "18:00"], "wed": ["09:00", "18:00"],
                      "thu": ["09:00", "18:00"], "fri": ["09:00", "18:00"], "sat": ["10:00", "16:00"], "sun": None},
            "booking": {"provider": "fake", "calendar_id": "primary", "windows": [["10:00", "12:00"], ["13:00", "15:00"],
                                                                             ["15:00", "17:00"]],
                        "lead_time_hours": 3, "max_per_window": 2, "days_ahead": 7,
                        "job_types": ["Home showing", "Buyer consultation", "Home value consultation",
                                      "Listing appointment"], "booking_link": None},
            "faq": [
                {"q": "Is 1420 Oak Ridge Dr still available?",
                 "a": "Yes, 1420 Oak Ridge Dr (ZIP 78704) is still active. Jenna can show it; I can book a showing."},
                {"q": "Who will I meet?", "a": "Jenna Harper, a licensed agent with Maple & Main Realty."},
                {"q": "Do you work with first-time buyers?", "a": "Yes, Jenna works with many first-time buyers."},
            ],
            "emergency": {"keywords": [], "dial": None},
        }
    slug = "demo-" + niche.replace("_", "-")
    tid = "00000000-0000-4000-8000-00000000d0" + ("01" if niche == "home_services" else "02")
    return load_record({"id": tid, "slug": slug, "status": "sandbox", "twilio_number": None, "client_id": None,
                        "config": {**common, **cfg}})


def greeting(tenant: TenantRecord) -> str:
    b = tenant.config.business
    if b.niche == "real_estate":
        return (f"Hi, this is Jenna Harper's assistant at {b.name}. Sorry Jenna missed you! "
                "I'm the virtual assistant and I can help right now. What are you calling about?")
    return (f"Hi, this is {b.name}. Sorry we missed your call! I'm the virtual assistant and I can get you booked. "
            "What's going on?")


class MemoryStore(JsonStore):
    """JsonStore semantics, kept in process memory only (never written to disk)."""

    name = "memory"

    def __init__(self) -> None:  # noqa: D107 - no directory on purpose
        self._lock = threading.RLock()
        self._tables: dict[str, list[dict[str, Any]]] = {}

    def _read(self, table):
        self._check_table(table)
        return [dict(r) for r in self._tables.get(table, [])]

    def _write(self, table, rows):
        self._tables[table] = rows

    def ping(self):
        return True


# --- the backend ------------------------------------------------------------------------------------------
class Paused(Exception):
    def __init__(self, reason: str, status: int):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class DemoBackend:
    def __init__(self, rt: Any):
        self.rt = rt
        self.cfg = demo_config()
        self._lock = threading.RLock()
        self._sem = threading.BoundedSemaphore(self.cfg["max_concurrent"])
        self._rebuild(rt.now())
        self._stop = threading.Event()
        self._sweeper = None
        interval = float(os.environ.get("DEMO_SWEEP_SECONDS", "60") or 60)
        if interval > 0:  # deletion must not depend on visitor traffic
            self._sweeper = threading.Thread(target=self._sweep_loop, args=(interval,), name="demo-sweep", daemon=True)
            self._sweeper.start()

    def _sweep_loop(self, interval: float) -> None:
        while not self._stop.wait(interval):
            try:
                self.maybe_rotate(self.rt.now())
            except Exception:  # noqa: BLE001 - the sweeper must survive a bad pass
                log.exception("demo sweep failed")

    def stop(self) -> None:
        self._stop.set()

    def _rebuild(self, now: datetime) -> None:
        """A fresh generation: in-memory store, state, calendar, engine, sessions and counters."""
        self.born = now
        self.salt = secrets.token_bytes(16)
        self.store = MemoryStore()
        self.state = StateStore(self.store, memory_fallback=True)
        self.calendar = FakeProvider(self.store, self.state)
        self.engine = Engine(self.store, self.rt.engine.llm, self.calendar, self.rt.settings, state=self.state)
        self.tenants = {n: _tenant(n, self.cfg["daily_budget_usd"], self.cfg["max_messages_per_session"])
                        for n in self.cfg["live_niches"]}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.ip_hour: dict[tuple[str, str], int] = {}
        self.ip_day: dict[tuple[str, str], int] = {}

    def maybe_rotate(self, now: datetime) -> None:
        """Rebuild everything after `retention_hours`; drop finished sessions (and their transcripts) sooner."""
        with self._lock:
            if now - self.born >= timedelta(hours=self.cfg["retention_hours"]):
                self._rebuild(now)
                return
            ttl = timedelta(minutes=self.cfg["session_ttl_minutes"] + 5)
            for key in [k for k, s in self.sessions.items() if now - s["created"] > ttl]:
                sess = self.sessions.pop(key)
                tenant = self.tenants.get(sess["niche"])
                if tenant is None:
                    continue
                self._forget_booking(tenant, key, now)
                self.engine.convos.pop((tenant.id, CHANNEL, key), None)
                for skey in (self.engine._convo_key(tenant.id, CHANNEL, key),
                             f"limit:{tenant.id}:{Engine._who('web-' + key)}"):
                    self.store.delete("runtime_state", key=skey)

    def _forget_booking(self, tenant: TenantRecord, key: str, now: datetime) -> None:
        """Delete what a finished session booked: the bookings row, the fake calendar event and its ledger entry."""
        contact = "web-" + key
        convo = self.engine.find_convo(tenant, CHANNEL, key)
        event_id = (convo.booking or {}).get("event_id") if convo else None
        self.store.delete("bookings", tenant_id=tenant.id, contact_e164=contact)
        self.store.delete("opt_outs", tenant_id=tenant.id, contact_e164=contact)
        if event_id:
            self.calendar.events.pop(event_id, None)
            rows = [r for r in self.calendar.ledger(tenant.id) if r.get("event_id") != event_id]
            self.calendar._save_ledger(tenant.id, rows, now)

    def hash(self, value: str) -> str:
        return hashlib.sha256(self.salt + value.encode()).hexdigest()[:20]

    # budget: durable across restarts, shared by all demo niches
    @staticmethod
    def spend_key(now: datetime) -> str:
        return f"demo:spend:{now.date().isoformat()}"

    def spent(self, now: datetime) -> float:
        try:
            return float(self.rt.state.get(self.spend_key(now), 0) or 0)
        except StoreError:
            return float("inf")  # cannot read the budget -> fail closed

    def availability(self, now: datetime) -> str:
        """'' when live, else the pause reason."""
        if os.environ.get("DEMO_LIVE", "1").strip().lower() in ("0", "false", "off", "no"):
            return "disabled"
        if not self.rt.settings.cred_key:
            return "not_configured"
        if not self.tenants:
            return "disabled"
        if self.spent(now) >= self.cfg["daily_budget_usd"]:
            return "budget"
        try:  # the runtime-wide daily cap (GLOBAL_DAILY_BUDGET_USD) also stops the demo
            if self.rt.engine.global_spend(now.date().isoformat()) >= self.rt.settings.global_daily_budget_usd:
                return "budget"
        except StoreError:
            return "budget"
        return ""

    def _count(self, table: dict, key: tuple[str, str], cap: int) -> None:
        with self._lock:
            if table.get(key, 0) >= cap:
                raise Paused("ip_limit", 429)
            table[key] = table.get(key, 0) + 1
            if len(table) > 50_000:  # bounded memory under a flood of distinct IPs
                for k in [k for k in table if k[1] != key[1]]:
                    table.pop(k, None)

    def new_session(self, niche: str, ip_hash: str, now: datetime) -> dict[str, Any]:
        self.maybe_rotate(now)
        reason = self.availability(now)
        if reason:
            raise Paused(reason, 503)
        tenant = self.tenants.get(niche)
        if tenant is None:
            raise Paused("niche_not_live", 404)
        self._count(self.ip_day, (ip_hash, now.date().isoformat()), self.cfg["max_sessions_per_ip_day"])
        sid = secrets.token_urlsafe(18)
        key = self.hash(sid)
        hello = greeting(tenant)
        with self._lock:
            self.sessions[key] = {"niche": niche, "count": 0, "created": now, "lock": threading.Lock()}
        self.engine.note_outbound(tenant, CHANNEL, "web-" + key, key, hello, prior=hello)
        token = crypto.sign(self.rt.settings.cred_key, {"p": TOKEN_PURPOSE, "sid": sid, "n": niche},
                            ttl_s=self.cfg["session_ttl_minutes"] * 60, now=now.timestamp())
        log.info("demo session started niche=%s", niche)
        return {"token": token, "niche": niche, "business": tenant.config.business.name, "greeting": hello,
                "remaining": self.cfg["max_messages_per_session"]}

    def chat(self, token: str, message: str, ip_hash: str, now: datetime) -> dict[str, Any]:
        self.maybe_rotate(now)
        try:
            body = crypto.verify(self.rt.settings.cred_key, token, now=now.timestamp())
        except crypto.CryptoError:
            raise Paused("bad_token", 401) from None
        if body.get("p") != TOKEN_PURPOSE or not isinstance(body.get("sid"), str):
            raise Paused("bad_token", 401)
        key = self.hash(body["sid"])
        sess = self.sessions.get(key)
        if sess is None or sess["niche"] != body.get("n"):
            raise Paused("session_expired", 409)  # demo backend was rotated or restarted: start a new session
        reason = self.availability(now)
        if reason:
            raise Paused(reason, 503)
        tenant = self.tenants[sess["niche"]]
        if not sess["lock"].acquire(blocking=False):
            raise Paused("busy", 429)  # one turn at a time per session
        try:
            if sess["count"] >= self.cfg["max_messages_per_session"]:
                raise Paused("session_limit", 429)
            self._count(self.ip_hour, (ip_hash, now.strftime("%Y-%m-%dT%H")), self.cfg["max_messages_per_ip_hour"])
            if not self._sem.acquire(blocking=False):
                raise Paused("busy", 429)
            try:
                sess["count"] += 1
                result = self.engine.handle(tenant, CHANNEL, "web-" + key, message, key, now)
            finally:
                self._sem.release()
            if result.cost_usd:
                try:
                    self.rt.state.incr(self.spend_key(now), result.cost_usd)
                    self.rt.state.incr(f"spend:global:{now.date().isoformat()}", result.cost_usd)  # counts in GLOBAL_DAILY_BUDGET_USD
                except StoreError:
                    log.warning("demo spend could not be recorded")
            convo = self.engine.find_convo(tenant, CHANNEL, key)
            booked = None
            if convo and convo.booking:
                booked = {"label": convo.booking.get("label"), "job_type": convo.booking.get("job_type")}
            log.info("demo turn niche=%s claude_calls=%d guard=%s", sess["niche"], result.claude_calls,
                     ",".join(n.split(":")[0] for n in result.guard) or "-")
            return {"reply": result.reply, "ended": bool(result.end), "booked": booked,
                    "remaining": max(0, self.cfg["max_messages_per_session"] - sess["count"])}
        finally:
            sess["lock"].release()


_BACKEND_LOCK = threading.Lock()


def backend(request: Request) -> DemoBackend:
    app = request.app
    with _BACKEND_LOCK:
        be = getattr(app.state, "webchat", None)
        if be is None:
            be = DemoBackend(app.state.rt)
            app.state.webchat = be
        return be


# --- HTTP -------------------------------------------------------------------------------------------------
def _origin_of(url: str) -> str:
    parts = urlsplit(url or "")
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""


def allowed_origins(cfg: dict[str, Any]) -> set[str]:
    b = settings_mod.brand()
    out = set(cfg["allowed_origins"])
    site = _origin_of(str(b.get("site_url") or ""))
    if site:
        out.add(site)
    domain = str(b.get("domain") or "").strip()
    if domain:
        out.update({f"https://{domain}", f"https://www.{domain}"})
    return out


def _origin_ok(request: Request, be: DemoBackend) -> tuple[bool, str]:
    origin = request.headers.get("origin", "")
    if not origin:
        return be.rt.settings.is_sim, ""  # browsers always send Origin on these calls; only tests/sim omit it
    if origin in allowed_origins(be.cfg):
        return True, origin
    host = urlsplit(origin).hostname or ""
    if be.rt.settings.is_sim and urlsplit(origin).scheme == "http" and host in ("localhost", "127.0.0.1"):
        return True, origin
    return False, ""


def _json(body: dict[str, Any], status: int, origin: str) -> JSONResponse:
    headers = {"Cache-Control": "no-store", "Vary": "Origin"}
    if origin:
        headers.update({"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "false"})
    return JSONResponse(body, status_code=status, headers=headers)


def _paused(p: Paused, origin: str) -> JSONResponse:
    return _json({"paused": True, "reason": p.reason, "note": PAUSED_NOTE}, p.status, origin)


def ip_bucket(ip: str) -> str:
    """Rate-limit unit: an IPv4 address, or the /64 of an IPv6 address (one subscriber usually owns a whole /64)."""
    try:
        addr = ipaddress.ip_address(ip.strip("[]"))
    except ValueError:
        return ip
    if addr.version == 6:
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def client_ip(request: Request) -> str:
    """Railway's edge appends the connecting address as the LAST X-Forwarded-For entry; earlier ones are client-set."""
    xff = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    if xff:
        return ip_bucket(xff[-1])
    return ip_bucket(request.client.host) if request.client else "unknown"


class SessionIn(BaseModel):
    niche: str = Field(max_length=40)


class ChatIn(BaseModel):
    token: str = Field(max_length=600)
    message: str = Field(max_length=MAX_MESSAGE_CHARS)


@router.options("/demo/{rest:path}")
def demo_preflight(rest: str, request: Request) -> Response:
    be = backend(request)
    ok, origin = _origin_ok(request, be)
    if not ok or not origin:
        return Response(status_code=403)
    return Response(status_code=204, headers={
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", "Vary": "Origin"})


@router.get("/demo/status")
def demo_status(request: Request) -> JSONResponse:
    be = backend(request)
    ok, origin = _origin_ok(request, be)
    if not ok:
        return _json({"live": False, "reason": "origin"}, 403, "")
    now = be.rt.now()
    be.maybe_rotate(now)
    reason = be.availability(now)
    return _json({"live": not reason, "reason": reason, "niches": sorted(be.tenants) if not reason else [],
                  "max_messages_per_session": be.cfg["max_messages_per_session"]}, 200, origin)


async def _body(request: Request, model: type[BaseModel]) -> BaseModel | None:
    try:
        raw = await request.body()
        if len(raw) > MAX_MESSAGE_CHARS * 4:
            return None
        return model.model_validate_json(raw or b"{}")
    except (ValidationError, ValueError):
        return None


@router.post("/demo/session")
async def demo_session(request: Request) -> JSONResponse:
    be = backend(request)
    ok, origin = _origin_ok(request, be)
    if not ok:
        return _json({"error": "origin"}, 403, "")
    data = await _body(request, SessionIn)
    if data is None:
        return _json({"error": "bad_request"}, 400, origin)
    now = be.rt.now()
    try:
        out = await run_in_threadpool(be.new_session, data.niche, be.hash(client_ip(request)), now)
    except Paused as p:
        return _paused(p, origin)
    return _json(out, 200, origin)


@router.post("/demo/chat")
async def demo_chat(request: Request) -> JSONResponse:
    be = backend(request)
    ok, origin = _origin_ok(request, be)
    if not ok:
        return _json({"error": "origin"}, 403, "")
    data = await _body(request, ChatIn)
    if data is None:
        return _json({"error": "bad_request"}, 400, origin)
    now = be.rt.now()
    try:
        out = await run_in_threadpool(be.chat, data.token, data.message, be.hash(client_ip(request)), now)
    except Paused as p:
        return _paused(p, origin)
    except Exception:  # noqa: BLE001 - the page falls back to the scripted demo on any server problem
        log.exception("demo turn failed")
        return _paused(Paused("error", 503), origin)
    return _json(out, 200, origin)
