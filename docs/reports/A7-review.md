# A7 · ביקורת חוזרת — APPROVE

- **בדיקות שהרצתי בעצמי:** `make qa-admin` (פורט 8971) נתן e2e **77/0** ו-overflow **228/0**. `make qa-start` (פורט 8973) נתן **116/0** ו-**516/0**. `deno test supabase/functions` עבר 41/0. `sync_config --check` לא מצא drift. `check_hardcoded` ו-`check_secrets` החזירו 0.
- **מודול תמחור אחד:** `admin-pricing.js` נמחק. `site/assets/pricing.mjs` זהה בבתים ל-`_shared/pricing.mjs`, ו-`pricing.ts` הוא רק מעטפת טיפוסים מעליו. בשרת הבדיקה הדפדפן טוען אותו עם `200 text/javascript`, בלי שגיאות קונסול.
- **4 המקרים שנכשלו קודם:** הרצתי את `window.AdminCalc` מול `priceQuote` של השרת, עם אישור ידני ובלי. התוצאות זהות בכל המקרים:
  - `BNDL+ADD-CHAT`: `already_included`.
  - קוד כפול: `duplicate_code`.
  - כמות 11: `bad_qty`.
  - `MAP`: חסום בלי אישור, וניתן לשליחה רק עם `manual_approved`.

  בממשק: בבורר אין קודים שכבר בהצעה, הכמות מוגבלת ל-10, ו-MAP בלי "בדקתי" נשאר `draft` עם הודעה בעברית.
- **תקרת FOUNDING** נאכפת עכשיו גם בשרת (`founding_limit_reached` ב-`quote_engine.ts`).
- **תיקוני UI ב-390:** התווית `(FOUNDING)` מוצגת נכון (`11-founding-label-390.png`). התקציר היומי סגור במובייל, והלשוניות מתחילות ב-316px (`12-digest-collapsed-390.png`). ביומן אין יותר סוגי אירועים לא מתורגמים. בהגדרות מוצגים כללי ההחזרים ו-overage_policy. 0 גלישה ב-375/390/414/1280.
- **פתוח ומנותב נכון:** `admin_log_event` ל-A8/A1. view/RPC לנתוני `runtime_state` לאדמין ל-B7. MIME של `.mjs` צריך להיות `text/javascript` גם באירוח בפועל.
