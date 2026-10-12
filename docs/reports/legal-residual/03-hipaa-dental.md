# 03 · HIPAA and the dental "early access" offer

Research memo, not legal advice. Prepared 2026-10-12 for AI Lab Pro (ailabpro.co), an Israeli sole proprietor with no US entity. Scope: whether the planned dental version of the Missed-Call AI Receptionist can run without a HIPAA Business Associate Agreement (BAA), what competitors do, what a BAA-covered stack would cost, and what the Terms and the dental page should say. Every source is listed at the end with an access date of 2026-10-12. Where a quote could not be verified on the primary page, this memo says so. Several hhs.gov pages returned HTTP 403 to the research tool. Those HHS points rest on search excerpts of the HHS page and are marked "excerpt".

## Summary

1. A phone-answering and scheduling vendor that takes calls for a dental practice and creates, receives, stores or transmits caller data for it is a **business associate** under 45 C.F.R. §160.103 whether or not a BAA is signed. The status comes from the facts, not from the paperwork [1][5][7].
2. Caller name + phone + "existing patient" or "new patient" + "tooth pain" or "cleaning", received on behalf of a dental practice, is **PHI**. Name and phone identify the person. The rest relates to the past, present or future provision of health care [1].
3. Dropping the reason does **not** fix this. Name + phone + new/existing patient status + a requested appointment at a named dental practice still relates to the "provision of health care", so it is still PHI. **Option C ("dental without PHI") is not achievable.**
4. The conduit exception does not apply. We store transcripts and booking logs for 90 days, an AI model interprets the content, and we write to the calendar. That is persistent, routine access, not mere transmission [4][5].
5. Our own vendors forbid it. Twilio's HIPAA list says a covered entity or business associate must not use its services with PHI without a Twilio BAA [10]. Resend says it "cannot sign a Business Associate Agreement" [16], and Zapier does not offer one [18]. Running dental today would breach vendor terms on top of HIPAA.
6. OCR's direct reach to an Israeli sole proprietor with no US presence is practically weak. The real exposure runs through the US dental client (OCR has fined practices $31K–$1.55M for missing BAAs [6][7][8]), through contract and indemnity claims, through state attorneys general, through vendor account termination, and through the live page saying "No" to "Does it handle patient health information?", which is inaccurate.
7. Competitors split into two groups. Vendors that sell to healthcare sign BAAs: Frontdesk on every plan, Vapi as a paid add-on, Retell under a custom agreement, Weave as a standard addendum. Retell's Terms contain exactly the "no PHI unless a BAA" clause we need [21][22][23][24].
8. **Recommendation: (B) with corrections, now.** Keep the hidden waitlist (dentists' business emails only, which are not PHI). Fix the inaccurate FAQ. State plainly that the service is not available to HIPAA covered entities until we can sign a BAA. Onboard no dental or medical client until the BAA chain exists. The cheapest BAA-covered stack is likely AWS-centred (§Cost), but Twilio's Security Edition price is not public and is the main unknown.

---

## Finding 1: business associate status, PHI, conduit, exposure

### 1.1 Business associate without a signed BAA

45 C.F.R. §160.103, "Business associate", paragraph (1)(i): a person who, "on behalf of such covered entity … other than in the capacity of a member of the workforce … creates, receives, maintains, or transmits protected health information for a function or activity regulated by this subchapter". Paragraph (1)(ii) adds services such as "management, administrative, … or financial services" [1].

Answering a practice's overflow calls, collecting caller details and booking appointments is an administrative function performed on the practice's behalf. HHS's business-associate guidance lists close analogues, for example "An independent medical transcriptionist that provides transcription services to a physician" [2, excerpt]. No HHS FAQ that names "answering services" specifically was found. The conclusion rests on the regulatory definition, which is clear on these facts.

**The BAA is not what creates the status.** HHS's cloud FAQ 2079 states that a provider meeting the business-associate definition "must comply with all applicable HIPAA Rules, whether or not it has signed a BAA", citing 78 Fed. Reg. 5565, 5598 (Jan. 25, 2013) [5, excerpt]. HHS's fact sheet *Direct Liability of Business Associates* (announced May 24, 2019) lists the provisions OCR can enforce directly against a business associate. These include impermissible uses and disclosures, Security Rule failures, and failure to sign BAAs with subcontractors [3].

Our vendors (Twilio, Anthropic, Supabase, Railway, Resend) would become our **subcontractors** under the §160.103 definition: "a person to whom a business associate delegates a function, activity, or service" [1]. Each would need its own BAA with us.

A narrow mitigating point: FAQ 2079 notes that OCR "recognizes that a CSP may not have actual or constructive knowledge" that its service is being used for ePHI [5, excerpt]. The affirmative defences in 45 C.F.R. §160.410 rest on lack of knowledge or timely correction. That route is closed to us. We market to dentists by name, so we would plainly have knowledge. (§160.410 is cited from general knowledge of the rule and was not re-fetched here.)

### 1.2 Is name + phone + "existing patient" + "tooth pain" PHI?

Yes. Under §160.103 [1]:

- "Health information" is information, including oral information, that "is created or received by a health care provider …" and "relates to the past, present, or future physical or mental health or condition of an individual; the provision of health care to an individual; or the past, present, or future payment for the provision of health care".
- "Individually identifiable health information" is a subset that "identifies the individual" or where there is "a reasonable basis to believe the information can be used to identify the individual".
- "Protected health information" is individually identifiable health information "transmitted by electronic media; maintained in electronic media; or transmitted or maintained in any other form or medium".

Applied to our case:

- "Tooth pain" is a present physical condition.
- "Existing patient" reveals past provision of care by a specific provider.
- A booked "urgent visit" or "new-patient exam" is future provision of care.
- Name and phone are direct identifiers. They are 2 of the 18 identifiers in the Safe Harbor list at §164.514(b)(2).

HHS's de-identification guidance (Nov 26, 2012) gives this example: a list of names, which is ordinary demographic data, becomes PHI when listed with "an indication that the individual was treated at a certain clinic". That quote is recalled from the guidance. The hhs.gov page returned 403 and an exact-phrase search did not surface it, so treat the wording as **unverified**. The principle follows directly from the §160.103 text above.

### 1.3 Why the conduit exception does not apply

The rule does not have a free-standing "conduit" paragraph. The concept comes from HHS guidance and the 2013 Omnibus preamble, where HHS says the exception is "a narrow one" covering "mere courier services, such as the U.S. Postal Service or United Parcel Service and their electronic equivalents, such as internet service providers (ISPs) providing mere data transmission services" (as quoted in [25], secondary).

HHS's cloud FAQ adds that the exception is limited to "transmission-only services … including any temporary storage of PHI incident to such transmission", and that a provider which stores ePHI is a business associate "even if [it] does not actually view the information" [4, excerpt]. Paragraph (3)(i) of the §160.103 definition goes further: even a pure data-transmission provider is a business associate if it "requires access on a routine basis to such protected health information" [1].

Our service fails the exception on every point:

- An AI model reads and interprets the content.
- We store transcripts for 90 days and booking records for 2 years (SA §12).
- We write bookings into the practice calendar.
- We send alert emails and texts.

Twilio's raw carriage might be argued as conduit-like. Our application on top of it cannot.

### 1.4 Penalties and enforcement examples

- **Civil money penalties** follow four culpability tiers (45 C.F.R. §160.404), adjusted for inflation each year (45 C.F.R. part 102). Secondary sources report these per-violation amounts for 2026: Tier 1 from $145, up to $73,011 per violation in Tiers 1–3, and Tier 4 from $73,011, with a calendar-year cap of $2,190,294 [26]. **Unverified against the Federal Register.** Under OCR's 2019 notice of enforcement discretion, lower annual caps apply to Tiers 1–3.
- **Practices fined for having no BAA:**
  - Raleigh Orthopaedic Clinic paid $750,000 after handing PHI for 17,300 patients to a vendor without a BAA [6].
  - North Memorial Health Care paid $1.55M; the violations included a missing BAA [7].
  - Center for Children's Digestive Health, a small 7-site practice, paid $31,000. Neither party could produce a signed BAA, and no misuse was proven [8].
- **Vendors fined directly as business associates:**
  - MedEvolve paid $350,000 (May 2023), partly for having no BAA with its own subcontractor [9].
  - Comstar, LLC, a business associate of more than 70 covered entities, settled after a ransomware attack (May 2025) [27].

### 1.5 Can OCR reach a non-US vendor with no US presence? An honest assessment

No source was found in which OCR collected a penalty from a foreign business associate that had no US presence. HHS's own FAQ on offshore storage acknowledges "special considerations with respect to enforceability" [11]. In practice, OCR could open an investigation and issue a notice of proposed determination. Collecting from an Israeli sole proprietor without US assets would require litigation abroad, which is unlikely for a small matter.

**That does not make the risk small. The exposure moves elsewhere:**

- **The dental client.** The client is the easy target for OCR (see Raleigh and CCDH above). The client will then turn to us under contract. Our indemnity and limitation-of-liability clauses would be tested in that dispute.
- **State attorneys general.** HITECH lets state AGs enforce HIPAA in federal court. This is from general knowledge of HITECH §13410(e) and was not re-verified here.
- **Vendors.** Twilio, Resend and Anthropic would be entitled to terminate our accounts for breaching their terms, which would take down the whole US business, not just dental.
- **Deception risk.** The live FAQ answers "Does it handle patient health information?" with "No". Under §160.103 that answer is wrong. A false privacy statement to US businesses is a deception risk (FTC Act §5) that is independent of HIPAA.
- **A future US LLC.** Any US entity, Stripe account or US bank account created later would give US regulators a reachable target for past conduct.

---

## Finding 2: what competitors do

Quotes marked "verified" were fetched from the vendor's own page. Those marked "unverified" come from search snippets or third parties.

| Vendor | BAA? | Condition | Quote / note | URL |
|---|---|---|---|---|
| Frontdesk (myaifrontdesk.com) | **Yes** | Every plan (table shows "$109/mo flat") | "HIPAA-compliant answering service. BAA on every plan." / "Healthcare practices get a Business Associate Agreement before the first call." (verified) | [21] |
| Vapi | **Yes**, paid add-on | "HIPAA is available as a paid compliance add-on with Usage only or any Success Package." | "Never use real PHI until HIPAA mode is enabled for your organization." (verified) | [22] |
| Retell AI | **Yes**, by agreement | Pricing table: "Custom BAA"; Enterprise "Custom Pricing" | Terms §13 quoted below (verified) | [23][24] |
| Weave | **Yes**, standard addendum | No plan limit found | "This Business Associate Addendum … supplements the underlying agreement, including the Terms of Service … between Weave Communications, Inc. ("Weave", "Business Associate") and its client ("Client", "Covered Entity")" (verified, updated 2026-04-10) | [28] |
| Twilio (telephony layer) | **Yes**, editions only | Security or Enterprise Edition | "Customers wishing to sign a BAA with Twilio must have our Security Edition or Enterprise Edition." (verified) | [12] |
| ElevenLabs Agents | **Yes**, Enterprise only | Zero Retention Mode | "The signing of a BAA … is available only for Enterprise plan subscriptions." (search excerpt of vendor docs) | [19] |
| Synthflow | Probably Enterprise only | Third party reports ~$30K/yr (unverified) | Terms page returned 404 | n/a |
| Goodcall | Not stated | n/a | Its "HIPAA compliant AI software" post does not mention a BAA (verified) | [29] |
| Dialzara | Not stated | n/a | Blog says only "HIPAA-compliant" (unverified) | [30] |
| Smith.ai, Slang.ai, Rosie | No HIPAA/BAA page found | n/a | Not verified either way | n/a |
| Simbo.ai | Not verified | n/a | "HIPAA-compliant by design"; no customer-BAA statement found (unverified) | [31] |
| Arini | Unclear | n/a | "maintains HIPAA BAAs with all partners" (third-party profile, unverified; this may refer to its own vendors) | [32] |
| Annie (mysocialpractice / Dental Intelligence) | Not verified | n/a | "100% HIPAA compliant", no BAA mention (unverified) | [33] |

**Pattern.** Vendors that serve healthcare sign a BAA, often only on a higher tier. Several small-business AI receptionists (Goodcall, Dialzara, Rosie, Smith.ai, Slang) do not publish a BAA offer. None of them was found to sell a dental product while openly declining a BAA, which is our current position.

**"No PHI unless a BAA" clauses in Terms**, which is the approach we use:

- **Retell AI, Terms §13 (verified, reassembled from three contiguous fragments):** "Unless otherwise expressly agreed in writing, Retell AI does not act as a "Business Associate" as defined under HIPAA and disclaims any such obligations, and you will not use the Services to process HIPAA regulated personal health information unless we have expressly agreed to enter into a business associate agreement with you." Its §3 defines "Prohibited Data" to include PHI, and adds: "if the parties have executed a Business Associate Agreement ("BAA"), Protected Health Information is not considered Prohibited Data" [24].
- **Twilio, HIPAA Eligible Services (verified, last updated June 30, 2026):** "If you are a Covered Entity or Business Associate as defined by [HIPAA], you agree to not to use the HIPAA Eligible Services for any purpose or in any manner involving Protected Health Information without first entering into a Twilio Business Associate Agreement." [10]
- **Resend, Enterprise Terms (search excerpt):** the service "is not designed for" PHI, and PHI is allowed only if an Order Form expressly permits it under a BAA signed by both parties [17].

---

## Finding 3: the BAA chain for our stack

- **Twilio.** Its HIPAA Eligible Services list (last updated June 30, 2026) covers [10]:
  - Programmable Voice basics, including "Speech Recognition", "Text to Speech (Basic and Amazon Polly)", "Media Streams*" and "Conversation Relay*".
  - Programmable SMS and MMS, phone numbers and Messaging Features.
  - Asterisked items must follow Twilio's *Architecting for HIPAA* guide.
  - ConversationRelay was added on March 17, 2025.

  The list does not say whether every STT/TTS provider selectable inside ConversationRelay is covered. A Twilio changelog (Oct 23, 2025) calls Deepgram Nova-3 for Real-Time Transcription "HIPAA eligible" [13]. **ElevenLabs voices via ConversationRelay are unverified: assume not covered and use Polly.**
- **Edition price.** HIPAA accounts need Security or Enterprise Edition. Editions are sold by sales, with a 1-year minimum contract [12][14]. **No public price was found.**
- **Anthropic.** A BAA is available for a "HIPAA Ready API Org". The Primary Owner signs, then contacts sales to enable it. No minimum spend is stated [15].
  - Covered: the Messages API, including prompt caching, structured outputs and tool use, plus the Token Counting and Models APIs.
  - Excluded: the Batch API, Files API, Code Execution, Web Fetch and the Console.
  - Covered Models require 30-day retention, so ZDR is not required.
- **Claude through AWS Bedrock** under the AWS BAA is a known alternative, from general knowledge. **Verify** that Bedrock and the specific Haiku model are on AWS's HIPAA-eligible list [20].

### BAA cost table

| Vendor | BAA available? | Plan + monthly cost | Notes |
|---|---|---|---|
| Twilio (Voice, SMS, ConversationRelay, Polly TTS) | Yes | Security or Enterprise Edition, sales-quoted, 1-yr minimum; **price not public** | Largest unknown. Usage fees on top. Product list [10], edition rule [12] |
| Deepgram STT inside ConversationRelay | Partly (via Twilio) | Within the Twilio BAA if covered | Nova-3 eligible for Real-Time Transcription [13]. ConversationRelay provider coverage unverified. Deepgram direct BAA "upon request" [19] |
| Amazon Polly TTS | Yes | Via Twilio (listed) or the AWS BAA | Listed by Twilio [10] and on AWS's eligible list [20] |
| ElevenLabs TTS | Enterprise only | Enterprise (quote) | Drop it for dental [19] |
| Anthropic Claude API | Yes | HIPAA-ready org via sales; no published minimum; normal token prices | Haiku-class model coverage: confirm the "Covered Models" list [15] |
| Supabase | Yes | Team **$599/mo** + HIPAA add-on (price not on pricing page; third parties report ~$350/mo, unverified) | Free and Pro plans are not eligible [17a] |
| Railway | Yes | Enterprise or committed spend; July 2024 changelog: "customers above $1,000 of monthly committed spend" | Current pricing page says "Enterprise agreements add HIPAA BAAs", no figure [18a] |
| Resend | **No** | n/a | "not HIPAA compliant and cannot sign a Business Associate Agreement" [16]. Workaround: alerts with no PHI ("New booking, open dashboard"), or a BAA email vendor |
| Zapier | **No** (Enterprise included) | n/a | "we therefore don't offer a BAA" [18]. Remove from the dental flow |
| Google Calendar | Yes, under the **practice's** Google Workspace BAA | Paid Workspace plan (~$7+/user; plan eligibility varies by source) | It is the practice's calendar, so the practice signs with Google. We should not use our own Google account to hold PHI [34] |
| AWS (alternative host + DB + Bedrock) | Yes, self-serve AWS BAA via AWS Artifact (general knowledge, verify) | Pay-as-you-go, ~$50–200/mo at our scale (estimate) | Replaces Supabase, Railway and possibly the Anthropic direct BAA |

### Minimal monthly cost estimate (rough, for planning)

- **Path 1: keep the current vendors.** Supabase about $949 (or $599 plus an unknown add-on) + Railway about $1,000 committed + Twilio Edition (unknown) + Anthropic usage + an email workaround. That is **about $2,000/month before Twilio's edition fee**, plausibly $2,500–3,500 in total. Not viable for a small early-access pilot.
- **Path 2: AWS-centred.** AWS BAA for compute, Postgres and Bedrock Claude, about $100–250/mo. Polly comes through Twilio. Email carries no PHI. Calendar sits under the practice's Workspace BAA. Add the Twilio Security Edition. The total is about **$150–300/month plus the Twilio edition fee**, which is the gating unknown and must be quoted by Twilio sales.
- Either path also needs paperwork that money alone does not buy: a HIPAA risk analysis, policies, workforce training, breach procedures and a BAA template for clients. That is a one-time project, plausibly done with a compliance-platform template.

---

## Finding 4: minimum-data alternative (no reason, no health detail)

**Honest answer: still PHI.** With only name + phone + new/existing patient + preferred time, collected for a named dental practice:

- The data is "received by a health care provider" (through its agent, us).
- It "relates to … the provision of health care to an individual" (§160.103 "health information" [1]). Existing-patient status shows past care. The requested appointment is future care.
- Name and phone make it individually identifiable [1].

HHS treats the fact that a person is a patient of a provider as health information (see the de-identification example in §1.2, wording unverified). No HHS statement was found suggesting that scheduling data stripped of the reason falls outside PHI. Minimisation still lowers breach severity and is good practice. **It does not remove business-associate status or the BAA requirement. Option C is not available.**

---

## Recommendation

**Option B, corrected, now; plan Path 2 later.**

| # | Action | Status |
|---|---|---|
| R1 | Keep `/dental/` hidden and noindex as a waitlist that collects only a dentist's business email. Business contact data is not PHI. | resolved by product |
| R2 | Replace the FAQ answer "No. It collects only…", which is inaccurate under §160.103, with the text below. | resolved by product |
| R3 | Add the "not available to HIPAA covered entities until we sign a BAA" notice in the hero area and next to the form. | resolved by product |
| R4 | Do not onboard, pilot or demo with real callers for any dental, medical or other HIPAA covered entity until every vendor in the call path is under a BAA. | resolved by contract/product |
| R5 | Replace the "no BAA" wording in Terms §8, SA §12 and Privacy §11 with the clauses below, which follow the Retell and Twilio pattern. | resolved by contract |
| R6 | Add an onboarding question: "Are you a HIPAA covered entity (e.g., a dental, medical or therapy practice)?" A "yes" blocks activation. | resolved by product |
| R7 | Get a Twilio Security Edition quote and Anthropic's HIPAA-ready terms, and price the AWS-centred stack. | **needs money** |
| R8 | Write the HIPAA risk analysis, policies and client BAA template before the first dental client. | **needs money** (time or template cost) |
| R9 | Optional: re-scope the scripted demo away from "Toothache" until launch. It is a fictional demo with no data collected, so this is low risk; keeping it is acceptable once R2 and R3 are fixed. | resolved by product |

Option A (remove dental entirely) is also defensible. It is only needed if Meir prefers zero healthcare signalling. B with R2–R6 closes the legal gap, because no PHI flows while nobody is onboarded.

### Exact clause text

**Terms §8 Acceptable use.** Replace the third bullet with:

> - collect, store or transmit protected health information as defined under HIPAA ("PHI"), payment card numbers, Social Security numbers or similar sensitive data, unless we have both signed a written Business Associate Agreement ("BAA") that covers your account. If you are a HIPAA covered entity or business associate (for example, a dental, medical or therapy practice), you may not use the services until such a BAA is in place.

**Service Agreement §12, "Health information".** Replace the bullet with:

> - **Health information.** Unless we have both signed a Business Associate Agreement, we do not act as a "business associate" under HIPAA and you must not use the service to create, receive, maintain or transmit protected health information. You confirm that you are not a HIPAA covered entity or business associate, or that a signed BAA covers this Agreement. If you become one, tell us before you use the service with callers, and we may pause the service until a BAA is in place. Data submitted in breach of this section is your responsibility under section 16.

**Privacy §11.** Replace the paragraph with:

> Our services are not designed to collect health, financial-account or government-ID information. We do not act as a HIPAA business associate unless we have signed a written Business Associate Agreement with the client. Until then, the services are not available to HIPAA covered entities (such as dental and medical practices), and clients must not use them for protected health information. For dental practices we currently run an early-access email list only. It collects the practice's business contact details and no patient information.

### Dental page copy (consistent with the above)

- **hero.fine:** "Early access: not yet available to practices covered by HIPAA. We'll open once we can sign a Business Associate Agreement (BAA). Join the list and we'll email you."
- **pricing.note:** "Expected pricing. Practice management systems such as Dentrix or Open Dental get a custom quote. The service will open to dental practices only with a signed HIPAA BAA."
- **early.text:** "We're preparing a HIPAA-ready version with a signed Business Associate Agreement. Leave your work email and we'll write when it's ready. We collect only your email here. No patient information."
- **FAQ "Does it handle patient health information?":** "Yes. Patient name, phone number and appointment details from a dental practice are protected health information under HIPAA. That's why the dental version isn't live yet: we'll open it only once we can sign a Business Associate Agreement (BAA) with your practice and have one in place with every provider we use. Until then, please don't forward patient calls to our service."
- **included_items**, last bullet: change to "Will open only with a signed HIPAA BAA. No medical advice, no health history."
- **hero.lead:** drop "It collects only a name, a phone number and a general reason for the visit", because it implies safety. Suggested: "Your AI receptionist will answer the calls your team can't, text back anyone who hangs up, and book new-patient and urgent visits into your calendar."

---

## Sources (accessed 2026-10-12)

1. 45 C.F.R. §160.103, Definitions (via Cornell LII). https://www.law.cornell.edu/cfr/text/45/160.103
2. HHS OCR, *Business Associates* (guidance; list of examples). https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html. Excerpt only (403). Also https://www.hhs.gov/sites/default/files/ocr/privacy/hipaa/understanding/coveredentities/businessassociates.pdf
3. HHS OCR, *Direct Liability of Business Associates* fact sheet, announced May 24, 2019. https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/factsheet/index.html and https://www.hhs.gov/about/news/2019/05/24/new-hhs-fact-sheet-on-direct-liability-of-business-associates-under-hipaa.html
4. HHS FAQ, *Can a CSP be considered to be a "conduit" like the postal service…?* (cloud guidance, Oct 2016). https://www.hhs.gov/hipaa/for-professionals/faq/can-a-csp-be-considered-to-be-a-conduit-like-the-postal-service-and-therefore-not-a-business-associate-that-must-comply-with-the-hipaa-rules/index.html (excerpt)
5. HHS FAQ 2079, *What if a HIPAA covered entity (or business associate) uses a CSP to maintain ePHI without first executing a business associate agreement with that CSP?* https://www.hhs.gov/hipaa/for-professionals/faq/2079/what-if-a-hipaa-covered-entity-or-business-associate-uses-a-csp-to-maintain-ephi-without-first-executing-a-business-associate-agreement-with-that-csp/index.html (excerpt)
6. HHS OCR, *$750,000 settlement highlights the need for HIPAA business associate agreements* (Raleigh Orthopaedic Clinic, 2016). https://www.hhs.gov/hipaa/for-professionals/compliance-enforcement/agreements/raleigh-orthopaedic-clinic/index.html
7. HHS OCR, *$1.55 million settlement underscores the importance of executing HIPAA business associate agreements* (North Memorial, 2016). https://www.hhs.gov/hipaa/for-professionals/compliance-enforcement/agreements/north-memorial-health-care/index.html
8. HHS OCR, *No Business Associate Agreement? $31K Mistake* (Apr 20, 2017, Center for Children's Digestive Health), listed at https://www.hhs.gov/hipaa/for-professionals/compliance-enforcement/agreements/index.html. Facts per Bricker Graydon summary: https://www.bricker.com/benefits-insights/31000-settlement-no-business-associate-agreement
9. HHS OCR, MedEvolve settlement, $350,000 (May 16, 2023). https://www.hhs.gov/hipaa/for-professionals/compliance-enforcement/agreements/medevolve/index.html
10. Twilio, *HIPAA Eligible Services* (PDF, last updated June 30, 2026). https://www.twilio.com/content/dam/twilio-com/global/en/other/hipaa/pdf/HIPAA-Eligible-Services.pdf (via https://twil.io/HIPAA-eligible-products-and-services)
11. HHS FAQ, *Do the HIPAA Rules allow a covered entity or business associate to use a CSP that stores ePHI on servers outside of the United States?* https://www.hhs.gov/hipaa/for-professionals/faq/do-the-hipaa-rules-allow-a-covered-entity-or-business-associate-to-use-a-csp-that-stores-ephi-on-servers-outside-of-the-united-states/index.html (excerpt)
12. Twilio, *Twilio and HIPAA*. https://www.twilio.com/en-us/hipaa
13. Twilio Changelog, Oct 23, 2025, Real-Time Transcriptions supports Deepgram Nova-3, HIPAA eligible. https://static1.twilio.com/en-us/changelog/twilio-real-time-transcriptions-now-supports-deepgram--nova-3--a (excerpt)
14. Twilio Docs, *HIPAA Accounts* and *Twilio Editions*. https://www.twilio.com/docs/iam/twilio-editions/hippa and https://www.twilio.com/en-us/editions
15. Anthropic Privacy Center, *Business Associate Agreements (BAA) for Commercial Customers*. https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers; *Covered Models under a BAA*: https://support.claude.com/en/articles/15455031-covered-models-under-a-business-associate-agreement-baa
16. Resend, *Security* (FAQ). https://resend.com/security (excerpt)
17. Resend, *Enterprise Terms and Conditions*. https://resend.com/legal/enterprise-terms (excerpt)
17a. Supabase, *Pricing* ("HIPAA available as paid add-on" on Team, from $599/month) https://supabase.com/pricing; *HIPAA Compliance* docs https://supabase.com/docs/guides/security/hipaa-compliance
18. Zapier, *Enterprise Agreement FAQ*. https://zapier.com/legal/enterprise-agreement-faq (excerpt)
18a. Railway, *Compliance* docs https://docs.railway.com/enterprise/compliance; *Pricing* https://railway.com/pricing; changelog *HIPAA BAAs* (2024-07-12) https://railway.com/changelog/2024-07-12-hipaa-baas (excerpt)
19. ElevenLabs, *HIPAA* (Agents docs) https://elevenlabs.io/docs/agents-platform/legal/hipaa; Deepgram, *Data Privacy Compliance* https://developers.deepgram.com/docs/data-privacy-compliance (excerpts)
20. AWS, *HIPAA Eligible Services Reference*. https://aws.amazon.com/compliance/hipaa-eligible-services-reference/; Amazon Polly HIPAA eligibility: https://aws.amazon.com/blogs/machine-learning/amazon-polly-achieves-hipaa-eligibility
21. Frontdesk, *HIPAA-compliant answering service*. https://www.myaifrontdesk.com/hipaa-compliant-answering-service
22. Vapi Docs, *HIPAA*. https://docs.vapi.ai/security-and-privacy/hipaa
23. Retell AI, *Pricing*. https://www.retellai.com/pricing
24. Retell AI, *Terms of Service* (§3, §13). https://www.retellai.com/terms-of-service
25. Crowell & Moring, *Conduit Exception Remains Narrow Under New HIPAA Rule* (secondary, quoting the 2013 preamble). https://www.crowell.com/NewsEvents/AlertsNewsletters/all/Conduit-Exception-Remains-Narrow-Under-New-HIPAA-Rule
26. AccountableHQ, *HIPAA Violation Fine Amounts* (secondary, figures unverified). https://www.accountablehq.com/post/hipaa-violation-fine-amounts-penalties-by-tier-per-violation-and-annual-caps
27. HHS, *HHS Office for Civil Rights Settles HIPAA Ransomware Cybersecurity Investigation with Comstar, LLC* (May 30, 2025). https://www.hhs.gov/press-room/hhs-hipaa-comstar-agreement.html
28. Weave, *Business Associate Addendum* (updated 2026-04-10). https://www.getweave.com/legal/baa/
29. Goodcall blog, HIPAA post. https://www.goodcall.com/post/goodcalls-hipaa-compliant-ai-software-secure-data-management-for-local-and-enterprise-businesses
30. Dialzara blog. https://dialzara.com/blog/67de08f313cee397379a0c95 (unverified)
31. Simbo.ai blog. https://www.simbo.ai/blog/?p=23987 (unverified)
32. PlayHT profile of Arini. https://play.ht/blog/ai-apps/arini-ai (unverified, third party)
33. Annie AI page. https://mysocialpractice.com/annie-ai/ (unverified)
34. Google, *G Suite / Cloud Identity HIPAA Implementation Guide* (Mar 2022). https://services.google.com/fh/files/misc/gsuite_cloud_identity_hipaa_implementation_guide.pdf

*Gaps not closed: Twilio Security Edition price; the Supabase HIPAA add-on price; whether ElevenLabs and Deepgram, when chosen inside ConversationRelay, are covered by Twilio's BAA; whether the Anthropic BAA "Covered Models" include the Haiku 4.5-class model; the exact HHS de-identification wording; current 2026 penalty figures from the Federal Register. All of these need a direct check or a sales quote.*
