# Follow Up Boss, direct (real-estate tenants)

Two ways to get leads into Follow Up Boss (FUB):

1. **Zapier** (included in the price): the signed webhook (`docs/zapier-payloads.md`) -> "Follow Up Boss" Zap. No API key needed.
2. **Direct Events API** (optional, `real_estate.follow_up_boss.enabled: true`): the runtime posts one event per lead and
   per booking to `POST https://api.followupboss.com/v1/events` (FUB docs: "Events - Create"). FUB itself merges people by
   phone or e-mail, so a repeat caller is updated, never duplicated.

## Credentials
The client's FUB API key (Admin -> API in FUB) is stored encrypted like calendar tokens (AES-GCM, `CRED_KEY`, bound to the
tenant + provider `follow_up_boss`), through the admin endpoint `PUT /crm/{slug}/follow_up_boss {"token": "<api key>"}`.
`POST /crm/{slug}/follow_up_boss/test` calls `GET /v1/me` (read-only). The key is never echoed or logged.
Auth on the wire: HTTP Basic (API key as user name, empty password). `X-System: <our brand, no spaces>`;
`X-System-Key` is sent when `FUB_SYSTEM_KEY` is set (FUB issues it when an integration is registered; optional for Events).

## Payload (per event)
```json
{
  "source": "<real_estate.follow_up_boss.source or our brand name>",
  "system": "<our brand name>",
  "type": "Property Inquiry | Seller Inquiry | General Inquiry",
  "message": "<the lead summary the assistant wrote>",
  "description": "Event: lead.created\nChannel: voice\nJob: Buyer consultation\n...screening answers, one per line...",
  "person": {
    "firstName": "Chris", "lastName": "Kim",
    "phones": [{"value": "+15125550182", "type": "mobile"}],
    "emails": [{"value": "chris@example.com"}],
    "tags": ["<brand> lead", "voice lead", "buyer"],
    "price": "450k to 700k",
    "assignedTo": "<real_estate.follow_up_boss.assigned_to, when set>"
  },
  "property": {"street": "4512 Berkman Dr, Austin 78723"}
}
```
`type` by lead intent: buyer -> Property Inquiry, seller -> Seller Inquiry, renter/unknown -> General Inquiry.
`description` carries every screening answer (intent, area, timeline, price range, pre-approval, property address,
motivation, already working with an agent) and, for bookings, the booked window.

## Delivery
Same path as the other CRM links (`runtime/app/crm/`): the delivery queue, 1 try + retries on 429/5xx/network, exactly
once per (event, conversation), `crm.synced` / `crm.auth_failed` events, nothing personal in logs.
