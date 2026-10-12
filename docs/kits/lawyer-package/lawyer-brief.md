# Attorney brief — legal review before the first US client (v1, 2026-10-11)

**For:** a US-licensed attorney (business / tech contracts; ideally TCPA and privacy experience).
**Documents to review** (version `1.0`, effective October 12, 2026, live at ailabpro.co/legal/; standardized against nine competitors, see `docs/reports/LEGAL-STANDARD.md`; not yet reviewed by a licensed US attorney):
- Terms of Service — `site/legal/terms/index.html`
- Privacy Policy — `site/legal/privacy/index.html`
- Service Agreement — `site/legal/service-agreement/index.html`

## 1. The business in one paragraph
A one-person Israeli sole proprietorship (osek murshe) sells fixed-price AI services to small US businesses, fully remote and mostly asynchronous: online questionnaire → written fixed quote → 50% deposit → build → video handoff → monthly plan. Main product: a **Missed-Call AI Receptionist** that answers missed or forwarded inbound calls with an AI voice (Twilio + Anthropic's Claude model), sends an SMS text-back to callers who hang up, books jobs into the client's Google Calendar or Calendly, and alerts the owner. Second product: 5-page business websites. Target niches: home services (HVAC, plumbing, electrical, roofing, garage doors, locksmiths) and real estate agents. Dental offices: "early access" only, no health data, no BAA. First clients will come through Upwork. Prices are listed publicly (setup + monthly). We say "built with Claude" in text, with a non-affiliation statement; the brand and domain do not use "Claude".

## 2. Facts about how the product handles calls and texts
- Inbound only. No outbound AI-voice calls.
- Text-back only to a person who just called the business; informational content (request follow-up, booking confirmation, 24-h booking reminder). No marketing texts.
- First text names the business and includes "Reply STOP to opt out". STOP/CANCEL/END/QUIT/UNSUBSCRIBE handled in code before the AI; honored permanently per line until START. HELP answered.
- Quiet hours 21:00–08:00 client time for anything that is not a direct reply. Landlines are detected and not texted.
- Greeting: discloses an automated assistant and "This call may be transcribed". **No audio is recorded** (speech-to-text only), except a carrier voicemail fallback when our server is down (with notice).
- We register each client's A2P 10DLC brand and campaign as an ISV.
- Retention: transcripts and SMS 90 days; technical logs 30 days.
- Sub-processors: Supabase, Railway, Twilio, Anthropic, Resend, Google, Microsoft Clarity; payments via Upwork / PayPal / bank transfer.

## 3. Questions

### A. Structure and jurisdiction
1. Is it fine to contract with US businesses as an Israeli sole proprietorship, or do you recommend a US entity (e.g. LLC) before or after the first clients? What risks change?
2. Governing law: we proposed **New York** law with **online binding arbitration** (single arbitrator, English). Do you agree? Which provider, and should we add a class-action waiver and a small-claims carve-out (both drafted)? Is a choice of law enforceable against clients in other states for this kind of B2B contract?
3. Is electronic acceptance on the Quote page (typed full name + checkbox + logged IP, browser, time, document version hash) enough under the E-SIGN Act / UETA? Anything to add?
4. When the client hires us through Upwork, how should our Service Agreement sit next to Upwork's Terms (payment, escrow, disputes)? Is the "order of documents" clause enough?

### B. TCPA, SMS and call recording
5. Is a single informational text-back to a person who just called the business consistent with the TCPA and carrier (CTIA) rules without any additional consent step? Does the 24-h booking reminder change that?
6. Is the AI voice on **inbound** calls a concern under the FCC's 2024 ruling on AI-generated voices (which we understand addresses outbound calls)? Any disclosure we should add?
7. Transcription without audio recording: in all-party-consent states (e.g. California, Florida, Illinois, Pennsylvania, Washington), is "This call may be transcribed" at the start of the call sufficient, or do we need an explicit consent step (e.g. "By staying on the line you agree…")?
8. Our allocation of responsibility: the client represents that its use is lawful and indemnifies us (Service Agreement §8 and §16). As the ISV/technology provider, what is our own exposure, and is this allocation reasonable and enforceable?
9. Please check the SMS program terms (ToS §11) and the privacy statements about mobile data (Privacy §4) against current carrier/10DLC campaign requirements.
10. Florida (FTSA), Oklahoma and other "mini-TCPA" states: anything specific for informational text-backs and reminders?

### C. Privacy
11. Are we a "service provider"/"processor" for caller data under the CCPA/CPRA and other state laws? Do we need a separate data processing addendum with each client?
12. The Privacy Policy covers both our clients and our clients' callers. Is one policy acceptable, or should we split it?
13. Is 90-day retention for transcripts/SMS reasonable? Should the client be able to choose a shorter or longer period?
14. Analytics (Google Analytics, Microsoft Clarity session recording) on the website and portal: do we need a cookie banner or opt-out for US visitors (CCPA "sharing", Washington, etc.)?
15. We state that we do not opt in to Anthropic training on customer data. Is that wording enough, or should we describe Anthropic's commercial data terms explicitly?

### D. Health information (dental early access)
16. If a dental office uses the receptionist and the AI collects only name, phone and a general reason for the call, are we likely a HIPAA business associate anyway? What wording keeps us out of scope, or should we not offer dental at all until we can sign BAAs?

### E. Commercial terms
17. Refund policy as drafted (numbers and client wording come from `config/pricebook.json` → `refund_rules`):
    - **Satisfaction guarantee** (AI Receptionist and the Receptionist + Website bundle): "If you're not satisfied within 30 days after go-live, we refund the setup fee and switch the line off. Monthly fees for the period used are not refunded."
    - **Website alone:** only the deposit rule below, because content work starts immediately.
    - **Setup deposit:** fully refunded on request within 7 days of payment, as long as the client has not completed the access checklist; after that it is non-refundable, except under the guarantee.
    - **Retainers:** 75% refund of the first payment if cancelled within 7 days. **Monthly fees:** no partial-month refunds.
    - **Business days** for every response time (written quote "within 1 business day", replies) are Sunday–Thursday, Israel time.
    Questions: (a) Is "not satisfied" (no objective test) safe for us as written, or should we require a written request and a chance to fix the issue first? (b) For the bundle, should the refund cover the whole bundle setup fee or only the receptionist part, and what happens to the website? (c) Does the word "guarantee" create any warranty or consumer-law exposure for B2B buyers (e.g. FTC rules on "satisfaction guaranteed" claims, state auto-renewal laws for monthly plans in California/New York)? (d) Is defining business days as Sunday–Thursday (Israel time) clear enough for US clients?
18. Liability cap = fees paid in the prior 12 months, excluding the client's payment and indemnity obligations. Is this enforceable and standard for a small vendor?
19. IP: client owns deliverables after full payment; we keep templates, shared code, platform and prompts, with a license to the client. Any gap, especially for the hosted receptionist when the plan ends?
20. Service level "99% best effort, no credits": acceptable wording?
21. Marketing claims: we write "I work with Samsung and Haier in Israel (through their Israeli distributor) and with other Israeli corporate clients" on Upwork and the site. What permission or wording do we need?
22. Trademark: "Built with Claude (not affiliated with Anthropic)" in text only. Is our non-affiliation wording sufficient?

### F. Tax and payments (to confirm with our Israeli accountant as well)
23. Service performed outside the US: we plan to provide Form W-8BEN on request and expect no US withholding or sales tax. Anything to add in the contract?

## 4. What we need back
- Marked-up versions of the three documents (or a list of changes).
- Final choice for governing law, venue and arbitration provider.
- A yes/no on dental early access.
- Then we apply your changes, bump the version (e.g. `1.1`) and the "Last updated" date in `config/brand.json`, and notify active clients by email where the documents require it.
