# הרצות חיות מול Claude (11.10.2026), באישור מאיר, תקרה $3
**עלות כוללת: כ-$0.67.** הקלטה 1: ‏$0.23 (נעצרה ב-31, כי ‏`flows.py` קרס על "call already ended"). הקלטה 2 מלאה: ‏$0.40. הצעה חיה: ‏$0.045. החישוב לפי טוקנים × ‏$4/$20 למיליון, כי `sim record` לא מדפיס עלות.
- תקרות בקוד: tenant ‏$3 ליום, גלובלי ‏$25 ליום (`GLOBAL_DAILY_BUDGET_USD`), דמו ‏$3 ליום (`webchat.py`). המפתח נקרא רק במצב live/record: קודם מ-env (שם הוא לא היה מוגדר, והרצתי עם `env -u`), ואחר כך מ-`.secrets.env`. מפתח לא נכתב לשום קובץ (`check_secrets`: ‏0).
## מה היה שונה בין ה-mock ל-Claude האמיתי
- **ניסוח:** "Which one works better" במקום "Which works better", ‏"Monday October 12", ‏"someone will reach out", ‏"I've let the team know". הניסוח תקין, הבדיקות היו מחמירות מדי.
- **סדר כלים:** מחוץ לאזור השירות Claude לא קורא ל-`get_availability`, כי רשימת ה-ZIP כבר מופיעה בפרומפט. גם במצב "הודעה בלבד" אחרי שעות הוא לא קורא לו. זה תקין.
- **סיום שיחה:** אחרי הזמנה Claude מאשר וקורא מיד ל-`end_conversation` (כמו שכתוב בפרומפט), ולא מחכה ל-"Thanks". ב-SMS הוא לפעמים לא קורא ל-end בכלל, וזה לא מזיק.
- **בדיחה על אש:** Claude הוסיף "If there's ever a real fire, please call 911". זה לא מסלול חירום (לא נוצר `urgent`), ולכן הבדיקה צריכה לחפש את נוסח החירום של ה-guard ולא כל "911".
- **התנהגות שגויה אחת, תוקנה בפרומפט:** מחוץ לאזור ואחרי שעות Claude שאל "Would you like me to?" או ביקש שם **לפני** `take_message`. אם הלקוח לא עונה, הליד אובד.
- לא נמצאו הנחה, הבטחת הגעה, "אני אדם" או דילוג על 911 בתשובות החיות (נבדק בסריקה של כל ה-replays).
## מה שיניתי
- `runtime/app/brain.py` (שורה אחת בפרומפט): ‏"call take_message right away… (name is optional; do not ask permission…)". אחרי השינוי הקלטתי מחדש את כל התרחישים פעם אחת.
- `sim/scenarios.py` ו-`sim/flows.py`:
  - תרחישים עם `script:` (מודל שמתנהג רע בכוונה כדי לבדוק את ה-guard: ‏16, 20, 28–30) מוקלטים תמיד מה-mock. ב-Claude אמיתי ה-guard לא נבדק בהם.
  - נוספו שלוש ציפיות חדשות: `reply_matches` (regex), ‏`tools_any`, ו-`if_open` לשורת מתקשר אופציונלית.
  - שלב שמגיע אחרי שהשיחה כבר הסתיימה נרשם עכשיו ככישלון, ולא מפיל את כל ההקלטה.
- YAML (ציפיות בלבד, תורות הלקוח לא שונו): 01, 04, 11, 13, 26, 31, 32, 33, 38, 42.
- הצעת מחיר: `hvac_basic` חי = ‏draft, ‏RCP×1, ‏setup 350000, ‏monthly 30000, ‏deposit 175000. זהה ל-`expected.json`, רק קודים, בלי מחירים בטקסט, `manual_reasons` ריק. הפלט נשמר ב-`fixtures/replays/hvac_basic.json` וב-`docs/reports/A6-live.json`.
## תוצאות (replay של ההקלטות החיות)
- ‏`sim run --all`: **44/44 replay**, ‏**44/44 mock**. ‏pytest: **526/526**. שער guard: ‏218 עברו, **100% ענפים**. ‏selftest: ‏11/11. ‏deno test: ‏**66/66**.
- זמן Claude בהקלטה: ‏p95 של כ-6 שניות לתור קול. זה כולל סבב כלים ו-effort ‏low. ב-B9 צריך למדוד מקצה לקצה, והיעד של פחות משנייה לא יושג בלי שינוי.
- גיבוי ה-replays של ה-mock: בתיקיית scratchpad של הסשן. לא בוצע commit.
