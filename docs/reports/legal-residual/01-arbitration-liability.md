# Legal residual risks 1 and 5: arbitration, forum, and personal liability

**Prepared:** 2026-10-12 · **Scope:** Risk 1 (arbitration / class waiver / forum / governing law) and Risk 5 (personal liability of an uninsured Israeli sole proprietor) for AI Lab Pro (ailabpro.co).
**Status:** Legal research memo by an AI research agent. **This is not legal advice and was not written by a lawyer.** Each citation is marked:
- **[V]**: verified in this session against the primary text or an official page.
- **[S]**: confirmed only through secondary sources (law-firm or commentary pages).
- **[K]**: well-established authority stated from background knowledge and **not re-checked in this session**. Verify these before relying on a pin cite.

Documents reviewed: `docs/kits/lawyer-package/terms.md` (Terms of Service v1.0, §§3, 14–18) and `service-agreement.md` (Service Agreement v1.0, §§5, 8–10, 15–18, 20). No site or legal file was edited.

---

## Summary

1. **The B2B arbitration clause and class waiver are enforceable in principle under the FAA.** Concepcion, *Italian Colors* (which upheld a class waiver against small merchants) and Epic Systems point the same way. The weak spots are **formation and conspicuousness** and **cost**, not the doctrine itself.
2. **Consumer-rules risk.** A home-services contractor buying for its business is not a "consumer" under the AAA definition (personal, family or household use). An explicit business-purpose representation helps the AAA's administrative decision. *Resolved by contract.*
3. **The current clause has gaps:** no Expedited Procedures or documents-only election, no delegation sentence, no opt-out, no class-waiver severability, no fee rule, no statement on ICDR routing, and it allows a court route for "collecting unpaid fees" that only the drafter benefits from. Exact replacement text is in Part B. *Resolved by contract.*
4. **AAA fees exceed the deal size.** Commercial filing fee for a claim under $75k is **$1,450 initial + $1,150 final**, plus arbitrator compensation [V]. Arbitration is uneconomic for either side on a $3,500 dispute. The small-claims carve-out and the 50/50 prepayment are the real protection.
5. **ICDR.** The AAA administers international cases through the ICDR, but a clause that names the **AAA Commercial Rules** gets those rules even when the ICDR administers [S]. Say so expressly and pin the seat in New York.
6. **Governing law.** NY GOL §5-1401 lets parties choose NY law without a NY connection only for transactions of **$250,000 or more**. Our deals are far below that, so a court could apply the common-law "reasonable relationship" test. Keep NY law (the FAA governs the arbitration clause anyway), keep the NY seat, and add a fallback. Delaware has the same problem: its §2708 safe harbour requires $100,000 or more [K].
7. **Liability caps among competitors range from about 15 days ($500 max, Ruby) to 24 months (Smith.ai).** The modal range is 3–12 months [V]. "The greater of fees paid in the prior 6 months or $500" is within market. Carve out refunds owed under SA §5 and add an exclusion for TCPA fines and statutory damages. *Resolved by contract.*
8. **The contract cannot make a sole proprietor's assets separate.** An arbitral award against Meir is enforceable in Israel under the New York Convention (Israel and the US are both parties). An LLC protects mainly against **contract** claims. It does **not** protect against personal tort or TCPA liability for acts Meir personally performs. **Insurance is the bigger shield.** *Needs money or a decision.*
9. **Entity.** The cheapest workable US option is a **New Mexico LLC** (about $50 to form, no annual report) or a **Wyoming LLC** ($100 + $60/yr), plus a registered agent. Every option carries an annual **Form 5472 + pro-forma 1120** filing with a **$25,000 penalty** for missing it [S]. There is also an Israeli **CFC / "חברת משלח יד זרה"** tax risk to flag. An Israeli Ltd costs about ₪2,600 to register + ₪1,777/yr + accounting [S]. *Needs money or a decision.*
10. **Recommended sequence.** (a) Update the clauses now (free). (b) Get Israeli tech E&O quotes that include **US/Canada jurisdiction** before the first receptionist go-live. (c) Decide on an entity, with an Israeli CPA, at the first of these triggers: the 3rd receptionist client, about $15k collected, or a US client or insurer demanding one.

---

## Part A: Risk 1 findings (arbitration, class waiver, forum)

### A1. Enforceability of a B2B arbitration clause and class waiver with a small business

**FAA baseline.** Under 9 U.S.C. §2, written arbitration agreements in contracts "involving commerce" are "valid, irrevocable, and enforceable, save upon such grounds as exist at law or in equity for the revocation of any contract" [K]. The Supreme Court line:
- *AT&T Mobility LLC v. Concepcion*, 563 U.S. 333 (2011): the FAA preempts state rules that condition enforcement on the availability of class procedures [K].
- *American Express Co. v. Italian Colors Restaurant*, 570 U.S. 228 (2013): a class waiver was enforced **against small merchants** even though individually proving the claim cost more than the possible recovery. The "effective vindication" argument was rejected for cost alone [K; summary corroborated in [S] source 21]. This is the closest Supreme Court authority to our facts: small business against a vendor, standard-form contract.
- *Epic Systems Corp. v. Lewis*, 584 U.S. 497 (2018): individual-arbitration agreements are enforced as written. Other federal statutes do not displace the FAA unless Congress clearly says so [K].
- *Lamps Plus, Inc. v. Varela*, 587 U.S. 176 (2019): class arbitration requires affirmative consent and is not inferred from ambiguity [K]. Our clause should still say "never class arbitration".
- *Green Tree Fin. Corp.–Ala. v. Randolph*, 531 U.S. 79 (2000): the party resisting arbitration bears the burden of showing that costs are prohibitive [K].
- *Smith v. Spizzirri*, 601 U.S. 472 (2024): when a court compels arbitration on request, it must stay the case rather than dismiss it [K].

