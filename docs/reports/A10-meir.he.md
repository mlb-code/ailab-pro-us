# AI Lab Pro US — מה נשאר לפני העלייה לאוויר + מדריך תפעול יומי (11.10.2026)

**איפה זה עומד:** כל הבדיקות האוטומטיות עוברות, אבל השער עוד סגור. יש 5 תיקונים קטנים שהסוכנים יעשו (פירוט ב-`A10.md`). את מה שכתוב כאן עושה רק אתה.
סדר העבודה: קודם תיקוני הסוכנים, אחר כך סעיפים 1–9 כאן, לפי הסדר.

## צ'ק-ליסט עלייה (לחיצה-לחיצה)

### 1. דומיין ב-Cloudflare
1. נכנסים ל-dash.cloudflare.com, ואז **Domain Registration → Register Domains** ומחפשים `ailabpro.co`.
2. **Purchase** (בערך 25–30 דולר לשנה).
✅ הצלחה = הדומיין מופיע ב-**Websites** עם הסטטוס Active.

### 2. מייל לדומיין (בלי זה, מיילים ל-support@ לא יגיעו אליך)
1. ב-Cloudflare בוחרים את הדומיין, ואז **Email → Email Routing → Get started**.
2. יוצרים כתובות: `support@`, ‏`hello@`, ‏`quotes@`. לכל אחת: **Destination** = תיבת הג'ימייל שלך → **Save**.
3. מאשרים את המייל שמגיע לג'ימייל.
✅ הצלחה = שולחים מייל מהטלפון ל-support@ailabpro.co, והוא מגיע לג'ימייל תוך דקה.

### 3. GitHub ו-Pages (אחרי שהסוכן הוסיף `pages.yml` ו-`site/CNAME`)
1. github.com → **New repository**. השם: `ailabpro-site`.
   ⚠️ ב-GitHub החינמי, Pages עובד רק בריפו **ציבורי**, וריפו ציבורי חושף גם את התיקייה docs/. לכן כדאי לבקש מהסוכן ריפו נפרד שמכיל רק את `site/`. (החלופה: GitHub Pro בכ-4 דולר לחודש, ואז אפשר ריפו פרטי.)
2. כותבים לקלוד: **"תעלה את האתר לריפו"**. הוא דוחף, אבל רק אחרי שאתה מאשר.
3. בריפו: **Settings → Pages → Source: GitHub Actions**. ב-**Custom domain** כותבים `ailabpro.co` → **Save**, ומסמנים **Enforce HTTPS**.
4. ב-Cloudflare: **DNS → Records → Add record**. מוסיפים 4 רשומות מסוג `A` עם השם `@` ועם הערכים `185.199.108.153`, ‏`185.199.109.153`, ‏`185.199.110.153`, ‏`185.199.111.153`.
5. מוסיפים עוד רשומה מסוג `CNAME`, עם השם `www` והערך `mlb-code.github.io`.
6. בכל הרשומות **Proxy status = DNS only** (ענן אפור), עד שהתעודה מוכנה.
✅ הצלחה = https://ailabpro.co נפתח עם מנעול, ורואים את דף שירותי הבית.

### 4. Supabase (מסד הנתונים)
1. נרשמים ל-supabase.com עם `hello@ailabpro.co`.
2. **Account → Access Tokens → Generate new token**. מדביקים את הטוקן ב-`~/Desktop/ailab-pro-us/.secrets.env` בשורה `SUPABASE_ACCESS_TOKEN=`.
3. כותבים לקלוד: **"תריץ us_setup"**. הוא מריץ `--plan`, אחריו `--create`, ובסוף `us_setup_check.py`. המדריך המלא: `docs/runbooks/supabase-us-setup.he.md`.
✅ הצלחה = הסקריפט מדפיס "✅ ailab-us נוצר", וכל השורות בבדיקה ירוקות.

### 5. Resend (מיילים יוצאים מהדומיין)
1. resend.com → **Domains → Add domain** → `ailabpro.co` → אזור **us-east-1**.
2. Resend מציג 3–4 רשומות (TXT/MX). מעתיקים כל אחת ל-Cloudflare: **DNS → Add record**, אותו סוג, אותו שם ואותו ערך.
3. חוזרים ל-Resend ולוחצים **Verify**.
4. **API Keys → Create** → מדביקים ב-`.secrets.env` בשורה `RESEND_API_KEY=` → כותבים לקלוד: **"תריץ us_setup --only secrets"**.
✅ הצלחה = ליד הדומיין ב-Resend כתוב Verified. עד אז המיילים יוצאים מ-`pro@ai-lab.co.il`, והמערכת עוברת לשם לבד.

### 6. כניסה עם Google
1. console.cloud.google.com → **New project** בשם "AI Lab Pro" → **APIs & Services → OAuth consent screen** → **External**.
2. ממלאים:
   - App name: AI Lab Pro
   - Support email: `support@ailabpro.co`
   - Authorized domain: `ailabpro.co`
   - Privacy policy: `https://ailabpro.co/legal/privacy/`
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. ב-Authorized redirect URI מדביקים את הכתובת שקלוד ייתן לך (`https://<ref>.supabase.co/auth/v1/callback`).
5. מעתיקים את ה-Client ID ואת ה-Secret ל-`.secrets.env`, לשורות `GOOGLE_OAUTH_CLIENT_ID=` ו-`GOOGLE_OAUTH_CLIENT_SECRET=` → כותבים לקלוד: **"תריץ us_setup --only google"**.
✅ הצלחה = ב-`/start/` הכפתור "Continue with Google" פעיל ומכניס אותך.

