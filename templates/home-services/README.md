# תבנית "שירותי בית" (US) · אתר לעסק, מוצר `WEB`

תבנית פנימית לבניית אתר של 5 עמודים לעסקי שירותי בית בארה"ב: מיזוג וחימום (HVAC), אינסטלציה, חשמל, גגות וכדומה.
האתר עצמו באנגלית אמריקאית, LTR. ההדגמה החיה: `site/demo-site/home-services/` (עסק פיקטיבי "Copperleaf Air & Plumbing", יוסטון, טקסס, מסומן demo ו-noindex).
ההיקף מוגדר ב-`docs/PRICEBOOK.md` (סעיף `WEB`): 5 עמודים, טופס → מייל + Google Sheet, כפתורי חיוג ו-SMS, SEO מקומי בסיסי, LocalBusiness schema, sitemap וקישור ל-GBP. עמוד נוסף, גרסה בספרדית, לוגו או בלוג הם תוספות (`ADD-PAGE`, `ADD-WEB-ES`, `ADD-LOGO`, `ADD-BLOG`). לא מוסיפים אותם בלי הצעת מחיר.

---

## 1. מה יש בתיקייה

| קובץ | מה זה |
|---|---|
| `demo/content.json` | **התוכן של לקוח אחד** (כאן: לקוח ההדגמה). כל הטקסטים, השירותים, השעות, הרישיונות, אזור השירות, הביקורות, ה-FAQ, המתגים והצבעים. לכל לקוח יש קובץ אחד כזה |
| `demo/og.png` | תמונת השיתוף של ההדגמה (1200×630). נוצרת עם `--og` |
| `_generator/build.py` | הגנרטור: קורא את `content.json` וכותב 5 עמודים, `assets/`, `sitemap.xml`, `robots.txt`. דטרמיניסטי: אותו קלט נותן קבצים זהים |
| `_generator/art.py` | כל האיורים כ-SVG: חתך הבית בהירו, אייקוני השירותים, מפת אזור השירות, הלוגו (מגן עם ראשי תיבות) וכרטיס ה-OG. אין תמונות סטוק |
| `assets/style.css` | כל העיצוב, mobile-first. הצבעים מגיעים מ-`content.json` (בלוק `:root` בכל עמוד) |
| `assets/main.js` | תפריט נייד, טופס (ולידציה + שליחה), מצב הדגמה לכפתורי חיוג ו-SMS, אירועי GA4. בלי ספריות |
| `leads/Code.gs` | Google Apps Script: טופס → שורה בגיליון + מייל לבעל העסק (שדות אמריקאיים: ZIP, urgency, contact by, הסכמה) |
| `placeholder-site/` | אותו אתר עם 47 מצייני מקום `{{...}}` (נוצר ב-`--template`): בלי שם, עיר, ZIP, ממליץ או רישיון של הדמו. לקריאה ולהשוואה בלבד, לא לפריסה |

**כלל:** לא עורכים HTML ידנית. משנים את `content.json` ומריצים את הגנרטור.

```bash
# דמו (מתוך שורש הריפו): בונה את site/demo-site/home-services/
python3 templates/home-services/_generator/build.py
# לקוח: קובץ תוכן משלו ותיקיית פלט משלו
python3 templates/home-services/_generator/build.py --content ~/Desktop/clients/<slug>/content.json ~/Desktop/clients/<slug>/site
# תמונת OG (פעם אחת לכל לקוח, צריך Chrome): נשמרת ליד content.json כ-og.png ומועתקת לאתר
python3 templates/home-services/_generator/build.py --content ~/Desktop/clients/<slug>/content.json --og ~/Desktop/clients/<slug>/site
# גרסת מצייני מקום
python3 templates/home-services/_generator/build.py --template templates/home-services/placeholder-site
```
דגלים: `--content` (ברירת מחדל: `demo/content.json`), `--allow-no-leads` (טיוטה בלי Apps Script, ראו סעיף 8), `--brand` (קובץ `brand.json` לשורת "Website by"; ברירת מחדל `config/brand.json` של הריפו), `--og`, `--template`. משתנה סביבה `OG_PORT` (ברירת מחדל 8977) הוא פורט הדיבאג של Chrome לצילום ה-OG.

