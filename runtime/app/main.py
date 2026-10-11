"""FastAPI entry point.

`app` (module level) is what Railway runs: `uvicorn app.main:app`. Tests and the simulator
call `create_app(settings, store, ...)` to inject settings, store, Claude client, calendar,
Twilio REST client and clock.

Routes: /health, voice (`app.voice`, `app.voice_stream`), SMS (`app.sms`).
Every /voice/* and /sms/* HTTP webhook is Twilio-signature checked by the middleware; the relay
WebSocket checks the signature itself (see `app.voice_stream`).
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Callable

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import __version__
from . import settings as settings_mod
from . import store as store_mod
from ._stubs_b56 import TenantCalendars
from .conversation import Engine
from .llm import LLMClient
from .runtime_ctx import Runtime, utcnow
from .sms import router as sms_router
from .sms_outbound import Outbound, rest_client
from .twilio_auth import TwilioSignatureMiddleware
from .voice import VoiceFlow, greeting
from .voice import router as voice_router
from .voice_stream import router as stream_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("rt.main")

default_greeting = greeting  # backwards-compatible name


def create_app(settings: settings_mod.Settings | None = None, store: store_mod.Store | None = None, *,
               llm: LLMClient | None = None, calendar: Any = None, twilio_client: Any = None,
               clock: Callable[[], datetime] | None = None) -> FastAPI:
    settings = settings or settings_mod.load()
    store = store or store_mod.from_settings(settings)
    engine = Engine(store, llm or LLMClient(settings, namespace="runtime"), calendar or TenantCalendars(settings),
                    settings)
    outbound = Outbound(settings, store, twilio_client if twilio_client is not None else rest_client(settings))
    rt = Runtime(settings=settings, store=store, engine=engine, outbound=outbound, clock=clock or utcnow)
    outbound.rt = rt
    rt.flow = VoiceFlow(rt)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = None
        if settings.jobs_loop_s > 0:
            async def loop() -> None:
                while True:
                    await asyncio.sleep(settings.jobs_loop_s)
                    try:
                        await run_in_threadpool(outbound.run_due, rt.now())
                    except Exception:  # noqa: BLE001 - the loop must survive a bad tick
                        log.exception("jobs tick failed")
            task = asyncio.create_task(loop())
        yield
        if task:
            task.cancel()
        await run_in_threadpool(rt.drain, 5.0)

    app = FastAPI(title=f"{settings.brand_name} runtime", version=__version__, docs_url=None, redoc_url=None,
                  lifespan=lifespan)
    app.state.settings = settings
    app.state.store = store
    app.state.rt = rt
    app.state.started_at = utcnow()
    app.add_middleware(TwilioSignatureMiddleware, settings=settings)

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
            "uptime_s": int((utcnow() - app.state.started_at).total_seconds()),
            **settings.public(),
        }
        return JSONResponse(body, status_code=200 if ok_store else 503)

    app.include_router(voice_router)
    app.include_router(stream_router)
    app.include_router(sms_router)
    app.include_router(__import__("app.notify.routes", fromlist=["router"]).router)  # B5/B6: oauth, jobs/tick, reports, zapier, health/deep
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
