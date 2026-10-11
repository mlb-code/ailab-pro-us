# B7 · ביקורת חוזרת (11.10.2026): **APPROVE**
- הרצתי בעצמי:
  - `qa-portal-b7`: ‏111/0 · 108/0 · SQL ‏47.
  - `qa-start`: ‏116 + 516 · `qa-admin`: ‏77 + 228.
  - `run.ts`: RLS ‏159 + 10/10 מוטציות · `deno test`: ‏64/0.
  - secrets, hardcoded, sync: נקיים.
- (1) כותרות: המיגרציה והמוק זהים ל-`01-welcome/script.md`. ה-e2e קורא את הכותרות מהתסריט עצמו.
- (2) go-live: `onboarding_go_live_gate` (BEFORE, רק לקריאות של לקוח) דוחה עם `go_live_not_ready` אם הלקוח לא ב-testing או שיש סעיף פתוח (חוץ מ-tools). ה-SQL מוודא שהמפתח לא נשרף, ושאחרי בקשה תקינה המייל נכנס לתור פעם אחת.
- (3) בקשה מושהית: טריגר `requests_paused_guard` חוסם הפעלה גם לאדמין. באדמין יש תגית "מושהה ע"י הלקוח" וחסימה גם ב-UI.
- `calendar-connect`: הבעלות נבדקת דרך PostgREST עם ה-JWT של המשתמש (RLS), בלי service key. `RUNTIME_ADMIN_TOKEN` נשלח רק ל-runtime. ללקוח חוזר רק `{url}` שעבר ולידציה.
- נשאר לתיעוד: ל-`request_cancelled` אין עדיין תבנית מייל (A8).

---
# B7 · ביקורת (11.10.2026)

**פסק דין: CHANGES** (3 תיקונים קטנים. האבטחה, הבדיקות וה-UI תקינים)

1. **כותרות הצ'ק-ליסט לא תואמות לתסריטים** (`.obstep__t`, כל הרוחבים). בפורטל: Turn on call forwarding · Business details & hours · FAQ · Who gets alerts · SMS registration info. ב-`videos/01-welcome/script.md` שורה 35: Forward your missed calls · Business hours · Services & FAQ · Emergencies & alerts · Texting registration & go-live. חמש מתוך שבע שונות. הבדיקה ב-`e2e_portal_b7.mjs` נקראת "item titles match the video scripts", אבל היא בודקת את כותרות ה-SPEC, כלומר השם שלה מטעה. התיקון: ליישר את הכותרות ב-`private.seed_onboarding` וב-`OB_ITEMS` במוק לנוסח התסריטים, ולעדכן את הבדיקה. בנוסף, ב-02 ("Last step before go-live") וב-01 ("The last step is call forwarding") כתוב שזה הצעד האחרון, אבל זה סעיף 1. זה ל-B11.
2. **שער ה-go-live קיים רק ב-UI.** לקוח יכול לקרוא ישירות ל-`update_onboarding_item(..., {go_live_requested_at})` בכל שלב. במצב כזה `onboarding_go_live_event` יוצר אירוע, A8 שולח את `final_payment_due`, והמפתח `final_payment_due:<client>` נשרף, כך שהמייל האמיתי לא יישלח אחר כך. התיקון: בטריגר (או ב-guard) לדרוש `clients.status='testing'` וכל הסעיפים `done`, ואחרת לזרוק חריגה. להוסיף לזה assert ב-`portal_b7_test.sql`.
3. **בתור הריטיינר באדמין לא רואים בקשה שהלקוח השהה** (`requests.paused`). ב-`admin.js` אין שום שימוש בשדה, כך שמאיר עלול להפעיל בקשה מושהית. התיקון: pill "מושהה ע"י הלקוח" בשורה ובפרטים.