---

## 2. הפרומפט האחד (להדביק לסשן חדש של Claude)

> בנה אתר לקוח מתבנית שירותי הבית: קרא את `~/Desktop/ailab-pro-us/templates/home-services/README.md` כולו, ואז את תשובות השאלון למטה. צור `~/Desktop/clients/<slug>/content.json` כהעתק של `demo/content.json`, ומלא אותו מהתשובות: `flags.demo=false`, `flags.noindex=true` עד יום העלייה, `powered_by` לפי מה שסוכם עם הלקוח. **אל תמציא** ביקורות, מספרי רישיון, ביטוח או מבצעים: מה שחסר נשאר ריק או יוצא מהאתר, ומדווח. התאם `colors` (סעיף 6), הרץ את `build.py` עם `--og` לתיקייה `~/Desktop/clients/<slug>/site`, הרץ את צ'קליסט ה-QA (סעיף 10), צלם 1440 ו-390, וכתוב לי בעברית מה חסר מהלקוח. בלי push ובלי פריסה עד שמאיר מאשר.
> **תשובות השאלון:** (להדביק כאן)

---

## 3. שאלון היכרות ללקוח (באנגלית ללקוח, מתורגם כאן)

**העסק**
1. השם המדויק כפי שהוא מופיע ב-Google Business Profile, ושורת תיאור קצרה ("Heating, cooling & plumbing").
2. עיר ומדינה של הבסיס. **האם יש כתובת שהלקוחות מגיעים אליה?** רוב עסקי שירותי הבית הם service-area business: מסתירים את הרחוב (`show_street=false`), ומשאירים עיר, מדינה ו-ZIP list.
3. שנת הקמה, הבעלים והצוות שמופיע באתר (שם + תפקיד, באישור כל אחד).
4. מה מבדיל אתכם? למה לקוחות חוזרים? (מזה נכתבים ה-hero וה-About.)

**רישוי וביטוח (חובה לבדוק מול המקור)**
5. מספרי רישיון לכל מקצוע ולכל מדינה. דוגמאות: Texas ACR (TDLR, `TACLA#####C`), Texas plumbing (TSBPE, `RMP-#####`), California CSLB, Florida CAC/CFC. **מעתיקים מהרישיון עצמו**, ובודקים באתר הרשות.
6. ביטוח: general liability, workers' comp, bonded? הנוסח המדויק שמותר לכתוב.

**שירותים ומחירים**
7. עד 6 שירותים. לכל אחד: שם, משפט, 4 סימנים ש"צריך לקרוא לנו", מה כלול, הערה (למשל diagnostic fee).
8. האם מציגים מחירים? (diagnostic fee, תוכנית תחזוקה). אם לא, משאירים את `note` בלי סכום.
9. מותגים שאתם מתקינים, אחריות על עבודה, היתרים (permits).

**זמינות**
10. שעות משרד לכל יום, ואזור הזמן.
11. **שירות חירום**: יש 24/7? רק לקוחות קיימים? תוספת מחיר בלילה? (`emergency.enabled`, `emergency_banner`)
12. **מימון**: יש? דרך איזו חברה (GreenSky, Synchrony, Service Finance)? קישור להגשה? (`financing`). לא כותבים ריבית או "0% APR" בלי נוסח מהספק.
13. אזור שירות: רשימת ערים ו-**רשימת ZIP codes** (עד ~20 מוצגים).

**ערוצי קשר**
14. מספר לשיחות. מספר ל-SMS (אם שונה), ו**האם המספר הזה בכלל מקבל SMS** (קו נייח לא מקבל). ראו סעיף 11.
15. המייל שאליו יגיעו לידים, ומי הבעלים של הגיליון.
16. Google Business Profile: קישור, וקישור "write a review". קישור לכל הביקורות בגוגל.

