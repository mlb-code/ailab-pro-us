# AI Lab Pro (US) — Price Book v1.1 (2026-10-25)

> מחירון בדולרים. מקור האמת למכונה הוא `config/pricebook.json` (נבנה במשימה A3 מהטבלאות כאן). Claude לעולם לא ממציא מחיר: הוא בוחר קודים מהטבלה, והמחיר מחושב בקוד. שינוי מחיר = שינוי כאן + ב-JSON, באישור מאיר.
>
> v1.1 (אישור מאיר 25.10.2026, "כן לפי ההמלצות"; מקור: `ailab-pro-us-internal/docs/reports/dual-pricing-2026-10.he.md` + `pricing-research-2026-10.he.md`): תוספות חדשות (כונן לילה, תגובה לליד, מעקב הצעות), ספרדית ‎$350 + ‎$30, בקשת ביקורת ‎$25 לחודש, חבילות Never Miss a Job ו-Growth, מנהל תורים בבסיס, ומסלול ב' (‎$0 הקמה) שמור במחירון מאחורי דגל כבוי.

All prices USD, fixed-price, excluding any sales tax (none expected; service performed outside the US). Setup is paid 50% deposit / 50% before go-live. Monthly fees start on the go-live date, billed monthly in advance, cancel anytime with 30 days notice.

Two ways to pay (owner decision 2026-10-25): **Plan A** = setup + monthly (the prices in the Setup and Monthly columns; the only plan sold today). **Plan B** = $0 setup and a higher monthly for a 12-month minimum (column "Plan B monthly"); it is kept here behind `rules.plan_b_enabled = false` and is **not shown on the site or offered in quotes** until the Tranzila USD standing-order terminal and its FX rate are confirmed (§5).

Status: `available` = can be quoted and bought now. `coming soon` = listed on the site with a "Coming soon" label, never quotable or purchasable (the quote engine rejects it). Everything marked coming soon needs business texting, which starts only after US phone carriers approve our texting registration (A2P 10DLC).

## 1. Core offers (sold now)

| Code | Offer | Setup | Monthly | Plan B monthly | Status | Delivery |
|---|---|---|---|---|---|---|
| `RCP` | Missed-Call AI Receptionist | $3,500 | $300 | $650 | available | 10 business days after access is complete |
| `WEB` | Business Website (template-based, 5 pages) | $1,900 | $129 | $319 | available | 7 business days after content is complete |
| `BNDL` | Receptionist + Website bundle | $4,900 | $400 | $890 | available | 14 business days |

### `RCP` includes
- 1 location, 1 AI line (a US number we provision; the client keeps their existing number and forwards unanswered calls to it).
- Voice answering of missed/forwarded calls + automatic SMS text-back to callers who hang up.
- Collects job details (name, callback number, service address/ZIP, job type, urgency, preferred time).
- Booking into 1 calendar: Google Calendar or Calendly.
- Up to 25 FAQ entries, business hours, after-hours mode, emergency keywords → owner alert.
- Owner notifications by SMS + email for every lead; daily summary email.
- Appointment manager (included, no extra fee): callers can check, move or cancel a visit we booked for them by calling back; returning callers are recognized (first name, next visit, last job type). Rescheduling by text (C/R/X replies) switches on only after texting registration.
- 1 outgoing Zapier webhook (lead/booking events) to connect any other tool.
- English. Client portal with call log, transcripts, bookings, settings.
- A2P 10DLC SMS registration handled by us (registration fees included).
- Included usage per month: 400 voice minutes + 1,000 SMS segments. We alert you at 80% and 100%. No automatic overage billing: extra usage blocks (ADD-USAGE) are added only with your approval.
- Monthly: monitoring, prompt/FAQ updates, 1 active change request at a time (small changes, ≤ 1 hour each).

### `WEB` includes
- 5 pages (Home, Services, About, Reviews/FAQ, Contact), mobile-first, fast static hosting, SSL.
- Lead form → email + Google Sheet; click-to-call and click-to-text buttons.
- Basic local SEO: titles/meta, LocalBusiness schema, sitemap, Google Search Console + Google Business Profile link.
- Copywriting from the questionnaire (Claude-drafted, client-approved), stock or client photos.
- Monthly: hosting, uptime check, 1 small content edit per month.
- Sold directly from the page (choose package → pay deposit → questionnaire). No quote step unless add-ons are requested.

### `BNDL`
`RCP` + `WEB` with the AI line number on the site and a web chat widget included. Saves $500 setup / $29 monthly.

### Trade bundles (coming soon)

| Code | Offer | Setup | Monthly | Plan B monthly | Status | Delivery |
|---|---|---|---|---|---|---|
| `BNDL-NM` | Never Miss a Job bundle | $4,700 | $450 | $920 | coming soon | — |
| `BNDL-GROW` | Growth bundle | $5,400 | $500 | $1,040 | coming soon | — |

