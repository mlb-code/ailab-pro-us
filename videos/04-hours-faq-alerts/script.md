# 04 · Set hours, FAQ and emergency contacts

target_seconds: 150
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** סעיפים 3–5 בצ'ק-ליסט בסרטון אחד (3 שעות, 4 FAQ, 5 חירום והתראות): שעות ומצב אחרי שעות העבודה (`book_next_day` / `message_only` / `emergency_dial`), FAQ (עד 25, הצעה אוטומטית מהאתר), ומי מקבל התראות, כולל מספר כוננות לחירום. מה שנאמר על חירום תואם לקוד: קודם "If anyone is in danger, please hang up and call 911 now", התראה דחופה לבעלים, והשיחה ממשיכה לאסוף פרטים (אלא אם אושרה סכנה). מצב אחרי-שעות ומספר הכוננות ניתנים לעריכה בפורטל (B7 מרחיב את הרשימה הלבנה). על מחירים: אם הלקוח לא מציג מחירים, הסוכן אומר שהמחיר המדויק ניתן במקום. הטפסים ב-B7. אפשר לחתוך את הסרטון לשלושה קטעים (`s-hours`, `s-faq`, `s-alerts`), אחד לכל סעיף בצ'ק-ליסט.

| | |
|---|---|
| Goal | The client fills the three forms correctly the first time: hours + after-hours mode, FAQ, alert contacts + on-call number. |
| Plays in | Checklist items 3 "Business hours", 4 "Services & FAQ", 5 "Emergencies & alerts" (full video on item 3; chapter links on items 4 and 5; copy exact titles from the portal) · later: **My receptionist → Settings** |
| Products | `RCP`, `BNDL` |
| Formats | 1920×1080 MP4 + captions + three chapter clips |
| CTA | "Fill in your hours" |

## Fields shown (from `runtime/app/tenant_schema.json` / SPEC §6.6; client-editable via `update_tenant_settings`: hours, faq, notify, paused, plus after_hours and the on-call number as extended by B7 — confirm in the B7 migration before recording)
- `hours` per weekday (open/close or closed), `after_hours.mode`: `book_next_day` | `message_only` | `emergency_dial`.
- `faq[]` {q, a}, max 25 (PRICEBOOK `RCP` includes "Up to 25 FAQ entries").
- `notify.sms[]`, `notify.email[]`, `notify.daily_summary` (default 19:00 tenant time); `emergency.dial` / `handoff.number`.
- Labels on screen must match the B7 form labels exactly; re-check before recording.

## Scenes

### S1 · 0:00–0:10 · Intro (motion graphics)
- **On-screen text:** "1 Hours · 2 FAQ · 3 Alerts"

VO: Three short forms teach your receptionist about your business: your hours, the questions callers ask, and who gets alerts.

### S2 · 0:10–0:45 · Hours (chapter `s-hours`)
- **Record:** item 3 form. Set Mon–Fri 7:00 AM–6:00 PM, Sat 8:00 AM–12:00 PM, Sun closed. Then the after-hours choice (three options).
- **On-screen text:** "After hours: book the next opening · take a message · put urgent calls through"

VO: In Business hours, set the hours you're open, day by day.
VO: Then choose what happens after hours. The receptionist can book the next open time, take a message only, or put urgent calls through to your on-call phone.
VO: Check that the time zone shown at the top is yours.

### S3 · 0:45–1:22 · FAQ (chapter `s-faq`)
- **Record:** item 4. The suggested list (from the client's website) appears; edit one answer, delete one, add "Do you service Trane units? → Yes, all major brands."
- **On-screen text:** "Up to 25 · short and true · no price? leave it out"

VO: In Services and FAQ, add the questions callers ask most, with short answers in your own words. You can add up to twenty-five.
VO: We suggest a first list from your website, so you can edit instead of typing.
VO: Keep answers short and true. If you don't quote prices over the phone, leave prices out. The receptionist will say your team gives an exact price on site.

### S4 · 1:22–2:05 · Alerts and emergencies (chapter `s-alerts`)
- **Record:** item 5. Add two mobile numbers and one email (test data, 555 numbers, `@example.com`). Then the on-call number field.
- **Visual insert (motion graphics):** caller says "I smell gas" → bubble "If anyone is in danger, please hang up and call 911 now." (`guard.py` LIFE_SAFETY_TEXT) → owner phone buzzes "URGENT lead" → the conversation continues: "What's the address?".
- **On-screen text:** "Every lead: text + email" · "Daily summary every evening" · "Emergency: 911 line first · urgent alert to you · details still collected"

VO: In Emergencies and alerts, add the mobile numbers and emails that should get each new lead. Every lead arrives by text and by email, and a summary arrives every evening.
VO: Then add your on-call number.
VO: If a caller mentions something dangerous, like a gas smell, the receptionist first says: if anyone is in danger, hang up and call nine one one. You get an urgent alert right away, and if the caller stays on, it keeps collecting the details.

### S5 · 2:05–2:15 · Change it later
- **Record:** **My receptionist → Settings** with the same three sections.

VO: You can change your hours, after-hours choice, FAQ, alert contacts and on-call number later, from the My receptionist tab.

## Production notes
- Do not say which words trigger an emergency beyond "a gas smell": the keyword list is per tenant.
- Do not promise response times, arrival times or prices. The receptionist never gives a price unless the client lists one (`pricing.mode = listed`).
