/* Mock backend for the client portal: same API as the Supabase adapter in ../backend.js, stored in this browser's
   localStorage. No network, no real e-mail. Mirrors the server rules that matter to the UI:
     - ownership (RLS): a user sees and edits only rows where user_id/owner_id = own id; other ids read as "not found"
     - questionnaire guard: edits only while 'draft'; submit needs an offer; max 20 per user; locked afterwards
     - attachments: own draft only, max 5 per questionnaire, max 10 MB each
     - quotes visible to the client only from 'sent' on (sent_at set)
   E-mails go to an in-browser outbox (shown on the sign-in screen in mock mode).
   Test/dev helpers: window.StartMock.admin.{reset, db, inbox, seed(stage, pricebook)}. */
(function () {
  const KEY = 'aplp_mock_db_v1', SKEY = 'aplp_mock_session_v1';
  const ls = {
    get: k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del: k => { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  const TABLES = ['users', 'profiles', 'questionnaires', 'attachments', 'quotes', 'clients', 'payments', 'events', 'outbox', 'otps',
    'leads', 'onboarding_items', 'requests', 'tenants', 'runtime_state', 'admin_notes', 'quote_reviews'];   // second row: admin (A7)
  // mirrors private.handle_new_user() setting is_admin for the owner's address; in the mock that address is a demo one
  const MOCK_ADMIN_EMAIL = () => (window.SITE_CONFIG && window.SITE_CONFIG.MOCK_ADMIN_EMAIL) || 'admin@demo.local';
  function load() {
    const db = ls.get(KEY) || {};
    TABLES.forEach(t => { if (!Array.isArray(db[t])) db[t] = []; });
    return db;
  }
  const store = db => ls.set(KEY, db);
  const now = () => new Date().toISOString();
  const rnd = n => { let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const later = v => new Promise(r => setTimeout(() => r(clone(v)), 30));   // async like the network
  function fail(code) { const e = new Error(code); e.code = code; return Promise.reject(e); }

  function me(db) {
    const s = ls.get(SKEY);
    return s && db.users.find(u => u.id === s.uid) || null;
  }
  function session(u) { return u ? { user: { id: u.id, email: u.email } } : null; }
  function event(db, entity, entity_id, user_id, type, payload) {
    db.events.push({ id: uuid(), actor: 'client', entity, entity_id, user_id, type, payload: payload || {}, created_at: now() });
  }
  function signIn(db, email) {
    let u = db.users.find(x => x.email === email);
    if (!u) {
      u = { id: uuid(), email, created_at: now() };
      db.users.push(u);
      // mirrors private.handle_new_user(): every auth user gets a profile row
      db.profiles.push({ id: u.id, email, full_name: null, company: null, phone: null, city: null, state: null, timezone: null,
        niche: null, website: null, how_heard: null, update_lang: 'en', is_admin: email === MOCK_ADMIN_EMAIL(), created_at: now(), updated_at: now() });
    }
    ls.set(SKEY, { uid: u.id });
    return u;
  }

  function create(C) {
    const MAX_FILES = C.MAX_FILES || 5, MAX_BYTES = (C.MAX_FILE_MB || 10) * 1048576;
    return {
      mode: 'mock',
      googleEnabled: false,
      getSession() { return later(session(me(load()))); },
      consumeLink() {
        const p = new URLSearchParams(location.search);
        const tok = p.get('mock_token');
        const db = load();
        if (tok) {
          p.delete('mock_token');
          history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
          const o = db.otps.find(x => x.token === tok && Date.parse(x.expires_at) > Date.now());
          if (!o) return fail('Token has expired or is invalid');
          db.otps = db.otps.filter(x => x !== o);
          const u = signIn(db, o.email); store(db);
          return later(session(u));
        }
        return later(session(me(db)));
      },
      sendCode(email) {
        const db = load();
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const token = rnd(32);
        db.otps = db.otps.filter(x => x.email !== email);
        db.otps.push({ email, code, token, expires_at: new Date(Date.now() + 30 * 60000).toISOString() });
        const link = location.origin + '/start/?mock_token=' + token;
        db.outbox.push({ id: uuid(), to: email, template: 'auth_code', subject: 'Your sign-in code: ' + code, code, link, created_at: now() });
        store(db);
        return later(null);
      },
      verifyCode(email, code) {
        const db = load();
        const o = db.otps.find(x => x.email === email && x.code === code && Date.parse(x.expires_at) > Date.now());
        if (!o) return fail('Token has expired or is invalid');
        db.otps = db.otps.filter(x => x !== o);
        const u = signIn(db, email); store(db);
        return later(session(u));
      },
      signInWithGoogle() { return fail('provider_disabled'); },
      signOut() { ls.del(SKEY); return later(null); },

      getProfile() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        return later(db.profiles.find(p => p.id === u.id) || null);
      },
      saveProfile(patch) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const p = db.profiles.find(x => x.id === u.id); if (!p) return fail('not_found');
        const ok = ['full_name', 'company', 'phone', 'city', 'state', 'timezone', 'niche', 'website', 'how_heard', 'update_lang'];
        ok.forEach(k => { if (k in patch) p[k] = patch[k]; });   // id/email/is_admin are ignored, like profiles_guard
        if (p.update_lang !== 'en' && p.update_lang !== 'he') return fail('invalid_update_lang');
        if (p.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch (e) { return fail('invalid_timezone'); } }
        p.updated_at = now(); store(db);
        return later(p);
      },

      listQuestionnaires() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const rows = db.questionnaires.filter(q => q.user_id === u.id)
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map(q => ({ id: q.id, offer: q.offer, niche: q.niche, status: q.status, created_at: q.created_at, updated_at: q.updated_at, submitted_at: q.submitted_at }));
        return later(rows);
      },
      createQuestionnaire(init) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        if (db.questionnaires.filter(q => q.user_id === u.id).length >= 20) return fail('too_many_questionnaires');
        const q = { id: uuid(), user_id: u.id, offer: init && init.offer || null, niche: init && init.niche || null, status: 'draft',
          answers: {}, summary: [], submitted_at: null, created_at: now(), updated_at: now() };
        db.questionnaires.push(q);
        event(db, 'questionnaire', q.id, u.id, 'created', { to: 'draft' });
        store(db);
        return later({ id: q.id });
      },
      getQuestionnaire(id) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        return later(db.questionnaires.find(q => q.id === id && q.user_id === u.id) || null);
      },
      saveQuestionnaire(id, patch) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const q = db.questionnaires.find(x => x.id === id && x.user_id === u.id && x.status === 'draft');
        if (!q) return later(null);   // RLS: update matches 0 rows
        ['offer', 'niche', 'answers', 'summary'].forEach(k => { if (k in patch) q[k] = clone(patch[k]); });
        if (JSON.stringify(q.answers).length > 200000) return fail('answers_too_large');
        q.updated_at = now(); store(db);
        return later({ updated_at: q.updated_at, status: q.status });
      },
      submitQuestionnaire(id) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const q = db.questionnaires.find(x => x.id === id && x.user_id === u.id);
        if (!q) return fail('not_found');
        if (q.status !== 'draft') return fail('questionnaire_locked');
        if (!q.offer) return fail('offer_required');
        q.status = 'submitted'; q.submitted_at = now(); q.updated_at = now();
        event(db, 'questionnaire', q.id, u.id, 'status_changed', { from: 'draft', to: 'submitted' });
        store(db);
        return later(q);
      },
      deleteQuestionnaire(id) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const q = db.questionnaires.find(x => x.id === id && x.user_id === u.id && x.status === 'draft');
        if (!q) return fail('questionnaire_locked');
        db.questionnaires = db.questionnaires.filter(x => x !== q);
        db.attachments = db.attachments.filter(a => a.questionnaire_id !== id);
        store(db);
        return later(null);
      },

      listAttachments(qid) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        return later(db.attachments.filter(a => a.questionnaire_id === qid && a.owner_id === u.id));
      },
      uploadAttachment(qid, file, safeName, mime) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const q = db.questionnaires.find(x => x.id === qid && x.user_id === u.id && x.status === 'draft');
        if (!q) return fail('questionnaire_locked');
        if (db.attachments.filter(a => a.questionnaire_id === qid).length >= MAX_FILES) return fail('too_many_files');
        if (file.size > MAX_BYTES) return fail('Payload too large');
        const row = { id: uuid(), owner_id: u.id, questionnaire_id: qid, request_id: null,
          storage_path: u.id + '/' + qid + '/' + rnd(10) + '-' + safeName, filename: String(file.name).slice(0, 255),
          size: file.size, mime_type: mime || null, created_at: now() };
        db.attachments.push(row); store(db);
        return later(row);
      },
      removeAttachment(att) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const a = db.attachments.find(x => x.id === att.id && x.owner_id === u.id);
        const q = a && db.questionnaires.find(x => x.id === a.questionnaire_id);
        if (!a || !q || q.status !== 'draft') return fail('questionnaire_locked');
        db.attachments = db.attachments.filter(x => x !== a); store(db);
        return later(null);
      },
      downloadUrl() { return fail('mock_no_file_storage'); },

      listQuotes() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        return later(db.quotes.filter(q => q.user_id === u.id && q.sent_at && ['sent', 'viewed', 'accepted', 'expired', 'void'].includes(q.status))
          .sort((a, b) => b.sent_at.localeCompare(a.sent_at)));
      },
      getClient() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        return later(db.clients.filter(c => c.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null);
      },
      listPayments() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const mine = db.clients.filter(c => c.user_id === u.id).map(c => c.id);
        return later(db.payments.filter(p => mine.includes(p.client_id)).sort((a, b) => b.created_at.localeCompare(a.created_at)));
      },
      // Event stub: what the DB trigger + task A8 do for real (events row + q_received to the client + owner alert).
      notify(type, payload) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        event(db, payload && payload.entity || 'questionnaire', payload && payload.id || null, u.id, type, payload);
        if (type === 'q_submitted') {
          db.outbox.push({ id: uuid(), to: u.email, template: 'q_received', subject: 'Got it — your fixed quote arrives ' + ((window.Start && window.Start.BRAND.quote_sla_text) || 'soon'), created_at: now() });
          db.outbox.push({ id: uuid(), to: 'owner', template: 'admin_q_submitted', subject: 'owner alert: questionnaire submitted', payload, created_at: now() });
        }
        store(db);
        return later({ ok: true, via: 'mock-outbox', type });
      }
    };
  }

  // ------------------------------------------------------------------ dev + test helpers
  // seed(stage, pricebook): moves the signed-in user's latest submitted questionnaire forward so the Home/Quotes/Billing
  // tabs can be exercised: 'quote_sent' | 'accepted' | 'deposit_paid' | 'testing' | 'live'. Totals come from the pricebook.
  function seed(stage, pb) {
    const db = load(), u = me(db); if (!u) throw new Error('not_authenticated');
    const order = ['quote_sent', 'accepted', 'deposit_paid', 'testing', 'live'];
    const lvl = order.indexOf(stage); if (lvl < 0) throw new Error('unknown stage ' + stage);
    let q = db.questionnaires.filter(x => x.user_id === u.id && x.status !== 'draft').sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (!q) {
      q = { id: uuid(), user_id: u.id, offer: 'RCP', niche: 'home_services', status: 'submitted', answers: {}, summary: [], submitted_at: now(), created_at: now(), updated_at: now() };
      db.questionnaires.push(q);
    }
    q.status = 'quoted';
    const items = (pb && pb.items) || [];
    const code = q.offer && q.offer !== 'UNSURE' ? q.offer : 'RCP';
    const it = items.find(i => i.code === code) || { code, name: code, setup_cents: 0, monthly_cents: 0 };
    const setup = it.setup_cents || 0, monthly = it.monthly_cents || 0;
    const pct = pb && pb.rules && pb.rules.deposit_pct || 50;
    const deposit = Math.round(setup * pct / 100 / 100) * 100;
    const days = pb && pb.rules && pb.rules.quote_valid_days || 14;
    let quote = db.quotes.find(x => x.questionnaire_id === q.id);
    if (!quote) {
      quote = { id: uuid(), questionnaire_id: q.id, user_id: u.id, items: [{ code, qty: 1, name: it.name, setup_cents: setup, monthly_cents: monthly, kind: 'fixed' }],
        setup_cents: setup, monthly_cents: monthly, deposit_cents: deposit, public_token: rnd(40), pay_method: 'paypal_link', pay_link: null,
        valid_until: new Date(Date.now() + days * 86400000).toISOString(), created_at: now() };
      db.quotes.push(quote);
    }
    quote.status = 'sent'; quote.sent_at = quote.sent_at || now();
    if (lvl >= 1) { quote.status = 'accepted'; quote.accepted_at = quote.accepted_at || now(); }
    let client = db.clients.find(c => c.quote_id === quote.id);
    if (lvl >= 1 && !client) {
      client = { id: uuid(), user_id: u.id, quote_id: quote.id, products: [code], status: 'onboarding', go_live_at: null, monthly_cents: monthly, next_bill_on: null, created_at: now() };
      db.clients.push(client);
      db.payments.push({ id: uuid(), client_id: client.id, kind: 'deposit', amount_cents: deposit, method: 'paypal', status: 'due', reference: null, paid_at: null, created_at: now() });
    }
    if (lvl >= 2) db.payments.filter(p => p.client_id === client.id && p.kind === 'deposit').forEach(p => { p.status = 'paid'; p.paid_at = p.paid_at || now(); });
    if (lvl >= 3) client.status = 'testing';
    if (lvl >= 4) {
      client.status = 'live'; client.go_live_at = client.go_live_at || now();
      const nb = new Date(); nb.setMonth(nb.getMonth() + 1); client.next_bill_on = nb.toISOString().slice(0, 10);
      if (!db.payments.some(p => p.client_id === client.id && p.kind === 'final'))
        db.payments.push({ id: uuid(), client_id: client.id, kind: 'final', amount_cents: setup - deposit, method: 'paypal', status: 'paid', reference: null, paid_at: now(), created_at: now() });
    }
    store(db);
    return { questionnaire: q.id, quote: quote.id, client: client && client.id };
  }

  // ================================================================== mock admin API (task A7, site/start/admin/)
  // Same method names as the Supabase admin adapter in ../admin-backend.js. Every call requires profiles.is_admin
  // (RLS: private.is_admin()); a non-admin gets 'not_admin'. Mirrors the DB rules the admin UI relies on:
  //   quotes_guard (draft|needs_manual_price -> approved -> sent; amounts frozen after send; FOUNDING only),
  //   one active request per client (requests_one_active), log_status_change (status events), admin_notes (admin only).
  // E-mails are stubs in the outbox (quote_sent, deposit_received, request_update, admin_new_quote), like A8 will send.
  function adminApi(C) {
    const pbOf = pb => pb || (window.Start && window.Start.PB) || window.ADMIN_PB || {};
    function guard() {
      const db = load(), u = me(db);
      if (!u) return { err: 'not_authenticated' };
      const p = db.profiles.find(x => x.id === u.id);
      if (!p || !p.is_admin) return { err: 'not_admin' };
      return { db, u };
    }
    function aEvent(db, u, entity, entity_id, user_id, type, payload, visible) {
      db.events.push({ id: uuid(), actor: 'admin:' + u.id, entity, entity_id, user_id: user_id || null, type, payload: payload || {},
        client_visible: !!visible, created_at: now() });
    }
    function statusEvent(db, u, entity, row, from, to) {
      const owner = row.user_id || ((db.clients.find(c => c.id === row.client_id) || {}).user_id) || null;
      const vis = entity === 'quote' ? ['sent', 'viewed', 'accepted', 'expired'].includes(to) : true;
      aEvent(db, u, entity, row.id, owner, 'status_changed', { from, to }, vis);
    }
    const emailOf = (db, uid) => ((db.profiles.find(p => p.id === uid) || {}).email) || null;
    const companyOf = (db, uid) => { const p = db.profiles.find(x => x.id === uid) || {}; return p.company || p.full_name || p.email || ''; };
    const usd = c => '$' + Math.round((c || 0) / 100).toLocaleString('en-US');
    const run = fn => { const g = guard(); if (g.err) return fail(g.err); try { const r = fn(g.db, g.u); store(g.db); return later(r); } catch (e) { return fail(e.code || e.message); } };
    const err = code => { const e = new Error(code); e.code = code; return e; };
    const FROZEN = ['items', 'setup_cents', 'monthly_cents', 'deposit_cents', 'discount_code'];
    const QUOTE_EDITABLE = ['items', 'setup_cents', 'monthly_cents', 'deposit_cents', 'discount_code', 'scope_md', 'assumptions', 'timeline_text',
      'pay_method', 'pay_link', 'valid_until', 'status'];

    // quotes_guard (UPDATE branch) for admin writes
    function applyQuote(db, u, q, patch) {
      const next = Object.assign({}, q);
      QUOTE_EDITABLE.forEach(k => { if (k in patch) next[k] = clone(patch[k]); });
      if (next.discount_code != null && next.discount_code !== 'FOUNDING') throw err('invalid_discount');
      if (next.pay_link != null && next.pay_link !== '' && !/^https:\/\//.test(next.pay_link)) throw err('pay_link_https');
      if (next.pay_link === '') next.pay_link = null;
      if (next.pay_method != null && !['paypal_link', 'upwork', 'wire', 'tranzila_link'].includes(next.pay_method)) throw err('invalid_pay_method');
      if (q.sent_at && FROZEN.some(k => JSON.stringify(next[k]) !== JSON.stringify(q[k]))) throw err('quote_frozen_after_send');
      if (next.status !== q.status) {
        const to = next.status, from = q.status;
        if (to === 'approved' && (next.setup_cents == null || next.monthly_cents == null || next.deposit_cents == null)) throw err('quote_amounts_missing');
        if (from === 'needs_manual_price' && !['needs_manual_price', 'approved', 'void', 'draft'].includes(to)) throw err('manual_price_required');
        if (to === 'sent' && !['approved', 'sent'].includes(from)) throw err('quote_not_approved');
        if (from === 'accepted' && to !== 'void') throw err('quote_already_accepted');
        if (to === 'sent') {
          next.sent_at = now();
          const days = (pbOf().rules && pbOf().rules.quote_valid_days) || 14;
          next.valid_until = next.valid_until || new Date(Date.now() + days * 86400000).toISOString();
        }
      }
      next.updated_at = now();
      Object.assign(q, next);
      return q;
    }

    // stand-in for the quote-draft Edge Function (A6): codes from the questionnaire via StartQ.quoteHints, math via the shared pricing module (window.Pricing = /assets/pricing.mjs)
    function draftFor(db, q, pb) {
      const P = window.Pricing, Q = window.StartQ;
      if (!P) throw err('pricing_not_loaded');
      const a = Object.assign({}, q.answers || {}, { offer: q.offer, niche: q.niche });
      const hints = Q && Q.quoteHints ? Q.quoteHints(a, pb) : { add: [], custom: [] };
      const core = q.offer && q.offer !== 'UNSURE' ? q.offer : 'RCP';
      const lines = [{ code: core, qty: 1, source: 'answers' }];
      const meta = pb.integration_meta || {};
      (hints.add || []).forEach(x => {
        const it = P.itemOf(pb, x.code);
        if (it && P.addonApplies(pb, it, core) && !P.alreadyIncluded(core, x.code) && !lines.some(l => l.code === x.code))
          lines.push({ code: x.code, qty: Math.min(P.MAX_QTY, x.qty || 1), source: 'answers', systems: x.systems });
      });
      const CUSTOM_NAMES = { locations_over_3: 'More than 3 locations', call_volume: 'Call volume above the auto-quote limit' };
      (hints.custom || []).forEach(k => {
        const key = k.replace(/^(tool|crm):/, '');
        lines.push({ code: P.CUSTOM_CODE, qty: 1, source: 'answers', label: CUSTOM_NAMES[k] || ((meta[key] && meta[key].label) || key) + ' integration' });
      });
      const r = P.priceQuote(pb, lines, {});
      const open = r.lines.some(l => !l.priced);
      const it = P.itemOf(pb, core) || {};
      return {
        items: P.storedItems(r), setup_cents: open ? null : r.setup_cents, monthly_cents: open ? null : r.monthly_cents, deposit_cents: open ? null : r.deposit_cents,
        status: r.needs_manual_price ? 'needs_manual_price' : 'draft',
        scope_md: 'We will set up the ' + (it.name || core) + ' for ' + (companyOf(db, q.user_id) || 'your business') + ', based on your questionnaire answers.\n\n' +
          '(Demo draft: written by the mock quote engine, not by Claude.)',
        assumptions: ['Access to the tools listed in the questionnaire is provided within the setup checklist.', 'Prices are fixed as listed; no usage overage is billed automatically.'],
        timeline_text: it.delivery_business_days ? it.delivery_business_days + ' business days ' + (it.delivery_starts || '') : '',
        __review: { manual_reasons: r.manual_reasons, risk_flags: q.niche === 'dental' ? ['dental early access: manual review'] : [],
          questions_for_client: [], hints, removed: [], model: 'mock' }
      };
    }

    return {
      adminWhoami() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const p = db.profiles.find(x => x.id === u.id) || {};
        return later({ user: { id: u.id, email: u.email }, is_admin: !!p.is_admin });
      },
      adminListLeads() { return run(db => db.leads.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))); },
      adminListProfiles() { return run(db => db.profiles.slice()); },
      adminListQuestionnaires() { return run(db => db.questionnaires.slice().sort((a, b) => (b.submitted_at || b.updated_at).localeCompare(a.submitted_at || a.updated_at))); },
      adminListAttachments(qid) { return run(db => db.attachments.filter(a => a.questionnaire_id === qid)); },
      adminListQuotes() { return run(db => db.quotes.slice().sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at))); },
      adminRegenerateDraft(qid, pb) {
        return run((db, u) => {
          pb = pbOf(pb);
          const q = db.questionnaires.find(x => x.id === qid); if (!q) throw err('not_found');
          if (q.status === 'draft') throw err('questionnaire_not_submitted');
          const d = draftFor(db, q, pb);
          const review = d.__review; delete d.__review;
          let quote = db.quotes.filter(x => x.questionnaire_id === qid && !x.sent_at && x.status !== 'void').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
          if (quote) {
            const from = quote.status;
            Object.assign(quote, d, { discount_code: null, updated_at: now() });
            if (from !== quote.status) statusEvent(db, u, 'quote', quote, from, quote.status);
            aEvent(db, u, 'quote', quote.id, quote.user_id, 'draft_regenerated', { model: 'mock' });
          } else {
            quote = Object.assign({ id: uuid(), questionnaire_id: qid, user_id: q.user_id, discount_code: null, public_token: rnd(40),
              pay_method: null, pay_link: null, valid_until: null, sent_at: null, viewed_at: null, accepted_at: null, anonymized: false,
              agreement_version: null, created_at: now(), updated_at: now() }, d);
            db.quotes.push(quote);
            aEvent(db, u, 'quote', quote.id, quote.user_id, 'created', { to: quote.status, model: 'mock' });
            db.outbox.push({ id: uuid(), to: 'owner', template: 'admin_new_quote', quote_id: quote.id,
              subject: 'הצעה חדשה לאישור: ' + companyOf(db, q.user_id) + ' · ' + (q.offer || '') + (quote.setup_cents != null ? ' · ' + usd(quote.setup_cents) : ''), created_at: now() });
          }
          db.quote_reviews = db.quote_reviews.filter(r => r.quote_id !== quote.id);
          db.quote_reviews.push(Object.assign({ quote_id: quote.id, created_at: now(), updated_at: now() }, review));
          return quote;
        });
      },
      // quote_reviews: admin-only side panel written by quote-draft (A6 migration 20261011100400)
      adminGetQuoteReview(id) { return run(db => db.quote_reviews.find(r => r.quote_id === id) || null); },
      adminSaveQuote(id, patch) {
        return run((db, u) => {
          const q = db.quotes.find(x => x.id === id); if (!q) throw err('not_found');
          if (q.anonymized) throw err('quote_anonymized');
          const from = q.status;
          applyQuote(db, u, q, patch || {});
          if (from !== q.status) statusEvent(db, u, 'quote', q, from, q.status);
          aEvent(db, u, 'quote', q.id, q.user_id, 'admin_edit', { fields: Object.keys(patch || {}).filter(k => k !== 'status') });
          return q;
        });
      },
      // "אשר ושלח" = the quote-send Edge Function (A6): {discount_code?, pay_method?, pay_link?, manual_approved?}.
      // Re-prices from the stored codes, refuses anonymized / not sendable / unresolved manual price (unless manual_approved
      // covers only the over-threshold check), then draft|needs_manual_price -> approved -> sent + quote_sent e-mail event.
      quoteSend(id, opts) {
        opts = opts || {};
        return run((db, u) => {
          const P = window.Pricing, pb = pbOf();
          const q = db.quotes.find(x => x.id === id); if (!q) throw err('quote_not_found');
          if (q.anonymized) throw err('quote_anonymized');
          if (!['draft', 'needs_manual_price', 'approved'].includes(q.status)) throw err('quote_not_sendable:' + q.status);
          if (opts.pay_link && !/^https:\/\//.test(opts.pay_link)) throw err('bad_pay_link');
          const discount = opts.discount_code === undefined ? q.discount_code : opts.discount_code;
          // same verdict as quote-send: shared pricing module + the FOUNDING cap counted from the DB
          const used = discount ? db.quotes.filter(x => x.id !== q.id && x.discount_code === discount && ['sent', 'viewed', 'accepted'].includes(x.status)).length : 0;
          const v = P.validateItems(pb, q.items, { discount_code: discount || null, manual_approved: !!opts.manual_approved, founding_used: used });
          if (v.errors.length) throw err('pricing_failed:' + v.errors.join(','));
          if (v.needs_manual_price) throw err('needs_manual_price');
          if (v.blockers.includes('founding_limit_reached')) throw err('founding_limit_reached');
          const r = P.priceQuote(pb, P.inputsFromStored(q.items, pb), { discount_code: discount || null, manual_approved: !!opts.manual_approved });
          const patch = { items: P.storedItems(r), discount_code: discount || null, setup_cents: r.setup_cents,
            monthly_cents: r.monthly_cents, deposit_cents: r.deposit_cents };
          if ('pay_method' in opts && opts.pay_method !== undefined) patch.pay_method = opts.pay_method;
          if ('pay_link' in opts && opts.pay_link !== undefined) patch.pay_link = opts.pay_link || null;
          let from = q.status;
          if (from !== 'approved') { applyQuote(db, u, q, Object.assign({ status: 'approved' }, patch)); statusEvent(db, u, 'quote', q, from, 'approved'); from = 'approved'; }
          else applyQuote(db, u, q, patch);
          applyQuote(db, u, q, { status: 'sent' }); statusEvent(db, u, 'quote', q, from, 'sent');
          const qn = db.questionnaires.find(x => x.id === q.questionnaire_id);
          if (qn && qn.status === 'submitted') { qn.status = 'quoted'; qn.updated_at = now(); statusEvent(db, u, 'questionnaire', qn, 'submitted', 'quoted'); }
          const brand = (window.ADMIN_BRAND && window.ADMIN_BRAND.name) || (window.Start && window.Start.BRAND && window.Start.BRAND.name) || '';
          db.outbox.push({ id: uuid(), to: emailOf(db, q.user_id), template: 'quote_sent', quote_id: q.id,
            subject: 'Your fixed quote from ' + brand + ': ' + usd(q.setup_cents) + ' + ' + usd(q.monthly_cents) + '/mo', created_at: now() });
          aEvent(db, u, 'quote', q.id, q.user_id, 'email_requested', { template: 'quote_sent' });
          return { quote_id: q.id, status: q.status, valid_until: q.valid_until };
        });
      },
      adminCreateClientFromQuote(quoteId) {
        return run((db, u) => {
          const q = db.quotes.find(x => x.id === quoteId); if (!q) throw err('not_found');
          if (q.status !== 'accepted') throw err('quote_not_accepted');
          let c = db.clients.find(x => x.quote_id === q.id);
          if (c) return c;
          const core = (q.items || []).map(i => i.code).find(cd => ['RCP', 'WEB', 'BNDL'].includes(cd)) || 'RCP';
          c = { id: uuid(), user_id: q.user_id, quote_id: q.id, products: [core], status: 'onboarding', go_live_at: null, monthly_cents: q.monthly_cents,
            next_bill_on: null, ended_at: null, business_name: companyOf(db, q.user_id), created_at: now(), updated_at: now() };
          db.clients.push(c);
          aEvent(db, u, 'client', c.id, c.user_id, 'created', { to: 'onboarding' }, true);
          db.payments.push({ id: uuid(), client_id: c.id, kind: 'deposit', amount_cents: q.deposit_cents || 0, method: q.pay_method, status: 'due',
            reference: null, paid_at: null, created_at: now(), updated_at: now() });
          db.payments.push({ id: uuid(), client_id: c.id, kind: 'final', amount_cents: (q.setup_cents || 0) - (q.deposit_cents || 0), method: q.pay_method, status: 'due',
            reference: null, paid_at: null, created_at: now(), updated_at: now() });
          return c;
        });
      },
      adminListClients() { return run(db => db.clients.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))); },
      adminSaveClient(id, patch) {
        return run((db, u) => {
          const c = db.clients.find(x => x.id === id); if (!c) throw err('not_found');
          const from = c.status;
          if ('status' in patch) {
            if (!['onboarding', 'building', 'testing', 'live', 'paused', 'cancelled'].includes(patch.status)) throw err('invalid_status');
            c.status = patch.status;
            if (c.status === 'live' && !c.go_live_at) c.go_live_at = now();
            c.ended_at = c.status === 'cancelled' ? (c.ended_at || now()) : null;
          }
          c.updated_at = now();
          if (from !== c.status) {
            statusEvent(db, u, 'client', c, from, c.status);
            const T = { testing: 'ready_to_test', live: 'went_live' };
            if (T[c.status]) db.outbox.push({ id: uuid(), to: emailOf(db, c.user_id), template: T[c.status], created_at: now() });
          }
          return c;
        });
      },
      adminListPayments() { return run(db => db.payments.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))); },
      adminMarkPaid(paymentId, reference) {
        return run((db, u) => {
          const p = db.payments.find(x => x.id === paymentId); if (!p) throw err('not_found');
          if (p.status === 'paid') return p;
          p.status = 'paid'; p.paid_at = now(); p.reference = String(reference || '').slice(0, 300) || null; p.updated_at = now();
          const c = db.clients.find(x => x.id === p.client_id) || {};
          aEvent(db, u, 'payment', p.id, c.user_id, 'payment_marked_paid', { kind: p.kind, amount_cents: p.amount_cents, reference: p.reference }, true);
          if (p.kind === 'deposit') db.outbox.push({ id: uuid(), to: emailOf(db, c.user_id), template: 'deposit_received', subject: 'Welcome aboard — your setup checklist is ready', created_at: now() });
          return p;
        });
      },
      adminListOnboarding() { return run(db => db.onboarding_items.slice().sort((a, b) => a.sort - b.sort)); },
      adminListTenants() { return run(db => db.tenants.slice()); },
      // runtime_state is service-role only in Supabase; the mock exposes it so the summary can be designed now
      adminRuntimeState(tenantId) { return run(db => db.runtime_state.filter(r => r.tenant_id === tenantId)); },
      adminListRequests() { return run(db => db.requests.slice().sort((a, b) => a.position - b.position)); },
      adminSaveRequest(id, patch) {
        return run((db, u) => {
          const r = db.requests.find(x => x.id === id); if (!r) throw err('not_found');
          const from = r.status;
          if ('status' in patch) {
            if (!['queued', 'active', 'waiting_on_you', 'done', 'declined'].includes(patch.status)) throw err('invalid_status');
            if (patch.status === 'active' && db.requests.some(x => x.client_id === r.client_id && x.id !== r.id && x.status === 'active')) throw err('one_active_request');
            r.status = patch.status;
          }
          if ('admin_reply' in patch) r.admin_reply = patch.admin_reply ? String(patch.admin_reply).slice(0, 10000) : null;
          r.updated_at = now();
          const c = db.clients.find(x => x.id === r.client_id) || {};
          if (from !== r.status) {
            statusEvent(db, u, 'request', r, from, r.status);
            db.outbox.push({ id: uuid(), to: emailOf(db, c.user_id), template: 'request_update', subject: 'Request "' + r.title + '" is now ' + r.status, created_at: now() });
          } else aEvent(db, u, 'request', r.id, c.user_id, 'admin_reply', {}, true);
          return r;
        });
      },
      adminListEvents(limit) { return run(db => db.events.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit || 300)); },
      adminLogEvent(entity, entity_id, user_id, type, payload) { return run((db, u) => { aEvent(db, u, entity, entity_id, user_id, type, payload); return { ok: true }; }); },
      adminGetNote(entity, id) { return run(db => (db.admin_notes.find(n => n.entity === entity && n.entity_id === id) || { body: '' }).body); },
      adminSaveNote(entity, id, body) {
        return run((db, u) => {
          let n = db.admin_notes.find(x => x.entity === entity && x.entity_id === id);
          if (!n) { n = { entity, entity_id: id, body: '' }; db.admin_notes.push(n); }
          n.body = String(body || '').slice(0, 20000); n.updated_at = now();
          aEvent(db, u, entity, id, null, 'admin_note_saved', {});
          return n;
        });
      },
      adminOutbox() { return run(db => db.outbox.slice().reverse()); }
    };
  }

  // Demo data for the admin (mock only): 4 businesses across the funnel. Prices are computed from the price book.
  function seedAdmin(pb) {
    const db = load(), u = me(db);
    const P = window.Pricing;
    if (!u || !P) throw new Error('not_ready');
    const ago = h => new Date(Date.now() - h * 3600000).toISOString();
    function person(email, full_name, company, niche, extra) {
      let x = db.users.find(y => y.email === email);
      if (!x) { x = { id: uuid(), email, created_at: ago(200) }; db.users.push(x); }
      const base = Object.assign({ id: x.id, email, full_name, company, phone: '7135550100', city: 'Houston', state: 'TX',
        timezone: 'America/Chicago', niche, website: null, how_heard: 'upwork', update_lang: 'en', is_admin: false, created_at: ago(200), updated_at: ago(200) }, extra || {});
      const have = db.profiles.find(p => p.id === x.id);
      if (!have) db.profiles.push(base);
      else Object.keys(base).forEach(k => { if (have[k] == null || have[k] === '') have[k] = base[k]; });   // fill blanks only
      return x.id;
    }
    const sys = (entity, entity_id, user_id, type, payload, h) => db.events.push({ id: uuid(), actor: 'client:' + user_id, entity, entity_id, user_id, type, payload: payload || {}, client_visible: true, created_at: ago(h) });
    function qn(uid, offer, niche, answers, status, h) {
      const q = { id: uuid(), user_id: uid, offer, niche, status, answers: Object.assign({ offer, niche }, answers), summary: [], submitted_at: status === 'draft' ? null : ago(h),
        created_at: ago(h + 2), updated_at: ago(h) };
      if (window.StartQ) q.summary = window.StartQ.buildSummary(q.answers, Object.assign({ _niches: [] }, pb));
      db.questionnaires.push(q); sys('questionnaire', q.id, uid, 'status_changed', { from: 'draft', to: status }, h);
      return q;
    }
    function quote(q, lines, status, extra) {
      const res = P.priceQuote(pb, lines, { discount_code: extra && extra.discount_code });
      const open = res.lines.some(l => !l.priced);
      const qt = Object.assign({ id: uuid(), questionnaire_id: q.id, user_id: q.user_id, status, items: P.storedItems(res),
        setup_cents: open ? null : res.setup_cents, monthly_cents: open ? null : res.monthly_cents,
        deposit_cents: open ? null : res.deposit_cents, discount_code: null,
        scope_md: 'We will set up the receptionist for this business, based on the questionnaire answers.\n\n(Demo draft from the mock quote engine.)',
        assumptions: ['Access to the listed tools is provided within the setup checklist.'], timeline_text: '10 business days after access is complete',
        valid_until: null, public_token: rnd(40), pay_method: 'paypal_link', pay_link: null, agreement_version: null, sent_at: null, viewed_at: null,
        accepted_at: null, accepted_name: null, anonymized: false, created_at: ago(20), updated_at: ago(20) }, extra || {});
      db.quotes.push(qt);
      return qt;
    }
    if (db.leads.length || db.quotes.some(q => q.scope_md && q.scope_md.indexOf('Demo draft') !== -1)) return { already: true };
    const dani = person('dani@coolbreeze.test', 'Dani Levi', 'Cool Breeze HVAC', 'home_services');
    const tom = person('tom@austinplumb.test', 'Tom Reyes', 'Austin Plumbing Co', 'home_services', { city: 'Austin' });
    const amy = person('amy@lonestarhomes.test', 'Amy Carter', 'Lone Star Homes', 'real_estate', { city: 'Dallas' });
    const ray = person('ray@brightair.test', 'Ray Brooks', 'Bright Air Heating & Cooling', 'home_services', { city: 'Phoenix', state: 'AZ', timezone: 'America/Phoenix' });

    db.leads.push({ id: uuid(), email: 'mike@quickfixgarage.test', niche: 'home_services', source_page: '/home-services/', utm: { source: 'upwork' }, created_at: ago(5) });
    db.leads.push({ id: uuid(), email: 'sara@smiledental.test', niche: 'dental', source_page: '/dental/', utm: {}, created_at: ago(30) });
    db.leads.push({ id: uuid(), email: 'dani@coolbreeze.test', niche: 'home_services', source_page: '/', utm: { source: 'google' }, created_at: ago(60) });

    const q1 = qn(dani, 'RCP', 'home_services', { services: ['hvac'], service_area: 'Houston 77002 77005', locations: '1', tools: ['google_calendar', 'jobber'], spanish: 'no' }, 'submitted', 3);
    quote(q1, [{ code: 'RCP' }, { code: 'ADD-CRM', qty: 1 }], 'draft', { scope_md: 'We will set up the Missed-Call AI Receptionist for Cool Breeze HVAC with Jobber and Google Calendar.\n\n(Demo draft from the mock quote engine.)' });
    const q2 = qn(tom, 'RCP', 'home_services', { services: ['plumbing'], locations: '2', tools: ['servicetitan'] }, 'submitted', 8);
    const qm = quote(q2, [{ code: 'RCP' }, { code: 'ADD-LOC', qty: 1 }, { code: 'CUSTOM', label: 'ServiceTitan integration' }], 'needs_manual_price');
    db.quote_reviews.push({ quote_id: qm.id, manual_reasons: ['custom:ServiceTitan integration'], risk_flags: ['ServiceTitan API access needs the client\'s admin account'],
      questions_for_client: ['Which ServiceTitan plan are you on?'], hints: {}, removed: ['We guarantee 30% more booked jobs.'], model: 'mock', created_at: ago(8), updated_at: ago(8) });
    const q3 = qn(amy, 'RCP', 'real_estate', { re_crm: 'follow_up_boss' }, 'quoted', 50);
    quote(q3, [{ code: 'RCP' }], 'sent', { sent_at: ago(40), valid_until: new Date(Date.now() + 11 * 86400000).toISOString(), pay_link: 'https://www.paypal.com/invoice/demo' });
    const q4 = qn(ray, 'RCP', 'home_services', { tools: ['google_calendar'] }, 'quoted', 400);
    const qa = quote(q4, [{ code: 'RCP' }, { code: 'ADD-ES' }], 'accepted', { discount_code: 'FOUNDING', sent_at: ago(380), accepted_at: ago(370), accepted_name: 'Ray Brooks', agreement_version: '1.0-draft' });
    qn(dani, 'WEB', 'home_services', { has_website: 'no' }, 'draft', 1);

    const c = { id: uuid(), user_id: ray, quote_id: qa.id, products: ['RCP'], status: 'live', go_live_at: ago(100), monthly_cents: qa.monthly_cents,
      next_bill_on: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10), ended_at: null, business_name: 'Bright Air Heating & Cooling', created_at: ago(370), updated_at: ago(100) };
    db.clients.push(c);
    db.payments.push({ id: uuid(), client_id: c.id, kind: 'deposit', amount_cents: qa.deposit_cents, method: 'paypal', status: 'paid', reference: 'PP-DEMO-1', paid_at: ago(360), created_at: ago(370), updated_at: ago(360) });
    db.payments.push({ id: uuid(), client_id: c.id, kind: 'final', amount_cents: qa.setup_cents - qa.deposit_cents, method: 'paypal', status: 'paid', reference: 'PP-DEMO-2', paid_at: ago(110), created_at: ago(200), updated_at: ago(110) });
    db.payments.push({ id: uuid(), client_id: c.id, kind: 'monthly', amount_cents: qa.monthly_cents, method: 'paypal', status: 'due', reference: null, paid_at: null, created_at: ago(2), updated_at: ago(2) });
    ['business_details', 'faq', 'alerts', 'calendar', 'sms_registration', 'other_tools', 'call_forwarding'].forEach((k, i) =>
      db.onboarding_items.push({ id: uuid(), client_id: c.id, key: k, title: k.replace(/_/g, ' '), video_url: null, sort: i, status: i < 5 ? 'done' : (i === 5 ? 'need_help' : 'todo'),
        data: {}, done_at: i < 5 ? ago(300 - i * 10) : null, created_at: ago(360), updated_at: ago(200) }));
    const t = { id: uuid(), client_id: c.id, slug: 'bright-air', status: 'live', twilio_number: '+16025550147', created_at: ago(300), updated_at: ago(100),
      config: { business: { name: 'Bright Air Heating & Cooling', niche: 'hvac', timezone: 'America/Phoenix', service_area_zips: ['85001', '85004', '85008'] },
        hours: { mon: ['07:00', '18:00'], tue: ['07:00', '18:00'], wed: ['07:00', '18:00'], thu: ['07:00', '18:00'], fri: ['07:00', '17:00'], sat: null, sun: null },
        after_hours: { mode: 'book_next_day' }, booking: { provider: 'calendly' }, pricing: { mode: 'none', items: [] },
        faq: [{ q: 'Do you service Trane units?', a: 'Yes, all major brands.' }, { q: 'Do you offer financing?', a: 'Our team can explain options on site.' }],
        handoff: { mode: 'dial' }, notify: { sms: ['+16025550111'], email: ['ray@brightair.test'] }, guard: { daily_budget_usd: 3 }, paused: false } };
    db.tenants.push(t);
    const month = new Date().toISOString().slice(0, 7);
    db.runtime_state.push({ id: uuid(), key: 'usage:' + t.id + ':' + month, tenant_id: t.id, value: { voice_minutes: 212, sms_segments: 480, calls: 64, bookings: 19 }, updated_at: ago(1) });
    db.runtime_state.push({ id: uuid(), key: 'spend:' + t.id + ':' + new Date().toISOString().slice(0, 10), tenant_id: t.id, value: { usd: 0.84 }, updated_at: ago(1) });
    db.requests.push({ id: uuid(), client_id: c.id, title: 'Add a question about filter size', body: 'Callers keep asking which filter size to buy.', status: 'active', position: 0, admin_reply: null, created_at: ago(30), updated_at: ago(20) });
    db.requests.push({ id: uuid(), client_id: c.id, title: 'Change Saturday hours', body: 'We now open 8–12 on Saturdays.', status: 'queued', position: 1, admin_reply: null, created_at: ago(10), updated_at: ago(10) });
    db.requests.push({ id: uuid(), client_id: c.id, title: 'Spanish greeting', body: '', status: 'done', position: 2, admin_reply: 'Done.', created_at: ago(300), updated_at: ago(250) });
    store(db);
    return { ok: true };
  }

  // ------------------------------------------------------------------ admin (task A7): see mock-admin section below
  window.StartMock = {
    create: C => Object.assign(create(C), adminApi(C)),
    MOCK_ADMIN_EMAIL,
    admin: {
      reset() { ls.del(KEY); ls.del(SKEY); },
      db: load,
      inbox: email => load().outbox.filter(m => !email || m.to === email),
      seed,
      seedAdmin   // A7: demo data for /start/admin/
    }
  };
})();
