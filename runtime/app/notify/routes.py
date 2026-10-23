"""HTTP endpoints for B5/B6 (one router, registered once in main.py).

Public:
    GET  /health/deep                     store ping, real Claude ping in live mode (simulated in sim), config booleans
    GET  /oauth/{provider}/start|callback (see app/calendar/routes.py)
Admin / portal backend / cron (Authorization: Bearer RUNTIME_ADMIN_TOKEN, or JOBS_TOKEN as the same
secret; 503 when neither is configured):
    POST /jobs/tick                       THE cron endpoint: SMS jobs + delivery queue + reports (every 5-15 min)
    GET  /reports/{slug}/daily?date=YYYY-MM-DD
    GET  /reports/{slug}/monthly?month=YYYY-MM
    PUT  /reports/{slug}/settings         {"avg_job_value_usd": 350}
    POST /zapier/{slug}/test              sends a signed `test.ping` to the tenant's webhook
    GET  /zapier/{slug}/secret            the tenant's signing secret (to verify on the receiving side)
    POST /oauth/{provider}/ticket         (see app/calendar/routes.py)

Services are built lazily from `app.state.settings` / `app.state.store` and cached on
`app.state.b56`; tests may set `app.state.b56` themselves.
"""
from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from ..calendar import CalendarHub, build_hub
from ..calendar.routes import router as calendar_router
from ..reports import Reporter, avg_job_value_key, daily_for_date, monthly_roi_data
from ..settings import Settings
from ..store import StateStore, Store
from ..zapier import TEST_EVENT, ZapierClient, signing_secret, tenant_secret
from .channels import OutboxEmail, email_from_env, sms_from_env
from .core import Notifier, NotifyPolicy

SIM_ADMIN_TOKEN = "sim-admin-token-not-a-secret"

router = APIRouter()
router.include_router(calendar_router)


@dataclass
class Services:
    settings: Settings
    store: Store
    state: StateStore
    notifier: Notifier
    calendar: CalendarHub
    zapier: ZapierClient
    reporter: Reporter
    admin_token: str


def build_services(settings: Settings, store: Store, state: StateStore | None = None,
                   env: dict[str, str] | None = None, **overrides: Any) -> Services:
    env = dict(os.environ if env is None else env)
    state = state or StateStore(store, memory_fallback=settings.is_sim)
    zapier = overrides.get("zapier") or ZapierClient(store, state, signing_secret(settings, env))
    notifier = overrides.get("notifier") or Notifier(
        store, state, overrides.get("email") or email_from_env(store, settings, env),
        overrides.get("sms") or sms_from_env(store, settings, env), zapier, NotifyPolicy.from_env(settings, env))
    calendar = overrides.get("calendar") or build_hub(store, settings, state, alert=notifier.calendar_alert,
                                                      http=overrides.get("http"), env=env)
    # One token for cron + admin/portal backend; JOBS_TOKEN (settings.jobs_token) is accepted as the same secret.
    token = (env.get("RUNTIME_ADMIN_TOKEN") or getattr(settings, "jobs_token", "")
             or (SIM_ADMIN_TOKEN if settings.is_sim else ""))
    return Services(settings, store, state, notifier, calendar, zapier, Reporter(store, state, notifier), token)


def services(app: FastAPI) -> Services:
    svc = getattr(app.state, "b56", None)
    if svc is None:
        svc = build_services(app.state.settings, app.state.store, getattr(app.state, "state_store", None))
        app.state.b56 = svc
    return svc


def require_admin(request: Request) -> JSONResponse | None:
    token = services(request.app).admin_token
    if not token:
        return JSONResponse({"error": "admin token not configured"}, status_code=503)
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), token.encode()):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return None


def _tenant(svc: Services, slug: str):
    return svc.store.tenant_by_slug(slug)


_PING: dict[str, Any] = {}


