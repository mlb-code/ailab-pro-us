"""ADD-CHAT: the chat box on the client's own website (one `<script>` line), same brain and guard as the phone line.

    <script src="https://<runtime>/chat/widget.js" data-tenant="<slug>" async></script>

Unlike the landing-page demo (`app.webchat`, fake tenants, nothing real), this talks to the tenant's REAL runtime:
the same `Engine` (guard -> brain -> tools -> reply check) with channel "chat" (text rules of SMS: 320-char replies,
length cap, rate limits, injection as data; no SMS keywords, no SMS metering), the tenant's real calendar through
`rt.engine.calendar`, owner alerts through `rt.deliver`, `lead.created` / `booking.created` through `after_turn`.
The visitor has no caller id, so the brain asks for a mobile number before booking (`book_slot.phone`, required on
this channel) and passes any contact details to `take_message`.

Per tenant: `webchat.enabled`, an exact-origin CORS allow-list (`webchat.allowed_origins`, https only; localhost only
in the simulator), a title and a per-session message cap. Rate limits per visitor (IP hash per hour, sessions per IP
per day, one turn at a time per session, a small concurrency cap) are shared across tenants in this process.

Privacy: no IP, raw session id or message text in logs or events (salted hashes; events carry counts only). The
conversation itself lives in `runtime_state` like every SMS thread (key convo:<tenant>:chat:<id>), so the owner's
alert e-mail shows the transcript and a restart does not lose it.

Endpoints: GET /chat/widget.js · GET /chat/{slug}/config · POST /chat/{slug}/session · POST /chat/{slug}/message
· OPTIONS /chat/{slug}/...
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import threading
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ValidationError

from . import crypto, guard
from .runtime_ctx import Runtime
from .sms_outbound import after_turn
from .tenants import TenantConfigError, TenantRecord
from .voice import DISCLOSURE_PARTS
from .webchat import client_ip

log = logging.getLogger("rt.chat")
router = APIRouter()

CHANNEL = "chat"
TOKEN_PURPOSE = "chatbox"
SESSION_TTL_S = 4 * 3600
MAX_MESSAGE_CHARS = 2000
MAX_MESSAGES_PER_IP_HOUR = 90
MAX_SESSIONS_PER_IP_DAY = 40
MAX_CONCURRENT = 8
NOTICE = ("You're chatting with an AI assistant. The conversation may be saved and shared with the business so they can "
          "follow up. Please don't type card numbers or other sensitive details.")


def greeting(tenant: TenantRecord) -> str:
    """Opening line of the chat box (the phone greeting without the recording sentence; the chat shows its own notice)."""
    from .voice import default_greeting
    text = default_greeting(tenant.config)
    sentences = [s for s in text.split(". ") if not all(p.search(s) for p in DISCLOSURE_PARTS[:2])]
    out = ". ".join(sentences).replace("missed your call", "missed you").replace("Thanks for calling", "Welcome to")
    return out if out.endswith((".", "?", "!")) else out + "."


class Limited(Exception):
    def __init__(self, reason: str, status: int):
        super().__init__(reason)
        self.reason, self.status = reason, status


class ChatBoxes:
    """Per-process visitor limits + session registry for every tenant's chat box."""

    def __init__(self, rt: Runtime):
        self.rt = rt
        self.salt = secrets.token_bytes(16)
        self._lock = threading.RLock()
        self._sem = threading.BoundedSemaphore(MAX_CONCURRENT)
        self.sessions: dict[str, dict[str, Any]] = {}
        self.ip_hour: dict[tuple[str, str], int] = {}
        self.ip_day: dict[tuple[str, str], int] = {}

    def hash(self, value: str) -> str:
        return hashlib.sha256(self.salt + value.encode()).hexdigest()[:20]

    def _count(self, table: dict, key: tuple[str, str], cap: int) -> None:
        with self._lock:
            if table.get(key, 0) >= cap:
                raise Limited("ip_limit", 429)
            table[key] = table.get(key, 0) + 1
            if len(table) > 50_000:
                for k in [k for k in table if k[1] != key[1]]:
                    table.pop(k, None)

    def _sweep(self, now: datetime) -> None:
        with self._lock:
            for key in [k for k, s in self.sessions.items() if (now - s["created"]).total_seconds() > SESSION_TTL_S + 300]:
                self.sessions.pop(key, None)

    def new_session(self, tenant: TenantRecord, ip_hash: str, now: datetime) -> dict[str, Any]:
        self._sweep(now)
        self._count(self.ip_day, (ip_hash, now.date().isoformat()), MAX_SESSIONS_PER_IP_DAY)
        sid = secrets.token_urlsafe(18)
        key = self.hash(sid)
        hello = greeting(tenant)
        with self._lock:
            self.sessions[key] = {"tenant": tenant.id, "count": 0, "created": now, "lock": threading.Lock()}
        self.rt.engine.note_outbound(tenant, CHANNEL, "web-" + key, "chat-" + key, hello, prior=hello)
        self.rt.store.for_tenant(tenant.id).log_event("chat.session", {})
        token = crypto.sign(self.rt.settings.cred_key, {"p": TOKEN_PURPOSE, "sid": sid, "t": tenant.id},
                            ttl_s=SESSION_TTL_S, now=now.timestamp())
        log.info("chat session started tenant=%s", tenant.slug)
        return {"token": token, "greeting": hello, "remaining": tenant.config.webchat.max_messages_per_session}

    def message(self, tenant: TenantRecord, token: str, text: str, ip_hash: str, now: datetime) -> dict[str, Any]:
        try:
            body = crypto.verify(self.rt.settings.cred_key, token, now=now.timestamp())
        except crypto.CryptoError:
            raise Limited("bad_token", 401) from None
        if body.get("p") != TOKEN_PURPOSE or body.get("t") != tenant.id or not isinstance(body.get("sid"), str):
            raise Limited("bad_token", 401)
        key = self.hash(body["sid"])
        with self._lock:
            sess = self.sessions.get(key)
            if sess is None:  # process restarted: the conversation is in runtime_state, only the counter is new
                sess = self.sessions[key] = {"tenant": tenant.id, "count": 0, "created": now, "lock": threading.Lock()}
        cap = tenant.config.webchat.max_messages_per_session
        if not sess["lock"].acquire(blocking=False):
            raise Limited("busy", 429)
        try:
            if sess["count"] >= cap:
                raise Limited("session_limit", 429)
            self._count(self.ip_hour, (ip_hash, now.strftime("%Y-%m-%dT%H")), MAX_MESSAGES_PER_IP_HOUR)
            if not self._sem.acquire(blocking=False):
                raise Limited("busy", 429)
            try:
                sess["count"] += 1
                convo_id = "chat-" + key
                res = self.rt.engine.handle(tenant, CHANNEL, "web-" + key, text, convo_id, now)
                self.rt.deliver(tenant, res.actions, convo_id)
                c = self.rt.engine.find_convo(tenant, CHANNEL, convo_id)
                if c is not None:
                    after_turn(self.rt, tenant, c, now)
            finally:
                self._sem.release()
            booked = None
            if c is not None and c.booking:
                booked = {"label": c.booking.get("label"), "job_type": c.booking.get("job_type")}
            self.rt.store.for_tenant(tenant.id).log_event("chat.turn", {"claude_calls": res.claude_calls,
                                                                        "guard": [n.split(":")[0] for n in res.guard],
                                                                        "outcome": res.outcome})
            log.info("chat turn tenant=%s claude_calls=%d guard=%s", tenant.slug, res.claude_calls,
                     ",".join(n.split(":")[0] for n in res.guard) or "-")
            return {"reply": res.reply, "ended": bool(res.end), "booked": booked,
                    "remaining": max(0, cap - sess["count"])}
        finally:
            sess["lock"].release()


