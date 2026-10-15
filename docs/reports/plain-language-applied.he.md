# שפה פשוטה: מה יושם (15.10.2026)

יושמו כל 60 השורות מ-`plain-language-audit.he.md`, ההגדרות מהמילון וכללי הטון, וגם 4 ההחלטות של מאיר. לא היה commit ולא push.

## מה השתנה, לפי דף
- **מחירון (`config/pricebook.json`, ומשם הכרטיסים, דף ההצעה וההסכם)**: נוסחו מחדש "מה כלול" ו"לא כלול" של RCP, WEB ו-BNDL. נוסחו מחדש גם השמות של ADD-LOC, ADD-CRM, ADD-CHAT ו-ADD-USAGE (עודכנו גם ב-`docs/PRICEBOOK.md`), טקסט הערבות וטקסט החזר המקדמה. המחירים, הימים והאחוזים לא השתנו. הרצתי `sync_config`.
- **קודי תוספות** (למשל "(add-on ADD-ES)"): נשארו בקונפיג, כי `quote_view.mjs` משתמש בהם כדי להסתיר החרגה של תוספת שכבר נקנתה. בתצוגה הם מוחלפים ב-"(extra, fixed price)", גם בדף הנחיתה וגם בהצעה.
- **בית ושירותים לבית**: שלבי "שיחה שפוספסה", פתיח הדמו, הערת המחיר, שאלה על Jobber, תג המחיר הוא עכשיו "Fixed price" (בלי RCP), "Add-ons" הפך ל-"Extras", ושורת "Hear it live" נוסחה מחדש.
- **נדל"ן**: הפתיח, תיאור ה-SEO, שלבים 1 ו-3, הרשימה "מה כלול", שאלת Follow Up Boss והערת המחיר.
- **אתר**: הפתיח, השלבים, החבילה ושאלות ה-SEO והעלות. **החלטה 1**: בכל מקום כתוב "First draft in 3 business days, live in {days:WEB} business days" (בדף, בשאלון, בפורטל וב-Upwork). את ה-7 קורא הקוד מהקונפיג (`webTimeline()` ב-`common.js`).
- **תוכן משותף**: איך זה עובד, אמון ושאלות נפוצות. **החלטה 2**: בשאלה builtin_ai כתוב עכשיו "Works with Google Calendar, Calendly and most apps through Zapier. Some systems (for example Outlook or ServiceTitan) need a custom quote." **החלטה 3**: מדפי השיווק נמחק "Business days are Sunday–Thursday". נשאר רק "within 1 business day". המפתחות ב-brand נשארו כמו שהם, ולכן לא היה צורך במפתח חדש.
- **החלטה 4**: "setup checklist" מופיע בכל מקום: באתר, בהחזר, בפרומפט ההצעה (`quote_prompt.ts`) ובמייל של WEB ("content checklist" הוחלף).
- **שאלון ופורטל**: re_crm (בניסוח של החלטה 2), הודעת הקוד, "Going live", תיאור Zapier, הודעת השימוש, "Your receptionist's number", והגדרה של go-live ליד הכפתור.
- **דף הצעה**: משפט ה-fingerprint (שורה 60). **מיילים**: הוסבר ש-portal הוא "your online account with us" והוגדר go-live. תוקנה סתירה: במייל היה כתוב "Approve go-live", אבל בכפתור בפורטל כתוב "Request go-live".
- **Upwork**: ‏AI line, webhook, native integration, SSL, schema, uptime, carrier registration ו-case study. **פוסטים**: 13 פוסטים תוקנו, ובכללם "any calendar or CRM". רונדרו מחדש הכרטיסים של slot 18 ו-22.

## מה לא שיניתי בכוונה
- **הדפים המשפטיים**, `rcp_guarantee.legal` ו-`deposit.condition`. ב-Terms ובהסכם עדיין כתוב "access checklist". צריך ליישר את זה בסבב משפטי. `pricebook_test` מוודא ש-"access checklist" עדיין מופיע בתנאי.
- **הערבות** עדיין כוללת את המילה "go-live", כי הבדיקה דורשת אותה. הוספתי לה הגדרה בסוגריים. כתבתי "AI assistant" ולא "receptionist", כי יש בדיקה שדף הנדל"ן אף פעם לא אומר "receptionist". מאותה סיבה הקישור בפוטר הוא "AI phone answering: home services".
- **"billed monthly in advance"** ו-"Reply STOP": לפי הביקורת, צריך אישור נפרד.
- **הקלטות Claude ב-`fixtures/replays`**: בתשובות המוקלטות עדיין כתוב "access checklist". זה תיעוד של מה שהמודל החזיר, ולכן לא ערכתי אותו.
- **המספר 3 (ימים לטיוטה)**: אין לו מפתח בקונפיג, והוא כתוב ידנית כמו קודם.
- **"Zapier webhook URL" בפורטל**: הלקוח צריך להדביק בדיוק את המונח הזה, ולכן השארתי אותו.

## תוצאות בדיקות
- `make qa-fast`: עבר. ‏check_hardcoded: 0. ‏pricebook_test: 0. גם `build_landing --check` ו-`proposals_check` עברו (את b-full קיצרתי ל-180 מילים לכל היותר).
- `make qa-start`: ‏131/0, ו-528 בדיקות overflow. `make qa-phase-a`: ‏155/0, ו-e2e_quote: ‏19/0. `make qa-portal-b7`: ‏114/0, ו-108 בדיקות overflow. SQL: ‏86 בדיקות.
- `make qa-deno`: ‏67/0. `make qa-browser`: ‏228/228. overflow ברוחב 360 ו-390: ‏114/114. `make qa-demo`: ‏257 מסלולים בכל אחד מ-3 המנועים. `make social-check`: 0 שגיאות.
- עדכנתי 4 בדיקות שבודקות טקסט: `e2e_start` (2), `e2e_portal_b7` (1) ו-`engine_test` (חוזקה: אין קודים בהחרגות).
- צילומי מסך של ההירו, המחירון ושאלות נפוצות בדסקטופ וב-390: אין גלישה ואין שבירה.
