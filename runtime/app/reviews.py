"""ADD-REV: post-job review-request SMS. Shipped DISABLED (docs/review-requests.md).

Why off: today's 10DLC campaign is customer care (informational). A "please leave us a Google review" text is
marketing-adjacent, so it needs (a) consent collected for it and (b) a 10DLC campaign whose use case covers review
requests. Nothing is sent until BOTH switches are on:
- env `REVIEW_REQUESTS_ENABLED=1` (`settings.review_requests_enabled`, the kill switch), and
- tenant config `review_requests.enabled` with a `google_review_url`.

Flow: the client's job system (or a Zapier zap) calls `POST /reviews/{slug}/job-completed` when a job is done.
`job_completed()` validates the body, `Outbound.enqueue_review` checks the switches, opt-out, blocklist, the 90-day
rule and consent, and queues ONE text `delay_hours` later inside the 09-20 window (business + customer time zone).
The cron (`/jobs/tick`) sends it through the usual `Outbound.send` choke point (`sms_outbound.review_text`).

Consent rule: the number has a `sms_consent` row `booking_texts` = yes (the customer said yes to texts when booking),
or the request attests consent (`consent: true` + `consent_text`, the wording the customer agreed to on the job
sheet), which is recorded in the consent log as a manual `booking_texts` = yes.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .tenants import TenantRecord
from .zapier import tenant_secret, verify

EVENT = "review.job_completed"


class JobCompleted(BaseModel):
    """Body of POST /reviews/{slug}/job-completed."""
    model_config = ConfigDict(extra="forbid")
    contact: str = Field(pattern=r"^\+[1-9]\d{6,14}$", description="Customer's mobile number, E.164")
    name: str | None = Field(default=None, max_length=80)
    job_type: str | None = Field(default=None, max_length=80)
    job_ref: str | None = Field(default=None, max_length=80, description="The client's job id (dedupe key)")
    consent: bool | None = Field(default=None, description="True = the customer agreed to texts on the job sheet")
    consent_text: str | None = Field(default=None, max_length=300, description="The consent wording they agreed to")


class BadBody(ValueError):
    pass


def parse_body(body: Any) -> JobCompleted:
    if not isinstance(body, Mapping):
        raise BadBody("body must be a JSON object")
    try:
        return JobCompleted.model_validate(dict(body))
    except ValidationError as exc:
        raise BadBody("; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors())) from exc


def job_completed(rt, tenant: TenantRecord, body: Any, now: datetime) -> dict[str, Any]:
    """Validate, queue the review text (or say why not) and log `review.job_completed` (no phone number)."""
    job = parse_body(body)  # BadBody -> 400 in the route
    res = rt.outbound.enqueue_review(tenant, job.contact, now, job.model_dump())
    rt.store.for_tenant(tenant.id).log_event(EVENT, {"job_ref": job.job_ref, "job_type": job.job_type,
                                                     "queued": res.get("queued", False),
                                                     **({"reason": res["reason"]} if res.get("reason") else {})})
    return res


def verify_zapier_inbound(request_headers: Mapping[str, str], raw_body: bytes, tenant_id: str, master_secret: str,
                          now: float | None = None) -> bool:
    """A Zapier "job completed" zap signs like our outgoing webhooks, with the tenant's existing signing secret
    (GET /zapier/{slug}/secret): `X-Signature: sha256=HMAC_SHA256(secret, X-Timestamp + '.' + raw_body)`."""
    if not master_secret:
        return False
    timestamp = request_headers.get("x-timestamp") or request_headers.get("X-Timestamp") or ""
    signature = request_headers.get("x-signature") or request_headers.get("X-Signature") or ""
    if not timestamp or not signature:
        return False
    return verify(tenant_secret(master_secret, tenant_id), timestamp, raw_body, signature, now)
