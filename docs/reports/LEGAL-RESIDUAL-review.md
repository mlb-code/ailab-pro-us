# בדיקה עוינת: יישום הסיכונים המשפטיים השיוריים (v1.1), 12.10.2026

**פסיקה: APPROVE** (אחרי התיקונים שבוצעו בבדיקה). שני דברים נשארו לאורקסטרטור: להחיל את המיגרציה, ולהפיק מחדש את קובצי ה-PDF לעורך הדין.

## ליקויים שנמצאו

| # | ליקוי | מיקום | סטטוס |
|---|---|---|---|
| 1 | אישור הזמנה אחרי שיחה עוכב לחלון 09–20, ונזרק אם התור מוקדם. ההחלטה: זו תשובה ישירה ל"כן", ולכן נשלח מיד. | `runtime/app/sms_outbound.py:180` (`confirm_booking`), `after_turn` | תוקן: נשלח מיד עם `direct_reply=True`. בדיקת opt-out, חסימה וקו נייח עדיין חלות. |
| 2 | "פספסנו אותך" שנדחה בלילה נשלח ב-08:00. מזכר 02 (R2-3, R2-6) קובע שהודעה בתור נשלחת בחלון 09–20 (ראשון 12–20), ורק אם המתקשר לא התקשר שוב. | `sms_outbound.py:168`, `:220` | תוקן: ההודעה נכנסת לתור עם `window=scheduled` ונבדק `_called_back`. |
| 3 | המגבלה "אחת ל-24 שעות" מומשה כ"אחת ליום קלנדרי", כך שאפשר היה לשלוח ב-20:59 ושוב ב-08:01. | `sms_outbound.py:243` | תוקן: חלון מתגלגל של 24 שעות. |
| 4 | Terms §11 אמר שכל הודעה שאינה תשובה נשלחת 9–20. זה סותר את הקוד (text-back 8–21, ואישור מיד). SA §8 סעיף 5 תיאר אישורים כמעוכבים. | `site/legal/terms/index.html:82`, `site/legal/service-agreement/index.html:94` + קובצי md בחבילה | תוקן בשני הדפים ובקובצי ה-md. |
| 5 | בדיקות ותרחישים שנבנו על ההתנהגות הישנה | `tests/test_legal_v11.py`, `tests/test_sms.py`, תרחישים 32 ו-37 | עודכנו. נוספו 6 מקרי חלון, תרחיש "התקשר שוב" ותרחיש קו נייח בלילה. |
| 6 | ב-IMPL היו טענות לא מדויקות ("אישור ממתין לחלון", "46 בדיקות") | `docs/reports/LEGAL-RESIDUAL-IMPL.md` | תוקן. נוספו הערות על סדר הפריסה ועל ה-PDF. |
| 7 | קובצי `docs/kits/lawyer-package/*.pdf` עדיין בגרסה 1.0, וקובצי ה-md בגרסה 1.1 | חבילת עורך הדין | **פתוח.** אין כלי הפקה בריפו. |
| 8 | אם ה-runtime ייפרס לפני המיגרציה, `record_consent` ייכשל (גם ביטול דרך STOP כותב ליומן) | `runtime/app/store.py` `opt_out` | **פתוח, סדר פריסה:** קודם מיגרציה, אחר כך runtime. |

סטיות מינוריות מהמזכרים שהשארתי: ניסוח ה-text-back "Sorry we missed your call! What can we help with?" (המזכר הציע "How can we help?"). הוא נשמר בכוונה בגלל ההקלטות, וה-SA מצטט אותו מילה במילה. בנוסף, ההודעה על הודעות הטקסט מוזגה למשפט ה-DISCLOSURE ולא נוספה כמשפט נפרד.

## ראיות לפי סעיפי הבדיקה

1. **טקסט משפטי:**
   - נקראו שלושת הדפים במלואם.
   - הפניות נבדקו ונכונות: §17 פריטים 1, 4–6, 7 ו-10; §15A; SA §5, §8, §10, §12, §15, §16 ו-§18 מול Terms §17; Privacy §6, §7 ו-§11.
   - התקרה זהה ב-Terms §15 וב-SA §15 ("greater of … 6 months … or US$500"), וההחזרים מוחרגים ממנה.
   - §17 תואם מילה במילה את מזכר 01: AAA Commercial + Expedited, גם כשהתיק עובר ל-ICDR, מושב ניו יורק, סעיף "מי מחליט", יציאה במייל תוך 30 יום, תביעות קטנות לשני הצדדים, ויתור ייצוגי עם סעיף "אם נפסל", ומגבלת שנה. הדין: ניו יורק, ובגיבוי דין המדינה של הלקוח.
   - סעיף PHI קיים ב-Terms §8, ב-SA §12 וב-Privacy §11. "5 years" מופיע ב-Privacy §7.
   - גרסה 1.1 ו-"Last updated: October 12, 2026" מופיעים בשלושת הדפים.
   - Placeholder יחיד: `[Business Name]` (SA §8).
   - באתר אין "compliant", "guarantees compliance" או "HIPAA/TCPA compliant" (grep). "HIPAA-ready version" הוא נוסח המזכר.
