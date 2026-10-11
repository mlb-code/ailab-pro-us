# A5 · ביקורת חוזרת — APPROVE
- **כל 6 הסעיפים מהסבב הקודם תוקנו**, ובדקתי כל אחד ב-CDP ב-390 (serve על 8951, נסגר). השוויתי בין הקונפיג הרגיל לבין brand.json ו-pricebook.json ששיניתי רק בזמן ההגשה (`deposit_pct=40`, `quote_sla_text`, `clarity_id`). הריפו לא שונה.
- **נדל"ן:** FUB ו-kvCORE מופיעים רק בשאלת ה-CRM (`re_crm`). ברשימת `tools` אין כפילות.
- **`quote_sla_text`:** משתנה בכניסה, ב-Home, במסך הסיום ובנושא המייל `q_received`. "payment link within 1 business day" הוא SLA אחר, לפי §2.4.
- **אחוז המקדמה:** כשהשתנה ל-40, גם מסך הסיום וגם Billing הציגו 40% ($1,400).
- **Live:** ל-RCP מוצג "Calls you miss…", ל-WEB מוצג "Your website is online".
- **Clarity:** נטען רק כשיש מזהה (0 סקריפטים כשהשדה ריק).
- **hashchange:** מצייר את השלב הנכון. 0 שגיאות קונסול, overflow 0.
- **בדיקות:** `make qa-start`: E2E 116/0, overflow 516/0. `check_hardcoded site`: 0, no drift, pricebook 0. `make qa` נכשל רק על 'Israel' ב-`runtime/app/{reports.py,notify/core.py}` (מסלול R, לא A5). לכן qa-browser לא רץ בתוך `make qa`.
