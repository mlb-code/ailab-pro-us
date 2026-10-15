# ביקורת שפה פשוטה: ailabpro.co

תאריך: 15.10.2026. בדיקה לקריאה בלבד, שום קובץ באתר לא שונה.
המבחן לכל משפט: "האם בעלת מספרה תבין את זה בלי לחפש בגוגל?"
נבדקו: `site/_content/*.json`, `config/pricebook.json` (שורות "מה כלול" ותוספות שמוצגות בדף), `site/demo/`, `site/start/` (שאלון, כניסה, פורטל), `site/quote/`, והמיילים ב-`supabase/functions/_shared/email/templates.ts` ו-`quote_email.ts`. הדפים המשפטיים לא נבדקו.

## 1. סיכום (10 שורות)

1. **בית: שירותים לבית (/)**: 6/10. הכותרת והפתיח מצוינים. מהבלוק "מה כלול" והלאה יש הרבה ז'רגון: AI line, A2P 10DLC, Zapier webhook, CRM/FSM, וקודים כמו ADD-LOC.
2. **נדל"ן (/real-estate/)**: 5/10. בפתיח יש משפט של 29 מילים עם "lead screening… synced to Follow Up Boss via Zapier".
3. **אתר (/website/)**: 5/10. בקטע SEO יש מונחים כמו schema, sitemap, SSL ו-uptime. יש גם סתירה במספרים: 3 ימים לטיוטה, ו-7 ימים עד שהאתר עולה.
4. **תוכן משותף (איך זה עובד, אמון, שאלות נפוצות, פוטר)**: 6/10. נוסח הערבות והחזר המקדמה ארוך. אותו דבר נקרא פעם "access checklist" ופעם "setup checklist".
5. **ביקורות ושיחות לדוגמה**: 8/10. רק המונח "founding clients".
6. **דמו (/demo/)**: 8/10. הדמו עצמו ברור. רק "Scripted, in your browser" ו-"transcribed" לא ברורים.
7. **שאלון וכניסה (/start/)**: 8/10. הכי נקי באתר. רק "CRM" ו-"carrier registration".
8. **פורטל ורשימת ההקמה**: 6/10. מופיעים webhook, usage block ו-go-live. ההסבר על A2P בפורטל דווקא טוב, וכדאי להעתיק אותו לשאר האתר.
9. **דף ההצעה (/quote/)**: 6/10. "fingerprint of these exact terms" ו-"billed monthly in advance".
10. **מיילים**: 8/10. קצרים וברורים. רק "portal" ו-"go-live" חוזרים בלי הסבר.

**4 בעיות עקביות שהן לא ניסוח** (מאיר צריך להחליט, לא לנסח):
- **אתר**: כתוב "draft is ready 3 business days after we have your content" (בזרימה, בשאלון ובפורטל). במקומות אחרים כתוב "live 7 business days after your content is in" ו-"7 days: Draft, then your approval". צריך לבחור מספר אחד, או להסביר ש-3 זו טיוטה ו-7 זה עלייה לאוויר.
- **שני שמות לאותה רשימה**: "access checklist" (בערבות, בהחזר ובשאלות הנפוצות) ו-"setup checklist" (בכל השאר). מומלץ להשאיר רק "setup checklist". זה משנה גם נוסח משפטי ב-pricebook, ולכן צריך אישור.
- **הבטחת יתר**: בשאלה builtin_ai כתוב "works with any calendar or CRM". אבל Outlook ו-ServiceTitan מסומנים "Custom quote". מומלץ לרכך (שורה 41).
- **ימי עסקים**: "Business days are Sunday–Thursday, Israel time" מבלבל לקוח אמריקאי (שישי שלו = אין עבודה). זה נכון עובדתית ולכן לא שיניתי את התוכן, רק את הניסוח (שורה 36).

## 2. טבלאות לפי דף

