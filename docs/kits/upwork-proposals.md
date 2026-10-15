# Upwork proposal kit — v1 (2026-10-15)

> **למאיר (בקצרה):**
> - שלוש תבניות הצעה (מזכירה AI / אתר / אוטומציה), כל אחת בגרסה קצרה (משרות זולות בקונקטים) ומלאה. מחליפים רק את מה שבסוגריים מסולסלים `{...}`. המקרא בסעיף 1.
> - **שורה ראשונה = הבעיה של הלקוח במילים שלו.** זה מה שהוא רואה בתצוגה המקדימה. לא "Hi, I'm Meir".
> - **הוחלט (15.10):** בלי קישור ליומן, בלי טלפון ובלי מייל בשום תבנית או תשובה. אפוורק אוסר פרטי קשר לפני חוזה. הקישור היחיד המותר הוא `https://ailabpro.co` ודפיו. שיחה מציעים רק "here on Upwork". אם הלקוח רוצה לשמוע את הקו, כותבים: "call the demo line on ailabpro.co (top of the page)". הבודק נכשל אם מופיע טלפון, מייל או קישור יומן.
> - מחיר המייסדים ($2,450) רק ל-3 הלקוחות הראשונים. אחרי הלקוח השלישי מוחקים את השורה האופציונלית.
> - הבודק `python3 tools/proposals_check.py` רץ בתוך `make qa-fast`: אורך ≤180 מילים, קישור לדמו, בלי הבטחות אסורות ובלי שמות לקוחות, וכל סכום בדולרים קיים במחירון.

Client-facing text is US English. Every dollar amount comes from `config/pricebook.json` (checked by `tools/proposals_check.py`). The only link allowed before a contract is `config/brand.json` `site_url` (and its pages). No phone numbers, emails or calendar links (Upwork rule; the checker fails on them).
Each copy-paste block is marked `<!-- template: ... -->` or `<!-- snippet: ... -->` so the checker can find it. Do not remove those markers.

---

## 1. Placeholders (legend)

| Placeholder | What to write | Example |
|---|---|---|
| `{their_problem}` | Their problem, in their own words from the job post. One short sentence. This is the first line the client sees. | "Half our after-hours calls go to voicemail and we lose them" |
| `{their_need}` | What they asked for (website jobs), in their words. | "a simple site that gets the phone ringing" |
| `{their_goal}` | Their automation goal, in their words. | "new leads followed up automatically" |
| `{first_name}` | Client's first name if shown; otherwise delete it and write "Hi there,". | Mike |
| `{trade}` | Their trade or business type. | HVAC / plumbing / roofing / real estate |
| `{tool}` | The CRM or field-service tool named in the post. | Jobber, Follow Up Boss |
| `{question}` | Only if you replace the default closing question. Keep it one question. | "Who answers the phone after 5 PM today?" |

**Optional founding line** (receptionist templates only, while fewer than 3 founding clients have signed):
<!-- snippet: founding-line -->
```text
I'm taking 3 founding clients at $2,450 setup (same $300/month) in exchange for a short case study.
```

**Demo line** (if the client wants to hear the AI on a real call):
<!-- snippet: demo-line -->
```text
You can call the demo line on ailabpro.co (top of the page) to hear it answer.
```

---

## 2. Templates

### 2.1 (a) AI receptionist / missed calls / after-hours answering

**Short** (jobs that cost few Connects):
<!-- template: a-short -->
```text
Hi {first_name},

{their_problem}: this is exactly what I build for {trade} businesses.

- An AI line answers missed and after-hours calls in your business name; callers who hang up get a text back
- It collects the job details and books into your Google Calendar or Calendly
- You get a text and an email for every lead

Fixed price: $3,500 setup + $300/month. Live 10 business days after your setup checklist.

Try the demo: https://ailabpro.co/demo/
Happy to do a 15-minute call here on Upwork if you prefer.

Which calendar do you book jobs in today?

Meir
```

**Full:**
<!-- template: a-full -->
```text
Hi {first_name},

{their_problem}. When the phone rings during a job, most callers try the next company on the list.

I build a Missed-Call AI Receptionist for {trade} businesses. What you get:
- An AI line that answers missed and after-hours calls in your business name. You keep your number and forward unanswered calls to it. Callers who hang up get a text back.
- It collects name, callback number, address or ZIP, job type and urgency, then books an open slot in your Google Calendar or Calendly.
- A text and an email to you for every lead, a daily summary, and an urgent alert when a caller uses an emergency keyword.

Fixed price: $3,500 setup + $300/month (starts at go-live). Live 10 business days after your setup checklist is done. 30-day satisfaction guarantee on the setup fee.

Try the demo (2 minutes, no sign-up): https://ailabpro.co/demo/
Happy to do a 15-minute call here on Upwork if you prefer.

Quick question: in a busy week, about how many calls go to voicemail?

Meir
```