**When could a small business be treated as a "consumer"?**
- The AAA Commercial Rules (2013 text, R-1 footnote) state: "A dispute arising out of a consumer arbitration agreement will be administered under the AAA's Consumer Arbitration Rules." **"Any disputes regarding which AAA rules shall apply shall be decided by the AAA"** (R-1(a)) [V, source 1].
- The AAA Consumer Rules define a consumer agreement as one between an **individual** consumer and a business, using standardized non-negotiable terms, for goods or services **primarily for personal, household or family use** [S, sources 4 and 5]. A roofer or HVAC company buying a business phone receptionist and website does not fit that definition. It is not "personal or household use".
- Commentary flags a **grey zone for sole proprietors and single-member LLCs** with mixed personal and business use. The AAA looks at the individual claimant and is not bound by the merchant's label, subject to the arbitrator's final say [S, source 5]. **I found no reported case** that applied the AAA Consumer Rules to a sole-proprietor contractor buying business software. I could not verify one either way.
- **Mitigation (resolved by contract and product):** an express representation that the customer is a business buying for business purposes. Collect the business name and EIN or state licence in the questionnaire, and the business name in the e-signature record. This gives the AAA administrator documentary grounds to apply the Commercial Rules.
- **Side note to verify:** the same R-1 footnote says the AAA applies its **Employment Fee Schedule** to "an independent contractor (working or performing as an individual and not incorporated)" bringing "work-related claims under independent contractor agreements" against a business [V, 2013 text, source 1]. Meir is an unincorporated individual contractor. If **he** files against a client for unpaid fees, the AAA might apply the employment fee schedule, under which the business pays most fees. That would favour Meir. Check this against the current (2022) rules text before relying on it.

**Delegation.**
- *Rent-A-Center, West, Inc. v. Jackson*, 561 U.S. 63 (2010): a clear delegation clause sends gateway questions to the arbitrator [K].
- *Henry Schein, Inc. v. Archer & White Sales, Inc.*, 586 U.S. 63 (2019): there is no "wholly groundless" exception [K].
- In the Second Circuit, incorporating the AAA Rules is itself "clear and unmistakable" evidence of delegation: *Contec Corp. v. Remote Solution Co.*, 398 F.3d 205 (2d Cir. 2005) [K]. AAA Commercial R-7(a) gives the arbitrator power to rule on "the existence, scope, or validity of the arbitration agreement" [V, source 1].
- Even so, an explicit sentence is cheap insurance in other circuits. It is market practice to carve the **class-waiver** question out for a court, so that an arbitrator never decides to run a class arbitration.
- *Coinbase, Inc. v. Suski*, 602 U.S. 143 (2024): when **two contracts** conflict on who decides arbitrability, a court decides which contract governs [K]. Our Terms, Service Agreement, Quote, and **Upwork's own User Agreement** (for Upwork-sourced clients) could conflict. The SA should incorporate Terms §17 verbatim and state precedence. Upwork's dispute terms were **not reviewed** in this memo; check them separately.

**Conspicuousness and formation.**
- *Meyer v. Uber Techs., Inc.*, 868 F.3d 66 (2d Cir. 2017): online terms bind when notice is reasonably conspicuous and assent is unambiguous [K].
- Our flow is stronger than a browsewrap: a typed name, a checkbox, and logged IP, user agent, timestamp and document version.
- **Recommended product change (resolved by product):** the e-signature checkbox should name the clause, for example "I agree to the Service Agreement and Terms, **including individual arbitration, the class-action waiver and the 30-day opt-out (Terms §17)**". The plain-English summary at the top of the Terms already mentions arbitration, which is good.

**Opt-out windows.**
- A real 30-day opt-out is the strongest single answer to procedural unconscionability. *Circuit City Stores, Inc. v. Ahmed*, 283 F.3d 1198 (9th Cir. 2002) held that a meaningful 30-day opt-out meant the clause was not procedurally unconscionable [S, source 8].
- *Mohamed v. Uber Techs., Inc.*, 848 F.3d 1201 (9th Cir. 2016) reached the same result where the opt-out was conspicuous, lasted 30 days and had no adverse consequence [S, source 8].
- The limit is *Circuit City Stores, Inc. v. Mantor*, 335 F.3d 1101 (9th Cir. 2003): an opt-out that management discouraged was "an empty choice" [S, source 8].
- **New York law:** unconscionability generally requires **both** procedural and substantive unconscionability. *Gillman v. Chase Manhattan Bank*, 73 N.Y.2d 1 (1988) [K]. An opt-out therefore removes one of the two required prongs.
- **Cost of offering it:** realistically close to zero. Few B2B customers opt out, and an opted-out client still faces NY courts with a jury waiver.
- **Competitor practice:** Ruby gives a 30-day opt-out, though by signed mail to Portland, OR [V, source 14]. A mailed-only opt-out is weaker. **Use email.**

**Unconscionability risks specific to us.**
1. **Online or documents-only arbitration with a non-US company.** Video hearings reduce the client's cost and travel burden. That cuts **against** unconscionability: the client never travels to New York. AAA Commercial R-1(d) lets parties opt into Expedited Procedures and E-6 documents-only for any dispute [V/S, sources 1 and 2].
2. **One-sided carve-outs.** The current §17.4 lets either party go to court "to collect unpaid fees". In practice only the seller benefits from that. One-sided carve-outs are a classic substantive-unconscionability argument, mostly in California courts. **Recommendation:** remove it and keep the carve-outs mutual (small claims and IP/confidentiality injunctions).
3. **Cost.** See A1-fees below. Because small-claims court stays open to the client, a *Green Tree* "prohibitive cost" argument is weak. *Italian Colors* also undercuts it in B2B.
4. **Mass arbitration.** The risk is low in B2B with a few dozen clients. No special mass-arbitration protocol is needed now.

