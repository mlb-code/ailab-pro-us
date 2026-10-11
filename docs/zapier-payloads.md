# Zapier webhook payloads (runtime, task B6)

One outgoing webhook per tenant (`config.zapier.webhook_url`, https only, no private/loopback IPs).
The tenant picks events in `config.zapier.events`: `lead.created`, `booking.created`, `call.completed`.
The admin "send test" button sends `test.ping`.

## Delivery
- `POST` JSON, `Content-Type: application/json`.
- Headers: `X-Event`, `X-Timestamp` (unix seconds), `X-Idempotency-Key` (= payload `id`),
  `X-Signature: sha256=<hex HMAC-SHA256(secret, X-Timestamp + "." + raw body)>`.
- Secret: per tenant, from `GET /zapier/{slug}/secret` (admin). Verify with a 5-minute window.
- Exactly once per key (call SID, conversation id, or calendar event id). 1 try + 3 retries
  (2 s, 8 s, 30 s) on network errors, 408, 429, 5xx. Other 4xx: no retry. After that: an
  `events` row `zapier.dead_letter` with the payload (shown in admin_daily).

## Envelope
```json
{"id": "lead.created:SM8f2c...", "event": "lead.created", "created_at": "2026-10-12T14:05:00+00:00",
 "tenant": {"slug": "demo-hvac", "business": "Cool Breeze HVAC"}, "data": { }}
```

## `lead.created` (once per conversation, when it has an outcome)
```json
"data": {"channel": "sms", "convo_id": "SM8f2c...", "contact": "+17135550123", "outcome": "message", "urgency": "normal"}
```

## `booking.created` (once per calendar event)
```json
"data": {"channel": "voice", "convo_id": "CA91d...", "contact": "+17135550123", "name": "Dana Miller",
         "address": "2100 Rice Blvd, Houston, TX 77005", "job_type": "AC repair", "urgency": "normal",
         "start": "2026-10-13T08:00:00-05:00", "end": "2026-10-13T12:00:00-05:00",
         "event_id": "https://api.calendly.com/scheduled_events/ABC123"}
```
`start`/`end` = the arrival window the customer was told.

## `call.completed` (once per call SID)
```json
"data": {"call_sid": "CA91d...", "outcome": "booked", "duration_s": 142, "summary": "AC repair booked for Tue 8-12"}
```
`outcome` is one of `booked`, `message`, `handoff`, `emergency`, `spam`, `abandoned`.

## `test.ping`
```json
"data": {"message": "Test event from your AI receptionist"}
```

Follow Up Boss / Jobber / HubSpot via Zapier: "Webhooks by Zapier → Catch Hook", then map `data.*` fields.