**מראה ואמון**
17. לוגו (SVG/PNG שקוף) וצבעי המותג (צבעי המשאיות/מדים). אם אין לוגו: מגן עם ראשי תיבות (מהגנרטור), או תוספת `ADD-LOGO`.
18. 3–6 ביקורות אמיתיות (טקסט, שם פרטי + אות, שכונה), **עם אישור לפרסם**, או רק קישור לגוגל.
19. תמונות אמיתיות (צוות, משאיות, עבודות) אם יש. בלי תמונות סטוק. אם אין, נשארים עם האיורים.
20. דומיין: יש? איפה רשום (GoDaddy, Namecheap, Cloudflare, Squarespace)? הדומיין תמיד על שם הלקוח.
21. GA4 / Search Console קיימים? אם כן, גישה.

---

## 4. מצייני מקום → שדות ב-content.json

ב-`--template` הגנרטור מחליף ב-`{{...}}` את שדות `business`, את הרשימות שתמיד שייכות ללקוח, ואת כל אזכור של שם העסק, הבעלים, הערים והמדינה של הדמו בטקסט החופשי. **סך הכל 47 מצייני מקום.** השירותים, ה-FAQ וה-hero נשארים בנוסח HVAC כללי, וכותבים אותם מחדש ב-`content.json`.

| מציין מקום | שדה | איפה מופיע | דוגמה (דמו) |
|---|---|---|---|
| `{{BUSINESS_NAME}}` | `business.name` | לוגו, `<title>`, description, og, JSON-LD, טופס (נוסח ההסכמה), פוטר | Copperleaf Air & Plumbing |
| `{{TAGLINE}}` | `business.tagline` | מתחת ללוגו, og:image:alt, כרטיס OG | Heating, cooling & plumbing |
| `{{CITY}}`, `{{STATE}}` | `business.city`, `.state` | כותרות, descriptions, JSON-LD `addressLocality`/`addressRegion`, מפה | Houston, TX |
| `{{PHONE}}` | `business.phone` | כל מספר גלוי (כותרת, כפתורים, פוטר) | (713) 555-0100 |
| `{{PHONE_E164}}` | `business.phone_e164` | כל `tel:` ו-JSON-LD `telephone`. פורמט `+1XXXXXXXXXX` | +17135550100 |
| `{{SMS_E164}}` | `business.sms_e164` | כל `sms:` (ריק = כמו הטלפון) | +17135550100 |
| `{{EMAIL}}` | `business.email` | פוטר, צור קשר, JSON-LD (ריק = לא מוצג) | office@… |
| `{{SITE_URL}}` | `business.site_url` | canonical, og:url, og:image, JSON-LD, sitemap. **עם `/` בסוף** | https://www.example.com/ |
| `{{LICENSE_1}}`, `{{LICENSE_2}}` | `business.licenses[].number` | שורת האמון, About, פוטר | TACLA 00000C |
| `{{INSURANCE_TEXT}}` | `business.insurance` | שורת האמון, About | General liability and workers' comp insured |
| `{{FOUNDED_YEAR}}` | `business.founded` | About | 2009 |
| `{{GBP_URL}}` | `business.gbp_url` | כפתור "Leave us a Google review", JSON-LD `sameAs` | |
| `{{REVIEWS_URL}}` | `business.reviews_url` | "Read all reviews on Google" | |
| `{{LD_DESCRIPTION}}` | `business.ld_description` | JSON-LD description | משפט אחד |
| `{{LEADS_URL}}` | `business.leads_url` | `data-leads` ב-`<body>` (כתובת ה-Apps Script) | |
| `{{STREET}}`, `{{ZIP}}` | `business.street`, `.zip` | רק אם `show_street=true` | |
| `{{STATE_NAME}}` | נגזר מ-`state` | משפט אימות הרישיון, FAQ | Texas |
| `{{LICENSE_n_LABEL}}` (n=1–2) | `business.licenses[].label` | שורת האמון, About, פוטר | Texas ACR contractor license |
| `{{AREA_CITY_n}}` (n=2–6), `{{ZIP_n}}` (n=1–4) | `business.service_area.cities` / `.zips` | אזור שירות, מפה, FAQ, JSON-LD `areaServed` | Bellaire / 77005 |
| `{{REVIEW_n_TEXT/NAME/PLACE}}` (n=1–3) | `reviews[]` | בית, Reviews | |
| `{{ABOUT_STORY_n}}` (n=1–3), `{{TEAM_n_NAME/ROLE}}` (n=1–3) | `about.story`, `about.team` | About | |

