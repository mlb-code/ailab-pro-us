# A9 — ביקורת חוזרת (11.10.2026)

**APPROVE** — ששת הסעיפים תוקנו. בדקתי כל אחד מהם בקבצים עצמם.
1. החזרים: הנוסח זהה ב-PRICEBOOK כלל 7, ב-Terms §7, ב-SA §5 וב-lawyer-brief 17. מקדמה מוחזרת במלואה תוך 7 ימים, כל עוד צ'קליסט הגישות לא הושלם. בריטיינר מוחזרים 75% מהתשלום הראשון. התנאי "הודעה בכתב" הוסר.
2. שמירה: בטבלה ב-Privacy §7 ובסעיף SA §12 הערכים אחידים, ותואמים ל-SPEC §4/§8. תמלילים 90 יום, לוגים 30 יום, הזמנות שנתיים, חשבון נמחק 30 יום אחרי הסיום. הסתירה הפנימית נעלמה.
3. Samsung/Haier: הנוסח עכשיו "I work with … (through their Israeli distributor)". הוא מסומן "wording pending owner approval" ומופיע גם ב-lawyer-brief 21.
4. בפרופיל מופיע "SMS Automation (Twilio)". 5. השדות `legal_entity.form` ו-`legal_entity.governing_law` מחוברים דרך `data-brand`, עם placeholder כברירת מחדל. 6. אין יותר "days notice" או "fill a".
בדיקות: `check_hardcoded` ‏(docs/kits, ‏site/legal, ‏PRICEBOOK) → 0 שגיאות, 4 אזהרות על סכומי שכבות חוקיים. `overflow.mjs` → 36/36 PASS.
לפני שימוש: מאיר מאשר את מדיניות ההחזר ואת ניסוח Samsung/Haier. ב-`config/pricebook.json` עוד חסר ההחזר של 75% בריטיינר, וזה באחריות A3.
