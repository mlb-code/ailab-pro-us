# Thumbnail and poster-frame spec

> **תקציר למאיר:** תמונה ממוזערת לכל סרטון, באותה שפה עיצובית של האתר: רקע כחול כהה (navy), פס ענבר (amber), כותרת קצרה בגופן Noto Serif, ותווית קטנה ב-Space Mono. בלי פנים, בלי אנשים אמיתיים, בלי לוגו של צד שלישי. הטקסטים נלקחים מהטבלה למטה ושם המותג מ-`brand.json`. אפשר לייצר את כולם אוטומטית מ-HTML ולצלם עם `tools/cdp-shots.mjs`.

## Sizes
| Use | Size | Notes |
|---|---|---|
| Portal / email / landing poster | 1920×1080 (export 1280×720 JPG ≤ 200 KB too) | first frame of the MP4 = poster |
| Vertical (social, Upwork) | 1080×1920 | title in the top 60%; bottom 250 px kept empty |
| Email inline image | 1200×675 PNG with a ▶ badge | the email links to the portal page, never autoplays |

## Layout A (default)
- Background `--bg` (navy) with a subtle `--surface` (navy-2) card on the right 45% showing a cropped screenshot of the relevant screen (scene still), 18 px radius (`--radius`), 1 px `--line-2` border.
- Left 55%: eyebrow in `--mono` uppercase `--acc` (amber), e.g. `SETUP · STEP 2`; title in `--serif` 700, `--fg` (cream), max 2 lines, max 28 characters per line; one amber rule 6 px × 96 px under the title.
- Bottom-left: brand mark text from `brand.json` → `name` in `--sans` 600, `--fg-2`. No other brand string, no domain, no price.
- Duration chip bottom-right: `--mono`, `--fg` on `--surface-2`, e.g. `1:50`.
- Safe area: 64 px all sides (16:9), 96 px (9:16).

## Layout B (explainer and verification video)
- Full-bleed navy, centered title, no screenshot. Used for 10 (poster) and 90.

## Per-video text
| Video | Eyebrow | Title |
|---|---|---|
| 01-welcome | `WELCOME` | What happens now |
| 02-call-forwarding | `SETUP · STEP 1` | Forward your missed calls (cut name as a second chip: AT&T, Verizon, …) |
| 03-connect-calendar | `SETUP · STEP 2` | Connect your calendar |
| 04-hours-faq-alerts | `SETUP · STEPS 3–5` | Hours, FAQ and alerts |
| 05-sms-registration | `SETUP · STEP 7` | Your texting registration |
| 06-connect-other-tools | `SETUP · STEP 6` | Send leads to your other tools |
| 07-first-week | `YOU'RE LIVE` | Your first week |
| 08-monthly-report | `MONTHLY REPORT` | Reading your report |
| 09-website-handoff | `YOUR WEBSITE` | What you have now |
| 10-landing-explainer | `60 SECONDS` | What happens to a missed call |
| 90-google-verification | `GOOGLE OAUTH REVIEW` | Calendar access demo |

Step numbers follow the B7 checklist order: 1 forwarding · 2 calendar · 3 hours · 4 FAQ · 5 emergency & alerts · 6 Zapier · 7 texting registration & go-live.

## Production
- Build each thumbnail as a small HTML page that loads `site/assets/base.css` (tokens) and `config/brand.json` (name), then capture: `node tools/cdp-shots.mjs file:///…/thumb-03.html out/thumb-03 1920 1080 0`.
- Rules: no faces or people, no third-party logos (Google, Calendly, carriers are written as plain text), no "#1", no results or percentages, cream-on-navy contrast only.