**A1-fees: AAA costs (Commercial Fee Schedule, amended and effective Sept 1, 2025) [V, source 3].**

| Claim | Initial filing fee | Final fee |
|---|---|---|
| < $75,000 | $1,450 | $1,150 |
| $75,000 – < $150,000 | $2,375 | $1,825 |

- The **final fee** is incurred only when the first evidentiary hearing is scheduled. **A documents-only case may never trigger it.** Check this with the AAA, since "hearing" on documents is an administrative question.
- Fees are "paid by the party bringing the claim or counterclaim". Arbitrator compensation is extra and is "initially subject to allocation by AAA-ICDR and ultimately by an arbitrator in an award" [V].
- A $750 minimum of the initial filing fee is non-refundable.
- **Expedited Procedures** apply by default when no claim exceeds **$100,000** (2022 amendment; it was $75,000 in the 2013 text) [S, sources 2 and 6].
- **E-6 documents-only** applies where no claim exceeds **$25,000**, "unless any party requests an oral hearing, or the arbitrator determines that an oral hearing is necessary" (2013 text) [V, source 1]. I could not confirm whether the 2022 text kept $25,000. The clause below therefore **elects** documents-only by agreement under R-1(d) rather than relying on the default.
- **Practical conclusion:** for a $3,500 dispute, either side spends about $1,450 to $3,500+ on arbitration. Neither side will rationally arbitrate small amounts. **The real protections are the 50/50 prepayment, the refund policy and the small-claims option.** Arbitration is mainly a shield against **class actions and large claims**, especially TCPA-driven ones.
- Paying the client's AAA fees on small claims would strengthen enforceability further. It could cost about $3k–$5k per case, so it is offered below only as an **optional** sentence: *needs a decision*.

### A2. AAA vs ICDR when one party is foreign

- The AAA's international division (ICDR) "also administers international cases under the AAA's Commercial Arbitration Rules" (AAA article, Oct 21, 2019) [V, source 7].
- An ICDR guide states that if the parties chose a specific rule set, it applies. **If the clause is silent and the matter is international, the ICDR International Dispute Resolution Procedures apply by default** [S, source 9].
- **Drafting answer:** name the **AAA Commercial Arbitration Rules (including the Expedited Procedures)** expressly. Say that if the AAA assigns the case to the ICDR, the same Commercial Rules still apply and not the ICDR International Rules. Fix the **seat as New York, New York**, the language as English, and one arbitrator.
- I did **not** verify whether the ICDR uses a different fee schedule for international cases under the Commercial Rules. Ask the AAA case-filing team (a one-email question).
- **New York Convention:** Israel and the United States are both Contracting States [K]. An award seated in New York involving a foreign party is "non-domestic", falls under the Convention (9 U.S.C. §202), and can be confirmed in the US (9 U.S.C. §207) [K]. It can also be **enforced in Israel** under Israel's Arbitration Law 5728-1968 and its Convention implementing rules [K, no section number verified].
- **This cuts both ways for Meir:** a US client who wins an award can reach his personal assets in Israel. The liability cap and insurance therefore matter. Conversely, Meir can enforce a fee award against a US client in that client's state.

### A3. Governing law: New York vs Delaware vs the client's state

- **NY GOL §5-1401** lets parties choose NY law "whether or not such contract … bears a reasonable relation to this state" only for transactions of **$250,000 or more**. **§5-1402** gives the matching forum rule for $1,000,000 or more, together with a §5-1401 choice and a submission to NY jurisdiction [K]. **Our contracts ($1,900–$7,500) are far below both thresholds.** A NY court would apply the common-law test, generally following *Restatement (Second) of Conflict of Laws* §187, which requires a reasonable relationship or basis. With no NY party and no NY performance, a court **could refuse** to apply NY substantive law.
- **Why keep NY anyway:**
  1. The **arbitration clause itself is governed by the FAA**, which we state.
  2. Arbitrators generally apply the parties' chosen law. A court looks again only on a narrow vacatur review (9 U.S.C. §10).
  3. NY commercial law is predictable and enforces liability caps between businesses. It does not enforce them for gross negligence: *Kalisch-Jarcho, Inc. v. City of New York*, 58 N.Y.2d 377 (1983); *Sommer v. Federal Signal Corp.*, 79 N.Y.2d 540 (1992) [K].
  4. A competitor with the same profile uses it. **Slang.ai** chooses New York law and New York County courts [V, source 13].
- **Delaware:** Del. Code tit. 6 §2708 deems a Delaware choice valid only for contracts of **$100,000 or more** [K]. It has the same problem and no advantage.
- **The client's state:** this is the most likely to be upheld, but it means 50 different laws. Some, such as California, are hostile to one-sided arbitration terms. It does not help a one-person seller.
- **Recommendation (resolved by contract):** keep New York law plus the FAA and a New York seat. Add a short **fallback**: if a court will not apply NY law to an issue, the law of the client's principal place of business applies to that issue only. This turns a void choice into a predictable one instead of litigating which law applies.

### A4. Competitor dispute clauses (fetched 2026-10-12)

| Competitor | Dispute clause | Source |
|---|---|---|
| Smith.ai | AAA arbitration "at Smith's sole discretion", California law, Santa Clara County courts | [V, 10] |
| Goodcall | AAA, **Consumer Arbitration Rules**, class waiver, jury waiver, California law, San Francisco courts | [V, 12] |
| Dialzara (Dialzara LLC) | Idaho law, class-action waiver ("individual capacity") | [V, 11] |
| Ruby | AAA **Consumer** Rules, class waiver, **30-day opt-out by signed mail** | [V, 14] |
| My AI Front Desk | AAA rules, English, seat California, court interim relief carve-out | [V, 16] |
| Slang.ai | NY law + NY County courts (no arbitration found in the fetched text) | [V, 13] |
| Synthflow | German law | [V, 17] |
| Rosie | Arbitration + class waiver announced in a header; provider and seat could not be extracted from the fetched page | [V, 15] |
| Podium | Page fetched but not parsed; **not verified** | [18] |

