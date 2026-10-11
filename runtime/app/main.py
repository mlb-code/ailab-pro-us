"""FastAPI entry point.

`app` (module level) is what Railway runs: `uvicorn app.main:app`. Tests and the simulator
call `create_app(settings, store)` to inject their own settings and store.

B1 ships the skeleton: /health, Twilio signature middleware, tenant resolution by the `To`
number, and minimal /voice/incoming and /sms/incoming handlers. The full voice flow (B3) and
SMS flow (B4) replace those two handlers; tenant resolution stays here.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from twilio.twiml.messaging_response import MessagingResponse
from twilio.twiml.voice_response import VoiceResponse

from . import __version__
from . import settings as settings_mod
from . import store as store_mod
from .tenants import TenantConfigError, TenantRecord
from .twilio_auth import TwilioSignatureMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("rt.main")

TWIML = "application/xml"
NOT_IN_SERVICE = "Sorry, this number is not in service. Goodbye."
UNAVAILABLE = "Sorry, we can't take your call right now. Please call back later. Goodbye."


def default_greeting(tenant: TenantRecord) -> str:
    cfg = tenant.config
    return cfg.voice.greeting or (
        f"Thanks for calling {cfg.business.name}, this is the virtual assistant. "
        "Sorry we missed you, I can get you booked. This call may be transcribed. "
        "What can we help with?")


def create_app(settings: settings_mod.Settings | None = None, store: store_mod.Store | None = None) -> FastAPI:
    settings = settings or settings_mod.load()
    store = store or store_mod.from_settings(settings)
    app = FastAPI(title=f"{settings.brand_name} runtime", version=__version__, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.store = store
    app.state.started_at = datetime.now(timezone.utc)
    app.add_middleware(TwilioSignatureMiddleware, settings=settings)

    def resolve_tenant(to_number: str) -> tuple[TenantRecord | None, str]:
        """(tenant, problem). problem in {'', 'unknown', 'invalid_config'}."""
        try:
            tenant = store.tenant_by_number(to_number)
        except TenantConfigError as exc:
            log.error("tenant config invalid for number ending %s: %s", to_number[-4:], exc.problems[:3])
            return None, "invalid_config"
        return (tenant, "") if tenant else (None, "unknown")

    @app.get("/health")
    def health() -> JSONResponse:
        try:
            ok_store = store.ping()
        except Exception:  # noqa: BLE001 - health must never raise
            ok_store = False
        body = {
            "ok": ok_store,
            "version": __version__,
            "store_ok": ok_store,
            "uptime_s": int((datetime.now(timezone.utc) - app.state.started_at).total_seconds()),
            **settings.public(),
        }
        return JSONResponse(body, status_code=200 if ok_store else 503)

    @app.post("/voice/incoming")
    async def voice_incoming(request: Request) -> Response:
        form = await request.form()
        tenant, problem = resolve_tenant(str(form.get("To", "")))
        vr = VoiceResponse()
        if problem == "unknown":
            vr.say(NOT_IN_SERVICE)
            vr.hangup()
        elif problem or not tenant.active:
            vr.say(UNAVAILABLE)
            vr.hangup()
        else:
            store.log_event("runtime", "tenant", tenant.id, "voice.incoming", {"call_sid": form.get("CallSid", "")})
            gather = vr.gather(input="speech", action="/voice/turn", method="POST",
                               speech_model="phone_call", speech_timeout="auto")
            gather.say(default_greeting(tenant), voice=tenant.config.voice.tts_voice)
        return Response(str(vr), media_type=TWIML)

    @app.post("/sms/incoming")
    async def sms_incoming(request: Request) -> Response:
        form = await request.form()
        tenant, problem = resolve_tenant(str(form.get("To", "")))
        if tenant and not problem:
            store.log_event("runtime", "tenant", tenant.id, "sms.incoming", {"message_sid": form.get("MessageSid", "")})
        return Response(str(MessagingResponse()), media_type=TWIML)

    return app


class _LazyApp:
    """Build the real app on the first ASGI call, so importing this module has no side effects."""

    def __init__(self) -> None:
        self.inner: FastAPI | None = None

    async def __call__(self, scope, receive, send):
        if self.inner is None:
            self.inner = create_app()
        await self.inner(scope, receive, send)


app = _LazyApp()