def claude_ping(settings: Settings, ttl_s: float = 60.0) -> bool:
    """live/record: a real, free API call (models.retrieve on the configured model), cached 60 s.
    mock/replay (simulator, tests): simulated as healthy, no network."""
    if settings.brain_mode not in ("live", "record"):
        return True
    import time
    hit = _PING.get(settings.model)
    if hit and time.time() - hit[0] < ttl_s:
        return hit[1]
    try:
        import anthropic

        anthropic.Anthropic(timeout=5.0, max_retries=0).models.retrieve(settings.model)
        ok = True
    except Exception:  # noqa: BLE001 - any failure = not healthy
        ok = False
    _PING[settings.model] = (time.time(), ok)
    return ok


@router.get("/health/deep")
def health_deep(request: Request) -> JSONResponse:
    """Admin only (Bearer RUNTIME_ADMIN_TOKEN): booleans and tenant slugs + field paths, never values."""
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    s = svc.settings
    try:
        store_ok = bool(svc.store.ping())
    except Exception:  # noqa: BLE001
        store_ok = False
    checks = {
        "store": store_ok,
        "twilio_auth_token": bool(s.twilio_auth_token),
        "twilio_account_sid": bool(os.environ.get("TWILIO_ACCOUNT_SID")) or s.is_sim,
        "claude": claude_ping(s),
        "cred_key": bool(s.cred_key),
        "email": not isinstance(svc.notifier.email, OutboxEmail) or s.is_sim,
        "zapier_signing_secret": bool(svc.zapier.master),
        "admin_token": bool(svc.admin_token),
        "admin_email": bool(svc.notifier.policy.admin_email) or s.is_sim,
    }
    optional = {p: svc.calendar.tokens.configured(p) for p in ("calendly", "google")}
    invalid = invalid_tenants(svc.store)
    checks["tenant_configs"] = not invalid
    ok = all(checks.values())
    return JSONResponse({"ok": ok, "checks": checks, "calendar_oauth": optional, "mode": s.mode,
                         "tenants_invalid": invalid}, status_code=200 if ok else 503)


def invalid_tenants(store: Store) -> list[dict[str, Any]]:
    """Every stored tenant config validated (B12 #2): slug + the failing field paths only. Validation
    messages can quote config values (phones, e-mails, FAQ), so they never leave the server."""
    from ..tenants import TenantConfigError, load_record
    out = []
    for row in store.select("tenants"):
        try:
            load_record(row)
        except TenantConfigError as exc:
            fields = sorted({p.split(":", 1)[0].strip() for p in exc.problems})
            out.append({"slug": row.get("slug"), "fields": fields[:10]})
    return out


@router.post("/jobs/tick")
def jobs_tick(request: Request):
    """The single cron endpoint (every 5-15 min): SMS jobs (text-back, reminders), the delivery queue
    (alerts/Zapier retries that survived a restart), then reports."""
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    out: dict[str, Any] = {}
    rt = getattr(request.app.state, "rt", None)
    now = rt.now() if rt is not None else datetime.now(timezone.utc)  # runtime clock (FakeClock in the sim)
    if rt is not None and getattr(rt, "outbound", None) is not None:
        try:
            out["sms_jobs"] = len(rt.outbound.run_due(now) or [])
        except Exception:  # noqa: BLE001 - one failing part must not stop the rest
            out["sms_jobs"] = "error"
    from ..hooks_b56 import queue_for
    state = getattr(rt, "state", None) or svc.state
    out["deliveries"] = queue_for(svc.store, state).drain()
    out["ran"] = svc.reporter.run_due(now)
    return out


@router.get("/reports/{slug}/daily")
def report_daily(slug: str, request: Request):
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    raw = request.query_params.get("date", "")
    try:
        day = date.fromisoformat(raw) if raw else datetime.now(timezone.utc).date()
    except ValueError:
        return JSONResponse({"error": "date must be YYYY-MM-DD"}, status_code=400)
    return daily_for_date(svc.store, tenant, day)


@router.get("/reports/{slug}/monthly")
def report_monthly(slug: str, request: Request):
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    month = request.query_params.get("month") or datetime.now(timezone.utc).strftime("%Y-%m")
    try:
        datetime.strptime(month, "%Y-%m")
    except ValueError:
        return JSONResponse({"error": "month must be YYYY-MM"}, status_code=400)
    return monthly_roi_data(svc.store, svc.state, tenant, month)


