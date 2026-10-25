/* /start/admin/ — owner admin (Hebrew, RTL). Only profiles.is_admin: anyone else is sent back to /start/.
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

  // ------------------------------------------------------------ labels (Hebrew UI; product names come from the price book)
  const TABS = [['leads', 'לידים'], ['questionnaires', 'שאלונים'], ['quotes', 'הצעות'], ['clients', 'לקוחות'], ['requests', 'תור ריטיינר'],
    ['tenants', 'Tenants'], ['events', 'יומן'], ['settings', 'הגדרות']];
  const ST = {
    q: { draft: 'טיוטה', submitted: 'הוגש', quoted: 'קיבל הצעה', closed: 'סגור' },
    quote: { draft: 'טיוטה', needs_manual_price: 'צריך תמחור ידני', approved: 'אושר', sent: 'נשלח', viewed: 'נצפה', accepted: 'התקבל', expired: 'פג תוקף', void: 'בוטל' },
    client: { onboarding: 'קליטה', building: 'בנייה', testing: 'בדיקות', live: 'באוויר', paused: 'מושהה', cancelled: 'בוטל' },
    pay: { due: 'לתשלום', paid: 'שולם', refunded: 'הוחזר' },
    kind: { deposit: 'מקדמה', final: 'תשלום לפני עלייה לאוויר', monthly: 'חודשי', overage: 'שימוש נוסף' },
    req: { queued: 'בתור', active: 'פעילה', waiting_on_you: 'ממתינה ללקוח', done: 'הושלמה', declined: 'נדחתה' },
    ob: { todo: 'לביצוע', done: 'בוצע', need_help: 'צריך עזרה' },
    tenant: { sandbox: 'ארגז חול', live: 'באוויר', paused: 'מושהה' }
  };
  // The first method is preselected for a quote without one: card / PayPal checkout while brand.json payments.paypal is on,
  // else Upwork Direct Contracts. Same default as quote-draft / quote-send and the quote page (defaultPayMethod in
  // /assets/quote_view.mjs; tools/e2e_admin.mjs checks they match). The other methods stay selectable.
  const PAY_PAYPAL = ['paypal_checkout', 'PayPal – כפתור בדף ההצעה'];
  const PAY_BASE = [['upwork', 'Upwork (Direct Contract)'], ['paypal_link', 'קישור PayPal'], ['wire', 'העברה בנקאית'], ['tranzila_link', 'קישור טרנזילה']];
  const ppOn = () => { const p = BRAND.payments && BRAND.payments.paypal; return !!(p && p.enabled === true && /^[A-Za-z0-9_-]{16,128}$/.test(p.client_id || '')); };
  // while PayPal is off it is listed only for a quote that already stores it (quote-send then refuses it: paypal_off)
  const payMethods = cur => ppOn() ? [PAY_PAYPAL].concat(PAY_BASE) : cur === PAY_PAYPAL[0] ? PAY_BASE.concat([PAY_PAYPAL]) : PAY_BASE;
  const payDefault = () => (ppOn() ? PAY_PAYPAL[0] : PAY_BASE[0][0]);
  const payLabel = v => (PAY_BASE.concat([PAY_PAYPAL]).find(x => x[0] === v) || [, v])[1];
  const ENT = { questionnaire: 'שאלון', quote: 'הצעה', client: 'לקוח', payment: 'תשלום', request: 'בקשה', tenant: 'Tenant', lead: 'ליד', onboarding_item: 'צ\'ק-ליסט', system: 'מערכת' };
  const EVT = { created: 'נוצר', status_changed: 'שינוי סטטוס', admin_edit: 'עריכה באדמין', draft_regenerated: 'טיוטה נוצרה מחדש',
    email_quote_sent: 'מייל ההצעה נשלח', payment_marked_paid: 'תשלום סומן כשולם', admin_note_saved: 'הערה פנימית נשמרה', admin_reply: 'תשובה ללקוח',
    payment_captured: 'תשלום התקבל ב-PayPal', payment_pending: 'תשלום PayPal בעיבוד', payment_refunded: 'תשלום הוחזר', paypal_alert: 'התראת PayPal',
    pay_method_changed: 'אמצעי התשלום שונה',
    q_submitted: 'שאלון הוגש', quote_sent: 'הצעה נשלחה', email_requested: 'נשלחה בקשת מייל', settings_updated: 'הלקוח עדכן הגדרות',
    need_help: 'הלקוח ביקש עזרה', onboarding_updated: 'עדכון בצ\'ק-ליסט', retention_error: 'שגיאה במחיקה לפי מדיניות שמירה', retention_run: 'הרצת מחיקה לפי מדיניות שמירה',
    'alert.pending': 'התראה ממתינה', 'booking.cancelled': 'הזמנה בוטלה', 'calendar.connected': 'יומן חובר', 'calendar.reconnect_needed': 'צריך לחבר את היומן מחדש',
    'delivery.dead': 'משלוח נכשל סופית', 'email.outbox': 'מייל בתור', 'notify.admin_unset': 'אין מייל מנהל מוגדר', 'notify.failed': 'התראה נכשלה',
    'sms.incoming': 'SMS נכנס', 'sms.not_sent': 'SMS לא נשלח', 'sms.outbox': 'SMS בתור', 'sms.reminder': 'תזכורת SMS', 'sms.send_failed': 'שליחת SMS נכשלה',
    'sms.sent': 'SMS נשלח', 'sms.status': 'סטטוס SMS', 'sms.textback': 'SMS חזרה למתקשר', 'voice.call_cap': 'תקרת שיחות למספר', 'voice.fallback': 'מעבר למענה גיבוי',
    'voice.incoming': 'שיחה נכנסת', 'voice.latency': 'מדידת השהיה', 'voice.relay_failed': 'כשל בחיבור הקולי', 'zapier.dead_letter': 'Zapier נכשל סופית',
    'zapier.pending': 'Zapier בתור', 'zapier.sent': 'Zapier נשלח' };
  const EVT_PREFIX = { sms: 'SMS', voice: 'שיחה', calendar: 'יומן', zapier: 'Zapier', notify: 'התראה', email: 'מייל', booking: 'הזמנה', alert: 'התראה', delivery: 'משלוח' };
  // every event type gets Hebrew: known map, else "<area>: <type>" for runtime dotted types, else "אירוע מערכת"
  const evtLabel = t => EVT[t] || (t && t.indexOf('.') > 0 && EVT_PREFIX[t.split('.')[0]] ? EVT_PREFIX[t.split('.')[0]] + ': ' + t.split('.').slice(1).join('.') : 'אירוע מערכת (' + t + ')');
  const ERR = {
    not_admin: 'אין לך הרשאת ניהול.',
    not_authenticated: 'החיבור פג. צריך להתחבר מחדש.',
    backend_off: 'הבקאנד לא מוגדר (SITE_CONFIG).',
    quote_frozen_after_send: 'ההצעה כבר נשלחה, ולכן השורות והסכומים נעולים. כדי לשנות: מבטלים ומוציאים הצעה חדשה.',
    quote_amounts_missing: 'חסרים סכומים. קודם משלימים את התמחור הידני.',
    manual_price_required: 'צריך להשלים תמחור ידני לפני השליחה.',
    quote_not_approved: 'אפשר לשלוח רק הצעה מאושרת.',
    quote_already_accepted: 'הלקוח כבר אישר את ההצעה הזו.',
    quote_anonymized: 'ההצעה עברה אנונימיזציה ואי אפשר לשלוח אותה.',
    one_active_request: 'ללקוח הזה כבר יש בקשה פעילה. קודם מעבירים אותה לסטטוס אחר.',
    request_paused: 'הלקוח השהה את הבקשה הזו, ולכן אי אפשר להפעיל אותה.',
    requests_one_active: 'ללקוח הזה כבר יש בקשה פעילה. קודם מעבירים אותה לסטטוס אחר.',
    pay_link_https: 'קישור התשלום חייב להתחיל ב-https://',
    pay_link_check: 'קישור התשלום חייב להתחיל ב-https://',
    invalid_discount: 'קוד הנחה לא מוכר.',
    questionnaire_not_submitted: 'השאלון עוד לא הוגש.',
    quote_not_accepted: 'אפשר לפתוח כרטיס לקוח רק אחרי שהלקוח אישר את ההצעה.',
    mock_no_file_storage: 'במצב דמו נשמר רק שם הקובץ, לא הקובץ עצמו.',
    'Token has expired or is invalid': 'הקוד שגוי או שפג תוקפו.',
    needs_manual_price: 'יש שורות שדורשות מחיר ידני (או אישור תמחור ידני). אי אפשר לשלוח עדיין.',
    bad_pay_link: 'קישור התשלום חייב להתחיל ב-https://',
    quote_not_sendable: 'ההצעה כבר לא בסטטוס שאפשר לשלוח ממנו.',
    send_blocked: 'השליחה נחסמה: הסכומים השמורים לא תואמים לחישוב מחדש. לשמור טיוטה ולנסות שוב.',
    pricing_failed: 'החישוב נכשל: יש קוד שלא מתאים למחירון.',
    quote_not_found: 'ההצעה לא נמצאה.',
    forbidden: 'אין לך הרשאת ניהול.',
    founding_limit_reached: 'תקרת הלקוחות המייסדים (FOUNDING) כבר נוצלה. השרת חסם את השליחה עם ההנחה.',
    // card / PayPal checkout (quote-send, pay-refund)
    paypal_off: 'תשלום בכרטיס דרך PayPal כבוי כרגע (או שהמפתחות עוד לא הוגדרו). לבחור אמצעי תשלום אחר.',
    refund_window_passed: 'עברו יותר מ-7 ימים מהתשלום, אז הכפתור לא מחזיר. אם בכל זאת צריך להחזיר: מתוך PayPal עצמו (Activity ← Refund).',
    not_paypal: 'זה לא תשלום שעבר דרך כפתור ה-PayPal, אז אין מה להחזיר מכאן.',
    not_paid: 'התשלום לא במצב "שולם", אז אין מה להחזיר.',
    not_deposit: 'הכפתור מחזיר רק מקדמה. החזר אחר: מתוך PayPal עצמו.',
    paypal_refund_failed: 'PayPal סירב להחזר. לבדוק ב-PayPal ← Activity, ולהעביר לקלוד אם לא ברור.',
    paypal_unreachable: 'אין חיבור ל-PayPal כרגע. לנסות שוב בעוד כמה דקות.',
    paypal_error: 'PayPal החזיר שגיאה. לנסות שוב, ואם חוזר: להעביר לקלוד.'
  };
  function errText(e) {
    const m = (e && (e.code || e.message || e.msg)) || String(e || '');
    for (const k in ERR) if (m.indexOf(k) !== -1) return ERR[k];
    if (/Failed to fetch|NetworkError/i.test(m)) return 'אין חיבור לשרת. לבדוק את החיבור ולנסות שוב.';
    return 'משהו השתבש: ' + m;
  }

  // ------------------------------------------------------------ formatting
  const money = c => c == null ? '<span class="muted">—</span>' : '<span class="num" dir="ltr">' + esc(moneyText(c)) + '</span>';
  const moneyText = c => c == null ? '—' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const ltr = s => '<span dir="ltr" class="ltr">' + esc(s) + '</span>';
  function fmtDate(iso, withTime) {
    if (!iso) return '';
    try {
      const o = { day: 'numeric', month: 'numeric', year: '2-digit' };
      if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
      const tz = BRAND.owner && BRAND.owner.timezone; if (tz) o.timeZone = tz;
      return new Intl.DateTimeFormat('he-IL', o).format(new Date(iso));
    } catch (e) { return String(iso).slice(0, 10); }
  }
  const pill = (group, s) => '<span class="pill pill--' + esc(s) + '">' + esc((ST[group] && ST[group][s]) || s) + '</span>';
  const prof = uid => D.profiles.find(p => p.id === uid) || {};
  const company = uid => { const p = prof(uid); return p.company || p.full_name || p.email || 'ללא שם'; };
  const clientName = c => c ? (c.business_name || company(c.user_id)) : '';
  const itemOf = code => (PB.items || []).find(i => i.code === code);
  const offerLabel = code => code === 'UNSURE' ? 'לא בטוח — לבקש המלצה' : ((itemOf(code) || {}).name || code || '—');
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
  async function loadConfig() {
    const get = async u => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error('config ' + r.status); return r.json(); };
    try { [BRAND, PB] = await Promise.all([get('/assets/brand.json'), get('/assets/pricebook.json')]); } catch (e) { BRAND = {}; PB = {}; }
    PB._niches = (BRAND.niches || []).map(n => ({ key: n.key, label: n.label, early: n.status === 'early_access' }));
    window.ADMIN_PB = PB; window.ADMIN_BRAND = BRAND;   // the mock adapter prices drafts with the same config
    $('#brandName').textContent = BRAND.name || '';
    document.title = 'ניהול' + (BRAND.name ? ' · ' + BRAND.name : '');
    $('#footer').innerHTML = '<bdi>' + esc(BRAND.name || '') + '</bdi> · <bdi dir="ltr">' + esc((BRAND.disclaimers && BRAND.disclaimers.footer) || '') + '</bdi>';
  }

  // ------------------------------------------------------------ header + sign in
  function header(session) {
    const nav = $('#navlinks');
    nav.innerHTML = session ? '<a href="/start/">הפורטל</a><span class="who" dir="ltr">' + esc(session.user.email) + '</span>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="logoutBtn">יציאה</button>' : '<a href="/">לאתר</a>';
    const b = $('#logoutBtn'); if (b) b.addEventListener('click', async () => { await AB.signOut(); location.href = '/start/admin/'; });
  }
  function mockBar() {
    if (AB.mode !== 'mock' || $('#mockBanner')) return;
    const b = document.createElement('div'); b.id = 'mockBanner'; b.className = 'mockbar'; b.setAttribute('role', 'note');
    b.textContent = 'מצב דמו: הנתונים נשמרים רק בדפדפן הזה, ושום מייל לא נשלח באמת.';
    document.body.insertBefore(b, document.body.firstChild);
  }

  function showLogin(err) {
    header(null);
    const demoHint = AB.mode === 'mock' ? '<p class="muted small">בדמו: מנהל = <span dir="ltr">' + esc((window.StartMock && window.StartMock.MOCK_ADMIN_EMAIL()) || '') + '</span>. כל מייל אחר הוא לקוח ויחזור לפורטל.</p>' : '';
    app.innerHTML = '<span class="eyebrow">ניהול</span><h1>כניסה לניהול</h1>' +
      '<div class="card login"><form id="emailForm" novalidate><div class="field"><label for="email">המייל שלך</label>' +
      '<input class="input ltr" dir="ltr" type="email" id="email" autocomplete="email" required></div>' +
      '<button class="btn btn--primary btn--block" type="submit" id="sendBtn">שלח לי קוד כניסה</button></form>' +
      '<form id="codeForm" novalidate hidden><div class="field"><label for="code">הקוד בן 6 הספרות מהמייל</label>' +
      '<input class="input code" dir="ltr" type="text" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>' +
      '<button class="btn btn--primary btn--block" type="submit" id="verifyBtn">כניסה</button></form>' +
      '<div id="mockInbox"></div><div id="loginMsg">' + msg(err) + '</div>' + demoHint + '</div>';
    let email = '';
    $('#emailForm').addEventListener('submit', async e => {
      e.preventDefault();
      email = $('#email').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('#loginMsg').innerHTML = msg('כתובת המייל לא תקינה.'); return; }
      try { await AB.sendCode(email); } catch (er) { $('#loginMsg').innerHTML = msg(errText(er)); return; }
      $('#emailForm').hidden = true; $('#codeForm').hidden = false; $('#code').focus();
      if (AB.mode === 'mock' && window.StartMock) {
        const m = window.StartMock.admin.inbox(email).filter(x => x.template === 'auth_code').pop();
        if (m) $('#mockInbox').innerHTML = '<div class="notice" role="note">תיבת דמו: הקוד הוא <span class="mono" id="mockCode" dir="ltr">' + esc(m.code) + '</span></div>';
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
    app.innerHTML = '<span class="eyebrow">ניהול</span><h1>מה מחכה לך היום</h1>' +
      '<section class="card digest" id="digest" aria-labelledby="dgH"></section>' +
      '<div class="tabs" role="tablist" aria-label="אזורי ניהול">' + TABS.map(([id, l]) =>
        '<button type="button" role="tab" id="tab-' + id + '" data-tab="' + id + '" aria-controls="panel" aria-selected="' + (id === tab) + '" tabindex="' + (id === tab ? 0 : -1) + '">' + esc(l) + '<span class="cnt" id="cnt-' + id + '"></span></button>').join('') +
      '</div><div id="panel" role="tabpanel" tabindex="-1"></div>';
    $$('.tabs [role=tab]').forEach(b => {
      b.addEventListener('click', () => go(b.dataset.tab));
      b.addEventListener('keydown', e => {
        const all = $$('.tabs [role=tab]'), i = all.indexOf(b);
        let n = null;
        if (e.key === 'ArrowLeft') n = all[(i + 1) % all.length];        // RTL: left = next
        if (e.key === 'ArrowRight') n = all[(i - 1 + all.length) % all.length];
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
    $('#digest').innerHTML = '<details id="digestDet"' + (wasOpen ? ' open' : '') + '><summary class="digest__head"><h2 id="dgH">תקציר יומי</h2><span class="muted small">' +
      (hot ? '<b class="digest__hot">' + hot + ' לטיפול</b> · ' : '') + esc(fmtDate(new Date().toISOString(), true)) + '</span></summary>' +
      '<ul class="digest__grid">' +
      tile(c.newLeads, 'לידים חדשים ב-24 שעות', 'leads') +
      tile(c.awaiting, 'שאלונים שמחכים להצעה', 'questionnaires', true) +
      tile(c.drafts, 'טיוטות לאישור', 'quotes', true) +
      tile(c.manual, 'צריך תמחור ידני', 'quotes', true) +
      tile(c.waiting, 'הצעות אצל לקוח', 'quotes') +
      tile(c.accepted, 'אישרו, צריך לפתוח לקוח', 'quotes', true) +
      tile(c.depositsDue, 'מקדמות שלא שולמו', 'clients') +
      '<li><button type="button" data-go="clients"><b>' + money(c.dueSum) + '</b>סה"כ פתוח לתשלום</button></li>' +
      tile(c.active + ' / ' + c.queued, 'בקשות פעילות / בתור', 'requests') +
      tile(c.needHelp, 'צריכים עזרה בצ\'ק-ליסט', 'clients', true) + '</ul>' +
      (AB.mode === 'mock' ? '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" id="seedBtn">טען נתוני דמו</button></div>' : '') + '</details>';
    $$('#digest [data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    const sb = $('#seedBtn');
    if (sb) sb.addEventListener('click', async () => {
      try { window.StartMock.admin.seedAdmin(PB); await reload(); renderDigest(); renderTab(); toast('נתוני הדמו נטענו.'); } catch (e) { toast(errText(e)); }
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
    ({ leads: tLeads, questionnaires: tQs, quotes: tQuotes, clients: tClients, requests: tRequests, tenants: tTenants, events: tEvents, settings: tSettings }[tab])(p, keepList);
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
    return '<h3>הערות פנימיות</h3><div class="field"><label for="notes">רק אתה רואה את זה. לא מוצג ללקוח בשום מסך או מייל.</label>' +
      '<textarea class="textarea" id="notes" maxlength="20000"></textarea></div><button type="button" class="btn btn--ghost btn--sm" id="notesSave" data-entity="' + entity + '" data-eid="' + esc(id) + '">שמירת הערה</button>';
  }
  async function wireNotes() {
    const b = $('#notesSave'); if (!b) return;
    const ta = $('#notes');
    try { const v = await AB.adminGetNote(b.dataset.entity, b.dataset.eid); if (ta.isConnected) ta.value = v; } catch (e) { /* no note yet */ }
    if (!b.isConnected) return;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await AB.adminSaveNote(b.dataset.entity, b.dataset.eid, $('#notes').value); toast('ההערה נשמרה.'); await reloadEvents(); }
      catch (e) { toast(errText(e)); }
      b.disabled = false;
    });
  }
  async function reloadEvents() { try { D.events = await AB.adminListEvents(300); } catch (e) { /* keep old */ } }

  // ------------------------------------------------------------ לידים
  function tLeads(p) {
    const f = F.leads = F.leads || { onlyNew: true, term: '' };
    p.innerHTML = '<div class="filters"><label class="check"><input type="checkbox" id="fOnly"' + (f.onlyNew ? ' checked' : '') + '> רק מי שלא התחיל שאלון</label>' +
      fsearch('fTerm', 'חיפוש לפי מייל או דף', f.term) + '</div><ul class="plist" id="leadList"></ul>';
    const draw = () => {
      f.onlyNew = $('#fOnly').checked; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.leads.filter(l => (!f.onlyNew || !startedLead(l)) && (!f.term || ((l.email || '') + ' ' + (l.source_page || '')).toLowerCase().indexOf(f.term) !== -1));
      $('#leadList').innerHTML = rows.length ? rows.map(l => {
        const st = startedLead(l);
        const utm = l.utm && Object.keys(l.utm).length ? Object.entries(l.utm).map(([k, v]) => k + '=' + v).join(' · ') : '';
        const extra = [l.name, l.company, l.offer].filter(Boolean).map(x => '<bdi>' + esc(x) + '</bdi>').join(' · ');
        return '<li><span class="grow"><b>' + ltr(l.email) + '</b>' + (extra ? ' · ' + extra : '') + '<br><span class="muted small">' + esc(nicheLabel(l.niche)) + ' · ' + ltr(l.source_page || '') +
          (utm ? ' · ' + ltr(utm) : '') + ' · ' + esc(fmtDate(l.created_at, true)) + '</span></span>' +
          '<span class="pill pill--' + (st ? 'done' : 'todo') + '">' + (st ? 'התחיל שאלון' : 'לא התחיל') + '</span>' +
          '<a class="btn btn--ghost btn--sm" href="mailto:' + esc(l.email) + '">מייל</a></li>';
      }).join('') : '<li class="empty">אין לידים בסינון הזה.</li>';
    };
    $('#fOnly').addEventListener('change', draw); $('#fTerm').addEventListener('input', draw);
    draw();
  }

  // ------------------------------------------------------------ שאלונים
  function tQs(p, keep) {
    const f = F.qs = F.qs || { st: '!draft', offer: '', niche: '', term: '' };
    const filter = () => {
      f.st = $('#fSt').value; f.offer = $('#fOffer').value; f.niche = $('#fNiche').value; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.qs.filter(q => (f.st === '!draft' ? q.status !== 'draft' : !f.st || q.status === f.st) && (!f.offer || q.offer === f.offer) &&
        (!f.niche || q.niche === f.niche) && (!f.term || [company(q.user_id), prof(q.user_id).email].join(' ').toLowerCase().indexOf(f.term) !== -1));
      fillList(rows, q => '<span class="l1"><b>' + esc(company(q.user_id)) + '</b>' + pill('q', q.status) + '</span><span class="l2">' + esc(offerLabel(q.offer)) + ' · ' +
        esc(nicheLabel(q.niche)) + ' · ' + esc(fmtDate(q.submitted_at || q.updated_at)) + '</span>', 'questionnaires', 'אין שאלונים בסינון הזה.');
    };
    if (!keep || !$('#fSt')) {
      split(p, fsel('fSt', 'סטטוס', [['!draft', 'כל מה שהוגש'], ['', 'כל הסטטוסים']].concat(Object.entries(ST.q)), f.st) +
        fsel('fOffer', 'מוצר', [['', 'כל המוצרים']].concat(((PB.rules || {}).core_codes || []).map(c => [c, offerLabel(c)]), [['UNSURE', offerLabel('UNSURE')]]), f.offer) +
        fsel('fNiche', 'נישה', [['', 'כל הנישות']].concat((BRAND.niches || []).map(n => [n.key, n.label])), f.niche) + fsearch('fTerm', 'חיפוש: עסק או מייל', f.term), filter);
    }
    filter();
    qDetail();
  }
  async function qDetail() {
    const d = $('#detail');
    const q = sel && D.qs.find(x => x.id === sel);
    if (!q) { d.innerHTML = '<p class="muted">בוחרים שאלון מהרשימה.</p>'; return; }
    const pr = prof(q.user_id);
    const summary = Array.isArray(q.summary) && q.summary.length ? q.summary : (Q ? Q.buildSummary(Object.assign({}, q.answers, { offer: q.offer, niche: q.niche }), PB) : []);
    const qt = liveQuoteOf(q.id);
    const kv = [['שם', esc(pr.full_name)], ['עסק', esc(pr.company)], ['מייל', ltr(pr.email)], ['טלפון', ltr(pr.phone)], ['עיר ומדינה', esc([pr.city, pr.state].filter(Boolean).join(', '))],
      ['אזור זמן', ltr(pr.timezone)], ['אתר', ltr(pr.website)], ['איך הגיע', esc(pr.how_heard)], ['שפת עדכונים', esc(pr.update_lang === 'he' ? 'עברית' : 'אנגלית')]];
    d.innerHTML = '<div class="row">' + pill('q', q.status) + '<span class="muted small">' + (q.submitted_at ? 'הוגש ' + esc(fmtDate(q.submitted_at, true)) : 'טיוטה, עודכן ' + esc(fmtDate(q.updated_at, true))) + '</span></div>' +
      '<h2>' + esc(company(q.user_id)) + '</h2><p class="muted">' + esc(offerLabel(q.offer)) + ' · ' + esc(nicheLabel(q.niche)) + '</p>' +
      '<div class="btnrow"><button type="button" class="btn btn--ghost" id="copyMd">העתק ל-Claude</button>' +
      (qt ? '<button type="button" class="btn btn--primary" id="openQuote">פתח את ההצעה (' + esc(ST.quote[qt.status] || qt.status) + ')</button>'
        : (q.status !== 'draft' ? '<button type="button" class="btn btn--primary" id="mkDraft">צור טיוטת הצעה</button>' : '')) + '</div><div id="copyBox"></div><div id="qMsg"></div>' +
      '<h3>הלקוח</h3><dl class="kv">' + kv.map(x => '<dt>' + x[0] + '</dt><dd>' + (x[1] || '<span class="muted">—</span>') + '</dd>').join('') + '</dl>' +
      '<h3>תשובות</h3><ul class="sum" dir="ltr" lang="en">' + summary.map(it => '<li><div class="q">' + esc(it.q) + '</div><div class="a' + ((it.a || '').trim() ? '' : ' none') + '">' + esc((it.a || '').trim() || '—') + '</div></li>').join('') + '</ul>' +
      '<h3>קבצים</h3><div id="files"><p class="muted">טוען…</p></div>' + notesBox('questionnaire', q.id);
    focusDetail();
    const filesEl = $('#files', d), copyBox = $('#copyBox', d);
    $('#copyMd', d).addEventListener('click', async () => {
      const md = '# Questionnaire: ' + company(q.user_id) + '\n\n- Offer: ' + (q.offer || '') + '\n- Niche: ' + (q.niche || '') + '\n- Submitted: ' + (q.submitted_at || '') +
        '\n- Contact: ' + [pr.full_name, pr.email, pr.phone, pr.city, pr.state, pr.timezone].filter(Boolean).join(' · ') + '\n\n## Answers\n\n' +
        summary.map(it => '**' + it.q + '**\n' + ((it.a || '').trim() || '—')).join('\n\n') + '\n';
      try { await navigator.clipboard.writeText(md); toast('הועתק. להדביק בשיחה עם Claude.'); }
      catch (e) { copyBox.innerHTML = '<div class="field"><label for="mdBox">להעתקה ידנית</label><textarea class="textarea tall ltr" dir="ltr" id="mdBox" readonly>' + esc(md) + '</textarea></div>'; $('#mdBox', copyBox).select(); }
    });
    // attachments load async: the detail may have been replaced meanwhile (e.g. "צור טיוטת הצעה" jumps to the quote)
    (async () => {
      let atts;
      try { atts = await AB.adminListAttachments(q.id); } catch (e) { if (filesEl.isConnected) filesEl.innerHTML = msg(errText(e)); return; }
      if (!filesEl.isConnected) return;
      filesEl.innerHTML = atts.length ? '<ul class="plist">' + atts.map((a, i) => '<li><span class="grow" dir="ltr">' + esc(a.filename) + '</span><button type="button" class="btn btn--ghost btn--sm" data-att="' + i + '">הורדה</button></li>').join('') + '</ul>' : '<p class="muted">אין קבצים.</p>';
      $$('[data-att]', filesEl).forEach(b => b.addEventListener('click', async () => {
        try { window.open(await AB.downloadUrl(atts[+b.dataset.att]), '_blank', 'noopener'); } catch (e) { toast(errText(e)); }
      }));
    })();
    const oq = $('#openQuote'); if (oq) oq.addEventListener('click', () => go('quotes', qt.id));
    const mk = $('#mkDraft');
    if (mk) mk.addEventListener('click', async () => {
      mk.disabled = true; $('#qMsg').innerHTML = msg('מכין טיוטה…', 'ok');
      try { const r = await AB.adminRegenerateDraft(q.id, PB); await refresh(); const nid = (r && (r.id || r.quote_id)) || (liveQuoteOf(q.id) || {}).id; if (nid) go('quotes', nid); }
      catch (e) { $('#qMsg').innerHTML = msg(errText(e)); mk.disabled = false; }
    });
    wireNotes();
  }

  // ------------------------------------------------------------ הצעות
  function tQuotes(p, keep) {
    const f = F.quotes = F.quotes || { st: 'open', term: '' };
    const OPEN = ['draft', 'needs_manual_price', 'approved'];
    const filter = () => {
      f.st = $('#fSt').value; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.quotes.filter(q => (f.st === 'open' ? OPEN.includes(q.status) : !f.st || q.status === f.st) &&
        (!f.term || company(q.user_id).toLowerCase().indexOf(f.term) !== -1));
      fillList(rows, q => '<span class="l1"><b>' + esc(company(q.user_id)) + '</b>' + pill('quote', q.status) + '</span><span class="l2">' +
        '<bdi>' + esc(((q.items || []).map(i => i.code).filter(c => c !== 'CUSTOM').join(' + ')) || '—') + '</bdi> · הקמה ' + money(q.setup_cents) + ' · חודשי ' + money(q.monthly_cents) + '</span>', 'quotes', 'אין הצעות בסינון הזה.');
    };
    if (!keep || !$('#fSt')) split(p, fsel('fSt', 'סטטוס', [['open', 'פתוחות (לטיפול שלך)'], ['', 'כל ההצעות']].concat(Object.entries(ST.quote)), f.st) + fsearch('fTerm', 'חיפוש לפי עסק', f.term), filter);
    filter();
    quoteDetail();
  }

  let ED = null;   // editor state of the open quote: {id, lines, discount, confirmed}
  function foundingUsed(exceptId) { return D.quotes.filter(q => q.id !== exceptId && q.discount_code === 'FOUNDING' && ['sent', 'viewed', 'accepted'].includes(q.status)).length; }
  const REASON = r => {
    const [k, c] = r.split(':');
    return ({ setup_over_threshold: 'הקמה מעל ' + moneyText((PB.rules || {}).manual_price_setup_over_cents) + ': לבדוק ידנית',
      custom: 'שורה מותאמת שדורשת מחיר ידני: ' + r.slice(7), from: c + ' מתומחר "החל מ", צריך מחיר סופי', fixed: c + ' בלי מחיר בטבלה, צריך מחיר ידני',
      later_offer: c + ' היא הצעה "בהמשך": לא מתומחרת אוטומטית, צריך לאשר את המחיר ידנית' })[k] || r;
  };
  const PERR = e => {
    const [k, c, d] = e.split(':');
    return ({ no_core_offer: 'חסר מוצר ליבה (' + ((PB.rules || {}).core_codes || []).join(' / ') + ').', more_than_one_core_offer: 'מותר מוצר ליבה אחד בלבד בהצעה.',
      unknown_code: 'קוד שלא קיים במחירון: ' + c, duplicate_code: 'הקוד ' + c + ' מופיע פעמיים.', bad_qty: 'כמות לא תקינה ב-' + c + ' (1 עד ' + (P ? P.MAX_QTY : '') + ').',
      core_qty: 'מוצר ליבה בכמות 1 בלבד.', addon_requires_core: 'התוספת ' + c + ' צריכה מוצר ליבה.', addon_not_applicable: 'התוספת ' + c + ' לא מתאימה ל-' + d + '.',
      already_included: c + ' כבר כלול ב-' + d + '.', percent_qty: 'דחוף בכמות 1 בלבד.', custom_without_label: 'שורה מותאמת בלי שם.',
      unknown_discount: 'קוד הנחה לא מוכר.', monthly_discount_not_allowed: 'אסור לתת הנחה על החודשי.' })[k] || e;
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
      if (have.has(it.code)) return false;
      if (cores.includes(it.code)) return !core;
      if (it.group === 'addon') return core ? P.addonApplies(PB, it, core) && !P.alreadyIncluded(core, it.code) : it.applies_to.includes('any');
      return true;   // 'later' offers (alone or with a core)
    }).map(it => it.code);
  }

  // first-touch source of the lead (questionnaires.utm, from the site's utm_* links; empty = unknown / direct)
  function utmLine(qn) {
    const u = qn && qn.utm;
    if (!u || !u.utm_source) return '';
    const parts = [u.utm_source, u.utm_medium, u.utm_campaign].filter(Boolean).map(esc).join(' / ');
    return '<p class="muted small">מקור הליד (הקליק הראשון): <span dir="ltr">' + parts + '</span>' + (u.landing_path ? ' · דף נחיתה <span dir="ltr">' + esc(u.landing_path) + '</span>' : '') + '</p>';
  }
  function quoteDetail() {
    const d = $('#detail');
    const q = sel && D.quotes.find(x => x.id === sel);
    if (!q) { d.innerHTML = '<p class="muted">בוחרים הצעה מהרשימה.</p>'; ED = null; return; }
    const frozen = !!q.anonymized || !!q.sent_at || ['sent', 'viewed', 'accepted', 'expired', 'void'].includes(q.status);
    if (!ED || ED.id !== q.id) ED = { id: q.id, lines: P.inputsFromStored(q.items || [], PB), discount: q.discount_code || null, confirmed: false };
    const qn = D.qs.find(x => x.id === q.questionnaire_id);
    const summary = qn ? (Array.isArray(qn.summary) && qn.summary.length ? qn.summary : (Q ? Q.buildSummary(Object.assign({}, qn.answers, { offer: qn.offer, niche: qn.niche }), PB) : [])) : [];
    const answers = '<details class="card" open><summary><b>התשובות של הלקוח</b></summary><ul class="sum" dir="ltr" lang="en">' +
      (summary.length ? summary.map(it => '<li><div class="q">' + esc(it.q) + '</div><div class="a' + ((it.a || '').trim() ? '' : ' none') + '">' + esc((it.a || '').trim() || '—') + '</div></li>').join('') : '<li class="muted">אין שאלון מקושר.</li>') + '</ul>' + utmLine(qn) + '</details>';
    const head = '<div class="row">' + pill('quote', q.status) + '<span class="muted small">נוצרה ' + esc(fmtDate(q.created_at, true)) +
      (q.sent_at ? ' · נשלחה ' + esc(fmtDate(q.sent_at, true)) : '') + (q.valid_until ? ' · בתוקף עד ' + esc(fmtDate(q.valid_until)) : '') + '</span></div>' +
      '<h2>' + esc(company(q.user_id)) + '</h2>';
    if (frozen) { d.innerHTML = head + frozenQuote(q) + '<div id="reviewBox"></div>' + answers + notesBox('quote', q.id); wireFrozen(q); wireNotes(); loadReview(q); focusDetail(); return; }

    const core = (ED.lines.find(l => ((PB.rules || {}).core_codes || []).includes(l.code)) || {}).code || null;
    const addable = addableCodes(core);
    const customKeys = Object.entries(PB.integrations || {}).filter(([, v]) => v === 'custom').map(([k]) => ['tool:' + k, intLabel(k) + ' integration']);
    const used = foundingUsed(q.id), maxF = maxFounding();
    const foundingBlocked = !ED.discount && maxF && used >= maxF;
    d.innerHTML = head + '<div class="qgrid"><div>' +
      '<h3>שורות ההצעה</h3><ul class="lines" id="lines"></ul>' +
      '<div class="addrow"><label class="sr-only" for="addCode">הוספת קוד מהמחירון</label><select class="select" id="addCode">' + opt('', 'הוספת קוד מהמחירון…', '') +
      addable.map(c => opt(c, c + ' — ' + (itemOf(c) || {}).name, '')).join('') + '</select><button type="button" class="btn btn--ghost" id="addBtn">הוסף</button></div>' +
      '<div class="addrow"><label class="sr-only" for="addCustom">הוספת שורה בתמחור ידני</label><select class="select" id="addCustom">' + opt('', 'שורה בתמחור ידני (custom)…', '') +
      customKeys.concat([['locations_over_3', 'More than 3 locations'], ['call_volume', 'Call volume above the auto-quote limit']]).map(([k, l]) => opt(k, l, '')).join('') +
      '</select><button type="button" class="btn btn--ghost" id="addCustomBtn">הוסף</button></div>' +
      '<label class="check spaced"><input type="checkbox" id="founding"' + (ED.discount === 'FOUNDING' ? ' checked' : '') + '' + '> הנחת מייסדים <bdi dir="ltr">(FOUNDING)</bdi>: ' +
      pctFounding() + '% מההקמה בלבד · נוצלו ' + used + ' מתוך ' + maxF + '</label>' +
      (foundingBlocked ? '<p class="small" style="color:var(--warn)">שים לב: התקרה של ' + maxF + ' לקוחות מייסדים כבר נוצלה. השרת יחסום שליחה עם ההנחה.</p>' : '') +
      '<ul class="errs" id="pErrs" role="alert"></ul><div id="manualBox"></div>' +
      '<h3>סכומים</h3><dl class="totals" id="totals"></dl>' +
      '<h3>טקסט ההצעה (באנגלית, הלקוח רואה)</h3>' +
      '<div class="field"><label for="scope">What we\'ll build</label><textarea class="textarea tall ltr" dir="ltr" lang="en" id="scope" maxlength="20000">' + esc(q.scope_md || '') + '</textarea></div>' +
      '<div class="field"><label for="assum">Assumptions (שורה לכל הנחה)</label><textarea class="textarea ltr" dir="ltr" lang="en" id="assum">' + esc((q.assumptions || []).join('\n')) + '</textarea></div>' +
      '<div class="field"><label for="timeline">Timeline</label><input class="input ltr" dir="ltr" lang="en" id="timeline" maxlength="4000" value="' + esc(q.timeline_text || '') + '"></div>' +
      '<h3>תשלום</h3><div class="field"><label for="payMethod">אמצעי תשלום</label><select class="select" id="payMethod">' +
      payMethods(q.pay_method).map(([v, l]) => opt(v, l, q.pay_method || payDefault())).join('') + '</select></div>' +
      '<div class="field"><label for="payLink">קישור תשלום או קישור לחוזה ב-Upwork (לא חובה; בלי קישור הלקוח רואה מה השלב הבא)</label><input class="input ltr" dir="ltr" type="url" id="payLink" maxlength="1000" placeholder="https://" value="' + esc(q.pay_link || '') + '"></div>' +
      '<div id="eMsg"></div><div class="btnrow"><button type="button" class="btn btn--primary" id="sendBtn">אשר ושלח</button>' +
      '<button type="button" class="btn btn--ghost" id="saveBtn">שמור טיוטה</button>' +
      (q.questionnaire_id ? '<button type="button" class="btn btn--ghost" id="regenBtn">צור טיוטה מחדש</button>' : '') +
      '<button type="button" class="btn btn--ghost" id="voidBtn">בטל הצעה</button></div>' +
      '<p class="muted small">"אשר ושלח" מעביר את ההצעה ל-approved ואז ל-sent, ושולח ללקוח את המייל quote_sent. כל פעולה נרשמת ביומן.</p>' +
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
      if (!confirm('ליצור טיוטה מחדש? השורות והטקסט הנוכחיים יוחלפו.')) return;
      rg.disabled = true;
      try { await AB.adminRegenerateDraft(q.questionnaire_id, PB); ED = null; await refresh(); toast('נוצרה טיוטה חדשה.'); }
      catch (e) { $('#eMsg').innerHTML = msg(errText(e)); rg.disabled = false; }
    });
    wireNotes();
  }

  function lineAmt(l, i, c) {
    if (c.unresolved.includes(i)) return '<span>הקמה ' + money(null) + '</span><span>חודשי ' + money(null) + '</span>';
    const it = itemOf(l.code), qty = l.qty || 1;
    if (it && it.kind === 'percent') return '<span>' + esc(it.setup_pct || (PB.rules || {}).rush_pct) + '% מההקמה: ' + money(c.r.rush_cents) + '</span>';
    const man = manualLine(l) && isC(l.manual_setup_cents) && isC(l.manual_monthly_cents);
    const us = man ? l.manual_setup_cents : it && it.setup_cents, um = man ? l.manual_monthly_cents : it && it.monthly_cents;
    return '<span>הקמה ' + money(isC(us) ? us * qty : null) + '</span><span>חודשי ' + money(isC(um) ? um * qty : null) + '</span>';
  }
  function drawLines() {
    const c = calc(ED.lines, ED.discount, ED.confirmed);
    const ul = $('#lines');
    ul.innerHTML = ED.lines.length ? ED.lines.map((l, i) => {
      const it = itemOf(l.code);
      const manual = manualLine(l);
      const name = l.code === 'CUSTOM' ? (l.label || 'Custom') : ((it || {}).name || l.code);
      let ctl = '';
      if (QTY_CODES.includes(l.code)) ctl += '<label class="mini">כמות<input class="input qty" type="number" min="1" max="' + P.MAX_QTY + '" step="1" data-qty="' + i + '" value="' + esc(l.qty || 1) + '"></label>';
      if (manual) {
        const fl = it && it.kind === 'from' && it.setup_cents;
        const dflt = (v, t) => isC(v) ? v / 100 : (isC(t) ? t / 100 : '');
        ctl += '<label class="mini">הקמה ידנית ($)' + (fl ? ' · החל מ-' + esc(moneyText(fl)) : '') + '<input class="input" dir="ltr" type="number" min="0" step="1" data-ms="' + i + '" value="' + dflt(l.manual_setup_cents, it && it.kind === 'fixed' ? it.setup_cents : null) + '"></label>' +
          '<label class="mini">חודשי ידני ($)<input class="input" dir="ltr" type="number" min="0" step="1" data-mm="' + i + '" value="' + dflt(l.manual_monthly_cents, it ? it.monthly_cents : null) + '"></label>';
        // a later fixed offer starts at its table price: store it as the manual value so the server sees Meir's number
        if (it && it.kind === 'fixed' && !isC(l.manual_setup_cents) && isC(it.setup_cents) && isC(it.monthly_cents)) { l.manual_setup_cents = it.setup_cents; l.manual_monthly_cents = it.monthly_cents; }
        if (it && !isC(l.manual_monthly_cents) && isC(it.monthly_cents)) l.manual_monthly_cents = it.monthly_cents;   // input shows the table monthly
      }
      ctl += '<button type="button" class="btn btn--ghost btn--sm" data-rm="' + i + '" aria-label="הסרת ' + esc(l.code) + '">הסרה</button>';
      const bad = c.errors.some(e => e.split(':')[1] === l.code);
      return '<li class="line' + (manual ? ' line--manual' : '') + (bad ? ' line--err' : '') + '"><span class="line__name"><code dir="ltr">' + esc(l.code) + '</code><span dir="ltr" lang="en">' + esc(name) + '</span></span>' +
        '<span class="line__amt" data-amt="' + i + '">' + lineAmt(l, i, c) + '</span><span class="line__ctl">' + ctl + '</span></li>';
    }).join('') : '<li class="empty">אין שורות. מוסיפים קוד מהמחירון.</li>';
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
    $('#totals').innerHTML = row('סכום ביניים להקמה', money(unresolved ? null : r.setup_subtotal_cents)) +
      (r.rush_cents ? row('דחוף (ADD-RUSH)', money(r.rush_cents)) : '') +
      (r.discount_cents ? row('הנחת מייסדים', '<span dir="ltr" class="num">−' + esc(moneyText(r.discount_cents)) + '</span>') : '') +
      row('סה"כ הקמה', money(unresolved ? null : r.setup_cents), 'grand') +
      row('מקדמה (' + ((PB.rules || {}).deposit_pct || 50) + '%)', money(unresolved ? null : r.deposit_cents)) +
      row('לפני עלייה לאוויר', money(unresolved ? null : r.final_cents)) +
      row('חודשי מהעלייה לאוויר', money(unresolved ? null : r.monthly_cents), 'grand');
    $('#pErrs').innerHTML = c.errors.map(e => '<li>' + esc(PERR(e)) + '</li>').join('');
    const mb = $('#manualBox');
    if (c.needed) {
      const had = $('#manualOk') && $('#manualOk').checked;
      mb.innerHTML = '<div class="notice" role="note"><div><b>תמחור ידני (needs_manual_price)</b><ul>' + c.reasons.map(x => '<li>' + esc(REASON(x)) + '</li>').join('') + '</ul>' +
        (c.unresolved.length ? '<p>חסר מחיר בשורות המסומנות. אי אפשר לשלוח עד שממלאים.</p>' : '') +
        '<label class="check"><input type="checkbox" id="manualOk"' + (had || ED.confirmed ? ' checked' : '') + '> בדקתי את התמחור הידני ואני מאשר אותו</label></div></div>';
      $('#manualOk').addEventListener('change', e => { ED.confirmed = e.target.checked; });
    } else { mb.innerHTML = ''; ED.confirmed = false; }
    return c;
  }

  async function saveQuote(q, andSend) {
    const c = drawTotals(), r = c.r;
    const em = $('#eMsg'); em.innerHTML = '';
    if (c.errors.length) { em.innerHTML = msg('יש שגיאות בשורות. מתקנים לפני שמירה.'); return; }
    const link = $('#payLink').value.trim();
    if (link && !/^https:\/\//.test(link)) { em.innerHTML = msg(ERR.pay_link_https); $('#payLink').focus(); return; }
    const unresolved = c.unresolved.length > 0;
    if (andSend) {
      if (unresolved) { em.innerHTML = msg('חסר מחיר ידני בשורה אחת או יותר. אי אפשר לשלוח.'); return; }
      if (c.needed && !ED.confirmed) { em.innerHTML = msg('לפני שליחה צריך לסמן "בדקתי את התמחור הידני".'); return; }
      const v = P.validateItems(PB, ED.lines, { discount_code: ED.discount, manual_approved: !!ED.confirmed });
      if (!v.ok) { em.innerHTML = msg('השרת יחסום את השליחה: ' + v.blockers.map(PERR).join(' · ')); return; }
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
        if (!confirm('לשלוח את ההצעה ל-' + company(q.user_id) + '? ' + moneyText(r.setup_cents) + ' הקמה + ' + moneyText(r.monthly_cents) + ' לחודש.')) { await refresh(); return; }
        // quote-send Edge Function (A6): re-prices with the same module, approved -> sent, emits the quote_sent e-mail event
        await AB.quoteSend(q.id, { discount_code: ED.discount, pay_method: patch.pay_method, pay_link: patch.pay_link || '', manual_approved: !!ED.confirmed });
        ED = null; await refresh(); toast('ההצעה אושרה ונשלחה ללקוח.');
      } else { await refresh(); toast('הטיוטה נשמרה.'); }
    } catch (e) { em.innerHTML = msg(errText(e)); bs.forEach(b => { b.disabled = false; }); }
  }
  async function voidQuote(q) {
    if (!confirm('לבטל את ההצעה? אי אפשר להחזיר.')) return;
    try { await AB.adminSaveQuote(q.id, { status: 'void' }); ED = null; await refresh(); toast('ההצעה בוטלה.'); } catch (e) { toast(errText(e)); }
  }
  function frozenQuote(q) {
    const items = q.items || [];
    const cl = clientOfQuote(q.id);
    const pm = payLabel(q.pay_method || payDefault());
    if (q.anonymized) return '<div class="notice notice--err" role="note"><div>ההצעה עברה אנונימיזציה (מדיניות שמירה). אי אפשר לערוך או לשלוח אותה; היא נשמרת לצורכי הנהלת חשבונות בלבד.</div></div>' +
      '<dl class="totals spaced"><dt class="grand">סה"כ הקמה</dt><dd>' + money(q.setup_cents) + '</dd><dt class="grand">חודשי</dt><dd>' + money(q.monthly_cents) + '</dd></dl>';
    return '<p class="muted">ההצעה ' + (q.status === 'void' ? 'בוטלה' : 'נשלחה') + '. השורות והסכומים נעולים; כדי לשנות מבטלים ומוציאים הצעה חדשה.</p>' +
      '<ul class="lines">' + items.map(it => '<li class="line"><span class="line__name"><code dir="ltr">' + esc(it.code) + '</code><span dir="ltr" lang="en">' + esc(it.name || '') + (it.qty > 1 ? ' × ' + it.qty : '') + '</span></span>' +
        '<span class="line__amt"><span>הקמה ' + money(it.setup_cents) + '</span><span>חודשי ' + money(it.monthly_cents) + '</span></span></li>').join('') + '</ul>' +
      '<dl class="totals">' + (q.discount_code ? '<dt>הנחה</dt><dd dir="ltr">' + esc(q.discount_code) + '</dd>' : '') + '<dt class="grand">סה"כ הקמה</dt><dd>' + money(q.setup_cents) + '</dd><dt>מקדמה</dt><dd>' + money(q.deposit_cents) +
      '</dd><dt class="grand">חודשי</dt><dd>' + money(q.monthly_cents) + '</dd></dl>' +
      '<dl class="kv spaced"><dt>אמצעי תשלום</dt><dd>' + esc(pm) + '</dd><dt>קישור תשלום</dt><dd>' + (q.pay_link ? ltr(q.pay_link) : '<span class="muted">—</span>') + '</dd>' +
      (q.accepted_at ? '<dt>אושרה ע"י</dt><dd>' + esc(q.accepted_name || '') + ' · ' + esc(fmtDate(q.accepted_at, true)) + '</dd>' : '') + '</dl>' +
      '<div class="btnrow">' + (q.public_token && q.status !== 'void' ? '<a class="btn btn--ghost" href="/quote/#t=' + encodeURIComponent(q.public_token) + '" target="_blank" rel="noopener">דף ההצעה של הלקוח</a>' : '') +
      (['sent', 'viewed'].includes(q.status) ? '<button type="button" class="btn btn--ghost" id="voidBtn">בטל הצעה</button>' : '') +
      (q.status === 'accepted' ? (cl ? '<button type="button" class="btn btn--primary" id="toClient">לכרטיס הלקוח</button>' : '<button type="button" class="btn btn--primary" id="mkClient">פתח כרטיס לקוח</button>') : '') + '</div><div id="eMsg"></div>';
  }
  // quote_reviews (A6, admin only): why a manual price is needed, risk flags, questions for the client, what the sanitizer removed
  async function loadReview(q) {
    const box = $('#reviewBox'); if (!box) return;
    let r = null;
    try { r = await AB.adminGetQuoteReview(q.id); } catch (e) { box.innerHTML = msg(errText(e)); return; }
    if (!r || !box.isConnected) return;
    const list = (title, arr) => arr && arr.length ? '<h4>' + esc(title) + '</h4><ul class="sum" dir="auto">' + arr.map(x => '<li><div class="a" dir="auto">' + esc(typeof x === 'string' ? x : JSON.stringify(x)) + '</div></li>').join('') + '</ul>' : '';
    const body = list('סיבות לתמחור ידני', r.manual_reasons) + list('דגלי סיכון', r.risk_flags) + list('שאלות ללקוח', r.questions_for_client) + list('מה הוסר מהטקסט של Claude', r.removed);
    box.innerHTML = '<section class="card review" aria-labelledby="rvH"><h3 id="rvH">בדיקת הטיוטה (רק אתה רואה)</h3>' +
      (body || '<p class="muted">אין הערות מהמנוע.</p>') + (r.model ? '<p class="muted small">מודל: <span dir="ltr">' + esc(r.model) + '</span></p>' : '') + '</section>';
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

  // ------------------------------------------------------------ לקוחות
  function tClients(p, keep) {
    const f = F.clients = F.clients || { st: '', term: '' };
    const filter = () => {
      f.st = $('#fSt').value; f.term = $('#fTerm').value.trim().toLowerCase();
      const rows = D.clients.filter(c => (!f.st || c.status === f.st) && (!f.term || clientName(c).toLowerCase().indexOf(f.term) !== -1));
      fillList(rows, c => '<span class="l1"><b>' + esc(clientName(c)) + '</b>' + pill('client', c.status) + '</span><span class="l2">' + '<bdi>' + esc((c.products || []).join(' + ')) + '</bdi> · חודשי ' + money(c.monthly_cents) + '</span>', 'clients', 'אין לקוחות עדיין.');
    };
    if (!keep || !$('#fSt')) split(p, fsel('fSt', 'סטטוס', [['', 'כל הסטטוסים']].concat(Object.entries(ST.client)), f.st) + fsearch('fTerm', 'חיפוש לפי עסק', f.term), filter);
    filter();
    clientDetail();
  }
  // payments made by card / PayPal checkout: PayPal ids on the row, the refund button for a deposit inside the price book's rule
  const refundDays = () => Number((((PB.refund_rules || {}).deposit || {}).window_days) || 7);
  const isPending = x => x.provider === 'paypal' && x.status === 'due' && !!x.provider_capture_id;
  function providerLine(x) {
    if (x.provider !== 'paypal') return '';
    const id = x.provider_capture_id ? ' · מזהה חיוב ' + ltr(x.provider_capture_id) : x.provider_order_id ? ' · הזמנה פתוחה ' + ltr(x.provider_order_id) : '';
    return '<br><span class="muted small">PayPal' + id + (x.payer_email ? ' · משלם ' + ltr(x.payer_email) : '') + '</span>';
  }
  function refundCtl(x) {
    if (x.provider !== 'paypal' || x.kind !== 'deposit' || x.status !== 'paid' || !x.provider_capture_id) return '';
    const inWindow = x.paid_at && Date.now() - Date.parse(x.paid_at) <= refundDays() * 864e5;
    return inWindow ? '<button type="button" class="btn btn--ghost btn--sm" data-refund="' + esc(x.id) + '">החזר</button>'
      : '<span class="muted small">עברו ' + refundDays() + ' ימים: החזר רק מתוך PayPal</span>';
  }
  async function clientDetail() {
    const d = $('#detail');
    const c = sel && D.clients.find(x => x.id === sel);
    if (!c) { d.innerHTML = '<p class="muted">בוחרים לקוח מהרשימה.</p>'; return; }
    const pays = D.payments.filter(x => x.client_id === c.id);
    const ob = D.onboarding.filter(x => x.client_id === c.id).sort((a, b) => a.sort - b.sort);
    const done = ob.filter(x => x.status === 'done').length;
    const t = D.tenants.find(x => x.client_id === c.id);
    const pr = prof(c.user_id);
    d.innerHTML = '<div class="row">' + pill('client', c.status) + '<span class="muted small">לקוח מאז ' + esc(fmtDate(c.created_at)) + (c.go_live_at ? ' · באוויר מ-' + esc(fmtDate(c.go_live_at)) : '') + '</span></div>' +
      '<h2>' + esc(clientName(c)) + '</h2>' +
      '<dl class="kv"><dt>מוצרים</dt><dd dir="ltr">' + esc((c.products || []).join(' + ')) + '</dd><dt>חודשי</dt><dd>' + money(c.monthly_cents) + '</dd><dt>חיוב הבא</dt><dd>' + esc(c.next_bill_on ? fmtDate(c.next_bill_on) : '—') +
      '</dd><dt>מייל</dt><dd>' + ltr(pr.email || '') + '</dd><dt>שפת עדכונים</dt><dd>' + esc(pr.update_lang === 'he' ? 'עברית' : 'אנגלית') + '</dd></dl>' +
      '<h3>סטטוס</h3><div class="addrow"><label class="sr-only" for="cSt">סטטוס הלקוח</label><select class="select" id="cSt">' + Object.entries(ST.client).map(([v, l]) => opt(v, l, c.status)).join('') +
      '</select><button type="button" class="btn btn--ghost" id="cStSave">שמירת סטטוס</button></div>' +
      '<p class="muted small">testing שולח ללקוח "ready_to_test", live שולח "went_live".</p>' +
      '<h3>תשלומים</h3>' + (pays.length ? '<ul class="plist">' + pays.map(x => '<li><span class="grow"><b>' + esc(ST.kind[x.kind] || x.kind) + '</b> ' + money(x.amount_cents) +
        '<br><span class="muted small">' + (x.paid_at ? 'שולם ' + esc(fmtDate(x.paid_at)) : 'נוצר ' + esc(fmtDate(x.created_at))) + (x.reference ? ' · אסמכתה ' + ltr(x.reference) : '') + '</span>' +
        providerLine(x) + '</span>' + (isPending(x) ? '<span class="pill pill--pending">בעיבוד ב-PayPal</span>' : pill('pay', x.status)) +
        (x.status === 'due' ? '<label class="sr-only" for="ref-' + esc(x.id) + '">אסמכתה</label><input class="input" dir="ltr" id="ref-' + esc(x.id) + '" placeholder="אסמכתה (לא חובה)" maxlength="300">' +
          '<button type="button" class="btn btn--primary btn--sm" data-pay="' + esc(x.id) + '">סמן כשולם</button>' : '') + refundCtl(x) + '</li>').join('') + '</ul>' : '<p class="muted">אין תשלומים רשומים.</p>') +
      '<h3>צ\'ק-ליסט קליטה</h3>' + (ob.length ? '<p class="small">' + done + ' מתוך ' + ob.length + ' הושלמו</p><div class="bar" role="progressbar" aria-label="התקדמות הצ\'ק-ליסט" aria-valuemin="0" aria-valuemax="' + ob.length + '" aria-valuenow="' + done + '"><i style="width:' + Math.round(done / ob.length * 100) + '%"></i></div>' +
        '<ul class="plist">' + ob.map(o => '<li><span class="grow" dir="ltr" lang="en">' + esc(o.title) + '</span>' + pill('ob', o.status) + '</li>').join('') + '</ul>' : '<p class="muted">הצ\'ק-ליסט עוד לא נפתח (משימה B7).</p>') +
      '<h3>Tenant</h3><div id="tenantBox">' + (t ? '' : '<p class="muted">אין tenant עדיין.</p>') + '</div>' +
      (c.quote_id ? '<div class="btnrow"><button type="button" class="btn btn--ghost" id="toQuote">להצעה של הלקוח</button></div>' : '') +
      notesBox('client', c.id);
    focusDetail();
    $('#cStSave').addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await AB.adminSaveClient(c.id, { status: $('#cSt').value }); await refresh(); toast('הסטטוס נשמר.'); } catch (er) { toast(errText(er)); b.disabled = false; }
    });
    $$('[data-pay]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await AB.adminMarkPaid(b.dataset.pay, ($('#ref-' + b.dataset.pay) || {}).value || ''); await refresh(); toast('התשלום סומן כשולם.'); } catch (e) { toast(errText(e)); b.disabled = false; }
    }));
    // PayPal deposit refund (pay-refund): full amount, within the price book's deposit rule, confirmed in Hebrew first
    $$('[data-refund]').forEach(b => b.addEventListener('click', async () => {
      const x = pays.find(p => p.id === b.dataset.refund); if (!x) return;
      const checklistDone = ob.length > 0 && ob.every(o => o.status === 'done' || o.key === 'tools');
      if (!confirm('להחזיר ללקוח ' + clientName(c) + ' את כל המקדמה (' + moneyText(x.amount_cents) + ') דרך PayPal?\n' +
        'הכסף חוזר לכרטיס או לחשבון ה-PayPal של הלקוח, ואי אפשר לבטל את זה.' +
        (checklistDone ? '\nשים לב: הלקוח כבר השלים את הצ\'ק-ליסט, ולפי הכלל לא חייבים להחזיר.' : ''))) return;
      b.disabled = true;
      try { await AB.adminRefundPayment(x.id); await refresh(); toast('המקדמה הוחזרה ב-PayPal.'); } catch (e) { toast(errText(e)); b.disabled = false; }
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
    box.innerHTML = '<dl class="kv"><dt>slug</dt><dd>' + ltr(t.slug) + '</dd><dt>סטטוס</dt><dd>' + pill('tenant', t.status) + '</dd><dt>מספר</dt><dd>' + ltr(t.twilio_number || '—') + '</dd>' +
      '<dt>שם העסק</dt><dd dir="ltr">' + esc(b.name || '—') + '</dd><dt>אזור זמן</dt><dd>' + ltr(b.timezone || '—') + '</dd><dt>ימי פעילות</dt><dd dir="ltr">' + esc(days || '—') + '</dd>' +
      '<dt>אחרי שעות</dt><dd dir="ltr">' + esc((cfg.after_hours || {}).mode || '—') + '</dd><dt>יומן</dt><dd dir="ltr">' + esc((cfg.booking || {}).provider || '—') + '</dd>' +
      '<dt>שאלות נפוצות</dt><dd>' + ((cfg.faq || []).length) + '</dd><dt>מחירים בטלפון</dt><dd dir="ltr">' + esc((cfg.pricing || {}).mode || '—') + '</dd>' +
      '<dt>AI מושהה</dt><dd>' + (cfg.paused ? 'כן' : 'לא') + '</dd></dl>' +
      (usage ? '<h3>שימוש החודש (runtime_state)</h3><dl class="kv"><dt>דקות קול</dt><dd><span dir="ltr">' + esc(usage.voice_minutes || 0) + ' / ' + esc(inc.voice_minutes || '') + '</span> ' + esc(pctOf(usage.voice_minutes || 0, inc.voice_minutes)) + '</dd>' +
        '<dt>מקטעי SMS</dt><dd><span dir="ltr">' + esc(usage.sms_segments || 0) + ' / ' + esc(inc.sms_segments || '') + '</span> ' + esc(pctOf(usage.sms_segments || 0, inc.sms_segments)) + '</dd>' +
        (usage.calls != null ? '<dt>שיחות</dt><dd>' + esc(usage.calls) + '</dd>' : '') + (usage.bookings != null ? '<dt>הזמנות</dt><dd>' + esc(usage.bookings) + '</dd>' : '') +
        (spend ? '<dt>עלות Claude היום</dt><dd>' + money(Math.round((spend.usd || 0) * 100)) + '</dd>' : '') + '</dl>'
        : '<p class="muted small">אין נתוני שימוש (runtime_state נגיש רק ל-runtime; בדמו מוצגים נתונים לדוגמה).</p>');
  }

  // ------------------------------------------------------------ תור ריטיינר
  function tRequests(p) {
    const f = F.req = F.req || { st: 'open', client: '' };
    const clients = D.clients.filter(c => D.requests.some(r => r.client_id === c.id));
    p.innerHTML = '<div class="filters">' + fsel('fSt', 'סטטוס', [['open', 'פתוחות'], ['', 'הכל']].concat(Object.entries(ST.req)), f.st) +
      fsel('fClient', 'לקוח', [['', 'כל הלקוחות']].concat(clients.map(c => [c.id, clientName(c)])), f.client) + '</div>' +
      '<p class="muted small">בקשה פעילה אחת לכל לקוח; השאר ממתינות בתור לפי הסדר שהלקוח קבע.</p><div id="reqList"></div>';
    const order = { active: 0, waiting_on_you: 1, queued: 2, done: 3, declined: 4 };
    const draw = () => {
      f.st = $('#fSt').value; f.client = $('#fClient').value;
      const rows = D.requests.filter(r => (f.st === 'open' ? ['queued', 'active', 'waiting_on_you'].includes(r.status) : !f.st || r.status === f.st) && (!f.client || r.client_id === f.client))
        .sort((a, b) => clientName(D.clients.find(c => c.id === a.client_id)).localeCompare(clientName(D.clients.find(c => c.id === b.client_id))) || order[a.status] - order[b.status] || a.position - b.position);
      $('#reqList').innerHTML = rows.length ? rows.map(r => {
        const c = D.clients.find(x => x.id === r.client_id);
        return '<article class="req" aria-labelledby="rq-' + esc(r.id) + '"><div class="req__h"><b id="rq-' + esc(r.id) + '" dir="auto">' + esc(r.title) + '</b>' + pill('req', r.status) +
          (r.paused ? '<span class="pill pill--paused" id="rp-' + esc(r.id) + '">מושהה ע"י הלקוח</span>' : '') + '</div>' +
          (r.paused ? '<p class="small muted">הלקוח השהה את הבקשה: אי אפשר להפעיל אותה עד שהלקוח ימשיך אותה.</p>' : '') +
          '<p class="muted small">' + esc(clientName(c)) + ' · מקום בתור ' + (r.position + 1) + ' · עודכן ' + esc(fmtDate(r.updated_at, true)) + '</p>' + (r.body ? '<p dir="auto">' + esc(r.body) + '</p>' : '') +
          '<div class="row2"><div class="field"><label for="rs-' + esc(r.id) + '">סטטוס</label><select class="select" id="rs-' + esc(r.id) + '">' + Object.entries(ST.req).map(([v, l]) => opt(v, l, r.status)).join('') + '</select></div>' +
          '<div class="field"><label for="ra-' + esc(r.id) + '">תשובה ללקוח (הלקוח רואה, באנגלית)</label><textarea class="textarea ltr" dir="ltr" lang="en" id="ra-' + esc(r.id) + '" maxlength="10000">' + esc(r.admin_reply || '') + '</textarea></div></div>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-rsave="' + esc(r.id) + '">שמירה</button></article>';
      }).join('') : '<p class="empty">אין בקשות בסינון הזה.</p>';
      $$('[data-rsave]').forEach(b => b.addEventListener('click', async () => {
        const id = b.dataset.rsave; b.disabled = true;
        const rq = D.requests.find(x => x.id === id);
        if (rq && rq.paused && $('#rs-' + id).value === 'active') { toast(ERR.request_paused); b.disabled = false; return; }
        try { await AB.adminSaveRequest(id, { status: $('#rs-' + id).value, admin_reply: $('#ra-' + id).value.trim() || null }); await reload(); renderDigest(); draw(); toast('הבקשה עודכנה.'); }
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
    p.innerHTML = '<div class="notice" role="note"><div>עורך ה-JSON של tenant (עם ולידציה מול tenant_schema.json) והכפתור "הרץ 20 תרחישי סימולטור" מגיעים במשימה B7. בינתיים: סיכום לקריאה בלבד בכרטיס הלקוח.</div></div>' +
      (D.tenants.length ? '<ul class="plist spaced">' + D.tenants.map(t => '<li><span class="grow"><b dir="ltr">' + esc(t.slug) + '</b> · ' + esc(clientName(D.clients.find(c => c.id === t.client_id))) + '</span>' +
        pill('tenant', t.status) + '<span dir="ltr">' + esc(t.twilio_number || '') + '</span><button type="button" class="btn btn--ghost btn--sm" data-tc="' + esc(t.client_id) + '">לכרטיס הלקוח</button></li>').join('') + '</ul>' : '<p class="empty spaced">אין tenants עדיין.</p>');
    $$('[data-tc]', p).forEach(b => b.addEventListener('click', () => go('clients', b.dataset.tc)));
  }

  // ------------------------------------------------------------ יומן
  function tEvents(p) {
    const f = F.ev = F.ev || { ent: '' };
    const ents = Array.from(new Set(D.events.map(e => e.entity)));
    p.innerHTML = '<div class="filters">' + fsel('fEnt', 'סוג', [['', 'כל האירועים']].concat(ents.map(e => [e, ENT[e] || e])), f.ent) + '</div><ul class="ev" id="evList"></ul>';
    const draw = () => {
      f.ent = $('#fEnt').value;
      const rows = D.events.filter(e => !f.ent || e.entity === f.ent);
      $('#evList').innerHTML = rows.length ? rows.map(e => {
        const who = /^admin/.test(e.actor) ? 'אתה' : /^client/.test(e.actor) ? 'לקוח' : e.actor === 'runtime' ? 'runtime' : 'מערכת';
        const pl = e.payload || {};
        const st = pl.to ? ' → ' + ((ST[e.entity === 'questionnaire' ? 'q' : e.entity === 'request' ? 'req' : e.entity] || {})[pl.to] || pl.to) : '';
        const subj = e.user_id ? ' · ' + company(e.user_id) : '';
        return '<li><time datetime="' + esc(e.created_at) + '">' + esc(fmtDate(e.created_at, true)) + '</time><span>' + esc(ENT[e.entity] || e.entity) + ': ' + esc(evtLabel(e.type)) + (pl.template ? ' <bdi dir="ltr">' + esc(pl.template) + '</bdi>' : '') + esc(st) + esc(subj) +
          ' <span class="muted">(' + esc(who) + ')</span></span></li>';
      }).join('') : '<li class="empty">היומן ריק.</li>';
    };
    $('#fEnt').addEventListener('change', draw);
    draw();
  }

  // ------------------------------------------------------------ הגדרות (read-only)
  async function tSettings(p) {
    const r = PB.rules || {}, fd = (r.discounts || {}).FOUNDING || {};
    const onoff = v => v ? '<span class="pill pill--live">דלוק</span>' : '<span class="pill pill--draft">כבוי</span>';
    p.innerHTML = '<div class="notice" role="note"><div><b>קריאה בלבד.</b> ההגדרות האלה נקבעות בקובץ config/brand.json ובמחירון config/pricebook.json (ומסונכרנות ב-tools/sync_config.py), לא מכאן. ' +
      'מיילים ללקוחות (client_emails_enabled) נשלטים ב-private.settings במסד הנתונים.</div></div>' +
      '<div class="card spaced"><h2>דגלים</h2><dl class="kv">' +
      '<dt>הצגת מחיר מייסדים (show_founder_price)</dt><dd>' + onoff(BRAND.show_founder_price) + '</dd>' +
      '<dt>מסמכים משפטיים סופיים (legal_final)</dt><dd>' + onoff(BRAND.legal_final) + '</dd>' +
      '<dt>גרסת הסכם</dt><dd>' + ltr(BRAND.agreement_version || '') + '</dd>' +
      '<dt>זמן הצעה שמובטח ללקוח</dt><dd dir="ltr" lang="en">' + esc(BRAND.quote_sla_text || '') + '</dd>' +
      '<dt>שפת דוחות למנהל</dt><dd>' + esc(((BRAND.owner || {}).admin_lang) === 'he' ? 'עברית' : ((BRAND.owner || {}).admin_lang || '')) + '</dd>' +
      '<dt>אזור זמן למנהל</dt><dd>' + ltr((BRAND.owner || {}).timezone || '') + '</dd>' +
      '<dt>מודל Claude</dt><dd>' + ltr((BRAND.claude || {}).model || '') + '</dd>' +
      '<dt>Backend</dt><dd>' + ltr(AB.mode) + '</dd></dl></div>' +
      '<div class="card spaced"><h2>כללי מחירון</h2><dl class="kv">' +
      '<dt>גרסת מחירון</dt><dd>' + ltr((PB.version || '') + ' · ' + (PB.updated || '')) + '</dd>' +
      '<dt>מקדמה</dt><dd>' + esc(r.deposit_pct) + '%</dd><dt>FOUNDING</dt><dd>' + esc(fd.setup_pct || 0) + '% מההקמה, עד ' + esc(fd.max_clients || 0) + ' לקוחות (נוצלו ' + foundingUsed(null) + ')</dd>' +
      '<dt>תוקף הצעה</dt><dd>' + esc(r.quote_valid_days) + ' ימים</dd><dt>סף תמחור ידני</dt><dd>' + money(r.manual_price_setup_over_cents) + '</dd>' +
      '<dt>שימוש כלול בחודש</dt><dd dir="ltr">' + esc(((r.included_usage || {}).voice_minutes || '') + ' min · ' + ((r.included_usage || {}).sms_segments || '') + ' SMS') + '</dd>' +
      '<dt>חריגה משימוש (overage_policy)</dt><dd>' + (r.overage_policy === 'no_auto_billing_alert_80_100_addon_with_approval'
        ? 'אין חיוב אוטומטי על חריגה. התראה ללקוח ב-80% וב-100%; חבילת שימוש נוספת (ADD-USAGE) רק באישור הלקוח.' : esc(r.overage_policy || '—')) +
        ' <span class="muted small" dir="ltr">' + esc(r.overage_policy || '') + '</span></dd></dl></div>' +
      '<div class="card spaced"><h2>כללי החזרים</h2>' + refundHtml() + '</div>' +
      (AB.mode === 'mock' ? '<div class="card spaced"><h2>תיבת דואר דמו</h2><p class="muted small">המיילים שהיו נשלחים (stub של A8).</p><ul class="ev mailbox" id="outbox"></ul></div>' : '');
    if (AB.mode === 'mock') {
      try {
        const box = await AB.adminOutbox();
        if (!$('#outbox')) return;
        $('#outbox').innerHTML = box.slice(0, 30).map(m => '<li><time>' + esc(fmtDate(m.created_at, true)) + '</time><span><b dir="ltr">' + esc(m.template) + '</b> → ' + ltr(m.to || '') +
          (m.subject ? '<br><span dir="auto">' + esc(m.subject) + '</span>' : '') + '</span></li>').join('') || '<li class="empty">ריק.</li>';
      } catch (e) { /* mock only */ }
    }
  }

  function refundHtml() {
    const rr = PB.refund_rules || {}, dp = rr.deposit || {}, rt = rr.retainer || {}, g = rr.rcp_guarantee || {};
    if (!dp.refund_pct && !rt.refund_pct) return '<p class="muted">אין כללי החזר בקונפיג.</p>';
    return '<dl class="kv">' +
      (g.text ? '<dt>אחריות שביעות רצון</dt><dd>החזר דמי ההקמה אם הלקוח לא מרוצה תוך ' + esc(rr.rcp_guarantee_days) + ' ימים מהעלייה לאוויר, והקו מכובה. בחבילה מוחזר רק חלק המזכירה, והאתר נשאר אצל הלקוח. החודשי על התקופה שנוצלה לא מוחזר (<bdi dir="ltr">' + esc((g.codes || []).join(', ')) + '</bdi>; לאתר בלבד חל רק כלל המקדמה)' +
        '<br><span class="muted small" dir="ltr" lang="en">' + esc(g.text) + '</span></dd>' : '') +
      (dp.refund_pct != null ? '<dt>מקדמת הקמה</dt><dd>' + esc(dp.refund_pct) + '% החזר לפי בקשה, תוך ' + esc(dp.window_days) + ' ימים מהתשלום, כל עוד הצ\'ק-ליסט לא הושלם' +
        '<br><span class="muted small" dir="ltr" lang="en">' + esc(dp.text || '') + '</span></dd>' : '') +
      (rt.refund_pct != null ? '<dt>ריטיינר</dt><dd>' + esc(rt.refund_pct) + '% מהתשלום הראשון אם מבטלים תוך ' + esc(rt.window_days) + ' ימים (<bdi dir="ltr">' + esc((rt.codes || []).join(', ')) + '</bdi>)' +
        '<br><span class="muted small" dir="ltr" lang="en">' + esc(rt.text || '') + '</span></dd>' : '') +
      '<dt>סטטוס</dt><dd dir="ltr" lang="en">' + esc(rr.status || '') + '</dd></dl>';
  }

  // ------------------------------------------------------------ boot
  (async function boot() {
    await loadConfig();
    try { P = await import('/assets/pricing.mjs'); window.Pricing = P; }   // same module as the server; the mock uses it too
    catch (e) { app.innerHTML = '<h1>ניהול</h1>' + msg('מודול התמחור לא נטען: ' + (e && e.message)); return; }
    if (AB.mode === 'off') { header(null); app.innerHTML = '<h1>ניהול</h1>' + msg(ERR.backend_off); return; }
    try { await AB.ready(); } catch (e) { app.innerHTML = '<h1>ניהול</h1>' + msg(errText(e)); return; }
    mockBar();
    let s = null;
    try { s = await AB.consumeLink(); } catch (e) { showLogin(errText(e)); return; }
    if (!s) s = await AB.getSession();
    if (!s) { showLogin(); return; }
    await afterSignIn(s);
  })();
})();
