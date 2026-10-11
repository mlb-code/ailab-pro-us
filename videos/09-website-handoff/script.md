# 09 · Your new website: the handoff

target_seconds: 120
status: draft, waiting for the owner's approval · narration in US English · max 120 wpm

> **תקציר למאיר:** ללקוחות WEB (וגם BNDL) ביום העלייה. סיור ב-5 העמודים, כפתורי החיוג וה-SMS, לאן מגיעים לידים מהטופס (מייל + Google Sheet בשם "Website leads – <העסק>"), הדומיין נשאר על שם הלקוח ולא נוגעים ברשומות ה-DNS, Google Search Console ופרופיל העסק בגוגל (שעות זהות לאתר), ועריכה אחת קטנה בחודש דרך Requests. בלי הבטחות לגבי דירוג בגוגל: נאמר רק שאתר חדש יכול לקחת כמה שבועות עד שמופיע בחיפוש. ההקלטה נעשית על אתר הדמו Copperleaf (`site/demo-site/home-services/`, קיים). Requests בפורטל עוד לא קיים (B7). גרסת `bndl` מוסיפה משפט על קו ה-AI והצ'אט באתר.

| | |
|---|---|
| Goal | The client knows what they own, where leads go, what not to touch, and how to ask for the monthly edit. |
| Plays in | Link in the `went_live` email for `WEB`/`BNDL` · portal **Home** when the client is live with a website `[PENDING B7: video slot on Home]` |
| Products | `WEB`, `BNDL` |
| Formats | 1920×1080 MP4 + captions; vertical 1080×1920 cut of S2 (the site on a phone) |
| CTA | "Send your first edit request" |
| Cuts | `main` (WEB) · `bndl` (base + one extra line) |

## Scenes

### S1 · 0:00–0:08 · Title
- **On-screen text:** "Your website is live" / "What you have and how it works"

VO: Your website is live. Here's what you have, and how to keep it working for you.

### S2 · 0:08–0:35 · The five pages (exists today)
- **Record:** `make serve`, then `node tools/cdp-shots.mjs http://localhost:8787/demo-site/home-services/ $OUT/home 1920 1080 0 9333 '[0,900,1800]'`, same for `services/`, `about/`, `reviews/`, `contact/`; mobile: `390 844 1`. Remove the demo badge in the edit or crop it.
- **On-screen text:** "Home · Services · About · Reviews & FAQ · Contact"

VO: You have five pages: Home, Services, About, Reviews and FAQ, and Contact.
VO: Every page has a call button and a text button. On a phone, one tap calls you or starts a text to your number.

### S3 · 0:35–0:58 · Leads (motion graphics + test sheet)
- **Record:** fill the Contact form on the demo (demo mode shows success without sending), then a **test** Google Sheet "Website leads – Copperleaf Air & Plumbing" with one row (name, phone, ZIP, service, urgency).
- **On-screen text:** "Form → email + Google Sheet"

VO: When someone fills in the contact form, you get an email, and a new row appears in your Google Sheet called Website leads.
VO: Check it every day, and call new leads back.

### S4 · 0:58–1:22 · Domain and Google (motion graphics)
- **Visual:** domain card "registered in your name" → arrow → site; a "do not change" lock over two DNS rows (CNAME `www`, A records `@`). Then Search Console and Google Business Profile logos as plain text labels (no logos).
- **On-screen text:** "Your domain stays in your name" · "Don't change the DNS records we set" · "Same hours on your Google profile"

VO: Your domain stays in your name. We pointed it to the new site, so please don't change those settings at your domain company, or the site goes offline.
VO: We submitted the site to Google Search Console. Make sure your Google Business Profile links to it and lists the same hours.
VO: New sites can take a few weeks to show up in Google search. That's normal.

### S5 · 1:22–1:45 · Monthly edit `[PENDING B7]`
- **Record:** portal **Requests → New request** → "Update the AC tune-up price on Services" → attach a photo → Submit.
- **On-screen text:** "1 small edit a month, included"

VO: Your plan includes one small edit a month, like a new photo, a price change, or an updated service.
VO: Send it from Requests in your portal. Tell us the page and paste the new text.

### S6 · 1:45–1:55 · Bundle line (cut `bndl` only)
- **Visual:** header of the demo site with the phone number highlighted → "AI line".

VO[bndl]: Your AI line number is on the site, and the chat on your pages uses the same receptionist, so web visitors get answers too.

### S7 · end card
- **On-screen text:** "Questions? → Requests" · `{{brand.support_email}}`

VO: Questions about your site? Send us a request.

## Production notes
- The demo business (Copperleaf Air & Plumbing) is fictional and noindex; that is the only site shown. Never show a client's live site without their written OK.
- Whether "we" or the client updates the Google Business Profile is per job; the voice says "make sure", which fits both.
