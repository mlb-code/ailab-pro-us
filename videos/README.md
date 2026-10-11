# videos/ — תסריטים (EN) ותוכנית הפקה לסרטוני onboarding והסבר

**סטטוס (11.10.2026):** תסריטים בלבד, ממתינים לאישור מאיר. שום מדיה עוד לא הופקה. ההפקה מתחילה אחרי אישור התסריטים, ורוב הסרטונים גם אחרי B7 (מסכי הפורטל).
**כללים:** בלי פנים ובלי אנשים אמיתיים. הקלטות מסך של הפורטל וה-runtime במצב סימולציה, גרפיקה פשוטה בתנועה, קריינות בקול AI באנגלית אמריקאית (עד 120 מילים לדקה), כתוביות. בלי הבטחות לתוצאות, ובלי מחירים או שם מותג שמוקלדים ידנית: הכול דרך טוקנים מ-`config/brand.json` ו-`config/pricebook.json`.

## 1. רשימת הסרטונים

האורך מחושב מהקריינות ב-120 מילים לדקה (`python3 videos/vo_length.py`). הזמן הסופי ייקבע לפי ה-TTS, והטיימקודים בתסריטים הם הערכה.

| # | תיקייה | על מה | איפה מוטמע | אורך (גרסאות) | אפשר להפיק לפני B7? |
|---|---|---|---|---|---|
| 01 | `01-welcome/` | ברוך הבא, מה קורה עכשיו (אחרי מקדמה) | מייל `deposit_received` · כרטיס הסטטוס ב-Home בשלב Setup checklist · ראש לשונית Onboarding | ~1:50 | חלקית (S1, S2, S5–S7) |
| 02 | `02-call-forwarding/` | העברת שיחות שלא נענו: AT&T, Verizon, T-Mobile, Google Voice, RingCentral, קו נייח | סעיף 1 בצ'ק-ליסט (הגרסה לפי הספק שהלקוח בוחר) · מיילים `final_payment_due`, `went_live` | 1:35 (כללי) · 1:58–2:04 (לכל ספק) | חלקית (גרפיקה וקודים, אחרי אימות מול הספקים) |
| 03 | `03-connect-calendar/` | חיבור יומן: Calendly (ברירת מחדל, מנוי בתשלום) או Google (חינם) | סעיף 2 בצ'ק-ליסט | ~1:00 · 1:24 (`calendly`) · 1:16 (`google`) | לא. Google רק אחרי verification |
| 04 | `04-hours-faq-alerts/` | שעות, FAQ, אנשי התראה ומספר חירום | סעיפים 3–5 (סרטון מלא בסעיף 3, קטעים בסעיפים 4–5) · My receptionist → Settings | ~1:56 | לא |
| 05 | `05-sms-registration/` | פרטים לרישום SMS (A2P 10DLC) | סעיף 7 (יחד עם go-live) | ~1:08 | לא |
| 06 | `06-connect-other-tools/` | Zapier webhook (רשות) | סעיף 6 | ~1:00 | חלקית (צד Zapier) |
| 07 | `07-first-week/` | השבוע הראשון: התראות, יומן שיחות, בקשות שינוי, Pause AI | מייל `went_live` · מצב ריק של My receptionist · ראש Requests | ~2:04 | חלקית (S2 התראות) |
| 08 | `08-monthly-report/` | הדוח החודשי, שורה אחר שורה | המייל החודשי (`monthly_roi`) · My receptionist → Reports · `monthly_invoice` | ~1:36 | כן (מלבד S5) |
| 09 | `09-website-handoff/` | מסירת אתר ללקוח WEB/BNDL | מייל `went_live` של WEB · Home של לקוח אתר | 1:36 (`main`) · 1:48 (`bndl`) | כן (מלבד S5) |
| 10 | `10-landing-explainer/` | הסבר של 60 שניות לדף הנחיתה, בלי פנים, כתוביות צרובות | `/` ו-`/home-services/` (מקום מוצע ב-`#how-it-answers`; עוד אין slot ב-`tools/build_landing.py`) · דף ההצעה (רשות) · תיק עבודות ב-Upwork | ~0:58 | כן |
| 90 | `90-google-verification/` | סרטון פנימי לבקשת האימות של גוגל (YouTube Unlisted) | Google Cloud → Prepare for verification | ~1:00 | לא (צריך B7 + B9) |

