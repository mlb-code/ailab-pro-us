# ביקורת A0 + A3 — 11.10.2026

**פסק דין: APPROVE** (אין חוסמים; 3 הערות קלות למטה)

**מה הורץ בפועל**
- `make qa PORT=8938` → עבר מקצה לקצה: secrets 0 ממצאים (134 קבצים), check_hardcoded 0 שגיאות, sync --check בלי סטייה, pricebook_test 0 כשלים, overflow self-test + styleguide ‏12/12.
- בהרצה הראשונה שלי `check_hardcoded.py` מצא 5 שגיאות ב-runtime/ (‏"AI Lab Pro" ב-`__init__.py:1`, `main.py:45`, `sim/__main__.py:134`; ‏"claude-opus-5-5" ב-`settings.py:25`, `llm.py:31`). כמה דקות אחר כך, ב-`make qa`, הן כבר לא הופיעו (מסלול R תיקן אותן בינתיים).
- overflow על `/_styleguide/` בשרת של הריפו (פורט 8937) → ‏12/12 PASS‏ (375/390/414/1280 × chromium/webkit/firefox). fixtures: ‏ok עבר, wide ו-console-error נכשלו עם exit 1. השרת נסגר.
- cdp-shots במובייל 390 → 0 שגיאות קונסול, scrollWidth=390. cdp-eval: ‏`dir=ltr`, הגופנים Noto Sans/Noto Serif/Space Mono נטענו מ-Google Fonts בלבד, רקע `rgb(15,26,38)`. cdp-eval-m: ‏sw=390, והמחירים בדף נטענים מה-JSON.
- check_hardcoded על קבצים שהשתלתי בתיקייה זמנית מחוץ לריפו → תפס את ‏"AI Lab Pro", ‏support@, שם המודל, ‏$3,500/$300/$4,900/$1,900 (‏7 שגיאות, exit 1). הקבצים נמחקו.
- sync_config --check על עותק זמני → תפס סטייה ב-runtime/app/pricebook.json ומחיר מסוג string (INVALID). העותק נמחק.

**בדיקת הסעיפים**
1. נישות: ‏`home_services`, ‏`real_estate`, ‏`dental` ב-brand.json, ‏בסכמה (enum), ‏בבדיקה וב-enum של A1. מקף מופיע רק בנתיבי URL. אין law/Clio/legal-practice ב-config/ וב-site/assets/. ‏"attorney review" מופיע רק בהקשר של ביקורת משפטית.
2. המחירון: 22 קודים, ולכל קוד ההקמה והחודשי זהים ל-MD. ‏ADD-RUSH מוגדר `percent` ‏25% מסכום ההקמה לפני הדחוף. פריטי custom (ServiceTitan, ‏EHR, יותר מ-3 מיקומים, מעל 3,000 דקות, ‏HIPAA BAA) קיימים. ‏refund_rules תואם לכלל 7 (‏100% תוך 7 ימים מהתשלום כל עוד הצ'ק-ליסט לא הושלם; ריטיינר 75% מהתשלום הראשון). ‏FOUNDING: ‏30% מההקמה בלבד, ל-3 לקוחות, ע"י אדמין. החיסכון בחבילה $500/$29 מאומת. לא נמצא אי-התאמה מספרית.
3. ‏brand.json: ערכים ציבוריים ו-placeholders בלבד, אין סודות. יש brand, ‏domain, ‏senders, ‏analytics ו-`claude.model=claude-opus-5-5`. הטוקנים: navy ‏#0F1A26, ‏amber ‏#E8A64A, טקסט cream ‏#EFE7D8. ניגודיות שחישבתי בעצמי: הנמוכה ביותר 4.74 (fg-3 בקטע הענבר) ו-4.77 (fg-3 על navy-3). הכל ≥4.5, כפי שנטען בדוח. אין גופן עברי. ‏`overflow-x:clip` קיים, ואין `left:-9999px`.
4. כלי ה-QA עובדים ב-LTR, ואין בכלים הנחות RTL או עברית.
5. הדוחות A0.md ו-A3.md כנים, וכל הטענות שבדקתי התאמתו. סטייה זניחה: ‏4.73 בדוח מול 4.74 אצלי (עיגול).

**הערות לא חוסמות**
1. ‏`includes[]` בפריטים שמנוסחים מחדש בגוף שני ("AI-drafted, approved by you" במקום "Claude-drafted, client-approved"). ‏pricebook_test לא משווה את הטקסט הזה, ומאיר צריך לאשר את הניסוח יחד עם `excludes[]`.
2. ‏check_hardcoded מדלג על תיקיות `tests` שלמות ועל שורות הערה, ולכן שם יכול להסתתר מחיר. זה מקובל, אבל כדאי לזכור את זה ב-A10.
3. ‏A3.md סעיף 5 ("make qa יכשל") כבר לא עדכני, כי runtime תוקן. ב-pricebook_test נשארה הודעת note על Clio שכבר לא רלוונטית (לא מזיקה).