**טקסט של מקצוע ומדינה** (לא נמצא ב-`build.py`): `trades` (רשימה: `hvac`, `plumbing`, `electrical`, `roofing`, `handyman`, `landscaping`, `pest`, `garage`, `appliance`, `cleaning`, `painting`, `pool`), ובלוקים `copy` ו-`seo`. מפתח שחסר מקבל ברירת מחדל שנבנית מ-`trades` ומ-`state`. בטקסט אפשר להשתמש בטוקנים `{name} {city} {state} {state_name} {phone} {trade} {founded} {tagline}`.

| שדה | איפה מופיע | ברירת מחדל |
|---|---|---|
| `copy.services_h2` | כותרת השירותים בבית | `{trade} for your home, one call.` |
| `copy.services_lead` | פסקת הפתיחה בעמוד Services | `Licensed {trade} for homes in {city} and nearby…` |
| `copy.license_badge` | תג "Licensed" בשורת האמון | תווית הרישיון הראשון, עם קיצור המדינה (Texas → TX) |
| `copy.license_lookup` | משפט האימות ב-About | `You can verify our licenses with the {state_name} licensing board.` |
| `copy.form_placeholder` | טקסט הדוגמה בשדה ההודעה בטופס | `Tell us what's going on and when you'd like us there` |
| `seo.home_title` | `<title>` של הבית | `{name} \| {tagline} in {city}, {state}` |
| `seo.home_desc`, `services_desc`, `about_desc`, `reviews_desc`, `contact_desc` | meta description של כל עמוד | נוסח כללי עם `{trade}`, `{city}`, `{state}` |

האיור בהירו (`art.hero_house`, עם תגיות AC + HEAT ו-PLUMBING) מתאים ל-HVAC ולאינסטלציה. למקצוע אחר מציירים איור חלופי ב-`art.py`.

עוד שדות בלי מציין מקום: `hours` (מקום אחד בלבד; משמש בפוטר, בצור קשר, ב-CTA וב-JSON-LD), `emergency`, `financing`, `service_area.cities`/`.zips`, `schema_types`, `price_range`, `ga4_id`, `hero`, `services`, `steps`, `reviews`, `faq`, `about`, `form`.
**אייקונים לשירותים:** `ac`, `heat`, `plumb`, `water`, `drain`, `plan` (ועוד ב-`art.ICONS`). שירות של מקצוע אחר (חשמל, גגות) צריך אייקון חדש: מוסיפים path ב-`ICONS`, בסגנון קו עבה, viewBox 48.

---

## 5. מתגים (`flags` ב-content.json)

| מתג | הדגמה | טיוטת לקוח | יום העלייה |
|---|---|---|---|
| `demo` | true: תגיות "sample", הערות "demo" בפוטר וב-JSON-LD, כפתורי חיוג/SMS מציגים הודעה ולא מחייגים, הטופס לא שולח | **false** | false |
| `noindex` | true | true | **false** (ואז robots.txt מקבל שורת Sitemap) |
| `powered_by` | true | לפי ההסכם | לפי ההסכם. השם והקישור נלקחים מ-`config/brand.json` |
| `emergency_banner` | true | לפי שאלה 11 | |
| `financing_banner` | true | לפי שאלה 12 | |
| `show_street` | false | true רק אם לקוחות מגיעים לכתובת | |

- **בלי ביקורות אמיתיות:** `reviews: []` ומוחקים את הסקשן מהבית (או משאירים רק קישור לגוגל). **לא ממציאים ביקורות לאתר אמיתי** (FTC: ביקורות מזויפות אסורות, קנס לכל הפרה).
- **לא שמים ביקורות ב-JSON-LD** (`Review`/`AggregateRating`) של העסק עצמו: גוגל לא מציג self-serving reviews, וזה סיכון.

