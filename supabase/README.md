> **החלטה (11.10.2026): מפתחות נישה בכל הריפו הם snake_case כמו ב-DB — `home_services`, `real_estate`.** (12.10.2026: `dental` הוסר מהמוצר ונשאר ב-enum רק לשורות היסטוריות; אין מיגרציה שמוחקת ערך enum.) (ה-enum `public.niche`; `brand.json`, דפים ושאלון משתמשים באותם מפתחות. נתיבי URL כמו `/home-services/` הם נתיבים בלבד, לא מפתחות.) אין נישת משפט.

# supabase/ — מיגרציות, RLS, בדיקות SQL ו-Edge Functions (quote-draft, quote-view, quote-accept, notify, zapier-out) של פרויקט ailab-us.

## RPCs שה-DB חושף (חתימות קבועות)

| פונקציה | מי מריץ | שימוש |
|---|---|---|
| `public.ping() → text` | anon / authenticated / service_role | keep-alive יומי (פרויקט Free), בריאות ה-runtime (`store.ping`) |
| `public.runtime_put_credential(p_tenant_id uuid, p_provider text, p_ciphertext text, p_expires_at timestamptz default null) → void` | **service_role בלבד** | upsert ל-`private.tenant_credentials`; רק ciphertext (AES-GCM, `CRED_KEY` ב-Railway). provider ∈ `google`/`calendly`/`twilio_sub` |
| `public.runtime_get_credential(p_tenant_id uuid, p_provider text) → text` | **service_role בלבד** | מחזיר ciphertext או null |
| `public.update_tenant_settings(p_tenant_id uuid, p_patch jsonb) → jsonb` | לקוח (שלו) / אדמין | רשימה לבנה: `hours`, `faq`, `notify`, `paused` |
| `public.update_onboarding_item(p_id uuid, p_status onboarding_status, p_data jsonb default null)` | לקוח (שלו) / אדמין | סטטוס `todo`/`done`/`need_help` + מיזוג `data` |

החתימות של `runtime_*` תואמות ל-`runtime/app/store.py` (`SupabaseStore.put_credential`/`get_credential`, פרמטרים `p_tenant_id`, `p_provider`, `p_ciphertext`, `p_expires_at`). anon/authenticated חסומים גם בהרשאות וגם בבדיקת תפקיד בתוך הפונקציה; נבדק ב-`tests/rls_test.sql`.

## `public.runtime_state` (מיגרציה `20261011100300_us_runtime_state.sql`)
מצב קטן ועמיד של ה-runtime: מוני קצב, תקציב, שימוש חודשי. עמודות `id`, `key` (ייחודי גלובלית), `tenant_id` (nullable, נמחק יחד עם ה-tenant), `value jsonb`, `updated_at`. החוזה זהה ל-`StateStore` ב-`runtime/app/store.py`: select לפי `key`, update לפי `id`, insert, הכל דרך PostgREST. הטבלה ב-`public` רק כדי ש-PostgREST יגיע אליה; ל-anon ול-authenticated אין הרשאות ואין מדיניות, כך שרק service role ניגש אליה. נבדק ב-`tests/rls_test.sql`.

## מיילים (A8) — מה `tools/us_setup.py` (A2) צריך להגדיר

מיגרציה `20261011100500_us_email_events.sql`: outbox ב-`private.email_outbox` (מפתח `idem_key` ייחודי = Idempotency-Key ב-Resend), טריגרים על `events`/`payments`/`leads`, RPC לשירות בלבד (`email_claim`, `email_complete`, `email_settings`, `email_recipient`, `email_unsubscribe`, `storage_purge_claim`, `storage_purge_done`), RPC לאדמין `admin_log_event(p_entity, p_entity_id, p_type, p_payload)` (A7). Edge Function `events-dispatch` שולחת; `email-unsubscribe` מטפלת בהסרה.

| # | מה | שם מדויק | ערך / הערה |
|---|---|---|---|
| 1 | פריסת Edge Functions | `events-dispatch` | `verify_jwt = true` (נקרא רק עם service role) |
| 2 | | `email-unsubscribe` | **`verify_jwt = false`** (קישור ציבורי במייל) |
| 3 | סוד Edge Function | `RESEND_API_KEY` | בלעדיו המיילים נשארים `pending` (לא נשרפים ניסיונות). `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` מוזרקים אוטומטית |
| 4 | Vault | `ailab_us_project_url` | `https://<ref>.supabase.co` |
| 5 | Vault | `ailab_us_service_role_key` | אותו מפתח service role (JWT) שה-Edge runtime מזריק כ-`SUPABASE_SERVICE_ROLE_KEY` |
| 6 | אחרי 4–5, SQL אחד | `select private.install_email_jobs();` | idempotent. יוצר 5 משימות pg_cron (UTC): `ailab-us-email-dispatch` כל דקה (רק כשיש מה לשלוח), `ailab-us-email-scan` 15:00 (תזכורת הצעה + nudge), `ailab-us-monthly-invoice` 15:00 ב-1 לחודש, `ailab-us-quote-expiring` 14:30 (קורא ל-`quote-expiring`), `ailab-us-storage-purge` 03:47 (מוחק קבצים מ-`private.storage_purge_queue`) |
| 7 | `private.settings` | `admin_email` | המייל של מאיר (ברירת מחדל קיימת). `client_emails_enabled` נשאר `false` עד שמאיר מאשר נוסחים (חוסם רק תזכורות, ראו למטה); `admin_emails_enabled = true` |
| 8 | Resend | דומיין `brand.domain` | עד שמאומת: שגיאת domain מ-Resend → שליחה חוזרת אוטומטית מ-`senders.fallback` |

**שולח:** `brand.smtp_from` אם מלא, אחרת `senders.transactional` / `senders.quotes` (הצעות) / `senders.alerts` (למאיר), אחרת `senders.fallback`. reply-to: `senders.reply_to` (ללקוח), מייל הלקוח (למאיר).
**טרנזקציוני מול תזכורת:** `quote_reminder`, `quote_expiring`, `onboarding_nudge` = תזכורות: נשלחות רק כש-`client_emails_enabled=true`, עם קישור הסרה + `List-Unsubscribe`, ורק אם `brand.physical_address` מלא (CAN-SPAM). כל השאר טרנזקציוני ויוצא תמיד. מיילים למאיר נדחים ל-08:00 שעון `owner.timezone` אם נוצרו בין 23:00 ל-08:00.
**לא כאן:** `auth_code` (Supabase Auth), `lead_alert` / `daily_summary` / `admin_daily` / התראות שימוש / דוח ROI חודשי (runtime, B6).
**בדיקות:** `deno run -A --node-modules-dir=none supabase/tests/offline/email_events_run.ts` (אופליין בלבד: הבדיקה כותבת ל-stand-in של `vault`/`net`). בפרויקט אמיתי: `select * from cron.job where jobname like 'ailab-us-%'` = 7 שורות; `select status, count(*) from private.email_outbox group by 1`.
