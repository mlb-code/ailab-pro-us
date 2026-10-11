# 01 · Welcome — what happens now

target_seconds: 120
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** הסרטון הראשון שהלקוח רואה אחרי שהמקדמה סומנה כשולמה. הוא מסביר איפה הפורטל, מה זה הצ'ק-ליסט (7 סעיפים, כל אחד עם סרטון), איך מבקשים עזרה בכתב, ומה לוח הזמנים: רישום SMS (1–2 שבועות), בנייה (כ-10 ימי עסקים), מספר ניסיון, אישור go-live, ובסוף העברת שיחות. אין בו הבטחות ואין מחירים. מתאים ל-RCP ול-BNDL. ללקוח WEB בלבד יש את סרטון 09. מסך הצ'ק-ליסט עוד לא קיים (B7), ולכן סצנות 3–4 מוקלטות מהפורטל של B7 (7 סעיפים בסדר: העברת שיחות, יומן, שעות, FAQ, חירום, Zapier, SMS + go-live).

| | |
|---|---|
| Goal | The client knows where to go, what to do first, and what happens next. No call needed. |
| Plays in | Link in the `deposit_received` email ("Welcome aboard — your setup checklist is ready") · portal **Home** status card when stage = Setup checklist · top of the **Onboarding** tab `[PENDING B7]` |
| Products | `RCP`, `BNDL` |
| Formats | 1920×1080 MP4 + captions. No vertical cut. |
| CTA | "Open your setup checklist" |

## Scenes

### S1 · 0:00–0:09 · Title (motion graphics)
- **Visual:** navy background, amber rule, title card per `../thumbnail-spec.md` layout A. Logo from `brand.json` `name`.
- **On-screen text:** "Welcome aboard" / "What happens now"

VO: Welcome aboard. Your deposit is in, and your setup has started.
VO: This short video shows what happens next, and what we need from you.

### S2 · 0:09–0:30 · Portal home (exists today)
- **Record:** recipe R1 in `../README.md` (mock sign-in as the demo client), then `http://localhost:8787/start/?mock_seed=deposit_paid`. Remove `#mockBanner` (recipe R2).
- **Focus/zoom:** `ol.stepper` → highlight `li.is-current` ("Setup checklist"), then `.status__text`.
- **On-screen text:** "Sign in with your email · no password"

VO: Sign in to your portal with your email. There's no password.
VO: The progress bar shows where things stand. You're now at step four, the setup checklist.

### S3 · 0:30–0:58 · Onboarding checklist
- **Record:** portal tab **Onboarding** (B7, "Your setup checklist"). Show the 7 items in B7 order, each with its status pill (`todo / done / need_help`).
- **On-screen text (list, one line per item, B7 order):** 1 Forward your missed calls · 2 Connect your calendar · 3 Business hours · 4 Services & FAQ · 5 Emergencies & alerts · 6 Connect other tools · 7 Texting registration & go-live (copy the exact titles from the portal before recording)

VO: Open the Onboarding tab. You'll see seven short items.
VO: Each one has a video like this one, a short instruction, and a form or a button.
VO: Most items take a few minutes. Together, they take about an hour.
VO: Read call forwarding first, but turn it on only after you've tested everything.

### S4 · 0:58–1:12 · Need help
- **Record:** open **Need help with this step?** on one item; the text box opens; type "Not sure which calendar to connect."
- **On-screen text:** "Need help? Write to us. No calls needed."

VO: If something is unclear, click Need help on that item and write what you see.
VO: We answer in writing, so you never need to get on a call.

### S5 · 1:12–1:40 · Timeline (motion graphics)
- **Visual:** horizontal timeline, same steps and wording as the landing section `#after-you-pay` (Day 0 → Days 1–3 → Day 1 registration → By day 10 → Go-live). Re-read the generated landing page before animating; do not invent new dates.
- **On-screen text:** "Texting registration: typically 1–2 weeks" · "Voice answering doesn't wait for it" · "Built and tested: about 10 business days after your checklist"

VO: Here's the timeline. As soon as your SMS registration info is in, we file your texting registration with US carriers. It usually takes one to two weeks.
VO: Voice answering doesn't wait for it.
VO: Once your checklist is done, we build and test your receptionist. Then you get a test number and call it yourself.

### S6 · 1:40–1:52 · Go-live (motion graphics + portal stepper)
- **Visual:** stepper animates Testing → Live (still of `?mock_seed=live`, recipe R1).

VO: When you're happy with it, you approve go-live and pay the second half.
VO: The last step is call forwarding, and there's a video for that too.

### S7 · 1:52–2:00 · End card
- **On-screen text:** "Start with your setup checklist" · `{{brand.support_email}}` · small: "Narrated by an AI voice."

VO: Open your setup checklist and start at the top. See you inside.

## Production notes
- Wording check: "setup checklist", "test number", "go-live", "call forwarding" are the terms used on the landing pages and portal. Keep them.
- If B7 names the tab differently than "Onboarding", update S3/S4 VO and captions before recording.