---

## 6. צביעה מחדש

ב-`content.json` מוסיפים `"colors": {...}` עם כל אחד מהמפתחות: `paper`, `paper2`, `ink`, `ink2`, `hot`, `hot_soft`, `cool`, `cool_soft`. הגנרטור כותב אותם כ-`:root` בכל עמוד, והאיורים (SVG עם מחלקות CSS), ה-favicon וכרטיס ה-OG מקבלים אותם אוטומטית.

| מפתח | תפקיד | כלל ניגודיות |
|---|---|---|
| `paper`, `paper2` | רקע ורצועות | בהירים וחמים, לא לבן טהור |
| `ink`, `ink2` | טקסט | `ink2` לפחות 7:1 על `paper2` |
| `hot` | כפתור החיוג, eyebrow, הדגשות (צבע "חם") | **≥ 4.5:1 על `paper2` ועם טקסט לבן** |
| `cool` | כפתור ה-SMS, קישורים, פוקוס (צבע "קר") | ≥ 4.5:1 על `paper` ועם לבן |
| `hot_soft`, `cool_soft` | רקעי אייקונים וסימון | בהירים |

בדיקה:
```bash
python3 -c "
def L(h):
  c=[int(h[i:i+2],16)/255 for i in (0,2,4)];c=[x/12.92 if x<=.03928 else ((x+.055)/1.055)**2.4 for x in c];return .2126*c[0]+.7152*c[1]+.0722*c[2]
r=lambda a,b:(max(L(a),L(b))+.05)/(min(L(a),L(b))+.05)
print(round(r('AE3A0B','F2E7D3'),2), round(r('AE3A0B','FFFFFF'),2))"
```
**גופן:** Archivo (משתנה, wdth+wght) מ-Google Fonts בלבד, נטען בלי לחסום רינדור. החלפה: `FONTS_CSS` ב-`build.py` ו-`--font` ב-`style.css`.
**לוגו של הלקוח:** להחליף את `LOGO` ב-`build.py` ב-`<img src="{p}assets/logo.svg" alt="" width="46" height="46">` ולהעתיק את הקובץ ל-`assets/`, ולעדכן את `favicon.svg`.

---

## 7. מטא, Open Graph ו-JSON-LD

- `<title>`: "שירות | שם, עיר מדינה". description עד ~155 תווים, עם העיר ומה שאנשים באמת מקלידים ("AC repair Houston", "water heater replacement Katy").
- **OG:** `--og` מרנדר כרטיס 1200×630 מ-`art.og_html` (שם, תיאור, טלפון, איור) עם `tools/cdp-shots.mjs` של הריפו. מחוץ לריפו צריך שהנתיב `../../../tools/` יהיה זמין, או לצלם ידנית.
- **JSON-LD בכל עמוד:** `@type` מ-`schema_types` (`HVACBusiness`, `Plumber`, `Electrician`, `RoofingContractor`, `HomeAndConstructionBusiness`...), שם, טלפון, `address` (בלי רחוב כשהוא מוסתר), `areaServed` (ערים), `openingHoursSpecification` מ-`hours`, `hasOfferCatalog` מהשירותים, `sameAs` מ-`gbp_url`. ב-`reviews/` גם `FAQPage` מ-`faq`.
- בדיקה: https://validator.schema.org ו-https://search.google.com/test/rich-results.

---

## 8. חיבור הטופס (גיליון + מייל)

1. יוצרים Google Sheet בשם "Website leads – <שם העסק>". עדיף בחשבון של הלקוח. אחרת אצלנו, ומשתפים איתו.
2. ב-`leads/Code.gs` ממלאים `SHEET_ID` (מהכתובת, בין `/d/` ל-`/edit`), `NOTIFY_EMAIL`, `BUSINESS_NAME` ו-`TIME_ZONE` (טקסס: `America/Chicago`).
3. בגיליון: Extensions → Apps Script → מדביקים → Save → בוחרים `setupSheet` → Run → מאשרים הרשאות.
4. Deploy → New deployment → Web app → Execute as: **Me** → Who has access: **Anyone** → Deploy → מעתיקים את הכתובת שמסתיימת ב-`/exec`.
5. ב-`content.json`: `"leads_url": "https://script.google.com/macros/s/.../exec"`, ו-`demo=false`. בונים מחדש.
   **הגנה:** כש-`demo=false` ו-`leads_url` ריק, הבנייה **נכשלת** עם הודעה ברורה. לטיוטה מעבירים `--allow-no-leads`: אז הטופס לא מציג "Thanks", אלא את הודעת הכישלון עם טלפון ו-SMS, כך שאף פנייה לא הולכת לאיבוד בשקט.
