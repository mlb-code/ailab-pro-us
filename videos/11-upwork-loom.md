# 11 · Upwork Loom (60 seconds + 20-second website cut)

status: draft, waiting for the owner's approval · narration in US English · screen only, no camera bubble

> **למאיר (בקצרה):** סרטון Loom אחד כללי שמקליטים פעם אחת ומצרפים להצעות באפוורק (לא אחד לכל משרה). מסך בלבד, בלי מצלמה. קול: שלך, בקצב רגוע (~140 מילים לדקה). לפני ההקלטה: חלון דפדפן נקי, זום 110%, בלי סימניות ובלי לשוניות אחרות. דף הצעת המחיר לדוגמה עובד רק מקומית: בטרמינל `make serve` ואז לפתוח את הכתובת שבשוט 4. הדמו מראה "Demo — no real booking is made", לא לחתוך את זה. אין שמות לקוחות, אין אחוזים, אין "מבטיח".

## A. 60 seconds — AI receptionist

| # | Time | Screen (what to record) | Spoken line |
|---|---|---|---|
| 1 | 0:00–0:06 | `https://ailabpro.co/` hero, cursor still. | "Hi, I'm Meir. Here's a one-minute look at the AI receptionist I build for service businesses." |
| 2 | 0:06–0:28 | `https://ailabpro.co/demo/` → click **AC blowing warm air** → tap the replies: "My AC is blowing warm air" → `77005` → "Tuesday 8 AM–12 PM" → "Mike Alvarez" → stop on the green **booked** card. | "Say a customer calls and you're on a job. The AI texts back in your business name. It asks what's wrong, checks the ZIP, offers two open time windows from your calendar, and books the job. You get a text and an email with the details." |
| 3 | 0:28–0:38 | Back to `https://ailabpro.co/#included`, slow scroll through the list. | "Phone calls work the same way. It answers when you can't, after hours too. Emergency words like a gas smell alert you right away." |
| 4 | 0:38–0:50 | Local sample quote: `http://localhost:8787/quote/?t=fixture` (run `make serve` first). Scroll from the price to "What's included" and "Not included". | "This is what a quote looks like. One fixed price, in writing, with what's included and what isn't. No hourly billing." |
| 5 | 0:50–1:00 | `https://ailabpro.co/#pricing`, hold on the price card. | "Setup is thirty-five hundred dollars plus three hundred a month. It goes live about ten business days after your checklist. Reply with the calendar you use, and I'll send a written scope." |

Word count of the spoken lines: about 140 (`python3 tools/proposals_check.py` prints it).

<!-- loom: rcp -->
```text
Hi, I'm Meir. Here's a one-minute look at the AI receptionist I build for service businesses.
Say a customer calls and you're on a job. The AI texts back in your business name. It asks what's wrong, checks the ZIP, offers two open time windows from your calendar, and books the job. You get a text and an email with the details.
Phone calls work the same way. It answers when you can't, after hours too. Emergency words like a gas smell alert you right away.
This is what a quote looks like. One fixed price, in writing, with what's included and what isn't. No hourly billing.
Setup is thirty-five hundred dollars plus three hundred a month. It goes live about ten business days after your checklist. Reply with the calendar you use, and I'll send a written scope.
```

## B. 20 seconds — website

| # | Time | Screen | Spoken line |
|---|---|---|---|
| 1 | 0:00–0:12 | `https://ailabpro.co/demo-site/home-services/` in a phone-width window (DevTools device mode, iPhone). Scroll the home page, tap past the **call** button, open **Contact** and show the form. | "This is a sample site for a demo HVAC company. Five pages, a call button on every screen, and a form that goes to your email and a Google Sheet." |
| 2 | 0:12–0:20 | `https://ailabpro.co/website/`, hold on the price. | "Nineteen hundred dollars plus one twenty-nine a month. Live seven business days after your content is in." |

<!-- loom: web -->
```text
This is a sample site for a demo HVAC company. Five pages, a call button on every screen, and a form that goes to your email and a Google Sheet.
Nineteen hundred dollars plus one twenty-nine a month. Live seven business days after your content is in.
```

## Production notes
- Prices are spoken in words. If `config/pricebook.json` changes (RCP $3,500 + $300, WEB $1,900 + $129), re-record. The checker compares the spoken numbers with the price book.
- Record at 1440×900 or larger; Loom's default quality is fine. No background music.
- Title in Loom: "AI receptionist — 60-second walkthrough" / "5-page website — 20-second sample". Share link set to "Anyone with the link".
- Before a contract, the Loom link goes in the proposal attachment field only. Never say or type a phone number, email or calendar link in the video (pages of ailabpro.co on screen are fine).
