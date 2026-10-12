# סקירת LEGAL-STANDARD (12.10.2026)
**פסק דין: CHANGES.** יש 3 תיקונים קטנים. אין בעיה מהותית בשלושת המסמכים עצמם.
1. **`site/_content/dental.json` (שורות 19, 420, 425, 453) → `site/dental/`:** כתוב שם "any HIPAA BAA request, get a custom quote", וזה סותר את Privacy §11, את SA §12 ואת החלטה 6 ("do not sign BAAs"). לנסח מחדש: "We don't sign a HIPAA BAA". בנוסף, "after a legal review" ו-"We're finishing a legal review" מציגים בדיקה משפטית שלא מתבצעת. להחליף ל-"Early access for a small number of practices".
2. **`site/legal/service-agreement/` §15:** הסעיף מפנה ל-"your indemnity in section 16.1", אבל ב-§16 אין מספור משנה. לסמן "16.1 By you" ו-"16.2 By us", או לכתוב "your indemnity in section 16 (By you)".
3. **`site/legal/privacy/` §6 (לא חוסם):** במסלול הקולי של הייצור (`runtime/app/voice_stream.py`) Twilio ConversationRelay מעביר את האודיו ל-Deepgram לתמלול ול-ElevenLabs או Amazon Polly להקראה. כדאי להוסיף לשורת Twilio: "(via Twilio's speech partners, e.g. Deepgram, ElevenLabs, Amazon Polly)". jsDelivr ו-cdnjs משמשים רק כ-CDN לקוד, אפשר להשאיר.
4. **קוסמטי:** ב-SA §4 כתוב "1000 SMS segments" (המספר מוטבע מהמחירון), ובשאר המקומות "1,000". ב-FAQ של דפי הנחיתה כתוב "30 days notice" בלי גרש, ובמסמכים "30 days' notice". קישורי ה-mailto הם `href="#"` כשאין JS.

**מה עבר:**
- אין placeholders, `[ATTORNEY]` או "to be reviewed". מופיעים "Last updated: October 12, 2026" ו-v1.0.
- באנר DRAFT מוסתר. בעותק זמני עם `legal_final=false` הוא מוצג בשלושת המנועים.
- הקישורים בין המסמכים, ה-mailto (עם JS) והפוטר מחזירים 200.
- overflow: ‏72/72 (3 דפים + 3 fixtures של הצעה × 3 מנועים × 4 רוחבים), 0 שגיאות קונסול.
- ניגודיות: בהיר 5.8–15.1, כהה 8.6–16.3.
- נוסח הערבות וההחזר זהה ל-`pricebook.json` ב-Terms §7, ב-SA §5, ב-4 דפי הנחיתה, בדף ההצעה ובמייל ההצעה ובמייל ה-go-live (שניהם קוראים מ-`refund_rules`). בחבילה מוחזר רק חלק ה-RCP בכל המקומות.
- SLA "within 1 business day" עם "Sunday–Thursday" עקבי.
- הדין והבוררות (NY, FAA, AAA, ויתור ייצוגי) זהים ב-Terms §17 וב-SA §18.
- התקרות: ב-Terms ‏12 חודשים או $100, ב-SA ‏12 חודשים הדדי. תואם לסטנדרט.
- יש חידוש אוטומטי וביטול בכל עת. ה-sender of record מופיע ב-SA §8 ובמקביל ב-Terms §11 וב-Privacy §2/§4.
- 13 מעבדי משנה, CCPA מלא, אין טענת HIPAA, דנטל early access. הישות והכתובת נלקחות מ-config.
- איות אמריקאי, סעיפים ממוספרים, אין הבטחת תוצאות.
- `make qa-fast` עבר (rc=0). `e2e_phase_a` ‏157/157, כולל "accept stores … agreement version". השרת על 8900/8901 נסגר.
