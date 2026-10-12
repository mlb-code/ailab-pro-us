# Residual legal risk 2 and 3: TCPA / state mini-TCPAs and call-recording consent

Research memo, prepared 2026-10-12 by a research agent. **This is not legal advice and was not written by a lawyer.** It collects public statutes, FCC orders, court decisions and competitor practice, so the owner can close what product and contract changes can close, and see clearly what is left. Each citation is marked **[verified]** when the primary text or a primary-source excerpt was read during this research, **[secondary]** when it comes from a law-firm or vendor summary only, and **[unverified]** when it is from general knowledge and was not checked in this session.

Files reviewed (read-only): `docs/kits/lawyer-package/service-agreement.md` §8, `docs/kits/lawyer-package/privacy.md`, `runtime/app/voice.py`, `voice_safe.py`, `sms.py`, `guard.py`.

---

## Summary

1. **Federal TCPA exposure for our texts is low.** The texts are informational, and the system does not use a random or sequential number generator, so after *Facebook v. Duguid* (2021) it is very likely not an "autodialer". A text is not an "artificial or prerecorded voice" (*Trim v. Reward Zone*, 9th Cir. 2023). If neither trigger applies, 47 U.S.C. §227(b) consent rules do not reach these texts at all. Consent is still the backstop if a court disagrees.
2. **Prior express consent (oral is enough), not written consent, is the federal standard for non-marketing texts.** Written consent applies only to advertising and telemarketing (47 C.F.R. §64.1200(a)(2), (f)(9)).
3. **The biggest federal gap:** the FCC's 1992 TCPA Order ¶31 says a number "captured" by Caller ID or ANI **"without notice"** to the caller is **not** consent. Our greeting gives no texting notice today. One sentence in the greeting ("we may text you about this call") plus an explicit "OK to text?" question at booking closes most of this gap.
4. **Revocation rules (47 C.F.R. §64.1200(a)(10)-(12), effective April 11, 2025) are in force.** Our STOP list is missing **"REVOKE"** and **"OPT OUT"**. It also only matches a message that is *just* the keyword, so "please stop texting me" or "don't text me" said on a call is not captured. These are concrete code gaps to fix.
5. **State mini-TCPAs (FL, OK, MD, CT, TX, WA, AZ, NJ, VA) cover only sales or solicitation messages.** Pure confirmations, reminders and "sorry we missed your call" texts are outside them, provided no offer, coupon or sales pitch is added. The safest time window for scheduled texts is **9 a.m.–8 p.m. in the recipient's local time (Sunday noon–8 p.m.)**. Today we check quiet hours in the *client's* time zone only.
6. **Competitors (Podium, Rosie, Goodcall, Slang, Smith.ai, AI Front Desk) all push consent duties onto the business customer by contract.** None that we could read promises consent capture. Podium's (Twilio-derived) messaging rules say a consumer-initiated contact is "consent and proof of consent", limited to "that particular conversation".
7. **Recording consent:** about 11–12 states require all-party consent. Real-time transcription is very likely "interception" under Florida §934.03 ("aural **or other** acquisition"), Washington ("recorded or transmitted") and California §631. California §632.7 covers "records", and a kept transcript is probably a record.
8. **Notice at the very start of the call, followed by the caller continuing, is the accepted way to get consent in every all-party state** (*Kearney v. Salomon Smith Barney*, Cal. 2006; RCW 9.73.030(3)). "This call may be transcribed" probably works, but it is the weakest wording. It should name recording/transcription **and** service providers.
9. **We (the vendor) are the "third party" that CIPA §631 lawsuits target** (*Ambriz v. Google*, N.D. Cal. Feb. 2025; *Taylor v. ConverseNow*, N.D. Cal. Aug. 2025). The best defenses are a disclosure that names service providers, and contract and technical proof that we and our subprocessors cannot use caller data for our own purposes (no training).
10. **Residual after the recommended changes:** a low but non-zero class-action risk (CIPA "capability" theory; a text-back to a caller who hung up before hearing any notice). It cannot be eliminated without a US entity, insurance or counsel. It can be documented and made expensive to plead.

---

## Part A: Risk 2, TCPA and state mini-TCPAs

### A.1 Federal law

**A.1.1 Does the TCPA reach these texts at all?**

- **Texts are "calls".** The FCC treats texts as calls under §227(b) (2003 TCPA Order, 18 FCC Rcd 14014 ¶165 **[unverified ¶]**). The Supreme Court accepted this in *Campbell-Ewald Co. v. Gomez*, 577 U.S. 153 (2016) **[unverified]**.
- **§227(b)(1)(A)(iii) is triggered only by (i) an ATDS or (ii) an artificial or prerecorded voice.**
  - **ATDS.** *Facebook, Inc. v. Duguid*, 592 U.S. 395 (2021) **[unverified, well known]**: equipment is an ATDS only if it can store or produce numbers using a random or sequential number generator. Our system texts only the number that just called, so it is very unlikely to be an ATDS.
  - **"Artificial or prerecorded voice".** A text has no voice. *Trim v. Reward Zone USA LLC*, 76 F.4th 1157 (9th Cir. 2023) **[unverified]** held that a text message is not a "prerecorded voice" call. The FCC's **Declaratory Ruling of Feb. 8, 2024 (FCC 24-17)** **[unverified number; content well known]** holds that AI-generated **voices** in calls are "artificial" voices. That ruling is about voice calls. It does not address AI-*written* text. Our AI voice is used only on **inbound** calls the caller placed. §227(b)(1)(A) and (B) restrict calls the business *makes*, so inbound AI voice is outside them.
- **§227(c) and the DNC rules (47 C.F.R. §64.1200(c)-(d))** apply to "telephone solicitations" and telemarketing. Confirmations, reminders and "how can we help?" texts are not solicitations, as long as they contain no sales content. *Butera v. Sugarhouse Real Estate Group*, 2025 WL 1798968 (D. Utah June 30, 2025) **[secondary]** held that returning a consumer's missed call was invited and was not an "unsolicited" second call.
- **Conclusion.** For these texts, federal liability under §227(b) needs a plaintiff to show ATDS use, which is hard after *Duguid*. Consent is the second line of defense. Because state "autodialer" definitions and future FCC action could change this, we design as if consent were required.