**כיסוי הצ'ק-ליסט (לפי הסדר ב-B7, 7 סעיפים):** 1 העברת שיחות → 02 · 2 יומן → 03 · 3 שעות → 04 S2 · 4 FAQ → 04 S3 · 5 חירום והתראות → 04 S4 · 6 Zapier → 06 · 7 רישום SMS + go-live → 05 (ו-01 S6). כל סעיף מכוסה. את הכותרות המדויקות מעתיקים מהפורטל לפני ההקלטה.
**מול השמות ב-TASKS B11:** `01-what-it-does` → 10 · `02-connect-calendar` → 03 · `03-call-forwarding` → 02 · `04-portal-requests` → 07. לפי הנחיית המתזמר: תיקייה לכל סרטון עם `script.md`, ולא `videos/scripts/`.
**מפתחות `onboarding_items.key`:** לפי B7 (למשל `forward_calls`, `calendar`, `hours`, `faq`, `emergency`, `sms`, `go_live`; Zapier לפי המפתח ש-B7 יקבע). הקישור לסרטון ב-`video_url` לפי המפתח, ובהעברת שיחות גם לפי הספק שנבחר.

## 2. מבנה תסריט ובדיקה

כל `script.md`: תקציר בעברית למאיר בראש, טבלת מטרה/מיקום/פורמט/CTA, ואז סצנות. לכל סצנה יש **Record** (כתובת מדויקת, סלקטורים ופעולות), **On-screen text** ושורות קריינות.
- `target_seconds: N`: האורך המקסימלי לכל גרסה.
- `VO: ...`: קריינות מילה במילה, שמופיעה בכל הגרסאות. `VO[att]: ...`: מופיעה רק בגרסה `att`. כל גרסה = הבסיס + השורות שלה, לפי סדר הסצנות.
- טוקנים: `{{brand.name}}`, `{{brand.support_email}}`, `{{rules.included_usage.voice_minutes}}`, `{{price.RCP.setup}}` וכו'. הם מוחלפים בזמן ההפקה.
- `[PENDING B7]`: מסך שעוד לא נבנה. לפני ההקלטה מעדכנים את התוויות לפי מה ש-B7 בנה בפועל.

```bash
python3 videos/vo_length.py                                    # בודק את כל התסריטים: מילים → שניות (120 wpm), נכשל מעל היעד או מעל 150 שניות
python3 videos/vo_length.py --export videos/02-call-forwarding --variant att   # הטקסט הסופי לקריינות, עם הטוקנים מוחלפים
```

## 3. מתכוני הקלטה (קיימים היום)

- **R0 · שרתים:** `make serve` (האתר ב-`http://localhost:8787`). runtime מקומי: `cd runtime && .venv/bin/python -m sim serve --port 8000` (Twilio ויומן מדומים, בלי חשבונות).
- **R1 · כניסה לפורטל כלקוח הדמו (mock):** `http://localhost:8787/start/?mock=1` → `#email` = `demo@copperleaf.example` → `#sendBtn` → קוד מ-`#mockCode` → מקלידים ב-`#code` (נשלח אוטומטית ב-6 ספרות) → פרופיל: `#p_full_name` "Dan Mercer", `#p_company` "Copperleaf Air & Plumbing", `#p_phone` "(713) 555-0100", `#p_city` "Houston", `#p_state` "TX" → `#pSave`. לקידום שלב: `http://localhost:8787/start/?mock_seed=quote_sent|accepted|deposit_paid|testing|live`. לשוניות: `#tab-home`, `#tab-quotes`, `#tab-billing`. סטטוס: `ol.stepper li.is-current`, `.status__text`.
- **R2 · ניקוי מצב הדמו לפני צילום:** `document.getElementById('mockBanner')?.remove(); document.querySelectorAll('.mockmail').forEach(e=>e.remove())`.
- **R3 · דפים ציבוריים:** דף נחיתה `/home-services/` (`#demo`, `.demo__pick[data-scenario="ac"]`, `#how`, `#after-you-pay`), דף הצעה `/quote/?t=fixture` (`#acceptForm`, `#pay-slot`), אתר הדמו `/demo-site/home-services/` (5 עמודים).
- **R4 · מיילים מה-runtime:** מרנדרים את התבנית האמיתית (`runtime/app/notify/templates.py`) עם נתוני דוגמה לקובץ בתיקיית scratch ומצלמים (ראו 08).
- **זהות הדמו:** Copperleaf Air & Plumbing (פיקטיבי, נבדק ב-B10), מספרי 555 בלבד, מיילים `@example.com`/`.example`. לא מצלמים לקוח אמיתי, יומן אמיתי או חשבון ספק אמיתי.
- **מגבלה:** `tools/cdp-shots.mjs` פותח פרופיל Chrome חדש בכל הרצה, ולכן הוא מתאים לדפים ציבוריים ולא לפורטל (שם ההתחברות נשמרת ב-localStorage). להקלטת הפורטל בהפקה צריך סקריפט קטן `videos/tools/capture.mjs`: סשן Chrome אחד שמריץ רשימת צעדים (navigate/type/click/eval), ומקליט עם `Page.startScreencast` או צילומי מסך ב-1920×1080 (או 3840×2160 בשביל zoom חד). עוד לא נכתב, כי זה שלב הפקה.