2. **אתר:**
   - `build_landing --check`: 0 differ. `check_hardcoded`: 0.
   - `/dental/` מסומן noindex ומציג רשימת המתנה בלבד. ה-FAQ מתוקן לפי מזכר 03, ואין בו "legal review".
   - בשאלון, בחירת Dental מציגה הודעת רשימת המתנה. השרת מסרב: `quote_engine.ts:162` מחזיר `dental_waitlist_only`, ובדיקת Deno `engine_test.ts:98` עוברת.
   - תיבת האישור בדף ההצעה מזכירה בוררות, ויתור ייצוגי ויציאה תוך 30 יום. `e2e_quote` עובר עם `agreement_version` מתוך brand (1.1).
3. **Runtime:**
   - (a) משפט ה-DISCLOSURE זהה למילה. פתיח עם "recorded" בלבד, "transcribed" בלבד או "text you" בלבד → `has_disclosure=False`, והמשפט המלא מצורף.
   - (b) במצב gather: `twiml_gather(barge_in=False)` משמיע `<Say>` לפני `<Gather>`. במצב stream: `welcome_greeting_interruptible="none"` ודיבור בזמן הפתיח מוחזק עד סופו (`voice_stream.py`).
   - (c) שאלת ההסכמה נשאלת אחרי ההזמנה. "No" → ההזמנה נשמרת, לא נשלחות הודעות, ופרטי התור נאמרים בקול. נרשמת שורה ב-`sms_consent` עם ההחלטה והמילים.
   - (d) בהתנגדות להקלטה, `_withhold_transcript` מנקה את `transcript` ואת `messages` (רק הפתיח והסמן נשארים). `_persist` כותב את התמליל המנוקה ואת `transcript_withheld`, ושואל לחזור למספר.
   - (e) נבדקו ב-`sms_keyword`: "please stop texting me", "opt out", "REVOKE", "remove me", "unsubscribe" → stop. START ו-HELP עובדים. "don't text me" בשיחה → opt_out לפי המספר.
   - (f) 6 מקרי חלון בבדיקה `test_window_cases_business_new_york`:
     - לוס אנג'לס 19:30 ניו יורק → מותר.
     - הוואי 09:30 ניו יורק → נדחה ל-15:00 ניו יורק.
     - ראשון 11:00 → נדחה ל-12:00.
     - קידומת לא ידועה → אזור הזמן של העסק.
     - שיחה שהוחמצה ב-23:00 → נשלח ב-09:00.
     - אישור הזמנה בלילה → נשלח מיד.
   - (g) קו נייח: לא נשלח text-back, אישור או תזכורת (`test_confirmation_is_not_sent_to_a_landline_even_at_night`).
   - (h) התבניות נעולות בקוד. ב-config, בפורטל או באדמין אין שדה תבנית, ושם העסק ושורת STOP תמיד מופיעים.
   - (i) `check_hardcoded`: 0.
4. **Supabase:**
   - טבלה `sms_consent` עם RLS (אדמין קורא, רק service_role כותב), שני אינדקסים, ובלי FK ל-tenant. היא שורדת מחיקה או אנונימיזציה של הלקוח.
   - ב-`run_retention` נוספה רק מחיקה אחרי 5 שנים (diff מול 20261011100200).
   - RLS offline: 167 בדיקות, כולל מוטציה "consent log deleted with tenant" שנתפסה.
   - **המיגרציה לא הוחלה.** ניסיון קריאה בלבד ל-DB החי נחסם בהרשאות, ולכן לא אומת ישירות. להחלה: `python3 tools/us_setup.py --only migrate` (בדיקה מקדימה: `--dry-run` מציג אותה אחרונה).
5. **מסמכים:**
   - נבדקו בחבילת עורך הדין ב-md: התקרה, §17 (פריטים 4 ו-9), SA §18, PHI ו-5 שנים, תואמים ל-HTML.
   - `LEGAL-RESIDUAL-IMPL.md` בעברית, 104 שורות, ותוקן לפי הקוד.
6. **בדיקות:** ראו הטבלה.

## תוצאות בדיקות (אחרי התיקונים)

| חבילה | תוצאה |
|---|---|
| runtime pytest | 626 passed |
| test_legal_v11.py | 48 passed |
| סימולטור replay (stream / gather) | 49/49, 49/49 |
| sim selftest | 11/11 |
| make qa-fast | עבר (exit 0) |
| make qa-deno | 67 passed |
| make qa-sql (RLS offline / quote engine / email events) | 167 / 9 / 59 |
| make qa-phase-a | 157 passed + e2e_quote 19 |
| make qa-browser (כולל דפי legal) | 240/240 |
| build_landing --check / check_hardcoded | 0 differ / 0 |

לא הורצו מחדש: qa-start, qa-admin ו-qa-portal-b7. שינויי הבדיקה לא נגעו בקוד של השאלון, האדמין או הפורטל.
