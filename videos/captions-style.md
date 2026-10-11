# Captions style (all videos)

> **תקציר למאיר:** כתוביות באנגלית לכל הסרטונים, מתוך הטקסט המדויק של התסריט (לא מתמלול אוטומטי), עם תזמון מהקריינות. ברירת מחדל: קובץ `.vtt` נפרד שאפשר לכבות. רק בסרטון 10 (דף הנחיתה, מתנגן בלי קול) הכתוביות צרובות בתמונה. הצבעים והגופנים נלקחים מאותם משתנים של האתר (`site/assets/base.css`), ושם המותג מ-`config/brand.json`. אין ערכים קשיחים של מותג.

## Source of truth
- **Text:** the rendered narration, `python3 videos/vo_length.py --export videos/<NN-name> [--variant <cut>]`. Tokens such as `{{brand.name}}` are resolved from `config/brand.json` / `config/pricebook.json` at that moment; never type the brand name or a price into a caption file by hand.
- **Timing:** the TTS provider's word/character timestamps (ElevenLabs "with timestamps" output). If a voice without timestamps is used, align with a forced-alignment pass on the known text. Never use speech-to-text output as the text.
- **Files:** `<NN-name>/<cut>.en.vtt` next to the MP4 in the `videos-public` bucket (SPEC §4 storage), e.g. `videos-public/onboarding/02-call-forwarding/att-v1.mp4` + `att-v1.en.vtt`.

## Line rules
| Rule | Value |
|---|---|
| Max lines on screen | 2 |
| Max characters per line | 42 (16:9) · 32 (9:16) |
| Min / max cue duration | 1.0 s / 6.0 s |
| Reading speed | ≤ 17 characters per second; split long sentences at commas or "and" |
| Line breaks | break after punctuation, never between a number and its unit ("20 seconds"), never inside a code (`**61*1XXXXXXXXXX**20#`) |
| Numbers | as digits in captions even when the voice says words ("911", "80%", "1–2 weeks") |
| Codes | carrier codes, URLs and button names in `--mono`, never broken across lines; if a code is longer than one line, it goes in an on-screen card instead of the caption |
| Button / tab names | exactly as on screen, Title Case as the UI shows it ("Need help", "Connect Calendly", "My receptionist") |
| Speaker labels | none (one narrator). In motion-graphics conversations, caller/receptionist lines are on-screen bubbles, not captions |
| Sound cues | none except `[phone rings]` in 02 S2 and 10 S1 |

## Look (burned-in captions and on-screen text)
Values come from the design tokens in `site/assets/base.css` (built in A3 from `config/brand.json`); name the token, not the hex, in edit presets.

| Element | Token / value |
|---|---|
| Caption text | `--fg` (cream) on a box of `--bg` (navy) at 85% opacity, radius `--radius-sm`, padding 10/16 px |
| Caption font | `--sans` (Noto Sans), 600 weight, 44 px at 1080p (16:9) · 52 px at 1080×1920 |
| Caption position | bottom-center, 72 px safe margin (16:9) · lower third above the 250 px platform UI zone (9:16) |
| Emphasis (one word per cue at most) | `--acc` (amber) text, no underline |
| On-screen titles | `--serif` (Noto Serif) 700, `--fg`; eyebrow label `--mono` (Space Mono) uppercase, `--acc` |
| Status words (Connected, Done) | `--ok`; warnings ("Verify with your carrier") `--warn` |
| Focus highlight on UI | 3 px ring like `--focus` (amber 55%), 400 ms ease `--ease` |
| Fine print | `--fg-2`, 28 px, max 2 s on screen per 10 words |

Contrast: cream on navy is the site's AA-checked pair; don't place captions over raw screenshots without the navy box.

## Sidecar VTT template
```
WEBVTT

00:00:00.000 --> 00:00:03.200
Welcome aboard.
Your deposit is in, and your setup has started.
```