@router.put("/reports/{slug}/settings")
async def report_settings(slug: str, request: Request):
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    body = await request.json()
    try:
        value = float(body.get("avg_job_value_usd"))
    except (TypeError, ValueError):
        return JSONResponse({"error": "avg_job_value_usd must be a number"}, status_code=400)
    if not 0 < value <= 100000:
        return JSONResponse({"error": "avg_job_value_usd out of range"}, status_code=400)
    svc.state.put(avg_job_value_key(tenant.id), value, tenant.id)
    return {"ok": True, "avg_job_value_usd": value}


@router.post("/zapier/{slug}/test")
def zapier_test(slug: str, request: Request):
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    if not tenant.config.zapier.webhook_url:
        return JSONResponse({"error": "no webhook_url configured"}, status_code=400)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return svc.zapier.emit(tenant, TEST_EVENT, stamp, {"message": "Test event from your AI receptionist"})


@router.get("/zapier/{slug}/secret")
def zapier_secret(slug: str, request: Request):
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    if not svc.zapier.master:
        return JSONResponse({"error": "ZAPIER_SIGNING_SECRET not configured"}, status_code=503)
    return {"signing_secret": tenant_secret(svc.zapier.master, tenant.id), "header": "X-Signature",
            "scheme": "sha256=HMAC_SHA256(secret, X-Timestamp + '.' + raw_body)"}


# --- ADD-REV ---------------------------------------------------------------------------------------------------
# Post-job review-request SMS (app.reviews, docs/review-requests.md). Shipped DISABLED: both the env kill switch
# REVIEW_REQUESTS_ENABLED and the tenant's review_requests.enabled must be on, else 403 review_requests_disabled.
#   POST /reviews/{slug}/job-completed   admin Bearer token OR tenant HMAC (X-Timestamp + X-Signature over the body)
#   GET  /reviews/{slug}/status          admin: the two switches, url_set, pending_jobs

def _review_rt(request: Request):
    return getattr(request.app.state, "rt", None)


@router.post("/reviews/{slug}/job-completed")
async def review_job_completed(slug: str, request: Request):
    from ..reviews import BadBody, job_completed, verify_zapier_inbound
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    raw = await request.body()
    rt = _review_rt(request)
    if require_admin(request) is not None:  # not the admin token: accept a valid tenant signature instead
        now_s = rt.now().timestamp() if rt is not None else None
        if not verify_zapier_inbound(request.headers, raw, tenant.id, svc.zapier.master, now_s):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    if rt is None or getattr(rt, "outbound", None) is None:
        return JSONResponse({"error": "runtime not ready"}, status_code=503)
    enabled, _why = rt.outbound.review_enabled(tenant)
    if not enabled and _why in ("env_disabled", "tenant_disabled"):
        return JSONResponse({"error": "review_requests_disabled"}, status_code=403)
    try:
        import json as _json
        body = _json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse({"error": "body must be JSON"}, status_code=400)
    try:
        res = job_completed(rt, tenant, body, rt.now())
    except BadBody as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return {k: v for k, v in res.items() if k in ("queued", "reason", "due")}


@router.get("/reviews/{slug}/status")
def review_status(slug: str, request: Request):
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    rt = _review_rt(request)
    rv = tenant.config.review_requests
    pending = 0
    if rt is not None and getattr(rt, "outbound", None) is not None:
        pending = sum(1 for j in rt.outbound.jobs(tenant) if j.get("kind") == "review")
    return {"env_enabled": bool(svc.settings.review_requests_enabled), "tenant_enabled": bool(rv.enabled),
            "url_set": bool(rv.google_review_url), "pending_jobs": pending}
# --- end ADD-REV -----------------------------------------------------------------------------------------------


# --- ADD-CRM ---------------------------------------------------------------------------------------------------
# Direct CRM links (HubSpot, Jobber): the admin stores one access token per tenant + provider, encrypted like
# calendar tokens; it is never echoed back. `POST .../test` is a read-only auth check. Public docs: docs/crm-links.md.
#     PUT    /crm/{slug}/{provider}       {"token": "..."}  -> {"ok": true, "provider": ...}
#     DELETE /crm/{slug}/{provider}                         -> {"ok": true, "provider": ...}
#     GET    /crm/{slug}                                    -> {provider: {"connected": bool, "enabled": bool}}
#     POST   /crm/{slug}/{provider}/test                    -> {"ok": bool, "status": ..., "reason"?: ...}
from ..crm import CredentialBox, make_client  # noqa: E402
from ..crm.base import ALL_PROVIDERS as CRM_PROVIDERS  # noqa: E402  (hubspot, jobber, follow_up_boss)

