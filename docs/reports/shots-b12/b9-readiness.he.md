# הכנה ל-B9: Railway + Twilio, לחיצה-לחיצה (טיוטת B12, 11.10.2026)

> לא לקנות ולא לפרוס כלום לפני אישור מפורש של המתזמר. מחירים הם הערכה לפי דפי Twilio, ויש לאמת אותם במסך הרכישה.
> **החלטה (TASKS, נספח B9):** ב-v1 יש **חשבון Twilio ראשי אחד**. כל המספרים נקנים בו, ואין subaccounts. החתימה נבדקת מול `TWILIO_AUTH_TOKEN` יחיד, ו-subaccount לכל לקוח יגיע רק עם תמיכה בטוקן לכל tenant. כל חוסמי B12 נסגרו (הרצה 3).

## 0. מה צריך להכין לפני כן (מאיר)
1. חשבון Railway (כבר קיים, ה-Hobby של $5 לחודש מספיק לשירות אחד).
2. כרטיס אשראי ל-Twilio, ותעודה מזהה/מסמך עוסק מורשה כ-PDF.
3. כתובת אתר עם Privacy Policy ו-Terms (הדומיין החדש). בלי זה רישום ה-SMS נדחה.
4. Supabase של `ailab-us`. **עד שיהיה:** מריצים את בדיקת העשן עם `STORE_BACKEND=json` ו-Volume (סעיף 1.6).