_LOCK = threading.Lock()


def boxes(request: Request) -> ChatBoxes:
    app = request.app
    with _LOCK:
        b = getattr(app.state, "chat_boxes", None)
        if b is None:
            b = ChatBoxes(app.state.rt)
            app.state.chat_boxes = b
        return b


# --- HTTP -------------------------------------------------------------------------------------------------
def _tenant(rt: Runtime, slug: str) -> TenantRecord | None:
    try:
        t = rt.store.tenant_by_slug(slug)
    except TenantConfigError:
        return None
    return t if t is not None and t.active and t.config.webchat.enabled else None


def origin_ok(request: Request, tenant: TenantRecord, rt: Runtime) -> tuple[bool, str]:
    origin = request.headers.get("origin", "")
    if not origin:
        return rt.settings.is_sim, ""  # browsers always send Origin on cross-site calls; only tests omit it
    if origin.rstrip("/") in tenant.config.webchat.allowed_origins:
        return True, origin
    parts = urlsplit(origin)
    if rt.settings.is_sim and parts.scheme == "http" and (parts.hostname or "") in ("localhost", "127.0.0.1"):
        return True, origin
    return False, ""


def _json(body: dict[str, Any], status: int, origin: str) -> JSONResponse:
    headers = {"Cache-Control": "no-store", "Vary": "Origin"}
    if origin:
        headers.update({"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "false"})
    return JSONResponse(body, status_code=status, headers=headers)


class SessionIn(BaseModel):
    page: str = Field(default="", max_length=300)  # the page the visitor is on (shown to the owner, never logged)


class MessageIn(BaseModel):
    token: str = Field(max_length=600)
    message: str = Field(max_length=MAX_MESSAGE_CHARS)


async def _body(request: Request, model: type[BaseModel]) -> BaseModel | None:
    try:
        raw = await request.body()
        if len(raw) > MAX_MESSAGE_CHARS * 4:
            return None
        return model.model_validate_json(raw or b"{}")
    except (ValidationError, ValueError):
        return None


@router.get("/chat/widget.js")
def widget_js() -> Response:
    return Response(WIDGET_JS, media_type="application/javascript; charset=utf-8",
                    headers={"Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff"})


@router.options("/chat/{slug}/{rest:path}")
def chat_preflight(slug: str, rest: str, request: Request) -> Response:
    rt: Runtime = request.app.state.rt
    tenant = _tenant(rt, slug)
    if tenant is None:
        return Response(status_code=404)
    ok, origin = origin_ok(request, tenant, rt)
    if not ok or not origin:
        return Response(status_code=403)
    return Response(status_code=204, headers={
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", "Vary": "Origin"})


@router.get("/chat/{slug}/config")
def chat_config(slug: str, request: Request) -> JSONResponse:
    rt: Runtime = request.app.state.rt
    tenant = _tenant(rt, slug)
    if tenant is None:
        return _json({"error": "not_found"}, 404, "")
    ok, origin = origin_ok(request, tenant, rt)
    if not ok:
        return _json({"error": "origin"}, 403, "")
    w = tenant.config.webchat
    return _json({"title": w.title or tenant.config.business.name, "business": tenant.config.business.name,
                  "notice": NOTICE, "max_messages": w.max_messages_per_session}, 200, origin)


@router.post("/chat/{slug}/session")
async def chat_session(slug: str, request: Request) -> JSONResponse:
    rt: Runtime = request.app.state.rt
    tenant = _tenant(rt, slug)
    if tenant is None:
        return _json({"error": "not_found"}, 404, "")
    ok, origin = origin_ok(request, tenant, rt)
    if not ok:
        return _json({"error": "origin"}, 403, "")
    if await _body(request, SessionIn) is None:
        return _json({"error": "bad_request"}, 400, origin)
    if not rt.settings.cred_key:
        return _json({"error": "not_configured"}, 503, origin)
    b = boxes(request)
    try:
        out = await run_in_threadpool(b.new_session, tenant, b.hash(client_ip(request)), rt.now())
    except Limited as exc:
        return _json({"error": exc.reason}, exc.status, origin)
    return _json(out, 200, origin)


@router.post("/chat/{slug}/message")
async def chat_message(slug: str, request: Request) -> JSONResponse:
    rt: Runtime = request.app.state.rt
    tenant = _tenant(rt, slug)
    if tenant is None:
        return _json({"error": "not_found"}, 404, "")
    ok, origin = origin_ok(request, tenant, rt)
    if not ok:
        return _json({"error": "origin"}, 403, "")
    data = await _body(request, MessageIn)
    if data is None:
        return _json({"error": "bad_request"}, 400, origin)
    b = boxes(request)
    try:
        out = await run_in_threadpool(b.message, tenant, data.token, data.message, b.hash(client_ip(request)), rt.now())
    except Limited as exc:
        return _json({"error": exc.reason}, exc.status, origin)
    except Exception:  # noqa: BLE001 - never leak details to the visitor's browser
        log.exception("chat turn failed tenant=%s", tenant.slug)
        return _json({"error": "error"}, 503, origin)
    return _json(out, 200, origin)


# --- the embeddable script (no brand strings: everything comes from /chat/{slug}/config) --------------------------
WIDGET_JS = r"""/* chat box: one script tag, data-tenant="<slug>". Vanilla JS, no dependencies. */
(function () {
  'use strict';
  var me = document.currentScript || (function (s) { return s[s.length - 1]; })(document.getElementsByTagName('script'));
  var slug = me && me.getAttribute('data-tenant');
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return;
  var base = (me.getAttribute('src') || '').replace(/\/chat\/widget\.js.*$/, '');
  var api = base + '/chat/' + slug;
  var cfg = null, token = null, busy = false, open = false, ended = false;
  var css = '.aichat-btn{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:0;border-radius:999px;padding:14px 18px;font:600 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#1b2430;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);cursor:pointer}' +
    '.aichat-btn:focus-visible{outline:3px solid #9583FF;outline-offset:2px}' +
    '.aichat-panel{position:fixed;right:16px;bottom:80px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);height:min(560px,calc(100vh - 110px));display:none;flex-direction:column;background:#fff;color:#1b2430;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow:hidden}' +
    '.aichat-panel[data-open="1"]{display:flex}' +
    '@media (max-width:480px){.aichat-panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100dvh;border-radius:0}.aichat-panel[data-open="1"]~.aichat-btn{display:none}}' +
    '.aichat-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:#1b2430;color:#fff}' +
    '.aichat-h b{font-size:15px}.aichat-h small{display:block;opacity:.8;font-size:12px;font-weight:400}' +
    '.aichat-x{border:0;background:transparent;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}.aichat-x:focus-visible{outline:2px solid #fff}' +
    '.aichat-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f4f5f7}' +
    '.aichat-m{max-width:85%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}' +
    '.aichat-m.in{align-self:flex-start;background:#fff;border:1px solid #e3e5ea;border-bottom-left-radius:4px}' +
    '.aichat-m.out{align-self:flex-end;background:#5B45E6;color:#fff;border-bottom-right-radius:4px}' +
    '.aichat-f{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e5ea;background:#fff}' +
    '.aichat-f textarea{flex:1;resize:none;border:1px solid #c9ccd4;border-radius:10px;padding:9px 10px;font:inherit;min-height:42px;max-height:120px}' +
    '.aichat-f textarea:focus-visible{outline:3px solid #9583FF;outline-offset:1px}' +
    '.aichat-send{border:0;border-radius:10px;padding:0 14px;background:#1b2430;color:#fff;font:inherit;font-weight:600;cursor:pointer;min-width:64px}.aichat-send:disabled{opacity:.5;cursor:default}.aichat-send:focus-visible{outline:3px solid #9583FF;outline-offset:2px}' +
    '.aichat-n{font-size:11px;color:#556;padding:6px 12px 10px;background:#fff}' +
    '.aichat-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '@media (prefers-reduced-motion:no-preference){.aichat-panel[data-open="1"]{animation:aichat-in .18s ease-out}@keyframes aichat-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}';
  function el(tag, attrs, text) { var e = document.createElement(tag); for (var k in attrs || {}) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); } if (text != null) e.textContent = text; return e; }
  function getJSON(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || r.status); e.code = j.error || r.status; throw e; } return j; }); });
  }
  var style = el('style'); style.textContent = css; document.head.appendChild(style);
  var btn = el('button', { class: 'aichat-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'aichat-panel' }, 'Chat with us');
  var panel = el('section', { class: 'aichat-panel', id: 'aichat-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'aichat-title', 'data-open': '0' });
  var head = el('div', { class: 'aichat-h' });
  var title = el('div'); var tb = el('b', { id: 'aichat-title' }, 'Chat'); var ts = el('small', null, 'AI assistant'); title.appendChild(tb); title.appendChild(ts);
  var x = el('button', { class: 'aichat-x', type: 'button', 'aria-label': 'Close chat' }, '×');
  head.appendChild(title); head.appendChild(x);
  var logEl = el('div', { class: 'aichat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  var form = el('form', { class: 'aichat-f' });
  var ta = el('textarea', { rows: '1', maxlength: '600', 'aria-label': 'Your message', placeholder: 'Type your message' });
  var send = el('button', { class: 'aichat-send', type: 'submit' }, 'Send');
  form.appendChild(ta); form.appendChild(send);
  var notice = el('div', { class: 'aichat-n' }, '');
  panel.appendChild(head); panel.appendChild(logEl); panel.appendChild(form); panel.appendChild(notice);
  document.body.appendChild(panel); document.body.appendChild(btn);
  function add(kind, text) { var m = el('div', { class: 'aichat-m ' + kind }); var sr = el('span', { class: 'aichat-sr' }, kind === 'in' ? 'Assistant: ' : 'You: '); m.appendChild(sr); m.appendChild(document.createTextNode(text)); logEl.appendChild(m); logEl.scrollTop = logEl.scrollHeight; return m; }
  function setOpen(v) { open = v; panel.setAttribute('data-open', v ? '1' : '0'); btn.setAttribute('aria-expanded', v ? 'true' : 'false'); if (v) { ta.focus(); } else { btn.focus(); } }
  function start() {
    if (token || busy) return; busy = true; send.disabled = true;
    getJSON(api + '/config').then(function (c) { cfg = c; tb.textContent = c.title || 'Chat'; ts.textContent = 'AI assistant for ' + (c.business || ''); notice.textContent = c.notice || ''; return getJSON(api + '/session', { page: location.pathname.slice(0, 300) }); })
      .then(function (s) { token = s.token; add('in', s.greeting); })
      .catch(function (e) { add('in', e.code === 'ip_limit' ? 'The chat is busy right now. Please call or text us instead.' : 'The chat is not available right now. Please call or text us instead.'); ended = true; })
      .then(function () { busy = false; send.disabled = ended; });
  }
  btn.addEventListener('click', function () { setOpen(!open); if (open) start(); });
  x.addEventListener('click', function () { setOpen(false); });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } });
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : send.click(); } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = ta.value.trim(); if (!text || busy || ended || !token) return;
    add('out', text); ta.value = ''; busy = true; send.disabled = true;
    var typing = add('in', '…'); typing.setAttribute('aria-hidden', 'true');
    getJSON(api + '/message', { token: token, message: text }).then(function (r) {
      typing.remove(); if (r.reply) add('in', r.reply);
      if (r.ended || r.remaining === 0) { ended = true; }
    }).catch(function (e) {
      typing.remove();
      add('in', e.code === 'session_limit' || e.code === 'ip_limit' ? 'That is the limit for this chat. Please call or text us to continue.' : 'Sorry, something went wrong. Please call or text us instead.');
      if (e.code === 'bad_token' || e.code === 'session_limit') ended = true;
    }).then(function () { busy = false; send.disabled = ended; if (!ended) ta.focus(); });
  });
})();
"""
