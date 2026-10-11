/* Sales questionnaire content: the single source for the form, the summary, the admin view and the quote engine.

   STABILITY CONTRACT
   - Field keys (k) and option values (v) are stored in questionnaires.answers (jsonb). NEVER rename or reuse them;
     add new keys instead. Labels (l / label) may change freely (the summary is rebuilt from labels on each save).
   - questionnaires.offer / .niche columns mirror answers.offer / answers.niche.
   - Onboarding facts (exact hours, which calendar/CRM account, phone carrier and forwarding) are NOT asked here:
     they are collected after the deposit in the setup checklist (SPEC §6.8). Here we only ask what changes the quote.

   KEYS (step -> keys)                         used by the quote engine (A6) as
   project   offer, niche                      core code (RCP|WEB|BNDL|UNSURE), niche (dental = manual review)
   recommend goal, website_now, biggest_leak   UNSURE only: inputs for the recommended core offer
   business  services[], service_area,         context
             locations                         '2' -> ADD-LOC x1, '3' -> ADD-LOC x2, '4plus' -> custom
   calls     who_answers, calls_week,          calls_week '400plus' -> custom (volume over the auto-quote limit)
             missed_pct, after_hours (not RE),
             urgent (not real_estate), job_value
             re_lead_types[], re_qualify[]     real_estate only (lead screening: buyer/seller/renter, timeline, pre-approval)
   website   has_website, domain, gbp,         WEB/BNDL; domain + gbp WEB only
             content_have[], web_extras[]      web_extras: extra_pages->ADD-PAGE, spanish->ADD-WEB-ES, logo->ADD-LOGO, blog->ADD-BLOG
   tools     re_crm (real_estate only: integration_meta crm/real_estate keys + other|none; mapped via pricebook.integrations), tools[], tools_other
                                               each tool key maps via pricebook.integrations: native | zapier | addon:<code> | custom
   prefs     spanish, price_on_phone (not RE)  spanish 'many'|'some' -> ADD-ES
   finish    timeline, decider, files, more    timeline 'asap' -> suggest ADD-RUSH (never auto-added)
   quoteHints(answers, pricebook) below returns the same mapping as data. */
