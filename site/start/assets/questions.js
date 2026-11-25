/* Sales questionnaire content: the single source for the form, the summary, the admin view and the quote engine.

   STABILITY CONTRACT
   - Field keys (k) and option values (v) are stored in questionnaires.answers (jsonb). NEVER rename or reuse them;
     add new keys instead. Labels (l / label) may change freely (the summary is rebuilt from labels on each save).
   - questionnaires.offer / .niche columns mirror answers.offer / answers.niche.
   - Onboarding facts (exact hours, which calendar/CRM account, phone carrier and forwarding, service area, prices on the
     phone, website content) are NOT asked here: they are collected after the deposit in the setup checklist
     (portal-b.js, onboarding_items.data). Here we only ask what changes the quote — 3 screens, about 3 minutes
     (spec 2026-10-29): profile (home.js) + the two steps below.
   - Keys asked until 2026-10-29 (service_area, who_answers, missed_pct, after_hours, urgent, job_value, re_lead_types,
     re_qualify, domain, gbp, web_hours, web_address, web_tone, web_colors, web_reviews, price_on_phone, timeline, decider,
     website_now, biggest_leak, files) stay valid in stored answers and in the quote engine; they are simply no longer asked.
   - services[] and content_have[] (asked until 2026-11-25, price-neutral; the setup checklist asks them after the deposit)
     likewise stay valid in stored answers and summaries; they are no longer asked.
   - NEW questionnaires offer the Business Website only (NEW_OFFERS, owner decision 2026-11-25): FirstRing is sold as a
     monthly plan through the plan sign-up (signup.js; /start/?offer=RCP|BNDL|UNSURE goes there, home.js). The codes RCP,
     BNDL and UNSURE (LEGACY_OFFERS) and every receptionist branch below stay: submitted questionnaires, summaries, the
     admin, quote hints and the quote engine still read them. An open draft that still holds one of them is moved to WEB
     when opened (q.js), with a note pointing to the plans.

   KEYS (step -> keys)                         used by the quote engine (A6) as
   need      offer, niche                      core code (RCP|WEB|BNDL|UNSURE), niche (home_services | real_estate)
             goal                              UNSURE only: input for the recommended core offer
             locations (RCP/BNDL)              '2' -> ADD-LOC x1, '3' -> ADD-LOC x2, '4plus' -> custom
   extras    calls_week (not WEB)              '400plus' -> custom (volume over the auto-quote limit)
             locations (UNSURE)                as above
             spanish (not WEB)                 'many'|'some' -> ADD-ES
             dispatch (RCP/BNDL, not RE)       'yes' -> ADD-DISPATCH x1 (only while the price book lists it as available)
             re_crm (real_estate, not WEB)     integration_meta crm/real_estate keys + other|none; mapped via pricebook.integrations
             tools[], tools_other (not WEB)    each tool key maps via pricebook.integrations: native | zapier | addon:<code> | custom
             has_website (WEB/UNSURE)          context (UNSURE: input for the recommendation)
             web_extras[] (WEB/BNDL)           extra_pages->ADD-PAGE, spanish->ADD-WEB-ES, logo->ADD-LOGO, blog->ADD-BLOG
             more                              free text; Claude reads it (HIPAA/EHR etc. surface here)
   FOLD: fields with opt (true, or a function of the answers) do not change the price; q.js draws them inside one closed
   "Add more details (optional)" fold per step (native <details>), so the default path shows only what the quote needs.
   They are saved, restored and summarised exactly like the others (same keys); a fold with an answer in it opens by itself.
   TOOLS on the real-estate path leave out the home-services job apps (integration_meta category 'fsm': Jobber, Housecall
   Pro, ServiceTitan); the price book is unchanged. q.js drops a saved tool that is no longer offered before it saves.
   (WEB has no quote step: it ends with a deposit-link request, event web_deposit_link_requested; no tools step)
   quoteHints(answers, pricebook) below returns the same mapping as data. */
