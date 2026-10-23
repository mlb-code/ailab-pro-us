"""Streaming voice transport: Twilio ConversationRelay over a WebSocket (production default).

/voice/incoming answers with
    <Connect action="/voice/relay-end"><ConversationRelay url="wss://.../voice/relay?t=TOKEN" .../></Connect>
Twilio runs streaming STT + TTS; we exchange JSON over the socket:
    in : setup {callSid, from, to} | prompt {voicePrompt, last} | interrupt | dtmf | error
    out: text {token, last, interruptible} | end {handoffData}
The welcome greeting (with the call notice, `voice.DISCLOSURE`) is spoken by Twilio from the TwiML with
welcomeGreetingInterruptible="none" (the caller cannot cut it off), and a prompt that arrives while it is
still playing (estimated from its length) is held until it has ended: nothing the caller says reaches
Claude before the notice is complete (SA §8, "AI and recording notice").
After `end`, Twilio requests the Connect action (/voice/relay-end) with HandoffData: we answer
<Dial> (handoff / urgent line) or <Hangup>. If the relay session fails, /voice/relay-end
continues the same call in turn-based <Gather> mode (same conversation state).

Security: the socket is accepted only with (1) a valid X-Twilio-Signature over the wss URL and
(2) a short-lived HMAC token in the URL bound to this call (CRED_KEY), checked again against the
setup message's callSid. Silence: no prompt within VOICE_SILENCE_SECONDS (+ estimated speaking
time of our last sentence) counts as a silent turn.

Latency: Claude's reply is streamed and spoken sentence by sentence (app.speech): every guarded
sentence goes out as a non-final `text` token as soon as it is complete, then an empty `last` token
closes the reply. Each turn records (total, llm) ms and, for Claude turns, the time to the first
sentence and its Claude share; server time = total - Claude (target p95 < 150 ms). End-to-end
< 1 s = STT final + server + Claude to first sentence + Twilio TTS start (docs/reports/VOICE-LATENCY.md).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Request, WebSocket
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from starlette.websockets import WebSocketDisconnect
from twilio.request_validator import RequestValidator
from twilio.twiml.voice_response import VoiceResponse

from . import crypto
from .runtime_ctx import Runtime
from .tenants import TenantConfigError, TenantRecord, load_record
from .voice import (DIAL_TIMEOUT_S, REPEAT_TEXT, TWIML, greeting, twiml_gather, twiml_say_hangup)

log = logging.getLogger("rt.voice_stream")

TOKEN_TTL_S = 900


def ws_base(rt: Runtime, request_or_ws: Any) -> str:
    base = rt.settings.public_base_url
    if not base:
        h = request_or_ws.headers
        scheme = h.get("x-forwarded-proto") or request_or_ws.url.scheme
        base = f"{scheme}://{h.get('host', 'localhost')}"
    return base.replace("https://", "wss://", 1).replace("http://", "ws://", 1)


def tts(tenant: TenantRecord) -> tuple[str, str]:
    voice = tenant.config.voice.tts_voice
    if voice.startswith("Polly."):
        return "Amazon", voice.removeprefix("Polly.")
    return "ElevenLabs", voice


def relay_twiml(rt: Runtime, request: Request, tenant: TenantRecord, call_sid: str) -> str:
    token = crypto.sign(rt.settings.cred_key, {"c": call_sid, "t": tenant.id}, ttl_s=TOKEN_TTL_S)
    provider, voice = tts(tenant)
    vr = VoiceResponse()
    connect = vr.connect(action="/voice/relay-end", method="POST")
    connect.conversation_relay(
        url=f"{ws_base(rt, request)}/voice/relay?t={token}", welcome_greeting=greeting(tenant),
        welcome_greeting_interruptible="none", interruptible="speech", language="en-US",
        tts_provider=provider, voice=voice, transcription_provider="Deepgram", dtmf_detection=False)
    return str(vr)


def speaking_seconds(rt: Runtime, text: str) -> float:
    return len((text or "").split()) / max(rt.settings.voice_tts_wps, 0.1)


router = APIRouter()


@router.websocket("/voice/relay")
async def voice_relay(ws: WebSocket) -> None:
    rt: Runtime = ws.app.state.rt
    token = ws.query_params.get("t", "")
    url = f"{ws_base(rt, ws)}{ws.url.path}?{ws.url.query}"
    sig = ws.headers.get("x-twilio-signature", "")
    auth = rt.settings.twilio_auth_token
    try:
        claims = crypto.verify(rt.settings.cred_key, token) if rt.settings.cred_key else None
    except crypto.CryptoError:
        claims = None
    if not (auth and sig and claims and RequestValidator(auth).validate(url, {}, sig)):
        log.warning("relay socket refused (signature or token)")
        await ws.close(code=1008)
        return
    rows = rt.store.select("tenants", id=claims["t"])
    try:
        tenant = load_record(rows[0]) if rows else None
    except TenantConfigError:
        tenant = None
    if tenant is None or not tenant.active:
        await ws.close(code=1008)
        return
    await ws.accept()
    await RelaySession(rt, tenant, claims["c"], ws).run()


class RelaySession:
    def __init__(self, rt: Runtime, tenant: TenantRecord, call_sid: str, ws: WebSocket):
        self.rt, self.tenant, self.call_sid, self.ws = rt, tenant, call_sid, ws
        self.queue: asyncio.Queue = asyncio.Queue()
        self.caller = ""

    async def _reader(self) -> None:
        try:
            while True:
                raw = await self.ws.receive_text()
                try:
                    await self.queue.put(json.loads(raw))
                except ValueError:
                    continue
        except (WebSocketDisconnect, RuntimeError):
            await self.queue.put(None)

    async def send(self, msg: dict[str, Any]) -> None:
        await self.ws.send_text(json.dumps(msg))

    async def run(self) -> None:
        reader = asyncio.create_task(self._reader())
        try:
            await self._loop()
        finally:
            reader.cancel()

    async def _loop(self) -> None:
        flow, now = self.rt.flow, self.rt.now
        first = await self.queue.get()
        if not first or first.get("type") != "setup" or first.get("callSid") != self.call_sid:
            await self.ws.close(code=1008)
            return
        self.caller = str(first.get("from", ""))
        loop = asyncio.get_running_loop()
        greeting_s = speaking_seconds(self.rt, greeting(self.tenant))
        greeting_ends = loop.time() + greeting_s
        timeout = self.rt.settings.voice_silence_s + greeting_s
        while True:
            try:
                msg = await asyncio.wait_for(self.queue.get(), timeout)
            except asyncio.TimeoutError:
                msg = {"type": "prompt", "voicePrompt": "", "last": True, "_silence": True}
            if msg is None:  # socket closed by Twilio: hang-up OR relay failure -> wait for relay-end / status
                await run_in_threadpool(flow.relay_lost, self.tenant, self.call_sid, now())
                return
            kind = msg.get("type")
            if kind == "interrupt":
                await run_in_threadpool(self._note_interrupt, msg)
                continue
            if kind == "error":
                log.warning("relay error message: %s", str(msg.get("description", ""))[:120])
                continue
            if kind != "prompt" or not msg.get("last", True):
                continue
            hold = greeting_ends - loop.time()
            if hold > 0 and self.rt.settings.voice_greeting_hold and not msg.get("_silence"):  # caller spoke over the notice: process it once it has ended
                await asyncio.sleep(hold)
            turn = await run_in_threadpool(flow.turn, self.tenant, self.call_sid, self.caller,
                                           str(msg.get("voicePrompt") or ""), now(), self._sentence_sink())
            ending = bool(turn.end or turn.dial or turn.dispatch)
            if turn.streamed:  # sentences already went out as they were ready; close this reply
                await self.send({"type": "text", "token": "", "last": True, "interruptible": not ending})
            elif turn.reply:
                await self.send({"type": "text", "token": turn.reply, "last": True, "interruptible": not ending})
            if ending:
                await asyncio.sleep(speaking_seconds(self.rt, turn.reply))  # let the goodbye be heard
                handoff = ({"action": "dispatch"} if turn.dispatch else
                           {"action": "dial", "number": turn.dial} if turn.dial else {"action": "hangup"})
                if not (turn.dial or turn.dispatch):  # close the call before the socket goes away (nothing runs after `end`)
                    await run_in_threadpool(flow.finalize, self.tenant, self.call_sid, now())
                await self.send({"type": "end", "handoffData": json.dumps(handoff)})
                return
            timeout = self.rt.settings.voice_silence_s + speaking_seconds(self.rt, turn.reply)

    def _sentence_sink(self):
        """Called from the worker thread for each guarded sentence: send it now, in order, as a
        non-final `text` token (Twilio starts TTS on it while Claude is still writing the next one)."""
        loop = asyncio.get_running_loop()
        sent = [0]

        def sink(sentence: str) -> None:
            token = (" " if sent[0] else "") + sentence  # Twilio concatenates tokens as they are
            sent[0] += 1
            fut = asyncio.run_coroutine_threadsafe(
                self.send({"type": "text", "token": token, "last": False, "interruptible": True}), loop)
            try:
                fut.result(timeout=5)
            except Exception:  # noqa: BLE001 - socket gone: the turn still completes and is persisted
                log.warning("relay: sentence not sent")

        return sink

    def _note_interrupt(self, msg: dict[str, Any]) -> None:
        eng = self.rt.engine
        c = eng.find_convo(self.tenant, "voice", self.call_sid)
        if c is not None:
            c.meta["interrupts"] = int(c.meta.get("interrupts", 0)) + 1
            eng.save_convo(c)


@router.post("/voice/relay-end")
async def voice_relay_end(request: Request) -> Response:
    """Connect action: what happens on the call after the relay session ends."""
    rt: Runtime = request.app.state.rt
    form = await request.form()
    tenant, problem = rt.resolve_tenant(str(form.get("To", "")))
    if problem or not tenant:
        return Response(twiml_say_hangup(""), media_type=TWIML)
    try:
        handoff = json.loads(str(form.get("HandoffData") or "{}"))
    except ValueError:
        handoff = {}
    if handoff.get("action") == "dial" and handoff.get("number"):
        vr = VoiceResponse()
        vr.dial(str(handoff["number"]), timeout=DIAL_TIMEOUT_S, action="/voice/dial-result", method="POST")
        return Response(str(vr), media_type=TWIML)
    call_sid = str(form.get("CallSid", ""))
    if handoff.get("action") == "dispatch":  # ADD-DISPATCH: ring the on-call waterfall (app.dispatch)
        return Response(await run_in_threadpool(rt.dispatcher.leg_twiml, tenant, call_sid, ""), media_type=TWIML)
    if handoff.get("action") != "hangup" and await run_in_threadpool(rt.flow.resume_gather, tenant, call_sid):
        # Session ended without our `end` (relay failure, socket closed) and the call is live:
        # continue the same conversation turn by turn - never hang up, never close the call here.
        rt.store.for_tenant(tenant.id).log_event("voice.relay_failed", {
            "call_sid": call_sid, "status": str(form.get("SessionStatus", "")), "error": str(form.get("ErrorCode", ""))})
        return Response(twiml_gather(REPEAT_TEXT, tenant.config.voice.tts_voice), media_type=TWIML)
    return Response(twiml_say_hangup(""), media_type=TWIML)