**A.1.2 What kind of consent?**

- Informational (non-telemarketing) automated calls and texts to a wireless number need **"prior express consent"**, which may be **oral**. Prior express **written** consent is required only for calls that "include or introduce an advertisement or constitute telemarketing" (47 C.F.R. §64.1200(a)(2) **[verified]**; definition in §64.1200(f)(9) **[verified]**; FCC 2012 TCPA Order, FCC 12-21, 27 FCC Rcd 1830 **[verified, read]**).
- *Bradford v. Sovereign Pest Control* (5th Cir. Feb. 25, 2026) **[secondary]** went further and held that even telemarketing needs only express consent, written or oral. It binds Texas, Louisiana and Mississippi only. A bill (Sept. 24, 2026) seeks to reverse it **[secondary]**. This does not affect us, because we send no marketing.
- *McLaughlin Chiropractic Assocs. v. McKesson Corp.* (U.S. June 20, 2025) **[unverified]** held that district courts are not bound by FCC interpretations under the Hobbs Act. FCC orders like the 1992 ¶31 are therefore persuasive, not binding. This makes the "caller ID = consent" question more open in both directions.

**A.1.3 Does calling the business (caller ID) give prior express consent?**

- **1992 TCPA Order, 7 FCC Rcd 8752, 8769 ¶31** (FCC 92-443): "persons who knowingly release their phone numbers have in effect given their invitation or permission to be called at the number which they have given, absent instructions to the contrary". The same paragraph adds that telemarketers "capturing telephone numbers by utilizing caller ID or an Automatic Number Identification device **without notice** to the residential telephone subscriber will be in violation of [the] TCPA rules, and capturing a telephone number does not indicate the called party's invitation or permission to receive autodialed or prerecorded calls" **[verified, as paraphrased by the FCC itself in FCC 12-21 n.20]**.
- **What this means for us.** A number taken *only* from caller ID, with no notice, is weak consent evidence. A number taken from caller ID **after notice** ("we may text you at this number about your call"), with the caller staying on the line, fits the "knowingly release ... absent instructions to the contrary" rule. A number the caller **confirms** ("yes, text me at this number") is strong.
- **Scope of consent.** FCC 2015 Omnibus Declaratory Ruling and Order (FCC 15-72, July 10, 2015) **[secondary for ¶ numbers]** confirms that consent is limited to the purpose for which the number was given. *Van Patten v. Vertical Fitness Group*, 847 F.3d 1037 (9th Cir. 2017) **[unverified]** holds that consent covers messages that relate to the reason the number was given. A text about the caller's own service request, booking or appointment falls squarely inside that scope. Promotions would not.
- **One-time "on-demand" reply.** The 2015 Omnibus Order (¶¶ around 103–106, "on-demand text offers") **[secondary]** holds that **one** text sent immediately in reply to a consumer's request, containing only the requested information, does not violate the TCPA. Our missed-call text is not a perfect fit, because the caller asked for a call, not a text. The rationale (consumer-initiated, prompt, single, no marketing) is the best federal analogy, and our design already matches it.
- **No case found** that squarely holds a single "sorry we missed your call" text is or is not lawful under §227(b). *Butera* (D. Utah 2025) supports the "invitation" logic for a return call under the DNC rules. One commentator (Dobronski, TCPAWorld comment) says caller-ID capture is not consent. That tracks ¶31's "without notice" sentence. **Residual: unsettled.**

**A.1.4 Revocation rules now in force**

- **FCC Report and Order, FCC 24-24 (Feb. 16, 2024)**, codified at 47 C.F.R. §64.1200(a)(10)-(12), effective **April 11, 2025** **[verified text summary from eCFR via Cornell]**:
  - (a)(10): consent may be revoked "by any reasonable means"; a reply text using words such as **"stop," "quit," "end," "revoke," "opt out," "cancel," or "unsubscribe"** is a per se reasonable revocation; requests must be honored "within a reasonable time not to exceed ten business days".
  - (a)(11): other means (voicemail, email, a sentence in a text, a request on a call) create a **rebuttable presumption** of revocation based on the totality of circumstances.
  - (a)(12): **one** confirmation text is allowed, with no marketing, sent within five minutes (presumed within consent).
- **The "revoke-all" part** (one opt-out stops all unrelated robocalls and robotexts from the caller) was waived until April 11, 2026 (DA 25-312, Apr. 7, 2025) **[secondary]**. It was then waived again until **January 31, 2027** (DA 26-12, Jan. 6, 2026) **[secondary]**.
- **New order, Oct. 1, 2026.** A new Report and Order and FNPRM was adopted Sept. 30, 2026 and released Oct. 1, 2026 (reported as **FCC 26-67**) **[secondary; two law-firm sources, number not confirmed on fcc.gov]**. It reportedly lets a sender treat an opt-out sent in reply to an **informational** message as covering only that category of informational messages. It also allows a text to disclose just one of the seven keywords. It takes effect 30 days after Federal Register publication, which had not happened as of Oct. 8, 2026.
- **Our position.** We stop **all** automated messages to the number after any opt-out. This is stricter than the rule, and it is the simplest correct behavior. **Keep it.**
- **Gaps found in `guard.py`:**
  1. `STOP_WORDS` lacks **REVOKE** and **OPT OUT** (normalized "OPTOUT").
  2. `sms_keyword()` counts only a message that is *exactly* the keyword. Under (a)(11), "Please stop texting me", "don't text me", or "take me off your list" is very likely a reasonable revocation.
  3. A request made **by voice** on a call ("don't text me") must also be honored.

**A.1.5 "One-to-one consent" rule**

The FCC's Dec. 2023 rule (requiring consent to be specific to one seller, for lead generators) was **vacated** by the 11th Circuit in *Insurance Marketing Coalition v. FCC*, No. 24-10277 (11th Cir. Jan. 24, 2025) **[secondary]**. It applied only to prior express **written** consent for marketing. It is irrelevant to our informational texts.

**A.1.6 Carrier rules (not law, but they decide whether messages get delivered)**

The CTIA Messaging Principles and Twilio's Messaging Policy require consent for every message. Podium's legal center reproduces the same text **[verified]**. It allows two "alternative consent" cases:

- (i) "Contact initiated by an individual ... the individual's inbound message to you constitutes both consent and proof of consent ... limited only to that particular conversation".
- (ii) "Informational content to an individual based on a prior relationship ... provided that individual provided their phone number to you, and has taken some action to trigger the potential communication ... Examples ... appointment reminders ... repair persons confirming service call times".

Our confirmations and reminders fit (ii). Our two-way replies fit (i). The **missed-call text-back** is the one message that fits neither cleanly. A phone call is not an inbound *message*, and a hang-up is arguably an "action to trigger" contact. This needs to be described honestly in the A2P 10DLC campaign "opt-in description" (see recommendation R2-9).

### A.2 State mini-TCPAs

| State | Statute | Non-marketing texts covered? | Time limits (recipient's local time) | Our 9 p.m.–8 a.m. block (client time zone) enough? |
|---|---|---|---|---|
| Florida | Fla. Stat. §501.059 (FTSA, amended by HB 761, 2023); hours in §501.059 / §501.616(6) | **No.** Applies to "telephonic sales call[s]" (calls or texts that solicit a sale) and, after 2023, only "unsolicited" ones made with an automated system for **selection and dialing** [secondary] | 8 a.m.–8 p.m.; 3 calls per 24 h on the same subject [secondary] | No for sales (8 p.m. end). Not applicable to our informational texts. |
| Oklahoma | 15 O.S. §§775C.1–775C.6 (OTSA, 2022) | **No.** Copy of the FTSA, limited to telephonic sales calls [secondary] | 8 a.m.–8 p.m.; 3 per 24 h [secondary] | Same as Florida |
| Washington | RCW 19.190.060 (CEMA, "commercial electronic text message" = text to **promote** goods or services) [unverified text]; RCW 80.36.390 (solicitation hours) | **No**, if the text does not promote. Keep text-back wording neutral ("How can we help?") | 8 a.m.–8 p.m. for solicitations [secondary] | Not applicable if no promotion |
| Maryland | Md. Com. Law §§14-4501–14-4503 (Stop the Spam Calls Act, 2023) | **No.** Covers "telephone solicitations" (calls, texts, voicemail) [secondary] | 8 a.m.–8 p.m. (one source says 9 a.m.) [secondary, conflicting] | Not applicable |
| Texas | Tex. Bus. & Com. Code chs. 302, 304, 305 (texts added by SB 140, eff. Sept. 1, 2025); hours §301.051 | **No.** Covers "telephone solicitation" [secondary] | 9 a.m.–9 p.m. Mon–Sat; noon–9 p.m. Sun [secondary] | Not applicable; stricter on Sunday |
| Connecticut | Conn. Gen. Stat. §42-288a (2023 amendments) | **No.** "Telephonic sales calls"; consumer-inquiry and non-commercial carve-outs [secondary] | **9 a.m.–8 p.m.** [secondary] | Not applicable; strictest weekday window |
| Georgia | O.C.G.A. §46-5-27 (no-call) [unverified] | Telephone solicitations only [unverified] | Not confirmed | Not confirmed |
| Arizona | A.R.S. §§44-1271–44-1278 (solicitation registration); 2024 amendments reportedly add texts [unverified] | Telephone solicitation only [secondary] | Federal default 8 a.m.–9 p.m. [secondary] | Not applicable |
| New Jersey | N.J.S.A. 56:8-119 to -135 | Unsolicited telemarketing sales calls only [secondary] | No calls 9 p.m.–8 a.m. [secondary] | Yes |
| Virginia | Va. Code §§59.1-510–518 | Telephone solicitation (texts covered) [secondary] | 8 a.m.–9 p.m. [secondary] | Yes |
| Federal | 47 C.F.R. §64.1200(c)(1) | Telephone solicitations only | 8 a.m.–9 p.m. called party's local time [unverified cite] | Partly: we use the client's time zone, not the recipient's |

**Conclusion.** No state law we found regulates the timing or consent of purely informational or transactional texts. All of them bite only if a message becomes a sales message. The real risk is **content drift**: a client edits the text-back to "Sorry we missed you! Book today and get 10% off". That single sentence turns the message into a telephonic sales call under the FTSA, OTSA and CT laws, and into telemarketing under federal law (prior express written consent). **The text-back and reminder templates must be locked against promotional edits.**

**Safest nationwide window** (recommended for every message that is not an immediate reply):

- Send only between **9:00 a.m. and 8:00 p.m. Monday–Saturday and 12:00 noon–8:00 p.m. Sunday**.
- Evaluate the window in **both** the client's time zone and the recipient's time zone (inferred from area code); both must be inside it.
- Covers CT (9–8), FL, OK, MD, WA (8–8), TX (Sunday noon) and the federal 8–9 rule.

### A.3 Industry practice (exact language found)

| Vendor | What they say | Source |
|---|---|---|
| **Podium** | Terms of Service v6.4 §5.2: Services are for communicating "only with Client's own current Customers who have consented to the receipt of such communications"; some AI Services involve "the monitoring or capture of real-time transcription of Customer communications by Podium that requires informed consent from Customers"; Client will "provide all required disclosures to Customers and obtain all required consents". Messaging rules: inbound message "constitutes both consent and proof of consent ... limited only to that particular conversation". Privacy policy: "Clients are responsible for obtaining any required consent from call participants in order to record calls". No missed-call-specific TCPA help page was found. | legal.podium.com [verified] |
| **Rosie (heyrosie.com)** | "The Services will create an audio recording of each call ... and will generate transcripts". "Rosie will provide courtesy template notices to inform your Callers that their call is being recorded so that the Caller can consent by continuing with the call or withhold consent by ending the call. You decide through your Account settings whether and how to implement such templates ... You are solely responsible ..." | heyrosie.com/legal/terms [verified] |
| **Goodcall** | Users may not "violate any applicable ... law ... including laws against recording users without their knowledge or consent"; customer information "may be recorded via the Service". No texting-consent clause found. | help.goodcall.com ToS [verified] |
| **Slang.ai** | "Before any End User engages with Customer in a manner that uses the Services, Customer warrants and will ensure that it provides all notices and obtains all consents required under applicable law". | slang.ai/terms-of-service [verified] |
| **My AI Front Desk** | User must comply with "the Telephone Consumer Protection Act (TCPA), the Telemarketing Sales Rule (TSR), and any state-specific telemarketing regulations"; §31.4 "If you enable call recording for outbound calls, you are responsible for obtaining consent". | myaifrontdesk.com/terms [verified] |
| **Smith.ai** | Terms page not retrievable (404). Privacy policy (updated Sept. 29, 2026) records SMS "consent record (including the date and time of opt-in)" for its *own* texts. Its SVP Growth is quoted: "Consent notification must occur at the beginning of the call before any substantive business discussion." | smith.ai/privacy [verified]; quote [secondary] |
| **Dialzara** | Terms define "Call Content" to include "audio recordings, voicemails, transcripts"; customer owns it. Consent clause not retrievable. | [secondary] |
| **Textline** | "Implied consent can only be used for conversational messaging"; informational messages "require prior express consent"; recommends express written consent "to protect your business". | textline.com compliance portal [verified] |
| **Ruby, Synthflow** | Ruby keeps call recordings ≤ 90 days (terms excerpt). Synthflow terms (German law) contain no caller-consent clause found. | [verified excerpts] |

**Pattern.** Every vendor makes the business the party responsible for consent. None was found to ask the caller for text consent in the greeting by default. Rosie is the only one that offers a ready "continue = consent" recording template. **Asking for and logging text consent would put us ahead of the market.** That is a sales point as well as a defense.

---

## Part B: Risk 2 recommended changes

Each item is marked **[resolved by product]**, **[resolved by contract]**, or **[residual]**.

**R2-1. Greeting adds a text notice (one sentence).** **[resolved by product, mostly]**
Exact constant to add next to `DISCLOSURE` (see R3-1 for the combined greeting):
`TEXT_NOTICE = "We may text you at this number about your call."`
This turns caller-ID capture "without notice" (1992 Order ¶31) into capture *with* notice. It must be **non-removable**. Today `greeting()` re-appends only the recording disclosure. The same check must cover the text notice. If a client's custom greeting lacks it, append it.

**R2-2. Explicit consent question at booking, logged.** **[resolved by product]**

- Before sending any confirmation or reminder, the AI asks exactly: **"Can I text your confirmation and a reminder to the number you're calling from?"** If the caller gives a different number, it uses and confirms that one.
- Log: `sms_consent = yes | no | not_asked`, `consent_source = "voice_booking"`, `consent_utterance` (the caller's exact transcribed words), `consent_prompt_version`, `call_sid`, `from_e164`, `timestamp_utc`.
- On "no": send no confirmation or reminder, and tell the client in the lead alert.

**Which is stronger: notice (R2-1) or asking (R2-2)?** Asking with a logged "yes" is stronger. It is "express" consent, not merely "knowingly released". An oral "yes" is valid prior express consent for informational messages (1992 Order ¶31; FCC 12-21). Nothing in the TCPA requires the person collecting it to be human. The evidence is the transcript line plus Twilio's call record (call SID, timestamps, caller ID) held by an independent third party. **Use both:** the notice covers the text-back, and the question covers confirmations and reminders.

**R2-3. Text-back content rules (locked template).** **[resolved by product + contract]**

- Exactly one message per missed call, max one per number per 24 h (already in `voice_safe`).
- Content only: business name, apology, offer to help, STOP. No links, prices, offers, coupons, reviews requests, or "book now".
- Allowed wording (client may change only `[Business Name]`):
  `"Hi, this is [Business Name]. Sorry we missed your call. How can we help? Reply STOP to opt out."`
- Send within **5 minutes** of the call ending. If the window is missed (for example, quiet hours), send the next morning only if the caller has not called back, and only once.
- Do **not** send if the number is opted out, a landline, on the client's blocklist, or flagged as spam.

**R2-4. Two-way AI SMS replies.** **[resolved by product]**

- Only in reply to the caller's own inbound text. That inbound text is "consent and proof of consent ... limited ... to that particular conversation" (Twilio/Podium messaging rule).
- AI replies must stay on the caller's request. The system prompt must forbid promotions and upsells.
- No AI-initiated follow-ups after the conversation goes quiet. One scheduled reminder is allowed only if R2-2 consent exists.

**R2-5. Revocation across channels.** **[resolved by product]**
Fix `guard.py`:

1. `STOP_WORDS |= {"REVOKE", "OPTOUT", "STOPALL"}` (normalized). Keep CANCEL. **Note on CANCEL in a booking context:** a caller who texts "cancel" may mean *cancel my appointment*. The rule makes "cancel" a per se revocation, so treat it as STOP. Send the one allowed confirmation, adapted: `"[Business]: you won't get more texts from us. To cancel or change your appointment, call [phone]. Reply START to resume texts."` This is allowed under (a)(12) as long as it has no marketing and is the only message.
2. Add a natural-language opt-out detector before the AI. Any message matching phrases such as *stop texting, don't text, do not text, remove me, take me off, unsubscribe, no more texts, leave me alone, wrong number* is treated as STOP. Ambiguous cases are treated as STOP (stricter is safer).
3. **Voice:** if the caller says on the call "don't text me" or similar, the AI answers "Got it, we won't text you." It then sets `opted_out` with `source="voice"` and the utterance logged. No confirmation, booking or reminder texts are sent.
4. Honor revocations immediately (rule allows 10 business days; we do it instantly). Keep the opt-out record for the life of the account **plus 5 years**.

**R2-6. Time window.** **[resolved by product]**

- For the text-back: keep the current block, but compute it in **both** the client's and the caller's area-code time zone. Both must be between **8:00 a.m. and 9:00 p.m.**
- For scheduled messages (reminders, any queued text-back): **9:00 a.m.–8:00 p.m. Mon–Sat and 12:00–8:00 p.m. Sun**, in both time zones. Schedule the 24-hour reminder inside that window (for example, a 7 a.m. appointment gets its reminder at 6–8 p.m. the day before).
- Direct replies to the caller's own text may go at any hour (they are conversational).

**R2-7. Landline / VoIP checks.** **[resolved by product]**

- Keep the Twilio Lookup line-type check. Do not text `landline`.
- For `nonFixedVoip`/`fixedVoip`, sending is allowed: these can receive SMS, and the TCPA §227(b)(1)(A)(iii) cell-phone rule is about "cellular telephone service". Log the line type with each message.
- Do not text toll-free or short-code callers.

**R2-8. Evidence retention.** **[resolved by product]**

- Keep a **consent-and-opt-out ledger**, separate from transcripts. For every outbound message: number, line type, message type, template version, consent basis (`caller_initiated_notice` / `voice_booking_yes` / `inbound_text`), call SID, timestamps, opt-out status at send time.
- Retain for **5 years**. The TCPA limitation period is 4 years under 28 U.S.C. §1658 **[unverified]**, and some state limits are shorter.
- Keep only the consent excerpt (the "yes" line and the greeting version that played), not the full transcript. Full transcripts keep the 90-day rule. Add this ledger to the privacy policy retention table.

**R2-9. A2P 10DLC campaign description.** **[resolved by product]**
Describe opt-in truthfully:

> "Consumers call the business. The phone greeting says texts may follow and the assistant asks permission before sending confirmations and reminders. One informational text is sent to callers whose call was missed. Consumers who text the number initiate a conversation. STOP/HELP supported."

Sample messages = the locked templates. A misleading opt-in description is a common rejection and suspension reason.

**R2-10. Updated Service Agreement §8.** **[resolved by contract]** Replace §8 items 2, 3, 4, 5 and 8 and the closing representation with:

> **8. Calls, texts and consent (SMS / TCPA)**
>
> **You are the sender of record.** Calls are answered and texts are sent in your business's name, on your behalf. You are responsible for having any consent the law requires. To help you, the service collects and logs consent in the ways described below, and you agree not to change these settings. We do not give legal advice and do not promise that these steps are enough for every caller or every state.
>
> 1. **Inbound only.** The AI answers calls that callers make to you. It does not place outbound calls with an artificial or AI voice.
> 2. **Notice in the greeting.** Every AI-answered call starts with a notice that the caller is speaking with an AI assistant, that the call may be recorded and transcribed by our service providers, and that the business may text the caller at that number about the call. You cannot remove or shorten this notice.
> 3. **Texts we send, and the consent basis for each.**
>    (a) *Missed-call text:* at most one text per missed call (and no more than one per number in 24 hours), sent soon after the caller's own call, with fixed wording that names your business and says "Reply STOP to opt out." You can change only your business name in it.
>    (b) *Booking confirmation and one reminder:* sent only if the caller said yes when the assistant asked, during the call, whether it may text a confirmation and a reminder. The answer is logged with the time and the call record.
>    (c) *Replies:* the AI texts back only in a conversation the caller started or continued by texting.
>    No marketing, promotional, review-request or sales texts are sent through the service, and you agree not to ask for them or add such content to any template.
> 4. **Opt-out.** STOP, QUIT, END, REVOKE, OPT OUT, CANCEL, UNSUBSCRIBE, any message that clearly asks not to be texted, and a spoken request on a call are honored right away for all automated messages to that number, until the person texts START. One confirmation text may be sent. If a caller asks you directly (in person, by email or on your own phone) not to be texted, you must tell us, and we will add the number to the opt-out list within one business day.
> 5. **Time window.** Messages that are not a direct reply to the caller are sent only between 9:00 a.m. and 8:00 p.m. (noon to 8:00 p.m. on Sundays), checked in both your time zone and the caller's likely time zone. A missed-call text is not sent between 9:00 p.m. and 8:00 a.m.
> 6. **Landlines.** The system checks the number type and does not text landlines.
> 7. **Records.** We keep a log of the consent basis, time and number for each text, and of each opt-out, for five years, and we will give you a copy on request to answer a complaint or claim.
> 8. **SMS registration (A2P 10DLC).** [unchanged]
>
> You represent that: (a) you have the right to receive and respond to calls and texts at the numbers you forward to us; (b) you will not ask us to text anyone who has not called or texted you, or to send marketing texts; (c) you will promptly forward to us any opt-out request you receive outside the service; and (d) you will not use the service in a way that breaks the TCPA, state telemarketing or call-recording laws, or carrier rules. You will indemnify us for claims caused by your breach of this section, including content you add and contacts you ask us to make. We do not claim that the service makes your business compliant with any law.

(Note: item 7 "AI disclosure" and item 8 "Transcription notice" from the current §8 move into the recording paragraph in Part D.)

---

## Part C: Risk 3, call recording and interception consent

### C.1 All-party consent states (telephone calls)

| State | Statute | Notes |
|---|---|---|
| California | Cal. Penal Code §631 (wiretapping, including by third parties and "aiding"), §632 ("confidential communication", recording or eavesdropping), §632.7 (cellular or cordless calls; "intercepts or receives and intentionally records") | §632.7 has no "confidential" requirement and binds parties as well as eavesdroppers: *Smith v. LoanMe, Inc.*, 11 Cal.5th 183 (2021) [secondary]. Private action §637.2: $5,000 per violation [unverified amount]. |
| Florida | Fla. Stat. §934.03(1)(a), (2)(d) | Lawful only "when all of the parties to the communication have given prior consent" [verified]. "Intercept" = aural **or other** acquisition of contents (§934.02(3)) [unverified]. |
| Washington | RCW 9.73.030(1), (3) | All-party. Consent is "considered obtained whenever one party has announced to all other parties ... in any reasonably effective manner, that such communication ... is about to be recorded or transmitted", and if recorded, the announcement itself must be recorded [secondary, codified text]. |
| Illinois | 720 ILCS 5/14-2(a) | All-party, but since 2014 only for **surreptitious** recording of private conversations. Open notice defeats "surreptitious" [unverified]. |
| Pennsylvania | 18 Pa.C.S. §5704(4) | Lawful where "all parties to the communication have given prior consent" [unverified]. Notice plus continuing = implied consent in Pa. case law [unverified]. |
| Maryland | Md. Cts. & Jud. Proc. §10-402(c)(3) | All-party [unverified]. |
| Massachusetts | G.L. c. 272 §99 | Bars **secret** recording. Notice defeats it [unverified]. |
| Montana | Mont. Code §45-8-213 | All-party, with an exception for persons given warning [unverified]. |
| New Hampshire | RSA 570-A:2 | All-party [unverified]. |
| Connecticut | Conn. Gen. Stat. §52-570d (civil, phone) | Consent, verbal notice recorded at the start, or warning tone [unverified]. |
| Nevada | NRS 200.620; *Lane v. Allstate*, 114 Nev. 1176 (1998) | Wire calls read as all-party [unverified]. |
| Delaware | 11 Del. C. §1335 vs §2402 | Statutes conflict; treat as all-party [unverified]. |
| Oregon | ORS 165.540 | One-party for phone; all-party for in-person (not our case) [unverified]. |
| Michigan | MCL 750.539c | Eavesdropping statute; a participant may record (*Sullivan v. Gray*) [unverified]; treat as cautious. |

### C.2 Is real-time transcription without stored audio "recording" or "interception"?

- **Interception.** Very likely yes in FL (aural *or other* acquisition), CA §631 (reading or learning "contents" while in transit, attempting to, or using the information), PA and WA ("recorded **or transmitted**"). Audio streams from Twilio to Deepgram and text to Anthropic. That is acquisition and transmission of contents in transit. Not storing audio does **not** avoid interception statutes.
- **Recording.** A retained, verbatim transcript is very likely a "record" for §632 and §632.7. No appellate ruling resolves this **[secondary: commentators call it "an open question"]**. Assume it is.
- **AI vendor lawsuits (the active wave):**
  - *Ambriz v. Google LLC*, No. 3:23-cv-05437-RFL (N.D. Cal. Feb. 10, 2025), 2025 WL 830450 **[secondary, multiple sources]**. The motion to dismiss was denied. Google's Cloud Contact Center AI (real-time transcription and suggestions for businesses) can be a §631 "third party" under the **capability test**: it is enough that the vendor is *capable* of using the data for its own purposes, without proof that it did. Discovery is ongoing as of Sept. 2026.
  - *Taylor v. ConverseNow Technologies*, No. 3:25-cv-00990-SI (N.D. Cal. Aug. 11, 2025) **[secondary, multiple sources]**. The court denied dismissal of §§631 and 632 claims against an **AI voice assistant answering restaurant phone orders** (Domino's). This is the closest case to our product. Allegations that the vendor used call data to improve its own product defeated the "mere tool / agent of the business" defense.
  - *In re Otter.AI Privacy Litigation* (N.D. Cal.): partial denial of dismissal, reported Aug. 13, 2026, on AI note-taker transcription **[secondary, single source]**.
  - *Thompson v. SoundHound AI* (Alameda Cty. Super. Ct., filed July 30, 2026), §§631 and 632.7 against AI voice agents on restaurant lines. Complaint only **[secondary]**.
  - *Javier v. Assurance IQ, LLC*, 2022 WL 1744107 (9th Cir. May 31, 2022) (unpublished) **[unverified cite]**: §631 requires **prior** consent of all parties; consent given after the interception began does not cure it. Notice must come **before** substantive content is captured.
  - The split: "extension" test (vendor is a tool of the party: *Graham v. Noom*, N.D. Cal. 2021; *Yockey v. Salesforce*, 2024) **[unverified]** vs "capability" test (*Javier* on remand, *Ambriz*). The Ninth Circuit has not settled it.
- **California SB 690** (signed Sept. 30, 2026, effective Jan. 1, 2027) **[secondary]** in its final form only limits private suits over website and app pen-register / trap-and-trace (§638.51). It **does not** change §§631, 632, 632.7. The broad "commercial business purpose" exemption was removed in July 2026.

### C.3 Is notice at the start plus continuing enough?

- **California.** *Kearney v. Salomon Smith Barney, Inc.*, 39 Cal.4th 95 (2006) **[secondary for quote]**: a business that "adequately advises all parties to a telephone call, at the outset of the conversation, of its intent to record the call" does not violate §632. Continuing after notice defeats the expectation of confidentiality. The same logic is used for implied consent under §§631 and 632.7.
- **Washington.** The statute itself (RCW 9.73.030(3)) makes an announcement "in any reasonably effective manner" equal to consent. **The announcement must itself be recorded if the call is recorded.** Our transcript stores the greeting as turn 0 (`voice.py` appends `greeting(tenant)` to the transcript). Keep this, and also log the greeting version ID.
- **Florida.** No statutory announcement rule. Florida courts accept implied consent from notice plus continuing **[unverified case]**. Use the same start-of-call notice.
- **Illinois, Massachusetts.** Open notice removes "surreptitious" or "secret".
- **Pennsylvania.** "Prior consent" from notice plus continuing **[unverified]**.
- **"May be transcribed" vs "may be recorded".**
  - "Transcribed" is accurate but less familiar, and it does not mention *who* hears the call.
  - Recommended: say **"recorded and transcribed"**. Over-disclosure ("recorded" when audio is not kept) carries no realistic legal risk. Twilio and Deepgram do capture audio transiently. Washington's statute speaks of being "recorded or transmitted", and the familiar word "recorded" makes the notice "reasonably effective".
  - Do not *promise* "we never record". The privacy policy can say audio is not stored.
- **Third-party vendors.** Commentators argue a generic "may be recorded for quality" notice may not cover a third-party AI vendor's own use **[secondary, advocacy position]**. Naming "an AI assistant and its service providers" in the greeting directly addresses the *Ambriz* / *Taylor* theory that the caller did not know a third party was listening.

### C.4 Our exposure as the vendor

- **We, Twilio, Deepgram, Anthropic and ElevenLabs/Polly are all potential "third parties"** under §631 (capability test). The client's disclosure covers us only if it tells the caller a third party is involved, or if a court treats us as the client's tool (extension test).
- **Facts that help us:**
  1. We are a service provider under the privacy policy and do not use caller data for our own purposes.
  2. The Anthropic commercial API does not train on inputs by default (privacy.md §5).
  3. Audio is not stored.
  4. Transcripts are deleted at 90 days.
- **Facts that hurt us:**
  1. Under *Ambriz*, *capability* alone may be pleaded.
  2. **Deepgram** has a "Model Improvement Program". Whether audio sent via Twilio ConversationRelay is opted out is **unverified** and must be checked.
  3. "Training" or "quality improvement" language anywhere in our own terms would be used against us.
- **Competitor disclosures:** see A.3. Rosie offers a "continue = consent" template but leaves it optional. Podium contractually requires "informed consent" for "real-time transcription ... by Podium". No competitor greeting text that names vendors was found.

---

## Part D: Risk 3 recommended changes

**R3-1. Exact greeting (combined, short, non-removable).** **[resolved by product, mostly]**
Default:

> "Thanks for calling {Business}. I'm the virtual assistant, an AI. This call may be recorded and transcribed by us and our service providers, and we may text you about it. How can I help?"

- Spoken length is about 9–10 seconds.
- Replace the constants: `DISCLOSURE = "This call may be recorded and transcribed by us and our service providers, and we may text you about it."`
- Enforcement: in `greeting()`, require a case-insensitive check for **all** of these: `"recorded"`, `"transcribed"`, `"service providers"`, `"text"`. If any is missing from a custom greeting, append the full `DISCLOSURE`. (Today the check passes if *either* "transcri" or "record" appears, so a client greeting saying only "calls may be recorded for quality" would drop the vendor and text parts.)
- The same constant applies in `voice_safe.safe_greeting()`.
- The disclosure must play **before** any caller speech is sent to the LLM. Speech-to-text runs from the first moment, so the greeting must start immediately on answer, with no barge-in processing before the disclosure ends. **Suppress barge-in until the disclosure sentence has finished.**

**R3-2. Objection rule.** **[resolved by product]**

- If the caller says anything like "don't record this", "I don't consent", or "stop transcribing", the AI says: **"No problem. I'll stop here. Please leave your name and number after this and the team will call you back, or call back during business hours."**
- Then end the AI session.
- Store **no transcript content after the objection.** Mark the call `recording_objection=true` and keep only metadata: number, time, "caller objected".
- The team gets an alert: "Caller asked not to be recorded; call them back."
- A simpler alternative is to transfer the call to the client's line if live handoff is on.
- Discard the pre-objection turns too, except the greeting line (which proves notice).

**R3-3. Retention.** **[resolved by product]**

- Transcripts: keep 90 days (current), and let the client choose 30 or 90.
- Greeting/disclosure version log and consent ledger: 5 years (see R2-8).
- Statutes of limitation: CIPA claims are generally 1 year (Cal. Code Civ. Proc. §340) **[unverified]**, Washington 3 years **[unverified]**. The 5-year ledger covers all.

**R3-4. Vendor settings and contract (reduce "capability").** **[partly resolved by product, partly residual]**

- Confirm and record in writing that Deepgram processing via Twilio is excluded from model improvement. If it is not, enable an opt-out (Deepgram API parameter `mip_opt_out=true` **[unverified that ConversationRelay exposes it]**) or switch the STT provider.
- Confirm that Twilio AI/ML features (for example, Voice Intelligence training) are not enabled.
- Keep the Anthropic API, which does not train by default.
- Add to the SA and privacy policy: "We and our service providers do not use callers' information to train AI models or for any purpose other than providing the service to your business."

**R3-5. Service Agreement §8 replacement paragraph ("AI and recording notice").** **[resolved by contract]**

> **AI and recording notice.** Every AI-answered call begins with a spoken notice that the caller is speaking with an AI assistant and that the call may be recorded and transcribed by us and our service providers. The notice plays before the assistant processes anything the caller says, and you cannot remove or shorten it. Call audio is streamed to our service providers to convert speech to text and text to speech and is not stored by us. Transcripts are kept for 90 days (or a shorter period you choose) and then deleted. If a caller objects to recording or transcription, the assistant stops, does not keep a transcript of the conversation after the objection, and alerts you to call the person back. We and our service providers process call content only to provide the service to you and do not use it to train AI models. The laws of some states require all parties to a call to consent to its recording or interception. The notice is designed so that a caller who continues the call after hearing it consents, which is the approach courts and statutes in those states generally accept. You will not instruct callers or use the service in a way that conflicts with the notice, and you will tell us if you need a different notice for a specific state or industry.

**R3-6. Privacy policy.** **[resolved by contract]**
Add "AI and recording notice" text to the callers' section, mirroring R3-5. Add the consent ledger (5 years) to the retention table.

---

## Residual list (what product and contract cannot close)

| # | Residual | Level | Why it remains |
|---|---|---|---|
| 1 | Missed-call text to a caller who hung up **before** the greeting's text notice played | Low–moderate | Consent rests on caller-initiated contact only. ¶31 says caller-ID capture "without notice" is not consent. No case squarely decides it. It is mitigated by: one message, informational, no ATDS (*Duguid*), and STOP. **Optional stricter mode:** send the text-back only if the notice finished playing. This trades away part of the feature. |
| 2 | ATDS definition under state laws (FL "selection and dialing" applies only to sales calls) and future FCC rules on AI-generated texts | Low | Outside our control; monitor. |
| 3 | CIPA §631 "capability" claims against us as a third-party AI vendor (*Ambriz*, *Taylor*) | Moderate (California callers) | Pleading standard is low. Notice naming service providers and no-training proof are the defenses, but class actions can still be filed. No US entity and no insurance. |
| 4 | Whether a kept transcript is a "recording" under §632.7 | Open question | No appellate ruling. |
| 5 | Client circumvents the product (adds promos, texts non-callers, ignores off-platform opt-outs) | Low–moderate | Covered by contract and indemnity, but an indemnity from a small contractor may be worth little. |
| 6 | FCC 26-67 (Oct. 2026) and the "revoke-all" rule (Jan. 31, 2027) may change revocation scope | Low | We already apply a stricter "stop everything" rule. |
| 7 | All statements marked [secondary] or [unverified] in this memo | n/a | Need confirmation by US counsel or primary text before relying on them in a dispute. |

---

## Sources (accessed 2026-10-12)

1. 47 U.S.C. §227 (TCPA). [general knowledge; not fetched]
2. 47 C.F.R. §64.1200 (eCFR via Cornell LII): https://www.law.cornell.edu/cfr/text/47/64.1200
3. FCC 12-21, TCPA Report and Order (Feb. 15, 2012), n.20 quoting 1992 TCPA Order ¶31 (caller ID "without notice"): https://transition.fcc.gov/Daily_Releases/Daily_Business/2012/db0215/FCC-12-21A1.pdf
4. FCC 24-24, Consent revocation Report and Order (Feb. 16, 2024): https://docs.fcc.gov/public/attachments/FCC-24-24A1.pdf
5. DA 25-312, revoke-all waiver (Apr. 2025): https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf
6. Burr & Forman, "FCC Delays Effective Date of TCPA Revoke-All Rule Until January 31, 2027" (DA 26-12): https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027
7. FCC, "CGB Extends the Effective Date of the TCPA's Consent Revocation Rule": https://www.fcc.gov/document/cgb-extends-effective-date-tcpas-consent-revocation-rule
8. RecordingLaw, "FCC Adopts New TCPA Consent Revocation Rule" (FCC 26-67): https://www.recordinglaw.com/news/fcc-tcpa-consent-revocation-order/
9. Covington Inside Global Tech, "Update: FCC adopts final order and further notice on TCPA consent revocation" (Oct. 2, 2026): https://www.insideglobaltech.com/2026/10/02/update-fcc-adopts-final-order-and-further-notice-on-tcpa-consent-revocation/
10. TCPAWorld, *Butera v. Sugarhouse* (D. Utah June 30, 2025): https://tcpaworld.com/2025/07/01/invitation-court-refuses-to-allow-litigators-to-manufacture-tcpa-claims-holds-a-company-can-safely-return-a-missed-call-without-violating-the-tcpas-dnc-provisions/
11. Holland & Knight, *Bradford v. Sovereign Pest Control* (5th Cir. 2026): https://www.hklaw.com/en/insights/publications/2026/03/tcpa-reset-fifth-circuit-rejects-prior-express-written-consent-rule
12. Kelley Drye, "Eleventh Circuit Vacates TCPA 1:1 Consent Rule": https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/eleventh-circuit-vacates-tcpa-11-consent-rule
13. Federal Register, 2015 TCPA Omnibus (80 FR 61129, Oct. 9, 2015): https://www.govinfo.gov/content/pkg/FR-2015-10-09/html/2015-25682.htm
14. Perkins Coie, "The July 2015 TCPA Omnibus Declaratory Ruling and Order": https://perkinscoie.com/en/news-insights/the-july-2015-tcpa-omnibus-declaratory-ruling-and-order-the-good.html
15. Florida HB 761 (2023) staff analysis: https://www.flsenate.gov/Session/Bill/2023/761/Analyses/h0761e.COM.PDF
16. Quarles, "Amendments to the Florida Telephone Solicitation Act": https://www.quarles.com/newsroom/publications/a-return-to-relative-sanity-amendments-to-the-florida-telephone-solicitation-act
17. Fla. Stat. §934.03: https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0900-0999/0934/Sections/0934.03.html
18. RCW 9.73.030 (codified text via codepublishing): https://www.codepublishing.com/WA/RCW/9.73.030 ; RCFP Washington guide: https://www.rcfp.org/reporters-recording-guide/washington/
19. Enzo Dialer, "State Mini-TCPA Laws: The 2026 Tracker": https://enzodialer.com/resources/compliance/state-mini-tcpa-laws
20. JustCall, "State-by-State Mini-TCPA Laws in 2026": https://justcall.io/blog/state-mini-tcpa-laws.html
21. Podium Legal Center (ToS v6.4 §5.2, messaging consent rules, privacy policy): https://legal.podium.com/
22. Rosie Terms: https://heyrosie.com/legal/terms
23. Goodcall Terms of Service: https://help.goodcall.com/en/articles/8007566-terms-of-service
24. Slang.ai Terms of Service: https://www.slang.ai/terms-of-service
25. My AI Front Desk Terms: https://www.myaifrontdesk.com/terms
26. Smith.ai Privacy Policy: https://smith.ai/privacy
27. Textline Security and SMS Compliance Portal: https://www.textline.com/security-and-compliance-portal
28. Synthflow Terms: https://docs.synthflow.ai/docs/terms-conditions
29. *Taylor v. ConverseNow Technologies*, No. 3:25-cv-00990 (N.D. Cal. 2025), Doc. 35: https://law.justia.com/cases/federal/district-courts/california/candce/3:2025cv00990/443577/35/ ; Wilson Sonsini summary: https://www.wsgr.com/en/insights/us-federal-court-allows-cipa-class-action-against-ai-customer-service-provider-to-proceed.html
30. *Ambriz v. Google* status tracker: https://ailawsuittracker.com/cases/ambriz-v-google-llc-3-23-cv-05437/ ; ZwillGen: https://www.zwillgen.com/privacy/federal-judge-allows-google-customer-service-ai-class-action-to-proceed/ ; Goodwin: https://www.goodwinlaw.com/en/insights/publications/2025/02/alerts-practices-dpc-ftec-ai-voice-products-subject-to-california-invasion-of-privacy-claims
31. WilmerHale, "CIPA Reform Signed Into Law" (SB 690): https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20261006-cipa-reform-signed-into-law
32. CIPA Case Watch, Oct. 2026: https://consentpixel.com/blogs/cipa-case-watch-october-2026/
33. *Smith v. LoanMe* answer brief (S260391): https://supreme.courts.ca.gov/sites/default/files/supremecourt/default/documents/6-s260391-resp-answer-brief-merits-060120.pdf
34. Captain Compliance on *Brewer v. Otter.ai* / *Ambriz*: https://captaincompliance.com/education/old-wiretapping-laws-new-ai-tools-what-brewer-v-otter-ai-and-ambriz-v-google-mean-for-ai-transcription-services/
35. Cases cited from general knowledge, not fetched in this session (verify before use): *Facebook v. Duguid*, 592 U.S. 395 (2021); *Campbell-Ewald v. Gomez*, 577 U.S. 153 (2016); *Trim v. Reward Zone USA*, 76 F.4th 1157 (9th Cir. 2023); *Van Patten v. Vertical Fitness*, 847 F.3d 1037 (9th Cir. 2017); *McLaughlin Chiropractic v. McKesson* (U.S. 2025); *Insurance Marketing Coalition v. FCC* (11th Cir. Jan. 24, 2025); *Kearney v. Salomon Smith Barney*, 39 Cal.4th 95 (2006); *Javier v. Assurance IQ* (9th Cir. 2022); *Lane v. Allstate*, 114 Nev. 1176 (1998); FCC 24-17 (AI voice declaratory ruling, Feb. 8, 2024).
