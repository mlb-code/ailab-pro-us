# B9: פריסת ה-runtime ל-Railway וחיבור מספר Twilio (12.10.2026)

## מה נפרס
- **פרויקט Railway:** `ailab-pro-us` (חדש, Hobby). **שירות:** `runtime` מהריפו `mlb-code/ailab-pro-us`, ענף `main`, Root Directory `/runtime`, Railpack, Python 3.12, worker אחד, אזור `us-east4` (קרוב ל-Supabase ב-us-east-1 ול-Twilio).
- **כתובת:** `https://runtime-production-7097.up.railway.app` (= `PUBLIC_BASE_URL`).
- **בנייה:** Railpack לא מתקין תלויות מ-`pyproject.toml` לבד, ולכן הוגדרו בהגדרות השירות (לא בקוד): Build `python -m venv /app/venv && /app/venv/bin/pip install --no-cache-dir .`, Start `/app/venv/bin/python -m uvicorn app.main:app ... --workers 1 --proxy-headers`, Healthcheck `/health`. אין שינוי קוד.
- **משתנים (שמות בלבד):** `RUNTIME_MODE=prod`, `PUBLIC_BASE_URL`, `STORE_BACKEND=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CRED_KEY`, `RUNTIME_ADMIN_TOKEN`, `ZAPIER_SIGNING_SECRET`, `BRAIN_MODE=live`, `VOICE_MODE=stream`, `CLAUDE_VOICE_MODEL=claude-haiku-5-5`, `GLOBAL_DAILY_BUDGET_USD=25`, `ADMIN_EMAIL`, `CLIENT_EMAILS_ENABLED=false`, `TWILIO_VOICE_USD_PER_MIN=0.0785`, `DEMO_LIVE=0`, `PORT=8080`, `PYTHON_VERSION`/`RAILPACK_PYTHON_VERSION=3.12`.
- **סודות חדשים** (`CRED_KEY`, `RUNTIME_ADMIN_TOKEN`, `ZAPIER_SIGNING_SECRET`) נוצרו ונוספו ל-`.secrets.env` (הרשאה 0600). **לא להחליף את `CRED_KEY`.**
- **Cron:** שירות שני `tick-cron` באותו פרויקט (תמונה `curlimages/curl:8.10.1`, Cron `*/10 * * * *`) שקורא `POST /jobs/tick` עם `RUNTIME_ADMIN_TOKEN` (משתני הפניה `${{runtime.*}}`). אין צורך ב-GitHub Actions.
- **Tenant דמו ב-Supabase:** `demo-hvac`, ‏"Copperleaf Air & Plumbing", ‏Houston (America/Chicago), ZIP כולל 77005, ‏`status=sandbox`, ‏`twilio_number=+18323070813`, יומן `fake`, ‏handoff=`message` (בלי העברה), התראות: מייל `laviemb@gmail.com` בלבד, SMS כבוי. נוצרה גם שורת `clients` "(DEMO)" בסטטוס `testing`.

## חיבור Twilio (המספר +1 832-307-0813, חשבון ראשי, נקרא בחזרה ואומת)
- Voice URL: `/voice/incoming` POST · Fallback: `/voice/fallback` POST · Status Callback: `/voice/status` POST · SMS: `/sms/incoming` POST.

## בדיקות עשן (בלי שיחה אמיתית)
| בדיקה | תוצאה |
|---|---|
| `GET /health` | 200, ‏`ok:true`, ‏store=supabase |
| `GET /health/deep` (Bearer) | 200, כל ה-checks ‏`true` (store, twilio, claude, cred_key, email, zapier, admin_token, admin_email, tenant_configs) |
| `/voice/incoming` בלי חתימה | 403 (אימות חתימה פעיל) |
| `/voice/incoming` עם חתימת Twilio | 200, ‏TwiML `<Connect><ConversationRelay url="wss://runtime-production-7097.up.railway.app/voice/relay?t=…">`, ברכה עם "virtual assistant, an AI" ו-"may be recorded and transcribed" |
| `/voice/fallback` חתום | 200, הודעת "Sorry, we're having trouble…" |
| `wss://…/voice/relay` בלי חתימה | 403 (נקודת הקצה חיה ודורשת חתימה) |
| ריצת `tick-cron` אוטומטית (15:21 UTC) | JSON עם `"ran"` בלוג של ה-cron |
| `POST /jobs/tick` ידני | 200, ‏`"ran"` כולל `admin_daily` (נשלח מייל סיכום יומי למאיר) |
- שורות הבדיקה (call/state) נמחקו מ-Supabase. **לא נשלח SMS ולא בוצעה שיחה יוצאת.** עלות Claude: ‏0 (בדיקת הבריאות היא `models.retrieve`, חינם).

## השיחה האמיתית הראשונה (מאיר)
1. מתקשרים מהנייד ל-**+1 832-307-0813**.
2. שומעים: "Thanks for calling Copperleaf Air & Plumbing. I'm the virtual assistant, an AI. This call may be recorded and transcribed…, How can I help?"
3. אומרים: "My AC is blowing warm air, ZIP 77005" → בוחרים חלון → שם וכתובת → "that's all". **הצלחה =** בטבלת `calls` שורה עם `outcome=booked` ו-`duration_s` > 0, ומייל "New lead" ל-laviemb@gmail.com.
4. שיחה שנייה: מנתקים מיד. **text-back לא יגיע עדיין**: SMS לארה"ב חסום עד אישור A2P 10DLC (סעיף 2.7 במדריך). כרגע מצופה רק מייל התראה. אחרי האישור: הודעת text-back אחת.
5. בדיקת fallback: Railway → `runtime` → Settings → **Remove/Stop deployment** → להתקשר → נשמעת הודעת התקלה → Redeploy.

## חזרה לאחור (rollback)
- גרסה תקולה: Railway → `ailab-pro-us` → `runtime` → Deployments → הגרסה הקודמת → **Redeploy**.
- ניתוק מלא: Twilio Console → Phone Numbers → המספר → למחוק את ה-Voice URL (או להפנות ל-`/voice/fallback`).
- עצירת Claude לכולם: `GLOBAL_DAILY_BUDGET_USD=0`. עצירת הדמו בלבד: `tenants.status='paused'`.

## פתוח / חסום
- **סודות Edge Function ב-Supabase** (`RUNTIME_URL`, `RUNTIME_ADMIN_TOKEN` בשביל `calendar-connect`): לא נקבעו (פעולה שנחסמה למתזמר). Supabase → Edge Functions → Secrets → Add: ‏`RUNTIME_URL` = הכתובת למעלה, ‏`RUNTIME_ADMIN_TOKEN` = הערך מ-`.secrets.env`. נדרש רק לחיבור יומן.
- A2P 10DLC (SMS), ‏Calendly/Google OAuth, ‏`DEMO_LIVE` ובדיקת X-Forwarded-For: לפי המדריך, אחרי אישורי מאיר.
- הערה לקוד (לא חובה): קובץ `runtime/requirements.txt` או `uv.lock` יאפשר ל-Railpack להתקין לבד ולוותר על פקודת ה-Build הידנית.
