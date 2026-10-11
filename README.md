# AI Lab Pro US

פלטפורמה למכירה ומסירה של שירותי AI לעסקים קטנים בארה"ב, בלי שיחות טלפון:
דף נחיתה לפי נישה ← הדגמה ← שאלון ← הצעת מחיר קבועה (Claude מנסח, מאיר מאשר) ← תשלום ← צ'ק-ליסט עם סרטונים ← מוצר שרץ ← ריטיינר.
המוצר הראשון: **Missed-Call AI Receptionist** ($3,500 + $300 לחודש). השני: אתר לעסק ($1,900 + $129 לחודש).

## מה יש כאן
| תיקייה | מה |
|---|---|
| `docs/` | `SPEC.md` (המפרט, בעברית) · `TASKS.md` (משימות לסוכנים) · `PRICEBOOK.md` (מחירון) |
| `config/` | שם המותג, הדומיין והמחירים במקום אחד |
| `site/` | האתר (אנגלית), השאלון, פורטל הלקוח, האדמין (עברית) |
| `supabase/` | מסד הנתונים והפונקציות (פרויקט `ailab-us`) |
| `runtime/` | השירות שעונה לטלפון וקובע ביומן (Railway) + סימולטור |
| `templates/`, `videos/`, `tools/` | תבניות מסירה, סרטונים, כלי הקמה ובדיקה |

## דרישות קדם (פעם אחת במחשב)
| כלי | גרסה | למה | בדיקה |
|---|---|---|---|
| Python | 3.12 ומעלה | כלי בדיקה, הגדרות, סימולטור | `python3 --version` |
| Node | 24 | בדיקות דפדפן (Playwright, Puppeteer) | `node -v` |
| Deno | 2.x | בדיקות של Edge Functions ושל SQL (PGlite) | `deno --version` |
| make | כל גרסה (מגיע עם Xcode CLT) | פקודות הבדיקה | `make -v` |
| Google Chrome | מותקן ב-Applications | צילומים ובדיקות Puppeteer | — |
| Pillow | לא חובה | רק ל-`tools/grid.py` | `python3 -c "import PIL"` |

התקנה בתוך הריפו (לא גלובלית):
```
cd ~/Desktop/ailab-pro-us && make install
```
✅ הצלחה: מופיע `added N packages`. במחשב חדש, שעוד אין בו דפדפני Playwright, מריצים פעם אחת `npx playwright install chromium webkit firefox`.

## בדיקות
```
cd ~/Desktop/ailab-pro-us && make qa
```
זו בדיקה מלאה: בדיקות סטטיות, 3 דפדפנים, Deno ו-SQL אופליין. לוקחת כמה דקות.
✅ הצלחה: השורה האחרונה היא `make qa: all checks passed`.
- `make qa-fast`: רק הבדיקות הסטטיות, בערך שנייה. את זו מריץ GitHub לפני כל פרסום.
- כל חבילה מרימה שרת על פורט פנוי משלה, ולכן אין התנגשות פורטים. עדיין עדיף להריץ `make qa` רגיל ולא `-j`: כשהמחשב עמוס, Firefox ו-Playwright נתקעים על timeout.

## איך מריצים מקומית
האתר:
```
cd ~/Desktop/ailab-pro-us && make serve
```
ואז לפתוח בדפדפן: http://localhost:8787
✅ הצלחה: מופיע דף הנחיתה באנגלית.

הסימולטור (שיחות ו-SMS בלי Twilio):
```
cd ~/Desktop/ailab-pro-us/runtime && .venv/bin/python -m sim serve
```
ואז לפתוח: http://localhost:8000/sim
✅ הצלחה: חלון צ'אט שבו אפשר "להתקשר" לעסק הדמו.

## פרסום (GitHub Pages)
`.github/workflows/pages.yml` מפרסם את תיקיית `site/` בכל push ל-main, אבל רק אם `make qa-fast` עבר.
פעם אחת בהגדרות הריפו: Settings ← Pages ← Source: **GitHub Actions**.
הדומיין נלקח מ-`config/brand.json`: הקובץ `site/CNAME` נכתב על ידי `python3 tools/sync_config.py`.

## חשוב
- סודות רק בקובץ `.secrets.env` (לא נכנס ל-git). לא מדביקים מפתחות בשום מקום אחר.
- אין push ואין העלאה לאוויר בלי אישור של מאיר.
- מצב נוכחי (11.10.2026): שלב א' בנוי ונבדק מקומית מול backend מדומה. ממתין לפרויקט Supabase ולדומיין.
