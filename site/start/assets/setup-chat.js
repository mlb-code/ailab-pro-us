/* /start/ Setup tab, FirstRing monthly plans: the setup assistant (design: docs/setup-agent-design-2026-11-27.md, sections 2.3 + 6).
   The customer sets up the account by chatting; the checklist stays one tap away as "Edit manually" and is the fallback
   whenever the assistant can't answer. Shown only for plan clients while brand.json setup_agent.enabled is true (absent = off);
   portal-b.js asks PortalSetupChat.on(d) and otherwise renders the checklist exactly as before.
   Data: Backend.setupChat(input, clientTurnId) = Edge Function setup-agent (contract v1; the mock answers from
   mock/setup-script.js). The server owns the conversation, the cards and every saved setting. This file only renders the typed
   blocks (summary_card, choices, action, open_form, notice) and runs the real actions through the checklist's own code paths
   (Backend.calendarConnectUrl, updateOnboarding for the carrier, startForwardingTest, confirmForwardingTest), then reports back
   with an event. Server text is never inserted as HTML: every string from the server is a text node. */
(function () {
  const S = window.Start, B = window.Backend;
  const P = () => window.PortalB;
  const esc = s => S.esc(s);
  const VIEW_KEY = 'start_setup_view', SNAP_KEY = 'start_setup_snap', PEND_KEY = 'start_setup_pending';
  const STALE_MS = 60000, SOFT_MS = 30000, HARD_MS = 95000, MAX = 1000;
  // conversation topic -> checklist item (progress.topic, design section 2.5)
  const TOPIC_ITEM = { services: 'faq', area: 'faq', prices: 'faq', re_leads: 'faq', re_screening: 'faq', faq: 'faq', hours: 'hours', after_hours: 'hours',
    alerts: 'alerts', on_call: 'alerts', emergency: 'alerts', calendar: 'calendar', tools: 'tools', business_phone: 'forward_calls', carrier: 'forward_calls',
    test_call: 'forward_calls', forwarding: 'forward_calls' };
  const mock = () => B.mode === 'mock';
  const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });

  // one conversation per client, kept while the page lives (a re-render of the tab does not lose it)
  let st = fresh(null);
  function fresh(cid) {
    return { cid, msgs: [], local: [], progress: null, composer: null, fallback: null, status: null, limits: null, at: 0,
      busy: false, turn: null, failed: null, failures: 0, forced: null, disabled: false, limitedUntil: 0, banner: null, d: null, api: null,
      testPoll: null, livePoll: null, lastFocus: null };
  }

  // ------------------------------------------------------------ switches
  // brand.json setup_agent.enabled (absent or anything but true = off). Demo mode only: /start/?mock=1&mock_setup_agent=1.
  const flagOn = () => !!(S.BRAND && S.BRAND.setup_agent && S.BRAND.setup_agent.enabled === true) ||
    (mock() && S.ss.get('start_mock_setup_agent') === '1');
  const on = d => !!(d && d.client && P() && P().isPlan(d) && flagOn() && !st.disabled);
  const view = () => st.forced ? 'manual' : S.ss.get(VIEW_KEY) === 'manual' ? 'manual' : 'chat';
  const snapOf = d => JSON.stringify((d.ob || []).map(o => [o.key, o.status, o.updated_at || '', JSON.stringify(o.data || {}).length]));

  // ------------------------------------------------------------ the tab
  function html(d) {
    if (st.cid !== d.client.id) st = fresh(d.client.id);
    st.d = d;
    if (st.disabled) return P().onboardingHtml(d);   // the server switched the assistant off: today's checklist, as is
    const v = view();
    return P().messageModeHtml(d) + headHtml(d, v) + (v === 'manual' ? manualHtml(d) : chatHtml(d));
  }
  function counts(d) {
    const pr = P().obProgress(d), sp = st.progress;
    return sp && typeof sp.done === 'number' && typeof sp.total === 'number' && view() === 'chat' ? { done: sp.done, total: sp.total } : { done: pr.done, total: pr.total };
  }
  function headHtml(d, v) {
    const c = counts(d), pct = c.total ? Math.round(c.done / c.total * 100) : 0;
    const seg = st.disabled ? '' : '<div class="seg" role="group" aria-label="How you set up">' +
      '<button type="button" class="seg__b" data-saview="chat" aria-pressed="' + (v === 'chat') + '">Chat</button>' +
      '<button type="button" class="seg__b" data-saview="manual" aria-pressed="' + (v === 'manual') + '">Edit manually</button></div>';
    return '<section class="card obhead sahead" id="saHead" aria-labelledby="saH"><div class="sahead__top"><h2 class="h-card" id="saH">Set up your receptionist</h2>' + seg + '</div>' +
      '<p id="obCount">' + c.done + ' of ' + c.total + ' steps done.' + (v === 'manual' ? ' Each step saves as you go.' + (st.disabled ? '' : ' Prefer to chat? <button type="button" class="linkbtn" data-saview="chat">Switch to the setup assistant.</button>') : '') + '</p>' +
      '<div class="bar" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="' + c.total + '" aria-valuenow="' + c.done + '"><i style="width:' + pct + '%"></i></div>' +
      P().autoGoLiveHtml(d) + (v === 'manual' && st.forced && st.forced.text ? forcedHtml() : '') + '</section>';
  }
  function forcedHtml() {
    return '<div class="notice notice--info sa-forced" role="status"><div><p>' + esc(st.forced.text) + '</p>' +
      (st.forced.retry ? '<div class="btn-row"><button type="button" class="btn btn--ghost btn--sm" id="saRetryChat">Try the chat again</button></div>' : '') + '</div></div>';
  }
  function manualHtml(d) { return P().stepsHtml(d, true); }
  function chatHtml(d) {
    const name = ((((S.PB || {}).rules || {}).subscription || {}).product) || '';
    return doneHtml(d) + '<section class="setupchat" id="saChat" aria-labelledby="saChatH"><h3 class="sr-only" id="saChatH">Chat with the ' + esc(name ? name + ' ' : '') + 'setup assistant</h3>' +
      '<p class="sa-disc" id="saDisc"><span class="sa-ai" aria-hidden="true">AI</span><span>You’re chatting with our AI setup assistant. What you type is processed by our AI provider (Anthropic) to set up your account. Please don’t share passwords or card numbers. <a href="/legal/privacy/">Privacy Policy</a></span></p>' +
      '<ol class="chatlog" id="saLog" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation with the setup assistant" aria-busy="true">' +
      '<li class="sa-skel" aria-hidden="true"><span></span><span></span></li><li class="sa-skel sa-skel--s" aria-hidden="true"><span></span></li></ol>' +
      '<div class="composer" id="saComposer"><div id="saBanner"></div><div class="sa-chips sa-quick" id="saQuick" role="group" aria-label="Quick replies" hidden></div>' +
      '<form class="composer__f" id="saForm" novalidate><label class="sr-only" for="saText">Your answer</label>' +
      '<textarea class="textarea composer__t" id="saText" rows="1" maxlength="1000" enterkeyhint="send" autocomplete="off" autocapitalize="sentences" placeholder="Type your answer" aria-describedby="saHint"></textarea>' +
      '<button type="submit" class="btn btn--primary composer__send" id="saSend"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span class="sr-only">Send</span></button></form>' +
      '<div class="composer__row"><span class="muted small" id="saHint"></span><button type="button" class="linkbtn composer__manual" id="saManual">Edit manually</button></div></div>' +
      '<div class="sa-kbpad" aria-hidden="true"></div></section>';   // as tall as the on-screen keyboard: the last message can scroll above it
  }
  // finished: every step with an Edit button (it asks the assistant to change that step) and what happens next
  function doneHtml(d) {
    const p = st.progress;
    if (st.status !== 'complete' || !p || !Array.isArray(p.steps)) return '';
    const live = p.go_live === 'live';
    const next = live ? 'Calls forwarded from your business line are answered. Want to change something? Tell the assistant below, or use Edit manually.'
      : p.go_live === 'delayed' ? 'Our final checks found something to fix. We’re looking at it and will email you shortly.'
        : 'We’re running automatic test calls against your settings now. You’ll be live within minutes and get an email.';
    return '<section class="card sa-done" id="saDone" aria-labelledby="saDoneH"><h3 class="h-sub" id="saDoneH">' + (live ? 'You’re live' : 'You’re all set') + '</h3><p>' + esc(next) + '</p>' +
      '<ul class="sa-steps">' + p.steps.map(s => '<li><span class="sa-steps__t">' + esc(s.title || s.key) + (s.required === false ? ' <span class="muted small">(optional)</span>' : '') + '</span>' +
        '<span class="pill pill--' + (s.status === 'done' ? 'done' : 'todo') + '">' + (s.status === 'done' ? 'Done' : s.required === false ? 'Skipped' : 'To do') + '</span>' +
        '<button type="button" class="linkbtn" data-saedit="' + esc(s.title || s.key) + '" aria-label="Change ' + esc(s.title || s.key) + '">Edit</button></li>').join('') + '</ul></section>';
  }

  // ------------------------------------------------------------ binding (called by portal-b.js after the panel is drawn)
  function bind(d, api) {
    st.d = d; st.api = api;
    if (st.disabled) { P().bindOnboarding(d, api); return; }
    S.$$('[data-saview]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.saview, null, b.dataset.saview === 'chat' ? '#saText' : '[data-saview="manual"]')));
    const rc = S.$('#saRetryChat');
    if (rc) rc.addEventListener('click', () => switchView('chat', null, '#saText'));
    if (view() === 'manual') { P().bindOnboarding(d, api); return; }
    P().bindPlanActions(d, api, 'onboarding');
    mount(d);
  }
  function rerender(focusSel) {
    const panel = S.$('#panel'); if (!panel || !st.d) return;
    panel.innerHTML = html(st.d);
    bind(st.d, st.api);
    const el = focusSel && S.$(focusSel);
    if (el) el.focus({ preventScroll: false });
  }
  function switchView(v, itemKey, focusSel) {
    if (v === 'manual') {
      S.ss.set(SNAP_KEY, snapOf(st.d));
      if (!st.forced) S.ss.set(VIEW_KEY, 'manual');
      if (itemKey) P().setOpen(itemKey);
      rerender(itemKey ? '#ob-' + itemKey + ' > summary' : focusSel);
      if (itemKey) { const det = S.$('#ob-' + itemKey); if (det) det.scrollIntoView({ block: 'start' }); }
      return;
    }
    const before = S.ss.get(SNAP_KEY);
    S.ss.del(VIEW_KEY); S.ss.del(SNAP_KEY);
    // back from a form the assistant sent the customer to: ask the server again (fresh state, no stale "unavailable")
    if (st.forced) { st.forced = null; st.failures = 0; st.at = 0; st.status = null; st.composer = null; st.fallback = null; st.banner = null; st.limitedUntil = 0; }
    st.formsSaved = !!(before && before !== snapOf(st.d));
    rerender(focusSel);
  }
  // the form for this step (fallback, "Edit this in the form", "Edit manually")
  function openForm(itemKey, forced) {
    if (forced) st.forced = forced;
    switchView('manual', itemKey || currentItem());
  }
  function currentItem() {
    const fb = st.fallback && st.fallback.item_key;
    if (fb) return fb;
    const t = st.progress && typeof st.progress.topic === 'string' ? st.progress.topic : '';
    const tp = TOPIC_ITEM[t] || t.split('.')[0];
    if (tp && ((st.d && st.d.ob) || []).some(o => o.key === tp)) return tp;
    const ob = (st.d && P().obProgress(st.d).items) || [];
    return (ob.find(o => o.status !== 'done') || {}).key || null;
  }

  function mount(d) {
    const log = S.$('#saLog'); if (!log) return;
    wireComposer(); watchViewport(); watchOnline();
    const doneEdit = S.$$('[data-saedit]');
    doneEdit.forEach(b => b.addEventListener('click', () => send({ type: 'message', text: 'I want to change my ' + b.dataset.saedit.toLowerCase() + '.' }, { label: 'Change ' + b.dataset.saedit.toLowerCase() })));
    // back from the calendar's OAuth page (a fresh page load) or from the forms: the thread first, then the event
    const cal = P().takeCalendarReturn(), ev = cal ? 'calendar_returned' : st.formsSaved ? 'forms_saved' : null;
    st.formsSaved = false;
    if (st.msgs.length) renderAll();
    const stale = !st.msgs.length || Date.now() - st.at > STALE_MS;
    (async () => {
      if (stale) await send({ type: 'resume' }, { silent: true, first: !st.msgs.length });
      if (!S.$('#saLog') || st.forced) return;
      if (cal && cal.kind !== 'ok') { st.local.push({ id: 'local-' + uuid(), role: 'note', text: cal.text, kind: cal.kind, local: true }); renderAll(); }
      if (ev) send({ type: 'event', event: ev }, { silent: true });
      else if (!stale) afterRender([]);
    })();
  }

  // ------------------------------------------------------------ one turn
  async function send(input, opts) {
    opts = opts || {};
    if (st.busy || st.applying) return;
    if (navigator.onLine === false) { renderComposer(); return; }
    if (st.limitedUntil > Date.now() && input.type !== 'resume' && input.type !== 'event') { renderComposer(); return; }
    const turn = opts.retry || { id: uuid(), input, label: opts.label || (input.type === 'message' ? input.text : null) };
    st.turn = turn; st.busy = true; st.banner = null;
    if (!opts.retry && turn.label && input.type !== 'resume' && input.type !== 'event') st.local.push({ id: 'opt-' + turn.id, role: 'user', text: turn.label, local: true, turnId: turn.id });
    if (st.failed && st.failed.id === turn.id) st.failed = null;
    if (input.type !== 'resume' && input.type !== 'event') { try { sessionStorage.setItem(PEND_KEY, JSON.stringify({ id: turn.id, input })); } catch (e) { /* storage blocked */ } }
    renderAll(); typing(true); renderComposer();
    const soft = setTimeout(() => typing(true, true), SOFT_MS);
    let res = null, err = null;
    try {
      res = await Promise.race([B.setupChat(input, turn.id), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), HARD_MS))]);
      if (!res || res.v !== 1 || !Array.isArray(res.messages)) throw Object.assign(new Error('bad_response'), { code: 'bad_response' });
    } catch (e) { err = e; }
    clearTimeout(soft);
    st.busy = false; typing(false);
    if (err) { onError(err, turn, opts); return; }
    await apply(res, turn, opts);
  }

  async function apply(res, turn, opts) {
    const input = turn.input, prevDone = st.progress ? st.progress.done : null, prevLive = st.progress ? st.progress.go_live : null;
    const known = {}, seqs = {};
    st.msgs.forEach(m => { known[m.id] = 1; if (m.seq) seqs[m.seq] = 1; });
    const hadPending = cards().some(c => c.status === 'pending');
    const added = [];
    if (input.type === 'resume') { st.msgs = res.messages.slice(); st.local = st.local.filter(m => m.role === 'note' && m.keep); }
    else {
      st.local = st.local.filter(m => m.turnId !== turn.id || !res.messages.some(x => x.role === 'user'));
      res.messages.forEach(m => {   // new ones are added; one seen before (a retried message) takes the server's latest copy
        const i = st.msgs.findIndex(x => x.id === m.id || (m.seq && x.seq === m.seq));
        if (i === -1) { st.msgs.push(m); added.push(m); } else st.msgs[i] = m;
      });
    }
    st.msgs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    if (input.type === 'resume') st.msgs.forEach(m => added.push(m));
    // card statuses changed by this turn, read off the turn (a resume brings every card's live status)
    const ups = [];
    if (input.type === 'confirm' && res.status !== 'unavailable') {
      const err = added.some(m => (m.blocks || []).some(b => b.type === 'notice' && b.kind === 'err'));
      ups.push({ proposal_id: input.proposal_id, status: err ? 'failed' : 'confirmed' });
    }
    added.forEach(m => (m.blocks || []).forEach(b => {
      if (b.type !== 'summary_card' || b.status !== 'pending') return;
      cards().forEach(c => { if (c.topic === b.topic && c.proposal_id !== b.proposal_id && c.status === 'pending') ups.push({ proposal_id: c.proposal_id, status: 'superseded' }); });
    }));
    ups.forEach(u => cards().forEach(c => { if (c.proposal_id === u.proposal_id && ['pending', 'confirmed', 'superseded', 'failed'].indexOf(u.status) !== -1) c.status = u.status; }));
    st.status = res.status; st.progress = res.progress || st.progress; st.composer = res.composer || null; st.limits = res.limits || null; st.fallback = res.fallback || null; st.at = Date.now();
    if (res.status === 'unavailable' && res.fallback) { fallback(res.fallback, turn, opts); return; }
    st.failures = 0; st.failed = null; st.limitedUntil = 0;
    if (turn.input.type !== 'resume' && turn.input.type !== 'event') { try { sessionStorage.removeItem(PEND_KEY); } catch (e) { /* storage blocked */ } }
    const p = st.progress || {};
    const changed = prevDone !== null && (p.done !== prevDone || p.go_live !== prevLive);
    if (!S.$('#saLog')) return;
    renderAll();
    afterRender(added, opts);
    // a typed answer can confirm or replace a card on the server ("yes", a correction): read the cards' live statuses again
    if (input.type === 'message' && hadPending && !opts.refresh) setTimeout(() => { if (S.$('#saLog') && !st.busy) send({ type: 'resume' }, { silent: true, refresh: true }); }, 0);
    if (!changed && !(input.type === 'event' && input.event !== 'back_online')) { refreshHead(); return; }
    // a step was saved or go-live moved: the header counts, the go-live line and the tabs come from fresh data
    const d = st.d, was = d.client && d.client.status, log = S.$('#saLog');
    st.applying = true; log.dataset.sync = '1';
    try { const c = await B.getClient(); if (c) d.client = c; await P().load(d); } catch (e) { /* the header keeps the old counts */ }
    st.applying = false; delete log.dataset.sync;
    if (d.client && d.client.status !== was && st.api) { await st.api.refresh('onboarding'); return; }
    if (S.$('#saLog')) { refreshHead(); renderComposer(); }
  }

  // the server says no assistant for this account (kill switch, not a plan client): the checklist exactly as without the flag
  function checklistOnly(itemKey) {
    st.disabled = true; S.ss.del(VIEW_KEY);
    if (itemKey) P().setOpen(itemKey);
    const tb = S.$('#tab-onboarding'); if (tb && st.d && st.d.client) tb.textContent = st.d.client.status === 'live' ? 'Setup' : 'Setup checklist';
    rerender();
  }
  function fallback(fb, turn, opts) {
    const reason = fb.reason;
    if (reason === 'assistant_unavailable') {
      st.failures++;
      if (turn.input.type !== 'resume' && turn.input.type !== 'event') st.failed = turn;
      if (st.failures >= 2) { openForm(fb.item_key, { reason, text: 'The setup assistant can’t answer right now. Your answers so far are saved; you can finish this step here.', retry: true }); return; }
      st.banner = { kind: 'err', text: 'Sorry, I didn’t get that through.', retry: !!st.failed, form: fb.item_key || true };
    } else if (reason === 'disabled') {
      checklistOnly(fb.item_key || currentItem()); return;
    } else if (reason === 'budget' || reason === 'limit') {
      st.local = st.local.filter(m => m.turnId !== turn.id);
      if (turn.input.type === 'message') { const ta = S.$('#saText'); if (ta && !ta.value) ta.value = turn.input.text || ''; }
      st.banner = { kind: 'info', text: reason === 'budget' ? 'The setup assistant is taking a break. Your answers are saved; finish in the form. The buttons above still work.'
        : 'You’ve sent a lot of messages; the form is right here. Your answers are saved, and the buttons above still work.', form: fb.item_key || true };
    } else st.banner = { kind: 'err', text: 'The setup assistant can’t answer right now.', form: fb.item_key || true };
    if (!S.$('#saLog')) return;
    refreshHead(); renderAll(); afterRender([], opts);
  }

  function onError(e, turn, opts) {
    const code = String((e && (e.code || e.message)) || '');
    const first = turn.input.type === 'resume' && !st.msgs.length;
    if (/turn_in_progress/.test(code) && !opts.waited) {   // another tab or device is mid-turn: wait, then read what it got
      setTimeout(() => { if (S.$('#saLog')) send({ type: 'resume' }, { silent: true, waited: true }); }, 2500);
      st.local = st.local.filter(m => m.turnId !== turn.id); renderAll(); return;
    }
    if (/not_a_plan_client/.test(code)) { checklistOnly(null); return; }
    if (/rate_limited/.test(code)) {
      st.failed = turn.input.type === 'message' ? turn : null;
      st.limitedUntil = Date.now() + ((e.retry_after_s || 60) * 1000);
      st.banner = { kind: 'info', text: 'You’ve sent a lot of messages; the form is right here.', form: true };
      renderAll(); renderComposer(); setTimeout(() => { if (S.$('#saLog')) renderComposer(); }, (e.retry_after_s || 60) * 1000 + 50); return;
    }
    if (/not_signed_in|not_authenticated|401/.test(code)) { st.banner = { kind: 'err', text: 'Your session ended. Please reload the page and sign in again.' }; renderAll(); renderComposer(); return; }
    if (/bad_input|payload_too_large|413/.test(code)) {
      st.local = st.local.filter(m => m.turnId !== turn.id);
      const ta = S.$('#saText'); if (ta && turn.input.text && !ta.value) ta.value = turn.input.text;
      st.banner = { kind: 'err', text: 'That message is too long. Please keep it under 1,000 characters.' }; renderAll(); renderComposer(); return;
    }
    if (first) { openForm(null, { reason: 'unreachable', text: 'The setup assistant isn’t available right now. You can set everything up here; your answers are saved as you go.', retry: true }); return; }
    if (turn.input.type === 'resume' || turn.input.type === 'event') { st.banner = { kind: 'err', text: navigator.onLine === false ? 'You’re offline. Your answers are saved.' : 'Can’t reach the setup assistant. Check your connection.', resume: true }; renderAll(); renderComposer(); return; }
    st.failures++;
    st.failed = turn;
    if (st.failures >= 2) { openForm(null, { reason: 'error', text: 'The setup assistant can’t answer right now. Your answers so far are saved; you can finish this step here.', retry: true }); return; }
    st.banner = { kind: 'err', text: 'Sorry, I didn’t get that through.', retry: true, form: true };
    renderAll(); renderComposer();
  }

  // ------------------------------------------------------------ rendering (DOM nodes; server strings are text only)
  const cards = () => { const out = []; st.msgs.forEach(m => (m.blocks || []).forEach(b => { if (b && b.type === 'summary_card') out.push(b); })); return out; };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function lastAssistantIdx(list) { for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant') return i; return -1; }
  function renderAll() {
    const log = S.$('#saLog'); if (!log) return;
    const list = st.msgs.concat(st.local.filter(m => !m.turnId)).concat(st.local.filter(m => m.turnId));
    const la = lastAssistantIdx(list);
    const liveIdx = la !== -1 && !list.slice(la + 1).some(m => m.role === 'user') ? la : -1;
    let lastUser = -1; for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') { lastUser = i; break; }
    const unanswered = lastUser !== -1 && !st.busy && (list[lastUser].unanswered || (lastUser > la && (list[lastUser].local || st.failed))) ? lastUser : -1;
    // nodes already on screen stay (the log announces additions only); their state is updated in place
    const have = {};
    S.$$('#saLog > li[data-key]').forEach(li => { have[li.dataset.key] = li; });
    const want = [];
    list.forEach((m, i) => {
      const live = i === liveIdx;
      let li = have[m.id];
      if (li && live && li.dataset.stripped) { const nu = msgEl(m); li.replaceWith(nu); li = nu; }   // live again (rare): drawn anew
      else if (!li) li = msgEl(m);
      delete have[m.id];
      syncMsg(li, m, live, i === unanswered);
      want.push(li);
    });
    Object.keys(have).forEach(k => have[k].remove());
    S.$$('#saLog > .sa-skel').forEach(x => x.remove());
    let prev = null;
    want.forEach(li => { const at = prev ? prev.nextSibling : log.firstChild; if (at !== li) log.insertBefore(li, at); prev = li; });
    const ty = S.$('#saTyping'); if (ty) log.appendChild(ty);
    log.setAttribute('aria-busy', st.busy && !st.msgs.length ? 'true' : 'false');
    renderBanner(); renderQuick(); renderComposer(); bindLive(); bindHelpBox();
  }
  function syncMsg(li, m, live, failed) {
    if (!live && li.querySelector('.sa-live')) { li.querySelectorAll('.sa-live').forEach(x => x.remove()); li.dataset.stripped = '1'; }
    li.querySelectorAll('section.scard').forEach(sec => {
      const b = cards().find(c => c.proposal_id === sec.dataset.proposal);
      if (b && sec.dataset.status !== b.status) cardStatus(sec, b);
    });
    if (m.role === 'user') {
      const f = li.querySelector('.sa-fail');
      if (failed && !f) {
        const r = el('div', 'sa-fail'); r.appendChild(el('span', 'small', 'Not sent.'));
        if (!(st.banner && st.banner.retry)) {   // the banner below already has "Try again"
          const t = el('button', 'linkbtn sa-retry', 'Try again'); t.type = 'button'; t.dataset.saretry = (st.failed && st.failed.id) || m.client_turn_id || m.turnId || m.id;
          r.appendChild(t);
        }
        li.appendChild(r);
      } else if (!failed && f) f.remove();
    }
  }
  function msgEl(m) {
    const li = el('li', 'sa-m sa-m--' + (m.role === 'user' ? 'out' : m.role === 'note' ? 'note' : 'in'));
    li.dataset.key = m.id;
    if (m.role === 'user') {
      const b = el('div', 'bubble bubble--out'); b.appendChild(el('span', 'sr-only', 'You: ')); b.appendChild(document.createTextNode(m.text || ''));
      li.appendChild(b); return li;
    }
    if (m.role === 'note') {
      const n = el('p', 'sa-note' + (m.kind ? ' sa-note--' + m.kind : '')); n.appendChild(el('span', 'sr-only', 'Note: ')); n.appendChild(document.createTextNode(m.text || ''));
      li.appendChild(n); return li;
    }
    if (m.text) { const b = el('div', 'bubble bubble--in'); b.appendChild(el('span', 'sr-only', 'Setup assistant: ')); b.appendChild(document.createTextNode(m.text)); li.appendChild(b); }
    (m.blocks || []).forEach(bl => { const x = blockEl(bl, true, m); if (x) li.appendChild(x); });
    return li;
  }
  function blockEl(b, live, m) {
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'summary_card') return cardEl(b);
    if (b.type === 'choices') {
      if (!Array.isArray(b.options) || !b.options.length) return null;
      const g = el('div', 'sa-chips sa-live'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Choose one');
      b.options.forEach(o => { const x = el('button', 'chip', o.label); x.type = 'button'; x.dataset.choice = o.id; g.appendChild(x); });
      return g;
    }
    if (b.type === 'notice') { const n = el('div', 'notice notice--' + (['ok', 'err', 'info'].indexOf(b.kind) !== -1 ? b.kind : 'info') + ' sa-notice'); n.appendChild(el('span', null, b.text || '')); return n; }
    if (b.type === 'open_form') { const x = el('button', 'btn btn--ghost btn--sm sa-openform', b.label || 'Edit this in the form'); x.type = 'button'; x.dataset.openform = b.item_key || ''; return x; }
    if (b.type === 'action') return actionEl(b, live, !!(m && m.text));
    return null;   // a block type this page doesn't know yet: skipped (a newer server keeps working with an older page)
  }
  const STATUS = { pending: ['todo', 'Check this'], confirmed: ['done', 'Saved'], superseded: ['todo', 'Replaced'], failed: ['need_help', 'Not saved'] };
  function cardEl(b) {
    const id = 'sc-' + String(b.proposal_id || uuid()).replace(/[^A-Za-z0-9_-]/g, '');
    const s = el('section', 'scard scard--' + (STATUS[b.status] ? b.status : 'pending')); s.setAttribute('aria-labelledby', id + '-h'); s.dataset.proposal = b.proposal_id || ''; s.dataset.status = b.status || 'pending';
    const h = el('div', 'scard__h'); const t = el('h4', 'scard__t', b.title || 'Here’s what I understood'); t.id = id + '-h'; h.appendChild(t);
    const stt = STATUS[b.status] || STATUS.pending; h.appendChild(el('span', 'pill scard__p pill--' + stt[0], stt[1])); s.appendChild(h);
    const dl = el('dl', 'scard__f');
    (Array.isArray(b.fields) ? b.fields : []).forEach(f => { const wrap = el('div'); wrap.appendChild(el('dt', null, f.label || '')); const dd = el('dd'); fieldValue(dd, f); wrap.appendChild(dd); dl.appendChild(wrap); });
    s.appendChild(dl);
    if (b.note) s.appendChild(el('p', 'scard__n muted small', b.note));
    if (b.status === 'superseded') s.appendChild(el('p', 'muted small scard__r', 'Replaced by the newer version below.'));
    if (b.status === 'pending') {
      const row = el('div', 'btn-row scard__a');
      const acts = Array.isArray(b.actions) && b.actions.length ? b.actions : [{ id: 'confirm', label: 'Looks right' }, { id: 'change', label: 'Change something' }];
      acts.forEach(a => {
        if (a.id !== 'confirm' && a.id !== 'change') return;
        const x = el('button', 'btn btn--sm ' + (a.id === 'confirm' ? 'btn--primary' : 'btn--ghost'), a.label || (a.id === 'confirm' ? 'Looks right' : 'Change something'));
        x.type = 'button'; x.dataset.card = a.id; x.dataset.proposal = b.proposal_id || ''; row.appendChild(x);
      });
      s.appendChild(row);
    }
    return s;
  }
  // a card whose status changed (saved, replaced by a correction, refused by the server): updated in place, nothing re-announced
  function cardStatus(sec, b) {
    const stt = STATUS[b.status] || STATUS.pending;
    sec.dataset.status = b.status; sec.className = 'scard scard--' + (STATUS[b.status] ? b.status : 'pending');
    const p = sec.querySelector('.scard__p'); if (p) { p.className = 'pill scard__p pill--' + stt[0]; p.textContent = stt[1]; }
    if (b.status !== 'pending') { const a = sec.querySelector('.scard__a'); if (a) a.remove(); }
    if (b.status === 'superseded' && !sec.querySelector('.scard__r')) sec.appendChild(el('p', 'muted small scard__r', 'Replaced by the newer version below.'));
  }
  // a field value by kind; anything else shows the server's ready-made `text`
  const DAY = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  const t12 = v => { const m = /^(\d{2}):(\d{2})$/.exec(v || ''); if (!m) return v || ''; let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + m[2] + ' ' + ap; };
  function hoursLines(v) {
    const out = []; let i = 0;
    while (i < DAY.length) {
      const cur = Array.isArray(v[DAY[i][0]]) ? v[DAY[i][0]].join('-') : 'closed';
      let j = i; while (j + 1 < DAY.length && (Array.isArray(v[DAY[j + 1][0]]) ? v[DAY[j + 1][0]].join('-') : 'closed') === cur) j++;
      const days = i === j ? DAY[i][1] : DAY[i][1] + '–' + DAY[j][1];
      out.push(days + ' ' + (cur === 'closed' ? 'Closed' : t12(v[DAY[i][0]][0]) + '–' + t12(v[DAY[i][0]][1])));
      i = j + 1;
    }
    return out;
  }
  function fieldValue(dd, f) {
    const v = f.value;
    const list = (arr, cls) => { const u = el('ul', cls || 'sa-list'); arr.forEach(x => u.appendChild(el('li', null, x))); dd.appendChild(u); };
    try {
      if (f.kind === 'hours' && v && typeof v === 'object' && !Array.isArray(v)) return list(hoursLines(v));
      if (f.kind === 'list' && Array.isArray(v)) return v.length ? list(v.map(String)) : dd.appendChild(el('span', 'muted', 'None'));
      if (f.kind === 'time' && typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) return dd.appendChild(el('span', null, t12(v)));
      if (f.kind === 'url' && typeof v === 'string') return dd.appendChild(el('span', 'mono', v));
      if (f.kind === 'phone') return dd.appendChild(el('span', 'mono', v ? P().fmtPhone(String(v)) : 'None'));
      if (f.kind === 'prices' && Array.isArray(v)) return v.length ? list(v.map(x => (x.name || '') + ': $' + Number(x.price_usd || 0).toLocaleString('en-US') + (x.note ? ' (' + x.note + ')' : ''))) : dd.appendChild(el('span', 'muted', 'No prices'));
      if (f.kind === 'faq' && Array.isArray(v)) {
        const o = el('ol', 'sa-faq'); v.forEach(x => { const li = el('li'); li.appendChild(el('b', null, x.q || '')); li.appendChild(el('span', null, x.a || '')); o.appendChild(li); }); dd.appendChild(o); return null;
      }
    } catch (e) { /* unexpected value shape: the text below */ }
    dd.appendChild(el('span', null, f.text != null ? f.text : (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))));
    return null;
  }

  // inline real actions: the checklist's own Backend calls
  const fwdItem = () => ((st.d && st.d.ob) || []).find(o => o.key === 'forward_calls') || null;
  function actionEl(b, live, said) {
    const s = el('section', 'acard acard--' + String(b.action || '').replace(/[^a-z_]/g, ''));
    const hid = 'ac-' + uuid().slice(0, 8);
    s.setAttribute('aria-labelledby', hid);
    const head = t => { const h = el('h4', 'acard__t', t); h.id = hid; s.appendChild(h); };
    const d = st.d || {};
    if (b.action === 'connect_calendar') {
      const g = b.provider === 'google';
      head(g ? 'Connect Google Calendar' : 'Connect your Calendly account');
      s.appendChild(el('p', null, g ? 'You’ll sign in with Google and allow access to calendar events only. We never see your password.'
        : 'To book visits, your receptionist needs permission from your Calendly account. You’ll sign in with Calendly and allow it. We never see your password.'));
      const row = el('div', 'btn-row sa-live'); const x = el('button', 'btn btn--primary btn--sm', g ? 'Connect Google Calendar' : 'Connect Calendly account');
      x.type = 'button'; x.dataset.calconnect = g ? 'google' : 'calendly'; x.dataset.tenant = b.tenant_id || (d.tenant && d.tenant.id) || ''; row.appendChild(x); s.appendChild(row);
      s.appendChild(el('div', 'sa-amsg sa-live'));
      return s;
    }
    if (b.action === 'forwarding_instructions') {
      const label = P().carrierLabel(b.carrier) || 'your phone provider';
      head('Forwarding for ' + label);
      const num = b.forward_to || (d.tenant && d.tenant.twilio_number) || '';
      if (!num) {   // no receptionist number yet: the provider's steps come with it
        const x = el('div'); x.innerHTML = S.msgHtml('Your receptionist’s number is being set up (usually a few minutes). The forwarding steps for ' + label + ' show here as soon as it’s ready; we’ll also email you.', 'info');
        s.appendChild(x); return s;
      }
      { const p = el('p'); p.appendChild(document.createTextNode('Forward to your receptionist’s number: ')); p.appendChild(el('b', 'mono bignum', P().fmtPhone(num))); s.appendChild(p); }
      const how = el('div', 'sa-how'); how.innerHTML = P().carrierHow(b.carrier, num) || '<p>' + esc('Look for “conditional call forwarding” or “forward when busy / no answer” in your phone provider’s settings.') + '</p>';   // our own copy (CARRIERS), number escaped
      s.appendChild(how);
      {
        const f = el('div', 'field sa-live sa-car'); const id = 'sa_car';
        const lab = el('label', null, 'Different provider?'); lab.htmlFor = id; f.appendChild(lab);
        const sel = el('select', 'select'); sel.id = id; sel.innerHTML = '<option value="">Choose…</option>' + P().carrierOptions(b.carrier || ''); sel.dataset.num = num; f.appendChild(sel); s.appendChild(f);
        const it = fwdItem();
        if (it) { const h = el('div', 'sa-live sa-help'); h.innerHTML = P().helpBox(it); s.appendChild(h); }
      }
      return s;
    }
    if (b.action === 'test_call') return testEl(b, live, s, head, said);
    return null;
  }
  // said = the assistant's message already explains the state: the card then holds only the action (no repeated text)
  function testEl(b, live, s, head, said) {
    const d = st.d || {}, it = fwdItem() || { data: {}, status: 'todo' }, data = it.data || {};
    const num = b.number || (d.tenant && d.tenant.twilio_number) || '';
    head(b.state === 'passed' ? 'Test call: forwarding works' : 'Test call');
    const box = el('div', 'sa-test');
    const add = h => { const x = el('div'); x.innerHTML = h; box.appendChild(x); };   // S.msgHtml / forwardStateHtml escape their text
    const btn = (label, key, primary) => { const x = el('button', 'btn btn--sm ' + (primary ? 'btn--primary' : 'btn--ghost'), label); x.type = 'button'; x.dataset.test = key; x.dataset.item = b.item_id || it.id || ''; return x; };
    const row = el('div', 'btn-row sa-live');
    switch (b.state) {
      case 'no_number': add(S.msgHtml('Your receptionist’s number is being set up (usually a few minutes). The test call opens here when it’s ready; we’ll also email you. You can do the other steps first.', 'info')); break;
      case 'waiting':
        add('<p class="sa-wait"><span class="spin" aria-hidden="true"></span><span>Waiting for the call to reach <b class="mono">' + esc(P().fmtPhone(num)) + '</b>…' + (said ? '' : ' From another phone, call your business number and let it ring out.') + '</span></p>');
        if (mock()) row.appendChild(btn('Simulate the forwarded call (demo mode)', 'sim'));
        break;
      case 'unverified': case 'direct': case 'mismatch': {
        // the checklist's wording (forwardStateHtml) for the state the server reported
        const fake = Object.assign({}, it, { status: 'todo' }), at = data.test_unverified_at || new Date().toISOString();
        const h = b.state === 'mismatch' ? (data.test_mismatch_from ? P().forwardStateHtml(fake, Object.assign({}, data, { test_unverified_at: null }), d)
            : S.msgHtml('A call reached your receptionist, but not through your business number. Check your business number and test again.', 'err'))
          : P().forwardStateHtml(fake, Object.assign({}, data, { test_mismatch_from: null, test_unverified_at: at, test_direct: b.state === 'direct' }), d);
        if (said && b.state === 'unverified') { const c = btn('Yes, I called my business number', 'confirm', true); c.id = 'ob_fwdconfirm'; row.appendChild(c); break; }
        if (said) { row.appendChild(btn('Test again', 'start', true)); break; }
        const x = el('div', b.state === 'unverified' ? 'sa-live' : null); x.innerHTML = h; box.appendChild(x);
        if (b.state === 'unverified') { const c = x.querySelector('#ob_fwdconfirm'); if (c) { c.dataset.test = 'confirm'; c.dataset.item = c.dataset.item || b.item_id || it.id || ''; } }
        if (b.state !== 'unverified') row.appendChild(btn('Test again', 'start', true));
        break;
      }
      case 'passed': add(S.msgHtml(data.test_call_at ? 'Call received ' + P().when(data.test_call_at, d) + ' through your business line. Forwarding works.' : 'Forwarding works.', 'ok')); break;
      default:
        if (!said) box.appendChild(el('p', null, 'Press “Test call”. You then have 30 minutes: from another phone, call your business number (not the receptionist’s number), let it ring out, and say a few words to the receptionist.'));
        add('<p class="notice small" role="note">' + esc('Heads-up: once business texting is live (after US carrier registration), hanging up without speaking sends the phone you called from our “Sorry we missed your call” text-back message. That’s expected during a test. Until then, nothing is texted.') + '</p>');
        row.appendChild(btn('Test call', 'start', true));
    }
    s.appendChild(box);
    if (row.childNodes.length) s.appendChild(row);
    s.appendChild(el('div', 'sa-amsg sa-live'));
    return s;
  }

  function renderBanner() {
    const box = S.$('#saBanner'); if (!box) return;
    const off = navigator.onLine === false;
    const b = off ? { kind: 'info', text: 'You’re offline. Your answers are saved.' } : st.banner;
    box.innerHTML = '';
    if (!b) return;
    const n = el('div', 'notice notice--' + (b.kind || 'info') + ' sa-banner'); n.setAttribute('role', b.kind === 'err' ? 'alert' : 'status');
    const w = el('div'); w.appendChild(el('p', null, b.text)); n.appendChild(w);
    const row = el('div', 'btn-row');
    if (!off && b.retry && st.failed) { const x = el('button', 'btn btn--primary btn--sm', 'Try again'); x.type = 'button'; x.dataset.saretry = st.failed.id; row.appendChild(x); }
    if (!off && b.resume) { const x = el('button', 'btn btn--primary btn--sm', 'Try again'); x.type = 'button'; x.id = 'saResume'; row.appendChild(x); }
    if (b.form) { const x = el('button', 'btn btn--ghost btn--sm', 'Open the form for this step'); x.type = 'button'; x.dataset.openform = typeof b.form === 'string' ? b.form : ''; row.appendChild(x); }
    if (row.childNodes.length) w.appendChild(row);
    box.appendChild(n);
  }
  function renderQuick() {
    const q = S.$('#saQuick'); if (!q) return;
    const list = (st.composer && Array.isArray(st.composer.quick_replies) ? st.composer.quick_replies : []).filter(x => x && x.label && x.input);
    q.innerHTML = '';
    q.hidden = !list.length || st.busy || !!st.failed;
    list.forEach((x, i) => { const b = el('button', 'chip chip--ghost', x.label); b.type = 'button'; b.dataset.quick = i; q.appendChild(b); });
  }
  function renderComposer() {
    const ta = S.$('#saText'), sb = S.$('#saSend'), hint = S.$('#saHint'); if (!ta) return;
    const off = navigator.onLine === false, limited = st.limitedUntil > Date.now();
    const enabled = !(st.composer && st.composer.enabled === false) && !st.busy && !off && !limited && !(st.status === 'unavailable' && !st.failed && st.fallback && st.fallback.reason !== 'assistant_unavailable');
    ta.disabled = !enabled && !st.busy; ta.readOnly = st.busy; sb.disabled = !enabled;
    // the server's hint: in the box when it fits on one line, otherwise as the small line under it (a placeholder must not wrap)
    const h = String((st.composer && st.composer.hint) || '').trim(), fits = h && h.length <= 28;
    ta.placeholder = fits ? h : st.status === 'complete' ? 'Tell me what to change' : 'Type your answer';
    const left = st.limits && typeof st.limits.messages_left_today === 'number' ? st.limits.messages_left_today : null;
    const n = ta.value.length;
    hint.textContent = n > MAX - 100 ? (MAX - n) + ' characters left' : off ? 'You’re offline. Your answers are saved.' : limited ? 'You can send more messages soon. The form works any time.'
      : left !== null && left <= 10 ? left + ' message' + (left === 1 ? '' : 's') + ' left today.' : h && !fits && !st.busy ? h : '';
    renderBannerOnlyIfOffline(off);
  }
  let wasOff = null;
  function renderBannerOnlyIfOffline(off) { if (wasOff !== off) { wasOff = off; renderBanner(); } }
  function typing(onOff, slow) {
    const log = S.$('#saLog'); if (!log) return;
    let t = S.$('#saTyping');
    if (!onOff) { if (t) t.remove(); log.setAttribute('aria-busy', 'false'); return; }
    if (!t) { t = el('li', 'sa-m sa-m--in sa-typing'); t.id = 'saTyping'; log.appendChild(t); }
    t.innerHTML = '';
    const b = el('div', 'bubble bubble--in bubble--typing'); b.setAttribute('aria-hidden', 'true'); b.appendChild(el('i')); b.appendChild(el('i')); b.appendChild(el('i')); t.appendChild(b);
    t.appendChild(el('span', 'sa-typing__t small muted', slow ? 'Still working on it… This is taking longer than usual.' : 'Setup assistant is thinking…'));
    if (slow) { const x = el('button', 'linkbtn', 'Edit manually instead'); x.type = 'button'; x.dataset.openform = ''; t.appendChild(x); }
    scrollLast();
  }

  // ------------------------------------------------------------ events on the drawn nodes
  function bindLive() {
    const log = S.$('#saLog'); if (!log || log.dataset.bound) return;
    log.dataset.bound = '1';
    const comp = S.$('#saComposer');
    const onClick = async e => {
      const t = e.target.closest('button'); if (!t || t.disabled) return;
      if ((t.dataset.card || t.dataset.choice || t.dataset.quick != null || t.dataset.saretry) && (st.busy || navigator.onLine === false)) { renderComposer(); renderBanner(); return; }
      if (t.dataset.card) {
        const pid = t.dataset.proposal;
        S.$$('[data-card][data-proposal="' + pid + '"]').forEach(x => { x.disabled = true; });
        send({ type: t.dataset.card === 'confirm' ? 'confirm' : 'change', proposal_id: pid }, { label: t.textContent });
      } else if (t.dataset.choice) {
        t.parentNode.querySelectorAll('button').forEach(x => { x.disabled = true; });
        send({ type: 'choose', choice_id: t.dataset.choice }, { label: t.textContent });
      } else if (t.dataset.quick != null) {
        const q = ((st.composer || {}).quick_replies || [])[+t.dataset.quick];
        if (q) send(q.input, { label: q.label });
      } else if (t.dataset.saretry) retry(t.dataset.saretry);
      else if (t.id === 'saResume') send({ type: 'resume' }, { silent: true });
      else if (t.dataset.openform != null) openForm(t.dataset.openform || null);
      else if (t.dataset.calconnect) calConnect(t);
      else if (t.dataset.test) testAction(t);
    };
    log.addEventListener('click', onClick);
    if (comp) comp.addEventListener('click', onClick);
    log.addEventListener('change', async e => {
      const sel = e.target.closest('#sa_car'); if (!sel) return;
      const how = sel.closest('.acard').querySelector('.sa-how');
      if (how) how.innerHTML = P().carrierHow(sel.value, sel.dataset.num) || '';
      const h = sel.closest('.acard').querySelector('.acard__t'); if (h && sel.value) h.textContent = 'Forwarding for ' + P().carrierLabel(sel.value);
      const it = fwdItem();
      try { if (it) await B.updateOnboarding(it.id, null, { carrier: sel.value || null }); } catch (er) { /* the carrier choice is a convenience, as in the form */ }
    });
  }
  // "Need help with this step?" in the forwarding card: the checklist's own handler (portal-b.js bindHelp)
  function bindHelpBox() {
    if (!S.$('#saLog [data-help]:not([data-hb])')) return;
    P().bindHelp(st.d, async () => {
      try { await P().load(st.d); } catch (e) { /* the message below still shows */ }
      const h = S.$('#saLog .sa-help'); if (h) h.innerHTML = S.msgHtml('We got your message and will reply in writing ' + S.sla() + '.', 'info');
    });
    S.$$('#saLog [data-help]').forEach(b => { b.dataset.hb = '1'; });
  }
  function retry(id) {
    let t = st.failed && st.failed.id === id ? st.failed : null;
    if (!t) { try { const p = JSON.parse(sessionStorage.getItem(PEND_KEY) || 'null'); if (p && p.id === id) t = { id, input: p.input }; } catch (e) { /* storage blocked */ } }
    if (!t) {
      const m = st.msgs.find(x => x.client_turn_id === id || x.id === id);
      const ri = m && m.retry_input && typeof m.retry_input === 'object' && m.retry_input.type ? m.retry_input : null;
      if (m) t = { id: m.client_turn_id || uuid(), input: ri || { type: 'message', text: m.text || '' } };
    }
    if (!t) return;
    st.failed = t; send(t.input, { retry: t });
  }
  async function calConnect(t) {
    const msg = t.closest('.acard').querySelector('.sa-amsg');
    t.disabled = true;
    try { const r = await B.calendarConnectUrl(t.dataset.tenant || (st.d.tenant && st.d.tenant.id), t.dataset.calconnect); S.ss.del(VIEW_KEY); location.assign(r.url); }
    catch (e) {
      t.disabled = false;
      const g = t.dataset.calconnect === 'google';
      if (msg) msg.innerHTML = S.msgHtml(/not configured|503/.test(String(e && e.message)) ? (g ? 'Google Calendar connection isn’t available yet. You can choose Calendly or take messages only.' : 'Calendly connection isn’t available yet. Use Edit manually and “Need help” and we’ll connect it with you.') : P().settingsErr(e));
    }
  }
  async function testAction(t) {
    const msg = t.closest('.acard').querySelector('.sa-amsg'), id = t.dataset.item || (fwdItem() || {}).id;
    if (t.dataset.test === 'sim') { try { window.StartMock.admin.simulateCall(st.d.tenant.id); } catch (e) { /* demo only */ } return; }
    t.disabled = true;
    try {
      if (t.dataset.test === 'confirm') await B.confirmForwardingTest(id);
      else await B.startForwardingTest(id);
      send({ type: 'event', event: t.dataset.test === 'confirm' ? 'test_changed' : 'test_started' }, { silent: true, focus: true });
    } catch (e) { t.disabled = false; if (msg) msg.innerHTML = S.msgHtml(P().settingsErr(e)); }
  }

  // ------------------------------------------------------------ after a reply: polls, focus, scroll
  function afterRender(added, opts) {
    opts = opts || {};
    pollTest(); pollLive();
    if (opts.silent && opts.first) { scrollLast(true); return; }
    const newCtl = added && added.length ? (() => {
      const ids = added.map(m => m.id);
      const lis = S.$$('#saLog > li').filter(li => ids.indexOf(li.dataset.key) !== -1);
      for (const li of lis) { const b = li.querySelector('.scard__a button, .sa-chips button, .acard .sa-live button'); if (b) return b; }
      return null;
    })() : null;
    const wantFocus = !opts.silent || opts.focus;
    if (newCtl) { if (wantFocus) newCtl.focus({ preventScroll: true }); scrollLast(); return; }
    const ta = S.$('#saText');
    if (ta && wantFocus && !ta.disabled) ta.focus({ preventScroll: true });
    scrollLast();
  }
  // the newest message just above the composer (which sits on the keyboard when it is open); a tall card shows from its top
  function scrollLast(instant) {
    const items = S.$$('#saLog > li'); const last = items[items.length - 1], comp = S.$('#saComposer'); if (!last || !comp) return;
    const r = last.getBoundingClientRect(), top = comp.getBoundingClientRect().top - 8, head = 76;
    const dy = r.height > top - head ? r.top - head : r.bottom > top ? r.bottom - top : r.top < head ? r.top - head : 0;
    if (Math.abs(dy) > 1) window.scrollBy({ top: dy, behavior: instant || reduced() ? 'instant' : 'smooth' });
  }
  function latestBlock(type, pred) {
    for (let i = st.msgs.length - 1; i >= 0; i--) {
      const m = st.msgs[i]; if (m.role === 'user') return null;
      if (m.role !== 'assistant') continue;
      const b = (m.blocks || []).find(x => x && x.type === type && (!pred || pred(x)));
      if (b) return b;
      return null;
    }
    return null;
  }
  // the test call: the same item fields the checklist's pollTest watches, then `test_changed`
  function pollTest() {
    const b = latestBlock('action', x => x.action === 'test_call' && x.state === 'waiting');
    if (!b) { clearInterval(st.testPoll); st.testPoll = null; return; }
    if (st.testPoll) return;
    const it0 = fwdItem() || {}, key = o => [o.status, (o.data || {}).test_unverified_at || '', (o.data || {}).test_mismatch_at || '', (o.data || {}).test_call_at || ''].join('|');
    const base = key(it0), until = Date.now() + 30 * 60000;
    st.testPoll = setInterval(async () => {
      if (!S.$('#saLog') || Date.now() > until) { clearInterval(st.testPoll); st.testPoll = null; return; }
      if (st.busy) return;
      try {
        const ob = await B.listOnboarding(); const it = (ob || []).find(o => o.key === 'forward_calls');
        if (it && key(it) !== base) { clearInterval(st.testPoll); st.testPoll = null; st.d.ob = st.d.ob.map(o => o.id === it.id ? it : o); send({ type: 'event', event: 'test_changed' }, { silent: true }); }
      } catch (e) { /* keep polling */ }
    }, mock() ? 700 : 5000);
  }
  // automatic go-live: while the final checks run, watch the client status, then read the conversation again
  function pollLive() {
    const p = st.progress || {};
    if (p.go_live !== 'testing') { clearInterval(st.livePoll); st.livePoll = null; return; }
    if (st.livePoll) return;
    const was = st.d.client && st.d.client.status;
    st.livePoll = setInterval(async () => {
      if (!S.$('#saLog')) { clearInterval(st.livePoll); st.livePoll = null; return; }
      if (st.busy) return;
      try {
        const c = await B.getClient();
        if (c && c.status !== was) { clearInterval(st.livePoll); st.livePoll = null; st.d.client = c; st.at = 0; await st.api.refresh('onboarding'); }
      } catch (e) { /* keep polling */ }
    }, mock() ? 800 : 15000);
  }
  function refreshHead() {
    const h = S.$('#saHead'), d = st.d; if (!h || !d) return;
    const tmp = document.createElement('div'); tmp.innerHTML = headHtml(d, view());
    const nh = tmp.firstChild; h.replaceWith(nh);
    S.$$('#saHead [data-saview]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.saview, null, b.dataset.saview === 'chat' ? '#saText' : '[data-saview="manual"]')));
    const old = S.$('#saDone'), nd = doneHtml(d);
    if (old) { if (nd) { const t2 = document.createElement('div'); t2.innerHTML = nd; old.replaceWith(t2.firstChild); bindDone(); } else old.remove(); }
    else if (nd) { const c = S.$('#saChat'); if (c) { c.insertAdjacentHTML('beforebegin', nd); bindDone(); } }
  }
  function bindDone() {
    S.$$('#saDone [data-saedit]').forEach(b => b.addEventListener('click', () => send({ type: 'message', text: 'I want to change my ' + b.dataset.saedit.toLowerCase() + '.' }, { label: 'Change ' + b.dataset.saedit.toLowerCase() })));
  }

  // ------------------------------------------------------------ composer, keyboard, viewport, network
  function wireComposer() {
    const f = S.$('#saForm'), ta = S.$('#saText'), man = S.$('#saManual'); if (!f) return;
    const grow = () => { ta.style.height = 'auto'; const max = parseFloat(getComputedStyle(ta).lineHeight || '24') * 4 + 26; ta.style.height = Math.min(ta.scrollHeight + 2, max) + 'px'; };
    ta.addEventListener('input', () => { grow(); renderComposer(); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true })); } });
    ta.addEventListener('focus', () => { setTimeout(() => scrollLast(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sa-kb'), 10) > 0), 300); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const text = ta.value.trim(); if (!text || st.busy) return;
      if (navigator.onLine === false) { renderComposer(); return; }
      ta.value = ''; grow();
      send({ type: 'message', text: text.slice(0, 1000) });
    });
    if (man) man.addEventListener('click', () => openForm(null));
    if (ro) ro.disconnect();
    ro = window.ResizeObserver ? new ResizeObserver(() => { const c = S.$('#saComposer'); if (c) document.documentElement.style.setProperty('--sa-composer-h', c.offsetHeight + 'px'); }) : null;
    if (ro && S.$('#saComposer')) ro.observe(S.$('#saComposer'));
    renderComposer();
  }
  let vvBound = false, netBound = false, ro = null;
  // the on-screen keyboard: the composer sits on top of it (visualViewport), the newest message stays above the composer
  function watchViewport() {
    const vv = window.visualViewport; if (!vv || vvBound) return; vvBound = true;
    const upd = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--sa-kb', (kb > 40 ? kb : 0) + 'px');
      if (kb > 40 && document.activeElement && document.activeElement.id === 'saText') scrollLast(true);
    };
    vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd); upd();
  }
  function watchOnline() {
    if (netBound) return; netBound = true;
    window.addEventListener('offline', () => { if (S.$('#saLog')) { renderComposer(); renderBanner(); } });
    window.addEventListener('online', () => {
      if (!S.$('#saLog')) return;
      renderComposer(); renderBanner();
      if (!st.busy && st.msgs.length) send({ type: 'event', event: 'back_online' }, { silent: true });
    });
  }

  window.PortalSetupChat = { on, html, bind, _state: () => st };
})();
