# אחריות שביעות רצון 30 יום (RCP/BNDL) — 11.10.2026

**מה הוחלט:** לקוח RCP או BNDL שלא מרוצה תוך 30 יום מה-go-live מקבל את דמי ההקמה בחזרה, והקו מכובה. החודשי על התקופה שנוצלה לא מוחזר. ל-WEB נשאר רק כלל המקדמה של 7 ימים. ה-SLA של ההצעה הוא `quote_sla_text`, וימי העסקים הם א'–ה' לפי שעון ישראל. מחיר המייסדים מוצג כ-"Founding-client price".

- **קונפיג:** ב-`pricebook.json` נוספו `refund_rules.rcp_guarantee_days: 30` ו-`rcp_guarantee` עם השדות `codes`, `label`, `text`, `legal` ועוד. נוספו גם `deposit.label` ו-`FOUNDING.label`. ב-`brand.json` נוסף `business_days_text`. הסכמה עודכנה, והקונפיג סונכרן.
- **PRICEBOOK.md:** לכלל 7 נוספו האחריות וימי העסקים. נוסף כלל 8 לתווית המייסדים. ב-`pricebook_test` נוספו 11 בדיקות: ימים, קודים, WEB מוחרג, ומספר הימים בכל טקסט שווה לקונפיג.
- **דפי נחיתה:** ב-`build_landing.py` נוספו הטוקנים `{guarantee*}`, `{refund_label}`, `{business_days}` ו-`{founding_label}`. בלוק האמון, ה-FAQ ("Can I cancel? What if I'm not happy?" ו-"no_call" עם א'–ה') וה-fine print בכרטיס המחיר מציגים את האחריות בדף הבית, בנדל"ן ובדנטל. דף ה-website לא השתנה.
- **משפטי:** סעיף 7 בתנאי השימוש וסעיף 5 בהסכם השירות נכתבו מחדש. כל מספר וטקסט בהם הוא `<span data-cfg="pricebook:…">` ש-`build_landing.py` מעדכן מהקונפיג, ו-`--check` נכשל אם יש סטייה. נוסף גם משפט על ה-SLA וימי העסקים. `check_hardcoded` מדלג על spans כאלה (נוספה לו בדיקה עצמית).
- **הצעה ומיילים:** `quote_view.mjs` מחזיר `refund.guarantee` רק ל-RCP/BNDL. דף ההצעה ומייל ההצעה מציגים את האחריות. במייל `went_live` (A8) מופיעה האחריות עם תאריך הסיום. תווית ההנחה בהצעה היא עכשיו "Founding-client price (30% off setup)". באדמין (הגדרות) נוספה שורת אחריות. ה-fixtures ותצוגות המייל נוצרו מחדש.
- **מסמכים:** שאלה 17 ב-lawyer-brief כוללת את הנוסח וארבע שאלות לעו"ד (האם "not satisfied" בלי מבחן אובייקטיבי, היקף ההחזר ב-bundle, חשיפה בגלל המילה guarantee, ימי עסקים). ב-SPEC עודכנו §3 (סעיף 5) ו-§7. ב-Upwork kit נוספו placeholders `{{refund_rules.rcp_guarantee.text}}` ו-`{{brand.quote_sla_text}}`, וכלל 6 עודכן.
- **לא נדרש שינוי:** הסרטונים ו-`runtime/` (אין בהם אזכור החזרים).
- **תיקון בדיקה:** ב-`e2e_start` הבדיקה הניחה שהדגל כבוי. עכשיו היא בודקת לפי `show_founder_price` בפועל, עם התווית מהמחירון.

**בדיקות:** `qa-fast` עבר (pricebook 0 כשלים, build_landing 11/11, check_hardcoded 0). `deno test`: ‏66/66. `e2e_phase_a`: ‏157/157. overflow על הדפים ששונו: 120/120. `make qa` המלא (סדרתי) עבר: overflow 240/240, דמו 321 נתיבים ×3 דפדפנים, start 133/0, admin 81/0, B7 114/0 + SQL 86, phase-A 157/0, e2e_quote 19/0, RLS 159, מיילים 59. בהרצה הראשונה של `make qa` נכשלה בדיקה אחת (דגל המייסדים); אחרי התיקון כל ההרצה עברה.

**פתוח למאיר ולעו"ד:** מה כלול בהחזר ב-bundle (כל דמי ההקמה או רק החלק של ה-RCP), ואיך מבצעים החזר דרך Upwork (במיילסטונים).
