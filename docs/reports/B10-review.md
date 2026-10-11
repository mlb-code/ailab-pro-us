# B10 — ביקורת (11.10.2026)

**CHANGES:**
1. **טקסט של מקצוע ומדינה מקודד ב-`build.py` ולא ב-`content.json`.** לקוח חשמלאי או גגן יקבל בדיוק את הנוסח הזה: Home `.sec-head h2` "Heating, cooling and plumbing, one call."; Services `.page-hero .lead` "Licensed HVAC and plumbing…" ו-meta description עם רשימת שירותים קבועה; About meta "Family-owned HVAC and plumbing company"; About `aside.panel .muted` "You can look up Texas licenses…"; Contact meta "Request HVAC or plumbing service"; `badges_row` מכיל `.replace('Texas ','TX ')`. כל אלה צריכים לעבור לשדות ב-content (למשל `trade_phrase`, `license_lookup`, `seo.*`).
2. **אובדן לידים בלי שום סימן.** כשבונים עם `demo=false` ו-`leads_url` ריק, ה-build לא מתריע (בדקתי), ו-`main.js` מציג "Thanks, we got your request" בלי לשלוח כלום. הפתרון: ה-build צריך להיכשל או לפחות להתריע בבירור, ובאתר אמיתי בלי URL צריך להופיע `#form-fail` ולא הודעת הצלחה.
3. **ב-`--template` נשאר טקסט של הדמו.** יש בדיוק 17 מצייני מקום, אבל ב-`placeholder-site/about/` עדיין כתוב "Ray Medina started Copperleaf…". נשארו גם ערי יוסטון, רשימת ה-ZIP, שמות הממליצים, "Texas ACR…" ו-"$89 (sample terms)". README §4 מתעד שהרשימות נשארות, אבל לפחות את שם העסק צריך להחליף, ואת הרשימות כדאי לסמן כ-`{{…}}` או כ-"SAMPLE".

**מה הרצתי בעצמי:**
- בנייה מחדש לתיקייה זמנית ו-`diff -r` מול `site/demo-site/home-services`: זהה. גם `--template` זהה ל-`placeholder-site/`, עם 17 מצייני מקום ייחודיים.
- `overflow.mjs`, 5 עמודים: ‏60/60 PASS (3 מנועים × 375/390/414/1280), בלי שגיאות קונסול.
- Lighthouse 12.8.2 במובייל (ציונים לפי סדר: ביצועים / נגישות / Best Practices / SEO):
  - בית: 90/100/100/63
  - services: ‏100/100/100/63
  - contact: ‏100/100/100/63
  - build עם `noindex=false`: ‏100/100/100/100
  - ה-SEO 63 נובע רק מ-`is-crawlable`, כלומר מה-noindex, וזה בכוונה.
- `check_hardcoded site templates`: אפס שגיאות. `check_secrets`: אפס ממצאים. שרתים בפורטים 8900–8901, נסגרו.
- **הסמן `generated-by: tools/`:** בדקתי בעותק בלי הסמן. יוצאות 35 שגיאות, וכולן `site_url` או השם מ-brand.json, שהגנרטור קורא בזמן ריצה. מקורות התבנית (`build.py`, `art.py`, `content.json` עם `@brand/…`) נסרקים בלי פטור ונקיים. לכן הסמן מקובל ולא מסתיר קידוד אמיתי. עדיף שהכלי יקבל `generated-by:` עם כל נתיב, במקום "tools/ convention".

**צ'קליסט:**
1. **הכלולים ב-WEB קיימים:**
   - 5 עמודים, ו-JSON-LD `HVACBusiness+Plumber` שעובר parse בכל עמוד. `FAQPage` נמצא ב-reviews.
   - sitemap, ו-robots עם Sitemap רק כשהאתר indexable. `og.png` ו-`--og`.
   - landmarks (header/nav/main/footer), כל השדות עם label, h1 אחד בכל עמוד, skip link הוא הפוקוס הראשון, `:focus-visible`.
   - Code.gs: honeypot, ולידציה של 10 ספרות ו-ZIP, Lock, הגנה מנוסחאות, הסכמה, גיליון ומייל. אין rate-limit, וזה מקובל.
   - קישורי `sms:` עם body, ונוסח "Reply STOP" בטופס ובפוטר.
   - "Website by" מגיע מ-brand.json. `html{overflow-x:clip}` קיים, ואין `left:-9999px`.
2. **הדמו פיקטיבי ומסומן:** מספר 555, תגיות sample, בלי רחוב, noindex. חיפוש "Copperleaf" + HVAC ביוסטון לא מצא אף עסק בשם הזה.
3. **עיצוב:** חזק ומתאים לבעל מקצוע. Archivo מ-Google Fonts, נחושת וכחול-פטרול ולא הנייבי והענבר של הסטודיו, איורי SVG בלי סטוק, באנרי חירום ומימון, וסרגל Call/Text/Get service בנייד. הערה קטנה: ב-390 תג הדמו מכסה את אייקון באנר החירום (רק בדמו).
4. **README:** עונה על כל הדרישות. יש פרומפט אחד, 21 שאלות, טבלת מצייני מקום, צביעה מחדש, OG ו-JSON-LD, חיבור הטופס, GitHub Pages ו-DNS, צ'קליסט QA, ‏10DLC ו-TCPA, והחוסר של מתג Text לקו נייח מתועד ב-§11.
5. **כנות הדוח:** הדוח כן. הסטיות בשם ובנתיב ונושא הסמן דווחו. ההבדלים בציונים (ביצועים 99 בדוח מול 90 אצלי, SEO 66 מול 63) הם שונות בין ריצות.

**צילומי מסך:** `docs/reports/shots-b10-review/` (6 קבצים).

---
## בדיקה חוזרת (11.10.2026)
**CHANGES (סעיף אחד, תיקון של שורה):**
1. בעמוד Contact, ב-`#f-msg`, ה-placeholder "E.g. AC blowing warm air since this morning" כתוב ישירות ב-`build.py` (שורה 677). הוא הופיע באתר החשמלאי שבניתי לבדיקה. צריך להעביר אותו ל-`copy.form_placeholder`, עם ברירת מחדל נייטרלית.

**שאר התיקונים אומתו:**
- בנייה מחדש: diff נקי מול הדמו ומול `placeholder-site`. בגרסת `--template` יש 47 מצייני מקום, ואף שארית של Copperleaf, Houston, Texas, sample או $89.
- אתר חשמלאי בטמפה, פלורידה, מקובץ content חדש: אין בו HVAC, Texas, plumbing או heating, חוץ מהסעיף למעלה. איור ההירו לא נבדק, כי הוא מוכר ומתועד כחוסר.
- בנייה עם `demo=false` בלי `leads_url` נכשלת עם exit 1 והודעה ברורה. עם `--allow-no-leads` הטופס מציג "Sorry, that didn't go through" עם טלפון ו-SMS, והפוקוס עובר להודעה (צילום: `shots-b10-review/fl-contact-fail-390.png`).
- overflow: ‏60/60. ‏`check_hardcoded`: אפס שגיאות. ‏`check_secrets`: אפס ממצאים. השרתים בפורטים 8900 ו-8902 נסגרו.