### 2.2 (b) Website for a contracting or real-estate business

**Short:**
<!-- template: b-short -->
```text
Hi {first_name},

You need {their_need}. I build 5-page websites for {trade} businesses with one job: get the visitor to call, text or fill in the form.

- 5 pages, mobile-first, fast hosting and SSL
- Click-to-call, click-to-text, and a lead form to your email and a Google Sheet
- Basic local SEO and your Google Business Profile link

Fixed price: $1,900 setup + $129/month. Live 7 business days after your content is in.

Sample site: https://ailabpro.co/demo-site/home-services/
Happy to do a 15-minute call here on Upwork if you prefer.

Do you already own a domain?

Meir
```

**Full:**
<!-- template: b-full -->
```text
Hi {first_name},

You need {their_need}. For a {trade} business, the website has one job: get the visitor to call, text or fill in the form.

What you get:
- 5 pages (Home, Services, About, Reviews/FAQ, Contact), mobile-first, fast hosting and SSL
- Click-to-call and click-to-text buttons on every page, plus a lead form that goes to your email and a Google Sheet
- Basic local SEO: page titles, LocalBusiness schema, sitemap, Google Search Console and a link to your Google Business Profile

I draft the text from a 10-minute questionnaire. You approve every page before launch.

Fixed price: $1,900 setup + $129/month (hosting, uptime check, 1 small edit a month). Live 7 business days after your content is in. Extra pages are $250 each.

Sample site: https://ailabpro.co/demo-site/home-services/
Happy to do a 15-minute call here on Upwork if you prefer.

Do you already own your domain, or should we register one in your name?

Meir
```

### 2.3 (c) Automation / Zapier / CRM follow-up

**Note:** apply only when the job is about **lead intake or follow-up** (missed calls, new inquiries, booking). For pure "connect app A to app B" Zapier jobs, skip, or send the general template from `upwork.md` §3.3 with a written custom quote. Never write a price that is not in the price book.

**Short:**
<!-- template: c-short -->
```text
Hi {first_name},

You want {their_goal}. Most follow-up gaps start in the first minute, when a lead calls and nobody answers.

- An AI line answers missed calls, texts back hang-ups, collects the details and books
- Each lead goes to {tool} through a Zapier webhook (included)
- A text and an email to you for every lead

Fixed price: $3,500 setup + $300/month. Live 10 business days after access. Different workflow? Written fixed quote within 1 business day.

Demo: https://ailabpro.co/demo/
Happy to do a 15-minute call here on Upwork if you prefer.

Where do your leads come in today: calls, forms, or both?

Meir
```

**Full:**
<!-- template: c-full -->
```text
Hi {first_name},

You want {their_goal}. In most small businesses I look at, the gap starts in the first minute: a lead calls or writes, nobody answers, and the lead moves on.

What I'd set up:
- An AI line that answers missed calls, texts back callers who hang up, collects the details (name, phone, address or ZIP, job type, urgency) and books into Google Calendar or Calendly
- Each lead and booking sent to {tool} through a Zapier webhook (included), or written directly into Jobber, Housecall Pro, GoHighLevel or HubSpot with a native integration
- A text and an email to you for every lead, plus a daily summary

Fixed price: $3,500 setup + $300/month. Native integration: +$1,200 setup + $50/month. Live 10 business days after access. If your workflow is different, you get a written fixed quote within 1 business day.

Demo: https://ailabpro.co/demo/
Happy to do a 15-minute call here on Upwork if you prefer.

Which system is your source of truth for leads today?

Meir
```

---

## 3. Boost paragraph (tool named in the job post)

Add these 5 lines above the price line of any template when the post names one of the tools below. Pick line 2 from the table. What we actually support comes from `config/pricebook.json` → `integrations`: Jobber, Housecall Pro = native add-on (`ADD-CRM`); Follow Up Boss, kvCORE = Zapier; ServiceTitan = custom (no ready connection). Do not promise more.

<!-- snippet: boost -->
```text
You mentioned {tool}, so here is exactly how it connects:
{tool_line}
The AI collects the same fields on every call (name, phone, address or ZIP, job type, urgency), so records arrive complete.
Nothing changes in how your team already works in {tool}.
If a field you need is not covered, I will say so in the written scope before you pay anything.
```

`{tool_line}` options:

