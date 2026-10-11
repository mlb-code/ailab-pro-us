# Upwork kit — v1 (2026-10-11)

Copy-paste kit for the Upwork profile, Project Catalog, proposals and daily routine.
Client-facing text is US English. Notes for the owner are marked **Note**.

**Price source:** `docs/PRICEBOOK.md` v1 / `config/pricebook.json`. Every dollar amount below was copied from there. If the price book changes, update this file before you paste anything.
**Brand values** (name, domain, Calendly link) come from `config/brand.json`. Below they appear as `{{brand.name}}`, `{{brand.domain}}`, `{{brand.calendly_url}}`. Replace them when you paste.
**Config text** is pasted word for word from config, never retyped: `{{brand.quote_sla_text}}` (quote turnaround, now "within 1 business day") and `{{refund_rules.rcp_guarantee.text}}` (the satisfaction guarantee on the receptionist and the bundle, from `config/pricebook.json`). The website on its own has no satisfaction guarantee (only the deposit rule).

Niches in this kit: **home services** (HVAC, plumbing, electrical, roofing, garage doors, locksmiths) and **real estate**. Dental: early access only (see Upwork rules, item 9). No other niches.

---

## 1. Profile

### 1.1 Title (70 characters; Upwork limit is 70)
```
AI Receptionist & Automation for Home Service Businesses — Fixed Price
```

### 1.2 Overview (paste as is; about 2,000 characters, limit is 5,000)
```
Your phone rings while you are on a roof. The caller hangs up and calls the next company. I fix that.

I build a Missed-Call AI Receptionist for home service businesses: HVAC, plumbing, electrical, roofing, garage doors and locksmiths. It also works for real estate agents.

What's included:
- An AI line that answers your missed or forwarded calls, day and night
- An automatic text-back to callers who hang up
- It collects the job details: name, callback number, address or ZIP, job type, urgency
- It books the job into your Google Calendar or Calendly
- You get a text and an email for every lead, plus a daily summary
- Emergency keywords alert you right away
- A client portal with call log, transcripts, bookings and settings
- A Zapier webhook to connect your other tools (Jobber, Housecall Pro and more)

Fixed prices. You see the price before you start:
- AI Receptionist: $3,500 setup + $300/month
- Business website (5 pages): $1,900 setup + $129/month
- Both together: $4,900 setup + $400/month

How we work (no meetings needed):
1. You answer a short online questionnaire (about 6 minutes).
2. You get a written fixed quote {{brand.quote_sla_text}}.
3. You pay a 50% deposit (on Upwork, as the first milestone).
4. You follow a setup checklist. Every step has a short video.
5. I build and test. You test it yourself before go-live.
6. Handoff by video. You pay the second 50% before go-live.

AI Receptionist and the bundle: {{refund_rules.rcp_guarantee.text}}

Prefer to talk? An optional 15-minute video call is always available.

About me:
I am a senior solo builder based in Israel. I build with Claude, Anthropic's AI model (I am not affiliated with Anthropic). I work with Samsung and Haier in Israel (through their Israeli distributor) and with other Israeli corporate clients. You work directly with me. No account managers, no hand-offs.

Response time: within one business day, Sunday–Thursday (Israel time).

I do not promise results like "double your leads". I promise a clear scope, a fixed price, and a working system you can test before you pay the final 50%.
```

**Note:** "Samsung and Haier" — wording pending owner approval. Use exactly the sentence above (the work is through their Israeli distributor). Do not upload their logos unless you have written permission.

### 1.3 Skills (pick up to 15)
AI Chatbot · Voice Agent · Twilio · Conversational AI · Automation · Zapier · API Integration · Google Calendar API · Calendly · SMS Automation (Twilio) · Website Development · Landing Page · Claude · Python · Supabase

### 1.4 Hourly rate
**Note:** Not in the price book. Meir decides. Keep the profile focused on fixed price. If a client asks for hourly, offer a fixed quote instead.

