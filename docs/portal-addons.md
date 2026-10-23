# Portal add-ons: real-estate lead screening and the website chat box

What a client can change in the portal (`/start/`, tab **My receptionist → Settings**) for the two niche/add-on
features, what only we change, and why. Added 2026-10-23.

## Real-estate lead screening (clients with `business.niche = real_estate`)

Card **Lead screening questions**. The client edits, and the portal saves through `update_tenant_settings`
(key `real_estate`, validated against `tenant_schema.json` in the browser and again in SQL):

| Setting | What the client sees | Stored as |
|---|---|---|
| Agent name | "Agent name (optional)", up to 80 characters; empty = brokerage name only | `real_estate.agent_name` |
| Questions | 8 fixed questions, each with a checkbox (ask / skip) and up/down arrows. **The list order is the order the assistant asks.** At least one question must stay on. | `real_estate.screening` (array of the question keys, no duplicates, max 8) |
| Rental leads | "Also take rental leads" | `real_estate.renters` |

The 8 questions and their keys: Buying, selling or renting? (`intent`) · Which area or property? (`area`) · Timeline
(`timeline`) · Price range / budget (`price_range`) · Pre-approved for a mortgage? (`pre_approval`) · Property address
(`property_address`) · What's prompting the move? (`motivation`) · Already working with an agent? (`has_agent`).

The card carries a fair-housing note: the assistant never asks about race, religion, national origin, family status
or disability, and never steers callers toward or away from an area. The question list is fixed for that reason —
clients reorder or skip questions, they cannot write new ones.

The patch is merged one level deep, so saving the card never drops the keys the portal does not send.

## Chat box for the client's website (add-on `ADD-CHAT`, `webchat.enabled = true`)

Card **Chat box for your website**. It is read-only: it shows the one line the client pastes right before the
closing `</body>` tag of their site (any site builder with a custom-HTML block works), with a Copy button:

```html
<script src="<runtime URL>/chat/widget.js" data-tenant="<tenant slug>" async></script>
```

The runtime URL comes from `brand.json` (`demo.runtime_url`), the slug from the tenant row. The card also lists the
**allowed website addresses** (`webchat.allowed_origins`) with the note "Chat only works on these addresses. To add
one, send us a Request." When `webchat.enabled` is false the card is not rendered at all.

## What only we change (through the admin or a Request)

| Setting | Why it is ours |
|---|---|
| `real_estate.follow_up_boss` (enabled, source, assigned_to) and the Follow Up Boss API key | The CRM link is part of the setup we deliver and verify; the key itself is stored encrypted as a credential, never in the config. A client patch that includes `follow_up_boss` is refused (`invalid_setting:real_estate.follow_up_boss`). |
| `real_estate.meetings` (lead intent → meeting type) | Must match the calendar event types we configured; the runtime checks them against `booking.job_types`. |
| `webchat.*` — enabled, `allowed_origins`, title, message limit | Turning the add-on on is a billing event; the origin list is a security boundary (exact `https://` origins the widget may be embedded from, so another site cannot ride on a client's assistant). |
| CRM tokens (Zapier webhook, calendar OAuth tokens) | Secrets live in the credential store, not in the tenant config, and are rotated by us. |

Everything the client cannot change here goes through the **Requests** tab, which we work on one at a time.

Tests: `tools/e2e_portal_b7.mjs` (portal, mock backend), `supabase/tests/portal_b7_test.sql` (the RPC, offline in PGlite),
migration `supabase/migrations/20261023100000_us_settings_real_estate.sql`.
