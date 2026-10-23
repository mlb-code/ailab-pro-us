# Post-job review-request SMS (add-on `ADD-REV`) — shipped DISABLED

One text after a completed job that asks the customer for a Google review. The code is in the runtime
(`runtime/app/reviews.py`, `Outbound.enqueue_review` / `_run_review` in `runtime/app/sms_outbound.py`,
routes at the end of `runtime/app/notify/routes.py`), but **nothing can be sent in production today**.

## Why it ships off

Our 10DLC campaign is registered as customer care (informational texts: missed-call text-back, booking
confirmation, reminder). A "please leave us a review" text is marketing-adjacent, so it needs:

1. **Consent collected for it** — the customer must have agreed to receive texts about their job
   (see the consent rule below), and
2. **A 10DLC campaign whose use case covers review requests** — a new campaign or an amended use case,
   approved by the carriers, with sample messages that include the review text.

Until both exist the feature stays behind two switches, and both default to off.

## The two switches (both must be on)

| Switch | Where | Default |
|---|---|---|
| `REVIEW_REQUESTS_ENABLED=1` | runtime environment (kill switch, `settings.review_requests_enabled`, visible in `/health` as `review_requests_enabled`) | off |
| `review_requests.enabled: true` + `google_review_url` | tenant config (`config.review_requests`, also `delay_hours`, default 2) | off |

With either switch off, `POST /reviews/{slug}/job-completed` answers `403 {"error": "review_requests_disabled"}`
and queues nothing. A job already queued is re-checked at send time: switching either off before the send
means no text (event `sms.review` with the reason).

## How it works when enabled

1. The client's job system (or a Zapier zap) calls `POST /reviews/{slug}/job-completed` when a job is done.
2. The runtime checks: both switches, the number is not opted out and not on the tenant blocklist, no review
   text to this number in the last 90 days, and consent (below).
3. One job is queued `delay_hours` after the call, moved into the 09:00–20:00 texting window (Sunday 12:00–20:00)
   in **both** the business's and the customer's area-code time zone, like the reminder.
4. The cron (`POST /jobs/tick`) sends it through the single outbound choke point (`Outbound.send`): opt-out,
   blocklist, tenant paused, quiet hours and the landline/toll-free lookup are checked again at send time.
5. The message is logged in `sms_messages`, counted toward usage, and an `sms.review` event records the result
   (no phone number in the event payload).

Template (locked; only the business name and the client's own Google review URL vary, no prices or offers):

```
<Business>: thanks for choosing us! If you have a minute, a Google review helps a lot: <google_review_url> Reply STOP to opt out.
```

One SMS segment with a short business name (`business.sms_display_name`). This is the only automated text that
carries a link, and the link may only be the tenant's `google_review_url` (https).

Limits: one review text per customer number per 90 days; one job per `job_ref` (duplicates are ignored).

## Consent rule

A review text goes out only if one of these holds:

- The number has a `booking_texts = yes` row in the consent log — the customer answered yes to the texting
  question when they booked (by phone or text). Nothing more is needed.
- The request carries `"consent": true` **and** `"consent_text"` — the client attests that the customer agreed
  to texts on the job sheet / work order, and `consent_text` is the wording they agreed to. The runtime writes it
  to the consent log (`channel: manual`, `booking_texts = yes`, version `review-2026-10-23`). `consent: true`
  without the wording is refused (`no_consent`).

STOP (or any opt-out sentence) stops review texts too, like every other automated message.

## Request

`POST /reviews/{slug}/job-completed` — JSON body:

```json
{"contact": "+17135550123", "name": "Dana", "job_type": "AC repair", "job_ref": "J-1001",
 "consent": true, "consent_text": "Customer agreed on the job sheet to receive text messages about this job."}
```

- `contact` (required, E.164). `name`, `job_type`, `job_ref` optional (`job_ref` = the client's job id, used to
  dedupe). `consent` / `consent_text` only when there is no booking-time yes on file.
- Auth: either the admin Bearer token (`RUNTIME_ADMIN_TOKEN`) **or** a tenant HMAC signature (below).
- Answers: `200 {"queued": true, "due": "..."}` or `200 {"queued": false, "reason": "..."}`
  (`no_consent`, `opted_out`, `blocklist`, `already_asked_90d`, `duplicate`, `no_review_url`);
  `400` bad body; `401` bad auth; `403 review_requests_disabled`; `404` unknown slug.

`GET /reviews/{slug}/status` (admin) → `{"env_enabled", "tenant_enabled", "url_set", "pending_jobs"}`.

## Zapier inbound signature

A "job completed" zap (from the client's job software) can call the endpoint without the admin token by signing
the request with the tenant's existing signing secret, the same one our outgoing webhooks use
(`GET /zapier/{slug}/secret`):

- `X-Timestamp`: unix seconds (accepted within 5 minutes of the runtime clock).
- `X-Signature`: `sha256=<hex HMAC-SHA256(secret, X-Timestamp + "." + raw body)>`.

A missing or wrong signature is `401`; the body is still validated and the switches still apply.

## Before enabling for anyone

1. 10DLC: register (or amend) a campaign whose use case covers review requests, with this template as a sample
   message, and point the tenant's number at it. Keep the customer-care campaign for the informational texts.
2. Consent wording: add a texting consent line to the client's booking confirmation / job sheet, and either
   rely on the booking-time yes (already logged) or pass `consent` + `consent_text` on every call.
3. Tenant config: `review_requests.enabled: true`, `google_review_url` (the client's own Google review link),
   `delay_hours`.
4. Environment: `REVIEW_REQUESTS_ENABLED=1` on the runtime, then check `GET /reviews/{slug}/status`.
5. Tests: `runtime/tests/test_reviews.py` (offline) cover the switches, consent, window, opt-out, 90 days,
   landline and the signature.
