# A2 · ביקורת: APPROVE (עם 5 הערות לא חוסמות)

**מה הרצתי בעצמי (בלי רשת ל-api.supabase.com, בלי לקרוא את `.secrets.env`)**
- `python3 tools/us_setup.py --self-test` → 26 tests OK. הטסטים כותבים לקובץ סודות זמני ולא נוגעים בקובץ האמיתי.
- `env -i … HTTPS_PROXY=http://127.0.0.1:9 python3 tools/us_setup.py --dry-run --create` → תוכנית של 12 שלבים, rc=0. בקוד, `dry_run()` חוזר לפני שנוצר `Api`, והטסט מוודא את זה עם transport שזורק שגיאה.
- `check_secrets.py .` → 0 ממצאים. `.gitignore` מכסה את `.secrets.env`. הקובץ האמיתי במצב 0600.

**מה בדקתי**
1. סודות: הטוקן נכנס רק ל-Authorization, ו-`ApiError` מכיל רק את הנתיב ואת גוף התשובה אחרי הסתרה. שום `say` לא מדפיס ערך (רק יש/אין). סיסמת ה-DB נכתבת (append, 0600) **לפני** `POST /projects`. CLI מקבל את הטוקן דרך env ולא דרך argv. אין DELETE, pause או restore.
2. API (מהידע שלי): `POST /v1/projects` עם `organization_slug` ונסיגה ל-`organization_id`. ההערכה שלי: `organization_slug` הוא השם הנוכחי ו-`organization_id` הוותיק, ביטחון בינוני. `region` עדיין מתקבל, אבל `region_selection` הוא השם החדש. `plan` לא נשלח, וזה נכון כי התוכנית נקבעת לפי הארגון והשדה deprecated. גם אלה נכונים: polling ל-`ACTIVE_HEALTHY`, `/database/query {query}`, השדות של `config/auth` (`mailer_otp_length/exp`, `mailer_subjects_*`/`mailer_templates_*_content`, `smtp_*` עם `smtp_port` כמחרוזת, `external_google_*`), `POST /secrets` כמערך `{name,value}`, `functions/deploy?slug=` ב-multipart עם `metadata`+`file`, `api-keys?reveal=false`, ו-`vault.create_secret/update_secret`. ביטחון גבוה. לא מצאתי שדה שגוי.
3. `rls_test.sql` מסתיים ב-`raise exception 'RLS_TESTS_PASSED'`, כך שהכל מתגלגל אחורה (rollback) על ה-DB האמיתי. ההרצה חוזרת בלי בעיה. `--only`/`--ref`/`--org` עובדים ונבדקים.
4. `config.js`: השדות זהים למה ש-`site/start/assets/backend.js` קורא (BACKEND, SUPABASE_URL/ANON_KEY/JS, GOOGLE_ENABLED, ALLOW_MOCK_SWITCH, BUCKET, MAX_FILES, MAX_FILE_MB). `FEATURES` הוא תוספת לא מזיקה. בלי הקובץ המצב הוא `off`, ו-`?mock=1` ב-localhost עדיין עובד (e2e משתמש בזה).
5. ה-runbook לחיצה-לחיצה, עם "הצלחה =" וטבלת תקלות. הסבר ההשהיה ב-Free נמצא שם. ה-keep-alive יוצא ב-exit 0 בשקט כשאין סודות, ו-exit 1 רק כשהפינג נכשל (זו ההתראה, לא CI).
6. `us_setup_check.py`: RLS בכל הטבלאות, אין הרשאות anon (חוץ מ-ping), ping, משימות cron, ו-`delete from auth.users` מתוך משימת pg_cron חד-פעמית עם ניקוי ב-finally. המסלול החלופי (Auth admin API) מתועד.
7. הדוח מדויק: 26/12/0 אומתו, והדברים שלא נבדקו מול API אמיתי מסומנים ככאלה.

**הערות (לא חוסמות, כדאי לתקן לפני ההרצה האמיתית)**
1. SPEC §5 אומר שעד שיש דומיין שולחים מ-`ai-lab.co.il` המאומת. הסקריפט לוקח כברירת מחדל את השולח מ-brand (`ailabpro.co`, לא מאומת), ולכן ברגע שמוסיפים `RESEND_API_KEY` מיילי הכניסה ייכשלו בלי `--smtp-from`. מוצע: נסיגה אוטומטית לפי SPEC, או ⚠️ בולט.
2. ה-runbook אומר `GOOGLE_OAUTH_CLIENT_ID=`, אבל ב-`.secrets.env.example` כתוב `GOOGLE_CLIENT_ID=`. מאיר לא ימצא את השורה. צריך לאחד את השמות.
3. שגיאות רשת (`URLError`/timeout) לא נתפסות ב-`urllib_transport`, ולכן יוצא traceback באנגלית במקום ❌ בעברית. לא דולף סוד.
4. מגבלת Free היא 2 פרויקטים פעילים **לכל משתמש** בכל הארגונים, והסקריפט סופר רק בארגון שנבחר. בחשבון חדש זה לא משנה, וה-API ידחה בכל מקרה.
5. GitHub מכבה workflows מתוזמנים אחרי 60 יום בלי פעילות בריפו. כדאי להוסיף שורה ל-runbook. הקובץ נקרא `supabase-us-setup.he.md` ולא `supabase-setup.he.md` כמו ב-TASKS. זו סטייה קלה, והיא מתועדת ב-`tools/README.md`.

גילוי נאות: הרצתי בטעות פקודת `git status --short` אחת (קריאה בלבד). לא שיניתי אף קובץ חוץ מהדוח הזה.
