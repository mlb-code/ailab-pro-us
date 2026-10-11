# AI Lab Pro (US) — Price Book v1 (2026-10-11)

> מחירון בדולרים. מקור האמת למכונה הוא `config/pricebook.json` (נבנה במשימה A3 מהטבלאות כאן). Claude לעולם לא ממציא מחיר: הוא בוחר קודים מהטבלה, והמחיר מחושב בקוד. שינוי מחיר = שינוי כאן + ב-JSON, באישור מאיר.

All prices USD, fixed-price, excluding any sales tax (none expected; service performed outside the US). Setup is paid 50% deposit / 50% before go-live. Monthly fees start on the go-live date, billed monthly in advance, cancel anytime with 30 days notice.

## 1. Core offers (sold now)

| Code | Offer | Setup | Monthly | Delivery |
|---|---|---|---|---|
| `RCP` | Missed-Call AI Receptionist | $3,500 | $300 | 10 business days after access is complete |
| `WEB` | Business Website (template-based, 5 pages) | $1,900 | $129 | 7 business days after content is complete |
| `BNDL` | Receptionist + Website bundle | $4,900 | $400 | 14 business days |

### `RCP` includes
- 1 location, 1 AI line (a US number we provision; the client keeps their existing number and forwards unanswered calls to it).
- Voice answering of missed/forwarded calls + automatic SMS text-back to callers who hang up.
- Collects job details (name, callback number, service address/ZIP, job type, urgency, preferred time).
- Booking into 1 calendar: Google Calendar or Calendly.
- Up to 25 FAQ entries, business hours, after-hours mode, emergency keywords → owner alert.
- Owner notifications by SMS + email for every lead; daily summary email.
- 1 outgoing Zapier webhook (lead/booking events) to connect any other tool.
- English. Client portal with call log, transcripts, bookings, settings.
- A2P 10DLC SMS registration handled by us (registration fees included).
- Included usage per month: 400 voice minutes + 1,000 SMS segments. Overage billed at cost + 20%, reported monthly.
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

## 2. Add-ons

| Code | Add-on | Applies to | Setup | Monthly |
|---|---|---|---|---|
| `ADD-LOC` | Additional location / AI line | RCP | $900 | $100 |
| `ADD-ES` | Spanish (bilingual line) | RCP | $750 | $50 |
| `ADD-CRM` | Native CRM/FSM integration, per system (Jobber, Housecall Pro, GoHighLevel, HubSpot) | RCP | $1,200 | $50 |
| `ADD-CHAT` | Website chat widget (same AI brain) | RCP | $500 | $25 |
| `ADD-REV` | Post-job review-request SMS | RCP | $400 | $0 |
| `ADD-USAGE` | Extra usage block: +400 min / +1,000 SMS | RCP | $0 | $60 |
| `ADD-PAGE` | Extra website page | WEB | $250 | $0 |
| `ADD-WEB-ES` | Spanish version of the website | WEB | $900 | $20 |
| `ADD-LOGO` | Simple logo (wordmark + icon) | WEB | $300 | $0 |
| `ADD-BLOG` | Blog section + 3 starter articles | WEB | $600 | $0 |
| `ADD-RUSH` | Rush delivery (half the business days) | any | +25% of setup | $0 |

Custom (not auto-priced → "custom quote", Meir prices manually): ServiceTitan, Dentrix/Open Dental/any EHR, more than 3 locations, call volume > 3,000 min/month, HIPAA BAA requests.

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
6. Quote valid 14 days. Upwork jobs: same prices; Upwork fee is ours to absorb.
7. Refund policy (pending lawyer; owner to confirm): the setup deposit is fully refunded on request within 7 days of payment, as long as the client has not completed the access checklist. Retainers: 75% refund of the first payment if cancelled within 7 days.
