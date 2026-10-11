# A4 — ביקורת (Opus, 11.10.2026)

## סבב 2 — פסק דין: APPROVE
- נבדק בלי git, על פורט 8912 (השרת נסגר). `--check`: ‏8 קבצים, 0 הבדלים. `check_hardcoded`: ‏0/0. overflow: ‏72/72. `demo_test`: ‏321 מסלולים, 0 כשלים בשלושת המנועים. אין שגיאות קונסול.
- נדל"ן: אין בדף "receptionist" (0 מופעים), "Lead Assistant" מופיע 3 פעמים, ורשימת הכלים בלי Jobber/HCP/ServiceTitan/QuickBooks ובלי ZIP/job type. שיניים: ב"מה כלול" אין כתובת, הניווט מוביל ל-`#early-access`, ומחיר המייסדים לא מופיע גם כשהדגל true (בדקתי בבנייה זמנית; הוא מופיע רק בבית ובנדל"ן).
- אתר: ב-trust, ב-FAQ וב-band אין יותר טקסט של RCP. ב-title כתוב "7 Business Days After We Have Your Content". שיחת 15 דקות: "Book a 15-minute video call" (mailto כשאין Calendly) מופיע ליד `#bundle` וב-`.pricing__side` בדף הבית.
- ‏/demo/: המחיר מעל הקפל (487px ב-390), וה-CTA מתחלף לפי הנישה (`data-niche-cta`). FAQ של Jobber/HCP: בלי מחיר ובלי טענה מוחלטת. זמנים: "8 AM–12 PM", ו-"Reply STOP" מופיע בהודעה הראשונה בכל 9 התרחישים. פוקוס אחרי צ'יפ: עובר לבועה היוצאת ואז לצ'יפ הבא.
- הערה לא חוסמת: ה-title של ‎/website/ ארוך (~95 תווים) ויחתך בגוגל. כדאי לקצר, למשל "Live 7 Business Days After Content".

## סבב 1 (היסטוריה)

**פסק דין: CHANGES** — העיצוב, הבדיקות האוטומטיות וה-SEO עוברים. אבל הבלוקים המשותפים לא מותאמים לכל דף, ולכן בנדל"ן, בשיניים ובאתר מופיע טקסט של שירותי בית/RCP.

1. **‎/real-estate/: המיצוב נשבר מתחת להירו.** כותרת h2 ב-`#how-it-answers`: "Your receptionist doesn't either". ב-`#trust` כתוב "Your receptionist runs on Claude". ב-`#included` מופיעים "Collects job details: …service address/ZIP, job type" ו-"emergency keywords". ב-`.tools` מופיעים Jobber/Housecall Pro/ServiceTitan/QuickBooks, ושם המוצר בכרטיס המחיר הוא "Missed-Call AI Receptionist". צריך override לנישה (סינון רשימת הכלים, ניסוח "lead screening", כותרת מוצר).
2. **‎/dental/ סותר את עצמו ואת SPEC §8.** ההירו אומר "collects only a name, a phone number and a general reason", אבל ב-`#included` כתוב "service address/ZIP, job type". חוץ מזה: כפתור הניווט "Get a quote" מוביל ל-`/start/?offer=RCP` בדף שהוא early access בלבד. כשמגדירים `show_founder_price=true`, מחיר המייסדים מופיע גם בדנטל (בדקתי בבנייה בתיקייה זמנית). גם כאן מופיעים כלי FSM.
3. **‎/website/ מקבל טקסט של RCP:** ב-`#trust` כתוב "Your receptionist runs on Claude" ו-"Quote in writing within 24 hours of your questionnaire" (ל-WEB אין שלב הצעה). שאלת "Do I have to get on a call" מתארת הצעה + צ'ק-ליסט. הבאנר האחרון אומר "Get your fixed quote… written quote within 24 hours" אבל הכפתור הוא "Choose this package". ב-title כתוב "Live in 7 Days", צריך "7 business days after content".
4. **החבילה בלי הצעת שיחה:** לפי Addendum 2, ליד BNDL צריכה להופיע הצעה בולטת לשיחת 15 דקות אופציונלית. ב-`#bundle` בדף האתר וב-`.pricing__side` בדף הבית אין כזו. שורת `.how__call` היא טקסט בלי קישור כל עוד `calendly_url` ריק. כשהשדה מלא הקישור נוצר (בדקתי), אבל צריך חלופה, למשל mailto.
5. **‎/demo/ בלי מחיר:** אין מחיר בכלל, לא מעל הקפל (390/1440) ולא בהמשך. כפתורי ה-CTA (‏3×) הם `/start/?offer=RCP` בלי `niche`, למרות שיש בדף מתג נישה. צריך להעביר את הנישה הפעילה (`home_services`/`real_estate`, המפתחות ש-`home.js` מקבל).
6. **שאלת Jobber/HCP:** "for $29/month" ו-"They work only inside their own software" הן טענות עובדתיות על מתחרים שלא אומתו. כדאי לנסח בלי מחיר ובלי טענה מוחלטת. "maintained… by a real team" לא מדויק לעסק של אדם אחד, עדיף "a real person".
7. **ניסוח בדמו:** "Tue 8–12 AM" ו-"Today 10–12" הם פורמט זמן שגוי באמריקאית (צריך "8 AM–noon", "10 AM–noon"). ההודעה הראשונה ב-text-back לא כוללת "Reply STOP to opt out" (SPEC §8, ההודעה הראשונה). כרגע זה מופיע רק בסוף.
8. **נגישות בדמו (קל):** אחרי לחיצה על צ'יפ הפוקוס נופל ל-`BODY`, כי הקבוצה נמחקת. עדיף להעביר את הפוקוס לצ'יפ הראשון החדש, או לסוף הצ'אט.
9. **כנות הדוח:** הדוח אומר שבנדל"ן אין את המילה receptionist (סעיף 4), וזה לא נכון (ראו 1). שאר המספרים שוחזרו. Lighthouse לא הורץ, ודווח על כך ביושר. דרישת הקבלה ≥90/≥95 עדיין פתוחה ל-A10.

