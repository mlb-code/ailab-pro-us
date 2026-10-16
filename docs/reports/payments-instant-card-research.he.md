# תשלום מיידי בכרטיס בדף ההצעה — מחקר והמלצה

תאריך: 16.10.2026 · פרויקט: AI Lab Pro US (ailabpro.co) · סטטוס: מחקר בלבד, לא שונה קוד.

## תקציר

1. **PayPal Business הוא הדרך היחידה הריאלית לכפתור "שלם עכשיו בכרטיס" על הדף שלנו** לעוסק מורשה ישראלי. תשלום אורח בכרטיס (בלי חשבון PayPal) זמין בישראל; Apple Pay / שדות כרטיס משובצים / שמירת כרטיס **לא** זמינים לסוחר ישראלי (ישראל לא ברשימת 37 המדינות).
2. **הלקוחות שלנו כבר מכירים את התבנית** "Approve & Pay Deposit" (ככה Jobber עובד מול הלקוחות שלהם). הכפתור צריך לשבת באותו מסך מיד אחרי ה-Accept, עם שלושה משפטי ביטחון לידו.
3. **הכסף החודשי**: לא לוכדים כרטיס במקדמה. בשלב ה-go-live הלקוח משלם את ה-50% השני ומאשר מנוי PayPal של $300/חודש שמתחיל ביום העלייה לאוויר.
4. **Upwork Direct Contracts** נשאר כפתור משני "תשלום עם הגנת Upwork"; **Payoneer** לחשבון קבלה בדולרים (ACH לסכומים גדולים). **Wise עסקי לא זמין בישראל**; Paddle / Lemon Squeezy אוסרים שירותים; טרנזילה בדולרים תלויה באישור הסולק שעדיין אין.
5. **מאמץ**: ~3–5 ימי עבודה של סוכן + 2–3 שעות של מאיר (פתיחת חשבונות ומפתחות). עלות: ~5.2% מכל תשלום (PayPal + מע"מ על העמלה), עוד ~3% אם ממירים לשקל בתוך PayPal.

---

## 1. מה גורם לבעל עסק אמריקאי לשלם $1,000–2,500 מיד, בלי שיחה

| ממצא | מה זה אומר לנו | מקור |
|---|---|---|
| **הלקוחות שלנו רגילים לתבנית הזו.** ב-Jobber, כשיש מקדמת חובה, כפתור המייל הוא "Review & Pay Deposit", בפורטל "Approve and Pay Deposit", ואז חתימה בשם. התשלום מעדכן את הסטטוס אוטומטית, וניתן לשמור כרטיס/ACH לעתיד. | לשים את כפתור התשלום **באותו מסך של ה-Accept**, לא במייל נפרד; המייל רק מוביל לדף. | [help.getjobber.com/deposits-on-quotes](https://help.getjobber.com/en/articles/deposits-on-quotes/) |
| **מתחרי ה-AI receptionist לא גובים הקמה**: Dialzara $29–349/חודש + 7 ימי ניסיון; Rosie $49–299; My AI Front Desk $79–149; Smith.ai מ-$150 לפי שיחות. | $3,500 הקמה נתפס כ"סוכנות שעושה בשבילי", לא כתוכנה. ליד הכפתור חייב להופיע "אנחנו מקימים הכל" + "את השאר משלמים רק אחרי שבדקת". | [dialzara.com/pricing](https://dialzara.com/pricing/), [cloudtalk.io/blog/rosie…](https://cloudtalk.io/blog/rosie-ai-answering-service-pricing), [myaifrontdesk pricing](https://llms.myaifrontdesk.com/pricing-usage), [cloudtalk smith.ai](https://cloudtalk.io/smith-ai-pricing/) |
| **אתרים לבעלי מקצוע**: 50% מקדמה / יתרה לפני עלייה לאוויר הוא הסטנדרט; מעל ~$1,000 יש שמחלקים לשלישים; מודל "pay monthly" $99–349 עם התחייבות 12 חודשים. | 50/50 שלנו תואם לשוק. לא צריך שינוי. | [aspnix payment terms](https://aspnix.com/posts/what-are-the-payment-terms), [FIU EWS](https://ews.fiu.edu/invoice/7242/), [redefineweb](https://redefineweb.com/services/pay-monthly-websites-design-smb/) |
| **Designjoy** (מנוי עיצוב $4,995/חודש) נמכר ישירות מדף התמחור בכרטיס, "pause/cancel anytime"; מתחרה טוען 75% החזר תוך 7 ימים ⚠ לא אומת. | המודל "קודם מנוי, אחר כך שיחה אם רוצים" עובד גם בסכומים גבוהים כשההבטחה פשוטה והיציאה קלה. | [designjoy.co](https://designjoy.co/), [manypixels השוואה](https://www.manypixels.co/blog/get-a-designer/manypixels-vs-designjoy) |
| **הצעות עם תשלום מובנה**: 76% מההצעות ב-Better Proposals שולמו דרך הפלטפורמה; תשלום ממוצע ~5 שעות אחרי חתימה; שליחה תוך 24 שעות = +42% המרה (נתוני ספק). | ההצעה תוך יום עסקים אחד + כפתור תשלום על הדף = בדיוק המודל שלנו. | [betterproposals.io/reports/2022](https://betterproposals.io/reports/2022/) |
| **Baymard**: 19% נוטשים כי לא סמכו על האתר עם הכרטיס, 18% כי נדרש לפתוח חשבון, 17% תהליך ארוך. חותמות: Norton (~36%) ו-McAfee (~23%) הכי מוכרות, אבל סקר העדפה ≠ המרה; מה שמוכח: אייקון + מיקרו-קופי מרגיע **ליד שדות התשלום**. | תשלום אורח (בלי חשבון), מעט שדות, ומשפטי ביטחון צמודים לכפתור. חותמת אבטחה קנויה לא חובה. | [baymard cart-abandonment](https://baymard.com/lists/cart-abandonment-rate), [baymard site-seal-trust](https://baymard.com/blog/site-seal-trust) |
| **תשלומים (BNPL)**: PayPal Pay Later רק לסוחר אמריקאי; Affirm/Klarna צרכניים; B2B BNPL (Resolve, Balance) מיועד לפלטפורמות ומפיצים. | לא רלוונטי. "תוכנית התשלומים" שלנו היא 50/50. | [paypal pay-later overview](https://developer.paypal.com/pay-later/overview.md), [resolvepay](https://resolvepay.com/blog/pastpay-alternatives) |
| **מעקב אחרי הצעה פתוחה**: בתעשייה מדברים על 3 נגיעות (ימים 1/3/7) ו-+28% סגירות מרצף אוטומטי ⚠ מספרים לא מאומתים (בלוגים של ספקים). | כבר יש לנו quote_reminder + quote_expiring. מספיק. | [ustechautomations](https://ustechautomations.com/resources/blog/home-services-chase-unsigned-estimates-with-timed-followups-recipe-2026) |
| **ACH לסכומים גדולים**: נהוג בארה"ב, עמלה ~1% במקום ~4%. | אפשרות "העברה בנקאית" לחבילה ($2,450 מקדמה) דרך חשבון קבלה USD ב-Payoneer. | [payoneer pricing](https://www.payoneer.com/about/pricing/) |

**מסקנה**: מה שמשכנע הוא לא לוגו אבטחה אלא (1) כפתור במקום הנכון, (2) בלי פתיחת חשבון, (3) שלוש הבטחות קצרות ליד הכפתור: החזר מלא 7 ימים, השאר רק אחרי הבדיקה, אחריות 30 יום, (4) שם עסק וכתובת אמיתית, (5) קבלה במייל מיד.

## 2. מה כבר קיים אצלנו, ומה חסר

**קיים היום** (נבדק בקוד):

| רכיב | מה יש | קובץ |
|---|---|---|
| שדות תשלום בהצעה | `pay_method` (paypal_link / upwork / wire / tranzila_link) + `pay_link` (https בלבד), ממולאים **ידנית** באדמין: "קישור תשלום (לא חובה; בלי קישור הלקוח רואה שהקישור יגיע בהמשך)" | `supabase/migrations/20261011100000_us_schema.sql`, `site/start/assets/admin.js` |
| דף ההצעה | Accept = שם + תיבת הסכמה → `quote-accept`. אחר כך `#pay-slot`: אם יש `pay_link` – כפתור "Pay deposit $X" (טאב חדש) + "Secure payment page…"; אחרת הודעה "We'll email your secure payment link for the $X deposit within 1 business day." | `site/quote/assets/quote.js` (paySlot), `site/assets/quote_view.mjs` |
| מיילים | quote_sent (כפתור לדף); quote_accepted (כפתור תשלום רק אם יש pay_link); admin_quote_accepted (עברית, מזכיר אם חסר קישור); deposit_received (אחרי סימון ידני); final_payment_due ו-monthly_invoice אומרים "We'll email your secure payment link"; web_deposit_ack (אתר נמכר "ישירות", אבל בפועל מאיר שולח קישור ביד) | `supabase/functions/_shared/email/templates.ts` |
| טבלת תשלומים | `payments` (deposit/final/monthly/overage; due/paid/refunded; reference, paid_at). "סמן כשולם" באדמין → טריגר פותח צ'ק-ליסט ושולח deposit_received | `…us_portal_b7.sql`, `…us_email_events.sql`, `admin-backend.js` |
| פורטל | לשונית Billing (רשימת תשלומים); "Request go-live … We send the final payment link" | `site/start/assets/portal-b.js` |
| משפטי | Terms §6–7 ו-Service Agreement §4–6: 50/50, חידוש אוטומטי חודשי מראש, ביטול 30 יום, השהיה אחרי 10 ימי איחור, החזרים; אמצעי תשלום "כפי שנקוב בהצעה (Upwork, PayPal, העברה)" | `site/legal/terms`, `site/legal/service-agreement` |
| תכנון | SPEC §2.4: Edge Function `pay-create` שמחזירה URL לפי ספק, אותו slot | `docs/SPEC.md` |

**חסר**: (1) checkout מיידי על הדף (אין PayPal SDK, אין `pay-create`); (2) webhook שמסמן "שולם" לבד — היום הכל ידני; (3) קבלה אוטומטית (deposit_received נשלח רק אחרי לחיצה של מאיר); (4) לכידת אמצעי תשלום לחיוב חודשי — monthly_invoice מבטיח "נשלח קישור" כל חודש ביד; (5) כפתור תשלום סופי בפורטל ב-go-live; (6) שדות ספק בטבלת payments (מזהה הזמנה, מזהה חיוב, מייל המשלם); (7) שורת הסכמה לחיוב חוזר ליד כפתור המנוי; (8) כפתור החזר באדמין (החזר 7 ימים).

## 3. אפשרויות לעוסק ישראלי

| ערוץ | פתוח לעוסק מורשה? | כרטיס / Apple Pay / ACH | חיוב חודשי | עמלה מלקוח בארה"ב | כסף לישראל | מאמץ | סיכונים |
|---|---|---|---|---|---|---|---|
| **PayPal Business (IL)** | כן | כרטיס אורח בלי חשבון: **כן** (הגדרה "חשבון PayPal אופציונלי" אחרי אימות). Apple/Google Pay, שדות כרטיס משובצים, שמירת כרטיס: **לא** (ישראל לא ב-37 המדינות). ACH: לא | Subscriptions API זמין; ⚠ לא אומת אם משלם בלי חשבון PayPal יכול להצטרף למנוי אצל סוחר ישראלי (בלוג ישן אומר שלא) — לבדוק בסנדבוקס. גיבוי: PayPal Invoicing חודשי אוטומטי | 3.4% + 1% בינלאומי + $0.30 ≈ **4.4%**; עם מע"מ על העמלה ≈ 5.2%. מחלוקת: $8 | משיכה בשקלים מ-1,000 ₪ חינם, אבל המרה **2.5% (+מע"מ 2.95%)**. משיכה לחשבון אמריקאי $35. ⚠ משיכת דולרים לחשבון דולרי בבנק ישראלי – לא אומת | נמוך-בינוני (SDK + 2 פונקציות) | החזקת כספים עד 21 יום בהתחלה (שירות: לסמן "Completed" → שחרור אחרי 7 ימים); רזרבה אפשרית (דוגמה: 15% ל-45 יום); הגנת מוכר לשירותים קיימת בישראל מ-2024 עם הוכחת אספקה |
| **Payoneer** | כן (חברה ישראלית, רישיון ישראלי 09.2026) | Request a Payment: כרטיס עד **3.99% + $0.49**; ACH 1% (משלם אמריקאי); חשבון קבלה USD (ACH/wire) חינם או 1% ⚠ לוודא בחשבון. Apple Pay: לא | אין חיוב אוטומטי (בקשה כל חודש ידנית/API ארגוני) | ראו משמאל | משיכה עם המרה 1.2–4%; $29.95 לשנה אם פחות מ-$6,000 | נמוך (קישור/פרטי בנק) | Payoneer Checkout (סליקה באתר) דורש חברה בהונג-קונג ו-$10–20k/חודש → לא רלוונטי |
| **טרנזילה בדולרים** | יש מסוף | תלוי באישור הסולק למט"ח/כרטיסים זרים — **עדיין אין** (Apple Pay החזיר 418). כשיאושר: iframe עם פרמטר מטבע USD | הוראת קבע בטוקן — ⚠ בדולרים לא אומת | עמלת כרטיס זר אצל סולקים ישראלים גבוהה פי ~3 מכרטיס מקומי (רשות התחרות) ⚠ למסוף שלנו לא ידוע | ישיר לבנק, ההמרה אצל הסולק | בינוני | ייתכן שהאישור לא יגיע; לקוח אמריקאי רואה דף תשלום ישראלי |
| **Upwork Direct Contracts** | כן | הלקוח משלם בכרטיס/בנק בתוך Upwork, escrow, Payment Protection; הלקוח **חייב לפתוח חשבון Upwork** | אבני דרך חודשיות ידניות או חוזה שעתי — לא נוח | אנחנו: 5%, או **0% עם Freelancer Plus ($19.99/חודש)**. הלקוח: ~5% (3% ב-ACH) + דמי פתיחה ⚠ $0.99–14.99 (לא אומת רשמית) | לבנק/Payoneer | נמוך | פחות "מיידי" (הזמנה + חשבון); מחלוקות לפי Upwork |
| **Wise Business** | **לא** — בישראל יתרות רק לחשבון פרטי | — | — | — | — | — | לרדת מזה |
| **Paddle / Lemon Squeezy** (MoR) | לא | Paddle: "שירותים אנושיים ללא תוכנה" אסורים; Lemon Squeezy: שירותים/ייעוץ אסורים | — | — | — | — | אימות מחדש: עדיין לא מתאים |
| **2Checkout (Verifone)** | ישראל לא ברשימת המדינות החסומות; ⚠ מדיניות שירותים לא ברורה | כרטיס כן | מנויים כן (2Subscribe) | ⚠ ~3.5% + $0.35 לא אומת | — | גבוה | לפנות בכתב רק אם PayPal ייכשל |
| **Rapyd** | ישראלית, מרחיבה סליקה בישראל; מחירון לא פומבי, KYB ארגוני | כרטיס + ACH | כן | לא פומבי | כן | גבוה | מיועד לעסקים גדולים יותר; "פלאן ב'" |

## 4. המלצה

### 4.1 עיצוב דף ההצעה (אחרי Accept, אותו מסך, בלי רענון)

```
✔ Accepted by Dan Cohen · Service Agreement v1.1
──────────────────────────────────────────
Pay your deposit: $1,750
[ Pay $1,750 by card ]        ← PayPal SDK, כפתור "Debit or Credit Card" ראשון
[ PayPal ]                    ← כפתור PayPal שני
Secure checkout by PayPal. No PayPal account needed. Receipt by email within a minute.

• Changed your mind? Full refund within 7 days.
• The other 50% is due only after you test your own line.
• 30-day satisfaction guarantee on the AI receptionist.   (רק RCP/BNDL)

Prefer Upwork's escrow protection? → Pay through Upwork (we'll send the invite)
Paying $2,000 or more? → Pay by bank transfer (ACH, no card fee)
AI Lab Pro · 7 Sokolov St., Herzliya, Israel · support@ailabpro.co
```

- שני המשפטים הראשונים מגיעים מ-`pricebook.json → refund_rules` (לא מקלידים מספרים).
- "Pay through Upwork" = בקשה שנרשמת בהצעה (`pay_method=upwork`) ומייל למאיר לשלוח Direct Contract. "Bank transfer" = מייל אוטומטי עם פרטי חשבון ה-USD ב-Payoneer; סימון "שולם" ידני.
- ההודעה "We'll email your secure payment link" נשארת רק כשאין PayPal מוגדר.

### 4.2 מתי לוכדים את הכרטיס לחודשי

בשלב **Request go-live** בפורטל, לא במקדמה: (1) כפתור "Pay final $1,750" (אותו SDK); (2) כפתור "Start monthly plan $300/mo from go-live" = PayPal Subscription עם תאריך התחלה = יום העלייה לאוויר, ומתחתיו שורה: "You authorize AI Lab Pro to charge $300 monthly from go-live until you cancel (30 days' notice)". ה-go-live נפתח רק אחרי שניהם. אם יתברר בסנדבוקס שמנוי דורש חשבון PayPal אצל המשלם — גיבוי: PayPal Invoicing אוטומטי ב-1 לחודש (תשלום בכרטיס בלי חשבון), במקום "נשלח לך קישור".

### 4.3 תוכנית ביצוע

**מאיר (ידני, ~2–3 שעות):**
1. פותח PayPal Business, מאמת מייל + בנק + זהות; מפעיל "חשבון PayPal אופציונלי" (הגדרות → תשלומי אתר → העדפות אתר).
2. ב-developer.paypal.com יוצר אפליקציה (Sandbox + Live) ומוסר Client ID + Secret לסודות Supabase (לא לריפו).
3. אחרי הפריסה: מדביק את כתובת ה-webhook שאקבל ממני ומאשר את רשימת האירועים.
4. פותח חשבון Payoneer עם חשבון קבלה USD (ל-ACH). אופציונלי: Freelancer Plus ב-Upwork.
5. במקביל, בלי תלות: שואל את הסולק של טרנזילה על סליקת USD/כרטיסים זרים.
6. מאשר את הטקסטים ליד הכפתורים.

**Claude/Opus בונה:**

| שלב | מה | מאמץ |
|---|---|---|
| A | `pay-create` (יוצר הזמנת PayPal למקדמה/סופי לפי token; הסכום מה-DB, לא מהדפדפן) + `pay-capture` (לכידה בשרת) + כפתורי SDK בדף ההצעה (fixture mode ממשיך לעבוד) | ~1–1.5 יום |
| B | `paypal-webhook` (אימות חתימה; CAPTURE.COMPLETED/REFUNDED/DISPUTE → `payments` paid/refunded, אידמפוטנטי) — הטריגרים הקיימים שולחים deposit_received ופותחים צ'ק-ליסט לבד; מייל `payment_receipt` קצר (סכום, 4 ספרות אחרונות, מספר אסמכתה) | ~1 יום |
| C | פורטל: כפתור תשלום סופי + מנוי ב-go-live; webhook ל-BILLING.SUBSCRIPTION.* → שורות monthly אוטומטיות; monthly_invoice הופך לקבלה | ~1–1.5 יום |
| D | מיגרציה: `payments.provider / provider_order_id / provider_capture_id / payer_email`; ערך `paypal_checkout` ב-pay_method; אדמין: סטטוס ספק + כפתור "החזר" (PayPal Refund API) ל-7 ימים | ~0.5 יום |
| E | משפטי: Terms §6 + Service Agreement §4 מוסיפים "card/PayPal checkout" ושורת הסכמה לחיוב חוזר; `docs/SPEC.md` §2.4 | ~0.5 יום |
| F | בדיקות e2e בסנדבוקס + `tools/e2e_quote.mjs` | כלול |

**עלויות שוטפות**: מקדמה $1,750 → ~$77 עמלת PayPal (+~$14 מע"מ על העמלה) ≈ 5.2%; חודשי $300 → ~$14. אם ממירים לשקל בתוך PayPal: עוד ~2.95%. Upwork: 0% לנו עם Plus ($19.99/חודש), הלקוח משלם ~5% + דמי פתיחה. Payoneer ACH: ~1%. אין עלות קבועה ב-PayPal.

**הקטנת סיכונים**: בתשלומים הראשונים לסמן בפעילות PayPal "Service → Completed" (שחרור אחרי 7 ימים במקום 21); לשמור הוכחות אספקה (לוג פורטל, תאריך go-live, מיילים) להגנת מוכר; לא להקפיץ נפח פתאום; להשאיר את Upwork כחלופה ללקוח זהיר; לענות למחלוקת תוך יומיים.

## מה לא אומת (לבדוק לפני בנייה)

- האם מנוי PayPal נפתח למשלם **בלי** חשבון PayPal כשהסוחר ישראלי (סנדבוקס, 30 דקות).
- האם PayPal ישראל מאפשר משיכת דולרים לחשבון דולרי בבנק ישראלי (עמוד העמלות מציין רק שקלים או בנק אמריקאי).
- עמלת ACH/חשבון קבלה USD ב-Payoneer לחשבון ישראלי (נראית בחשבון אחרי פתיחה).
- דמי פתיחת חוזה ב-Upwork Direct Contracts (מקורות צד ג' נעים בין $0.99 ל-$14.99).
- עמלת כרטיס זר בטרנזילה למסוף של מאיר, ואם יאושר USD בכלל.

## מקורות עיקריים

PayPal: [עמלות סוחר ישראל](https://www.paypal.com/il/webapps/mpp/merchant-fees) · [רשימת מדינות Expanded Checkout](https://developer.paypal.com/docs/checkout/advanced/eligibility) · [שמירת כרטיס — מדינות](https://developer.paypal.com/sdk/js/save-with-purchase/cards.md) · [תשלום אורח ישראל](https://www.paypal.com/il/cshelp/article/how-do-i-accept-credit-cards-using-guest-checkout-with-paypal-express-checkout-ts1623) · [הגנת מוכר ישראל 2024](https://paypal.com/il/webapps/mpp/ua/seller-protection) · [החזקת כספים לחשבון חדש](https://paypal.com/pf/cshelp/article/nouveau-compte-paypal%20-paiements-suspendus-et-acc%C3%A8s-plus-rapide-%C3%A0-votre-argent-help848) · [רזרבות](https://www.paypal.com/uk/cshelp/article/what-are-reserves-help393) · [Subscriptions](https://developer.paypal.com/docs/subscriptions/) · [Pay Later](https://developer.paypal.com/pay-later/overview.md)
Payoneer: [מחירון 01.2026](https://www.payoneer.com/about/pricing/) · [Request a Payment עמלות](https://payoneer.custhelp.com/app/answers/detail/a_id/33927) · [רישיון ישראל 09.2026](https://investor.payoneer.com/news-releases/news-release-details/payoneer-secures-payment-license-israel-expanding-global) · [Payoneer Checkout — הונג-קונג](https://community.shopify.com/t/is-payoneer-checkout-not-available-in-uae/258149)
Upwork: [Direct Contracts](https://support.upwork.com/hc/en-us/articles/360025040794) · [מחירון לקוחות](https://upwork.com/pricing/client) · [Freelancer Plus](https://www.upwork.com/resources/is-upwork-free)
Wise: [איפה אפשר לפתוח יתרה](https://www.wise.com/help/articles/2813542/where-can-i-open-a-wise-balance)
MoR: [Paddle — מה אסור](https://paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) · [Lemon Squeezy — מוצרים אסורים](https://docs.lemonsqueezy.com/help/getting-started/prohibited-products) · [2Checkout מדינות](https://verifone.cloud/docs/2checkout/Onboarding/Get-started-with-your-2Checkout-account/Restricted-countries-and-territories)
שוק: [Jobber deposits](https://help.getjobber.com/en/articles/deposits-on-quotes/) · [Baymard נטישה](https://baymard.com/lists/cart-abandonment-rate) · [Baymard חותמות](https://baymard.com/blog/site-seal-trust) · [Better Proposals 2022](https://betterproposals.io/reports/2022/) · [Dialzara](https://dialzara.com/pricing/) · [Smith.ai](https://cloudtalk.io/smith-ai-pricing/) · [Designjoy](https://designjoy.co/) · [טרנזילה — רישיון סולק](https://www.boi.org.il/en/communication-and-publications/press-releases/the-bank-of-israel-grants-a-permanent-acquirer-s-license-to-tranzila-ltd-as-part-of-the-steps-to-advance-competition-in-the-israeli-payment-and-settlement-market/)