## 1. Railway: שירות ה-runtime
1. railway.app → **New Project** → **Deploy from GitHub repo** → בוחרים את הריפו `ailab-pro-us` (פרטי).
2. נכנסים לשירות → **Settings** → **Root Directory** = `runtime` → Save. ה-Builder (Railpack) ופקודת ההפעלה נקראים מ-`runtime/railway.toml`: `uvicorn ... --workers 1`. **לא משנים ל-2 workers ולא מוסיפים replicas**: התור, המונים והנעילות בנויים ל-worker אחד.
3. **Settings → Networking → Generate Domain**. מעתיקים את הכתובת (למשל `https://ailab-rt.up.railway.app`). זה ה-`PUBLIC_BASE_URL`.
4. **Variables** → **New Variable**, אחד-אחד (בעמודה "סוד" לא מדביקים בצ'אט, רק ב-Railway):

| משתנה | ערך | סוד? |
|---|---|---|
| `RUNTIME_MODE` | `prod` | לא |
| `PUBLIC_BASE_URL` | הכתובת מסעיף 3, בלי `/` בסוף (חובה: חתימת Twilio וכתובת ה-WebSocket נבנות ממנה) | לא |
| `STORE_BACKEND` | `supabase` (או `json` עד שיש Supabase) | לא |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | מ-Supabase → Settings → API | המפתח: כן |
| `DATA_DIR` | `/data` (רק במצב json) | לא |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | מ-Twilio Console → Account Info (של **החשבון הראשי**) | הטוקן: כן |
| `CRED_KEY` | פקודה בטרמינל: `python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"` | כן. לא להחליף אחר כך (ההחלפה מוחקת את כל חיבורי היומן) |
| `RUNTIME_ADMIN_TOKEN` | אותה פקודה. אותו ערך נכנס גם לסודות של Supabase Edge Functions ול-cron | כן |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | כן |
| `BRAIN_MODE` | `live` | לא |
| `VOICE_MODE` | `stream` | לא |
| `GLOBAL_DAILY_BUDGET_USD` | `25` | לא |
| `RESEND_API_KEY` | resend.com → API Keys | כן |
| `ADMIN_EMAIL` | המייל של מאיר (ב-`brand.json` השדה `owner.admin_email` ריק) | לא |
| `CLIENT_EMAILS_ENABLED` | `false` עד אישור הנוסחים (התראות ליד ושימוש יוצאות בכל מקרה) | לא |
| `ZAPIER_SIGNING_SECRET` | אותה פקודה כמו CRED_KEY | כן |
| `TWILIO_VOICE_USD_PER_MIN` | `0.0785` (ConversationRelay ‏0.07 + קו נכנס 0.0085). **חובה** לפי נספח TASKS | לא |
| `DEMO_LIVE` | `0` עד שמאיר מאשר דמו חי | לא |
| `GOOGLE_CALENDAR_CLIENT_ID/_SECRET`, `CALENDLY_CLIENT_ID/_SECRET` | אחר כך, כשיש אפליקציות OAuth | כן |

5. Deploy. **הצלחה =** (אם `tenant_configs:false`, ב-`tenants_invalid` מופיע ה-tenant התקול. מתקנים אותו בעורך האדמין) `https://<domain>/health` מחזיר `"ok": true`. אחר כך `/health/deep` (דורש טוקן: בטרמינל `curl -H "Authorization: Bearer <RUNTIME_ADMIN_TOKEN>" https://<domain>/health/deep`) מחזיר 200, וכל ה-`checks` הם `true`. אם אחד מהם `false`, זה המשתנה החסר.
6. (רק במצב json) **Settings → Volumes → Add Volume**, ‏Mount path `/data`.
7. **Cron ל-`/jobs/tick` כל 10 דקות:** New → **Cron Job** (או שירות נפרד עם Cron Schedule `*/10 * * * *`), פקודה:
   `curl -fsS -X POST -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" https://<domain>/jobs/tick`
   **הצלחה =** בלוג של ה-cron מופיע JSON עם `"ran"`. בלי ה-cron אין text-back מושהה, אין תזכורות ואין סיכום יומי.
8. **X-Forwarded-For:** ה-runtime לוקח את הכתובת **האחרונה** ברשימה (מגבלות הדמו). אחרי הפריסה שולחים בקשה אחת עם `X-Forwarded-For: 1.2.3.4` ובודקים בלוג שה-IP שנספר הוא ה-IP האמיתי ולא 1.2.3.4. אם לא, הדמו נשאר `DEMO_LIVE=0`.

## 2. Twilio
1. twilio.com/try-twilio → נרשמים עם מייל העסק → מאמתים טלפון.
2. Console → **Upgrade** → כרטיס אשראי → טעינה ראשונה של $20.
3. **Trust Hub → Customer Profiles → Create Primary Business Profile:** סוג עסק Sole Proprietorship, שם ומספר העוסק, כתובת בישראל, אתר, איש קשר מורשה (מאיר). אישור: 1–3 ימי עסקים.
4. **Phone Numbers → Buy a number:** מדינה US, ‏Capabilities: Voice + SMS, קידומת אזור של העסק (לדמו 713/832). בערך $1.15 לחודש. **בחשבון הראשי, לא ב-subaccount.**
5. לוחצים על המספר → **Voice Configuration:**
   - A call comes in: Webhook, ‏`https://<domain>/voice/incoming`, ‏HTTP POST.
   - Primary handler fails: ‏`https://<domain>/voice/fallback`, ‏POST.
   - Call status changes: ‏`https://<domain>/voice/status`, ‏POST. **חובה**: בלי זה דקות הקול לא נספרות, ואין text-back אחרי ניתוק.
   - את ה-ConversationRelay ואת `/voice/relay` לא מגדירים ידנית. ה-runtime מחזיר אותם בתשובה (`wss://<domain>/voice/relay`, ‏action ‏`/voice/relay-end`).
6. **Messaging Configuration:** A message comes in: ‏`https://<domain>/sms/incoming`, ‏POST. ה-status callback של הודעות יוצאות נקבע מהקוד (`/sms/status`).
7. **A2P 10DLC.** הלקוח הוא ה-Brand, ומאיר הוא ה-ISV:
   - לכל לקוח: Trust Hub → **Secondary Customer Profile** עם שם משפטי זהה לרישום ב-IRS, EIN, כתובת בארה"ב, אתר עם Privacy/SMS terms, ונציג מורשה (מהסעיף "Texting registration" בצ'ק-ליסט).
   - **Brand:** ‏Low-Volume Standard ‏(~$4.50 חד-פעמי, עד ~6,000 מקטעים ביום, מספיק) או Standard ‏(~$46, כולל vetting).
   - **Campaign:** use case ‏"Customer Care" או "Low Volume Mixed"; ‏$15 vetting חד-פעמי, ועוד $1.50–$10 לחודש. בתיאור ה-opt-in: "The consumer calls the business; if the call is missed we send one informational text. Every first message names the business and says Reply STOP." מצרפים 2–3 הודעות לדוגמה מ-`sms_outbound.py`.
   - זמנים: Brand תוך דקות עד ימים; Campaign בדרך כלל 1–3 שבועות, ושליש נדחים בפעם הראשונה (SPEC §10). **הקול עובד בינתיים.** את ה-SMS מפעילים רק אחרי אישור.
   - **לקוח בלי EIN (עוסק יחיד אמריקאי):** Sole Proprietor brand (~$4.50 + ‏$2 לחודש). דורש כתובת וטלפון נייד בארה"ב לאימות OTP של הלקוח, קמפיין אחד ומספר אחד. **מאיר עצמו לא יכול להיות Sole Proprietor brand**, כי אין לו כתובת או נייד בארה"ב. הוא רק ה-ISV.
8. במספר הדמו (מותג AI Lab Pro עצמו, אם רוצים SMS בדמו): Standard brand עם מספר עוסק ישראלי, או להשאיר את הדמו בלי SMS.

## 3. בדיקת עשן ראשונה (שיחה ו-SMS אמיתיים)
1. ב-Supabase/JSON: tenant ‏`demo-hvac` עם `twilio_number` = המספר שנקנה, ‏`notify.sms` = הנייד של מאיר, `status=sandbox`.
2. מתקשרים מהנייד → שומעים ברכה עם "virtual assistant" ו-"may be transcribed" → אומרים "My AC is blowing warm air, ZIP 77005" → בוחרים חלון → שם וכתובת → "that's all".
3. **הצלחה =** בטבלת `calls` שורה עם `outcome=booked`, ‏`duration_s` > 0. אירוע ביומן הבדיקה (Calendly או Google). SMS אישור לנייד (רק אחרי שה-10DLC אושר). SMS ומייל "New lead" לבעלים. ב-`events` ‏`voice.latency`: לרשום p50/p95 של total ושל Claude.
4. שיחה שנייה: מנתקים לפני שמדברים → text-back אחד (רק אחרי 10DLC). שולחים "STOP" → מקבלים אישור אחד → שיחה נוספת וניתוק → **אף הודעה**.
5. עוצרים את השירות ב-Railway → מתקשרים → ה-fallback עונה. מפעילים מחדש.
6. מתעדים ב-`docs/reports/B9.md`: שעה, CallSid, תוצאה, latency.

## 4. מה B9 חייב למדוד (שלא נמדד בסימולטור)
- זמן תגובה מקצה לקצה לתור: מהתמלול הסופי ועד תחילת ההקראה. היעד: < 1 שנייה. כולל: STT של Twilio, זמן השרת (בסימולטור p95 < 55ms), Claude עם effort ‏low והתשובה המלאה (בגלל בדיקת ה-guard אין streaming), ו-TTS.
- שחתימת Twilio מגיעה ב-handshake של ה-WebSocket, ושהערכים `welcomeGreetingInterruptible="none"` ו-`interruptible="speech"` מתנהגים כצפוי.
- דקות מה-StatusCallback, ועלות אמיתית לשיחה מול ההערכה ($0.05–0.15 ל-Claude).

## 5. חזרה לאחור (rollback)
- תקלה בגרסה: Railway → Deployments → הגרסה הקודמת → **Redeploy**.
- תקלה שלא נפתרת מהר: ב-Twilio מוחקים את ה-Voice webhook של המספר (או מפנים ל-`/voice/fallback`). ההעברה של בעל העסק ממשיכה ל-Twilio, ושם עונה הודעה קולית. לחלופין, בעל העסק מכבה את העברת השיחות.
- עצירת AI ללקוח אחד: "Pause AI" בפורטל (`paused=true`), בלי פריסה מחדש.
- עצירת Claude לכולם: `GLOBAL_DAILY_BUDGET_USD=0` → מצב message-only.

## 6. עלות חודש ראשון (הערכה)
| פריט | בדיקות בלבד | + לקוח אחד בשימוש מלא (400 דק', 1,000 SMS) |
|---|---|---|
| Railway Hobby | $5–10 | $5–10 |
| מספרי Twilio (דמו + לקוח) | $1.15 | $2.30 |
| קול: 0.0785 לדקה | ~$4 (50 דק') | ~$31 |
| SMS: ~0.011 למקטע כולל carrier | ~$1 | ~$11 |
| Lookup line type | < $1 | ~$2 |
| 10DLC ללקוח | — | $20–61 חד-פעמי + $2–10 לחודש |
| Claude (תקרה $25 ליום) | ~$5–15 | ~$20–60 |
| Resend / Supabase Free | $0 | $0 |
| **סה"כ** | **~$20–35** (+$20 טעינה ראשונה ל-Twilio) | **~$95–175** |

## 7. אישורים פתוחים של מאיר
1. הקלטת replay חיה: `cd runtime && .venv/bin/python -m sim record --all --source live --yes` (≤ $2). זה גם "המעבר החי" ש-TASKS B12 דורש.
2. הרצת הצעה חיה: `deno task quote:live fixtures/hvac_basic.json` (~$0.05) → `docs/reports/A6-live.json`.
3. רכישת מספר Twilio (בחשבון הראשי), ‏Upgrade, ‏Trust Hub ו-10DLC.
4. נוסחי מיילים ללקוח (`CLIENT_EMAILS_ENABLED`) והדמו החי (`DEMO_LIVE`, ‏`brand.demo.runtime_url`).
