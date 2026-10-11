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
    ok = all(checks.values())
    return JSONResponse({"ok": ok, "checks": checks, "calendar_oauth": optional, "mode": s.mode},
                        status_code=200 if ok else 503)


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
