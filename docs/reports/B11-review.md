# B11 — ביקורת (11.10.2026)

**CHANGES** (קטנים; העבודה טובה, הבדיקות ירוקות והמבנה תקין)

1. `videos/vo_length.py:85-90,137` — באג ב-`--export`: שורות `VO[cut]` נאספות בנפרד ומודבקות **בסוף**. ב-02 (בכל הגרסאות לפי ספק) קטע הספק יוצא אחרי S5–S6, וב-09 `bndl` הוא יוצא אחרי כרטיס הסיום. הקריינות והכתוביות נבנות מה-export, ולכן צריך לשמור את סדר השורות כפי שהוא בקובץ.
2. `10-landing-explainer/script.md:45,47` — "fixed price in writing" לא תואם לדף הנחיתה ("Fixed quote in writing within 24 hours"). צריך: "a fixed quote in writing `{{brand.quote_sla_text}}`". שורה 28: לומר "AI receptionist" לפחות פעם אחת. שורה 38: לשנות את הבועה לנוסח שבקוד, "If anyone is in danger, please hang up and call 911 now." (`guard.py:35`).
3. `04-hours-faq-alerts/script.md:52` — בחירום חסר החלק "ממשיכים": קודם משפט 911 ("if anyone is in danger"), ואז השיחה ממשיכה לאסוף פרטים (`conversation.py:310`). שורה 57, "change all of this later": מצב after-hours ומספר הכוננות **לא** ברשימה הלבנה (`us_schema.sql:767`, רק hours/faq/notify/paused). צריך: "your hours, FAQ and alert contacts".
4. `02-call-forwarding/script.md:81-82` — סדר הבדיקה הפוך ממה שנבנה ב-B7: קודם לוחצים Test call ורק אז מתקשרים, עם חלון של 30 דקות (`mock-backend.js` forwardingCheck/startForwardingTest). חוץ מזה, ניתוק בלי לדבר נרשם כ-`abandoned`, ואז הטלפון של הבודק מקבל text-back (`voice.py:13,255`). צריך לבקש ממנו לומר "this is a test", או להזהיר שתגיע הודעה.
5. שעות שקטות לא מוזכרות באף תסריט. להוסיף שורה אחת ל-07 S2 או ל-05 S3: אישור ההזמנה נשלח מיד אחרי השיחה, גם בלילה. התזכורת (יום לפני) לא נשלחת בין 9 PM ל-8 AM. אפשר להוסיף גם ש-HELP עונה עם פרטי העסק.
6. סטייה של B7 (לא אשמת B11, אבל חוסמת הפקה). לפי `us_portal_b7.sql:49-57`, ב-B7 שבעבודה יש 8 סעיפים ל-RCP ובהם `emergency` נפרד, היומן הוא סעיף 5, אין סעיף Zapier/`tools`, המפתחות הם `forward_calls`/`go_live`, והכותרות אחרות. מספרים קשיחים ב-VO: "seven short items" (`01:37`), "step seven" (`02:47`), "item 4" (`90:23`), גבות התמונות הממוזערות, והמפתחות ב-`README.md:26`. צריך לסמן אותם `[PENDING B7]` או להוציא את המספר מהקריינות. המתזמר צריך ליישב את B7 מול SPEC §6.8: חסר סעיף 6, ו-`go_live` (sort 9) בא אחרי `forward_calls` (7), בניגוד לדף הנחיתה.

**מה נבדק ועבר:**
- `vo_length.py`: ‏11/20 עברו, 58–110 שניות. ‏`check_hardcoded`: ‏0/0. ‏`check_secrets`: ‏0 (גם על כל הריפו).
- אנגלית אמריקאית, משפטים קצרים, בלי הבטחות ובלי מחירים (רק טוקנים). המונחים text-back, AI line, setup checklist, test number ו-go-live תואמים לדפים.
- הערת Calendly בתשלום קיימת ב-03.
- 80/100% דרך מייל ו-SMS, בלי חיוב אוטומטי, תואם ל-`usage.py`/`templates.py:170-178`.
- מלל ההשהיה (Pause), כותרות ההתראות והדוח החודשי תואמים לקוד. "Reply STOP" מופיע בכל הודעה (`sms_outbound.py:41-51`).
- הסלקטורים והכתובות הקיימים אומתו: `#email #sendBtn #mockCode #code #p_* #pSave`, ‏`mock_seed`, ‏`ol.stepper li.is-current`, ‏`.status__text`, ‏`#tab-home/quotes/billing`, ‏`#demo`, ‏`.demo__pick[data-scenario="ac"]`, ‏`#how`, ‏`#after-you-pay`, ‏`#how-it-answers`, ‏`/quote/` (`#acceptForm`, `#pay-slot`), ‏`/demo-site/home-services/`.
- כל המסכים שלא נבנו מסומנים. קודי הספקים מסומנים "verify". מגבלת Google Voice נאמרת בכנות.
- README (עברית) שלם: מפת הטמעה, אורכים, צינור הפקה (הקלטה → סטוריבורד → קול → כתוביות → MP4 ואנכי), עלות וזמן, וכל הפריטים הפתוחים (`capture.mjs`, התחברות מחדש ל-ElevenLabs, אישור מאיר).
- B11.md כן ומדויק (הסטייה מ-`videos/scripts/` מתועדת). רק באג ה-export לא דווח.

**לא להפיק לפני ש-B7 מוכן:** 02, 03, 04, 05, 06, 07, 90 (וגם B9 ואישור גוגל), ו-01 S3–S4. **אפשר להפיק כבר עכשיו:** 10 (אחרי תיקון 2), 08 ו-09 (בלי S5).
