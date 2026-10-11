# 07 · Your first week: reading the call log and requesting changes

target_seconds: 150
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** נשלח עם מייל `went_live`. מסביר איך נראות ההתראות (SMS ומייל לכל ליד, URGENT, "Call back requested"), איך קוראים את יומן השיחות והתמלילים, איך מבקשים שינוי (בקשה פעילה אחת, השאר בתור, מייל בכל שינוי סטטוס), מה הלקוח משנה לבד (שעות, FAQ, אנשי התראה), ומה עושה "Pause AI" (המתקשר שומע משפט קצר שהצוות יחזור אליו, וה-AI לא עונה). ההתראות קיימות בקוד (`runtime/app/notify/templates.py`). הלשוניות My receptionist ו-Requests עוד לא קיימות (B7). שמות התוצאות על המסך צריכים להתאים למה ש-B7 יציג.

| | |
|---|---|
| Goal | In week one the client checks alerts, reads a few transcripts, and sends changes as requests, in writing. |
| Plays in | Link in the `went_live` email ("You're live 🎉 — what happens now") · empty state of **My receptionist** `[PENDING B7]` · top of **Requests** `[PENDING B7]` |
| Products | `RCP`, `BNDL` |
| Formats | 1920×1080 MP4 + captions; vertical 1080×1920 cut of S2 only (alerts on the phone, 30 s) |
| CTA | "Open My receptionist" |

## What exists today (checked in the repo)
- Owner SMS alert: `New booking: <name>, <phone>, <job>, <time>. <summary> Details: check your email.`; heads `URGENT lead`, `Call back requested`, `New lead` (`templates.lead_alert`).
- Email subject `New lead: {job_type} · {name} · {city}`; daily summary subject `Today: {n} calls answered, {b} booked` (default 7:00 PM tenant time).
- Call outcomes stored: `booked`, `message`, `handoff`, `emergency`, `spam`, `abandoned` (SPEC §4). Transcripts and texts are deleted after 90 days (SPEC §4).
- Pause: tenant `paused` → caller hears "Thanks for reaching out. Our team will get back to you soon." and the AI does not answer (`runtime/app/conversation.py`).
- Requests: statuses `queued / active / waiting_on_you / done / declined`, one active at a time, `request_update` email on each change (SPEC §2.5, §5; admin side exists in `site/start/assets/admin.js`).

## Scenes

### S1 · 0:00–0:10 · Intro (motion graphics)
- **On-screen text:** "Week one: check, read, request"

VO: You're live. Here's how to keep an eye on your receptionist during the first week.

### S2 · 0:10–0:40 · Alerts (motion graphics phone + email)
- **Visual:** phone mock with three texts built from the real templates (test data): "New booking: Maria G., (713) 555-0142, AC repair, Tue 8–12 …", "URGENT lead: …", "Call back requested: …". Then the email `New lead: AC repair · Maria G. · Houston`.
- **On-screen text:** "Every lead: text + email" · "URGENT and Call back requested first" · "Quiet hours 9 PM–8 AM: reminders wait · booking confirmations don't"

VO: Every lead reaches you by text and by email, with the name, phone and job.
VO: Urgent requests say URGENT. If a caller asked for a person, the text says Call back requested. Call those back first.
VO: Each evening, you also get a short summary of the day.
VO: Texts to your customers follow quiet hours. A booking confirmation goes out right after the call, even at night, but reminders are never sent between nine PM and eight AM.

### S3 · 0:40–1:15 · Call log `[PENDING B7]`
- **Record:** **My receptionist → Calls** with 6–8 seeded test calls (one per outcome). Open one booked call: transcript + summary + booking. Then **Messages** and **Bookings** sub-views.
- **On-screen text:** outcome labels as B7 shows them (booked · message taken · transferred · urgent · hung up · spam).

VO: In My receptionist, open Calls. Each call shows how it ended: booked, message taken, transferred, urgent, or hung up.
VO: Open a call to read the transcript and a short summary. Text conversations are under Messages, and booked jobs are under Bookings.
VO: Transcripts are kept for ninety days.

### S4 · 1:15–1:30 · What to look for (screen, zoom on a transcript line)
- **On-screen text:** "Read a few each day"

VO: This first week, read a few transcripts each day. Look for answers you'd say differently, and questions it couldn't answer.

### S5 · 1:30–2:00 · Request a change `[PENDING B7]`
- **Record:** **Requests → New request** → title "Ask about filter size" → description + pasted transcript line → Submit. Show the queue with one `active` and two `queued` items; drag to reorder.
- **On-screen text:** "One active request at a time" · "Email on every status change"

VO: To change how it answers, open Requests and click New request. Describe the change, and paste the line from the transcript if it helps.
VO: We work on one request at a time. The rest wait in line, and you can reorder them. You'll get an email each time a status changes.

### S6 · 2:00–2:15 · Do it yourself + Pause AI `[PENDING B7]`
- **Record:** **My receptionist → Settings** (hours, FAQ, alerts) → the **Pause AI** switch (don't toggle it on camera; hover only).
- **On-screen text:** "Paused: callers hear a short message, no AI"

VO: Hours, FAQ answers and alert contacts you can edit yourself, in Settings.
VO: If you ever need it to stop answering, use Pause AI. Callers then hear a short message that your team will get back to them.

## Production notes
- All names and numbers are test data (555 numbers, first name + initial).
- Seed data for S3 comes from the simulator (`python -m sim run --all` writes calls to the JSON store) once B7 reads calls from the same store; until then the scene can't be recorded.