CRM_TOKEN_MAX = 4096


def _crm_box(svc: Services) -> CredentialBox | None:
    return CredentialBox(svc.store, svc.settings.cred_key) if svc.settings.cred_key else None


def _crm_client(svc: Services, provider: str):
    """Uses the services' http client (`build_services(..., http=...)`, kept on the calendar TokenManager) or an
    explicit `svc.crm_http`, so tests mock the CRM API the same way they mock calendars."""
    http = getattr(svc, "crm_http", None) or getattr(getattr(svc.calendar, "tokens", None), "http", None)
    return make_client(provider, _crm_box(svc), svc.store, svc.state, http=http)


def _crm_guard(request: Request, slug: str, provider: str | None = None):
    """Admin + tenant + provider checks shared by the endpoints. Returns (svc, tenant) or an error response."""
    if (denied := require_admin(request)) is not None:
        return denied
    svc = services(request.app)
    if provider is not None and provider not in CRM_PROVIDERS:
        return JSONResponse({"error": "unknown provider", "providers": list(CRM_PROVIDERS)}, status_code=404)
    tenant = _tenant(svc, slug)
    if tenant is None:
        return JSONResponse({"error": "unknown tenant"}, status_code=404)
    if _crm_box(svc) is None:
        return JSONResponse({"error": "CRED_KEY not configured"}, status_code=503)
    return svc, tenant


@router.get("/crm/{slug}")
def crm_status(slug: str, request: Request):
    got = _crm_guard(request, slug)
    if isinstance(got, JSONResponse):
        return got
    svc, tenant = got
    box = _crm_box(svc)
    crm = getattr(tenant.config, "crm", None)
    enabled = {p: bool(getattr(getattr(crm, p, None), "enabled", False)) for p in CRM_PROVIDERS}
    enabled["follow_up_boss"] = bool(tenant.config.real_estate.follow_up_boss.enabled)
    return {p: {"connected": box.connected(tenant.id, p), "enabled": enabled[p]} for p in CRM_PROVIDERS}


@router.put("/crm/{slug}/{provider}")
async def crm_connect(slug: str, provider: str, request: Request):
    got = _crm_guard(request, slug, provider)
    if isinstance(got, JSONResponse):
        return got
    svc, tenant = got
    try:
        body = await request.json()
    except ValueError:
        body = None
    token = (body or {}).get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token.strip() or len(token) > CRM_TOKEN_MAX or any(c.isspace() for c in token.strip()):
        return JSONResponse({"error": "token must be a non-empty string without spaces"}, status_code=400)
    _crm_box(svc).save(tenant.id, provider, token.strip())
    svc.state.put(f"crm:notconn:{tenant.id}:{provider}", None, tenant.id)  # the "not connected" notice may fire again
    svc.store.for_tenant(tenant.id).log_event("crm.connected", {"provider": provider}, actor="admin")
    return {"ok": True, "provider": provider}


@router.delete("/crm/{slug}/{provider}")
def crm_disconnect(slug: str, provider: str, request: Request):
    got = _crm_guard(request, slug, provider)
    if isinstance(got, JSONResponse):
        return got
    svc, tenant = got
    _crm_box(svc).delete(tenant.id, provider)
    svc.store.for_tenant(tenant.id).log_event("crm.disconnected", {"provider": provider}, actor="admin")
    return {"ok": True, "provider": provider}


@router.post("/crm/{slug}/{provider}/test")
def crm_test(slug: str, provider: str, request: Request):
    got = _crm_guard(request, slug, provider)
    if isinstance(got, JSONResponse):
        return got
    svc, tenant = got
    res = _crm_client(svc, provider).check(tenant)
    return JSONResponse(res, status_code=200 if res.get("ok") else 502)
