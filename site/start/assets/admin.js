/* /start/admin/ — owner admin (English, LTR). Only profiles.is_admin: anyone else is sent back to /start/.
   RLS enforces it server-side (private.is_admin()); this page only hides the UI.
   Data: window.AdminBackend (admin-backend.js; mock or Supabase, same method names).
   Prices: /assets/pricing.mjs — the SAME module quote-send runs on the server (byte copy of supabase/functions/_shared/pricing.mjs,
   kept in sync by tools/sync_config.py) over /assets/pricebook.json. Amounts are never typed freely: only codes from the price book,
   or a manual price on 'custom' / 'from' lines (needs_manual_price). Brand + flags: /assets/brand.json (read-only here). */
(function () {
  const AB = window.AdminBackend, Q = window.StartQ;
  let P = null;   // pricing module, loaded in boot() (dynamic import: this file is a classic script)
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  let BRAND = {}, PB = {}, ME = null;
  const D = { leads: [], profiles: [], qs: [], quotes: [], clients: [], payments: [], onboarding: [], tenants: [], requests: [], events: [] };
  let tab = 'quotes', sel = null;
  const F = {};   // filters per tab (kept while the page is open)

  // ------------------------------------------------------------ labels (English UI; product names come from the price book)
  const TABS = [['leads', 'Leads'], ['questionnaires', 'Questionnaires'], ['quotes', 'Quotes'], ['clients', 'Clients'], ['requests', 'Retainer queue'],
    ['tenants', 'Tenants'], ['subscriptions', 'Subscriptions'], ['events', 'Log'], ['settings', 'Settings']];
  const ST = {
    q: { draft: 'Draft', submitted: 'Submitted', quoted: 'Quoted', closed: 'Closed' },
    quote: { draft: 'Draft', needs_manual_price: 'Needs manual price', approved: 'Approved', sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', expired: 'Expired', void: 'Void' },
    client: { onboarding: 'Onboarding', building: 'Building', testing: 'Testing', live: 'Live', paused: 'Paused', cancelled: 'Cancelled' },
    pay: { due: 'Due', paid: 'Paid', refunded: 'Refunded' },
    kind: { deposit: 'Deposit', final: 'Final payment (before go-live)', monthly: 'Monthly', overage: 'Extra usage' },
    req: { queued: 'Queued', active: 'Active', waiting_on_you: 'Waiting on client', done: 'Done', declined: 'Declined' },
    ob: { todo: 'To do', done: 'Done', need_help: 'Needs help' },
    tenant: { sandbox: 'Sandbox', live: 'Live', paused: 'Paused' }
  };
  // The first method is preselected for a quote without one: card / PayPal checkout while brand.json payments.paypal is on,
  // else Upwork Direct Contracts. Same default as quote-draft / quote-send and the quote page (defaultPayMethod in
  // /assets/quote_view.mjs; tools/e2e_admin.mjs checks they match). The other methods stay selectable.
  const PAY_PAYPAL = ['paypal_checkout', 'PayPal – button on the quote page'];
  const PAY_BASE = [['upwork', 'Upwork (Direct Contract)'], ['paypal_link', 'PayPal link'], ['wire', 'Bank transfer'], ['tranzila_link', 'Tranzila link']];
  const ppOn = () => { const p = BRAND.payments && BRAND.payments.paypal; return !!(p && p.enabled === true && /^[A-Za-z0-9_-]{16,128}$/.test(p.client_id || '')); };
  // while PayPal is off it is listed only for a quote that already stores it (quote-send then refuses it: paypal_off)
  const payMethods = cur => ppOn() ? [PAY_PAYPAL].concat(PAY_BASE) : cur === PAY_PAYPAL[0] ? PAY_BASE.concat([PAY_PAYPAL]) : PAY_BASE;
  const payDefault = () => (ppOn() ? PAY_PAYPAL[0] : PAY_BASE[0][0]);
  const payLabel = v => (PAY_BASE.concat([PAY_PAYPAL]).find(x => x[0] === v) || [, v])[1];
  const ENT = { questionnaire: 'Questionnaire', quote: 'Quote', client: 'Client', payment: 'Payment', request: 'Request', tenant: 'Tenant', lead: 'Lead', onboarding_item: 'Checklist', system: 'System' };
  const EVT = { created: 'Created', status_changed: 'Status changed', admin_edit: 'Edited in admin', draft_regenerated: 'Draft regenerated',
    email_quote_sent: 'Quote email sent', payment_marked_paid: 'Payment marked paid', admin_note_saved: 'Internal note saved', admin_reply: 'Reply to client',
    payment_captured: 'Payment received in PayPal', payment_pending: 'PayPal payment processing', payment_refunded: 'Payment refunded', paypal_alert: 'PayPal alert',
    pay_method_changed: 'Payment method changed',
    q_submitted: 'Questionnaire submitted', quote_sent: 'Quote sent', email_requested: 'Email requested', settings_updated: 'Client updated settings',
    need_help: 'Client asked for help', onboarding_updated: 'Checklist updated', retention_error: 'Retention cleanup error', retention_run: 'Retention cleanup run',
    'alert.pending': 'Alert pending', 'booking.cancelled': 'Booking cancelled', 'calendar.connected': 'Calendar connected', 'calendar.reconnect_needed': 'Calendar needs reconnecting',
    'delivery.dead': 'Delivery failed for good', 'email.outbox': 'Email queued', 'notify.admin_unset': 'No admin email set', 'notify.failed': 'Alert failed',
    'sms.incoming': 'SMS received', 'sms.not_sent': 'SMS not sent', 'sms.outbox': 'SMS queued', 'sms.reminder': 'SMS reminder', 'sms.send_failed': 'SMS send failed',
    'sms.sent': 'SMS sent', 'sms.status': 'SMS status', 'sms.textback': 'Text-back to caller', 'voice.call_cap': 'Call cap per number', 'voice.fallback': 'Switched to backup answering',
    'voice.incoming': 'Incoming call', 'voice.latency': 'Latency measured', 'voice.relay_failed': 'Voice connection failed', 'zapier.dead_letter': 'Zapier failed for good',
    'zapier.pending': 'Zapier queued', 'zapier.sent': 'Zapier sent' };
  const EVT_PREFIX = { sms: 'SMS', voice: 'Call', calendar: 'Calendar', zapier: 'Zapier', notify: 'Alert', email: 'Email', booking: 'Booking', alert: 'Alert', delivery: 'Delivery' };
  // every event type gets a label: known map, else "<area>: <type>" for runtime dotted types, else "System event"
  const evtLabel = t => EVT[t] || (t && t.indexOf('.') > 0 && EVT_PREFIX[t.split('.')[0]] ? EVT_PREFIX[t.split('.')[0]] + ': ' + t.split('.').slice(1).join('.') : 'System event (' + t + ')');
  const ERR = {
    not_admin: 'You do not have admin access.',
    not_authenticated: 'Your session expired. Please sign in again.',
    backend_off: 'The backend is not configured (SITE_CONFIG).',
    quote_frozen_after_send: 'This quote was already sent, so its lines and amounts are locked. To change it: void it and send a new quote.',
    quote_amounts_missing: 'Amounts are missing. Finish the manual pricing first.',
    manual_price_required: 'Finish the manual pricing before sending.',
    quote_not_approved: 'Only an approved quote can be sent.',
    quote_already_accepted: 'The client already accepted this quote.',
    quote_anonymized: 'This quote was anonymized and cannot be sent.',
    one_active_request: 'This client already has an active request. Move that one to another status first.',
    request_paused: 'The client paused this request, so it cannot be made active.',
    requests_one_active: 'This client already has an active request. Move that one to another status first.',
    pay_link_https: 'The payment link must start with https://',
    pay_link_check: 'The payment link must start with https://',
    invalid_discount: 'Unknown discount code.',
    questionnaire_not_submitted: 'The questionnaire is not submitted yet.',
    quote_not_accepted: 'You can open a client only after the client accepts the quote.',
    mock_no_file_storage: 'In demo mode only the file name is saved, not the file itself.',
    'Token has expired or is invalid': 'The code is wrong or has expired.',
    needs_manual_price: 'Some lines need a manual price (or manual pricing approval). Cannot send yet.',
    bad_pay_link: 'The payment link must start with https://',
    quote_not_sendable: 'This quote is no longer in a status that can be sent.',
    send_blocked: 'Send blocked: the saved amounts do not match a fresh calculation. Save the draft and try again.',
    pricing_failed: 'Pricing failed: a code does not match the price book.',
    quote_not_found: 'Quote not found.',
    forbidden: 'You do not have admin access.',
    founding_limit_reached: 'The founding-client cap (FOUNDING) is already used up. The server blocked sending with the discount.',
    // card / PayPal checkout (quote-send, pay-refund)
    paypal_off: 'Card payment through PayPal is off right now (or the keys are not set yet). Pick another payment method.',
    refund_window_passed: 'More than 7 days have passed since the payment, so this button cannot refund it. If you still need to refund: do it in PayPal itself (Activity → Refund).',
    not_paypal: 'This payment did not go through the PayPal button, so there is nothing to refund from here.',
    not_paid: 'This payment is not marked "Paid", so there is nothing to refund.',
    not_deposit: 'This button refunds deposits only. Any other refund: in PayPal itself.',
    paypal_refund_failed: 'PayPal declined the refund. Check PayPal → Activity, and pass it to Claude if it is unclear.',
    paypal_unreachable: 'Cannot reach PayPal right now. Try again in a few minutes.',
    paypal_error: 'PayPal returned an error. Try again, and if it repeats: pass it to Claude.'
  };
  function errText(e) {
    const m = (e && [e.code, e.message, e.msg].filter(Boolean).join(' ')) || String(e || '');
    for (const k in ERR) if (m.indexOf(k) !== -1) return ERR[k];
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Cannot reach the server. Check your connection and try again.';
    return 'Something went wrong: ' + m;
  }

  // ------------------------------------------------------------ formatting
  const money = c => c == null ? '<span class="muted">—</span>' : '<span class="num" dir="ltr">' + esc(moneyText(c)) + '</span>';
  const moneyText = c => c == null ? '—' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const ltr = s => '<span dir="ltr" class="ltr">' + esc(s) + '</span>';
  function fmtDate(iso, withTime) {
    if (!iso) return '';
    try {
      const o = { month: 'short', day: 'numeric', year: 'numeric' };
      if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
      const tz = BRAND.owner && BRAND.owner.timezone; if (tz) o.timeZone = tz;
      return new Intl.DateTimeFormat('en-US', o).format(new Date(iso));
    } catch (e) { return String(iso).slice(0, 10); }
  }
  const pill = (group, s) => '<span class="pill pill--' + esc(s) + '">' + esc((ST[group] && ST[group][s]) || s) + '</span>';
  const prof = uid => D.profiles.find(p => p.id === uid) || {};
  const company = uid => { const p = prof(uid); return p.company || p.full_name || p.email || 'No name'; };
  const clientName = c => c ? (c.business_name || company(c.user_id)) : '';
  const itemOf = code => (PB.items || []).find(i => i.code === code);
  const offerLabel = code => code === 'UNSURE' ? 'Not sure — wants a recommendation' : ((itemOf(code) || {}).name || code || '—');
  const nicheLabel = k => ((BRAND.niches || []).find(n => n.key === k) || {}).label || k || '—';
  const intLabel = k => ((PB.integration_meta || {})[k] || {}).label || k;
  const pctFounding = () => (((PB.rules || {}).discounts || {}).FOUNDING || {}).setup_pct || 0;
  const maxFounding = () => (((PB.rules || {}).discounts || {}).FOUNDING || {}).max_clients || 0;

  let toastT;
  function toast(t) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2800);
  }
  const msg = (t, kind) => t ? '<div class="notice notice--' + (kind || 'err') + '" role="' + (kind === 'ok' ? 'status' : 'alert') + '">' + esc(t) + '</div>' : '';

  // ------------------------------------------------------------ config
  // content-hash versions, filled in by tools/asset_version.py (no stale copy of the config after a deploy)
  const AV = /*asset-v*/{"/assets/brand.json":"c749ef27aa","/assets/pricebook.json":"d5a6684ad1","/assets/pricing.mjs":"c1b9f9ffc0"}/*/asset-v*/;
  const vurl = u => u + (AV[u] ? '?v=' + AV[u] : '');
  async function loadConfig() {
    const get = async u => { const r = await fetch(vurl(u), { cache: 'no-cache' }); if (!r.ok) throw new Error('config ' + r.status); return r.json(); };
    try { [BRAND, PB] = await Promise.all([get('/assets/brand.json'), get('/assets/pricebook.json')]); } catch (e) { BRAND = {}; PB = {}; }
    PB._niches = (BRAND.niches || []).map(n => ({ key: n.key, label: n.label, early: n.status === 'early_access' }));
    window.ADMIN_PB = PB; window.ADMIN_BRAND = BRAND;   // the mock adapter prices drafts with the same config
    $('#brandName').textContent = BRAND.name || '';
    document.title = 'Admin' + (BRAND.name ? ' · ' + BRAND.name : '');
    $('#footer').innerHTML = '<bdi>' + esc(BRAND.name || '') + '</bdi> · <bdi dir="ltr">' + esc((BRAND.disclaimers && BRAND.disclaimers.footer) || '') + '</bdi>';
  }

  // ------------------------------------------------------------ header + sign in
  function header(session) {
    const nav = $('#navlinks');
    nav.innerHTML = session ? '<a href="/start/">Portal</a><span class="who" dir="ltr">' + esc(session.user.email) + '</span>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="logoutBtn">Sign out</button>' : '<a href="/">Back to site</a>';
    const b = $('#logoutBtn'); if (b) b.addEventListener('click', async () => { await AB.signOut(); location.href = '/start/admin/'; });
  }
  function mockBar() {
    if (AB.mode !== 'mock' || $('#mockBanner')) return;
    const b = document.createElement('div'); b.id = 'mockBanner'; b.className = 'mockbar'; b.setAttribute('role', 'note');
    b.textContent = 'Demo mode: data is saved only in this browser, and no email is really sent.';
    document.body.insertBefore(b, document.body.firstChild);
  }

  function showLogin(err) {
    header(null);
    const demoHint = AB.mode === 'mock' ? '<p class="muted small">Demo: admin = <span dir="ltr">' + esc((window.StartMock && window.StartMock.MOCK_ADMIN_EMAIL()) || '') + '</span>. Any other email is a client and goes back to the portal.</p>' : '';
    app.innerHTML = '<span class="eyebrow">Admin</span><h1>Admin sign-in</h1>' +
      '<div class="card login"><form id="emailForm" novalidate><div class="field"><label for="email">Your email</label>' +
      '<input class="input ltr" dir="ltr" type="email" id="email" autocomplete="email" required></div>' +
      '<button class="btn btn--primary btn--block" type="submit" id="sendBtn">Send me a sign-in code</button></form>' +
      '<form id="codeForm" novalidate hidden><div class="field"><label for="code">The 6-digit code from the email</label>' +
      '<input class="input code" dir="ltr" type="text" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>' +
      '<button class="btn btn--primary btn--block" type="submit" id="verifyBtn">Sign in</button></form>' +
      '<div id="mockInbox"></div><div id="loginMsg">' + msg(err) + '</div>' + demoHint + '</div>';
    let email = '';
    $('#emailForm').addEventListener('submit', async e => {
      e.preventDefault();
      email = $('#email').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('#loginMsg').innerHTML = msg('That email address is not valid.'); return; }
      try { await AB.sendCode(email); } catch (er) { $('#loginMsg').innerHTML = msg(errText(er)); return; }
      $('#emailForm').hidden = true; $('#codeForm').hidden = false; $('#code').focus();
      if (AB.mode === 'mock' && window.StartMock) {
        const m = window.StartMock.admin.inbox(email).filter(x => x.template === 'auth_code').pop();
        if (m) $('#mockInbox').innerHTML = '<div class="notice" role="note">Demo inbox: the code is <span class="mono" id="mockCode" dir="ltr">' + esc(m.code) + '</span></div>';
      }
    });
    $('#codeForm').addEventListener('submit', async e => {
      e.preventDefault();
      try { const s = await AB.verifyCode(email, $('#code').value.trim()); await afterSignIn(s); }
      catch (er) { $('#loginMsg').innerHTML = msg(errText(er)); }
    });
  }

  async function afterSignIn(session) {
    let who;
    try { who = await AB.adminWhoami(); } catch (e) { showLogin(errText(e)); return; }
    if (!who.is_admin) { location.replace('/start/'); return; }   // non-admin: back to the client portal
    ME = who; header(session);
    await reload();
    route();
    window.addEventListener('hashchange', route);
  }

  // ------------------------------------------------------------ data
  async function reload() {
    const [leads, profiles, qs, quotes, clients, payments, onboarding, tenants, requests, events] = await Promise.all([
      AB.adminListLeads(), AB.adminListProfiles(), AB.adminListQuestionnaires(), AB.adminListQuotes(), AB.adminListClients(),
      AB.adminListPayments(), AB.adminListOnboarding(), AB.adminListTenants(), AB.adminListRequests(), AB.adminListEvents(300)]);
    Object.assign(D, { leads, profiles, qs, quotes, clients, payments, onboarding, tenants, requests, events });
  }
  const startedLead = l => { const p = D.profiles.find(x => (x.email || '').toLowerCase() === (l.email || '').toLowerCase()); return !!(p && D.qs.some(q => q.user_id === p.id)); };
  const liveQuoteOf = qid => D.quotes.filter(x => x.questionnaire_id === qid && x.status !== 'void').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
  const clientOfQuote = id => D.clients.find(c => c.quote_id === id);

  // ------------------------------------------------------------ routing: #tab or #tab/<id>
  function route() {
    const m = /^#([a-z]+)(?:\/([\w-]+))?/.exec(location.hash || '');
    const t = m && TABS.some(x => x[0] === m[1]) ? m[1] : tab;
    const changed = !$('#panel') || t !== tab;
    tab = t; sel = m && m[2] || null;
    if (!$('#panel')) shell();
    if (changed) { $$('.tabs [role=tab]').forEach(b => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }); renderTab(); }
    else renderTab(true);
  }
  function go(t, id) { const h = '#' + t + (id ? '/' + id : ''); if (location.hash === h) route(); else location.hash = h; }

  function shell() {
    mockBar();
    app.innerHTML = '<span class="eyebrow">Admin</span><h1>What needs you today</h1>' +
      '<section class="card digest" id="digest" aria-labelledby="dgH"></section>' +
      '<div class="tabs" role="tablist" aria-label="Admin sections">' + TABS.map(([id, l]) =>
        '<button type="button" role="tab" id="tab-' + id + '" data-tab="' + id + '" aria-controls="panel" aria-selected="' + (id === tab) + '" tabindex="' + (id === tab ? 0 : -1) + '">' + esc(l) + '<span class="cnt" id="cnt-' + id + '"></span></button>').join('') +
      '</div><div id="panel" role="tabpanel" tabindex="-1"></div>';
    $$('.tabs [role=tab]').forEach(b => {
      b.addEventListener('click', () => go(b.dataset.tab));
      b.addEventListener('keydown', e => {
        const all = $$('.tabs [role=tab]'), i = all.indexOf(b);
        let n = null;
        if (e.key === 'ArrowRight') n = all[(i + 1) % all.length];        // LTR: right = next
        if (e.key === 'ArrowLeft') n = all[(i - 1 + all.length) % all.length];
        if (e.key === 'Home') n = all[0];
        if (e.key === 'End') n = all[all.length - 1];
        if (n) { e.preventDefault(); n.focus(); go(n.dataset.tab); }
      });
    });
    renderDigest();
  }

  function counts() {
    const H24 = Date.now() - 864e5;
    const due = D.payments.filter(p => p.status === 'due');
    return {
      newLeads: D.leads.filter(l => Date.parse(l.created_at) > H24 && !startedLead(l)).length,
      awaiting: D.qs.filter(q => q.status === 'submitted' && !liveQuoteOf(q.id)).length,
      drafts: D.quotes.filter(q => q.status === 'draft' || q.status === 'approved').length,
      manual: D.quotes.filter(q => q.status === 'needs_manual_price').length,
      waiting: D.quotes.filter(q => q.status === 'sent' || q.status === 'viewed').length,
      // card / PayPal checkout opens the client card by itself on the first payment step (pay_target)
      accepted: D.quotes.filter(q => q.status === 'accepted' && !clientOfQuote(q.id) && q.pay_method !== PAY_PAYPAL[0]).length,
      depositsDue: due.filter(p => p.kind === 'deposit').length,
      dueSum: due.reduce((s, p) => s + (p.amount_cents || 0), 0),
      queued: D.requests.filter(r => r.status === 'queued').length,
      active: D.requests.filter(r => r.status === 'active').length,
      needHelp: D.onboarding.filter(o => o.status === 'need_help').length
    };
  }
  function renderDigest() {
    const c = counts();
    const tile = (n, label, t, hot) => '<li><button type="button" data-go="' + t + '" class="' + (hot && n ? 'hot' : '') + '"><b>' + n + '</b>' + esc(label) + '</button></li>';
    const wasOpen = $('#digestDet') ? $('#digestDet').open : !matchMedia('(max-width:759px)').matches;   // collapsed on phones, open on desktop
    const hot = c.awaiting + c.drafts + c.manual + c.accepted + c.needHelp;
    $('#digest').innerHTML = '<details id="digestDet"' + (wasOpen ? ' open' : '') + '><summary class="digest__head"><h2 id="dgH">Daily summary</h2><span class="muted small">' +
      (hot ? '<b class="digest__hot">' + hot + ' to handle</b> · ' : '') + esc(fmtDate(new Date().toISOString(), true)) + '</span></summary>' +
      '<ul class="digest__grid">' +
      tile(c.newLeads, 'New leads, last day', 'leads') +
      tile(c.awaiting, 'Questionnaires waiting for a quote', 'questionnaires', true) +
      tile(c.drafts, 'Drafts to approve', 'quotes', true) +
      tile(c.manual, 'Needs manual price', 'quotes', true) +
      tile(c.waiting, 'Quotes with the client', 'quotes') +
      tile(c.accepted, 'Accepted, open a client', 'quotes', true) +
      tile(c.depositsDue, 'Unpaid deposits', 'clients') +
      '<li><button type="button" data-go="clients"><b>' + money(c.dueSum) + '</b>Total due</button></li>' +
      tile(c.active + ' / ' + c.queued, 'Requests active / queued', 'requests') +
      tile(c.needHelp, 'Need help with the checklist', 'clients', true) + '</ul>' +
      (AB.mode === 'mock' ? '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" id="seedBtn">Load demo data</button></div>' : '') + '</details>';
    $$('#digest [data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    const sb = $('#seedBtn');
    if (sb) sb.addEventListener('click', async () => {
      try { window.StartMock.admin.seedAdmin(PB); await reload(); renderDigest(); renderTab(); toast('Demo data loaded.'); } catch (e) { toast(errText(e)); }
    });
    $('#cnt-quotes').textContent = c.drafts + c.manual ? String(c.drafts + c.manual) : '';
    $('#cnt-questionnaires').textContent = c.awaiting ? String(c.awaiting) : '';
    $('#cnt-requests').textContent = c.queued + c.active ? String(c.queued + c.active) : '';
  }
  async function refresh() { await reload(); renderDigest(); renderTab(true); }

  // ------------------------------------------------------------ tab dispatcher
  function renderTab(keepList) {
    const p = $('#panel');
    p.setAttribute('aria-labelledby', 'tab-' + tab);
    ({ leads: tLeads, questionnaires: tQs, quotes: tQuotes, clients: tClients, requests: tRequests, tenants: tTenants, subscriptions: tSubs, events: tEvents, settings: tSettings }[tab])(p, keepList);
  }
  // generic list + detail
  function split(p, filtersHtml, onFilter) {
    p.innerHTML = '<div class="split"><div><div class="filters">' + filtersHtml + '</div><ul class="alist" id="alist"></ul></div>' +
      '<section class="detail card" id="detail" tabindex="-1" aria-live="polite"></section></div>';
    $$('.filters input, .filters select', p).forEach(el => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', onFilter));
  }
  function fillList(rows, rowHtml, tabId, emptyText) {
    const ul = $('#alist');
    ul.innerHTML = rows.length ? rows.map(r => '<li><button type="button" data-id="' + esc(r.id) + '" aria-current="' + (r.id === sel) + '">' + rowHtml(r) + '</button></li>').join('')
      : '<li class="empty">' + esc(emptyText) + '</li>';
    $$('[data-id]', ul).forEach(b => b.addEventListener('click', () => {
      go(tabId, b.dataset.id);
      if (matchMedia('(max-width:959px)').matches) $('#detail').scrollIntoView({ block: 'start' });
    }));
  }
  const focusDetail = () => { const d = $('#detail'); if (d && document.activeElement && document.activeElement.closest('#alist')) d.focus({ preventScroll: true }); };
  const opt = (v, l, cur) => '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(l) + '</option>';
  const fsel = (id, label, options, cur) => '<label class="sr-only" for="' + id + '">' + esc(label) + '</label><select class="select" id="' + id + '">' + options.map(o => opt(o[0], o[1], cur)).join('') + '</select>';
  const fsearch = (id, ph, cur) => '<label class="sr-only" for="' + id + '">' + esc(ph) + '</label><input class="input" type="search" id="' + id + '" placeholder="' + esc(ph) + '" value="' + esc(cur || '') + '">';

  function notesBox(entity, id) {
    return '<h3>Internal notes</h3><div class="field"><label for="notes">Only you see this. Never shown to the client on any screen or email.</label>' +
      '<textarea class="textarea" id="notes" maxlength="20000"></textarea></div><button type="button" class="btn btn--ghost btn--sm" id="notesSave" data-entity="' + entity + '" data-eid="' + esc(id) + '">Save note</button>';
  }
  async function wireNotes() {
    const b = $('#notesSave'); if (!b) return;
    const ta = $('#notes');
    try { const v = await AB.adminGetNote(b.dataset.entity, b.dataset.eid); if (ta.isConnected) ta.value = v; } catch (e) { /* no note yet */ }
    if (!b.isConnected) return;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await AB.adminSaveNote(b.dataset.entity, b.dataset.eid, $('#notes').value); toast('Note saved.'); await reloadEvents(); }
      catch (e) { toast(errText(e)); }
      b.disabled = false;
    });
  }
  async function reloadEvents() { try { D.events = await AB.adminListEvents(300); } catch (e) { /* keep old */ } }

  // ------------------------------------------------------------ Leads
  function tLeads(p) {
    const f = F.leads = F.leads || { onlyNew: true, term: '' };
    p.innerHTML = '<div class="filters"><label class="check"><input type="checkbox" id="fOnly"' + (f.onlyNew ? ' checked' : '') + '> Only leads with no questionnaire</label>' +
      fsearch('fTerm', 'Search by email or page', f.term) + '</div><ul class="plist" id="leadList"></ul>';
    const draw = () => {
      f.onlyNew = $('#fOnly').checked; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.leads.filter(l => (!f.onlyNew || !startedLead(l)) && (!f.term || ((l.email || '') + ' ' + (l.source_page || '')).toLowerCase().indexOf(f.term) !== -1));
      $('#leadList').innerHTML = rows.length ? rows.map(l => {
        const st = startedLead(l);
        const utm = l.utm && Object.keys(l.utm).length ? Object.entries(l.utm).map(([k, v]) => k + '=' + v).join(' · ') : '';
        const extra = [l.name, l.company, l.offer].filter(Boolean).map(x => '<bdi>' + esc(x) + '</bdi>').join(' · ');
        return '<li><span class="grow"><b>' + ltr(l.email) + '</b>' + (extra ? ' · ' + extra : '') + '<br><span class="muted small">' + esc(nicheLabel(l.niche)) + ' · ' + ltr(l.source_page || '') +
          (utm ? ' · ' + ltr(utm) : '') + ' · ' + esc(fmtDate(l.created_at, true)) + '</span></span>' +
          '<span class="pill pill--' + (st ? 'done' : 'todo') + '">' + (st ? 'Started questionnaire' : 'Not started') + '</span>' +
          '<a class="btn btn--ghost btn--sm" href="mailto:' + esc(l.email) + '">Email</a></li>';
      }).join('') : '<li class="empty">No leads match this filter.</li>';
    };
    $('#fOnly').addEventListener('change', draw); $('#fTerm').addEventListener('input', draw);
    draw();
  }

  // ------------------------------------------------------------ Questionnaires
  function tQs(p, keep) {
    const f = F.qs = F.qs || { st: '!draft', offer: '', niche: '', term: '' };
    const filter = () => {
      f.st = $('#fSt').value; f.offer = $('#fOffer').value; f.niche = $('#fNiche').value; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.qs.filter(q => (f.st === '!draft' ? q.status !== 'draft' : !f.st || q.status === f.st) && (!f.offer || q.offer === f.offer) &&
        (!f.niche || q.niche === f.niche) && (!f.term || [company(q.user_id), prof(q.user_id).email].join(' ').toLowerCase().indexOf(f.term) !== -1));
      fillList(rows, q => '<span class="l1"><b>' + esc(company(q.user_id)) + '</b>' + pill('q', q.status) + '</span><span class="l2">' + esc(offerLabel(q.offer)) + ' · ' +
        esc(nicheLabel(q.niche)) + ' · ' + esc(fmtDate(q.submitted_at || q.updated_at)) + '</span>', 'questionnaires', 'No questionnaires match this filter.');
    };
    if (!keep || !$('#fSt')) {
      split(p, fsel('fSt', 'Status', [['!draft', 'All submitted'], ['', 'All statuses']].concat(Object.entries(ST.q)), f.st) +
        fsel('fOffer', 'Product', [['', 'All products']].concat(((PB.rules || {}).core_codes || []).map(c => [c, offerLabel(c)]), [['UNSURE', offerLabel('UNSURE')]]), f.offer) +
        fsel('fNiche', 'Niche', [['', 'All niches']].concat((BRAND.niches || []).map(n => [n.key, n.label])), f.niche) + fsearch('fTerm', 'Search: business or email', f.term), filter);
    }
    filter();
    qDetail();
  }
  async function qDetail() {
    const d = $('#detail');
    const q = sel && D.qs.find(x => x.id === sel);
    if (!q) { d.innerHTML = '<p class="muted">Pick a questionnaire from the list.</p>'; return; }
    const pr = prof(q.user_id);
    const summary = Array.isArray(q.summary) && q.summary.length ? q.summary : (Q ? Q.buildSummary(Object.assign({}, q.answers, { offer: q.offer, niche: q.niche }), PB) : []);
    const qt = liveQuoteOf(q.id);
    const kv = [['Name', esc(pr.full_name)], ['Business', esc(pr.company)], ['Email', ltr(pr.email)], ['Phone', ltr(pr.phone)], ['City and state', esc([pr.city, pr.state].filter(Boolean).join(', '))],
      ['Time zone', ltr(pr.timezone)], ['Website', ltr(pr.website)], ['How they heard', esc(pr.how_heard)], ['Update language', esc(pr.update_lang === 'he' ? 'Hebrew' : 'English')]];
    d.innerHTML = '<div class="row">' + pill('q', q.status) + '<span class="muted small">' + (q.submitted_at ? 'Submitted ' + esc(fmtDate(q.submitted_at, true)) : 'Draft, updated ' + esc(fmtDate(q.updated_at, true))) + '</span></div>' +
      '<h2>' + esc(company(q.user_id)) + '</h2><p class="muted">' + esc(offerLabel(q.offer)) + ' · ' + esc(nicheLabel(q.niche)) + '</p>' +
      '<div class="btnrow"><button type="button" class="btn btn--ghost" id="copyMd">Copy for Claude</button>' +
      (qt ? '<button type="button" class="btn btn--primary" id="openQuote">Open the quote (' + esc(ST.quote[qt.status] || qt.status) + ')</button>'
        : (q.status !== 'draft' ? '<button type="button" class="btn btn--primary" id="mkDraft">Create quote draft</button>' : '')) + '</div><div id="copyBox"></div><div id="qMsg"></div>' +
      '<h3>Client</h3><dl class="kv">' + kv.map(x => '<dt>' + x[0] + '</dt><dd>' + (x[1] || '<span class="muted">—</span>') + '</dd>').join('') + '</dl>' +
      '<h3>Answers</h3><ul class="sum" dir="ltr" lang="en">' + summary.map(it => '<li><div class="q">' + esc(it.q) + '</div><div class="a' + ((it.a || '').trim() ? '' : ' none') + '">' + esc((it.a || '').trim() || '—') + '</div></li>').join('') + '</ul>' +
      '<h3>Files</h3><div id="files"><p class="muted">Loading…</p></div>' + notesBox('questionnaire', q.id);
    focusDetail();
    const filesEl = $('#files', d), copyBox = $('#copyBox', d);
    $('#copyMd', d).addEventListener('click', async () => {
      const md = '# Questionnaire: ' + company(q.user_id) + '\n\n- Offer: ' + (q.offer || '') + '\n- Niche: ' + (q.niche || '') + '\n- Submitted: ' + (q.submitted_at || '') +
        '\n- Contact: ' + [pr.full_name, pr.email, pr.phone, pr.city, pr.state, pr.timezone].filter(Boolean).join(' · ') + '\n\n## Answers\n\n' +
        summary.map(it => '**' + it.q + '**\n' + ((it.a || '').trim() || '—')).join('\n\n') + '\n';
      try { await navigator.clipboard.writeText(md); toast('Copied. Paste it into your chat with Claude.'); }
      catch (e) { copyBox.innerHTML = '<div class="field"><label for="mdBox">Copy manually</label><textarea class="textarea tall ltr" dir="ltr" id="mdBox" readonly>' + esc(md) + '</textarea></div>'; $('#mdBox', copyBox).select(); }
    });
    // attachments load async: the detail may have been replaced meanwhile (e.g. "Create quote draft" jumps to the quote)
    (async () => {
      let atts;
      try { atts = await AB.adminListAttachments(q.id); } catch (e) { if (filesEl.isConnected) filesEl.innerHTML = msg(errText(e)); return; }
      if (!filesEl.isConnected) return;
      filesEl.innerHTML = atts.length ? '<ul class="plist">' + atts.map((a, i) => '<li><span class="grow" dir="ltr">' + esc(a.filename) + '</span><button type="button" class="btn btn--ghost btn--sm" data-att="' + i + '">Download</button></li>').join('') + '</ul>' : '<p class="muted">No files.</p>';
      $$('[data-att]', filesEl).forEach(b => b.addEventListener('click', async () => {
        try { window.open(await AB.downloadUrl(atts[+b.dataset.att]), '_blank', 'noopener'); } catch (e) { toast(errText(e)); }
      }));
    })();
    const oq = $('#openQuote'); if (oq) oq.addEventListener('click', () => go('quotes', qt.id));
    const mk = $('#mkDraft');
    if (mk) mk.addEventListener('click', async () => {
      mk.disabled = true; $('#qMsg').innerHTML = msg('Preparing the draft…', 'ok');
      try { const r = await AB.adminRegenerateDraft(q.id, PB); await refresh(); const nid = (r && (r.id || r.quote_id)) || (liveQuoteOf(q.id) || {}).id; if (nid) go('quotes', nid); }
      catch (e) { $('#qMsg').innerHTML = msg(errText(e)); mk.disabled = false; }
    });
    wireNotes();
  }

  // ------------------------------------------------------------ Quotes
  function tQuotes(p, keep) {
    const f = F.quotes = F.quotes || { st: 'open', term: '' };
    const OPEN = ['draft', 'needs_manual_price', 'approved'];
    const filter = () => {
      f.st = $('#fSt').value; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.quotes.filter(q => (f.st === 'open' ? OPEN.includes(q.status) : !f.st || q.status === f.st) &&
        (!f.term || company(q.user_id).toLowerCase().indexOf(f.term) !== -1));
      fillList(rows, q => '<span class="l1"><b>' + esc(company(q.user_id)) + '</b>' + pill('quote', q.status) + '</span><span class="l2">' +
        '<bdi>' + esc(((q.items || []).map(i => i.code).filter(c => c !== 'CUSTOM').join(' + ')) || '—') + '</bdi> · setup ' + money(q.setup_cents) + ' · monthly ' + money(q.monthly_cents) + '</span>', 'quotes', 'No quotes match this filter.');
    };
    if (!keep || !$('#fSt')) split(p, fsel('fSt', 'Status', [['open', 'Open (yours to handle)'], ['', 'All quotes']].concat(Object.entries(ST.quote)), f.st) + fsearch('fTerm', 'Search by business', f.term), filter);
    filter();
    quoteDetail();
  }

  let ED = null;   // editor state of the open quote: {id, lines, discount, confirmed}
  function foundingUsed(exceptId) { return D.quotes.filter(q => q.id !== exceptId && q.discount_code === 'FOUNDING' && ['sent', 'viewed', 'accepted'].includes(q.status)).length; }
  const REASON = r => {
    const [k, c] = r.split(':');
    return ({ setup_over_threshold: 'Setup over ' + moneyText((PB.rules || {}).manual_price_setup_over_cents) + ': check by hand',
      custom: 'Custom line that needs a manual price: ' + r.slice(7), from: c + ' is priced "from", needs a final price', fixed: c + ' has no price in the table, needs a manual price',
      later_offer: c + ' is a "later" offer: not priced automatically, approve the price by hand' })[k] || r;
  };
  const PERR = e => {
    const [k, c, d] = e.split(':');
    return ({ no_core_offer: 'Missing a core product (' + ((PB.rules || {}).core_codes || []).join(' / ') + ').', more_than_one_core_offer: 'Only one core product per quote.',
      unknown_code: 'Code not in the price book: ' + c, duplicate_code: 'Code ' + c + ' appears twice.', bad_qty: 'Invalid quantity on ' + c + ' (1 to ' + (P ? P.MAX_QTY : '') + ').',
      core_qty: 'A core product must have quantity 1.', addon_requires_core: 'Add-on ' + c + ' needs a core product.', addon_not_applicable: 'Add-on ' + c + ' does not fit ' + d + '.',
      already_included: c + ' is already included in ' + d + '.', percent_qty: 'Rush must have quantity 1.', custom_without_label: 'Custom line with no name.',
      unknown_discount: 'Unknown discount code.', monthly_discount_not_allowed: 'No discounts on the monthly fee.',
      coming_soon: c + ' is still "coming soon" (waiting on US SMS registration): it cannot be offered or sold.', plan_b_not_available: 'Plan B (no setup fee) is not on sale yet.' })[k] || e;
  };
  const QTY_CODES = ['ADD-LOC', 'ADD-CRM', 'ADD-PAGE', 'ADD-USAGE'];
  const isC = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const manualLine = l => l.code === 'CUSTOM' || (itemOf(l.code) && (itemOf(l.code).kind === 'from' || itemOf(l.code).group === 'later'));
  // admin view of priceQuote: totals with Meir's approval, plus what still blocks sending without it
  function calc(lines, discount, approved) {
    const o = { discount_code: discount || null };
    const strict = P.priceQuote(PB, lines, o);
    const r = approved ? P.priceQuote(PB, lines, Object.assign({ manual_approved: true }, o)) : strict;
    const unresolved = lines.map((l, i) => {
      if (!manualLine(l)) return -1;
      const it = itemOf(l.code);
      const tableOk = it && it.kind === 'fixed' && isC(it.setup_cents) && isC(it.monthly_cents);
      return tableOk || (isC(l.manual_setup_cents) && isC(l.manual_monthly_cents)) ? -1 : i;
    }).filter(i => i >= 0);
    return { r, errors: strict.errors, needed: strict.needs_manual_price, reasons: strict.manual_reasons, unresolved,
      sendable: strict.errors.length === 0 && !r.needs_manual_price && !unresolved.length };
  }
  window.AdminCalc = (lines, discount, approved) => calc(lines, discount, approved);   // used by tools/e2e_admin.mjs parity test
  function addableCodes(core) {
    const have = new Set(ED.lines.map(l => l.code)), cores = (PB.rules || {}).core_codes || [];
    return (PB.items || []).filter(it => {
      if (have.has(it.code) || !P.isAvailable(it)) return false;   // coming-soon items are never offered (PRICEBOOK §4.10)
      if (cores.includes(it.code)) return !core;
      if (it.group === 'core') return false;   // a core offer that is not sellable yet (not in rules.core_codes)
      if (it.group === 'addon') return core ? P.addonApplies(PB, it, core) && !P.alreadyIncluded(core, it.code, PB) : it.applies_to.includes('any');
      return true;   // 'later' offers (alone or with a core)
    }).map(it => it.code);
  }

  // first-touch source of the lead (questionnaires.utm, from the site's utm_* links; empty = unknown / direct)
  function utmLine(qn) {
    const u = qn && qn.utm;
    if (!u || !u.utm_source) return '';
    const parts = [u.utm_source, u.utm_medium, u.utm_campaign].filter(Boolean).map(esc).join(' / ');
    return '<p class="muted small">Lead source (first click): <span dir="ltr">' + parts + '</span>' + (u.landing_path ? ' · landing page <span dir="ltr">' + esc(u.landing_path) + '</span>' : '') + '</p>';
  }
  function quoteDetail() {
    const d = $('#detail');
    const q = sel && D.quotes.find(x => x.id === sel);
    if (!q) { d.innerHTML = '<p class="muted">Pick a quote from the list.</p>'; ED = null; return; }
    const frozen = !!q.anonymized || !!q.sent_at || ['sent', 'viewed', 'accepted', 'expired', 'void'].includes(q.status);
    if (!ED || ED.id !== q.id) ED = { id: q.id, lines: P.inputsFromStored(q.items || [], PB), discount: q.discount_code || null, confirmed: false };
    const qn = D.qs.find(x => x.id === q.questionnaire_id);
    const summary = qn ? (Array.isArray(qn.summary) && qn.summary.length ? qn.summary : (Q ? Q.buildSummary(Object.assign({}, qn.answers, { offer: qn.offer, niche: qn.niche }), PB) : [])) : [];
    const answers = '<details class="card" open><summary><b>Client answers</b></summary><ul class="sum" dir="ltr" lang="en">' +
      (summary.length ? summary.map(it => '<li><div class="q">' + esc(it.q) + '</div><div class="a' + ((it.a || '').trim() ? '' : ' none') + '">' + esc((it.a || '').trim() || '—') + '</div></li>').join('') : '<li class="muted">No linked questionnaire.</li>') + '</ul>' + utmLine(qn) + '</details>';
    const head = '<div class="row">' + pill('quote', q.status) + '<span class="muted small">Created ' + esc(fmtDate(q.created_at, true)) +
      (q.sent_at ? ' · sent ' + esc(fmtDate(q.sent_at, true)) : '') + (q.valid_until ? ' · valid until ' + esc(fmtDate(q.valid_until)) : '') + '</span></div>' +
      '<h2>' + esc(company(q.user_id)) + '</h2>';
    if (frozen) { d.innerHTML = head + frozenQuote(q) + '<div id="reviewBox"></div>' + answers + notesBox('quote', q.id); wireFrozen(q); wireNotes(); loadReview(q); focusDetail(); return; }

    const core = (ED.lines.find(l => ((PB.rules || {}).core_codes || []).includes(l.code)) || {}).code || null;
    const addable = addableCodes(core);
    const customKeys = Object.entries(PB.integrations || {}).filter(([, v]) => v === 'custom').map(([k]) => ['tool:' + k, intLabel(k) + ' integration']);
    const used = foundingUsed(q.id), maxF = maxFounding();
    const foundingBlocked = !ED.discount && maxF && used >= maxF;
    d.innerHTML = head + '<div class="qgrid"><div>' +
      '<h3>Quote lines</h3><ul class="lines" id="lines"></ul>' +
      '<div class="addrow"><label class="sr-only" for="addCode">Add a code from the price book</label><select class="select" id="addCode">' + opt('', 'Add a code from the price book…', '') +
      addable.map(c => opt(c, c + ' — ' + (itemOf(c) || {}).name, '')).join('') + '</select><button type="button" class="btn btn--ghost" id="addBtn">Add</button></div>' +
      '<div class="addrow"><label class="sr-only" for="addCustom">Add a manually priced line</label><select class="select" id="addCustom">' + opt('', 'Manually priced line (custom)…', '') +
      customKeys.concat([['locations_over_3', 'More than 3 locations'], ['call_volume', 'Call volume above the auto-quote limit']]).map(([k, l]) => opt(k, l, '')).join('') +
      '</select><button type="button" class="btn btn--ghost" id="addCustomBtn">Add</button></div>' +
      '<label class="check spaced"><input type="checkbox" id="founding"' + (ED.discount === 'FOUNDING' ? ' checked' : '') + '' + '> Founding discount <bdi dir="ltr">(FOUNDING)</bdi>: ' +
      pctFounding() + '% off setup only · ' + used + ' of ' + maxF + ' used</label>' +
      (foundingBlocked ? '<p class="small" style="color:var(--warn)">Note: the cap of ' + maxF + ' founding clients is already used up. The server will block sending with this discount.</p>' : '') +
      '<ul class="errs" id="pErrs" role="alert"></ul><div id="manualBox"></div>' +
      '<h3>Amounts</h3><dl class="totals" id="totals"></dl>' +
      '<h3>Quote text (the client sees this)</h3>' +
      '<div class="field"><label for="scope">What we\'ll build</label><textarea class="textarea tall ltr" dir="ltr" lang="en" id="scope" maxlength="20000">' + esc(q.scope_md || '') + '</textarea></div>' +
      '<div class="field"><label for="assum">Assumptions (one per line)</label><textarea class="textarea ltr" dir="ltr" lang="en" id="assum">' + esc((q.assumptions || []).join('\n')) + '</textarea></div>' +
      '<div class="field"><label for="timeline">Timeline</label><input class="input ltr" dir="ltr" lang="en" id="timeline" maxlength="4000" value="' + esc(q.timeline_text || '') + '"></div>' +
      '<h3>Payment</h3><div class="field"><label for="payMethod">Payment method</label><select class="select" id="payMethod">' +
      payMethods(q.pay_method).map(([v, l]) => opt(v, l, q.pay_method || payDefault())).join('') + '</select></div>' +
      '<div class="field"><label for="payLink">Payment link or Upwork contract link (optional; with no link the client sees what the next step is)</label><input class="input ltr" dir="ltr" type="url" id="payLink" maxlength="1000" placeholder="https://" value="' + esc(q.pay_link || '') + '"></div>' +
      '<div id="eMsg"></div><div class="btnrow"><button type="button" class="btn btn--primary" id="sendBtn">Approve and send</button>' +
      '<button type="button" class="btn btn--ghost" id="saveBtn">Save draft</button>' +
      (q.questionnaire_id ? '<button type="button" class="btn btn--ghost" id="regenBtn">Regenerate draft</button>' : '') +
      '<button type="button" class="btn btn--ghost" id="voidBtn">Void quote</button></div>' +
      '<p class="muted small">"Approve and send" moves the quote to approved, then to sent, and emails the client the quote_sent email. Every action is recorded in the log.</p>' +
      '</div><div><div id="reviewBox"></div>' + answers + notesBox('quote', q.id) + '</div></div>';
    drawLines(); focusDetail(); loadReview(q);
    $('#addBtn').addEventListener('click', () => {
      const c = $('#addCode').value; if (!c) { $('#addCode').focus(); return; }
      ED.lines.push({ code: c, qty: 1 }); quoteDetail(); $('#addCode').focus();
    });
    $('#addCustomBtn').addEventListener('click', () => {
      const s = $('#addCustom'); const k = s.value; if (!k) { s.focus(); return; }
      ED.lines.push({ code: 'CUSTOM', qty: 1, label: s.options[s.selectedIndex].text }); drawLines(); s.value = '';
    });
    $('#founding').addEventListener('change', e => { ED.discount = e.target.checked ? 'FOUNDING' : null; drawTotals(); });
    $('#saveBtn').addEventListener('click', () => saveQuote(q, false));
    $('#sendBtn').addEventListener('click', () => saveQuote(q, true));
    $('#voidBtn').addEventListener('click', () => voidQuote(q));
    const rg = $('#regenBtn');
    if (rg) rg.addEventListener('click', async () => {
      if (!confirm('Regenerate the draft? The current lines and text will be replaced.')) return;
      rg.disabled = true;
      try { await AB.adminRegenerateDraft(q.questionnaire_id, PB); ED = null; await refresh(); toast('New draft created.'); }
      catch (e) { $('#eMsg').innerHTML = msg(errText(e)); rg.disabled = false; }
    });
    wireNotes();
  }

  function lineAmt(l, i, c) {
    if (c.unresolved.includes(i)) return '<span>Setup ' + money(null) + '</span><span>Monthly ' + money(null) + '</span>';
    const it = itemOf(l.code), qty = l.qty || 1;
    if (it && it.kind === 'percent') return '<span>' + esc(it.setup_pct || (PB.rules || {}).rush_pct) + '% of setup: ' + money(c.r.rush_cents) + '</span>';
    const man = manualLine(l) && isC(l.manual_setup_cents) && isC(l.manual_monthly_cents);
    const us = man ? l.manual_setup_cents : it && it.setup_cents, um = man ? l.manual_monthly_cents : it && it.monthly_cents;
    return '<span>Setup ' + money(isC(us) ? us * qty : null) + '</span><span>Monthly ' + money(isC(um) ? um * qty : null) + '</span>';
  }
  function drawLines() {
    const c = calc(ED.lines, ED.discount, ED.confirmed);
    const ul = $('#lines');
    ul.innerHTML = ED.lines.length ? ED.lines.map((l, i) => {
      const it = itemOf(l.code);
      const manual = manualLine(l);
      const name = l.code === 'CUSTOM' ? (l.label || 'Custom') : ((it || {}).name || l.code);
      let ctl = '';
      if (QTY_CODES.includes(l.code)) ctl += '<label class="mini">Qty<input class="input qty" type="number" min="1" max="' + P.MAX_QTY + '" step="1" data-qty="' + i + '" value="' + esc(l.qty || 1) + '"></label>';
      if (manual) {
        const fl = it && it.kind === 'from' && it.setup_cents;
        const dflt = (v, t) => isC(v) ? v / 100 : (isC(t) ? t / 100 : '');
        ctl += '<label class="mini">Manual setup ($)' + (fl ? ' · from ' + esc(moneyText(fl)) : '') + '<input class="input" dir="ltr" type="number" min="0" step="1" data-ms="' + i + '" value="' + dflt(l.manual_setup_cents, it && it.kind === 'fixed' ? it.setup_cents : null) + '"></label>' +
          '<label class="mini">Manual monthly ($)<input class="input" dir="ltr" type="number" min="0" step="1" data-mm="' + i + '" value="' + dflt(l.manual_monthly_cents, it ? it.monthly_cents : null) + '"></label>';
        // a later fixed offer starts at its table price: store it as the manual value so the server sees Meir's number
        if (it && it.kind === 'fixed' && !isC(l.manual_setup_cents) && isC(it.setup_cents) && isC(it.monthly_cents)) { l.manual_setup_cents = it.setup_cents; l.manual_monthly_cents = it.monthly_cents; }
        if (it && !isC(l.manual_monthly_cents) && isC(it.monthly_cents)) l.manual_monthly_cents = it.monthly_cents;   // input shows the table monthly
      }
      ctl += '<button type="button" class="btn btn--ghost btn--sm" data-rm="' + i + '" aria-label="Remove ' + esc(l.code) + '">Remove</button>';
      const bad = c.errors.some(e => e.split(':')[1] === l.code);
      return '<li class="line' + (manual ? ' line--manual' : '') + (bad ? ' line--err' : '') + '"><span class="line__name"><code dir="ltr">' + esc(l.code) + '</code><span dir="ltr" lang="en">' + esc(name) + '</span></span>' +
        '<span class="line__amt" data-amt="' + i + '">' + lineAmt(l, i, c) + '</span><span class="line__ctl">' + ctl + '</span></li>';
    }).join('') : '<li class="empty">No lines yet. Add a code from the price book.</li>';
    $$('[data-qty]', ul).forEach(el => el.addEventListener('input', () => { ED.lines[+el.dataset.qty].qty = parseInt(el.value, 10) || 1; drawTotals(); }));
    const cents = v => v === '' || v == null ? null : Math.max(0, Math.round(parseFloat(v) * 100));
    $$('[data-ms]', ul).forEach(el => el.addEventListener('input', () => { ED.lines[+el.dataset.ms].manual_setup_cents = cents(el.value); drawTotals(); }));
    $$('[data-mm]', ul).forEach(el => el.addEventListener('input', () => { ED.lines[+el.dataset.mm].manual_monthly_cents = cents(el.value); drawTotals(); }));
    $$('[data-rm]', ul).forEach(el => el.addEventListener('click', () => { ED.lines.splice(+el.dataset.rm, 1); quoteDetail(); }));
    drawTotals();
  }
  function drawTotals() {
    const c = calc(ED.lines, ED.discount, true), r = c.r;
    ED.lines.forEach((l, i) => { const el = $('[data-amt="' + i + '"]'); if (el) el.innerHTML = lineAmt(l, i, c); });
    const unresolved = c.unresolved.length > 0 || c.errors.length > 0;
    const row = (l, v, cls) => '<dt' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(l) + '</dt><dd>' + v + '</dd>';
    $('#totals').innerHTML = row('Setup subtotal', money(unresolved ? null : r.setup_subtotal_cents)) +
      (r.rush_cents ? row('Rush (ADD-RUSH)', money(r.rush_cents)) : '') +
      (r.discount_cents ? row('Founding discount', '<span dir="ltr" class="num">−' + esc(moneyText(r.discount_cents)) + '</span>') : '') +
      row('Setup total', money(unresolved ? null : r.setup_cents), 'grand') +
      row('Deposit (' + ((PB.rules || {}).deposit_pct || 50) + '%)', money(unresolved ? null : r.deposit_cents)) +
      row('Before go-live', money(unresolved ? null : r.final_cents)) +
      row('Monthly from go-live', money(unresolved ? null : r.monthly_cents), 'grand');
    $('#pErrs').innerHTML = c.errors.map(e => '<li>' + esc(PERR(e)) + '</li>').join('');
    const mb = $('#manualBox');
    if (c.needed) {
      const had = $('#manualOk') && $('#manualOk').checked;
      mb.innerHTML = '<div class="notice" role="note"><div><b>Manual pricing (needs_manual_price)</b><ul>' + c.reasons.map(x => '<li>' + esc(REASON(x)) + '</li>').join('') + '</ul>' +
        (c.unresolved.length ? '<p>The marked lines have no price. You cannot send until they are filled in.</p>' : '') +
        '<label class="check"><input type="checkbox" id="manualOk"' + (had || ED.confirmed ? ' checked' : '') + '> I checked the manual pricing and approve it</label></div></div>';
      $('#manualOk').addEventListener('change', e => { ED.confirmed = e.target.checked; });
    } else { mb.innerHTML = ''; ED.confirmed = false; }
    return c;
  }

  async function saveQuote(q, andSend) {
    const c = drawTotals(), r = c.r;
    const em = $('#eMsg'); em.innerHTML = '';
    if (c.errors.length) { em.innerHTML = msg('Some lines have errors. Fix them before saving.'); return; }
    const link = $('#payLink').value.trim();
    if (link && !/^https:\/\//.test(link)) { em.innerHTML = msg(ERR.pay_link_https); $('#payLink').focus(); return; }
    const unresolved = c.unresolved.length > 0;
    if (andSend) {
      if (unresolved) { em.innerHTML = msg('A manual price is missing on one or more lines. Cannot send.'); return; }
      if (c.needed && !ED.confirmed) { em.innerHTML = msg('Before sending, tick "I checked the manual pricing".'); return; }
      const v = P.validateItems(PB, ED.lines, { discount_code: ED.discount, manual_approved: !!ED.confirmed });
      if (!v.ok) { em.innerHTML = msg('The server will block this send: ' + v.blockers.map(PERR).join(' · ')); return; }
    }
    const patch = {
      items: P.storedItems(r), discount_code: ED.discount,
      setup_cents: unresolved ? null : r.setup_cents, monthly_cents: unresolved ? null : r.monthly_cents, deposit_cents: unresolved ? null : r.deposit_cents,
      scope_md: $('#scope').value, assumptions: $('#assum').value.split('\n').map(x => x.trim()).filter(Boolean), timeline_text: $('#timeline').value.trim() || null,
      pay_method: $('#payMethod').value || null, pay_link: link || null,
      status: c.needed ? 'needs_manual_price' : 'draft'
    };
    if (q.status === 'approved' && !c.needed) delete patch.status;
    const bs = $$('.btnrow .btn', $('#detail')); bs.forEach(b => { b.disabled = true; });
    try {
      await AB.adminSaveQuote(q.id, patch);
      if (andSend) {
        if (!confirm('Send the quote to ' + company(q.user_id) + '? ' + moneyText(r.setup_cents) + ' setup + ' + moneyText(r.monthly_cents) + ' per month.')) { await refresh(); return; }
        // quote-send Edge Function (A6): re-prices with the same module, approved -> sent, emits the quote_sent e-mail event
        await AB.quoteSend(q.id, { discount_code: ED.discount, pay_method: patch.pay_method, pay_link: patch.pay_link || '', manual_approved: !!ED.confirmed });
        ED = null; await refresh(); toast('Quote approved and sent to the client.');
      } else { await refresh(); toast('Draft saved.'); }
    } catch (e) { em.innerHTML = msg(errText(e)); bs.forEach(b => { b.disabled = false; }); }
  }
  async function voidQuote(q) {
    if (!confirm('Void this quote? This cannot be undone.')) return;
    try { await AB.adminSaveQuote(q.id, { status: 'void' }); ED = null; await refresh(); toast('Quote voided.'); } catch (e) { toast(errText(e)); }
  }
  function frozenQuote(q) {
    const items = q.items || [];
    const cl = clientOfQuote(q.id);
    const pm = payLabel(q.pay_method || payDefault());
    if (q.anonymized) return '<div class="notice notice--err" role="note"><div>This quote was anonymized (retention policy). It cannot be edited or sent; it is kept for bookkeeping only.</div></div>' +
      '<dl class="totals spaced"><dt class="grand">Setup total</dt><dd>' + money(q.setup_cents) + '</dd><dt class="grand">Monthly</dt><dd>' + money(q.monthly_cents) + '</dd></dl>';
    return '<p class="muted">This quote was ' + (q.status === 'void' ? 'voided' : 'sent') + '. Lines and amounts are locked; to change them, void it and send a new quote.</p>' +
      '<ul class="lines">' + items.map(it => '<li class="line"><span class="line__name"><code dir="ltr">' + esc(it.code) + '</code><span dir="ltr" lang="en">' + esc(it.name || '') + (it.qty > 1 ? ' × ' + it.qty : '') + '</span></span>' +
        '<span class="line__amt"><span>Setup ' + money(it.setup_cents) + '</span><span>Monthly ' + money(it.monthly_cents) + '</span></span></li>').join('') + '</ul>' +
      '<dl class="totals">' + (q.discount_code ? '<dt>Discount</dt><dd dir="ltr">' + esc(q.discount_code) + '</dd>' : '') + '<dt class="grand">Setup total</dt><dd>' + money(q.setup_cents) + '</dd><dt>Deposit</dt><dd>' + money(q.deposit_cents) +
      '</dd><dt class="grand">Monthly</dt><dd>' + money(q.monthly_cents) + '</dd></dl>' +
      '<dl class="kv spaced"><dt>Payment method</dt><dd>' + esc(pm) + '</dd><dt>Payment link</dt><dd>' + (q.pay_link ? ltr(q.pay_link) : '<span class="muted">—</span>') + '</dd>' +
      (q.accepted_at ? '<dt>Accepted by</dt><dd>' + esc(q.accepted_name || '') + ' · ' + esc(fmtDate(q.accepted_at, true)) + '</dd>' : '') + '</dl>' +
      '<div class="btnrow">' + (q.public_token && q.status !== 'void' ? '<a class="btn btn--ghost" href="/quote/#t=' + encodeURIComponent(q.public_token) + '" target="_blank" rel="noopener">Client quote page</a>' : '') +
      (['sent', 'viewed'].includes(q.status) ? '<button type="button" class="btn btn--ghost" id="voidBtn">Void quote</button>' : '') +
      (q.status === 'accepted' ? (cl ? '<button type="button" class="btn btn--primary" id="toClient">Go to client</button>' : '<button type="button" class="btn btn--primary" id="mkClient">Open client</button>') : '') + '</div><div id="eMsg"></div>';
  }
  // quote_reviews (A6, admin only): why a manual price is needed, risk flags, questions for the client, what the sanitizer removed
  async function loadReview(q) {
    const box = $('#reviewBox'); if (!box) return;
    let r = null;
    try { r = await AB.adminGetQuoteReview(q.id); } catch (e) { box.innerHTML = msg(errText(e)); return; }
    if (!r || !box.isConnected) return;
    const list = (title, arr) => arr && arr.length ? '<h4>' + esc(title) + '</h4><ul class="sum" dir="auto">' + arr.map(x => '<li><div class="a" dir="auto">' + esc(typeof x === 'string' ? x : JSON.stringify(x)) + '</div></li>').join('') + '</ul>' : '';
    const body = list('Why manual pricing', r.manual_reasons) + list('Risk flags', r.risk_flags) + list('Questions for the client', r.questions_for_client) + list('Removed from Claude\'s text', r.removed);
    box.innerHTML = '<section class="card review" aria-labelledby="rvH"><h3 id="rvH">Draft review (only you see this)</h3>' +
      (body || '<p class="muted">No notes from the engine.</p>') + (r.model ? '<p class="muted small">Model: <span dir="ltr">' + esc(r.model) + '</span></p>' : '') + '</section>';
  }
  function wireFrozen(q) {
    const v = $('#voidBtn'); if (v) v.addEventListener('click', () => voidQuote(q));
    const t = $('#toClient'); if (t) t.addEventListener('click', () => go('clients', clientOfQuote(q.id).id));
    const m = $('#mkClient');
    if (m) m.addEventListener('click', async () => {
      m.disabled = true;
      try { const c = await AB.adminCreateClientFromQuote(q.id); await refresh(); go('clients', c.id); } catch (e) { $('#eMsg').innerHTML = msg(errText(e)); m.disabled = false; }
    });
  }

  // ------------------------------------------------------------ Clients
  function tClients(p, keep) {
    const f = F.clients = F.clients || { st: '', term: '' };
    const filter = () => {
      f.st = $('#fSt').value; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.clients.filter(c => (!f.st || c.status === f.st) && (!f.term || clientName(c).toLowerCase().indexOf(f.term) !== -1));
      fillList(rows, c => '<span class="l1"><b>' + esc(clientName(c)) + '</b>' + pill('client', c.status) + '</span><span class="l2">' + '<bdi>' + esc((c.products || []).join(' + ')) + '</bdi> · monthly ' + money(c.monthly_cents) + '</span>', 'clients', 'No clients yet.');
    };
    if (!keep || !$('#fSt')) split(p, fsel('fSt', 'Status', [['', 'All statuses']].concat(Object.entries(ST.client)), f.st) + fsearch('fTerm', 'Search by business', f.term), filter);
    filter();
    clientDetail();
  }
  // payments made by card / PayPal checkout: PayPal ids on the row, the refund button for a deposit inside the price book's rule
  const refundDays = () => Number((((PB.refund_rules || {}).deposit || {}).window_days) || 7);
  const isPending = x => x.provider === 'paypal' && x.status === 'due' && !!x.provider_capture_id;
  function providerLine(x) {
    if (x.provider !== 'paypal') return '';
    const id = x.provider_capture_id ? ' · capture ID ' + ltr(x.provider_capture_id) : x.provider_order_id ? ' · open order ' + ltr(x.provider_order_id) : '';
    return '<br><span class="muted small">PayPal' + id + (x.payer_email ? ' · payer ' + ltr(x.payer_email) : '') + '</span>';
  }
  function refundCtl(x) {
    if (x.provider !== 'paypal' || x.kind !== 'deposit' || x.status !== 'paid' || !x.provider_capture_id) return '';
    const inWindow = x.paid_at && Date.now() - Date.parse(x.paid_at) <= refundDays() * 864e5;
    return inWindow ? '<button type="button" class="btn btn--ghost btn--sm" data-refund="' + esc(x.id) + '">Refund</button>'
      : '<span class="muted small">Over ' + refundDays() + ' days: refund only in PayPal</span>';
  }
  async function clientDetail() {
    const d = $('#detail');
    const c = sel && D.clients.find(x => x.id === sel);
    if (!c) { d.innerHTML = '<p class="muted">Pick a client from the list.</p>'; return; }
    const pays = D.payments.filter(x => x.client_id === c.id);
    const ob = D.onboarding.filter(x => x.client_id === c.id).sort((a, b) => a.sort - b.sort);
    const done = ob.filter(x => x.status === 'done').length;
    const t = D.tenants.find(x => x.client_id === c.id);
    const pr = prof(c.user_id);
    d.innerHTML = '<div class="row">' + pill('client', c.status) + '<span class="muted small">Client since ' + esc(fmtDate(c.created_at)) + (c.go_live_at ? ' · live since ' + esc(fmtDate(c.go_live_at)) : '') + '</span></div>' +
      '<h2>' + esc(clientName(c)) + '</h2>' +
      '<dl class="kv"><dt>Products</dt><dd dir="ltr">' + esc((c.products || []).join(' + ')) + '</dd><dt>Monthly</dt><dd>' + money(c.monthly_cents) + '</dd><dt>Next bill</dt><dd>' + esc(c.next_bill_on ? fmtDate(c.next_bill_on) : '—') +
      '</dd><dt>Email</dt><dd>' + ltr(pr.email || '') + '</dd><dt>Update language</dt><dd>' + esc(pr.update_lang === 'he' ? 'Hebrew' : 'English') + '</dd></dl>' +
      '<h3>Status</h3><div class="addrow"><label class="sr-only" for="cSt">Client status</label><select class="select" id="cSt">' + Object.entries(ST.client).map(([v, l]) => opt(v, l, c.status)).join('') +
      '</select><button type="button" class="btn btn--ghost" id="cStSave">Save status</button></div>' +
      '<p class="muted small">testing emails the client "ready_to_test", live emails "went_live".</p>' +
      '<h3>Payments</h3>' + (pays.length ? '<ul class="plist">' + pays.map(x => '<li><span class="grow"><b>' + esc(ST.kind[x.kind] || x.kind) + '</b> ' + money(x.amount_cents) +
        '<br><span class="muted small">' + (x.paid_at ? 'Paid ' + esc(fmtDate(x.paid_at)) : 'Created ' + esc(fmtDate(x.created_at))) + (x.reference ? ' · reference ' + ltr(x.reference) : '') + '</span>' +
        providerLine(x) + '</span>' + (isPending(x) ? '<span class="pill pill--pending">Processing in PayPal</span>' : pill('pay', x.status)) +
        (x.status === 'due' ? '<label class="sr-only" for="ref-' + esc(x.id) + '">Reference</label><input class="input" dir="ltr" id="ref-' + esc(x.id) + '" placeholder="Reference (optional)" maxlength="300">' +
          '<button type="button" class="btn btn--primary btn--sm" data-pay="' + esc(x.id) + '">Mark paid</button>' : '') + refundCtl(x) + '</li>').join('') + '</ul>' : '<p class="muted">No payments recorded.</p>') +
      '<h3>Onboarding checklist</h3>' + (ob.length ? '<p class="small">' + done + ' of ' + ob.length + ' done</p><div class="bar" role="progressbar" aria-label="Checklist progress" aria-valuemin="0" aria-valuemax="' + ob.length + '" aria-valuenow="' + done + '"><i style="width:' + Math.round(done / ob.length * 100) + '%"></i></div>' +
        '<ul class="plist">' + ob.map(o => '<li><span class="grow" dir="ltr" lang="en">' + esc(o.title) + '</span>' + pill('ob', o.status) + '</li>').join('') + '</ul>' : '<p class="muted">The checklist is not open yet (task B7).</p>') +
      '<h3>Tenant</h3><div id="tenantBox">' + (t ? '' : '<p class="muted">No tenant yet.</p>') + '</div>' +
      (c.quote_id ? '<div class="btnrow"><button type="button" class="btn btn--ghost" id="toQuote">Go to client quote</button></div>' : '') +
      notesBox('client', c.id);
    focusDetail();
    $('#cStSave').addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await AB.adminSaveClient(c.id, { status: $('#cSt').value }); await refresh(); toast('Status saved.'); } catch (er) { toast(errText(er)); b.disabled = false; }
    });
    $$('[data-pay]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await AB.adminMarkPaid(b.dataset.pay, ($('#ref-' + b.dataset.pay) || {}).value || ''); await refresh(); toast('Payment marked paid.'); } catch (e) { toast(errText(e)); b.disabled = false; }
    }));
    // PayPal deposit refund (pay-refund): full amount, within the price book's deposit rule, confirmed first
    $$('[data-refund]').forEach(b => b.addEventListener('click', async () => {
      const x = pays.find(p => p.id === b.dataset.refund); if (!x) return;
      const checklistDone = ob.length > 0 && ob.every(o => o.status === 'done' || o.key === 'tools');
      if (!confirm('Refund the full deposit (' + moneyText(x.amount_cents) + ') to ' + clientName(c) + ' through PayPal?\n' +
        'The money goes back to the client\'s card or PayPal account, and this cannot be undone.' +
        (checklistDone ? '\nNote: the client already finished the checklist, so by the rule a refund is not required.' : ''))) return;
      b.disabled = true;
      try { await AB.adminRefundPayment(x.id); await refresh(); toast('Deposit refunded in PayPal.'); } catch (e) { toast(errText(e)); b.disabled = false; }
    }));
    const tq = $('#toQuote'); if (tq) tq.addEventListener('click', () => go('quotes', c.quote_id));
    if (t) tenantSummary(t);
    wireNotes();
  }
  async function tenantSummary(t) {
    const cfg = t.config || {}, b = cfg.business || {};
    const days = Object.entries(cfg.hours || {}).filter(([, v]) => Array.isArray(v)).map(([k]) => k).join(' ');
    let state = [];
    const box = $('#tenantBox');
    try { state = await AB.adminRuntimeState(t.id); } catch (e) { state = []; }
    if (!box || !box.isConnected) return;
    const usage = (state.find(r => /^usage:/.test(r.key)) || {}).value;
    const spend = (state.find(r => /^spend:/.test(r.key)) || {}).value;
    const inc = (PB.rules || {}).included_usage || {};
    const pctOf = (v, m) => m ? Math.round(v / m * 100) + '%' : '';
    box.innerHTML = '<dl class="kv"><dt>slug</dt><dd>' + ltr(t.slug) + '</dd><dt>Status</dt><dd>' + pill('tenant', t.status) + '</dd><dt>Number</dt><dd>' + ltr(t.twilio_number || '—') + '</dd>' +
      '<dt>Business name</dt><dd dir="ltr">' + esc(b.name || '—') + '</dd><dt>Time zone</dt><dd>' + ltr(b.timezone || '—') + '</dd><dt>Open days</dt><dd dir="ltr">' + esc(days || '—') + '</dd>' +
      '<dt>After hours</dt><dd dir="ltr">' + esc((cfg.after_hours || {}).mode || '—') + '</dd><dt>Calendar</dt><dd dir="ltr">' + esc((cfg.booking || {}).provider || '—') + '</dd>' +
      '<dt>FAQs</dt><dd>' + ((cfg.faq || []).length) + '</dd><dt>Prices on calls</dt><dd dir="ltr">' + esc((cfg.pricing || {}).mode || '—') + '</dd>' +
      '<dt>AI paused</dt><dd>' + (cfg.paused ? 'Yes' : 'No') + '</dd></dl>' +
      (usage ? '<h3>Usage this month (runtime_state)</h3><dl class="kv"><dt>Voice minutes</dt><dd><span dir="ltr">' + esc(usage.voice_minutes || 0) + ' / ' + esc(inc.voice_minutes || '') + '</span> ' + esc(pctOf(usage.voice_minutes || 0, inc.voice_minutes)) + '</dd>' +
        '<dt>SMS segments</dt><dd><span dir="ltr">' + esc(usage.sms_segments || 0) + ' / ' + esc(inc.sms_segments || '') + '</span> ' + esc(pctOf(usage.sms_segments || 0, inc.sms_segments)) + '</dd>' +
        (usage.calls != null ? '<dt>Calls</dt><dd>' + esc(usage.calls) + '</dd>' : '') + (usage.bookings != null ? '<dt>Bookings</dt><dd>' + esc(usage.bookings) + '</dd>' : '') +
        (spend ? '<dt>Claude cost today</dt><dd>' + money(Math.round((spend.usd || 0) * 100)) + '</dd>' : '') + '</dl>'
        : '<p class="muted small">No usage data (runtime_state is readable only by the runtime; the demo shows sample data).</p>');
  }

  // ------------------------------------------------------------ Retainer queue
  function tRequests(p) {
    const f = F.req = F.req || { st: 'open', client: '' };
    const clients = D.clients.filter(c => D.requests.some(r => r.client_id === c.id));
    p.innerHTML = '<div class="filters">' + fsel('fSt', 'Status', [['open', 'Open'], ['', 'All']].concat(Object.entries(ST.req)), f.st) +
      fsel('fClient', 'Client', [['', 'All clients']].concat(clients.map(c => [c.id, clientName(c)])), f.client) + '</div>' +
      '<p class="muted small">One active request per client; the rest wait in the queue in the order the client set.</p><div id="reqList"></div>';
    const order = { active: 0, waiting_on_you: 1, queued: 2, done: 3, declined: 4 };
    const draw = () => {
      f.st = $('#fSt').value; f.client = $('#fClient').value;
      const rows = D.requests.filter(r => (f.st === 'open' ? ['queued', 'active', 'waiting_on_you'].includes(r.status) : !f.st || r.status === f.st) && (!f.client || r.client_id === f.client))
        .sort((a, b) => clientName(D.clients.find(c => c.id === a.client_id)).localeCompare(clientName(D.clients.find(c => c.id === b.client_id))) || order[a.status] - order[b.status] || a.position - b.position);
      $('#reqList').innerHTML = rows.length ? rows.map(r => {
        const c = D.clients.find(x => x.id === r.client_id);
        return '<article class="req" aria-labelledby="rq-' + esc(r.id) + '"><div class="req__h"><b id="rq-' + esc(r.id) + '" dir="auto">' + esc(r.title) + '</b>' + pill('req', r.status) +
          (r.paused ? '<span class="pill pill--paused" id="rp-' + esc(r.id) + '">Paused by client</span>' : '') + '</div>' +
          (r.paused ? '<p class="small muted">The client paused this request: it cannot be made active until the client resumes it.</p>' : '') +
          '<p class="muted small">' + esc(clientName(c)) + ' · queue position ' + (r.position + 1) + ' · updated ' + esc(fmtDate(r.updated_at, true)) + '</p>' + (r.body ? '<p dir="auto">' + esc(r.body) + '</p>' : '') +
          '<div class="row2"><div class="field"><label for="rs-' + esc(r.id) + '">Status</label><select class="select" id="rs-' + esc(r.id) + '">' + Object.entries(ST.req).map(([v, l]) => opt(v, l, r.status)).join('') + '</select></div>' +
          '<div class="field"><label for="ra-' + esc(r.id) + '">Reply to client (the client sees this)</label><textarea class="textarea ltr" dir="ltr" lang="en" id="ra-' + esc(r.id) + '" maxlength="10000">' + esc(r.admin_reply || '') + '</textarea></div></div>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-rsave="' + esc(r.id) + '">Save</button></article>';
      }).join('') : '<p class="empty">No requests match this filter.</p>';
      $$('[data-rsave]').forEach(b => b.addEventListener('click', async () => {
        const id = b.dataset.rsave; b.disabled = true;
        const rq = D.requests.find(x => x.id === id);
        if (rq && rq.paused && $('#rs-' + id).value === 'active') { toast(ERR.request_paused); b.disabled = false; return; }
        try { await AB.adminSaveRequest(id, { status: $('#rs-' + id).value, admin_reply: $('#ra-' + id).value.trim() || null }); await reload(); renderDigest(); draw(); toast('Request updated.'); }
        catch (e) { toast(errText(e)); b.disabled = false; }
      }));
    };
    $('#fSt').addEventListener('change', draw); $('#fClient').addEventListener('change', draw);
    draw();
  }

  // ------------------------------------------------------------ Tenants (B7: admin-tenants.js; the placeholder below is only a fallback)
  function tTenants(p) {
    if (window.AdminTenants && window.TenantSchema) {
      window.AdminTenants.render(p, { D, AB, PB, BRAND, ST, sel, $, $$, esc, pill, money, moneyText, ltr, opt, fmtDate, toast, errText, go, refresh, clientName, prof, focusDetail });
      return;
    }
    p.innerHTML = '<div class="notice" role="note"><div>The tenant JSON editor (validated against tenant_schema.json) and the "Run 20 simulator scenarios" button come with task B7. Until then: a read-only summary on the client page.</div></div>' +
      (D.tenants.length ? '<ul class="plist spaced">' + D.tenants.map(t => '<li><span class="grow"><b dir="ltr">' + esc(t.slug) + '</b> · ' + esc(clientName(D.clients.find(c => c.id === t.client_id))) + '</span>' +
        pill('tenant', t.status) + '<span dir="ltr">' + esc(t.twilio_number || '') + '</span><button type="button" class="btn btn--ghost btn--sm" data-tc="' + esc(t.client_id) + '">Go to client</button></li>').join('') + '</ul>' : '<p class="empty spaced">No tenants yet.</p>');
    $$('[data-tc]', p).forEach(b => b.addEventListener('click', () => go('clients', b.dataset.tc)));
  }

  // ------------------------------------------------------------ Subscriptions (FirstRing monthly plans: admin-subscriptions.js)
  function tSubs(p) {
    if (window.AdminSubscriptions) { window.AdminSubscriptions.render(p, { AB, PB, $, $$, esc, pill, moneyText, fmtDate, toast, errText, go }); return; }
    p.innerHTML = '<p class="empty">admin-subscriptions.js did not load.</p>';
  }

  // ------------------------------------------------------------ Log
  function tEvents(p) {
    const f = F.ev = F.ev || { ent: '' };
    const ents = Array.from(new Set(D.events.map(e => e.entity)));
    p.innerHTML = '<div class="filters">' + fsel('fEnt', 'Type', [['', 'All events']].concat(ents.map(e => [e, ENT[e] || e])), f.ent) + '</div><ul class="ev" id="evList"></ul>';
    const draw = () => {
      f.ent = $('#fEnt').value;
      const rows = D.events.filter(e => !f.ent || e.entity === f.ent);
      $('#evList').innerHTML = rows.length ? rows.map(e => {
        const who = /^admin/.test(e.actor) ? 'you' : /^client/.test(e.actor) ? 'client' : e.actor === 'runtime' ? 'runtime' : 'system';
        const pl = e.payload || {};
        const st = pl.to ? ' → ' + ((ST[e.entity === 'questionnaire' ? 'q' : e.entity === 'request' ? 'req' : e.entity] || {})[pl.to] || pl.to) : '';
        const subj = e.user_id ? ' · ' + company(e.user_id) : '';
        return '<li><time datetime="' + esc(e.created_at) + '">' + esc(fmtDate(e.created_at, true)) + '</time><span>' + esc(ENT[e.entity] || e.entity) + ': ' + esc(evtLabel(e.type)) + (pl.template ? ' <bdi dir="ltr">' + esc(pl.template) + '</bdi>' : '') + esc(st) + esc(subj) +
          ' <span class="muted">(' + esc(who) + ')</span></span></li>';
      }).join('') : '<li class="empty">The log is empty.</li>';
    };
    $('#fEnt').addEventListener('change', draw);
    draw();
  }

  // ------------------------------------------------------------ Settings (read-only)
  async function tSettings(p) {
    const r = PB.rules || {}, fd = (r.discounts || {}).FOUNDING || {};
    const onoff = v => v ? '<span class="pill pill--live">On</span>' : '<span class="pill pill--draft">Off</span>';
    p.innerHTML = '<div class="notice" role="note"><div><b>Read-only.</b> These settings are set in config/brand.json and the price book config/pricebook.json (synced by tools/sync_config.py), not here. ' +
      'Client emails (client_emails_enabled) are controlled in private.settings in the database.</div></div>' +
      '<div class="card spaced"><h2>Flags</h2><dl class="kv">' +
      '<dt>Show founder price (show_founder_price)</dt><dd>' + onoff(BRAND.show_founder_price) + '</dd>' +
      '<dt>Final legal documents (legal_final)</dt><dd>' + onoff(BRAND.legal_final) + '</dd>' +
      '<dt>Agreement version</dt><dd>' + ltr(BRAND.agreement_version || '') + '</dd>' +
      '<dt>Quote time promised to the client</dt><dd dir="ltr" lang="en">' + esc(BRAND.quote_sla_text || '') + '</dd>' +
      '<dt>Admin report language</dt><dd>' + esc(((BRAND.owner || {}).admin_lang) === 'he' ? 'Hebrew' : ((BRAND.owner || {}).admin_lang) === 'en' ? 'English' : ((BRAND.owner || {}).admin_lang || '')) + '</dd>' +
      '<dt>Admin time zone</dt><dd>' + ltr((BRAND.owner || {}).timezone || '') + '</dd>' +
      '<dt>Claude model</dt><dd>' + ltr((BRAND.claude || {}).model || '') + '</dd>' +
      '<dt>Backend</dt><dd>' + ltr(AB.mode) + '</dd></dl></div>' +
      '<div class="card spaced"><h2>Price book rules</h2><dl class="kv">' +
      '<dt>Price book version</dt><dd>' + ltr((PB.version || '') + ' · ' + (PB.updated || '')) + '</dd>' +
      '<dt>Deposit</dt><dd>' + esc(r.deposit_pct) + '%</dd><dt>FOUNDING</dt><dd>' + esc(fd.setup_pct || 0) + '% off setup, up to ' + esc(fd.max_clients || 0) + ' clients (' + foundingUsed(null) + ' used)</dd>' +
      '<dt>Quote valid for</dt><dd>' + esc(r.quote_valid_days) + ' days</dd><dt>Manual pricing threshold</dt><dd>' + money(r.manual_price_setup_over_cents) + '</dd>' +
      '<dt>Included usage per month</dt><dd dir="ltr">' + esc(((r.included_usage || {}).voice_minutes || '') + ' min · ' + ((r.included_usage || {}).sms_segments || '') + ' SMS') + '</dd>' +
      '<dt>Overage (overage_policy)</dt><dd>' + (r.overage_policy === 'no_auto_billing_alert_80_100_addon_with_approval'
        ? 'No automatic billing for overage. The client is alerted at 80% and 100%; an extra usage pack (ADD-USAGE) only with the client\'s approval.' : esc(r.overage_policy || '—')) +
        ' <span class="muted small" dir="ltr">' + esc(r.overage_policy || '') + '</span></dd></dl></div>' +
      '<div class="card spaced"><h2>Refund rules</h2>' + refundHtml() + '</div>' +
      (AB.mode === 'mock' ? '<div class="card spaced"><h2>Demo mailbox</h2><p class="muted small">Emails that would have been sent (A8 stub).</p><ul class="ev mailbox" id="outbox"></ul></div>' : '');
    if (AB.mode === 'mock') {
      try {
        const box = await AB.adminOutbox();
        if (!$('#outbox')) return;
        $('#outbox').innerHTML = box.slice(0, 30).map(m => '<li><time>' + esc(fmtDate(m.created_at, true)) + '</time><span><b dir="ltr">' + esc(m.template) + '</b> → ' + ltr(m.to || '') +
          (m.subject ? '<br><span dir="auto">' + esc(m.subject) + '</span>' : '') + '</span></li>').join('') || '<li class="empty">Empty.</li>';
      } catch (e) { /* mock only */ }
    }
  }

  function refundHtml() {
    const rr = PB.refund_rules || {}, dp = rr.deposit || {}, rt = rr.retainer || {}, g = rr.rcp_guarantee || {};
    if (!dp.refund_pct && !rt.refund_pct) return '<p class="muted">No refund rules in the config.</p>';
    return '<dl class="kv">' +
      (g.text ? '<dt>Satisfaction guarantee</dt><dd>Setup fee refunded if the client is not happy within ' + esc(rr.rcp_guarantee_days) + ' days of go-live, and the line is turned off. In a bundle only the receptionist part is refunded, and the client keeps the website. Monthly fees for time already used are not refunded (<bdi dir="ltr">' + esc((g.codes || []).join(', ')) + '</bdi>; website-only: just the deposit rule applies)' +
        '<br><span class="muted small" dir="ltr" lang="en">' + esc(g.text) + '</span></dd>' : '') +
      (dp.refund_pct != null ? '<dt>Setup deposit</dt><dd>' + esc(dp.refund_pct) + '% refund on request, within ' + esc(dp.window_days) + ' days of payment, as long as the checklist is not finished' +
        '<br><span class="muted small" dir="ltr" lang="en">' + esc(dp.text || '') + '</span></dd>' : '') +
      (rt.refund_pct != null ? '<dt>Retainer</dt><dd>' + esc(rt.refund_pct) + '% of the first payment if cancelled within ' + esc(rt.window_days) + ' days (<bdi dir="ltr">' + esc((rt.codes || []).join(', ')) + '</bdi>)' +
        '<br><span class="muted small" dir="ltr" lang="en">' + esc(rt.text || '') + '</span></dd>' : '') +
      '<dt>Status</dt><dd dir="ltr" lang="en">' + esc(rr.status || '') + '</dd></dl>';
  }

  // ------------------------------------------------------------ boot
  (async function boot() {
    await loadConfig();
    try { P = await import(vurl('/assets/pricing.mjs')); window.Pricing = P; }   // same module as the server; the mock uses it too
    catch (e) { app.innerHTML = '<h1>Admin</h1>' + msg('The pricing module did not load: ' + (e && e.message)); return; }
    if (AB.mode === 'off') { header(null); app.innerHTML = '<h1>Admin</h1>' + msg(ERR.backend_off); return; }
    try { await AB.ready(); } catch (e) { app.innerHTML = '<h1>Admin</h1>' + msg(errText(e)); return; }
    mockBar();
    let s = null;
    try { s = await AB.consumeLink(); } catch (e) { showLogin(errText(e)); return; }
    if (!s) s = await AB.getSession();
    if (!s) { showLogin(); return; }
    await afterSignIn(s);
  })();
})();
