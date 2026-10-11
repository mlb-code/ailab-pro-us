# 03 · Connect your calendar

target_seconds: 120
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** סעיף 2 בצ'ק-ליסט. Calendly היא ברירת המחדל (בלי אימות של גוגל), אבל צריך אצל הלקוח מנוי Calendly בתשלום, וצריך להוסיף ל-event type שאלה ראשונה בשם "Job details". Google Calendar חינמי, אבל עד שגוגל מאשרים את האפליקציה (verification) לא שולחים לקוחות לחבר Google (הטוקן פג אחרי 7 ימים), ולכן גרסת `google` מוקלטת רק אחרי האישור. שתי גרסאות: `calendly`, `google`. הסרטון אומר מה הסוכן עושה ביומן (רק זמנים פנויים בחלונות שהוגדרו, אירוע עם כל הפרטים ועם הכיתוב "Booked by AI receptionist"), ומה קורה אם החיבור נופל (התראה ומעבר לרישום הודעות). כפתורי החיבור בפורטל עוד לא קיימים (B7). צד ה-OAuth קיים ב-runtime (B5).

| | |
|---|---|
| Goal | The client connects one calendar in about two minutes and understands what the receptionist will do with it. |
| Plays in | Checklist item 2 "Connect your calendar"; the item text must say "Calendly (paid plan) or Google Calendar (free)" (TASKS Addendum 2) |
| Products | `RCP`, `BNDL` |
| Formats | 1920×1080 MP4 per cut + captions |
| CTA | "Connect your calendar" |
| Cuts | `main` (base only, used before the client picks) · `calendly` · `google` |

## What exists today (checked in the repo)
- Runtime OAuth: `GET /oauth/{calendly|google}/start` → provider consent → `GET /oauth/{provider}/callback` → 302 to `{brand.site_url}/start/?calendar=<provider>&result=connected|cancelled|error` (`runtime/app/calendar/routes.py`). The portal does not read these params yet `[PENDING B7]`.
- Google scope: `https://www.googleapis.com/auth/calendar.events` only. Events created with `sendUpdates=none`, marked private, text "Booked by AI receptionist" (`runtime/app/calendar/base.py`, `google.py`).
- Calendly: booking through the Scheduling API needs a paid Calendly plan on the client's side; job details go into the first invitee question "Job details" (`runtime/app/calendar/calendly.py`, report B5).
- Token refresh failure → tenant flagged `needs_reconnect`, one alert to the owner (email + SMS), bookings fall back to taking a message (report B5).

## Scenes

### S1 · 0:00–0:15 · Why (motion graphics)
- **Visual:** calendar grid; busy blocks grey; two open windows glow amber ("8–12", "12–4").
- **On-screen text:** "Reads busy times · adds new visits"

VO: Your receptionist books jobs straight into your calendar. To do that, it needs to see when you're busy and add new visits.
VO: This takes about two minutes.

### S2 · 0:15–0:28 · The checklist item `[PENDING B7]`
- **Record:** portal **Onboarding** → item 2. Two buttons: **Connect Calendly** and **Connect Google Calendar**, with the line "Calendly (paid plan) or Google Calendar (free)".

VO: Open Connect your calendar in your checklist. You'll see two buttons. Pick the calendar you already use.

### S3 · 0:28–1:10 · Provider steps (one variant per cut)
- **Record (calendly):** a **test** Calendly account. calendly.com → Scheduling → the service-visit event type → Edit → Invitee questions → add question "Job details" (multiple lines) and drag it to the top → Save. Then portal → **Connect Calendly** → Calendly sign-in → **Allow** → back on `/start/?calendar=calendly&result=connected` → green "Connected" badge `[PENDING B7]`.
- **Record (google):** a **test** Google account. Portal → **Connect Google Calendar** → Google account chooser → consent screen showing the app name from `brand.json` `name` and the permission to view and edit events → **Continue** → back on `/start/?calendar=google&result=connected` → "Connected" `[PENDING B7]`. Only after Google verification is approved (see `docs/runbooks/google-oauth-verification.he.md`); before that the consent screen shows an "unverified app" warning and must not be shown to clients.
- **On-screen text (calendly):** "Paid Calendly plan needed" · "Add the question: Job details"
- **On-screen text (google):** "Free" · "Only events: view and edit"

VO[calendly]: Calendly needs a paid plan for this. First, open the event type you use for service visits.
VO[calendly]: Add a question called Job details, and move it to the top. That's where the receptionist writes the address, the job, and the notes.
VO[calendly]: Then come back to the portal, click Connect Calendly, sign in, and click Allow.

VO[google]: Google Calendar is free. Click Connect Google Calendar, and choose the Google account that holds your work calendar.
VO[google]: Google shows what we're asking for: permission to view and edit events on your calendars. Nothing else. Click Continue.

### S4 · 1:10–1:20 · Connected `[PENDING B7]`
- **Record:** portal item 2 with the "Connected" badge and status `done`.

VO: You'll land back in your portal, and the item shows Connected.

### S5 · 1:20–1:45 · What it does with your calendar (screen + motion)
- **Record:** a booked test event in the test calendar (created by the simulator against the real provider in B12/B9, or a motion-graphics mock of the event card until then). Event card shows: customer name, phone, address, job type, notes, "Booked by AI receptionist". Blur nothing real: test data only.

VO: From now on, the receptionist only offers times that are open, inside the time windows you set.
VO: Every job it books shows up as an event with the customer's name, phone, address and job details, marked Booked by AI receptionist.

### S6 · 1:45–1:58 · If the connection drops
- **On-screen text:** "Connection lost → we alert you · calls switch to taking messages"

VO: If the connection ever stops working, we'll let you know, and calls switch to taking messages until you reconnect.

## Production notes
- Use test accounts only (a test Google Workspace user, a test Calendly seat). No client calendars on screen.
- The same recording session also produces video 90 (Google verification demo).