<!-- snippet: boost-fsm -->
```text
Jobber / Housecall Pro: leads and bookings can be written directly into {tool} with a native integration (+$1,200 setup + $50/month), or sent through the Zapier webhook that is already included.
```
<!-- snippet: boost-zapier -->
```text
Follow Up Boss / kvCORE: each lead is sent to {tool} through the Zapier webhook that is included, using your own Zapier account. There is no direct native connection.
```
<!-- snippet: boost-servicetitan -->
```text
ServiceTitan: I don't have a ready-made ServiceTitan connection. You get every lead by text and email from day one, and I can quote a custom integration in writing after I see your setup.
```

---

## 4. Which jobs to apply to

### 4.1 Apply only if ALL of these are true
1. **Client in the United States.**
2. **Money:** fixed budget **≥ $1,000**, **or** payment verified **and** the client has spent **≥ $1,000** on Upwork. Hourly jobs: only if the top of the range is **≥ $40/hour** (we still quote fixed price).
3. **Fits an offer:** missed calls / after-hours answering / AI receptionist; a website for a contractor, home-service or real-estate business; lead follow-up into a CRM we support (see §3).
4. You can name their problem in one sentence from their own post.

### 4.2 Skip, even if the budget is good
- "Build me a SaaS", "white-label platform", "clone Dialzara / Smith.ai / Rosie", "AI agency for resale".
- Hourly jobs under $40/hour.
- Anything that needs **phone sales**, outbound calling, cold calling, appointment setting or marketing texts (the product does not do outbound or marketing).
- Medical / dental work that needs patient records, EHR access or a HIPAA BAA (see `upwork.md` rule 9).
- "Test task for free", "calls only", or a request to talk off Upwork before a contract.
- Non-US clients.

### 4.3 Connects policy
- **Max 16 Connects per bid**, boost included. If the job costs more, skip.
- **Max 5 bids per day.** Quality over volume; the target in `upwork.md` (10 per week) stays.
- Short template when the job costs ≤ 8 Connects or the budget is under $2,500; full template otherwise.
- Boost only jobs posted in the last 6 hours with fewer than 10 proposals.
- Every Thursday: count bids, replies and interviews in the leads sheet. Two weeks with zero replies on one template = rewrite its first line.

---

## 5. Screening questions — answers bank

Paste and adjust. Keep each under ~80 words.

<!-- snippet: q-experience -->
```text
Q: Describe your recent experience with similar projects.
A: I build AI assistants, lead-intake flows and websites for small businesses and corporate clients. My current product is a Missed-Call AI Receptionist for home-service and real-estate businesses: it answers calls you miss, texts back hang-ups, collects the job details and books into Google Calendar or Calendly. You can try it here: https://ailabpro.co/demo/ . I work solo, so you deal with the person who builds it.
```

<!-- snippet: q-timeline -->
```text
Q: How long will this take?
A: AI receptionist: live 10 business days after you finish the setup checklist (calendar, alerts, business details). Website: live 7 business days after your content is in. Both together: 14 business days. Texting starts after US carrier registration, typically 1-2 weeks; voice answering works from day one.
```

<!-- snippet: q-portfolio -->
```text
Q: Please share a link to your portfolio or past work.
A: Live demo of the AI receptionist (be the customer, tap the replies): https://ailabpro.co/demo/
Sample 5-page website for a demo HVAC company: https://ailabpro.co/demo-site/home-services/
Both use demo data only. Client work stays private.
```

<!-- snippet: q-availability -->
```text
Q: What is your availability and time zone?
A: I'm based in Israel (7 hours ahead of New York). I'm online Monday to Thursday 9 AM-3 PM Eastern for messages and calls, and I answer every message within one business day. Most of the work runs in writing, so you don't need to be online at the same time.
```

<!-- snippet: q-tools -->
```text
Q: What tools and technologies do you use?
A: Claude (Anthropic's AI model) for the conversation, Twilio for calls and texts, Google Calendar or Calendly for booking, Zapier for connecting other tools, and Supabase for the client portal and data. Native integrations are available for Jobber, Housecall Pro, GoHighLevel and HubSpot. Built with Claude; I'm not affiliated with Anthropic.
```

<!-- snippet: q-approach -->
```text
Q: How would you approach this project?
A: 1. You answer a 6-minute questionnaire. 2. You get a written fixed quote within 1 business day: scope, what's included and what isn't. 3. 50% first milestone. 4. You follow a short setup checklist; every step has a 2-minute video. 5. I build and test, and you try it yourself before the final 50%. No hourly billing.
```

---

## 6. Loom video

Script and shot list: `videos/11-upwork-loom.md` (60 seconds for the receptionist, 20 seconds for the website).
