> **החלטה (11.10.2026): מפתחות נישה בכל הריפו הם snake_case כמו ב-DB — `home_services`, `real_estate`, `dental`.** (ה-enum `public.niche`; `brand.json`, דפים ושאלון משתמשים באותם מפתחות. נתיבי URL כמו `/home-services/` הם נתיבים בלבד, לא מפתחות.) אין נישת משפט.

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