הסוגריים המסולסלים (`{price:RCP.setup}` וכו') ממולאים אוטומטית מהקונפיג, ולכן נשארו כמו שהם בנוסח המוצע. **סה"כ 60 שורות.**

### בית: שירותים לבית (`home-services.json` + `pricebook.json` RCP)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 1 | missed_steps[0].text | Unanswered calls forward to your AI line. It greets callers by your business name and asks what's going on. Hang-ups get a text back within a minute. | Calls you don't pick up go to your AI receptionist's number. It answers with your business name and asks what's going on. If a caller hangs up, it texts them within a minute. | "AI line" לא הוסבר | none |
| 2 | missed_steps[2].text | Only real openings from your calendar, inside your service area and time windows. You get the lead by text and email, plus a daily summary. | It books only open times on your calendar, in the areas and hours you serve. You get each new lead by text and email, plus a daily summary. | משפט בלי פועל | none |
| 3 | demo.lead | Pick a situation and tap the replies. This is a scripted demo of the text conversation after a missed call. | Pick a situation and tap the answers. You'll see the texts your customer gets after a missed call. The answers are set in advance. | "scripted demo" לא ברור | none |
| 4 | pricing.note | Adding a second location, Spanish, or a direct Jobber connection? Each add-on has a fixed price, listed below. | Need a second location, Spanish, or a direct link to Jobber? Each extra has a fixed price, listed below. | "add-on" מילה של מוכרים | none |
| 5 | כרטיס מחיר (תווית) | RCP · fixed price | Fixed price | קוד פנימי מוצג ללקוח | none |
| 6 | RCP.includes[0] | 1 location, 1 AI line (a US number we provision; you keep your existing number and forward unanswered calls to it) | 1 location and 1 new US phone number for your AI receptionist. You keep your own number; calls you miss are sent to the new one. | "provision" ו-"AI line" | none |
| 7 | RCP.includes[1] | Voice answering of missed and forwarded calls, plus an automatic text-back to callers who hang up | Answers the calls you miss, and texts back callers who hang up | ניסוח טכני ומסורבל | none |
| 8 | RCP.includes[4] | Up to 25 FAQ entries, business hours, after-hours mode, emergency keywords with an owner alert | Answers to up to 25 common questions, your business hours, a nights-and-weekends mode, and emergency words that alert you right away | רשימת מונחים בלי פעלים | pricing |
| 9 | RCP.includes[6] | 1 outgoing Zapier webhook (lead and booking events) to connect any other tool | 1 Zapier link (Zapier is an app that connects apps) that sends each new lead and booking to any other tool | "webhook" ז'רגון של מפתחים | pricing |
| 10 | RCP.includes[7] | English. Client portal with call log, transcripts, bookings and settings | English only. Your own online account shows every call, a written copy of each conversation, your bookings and settings. | "portal" ו-"transcripts" | none |
| 11 | RCP.includes[8] | A2P 10DLC SMS registration handled by us (registration fees included) | We handle the texting registration that US phone carriers require (fees included) | "A2P 10DLC" לא מובן | none |
| 12 | RCP.includes[10] | Monthly: monitoring, prompt/FAQ updates, 1 active change request at a time (small changes, up to 1 hour each) | Every month: we check that it works, update its answers, and make small changes for you, one at a time (up to 1 hour each) | "prompt" ו-"change request" | pricing |
| 13 | RCP.excludes[1] (והקודים בשורות הסמוכות) | Additional locations or AI lines (add-on ADD-LOC) | More locations or phone numbers (extra, see prices below) | קוד ADD-LOC מוצג ללקוח | none |
| 14 | RCP.excludes[3] | Native CRM/FSM integrations (add-on ADD-CRM) | A direct link to apps like Jobber or HubSpot (extra, see prices below) | "CRM/FSM" ראשי תיבות לא מוכרים | none |
| 15 | RCP.excludes (הקלטה) | Call audio recording (calls are transcribed; audio is not stored) | Call recordings (we keep a written copy of each call, not the audio) | "transcribed" מילה קשה | legal |
| 16 | RCP.excludes (HIPAA) | Handling of medical records or other protected health information (no HIPAA BAA) | Medical records or patient health information (we can't sign a HIPAA agreement) | "BAA" לא מוכר | legal |
| 17 | ADD-CRM.name | Native CRM/FSM integration, per system (Jobber, Housecall Pro, GoHighLevel, HubSpot) | Direct link to your job or customer app, per app (Jobber, Housecall Pro, GoHighLevel, HubSpot) | "native integration" ז'רגון | pricing |
| 18 | ADD-CHAT.name | Website chat widget (same AI brain) | Chat box on your website (same answers as your phone line) | "widget" ו-"AI brain" | pricing |
| 19 | ADD-USAGE.name | Extra usage block: +400 min / +1,000 SMS | Extra minutes and texts: +400 min / +1,000 texts | "usage block" ז'רגון חיוב | pricing |
| 20 | faq (Jobber) | Booking into Google Calendar or Calendly is included, and so is 1 Zapier webhook for any other tool. A direct Jobber, Housecall Pro, GoHighLevel or HubSpot connection is a {price:ADD-CRM.setup} add-on ({price:ADD-CRM.monthly}/mo). ServiceTitan gets a custom quote. | Booking into Google Calendar or Calendly is included. So is 1 Zapier link to send leads to any other tool. A direct link to Jobber, Housecall Pro, GoHighLevel or HubSpot costs {price:ADD-CRM.setup} + {price:ADD-CRM.monthly}/mo. For ServiceTitan, we quote separately. | webhook, משפט ארוך | none |

### נדל"ן (`real-estate.json`)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 21 | hero.lead | Instant text-back, lead screening (buying or selling, area, timeline, pre-approval) and booking into your calendar, synced to Follow Up Boss via Zapier. Even when you're at a showing. | Even when you're at a showing, every caller gets a text right away. It asks if they're buying or selling, where, when, and if they're pre-approved. Then it books them into your calendar and can send the lead to Follow Up Boss. | 29 מילים, אין פועל | none |
| 22 | seo.description | Instant text-back, lead screening and booking into your calendar, synced to Follow Up Boss via Zapier. Fixed price: {price:RCP.setup} setup + {price:RCP.monthly}/mo. | Missed callers get a text right away, get screened, and get booked into your calendar. Leads can go to Follow Up Boss. Fixed price: {price:RCP.setup} setup + {price:RCP.monthly}/mo. | מופיע בגוגל, ז'רגון | none |
| 23 | missed_steps[0].text | Calls you can't take forward to your AI line. It answers with your name or your team's name. Hang-ups get a text back within a minute, so sign calls don't go cold. | Calls you can't take go to your AI assistant's number. It answers with your name or your team's name. If a caller hangs up, it texts them within a minute, so sign calls don't go cold. | "AI line" לא הוסבר | none |
| 24 | missed_steps[2].text (משפט אחרון) | Leads can flow into Follow Up Boss through Zapier. | Each lead can also be added to Follow Up Boss automatically (through Zapier, an app that connects apps). | Zapier לא מוסבר | none |
| 25 | faq (Follow Up Boss) | Yes, through the Zapier webhook that's included: every new lead and booking can create a person and a task in Follow Up Boss. Google Calendar or Calendly booking is included too. | Yes. A Zapier link is included: each new lead and booking can add a contact and a to-do in Follow Up Boss. Booking into Google Calendar or Calendly is included too. | "webhook" ז'רגון | none |
| 26 | included_items[6] | Leads synced to Follow Up Boss or kvCORE through 1 included Zapier webhook | Leads sent to Follow Up Boss or kvCORE through 1 included Zapier link | "synced", "webhook" | pricing |
| 27 | pricing.note | Team with several lines? Each extra line is a fixed-price add-on, listed below. | Team with several phone numbers? Each extra number has a fixed price, listed below. | "line" ו-"add-on" | none |

### אתר (`website.json` + `pricebook.json` WEB/BNDL)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 28 | hero.lead | Five fast pages built around one job: getting a customer to call, text or fill in the form. Written from your questionnaire, approved by you, live {days:WEB} business days after your content is in. | Five fast pages with one job: getting customers to call, text or fill in your form. We write it from your answers and you approve it. It's live {days:WEB} business days after we have your content. | משפט סביל, לא ברור מי | none |
| 29 | variants.web_flow.link | No quote step. Fill a 10-minute questionnaire, we email your deposit link {quote_sla}, and the draft is ready 3 business days after we have your content. | No waiting for a quote. Answer 10 minutes of questions and we email your deposit link {quote_sla}. Your first draft is ready 3 business days after we have your content. | "quote step" ושלוש פעולות במשפט אחד (ראו גם סתירת 3/7) | none |
| 30 | WEB.includes[0] | 5 pages (Home, Services, About, Reviews/FAQ, Contact), mobile-first, fast static hosting, SSL | 5 pages (Home, Services, About, Reviews/FAQ, Contact). Built for phones first, hosted by us, fast and secure (the padlock in the browser). | "static hosting", "SSL" | none |
| 31 | WEB.includes[1] | Lead form to email and Google Sheet; click-to-call and click-to-text buttons | A contact form that goes to your email and a Google Sheet, plus buttons that call or text you in one tap | "click-to-text" ז'רגון | none |
| 32 | WEB.includes[2] | Basic local SEO: titles/meta, LocalBusiness schema, sitemap, Google Search Console and Google Business Profile link | Basic setup to help Google show you to local customers: page titles, your business details in Google's format, a page list for Google, Google's free site tools, and a link to your Google Business Profile | "schema", "meta", "sitemap" | pricing |
| 33 | WEB.includes[4] | Monthly: hosting, uptime check, 1 small content edit per month | Every month: we keep the site online, check that it's up, and make 1 small edit | "uptime", "content edit" | pricing |
| 34 | faq (Google) | We set up the basics: titles and descriptions, LocalBusiness schema, a sitemap, Google Search Console and a link to your Google Business Profile. Rankings depend on many things; we don't promise positions. | We set up the basics so Google can read your site: page titles and descriptions, your business details in Google's format, a list of your pages, Google's free site tools, and a link to your Google Business Profile. Where you rank depends on many things, so we can't promise a spot. | ז'רגון SEO | legal |
| 35 | bundle.text | The bundle adds the Missed-Call AI Receptionist, puts your AI line on the site, and includes a website chat widget. You save {bundle_save_setup} on setup and {bundle_save_monthly} a month. | The bundle adds the Missed-Call AI Receptionist, shows its phone number on your site, and adds a chat box to your site. You save {bundle_save_setup} on setup and {bundle_save_monthly} a month. | "AI line", "widget" | none |

### תוכן משותף (`_shared.json` + `pricebook.json` refund_rules)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 36 | proof.rows[3] (Quote in writing) | {quote_sla_cap} of your questionnaire. Business days are {business_days}. Valid for 14 days. No sales calls, ever. | {quote_sla_cap} after you send your answers. We work {business_days}. Your quote is good for 14 days. No sales calls, ever. | "business days" לא ברור | none |
| 37 | how.steps[3].text | We build and test it, you try it yourself, then you turn on call forwarding. {days:RCP} business days after your access checklist is done. | We build and test it. You try it yourself, then you turn on call forwarding. It's ready {days:RCP} business days after you finish your setup checklist. | שני שמות לרשימה | none |
| 38 | proof.rows[0] (Built with Claude) | Your {assistant} runs on Claude, Anthropic's AI model. We are an independent studio, not affiliated with or endorsed by Anthropic. | Your {assistant} runs on Claude, an AI made by the company Anthropic. We are a small independent studio. We are not part of Anthropic, and Anthropic does not endorse us. | "Claude"/"Anthropic" לא מוכרים | legal |
| 39 | faq.keep_number | Yes. You set call forwarding on no-answer or busy to the AI line we set up. Calls you pick up never reach it. Our checklist shows how for Verizon, AT&T, T-Mobile, Comcast Business, RingCentral and Google Voice. | Yes. When you don't answer or the line is busy, your phone sends the call to the new number we set up. Calls you pick up never reach it. Our checklist shows how for Verizon, AT&T, T-Mobile, Comcast Business, RingCentral and Google Voice. | משפט הפוך וטכני | none |
| 40 | faq.cost (משפטים 2–3) | You pay a {price:RCP.deposit} deposit to start and the rest before go-live. The monthly fee starts on your go-live date. | You pay {price:RCP.deposit} to start and the rest before it goes live. The monthly fee starts the day it goes live. | "go-live" לפני הסבר | pricing |
| 41 | faq.builtin_ai (משפט 2) | Ours answers the phone itself, works with any calendar or CRM, hands off to a person when needed, and comes with someone who maintains it. | Ours answers the phone itself, works with any calendar or customer app, passes the caller to a person when needed, and a real person keeps it running. | "CRM", גם הבטחת יתר | legal |
| 42 | faq.ai_disclosure (3 משפטים אחרונים) | Before it texts a booking confirmation or reminder, it asks the caller and logs the answer. If a caller objects to recording, it stops and keeps no transcript. We keep transcripts, not audio. | Before it texts a booking confirmation or reminder, it asks the caller's permission and saves their answer. If a caller doesn't want to be recorded, it stops and keeps no written copy. We keep written copies of calls, never the audio. | "logs", "transcript" | legal |
| 43 | faq.timeline | {days:RCP} business days after you finish the access checklist (calendar, alerts, SMS registration details). Rush delivery is available as an add-on. | {days:RCP} business days after you finish the setup checklist (your calendar, who gets alerts, and your business details for texting registration). Faster delivery is available for an extra fee. | שם כפול, "add-on" | pricing |
| 44 | refund_rules.rcp_guarantee.text | 30-day satisfaction guarantee: if you're not satisfied within 30 days after go-live, we refund the setup fee for the AI line and switch the line off. On the bundle, only the AI line's part of the setup fee is refunded and the website stays yours. Monthly fees for the period used are not refunded. | 30-day satisfaction guarantee: not happy within 30 days of going live? We refund the AI receptionist's setup fee and turn it off. On the bundle, we refund only the receptionist's part of the setup fee, and you keep the website. Monthly fees you already used are not refunded. | משפטים סבילים וארוכים | legal |
| 45 | refund_rules (deposit text) | The setup deposit is fully refunded on request within 7 days of payment, as long as the access checklist has not been completed. | Changed your mind? Ask within 7 days of paying and we refund your full deposit, as long as you haven't finished the setup checklist. | סביל, שם כפול | legal |
| 46 | sms_note | Text-back starts after US carrier registration (A2P 10DLC), typically 1–2 weeks. Voice answering starts right away. | Phone answering starts right away. Texting starts once US phone carriers approve your business for texting, usually in 1–2 weeks. | "A2P 10DLC" לא מובן | none |
| 47 | after_pay.steps[2].text | We file the US carrier registration (A2P 10DLC) for you. It usually takes 1–2 weeks; fees included. | We register your business for texting with US phone carriers. Approval usually takes 1–2 weeks. Fees included. | "A2P 10DLC" לא מובן | none |
| 48 | after_pay.steps[4].text | You approve go-live, pay the second half, and turn on call forwarding with our step-by-step video. | You give the OK to go live, pay the second half, and turn on call forwarding with our step-by-step video. | "go-live" כשם עצם | none |
| 49 | founder.text | {founding_label}: {price:RCP.founding} setup + {price:RCP.monthly}/mo for the first {founding_max} clients, in exchange for a short case study. | {founding_label}: {price:RCP.founding} setup + {price:RCP.monthly}/mo for our first {founding_max} clients, if you let us write a short case study about your results. | "case study" לא מוסבר | pricing |
| 50 | usage_text_fallback | {usage_voice} minutes + {usage_sms} texts included every month. We alert you at 80%. No surprise charges: extra usage is added only if you approve it. | {usage_voice} minutes + {usage_sms} texts included every month. We let you know when you've used 80%. No surprise charges: we add more only if you say yes. | "80%" של מה? | pricing |
| 51 | footer.columns[2].links[0–1] | Missed-call AI: home services / Lead AI: real estate | AI receptionist: home services / AI assistant: real estate | שמות פנימיים לא עקביים | none |

### ביקורות ושיחות לדוגמה (`reviews.json`)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 52 | samples.lead | Sample conversations from our demo business. Real reviews will appear here as founding clients go live. | Sample conversations from our demo business. Reviews from real clients will appear here once our first clients are up and running. | "founding", "go live" | none |

### דמו (`site/demo/` = `tools/build_landing.py` שורה 985)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 53 | lead | This is what a caller gets after a missed call: a text from your AI assistant, a few quick questions, and a booked slot. Scripted, in your browser. Demo — no real booking is made. | This is what a caller gets after a missed call: a text from your AI assistant, a few quick questions, and a booked time. The answers are set in advance. Demo — no real booking is made. | "Scripted, in your browser" | none |
| 54 | Hear it live (שורת טלפון) | US number, standard rates apply. An AI assistant answers, and the call may be recorded and transcribed. | US number, regular call charges apply. An AI assistant answers, and the call may be recorded and written down as text. | "transcribed" | legal |

### שאלון וכניסה (`site/start/assets/questions.js`, `home.js`, `q.js`)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 55 | questions.js re_crm (label + hint) | Which CRM holds your leads? / Any CRM works: the ones not listed connect through Zapier. | Where do you keep your leads (your CRM)? / Any CRM works. If yours isn't listed, we connect it through Zapier. | "CRM" בלי הקשר | none |
| 56 | home.js (הודעה אחרי שליחת קוד) | Not there? Check spam or promotions. The link and the code both work — the code helps when the link opens in a different browser. | Don't see it? Check your spam or promotions folder. You can click the link or type the code. The code helps if the link opens in a different browser. | מקף ארוך, משפט כפול | none |
| 57 | q.js (סיכום "מה הלאה", RCP) | Go live: voice answering starts right away; text-back starts after carrier registration, typically 1–2 weeks. | Going live: phone answering starts right away. Texting starts once phone carriers approve you, usually in 1–2 weeks. | "carrier registration" | none |

### פורטל ורשימת ההקמה (`portal-b.js`)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 58 | שלב Zapier (תיאור) | Optional. If you use other tools (a CRM, a spreadsheet), we can send each new lead and booking to them through one Zapier webhook. Don't use Zapier? Skip this step. | Optional. If you use other tools (a CRM, a spreadsheet), we can send each new lead and booking to them through Zapier. Don't use Zapier? Skip this step. | "webhook" מיותר כאן | none |
| 59 | שימוש חודשי (הודעה) | We never bill extra usage automatically. You get an alert at 80% and 100%; an extra usage block … is added only if you approve it. | We never charge for extra minutes or texts on our own. We alert you at 80% and 100% of your monthly minutes and texts. We add more only if you say yes. | "usage block" | pricing |

### דף הצעת מחיר (`site/quote/assets/quote.js`)

| # | איפה | היום | מוצע | למה | סיכון |
|---|---|---|---|---|---|
| 60 | הסבר חתימה | Type your full name and tick the box. This is your electronic signature. We record the time and a fingerprint of these exact terms. | Type your full name and tick the box. This is your electronic signature. We save the time you signed and a unique code that shows which exact terms you agreed to. | "fingerprint" לא מובן | legal |

**לא נכנס לטבלה** (נשאר כמו שהוא בכוונה): "Reply STOP to opt out" בדמו (חובה רגולטורית בהודעות SMS). תיבת ההסכמה עם "individual arbitration… class-action waiver… (Terms §17)" (נוסח משפטי). "Monthly fees start on your go-live date and are billed monthly in advance" אפשר לפשט ל-"You pay at the start of each month", אבל רק באישור, כי זה תנאי תשלום. המיילים כמעט נקיים: הנושא היחיד שחוזר הוא "Open your portal" ו-"go-live". עדיף לטפל בהם דרך מילון המונחים (סעיף 3) ולא שורה-שורה.

## 3. מילון מונחים: מה שומרים ואיך מסבירים

מונחים שאי אפשר להעלים. הצעה: tooltip בריחוף, או הסבר בסוגריים בפעם הראשונה בכל דף.

| מונח | הגדרה פשוטה (באנגלית, להצגה באתר) |
|---|---|
| call forwarding | A phone setting that sends calls you don't answer to another number. Takes 2 minutes; we show you how. |
| your receptionist's number (במקום AI line) | A new US phone number we set up for your AI receptionist. Customers still call your usual number. |
| text-back | An automatic text to anyone who called and hung up, so they don't call someone else. |
| go live | The day your receptionist (or website) starts working for real customers. Nothing goes live until you say OK. |
| setup checklist | A short list of steps in your account (calendar, alerts, hours), each with a short video. |
| texting registration (A2P 10DLC) | US phone carriers make every business that texts register first. We do it for you; it takes 1–2 weeks. |
| Zapier | A popular app that passes information from one app to another, like new leads into your customer list. |
| CRM | The app where you keep your customers and leads (for example Follow Up Boss, Jobber or HubSpot). |

(שווה לשקול גם את "business day": "Our working days are Sunday–Thursday, Israel time".)

## 4. המלצת טון

- **"we"** תמיד לסטודיו. לא "I", ולא "our team" במקום אחד ו-"the studio" במקום אחר. "we" נשמע יציב ומקצועי, וממילא כך כתוב ברוב האתר.
- **"you"** לבעל העסק, **"your customers" / "your callers"** ללקוחות שלו. לא "the client" ולא "the caller" בגוף שלישי.
- **"your receptionist" / "it"** למוצר. לא "the AI line", "the assistant" ו-"the AI" לסירוגין. בנדל"ן: "your assistant".
- פעיל במקום סביל: תמיד לכתוב מי עושה מה.

דוגמה:
- היום: "The setup deposit is fully refunded on request within 7 days of payment, as long as the access checklist has not been completed."
- מוצע: "Changed your mind? Ask within 7 days of paying and we refund your full deposit, as long as you haven't finished the setup checklist."