6. בדיקה: `testLead` מהעורך, ואחר כך פנייה אמיתית מהאתר. צריכה להופיע שורה בגיליון ומייל תוך דקה. אם השליחה נכשלת, מופיעה בעמוד הודעה עם טלפון ו-SMS, בלי alert.

השדות שנשלחים: `name, phone, zip, email, service, urgency, contact_pref, message, consent, source`. השדה הנסתר `website` הוא מלכודת בוטים. השרת בודק שיש שם, טלפון של 10 ספרות ו-ZIP, ומונע הזרקת נוסחאות לגיליון. אחרי שינוי ב-Code.gs: Manage deployments → Edit → New version (הכתובת לא משתנה).

---

## 9. פריסה: GitHub Pages + הדומיין של הלקוח

1. ריפו ללקוח: `gh repo create mlb-code/<slug>-site --public` (Pages בחינם דורש ריפו ציבורי בחשבון חינמי). **רק באישור מאיר.**
2. מעלים את תוכן תיקיית `site` לשורש הריפו (`index.html`, `services/`, `about/`, `reviews/`, `contact/`, `assets/`, `sitemap.xml`, `robots.txt`).
3. קובץ `CNAME` עם הדומיין בלבד, למשל `www.copperleafair.com`.
4. Settings → Pages → Deploy from branch `main` / root.
5. **DNS אצל הלקוח** (הדומיין רשום על שמו. מבקשים גישת delegate או שולחים לו הוראות):
   - `www` → CNAME → `mlb-code.github.io`
   - `@` → 4 רשומות A: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (או forwarding מ-@ ל-www אצל הרשם).
   - ב-Cloudflare: הרשומות במצב **DNS only** (ענן אפור) עד שה-HTTPS של GitHub מונפק.
6. אחרי ההתפשטות: Settings → Pages → **Enforce HTTPS**. מומלץ לאמת את הדומיין גם ב-Settings → Pages של הארגון (TXT), כדי שאף אחד לא יוכל לחטוף אותו.
7. **טיוטה:** אפשר לפרוס קודם ל-`https://mlb-code.github.io/<slug>-site/` עם `noindex=true` ו-`site_url` של הטיוטה. כל הקישורים יחסיים.
8. **יום העלייה:** `noindex=false`, `site_url` = הדומיין הסופי, בונים, push. אחר כך Search Console: אימות דומיין (TXT) ושליחת `sitemap.xml`, ובפרופיל העסק בגוגל (GBP): כתובת האתר ושעות זהות לאתר.

---

## 10. צ'קליסט QA (לפני שליחה ללקוח ולפני העלייה)

**גלילה אופקית ותצוגה**
- [ ] אין `left:-9999px` וכלום לא נדחף מחוץ למסך. התפריט הנייד מוסתר עם visibility/opacity בלבד. יש `html{overflow-x:clip}`.
- [ ] `node tools/overflow.mjs <5 הכתובות>`: הכל PASS ב-375/390/414/1280, ב-Chromium, WebKit ו-Firefox, ובלי שגיאות קונסול. (שרת מקומי: `python3 -m http.server 89xx -d <תיקייה>` בפורט פנוי, וסוגרים בסוף.)
- [ ] צילומים: `node tools/cdp-shots.mjs <url> <prefix> 1440 900 0 <port> '[0,900,1800]'` ו-`390 844 1`. לבדוק את ההירו, סרגל הפעולות התחתון בנייד (שלא מסתיר טקסט), הבאנרים והמפה.

