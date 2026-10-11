# 06 · Connect other tools (Zapier)

target_seconds: 100
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** סעיף 6 בצ'ק-ליסט, רשות. הלקוח יוצר Zap עם הטריגר "Webhooks by Zapier → Catch Hook", מדביק את הכתובת בפורטל, אנחנו שולחים אירוע בדיקה, והוא מחבר פעולה (למשל שורה בגיליון או לקוח חדש ב-Jobber). שלושה אירועים: ליד חדש, הזמנה חדשה, שיחה שהסתיימה. Webhooks by Zapier זמין רק בתוכנית Zapier בתשלום (לאמת לפני הקלטה). חיבור ישיר ל-CRM הוא תוספת נפרדת (`ADD-CRM`) ולא מוזכר כאן כהבטחה. השדה בפורטל עוד לא קיים (B7). כפתור הבדיקה קיים ב-runtime כנתיב אדמין (`POST /zapier/{slug}/test`).

| | |
|---|---|
| Goal | A client who uses other tools sends lead and booking events to them through one Zapier webhook. Others skip the item. |
| Plays in | Checklist item 6 "Connect other tools" |
| Products | `RCP`, `BNDL` (1 outgoing Zapier webhook included) |
| Formats | 1920×1080 MP4 + captions |
| CTA | "Paste your webhook URL" |

## What exists today (checked in the repo)
- Events: `lead.created`, `booking.created`, `call.completed`; JSON POST with an `X-Signature` HMAC header; 3 retries (report B6, `docs/zapier-payloads.md`).
- Test event: `POST /zapier/{slug}/test` (admin token) sends "Test event from your AI receptionist".
- The portal field for the webhook URL and a client-side "Send test" button: `[PENDING B7]`.

## Scenes

### S1 · 0:00–0:12 · Skip or not (motion graphics)
- **On-screen text:** "Optional" · "Use other tools? Send them each new lead."

VO: This step is optional. If you don't use other business tools, mark it done and move on.

### S2 · 0:12–0:45 · Create the Zap (screen recording, test Zapier account)
- **Record:** zapier.com → **Create → Zaps** → Trigger: **Webhooks by Zapier** → Event **Catch Hook** → Continue → copy the webhook URL.
- **On-screen text:** "Webhooks by Zapier needs a paid Zapier plan"

VO: If you do, open Zapier and create a new Zap.
VO: For the trigger, pick Webhooks by Zapier, then Catch Hook. Zapier gives you a web address. Copy it.
VO: Webhooks by Zapier needs a paid Zapier plan.

### S3 · 0:45–1:05 · Paste it in the portal `[PENDING B7]`
- **Record:** item 6 → paste the URL into the webhook field → **Save** → **Send test**.

VO: Paste that address into this step in your portal and click Save. Then click Send test.

### S4 · 1:05–1:35 · Finish the Zap (screen recording)
- **Record:** back in Zapier → **Test trigger** → the test event appears → add an action, for example **Google Sheets → Create Spreadsheet Row** (test sheet) → map name, phone, job type → Publish.
- **On-screen text:** "New lead · New booking · Call completed"

VO: Back in Zapier, click Test trigger. You'll see our test event.
VO: Now add the action you want, like a new row in a spreadsheet, and map the fields. Publish the Zap.
VO: From now on, we send three kinds of events: a new lead, a new booking, and a finished call.

## Production notes
- Use a test Zapier account and a test Google Sheet. Blur the webhook URL after copying (it's a secret-like address).
- Don't name CRMs as "supported through Zapier" in the voice; the native integration add-on is quoted separately.