**מה הרצתי בעצמי (הכול עבר)**
- `make qa-portal-b7`: e2e ‏106/0 · overflow ‏108/0 · SQL ‏41.
- `qa-start`: ‏116/0 + 516/0 · `qa-admin`: ‏77/0 + 228/0.
- `run.ts`: RLS ‏159 + 10/10 מוטציות.
- `deno test`: ‏58/0.
- `check_hardcoded site`: ‏0 · `check_secrets`: ‏0 · `sync_config --check`: אין drift.

**סיור ידני (פורט 8977, נסגר; מוק; 390×844 ו-1280×800; 10 צילומים ב-`shots-b7/`)**
- 7 סעיפים בסדר הנכון, ולכל אחד `data-video` ו-`data-script`.
- Test call: חלון של 30 דקות ואזהרת text-back. אחרי Simulate הסעיף עובר ל-Done.
- Calendly מופיע עם "(paid plan)". ה-FAQ נעצר ב-25. כפתור go-live מושבת עד שהצ'ק-ליסט מלא.
- My receptionist: שיחות, תמליל, SMS, הזמנות, Pause AI. כרטיס השימוש ב-Billing: נוסח 80/100% ובלי חיוב אוטומטי.
- אפס גלישה ב-375/390/414/1280 בכל הלשוניות ובאדמין. אין `-9999px`. אפס שגיאות קונסול.
- אדמין: RTL ועברית. שגיאות הסכמה מוצגות בעברית עם נתיב, והשמירה חסומה כשהקונפיג לא תקין. המיזוג אידמפוטנטי (פעמיים = אותו JSON). טבלת השימוש: דקות ומקטעים מול הכלול, ועלות Claude/Twilio ב-$ מול החודשי.

**אבטחה: תקין**
- הרשימה הלבנה כוללת בדיוק 6 מפתחות (`field_not_allowed` על כל השאר, ונבדק).
- `admin_tenant_usage` ו-`admin_save_tenant`: security definer + `is_admin`. ניסיון כלקוח וכ-service role נדחה. `client_tenant_usage` מחזיר רק ספירות של ה-tenant של הלקוח, בלי עלויות.
- הוולידטור גנרי והסכמה מסונכרנת byte-for-byte. אין טבלאות חדשות.
- לקוח A לא רואה את השיחות או התמלילים של B (מוטציית "RLS off on calls" נתפסת).

**לא חוסם (לתיעוד)**
- `calendar-connect` לא קיים, ולכן לא ניתן לאמת את בדיקת הבעלות. זה דווח ביושר, אבל ב-TASKS אין לזה בעלים: לשייך ל-B5/B9. במצב אמיתי שגיאת 404 תציג הודעה גנרית (המיפוי מכסה רק `not configured|503`).
- מילות חירום, אזור זמן, יומן ושירותים שנכנסים רק במיזוג של האדמין: **מקובל** לשלב הקליטה (SPEC §4 קבע את הרשימה הלבנה, ומאיר בודק לפני Testing). שני סיכונים: (א) שעות שנשמרות אחרי שה-tenant קיים נכנסות מיד, אבל אזור הזמן ממתין למיזוג. (ב) אחרי Live אפשר לשנות מילות חירום רק דרך Request. מומלץ סימון "נתוני קליטה חדשים מהקונפיג" ברשימת ה-Tenants.
- `msg()` באדמין מכניס את `e.message` של `JSON.parse` בלי escape (self-XSS בלבד). כותרת `portal-b.js` עדיין מציינת רשימה לבנה של 4 מפתחות.
- הניתוב: A8 כבר מטפל ב-`need_help`, ‏`go_live_requested`→`final_payment_due` ו-`onboarding_nudge`. ל-`request_cancelled` אין עדיין תבנית או טריגר (A8). sim-run ו-Send test של Zapier הולכים ל-B12. ההפניה נכונה.
- השינויים בקבצים המשותפים מינימליים: hooks ב-`home.js`/`admin.js`, שורה אחת ב-`sync_config`, ו-assert אחד ב-`e2e_admin`. ההתנהגות של A5/A7 נשמרה (qa-start ו-qa-admin ירוקים).