**Take-away:** NY law plus AAA Commercial Rules is **mainstream**. Our proposed clause is more protective of the client than several competitors' clauses (opt-out by email, documents-only, mutual carve-outs), which helps enforceability.

---

## Part B: Risk 1 recommended text (exact)

**Status: resolved by contract and product.** Replace Terms §17 in full and SA §18 in full. Keep the existing top-of-page summary sentence. Change the checkbox label as described in A1.

### Terms of Service, §17 (replacement)

> ## 17. Governing law and disputes
>
> 1. **Business customers only.** You confirm that you use our website and services for your business, not for personal, family or household use, and that you are not a consumer under any law.
> 2. **Governing law.** New York law and the Federal Arbitration Act govern these Terms, without regard to conflict-of-law rules. If a court will not apply New York law to an issue, the law of the state where your business is based applies to that issue only.
> 3. **Talk to us first.** Before starting any claim, send the other party a short written description of the dispute (to us at support@ailabpro.co). Both parties will try in good faith to resolve it within 30 days. Deadlines for bringing a claim pause during those 30 days.
> 4. **Binding individual arbitration.** Any dispute that is not resolved and that relates to these Terms, the Service Agreement, a Quote or our services will be decided by binding arbitration administered by the American Arbitration Association (AAA) under its Commercial Arbitration Rules, including the Expedited Procedures, in the version in effect when the claim is filed. If the AAA assigns the case to its International Centre for Dispute Resolution, the same Commercial Arbitration Rules still apply. There will be one arbitrator, the language is English, and the seat (legal place) of arbitration is New York, New York. If no claim or counterclaim is more than US$25,000 (not counting interest, fees and costs), the case is decided on written submissions only, unless the arbitrator decides a hearing is needed. Any hearing is held by video. Judgment on the award may be entered in any court with jurisdiction.
> 5. **Who decides.** The arbitrator decides all questions about the scope, validity, enforceability or arbitrability of this section, except that only a court may decide questions about item 7.
> 6. **Fees.** Each party pays its own lawyers and costs. AAA fees and the arbitrator's pay are paid as the AAA rules provide, and the arbitrator may reallocate them in the award. *[Optional, needs a decision: "If you start an arbitration for a claim of US$5,000 or less, you pay no more than US$250 of the AAA fees and we pay the rest, unless the arbitrator finds the claim frivolous."]*
> 7. **No class actions; no jury.** Claims may be brought only on an individual basis, never as a plaintiff or class member in a class, collective or representative proceeding, and never as a class arbitration. If this item is found unenforceable for a claim, that claim alone will be decided by a court under item 10, after any arbitration of the other claims ends. To the extent a dispute goes to court, both parties waive trial by jury.
> 8. **Small claims and urgent relief.** Either party may instead bring an individual claim in a small-claims court that has jurisdiction, as long as it stays there. Either party may ask a court for urgent relief to protect its intellectual property or confidential information.
> 9. **30-day opt-out.** You may opt out of arbitration (items 4 to 6) by emailing support@ailabpro.co with your business name and the words "arbitration opt-out" within 30 days after you first accept these Terms or sign a Quote, whichever is first. Opting out changes nothing else in these Terms.
> 10. **Courts.** For any matter that is not arbitrated, the state and federal courts located in New York County, New York have exclusive jurisdiction, and both parties consent to them.
> 11. **Time limit.** A claim must be started within one year after it arises, unless the law requires a longer period.

**Changes from v1.0:**
- Added: business-only representation, law fallback, Expedited Procedures, ICDR routing, a documents-only election under $25k, delegation, fee rule, class-waiver severability, email opt-out, one-year limit.
- **Removed the one-sided "collect unpaid fees" court carve-out.**

**About the one-year limit:** NY CPLR §201 allows a contractual shortening of a limitations period if it is reasonable [K]. Courts have upheld one year in commercial contracts [K].

**About "Terms §18. Changes":** it already says a change never applies to a dispute that started before it. Keep that sentence. It defeats the "illusory promise" argument.

### Service Agreement, §18 (replacement)

> ## 18. Governing law and disputes
>
> Section 17 of the Terms of Service (Governing law and disputes) is part of this Agreement as if written here in full. That section covers: business customers only; New York law and the Federal Arbitration Act; 30 days of good-faith talks first; binding individual arbitration administered by the AAA under its Commercial Arbitration Rules and Expedited Procedures, seated in New York, in English, on documents when no claim is above US$25,000; the arbitrator decides arbitrability; small-claims court; no class actions; no jury; a 30-day opt-out by email; and a one-year time limit. Your 30 days to opt out start on the date you sign your first Quote. If a Quote, this Agreement or the terms of a platform we were introduced through (for example Upwork) say something different about how disputes between you and us are resolved, section 17 of the Terms controls, to the extent that platform's terms allow.

---

## Part C: Risk 5 findings (personal liability; no entity, no insurance)

### C1. Contract mitigations: market-standard caps

All verified from fetched terms on 2026-10-12:

| Competitor | Cap | Notes |
|---|---|---|
| Smith.ai | Amounts paid in the **24 months** before the claim | [V, 10] |
| Slang.ai | Fees paid or payable in the **12 months** before the event; mutual; indemnities excluded | Has "Evaluation Services" (free, pilot, beta) terms where some obligations don't apply [V, 13] |
| Goodcall | Amount paid in the **last 6 months**, or **$100** if greater | [V, 12] |
| Rosie | Fees paid in the **3 months** before the act, or **$100** if no fees | [V, 15] |
| Ruby | Credit equal to the pro-rated monthly charge, **max 15 days or $500** | [V, 14] |
| Dialzara | "Amount of fees actually received" | [V, 11] |
| My AI Front Desk | Consequential-damages exclusion; TCPA, TSR and state telemarketing compliance placed on the customer; **force majeure**; "Compliance Features Are Not Legal Advice" (§32.7) | [V, 16] |
| Smith.ai (compliance) | Puts TCPA compliance on the customer for outbound calling | [V, 10] |
| Synthflow | German-law "contractually typical foreseeable damage" | [V, 17] |

**Conclusion.**
- The market ranges from about 15 days to 24 months. **3 to 12 months is typical** for SMB AI phone tools.
- **"The greater of fees paid in the prior 6 months or $500" is reasonable and defensible.** It sits exactly at Goodcall's level and above Rosie and Ruby.
- Under NY law such a cap is enforced between businesses **except for gross negligence or willful misconduct**, which cannot be capped (*Kalisch-Jarcho*; *Sommer*) [K].
- **Two necessary carve-outs:**
  1. **Refunds owed under SA §5** (the 30-day guarantee refunds the full $3,500 setup fee, which can exceed a 6-month cap). Otherwise the cap would contradict our own promise.
  2. The client's payment and indemnity obligations, as today.

**Clauses competitors use that we lack or should strengthen:**
1. **Exclusion of fines, penalties and statutory damages for messages sent in the client's name.** TCPA statutory damages are $500 per violation and up to $1,500 if willful (47 U.S.C. §227(b)(3)) [K]. This is the single largest tail risk. **Missing today.**
2. **"Compliance features are not legal advice; no fiduciary or advisor relationship"** (My AI Front Desk §32.7). **Missing.**
3. **"You maintain your own business insurance."** No competitor text was found for this, but it is common in B2B MSAs [K]. **Missing.**
4. **Early access / beta as-is** (Slang "Evaluation Services"). Our dental early access in SA §13 has no as-is language. **Missing.**
5. **Force majeure.** It exists in SA §20 but not in the Terms. Extend it to carrier and A2P 10DLC decisions and to AI-provider changes.
6. **Contractual time limit for claims** (one year). **Missing.**
7. **Exclusive remedy for defective deliverables** (fix, or refund the related setup fee). Covered by SA §5 in part. Tie it to the cap.

### C2. Entity options with current costs

**Key legal point first:** an LLC or Ltd shields the owner from the **company's contract debts**. It does **not** shield a person from liability for torts or statutory violations they **personally participate in**. Courts have held individuals personally liable under the TCPA where they personally directed the violating conduct, for example *Texas v. American Blastfax, Inc.*, 164 F. Supp. 2d 892 (W.D. Tex. 2001) [K, verify]. A one-person company where Meir does all the work gets **partial** protection only. **Insurance plus contract terms matter more than the entity.**

**(i) US single-member LLC owned by a non-resident**

| Item | Wyoming | New Mexico | Delaware |
|---|---|---|---|
| Formation (state fee) | $100 [S, 19] | $50 [S, 19] | $110 [K; one source says $90; verify on corp.delaware.gov] |
| Annual state fee or report | $60 minimum annual report/licence tax [S, 19] | **None** (no annual report) [S, 19] | $300 annual tax due June 1; $200 late penalty [S, 20] |
| Registered agent | about $25–$150/yr | about $50–$150/yr | about $50–$300/yr |

Market ranges for the registered agent are not individually verified.

**Requirements for all three states:**
- **EIN** via IRS Form SS-4 by fax or mail, or by phone from abroad. The online EIN application needs an SSN or ITIN for the responsible party [K]. No SSN is required.
- **Form 5472 attached to a pro-forma Form 1120**, every year, for a foreign-owned disregarded LLC (Treas. Reg. §1.6038A-1 and §301.7701-2(c)(2)(vi)) [S, sources 22 and 23]. The base **penalty is $25,000 per form per year** (IRC §6038A(d)), with continuation penalties after IRS notice [S]. Preparer cost is commonly a few hundred dollars a year (unverified market estimate).
- **FinCEN BOI (Corporate Transparency Act):** FinCEN's March 2025 interim final rule exempted US-formed companies from BOI reporting [K, verify current status]. If that is still the rule, there is no BOI filing for a US LLC.
- **Banking:**
  - **Mercury** publishes a list of prohibited founder countries. **I could not confirm Israel's status.** Check support.mercury.com, "Prohibited countries" [S, source 24].
  - **Wise Business** and **Relay**: eligibility for Israeli residents was not verified.
  - **Payoneer** and **PayPal** (already in use) work without a US account.
- **US tax nexus:** a disregarded LLC run entirely from Israel by an Israeli resident raises questions about effectively-connected income and permanent establishment under the US–Israel treaty. *Flagged, not resolved.*
- **Israeli tax (flag only).** The Israeli Tax Authority may treat a US LLC as a foreign company owned by an Israeli resident. Two regimes could apply:
  - **CFC rules (ITO §75B)**.
  - **"חברת משלח יד זרה" (foreign professional company, ITO §75B1)**, aimed at foreign companies whose income comes mainly from a "special occupation" performed by their Israeli controlling shareholders.
  - There is also a classification mismatch: transparent in the US, possibly opaque in Israel. **This must be resolved with an Israeli CPA before forming any US entity.**

