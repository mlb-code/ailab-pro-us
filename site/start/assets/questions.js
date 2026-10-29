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

   KEYS (step -> keys)                         used by the quote engine (A6) as
   need      offer, niche                      core code (RCP|WEB|BNDL|UNSURE), niche (home_services | real_estate)
             services[]                        context
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
             content_have[] (WEB)              context for the website brief
             more                              free text (collapsed "Add a note"); Claude reads it (HIPAA/EHR etc. surface here)
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
    hint: 'You hid your email from us at Apple. We only write to the address you give here.' };
  const PROFILE = [
    { k: 'full_name', label: 'Full name', type: 'text', req: true, auto: 'name' },
    { k: 'company', label: 'Business name', type: 'text', req: true, auto: 'organization' },
    { k: 'phone', label: 'Mobile phone', type: 'tel', req: true, auto: 'tel', ph: '(555) 555-0100', hint: 'For quote questions. We never call unannounced.' }
  ];
  // one optional tap on the thank-you screen (profiles.how_heard); never asked before the quote
  const HOW_HEARD = [O('upwork', 'Upwork'), O('google', 'Google search'), O('social', 'Facebook or Instagram'), O('referral', 'Referral from someone'),
    O('youtube', 'YouTube'), O('ai_assistant', 'An AI assistant (ChatGPT, Claude, …)'), O('other', 'Other')];

  const NICHE_OPTS = {
    services: {
      home_services: [O('hvac', 'HVAC'), O('plumbing', 'Plumbing'), O('electrical', 'Electrical'), O('roofing', 'Roofing'), O('garage_doors', 'Garage doors'),
        O('locksmith', 'Locksmith'), O('pest', 'Pest control'), O('cleaning', 'Cleaning'), O('landscaping', 'Landscaping'), O('other', 'Other')],
      real_estate: [O('buyers', 'Buyer agent'), O('listings', 'Listing agent'), O('team', 'Team or brokerage'), O('rentals', 'Rentals / property management'),
        O('investor', 'Investor'), O('other', 'Other')]
    }
  };
  const nicheOf = a => NICHE_OPTS.services[a.niche] ? a.niche : 'home_services';

  // Tools: the closed list = pricebook.integration_meta (niche-filtered) + Zapier + Other. Order follows the pricebook.
  function toolOptions(a, PB) {
    const meta = PB && PB.integration_meta || {};
    const crmKeys = isRE(a) ? reCrmOptions(a, PB).map(o => o.v).filter(v => v !== 'other' && v !== 'none') : [];
    return Object.keys(meta).filter(k => {
      const n = meta[k].niches || ['*'];
      if (crmKeys.indexOf(k) !== -1) return false;   // already asked in the niche's CRM question (re_crm)
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
    { id: 'need', title: 'What you need', sub: 'About 3 minutes. Everything saves as you go, so you can stop and come back.', fields: [
      { k: 'offer', label: 'What would you like us to build?', type: 'offer', req: true },
      { k: 'niche', label: 'Your industry', type: 'niche', req: true },
      { k: 'services', label: 'What do you do?', hint: 'Optional. Pick all that apply.', type: 'multi', opts: a => NICHE_OPTS.services[nicheOf(a)] },
      { k: 'goal', label: 'What matters most right now?', type: 'single', when: offerIs('UNSURE'), opts: [O('calls', 'Stop losing jobs to missed calls'),
        O('online', 'Get found online and look professional'), O('both', 'Both'), O('unsure', 'Not sure yet')] },
      { k: 'locations', label: 'How many locations or separate phone lines?', type: 'single', when: offerIs('RCP', 'BNDL'),
        opts: [O('1', '1'), O('2', '2'), O('3', '3'), O('4plus', '4 or more')] }
    ] },
    { id: 'extras', title: a => a.offer === 'WEB' ? 'Your website' : 'Extras that change the price', sub: 'Last screen. Pick what applies and skip the rest.', fields: [
      { k: 'calls_week', label: a => isRE(a) ? 'Leads per week' : 'Calls per week', hint: 'A rough guess is fine.', type: 'single', when: receptionist,
        opts: [O('lt20', 'Under 20'), O('20_50', '20–50'), O('50_150', '50–150'), O('150_400', '150–400'), O('400plus', 'Over 400')] },
      { k: 'locations', label: 'How many locations or separate phone lines?', type: 'single', when: offerIs('UNSURE'),
        opts: [O('1', '1'), O('2', '2'), O('3', '3'), O('4plus', '4 or more')] },
      { k: 'spanish', label: 'Do your callers speak Spanish?', type: 'single', when: receptionist, opts: [O('many', 'Yes, many'), O('some', 'Some'), O('no', 'No')] },
      { k: 'dispatch', label: 'Should urgent calls at night go straight to your on-call tech?', type: 'single',
        when: a => !isRE(a) && offerIs('RCP', 'BNDL')(a),
        hint: 'Optional extra. The assistant rings your on-call list in order and puts the caller through. Without it, urgent callers get a message taken and you are alerted.', opts: dispatchOptions },
      { k: 're_crm', label: 'Where do you keep your leads (your CRM)?', type: 'single', when: a => isRE(a) && a.offer !== 'WEB',
        hint: 'If yours isn’t listed, most apps connect through Zapier. Some systems need a custom quote.', opts: reCrmOptions },
      { k: 'tools', label: a => isRE(a) ? 'Anything else you use?' : 'Which of these do you use?', hint: 'Pick all that apply. We connect everything after you accept the quote — no logins needed now.',
        type: 'multi', when: a => a.offer !== 'WEB', opts: toolOptions },
      { k: 'tools_other', label: 'Which other tool?', type: 'text', when: a => a.offer !== 'WEB' && (has(a, 'tools', 'other') || (isRE(a) && a.re_crm === 'other')), ph: 'Tool name' },
      { k: 'has_website', label: 'Do you have a website today?', type: 'single', when: offerIs('WEB', 'UNSURE'), opts: [O('yes', 'Yes'), O('outdated', 'Yes, but it’s outdated'), O('no', 'No')] },
      { k: 'web_extras', label: 'Anything beyond the 5 standard pages?', hint: 'Optional extras. Pick all that apply.', type: 'multi', none: 'none', when: offerIs('WEB', 'BNDL'),
        opts: [O('extra_pages', 'More pages'), O('spanish', 'Spanish version'), O('logo', 'Logo design'), O('blog', 'Blog with starter articles'), O('none', 'No, 5 pages is fine')] },
      { k: 'content_have', label: 'What can you send us?', hint: 'Pick all that apply. You send the files from your portal after the deposit.', type: 'multi', none: 'none', when: offerIs('WEB'),
        opts: [O('logo', 'Logo'), O('photos', 'Photos of our work'), O('reviews', 'Customer reviews'), O('colors', 'Brand colors'), O('none', 'Nothing yet')] },
      { k: 'more', label: 'Add a note (optional)', hint: 'Anything else we should know — special rules, other systems, a deadline.', type: 'textarea', collapsed: true }
    ] }
  ];

  const resolve = (x, a, PB) => typeof x === 'function' ? x(a, PB) : x;
  const visible = (f, a) => !f.when || !!f.when(a);
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
  const OFFER_OPTS = [O('RCP', 'Missed-Call AI Receptionist'), O('WEB', 'Business Website'), O('BNDL', 'Receptionist + Website bundle'), O('UNSURE', 'Not sure — recommend for me')];
  // real estate: same RCP product, framed as lead capture + qualification (not "receptionist")
  const offerOpts = a => isRE(a || {}) ? [O('RCP', 'Missed-Call AI Lead Assistant'), O('WEB', 'Agent Website'), O('BNDL', 'Lead Assistant + Website bundle'), OFFER_OPTS[3]] : OFFER_OPTS;

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

  window.StartQ = { VERSION: 2, PROFILE, PROFILE_CONTACT, HOW_HEARD, STEPS, OFFER_OPTS, offerOpts, isRE, US_TZ, stepsFor, fieldsFor, visible, optsOf, resolve, valueText, buildSummary, visibleAnswers, countFields, quoteHints, toolOptions, reCrmOptions };
})();