### 1.5 Portfolio (3 items)
| # | Title | What to upload | Description (paste) |
|---|---|---|---|
| 1 | Missed-call AI receptionist — live demo (HVAC) | Screenshot of the chat demo + link to `{{brand.domain}}/demo/` (only in portfolio, not in proposals before a contract) | A demo HVAC company. A caller says "My AC is blowing warm air". The AI asks for the ZIP, offers two time windows and books the job. Demo only: no real booking is made. |
| 2 | Client portal — call log, transcripts, bookings | 2 screenshots of the portal (demo data only) | Every call and text in one place. The owner sees transcripts, bookings and settings, and can pause the AI with one click. |
| 3 | 60-second walkthrough video | The "What it does" video (B11 script 01) | How a missed call becomes a booked job, start to finish. |

**Note:** Assets come from tasks A4 (demo), B7 (portal) and B11 (video). Use demo data only. Never show a real client's data.

---

## 2. Project Catalog (2 listings)

Upwork Project Catalog has 3 tiers. Upwork counts **calendar days from the order**, so delivery days below include time for the access checklist.

### 2.1 Listing A — AI Receptionist
**Title:**
```
You will get an AI receptionist that answers calls and books jobs
```
**Category:** AI Apps & Integration (or closest: Chatbot Development).
**Tiers:**
| Tier | What's included | Price | Delivery |
|---|---|---|---|
| Starter | AI Receptionist (`RCP`): 1 location, 1 AI line, voice + text-back, booking into Google Calendar or Calendly, up to 25 FAQ entries, lead alerts, daily summary, client portal, 1 Zapier webhook | $3,500 | 21 days |
| Standard | Starter + 1 native CRM/FSM integration (`ADD-CRM`): Jobber, Housecall Pro, GoHighLevel or HubSpot | $4,700 | 24 days |
| Advanced | Receptionist + 5-page business website (`BNDL`), AI line on the site, web chat widget included | $4,900 | 28 days |

**Description (paste):**
```
Stop losing jobs to voicemail.

I set up an AI receptionist for your business. When you can't answer, it answers. It collects the job details, books the appointment into your calendar, and sends you a text and an email for every lead.

What's included (Starter):
- 1 US phone number for the AI line. You keep your number and forward unanswered calls to it.
- Voice answering + automatic text-back to callers who hang up
- Job details: name, callback number, address/ZIP, job type, urgency, preferred time
- Booking into Google Calendar or Calendly
- Business hours, after-hours mode, up to 25 FAQ entries
- Emergency keywords: instant alert to you
- Lead alerts by text + email, daily summary email
- Client portal: call log, transcripts, bookings, settings
- 1 Zapier webhook to connect other tools
- SMS registration (A2P 10DLC) handled by me, fees included
- Included usage: 400 voice minutes + 1,000 SMS segments per month

Monthly service plan: $300/month (Standard: $350/month, Advanced: $400/month). It starts on the go-live date and covers the phone line, usage above, monitoring, and small updates. Billed as a separate monthly contract. Cancel anytime with 30 days' notice.

{{refund_rules.rcp_guarantee.text}}

Not included: outbound calling, marketing texts, ServiceTitan or other custom systems (ask me for a custom quote), more than 1 location (add-on).

How it works:
1. After you order, I send a short questionnaire (about 6 minutes).
2. You follow a setup checklist. Every step has a 2-minute video.
3. I build and test. You call the line yourself before go-live.
4. Handoff by video.

Built with Claude (Anthropic's AI model). I am not affiliated with Anthropic.
Response time: within one business day, Sunday–Thursday (Israel time).
```
**Requirements (asked at order):** business name and website · main phone number · which calendar (Google Calendar / Calendly) · business hours and time zone · service area (ZIPs or cities) · CRM in use, if any.
**FAQ (paste up to 3):**
- *Do I need to change my phone number?* No. You forward unanswered calls to the AI line.
- *Does it record calls?* No audio is recorded. Calls are transcribed, and the greeting says so.
- *Can I talk to you first?* Yes. An optional 15-minute video call is available. It is not required.

