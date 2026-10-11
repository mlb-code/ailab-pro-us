# A8 · ביקורת — **APPROVE** (בלי חוסמים; משימות המשך ל-A2/A6 ולמאיר בהמשך)

**בדיקות שהרצתי בעצמי:** `deno test` → 58/58 · `email_events_run.ts` → 55 · `offline/run.ts` → ALL PASSED (159 + 10 מוטציות) · `quote_engine_run.ts` → 9 · `sql_lint` ✅ (7 מיגרציות) · `check_hardcoded` 0 (גם על email-previews) · `check_secrets` 0 · `sync_config --check` בלי drift · `deno lint` נקי. התצוגות המקדימות נוצרו מחדש (16 + index). צילמתי 6 מיילים במצב בהיר וכהה (CDP `prefers-color-scheme`) ל-`docs/reports/shots-a8/`. ב-375 וב-640 אין גלילה אופקית, ואין שגיאות קונסול.

**1. כיסוי אירועים.** כל אירוע ב-SPEC §5 משויך לבעלים אחד ואין כפילות עם B6:
- `auth_code` → Supabase Auth.
- `lead_alert`, `daily_summary`, `admin_daily` → runtime B6.
- כל השאר → A8. הנמענים: הלקוח, או מאיר ב-`admin_new_quote`, `admin_quote_accepted` ו-`need_help`.
- שתי תבניות נוספות של A6: `quote_accepted` ו-`quote_expiring`.
- `go_live_requested` (B7) → `final_payment_due` עם אותו מפתח כמו נתיב ה-payments, כך שהמייל יוצא פעם אחת ללקוח.
- `admin_log_event` קיים, עם `auth.uid()` ו-`private.is_admin()`. הוא חוסם זיוף של סוגי email, task ו-status, ויש לו בדיקה.
- מחיקת קבצים: `DELETE /storage/v1/object/{bucket}` עם `prefixes`, בנתחים של 100. רק תשובה 2xx מסמנת `done_at`. בדיקת ה-mock ובדיקת ה-SQL עוברות.

**2. אידמפוטנטיות.** יש `idem_key UNIQUE` עם `on conflict do nothing`. ה-claim משתמש ב-`FOR UPDATE SKIP LOCKED` וב-`locked_until`. `email_complete` פועל רק על שורה במצב `sending`, ולכן worker שמאחר מקבל `ignored`. ל-Resend נשלח `Idempotency-Key = idem_key`. הניסיונות החוזרים: 1/5/30/120/720 דקות, ואחרי 6 ניסיונות `failed`. הסכום, כ-14.6 שעות, נשאר בתוך חלון ה-24 שעות של Resend.
- בדיקה מקבילית ב-scratch (נמחקה): 5 הרצות `runDispatch` במקביל מול ה-SQL האמיתי ב-PGlite, על 30 לידים. יצאו 30 שליחות ייחודיות, וכל ה-30 במצב `sent`. הרצה נוספת לא תפסה אף שורה.
- הסתייגות: PGlite מריץ שאילתה אחת בכל רגע, אז זו לא תחרות אמיתית בין חיבורים. ההגנה האמיתית היא `SKIP LOCKED`, שהוא דפוס תקני.

**3. ציות.**
- `client_emails_enabled` חוסם רק את 3 התזכורות (`quote_reminder`, `quote_expiring`, `onboarding_nudge`). התזכורות כוללות קישור הסרה, `List-Unsubscribe`, `List-Unsubscribe-Post` וכתובת פיזית.
- כש-`physical_address` ריק, התזכורות מסומנות `skipped`. זה המצב היום.
- המיילים למאיר נדחים ל-08:00 לפי `Asia/Jerusalem`, וה-reply-to שלהם הוא כתובת הלקוח.
- סדר השולחים: `smtp_from` → `senders.*` → `fallback`. בשגיאת domain נשלח עוד ניסיון אחד מ-`fallback`.
- הקישורים נבנים מ-`site_url`, וההצעה נפתחת ב-`/quote/#t=`. הלוגים בלי PII.

**4. תבניות.** ללקוח: EN/LTR. למאיר: HE/RTL, עם בידוד LRI/PDI לסכומים. הכל בטבלאות, CSS inline, רוחב 600 וגרסת טקסט. סכומים ותאריכים מעוצבים, ואין מותג או מחיר כתובים בקוד.
- **באג נפרד של A6 (`quote_email.ts`):** במצב כהה התאים עם `bgcolor="#FFFFFF"` נשארים לבנים והטקסט בהם בהיר. A8 עוקף זאת עם `DARK_PATCH`, והצילום תקין. גם ה-`body` לא מוחשך, ונשאר פס בז' מתחת לכרטיס. התיקון שייך ל-A6.

**5. Cron ו-A2.** הדרישות מתועדות ב-README. הבדיקה מצפה ל-7 משימות cron: 2 של A1 ועוד 5 של A8. אבל `tools/us_setup.py` **עדיין לא מטפל בזה**, ול-A2 צריך להוסיף:
- (א) `step_vault`: סודות Vault `ailab_us_project_url` (`https://<ref>.supabase.co`) ו-`ailab_us_service_role_key`. זה מפתח ה-service_role מסוג JWT (legacy), נקרא מ-`/api-keys?reveal=true` ולא מודפס. הסודות `resend_api_key` ו-`anthropic_api_key` שב-Vault היום לא משמשים את A8.
- (ב) `NO_VERIFY_JWT`: להוסיף `"email-unsubscribe"`.
- (ג) `step_cron`: אחרי ה-Vault להריץ `select private.install_email_jobs();`, ולהוסיף ל-`CRON_JOBS` את `ailab-us-email-dispatch`, `-email-scan`, `-monthly-invoice`, `-quote-expiring` ו-`-storage-purge`.
- (ד) `RESEND_API_KEY` כבר נמצא ב-`FUNCTION_SECRET_KEYS`, ושם אין צורך בשינוי.

**6. דוח.** כל המספרים אומתו. החריגות מ-TASKS מתועדות: `events-dispatch` ו-`preview.ts` במקום `notify/` ו-`email_preview.py`, ו-`docs/email-copy.md` מוחלף ב-email-previews. הסתירה עם SPEC §5 (ש-`client_emails_enabled` חוסם את כל מיילי הלקוח) מדווחת בגלוי.

**המלצות שלא חוסמות:**
1. תזכורת שנחסמה על ידי דגל או חוסר כתובת נשרפת לצמיתות, כי ה-`idem_key` כבר נוצל. ב-`onboarding_nudge`, שורות `skipped` נספרות גם בתקרה של 3. עדיף `defer`, או לא לספור `skipped`.
2. SPEC §10.8 קובע "תוך יום עסקים". `quote_sla_text` = "within 24 hours" מבטיח יותר מזה, ומאיר צריך להכריע.
3. `senders.reply_to` = support@ailabpro.co. התיבה לא תקבל מיילים עד שהדומיין יוקם, ו-SPEC מציין את meir@.
4. A7 עוד לא קורא ל-`admin_log_event`.
5. B7 מזכיר "owner notice" על `go_live_requested`, ואין לזה תבנית.
6. כותרת `supabase/README.md` עדיין מזכירה `notify` ו-`zapier-out`.
7. ב-`admin_new_quote` הנישה מוצגת כמפתח גולמי (`home_services`).