- `BNDL-NM` = `RCP` + `ADD-DISPATCH` + `ADD-LEAD` (separately $5,100 + $500, so it costs $400 less setup and $50 less a month).
- `BNDL-GROW` = `BNDL-NM` + `ADD-QUOTE` + `ADD-REV` (separately $6,000 + $575).
- Both contain `ADD-LEAD` (texting), so both are **coming soon**. Decision 2026-10-25: Never Miss a Job is not sold without its lead follow-up part, because the bundle price is set for all three parts. Until texting is live, sell `RCP` + `ADD-DISPATCH` ($4,200 + $375) instead; the upgrade path to the bundle is an open owner decision.
- They are not in `rules.core_codes` yet: making them sellable also needs the database offer enums (`offer_code`, `clients.products`) and the RCP-or-BNDL checks in the portal, e-mails and payments widened.

## 2. Add-ons

| Code | Add-on | Applies to | Setup | Monthly | Plan B monthly | Status |
|---|---|---|---|---|---|---|
| `ADD-DISPATCH` | After-hours dispatch to your on-call tech | RCP | $700 | $75 | $145 | available |
| `ADD-LOC` | Additional location / phone number | RCP | $900 | $100 | $190 | available |
| `ADD-ES` | Spanish (bilingual line) | RCP | $350 | $30 | $65 | available |
| `ADD-CRM` | Direct link to your job or customer app, per app (Jobber, Housecall Pro, GoHighLevel, HubSpot) | RCP | $1,200 | $50 | $170 | available |
| `ADD-CHAT` | Chat box on your website (same answers as your phone line) | RCP | $500 | $25 | $75 | available |
| `ADD-LEAD` | Fast follow-up for new leads | RCP | $900 | $125 | $215 | coming soon |
| `ADD-QUOTE` | Follow-up on quotes you have sent | RCP | $500 | $50 | $100 | coming soon |
| `ADD-REV` | Google review requests after each job | RCP | $400 | $25 | $65 | coming soon |
| `ADD-USAGE` | Extra minutes and texts: +400 min / +1,000 texts | RCP | $0 | $60 | $60 | available |
| `ADD-PAGE` | Extra website page | WEB | $250 | $0 | — | available |
| `ADD-WEB-ES` | Spanish version of the website | WEB | $900 | $20 | $110 | available |
| `ADD-LOGO` | Simple logo (wordmark + icon) | WEB | $300 | $0 | — | available |
| `ADD-BLOG` | Blog section + 3 starter articles | WEB | $600 | $0 | — | available |
| `ADD-RUSH` | Rush delivery (half the business days) | any | +25% of setup | $0 | — | available |

What the new add-ons do:
- `ADD-DISPATCH` (voice only, built 2026-10-23): urgent calls at night/weekends (or always, by choice) are warm-transferred to the on-call tech: up to 3 numbers in order, each hears a one-line brief and presses 1 to take it; nobody takes it → the caller is told when to expect a callback and the on-call team gets an alert **phone call**. Staff text alerts stay off until texting registration. On-call list and urgent-call log in the portal.
- `ADD-LEAD` (coming soon): reply to a new web/lead-site lead within 60 seconds, plus an AI call when the lead consented; up to 300 leads a month from 2 sources (above that: `ADD-USAGE`, open owner decision).
- `ADD-QUOTE` (coming soon): 2 information-only reminders per sent quote, AI answers replies and books; no discounts.
- `ADD-REV` (coming soon): the review request after each job needs its own texting campaign ($10/month to us), hence the $25 monthly.
- Appointment manager is part of `RCP` (no code, no fee).

Custom (not auto-priced → "custom quote", Meir prices manually): ServiceTitan, any EHR or practice-management system, more than 3 locations, call volume > 3,000 min/month, HIPAA BAA requests.

## 3. Later offers (on the price book, not marketed in phase A)

| Code | Offer | Setup | Monthly |
|---|---|---|---|
| `MAP` | AI Opportunity Map (written report + Loom walkthrough) | $1,900 | — |
| `AUTO` | Workflow automation (1 process, up to 3 tools) | from $3,500 | $500 |
| `AGENT` | Custom AI agent (beyond the receptionist) | from $5,000 | $400 |
| `SYS` | Internal system (portal/dashboard, custom) | from $12,000 | custom |
| `APP` | Mobile/web app | from $18,000 | custom |
| `RET-CARE` | Retainer — Care (monitoring + 1 active request, ~4 h/mo) | — | $500 |
| `RET-GROW` | Retainer — Growth (1 active request, ~15 h/mo) | — | $1,500 |
| `RET-STUDIO` | Retainer — Studio (unlimited requests, 1 at a time) | — | $4,000 |

"from" prices are never auto-quoted: the quote engine marks them `custom` and Meir sets the number in admin.

