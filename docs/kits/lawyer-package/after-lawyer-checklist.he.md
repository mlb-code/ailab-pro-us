# צ'ק-ליסט אחרי שעורך הדין מחזיר את המסמכים

מסמך עבודה לסוכן או למי שמיישם את השינויים. מאיר רק מאשר בסוף. כל הנתיבים יחסיים לתיקיית `ailab-pro-us/`.

## איך בנויים דפי המשפט
- שלושת הדפים כתובים ב-HTML ידני ב-`site/legal/terms/index.html`, `site/legal/privacy/index.html` ו-`site/legal/service-agreement/index.html`. שינויי נוסח של עורך הדין נכנסים לשם ישירות.
- יש שני סוגים של ערכים שאסור להקליד ידנית:
  - **`<span data-cfg="pricebook:…">` / `"brand:…"`**: חלונות ההחזר, נוסח האחריות, ה-SLA וימי העסקים. `tools/build_landing.py` מטביע אותם מהקונפיג, ו-`--check` נכשל אם יש סטייה.
  - **`<span data-brand="…">`**: שם הישות, צורת ההתאגדות, הכתובת, המייל והדין החל. `site/legal/legal.js` ממלא אותם בדפדפן מתוך `site/assets/brand.json`.
- `site/legal/legal.js` גם מסתיר את באנר ה-DRAFT כש-`legal_final` הוא `true`.

## שלבים
1. **שינויי נוסח רגילים:** עורכים את קובצי ה-HTML שלמעלה, סעיף מול סעיף לפי קובצי ה-`.md` המסומנים. לא נוגעים בתוכן שבתוך `data-cfg`.
2. **שינוי בהחזרים או באחריות:** לא נוגעים ב-HTML.
   - עורכים את `config/pricebook.json` → `refund_rules` (`deposit.text`, `deposit.window_days`, `retainer.*`, `rcp_guarantee_days`, `rcp_guarantee.text`, `.legal`, `.label`, `.codes`).
   - מעדכנים את כלל 7 ב-`docs/PRICEBOOK.md`.
   - אם המספרים השתנו, מעדכנים את הבדיקות ב-`tools/pricebook_test.py`.
   - אותם ערכים מזינים גם את דפי הנחיתה, דף ההצעה, מייל ההצעה ומייל `went_live`.
3. **ימי עסקים או SLA:** `config/brand.json` → `business_days_text`, `quote_sla_text`.
4. **דין חל:** `config/brand.json` → `legal_entity.governing_law` (למשל `"the State of New York"`). ספק הבוררות כתוב בטקסט קבוע ב-Terms §17 וב-SA §18 (`[ARBITRATION PROVIDER…]`). מחליפים אותו ב-HTML, ומוחקים את הערות `[ATTORNEY: …]`.
5. **שם, כתובת ומייל:** `config/brand.json` → `legal_entity.name`, `legal_entity.form`, `physical_address`, `support_email`. הם כבר מולאו, וצריך רק לוודא שעורך הדין אישר.
6. **גרסה ותאריך תוקף:**
   - `config/brand.json` → `agreement_version`: `"1.0-draft"` → `"1.0"`. דף ההצעה שומר את הערך הזה בכל אישור לקוח (`quote-accept`).
   - (תוקן) התכונה היא עכשיו `data-brand="agreement_version"`, והגרסה מתעדכנת מהקונפיג. נשאר להחליף ידנית את ברירת המחדל `1.0-draft` שמופיעה ב-`site/legal` (כולל ה-`<meta description>`).
   - מחליפים את `[EFFECTIVE DATE]` ואת "Last updated" בשלושת הדפים.
7. **החלטות שמוסיפות טקסט חדש** (לפי `decisions-for-meir.he.md`):
   - סעיף case study ומחיר מייסדים: טיוטה כבר נמצאת ב-SA §11. מעדכנים לפי עורך הדין, ושוקלים תיבת הסכמה בדף ההצעה.
   - חיוב החריגה ב-SA §4 (תוקן): אין חיוב אוטומטי, התראה ב-80% וב-100%, ותוספת רק באישור.
   - חריג small-claims (תוקן): נמצא עכשיו גם ב-SA §18.
   - DPA, אם עורך הדין דורש: עמוד חדש תחת `site/legal/`, שמתווסף ל-`LEGAL_PAGES` ב-`tools/build_landing.py`.
8. **דנטל:** אם התשובה היא "לא", משנים ב-`config/brand.json` → `niches[key=dental].status`, ומעדכנים את `site/_content/dental.json`.
9. **הכרזה על המסמכים כסופיים:** `config/brand.json` → `"legal_final": true`. בלי השלב הזה הבאנר נשאר.
10. **סנכרון ובנייה:**
    ```
    python3 tools/sync_config.py
    python3 tools/build_landing.py
    make qa-fast
    ```
    הצלחה: `qa-fast` עובר בלי שגיאות, ו-`build_landing --check` מדווח "0 differ".
11. **בדיקה בדפדפן:** `make qa-browser` (overflow בדפי legal). פותחים את שלושת הדפים ומוודאים שהבאנר נעלם והגרסה מוצגת כ-1.0.
12. **קריאות דפי המשפט (תוקן):** `legal.css` קובע עכשיו צבעי טקסט, כותרות וקישורים מפורשים, בניגודיות AA במצב בהיר ובמצב כהה. קובצי ה-PDF הופקו מחדש מהדפים עצמם.
13. **עדכון מסמכים נלווים:** סעיף 4 ב-`docs/kits/lawyer-brief.md` מסמנים כהושלם. ב-`docs/kits/upwork.md` מעדכנים את ה-placeholders של ההחזרים, אם הנוסח השתנה. רושמים ב-`docs/reports/` דוח קצר: מה שונה, ואיזו גרסה נכנסה לתוקף.
