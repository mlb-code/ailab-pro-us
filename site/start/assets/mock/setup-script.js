/* Scripted setup assistant for the MOCK backend (demo mode and the browser tests; never used with Supabase).
   Answers Backend.setupChat exactly like the Edge Function setup-agent would (contract v1, docs/setup-agent-design-2026-11-27.md
   section 2.3), deterministically and without any model: a small rule-based reader per topic turns the customer's words into a
   card ("Here's what I understood"), a confirm saves the FULL checklist item through the mock's update_onboarding_item
   (env.apply -> OnboardingConfig.patch, the same rules as the database), and the server-side state machine decides the next
   topic from the item statuses (an item done in the forms is done for the chat). Covers every block type: summary_card
   (pending / confirmed / superseded / failed), choices, action (connect_calendar, forwarding_instructions, test_call), notice,
   open_form; corrections; the calendar OAuth return; the forwarding test with self-confirm; "I see you updated ... in the form";
   failures (env.fail, set by ?mock_setup_fail=); resume after a reload or on another "device" (the conversation is in the mock db).
   Loaded after mock-backend.js; window.StartMockSetup.turn(env, request) -> response. */
(function (root) {
  const HS_ORDER = ['services', 'area', 'hours', 'after_hours', 'prices', 'faq', 'alerts', 'on_call', 'emergency', 'calendar', 'tools', 'business_phone', 'carrier', 'test_call'];
  const RE_ORDER = ['services', 're_leads', 'area', 're_screening', 'hours', 'after_hours', 'faq', 'alerts', 'on_call', 'emergency', 'calendar', 'tools', 'business_phone', 'carrier', 'test_call'];
  const ITEM = { services: 'faq', area: 'faq', prices: 'faq', re_leads: 'faq', re_screening: 'faq', faq: 'faq', hours: 'hours', after_hours: 'hours',
    alerts: 'alerts', on_call: 'alerts', emergency: 'alerts', calendar: 'calendar', tools: 'tools', business_phone: 'forward_calls', carrier: 'forward_calls', test_call: 'forward_calls' };
  const OPTIONAL = ['tools', 'sms'];
  const CARRIERS = [['verizon', 'Verizon', /verizon/], ['att', 'AT&T', /\bat\s?&\s?t\b|\batt\b/], ['tmobile', 'T-Mobile', /t-?mobile/], ['comcast', 'Comcast Business', /comcast|xfinity/],
    ['ringcentral', 'RingCentral', /ring\s?central/], ['googlevoice', 'Google Voice', /google\s?voice/], ['nextiva', 'Nextiva', /nextiva/], ['grasshopper', 'Grasshopper', /grasshopper/],
    ['ooma', 'Ooma Office', /ooma/], ['dialpad', 'Dialpad', /dialpad/], ['zoom', 'Zoom Phone', /zoom/], ['vonage', 'Vonage Business', /vonage/], ['other', 'Other / not sure', /other|not sure|don.?t know|no idea/]];
  const AFTER = [['book_next_day', 'Book the next open slot'], ['message_only', 'Take a message only'], ['emergency_dial', 'Take a message, and call my on-call number for emergencies']];
  const RE_LEADS = [['buyers', 'Buyers', /buy/], ['sellers', 'Sellers', /sell/], ['renters', 'Renters', /rent/], ['investors', 'Investors', /invest/]];
  const RE_ASK = [['timeline', 'When they plan to buy, sell or move', /timeline|when|timing|soon/], ['preapproval', 'Mortgage pre-approval status', /pre-?approv|mortgage|financ/],
    ['budget', 'Budget or price range', /budget|price|afford/], ['areas', 'Neighborhoods they want', /neighbo|area|where/], ['property', 'Address of the property to sell', /address|property|home to sell/]];
  const SUGGEST = { home_services: ['flooding', 'burst pipe', 'gas smell', 'no heat', 'sewage backup'], real_estate: ['water leak', 'flooding', 'fire', 'break-in'] };
  const TZ = { 'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii' };
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  // a typed "yes" confirms the latest card only when the WHOLE message is a short yes ("yes but change Friday" is a correction)
  const YES = /^(y(es|ep|eah|up)?|ok(ay)?|correct|right|looks (good|right)|sounds good|perfect|great|sure|yes please|that'?s right|all good|👍|✅)$/i;
  const EVENT_TEXT = { calendar_returned: 'Back from the calendar sign-in.', test_started: 'Test call started.', test_changed: 'Checked the test call.',
    forms_saved: 'Back from the forms.', back_online: 'Back online.' };
  const NOPE = /^(no|nope|none|nah|skip|skip (it|this|for now)|n\/a|not now|no thanks|i don.?t know|not sure|nothing)\b/i;

  const E = (code, status, retry) => { const e = new Error(code); e.code = code; e.status = status; if (retry != null) e.retry_after_s = retry; return e; };
  const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
  const fmtPhone = e => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (e || ''); };
  const toE164 = s => { const d = String(s || '').replace(/\D/g, ''); return /^1?[2-9]\d{9}$/.test(d) ? '+1' + d.slice(-10) : null; };
  const t12 = v => { const m = /^(\d{2}):(\d{2})$/.exec(v || ''); if (!m) return v; let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + m[2] + ' ' + ap; };
  const pad = h => (h < 10 ? '0' : '') + h;

  // ------------------------------------------------------------ state
  const isRE = env => (((cfgOf(env).business) || {}).niche) === 'real_estate';
  const cfgOf = env => (env.tenant && env.tenant.config) || {};
  const order = env => isRE(env) ? RE_ORDER : HS_ORDER;
  const item = (env, key) => env.items().find(o => o.key === key) || null;
  const textingOn = env => !!(env.brand && env.brand.texting && env.brand.texting.enabled === true);
  function conv(env) {
    let c = env.db.setup_conversations.find(x => x.client_id === env.client.id);
    if (!c) {
      c = { id: env.uuid(), client_id: env.client.id, user_id: env.u.id, status: 'active', topic: null, turns: 0, model: 'scripted', cost_usd: 0,
        state: { notes: {}, confirmed: {}, skipped: {}, attempts: {}, said: {}, writes: {}, composer: null, seen_at: env.now() }, last_activity_at: env.now(), created_at: env.now(), completed_at: null };
      env.db.setup_conversations.push(c);
    }
    return c;
  }
  const msgsOf = (env, c) => env.db.setup_messages.filter(m => m.conversation_id === c.id).sort((a, b) => a.seq - b.seq);
  function addMsg(env, c, role, text, blocks, extra) {
    const all = msgsOf(env, c), seq = all.length ? all[all.length - 1].seq + 1 : 1;
    const m = Object.assign({ id: env.uuid(), conversation_id: c.id, seq, role, text: String(text || '').slice(0, 2000), blocks: blocks || [], created_at: env.now() }, extra || {});
    env.db.setup_messages.push(m);
    (m.blocks || []).forEach(b => { if (b.type === 'summary_card') { const p = env.db.setup_proposals.find(x => x.id === b.proposal_id); if (p) p.shown_seq = seq; } });
    return m;
  }
  function say(env, c, out, text, blocks, composer) {
    const S = c.state;
    if (S.nudge) { text = 'Please don’t share card numbers or passwords here. ' + text; S.nudge = false; }
    out.added.push(addMsg(env, c, 'assistant', text, blocks));
    S.composer = Object.assign({ enabled: true, hint: 'Type your answer', quick_replies: [] }, composer || {});
  }
  const qr = (label, text) => ({ label, input: { type: 'message', text: text || label } });

  // ------------------------------------------------------------ the request
  function turn(env, req) {
    if (!req || req.v !== 1 || !req.input || typeof req.input !== 'object') throw E('bad_input', 400);
    let inp = req.input;
    const T = inp.type;
    if (['resume', 'message', 'confirm', 'change', 'choose', 'event'].indexOf(T) === -1) throw E('bad_input', 400);
    if (T === 'message' && (typeof inp.text !== 'string' || !inp.text.trim())) throw E('bad_input', 400);
    if (T === 'message' && inp.text.length > 1000) throw E('payload_too_large', 413);
    if (!env.client || env.client.billing_mode !== 'subscription') throw E('not_a_plan_client', 403);
    const f = env.fail;
    if (f === 'server_error') throw E('server_error', 500);
    if (f === 'network') throw E('Failed to send a request to the Edge Function', 0);
    const c = conv(env), S = c.state, out = { added: [], updates: [] };
    c.last_activity_at = env.now();
    if (T === 'resume') {
      if (f === 'disabled') return respond(env, c, out, { all: true, status: 'unavailable', fallback: { reason: 'disabled', item_key: curItem(env, c), retry_after_s: null } });
      if (!msgsOf(env, c).length) greet(env, c, out);
      else resumeExtras(env, c, out);
      return respond(env, c, out, { all: true });
    }
    if (f === 'disabled' || ((f === 'budget' || f === 'limit') && T === 'message')) return respond(env, c, out, { status: 'unavailable', fallback: { reason: f, item_key: curItem(env, c), retry_after_s: f === 'disabled' ? null : 3600 } });
    if (f === 'rate_limited') throw E('rate_limited', 429, 60);
    if (f === 'turn_in_progress') throw E('turn_in_progress', 409);
    const all = msgsOf(env, c);
    let user = null;
    if (req.client_turn_id && T !== 'event') {   // idempotency: a known turn id answers the same again
      const prior = all.find(m => m.role === 'user' && m.client_turn_id === req.client_turn_id);
      if (prior) {
        const after = all.filter(m => m.seq > prior.seq);
        if (after.some(m => m.role === 'assistant')) return respond(env, c, { added: [prior].concat(after), updates: [] }, {});
        user = prior; inp = prior.input || inp;   // unanswered (the model failed before): answered now
      }
    }
    const minute = Date.now() - 60000;
    if (!user && T !== 'event' && all.filter(m => m.role === 'user' && Date.parse(m.created_at) > minute).length >= 30) throw E('rate_limited', 429, 60);   // the server: 12 (a test types faster)
    if (!user && T !== 'event') user = addMsg(env, c, 'user', userText(env, c, inp), [], { client_turn_id: req.client_turn_id || null, input: inp });
    if (user) out.added.push(user);
    if (T === 'event') out.added.push(addMsg(env, c, 'note', EVENT_TEXT[inp.event] || ''));
    if (f === 'assistant_unavailable') return respond(env, c, out, { status: 'unavailable', fallback: { reason: 'assistant_unavailable', item_key: curItem(env, c), retry_after_s: null } });
    c.turns++;
    if (inp.type === 'confirm') confirmP(env, c, inp.proposal_id, out);
    else if (inp.type === 'change') change(env, c, inp.proposal_id, out);
    else if (inp.type === 'choose') choose(env, c, inp.choice_id, out);
    else if (inp.type === 'event') onEvent(env, c, inp.event, out);
    else onText(env, c, user ? user.text : inp.text, out);
    S.seen_at = env.now();
    return respond(env, c, out, {});
  }
  function userText(env, c, inp) {
    if (inp.type === 'message') {
      const r = redact(inp.text); if (r !== inp.text) c.state.nudge = true;
      return r;
    }
    if (inp.type === 'confirm') return 'Looks right';
    if (inp.type === 'change') return 'Change something';
    if (inp.type === 'choose') {
      for (const m of msgsOf(env, c).slice().reverse()) for (const b of m.blocks || []) if (b.type === 'choices') { const o = (b.options || []).find(x => x.id === inp.choice_id); if (o) return o.label; }
      return inp.choice_id;
    }
    return '';
  }
  function luhn(d) { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
  function redact(t) {
    return String(t).replace(/\b(?:\d[ -]?){13,19}\b/g, m => luhn(m.replace(/\D/g, '')) ? '[card number removed]' : m)
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[removed]').replace(/(password|passcode|pin)\s*(is|:|=)?\s*\S+/gi, '$1: [removed]');
  }
  function respond(env, c, out, o) {
    const S = c.state;
    const lastAnswer = msgsOf(env, c).filter(m => m.role === 'assistant').reduce((a, m) => Math.max(a, m.seq), 0);
    const pub = m => {
      const x = { id: m.id, seq: m.seq, role: m.role, text: m.text, created_at: m.created_at, blocks: (m.blocks || []).map(b => {
        if (b.type !== 'summary_card') return b;
        const p = env.db.setup_proposals.find(y => y.id === b.proposal_id);
        return Object.assign({}, b, { status: p ? p.status : b.status });
      }) };
      if (m.role === 'user' && m.seq > lastAnswer) {
        x.unanswered = true; x.client_turn_id = m.client_turn_id || m.id;
        x.retry_input = m.input && m.input.type !== 'message' ? m.input : { type: 'message', text: m.text };
      }
      return x;
    };
    const today = new Date().toISOString().slice(0, 10);
    const used = env.db.setup_messages.filter(m => m.conversation_id === c.id && m.role === 'user' && String(m.created_at).slice(0, 10) === today).length;
    const fb = o.fallback || null;
    return { v: 1, conversation_id: c.id, status: o.status || c.status, messages: (o.all ? msgsOf(env, c).slice(-200) : out.added).map(pub), progress: progress(env, c),
      composer: fb && fb.reason !== 'assistant_unavailable' ? { enabled: false, hint: 'Use the form for now', quick_replies: [] } : (S.composer || { enabled: true, hint: 'Type your answer', quick_replies: [] }),
      fallback: fb, limits: { messages_left_today: Math.max(0, 150 - used) } };
  }
  function goLive(env, left) {
    const st = env.client.status;
    if (st === 'live') return 'live';
    const sim = env.db.provisioning_jobs.find(j => j.client_id === env.client.id && j.kind === 'golive_sim');
    if (st === 'testing') return sim && (sim.status === 'failed' || sim.status === 'delayed') ? 'delayed' : 'testing';
    if (!(env.tenant && env.tenant.twilio_number)) return 'waiting_number';
    return left ? 'steps_left' : 'testing';
  }
  function progress(env, c) {
    const items = env.items().filter(o => o.key !== 'sms' || textingOn(env));
    const steps = items.map(o => ({ key: o.key, title: o.title, status: o.status === 'done' ? 'done' : o.status === 'need_help' ? 'need_help' : 'todo', required: OPTIONAL.indexOf(o.key) === -1 }));
    const req = steps.filter(s => s.required), done = req.filter(s => s.status === 'done').length;
    const topic = c.topic || nextTopic(env, c);
    return { steps, done, total: req.length, topic: topic || null, go_live: goLive(env, req.length - done) };
  }
  function curItem(env, c) { const t = c.topic || nextTopic(env, c); return t ? ITEM[t] : null; }

  // ------------------------------------------------------------ topics
  function topicDone(env, c, t) {
    const S = c.state, it = item(env, ITEM[t]);
    if (!it) return true;
    if (t === 'test_call') return it.status === 'done';
    if (S.revisit && S.revisit.indexOf(t) !== -1) return !!(S.confirmed[t] || S.skipped[t]);   // "change my hours": asked again
    if (it.status === 'done') return true;
    if (t === 'test_call' || t === 'calendar') return false;
    return !!(S.confirmed[t] || S.skipped[t]);
  }
  const nextTopic = (env, c) => order(env).find(t => !topicDone(env, c, t)) || null;
  function ask(env, c, out, prefix) {
    const S = c.state;
    if (S.revisit && S.revisit.every(x => S.confirmed[x] || S.skipped[x])) S.revisit = null;
    const t = nextTopic(env, c);
    c.topic = t;
    if (!t) return complete(env, c, out, prefix);
    const q = question(env, c, t);
    if (!q) return;
    say(env, c, out, (prefix || '') + q.text, q.blocks, q.composer);
  }
  function complete(env, c, out, prefix) {
    if (c.status !== 'complete') { c.status = 'complete'; c.completed_at = env.now(); }
    const live = env.client.status === 'live';
    say(env, c, out, (prefix || '') + (live ? 'Everything is set up and you’re live. Want to change something? Just tell me, like “change my hours”.'
      : 'All required steps are done. We’re running automatic test calls against your settings now; you’ll be live within minutes and get an email.'), [],
    { hint: 'Tell me what to change', quick_replies: [] });
    if (live) c.state.said.live = true;
  }
  function greet(env, c, out) {
    const p = env.profile || {}, cfg = cfgOf(env), biz = cfg.business || {};
    const first = String(p.full_name || '').trim().split(/\s+/)[0];
    const rules = ((env.pb || {}).rules || {}).subscription || {};
    const product = ((rules.product_names || {})[biz.niche] || rules.product || '').trim();
    out.added.push(addMsg(env, c, 'assistant', 'Hi' + (first ? ' ' + first : '') + ', I’m the ' + (product ? product + ' ' : '') + 'setup assistant, an AI. I’ll ask a few short questions and set up your receptionist from your answers. About 10 minutes. You can stop any time and pick up later.' +
      (biz.name ? ' From your sign-up I already have ' + biz.name + (biz.main_phone ? ' at ' + fmtPhone(biz.main_phone) : '') + '.' : '')));
    out.added.push(addMsg(env, c, 'note', 'Your answers are processed by our AI provider (Anthropic) to set up your account. Please don’t share passwords or card numbers.'));
    ask(env, c, out, '');
  }
  // things that changed while the customer was away: go-live, the receptionist's number
  function resumeExtras(env, c, out) {
    const S = c.state;
    if (env.client.status === 'live' && !S.said.live) {
      S.said.live = true; c.status = 'complete';
      say(env, c, out, 'You’re live. Calls forwarded from your business line are answered. Want to change something? Just tell me, like “change my hours”.', [], { hint: 'Tell me what to change' });
      return;
    }
    const last = msgsOf(env, c).filter(m => m.role === 'assistant').pop();
    const waitingNumber = last && (last.blocks || []).some(b => b.type === 'action' && b.action === 'test_call' && b.state === 'no_number');
    if (waitingNumber && env.tenant && env.tenant.twilio_number) ask(env, c, out, 'Good news: your receptionist’s number is ready. ');
  }
  function question(env, c, t) {
    const cfg = cfgOf(env), re = isRE(env), S = c.state, biz = cfg.business || {};
    switch (t) {
      case 'services':
        if (re) {
          const list = ((cfg.booking || {}).job_types || []).slice(0, 30);
          const card = propose(env, c, 'services', { services: list.length ? list : ['Buyer consultation', 'Listing consultation', 'Home showing'] }, servicesFields);
          return card.block ? { text: 'First, what the receptionist books for you. These are the usual ones for agents. Keep these?', blocks: [card.block] } : null;
        }
        return { text: 'First: what jobs should the receptionist book for you? A few words each is fine.', composer: { hint: 'For example: drain cleaning, leak repair' } };
      case 'area': return { text: re ? 'Which areas do you cover? Cities, neighborhoods or ZIP codes are fine.' : 'Where do you work? Cities or ZIP codes are fine.', composer: { hint: 'Cities or ZIP codes', quick_replies: [qr('Skip for now', 'skip')] } };
      case 're_leads': return { text: 'Which leads should it take: buyers, sellers, renters, investors? Name the ones you want.', composer: { quick_replies: [qr('All four', 'buyers, sellers, renters and investors')] } };
      case 're_screening': return { text: 'What should it ask every new caller? For example their timeline, mortgage pre-approval, budget, the neighborhoods they want, or the address of a home to sell.' };
      case 'hours': return { text: 'When is someone usually there to answer?', composer: { hint: 'For example: Mon–Fri 8 to 5, Sat 9 to 12' } };
      case 'after_hours': return { text: 'After hours, what should happen when someone calls?', blocks: [{ type: 'choices', id: 'after_hours', options: AFTER.map(([v, l]) => ({ id: 'after_hours:' + v, label: l })) }] };
      case 'prices': return { text: 'Should the receptionist mention any prices, like a service-call fee? Tell me the price, or say no.', composer: { quick_replies: [qr('No prices', 'no')] } };
      case 'faq': return { text: 'What do callers ask you most? Give me a question and your answer. A few is plenty.', composer: { hint: 'Question? Answer.' } };
      case 'alerts': {
        const em = ((cfg.notify || {}).email || [])[0] || (env.profile || {}).email || '';
        return { text: 'Who should hear about new leads right away?' + (em ? ' I have ' + em + '.' : '') + ' Add a mobile number for text alerts? (Texts start once business texting is approved; until then alerts come by email.)',
          composer: { quick_replies: [qr('Just email', 'just email')] } };
      }
      case 'on_call': return { text: 'Is there a phone number we should ring for urgent jobs, or when a caller asks for a person? We ring it for 20 seconds, then take a message.', composer: { hint: 'A US phone number, or say no', quick_replies: [qr('No on-call number', 'no')] } };
      case 'emergency': {
        const sg = SUGGEST[re ? 'real_estate' : 'home_services'];
        return { text: 'Which words should count as an emergency? People often say ' + sg.slice(0, 3).map(w => '“' + w + '”').join(', ') + '. Tell me yours, or say “use those”.', composer: { quick_replies: [qr('Use those', 'use those')] } };
      }
      case 'calendar':
        if (S.calendly && !S.calendlyLink) return { text: 'What’s your Calendly booking link? It looks like https://calendly.com/your-name/service-call', composer: { hint: 'https://calendly.com/…' } };
        if (S.calendlyLink) return { text: 'Last part for Calendly: connect your account so the receptionist can book.', blocks: [{ type: 'action', action: 'connect_calendar', provider: 'calendly', tenant_id: env.tenant ? env.tenant.id : null }] };
        return { text: 'Now your calendar, so the receptionist can book visits. Which do you use?', blocks: [{ type: 'choices', id: 'calendar', options: [{ id: 'calendar:google', label: 'Google Calendar' }, { id: 'calendar:calendly', label: 'Calendly (paid plan)' }, { id: 'calendar:messages_only', label: 'No calendar: take messages only' }] }] };
      case 'tools': return { text: 'Do you use other tools, like a CRM or Zapier? We can send each new lead to them.', blocks: [{ type: 'choices', id: 'tools', options: [{ id: 'tools:skip', label: 'No, skip this' }, { id: 'tools:zapier', label: 'Yes, I have a Zapier webhook' }] }] };
      case 'business_phone':
        if (!biz.main_phone || S.bizAsk) return { text: 'What’s the number your customers call? That’s the line you’ll forward.', composer: { hint: 'A US phone number' } };
        return { text: 'Last step: call forwarding. Your business number is ' + fmtPhone(biz.main_phone) + '. Is that the number your customers call?', composer: { hint: 'Yes, or the right number', quick_replies: [qr('Yes', 'yes'), qr('No, it’s another number', 'no, it’s another number')] } };
      case 'carrier': return { text: 'Who’s your phone provider?', blocks: [{ type: 'choices', id: 'carrier', options: ['verizon', 'att', 'tmobile', 'comcast', 'ringcentral', 'other'].map(k => ({ id: 'carrier:' + k, label: CARRIERS.find(x => x[0] === k)[1] })) }], composer: { hint: 'Or type it, like “Nextiva”' } };
      case 'test_call': return testQuestion(env, c);
    }
    return null;
  }
  function testState(env) {
    const it = item(env, 'forward_calls'); if (!it) return 'ready';
    if (!(env.tenant && env.tenant.twilio_number)) return 'no_number';
    if (it.status === 'done') return 'passed';
    const d = it.data || {}, st = d.test_started_at || '';
    const mism = d.test_mismatch_at && d.test_mismatch_at >= st && (!d.test_unverified_at || d.test_mismatch_at >= d.test_unverified_at);
    if (mism) return 'mismatch';
    if (d.test_unverified_at && d.test_unverified_at >= st) return d.test_direct ? 'direct' : 'unverified';
    if (st && Date.parse(st) > Date.now() - 30 * 60000) return 'waiting';
    return 'ready';
  }
  function testQuestion(env, c) {
    const it = item(env, 'forward_calls'), num = env.tenant && env.tenant.twilio_number, cfg = cfgOf(env);
    const car = ((it && it.data) || {}).carrier || 'other', label = (CARRIERS.find(x => x[0] === car) || [0, 'your phone provider'])[1];
    const tc = { type: 'action', action: 'test_call', item_id: it ? it.id : null, number: num || null, state: testState(env) };
    if (!num) return { text: 'Your receptionist’s phone number isn’t ready yet (usually a few minutes). Everything else is saved. Come back when we email you, and I’ll show you how to forward your calls.', blocks: [tc] };
    return { text: 'Here’s how to forward your missed calls to ' + fmtPhone(num) + ' on ' + label + '. First, try it yourself: call ' + fmtPhone(num) + ' and talk to your receptionist like a customer would. Then turn on forwarding and press Test call.',
      blocks: [{ type: 'action', action: 'forwarding_instructions', carrier: car, forward_to: num, business_phone: (cfg.business || {}).main_phone || null }, tc] };
  }

  // ------------------------------------------------------------ cards (proposals) and saves
  function fullData(env, key, patch) {
    const it = item(env, key), d = (it && it.data) || {}, cfg = cfgOf(env), re = isRE(env), base = {};
    const set = (k, v) => { if (v !== undefined) base[k] = v; };
    if (key === 'faq') {
      set('services', d.services || ((cfg.booking || {}).job_types));
      set('service_area', 'service_area' in d ? d.service_area : areaText(cfg));
      set('faq', d.faq || cfg.faq || []);
      if (!re) {
        set('price_on_phone', d.price_on_phone || (cfg.pricing ? (cfg.pricing.mode === 'listed' ? 'fixed' : 'no') : undefined));
        set('fixed_prices', d.fixed_prices || (cfg.pricing && cfg.pricing.mode === 'listed' ? (cfg.pricing.items || []).map(priceLine) : undefined));
      } else { set('re_lead_types', d.re_lead_types); set('re_qualify', d.re_qualify); }
    } else if (key === 'hours') {
      set('hours', d.hours || cfg.hours); set('timezone', d.timezone || (cfg.business || {}).timezone); set('after_hours', d.after_hours || cfg.after_hours);
    } else if (key === 'alerts') {
      set('notify', d.notify || cfg.notify); set('on_call_number', 'on_call_number' in d ? d.on_call_number : ((cfg.handoff || {}).number || null)); set('emergency', d.emergency || cfg.emergency);
    } else if (key === 'calendar') {
      ['provider', 'booking_link', 'booking_mode'].forEach(k => set(k, d[k]));
    } else if (key === 'tools') set('zapier_webhook_url', 'zapier_webhook_url' in d ? d.zapier_webhook_url : ((cfg.zapier || {}).webhook_url || null));
    return Object.assign(base, patch || {});
  }
  function areaText(cfg) {
    const b = cfg.business || {}, parts = (b.service_area_places || []).concat(b.service_area_zips || []);
    return parts.length ? parts.join(', ') : undefined;
  }
  const priceLine = x => x.name + ': $' + x.price_usd + (x.note ? ' (' + x.note + ')' : '');
  // dry run (the server's setup_preview_step): the same checks the save will run, before a card is shown
  function preview(env, key, data) {
    const it = item(env, key); if (!it) return 'no_item';
    try { if (root.OnboardingConfig && env.client.billing_mode === 'subscription') root.OnboardingConfig.patch(key, Object.assign({}, it.data || {}, data), cfgOf(env)); return null; }
    catch (e) { return e.code || e.message; }
  }
  function propose(env, c, topic, patch, fieldsFn, out, extra) {
    const key = ITEM[topic === 'alerts_card' ? 'alerts' : topic] || 'alerts', data = fullData(env, key, patch);
    const bad = preview(env, key, data);
    if (bad) return { error: bad };
    const S = c.state;
    env.db.setup_proposals.filter(p => p.conversation_id === c.id && p.topic === topic && p.status === 'pending').forEach(p => {
      p.status = 'superseded'; p.decided_at = env.now(); if (out) out.updates.push({ proposal_id: p.id, status: 'superseded' });
    });
    const it = item(env, key);
    const p = { id: env.uuid(), conversation_id: c.id, client_id: env.client.id, topic, item_key: key, data, base: it.updated_at || '', status: 'pending', shown_seq: 0, error: null, created_at: env.now(), decided_at: null };
    env.db.setup_proposals.push(p);
    const f = fieldsFn(env, data, patch, extra);
    S.attempts[topic] = 0;
    return { block: Object.assign({ type: 'summary_card', proposal_id: p.id, topic, item_key: key, title: f.title, status: 'pending', fields: f.fields }, f.note ? { note: f.note } : {}, {
      actions: [{ id: 'confirm', label: 'Looks right' }, { id: 'change', label: 'Change something' }] }) };
  }
  function showCard(env, c, out, topic, patch, fieldsFn, text, extra) {
    const r = propose(env, c, topic, patch, fieldsFn, out, extra);
    if (r.error) return repair(env, c, out, topic);
    c.topic = topic === 'alerts_card' ? 'emergency' : topic;
    say(env, c, out, text || 'Here’s what I understood. Is this right?', [r.block], { hint: 'Say yes, or tell me what to change', quick_replies: [] });
  }
  function repair(env, c, out, topic) {
    const S = c.state; S.attempts[topic] = (S.attempts[topic] || 0) + 1;
    say(env, c, out, 'I couldn’t fit that into the settings. Could you say it more briefly? Or fill this one in the form.', [{ type: 'open_form', item_key: ITEM[topic === 'alerts_card' ? 'alerts' : topic], label: 'Fill this in the form instead' }]);
  }
  function clarify(env, c, out, topic, text) {
    const S = c.state; S.attempts[topic] = (S.attempts[topic] || 0) + 1;
    const blocks = S.attempts[topic] >= 2 ? [{ type: 'open_form', item_key: ITEM[topic], label: 'Fill this in the form instead' }] : [];
    const q = topic === 'services' ? null : question(env, c, topic);   // (the real-estate services question shows a card)
    say(env, c, out, text + (blocks.length ? ' Want to fill this one in the form instead?' : ''), blocks, (q || {}).composer);
  }
  const TOPICS_OF = { faq: env => isRE(env) ? ['services', 're_leads', 'area', 're_screening', 'faq'] : ['services', 'area', 'prices', 'faq'], hours: () => ['hours', 'after_hours'], alerts: () => ['alerts', 'on_call', 'emergency'] };
  const itemComplete = (env, c, key) => (TOPICS_OF[key] ? TOPICS_OF[key](env) : []).every(t => c.state.confirmed[t] || c.state.skipped[t]);
  // save a whole item as the customer's own update_onboarding_item would; returns null or the error code
  function save(env, c, key, data, statusOverride) {
    const it = item(env, key); if (!it) return 'no_item';
    const status = statusOverride !== undefined ? statusOverride : (it.status === 'done' || itemComplete(env, c, key) ? 'done' : 'todo');
    try {
      env.apply(it.id, status, Object.assign({}, data, { via: 'setup_assistant', confirmed_at: env.now(), saved_at: env.now() }));
      c.state.writes[it.id] = item(env, key).updated_at;
      return null;
    } catch (e) { return e.code || e.message || 'save_failed'; }
  }
  function confirmP(env, c, pid, out) {
    const S = c.state;
    const p = env.db.setup_proposals.find(x => x.id === pid && x.conversation_id === c.id);
    if (!p || p.status !== 'pending') return ask(env, c, out, 'That card was already handled. ');
    const it = item(env, p.item_key);
    if (it && (it.updated_at || '') !== p.base) {   // the forms changed this step meanwhile: a fresh card from the new state
      p.status = 'superseded'; p.decided_at = env.now(); out.updates.push({ proposal_id: p.id, status: 'superseded' });
      return ask(env, c, out, 'That step changed in the form meanwhile, so I didn’t save that card. ');
    }
    const topics = p.topic === 'alerts_card' ? ['alerts', 'on_call', 'emergency'] : [p.topic];
    const before = topics.map(t => S.confirmed[t]);
    topics.forEach(t => { S.confirmed[t] = true; });
    const status = p.item_key === 'calendar' ? 'todo' : p.item_key === 'forward_calls' ? null : undefined;
    const err = save(env, c, p.item_key, p.data, status);
    p.decided_at = env.now();
    if (err) {
      topics.forEach((t, i) => { S.confirmed[t] = before[i]; });
      p.status = 'failed'; p.error = String(err).slice(0, 120); out.updates.push({ proposal_id: p.id, status: 'failed' });
      say(env, c, out, 'I couldn’t save that.', [{ type: 'notice', kind: 'err', text: errText(err) }, { type: 'open_form', item_key: p.item_key, label: 'Fix it in the form' }],
        { quick_replies: [qr('Try again', 'try again')] });
      return;
    }
    p.status = 'confirmed'; out.updates.push({ proposal_id: p.id, status: 'confirmed' });
    if (p.topic === 'calendar') { S.calendlyLink = true; return ask(env, c, out, 'Link saved. '); }
    ask(env, c, out, 'Saved. ');
  }
  function errText(code) {
    const m = /invalid_setting:([\w.[\]]+)/.exec(code || '');
    if (m) {
      const p = m[1], n = /\[(\d+)\]/.exec(p), num = n ? ' #' + (+n[1] + 1) : '';
      const what = /^faq/.test(p) ? 'FAQ' + num + (/\.a$/.test(p) ? ' answer (max 600 characters)' : /\.q$/.test(p) ? ' question (max 300 characters)' : ' (up to 25 questions)')
        : /^hours/.test(p) ? 'Hours (opening must be before closing)' : /^notify/.test(p) ? 'Alerts' : /job_types/.test(p) ? 'Services (1 to 30, each up to 80 characters)'
          : /emergency/.test(p) ? 'Emergency words' : /main_phone/.test(p) ? 'Your business number' : /booking_link/.test(p) ? 'That Calendly link' : p;
      return what + ' wasn’t accepted. Please check it.';
    }
    if (/calendar_not_connected/.test(code)) return 'Connect your calendar account first, or choose “No calendar: take messages only”.';
    if (/data_too_large/.test(code)) return 'This is too long to save. Please shorten some answers.';
    return 'That wasn’t saved. Please try again, or use the form.';
  }
  function change(env, c, pid, out) {
    const p = env.db.setup_proposals.find(x => x.id === pid && x.conversation_id === c.id);
    if (!p || p.status !== 'pending') return ask(env, c, out, 'That card was already handled. ');
    const S = c.state;
    if (p.topic === 'alerts_card') {   // the combined alerts card: the three questions again (answers kept until replaced)
      ['alerts', 'on_call', 'emergency'].forEach(t => { delete S.confirmed[t]; });
      p.status = 'superseded'; p.decided_at = env.now(); out.updates.push({ proposal_id: p.id, status: 'superseded' });
      return ask(env, c, out, 'Sure, let’s go through alerts again. ');
    }
    S.changing = p.topic; c.topic = p.topic;
    say(env, c, out, 'Sure. What should I change?', [], { hint: 'Type the change' });
  }

  // ------------------------------------------------------------ inputs
  function choose(env, c, id, out) {
    const S = c.state, [g, v] = String(id || '').split(':');
    if (g === 'after_hours' && AFTER.some(a => a[0] === v)) {
      S.confirmed.after_hours = true;
      const err = save(env, c, 'hours', fullData(env, 'hours', { after_hours: { mode: v } }));
      if (err) { delete S.confirmed.after_hours; return say(env, c, out, errText(err), [{ type: 'open_form', item_key: 'hours', label: 'Fix it in the form' }]); }
      return ask(env, c, out, 'Got it. ');
    }
    if (g === 'calendar') {
      c.topic = 'calendar';
      if (v === 'google') return say(env, c, out, 'Great. Press the button to connect it; you’ll come right back here.', [{ type: 'action', action: 'connect_calendar', provider: 'google', tenant_id: env.tenant ? env.tenant.id : null }]);
      if (v === 'calendly') { S.calendly = true; S.calendlyLink = false; return ask(env, c, out, 'Calendly needs a paid Calendly plan for booking. '); }
      if (v === 'messages_only') {
        const err = save(env, c, 'calendar', { booking_mode: 'messages_only', provider: null }, 'done');
        if (err) return say(env, c, out, errText(err), [{ type: 'open_form', item_key: 'calendar', label: 'Fix it in the form' }]);
        S.confirmed.calendar = true;
        return ask(env, c, out, 'OK, no calendar: the receptionist takes messages and emails them to you. You can connect a calendar later. ');
      }
    }
    if (g === 'tools' && v === 'skip') {
      const err = save(env, c, 'tools', { skipped: true, zapier_webhook_url: null }, 'done');
      if (!err) c.state.skipped.tools = true;
      return ask(env, c, out, 'No problem, skipped. ');
    }
    if (g === 'tools' && v === 'zapier') { c.topic = 'tools'; return say(env, c, out, 'Paste your Zapier webhook URL. It comes from “Webhooks by Zapier → Catch Hook” and starts with https://', [], { hint: 'https://hooks.zapier.com/…' }); }
    if (g === 'carrier' && CARRIERS.some(x => x[0] === v)) return setCarrier(env, c, out, v);
    return ask(env, c, out, 'That option isn’t available anymore. ');
  }
  function setCarrier(env, c, out, key) {
    const it = item(env, 'forward_calls');
    try { if (it) env.apply(it.id, null, { carrier: key }); } catch (e) { /* the carrier is a display preference */ }
    c.state.confirmed.carrier = true;
    return ask(env, c, out, '');
  }
  function onEvent(env, c, ev, out) {
    const S = c.state;
    if (ev === 'back_online') return;   // nothing new to say; the response carries the fresh progress
    if (ev === 'calendar_returned') {
      const it = item(env, 'calendar');
      if (it && it.status === 'done') {
        const g = (it.data || {}).provider === 'google';
        S.calendly = false; S.calendlyLink = false; S.confirmed.calendar = true;
        return ask(env, c, out, (g ? 'Google Calendar connected. ' : 'Your Calendly account is connected. In Calendly, add an invitee question named “Job details” to your event type, so the receptionist can write the caller’s details into each booking. '));
      }
      c.topic = 'calendar';
      return say(env, c, out, 'The calendar didn’t connect. You can try again, or take messages only for now.', (question(env, c, 'calendar') || {}).blocks);
    }
    if (ev === 'test_started') {
      const main = (cfgOf(env).business || {}).main_phone;
      c.topic = 'test_call';
      return say(env, c, out, 'Test started. From another phone, call ' + (main ? fmtPhone(main) : 'your business number') + ' and let it ring out. I’m watching for it.', [testBlock(env)]);
    }
    if (ev === 'test_changed') {
      const s = testState(env);
      if (s === 'passed') {
        const it = item(env, 'forward_calls'), self = ((it && it.data) || {}).verified === 'self_confirmed';
        return ask(env, c, out, self ? 'Thanks, that counts as your test call. ' : 'Your test call came through your business line. Forwarding works. ');
      }
      if (s === 'unverified') return say(env, c, out, 'A call reached your receptionist, but your phone company didn’t say which line forwarded it. Did you call your business number and let it ring out?', [testBlock(env)]);
      if (s === 'direct') return say(env, c, out, 'That call came straight from your business phone to the receptionist’s number, so it doesn’t test forwarding. From another phone, call your business number and let it ring out.', [testBlock(env)]);
      if (s === 'mismatch') {
        const d = (item(env, 'forward_calls') || {}).data || {};
        return say(env, c, out, 'That call came through ' + fmtPhone(d.test_mismatch_from) + '. If that’s your business line, tell me the number and test again.', [testBlock(env)]);
      }
      return;
    }
    if (ev === 'forms_saved') {
      const changed = env.items().filter(o => o.updated_at > (S.seen_at || '') && S.writes[o.id] !== o.updated_at && o.key !== 'sms');
      // cards for those steps are out of date now
      env.db.setup_proposals.filter(p => p.conversation_id === c.id && p.status === 'pending' && changed.some(o => o.key === p.item_key)).forEach(p => {
        p.status = 'superseded'; p.decided_at = env.now(); out.updates.push({ proposal_id: p.id, status: 'superseded' });
      });
      const NAMES = { hours: 'business hours', faq: 'services and FAQ', alerts: 'alerts', calendar: 'calendar', tools: 'other tools', forward_calls: 'call forwarding' };
      const names = changed.map(o => NAMES[o.key] || o.title.toLowerCase());
      return ask(env, c, out, names.length ? 'I see you updated your ' + names.join(' and ') + ' in the form. ' : 'Welcome back. ');
    }
    return ask(env, c, out, '');
  }
  const testBlock = env => { const it = item(env, 'forward_calls'); return { type: 'action', action: 'test_call', item_id: it ? it.id : null, number: (env.tenant && env.tenant.twilio_number) || null, state: testState(env) }; };
  const REVISIT = [['hours', /\bhours?\b|open|close/], ['services', /services?|jobs?/], ['area', /area|zip|cities|where (we|i) work/], ['prices', /price/], ['faq', /faq|questions?/],
    ['alerts', /alert|email|mobile|on-?call|emergenc/], ['calendar', /calendar|calendly|booking/], ['tools', /zapier|tools?|crm/], ['carrier', /provider|carrier|forwarding/]];
  function onText(env, c, text, out) {
    const S = c.state, low = String(text || '').trim().toLowerCase();
    const latest = latestCard(env, c);
    if (latest && YES.test(low.replace(/[.!\s]+$/, ''))) return confirmP(env, c, latest.id, out);
    if (/\b(a person|a human|real person|talk to (someone|a person|your team)|need help|help me)\b/.test(low)) return requestHelp(env, c, text, out);
    const rv = /\b(change|edit|update|fix|redo)\b/.test(low) && !S.changing ? REVISIT.find(r => r[1].test(low)) : null;
    if (rv && (c.status === 'complete' || rv[0] !== c.topic)) {   // revisit an earlier step
      const t = rv[0];
      (t === 'alerts' ? ['alerts', 'on_call', 'emergency'] : [t]).forEach(x => { delete S.confirmed[x]; delete S.skipped[x]; });
      if (t === 'calendar') { S.calendly = false; S.calendlyLink = false; }
      S.revisit = t === 'alerts' ? ['alerts', 'on_call', 'emergency'] : [t]; c.topic = t;
      const q = question(env, c, t);
      return say(env, c, out, 'Sure, let’s update that. ' + q.text, q.blocks, q.composer);
    }
    const t = S.changing || c.topic || nextTopic(env, c);
    S.changing = null;
    if (!t) return complete(env, c, out, 'Everything is set up. ');
    return (READ[t] || READ.default)(env, c, out, text, low, t);
  }
  function latestCard(env, c) {
    const ms = msgsOf(env, c);
    for (let i = ms.length - 1; i >= 0; i--) {
      const b = (ms[i].blocks || []).filter(x => x.type === 'summary_card').pop();
      if (b) { const p = env.db.setup_proposals.find(x => x.id === b.proposal_id); return p && p.status === 'pending' ? p : null; }
    }
    return null;
  }
  function requestHelp(env, c, text, out) {
    const key = curItem(env, c) || 'hours', it = item(env, key);
    try { if (it) env.apply(it.id, 'need_help', { help_message: String(text).slice(0, 2000), help_at: env.now(), via: 'setup_assistant' }); } catch (e) { /* shown below either way */ }
    say(env, c, out, 'I’ve sent your message to our team. They reply in writing, usually within a business day. Meanwhile we can keep going, or you can use the form.', [{ type: 'open_form', item_key: key, label: 'Open the form for this step' }]);
  }

  // ------------------------------------------------------------ readers (the scripted stand-in for the model)
  const splitList = t => String(t).replace(/\b(also|plus)\b/gi, ',').split(/[,;\n]|\.\s+|\band\b/i).map(x => x.trim().replace(/[.!]+$/, '')).filter(x => x && !/^(that'?s it|nothing else|thanks?)$/i.test(x)).map(cap);
  const servicesFields = (env, data) => ({ title: 'Services you book', fields: [{ key: 'services', label: 'Services', kind: 'list', value: data.services, text: data.services.join(' · ') }] });
  const areaFields = (env, data) => {
    const a = root.OnboardingConfig ? root.OnboardingConfig.parseArea(data.service_area || '') : { places: [], zips: [] };
    const f = [];
    if (a.places.length) f.push({ key: 'service_area_places', label: 'Places', kind: 'list', value: a.places, text: a.places.join(', ') });
    if (a.zips.length) f.push({ key: 'service_area_zips', label: 'ZIP codes', kind: 'list', value: a.zips, text: a.zips.join(', ') });
    if (!f.length) f.push({ key: 'service_area', label: 'Area', kind: 'text', value: data.service_area, text: data.service_area });
    return { title: isRE(env) ? 'Areas you cover' : 'Where you work', fields: f, note: 'Callers from outside these get a polite “we don’t cover that area”.' };
  };
  const hoursFields = (env, data) => {
    const tz = TZ[data.timezone] || String(data.timezone || '').replace(/_/g, ' ');
    const lines = []; let i = 0;
    while (i < 7) { const k = DAYS[i], v = data.hours[k], s = Array.isArray(v) ? v.join('-') : 'closed'; let j = i; while (j + 1 < 7 && (Array.isArray(data.hours[DAYS[j + 1]]) ? data.hours[DAYS[j + 1]].join('-') : 'closed') === s) j++; lines.push((i === j ? DAY_LABEL[k] : DAY_LABEL[k] + '–' + DAY_LABEL[DAYS[j]]) + ' ' + (s === 'closed' ? 'closed' : t12(v[0]) + '–' + t12(v[1]))); i = j + 1; }
    return { title: 'Business hours', fields: [{ key: 'hours', label: 'Hours' + (tz ? ' (' + tz + ' time)' : ''), kind: 'hours', value: data.hours, text: lines.join(' · ') }] };
  };
  const pricesFields = (env, data, patch, items) => ({ title: 'Prices it may say', fields: [{ key: 'fixed_prices', label: 'Prices', kind: 'prices', value: items, text: data.fixed_prices.join(' · ') }], note: 'Anything else is handed to you.' });
  const faqFields = (env, data, patch, cut) => ({ title: 'Questions & answers (' + data.faq.length + ')', fields: [{ key: 'faq', label: 'Questions callers ask', kind: 'faq', value: data.faq, text: data.faq.map((x, i) => (i + 1) + '. ' + x.q + ' ' + x.a).join(' ') }],
    note: cut ? 'I kept the first 25 (the limit). Tell me which to swap.' : 'The receptionist answers only from this list and hands anything else to you.' });
  const reLeadFields = (env, data) => ({ title: 'Leads it takes', fields: [{ key: 're_lead_types', label: 'Leads', kind: 'list', value: data.re_lead_types.map(k => RE_LEADS.find(x => x[0] === k)[1]), text: data.re_lead_types.join(', ') }] });
  const reAskFields = (env, data) => ({ title: 'What every caller is asked', fields: [{ key: 're_qualify', label: 'Questions', kind: 'list', value: data.re_qualify.map(k => RE_ASK.find(x => x[0] === k)[1]), text: data.re_qualify.join(', ') }],
    note: 'It never asks about protected traits, why someone is moving, or steers callers toward or away from an area (fair housing).' });
  const alertsFields = (env, data) => {
    const n = data.notify || {}, kw = ((data.emergency || {}).keywords) || [];
    return { title: 'Alerts & emergencies', fields: [
      { key: 'notify.email', label: 'Lead alerts by email', kind: 'list', value: n.email || [], text: (n.email || []).join(', ') },
      { key: 'notify.sms', label: 'Text alerts', kind: 'list', value: (n.sms || []).map(fmtPhone), text: (n.sms || []).map(fmtPhone).join(', ') || 'None' },
      { key: 'notify.daily_summary', label: 'Daily summary', kind: 'time', value: n.daily_summary || null, text: n.daily_summary ? t12(n.daily_summary) : 'Off' },
      { key: 'on_call_number', label: 'On-call number', kind: 'phone', value: data.on_call_number || null, text: data.on_call_number ? fmtPhone(data.on_call_number) : 'None' },
      { key: 'emergency.keywords', label: 'Emergency words', kind: 'list', value: kw, text: kw.join(', ') }] };
  };
  const linkFields = (env, data) => ({ title: 'Calendly link', fields: [{ key: 'booking_link', label: 'Booking link', kind: 'url', value: data.booking_link, text: data.booking_link }] });
  const zapFields = (env, data) => ({ title: 'Zapier webhook', fields: [{ key: 'zapier_webhook_url', label: 'New leads go to', kind: 'url', value: data.zapier_webhook_url, text: data.zapier_webhook_url }] });
  const bizFields = (env, data) => ({ title: 'Your business number', fields: [{ key: 'business_phone', label: 'The number your customers call', kind: 'phone', value: data.business_phone, text: fmtPhone(data.business_phone) }] });

  // hours: "mon-fri 7 to 6, saturday 8-12", corrections like "actually friday we close at 4"
  const DAYRX = [['mon', /\bmon(day)?s?\b/], ['tue', /\btue(s|sday)?s?\b/], ['wed', /\bwed(s|nesday)?s?\b/], ['thu', /\bthu(r|rs|rsday)?s?\b/], ['fri', /\bfri(day)?s?\b/], ['sat', /\bsat(urday)?s?\b/], ['sun', /\bsun(day)?s?\b/]];
  const DAYNAME = '(mon|tue|wed|thu|fri|sat|sun)[a-z]*';
  function daysIn(seg) {
    const s = seg.toLowerCase(), out = [];
    const r = new RegExp('\\b' + DAYNAME + '\\s*(?:-|–|to|through|thru)\\s*' + DAYNAME).exec(s);
    if (r) { const a = DAYS.indexOf(r[1]), b = DAYS.indexOf(r[2]); for (let i = a; i <= (b >= a ? b : b + 7); i++) out.push(DAYS[i % 7]); }
    if (/weekdays?/.test(s)) out.push('mon', 'tue', 'wed', 'thu', 'fri');
    if (/weekends?/.test(s)) out.push('sat', 'sun');
    if (/every ?day|daily|7 days|all week/.test(s)) out.push.apply(out, DAYS);
    if (!out.length) DAYRX.forEach(([k, rx]) => { if (rx.test(s)) out.push(k); });
    return DAYS.filter(d => out.indexOf(d) !== -1);
  }
  const H = (h, m, ap) => { h = +h; if (/^p/i.test(ap || '') && h < 12) h += 12; if (/^a/i.test(ap || '') && h === 12) h = 0; return h * 60 + (+m || 0); };
  const hm = v => pad(Math.floor(v / 60)) + ':' + pad(v % 60);
  function closeAfter(open, h, m, ap) {   // a closing time with no am/pm is the first reading after the opening time
    if (/noon/i.test(String(h))) return 12 * 60;
    let v = H(h, m, ap);
    if (!ap) while (v <= open && v < 24 * 60) v += 12 * 60;
    return v >= 24 * 60 ? 23 * 60 + 59 : v;
  }
  function timesIn(seg) {
    const m = /(\d{1,2}|noon)(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2}|noon|midnight)(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?/i.exec(seg);
    if (!m) return null;
    let o = m[1] === 'noon' ? 12 * 60 : H(m[1], m[2], m[3]);
    if (!m[3] && m[1] !== 'noon' && +m[1] <= 5) o += 12 * 60;
    const c = m[4] === 'midnight' ? 23 * 60 + 59 : closeAfter(o, m[4], m[5], m[6]);
    return c > o ? [hm(o), hm(c)] : null;
  }
  function parseHours(text) {
    const t = String(text).replace(/(\d|am|pm|noon|a\.m\.|p\.m\.)\s+(?:and\s+|&\s+)?(?=(mon|tue|wed|thu|fri|sat|sun|week|every|daily))/gi, '$1, ');
    const hours = {}; let any = false;
    t.split(/[,;\n]|\.\s/).forEach(seg => {
      const ds = daysIn(seg); if (!ds.length) return;
      const tm = timesIn(seg), closed = /closed|\boff\b/i.test(seg);
      if (!tm && !closed) return;
      ds.forEach(dd => { hours[dd] = closed && !tm ? null : tm; }); any = true;
    });
    if (!any) return null;
    DAYS.forEach(dd => { if (!(dd in hours)) hours[dd] = null; });
    return hours;
  }
  function correctHours(text, prev) {
    const h = JSON.parse(JSON.stringify(prev)), ds = daysIn(text); let hit = false;
    if (!ds.length) return null;
    const full = timesIn(text);
    if (full) { ds.forEach(d => { h[d] = full; }); return h; }
    const cl = /clos(?:e|es|ing)\s*(?:at)?\s*(\d{1,2}|noon)(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
    const op = /open(?:s|ing)?\s*(?:at)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
    ds.forEach(d => {
      if (cl && Array.isArray(h[d])) { const o = H(h[d][0].slice(0, 2), h[d][0].slice(3)); const c = closeAfter(o, cl[1], cl[2], cl[3]); if (c > o) { h[d] = [h[d][0], hm(c)]; hit = true; } }
      if (op && Array.isArray(h[d])) { let o = H(op[1], op[2], op[3]); if (!op[3] && +op[1] <= 5) o += 720; const c = H(h[d][1].slice(0, 2), h[d][1].slice(3)); if (o < c) { h[d] = [hm(o), h[d][1]]; hit = true; } }
      if (!cl && !op && /closed|\boff\b/i.test(text)) { h[d] = null; hit = true; }
    });
    return hit ? h : null;
  }
  function parsePricesText(text) {
    const items = [];
    String(text).split(/[,;\n]|\.\s+|\band\b/i).forEach(part => {
      const m = /^(.*?)(?:\s+(?:is|are|costs?|runs?|=))?\s*[:\-–]?\s*\$?\s*(\d{1,6}(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)?\s*(.*)$/i.exec(part.trim());
      if (!m) return;
      const name = cap(m[1].replace(/^(the|our|a|an|and)\s+/i, '').replace(/\s+(is|are|costs?)$/i, '').trim());
      if (!name || /nothing|else/i.test(name)) return;
      items.push({ name: name.slice(0, 80), price_usd: Number(m[2]), note: m[3].replace(/^[(\s-]+|[)\s.]+$/g, '').slice(0, 160) });
    });
    return items.slice(0, 30);
  }
  function parseFaq(text) {
    const s = String(text).replace(/\s+/g, ' ').trim(), sents = [];
    let buf = '';
    for (let i = 0; i < s.length; i++) { buf += s[i]; if (/[?.!]/.test(s[i]) && (s[i + 1] === ' ' || i === s.length - 1)) { sents.push(buf.trim()); buf = ''; } }
    if (buf.trim()) sents.push(buf.trim());
    const out = []; let cur = null;
    sents.forEach(x => {
      const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(x);
      if (/\?$/.test(x)) { if (cur && cur.a) out.push(cur); cur = { q: x, a: '' }; return; }
      if (dash && (!cur || cur.a)) { if (cur && cur.a) out.push(cur); cur = null; out.push({ q: dash[1].replace(/[?.]*$/, '?'), a: dash[2] }); return; }
      if (cur) cur.a = (cur.a ? cur.a + ' ' : '') + x;
    });
    if (cur && cur.a) out.push(cur);
    return out.map(x => ({ q: cap(x.q), a: cap(x.a) }));
  }
  const READ = {
    services(env, c, out, text, low) {
      const items = splitList(text).filter(x => x.length <= 80).slice(0, 30);
      if (!items.length || NOPE.test(low)) return clarify(env, c, out, 'services', 'The receptionist needs at least one service to book. What jobs do you take?');
      showCard(env, c, out, 'services', { services: items }, servicesFields);
    },
    area(env, c, out, text, low) {
      if (NOPE.test(low)) {
        c.state.skipped.area = true;
        const err = save(env, c, 'faq', fullData(env, 'faq', { service_area: null }));
        if (err) delete c.state.skipped.area;
        return ask(env, c, out, 'No problem, skipped. ');
      }
      showCard(env, c, out, 'area', { service_area: String(text).trim().slice(0, 500) }, areaFields);
    },
    re_leads(env, c, out, text, low) {
      const types = /\ball\b|every/.test(low) ? RE_LEADS.map(x => x[0]) : RE_LEADS.filter(x => x[2].test(low)).map(x => x[0]);
      if (!types.length) return clarify(env, c, out, 're_leads', 'Which of these should it take: buyers, sellers, renters or investors?');
      showCard(env, c, out, 're_leads', { re_lead_types: types }, reLeadFields);
    },
    re_screening(env, c, out, text, low) {
      const ask2 = RE_ASK.filter(x => x[2].test(low)).map(x => x[0]);
      if (!ask2.length) return clarify(env, c, out, 're_screening', 'Pick a few: timeline, pre-approval, budget, neighborhoods, or the address of a home to sell.');
      showCard(env, c, out, 're_screening', { re_qualify: ask2 }, reAskFields);
    },
    hours(env, c, out, text) {
      const prevP = env.db.setup_proposals.filter(p => p.conversation_id === c.id && p.topic === 'hours' && p.status === 'pending').pop();
      const h = (prevP && correctHours(text, prevP.data.hours)) || parseHours(text);
      if (!h) return clarify(env, c, out, 'hours', 'I didn’t catch the days and times. Which days are you open, and from when to when? For example “Mon–Fri 8 to 5”.');
      const tz = ((item(env, 'hours') || {}).data || {}).timezone || (cfgOf(env).business || {}).timezone;
      showCard(env, c, out, 'hours', Object.assign({ hours: h }, tz ? { timezone: tz } : {}), hoursFields, prevP ? 'Updated. Is this right now?' : null);
    },
    after_hours(env, c, out, text, low) {
      const v = /emergenc|on-?call|call me|urgent/.test(low) ? 'emergency_dial' : /book|slot|schedule|next/.test(low) ? 'book_next_day' : /message/.test(low) ? 'message_only' : null;
      if (!v) return say(env, c, out, 'Pick one of these:', (question(env, c, 'after_hours') || {}).blocks);
      choose(env, c, 'after_hours:' + v, out);
    },
    prices(env, c, out, text, low) {
      if (NOPE.test(low)) {
        c.state.confirmed.prices = true;
        const err = save(env, c, 'faq', fullData(env, 'faq', { price_on_phone: 'no', fixed_prices: [] }));
        if (err) delete c.state.confirmed.prices;
        return ask(env, c, out, 'OK, no prices on the phone: the receptionist hands price questions to you. ');
      }
      const items = parsePricesText(text);
      if (!items.length) return clarify(env, c, out, 'prices', 'Tell me each price with its name, like “service call 89”, or say no.');
      showCard(env, c, out, 'prices', { price_on_phone: 'fixed', fixed_prices: items.map(priceLine) }, pricesFields, null, items);
    },
    faq(env, c, out, text) {
      let pairs = parseFaq(text); const cut = pairs.length > 25; pairs = pairs.slice(0, 25);
      if (!pairs.length) return clarify(env, c, out, 'faq', 'Give me a question and its answer, like “Do you work weekends? Yes, Saturday mornings.”');
      showCard(env, c, out, 'faq', { faq: pairs }, faqFields, null, cut);
    },
    alerts(env, c, out, text, low) {
      const S = c.state, emails = (String(text).match(/[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}/gi) || []).map(x => x.toLowerCase()).slice(0, 5);
      const phones = phonesIn(text), oncall = phones.filter(p => p.oncall).map(p => p.e164), mob = phones.filter(p => !p.oncall).map(p => p.e164).slice(0, 5);
      const cur = cfgOf(env).notify || {};
      S.notes.notify = { email: emails.length ? emails : (cur.email || []).slice(0, 5), sms: mob, daily_summary: cur.daily_summary === undefined ? '19:00' : cur.daily_summary };
      if (!S.notes.notify.email.length && !mob.length) return clarify(env, c, out, 'alerts', 'Lead alerts need at least one email or mobile number. Where should they go?');
      if (oncall.length) { S.notes.on_call = oncall[0]; S.confirmed.on_call = true; }
      S.confirmed.alerts = true;
      ask(env, c, out, oncall.length ? 'Got it, and ' + fmtPhone(oncall[0]) + ' as your on-call number. ' : 'Got it. ');
    },
    on_call(env, c, out, text, low) {
      const S = c.state, ph = phonesIn(text)[0];
      if (!ph && !NOPE.test(low)) return clarify(env, c, out, 'on_call', 'That doesn’t look like a US phone number. Try again, or say no.');
      S.notes.on_call = ph ? ph.e164 : null; S.confirmed.on_call = true;
      ask(env, c, out, ph ? 'Got it. ' : 'OK, no on-call number: urgent callers get a message to you. ');
    },
    emergency(env, c, out, text, low) {
      const sg = SUGGEST[isRE(env) ? 'real_estate' : 'home_services'];
      let words = [];
      if (/use (those|these|them)|^(yes|sure|ok)/.test(low)) {
        words = sg.slice(0, 3);
        const extra = /(?:plus|and also|also|add)\s+(.+)$/i.exec(text);
        if (extra) words = words.concat(splitList(extra[1]).map(x => x.toLowerCase()));
      } else words = splitList(text).map(x => x.toLowerCase());
      words = words.filter((w, i) => w && w.length <= 60 && words.indexOf(w) === i).slice(0, 40);
      if (!words.length) return clarify(env, c, out, 'emergency', 'Tell me at least one word that means an emergency for you, or say “use those”.');
      const S = c.state, n = S.notes, cfg = cfgOf(env), oc = 'on_call' in n ? n.on_call : ((cfg.handoff || {}).number || null);
      S.confirmed.emergency = true;
      showCard(env, c, out, 'alerts_card', { notify: n.notify || cfg.notify, on_call_number: oc, emergency: { keywords: words, dial: oc } }, alertsFields, 'Here’s your alerts setup. Is this right?');
    },
    calendar(env, c, out, text, low) {
      const S = c.state, link = /https:\/\/calendly\.com\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\/?/.exec(text);
      if (link) { S.calendly = true; return showCard(env, c, out, 'calendar', { provider: 'calendly', booking_link: link[0], booking_mode: null }, linkFields); }
      if (/google/.test(low)) return choose(env, c, 'calendar:google', out);
      if (/calendly/.test(low)) return choose(env, c, 'calendar:calendly', out);
      if (/message|no calendar|don.?t have|none|^no\b/.test(low)) return choose(env, c, 'calendar:messages_only', out);
      if (S.calendly) return clarify(env, c, out, 'calendar', 'That doesn’t look like a Calendly booking link (https://calendly.com/your-name/event).');
      const q = question(env, c, 'calendar'); say(env, c, out, 'Which calendar do you use?', q.blocks);
    },
    tools(env, c, out, text, low) {
      const url = /https:\/\/\S+/.exec(text);
      if (url) return showCard(env, c, out, 'tools', { zapier_webhook_url: url[0].slice(0, 500), skipped: false }, zapFields);
      if (NOPE.test(low) || /don.?t|no\b/.test(low)) {
        const err = save(env, c, 'tools', { skipped: true, zapier_webhook_url: null }, 'done');
        if (!err) c.state.skipped.tools = true;
        return ask(env, c, out, 'No problem, skipped. ');
      }
      clarify(env, c, out, 'tools', 'Paste your Zapier webhook URL (it starts with https://), or say no.');
    },
    business_phone(env, c, out, text, low) {
      const ph = phonesIn(text)[0];
      if (!ph && YES.test(low.replace(/[.!\s]+$/, ''))) { c.state.confirmed.business_phone = true; return ask(env, c, out, ''); }
      if (!ph && /^no\b/.test(low)) { c.state.bizAsk = true; return ask(env, c, out, ''); }
      if (!ph) return clarify(env, c, out, 'business_phone', 'That doesn’t look like a US phone number. What’s the number your customers call?');
      showCard(env, c, out, 'business_phone', { business_phone: ph.e164 }, bizFields);
    },
    carrier(env, c, out, text, low) {
      const k = CARRIERS.find(x => x[2].test(low));
      if (!k) return clarify(env, c, out, 'carrier', 'I don’t know that one. Pick one below, or choose “Other / not sure”.');
      setCarrier(env, c, out, k[0]);
    },
    test_call(env, c, out, text, low) {
      const ph = phonesIn(text)[0];
      if (ph && /business|line|number/.test(low)) { c.state.bizAsk = true; return showCard(env, c, out, 'business_phone', { business_phone: ph.e164 }, bizFields); }
      const k = CARRIERS.find(x => x[0] !== 'other' && x[2].test(low));
      if (k) return setCarrier(env, c, out, k[0]);
      const q = testQuestion(env, c);
      say(env, c, out, testState(env) === 'no_number' ? q.text : 'When you’ve turned on forwarding, press Test call. I’ll watch for the call.', q.blocks.filter(b => b.action === 'test_call'));
    },
    default(env, c, out) { ask(env, c, out, ''); }
  };
  function phonesIn(text) {
    const out = [], rx = /(\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g; let m;
    while ((m = rx.exec(text))) {
      const e = toE164(m[0]); if (!e) continue;
      const before = String(text).slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      out.push({ e164: e, oncall: /on-?\s?call|emergenc|urgent/.test(before) });
    }
    return out;
  }

  root.StartMockSetup = { turn, _parse: { parseHours, correctHours, parsePricesText, parseFaq, splitList } };
})(typeof window !== 'undefined' ? window : globalThis);