(function () {
  const O = (v, l, d) => d ? { v, l, d } : { v, l };
  const has = (a, k, v) => Array.isArray(a[k]) && a[k].indexOf(v) !== -1;
  const offerIs = (...codes) => a => codes.indexOf(a.offer) !== -1;
  const receptionist = offerIs('RCP', 'BNDL', 'UNSURE');
  const isRE = a => a.niche === 'real_estate';

  const US_TZ = [O('America/New_York', 'Eastern (New York)'), O('America/Chicago', 'Central (Chicago)'), O('America/Denver', 'Mountain (Denver)'),
    O('America/Phoenix', 'Arizona (Phoenix)'), O('America/Los_Angeles', 'Pacific (Los Angeles)'), O('America/Anchorage', 'Alaska (Anchorage)'),
    O('Pacific/Honolulu', 'Hawaii (Honolulu)')];

  // Profile = public.profiles columns (asked once on screen 1 of 3, editable later). 3 fields; the time zone is detected
  // and saved silently (home.js); city/state/website are asked in the setup checklist (Texting registration).
  // Asked first, only for accounts whose sign-in address is a relay (Apple "Hide My Email"): where quotes and receipts go.
  const PROFILE_CONTACT = { k: 'contact_email', label: 'Email for your quote and receipts', type: 'email', req: true, auto: 'email', ph: 'you@yourbusiness.com',
    hint: 'We only write to this address.' };
  const PROFILE = [
    { k: 'full_name', label: 'Full name', type: 'text', req: true, auto: 'name' },
    { k: 'company', label: 'Business name', type: 'text', req: true, auto: 'organization' },
    { k: 'phone', label: 'Mobile phone', type: 'tel', req: true, auto: 'tel', ph: '(555) 555-0100', hint: 'For quote questions. We never call unannounced.' }
  ];
  // one optional tap on the thank-you screen (profiles.how_heard); never asked before the quote
  const HOW_HEARD = [O('upwork', 'Upwork'), O('google', 'Google search'), O('social', 'Facebook or Instagram'), O('referral', 'A referral'),
    O('youtube', 'YouTube'), O('ai_assistant', 'An AI assistant'), O('other', 'Other')];

  // Tools: the closed list = pricebook.integration_meta (niche-filtered) + Zapier + Other. Order follows the pricebook.
  // Real estate never sees the home-services job apps (category 'fsm': Jobber, Housecall Pro, ServiceTitan).
  const HOME_SERVICES_ONLY = ['fsm'];
  function toolOptions(a, PB) {
    const meta = PB && PB.integration_meta || {};
    const crmKeys = isRE(a) ? reCrmOptions(a, PB).map(o => o.v).filter(v => v !== 'other' && v !== 'none') : [];
    return Object.keys(meta).filter(k => {
      const n = meta[k].niches || ['*'];
      if (crmKeys.indexOf(k) !== -1) return false;   // already asked in the niche's CRM question (re_crm)
      if (isRE(a) && HOME_SERVICES_ONLY.indexOf(meta[k].category) !== -1) return false;
      return n.indexOf('*') !== -1 || n.indexOf(a.niche) !== -1;
    }).map(k => O(k, k === 'zapier' ? 'Zapier (I have an account)' : k === 'other' ? 'Other' : meta[k].label));
  }

  // Real-estate CRM choices come only from config: pricebook.integration_meta entries with category crm + niche real_estate
  // (label = integration_meta.<key>.label), then Other and None.
  // ADD-DISPATCH choice: the price comes from the price book; a coming-soon item is never offered as a "yes".
  const usd = c => '$' + Math.round(c / 100).toLocaleString('en-US');
  const sold = (PB, code) => ((PB && PB.items) || []).find(i => i.code === code && i.availability !== 'coming_soon');
  function dispatchOptions(a, PB) {
    const it = sold(PB, 'ADD-DISPATCH');
    const yes = it ? 'Yes, add it (' + usd(it.setup_cents) + ' setup + ' + usd(it.monthly_cents) + '/mo)' : 'Yes, tell me when it’s available';
    return [O('yes', yes), O('no', 'No, the assistant takes a message')];
  }
  function reCrmOptions(a, PB) {
    const ints = PB && PB.integrations || {}, meta = PB && PB.integration_meta || {};
    const keys = Object.keys(meta).filter(k => k !== 'other' && k in ints && meta[k].category === 'crm' && (meta[k].niches || []).indexOf('real_estate') !== -1);
    return keys.map(k => O(k, meta[k].label)).concat([O('other', 'Another CRM'), O('none', 'No CRM')]);
  }

  const STEPS = [
    { id: 'need', title: 'What you need', fields: [
      { k: 'offer', label: 'What should we build?', type: 'offer', req: true },
      { k: 'niche', label: 'Your industry', type: 'niche', req: true },
      { k: 'goal', label: 'What matters most right now?', type: 'single', when: offerIs('UNSURE'), opts: [O('calls', 'Stop losing jobs to missed calls'),
        O('online', 'Get found online and look professional'), O('both', 'Both'), O('unsure', 'Not sure yet')] },
      { k: 'locations', label: 'How many locations or phone lines?', type: 'single', when: offerIs('RCP', 'BNDL'),
        opts: [O('1', '1'), O('2', '2'), O('3', '3'), O('4plus', '4 or more')] }
    ] },
    { id: 'extras', title: a => a.offer === 'WEB' ? 'Your website' : 'Extras that change the price', sub: 'Last screen. Skip what doesn’t apply.', fields: [
      { k: 'calls_week', label: a => isRE(a) ? 'Leads per week' : 'Calls per week', hint: 'A rough guess is fine.', type: 'single', when: receptionist,
        opts: [O('lt20', 'Under 20'), O('20_50', '20–50'), O('50_150', '50–150'), O('150_400', '150–400'), O('400plus', 'Over 400')] },
      { k: 'locations', label: 'How many locations or phone lines?', type: 'single', when: offerIs('UNSURE'),
        opts: [O('1', '1'), O('2', '2'), O('3', '3'), O('4plus', '4 or more')] },
      { k: 'spanish', label: 'Do your callers speak Spanish?', type: 'single', when: receptionist, opts: [O('many', 'Yes, many'), O('some', 'Some'), O('no', 'No')] },
      { k: 'dispatch', label: 'Send urgent night calls to your on-call tech?', type: 'single',
        when: a => !isRE(a) && offerIs('RCP', 'BNDL')(a),
        hint: 'The assistant rings your on-call list and connects the caller.', opts: dispatchOptions },
      { k: 're_crm', label: 'Which CRM do you use?', type: 'single', when: a => isRE(a) && a.offer !== 'WEB',
        hint: 'Not listed? Most connect through Zapier; some need a custom quote.', opts: reCrmOptions },
      { k: 'tools', label: a => isRE(a) ? 'Anything else you use?' : 'Which of these do you use?', hint: 'Some add to the price. No logins needed now.',
        type: 'multi', when: a => a.offer !== 'WEB', opts: toolOptions },
      { k: 'tools_other', label: 'Which other tool?', type: 'text', when: a => a.offer !== 'WEB' && (has(a, 'tools', 'other') || (isRE(a) && a.re_crm === 'other')), ph: 'Tool name' },
      { k: 'has_website', label: 'Do you have a website today?', type: 'single', when: offerIs('WEB', 'UNSURE'), opt: offerIs('WEB'), opts: [O('yes', 'Yes'), O('outdated', 'Yes, but it’s outdated'), O('no', 'No')] },
      { k: 'web_extras', label: 'Anything beyond the 5 standard pages?', hint: 'Pick all that apply.', type: 'multi', none: 'none', when: offerIs('WEB', 'BNDL'),
        opts: [O('extra_pages', 'More pages'), O('spanish', 'Spanish version'), O('logo', 'Logo design'), O('blog', 'Blog with starter articles'), O('none', 'No, 5 pages is fine')] },
      { k: 'more', label: 'Anything else we should know?', hint: 'Special rules, other systems, a deadline.', type: 'textarea', opt: true }
    ] }
  ];

  const resolve = (x, a, PB) => typeof x === 'function' ? x(a, PB) : x;
  const visible = (f, a) => !f.when || !!f.when(a);
  const optional = (f, a) => typeof f.opt === 'function' ? !!f.opt(a) : !!f.opt;   // drawn inside the step's closed fold
  const stepsFor = a => STEPS.filter(s => visible(s, a));
  const fieldsFor = a => stepsFor(a).flatMap(s => s.fields.filter(f => visible(f, a)).map(f => Object.assign({ step: s.id }, f)));
  const counted = f => f.type !== 'note';
  // every field a person could see on a path (conditional follow-ups like tools_other counted as visible)
  function countFields(offer, niche) {
    const a = { offer, niche, tools: ['other'] };
    return fieldsFor(a).filter(counted).length;
  }

  function optsOf(f, a, PB) {
    if (f.type === 'offer') return offerOpts(a);
    if (f.type === 'niche') return (PB && PB._niches || []).map(n => O(n.key, n.label));
    return resolve(f.opts, a, PB) || [];
  }
  const OFFER_OPTS = [O('RCP', 'FirstRing AI Receptionist'), O('WEB', 'Business Website'), O('BNDL', 'Receptionist + Website bundle'), O('UNSURE', 'Not sure yet')];
  // real estate: same RCP product, framed as lead capture + qualification (not "receptionist")
  const offerOpts = a => isRE(a || {}) ? [O('RCP', 'FirstRing AI Lead Assistant'), O('WEB', 'Agent Website'), O('BNDL', 'Lead Assistant + Website bundle'), OFFER_OPTS[3]] : OFFER_OPTS;
  // what a NEW questionnaire offers (the cards on step 2); offerOpts keeps every label for stored questionnaires
  const NEW_OFFERS = ['WEB'], LEGACY_OFFERS = ['RCP', 'BNDL', 'UNSURE'];
  const newOfferOpts = a => offerOpts(a).filter(o => NEW_OFFERS.indexOf(o.v) !== -1);

  function valueText(f, v, a, PB) {
    if (v == null || v === '') return '';
    const opts = (f.type === 'multi' || f.type === 'single' || f.type === 'offer' || f.type === 'niche') ? optsOf(f, a, PB) : null;
    const lab = x => { const o = opts && opts.find(o => o.v === x); return o ? o.l : String(x); };
    if (Array.isArray(v)) return v.map(lab).join(', ');
    return opts ? lab(v) : String(v).trim();
  }

  // ordered [{k, q, a}] stored in questionnaires.summary (admin + e-mails + the quote engine read it)
  function buildSummary(a, PB) {
    return fieldsFor(a).filter(f => counted(f) && f.type !== 'files').map(f => ({ k: f.k, q: resolve(f.label, a, PB), a: valueText(f, a[f.k], a, PB) }));
  }

  // answers restricted to the fields visible on the current path (what gets stored; hidden branches are dropped)
  function visibleAnswers(a) {
    const out = {};
    fieldsFor(a).forEach(f => { if (f.type !== 'note' && f.type !== 'files' && a[f.k] != null && a[f.k] !== '' && !(Array.isArray(a[f.k]) && !a[f.k].length)) out[f.k] = a[f.k]; });
    return out;
  }

  // Non-binding hints for the quote engine (A6 owns pricing; this only documents the mapping in code).
  function quoteHints(a, PB) {
    const ints = PB && PB.integrations || {};
    const add = [], custom = [], notes = [];
    if (a.locations === '2') add.push({ code: 'ADD-LOC', qty: 1 });
    if (a.locations === '3') add.push({ code: 'ADD-LOC', qty: 2 });
    if (a.locations === '4plus') custom.push('locations_over_3');
    if (a.calls_week === '400plus') custom.push('call_volume');
    if (a.spanish === 'many' || a.spanish === 'some') add.push({ code: 'ADD-ES', qty: 1 });
    if (a.dispatch === 'yes' && a.niche !== 'real_estate') {
      if (sold(PB, 'ADD-DISPATCH')) add.push({ code: 'ADD-DISPATCH', qty: 1 }); else notes.push('wants ADD-DISPATCH (not available yet)');
    }
    const crm = [];
    (a.tools || []).forEach(t => {
      const m = ints[t] || 'custom';
      if (m.indexOf('addon:') === 0) crm.push(t);
      else if (m === 'custom') custom.push('tool:' + t);
    });
    if (crm.length && (a.offer === 'RCP' || a.offer === 'BNDL')) add.push({ code: 'ADD-CRM', qty: crm.length, systems: crm });
    const W = { extra_pages: 'ADD-PAGE', spanish: 'ADD-WEB-ES', logo: 'ADD-LOGO', blog: 'ADD-BLOG' };
    (a.web_extras || []).forEach(x => { if (W[x]) add.push({ code: W[x], qty: 1 }); });
    if (isRE(a) && a.re_crm && a.re_crm !== 'none') {
      const m = ints[a.re_crm] || 'zapier';   // 'other' CRM: connected through Zapier per owner decision
      if (m === 'custom' && a.re_crm !== 'other') custom.push('crm:' + a.re_crm); else notes.push('real-estate CRM ' + a.re_crm + ' via ' + (a.re_crm === 'other' ? 'zapier' : m));
    }
    if (a.timeline === 'asap') notes.push('consider ADD-RUSH');
    return { core: a.offer || null, add, custom, notes };
  }

  window.StartQ = { VERSION: 2, PROFILE, PROFILE_CONTACT, HOW_HEARD, STEPS, OFFER_OPTS, offerOpts, NEW_OFFERS, LEGACY_OFFERS, newOfferOpts, isRE, US_TZ, stepsFor, fieldsFor, visible, optional, optsOf, resolve, valueText, buildSummary, visibleAnswers, countFields, quoteHints, toolOptions, reCrmOptions };
})();
