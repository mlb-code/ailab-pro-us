# חיבור Google Calendar: הגדרות ב-Google Cloud ובקשת אימות (למאיר)

> ברירת המחדל היא **Calendly**, ולא צריך בשבילו אימות של גוגל. את המדריך הזה עושים רק כשרוצים לאפשר ללקוחות גם Google Calendar.
> מה צריך לפני שמתחילים: דומיין חי, דף Privacy Policy באוויר, ו-runtime עם כתובת קבועה (`PUBLIC_BASE_URL`).

## שלב 1: פרויקט
1. נכנסים ל-https://console.cloud.google.com ומתחברים עם המייל של הדומיין החדש.
2. למעלה לוחצים על בורר הפרויקטים, ואז **New Project**. שם: `ailab-pro-calendar`. לוחצים **Create**.
3. בתפריט: **APIs & Services → Library**. מחפשים **Google Calendar API**, לוחצים **Enable**.

## שלב 2: מסך ההסכמה (OAuth consent screen)
1. **APIs & Services → OAuth consent screen** (בממשק החדש: **Google Auth Platform → Branding**).
2. User type: **External**, ואז **Create**.
3. App name: שם המותג מ-`config/brand.json`. User support email: המייל של התמיכה. לוגו 120×120 (לא חובה, אבל מאט את האימות).
4. App domain: דף הבית, Privacy Policy (`/legal/privacy/`), Terms (`/legal/terms/`). Authorized domains: הדומיין הראשי.
5. **Data access / Scopes → Add or remove scopes**: מסמנים רק את
   `https://www.googleapis.com/auth/calendar.events` (זה scope רגיש, ולכן צריך אימות). לוחצים **Update** ואז **Save**.
6. **Audience → Test users**: מוסיפים את המייל שלך ושל לקוח בדיקה. במצב Testing הטוקנים פגים אחרי 7 ימים.

## שלב 3: מפתחות (OAuth client)
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**. Name: `runtime-calendar`.
3. Authorized redirect URIs, מוסיפים בדיוק את הכתובת: `https://<כתובת ה-runtime>/oauth/google/callback`
4. **Create**. מעתיקים את Client ID ואת Client secret **ישר ל-Railway** (לא לצ'אט, לא לקובץ):
   `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`.
5. בדיקה: `GET /health/deep` מחזיר `"calendar_oauth": {"google": true}`.

## שלב 4: בקשת אימות (Verification)
1. **OAuth consent screen → Publish app**, ואז **Prepare for verification**.
2. מה גוגל מבקשים: הסבר קצר למה צריך גישה ליומן ("the AI receptionist books service visits into the business owner's calendar and reads busy times to avoid double booking"), וסרטון YouTube (Unlisted) שמראה: כניסה לפורטל, לחיצה על Connect calendar, מסך ההסכמה עם ה-scope, ואירוע שנוצר ביומן.
3. אימות של בעלות על הדומיין ב-Google Search Console (אותו מייל).
4. זמן טיפול: בדרך כלל כמה ימים עד כמה שבועות. עד שמאושר: לקוחות עם Google במצב Testing (עד 100 משתמשים, חיבור מחדש כל 7 ימים), או Calendly.

**הצלחה =** לקוח בדיקה לוחץ "Connect Google Calendar" בפורטל, חוזר לפורטל עם `result=connected`, והזמנה בסימולטור יוצרת אירוע ביומן שלו.

## Calendly (ברירת המחדל), לידיעה
- יוצרים OAuth app ב-https://developer.calendly.com: Redirect URI `https://<runtime>/oauth/calendly/callback`. את `CALENDLY_CLIENT_ID` ו-`CALENDLY_CLIENT_SECRET` שמים ב-Railway.
- הזמנה דרך ה-API (Scheduling API) דורשת **מנוי Calendly בתשלום אצל הלקוח**. ב-event type כדאי להוסיף שאלה ראשונה "Job details".