## 4. Quote rules (enforced in code, `supabase/functions/_shared/pricing.ts`)
1. Line items = exactly one core offer (`RCP` | `WEB` | `BNDL`) + 0..n add-ons whose `applies_to` matches. Unknown codes are rejected.
2. Totals = sum of table prices × quantity. Rush = 25% of the setup subtotal before rush.
3. Deposit = 50% of setup total, rounded to whole dollars; final = setup total − deposit.
4. If any item is `custom` or setup total > $10,000 → quote status `needs_manual_price`; it cannot be sent until Meir enters prices.
5. Discount: only `FOUNDING` (founding-client, first 3 clients) = 30% off setup, applied by Meir in admin, never by Claude. Monthly fees are never discounted.
6. Quote valid 14 days. Upwork jobs: same prices; Upwork fee is ours to absorb. Upwork sells Plan A only (`rules.upwork_plans`), or the annual prepay: setup + 12 months of the monthly fee for the price of 10 (`rules.annual_prepay`, "12 months for the price of 10", Upwork Direct Contracts). The prepay is a payment option, not a discount on the monthly fee.
7. Refund policy (final 2026-10-12, aligned with market standard; no attorney review yet): the setup deposit is fully refunded on request within 7 days of payment, as long as the client has not completed the access checklist. Retainers: 75% refund of the first payment if cancelled within 7 days.
   - Satisfaction guarantee (owner decision 2026-10-11) on `RCP` and `BNDL`: if the client is not satisfied within 30 days after go-live, we refund the setup fee and switch the line off. Monthly fees for the period used are not refunded. `WEB` keeps only the 7-day deposit rule, since content work starts immediately.
   - Bundle scope (decision 2026-10-12, `rcp_guarantee.bundle_refunds = rcp_setup_part`): on `BNDL` we refund only the AI Receptionist part of the setup fee (the `RCP` stand-alone setup price, less the same percentage discount the client got), not the full bundle setup fee. The website stays with the client; its monthly plan continues unless cancelled.
   - Business days for every SLA (`brand.quote_sla_text`) are Sunday–Thursday, Israel time (`brand.business_days_text`).
   - Client-facing copy reads all of this from `config/pricebook.json` → `refund_rules` (`deposit.text`, `rcp_guarantee_days`, `rcp_guarantee.text` / `.legal` / `.label`); never type the numbers by hand.
8. The `FOUNDING` discount is labelled "Founding-client price" in client copy (`rules.discounts.FOUNDING.label`).
9. Liability cap (decision 2026-10-12, legal v1.1; `rules.liability_cap_months`, `rules.liability_cap_floor_usd`): our total liability is the greater of the fees paid in the 6 months before the event or $500. Refunds owed under the refund policy (rule 7, including the 30-day satisfaction guarantee) are outside the cap and stay payable. The legal pages stamp both numbers from config (Terms §15, Service Agreement §15).
10. Availability (decision 2026-10-25, `items[].availability`, `rules.availability`): a `coming soon` item is never quoted, never offered to Claude and never purchasable; `pricing.mjs` rejects it (`coming_soon:<code>`). The site lists it under "Coming soon" with `rules.availability.coming_soon_text` and makes no texting promise for it. Today coming soon = `ADD-LEAD`, `ADD-QUOTE`, `ADD-REV`, `BNDL-NM`, `BNDL-GROW` (all need texting registration).

## 5. Plan B: no setup fee, 12-month minimum (approved 2026-10-25, not published)

`rules.plan_b_enabled = false`: Plan B is not shown on the site, not offered in quotes, and the public site copy of the price book (`site/assets/pricebook.json`) drops `rules.term_plan` and every `plan_b_monthly_cents`. The quote engine rejects a Plan B request (`plan_b_not_available`). Turn it on only after the Tranzila USD standing-order terminal and its FX rate are confirmed (if the FX spread is 2.5% or more, the premium goes to 25% and the table is recomputed).

- Price: Plan B monthly = monthly + setup × 1.2 ÷ 12, whole dollars (a 20% premium on the setup part). Every "Plan B monthly" cell above follows it; `tools/pricebook_test.py` checks it. The customer breaks even with Plan A in month 10.
- Term: 12 months minimum, card on file. Payment 1 of 12 is charged at signing and refunded in full within 7 days if the access checklist is not complete (same as the Plan A deposit); payments 2–12 every 30 days from go-live.
- After 12 months the price drops to the Plan A monthly, and the client can cancel any time with 30 days notice.
- Leaving early (after the 30-day guarantee): only the unpaid share of the setup fee, setup × remaining months ÷ 12, in one charge to the card on file. No other fee.
- 30-day guarantee on `RCP` and bundles: on Plan B the client leaves with no balance. Months paid are not refunded.
- Never a discount on the monthly. `FOUNDING` applies to Plan A setup only (Plan B has no setup fee). Plan B is sold on our site only, never on Upwork.
- One-time items (`ADD-PAGE`, `ADD-LOGO`, `ADD-BLOG`, `ADD-RUSH`) have no Plan B; `ADD-USAGE` has no setup, so its Plan B price is the same.
