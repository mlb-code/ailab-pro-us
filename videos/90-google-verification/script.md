# 90 · Google OAuth verification demo (internal, for Google's reviewers)

target_seconds: 120
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm · upload as YouTube **Unlisted**

> **תקציר למאיר:** לא סרטון ללקוחות. זה הסרטון שגוגל דורשים בבקשת ה-verification ל-scope הרגיש `calendar.events` (ראו `docs/runbooks/google-oauth-verification.he.md`, שלב 4). הוא צריך להראות: כניסה לפורטל, לחיצה על Connect Google Calendar, מסך ההסכמה עם שם האפליקציה וה-scope (ועם ה-client ID בשורת הכתובת), חזרה לפורטל, ואירוע שנוצר ביומן. מקליטים רק אחרי B7 (כפתור בפורטל) ואחרי שה-runtime עולה עם Google client אמיתי (B9), עם חשבון בדיקה. אפשר להקליט באותו סשן של סרטון 03.

| | |
|---|---|
| Goal | Pass Google's OAuth verification for `https://www.googleapis.com/auth/calendar.events`. |
| Plays in | Google Cloud Console → OAuth consent screen → Prepare for verification (YouTube Unlisted link) |
| Formats | 1920×1080 MP4, one continuous screen recording (no cuts inside the OAuth flow), captions |
| Depends on | B7 portal button, B9 deployed runtime on the real domain, Google OAuth client (runbook stage 3) |

## Scenes (one take; Google reviewers want an unedited flow)

### S1 · Portal sign-in `[PENDING B7]`
- **Record:** the real domain from `brand.json` `site_url` + `/start/` with the address bar visible; sign in as the test client.

VO: This is the client portal of {{brand.name}}. A business owner signs in to connect the calendar their AI receptionist books into.

### S2 · Connect `[PENDING B7]`
- **Record:** **Onboarding** → item 2 "Connect your calendar" → **Connect Google Calendar**.

VO: In the setup checklist, the owner clicks Connect Google Calendar.

### S3 · Consent screen (Google, real)
- **Record:** account chooser → consent screen. Zoom so the app name, the requested permission and the address bar (with `client_id=`) are readable. Click **Continue**.

VO: Google shows our app name and the one permission we request: to view and edit events on the owner's calendars. We don't request contacts, email, or any other Google data.

### S4 · Back in the portal `[PENDING B7]`
- **Record:** redirect to `/start/?calendar=google&result=connected` and the "Connected" state.

VO: The owner returns to the portal, and the calendar shows as connected.

### S5 · How the scope is used (simulator + Google Calendar)
- **Record:** a test call through the deployed runtime (B9 smoke test) or the simulator pointed at the test tenant, ending in a booking; then the test Google Calendar showing the new event "Booked by AI receptionist" with the job details.

VO: When a customer calls and books a visit, the receptionist reads existing events to find open times, then creates one event with the job details.
VO: It only changes events it created. Owners can disconnect at any time from their Google account settings.

## Production notes
- The privacy policy URL and the home page on the verified domain must be live before submitting (runbook stage 4).
- "It only changes events it created": matches `runtime/app/calendar/base.py` (cancel only our own events). Re-check before recording.
