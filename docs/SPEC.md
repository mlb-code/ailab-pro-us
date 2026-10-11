# מפרט: AI Lab Pro US — פלטפורמת מכירה ומסירה בלי טלפון (v1, 11.10.2026)

**למי:** מאיר (אישור), סוכני הבנייה (ביצוע לפי `TASKS.md`). **מחירים:** `PRICEBOOK.md`. **סטטוס:** ממתין לאישור מאיר. שום דבר לא נבנה.
**בשורה אחת:** בעל עסק אמריקאי מגיע לדף, מנסה הדגמה, ממלא שאלון של 6 דקות, מקבל הצעת מחיר קבועה בכתב תוך יום עסקים, משלם מקדמה, ממלא צ'ק-ליסט גישות עם סרטון לכל סעיף, ומקבל מוצר שרץ. אף שיחה לא נדרשת. כל מה שהלקוח רואה באנגלית אמריקאית; כל מה שמאיר רואה בעברית.

---

## 1. מסע הלקוח: "דני, חברת מיזוג בטקסס"

דני בן 44, בעלים של "Cool Breeze HVAC" ביוסטון, 6 טכנאים. ישראלי לשעבר; הלקוחות שלו אמריקאים. בקיץ הוא מפספס 30% מהשיחות כי הוא על גג.

| # | מה קורה | מסך / מייל | אוטומטי או מאיר |
|---|---|---|---|
| 1 | דני רואה הצעה ב-Upwork (או מודעה) ולוחץ על קישור | — | מאיר שולח הצעה ב-Upwork לפי הערכה |
| 2 | נוחת ב-`/home-services/`: "Never lose a job to voicemail again", מחיר גלוי $3,500 + $300/mo, סרטון 60 שניות | **Landing** | אוטומטי |
| 3 | לוחץ "Try it" ומשחק בצ'אט: "My AC is blowing warm air" → הסוכן שואל ZIP, מציע שני חלונות זמן, "קובע" | **Chat demo** | אוטומטי |
| 4 | לוחץ "Get my fixed quote" → מקליד מייל → מקבל מייל עם קישור + קוד 6 ספרות | **Sign in** + מייל `auth_code` | אוטומטי |
| 5 | שאלון 6 דקות: העסק, איך עונים היום, כמה שיחות, אילו כלים (בוחר Google Calendar + Jobber), שעות, אזור שירות | **Questionnaire** | אוטומטי, שמירה תוך כדי |
| 6 | מגיש. מקבל "Got it — your fixed quote arrives within 1 business day" | מייל `q_received` | אוטומטי |
| 7 | Claude מנסח טיוטה: `RCP` + `ADD-CRM` (Jobber) = $4,700 + $350/mo. מאיר מקבל מייל בעברית, נכנס לאדמין, קורא, לוחץ "אשר ושלח" | מייל `admin_new_quote` + **Admin** | Claude מנסח, **מאיר מאשר בלחיצה** |
| 8 | דני מקבל מייל עם ההצעה ודף הצעה: היקף, מה כלול, מה לא, לוח זמנים, מחיר, "Accept & pay deposit $2,350" | מייל `quote_sent` + **Quote page** | אוטומטי אחרי האישור |
| 9 | מקליד שם מלא, מסמן שקרא את ה-Service Agreement, לוחץ Accept. עובר לתשלום (PayPal / Upwork milestone) | **Quote page** → תשלום | אוטומטי; סימון "שולם" = מאיר בשלב א' |
| 10 | מאיר מסמן "מקדמה התקבלה" באדמין → דני מקבל "Welcome — here's your setup checklist" | מייל `deposit_received` | מאיר (לחיצה) |
| 11 | בפורטל: צ'ק-ליסט של 7 סעיפים, כל אחד עם סרטון של 2 דקות: חיבור יומן (OAuth), שעות, שאלות נפוצות, מי מקבל התראות, אישור SMS (10DLC), חיבור Jobber דרך Zapier, העברת שיחות | **Portal → Onboarding** | דני לבד; מייל `onboarding_nudge` אחרי 3 ימי שקט |
| 12 | בנייה: הגדרת tenant, בדיקה בסימולטור (20 תרחישים), מספר Twilio. דני מקבל "Your receptionist is ready to test" + מספר ניסיון | מייל `ready_to_test` | מאיר + סוכן, ~10 ימי עסקים |
| 13 | דני מתקשר בעצמו, מנסה. לוחץ "Approve go-live" ומשלם 50% שני | **Portal** + מייל `final_payment_due` | דני; סימון תשלום = מאיר |
| 14 | דני מפעיל העברת שיחות (לפי סרטון). מכאן כל שיחה שלא נענתה נענית; לכל ליד הוא מקבל SMS + מייל, וכל ערב סיכום | `lead_alert` (SMS+מייל), `daily_summary` | אוטומטי |
| 15 | חודש אחרי: "Can you add a question about filter size?" → בקשה בתור הריטיינר | **Portal → Requests** + `request_update` | מאיר מטפל, סטטוס גלוי |