### 2.2 Listing B — Business Website
**Title:**
```
You will get a fast 5-page website for your home service business
```
**Tiers:**
| Tier | What's included | Price | Delivery |
|---|---|---|---|
| Starter | Website (`WEB`): 5 pages, mobile-first, lead form, click-to-call/text, basic local SEO, hosting + SSL | $1,900 | 14 days |
| Standard | Starter + simple logo (`ADD-LOGO`) | $2,200 | 14 days |
| Advanced | Standard + blog section with 3 starter articles (`ADD-BLOG`) | $2,800 | 18 days |

**Description (paste):**
```
A clean, fast website that turns visitors into calls and form leads.

What's included:
- 5 pages: Home, Services, About, Reviews/FAQ, Contact
- Mobile-first design, fast hosting, SSL
- Lead form to your email + a Google Sheet
- Click-to-call and click-to-text buttons
- Basic local SEO: titles and meta, LocalBusiness schema, sitemap, Google Search Console, link to your Google Business Profile
- Copy written from your questionnaire answers. You approve every page.
- Stock photos or your own photos

Monthly plan: $129/month. Hosting, uptime check, 1 small content edit per month. Starts at launch. Billed as a separate monthly contract. Cancel anytime with 30 days' notice.

Add-ons: extra page $250 · Spanish version $900 + $20/month.

Response time: within one business day, Sunday–Thursday (Israel time).
```

---

## 3. Proposal templates (3)

Rules for every proposal: under 180 words · first line answers their post · no links and no contact details before a contract (Upwork rule) · one fixed price from the price book · end with one question.

### 3.1 Home services
```
Hi {first name},

You wrote that {their pain, in their words}. That is the most common problem I see: the phone rings while the crew is on a job, and the caller books someone else.

I build a Missed-Call AI Receptionist for {trade} businesses. It answers when you can't, collects the job details (address, job type, urgency), books into your {Google Calendar / Calendly}, and texts you every lead. Callers who hang up get an automatic text-back.

Fixed price: $3,500 setup + $300/month (starts at go-live, cancel with 30 days' notice). With a {Jobber / Housecall Pro} integration: $4,700 + $350/month.

How we work: after we start the contract, you fill out a 6-minute questionnaire. I send a written scope {{brand.quote_sla_text}}. First milestone = 50%. Setup checklist with short videos. You test it yourself before the final 50%.

{{refund_rules.rcp_guarantee.text}}

No meetings needed. An optional 15-minute video call is available if you prefer.

Quick question: about how many calls do you miss in a busy week?

{Name}
Built with Claude (not affiliated with Anthropic)
```

### 3.2 Real estate
```
Hi {first name},

You need {their need, e.g. "every lead answered fast, even during showings"}. I can set that up.

I build an AI receptionist for agents and teams. When you can't pick up, it answers the call, asks the basic questions (buying or selling, area, budget range, timeline), and books a call or showing slot into your calendar. Callers who hang up get a text-back. You get a text and an email for every lead.

It can send each lead to {Follow Up Boss / your CRM} through a Zapier webhook (included).

Fixed price: $3,500 setup + $300/month. With a native HubSpot or GoHighLevel integration: $4,700 + $350/month.

Process: short questionnaire after we start the contract → written fixed scope {{brand.quote_sla_text}} → 50% first milestone → setup checklist with videos → you test it before the final 50%.

{{refund_rules.rcp_guarantee.text}}

Do you want leads booked directly into your calendar, or only qualified and sent to you?

{Name}
Built with Claude (not affiliated with Anthropic)
```

