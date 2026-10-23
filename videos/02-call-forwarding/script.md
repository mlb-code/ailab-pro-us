# 02 · Forward your missed calls

target_seconds: 150
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** סעיף 1 בצ'ק-ליסט (מפעילים רק אחרי אישור go-live). מוסבר שהמספר של הלקוח לא משתנה: הטלפון שלו מצלצל קודם, ורק שיחה שלא נענתה (או קו תפוס) עוברת לקו ה-AI. יש גרסה כללית אחת (`main`) ושש גרסאות לפי ספק: AT&T, Verizon, T-Mobile, Google Voice, RingCentral, וקו נייח (Comcast Business ודומיו). כל גרסה = הקטע הכללי + קטע הספק. **הקודים צריכים אימות מול כל ספק לפני ההקלטה** (ספקים משנים קודים ותפריטים, ויש תוכניות שבהן ההעברה בתשלום). ב-Google Voice אין העברה "רק כשלא עונים" למספר חיצוני, ולכן הסרטון אומר זאת בכנות ומפנה ל-Need help. בדיקה לפי B7: לוחצים Start test, ואז יש 30 דקות להתקשר. הבודק אומר "this is a test" (ניתוק בלי דיבור = text-back לטלפון שלו).

| | |
|---|---|
| Goal | The client turns on forward-on-no-answer (and busy) to the AI line, tests it, and knows how to turn it off. |
| Plays in | Checklist item 1 "Forward your missed calls" (the portal shows the cut that matches the carrier the client picks; default `main`) · link in the `final_payment_due` and `went_live` emails |
| Products | `RCP`, `BNDL` |
| Formats | 1920×1080 MP4 per cut + captions; vertical 1080×1920 for the three wireless carriers (owners do this on their phone) |
| CTA | "Make a test call" |
| Cuts | `main` (base only), `att`, `verizon`, `tmobile`, `gvoice`, `ringcentral`, `landline` (each = base + its variant lines, assembled in order: S1–S3, variant scene, S5–S6) |

## Code sheet (on-screen only; verify every line against the carrier's current help page before recording)
`X` = the 10-digit AI line number, shown in checklist item 1. Example in recordings: `7135550199` (a 555 test number).

