# Direct CRM links (ADD-CRM)

The receptionist can push every new lead and every booked appointment straight into the client's CRM,
in addition to (or instead of) the Zapier webhook. Two links are built: **HubSpot** and **Jobber**.
GoHighLevel and Housecall Pro are designed but not built (see the end of this page).

## What is synced

| Runtime event | When | What the CRM receives |
|---|---|---|
| `lead.created` | A conversation ends with a real outcome (message taken, booked, hand-off, emergency) | Contact found-or-created + one note with the summary |
| `booking.created` | An appointment is booked | Same as above, plus a deal (HubSpot) / a client request with the booked window (Jobber) |

Per tenant the link is switched on in the tenant config:

```json
"crm": {
  "hubspot": {"enabled": true, "events": ["lead.created", "booking.created"]},
  "jobber":  {"enabled": false, "events": ["lead.created", "booking.created"]}
}
```

The lead record is built from the stored conversation: name, phone, e-mail (when the customer gave one),
address, job type, urgency, summary, channel (voice / SMS / web chat), the booked window, and for
real-estate tenants the screening answers. Transcripts are never sent to a CRM.

### Guarantees

- **Exactly once.** Each (tenant, CRM, event, conversation) is remembered; a retried or re-emitted event
  never creates a second contact, note or deal.
- **Never a duplicate contact.** The contact is looked up by phone (and by e-mail when known) before anything
  is created; an existing contact is updated.
- **Non-blocking.** The call or text flow only enqueues a job. The sync runs on the background delivery queue
  with the same retry schedule as Zapier (2 s, 8 s, 30 s) on rate limits (429), server errors (5xx) and
  network trouble. 401/403 is final and recorded as `crm.auth_failed` so the admin can replace the token.
- **Credentials.** One access token per tenant and CRM, stored encrypted (AES-256-GCM with `CRED_KEY`,
  bound to the tenant and provider, exactly like calendar tokens). The token is never returned by any
  endpoint, never logged, never written to a public file. Logs carry only tenant slug, provider and status.

## Admin endpoints

All require `Authorization: Bearer <RUNTIME_ADMIN_TOKEN>`.

| Call | Purpose |
|---|---|
| `PUT /crm/{slug}/{provider}` body `{"token": "..."}` | Store (or replace) the token, encrypted |
| `POST /crm/{slug}/{provider}/test` | Read-only auth check against the CRM (HubSpot: list 1 contact; Jobber: `account { id name }`) |
| `GET /crm/{slug}` | `{provider: {"connected": bool, "enabled": bool}}` |
| `DELETE /crm/{slug}/{provider}` | Remove the token |

`provider` is `hubspot` or `jobber`.

## HubSpot

**API:** CRM v3 (`api.hubapi.com`), authenticated with a *private app* access token.

**Field mapping**

| Lead field | HubSpot |
|---|---|
| phone | contact `phone` (matched against `phone` and `mobilephone`) |
| name | contact `firstname` / `lastname` (split on the first space) |
| email | contact `email` (also used for matching) |
| address | contact `address` |
| (always) | contact `lifecyclestage` = `lead` |
| summary, job type, urgency, channel, booked window, screening answers | one **note** (`hs_note_body`) associated to the contact |
| booking (`booking.created` only) | one **deal**: `dealname` = "<job type> - <name>", `closedate` = booked start, stage `appointmentscheduled` in the default pipeline, associated to the contact |

**How the client creates the private app** (HubSpot account with Super Admin rights):

1. Settings > Integrations > **Private Apps** > *Create a private app*. Name it after the receptionist.
2. Scopes tab, grant exactly:
   `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`.
   Notes: included with the contacts scopes (HubSpot treats notes as "engagements" on the contact; no separate
   scope is required for the note calls used here).
3. *Create app* > *Show token* > copy it. Send it to us through a secure channel (never e-mail or chat), or paste
   it yourself into the portal; we store it with `PUT /crm/{slug}/hubspot`.
4. We run the test call; "ok" means the link is live.

Private-app tokens do not expire but can be rotated in HubSpot at any time; after a rotation repeat step 3.

## Jobber

**API:** GraphQL (`api.getjobber.com/api/graphql`, header `X-JOBBER-GRAPHQL-VERSION: 2025-01-20`),
authenticated with a Bearer access token.

**Field mapping**

| Lead field | Jobber |
|---|---|
| phone | `clients(searchTerm:)` lookup; on create: `phones[0]` (MAIN, primary) |
| name | `clientCreate` `firstName` / `lastName` |
| email | `emails[0]` (MAIN, primary) |
| address | `billingAddress.street1` |
| job type (+ booked window) | `requestCreate` `title` ("AC repair (Tuesday Oct 13, 8 AM to 12 PM)") |
| summary, urgency, channel, booked window, screening answers | `clientCreateNote` on the client |

**Production dependency.** Jobber only issues API tokens to an **approved developer app** through OAuth 2.0
(authorization code). App approval is a manual review by Jobber and can take weeks; the OAuth connect flow
(authorize URL, callback, refresh) is not built yet and is scheduled right after that approval.
Until then the link works with a **manually obtained token** stored through `PUT /crm/{slug}/jobber`
(for example a token from the Jobber developer centre's "test in GraphiQL" flow). Those tokens expire,
so this mode is for pilots, not for unattended production. The mutation field names used
(`clientCreate`, `requestCreate`, `clientCreateNote`) follow the 2025-01-20 schema and are verified against
the client's account during the test call before go-live.

## Not built yet: GoHighLevel and Housecall Pro

Both would reuse the same `CrmClient` contract (find-or-create contact by phone, one note per event, a
pipeline object for bookings; same encrypted token store, same queue, retries and exactly-once key),
so each is a new file in `runtime/app/crm/` plus tests, not a new subsystem.

- **GoHighLevel**: REST API v2 (`services.leadconnectorhq.com`), auth either an OAuth marketplace app or a
  *Private Integration* token issued per sub-account (location). Objects: contacts (`/contacts/`, lookup by
  phone via `/contacts/search`), notes (`/contacts/{id}/notes`), opportunities (`/opportunities/`) in a chosen
  pipeline for bookings. Private Integration tokens make a pilot possible without marketplace review.
- **Housecall Pro**: REST API (`api.housecallpro.com`), customers + jobs/estimates. The API is available only
  on the **MAX** plan and third-party apps need Housecall Pro's approval; a pilot needs a client on MAX who
  issues an API key from their account. Bookings would map to a job with the booked arrival window.