**פונקציונליות**
- [ ] כל `tel:` בפורמט `+1XXXXXXXXXX`, וכל `sms:` נפתח עם הטקסט ההתחלתי באייפון ובאנדרואיד (`sms:+1...?&body=`).
- [ ] טופס: שגיאות ליד השדות (שם, טלפון של 10 ספרות, ZIP של 5 ספרות, הסכמה). שליחה אמיתית מגיעה לגיליון ולמייל. ההודעה מופיעה בתוך העמוד.
- [ ] התפריט הנייד נפתח ונסגר, Escape סוגר, Tab מראה פוקוס, "Skip to content" עובד.
- [ ] Lighthouse מובייל (`npx lighthouse@12.8.2 <url> --form-factor=mobile`): ביצועים ≥ 90, נגישות ≥ 95, SEO ≥ 95 (ב-noindex ה-SEO נופל בכוונה ל-66, ולכן בודקים SEO על build עם `noindex=false`).

**תוכן ומשפט**
- [ ] אין "demo", "sample", "{{" או "555-01" באתר לקוח: `grep -rniE "demo|sample|\{\{|555-01" <site>`.
- [ ] מספרי הרישיון והביטוח זהים למסמכים, ונבדקו באתר הרשות.
- [ ] ביקורות: אמיתיות, באישור, בלי עריכה שמשנה משמעות. בלי "guaranteed", "#1 in Houston" או "best" בלי מקור.
- [ ] מימון: רק הנוסח של הספק ("subject to credit approval"). בלי ריבית שלא אושרה.
- [ ] ביום העלייה: `grep -rn noindex <site>` ריק, ו-`robots.txt` כולל Sitemap.
- [ ] JSON-LD עובר ב-validator.schema.org וב-Rich Results Test. `og:image` נטען (Facebook Sharing Debugger).

---

## 11. כפתור ה-SMS: ‏10DLC ו-TCPA (חשוב, לא ייעוץ משפטי)

- **הכפתור עצמו** (`sms:`) רק פותח את אפליקציית ההודעות בטלפון של הגולש. הלקוח של העסק הוא זה ששולח את ההודעה הראשונה, כך שאין כאן שליחה יזומה מצד העסק.
- **התשובה של העסק** היא החלק הרגיש. אם העסק עונה מתוכנה (מספר וירטואלי, CRM, Twilio, ה-RCP שלנו) ולא מטלפון נייד רגיל, המספר חייב **רישום A2P 10DLC** (brand + campaign) אצל ספק ה-SMS. בלי רישום, הודעות נחסמות או מסוננות. ב-`RCP`/`BNDL` אנחנו מטפלים ברישום. ב-`WEB` לבד, הלקוח אחראי, וצריך להגיד לו את זה.
- **מספר נייח** לא מקבל SMS. אם אין מספר שמקבל הודעות, לא משאירים כפתור שלא עובד: או שמפעילים "text-enable" למספר אצל ספק (וגם זה דורש 10DLC), או שמסירים את כפתורי ה-Text מהתבנית (היום אין לזה מתג, זה שינוי קטן ב-`build.py`).
- **TCPA:** טקסט שיווקי (מבצעים, תזכורות שיווקיות) דורש הסכמה מפורשת בכתב. תשובה לפנייה של הלקוח מותרת, אבל: לזהות את העסק בהודעה הראשונה, להוסיף "Reply STOP to opt out", לכבד STOP מיד ולתמיד, ולא לשלוח בשעות שקטות (בדרך כלל 8pm–8am לפי השעה אצל הנמען. בחלק מהמדינות, כמו פלורידה ואוקלהומה, הכללים מחמירים יותר).
- **טופס:** תיבת ההסכמה ("I agree that … may call or text me … Reply STOP to opt out") נשמרת בגיליון בעמודה "Consent to call/text". לא מסמנים אותה מראש. אם הלקוח רוצה לשלוח גם שיווק, צריך תיבה נפרדת שאינה חובה, עם נוסח שעורך דין אישר.
- התבנית לא מקליטה ולא שולחת שום SMS בעצמה.