| Carrier | Forward when not answered | Forward when busy | Turn off | Notes to verify |
|---|---|---|---|---|
| AT&T wireless (phone menu, no dial code) | Android: Phone app → Settings → Calling accounts → your SIM → Call forwarding → **When unanswered** → AI line number | same menu → **When busy** (and **When unreachable**) | switch the same options off | AT&T publishes no dial codes and says forwarding is set from the phone ([KM1011513](https://www.att.com/support/article/wireless/KM1011513/), [Pixel 10 guide](https://www.att.com/device-support/article/140337/Google/pixel-10/)). iPhone has only “forward all calls” → Need help. Leave **Always forward** off. Same as the portal (22.10). |
| T-Mobile (GSM codes) | `**61*1XXXXXXXXXX**20#` | `**67*1XXXXXXXXXX#` | `##61#` · `##67#` · `##004#` | Ring time in steps of 5 s, max 30. Prepaid may differ. |
| Verizon wireless | `*71XXXXXXXXXX` → Call (busy + no answer together) | (same code) | `*73` | Ring time is set by Verizon. Check the plan for forwarding charges. |
| Landlines (Comcast Business VoiceEdge and most phone companies) | `*92` + number, or the provider's app / online portal (Comcast: Call Forwarding → **No Answer**) | `*90` + number (Comcast portal: **Busy**) | `*93` (no answer) · `*91` (busy) | Comcast codes per the official Business VoiceEdge star-code sheet (SLS90624); other Comcast phone products → Need help. Same as the portal (22.10). |
| RingCentral | App/Admin Portal: Settings → Phone → Call handling → unanswered calls → forward to an external number | — | set unanswered calls back to voicemail | Menu names change; admin rights may be needed. |
| Google Voice | No forward-on-no-answer to an outside number | — | — | Linked numbers ring at the same time, so the AI would answer first. → Need help. |

## Scenes

### S1 · 0:00–0:08 · Title (motion graphics)
- **On-screen text:** "Forward your missed calls" / "Step 1 of your checklist · turn it on at go-live"

VO: This is step one of your checklist: sending the calls you miss to your AI line. You'll turn it on at go-live.

### S2 · 0:08–0:30 · How it works (motion graphics)
- **Visual:** a customer's phone → the business number → owner's phone rings (timer 20 s) → arrow to "AI line" → receptionist bubble. Second path: busy signal → AI line.
- **On-screen text:** "Your number stays the same" · "Your phone rings first" · "No answer or busy → AI line"

VO: Your number stays the same, and customers call it like always.
VO: Your phone rings first. If nobody answers in about twenty seconds, or the line is busy, the call moves to your AI line, and your receptionist picks up.

### S3 · 0:30–0:45 · Find your AI line number
- **Record:** portal **Onboarding** → item 1, the AI line number in large type with a Copy button.
- **On-screen text:** "Only after you approve go-live"

VO: Your AI line number is in step one of your checklist. Keep it on screen.
VO: Turn forwarding on only after you've approved go-live. Until then, nothing changes.

### S4 · 0:45–1:25 · Carrier steps (one variant per cut)
- **Visual (AT&T):** no keypad: the Android menu path as animated breadcrumbs (Phone → Settings → Calling accounts → SIM → Call forwarding), then the When unanswered / When busy switches.
- **Visual (other wireless cuts):** vertical phone mock (motion graphics, not a real phone), keypad, the code typed digit by digit, the code sheet line large on the right. Use the example number `7135550199`.
- **Visual (RingCentral):** menu path as animated breadcrumbs. Do not record a real RingCentral account unless it is a test account with no customer data.

VO[att]: On AT&T, there's no code to dial. You set it in your phone. On Android, open the Phone app, then Settings, Calling accounts, your SIM, and Call forwarding.
VO[att]: Turn on When unanswered and When busy, and enter your AI line number for each. Leave Always forward off, so your phone still rings first.
VO[att]: On an iPhone, tap Need help with this step, and we'll set it up with you.

VO[tmobile]: On T-Mobile, open your phone's keypad and type the first code on screen. Replace the X's with your AI line number, starting with a one. Press Call.
VO[tmobile]: The twenty near the end is how many seconds your phone rings first.
VO[tmobile]: Then type the second code, for busy calls, and press Call again. Your phone shows a confirmation.

VO[verizon]: On Verizon wireless, open your phone's keypad. Type star seven one, then your AI line number, and press Call.
VO[verizon]: This one code covers both busy and unanswered calls. Wait for the confirmation tone, then hang up.
VO[verizon]: Some plans charge for forwarded minutes, so check yours.

VO[landline]: On most business landlines, including Comcast Business, pick up the handset and dial star nine two, then your AI line number. That forwards calls you don't answer.
VO[landline]: Star nine zero does the same for busy calls.
VO[landline]: If your provider has an online portal, you may find this under call forwarding, no answer, instead.

VO[ringcentral]: In RingCentral, open Settings, then Phone, then Call handling.
VO[ringcentral]: Find what happens to calls you don't answer, choose forward to another number, and enter your AI line number. Save.
VO[ringcentral]: Check both business hours and after hours, so the receptionist covers nights too. You may need your account admin for this.

VO[gvoice]: Google Voice rings all your linked phones at the same time. That means it can't send only the calls you miss to another number.
VO[gvoice]: If your business number is on Google Voice, open Need help in this step. We'll write back with the options that fit your setup.

### S5 · 1:25–1:50 · Test call
- **Record:** portal item 1 → **Start test** (`#ob_test`) → message "we watch for 30 minutes" → (mock) the item turns Done with "Test call received … Forwarding works." The real side needs B9 (Twilio).
- **On-screen text:** "1 Start test · 2 call within 30 minutes · 3 say "this is a test""

VO: Now test it. In this step, click Start test. You then have thirty minutes to make the call.
VO: From a different phone, call your business number and let it ring. When the receptionist answers, say, this is a test, then hang up.
VO: If you hang up without speaking, that phone gets a text back. The step turns to Done when the call reaches your AI line.

### S6 · 1:50–2:05 · Turn off + help
- **On-screen text:** the "Turn off" column for the cut's carrier · "Code didn't work? → Need help"

VO: To turn forwarding off, use the cancel code on screen. Your phone goes back to normal.
VO: Carriers change their menus from time to time. If a step doesn't work, open Need help in this step and tell us your carrier.

## Production notes
- Before recording: open each carrier's current support page for conditional call forwarding and confirm every code and menu name in the code sheet. Record the date checked in this file.
- Never show a real customer's phone number. Use 555 numbers only.
- Read codes on screen, not in the voice (except Verizon's short `*71` and the landline `*92`/`*90`), so a code change only needs a new caption, not new narration.
- Quiet-hours and text-back rules don't apply to this video; don't mention them.
