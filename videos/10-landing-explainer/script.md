# 10 · Landing explainer (60 seconds, no face)

target_seconds: 60
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** סרטון 60 שניות לדף הנחיתה של שירותי בית (מוחלף ב-`01-what-it-does` מהתוכנית המקורית). בלי פנים: מסך + גרפיקה + כתוביות צרובות (רוב הצפיות בלי קול). מה מוצג: שיחה שפוספסה, הטלפון מצלצל קודם, קו ה-AI עונה בשם העסק, שואל פרטים, קובע מתוך יומן אמיתי, הבעלים מקבל SMS ומייל, text-back למי שניתק, חירום = 911 קודם. אחר כך: המספר נשאר, אין שיחת מכירה, שאלון של 6 דקות והצעת מחיר קבועה בכתב (`{{brand.quote_sla_text}}` מהקונפיג). אין מחיר בקול (כדי שהסרטון לא יתיישן), אין הבטחות לתוצאות. הקלטת הצ'אט נעשית מהדמו הקיים בדף (`#demo`). מקום להטמעה בדף הנחיתה עוד לא קיים ב-`tools/build_landing.py` (לא בתחום שלי). גרסה אנכית לרשתות ול-Upwork.

| | |
|---|---|
| Goal | In 60 s a home-services owner understands what happens to a missed call and how buying works, then tries the demo. |
| Plays in | Landing `/` and `/home-services/` (suggested slot: inside `#how-it-answers`, muted autoplay off, poster frame) `[slot not built; owner of tools/build_landing.py]` · quote page `/quote/` under "What we'll build" (optional) · Upwork portfolio item (SPEC §7) |
| Products | `RCP` (home services). A real-estate cut can reuse S3–S5 with the Maple & Main demo later. |
| Formats | 1920×1080 MP4 + burned-in captions; 1080×1920 vertical; poster frame per `../thumbnail-spec.md` |
| CTA | "Try the demo on this page" |

## Scenes

### S1 · 0:00–0:07 · The problem (motion graphics)
- **Visual:** phone on a roof ledge, ringing, "Missed call" banner; second phone shows "Booked with another company" (generic, no brand).
- **Caption:** same as VO.

VO: You're on a roof. Your phone rings. By the time you call back, they've booked someone else.

### S2 · 0:07–0:18 · The answer (motion graphics)
- **Visual:** the forwarding diagram from video 02 S2, faster. Brand name from `brand.json` `name` on the title chip.
- **On-screen text:** "{{brand.name}}" · "Your phone rings first"

VO: {{brand.name}} answers the calls you miss. If no one picks up, your AI receptionist answers in your business name.

### S3 · 0:18–0:34 · The conversation (screen recording, exists today)
- **Record:** `http://localhost:8787/home-services/#demo`, scenario button `.demo__pick[data-scenario="ac"]`; capture the chat until the "booked" bubble. Keep the label "Demo — no real booking is made" visible (`brand.json` `disclaimers.demo`).
- **On-screen text:** "Name · address · job · urgency" · "Only real openings from your calendar"

VO: It asks for the name, address and job, and books an open time on your calendar.
VO: You get a text and an email for every lead.

### S4 · 0:34–0:45 · Hang-ups and emergencies (motion graphics)
- **Visual:** text-back bubble ("Sorry we missed your call! … Reply STOP to opt out."); then "I smell gas" → "If anyone is in danger, please hang up and call 911 now." (exact text of `guard.py` LIFE_SAFETY_TEXT) → owner phone "URGENT".
- **Fine print (2 s):** "Text-back starts after US carrier registration, typically 1–2 weeks."

VO: If a caller hangs up, they get a text back. In an emergency, they hear call nine one one first, and you get an urgent alert.

### S5 · 0:45–0:56 · How you buy (screen, exists today)
- **Record:** landing `#how` section (four steps), then `/start/?offer=RCP&niche=home_services` sign-in card.
- **On-screen text:** "Keep your number" · "No sales call" · "6-minute questionnaire → fixed quote in writing {{brand.quote_sla_text}}"

VO: You keep your number. There's no sales call. Answer a six-minute questionnaire and get a fixed quote in writing {{brand.quote_sla_text}}.

### S6 · 0:56–1:00 · CTA
- **On-screen text:** "Try the demo on this page"

VO: Try the demo on this page.

## Production notes
- Captions are burned in for this video only (muted autoplay); the others use sidecar `.vtt`.
- Re-read the landing hero and `#how` copy before recording; the VO must not contradict it (e.g. quote time comes from `brand.json` `quote_sla_text`).
- No customer logos, no "#1", no percentages.