**מה עבר (הרצתי בעצמי, פורט 8911, השרת נסגר):** `build_landing.py --check` ‏(8 קבצים, 0 הבדלים) · `check_hardcoded.py site` ‏(0/0) · overflow ‏72/72 (6 דפים × 375/390/414/1280 × 3 מנועים) · `demo_test.mjs` ‏321 מסלולים, 0 כשלים ב-Chromium, ב-WebKit וב-Firefox. אין שגיאות קונסול. הבקשות החיצוניות היחידות הן Google Fonts. אין `left:-9999px`.
- עיצוב: navy/amber, כותרת Noto Serif, "השעון" כרעיון אחד, בלי תמונות סטוק. זו אותה משפחה של pro.ai-lab.co.il ולא העתק. המחיר מופיע מעל הקפל בכל דף נישה, ב-1440 וב-390. "Get my fixed quote" מוביל ל-`?offer=RCP&niche=<key>` עם מפתחות תקינים.
- תוכן: ההירו מוכר RCP בלבד. משבצת המייסדים מוסתרת כשהדגל false ומוצגת כשהוא true. אין שום אזכור לעורכי דין. הסתייגות 10DLC קיימת. טקסט השימוש: 80% + no surprise. ‏`quote_sla_text` אחיד, ואין "1 business day" לגבי ההצעה. "Built with Claude" מופיע עם הערת אי-שיוך, ולא כמותג. שורת ההוכחה נלקחת מ-`brand.proof`. ההחזר תואם ל-`refund_rules`. אין הבטחות תוצאה.
- SEO: הקנוניקל של home-services מצביע ל-/. דנטל מסומן noindex ואינו ב-sitemap. ה-sitemap מכיל 4 כתובות ציבוריות. robots חוסם את `/start/` ו-`/quote/`. ארבע תמונות OG בגודל 1200×630, וכולן מקושרות. ה-JSON-LD (‏Service+Offer USD, ‏FAQPage ×8) עובר parse. אנליטיקס נטען רק כשיש מזהים (בדקתי עם מזהים פיקטיביים). החלופה לטופס הליד (mailto) מתועדת.
- דמו: עובד אופליין, 3 תרחישים לכל נישה, 2–3 צ'יפים בכל צעד, נגמר ב-"Booked" + "This is a demo". אפשר להגיע לצ'יפים במקלדת. אין גלישה ב-375.
- הערה למאיר (לא חוסם): `legal_entity.name` ו-`physical_address` ריקים, ולכן "פרטי העסק" מחבילת האמון (סינתזה §3ג) לא מופיעים בדף.

צילומי מסך (11): `docs/reports/shots-a4/` — `{home,real-estate,dental,website,demo}-{1440,390}.png` + `demo-midflow-390.png`. ‏home-services זהה לדף הבית.