**חריג אתר (`WEB`):** נמכר ישירות מהדף: Choose package → Accept terms → deposit → שאלון תוכן. אין שלב הצעה, אלא אם נבחרו תוספות.
**שיחת וידאו:** כפתור יחיד "Prefer a quick 15-min video call?" בדף ההצעה ובפורטל → קישור Calendly של מאיר. לא חלק מהמשפך.
**בעלים דובר עברית:** בפרופיל שדה `Preferred language for our updates: English / עברית`. הפורטל נשאר באנגלית; מאיר יכול לכתוב לו הערות בעברית.

---

## 2. מסכים

### 2.1 Landing (סטטי, נבנה מגנרטור אחד `tools/build_landing.py`)
עיצוב: אותה משפחה של pro.ai-lab.co.il: navy `#0F1A26`, amber `#E8A64A`, Noto Serif / Noto Sans (לטיניים), Space Mono לתוויות, LTR. **אותו סטנדרט, לא העתקה.**
**דפים:** `/` = שירותי בית (הנישה הראשונה, גם `/home-services/`), `/real-estate/`, `/law/`, `/dental/`, `/website/` (מוצר האתר), `/demo/`, `/legal/*`.
**בלוקים משותפים (סדר קבוע):** Hero (כאב + מחיר גלוי + 2 כפתורים: Try the demo / Get a fixed quote) · "What happens to a missed call" (3 שלבים מאוירים) · Live demo (הצ'אט) · What's included (מהמחירון) · How it works without calls (Questionnaire → Fixed quote in writing → Setup checklist with videos → Live) · Proof (Samsung/Haier כ"עבדנו עם", מונה "Built with Claude", אחריות 7 ימים) · Pricing card · FAQ (8) · Footer (משפטי, "Not affiliated with Anthropic").
**מה משתנה לפי נישה** (קובץ `site/_content/<niche>.json`): כותרות, 3 דוגמאות שיחה לדמו, רשימת כלים, FAQ, מילות SEO, תמונות. **דנטל ומשפט:** נבנים עכשיו, אבל `noindex` ו-CTA "Join early access" (רק ליד) עד ביקורת עו"ד (HIPAA / ייעוץ משפטי). נדל"ן ושירותי בית מלאים.
**מדידה:** GA4 + Clarity חדשים (מזהים ב-`brand.json`), אירועים `demo_start`, `quote_start`, `quote_submit`, `quote_accept`.

### 2.2 Chat demo
שלב א': **סקריפט בדפדפן בלבד** (`site/demo/demo.js`): עץ שיחה לכל נישה, נראה כמו SMS, עם "typing", בלי שרת. שלב ב' (משימה B8): אותו רכיב מדבר עם tenant הדגמה ב-runtime (`POST /demo/chat`), עם תקרות (20 הודעות לשיחה, $3 ליום); נפילה לשרת = חזרה אוטומטית לסקריפט. תמיד מסומן "Demo — no real booking is made".

### 2.3 שאלון (fork של `site/start/`, באנגלית, LTR)
אותה ארכיטקטורה שעובדת בעברית: HTML/JS בלי framework, `questions.js` כמקור אמת יחיד, שמירה אוטומטית, `summary` jsonb, קבצים עד 5×10MB. כניסה: **מייל עם קישור וגם קוד 6 ספרות** (אותו OTP; הקוד פותר "הקישור נפתח בדפדפן אחר" במובייל) + Google. בלי Apple.
**מבנה:** פרופיל (שם, עסק, עיר+מדינה, אזור זמן, טלפון, אתר, how heard, שפת עדכונים) ← **בחירת הצעה** (`RCP` / `WEB` / `BNDL` / "Not sure — recommend") ← ענפים:

| שלב | RCP | WEB |
|---|---|---|
| 1 | העסק: נישה (רשימה סגורה לפי הדף), שירותים, אזור שירות (ZIPs/ערים), מספר מיקומים | העסק + שירותים + אזור |
| 2 | השיחות היום: מי עונה, שיחות בשבוע, % שמפוספס (הערכה), מה קורה אחרי שעות, ערך ממוצע לעבודה | מה יש היום: אתר? דומיין? Google Business? |
| 3 | הזמנות: איך קובעים היום, משך עבודה טיפוסי, חלונות זמן, חירום | תוכן: לוגו, תמונות, ביקורות, צבעים |
| 4 | **כלים** (רשימה סגורה + Zapier + Other) | **כלים** (אותה רשימה) |
| 5 | שפות (Spanish?), כללים רגישים (מחירים בטלפון: כן/לא) | עמודים נוספים, ספרדית, בלוג |
| 6 | זמנים, מי מחליט, קבצים, "anything else" | אותו דבר |

**רשימת הכלים הסגורה (10):** Google Calendar · Outlook / Microsoft 365 Calendar · Calendly · Jobber · Housecall Pro · ServiceTitan · GoHighLevel · HubSpot · QuickBooks · Google Business Profile. ועוד: **Zapier** (יש לי חשבון) · **Other** (שדה טקסט). תוספות לפי נישה, מוצגות רק בדף שלהן: Follow Up Boss (נדל"ן), Clio (משפט), Dentrix / Open Dental (דנטל). כל כלי ממופה במחירון ל-`native` / `zapier` / `addon` / `custom`.

### 2.4 דף הצעת מחיר (`/quote/?t=<token>`) + מייל HTML
אותו תוכן בשני המקומות; המייל = תקציר + כפתור לדף. הדף נטען דרך Edge Function `quote-view` (טוקן אקראי 32 תווים, בלי התחברות, נרשם `viewed_at`).
**חלקים:** כותרת ושם הלקוח · "What we'll build" (טקסט של Claude, מאושר) · טבלת שורות (קוד, שם, הקמה, חודשי) · What's included / Not included (מהמחירון, לא מ-Claude) · Assumptions · Timeline · סכומים: Setup, Deposit 50%, Before go-live 50%, Monthly from go-live · תוקף 14 יום · **Accept**: שם מלא + תיבת "I agree to the Service Agreement v1.0" → נשמרים שם, IP, user agent, זמן, hash של גרסת ההסכם (חתימה אלקטרונית לפי ESIGN) · **אזור תשלום** `#pay-slot`.
**תשלום:** שלב א' = `quotes.pay_method` ∈ `paypal_link` | `upwork` | `wire` | `tranzila_link`; אם יש `pay_link` מוצג כפתור "Pay deposit $X"; אחרת "We'll send your secure payment link within 1 business day". שלב מאוחר יותר: Edge Function `pay-create` שמחזירה URL לפי ספק, בלי שינוי בדף (אותו slot).

### 2.5 פורטל לקוח (`/start/`, אחרי כניסה)
- **Home:** כרטיס סטטוס אחד עם 6 שלבים: Questionnaire → Quote → Deposit → Setup checklist → Testing → Live. כפתור הפעולה הבאה תמיד אחד.
- **Quotes:** רשימה + קישור לדף ההצעה.
- **Onboarding checklist:** סעיפים לפי המוצר (טבלה בסעיף 6.8), לכל סעיף: סרטון (slot ל-Loom/MP4, `video_url`), הוראה, טופס/כפתור, סטטוס `todo / done / need_help`. "Need help" = הודעה כתובה למאיר, לא שיחה.
- **My receptionist** (אחרי Live): שיחות ו-SMS אחרונים עם תמליל וסיכום, הזמנות, עריכת שעות / FAQ / אנשי התראה (רק שדות מותרים), מתג "Pause AI".
- **Requests (ריטיינר):** פותחים בקשה (כותרת, תיאור, קבצים). **בקשה פעילה אחת**; השאר בתור, ניתנות לגרירה. סטטוסים: `queued / active / waiting_on_you / done / declined`.
- **Billing:** תשלומים שנרשמו, החודש הבא, קישור תשלום חודשי (ידני בשלב א').

### 2.6 אדמין (`/start/admin/`, עברית, RTL, רק `is_admin`)
לשוניות: **לידים** (מיילים מהדף שלא התחילו שאלון) · **שאלונים** (סינון לפי נישה/הצעה/סטטוס, "העתק ל-Claude") · **הצעות**: טיוטת Claude לצד התשובות, עריכת טקסט, הוספה/הסרה של קודים מהמחירון (המחיר מתעדכן לבד), הנחת FOUNDING, הדבקת קישור תשלום, **"אשר ושלח"** בלחיצה; "צור טיוטה מחדש" · **לקוחות**: סטטוס, תשלומים (סימון "שולם" + אסמכתה), צ'ק-ליסט, הערות פנימיות · **Tenants**: עורך JSON עם ולידציה + כפתור "הרץ 20 תרחישי סימולטור" (שלב ב') · **תור ריטיינר**: כל הבקשות, שינוי סטטוס, תשובה ללקוח · **יומן אירועים**.

---

## 3. מחירון וכללי ההצעה
המחירון המלא ב-`PRICEBOOK.md`. תקציר:

| קוד | מוצר | הקמה | חודשי |
|---|---|---|---|
| `RCP` | Missed-Call AI Receptionist | $3,500 | $300 |
| `WEB` | אתר לעסק (5 עמודים) | $1,900 | $129 |
| `BNDL` | שניהם | $4,900 | $400 |
| תוספות | מיקום נוסף $900+$100 · ספרדית $750+$50 · CRM native $1,200+$50 · צ'אט באתר $500+$25 · ביקורות $400 · דחוף +25% | | |
| בהמשך | מיפוי $1,900 · אוטומציה מ-$3,500+$500 · סוכן מ-$5,000+$400 · מערכת מ-$12,000 · ריטיינר $500 / $1,500 / $4,000 | | |

**איך Claude מוגבל (החלטה):**
1. `config/pricebook.json` הוא מקור האמת היחיד; מסונכרן לאתר, לפונקציות ול-runtime בסקריפט אחד.
2. Edge Function `quote-draft` קוראת ל-Claude עם התשובות + המחירון, ומבקשת **פלט מובנה** (JSON schema): `items[{code, qty, reason}]`, `scope_md`, `assumptions[]`, `not_included_extra[]`, `timeline_text`, `questions_for_client[]`, `risk_flags[]`. **אין שדה מחיר בסכימה.**
3. הקוד מוודא שכל `code` קיים ותואם להצעה, מחשב סכומים, ומסמן `needs_manual_price` אם יש `custom` או הקמה מעל $10,000.
4. טקסט "כלול / לא כלול" מגיע מהמחירון, לא מ-Claude. Claude לא כותב הבטחות זמן מעבר לטבלה, לא מבטיח תוצאות ("you'll get 30% more jobs"), ולא מציע הנחות.
5. כל הצעה נשמרת `draft` → מאיר מאשר → `sent`. **אין שליחה בלי אישור.** מודל: `claude-opus-5-5`, effort `medium` (ערך ב-`brand.json`, ניתן להחלפה).

---

## 4. מודל נתונים (Supabase `ailab-us`, Postgres, סכימה `public` + `private`)

| טבלה | עמודות עיקריות | לקוח רואה | לקוח כותב |
|---|---|---|---|
| `profiles` | id (=auth.users), email, full_name, company, phone, city, state, timezone, niche, website, how_heard, update_lang (`en`/`he`), is_admin | שלו | שלו (בלי email/is_admin) |
| `leads` | id, email, niche, source_page, utm jsonb, created_at | — | insert דרך Edge Function `lead` בלבד (rate limit) |
| `questionnaires` | id, user_id, offer (`RCP`/`WEB`/`BNDL`/`UNSURE`), niche, status (`draft`/`submitted`/`quoted`/`closed`), answers jsonb, summary jsonb, submitted_at | שלו | רק ב-`draft` |
| `attachments` | id, owner_id, questionnaire_id?, request_id?, storage_path, filename, size | שלו | insert/delete שלו (≤5 לפריט) |
| `quotes` | id, questionnaire_id, user_id, status (`draft`/`needs_manual_price`/`approved`/`sent`/`viewed`/`accepted`/`expired`/`void`), items jsonb, setup_cents, monthly_cents, deposit_cents, discount_code, scope_md, assumptions jsonb, timeline_text, valid_until, public_token, pay_method, pay_link, agreement_version, accepted_name, accepted_ip, accepted_ua, accepted_at, sent_at, viewed_at | שלו, רק מ-`sent` והלאה | — (Accept דרך Edge Function) |
| `private.quote_drafts` | quote_id, model, prompt_hash, raw_output jsonb, tokens, cost_usd | — | — |
| `clients` | id, user_id, quote_id, products text[], status (`onboarding`/`building`/`testing`/`live`/`paused`/`cancelled`), go_live_at, monthly_cents, next_bill_on | שלו | — |
| `payments` | id, client_id, kind (`deposit`/`final`/`monthly`/`overage`), amount_cents, method, status (`due`/`paid`/`refunded`), reference, paid_at | שלו | — |
| `onboarding_items` | id, client_id, key, title, video_url, status, data jsonb, done_at | שלו | status/data בלבד, דרך RPC |
| `requests` | id, client_id, title, body, status, position, admin_reply, updated_at | שלו | insert; עריכה רק ב-`queued` |
| `tenants` | id, client_id, slug, status (`sandbox`/`live`/`paused`), config jsonb (סכמה בסעיף 6.6), twilio_number, created_at | שלו | רק דרך RPC `update_tenant_settings` (רשימה לבנה: hours, faq, notify, paused) |
| `private.tenant_credentials` | tenant_id, provider (`google`/`calendly`/`twilio_sub`), ciphertext, expires_at | — | — (runtime בלבד, מוצפן ב-`CRED_KEY`) |
| `calls` | id, tenant_id, call_sid, from_e164, started_at, duration_s, outcome (`booked`/`message`/`handoff`/`emergency`/`spam`/`abandoned`), transcript jsonb, summary, cost_usd | של ה-tenant שלו | — |
| `sms_messages` | id, tenant_id, contact_e164, direction, body, twilio_sid, created_at | כנ"ל | — |
| `bookings` | id, tenant_id, call_id?, customer_name, contact_e164, address, job_type, urgency, start_at, end_at, provider_event_id, status | כנ"ל | — |
| `opt_outs` | tenant_id, contact_e164, opted_out_at | — | — |
| `events` | id, actor, entity, entity_id, type, payload, created_at | שלו (מסונן) | — |
| `private.settings` | admin_email, from addresses, flags (`client_emails_enabled`), budgets | — | — |

**RLS (החלטה, כמו בפורטל העברי):** כל טבלה ב-`public` עם RLS; לקוח = `user_id = auth.uid()` (או דרך `clients.user_id` / `tenants.client_id`); אדמין = `is_admin()` (security definer, laviemb@gmail.com נקבע אוטומטית). טריגרי guard חוסמים שינוי סטטוס/סכומים/is_admin ע"י לקוח. ה-runtime משתמש ב-service role ורק ממנו נכתבים `calls`, `sms_messages`, `bookings`. ל-`private` אין גישת API.
**Storage:** `client-files` (פרטי, נתיב `{uid}/{entity}/{rand}-{ascii-name}`, 10MB), `videos-public` (ציבורי, סרטוני onboarding), `quote-pdf` (פרטי, שלב מאוחר).
**שמירה:** תמלילים ו-SMS נמחקים אחרי 90 יום (cron `pg_cron`), הזמנות 2 שנים, לקוח שבוטל: מחיקה מלאה 30 יום אחרי סיום.

---

## 5. אירועי מייל (Resend)
שולח: `{brand.name} <hello@{brand.domain}>`, reply-to `meir@ai-lab.co.il`. עד שיש דומיין: שליחה מ-`ai-lab.co.il` המאומת (כבר עובד). מיילי לקוח באנגלית; מיילים למאיר בעברית. כל מייל נרשם ב-`events`; כשל לא מכשיל פעולה. מיילים ללקוח כבויים (`client_emails_enabled=false`) עד שמאיר מאשר נוסחים.

| מפתח | טריגר | אל | נושא |
|---|---|---|---|
| `auth_code` | כניסה | לקוח | Your sign-in code: {code} |
| `lead_capture` | מייל בדף בלי שאלון | לקוח | Your fixed-quote link |
| `q_received` | שאלון → submitted | לקוח | Got it — your fixed quote arrives within 1 business day |
| `admin_new_quote` | טיוטה מוכנה | מאיר | הצעה חדשה לאישור: {עסק} · {הצעה} · ${סכום} |
| `quote_sent` | מאיר אישר | לקוח | Your fixed quote from {brand}: ${setup} + ${monthly}/mo |
| `quote_reminder` | 3 ימים אחרי sent בלי accept | לקוח | Any questions about your quote? (פעם אחת) |
| `admin_quote_accepted` | accept | מאיר | ✅ {עסק} אישר הצעה, ממתין לתשלום |
| `deposit_received` | מאיר סימן שולם | לקוח | Welcome aboard — your setup checklist is ready |
| `onboarding_nudge` | 3 ימים בלי התקדמות בצ'ק-ליסט | לקוח | 2 steps left to get your receptionist live |
| `need_help` | "Need help" בסעיף | מאיר | {עסק} צריך עזרה ב: {סעיף} |
| `ready_to_test` | client → testing | לקוח | Your AI receptionist is ready to test |
| `final_payment_due` | Approve go-live | לקוח | Final payment before go-live |
| `went_live` | client → live | לקוח | You're live 🎉 — what happens now |
| `lead_alert` | כל ליד/הזמנה מהסוכן (גם SMS) | בעל העסק | New lead: {job_type} · {name} · {city} |
| `daily_summary` | 19:00 שעון הלקוח | בעל העסק | Today: {n} calls answered, {b} booked |
| `request_update` | שינוי סטטוס בקשה | לקוח | Request "{title}" is now {status} |
| `monthly_invoice` | 1 לחודש | לקוח | Your {brand} monthly invoice |
| `admin_daily` | 08:00 שעון ישראל | מאיר | סיכום יומי: לידים, הצעות, תקלות runtime, עלויות Claude/Twilio |

---

## 6. המוצר: Missed-Call AI Receptionist

### 6.1 ארכיטקטורה (החלטה: **Python 3.12 + FastAPI**, שירות אחד ב-Railway)
למה Python: סוכן הוואטסאפ העברי כתוב ב-Python ורץ ב-Railway, כך שהדפוסים (`guard.py`, מתזמן, mailer) עוברים כמעט כמו שהם; ל-Twilio, Google API, Anthropic SDK ו-Supabase יש ספריות Python רשמיות; הבדיקות והסימולטור כתובים באותה שפה. Node לא נותן יתרון ממשי בזרימה מבוססת webhooks.
מבנה: `runtime/app/` (main, tenants, brain, guard, voice, sms, calendar/{google,calendly,fake}, notify, zapier, store), `runtime/sim/`, `runtime/tests/`. tenant נקבע לפי המספר שאליו הגיעה השיחה (`To`). כל webhook של Twilio מאומת בחתימה. סודות ב-Railway בלבד.

### 6.2 זרימת שיחה (החלטה: Twilio `<Gather input="speech">` + `<Say>` בקול Polly Neural)
1. הלקוח של דני מתקשר לדני → אין מענה תוך ~20 שניות → הספק מעביר (call forwarding on no-answer/busy) למספר ה-Twilio של ה-tenant.
2. `POST /voice/incoming`: בדיקות guard (blocklist, tenant paused, תקציב) → ברכה: "Thanks for calling Cool Breeze HVAC, this is the virtual assistant. Sorry we missed you — I can get you booked. This call may be transcribed. What can we help with?"
3. כל תור: התמלול של Twilio → `POST /voice/turn` → Claude (`claude-opus-5-5`, effort `low`, כלים בסעיף 6.4) → טקסט קצר (≤ 2 משפטים) → `<Say>` + `<Gather>` הבא.
4. מגבלות: 12 תורות או 6 דקות; 2 תורות שקטים ברצף = סיום מנומס; אחרי סיום → `calls` + סיכום + `lead_alert`.
5. ניתוק לפני הברכה / שתיקה = `abandoned` → **SMS text-back** תוך דקה (אם המספר נייד ולא ב-opt_outs).
**למה לא סטרימינג עכשיו:** Gather/Say פשוט, יציב, ניתן לסימולציה מלאה. השהיה של 2–3 שניות לתור סבירה לשיחה שכבר פוספסה. שדרוג ל-Twilio ConversationRelay = שלב ג', אותו `brain`.

### 6.3 זרימת SMS
- **Text-back:** "Hi, this is Cool Breeze HVAC. Sorry we missed your call! What can we help with? You can also book here: {link}. Reply STOP to opt out."
- כל SMS נכנס → STOP/START/HELP מטופלים **לפני** Claude (STOP → `opt_outs`, אישור אחד, שקט מוחלט) → guard → Claude עם אותו brain וכלים → תשובה ≤ 320 תווים.
- אין הודעות יזומות מעבר ל-text-back ותזכורת הזמנה אחת (24 שעות לפני). אין שיווק. אין הודעות בין 21:00 ל-08:00 שעון הלקוח, למעט תשובה ישירה להודעה נכנסת.

### 6.4 כלים של Claude וכללי הזמנה
כלים: `get_availability(job_type, date_from)` · `book_slot(slot_id, name, phone, address, job_type, urgency, notes)` · `take_message(summary, urgency)` · `handoff(reason)` · `end_conversation(outcome)`. כולם `strict`.
כללים (בקוד, לא בפרומפט בלבד): רק סלוטים שהוחזרו מ-`get_availability`; חלונות לפי `booking.windows` (למשל 8–12, 12–4); מרווח מינימום (`lead_time_hours`); עד `max_per_window`; אזור שירות לפי ZIP (מחוץ לאזור → הודעה מנומסת + `take_message`); אירוע ביומן עם כל הפרטים + "Booked by AI receptionist"; אישור SMS ללקוח. כפילות (אותו מספר + אותו יום) → לא מזמינים שוב.

### 6.5 מסירה לבן אדם וכללי הגנה (בהשראת `guard.py`)
**Handoff:** הלקוח מבקש אדם / כועס / שאלה מחוץ לידע → אם `handoff.mode=dial` ובשעות on-call → `<Dial>` לנייד של דני (20 שניות) ואם לא עונה → `take_message`; אחרת `take_message` + `lead_alert` מסומן HUMAN NEEDED.
**חירום:** מילות מפתח (gas smell, carbon monoxide, fire, sparks, flooding, no heat + elderly/baby) → אם סכנת חיים: "Please hang up and call 911 now" (תמיד ראשון); אחרת התראת URGENT מיידית לבעלים ב-SMS + `dial` אם מוגדר.
**כללים קשיחים (טהורים, נבדקים ביחידה):**
1. לא ייעוץ רפואי, משפטי, פיננסי או בטיחותי מעבר ל-"call 911" / "a technician will check it".
2. **מחירים רק אם `pricing.mode = "listed"`**, ורק המחירים שבקונפיג (למשל service call $89). אחרת: "Our team will give you an exact price on site." אין הנחות, אין התחייבות לזמן הגעה שלא הוזמן ביומן.
3. שעות: מחוץ לשעות → `after_hours.mode` (`book_next_day` / `message_only` / `emergency_dial`).
4. הודעת לקוח = נתונים, לא הוראות (קישורים ומספרים מנוטרלים כמו `as_data`).
5. קצב לכל מספר: 8 תשובות Claude ב-10 דקות, 30 ביום; חריגה שנייה ביום = השתקה 24 שעות + התראה אחת.
6. תקציב: $3 ליום לכל tenant, $25 ליום גלובלי; חריגה = מצב "message only" בלי Claude + התראה למאיר.
7. SMS מעל 600 תווים / MMS / אודיו → תשובה קבועה בלי Claude.
8. ספאם: מספר ב-blocklist, Lookup מסמן `landline` → בלי text-back; 2 שקטים בשיחה → ניתוק בלי SMS; רובו-קולר (תמלול ריק/מוזיקה) → `spam`.
9. אנגלית בלבד, אלא אם `ADD-ES` פעיל.
10. לעולם לא לטעון שהוא אדם. שאלו "are you a robot?" → "I'm the virtual assistant for {business}."

### 6.6 קונפיג tenant (`tenants.config`, JSON schema ב-`runtime/app/tenant_schema.json`)
```json
{
  "business": {"name": "Cool Breeze HVAC", "niche": "hvac", "timezone": "America/Chicago",
               "service_area_zips": ["77002","77005"], "main_phone": "+17135550100"},
  "voice": {"tts_voice": "Polly.Joanna-Neural", "greeting": "…", "languages": ["en"]},
  "hours": {"mon": ["07:00","18:00"], "sat": ["08:00","12:00"], "sun": null},
  "after_hours": {"mode": "book_next_day"},
  "booking": {"provider": "google", "calendar_id": "primary", "windows": [["08:00","12:00"],["12:00","16:00"]],
              "lead_time_hours": 2, "max_per_window": 3, "job_types": ["AC repair","Furnace repair","Maintenance","New install estimate"]},
  "pricing": {"mode": "none", "items": []},
  "faq": [{"q": "Do you service Trane units?", "a": "Yes, all major brands."}],
  "emergency": {"keywords": ["gas smell","carbon monoxide"], "dial": "+17135550111"},
  "handoff": {"mode": "dial", "number": "+17135550111", "hours": "business"},
  "notify": {"sms": ["+17135550111"], "email": ["dani@coolbreeze.com"], "daily_summary": "19:00"},
  "zapier": {"webhook_url": null, "events": ["lead.created","booking.created"]},
  "guard": {"daily_budget_usd": 3, "blocklist": []},
  "paused": false
}
```

### 6.7 לוגים ומדדים
לכל שיחה/שרשור: תמליל, החלטות guard, קריאות כלים, טוקנים ועלות, משך תור (p50/p95 נמדד). ב-Railway: לוג JSON בלי תוכן אישי. אדמין: עלות לכל tenant לחודש מול ה-$300.

### 6.8 מה הלקוח מספק (= צ'ק-ליסט ה-onboarding, כל סעיף עם סרטון)
1. **Business details & hours** (טופס בפורטל).
2. **FAQ** (עד 25 שאלות; הצעה אוטומטית מהאתר שלו).
3. **Who gets alerts** (ניידים + מיילים).
4. **Connect your calendar** (Google OAuth או Calendly OAuth, כפתור אחד).
5. **SMS registration info** (שם משפטי, EIN, כתובת, אתר) → אנחנו רושמים 10DLC.
6. **Connect other tools** (Zapier webhook URL, אם רלוונטי).
7. **Turn on call forwarding** (רק אחרי Testing): הוראות לפי ספק (Verizon, AT&T, T-Mobile, Comcast Business, RingCentral, Google Voice, אחר) עם "test call" שמאמת שהשיחה הגיעה ל-Twilio.

### 6.9 הסימולטור המקומי (חובה, לפני כל Twilio אמיתי)
`python -m sim` מריץ את ה-FastAPI מקומית עם: Twilio מדומה (שולח webhooks חתומים כמו Twilio, "מדבר" טקסט במקום קול), יומן מדומה (SQLite), Claude אמיתי או `CLAUDE_MODE=replay` (תשובות מוקלטות, לבדיקות בלי עלות), ו-Supabase מקומי או קבצי JSON. ממשק: CLI (`sim call --tenant demo-hvac --say "my ac is broken"`) + דף `/sim` בדפדפן (צ'אט עם בחירת "קול/SMS"). **20 תרחישים** ב-`runtime/sim/scenarios/*.yaml` עם תוצאה צפויה (booked / handoff / emergency / spam / STOP / out-of-area / after-hours / pricing-question / prompt-injection / budget-exceeded …). `pytest` מריץ את כולם ב-replay.

---

## 7. ערכות
**Upwork (`docs/kits/upwork.md`):** כותרת פרופיל ("AI Receptionist & Automation for Home Service Businesses — Fixed Price"), Overview, 3 פריטי Portfolio (דמו, צילום פורטל, סרטון), 2 Project Catalog (RCP, WEB) באותם מחירים, 3 תבניות Proposal (שירותי בית / נדל"ן / כללי) שמפנות לשאלון, 15 מילות חיפוש, שגרה יומית של 20 דקות (10 הצעות בשבוע), כללי Upwork (תשלום רק דרך Upwork בתוך החוזה; מותר קישור לשאלון אחרי שנפתח חוזה).
**משפטי (`site/legal/`, טיוטות; עו"ד אמריקאי לפני לקוח ראשון):**
- *Terms of Service:* שירות מרחוק מישראל, ללא שיוך ל-Anthropic, הגבלת אחריות לסכום ששולם ב-12 חודשים, דין: **מדינת ניו יורק, בוררות מקוונת** (מה שקונה אמריקאי מצפה לו; עו"ד יאשר).
- *Privacy Policy:* מה נאסף (בעל העסק ולקוחותיו), מעבדי משנה (Supabase, Twilio, Anthropic, Resend, Google, Railway), שמירה 90 יום, CCPA בסיסי, בקשות מחיקה.
- *Service Agreement:* היקף = ההצעה, 50/50, IP עובר בתשלום מלא (התבניות והקוד המשותף נשארים שלנו ברישיון), אחריות הלקוח לחוקיות השימוש ב-SMS ולגילוי תמלול, SLA "best effort" 99%, ביטול חודשי בהתראה של 30 יום, החזר מקדמה 7 ימים, W-8BEN לפי בקשה.
**סרטונים (`videos/scripts/`, 4 בשלב ב', 60–150 שניות, הקלטת מסך + קריינות AI באנגלית):** (1) *What it does* — שיחה שפוספסה הופכת להזמנה; (2) *Connect your calendar*; (3) *Turn on call forwarding* (גרסה כללית + כתוביות לפי ספק); (4) *Your portal & requests*. לכל תסריט: מטרה, שוטים, טקסט מילה במילה, CTA. מאיר מאשר תסריטים לפני הפקה.

---

## 8. אבטחה ופרטיות (הערות, לא ייעוץ משפטי)
- **TCPA / SMS:** text-back הוא תגובה לשיחה שהלקוח יזם, מידע בלבד, בלי שיווק; כל הודעה ראשונה מזהה את העסק וכוללת "Reply STOP to opt out"; STOP מכובד מיידית ולצמיתות (גם בין tenants של אותו עסק). אין שיחות יוצאות בקול AI (FCC 2024: קול AI = "artificial voice" בשיחות יוצאות). רישום A2P 10DLC לכל עסק תחתנו כ-ISV.
- **תמלול:** בברכה "This call may be transcribed". לא שומרים הקלטת אודיו (`record=false`). חלק מהמדינות דורשות הסכמת שני הצדדים להקלטה: הגילוי בברכה + אחריות הלקוח בהסכם.
- **CAN-SPAM:** מיילים טרנזקציוניים פטורים ברובם; כל מייל שאינו טרנזקציוני (תזכורת, ניוזלטר) כולל unsubscribe וכתובת פיזית (כתובת העסק בישראל מספיקה).
- **דנטל/משפט:** לא נוגעים במידע רפואי/משפטי; הסוכן אוסף רק שם, טלפון וסיבה כללית. אין BAA ב-v1, לכן הדפים במצב early access.
- **סודות:** OAuth refresh tokens מוצפנים (AES-GCM, מפתח ב-Railway בלבד); webhooks של Twilio מאומתים בחתימה; Edge Functions מאמתות JWT; אין סודות בריפו (gitignore + בדיקת `gitleaks`-light בסקריפט QA).
- **שמירה:** תמלילים ו-SMS 90 יום; לוגים טכניים 30 יום; גיבוי Supabase Free = אין PITR → ייצוא שבועי ל-JSON (GitHub Action פרטי).

---

## 9. מה מאיר צריך לספק, ומתי

| מתי | מה | איך (בקצרה; ההוראה המלאה תגיע לחיצה-לחיצה) | הצלחה = |
|---|---|---|---|
| עכשיו | אישור המפרט | לקרוא, לכתוב "מאושר" או הערות | — |
| לפני A2 | טוקן Supabase של חשבון meir@ai-lab.co.il | supabase.com/dashboard/account/tokens → Generate → להדביק ב-`ailab-pro-us/.secrets.env` | הסקריפט מדפיס "✅ ailab-us נוצר" |
| לפני A6 | מפתח Claude API עם יתרה | console.anthropic.com → API Keys → Create → לקובץ הסודות | `quote-draft` מחזיר טיוטה |
| לפני A6 | Google OAuth client לכניסה (Web) | כמו בפורטל העברי, origin של הדומיין/localhost | כפתור Google עובד |
| לפני שליחת הצעה ראשונה | אמצעי תשלום: PayPal Business (או תשובת טרנזילה) | paypal.com → Business → חשבוניות | קישור תשלום ראשון |
| לפני לקוח ראשון | דומיין `ailabpro.ai` (~$90/שנה) | Namecheap/Cloudflare → קנייה → DNS לפי הוראה | האתר עולה בדומיין |
| לפני לקוח ראשון | חשבון Upwork מאומת, עו"ד לחוזים | — | פרופיל חי, מסמכים מאושרים |
| שלב B9 | Twilio: חשבון, שדרוג מ-trial, ISV/Trust Hub, מספר | מדריך נפרד | "test call" עובר |
| שלב B5 | Google Cloud: OAuth לאפליקציית היומן + **בקשת verification** (scope רגיש) | מדריך נפרד; דורש דומיין + Privacy Policy + סרטון | Google מאשר |
| שלב B11 | חיבור ElevenLabs מחדש או אישור קול AI גנרי | — | קריינות ראשונה |

---

## 10. סיכונים והנחות
1. **אימות Google ליומן** (scope רגיש): בלי verification, טוקנים במצב Testing פגים אחרי 7 ימים. מענה: להגיש מוקדם; עד אז הזמנה דרך Calendly או "take_message" + התראה.
2. **10DLC:** עד 15 יום ושליש נדחים בפעם הראשונה → להתחיל בשבוע הראשון אחרי מקדמה; ה-Voice עובד בינתיים בלי SMS.
3. **השהיית קול** 2–3 שניות לתור: מקובל בגרסה 1, נמדד, ושדרוג מתוכנן.
4. **אמינות השרת:** Railway שירות אחד = נקודת כשל אחת. בריאות כל 5 דקות + התראה למאיר; ב-Twilio מוגדר fallback URL שמשמיע "please leave a message" ומקליט הודעה קולית (ההקלטה היחידה, עם גילוי).
5. **Supabase Free נרדם אחרי 7 ימים** → keep-alive יומי (כמו בפורטל העברי); ה-runtime עצמו שומר גם הוא פעילות.
6. **עלות Claude לשיחה** (הערכה: $0.05–0.15) × 400 שיחות = עד $60 מתוך $300. מעקב בדוח החודשי; החלפת מודל היא ערך קונפיג.
7. **אחריות על טעויות AI** (הזמנה שגויה, הבטחה): כללים בקוד + הסכם + "Pause AI" בפורטל.
8. **הפרשי שעות:** "תוך יום עסקים" ולא "תוך שעה"; התראות למאיר רק בשעות 08:00–23:00 שעון ישראל, למעט תקלת runtime.
9. **מותג זמני:** כל השמות, הדומיין, השולחים וה-GA ב-`config/brand.json`; החלפה = שינוי אחד + build.
10. **הנחה:** 3 הלקוחות הראשונים מגיעים מ-Upwork, ואז התשלום עובר דרך Upwork והבעיה של סליקת דולר נדחית.