(function () {
  const O = (v, l, d) => d ? { v, l, d } : { v, l };
  const has = (a, k, v) => Array.isArray(a[k]) && a[k].indexOf(v) !== -1;
  const offerIs = (...codes) => a => codes.indexOf(a.offer) !== -1;
  const receptionist = offerIs('RCP', 'BNDL', 'UNSURE');
  const isRE = a => a.niche === 'real_estate';

  const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
    'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
    'VA', 'WA', 'WV', 'WI', 'WY'];
  const US_TZ = [O('America/New_York', 'Eastern (New York)'), O('America/Chicago', 'Central (Chicago)'), O('America/Denver', 'Mountain (Denver)'),
    O('America/Phoenix', 'Arizona (Phoenix)'), O('America/Los_Angeles', 'Pacific (Los Angeles)'), O('America/Anchorage', 'Alaska (Anchorage)'),
    O('Pacific/Honolulu', 'Hawaii (Honolulu)')];

  // Profile = public.profiles columns (asked once, editable later). 9 fields.
  const PROFILE = [
    { k: 'full_name', label: 'Full name', type: 'text', req: true, auto: 'name' },
    { k: 'company', label: 'Business name', type: 'text', req: true, auto: 'organization' },
    { k: 'phone', label: 'Mobile phone', type: 'tel', req: true, auto: 'tel', ph: '(555) 555-0100', hint: 'For quote questions by text. We never call unannounced.' },
    { k: 'website', label: 'Website (optional)', type: 'url', auto: 'url', ph: 'yourbusiness.com' },
    { k: 'city', label: 'City', type: 'text', auto: 'address-level2', half: true },
    { k: 'state', label: 'State', type: 'select', opts: US_STATES.map(s => O(s, s)), auto: 'address-level1', half: true },
    { k: 'timezone', label: 'Time zone', type: 'select', opts: US_TZ, hint: 'Detected from your device. Used for your daily summaries.' },
    { k: 'how_heard', label: 'How did you hear about us?', type: 'select', opts: [O('upwork', 'Upwork'), O('google', 'Google search'),
      O('social', 'Facebook or Instagram'), O('referral', 'Referral from someone'), O('youtube', 'YouTube'), O('ai_assistant', 'An AI assistant (ChatGPT, Claude, …)'), O('other', 'Other')] },
    { k: 'update_lang', label: 'Preferred language for our updates', type: 'select', opts: [O('en', 'English'), O('he', 'Hebrew')], def: 'en',
      hint: 'Your portal stays in English; this only changes the language of personal notes from us.' }
  ];

  const NICHE_OPTS = {
    services: {
      home_services: [O('hvac', 'HVAC'), O('plumbing', 'Plumbing'), O('electrical', 'Electrical'), O('roofing', 'Roofing'), O('garage_doors', 'Garage doors'),
        O('locksmith', 'Locksmith'), O('pest', 'Pest control'), O('cleaning', 'Cleaning'), O('landscaping', 'Landscaping'), O('other', 'Other')],
      real_estate: [O('buyers', 'Buyer agent'), O('listings', 'Listing agent'), O('team', 'Team or brokerage'), O('rentals', 'Rentals / property management'),
        O('investor', 'Investor'), O('other', 'Other')],
      dental: [O('general', 'General dentistry'), O('cosmetic', 'Cosmetic'), O('ortho', 'Orthodontics'), O('pediatric', 'Pediatric'), O('surgery', 'Oral surgery'), O('other', 'Other')]
    },
    job_value: {
      home_services: [O('lt200', 'Under $200'), O('200_1k', '$200–$1,000'), O('1k_3k', '$1,000–$3,000'), O('gt3k', 'Over $3,000'), O('unsure', 'Not sure')],
      real_estate: [O('lt3k', 'Under $3,000'), O('3k_8k', '$3,000–$8,000'), O('8k_15k', '$8,000–$15,000'), O('gt15k', 'Over $15,000'), O('unsure', 'Not sure')],
      dental: [O('lt1k', 'Under $1,000'), O('1k_3k', '$1,000–$3,000'), O('gt3k', 'Over $3,000'), O('unsure', 'Not sure')]
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
  function reCrmOptions(a, PB) {
    const ints = PB && PB.integrations || {}, meta = PB && PB.integration_meta || {};
    const keys = Object.keys(meta).filter(k => k !== 'other' && k in ints && meta[k].category === 'crm' && (meta[k].niches || []).indexOf('real_estate') !== -1);
    return keys.map(k => O(k, meta[k].label)).concat([O('other', 'Another CRM'), O('none', 'No CRM')]);
  }

  const STEPS = [
    { id: 'project', title: 'Your project', sub: 'About 6 minutes. Everything saves as you go, so you can stop and come back.', fields: [
      { k: 'offer', label: 'What would you like a fixed quote for?', type: 'offer', req: true },
      { k: 'niche', label: 'Your industry', type: 'niche', req: true },
      { k: 'dental_note', type: 'note', when: a => a.niche === 'dental',
        text: 'Dental is in early access. We review every dental request by hand and confirm fit before quoting. The assistant collects only name, phone number and a general reason for the visit — no patient records.' }
    ] },
    { id: 'recommend', title: 'Help us recommend', sub: 'Three quick questions so we can suggest the right setup.', when: offerIs('UNSURE'), fields: [
      { k: 'goal', label: 'What matters most right now?', type: 'single', opts: [O('calls', 'Stop losing jobs to missed calls'),
        O('online', 'Get found online and look professional'), O('both', 'Both'), O('unsure', 'Not sure yet')] },
      { k: 'website_now', label: 'Your website today', type: 'single', opts: [O('good', 'I have one and it works'), O('outdated', 'I have one, but it is outdated'), O('none', 'No website')] },
      { k: 'biggest_leak', label: 'Where do you lose the most business?', type: 'single', opts: [O('missed_calls', 'Calls I can’t pick up while working'),
        O('slow_replies', 'Slow replies to web leads'), O('few_leads', 'Not enough leads coming in'), O('unsure', 'Not sure')] }
    ] },
    { id: 'business', title: 'Your business', sub: 'What you do and where.', fields: [
      { k: 'services', label: 'What do you offer?', hint: 'Pick all that apply.', type: 'multi', opts: a => NICHE_OPTS.services[nicheOf(a)] },
      { k: 'service_area', label: a => isRE(a) ? 'Which areas do you cover?' : 'Where do you work?', hint: 'ZIP codes, cities, counties or neighborhoods.', type: 'text', ph: 'e.g. 77002, 77005, Houston Heights' },
      { k: 'locations', label: 'How many locations or separate phone lines?', type: 'single', when: offerIs('RCP', 'BNDL'),
        opts: [O('1', '1'), O('2', '2'), O('3', '3'), O('4plus', '4 or more')] }
    ] },
    { id: 'calls', title: a => isRE(a) ? 'Your leads today' : 'Your calls today', sub: 'Rough guesses are fine.', when: receptionist, fields: [
      { k: 'who_answers', label: 'Who answers the phone today?', type: 'single', opts: [O('owner', 'Me'), O('staff', 'Office staff'),
        O('service', 'An answering service'), O('voicemail', 'Mostly voicemail')] },
      { k: 'calls_week', label: 'Calls per week', type: 'single', opts: [O('lt20', 'Under 20'), O('20_50', '20–50'), O('50_150', '50–150'),
        O('150_400', '150–400'), O('400plus', 'Over 400')] },
      { k: 'missed_pct', label: 'How many go unanswered?', type: 'single', opts: [O('lt10', 'Under 10%'), O('10_25', '10–25%'), O('25_50', '25–50%'),
        O('gt50', 'Over half'), O('unsure', 'Not sure')] },
      { k: 'after_hours', label: 'What happens to calls after hours?', type: 'single', when: a => !isRE(a), opts: [O('voicemail', 'Voicemail'), O('owner', 'I answer myself'),
        O('service', 'Answering service'), O('forward', 'They forward to someone on call')] },
      { k: 'urgent', label: 'Do you get urgent calls that can’t wait?', type: 'single', when: a => a.niche !== 'real_estate',
        opts: [O('often', 'Yes, often'), O('sometimes', 'Sometimes'), O('rarely', 'Rarely or never')] },
      { k: 're_lead_types', label: 'Which leads call you?', hint: 'Pick all that apply.', type: 'multi', when: isRE,
        opts: [O('buyers', 'Buyers'), O('sellers', 'Sellers'), O('renters', 'Renters'), O('investors', 'Investors')] },
      { k: 're_qualify', label: 'What should every caller be asked?', hint: 'Pick all that apply. You get the answers with each lead.', type: 'multi', when: isRE,
        opts: [O('timeline', 'When they plan to buy, sell or move'), O('preapproval', 'Mortgage pre-approval status'), O('budget', 'Budget or price range'),
          O('areas', 'Neighborhoods they want'), O('property', 'Address of the property to sell')] },
      { k: 'job_value', label: a => a.niche === 'real_estate' ? 'Average commission per closed deal' : a.niche === 'dental' ? 'Average value of a new patient' : 'Average value of a job',
        type: 'single', opts: a => NICHE_OPTS.job_value[nicheOf(a)] }
    ] },
    { id: 'website', title: 'Your website', sub: 'What you have today and what you’d like.', when: offerIs('WEB', 'BNDL'), fields: [
      { k: 'has_website', label: 'Do you have a website today?', type: 'single', opts: [O('yes', 'Yes'), O('outdated', 'Yes, but it’s outdated'), O('no', 'No')] },
      { k: 'domain', label: 'Do you own a domain name?', type: 'single', when: offerIs('WEB'), opts: [O('yes', 'Yes'), O('no', 'Not yet'), O('unsure', 'Not sure')] },
      { k: 'gbp', label: 'Do you have a Google Business Profile?', type: 'single', when: offerIs('WEB'), opts: [O('yes', 'Yes'), O('no', 'No'), O('unsure', 'Not sure')] },
      { k: 'content_have', label: 'What can you send us?', hint: 'Pick all that apply.', type: 'multi', none: 'none',
        opts: [O('logo', 'Logo'), O('photos', 'Photos of our work'), O('reviews', 'Customer reviews'), O('colors', 'Brand colors'), O('none', 'Nothing yet')] },
      { k: 'web_extras', label: 'Anything beyond the 5 standard pages?', hint: 'Optional extras. Pick all that apply.', type: 'multi', none: 'none',
        opts: [O('extra_pages', 'More pages'), O('spanish', 'Spanish version'), O('logo', 'Logo design'), O('blog', 'Blog with starter articles'), O('none', 'No, 5 pages is fine')] }
    ] },
    { id: 'tools', title: 'Your tools', sub: 'Just tick what you use. We connect everything after you accept the quote — no logins needed now.', fields: [
      { k: 're_crm', label: 'Which CRM holds your leads?', type: 'single', when: isRE, hint: 'Any CRM works: the ones not listed connect through Zapier.',
        opts: reCrmOptions },
      { k: 'tools', label: a => isRE(a) ? 'Anything else you use?' : 'Which of these do you use?', hint: 'Pick all that apply.', type: 'multi', opts: toolOptions },
      { k: 'tools_other', label: 'Which other tool?', type: 'text', when: a => has(a, 'tools', 'other') || (isRE(a) && a.re_crm === 'other'), ph: 'Tool name' }
    ] },
    { id: 'prefs', title: 'Language and rules', sub: 'Choices that shape how the assistant talks to your callers.', when: offerIs('RCP', 'BNDL'), fields: [
      { k: 'spanish', label: 'Do your callers speak Spanish?', type: 'single', opts: [O('many', 'Yes, many'), O('some', 'Some'), O('no', 'No')] },
      { k: 'price_on_phone', label: 'Should the assistant mention prices?', type: 'single', when: a => !isRE(a),
        opts: [O('no', 'No — our team gives prices'), O('fixed', 'Yes, a few fixed prices (like a service-call fee)')] }
    ] },
    { id: 'finish', title: 'Timing and anything else', sub: 'Last step. Files are optional.', fields: [
      { k: 'timeline', label: 'When would you like to start?', type: 'single', opts: [O('asap', 'As soon as possible (rush delivery is available)'),
        O('month', 'Within a month'), O('quarter', 'In the next 3 months'), O('exploring', 'Just exploring')] },
      { k: 'decider', label: 'Who signs off on this?', type: 'single', opts: [O('me', 'Just me'), O('partner', 'Me and a partner'), O('other', 'Someone else')] },
      { k: 'files', label: 'Files (optional, up to 5, 10 MB each)', hint: 'Logo, a screenshot of your current site, a price sheet — anything that helps.', type: 'files' },
      { k: 'more', label: 'Anything else we should know?', type: 'textarea' }
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
    if (a.niche === 'dental') notes.push('dental early access: manual review');
    return { core: a.offer || null, add, custom, notes };
  }

  window.StartQ = { VERSION: 1, PROFILE, STEPS, OFFER_OPTS, offerOpts, isRE, US_TZ, stepsFor, fieldsFor, visible, optsOf, resolve, valueText, buildSummary, visibleAnswers, countFields, quoteHints, toolOptions, reCrmOptions };
})();
