"""OAuth endpoints for connecting a tenant's calendar (portal step 4, SPEC 6.8).

    POST /oauth/{provider}/ticket    admin/portal-backend only (Bearer RUNTIME_ADMIN_TOKEN), body {"tenant_id"}
                                     -> {"url": "<runtime>/oauth/{provider}/start?ticket=..."} (15 min)
    GET  /oauth/{provider}/start     ticket -> 302 to Calendly/Google consent (state = signed tenant id + PKCE)
    GET  /oauth/{provider}/callback  code + state -> tokens stored encrypted -> 302 back to the portal

The portal never sees tokens. The Supabase Edge Function that serves the portal checks that
the signed-in client owns the tenant, then asks for a ticket.
"""
from __future__ import annotations

import logging
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from .. import crypto
from ..settings import brand
from .base import CalendarAuthError, CalendarError
from .oauth import PROVIDERS

log = logging.getLogger("rt.oauth")
router = APIRouter()


def _portal(result: str, provider: str) -> str:
    site = str(brand().get("site_url") or "").rstrip("/")
    return f"{site}/start/?{urlencode({'calendar': provider, 'result': result})}"


@router.post("/oauth/{provider}/ticket")
async def oauth_ticket(provider: str, request: Request):
    from ..notify.routes import require_admin, services  # local import: avoids a cycle

    if (denied := require_admin(request)) is not None:
        return denied
    if provider not in PROVIDERS:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    body = await request.json()
    tenant_id = str(body.get("tenant_id") or "")
    svc = services(request.app)
    if not tenant_id or not svc.store.select("tenants", id=tenant_id):
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    if not svc.calendar.tokens.configured(provider):
        return JSONResponse({"error": f"{provider} OAuth client not configured"}, status_code=503)
    ticket = svc.calendar.tokens.ticket(tenant_id, provider)
    base = svc.settings.public_base_url or str(request.base_url).rstrip("/")
    return {"url": f"{base}/oauth/{provider}/start?{urlencode({'ticket': ticket})}"}


@router.get("/oauth/{provider}/start")
def oauth_start(provider: str, request: Request, ticket: str = ""):
    from ..notify.routes import services

    if provider not in PROVIDERS:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    tokens = services(request.app).calendar.tokens
    try:
        tenant_id = tokens.check_ticket(ticket, provider)
        return RedirectResponse(tokens.authorize_url(tenant_id, provider), status_code=302)
    except crypto.CryptoError:
        return JSONResponse({"error": "invalid or expired link; start again from the portal"}, status_code=400)
    except CalendarAuthError as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)


@router.get("/oauth/{provider}/callback")
def oauth_callback(provider: str, request: Request, code: str = "", state: str = "", error: str = ""):
    from ..notify.routes import services

    if provider not in PROVIDERS:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    svc = services(request.app)
    if error or not code:
        return RedirectResponse(_portal("cancelled", provider), status_code=302)
    try:
        tenant_id = svc.calendar.tokens.handle_callback(provider, code, state)
    except crypto.CryptoError:
        return JSONResponse({"error": "invalid or expired state"}, status_code=400)
    except CalendarError as exc:  # includes CalendarAuthError
        log.warning("oauth %s callback failed: %s", provider, str(exc)[:120])
        return RedirectResponse(_portal("error", provider), status_code=302)
    svc.calendar.connected(tenant_id, provider)
    svc.store.for_tenant(tenant_id).log_event("calendar.connected", {"provider": provider})
    return RedirectResponse(_portal("connected", provider), status_code=302)