**(ii) Israeli private company (חברה בע"מ)**
- Registration fee: sources disagree. About ₪2,559 online (₪3,123 by paper) vs about ₪2,645 [S, source 25]. Verify on gov.il.
- **Annual fee 2026:** ₪1,338 if paid by 31.3.2026, otherwise **₪1,777** [S, source 25; gov.il service page, source 26].
- Accounting and audit: a typical market range of ₪8,000–₪20,000 per year (unverified estimate; companies require audited statements).
- Tax, at a high level: 23% corporate tax plus dividend tax on distributions, vs marginal personal rates for a sole proprietor.
- It protects against contract claims, but a US client could still name Meir personally for his own acts.
- No US filing burden, and no CFC or foreign-professional-company issue.

**(iii) Stay a sole proprietor (עוסק מורשה)**
- Costs nothing.
- **All business liabilities are personal and reach Meir's personal assets** (enforceable in Israel; see A2).
- Mitigated only by the contract (cap, exclusions, arbitration) and by insurance.

**What an advisor would typically recommend** (general practice, not a verified rule):
1. Stay a sole proprietor with strong contract terms while volume is tiny.
2. Buy E&O insurance **before** the first AI-receptionist go-live, because that product creates TCPA-type third-party exposure.
3. Form an entity once revenue is recurring. For an Israeli resident, an **Israeli Ltd** is usually simpler than a US LLC because it avoids the §75B1 and Form 5472 issues, unless US clients or insurers require a US entity.

**Suggested trigger:** the first of the 3rd receptionist client, about $15k collected, or a client or insurer requiring an entity.

### C3. Insurance

- **US market price reference:** tech E&O for a small IT consultant averages about **$899/yr** for $1M/$1M limits with a $2,500 deductible (Insureon) [S, source 27]. The typical range is **$750–$3,000/yr** [S].
- **Eligibility:** US small-business programs (Hiscox, Insureon marketplace carriers, Embroker, Vouch) are US-domiciled programs. Hiscox US tech E&O is offered "to brokers throughout the United States" [S, source 28]. **I found no published rule that bars foreign owners, but none that admits a foreign sole proprietor without a US address or entity either.**
- **Practical conclusion:** assume a US-admitted small-business E&O or cyber policy **cannot be bought without a US entity and address** until a broker confirms otherwise in writing.
- **Israeli market:** Phoenix ("הייטק פרוטקט"), Clal (hi-tech policy) and Harel (software/hardware combined policy, with an application form) sell tech professional liability ("אחריות מקצועית לחברות טכנולוגיה") [V that the products exist, sources 29–31].
  - One Israeli agency quotes programmers' or IT consultants' E&O **from ₪4,500/yr** [S, source 32]. This is a marketing floor.
  - **The critical point:** many Israeli policies exclude or surcharge **US/Canada jurisdiction**. Ask explicitly for "worldwide territory including USA/Canada jurisdiction" and for coverage of **regulatory fines or TCPA statutory damages**, which are often excluded everywhere.
  - Realistic ballpark with a US jurisdiction extension and cyber: about **₪6,000–₪15,000/yr**. This is an unverified estimate; get 2–3 quotes through a broker (for example Howden Israel or a tech-specialist agency).
- **Cannot buy without a US entity (likely):** US-admitted small-business E&O or cyber (Hiscox US, Insureon carriers, Embroker, Vouch).
- **Can buy now:** an Israeli tech E&O or cyber policy for the עוסק מורשה, with a US/Canada jurisdiction extension.

---

## Part D: Risk 5 recommended text (exact)

**Status: resolved by contract**, unless marked otherwise.

### Terms of Service, §15 (replacement)

> ## 15. Limitation of liability
>
> To the extent the law allows: (a) our total liability for all claims related to our website and services is limited to the greater of (i) the amounts you paid us in the 6 months before the event that caused the claim, or (ii) US$500; (b) we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, jobs or data; and (c) we are not liable for fines, penalties or statutory damages (including under the Telephone Consumer Protection Act or any state telemarketing, texting or call-recording law) arising from calls or texts made in your business's name, except to the extent caused by our failure to process an opt-out request we received. These limits apply even if a remedy fails of its essential purpose. For paid services, the limits in the Service Agreement apply.

### Terms of Service, new §15A (insert after §15)

> ## 15A. Your insurance and decisions; events outside our control
>
> You are responsible for insuring your own business, including against claims by your callers and customers. We are not your lawyer, compliance advisor or fiduciary; any compliance feature or default wording we provide is a tool, not legal advice. Neither party is liable for delays or failures caused by events beyond its reasonable control, including outages or decisions of phone carriers, SMS registration (A2P 10DLC) bodies, cloud or AI providers, changes to those providers' terms, cyber-attacks we could not reasonably prevent, natural disasters or war.

### Service Agreement, §15 (replacement)

> ## 15. Limitation of liability
>
> To the extent the law allows: (a) each party's total liability under this Agreement is limited to the greater of (i) the amounts you paid us in the 6 months before the event that caused the claim, or (ii) US$500; (b) neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, jobs or data; and (c) we are not liable for fines, penalties or statutory damages (including under the Telephone Consumer Protection Act or any state telemarketing, texting or call-recording law) arising from calls or texts made in your name, except to the extent caused by our failure to process an opt-out request we received. These limits do not apply to your payment obligations, to refunds we owe under section 5, to your indemnity under section 16, or to a party's fraud or willful misconduct.

*Decision note:* if Meir prefers to keep **12 months** in the SA (as in v1.0), that is still market (Slang). 6 months is the more protective option and is still defensible (Goodcall).

### Service Agreement, §16.1 (amend the end of the sentence)

> … or your use of calls and texts in breach of section 8 or the law, **including any resulting fines, penalties, statutory damages, settlements and reasonable attorneys' fees.**

### Service Agreement, §8 (add a closing paragraph)

> **Compliance features are not legal advice.** The default wording, opt-out handling and other compliance features we build are tools to help you comply; they are not legal advice, and we are not your compliance advisor or fiduciary. You are responsible for insuring your own business, including against claims by your callers.

### Service Agreement, §13 (health information): add to the early-access sentence

> Early-access services are provided "as is", without the service-level target in section 10, and we may change or stop them on 14 days' notice with a pro-rated refund of any prepaid monthly fee.

### Service Agreement, §20 (General): replace the force-majeure sentence and add a time limit

> Neither party is liable for delays or failures caused by events beyond its reasonable control, including outages or decisions of phone carriers, SMS registration (A2P 10DLC) bodies, cloud or AI providers, changes to those providers' terms, cyber-attacks we could not reasonably prevent, natural disasters or war. A claim under this Agreement must be started within one year after it arises, unless the law requires a longer period.

**Needs money or a decision (not solvable by text):**
- An entity (C2).
- Insurance (C3).
- The optional fee sentence in Terms §17.6.

---

## Part E: טבלת החלטה (Hebrew)

| אפשרות | עלות עכשיו | עלות לשנה | ממה זה מגן | מתי לעשות |
|---|---|---|---|---|
| עדכון סעיפי המחלוקת (בוררות, ויתור על תביעה ייצוגית, אפשרות יציאה) | 0 ₪ | 0 ₪ | מתביעות ייצוגיות ומתביעות גדולות בבית משפט אמריקאי | עכשיו, לפני הלקוח הראשון |
| עדכון תקרת אחריות + החרגת קנסות TCPA + "ביטוח על הלקוח" | 0 ₪ | 0 ₪ | מגביל כמה לקוח יכול לתבוע בפועל (ולא רק לפי החוזה) | עכשיו |
| שינוי תיבת האישור בחתימה (להזכיר בוררות וויתור על ייצוגית) | 0 ₪ (שינוי קוד קטן) | 0 ₪ | מחזק את התוקף של הסעיף בבית משפט | עכשיו |
| ביטוח אחריות מקצועית + סייבר מחברה ישראלית, עם הרחבה לשיפוט בארה"ב/קנדה | 0 ₪ (הצעות מחיר) | בערך 6,000 עד 15,000 ₪ (הערכה, לא מאומת) | מתביעות רשלנות, טעויות ודליפת מידע, כולל מה שישות משפטית לא חוסמת | לפני העלייה לאוויר של מזכירת ה-AI הראשונה |
| להישאר עוסק מורשה | 0 ₪ | 0 ₪ | לא מגן: כל חוב עסקי הוא אישי (ופסק בוררות אמריקאי ניתן לאכוף בישראל) | עד הטריגר שלמטה |
| חברה בע"מ ישראלית | בערך 2,600 ₪ אגרת רישום | 1,777 ₪ אגרה + בערך 8,000 עד 20,000 ₪ הנהלת חשבונות | מחובות חוזיים של העסק. לא מגן ממה שמאיר עושה אישית | בלקוח מזכירה שלישי, או כ-15 אלף דולר הכנסה, או כשלקוח או מבטח דורשים |
| LLC אמריקאית (ניו מקסיקו או ויומינג) | 50 עד 100 דולר + סוכן רשום | 60 דולר (ויומינג) + 25 עד 150 דולר סוכן + הכנת טופס 5472 (קנס 25 אלף דולר אם לא מגישים) | כמו בע"מ, ופותחת ביטוח ובנק אמריקאי | **רק אחרי** בדיקה עם רו"ח ישראלי (סיכון "חברת משלח יד זרה") |
| תשלום דמי הבוררות של הלקוח בתביעות קטנות (סעיף אופציונלי) | 0 ₪ | 0 ₪, אבל בערך 3,000 עד 5,000 דולר לכל תיק אם נפתח | מחזק עוד את התוקף של סעיף הבוררות | החלטה של מאיר. לא חובה בעסקה בין עסקים |

---

## Sources (all accessed 2026-10-12)

1. AAA, *Commercial Arbitration Rules and Mediation Procedures* (2013 text, R-1, R-7, E-6), copy hosted by the US Court of Appeals for the First Circuit: https://www.ca1.uscourts.gov/sites/ca1/files/citations/CommercialRules_Web_FINAL_2.pdf
2. ABA Litigation Section, "AAA's Amended Commercial Arbitration Rules Now Effective" (2022): https://www.americanbar.org/groups/litigation/resources/newsletters/alternative-dispute-resolution/aaas-amended-commercial-arbitration-rules-now-effective/ ; Troutman Pepper, "AAA Issues Amended Commercial Arbitration Rules" (Aug 31, 2022): https://www.troutman.com/insights/aaa-issues-amended-commercial-arbitration-rules
3. AAA-ICDR, *Commercial Arbitration Rules: Administrative Fee Schedule*, amended and effective September 1, 2025: https://www.adr.org/media/pfubh1we/2025_commercial-arbitration-fee-schedule.pdf
4. AAA, *Consumer Arbitration Rules* (amended May 1, 2025, copy): https://www.mcglinchey.com/wp-content/uploads/2025/05/2025_Consumer_Arbitration_Rules-1.pdf ; AAA consumer page: https://www.adr.org/rules-forms-and-fees/consumer/
5. terms.law, "AAA Consumer Rules vs. Commercial Rules vs. Processor Arbitration Clauses": https://terms.law/insights/aaa-consumer-rules-vs-processor-arbitration.html
6. Reed Smith / JD Supra summaries of the 2022 AAA Commercial Rules: https://www.jdsupra.com/legalnews/aaa-issues-amended-commercial-8524942/
7. AAA, "Filing an International Case Under the ICDR International Arbitration Rules or the AAA Commercial Rules: The Key Differences" (Oct 21, 2019): https://www.adr.org/news-and-insights/filing-an-international-case-under-the-icdr-international-arbitration-rules-or-the-aaa-commercial-rules-the-key-differences/
8. Public Citizen Consumer Law & Policy Blog, "Do Opt-Out Clauses Save Arbitration Agreements from Being Unconscionable?": https://clpblog.citizen.org/do-opt-out-clauses-save-arbitration-agreements-from-being-unconscionable/ ; Fox Rothschild, "Can Opt-Out Provisions Save Arbitration Clauses": https://www.foxrothschild.com/publications/can-opt-out-provisions-save-arbitration-clauses ; *Circuit City v. Mantor* (FindLaw): https://caselaw.findlaw.com/us-9th-circuit/1483957.html
9. ICDR, *A Guide to ICDR Case Management*: https://icdr.org/sites/default/files/document_repository/A_Guide_to_ICDR_Case_Management-LM.pdf
10. Smith.ai, Terms of Service (Receptionists; last updated July 2, 2026): https://smith.ai/receptionists/terms
11. Dialzara, Terms of Use: https://dialzara.com/terms-of-use and full Terms of Service (Termageddon-hosted): https://policies.termageddon.com/api/policy/YjNvclZUQlZNRVF6ZUVGalNtYzlQUT09
12. Goodcall, Terms of Service: https://help.goodcall.com/en/articles/8007566-terms-of-service
13. Slang.ai, Terms of Service: https://slang.ai/terms-of-service
14. Ruby, Terms: https://www.ruby.com/terms
15. Rosie, Terms: https://heyrosie.com/legal/terms
16. My AI Front Desk, Terms of Service: https://myaifrontdesk.com/terms-of-service
17. Synthflow, Terms & Conditions: https://docs.synthflow.ai/docs/terms-conditions
18. Podium, Legal (fetched, not parsed): https://legal.podium.com/
19. LLC University, "LLC annual fees by state": https://www.llcuniversity.com/llc-annual-fees-by-state/ ; HowToStartAnLLC, "LLC Annual Fees by State 2026": https://howtostartanllc.com/cost-to-form-an-llc/llc-annual-fees-by-state
20. Wolters Kluwer, "Delaware annual tax is due June 1" (Apr 8, 2026): https://www.wolterskluwer.com/en-ca/expert-insights/delaware-annual-tax-is-due-june-1
21. NCLC, "Using the AAA's Rules to Defeat Arbitration Requirements": https://library.nclc.org/article/using-aaas-rules-defeat-arbitration-requirements
22. Taxes for Expats, "Foreign owned single member LLC: 2026 tax and filing requirements": https://www.taxesforexpats.com/articles/foreign-business/foreign-owned-single-member-llc.html
23. SDO CPA, "The Complete Guide to Form 5472": https://www.sdocpa.com/form-5472-foreign-owned-business-guide/
24. Mercury, "Prohibited countries": https://support.mercury.com/hc/en-us/articles/35628854440468-Prohibited-countries
25. Stark & Stark CPA, annual fee reminder 2026: https://www.starkcpa.com/ (article "תזכורת לתשלום אגרה שנתית מופחתת לחברה לשנת 2026"); Mena CPA, "אגרת רשם החברות 2026": https://www.mena.co.il/agrat-rasham-hachavarot-2026-tashlum-agra-shnatit-madrich/ ; digitalawyer (registration fee): https://www.digitalawyer.co.il/
26. gov.il, "תשלום אגרה שנתית לחברה או שותפות": https://www.gov.il/he/service/company_partnership_annual_payment
27. Insureon, "IT Consultant Insurance cost": https://www.insureon.com/technology-business-insurance/it-consultants/cost
28. Embroker Access, Tech E&O / Cyber sell sheet (May 2024): https://access.embroker.com/wp-content/uploads/2024/06/Access_Tech-EO_Cyber_Sell-Sheet_May-2024.pdf (Hiscox US statement via search summary; not fetched directly)
29. Phoenix, "הייטק פרוטקט": https://www.fnx.co.il/other-insurances/protect-high-tech-policy/
30. Clal Insurance, hi-tech: https://www.clalbit.co.il/businessins/hitec/
31. Harel, software/hardware combined liability application form: https://www.harel-group.co.il/insurance/business/policies/doclib/ (PDF "ביטוח חבות משולב לחברות תוכנה וחומרה")
32. Asia Insurance Agency, "מתכנתים": https://asia-ins.co.il/software-developers-and-computer-consultants/ ; Howden Israel, tech professional liability: https://howden.co.il/

**Statutes and cases cited from background knowledge [K], not re-fetched:**
- FAA, 9 U.S.C. §§2, 9, 10, 202, 207.
- NY GOL §§5-1401, 5-1402; NY CPLR §201; Del. Code tit. 6 §2708; 47 U.S.C. §227(b)(3); IRC §6038A(d); Treas. Reg. §§1.6038A-1, 301.7701-2(c)(2)(vi); Israeli Income Tax Ordinance §§75B, 75B1; Israel Arbitration Law 5728-1968.
- *Concepcion* (2011); *Italian Colors* (2013); *Epic Systems* (2018); *Rent-A-Center* (2010); *Henry Schein* (2019); *Lamps Plus* (2019); *Coinbase v. Suski* (2024); *Smith v. Spizzirri* (2024); *Green Tree v. Randolph* (2000); *Contec v. Remote Solution* (2d Cir. 2005); *Meyer v. Uber* (2d Cir. 2017); *Gillman v. Chase Manhattan* (N.Y. 1988); *Kalisch-Jarcho* (N.Y. 1983); *Sommer v. Federal Signal* (N.Y. 1992); *Texas v. American Blastfax* (W.D. Tex. 2001).

**Not verified in this session:**
- The current (2022) text of E-6 and its $25k threshold.
- The ICDR fee schedule for Commercial-Rules cases.
- Whether Mercury accepts founders living in Israel.
- The FinCEN BOI status after 2025.
- Upwork's User Agreement dispute terms.
- Podium's cap.
- Israeli E&O premiums with US jurisdiction.