### 3.3 General (automation / website / other)
```
Hi {first name},

{One sentence that restates their goal}. I can deliver this at a fixed price.

My plan:
1. {step 1}
2. {step 2}
3. {step 3}

{Pick one price line from the price book:}
- Website, 5 pages: $1,900 setup + $129/month
- AI receptionist: $3,500 setup + $300/month
- Receptionist + website: $4,900 setup + $400/month
- Anything else: written fixed quote after a 6-minute questionnaire

I am a senior solo builder. I work with Samsung and Haier in Israel (through their Israeli distributor) and with other Israeli corporate clients. You work directly with me.

Process: questionnaire → written fixed quote {{brand.quote_sla_text}} → 50% first milestone → build → video handoff. An optional 15-minute call is available.

Response time: within one business day, Sunday–Thursday (Israel time).

{One specific question about their job.}

{Name}
Built with Claude (not affiliated with Anthropic)
```

**Note:** "Anything else" (automation, agents, systems) is priced as a custom quote by Meir in admin. Never write a number that is not in the price book.

---

## 4. Search terms (15 saved searches)
1. AI receptionist
2. missed call text back
3. AI phone answering
4. AI voice agent small business
5. virtual receptionist AI
6. HVAC automation
7. plumbing business AI
8. roofing company leads automation
9. Jobber integration
10. Housecall Pro automation
11. GoHighLevel AI voice
12. Twilio voice AI
13. real estate lead follow up AI
14. Follow Up Boss automation
15. home service business website

Filters for every saved search: payment verified · client location United States · fixed-price budget of 1,000 USD or more, or hourly · posted in the last 24 hours.

---

## 5. Daily routine (20 minutes, Sunday–Thursday)
Target: **10 proposals per week** (2 per working day).
| Minutes | What |
|---|---|
| 0–5 | Open the saved searches. Pick the 2 best jobs: US client, payment verified, clear problem, budget fits. Skip jobs with "test task for free" or that want calls only. |
| 5–15 | Write 2 proposals from the templates. Change the first line and the question every time. Check the price against the price book. |
| 15–20 | Answer messages and invitations. Every message gets a reply within one business day. Log jobs and proposals in the leads sheet. |

Every Thursday: 5 extra minutes. Which proposals got replies? Adjust the first lines.

---

## 6. Upwork rules (must follow)
1. **Payment only through Upwork** for any client you met on Upwork. No PayPal, no bank transfer, no invoices outside Upwork (Upwork's rule is 24 months, unless the client pays the conversion fee).
2. **No contact details and no outside links before a contract** (no email, phone, website, Calendly, questionnaire link). After the contract starts, you may send the questionnaire link and the Calendly link for the optional call.
3. Deposit = **first milestone (50% of setup)**. Second milestone (50%) before go-live. The monthly plan = a separate monthly fixed-price contract, started at go-live.
4. Prices on Upwork = price book prices. The Upwork fee is ours to absorb. Never raise the price to cover it.
5. The 30% `FOUNDING` discount (first 3 clients) is applied only by Meir, on setup only.
6. Do not promise results ("guaranteed", "double your leads", "% more jobs"). Use "what's included". The one exception is the satisfaction guarantee: paste `{{refund_rules.rcp_guarantee.text}}` exactly, only for the receptionist and the bundle, never for the website alone, and never reword it into a results promise. On Upwork the refund goes back through Upwork (the setup milestones).
7. Do not claim compliance ("HIPAA compliant", "TCPA compliant"). You can say what the product does (STOP is honored, no audio recording, text-back only after a caller's own call).
8. Honest location: profile says Israel. Response time: within one business day, Sunday–Thursday (Israel time).
9. **Dental:** early access only. Do not bid on jobs that need patient records, EHR access (Dentrix, Open Dental) or a HIPAA BAA. If a dental office invites you, reply that dental is in early access and the AI collects only name, phone and a general reason for the call.
10. Do not use "Claude" in the profile name or agency name. "Built with Claude (not affiliated with Anthropic)" in text is fine.
11. Product limits: no outbound AI calls, no marketing texts. The channels are voice, SMS and web chat.
12. Never share a real client's data in proposals, portfolio or messages.