## 4. תהליך ההפקה

1. **אישור תסריטים:** מאיר קורא את התקצירים בעברית ומאשר או מעיר. בלי אישור לא מתחילים הפקה.
2. **אימות עובדות:** קודי ההעברה של כל ספק (טבלה ב-02) מול דפי העזרה העדכניים, עם תאריך בדיקה. תוויות המסכים מול B7.
3. **הקלטה:** R0–R4 בתוספת `capture.mjs`. מקליטים כל סצנה בנפרד, ב-1920×1080 ובקצב 30fps. האנכיות ב-1080×1920 (מובייל: `390×844` עם scale 3, או מסגרת טלפון בגרפיקה).
4. **סטוריבורד:** תמונה אחת לכל סצנה + קריינות + טקסט על המסך, בגיליון אחד (`tools/grid.py`), לאישור מהיר של מאיר לפני הקריינות.
5. **קריינות:** `vo_length.py --export` → ElevenLabs. ברירת המחדל: קול אמריקאי ניטרלי. הקול המשובט של מאיר הוא אופציה (מומלץ רק ל-01 ול-10 אם הוא נשמע טבעי באנגלית). מבקשים פלט עם חותמות זמן לכל מילה. ⚠️ החיבור ל-ElevenLabs בסשן הזה דורש התחברות מחדש (SPEC §9: "חיבור ElevenLabs מחדש או אישור קול AI גנרי"). בכרטיס הסיום מופיע "Narrated by an AI voice".
6. **גרפיקה והרכבה:** Python (Pillow) + ffmpeg, כמו סקריפטי ה-reels הקיימים, או DaVinci Resolve החינמי. zoom/pan על צילומי המסך, טבעת פוקוס ענבר, בלי מוזיקה או עם מוזיקת רקע שקטה ברישיון חופשי.
7. **כתוביות:** לפי `captions-style.md`. קובץ `.vtt` נפרד, וצרוב רק בסרטון 10.
8. **ייצוא:** MP4 ‏H.264 1080p30, ‏AAC 128k, עוצמה −16 LUFS, עד ~20MB לסרטון. גרסאות אנכיות: 02 (שלושת הסלולריים), 07 S2, 09 S2, 10. תמונות ממוזערות לפי `thumbnail-spec.md`.
9. **QA:** צפייה מלאה, `vo_length.py`, התאמת מונחים לאתר ("AI line", "text-back", "setup checklist", "test number", "go-live", "Need help"), אין נתון אמיתי בפריים, הכתוביות מסונכרנות.
10. **העלאה:** bucket ‏`videos-public` ב-Supabase (SPEC §4), נתיב `onboarding/<NN-name>/<cut>-v1.mp4` + `.en.vtt`. כ-25 קבצים × ~15MB = ~375MB מתוך 1GB של Free. חלופה: YouTube Unlisted (חובה ל-90). אחר כך מעדכנים `video_url`, ואז אישור סופי של מאיר.

## 5. עלות וזמן (הערכה)

| פריט | הערכה |
|---|---|
| קריינות | ~2,100 מילים (~12,500 תווים) בכל הגרסאות. עם 2–3 טייקים: ~35 אלף תווים. ElevenLabs: חודש אחד בתוכנית Starter או Creator, בערך $5–22 (לבדוק מחיר עדכני) |
| תוכנה | $0 (Chrome/CDP, ffmpeg, Python, Resolve החינמי) |
| אחסון | $0 (Supabase Free או YouTube Unlisted) |
| חשבונות בדיקה | Calendly בתשלום לחודש בדיקה (~$10–16), Zapier בתשלום לחודש בדיקה (~$20–30). אפשר לדלג אם מקליטים גרפיקה במקום חשבון אמיתי |
| זמן סוכן | 2–3 שעות לסרטון, כ-3 ימי עבודה לכולם אחרי B7. אפשר כבר עכשיו: 10, 08, 09, ורוב 01 |
| זמן מאיר | ~1 שעה אישור תסריטים, ~20 דקות לבחירת קול, ~1 שעה צפייה ואישור |
