# 08 · Your monthly report, line by line

target_seconds: 120
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** סיור בדוח החודשי שהלקוח מקבל במייל ב-1 לחודש (`monthly_roi` ב-`runtime/app/notify/templates.py`, קיים ונבדק ב-B6). מוסבר כל שורה: שיחות שנענו (וכמה אחרי שעות העבודה), עבודות שנקבעו, הערכת שווי (רק אם הלקוח הגדיר ערך עבודה ממוצע, ומוצג במפורש כהערכה ולא כהכנסה), הודעות, דחופים, text-backs, ושימוש מול המכסה הכלולה, עם התראה ב-80% וב-100% ובלי חיוב אוטומטי. המספרים בסרטון מומצאים ומסומנים SAMPLE. ההגדרה של ערך עבודה ממוצע קיימת היום רק כנתיב אדמין, וגם תצוגת הדוח בפורטל עוד לא קיימת (B7).

| | |
|---|---|
| Goal | The client reads the report correctly, knows the value line is an estimate, and knows nothing is billed automatically. |
| Plays in | Link in the first monthly report email (footer line, added by the email owner) · **My receptionist → Reports** `[PENDING B7]` · `monthly_invoice` email (optional link) |
| Products | `RCP`, `BNDL` |
| Formats | 1920×1080 MP4 + captions |
| CTA | "Set your average job value" |

## Recording source (exists today)
Render the real template with sample data (from `runtime/`, output to a scratch folder, not the repo):
```bash
.venv/bin/python -c "
from app.notify import templates as T
r=dict(month_label='September 2026',calls_answered=38,after_hours_calls=14,booked=9,messages=12,urgent=1,text_backs=7,
       usage={'voice_minutes':172,'sms_segments':286},included={'voice_minutes':400,'sms_segments':1000},
       est_value_usd=2250.0,avg_job_value_usd=250.0,roi_multiple=7.5)
s,t,h=T.monthly_roi('Copperleaf Air & Plumbing',r); open('$SCRATCH/monthly.html','w').write(h); print(s)"
node ../tools/cdp-shots.mjs "file://$SCRATCH/monthly.html" "$SCRATCH/monthly" 1920 1080 0
```
Add a diagonal "SAMPLE DATA" watermark in the edit on every frame that shows numbers.

## Scenes

### S1 · 0:00–0:10 · Intro
- **Visual:** inbox row with the subject "Your September 2026 report: 38 calls answered, 9 booked".
- **On-screen text:** "Arrives on the 1st of each month"

VO: On the first of each month, you get a report on the month before. Here's how to read it. The numbers in this video are made up.

### S2 · 0:10–0:40 · Activity rows (zoom row by row)
- **On-screen text:** highlight each row as it's named.

VO: Calls answered counts the calls your receptionist picked up, and how many came after hours.
VO: Jobs booked are visits it put on your calendar.
VO: Messages are callers who wanted a call back instead. Urgent shows requests it flagged right away.
VO: Missed callers texted back are people who hung up and got a text from you.

### S3 · 0:40–1:15 · Estimated value
- **Visual:** zoom on "Estimated value of booked jobs" and "Value vs. your monthly fee", then the grey note under the table.
- **On-screen text:** "An estimate, not revenue"

VO: If you tell us your average job value, the report multiplies it by the jobs booked. It also compares that to your monthly fee.
VO: It's an estimate, not revenue. Some booked jobs cancel, and some are worth more.
VO: To set your average job value, enter it in My receptionist, or send it to us as a request.

### S4 · 1:15–1:45 · Usage
- **Visual:** zoom on "Voice minutes used" and "SMS segments used"; then an email mock of the 80% alert subject "You've used 80% of this month's included voice minutes".
- **On-screen text:** "Included: {{rules.included_usage.voice_minutes}} minutes · {{rules.included_usage.sms_segments}} SMS segments" · "Alerts at 80% and 100%" · "No automatic charges"

VO: The last rows show your usage against what's included in your plan.
VO: We email and text you at eighty percent and again at one hundred. Nothing changes automatically, and nothing is added to your bill without your approval.

### S5 · 1:45–1:55 · End card `[PENDING B7]` for the portal still
- **Record:** **My receptionist → Reports** list.
- **On-screen text:** "Questions about a number? → Requests"

VO: Past reports are saved in your portal. Questions about a number? Send us a request.

## Production notes
- `{{rules.included_usage.*}}` tokens are filled from `config/pricebook.json` at caption time (`python3 videos/vo_length.py --export` shows the rendered narration).
- The "average job value" UI: B7 must add a client field (today only the admin route `PUT /reports/{slug}/settings` sets it). If B7 doesn't add it, change the S3 last line to "send it to us as a request" only.