### 7. שדות שעוד ריקים ב-`config/brand.json` (תכתוב לקלוד את הערכים, והוא יעדכן ויבנה)
| שדה | מה לשים |
|---|---|
| `owner.admin_email` | המייל שאיתו תיכנס לאדמין, למשל `meir@ailabpro.co` |
| `legal_entity.name` | השם הרשום של העוסק המורשה שלך |
| `legal_entity.governing_law` | אחרי עו"ד (ההצעה: State of New York) |
| `physical_address` | כתובת למשלוח דואר. **חובה**, אחרת מיילי התזכורת לא יוצאים (חוק CAN-SPAM). כתובת בישראל מותרת |
| `calendly_url` | הקישור לשיחת 15 דקות שלך ב-Calendly (חינם) |
| `analytics.ga4_id` / `clarity_id` | מזהים חדשים לדומיין (`G-…` ומזהה Clarity) |
| `smtp_from` | להשאיר ריק עד שיש Verified ב-Resend. אחר כך: `AI Lab Pro <hello@ailabpro.co>` |
| `show_founder_price` | `true` אם רוצים להציג באתר את מחיר המייסדים (30% הנחה על ההקמה ל-3 הראשונים) |
| `quote_sla_text` | **החלטה שלך:** "within 24 hours" (המצב היום) או "within 1 business day" (כמו במפרט ובהסכם). בסופי שבוע 24 שעות לא יחזיקו |
| `proof.worked_with_status` | לאשר את הנוסח על Samsung/Haier |
| `legal_final` | `true` **רק** אחרי שעו"ד אישר (אז נעלם הבאנר "Draft") |
| `demo.runtime_url`, `demo.allowed_origins` | שלב ב', לא עכשיו |
✅ הצלחה = קלוד מריץ `sync_config` → `build_landing` → `make qa`, הכל ירוק, ורואים את הכתובת בפוטר.

### 8. ביקורת עו"ד
שולחים לעו"ד את `docs/kits/lawyer-brief.md` (23 שאלות), יחד עם 3 הדפים: `/legal/terms/`, ‏`/legal/privacy/`, ‏`/legal/service-agreement/`. אחרי האישור: `legal_final: true` וגרסה `1.0`.
✅ הצלחה = מכתב אישור מהעו"ד, והבאנר "DRAFT" לא מופיע באתר.

### 9. Upwork
עוברים לפי `docs/kits/upwork.md`: כותרת, Overview, ‏2 פריטי Project Catalog, אימות זהות, ו-20–30 הצעות בשבוע.
✅ הצלחה = הפרופיל ציבורי ו-100% מלא.

---

## מדריך תפעול יומי (אדמין): 10–15 דקות ביום

**כניסה:** https://ailabpro.co/start/admin/ → המייל שלך → קוד 6 ספרות מהמייל.

**כל בוקר (08:00):**
1. קוראים את המייל "סיכום יומי".
2. באדמין, בכרטיס **תקציר יומי**, כל מספר שגדול מ-0 הוא משהו לטפל בו. לוחצים על הכרטיס ומגיעים ישר לרשימה.

**לאשר הצעת מחיר** (מגיע מייל "הצעה חדשה לאישור"):
1. לשונית **הצעות** → בוחרים את ההצעה.
2. משמאל: הטיוטה של Claude. מימין: מה הלקוח ענה. בתיבה "בדיקת הטיוטה": דגלי סיכון ושאלות.
3. מוסיפים או מסירים שורות **רק דרך רשימת הקודים** (המחיר מתעדכן לבד).
4. אם זה אחד מ-3 הלקוחות הראשונים, מסמנים **FOUNDING**.
5. "אמצעי תשלום" → PayPal → מדביקים קישור חשבונית (https).
6. **אשר ושלח**.
✅ הצלחה = הסטטוס "נשלחה", והלקוח קיבל מייל.
- אם כתוב **"צריך תמחור ידני"**: מקלידים הקמה וחודשי בשורה המסומנת, ואז "אשר ושלח".

**לקוח אישר הצעה** (מייל "✅ … אישר הצעה"):
1. **הצעות** → ההצעה → **פתח כרטיס לקוח**.

**הגיע תשלום** (ב-PayPal):
1. **לקוחות** → הלקוח → **תשלומים**.
2. מקלידים אסמכתה → **סמן כשולם**.
✅ הצלחה = הלקוח מקבל "Welcome aboard", ובפורטל שלו נפתח צ'ק-ליסט של 7 סעיפים.

**"צריך עזרה"** (מייל "{עסק} צריך עזרה ב:"):
עונים במייל. בכרטיס הלקוח רואים באיזה סעיף הוא תקוע.

**מוכן לבדיקה:**
1. **לקוחות** → סטטוס **testing** → שמירה (הלקוח מקבל "ready to test").
2. כשהלקוח מבקש go-live ומשלם את התשלום הסופי: **סמן כשולם** → סטטוס **live**.

**בקשות ריטיינר:**
לשונית **תור ריטיינר** → משנים סטטוס (פעילה / ממתינה ללקוח / הושלמה) וכותבים תשובה. ללקוח יש רק בקשה פעילה אחת.

**לא עושים:**
- לא שולחים הצעה בלי לקרוא אותה.
- לא מקלידים סכום חופשי.
- לא מבטיחים ללקוח תוצאות או מועד שלא כתוב בהצעה.
- לא מוחקים לקוח. ביטול = סטטוס, והמחיקה האוטומטית מתבצעת אחרי 30 יום.

**יומן:** כל פעולה נרשמת בלשונית **יומן**. אם משהו נראה מוזר, מתחילים משם.
