/* Mock backend for the client portal: same API as the Supabase adapter in ../backend.js, stored in this browser's
   localStorage. No network, no real e-mail. Mirrors the server rules that matter to the UI:
     - ownership (RLS): a user sees and edits only rows where user_id/owner_id = own id; other ids read as "not found"
     - questionnaire guard: edits only while 'draft'; submit needs an offer; max 20 per user; locked afterwards
     - attachments: own draft only, max 5 per questionnaire, max 10 MB each
     - quotes visible to the client only from 'sent' on (sent_at set)
   E-mails go to an in-browser outbox (shown on the sign-in screen in mock mode).
   Test/dev helpers: window.StartMock.admin.{reset, db, inbox, seed(stage, pricebook)}.
   Social sign-in (Google / Apple) is simulated, never contacting a provider: on localhost /start/?mock=1&mock_providers=google,apple
   shows the buttons; a click "redirects" to /start/?mock_oauth=<provider> and the return is decided by mock_oauth_outcome=
   ok (default; signs in as <provider>.user@example.test, or mock_oauth_email=…) | hide (Apple relay address) | cancel | down | conflict
   (the last three come back exactly like Supabase does: #error=…&error_code=…&error_description=…). */
(function () {
  const KEY = 'aplp_mock_db_v1', SKEY = 'aplp_mock_session_v1';
  const ls = {
    get: k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del: k => { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing_path', 'first_seen'];
  const webOnly = (db, u, offer) => !offer || offer === 'WEB' || !!(db.profiles.find(p => p.id === u.id) || {}).is_admin;
  function cleanUtm(u) {
    const out = {};
    if (u && typeof u === 'object' && !Array.isArray(u)) UTM_KEYS.forEach(k => { if (typeof u[k] === 'string' && u[k]) out[k] = u[k].slice(0, 200); });
    return out;
  }
  const TABLES = ['users', 'profiles', 'questionnaires', 'attachments', 'quotes', 'clients', 'payments', 'events', 'outbox', 'otps',
    'leads', 'onboarding_items', 'requests', 'tenants', 'runtime_state', 'admin_notes', 'quote_reviews',   // second row: admin (A7)
    'calls', 'sms_messages', 'bookings', 'dispatch_events',   // third row: receptionist data written by the runtime (B7 reads it)
    'subscriptions', 'provisioning_jobs', 'trial_claims', 'tenant_credentials',   // FirstRing plans (*_us_subscriptions.sql)
    'billing_checkouts', 'paddle_calls'];   // sign-up + Paddle (*_us_paddle.sql); paddle_calls = what paddle-billing would send to Paddle
  // mirrors private.handle_new_user() setting is_admin for the owner's address; in the mock that address is a demo one
  const MOCK_ADMIN_EMAIL = () => (window.SITE_CONFIG && window.SITE_CONFIG.MOCK_ADMIN_EMAIL) || 'admin@demo.local';
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  };
  (function mockSocialFlags() {   // per-tab switches for tests/demos (see the header comment)
    const p = new URLSearchParams(location.search);
    if (p.has('mock_providers')) ss.set('start_mock_providers', p.get('mock_providers') || '');
    if (p.has('mock_oauth_outcome')) ss.set('start_mock_oauth_outcome', p.get('mock_oauth_outcome') || 'ok');
    if (p.has('mock_oauth_email')) ss.set('start_mock_oauth_email', p.get('mock_oauth_email') || '');
  })();
  const mockProviders = () => (ss.get('start_mock_providers') || '').split(',').map(x => x.trim()).filter(Boolean);
  const RELAY_DEMO = 'k7x2mq9ab3@privaterelay.appleid.com';
  // = defaultPayMethod() in /assets/quote_view.mjs: a new draft starts with it, quote-send falls back to it (tools/e2e_admin.mjs).
  // Card / PayPal checkout while brand.json payments.paypal is on (same rule as paypalOn()), else Upwork Direct Contracts.
  const ppOnBrand = b => { const p = b && b.payments && b.payments.paypal; return !!(p && p.enabled === true && /^[A-Za-z0-9_-]{16,128}$/.test(p.client_id || '')); };
  const brandNow = () => window.ADMIN_BRAND || (window.Start && window.Start.BRAND) || {};
  const PAY_DEFAULT = () => (ppOnBrand(brandNow()) ? 'paypal_checkout' : 'upwork');
  const PAY_METHODS = ['paypal_link', 'upwork', 'wire', 'tranzila_link', 'paypal_checkout'];
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
      db.profiles.push({ id: u.id, email, contact_email: null, full_name: null, company: null, phone: null, city: null, state: null, timezone: null,
        niche: null, website: null, how_heard: null, update_lang: 'en', is_admin: email === MOCK_ADMIN_EMAIL(), created_at: now(), updated_at: now() });
    }
    ls.set(SKEY, { uid: u.id });
    return u;
  }

  function create(C) {
    const MAX_FILES = C.MAX_FILES || 5, MAX_BYTES = (C.MAX_FILE_MB || 10) * 1048576;
    const providers = mockProviders().filter(x => x === 'google' || x === 'apple');
    const OAUTH_BACK = { cancel: 'error=access_denied&error_code=user_cancelled&error_description=User+cancelled+the+sign-in',
      down: 'error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code',
      conflict: 'error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked+to+another+user' };
    function oauthStart(provider) {
      if (providers.indexOf(provider) === -1) return fail('provider_disabled');
      // like supabase-js: the page leaves for the provider; here the "provider" is this same page. A refusal comes back
      // exactly as Supabase sends it (in the hash); a success comes back with a marker that consumeLink() turns into a session.
      const back = OAUTH_BACK[ss.get('start_mock_oauth_outcome') || 'ok'];
      location.assign(back ? '/start/#' + back : '/start/?mock_oauth=' + provider);
      return new Promise(() => {});   // never resolves: navigation is under way
    }
    return {
      mode: 'mock',
      googleEnabled: providers.indexOf('google') !== -1,
      appleEnabled: providers.indexOf('apple') !== -1,
      providers: ['google', 'apple'].filter(x => providers.indexOf(x) !== -1),
      getSession() { return later(session(me(load()))); },
      consumeLink() {
        const p = new URLSearchParams(location.search);
        const tok = p.get('mock_token');
        const db = load();
        const prov = p.get('mock_oauth');
        if (prov) {
          const email = ss.get('start_mock_oauth_outcome') === 'hide' ? RELAY_DEMO : (ss.get('start_mock_oauth_email') || (prov + '.user@example.test'));
          history.replaceState(null, '', location.pathname);
          const u = signIn(db, email); store(db);
          return later(session(u));
        }
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
      signInWithGoogle() { return oauthStart('google'); },
      signInWithApple() { return oauthStart('apple'); },
      signOut() { ls.del(SKEY); return later(null); },

      getProfile() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        return later(db.profiles.find(p => p.id === u.id) || null);
      },
      saveProfile(patch) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const p = db.profiles.find(x => x.id === u.id); if (!p) return fail('not_found');
        const ok = ['full_name', 'company', 'phone', 'city', 'state', 'timezone', 'niche', 'website', 'how_heard', 'update_lang', 'contact_email'];
        ok.forEach(k => { if (k in patch) p[k] = patch[k]; });   // id/email/is_admin are ignored, like profiles_guard
        if (p.contact_email != null && p.contact_email !== '' && !window.StartSignin.validEmail(p.contact_email)) return fail('invalid_contact_email');
        if (p.contact_email) p.contact_email = String(p.contact_email).trim().toLowerCase();
        if (p.update_lang !== 'en' && p.update_lang !== 'he') return fail('invalid_update_lang');
        if (p.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch (e) { return fail('invalid_timezone'); } }
        p.updated_at = now(); store(db);
        return later(p);
      },

      // = private.questionnaires_offer_guard (20261127200000_us_questionnaire_web_only.sql): a client creates / edits / sends
      // website questionnaires only (FirstRing = the plan sign-up); admins are not limited; locked rows are not editable anyway
      listQuestionnaires() {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        const rows = db.questionnaires.filter(q => q.user_id === u.id)
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map(q => ({ id: q.id, offer: q.offer, niche: q.niche, status: q.status, created_at: q.created_at, updated_at: q.updated_at, submitted_at: q.submitted_at }));
        return later(rows);
      },
      // mirrors private.questionnaires_guard (20261025100000_us_questionnaire_utm.sql): whitelisted keys, strings, 200 chars
      createQuestionnaire(init) {
        const db = load(), u = me(db); if (!u) return fail('not_authenticated');
        if (!webOnly(db, u, init && init.offer)) return fail('offer_not_offered');
        if (db.questionnaires.filter(q => q.user_id === u.id).length >= 20) return fail('too_many_questionnaires');
        const q = { id: uuid(), user_id: u.id, offer: init && init.offer || null, niche: init && init.niche || null, status: 'draft',
          answers: {}, summary: [], submitted_at: null, created_at: now(), updated_at: now(), utm: cleanUtm(init && init.utm) };
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
        if (!webOnly(db, u, 'offer' in patch ? patch.offer : q.offer)) return fail('offer_not_offered');
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
        if (!webOnly(db, u, q.offer)) return fail('offer_not_offered');
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
        if (type === 'web_deposit_link_requested') {   // WEB: no quote step; the owner sends the deposit link
          db.outbox.push({ id: uuid(), to: 'owner', template: 'admin_web_deposit_link_requested', subject: 'owner alert: website deposit link requested', payload, created_at: now() });
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
      if (next.pay_method != null && !PAY_METHODS.includes(next.pay_method)) throw err('invalid_pay_method');
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
        if (it && P.isAvailable(it) && P.addonApplies(pb, it, core) && !P.alreadyIncluded(core, x.code, pb) && !lines.some(l => l.code === x.code))
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
        __review: { manual_reasons: r.manual_reasons, risk_flags: [],
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
              pay_method: PAY_DEFAULT(), pay_link: null, valid_until: null, sent_at: null, viewed_at: null, accepted_at: null, anonymized: false,
              agreement_version: null, created_at: now(), updated_at: now() }, d);
            db.quotes.push(quote);
            aEvent(db, u, 'quote', quote.id, quote.user_id, 'created', { to: quote.status, model: 'mock' });
            db.outbox.push({ id: uuid(), to: 'owner', template: 'admin_new_quote', quote_id: quote.id,
              subject: 'New quote to approve: ' + companyOf(db, q.user_id) + ' · ' + (q.offer || '') + (quote.setup_cents != null ? ' · ' + usd(quote.setup_cents) : ''), created_at: now() });
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
      // "Approve and send" = the quote-send Edge Function (A6): {discount_code?, pay_method?, pay_link?, manual_approved?}.
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
          patch.pay_method = opts.pay_method || q.pay_method || PAY_DEFAULT();   // quote-send: no method given or stored -> the default
          if (patch.pay_method === 'paypal_checkout' && !ppOnBrand(brandNow())) throw err('paypal_off');   // as quote-send
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
      // = the pay-refund Edge Function: full PayPal refund of a paid PayPal deposit within refund_rules.deposit.window_days
      adminRefundPayment(paymentId) {
        return run((db, u) => {
          const p = db.payments.find(x => x.id === paymentId); if (!p) throw err('payment_not_found');
          if (p.provider !== 'paypal' || !p.provider_capture_id) throw err('not_paypal');
          if (p.status === 'refunded') return { status: 'refunded', refund_status: 'ALREADY_REFUNDED' };
          if (p.status !== 'paid') throw err('not_paid');
          if (p.kind !== 'deposit') throw err('not_deposit');
          const days = ((pbOf().refund_rules || {}).deposit || {}).window_days || 7;
          if (!p.paid_at || Date.now() - Date.parse(p.paid_at) > days * 864e5) throw err('refund_window_passed');
          p.status = 'refunded'; p.updated_at = now();
          const c = db.clients.find(x => x.id === p.client_id) || {};
          aEvent(db, u, 'payment', p.id, c.user_id, 'payment_refunded', { provider: 'paypal', kind: p.kind, amount_cents: p.amount_cents, capture_id: p.provider_capture_id }, false);
          return { status: 'refunded', refund_status: 'COMPLETED' };
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
            if (patch.status === 'active' && r.status !== 'active' && r.paused) throw err('request_paused');   // B7: requests_paused_guard
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
    db.leads.push({ id: uuid(), email: 'sara@sunbeltrealty.test', niche: 'real_estate', source_page: '/real-estate/', utm: {}, created_at: ago(30) });
    db.leads.push({ id: uuid(), email: 'dani@coolbreeze.test', niche: 'home_services', source_page: '/', utm: { source: 'google' }, created_at: ago(60) });

    const q1 = qn(dani, 'RCP', 'home_services', { services: ['hvac'], service_area: 'Houston 77002 77005', locations: '1', tools: ['google_calendar', 'jobber'], spanish: 'no' }, 'submitted', 3);
    quote(q1, [{ code: 'RCP' }, { code: 'ADD-CRM', qty: 1 }], 'draft', { scope_md: 'We will set up the FirstRing AI Receptionist for Cool Breeze HVAC with Jobber and Google Calendar.\n\n(Demo draft from the mock quote engine.)' });
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

  // ================================================================== mock portal phase B (task B7)
  // Same method names as the Supabase adapters in ../backend.js (client) and ../admin-backend.js (admin*). Mirrors
  // supabase/migrations/*_us_portal_b7.sql and the A1 rules the UI relies on:
  //   onboarding_items: created when the deposit is paid (trigger payments_seed_onboarding), client writes only through
  //     update_onboarding_item (status todo|done|need_help + data merge); start_forwarding_test stamps the time server-side;
  //     a call to the tenant number within 30 min marks forward_calls done (trigger calls_forwarding_test).
  //   tenants: client writes only through update_tenant_settings (whitelist hours/faq/notify/paused, same shape checks).
  //   requests: insert = queued at the end (max 25 open); title/body/position/paused editable only while queued;
  //     cancel = delete while queued (logged); one active request per client (admin side, A7).
  //   calls/sms_messages/bookings: read-only, own tenant only. Usage: client_tenant_usage / admin_tenant_usage.
  const OB_ITEMS = [   // key, title, sort, for receptionist (RCP/BNDL), for website-only (WEB) — same table as private.seed_onboarding
    ['forward_calls', 'Forward your missed calls', 1, true, false], ['calendar', 'Connect your calendar', 2, true, false],
    ['hours', 'Business hours', 3, true, true], ['faq', 'Services & FAQ', 4, true, false],
    ['alerts', 'Emergencies & alerts', 5, true, true], ['tools', 'Connect other tools', 6, true, false],
    ['sms', 'Texting registration & go-live', 7, true, false], ['web_content', 'Website content', 6, false, true]];
  function seedOnboardingAll(db) {
    db.clients.forEach(c => {
      if (!db.payments.some(p => p.client_id === c.id && p.kind === 'deposit' && p.status === 'paid')) return;
      if (db.onboarding_items.some(o => o.client_id === c.id)) return;   // the trigger fires once, on the deposit-paid transition
      const prods = c.products || [];
      const rcp = prods.some(x => x === 'RCP' || x === 'BNDL'), web = prods.length === 1 && prods[0] === 'WEB';
      OB_ITEMS.forEach(([key, title, sort, forRcp, forWeb]) => {
        if (!((forRcp && rcp) || (forWeb && web))) return;
        if (db.onboarding_items.some(o => o.client_id === c.id && o.key === key)) return;
        db.onboarding_items.push({ id: uuid(), client_id: c.id, key, title, video_url: null, sort, status: 'todo', data: {}, done_at: null, created_at: now(), updated_at: now() });
      });
    });
  }
  const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/, E164 = /^\+[1-9][0-9]{6,14}$/, EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;
  // public.update_tenant_settings checks (migration *_us_settings_portal_b7.sql = runtime/app/tenant_schema.json limits),
  // same error codes: invalid_setting:<path>, field_not_allowed: <key>
  const US_E164 = v => typeof v === 'string' && /^\+[1-9][0-9]{7,14}$/.test(v) && /^\+1[2-9][0-9]{9}$/.test(v);
  function checkSettingsPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'patch_must_be_object';
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (['hours', 'faq', 'notify', 'paused', 'after_hours', 'on_call_number', 'real_estate', 'spanish'].indexOf(k) === -1) return 'field_not_allowed: ' + k;   // spanish: P2 block below
      if (k === 'paused' && typeof v !== 'boolean') return 'invalid_setting:paused';
      if (k === 'spanish' && typeof v !== 'boolean') return 'invalid_setting:spanish';   // P2
      if (k === 'hours') {
        if (!isObj(v)) return 'invalid_setting:hours';
        for (const d of Object.keys(v)) {
          if (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(d) === -1) return 'invalid_setting:hours.' + d;
          const x = v[d];
          if (!(x === null || (Array.isArray(x) && x.length === 2 && HHMM.test(x[0]) && HHMM.test(x[1]) && x[0] < x[1]))) return 'invalid_setting:hours.' + d;
        }
      }
      if (k === 'faq') {
        if (!Array.isArray(v) || v.length > 25) return 'invalid_setting:faq';
        for (let i = 0; i < v.length; i++) {
          const e = v[i];
          if (!isObj(e) || Object.keys(e).some(x => x !== 'q' && x !== 'a')) return 'invalid_setting:faq[' + i + ']';
          if (typeof e.q !== 'string' || e.q.length < 1 || e.q.length > 300) return 'invalid_setting:faq[' + i + '].q';
          if (typeof e.a !== 'string' || e.a.length < 1 || e.a.length > 600) return 'invalid_setting:faq[' + i + '].a';
        }
      }
      if (k === 'notify') {
        if (!isObj(v) || Object.keys(v).some(x => ['sms', 'email', 'daily_summary'].indexOf(x) === -1)) return 'invalid_setting:notify';
        if ('sms' in v) {
          if (!Array.isArray(v.sms) || v.sms.length > 5) return 'invalid_setting:notify.sms';
          for (let i = 0; i < v.sms.length; i++) if (!US_E164(v.sms[i])) return 'invalid_setting:notify.sms[' + i + ']';
        }
        if ('email' in v) {
          if (!Array.isArray(v.email) || v.email.length > 5) return 'invalid_setting:notify.email';
          for (let i = 0; i < v.email.length; i++) if (typeof v.email[i] !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email[i]) || v.email[i].length > 320) return 'invalid_setting:notify.email[' + i + ']';
        }
        if ('daily_summary' in v && !(v.daily_summary === null || (typeof v.daily_summary === 'string' && HHMM.test(v.daily_summary)))) return 'invalid_setting:notify.daily_summary';
        if ((Array.isArray(v.sms) ? v.sms.length : 0) + (Array.isArray(v.email) ? v.email.length : 0) === 0) return 'invalid_setting:notify';
      }
      if (k === 'after_hours') {
        if (!isObj(v) || Object.keys(v).some(x => x !== 'mode')) return 'invalid_setting:after_hours';
        if (['book_next_day', 'message_only', 'emergency_dial'].indexOf(v.mode) === -1) return 'invalid_setting:after_hours.mode';
      }
      if (k === 'on_call_number' && !(v === null || US_E164(v))) return 'invalid_setting:on_call_number';
      if (k === 'real_estate') {   // 2026-10-23 (*_us_settings_real_estate.sql): the CRM link (follow_up_boss) is ours, the rest is the client's
        if (!isObj(v)) return 'invalid_setting:real_estate';
        if ('follow_up_boss' in v) return 'invalid_setting:real_estate.follow_up_boss';
        if (Object.keys(v).some(x => ['agent_name', 'screening', 'renters', 'meetings'].indexOf(x) === -1)) return 'invalid_setting:real_estate';
        if ('agent_name' in v && (typeof v.agent_name !== 'string' || v.agent_name.length > 80)) return 'invalid_setting:real_estate.agent_name';
        if ('screening' in v) {
          if (!Array.isArray(v.screening) || v.screening.length > 8) return 'invalid_setting:real_estate.screening';
          if (v.screening.some(x => RE_SCREENING.indexOf(x) === -1)) return 'invalid_setting:real_estate.screening';
          if (new Set(v.screening).size !== v.screening.length) return 'invalid_setting:real_estate.screening';
        }
        if ('renters' in v && typeof v.renters !== 'boolean') return 'invalid_setting:real_estate.renters';
        if ('meetings' in v) {
          if (!isObj(v.meetings)) return 'invalid_setting:real_estate.meetings';
          for (const mk of Object.keys(v.meetings)) {
            const mv = v.meetings[mk];
            if (['buyer', 'seller', 'renter', 'showing'].indexOf(mk) === -1 || typeof mv !== 'string' || mv.length < 1 || mv.length > 80) return 'invalid_setting:real_estate.meetings.' + mk;
          }
        }
      }
    }
    return null;
  }
  const RE_SCREENING = ['intent', 'area', 'timeline', 'price_range', 'pre_approval', 'property_address', 'has_agent'];   // motivation retired 2026-11-27
  const rsNum = v => typeof v === 'number' ? v : (v && typeof v === 'object' && typeof v.usd === 'number' ? v.usd : null);
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  // usage for one tenant+month from runtime_state; accepts the runtime key layout (usage:<t>:<m>:<kind>) and the
  // A7 demo layout (usage:<t>:<m> -> {voice_minutes, sms_segments, ...}, spend:<t>:<day> -> {usd})
  function usageOf(db, tid, m) {
    const rows = db.runtime_state.filter(r => typeof r.key === 'string' && r.key.indexOf(':' + tid + ':') !== -1);
    const get = k => { const r = rows.find(x => x.key === 'usage:' + tid + ':' + m + ':' + k); return r ? (rsNum(r.value) || 0) : 0; };
    const legacy = (rows.find(x => x.key === 'usage:' + tid + ':' + m) || {}).value || {};
    const sum = pre => rows.filter(x => x.key.indexOf(pre + tid + ':' + m + '-') === 0).reduce((s, x) => s + (rsNum(x.value) || 0), 0);
    const flag = rows.find(x => x.key === 'usage:' + tid + ':' + m + ':needs_addon_approval');
    return { month: m, voice_minutes: get('voice_minutes') || legacy.voice_minutes || 0, sms_segments: get('sms_segments') || legacy.sms_segments || 0,
      owner_sms_segments: get('owner_sms_segments'), needs_addon_approval: !!(flag && flag.value === true),
      claude_usd: Math.round(sum('spend:') * 10000) / 10000, twilio_usd: Math.round(sum('cost:twilio:') * 10000) / 10000,
      updated_at: rows.reduce((a, r) => (r.updated_at > a ? r.updated_at : a), '') || null };
  }
  // public.client_results (migration *_us_appointments.sql): same numbers, bucketed by the tenant's local month
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function localOf(iso, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    const p = {}; f.formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
    return { ym: p.year + '-' + p.month, wd: DAY_KEYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)], hm: p.hour + ':' + p.minute };
  }
  function resultsMonth(db, t, m) {
    const tz = ((t.config || {}).business || {}).timezone || 'UTC', hours = (t.config || {}).hours || {};
    const inM = v => !!v && localOf(v, tz).ym === m;
    const calls = db.calls.filter(c => c.tenant_id === t.id && inM(c.started_at));
    const ans = calls.filter(c => ['booked', 'message', 'handoff', 'emergency'].indexOf(c.outcome) !== -1);
    const bk = db.bookings.filter(b => b.tenant_id === t.id);
    const ev = db.events.filter(e => e.entity === 'tenant' && e.entity_id === t.id && /^appointment\./.test(e.type || '') && inM(e.created_at));
    return {
      calls_answered: ans.length,
      after_hours_calls: ans.filter(c => { const l = localOf(c.started_at, tz), sp = hours[l.wd]; return !Array.isArray(sp) || l.hm < sp[0] || l.hm >= sp[1]; }).length,
      booked: bk.filter(b => inM(b.created_at) && !b.rescheduled_from_id && ['confirmed', 'completed', 'rescheduled', 'no_show'].indexOf(b.status) !== -1).length,
      messages: calls.filter(c => c.outcome === 'message' || c.outcome === 'handoff').length,
      confirmations: bk.filter(b => inM(b.confirmed_at)).length,
      reschedules: ev.filter(e => e.type === 'appointment.rescheduled').length,
      cancellations: ev.filter(e => e.type === 'appointment.cancelled').length,
      no_shows: bk.filter(b => b.status === 'no_show' && inM(b.start_at)).length
    };
  }
  function resultsOf(db, tid, month) {
    const t = db.tenants.find(x => x.id === tid); if (!t) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
    const tz = ((t.config || {}).business || {}).timezone || 'UTC';
    const m = month || localOf(new Date().toISOString(), tz).ym;
    if (!/^[0-9]{4}-[0-9]{2}$/.test(m)) { const e = new Error('bad_month'); e.code = 'bad_month'; throw e; }
    const [y, mo] = m.split('-').map(Number), pm = mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0');
    const cur = resultsMonth(db, t, m), prev = resultsMonth(db, t, pm);
    const avgRow = db.runtime_state.find(r => r.key === 'roi:' + tid + ':avg_job_value_usd'), avg = avgRow ? rsNum(avgRow.value) : null;
    const seen = {}, back = [];
    db.calls.filter(c => c.tenant_id === tid && c.outcome === 'message' && c.job_type && c.from_e164 && localOf(c.started_at, tz).ym === m)
      .sort((a, b) => b.started_at.localeCompare(a.started_at)).forEach(c => {
        if (seen[c.from_e164]) return; seen[c.from_e164] = 1;
        if (db.bookings.some(b => b.tenant_id === tid && b.contact_e164 === c.from_e164 && b.created_at > c.started_at)) return;
        if (back.length < 10) back.push({ at: c.started_at, phone: c.from_e164, job_type: c.job_type, summary: String(c.summary || '').slice(0, 200) });
      });
    return Object.assign(cur, { month: m, previous: Object.assign(prev, { month: pm }), avg_job_value_usd: avg,
      est_value_usd: avg == null ? null : Math.round(cur.booked * avg * 100) / 100, worth_calling_back: back });
  }
  // trigger calls_forwarding_test: a call within [start - 1 min, start + 30 min] marks forward_calls done
  function forwardingCheck(db, call) {
    const t = db.tenants.find(x => x.id === call.tenant_id); if (!t) return;
    const it = db.onboarding_items.find(o => o.client_id === t.client_id && o.key === 'forward_calls' && o.status !== 'done' && o.data && o.data.test_started_at);
    if (!it) return;
    const st = Date.parse(it.data.test_started_at), at = Date.parse(call.started_at);
    if (!(at >= st - 60000 && at <= st + 30 * 60000)) return;
    // 2026-11-25: the call must come THROUGH the business line (ForwardedFrom = business.main_phone)
    const main = ((t.config || {}).business || {}).main_phone || null, fwd = call.forwarded_from || null;
    it.updated_at = now();
    if (fwd && fwd !== main) { it.data = Object.assign({}, it.data, { test_mismatch_at: call.started_at, test_mismatch_from: fwd, test_call_id: call.id }); return; }
    if (!fwd) { it.data = Object.assign({}, it.data, { test_unverified_at: call.started_at, test_call_id: call.id, test_direct: call.from_e164 === main }); return; }
    it.status = 'done'; it.done_at = now();
    it.data = Object.assign({}, it.data, { test_call_at: call.started_at, test_call_id: call.id, verified: 'forwarded_from' });
    const c = db.clients.find(x => x.id === t.client_id) || {};
    db.events.push({ id: uuid(), actor: 'runtime', entity: 'onboarding_item', entity_id: it.id, user_id: c.user_id || null, type: 'forwarding_test_passed', payload: { call_id: call.id }, client_visible: true, created_at: now() });
    autoGoLive(db, t.client_id);
  }

  function portalBApi() {
    function ctx() {
      const db = load(), u = me(db); if (!u) return { err: 'not_authenticated' };
      seedOnboardingAll(db);
      const client = db.clients.filter(c => c.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
      const tenant = client ? db.tenants.find(t => t.client_id === client.id) || null : null;
      return { db, u, client, tenant };
    }
    const run = fn => { const x = ctx(); if (x.err) return fail(x.err); try { const r = fn(x); store(x.db); return later(r); } catch (e) { return fail(e.code || e.message); } };
    const err = code => { const e = new Error(code); e.code = code; return e; };
    const ownsClient = (x, cid) => !!x.client && db2clients(x).some(c => c.id === cid);
    const db2clients = x => x.db.clients.filter(c => c.user_id === x.u.id);
    const ownsTenant = (x, tid) => x.db.tenants.some(t => t.id === tid && ownsClient(x, t.client_id));
    const isAdmin = x => !!(x.db.profiles.find(p => p.id === x.u.id) || {}).is_admin;
    const nameOf = (db, uid) => { const p = db.profiles.find(x => x.id === uid) || {}; return p.company || p.full_name || p.email || ''; };
    const emailOf = (db, uid) => (db.profiles.find(p => p.id === uid) || {}).email || null;
    const tenantRow = t => t && { id: t.id, client_id: t.client_id, slug: t.slug, status: t.status, twilio_number: t.twilio_number || null, config: t.config || {} };
    // card / PayPal checkout: mirrors the SQL RPCs pay_target / pay_set_order / pay_record_capture with fake PayPal ids
    // (the quote page keeps its own copy for the deposit; here: the portal's final payment, own quotes only)
    function payRow(x, token, which) {
      const q = x.db.quotes.find(y => y.public_token === token && y.user_id === x.u.id);
      if (!q || q.anonymized || ['deposit', 'final'].indexOf(which) === -1) throw err('not_found');
      if (q.status !== 'accepted') throw err('quote_not_accepted');
      if (q.pay_method !== 'paypal_checkout') throw err('not_paypal');
      const c = x.db.clients.find(cc => cc.quote_id === q.id);
      if (!c) throw err(which === 'final' ? 'deposit_not_paid' : 'not_found');
      const dep = x.db.payments.find(p => p.client_id === c.id && p.kind === 'deposit');
      if (which === 'final') {
        if (!dep || dep.status !== 'paid') throw err('deposit_not_paid');
        if (['testing', 'live'].indexOf(c.status) === -1) throw err('final_not_ready');
      }
      let p = x.db.payments.find(pp => pp.client_id === c.id && pp.kind === which);
      if (!p) {
        p = { id: uuid(), client_id: c.id, kind: which, amount_cents: which === 'final' ? (q.setup_cents || 0) - (q.deposit_cents || 0) : q.deposit_cents || 0,
          method: q.pay_method, status: 'due', reference: null, paid_at: null, provider: null, provider_order_id: null, provider_capture_id: null,
          payer_email: null, created_at: now(), updated_at: now() };
        x.db.payments.push(p);
      }
      return p;
    }

    return {
      // ---------------------------------------------------------- card / PayPal checkout (pay-create / pay-capture)
      payCreate(token, which) {
        return run(x => {
          const p = payRow(x, token, which);
          if (p.status === 'paid') throw err('already_paid');
          if (p.provider_capture_id) throw err('payment_pending');
          Object.assign(p, { provider: 'paypal', provider_order_id: 'MOCKORDER' + rnd(12).toUpperCase(), updated_at: now() });
          return { order_id: p.provider_order_id };
        });
      },
      payCapture(token, which, orderId) {
        return run(x => {
          const p = payRow(x, token, which);
          if (p.status === 'paid') {
            if (p.provider_order_id === orderId) return { status: 'paid', which, reference: p.provider_capture_id, amount_cents: p.amount_cents };
            throw err('already_paid');
          }
          if (p.provider_order_id !== orderId) throw err('order_mismatch');
          Object.assign(p, { status: 'paid', paid_at: now(), updated_at: now(), method: 'paypal_checkout', provider_capture_id: 'MOCKCAP' + rnd(12).toUpperCase(),
            payer_email: x.u.email });
          x.db.outbox.push({ id: uuid(), to: x.u.email, template: 'payment_receipt', payment_id: p.id, subject: 'Payment received', created_at: now() });
          x.db.outbox.push({ id: uuid(), to: 'owner', template: 'admin_payment_received', payment_id: p.id, subject: 'Payment received in PayPal', created_at: now() });
          if (p.kind === 'deposit') x.db.outbox.push({ id: uuid(), to: x.u.email, template: 'deposit_received', payment_id: p.id, created_at: now() });
          x.db.events.push({ id: uuid(), actor: 'runtime', entity: 'payment', entity_id: p.id, user_id: x.u.id, type: 'payment_captured',
            payload: { provider: 'paypal', kind: p.kind, amount_cents: p.amount_cents, capture_id: p.provider_capture_id }, client_visible: true, created_at: now() });
          return { status: 'paid', which, reference: p.provider_capture_id, amount_cents: p.amount_cents };
        });
      },
      // ---------------------------------------------------------- onboarding
      listOnboarding() {
        return run(x => x.db.onboarding_items.filter(o => ownsClient(x, o.client_id)).sort((a, b) => a.sort - b.sort));
      },
      updateOnboarding(id, status, data) {
        return run(x => {
          const it = x.db.onboarding_items.find(o => o.id === id);
          if (!it || !(ownsClient(x, it.client_id) || isAdmin(x))) throw err('not_your_item');
          if (status != null && ['todo', 'done', 'need_help'].indexOf(status) === -1) throw err('invalid_status');
          if (data != null && (typeof data !== 'object' || Array.isArray(data))) throw err('data_must_be_object');
          const merged = Object.assign({}, it.data || {}, data || {});
          // private.onboarding_go_live_gate: go-live only in 'testing' with every item done (optional 'tools' + 'sms' excepted)
          if (merged.go_live_requested_at && !(it.data || {}).go_live_requested_at && !isAdmin(x)) {
            const cl = x.db.clients.find(cc => cc.id === it.client_id) || {};
            const open = x.db.onboarding_items.some(o => o.client_id === it.client_id && o.id !== it.id && OPTIONAL_ITEMS.indexOf(o.key) === -1 && o.status !== 'done');
            if (((status || it.status) !== 'done' && OPTIONAL_ITEMS.indexOf(it.key) === -1) || cl.status !== 'testing' || open) throw err('go_live_not_ready');
          }
          // private.onboarding_apply: calendar done only with a connected calendar or "take messages only" (every client)
          if (it.key === 'calendar' && status === 'done' && it.status !== 'done' && !isAdmin(x) && merged.booking_mode !== 'messages_only'
              && !x.db.tenant_credentials.some(k => k.provider === merged.provider && x.db.tenants.some(t => t.id === k.tenant_id && t.client_id === it.client_id))) throw err('calendar_not_connected');
          const subCl = x.db.clients.find(cc => cc.id === it.client_id) || {};
          if (subCl.billing_mode === 'subscription') {   // every save goes straight into the live config (same rules as SQL)
            const t = x.db.tenants.find(tt => tt.client_id === it.client_id);
            if (t && window.OnboardingConfig) { t.config = window.OnboardingConfig.patch(it.key, merged, t.config); planGuard(x.db, t); t.updated_at = now(); }
          }
          if (JSON.stringify(merged).length >= 20000) throw err('data_too_large');
          const from = it.status, prevData = it.data || {};
          it.data = merged;
          if (status) it.status = status;
          it.done_at = it.status === 'done' ? (from === 'done' ? it.done_at : now()) : null;
          it.updated_at = now();
          const c = x.db.clients.find(cc => cc.id === it.client_id) || {};
          x.db.events.push({ id: uuid(), actor: 'client:' + x.u.id, entity: 'onboarding_item', entity_id: it.id, user_id: c.user_id || null,
            type: status === 'need_help' ? 'need_help' : 'onboarding_updated', payload: { key: it.key, status: it.status }, client_visible: true, created_at: now() });
          if (status === 'need_help') x.db.outbox.push({ id: uuid(), to: 'owner', template: 'need_help', subject: nameOf(x.db, c.user_id) + ' needs help with: ' + it.title, created_at: now() });
          if (data && data.go_live_requested_at && !(prevData && prevData.go_live_requested_at)) {
            x.db.events.push({ id: uuid(), actor: 'client:' + x.u.id, entity: 'client', entity_id: c.id, user_id: c.user_id || null, type: 'go_live_requested', payload: { item_id: it.id }, client_visible: true, created_at: now() });
            x.db.outbox.push({ id: uuid(), to: emailOf(x.db, c.user_id), template: 'final_payment_due', subject: 'Final payment before go-live', created_at: now() });
          }
          autoGoLive(x.db, it.client_id);
          return it;
        });
      },
      startForwardingTest(id) {
        return run(x => {
          const it = x.db.onboarding_items.find(o => o.id === id);
          if (!it || it.key !== 'forward_calls' || !(ownsClient(x, it.client_id) || isAdmin(x))) throw err('not_your_item');
          const t = x.db.tenants.find(tt => tt.client_id === it.client_id && tt.twilio_number);
          if (!t) throw err('no_forwarding_number');
          it.data = Object.assign({}, it.data, { test_started_at: now(), test_number: t.twilio_number }); it.updated_at = now();
          return { number: t.twilio_number, started_at: it.data.test_started_at, window_minutes: 30 };
        });
      },
      // Google/Calendly OAuth: the real adapter asks the calendar-connect Edge Function for a runtime /oauth/<p>/start link.
      // The mock "connects" at once and returns the URL the runtime callback would redirect to.
      calendarConnectUrl(tenantId, provider) {
        return run(x => {
          if (!ownsTenant(x, tenantId)) throw err('not_your_tenant');
          if (['google', 'calendly'].indexOf(provider) === -1) throw err('unknown_provider');
          x.db.events.push({ id: uuid(), actor: 'runtime', entity: 'tenant', entity_id: tenantId, user_id: x.u.id, type: 'calendar.connected', payload: { provider }, client_visible: false, created_at: now() });
          x.db.tenant_credentials = x.db.tenant_credentials.filter(k => !(k.tenant_id === tenantId && k.provider === provider));
          x.db.tenant_credentials.push({ tenant_id: tenantId, provider, ciphertext: 'mock', updated_at: now() });   // what the runtime callback stores
          return { url: '/start/?' + new URLSearchParams({ calendar: provider, result: 'connected' }) + '#onboarding' };
        });
      },
      // ---------------------------------------------------------- tenant (receptionist)
      getTenant() { return run(x => tenantRow(x.tenant)); },
      updateTenantSettings(tenantId, patch) {
        return run(x => {
          if (!(ownsTenant(x, tenantId) || isAdmin(x))) throw err('not_your_tenant');
          const bad = checkSettingsPatch(patch); if (bad) throw err(bad);
          if ('spanish' in patch && !p2HasSpanish(x.db, tenantId)) throw err('spanish_not_in_plan');   // P2
          const t = x.db.tenants.find(tt => tt.id === tenantId);
          const p2 = clone(patch); delete p2.on_call_number; delete p2.spanish;
          if ('spanish' in patch) p2SetSpanish(t, patch.spanish);   // P2: voice.languages + the remembered choice
          const prevRe = (t.config || {}).real_estate;
          t.config = Object.assign({}, t.config || {}, p2); t.updated_at = now();
          if ('real_estate' in patch) {   // one level deep, like the SQL: follow_up_boss + keys the patch leaves out are kept
            t.config.real_estate = Object.assign({}, clone(prevRe || {}), patch.real_estate);
          }
          if ('on_call_number' in patch) {   // same mapping as the SQL: handoff.number/mode + emergency.dial
            const n = patch.on_call_number;
            t.config.handoff = Object.assign({}, t.config.handoff || {}, { mode: n === null ? 'message' : 'dial', number: n });
            t.config.emergency = Object.assign({}, t.config.emergency || {}, { dial: n });
          }
          const c = x.db.clients.find(cc => cc.id === t.client_id) || {};
          x.db.events.push({ id: uuid(), actor: 'client:' + x.u.id, entity: 'tenant', entity_id: t.id, user_id: c.user_id || null, type: 'settings_updated', payload: { fields: Object.keys(patch) }, client_visible: true, created_at: now() });
          return clone(t.config);
        });
      },
      // ---------------------------------------------------------- ADD-DISPATCH (mirrors 20261023100000_us_dispatch.sql)
      saveDispatch(tenantId, patch) {
        return run(x => {
          if (!(ownsTenant(x, tenantId) || isAdmin(x))) throw err('not_your_tenant');
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw err('patch_must_be_object');
          const bad = Object.keys(patch).find(k => ['daytime_too', 'callback_minutes', 'contacts', 'schedule'].indexOf(k) === -1);
          if (bad) throw err('field_not_allowed: ' + bad);
          const t = x.db.tenants.find(tt => tt.id === tenantId), cur = clone((t.config || {}).dispatch || {});
          if ('daytime_too' in patch && typeof patch.daytime_too !== 'boolean') throw err('invalid_setting:dispatch.daytime_too');
          if ('callback_minutes' in patch && !(Number.isInteger(patch.callback_minutes) && patch.callback_minutes >= 5 && patch.callback_minutes <= 120)) throw err('invalid_setting:dispatch.callback_minutes');
          let ids = (cur.contacts || []).map(c => c.id);
          if ('contacts' in patch) {
            if (!Array.isArray(patch.contacts) || patch.contacts.length > 5) throw err('invalid_setting:dispatch.contacts');
            const phones = []; ids = [];
            patch.contacts = patch.contacts.map((c, i) => {
              if (!c || !/^[a-z0-9_-]{1,20}$/.test(c.id || '') || ids.indexOf(c.id) !== -1) throw err('invalid_setting:dispatch.contacts[' + i + '].id');
              if (!String(c.name || '').trim() || String(c.name).trim().length > 60) throw err('invalid_setting:dispatch.contacts[' + i + '].name');
              if (!/^\+1[2-9]\d{9}$/.test(c.phone || '') || phones.indexOf(c.phone) !== -1) throw err('invalid_setting:dispatch.contacts[' + i + '].phone');
              ids.push(c.id); phones.push(c.phone);
              const prev = (cur.contacts || []).find(o => o.phone === c.phone) || {};
              return { id: c.id, name: String(c.name).trim(), phone: c.phone, role: c.role === 'manager' ? 'manager' : 'tech',
                alerts_opt_in_at: c.opt_in ? (prev.alerts_opt_in_at || now()) : null };
            });
          }
          const sched = 'schedule' in patch ? patch.schedule : (cur.schedule || []);
          if (!Array.isArray(sched) || sched.length > 28) throw err('invalid_setting:dispatch.schedule');
          sched.forEach((r, i) => {
            if (!r || DAYS3.indexOf(r.day) === -1 || !HHMM.test(r.start || '') || !HHMM.test(r.end || '') || !Array.isArray(r.contacts) || !r.contacts.length || r.contacts.length > 5
                || r.contacts.some(c => ids.indexOf(c) === -1)) throw err('invalid_setting:dispatch.schedule[' + i + ']');
          });
          t.config = Object.assign({}, t.config, { dispatch: Object.assign(cur, patch) }); t.updated_at = now();
          return clone(t.config.dispatch);
        });
      },
      listDispatchEvents(tenantId, limit) {
        return run(x => ownsTenant(x, tenantId) || isAdmin(x) ? x.db.dispatch_events.filter(r => r.tenant_id === tenantId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit || 200) : []);
      },
      markDispatchHandled(tenantId, callSid) {
        return run(x => {
          if (!(ownsTenant(x, tenantId) || isAdmin(x))) throw err('not_your_tenant');
          const rows = x.db.dispatch_events.filter(r => r.tenant_id === tenantId && r.call_sid === callSid);
          if (!rows.length) throw err('not_found');
          if (!rows.some(r => r.result === 'handled')) x.db.dispatch_events.push({ id: uuid(), tenant_id: tenantId, call_sid: callSid, leg: null, contact_name: 'Owner', result: 'handled', wait_s: null, detail: 'portal', at: now() });
          return null;
        });
      },
      listCalls(tenantId, limit) {
        return run(x => ownsTenant(x, tenantId) ? x.db.calls.filter(c => c.tenant_id === tenantId).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit || 50) : []);
      },
      listSms(tenantId, limit) {
        return run(x => ownsTenant(x, tenantId) ? x.db.sms_messages.filter(c => c.tenant_id === tenantId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit || 200) : []);
      },
      listBookings(tenantId, limit) {
        return run(x => ownsTenant(x, tenantId) ? x.db.bookings.filter(c => c.tenant_id === tenantId).sort((a, b) => (b.start_at || '').localeCompare(a.start_at || '')).slice(0, limit || 50) : []);
      },
      // appointment manager (migration *_us_appointments.sql): Results panel, no-show, average job value
      getResults(tenantId, month) {
        return run(x => {
          if (!(ownsTenant(x, tenantId) || isAdmin(x))) throw err('not_your_tenant');
          return resultsOf(x.db, tenantId, month || null);
        });
      },
      markNoShow(bookingId, noShow) {
        return run(x => {
          const b = x.db.bookings.find(r => r.id === bookingId);
          if (!b) throw err('not_found');
          if (!(ownsTenant(x, b.tenant_id) || isAdmin(x))) throw err('not_your_tenant');
          const on = noShow !== false;
          if (on && b.status !== 'confirmed') throw err('bad_status');
          if (on && (!b.start_at || Date.parse(b.start_at) > Date.now())) throw err('visit_not_started');
          if (!on && b.status !== 'no_show') throw err('bad_status');
          b.status = on ? 'no_show' : 'confirmed';
          x.db.events.push({ id: uuid(), actor: 'client:' + x.u.id, entity: 'tenant', entity_id: b.tenant_id, user_id: x.u.id, type: on ? 'booking_no_show' : 'booking_no_show_undone', payload: { booking_id: b.id }, client_visible: true, created_at: now() });
          return { id: b.id, status: b.status };
        });
      },
      setAvgJobValue(tenantId, value) {
        return run(x => {
          if (!(ownsTenant(x, tenantId) || isAdmin(x))) throw err('not_your_tenant');
          if (value !== null && !(typeof value === 'number' && value > 0 && value <= 100000)) throw err('avg_job_value_range');
          const k = 'roi:' + tenantId + ':avg_job_value_usd';
          x.db.runtime_state = x.db.runtime_state.filter(r => r.key !== k);
          if (value !== null) x.db.runtime_state.push({ id: uuid(), key: k, tenant_id: tenantId, value: Math.round(value * 100) / 100, updated_at: now() });
          return { avg_job_value_usd: value };
        });
      },
      getUsage(tenantId, month) {
        return run(x => {
          if (!(ownsTenant(x, tenantId) || isAdmin(x))) throw err('not_your_tenant');
          const u = usageOf(x.db, tenantId, month || thisMonth());
          return { month: u.month, voice_minutes: u.voice_minutes, sms_segments: u.sms_segments, needs_addon_approval: u.needs_addon_approval };
        });
      },
      // ---------------------------------------------------------- requests (retainer)
      listRequests() { return run(x => x.db.requests.filter(r => ownsClient(x, r.client_id)).sort((a, b) => a.position - b.position)); },
      createRequest(row) {
        return run(x => {
          if (!x.client) throw err('no_client');
          const title = String((row && row.title) || '').trim(), body = String((row && row.body) || '');
          if (title.length < 1 || title.length > 200) throw err('request_title_length');
          if (body.length > 10000) throw err('request_body_length');
          const mine = x.db.requests.filter(r => r.client_id === x.client.id);
          if (mine.filter(r => ['queued', 'active', 'waiting_on_you'].indexOf(r.status) !== -1).length >= 25) throw err('too_many_requests');
          const r = { id: uuid(), client_id: x.client.id, title, body, status: 'queued', paused: false, admin_reply: null,
            position: mine.length ? Math.max.apply(null, mine.map(m => m.position)) + 1 : 0, created_at: now(), updated_at: now() };
          x.db.requests.push(r);
          x.db.events.push({ id: uuid(), actor: 'client:' + x.u.id, entity: 'request', entity_id: r.id, user_id: x.u.id, type: 'status_changed', payload: { to: 'queued' }, client_visible: true, created_at: now() });
          return r;
        });
      },
      // requests_guard: client edits only while queued; status/admin_reply/client_id are kept
      saveRequest(id, patch) {
        return run(x => {
          const r = x.db.requests.find(q => q.id === id && ownsClient(x, q.client_id));
          if (!r) return null;   // RLS: 0 rows
          if (r.status !== 'queued') throw err('request_locked');
          ['title', 'body', 'position', 'paused'].forEach(k => { if (patch && k in patch) r[k] = k === 'paused' ? !!patch[k] : patch[k]; });
          if (!r.title || r.title.length > 200) throw err('request_title_length');
          r.updated_at = now();
          return r;
        });
      },
      cancelRequest(id) {
        return run(x => {
          const r = x.db.requests.find(q => q.id === id && ownsClient(x, q.client_id) && q.status === 'queued');
          if (!r) throw err('request_locked');
          x.db.requests = x.db.requests.filter(q => q !== r);
          x.db.attachments = x.db.attachments.filter(a => a.request_id !== id);
          x.db.events.push({ id: uuid(), actor: 'client:' + x.u.id, entity: 'request', entity_id: id, user_id: x.u.id, type: 'request_cancelled', payload: { title: r.title.slice(0, 200) }, client_visible: true, created_at: now() });
          return null;
        });
      },
      listRequestAttachments(rid) { return run(x => x.db.attachments.filter(a => a.request_id === rid && a.owner_id === x.u.id)); },
      uploadRequestAttachment(rid, file, safeName, mime) {
        return run(x => {
          const r = x.db.requests.find(q => q.id === rid && ownsClient(x, q.client_id) && ['queued', 'waiting_on_you'].indexOf(q.status) !== -1);
          if (!r) throw err('item_locked');
          if (x.db.attachments.filter(a => a.request_id === rid).length >= 5) throw err('too_many_files');
          if (file.size > 10 * 1048576) throw err('Payload too large');
          const row = { id: uuid(), owner_id: x.u.id, questionnaire_id: null, request_id: rid, storage_path: x.u.id + '/' + rid + '/' + rnd(10) + '-' + safeName,
            filename: String(file.name).slice(0, 255), size: file.size, mime_type: mime || null, created_at: now() };
          x.db.attachments.push(row);
          return row;
        });
      },
      removeRequestAttachment(att) {
        return run(x => {
          const a = x.db.attachments.find(y => y.id === att.id && y.owner_id === x.u.id);
          const r = a && x.db.requests.find(q => q.id === a.request_id);
          if (!a || !r || ['queued', 'waiting_on_you'].indexOf(r.status) === -1) throw err('item_locked');
          x.db.attachments = x.db.attachments.filter(y => y !== a);
          return null;
        });
      },
      // ---------------------------------------------------------- admin (Tenants tab)
      adminListOnboarding() {   // same result as A7's, after the deposit trigger has run (mock seeds lazily)
        return run(x => { if (!isAdmin(x)) throw err('not_admin'); return x.db.onboarding_items.slice().sort((a, b) => a.sort - b.sort); });
      },
      adminTenantUsage(month) {
        return run(x => {
          if (!isAdmin(x)) throw err('not_admin');
          const m = month || thisMonth(); if (!/^[0-9]{4}-[0-9]{2}$/.test(m)) throw err('bad_month');
          return x.db.tenants.slice().sort((a, b) => a.slug.localeCompare(b.slug)).map(t => Object.assign({ tenant_id: t.id, slug: t.slug }, usageOf(x.db, t.id, m)));
        });
      },
      adminSaveTenant(row) {
        return run(x => {
          if (!isAdmin(x)) throw err('not_admin');
          const cfg = row && row.config;
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw err('config_must_be_object');
          if (row.slug != null && !/^[a-z0-9][a-z0-9-]{2,59}$/.test(row.slug)) throw err('tenants_slug_check');
          const num = row.twilio_number || null;
          if (num && !/^\+[1-9][0-9]{6,14}$/.test(num)) throw err('tenants_twilio_number_check');
          if (['sandbox', 'live', 'paused'].indexOf(row.status || 'sandbox') === -1) throw err('invalid_status');
          let t = row.id ? x.db.tenants.find(y => y.id === row.id) : null;
          if (row.id && !t) throw err('not_found');
          const slug = row.slug || (t && t.slug);
          if (x.db.tenants.some(y => y !== t && y.slug === slug)) throw err('duplicate key value violates unique constraint "tenants_slug_key"');
          if (num && x.db.tenants.some(y => y !== t && y.twilio_number === num)) throw err('duplicate key value violates unique constraint "tenants_twilio_number_key"');
          if (!t) {
            if (!x.db.clients.some(c => c.id === row.client_id)) throw err('not_found');
            t = { id: uuid(), client_id: row.client_id, created_at: now() }; x.db.tenants.push(t);
          }
          Object.assign(t, { slug, status: row.status || t.status || 'sandbox', twilio_number: num, config: clone(cfg), updated_at: now() });
          const c = x.db.clients.find(cc => cc.id === t.client_id) || {};
          x.db.events.push({ id: uuid(), actor: 'admin:' + x.u.id, entity: 'tenant', entity_id: t.id, user_id: c.user_id || null,
            type: row.id ? 'tenant_saved' : 'tenant_created', payload: { slug: t.slug, status: t.status }, client_visible: false, created_at: now() });
          return clone(t);
        });
      }
    };
  }

  // B7 demo/test helper: a valid tenant (runtime/app/tenant_schema.json) for the signed-in user's client + receptionist data.
  // seedTenant({niche: 'real_estate'}) seeds a real-estate tenant (screening questions + the ADD-CHAT website chat box);
  // no argument = the HVAC tenant exactly as before.
  function seedTenant(opts) {
    const re = !!(opts && opts.niche === 'real_estate');
    const db = load(), u = me(db); if (!u) throw new Error('not_authenticated');
    const client = db.clients.filter(c => c.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!client) throw new Error('no_client');
    const p = db.profiles.find(x => x.id === u.id) || {};
    let t = db.tenants.find(x => x.client_id === client.id);
    if (!t) {
      t = { id: uuid(), client_id: client.id, slug: 'demo-' + rnd(6).toLowerCase(), status: client.status === 'live' ? 'live' : 'sandbox',
        twilio_number: '+1713555' + String(Math.floor(1000 + Math.random() * 8999)), created_at: now(), updated_at: now(),
        config: { business: { name: p.company || 'Demo Business', niche: 'home_services', trade: 'HVAC', timezone: p.timezone || 'America/Chicago', service_area_zips: [], main_phone: '+17135550100' },
          hours: { mon: ['08:00', '17:00'], tue: ['08:00', '17:00'], wed: ['08:00', '17:00'], thu: ['08:00', '17:00'], fri: ['08:00', '17:00'], sat: null, sun: null },
          booking: { provider: 'calendly', windows: [['08:00', '12:00'], ['12:00', '16:00']], job_types: ['AC repair', 'Maintenance'] },
          faq: [], notify: { sms: [], email: [u.email], daily_summary: '19:00' }, paused: false } };
      db.tenants.push(t);
    }
    if (re) {   // also turns an existing demo tenant into the real-estate one (the e2e seeds the HVAC tenant first)
      t.config.business = Object.assign({}, t.config.business, { niche: 'real_estate', trade: 'Real estate' });
      t.config.booking = Object.assign({}, t.config.booking, { job_types: ['Home showing', 'Buyer consultation', 'Listing consultation'] });
      t.config.real_estate = { agent_name: 'Jenna Harper', screening: RE_SCREENING.slice(), renters: false, meetings: {}, follow_up_boss: { enabled: false, source: '', assigned_to: '' } };
      t.config.webchat = { enabled: true, allowed_origins: ['https://example-realty.test'], title: '', max_messages_per_session: 30 };
      t.updated_at = now();
    }
    if (!db.calls.some(c => c.tenant_id === t.id)) {
      const ago = h => new Date(Date.now() - h * 3600000).toISOString();
      const c1 = { id: uuid(), tenant_id: t.id, call_sid: 'CA' + rnd(32), from_e164: '+17135550142', started_at: ago(2), duration_s: 96, outcome: 'booked', cost_usd: 0.11,
        summary: 'AC blowing warm air. Booked Tuesday 8–12.', created_at: ago(2),
        transcript: [{ who: 'assistant', text: 'Thanks for calling. This call may be transcribed. What can we help with?' }, { who: 'customer', text: 'My AC is blowing warm air <b>help</b>' },
          { who: 'assistant', text: 'Sorry about that. I can book a technician: Tuesday 8–12 or 12–4?' }, { who: 'customer', text: 'Tuesday morning.' }] };
      const c2 = { id: uuid(), tenant_id: t.id, call_sid: 'CA' + rnd(32), from_e164: '+12815550177', started_at: ago(26), duration_s: 41, outcome: 'message', cost_usd: 0.05,
        summary: 'Asked about a new install estimate. Wants a call back.', created_at: ago(26), transcript: [{ who: 'customer', text: 'Do you do new installs?' }] };
      db.calls.push(c1, c2);
      db.sms_messages.push({ id: uuid(), tenant_id: t.id, contact_e164: '+12815550177', direction: 'outbound', body: 'Hi, sorry we missed your call! What can we help with? Reply STOP to opt out.', twilio_sid: 'SM' + rnd(32), created_at: ago(26) },
        { id: uuid(), tenant_id: t.id, contact_e164: '+12815550177', direction: 'inbound', body: 'A quote for a new AC unit please', twilio_sid: 'SM' + rnd(32), created_at: ago(25.9) });
      const st = new Date(Date.now() + 40 * 3600000); st.setMinutes(0, 0, 0);
      db.bookings.push({ id: uuid(), tenant_id: t.id, call_id: c1.id, customer_name: 'Maria Lopez', contact_e164: '+17135550142', address: '1200 Main St, Houston, TX 77002',
        job_type: 'AC repair', urgency: 'normal', start_at: st.toISOString(), end_at: new Date(st.getTime() + 4 * 3600000).toISOString(), provider_event_id: null, status: 'confirmed', created_at: ago(2) });
      const m = thisMonth(), day = new Date().toISOString().slice(0, 10);
      db.runtime_state.push({ id: uuid(), key: 'usage:' + t.id + ':' + m + ':voice_minutes', tenant_id: t.id, value: 37, updated_at: now() },
        { id: uuid(), key: 'usage:' + t.id + ':' + m + ':sms_segments', tenant_id: t.id, value: 112, updated_at: now() },
        { id: uuid(), key: 'spend:' + t.id + ':' + day, tenant_id: t.id, value: 0.42, updated_at: now() },
        { id: uuid(), key: 'cost:twilio:' + t.id + ':' + day, tenant_id: t.id, value: 1.37, updated_at: now() });
    }
    store(db);
    return tenantRow2(t);
  }
  // ADD-DISPATCH demo: the add-on on the signed-in client's tenant, two urgent calls in the log, one STOP from staff
  const DAYS3 = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  function seedDispatch(opts) {
    const db = load(), u = me(db); if (!u) throw new Error('not_authenticated');
    const client = db.clients.filter(c => c.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const t = client && db.tenants.find(x => x.client_id === client.id); if (!t) throw new Error('no_tenant');
    const ago = m => new Date(Date.now() - m * 60000).toISOString();
    t.config = Object.assign({}, t.config, { dispatch: { enabled: !(opts && opts.off), daytime_too: false, callback_minutes: 15, sms_alerts: false,
      contacts: [{ id: 'dan', name: 'Dan', phone: '+17135550201', role: 'tech', alerts_opt_in_at: ago(9000) },
                 { id: 'maria', name: 'Maria', phone: '+17135550203', role: 'manager', alerts_opt_in_at: ago(9000) }],
      schedule: DAYS3.map(d => ({ day: d, start: '18:00', end: '07:00', contacts: ['dan'] })) } });
    const ev = (sid, m, leg, name, result, wait) => ({ id: uuid(), tenant_id: t.id, call_sid: sid, leg, contact_name: name, result, wait_s: wait == null ? null : wait, detail: null, at: ago(m) });
    db.dispatch_events.push(ev('CAdispatch1', 600, 0, 'Dan', 'accepted', 18),
      ev('CAdispatch2', 120, 0, 'Dan', 'no_answer'), ev('CAdispatch2', 119, 1, 'Maria', 'no_answer'), ev('CAdispatch2', 118, null, 'Dan', 'alert_sent'),
      ev('CAdispatch2', 118, null, 'Maria', 'alert_sent'), ev('', 60, null, 'Maria', 'opted_out'));
    store(db);
    return t.id;
  }
  const tenantRow2 = t => ({ id: t.id, slug: t.slug, twilio_number: t.twilio_number });
  // Appointment manager demo/test data: calls worth calling back, a moved visit, a past visit (no-show button), confirmations
  function seedResults() {
    const db = load(), u = me(db); if (!u) throw new Error('not_authenticated');
    const client = db.clients.filter(c => c.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const t = client && db.tenants.find(x => x.client_id === client.id); if (!t) throw new Error('no_tenant');
    if (db.calls.some(c => c.tenant_id === t.id && c.call_sid === 'CA-results-1')) return tenantRow2(t);
    const ago = h => new Date(Date.now() - h * 3600000).toISOString();
    db.calls.push({ id: uuid(), tenant_id: t.id, call_sid: 'CA-results-1', from_e164: '+18325550190', started_at: ago(5), duration_s: 70, outcome: 'message', job_type: 'AC repair',
      summary: 'AC not cooling; wanted a price first. Call back.', transcript: [], created_at: ago(5) },
    { id: uuid(), tenant_id: t.id, call_sid: 'CA-results-2', from_e164: '+18325550191', started_at: ago(7), duration_s: 50, outcome: 'message', job_type: 'Maintenance',
      summary: 'Tune-up next week, will check the schedule.', transcript: [], created_at: ago(7) });
    const past = new Date(Date.now() - 3 * 3600000); past.setMinutes(0, 0, 0);
    const moved = { id: uuid(), tenant_id: t.id, call_id: null, customer_name: 'Tess Brown', contact_e164: '+18325550192', address: '500 Elm St, Houston, TX 77007', job_type: 'Maintenance', urgency: 'normal',
      start_at: new Date(Date.now() + 30 * 3600000).toISOString(), end_at: new Date(Date.now() + 34 * 3600000).toISOString(), provider_event_id: 'fake-moved', status: 'rescheduled', created_at: ago(30) };
    db.bookings.push(moved,
      { id: uuid(), tenant_id: t.id, call_id: null, customer_name: 'Tess Brown', contact_e164: '+18325550192', address: '500 Elm St, Houston, TX 77007', job_type: 'Maintenance', urgency: 'normal',
        start_at: new Date(Date.now() + 54 * 3600000).toISOString(), end_at: new Date(Date.now() + 58 * 3600000).toISOString(), provider_event_id: 'fake-new', status: 'confirmed', created_at: ago(1),
        rescheduled_from_id: moved.id, confirmed_at: ago(0.5) },
      { id: uuid(), tenant_id: t.id, call_id: null, customer_name: 'Sam Lee', contact_e164: '+18325550193', address: '12 Oak Ave, Houston, TX 77008', job_type: 'AC repair', urgency: 'normal',
        start_at: past.toISOString(), end_at: new Date(past.getTime() + 2 * 3600000).toISOString(), provider_event_id: 'fake-past', status: 'confirmed', created_at: ago(20) });
    db.events.push({ id: uuid(), actor: 'runtime', entity: 'tenant', entity_id: t.id, user_id: null, type: 'appointment.rescheduled', payload: { channel: 'voice' }, client_visible: false, created_at: ago(1) });
    store(db);
    return tenantRow2(t);
  }

  // B7: the runtime logging a call to the tenant number (e.g. the client's forwarding test)
  function simulateCall(tid, opts) {
    const db = load();
    const t = db.tenants.find(x => x.id === tid); if (!t) throw new Error('not_found');
    const fwd = opts && 'forwardedFrom' in opts ? opts.forwardedFrom : (((t.config || {}).business || {}).main_phone || null);
    const call = { id: uuid(), tenant_id: t.id, call_sid: 'CA' + rnd(32), from_e164: (opts && opts.from) || '+12815550177', forwarded_from: fwd, started_at: now(), duration_s: 20, outcome: 'message',
      transcript: [{ who: 'assistant', text: 'Thanks for calling. This call may be transcribed.' }], summary: 'Forwarding test call.', cost_usd: 0.01, created_at: now() };
    db.calls.push(call);
    forwardingCheck(db, call);
    store(db);
    return call.id;
  }

  // ------------------------------------------------------------------ FirstRing monthly plans (mirrors 20261125100000_us_subscriptions.sql)
  // subscriptions + trial_claims + provisioning_jobs; the same contract as public.billing_upsert_subscription (here: the mock
  // provider, always on in the mock backend). Plan numbers (minutes, price) are never stored: the portal reads the price book.
  const OPTIONAL_ITEMS = ['tools', 'sms'];
  const SUB_ITEMS = [['hours', 'Business hours', 1], ['faq', 'Services & FAQ', 2], ['alerts', 'Emergencies & alerts', 3],
    ['calendar', 'Connect your calendar', 4], ['tools', 'Connect other tools', 5], ['forward_calls', 'Forward your missed calls', 6],
    ['sms', 'Texting registration (optional, later)', 7]];
  const PLAN_RANK = { FR_STARTER: 1, FR_PRO: 2, FR_BUSINESS: 3 };
  const AREA_TZ_MOCK = { 713: 'America/Chicago', 281: 'America/Chicago', 832: 'America/Chicago', 512: 'America/Chicago', 312: 'America/Chicago',
    212: 'America/New_York', 305: 'America/New_York', 404: 'America/New_York', 303: 'America/Denver', 602: 'America/Phoenix', 213: 'America/Los_Angeles', 415: 'America/Los_Angeles' };
  const bErr = code => { const e = new Error(code); e.code = code; return e; };
  const usE164 = v => { const d = String(v || '').replace(/\D/g, ''); return /^1?[2-9]\d{9}$/.test(d) ? '+1' + d.slice(-10) : null; };
  const subOf = (db, cid) => db.subscriptions.filter(s => s.client_id === cid).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
  const iso = ms => new Date(ms).toISOString();
  function subService(sub, at) {
    const t = at || Date.now(), P = v => v ? Date.parse(v) : null;
    if (!sub) return ['full', ''];
    if (sub.status === 'trialing') return sub.trial_ends_at && P(sub.trial_ends_at) + 12 * 3600000 < t ? ['message_only', 'trial_ended'] : ['full', ''];
    if (sub.status === 'active') return sub.cancel_at_period_end && sub.current_period_end && P(sub.current_period_end) < t ? ['message_only', 'canceled'] : ['full', ''];
    if (sub.status === 'past_due') return (P(sub.past_due_since) || t) + 7 * 86400000 < t ? ['message_only', 'past_due'] : ['full', ''];
    if (sub.status === 'paused') return ['message_only', 'paused'];
    return (P(sub.ends_at) || P(sub.canceled_at) || t) <= t ? ['message_only', 'canceled'] : ['full', ''];
  }
  function planBlock(db, cid) {
    const sub = subOf(db, cid); if (!sub) return null;
    const [service, reason] = subService(sub);
    const trial = sub.status === 'trialing';
    const ps = trial ? (sub.trial_began_at || sub.created_at) : (sub.current_period_start || sub.trial_ends_at || sub.created_at);
    return { code: sub.plan_code, status: sub.status, trial_ends_at: sub.trial_ends_at || null, period_start: String(ps).slice(0, 10) + 'T' + String(ps).slice(11, 13) + String(ps).slice(14, 16),
      period_end: (trial ? sub.trial_ends_at : sub.current_period_end) || null, service, service_reason: reason };
  }
  function planGuard(db, t) {   // private.tenant_plan_guard
    const cl = db.clients.find(c => c.id === t.client_id) || {};
    if (cl.billing_mode !== 'subscription') return;
    const blk = planBlock(db, t.client_id); if (!blk) return;
    const prev = ((t.config || {}).plan || {}).service || 'full', sub = subOf(db, t.client_id);
    t.config = Object.assign({}, t.config || {}, { plan: blk });
    p2PlanSpanish(t);   // P2: private.tenant_plan_spanish
    const to = emailOf2(db, cl.user_id), day = new Date().toISOString().slice(0, 10);
    if (prev === 'full' && blk.service === 'message_only' && !db.outbox.some(m => m.key === 'mm:' + sub.id + ':' + blk.service_reason + ':' + day)) {
      db.outbox.push({ id: uuid(), key: 'mm:' + sub.id + ':' + blk.service_reason + ':' + day, to, template: 'subscription_message_mode', subject: 'Your receptionist is now in message mode', created_at: now() });
    } else if (prev === 'message_only' && blk.service === 'full') {
      db.outbox.push({ id: uuid(), to, template: 'subscription_restored', subject: 'Full answering is back on', created_at: now() });
    }
  }
  const emailOf2 = (db, uid) => (db.profiles.find(p => p.id === uid) || {}).email || null;
  function defaultConfig(db, cl, phone) {
    const p = db.profiles.find(x => x.id === cl.user_id) || {};
    const q = db.questionnaires.filter(x => x.user_id === cl.user_id).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0] || {};
    const ph = usE164(phone) || usE164(p.phone);
    const niche = (q.niche || p.niche) === 'real_estate' ? 'real_estate' : 'home_services';
    const trade = String(((q.answers || {}).trade) || '').trim().slice(0, 60);
    const tz = p.timezone || (ph && AREA_TZ_MOCK[ph.slice(2, 5)]) || 'America/New_York';
    const svc = Array.isArray((q.answers || {}).services) && q.answers.services.length ? q.answers.services.slice(0, 30)
      : niche === 'real_estate' ? ['Buyer consultation', 'Listing consultation', 'Home showing'] : [(trade ? trade + ' service call' : 'Service call'), 'Estimate'];
    const email = String(p.contact_email || p.email || '').toLowerCase();
    const day = ['08:00', '17:00'];
    return { business: Object.assign({ name: (cl.business_name || p.company || p.full_name || 'Your business').slice(0, 120), niche, trade, timezone: tz, service_area_zips: [] }, ph ? { main_phone: ph } : {}),
      voice: { greeting: '' }, hours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null },
      booking: { provider: 'calendly', enabled: true, job_types: svc, windows: [['08:00', '12:00'], ['12:00', '16:00']] },
      notify: { sms: [], email: email ? [email] : [], daily_summary: '19:00' }, paused: false };
  }
  function slugFor(db, name) {
    let base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    if (base.length < 3) base = 'fr-' + (base || 'line');
    let s = base, n = 1; while (db.tenants.some(t => t.slug === s)) s = base + '-' + (++n);
    return s;
  }
  function provisionClient(db, sub) {
    const cl = db.clients.find(c => c.id === sub.client_id);
    let t = db.tenants.find(x => x.client_id === cl.id);
    if (!t) {
      const cfg = defaultConfig(db, cl, sub.business_phone);
      t = { id: uuid(), client_id: cl.id, slug: slugFor(db, cfg.business.name), status: 'sandbox', twilio_number: null, config: cfg, created_at: now(), updated_at: now() };
      db.tenants.push(t);
    }
    SUB_ITEMS.forEach(([key, title, sort]) => {
      if (!db.onboarding_items.some(o => o.client_id === cl.id && o.key === key)) db.onboarding_items.push({ id: uuid(), client_id: cl.id, key, title, video_url: null, sort, status: 'todo', data: {}, done_at: null, created_at: now(), updated_at: now() });
    });
    if (!t.twilio_number) {
      let j = db.provisioning_jobs.find(x => x.tenant_id === t.id && x.kind === 'number');
      if (!j) { j = { id: uuid(), tenant_id: t.id, client_id: cl.id, kind: 'number', status: 'pending', attempts: 0, last_error: null, result: {}, dry_run: false, created_at: now(), updated_at: now() }; db.provisioning_jobs.push(j); }
      if (sub.trial_duplicate) Object.assign(j, { status: 'held', last_error: 'duplicate_trial: this business phone already had a free trial' });
    }
    return t;
  }
  function syncClient(db, cid) {   // private.sync_client_billing
    const sub = subOf(db, cid); if (!sub) return;
    const [service] = subService(sub);
    db.tenants.filter(t => t.client_id === cid).forEach(t => planGuard(db, t));
    const c = db.clients.find(x => x.id === cid);
    c.next_bill_on = ['active', 'trialing'].indexOf(sub.status) !== -1 ? String(sub.current_period_end || sub.trial_ends_at || '').slice(0, 10) || null : null;
    if (service === 'message_only' && c.status === 'live') { c.status = 'paused'; c.billing_paused = true; }
    else if (service === 'full' && c.status === 'paused' && c.billing_paused) { c.status = 'live'; c.billing_paused = false; }
    if (service === 'full') tryGoLive(db, cid);
    p2ReleaseSync(db, cid);   // P2: private.number_release_sync
  }
  function tryGoLive(db, cid) {
    const c = db.clients.find(x => x.id === cid), sub = subOf(db, cid);
    if (!c || c.billing_mode !== 'subscription' || c.status !== 'testing' || !sub || ['trialing', 'active'].indexOf(sub.status) === -1 || subService(sub)[0] !== 'full') return false;
    const t = db.tenants.find(x => x.client_id === cid);
    if (!t || !t.twilio_number || !db.provisioning_jobs.some(j => j.tenant_id === t.id && j.kind === 'golive_sim' && j.status === 'done' && j.result && j.result.passed)) return false;
    if (db.onboarding_items.some(o => o.client_id === cid && OPTIONAL_ITEMS.indexOf(o.key) === -1 && o.status !== 'done')) return false;
    if (t.status === 'sandbox') t.status = 'live';
    c.status = 'live'; c.go_live_at = c.go_live_at || now(); c.updated_at = now();
    db.events.push({ id: uuid(), actor: 'system', entity: 'client', entity_id: cid, user_id: c.user_id, type: 'auto_go_live', payload: { plan: sub.plan_code }, client_visible: true, created_at: now() });
    db.outbox.push({ id: uuid(), to: emailOf2(db, c.user_id), template: 'went_live', subject: 'You’re live', created_at: now() });
    return true;
  }
  function autoGoLive(db, cid) {   // private.onboarding_autogolive
    const c = db.clients.find(x => x.id === cid);
    if (!c || c.billing_mode !== 'subscription' || ['onboarding', 'building', 'testing'].indexOf(c.status) === -1) return;
    if (db.onboarding_items.some(o => o.client_id === cid && OPTIONAL_ITEMS.indexOf(o.key) === -1 && o.status !== 'done')) return;
    const t = db.tenants.find(x => x.client_id === cid); if (!t || !t.twilio_number) return;
    if (c.status !== 'testing') { c.status = 'testing'; db.outbox.push({ id: uuid(), to: emailOf2(db, c.user_id), template: 'ready_to_test', subject: 'Your setup is done: final checks running', created_at: now() }); }
    let j = db.provisioning_jobs.find(x => x.tenant_id === t.id && x.kind === 'golive_sim');
    if (!j) { j = { id: uuid(), tenant_id: t.id, client_id: cid, kind: 'golive_sim', status: 'pending', attempts: 0, result: {}, created_at: now(), updated_at: now() }; db.provisioning_jobs.push(j); }
    else if (!(j.status === 'pending' || j.status === 'running' || (j.status === 'done' && j.result && j.result.passed))) Object.assign(j, { status: 'pending', attempts: 0, last_error: null });
    tryGoLive(db, cid);
  }
  function upsertCore(db, a) {   // private.upsert_subscription_core
    let sub = db.subscriptions.find(s => s.provider === a.provider && s.provider_subscription_id === a.provider_subscription_id);
    if (sub && sub.last_event_at && a.event_at && a.event_at < sub.last_event_at) return { subscription_id: sub.id, client_id: sub.client_id, status: sub.status, stale: true, changed: false };
    let cl;
    if (!sub) {
      cl = db.clients.filter(c => c.user_id === a.user_id && c.billing_mode === 'subscription').sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
      const p = db.profiles.find(x => x.id === a.user_id) || {};
      if (!cl) { cl = { id: uuid(), user_id: a.user_id, quote_id: null, products: ['RCP'], status: 'onboarding', billing_mode: 'subscription', billing_paused: false, business_name: p.company || null, monthly_cents: null, created_at: now(), updated_at: now() }; db.clients.push(cl); }
      a.phone = usE164(a.business_phone) || usE164(p.phone);
    } else { cl = db.clients.find(c => c.id === sub.client_id); a.phone = usE164(a.business_phone) || sub.business_phone; }
    let dup = false;
    if (a.status === 'trialing' && a.phone) {
      let claim = db.trial_claims.find(t => t.phone === a.phone);
      if (!claim) { claim = { phone: a.phone, client_id: cl.id, user_id: cl.user_id, claimed_at: now(), money_back_used_at: null }; db.trial_claims.push(claim); }
      dup = claim.client_id !== cl.id;
    }
    const ts = now();
    const isNew = !sub, was = sub ? { status: sub.status, cancel: !!sub.cancel_at_period_end } : null;
    if (!sub) {
      sub = { id: uuid(), client_id: cl.id, provider: a.provider, provider_subscription_id: a.provider_subscription_id, provider_customer_id: a.provider_customer_id || null,
        trial_began_at: a.status === 'trialing' ? ts : null, created_at: ts, money_back_used_at: null, trial_duplicate: false };
      db.subscriptions.push(sub);
    }
    Object.assign(sub, { plan_code: a.plan_code, scheduled_plan_code: a.scheduled_plan_code || null, status: a.status,
      card_on_file: a.card_on_file == null ? !!sub.card_on_file : !!a.card_on_file,
      trial_began_at: a.status === 'trialing' ? (sub.trial_began_at || ts) : sub.trial_began_at,
      trial_ends_at: a.trial_ends_at || sub.trial_ends_at || null, current_period_start: a.current_period_start || sub.current_period_start || null,
      current_period_end: a.current_period_end || sub.current_period_end || null,
      cancel_at_period_end: a.cancel_at_period_end == null ? !!sub.cancel_at_period_end : !!a.cancel_at_period_end,
      canceled_at: a.status === 'canceled' ? (a.canceled_at || sub.canceled_at || ts) : null,
      ends_at: a.status === 'canceled' ? (sub.ends_at || a.current_period_end || sub.current_period_end || a.canceled_at || ts) : null,
      past_due_since: a.status === 'past_due' ? (sub.past_due_since || ts) : null, paused_at: a.status === 'paused' ? (sub.paused_at || ts) : null,
      business_phone: a.phone || sub.business_phone || null, trial_duplicate: !!sub.trial_duplicate || dup, last_event_at: a.event_at || ts, updated_at: ts });
    let t = null;
    if (['trialing', 'active'].indexOf(sub.status) !== -1) t = provisionClient(db, sub);
    syncClient(db, cl.id);
    if (dup) db.outbox.push({ id: uuid(), to: 'owner', template: 'admin_provisioning_alert', subject: 'Automatic setup: second trial for the same phone', created_at: now() });
    subscriptionEmails(db, sub, cl, isNew, was);
    db.events.push({ id: uuid(), actor: 'system', entity: 'client', entity_id: cl.id, user_id: cl.user_id, type: 'subscription_updated', payload: { plan: sub.plan_code, status: sub.status }, client_visible: true, created_at: now() });
    return { subscription_id: sub.id, client_id: cl.id, tenant_id: t && t.id, status: sub.status, plan_code: sub.plan_code, stale: false, changed: true, trial_duplicate: sub.trial_duplicate };
  }
  // private.subscriptions_emails (20261128100000_us_subscription_emails.sql): welcome + Meir's alert once per new row,
  // Meir's cancel alert when a cancel is scheduled or a row ends without one
  function subscriptionEmails(db, sub, cl, isNew, was) {
    const q = (template, key, extra) => { if (!db.outbox.some(m => m.key === key)) db.outbox.push(Object.assign({ id: uuid(), key, sub: sub.id, template, created_at: now() }, extra)); };
    if (isNew && (sub.status === 'trialing' || sub.status === 'active')) {
      const tpl = sub.status === 'trialing' ? 'trial_welcome' : 'plan_welcome';
      q(tpl, tpl + ':' + sub.id, { to: emailOf2(db, cl.user_id), subject: sub.status === 'trialing' ? 'Your free trial has started' : 'Your plan has started' });
      q('admin_new_subscription', 'admin_new_subscription:' + sub.id, { to: 'owner', subject: 'New subscription' });
    } else if (!isNew && sub.cancel_at_period_end && !was.cancel && sub.status !== 'canceled') {
      q('admin_subscription_canceled', 'admin_subscription_canceled:' + sub.id + ':scheduled:' + now().slice(0, 10), { to: 'owner', subject: 'Subscription canceled', kind: 'scheduled' });
    } else if (!isNew && sub.status === 'canceled' && was.status !== 'canceled' && !was.cancel) {
      q('admin_subscription_canceled', 'admin_subscription_canceled:' + sub.id + ':ended', { to: 'owner', subject: 'Subscription ended', kind: 'ended' });
    }
  }
  function billingSync(db) {   // private.billing_sync (hourly cron)
    const t = Date.now();
    db.subscriptions.forEach(s => {
      if (s.provider === 'mock' && s.scheduled_plan_code && s.status === 'active' && s.current_period_end && Date.parse(s.current_period_end) <= t) {
        s.plan_code = s.scheduled_plan_code; s.scheduled_plan_code = null; s.current_period_start = s.current_period_end; s.current_period_end = iso(Date.parse(s.current_period_end) + 30 * 86400000);
      }
      if (s.status === 'trialing' && s.trial_ends_at && Date.parse(s.trial_ends_at) > t && Date.parse(s.trial_ends_at) <= t + 3 * 86400000
          && !db.outbox.some(m => m.template === 'trial_ending' && m.sub === s.id)) {
        const c = db.clients.find(x => x.id === s.client_id) || {};
        db.outbox.push({ id: uuid(), sub: s.id, to: emailOf2(db, c.user_id), template: 'trial_ending', subject: 'Your free trial ends soon', created_at: now() });
      }
    });
    [...new Set(db.subscriptions.map(s => s.client_id))].forEach(cid => syncClient(db, cid));
  }
  function periodKey(t) { const ps = ((t.config || {}).plan || {}).period_start; return ps ? 'p' + ps : new Date().toISOString().slice(0, 7); }
  function setUsage(tid, minutes) {
    const db = load(), t = db.tenants.find(x => x.id === tid); if (!t) throw new Error('not_found');
    const k = 'usage:' + tid + ':' + periodKey(t) + ':voice_minutes';
    db.runtime_state = db.runtime_state.filter(r => r.key !== k);
    db.runtime_state.push({ id: uuid(), key: k, tenant_id: tid, value: minutes, updated_at: now() });
    store(db);
  }
  // /jobs/tick: the number (dry run -> fictional 555-01xx number) and the go-live check ('pass' unless opts.golive = 'fail')
  function runtimeTick(opts) {
    const db = load(), out = { done: 0, failed: 0, held: 0 };
    db.provisioning_jobs.filter(j => j.status === 'pending').forEach(j => {
      const t = db.tenants.find(x => x.id === j.tenant_id); if (!t) return;
      j.attempts = (j.attempts || 0) + 1; j.updated_at = now();
      if (j.kind === 'number') {
        if (!t.twilio_number) {
          const area = String(((t.config || {}).business || {}).main_phone || '+1202').slice(2, 5);
          let n = 0, num; do { num = '+1' + area + '55501' + String(n++).padStart(2, '0'); } while (db.tenants.some(x => x.twilio_number === num || ((x.config || {}).business || {}).main_phone === num));
          t.twilio_number = num;
        }
        Object.assign(j, { status: 'done', dry_run: true, result: { number: t.twilio_number, dry_run: true } }); out.done++;
        db.events.push({ id: uuid(), actor: 'runtime', entity: 'tenant', entity_id: t.id, user_id: null, type: 'number_assigned', payload: { dry_run: true }, client_visible: true, created_at: now() });
      } else if (j.kind === 'golive_sim') {
        const pass = !(opts && opts.golive === 'fail');
        Object.assign(j, { status: pass ? 'done' : 'failed', result: { passed: pass, failed: pass ? [] : ['booking'], checks: [] } });
        out[pass ? 'done' : 'failed']++;
        if (pass) tryGoLive(db, j.client_id);
      }
    });
    store(db);
    return out;
  }
  // test/demo: change the signed-in user's subscription (e.g. {trial_ends_at: <past>}) and run the hourly sync
  function billingTravel(patch, opts) {
    const db = load(), u = me(db); if (!u) throw new Error('not_authenticated');
    const c = db.clients.filter(x => x.user_id === u.id && x.billing_mode === 'subscription')[0]; if (!c) throw new Error('no_subscription');
    const sub = subOf(db, c.id);
    Object.assign(sub, patch || {});
    billingSync(db);
    store(db);
    return clone(sub);
  }
  // paddle-webhook for the checkout ref (subscription.created, trialing or active); the user + phone come from the ref row
  function paddleWebhook(opts) {
    const db = load(), o = opts || {}, c = db.billing_checkouts.find(x => x.ref === o.ref);
    if (!c) throw new Error('unknown_ref');
    const trial = o.trial != null ? !!o.trial : c.trial;
    const r = upsertCore(db, { provider: 'paddle', provider_subscription_id: o.subscription_id || ('sub_mock' + rnd(20)), status: trial ? 'trialing' : 'active', plan_code: o.plan_code || c.plan_code,
      user_id: c.user_id, provider_customer_id: 'ctm_mock' + rnd(12), trial_ends_at: trial ? iso(Date.now() + 14 * 86400000) : null,
      current_period_start: trial ? null : now(), current_period_end: trial ? null : iso(Date.now() + 30 * 86400000), card_on_file: true, business_phone: c.business_phone, event_at: now() });
    c.status = 'completed'; c.completed_at = now();
    store(db);
    return r;
  }
  function billingApi() {
    const run = fn => { const db = load(), u = me(db); if (!u) return fail('not_authenticated'); try { const r = fn(db, u); store(db); return later(r); } catch (e) { return fail(e.code || e.message); } };
    const mine = (db, u) => db.clients.filter(c => c.user_id === u.id && c.billing_mode === 'subscription').sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
    const admin = (db, u) => { if (!(db.profiles.find(p => p.id === u.id) || {}).is_admin) throw bErr('not_admin'); };
    const eligible = (db, u, phone) => {
      const ph = usE164(phone) || usE164((db.profiles.find(p => p.id === u.id) || {}).phone);
      if (!ph) return { eligible: false, reason: 'phone_required' };
      const claim = db.trial_claims.find(t => t.phone === ph), c = mine(db, u);
      return claim && claim.client_id !== (c && c.id) ? { eligible: false, reason: 'trial_already_used' } : { eligible: true, reason: '' };
    };
    const ownSub = (db, u) => { const c = mine(db, u), s = c && subOf(db, c.id); if (!s) throw bErr('no_subscription'); return s; };
    return {
      getBilling() {
        return run((db, u) => {
          const c = mine(db, u); if (!c) return { subscription: null, mock_checkout: true };
          const s = subOf(db, c.id), t = db.tenants.find(x => x.client_id === c.id) || {}, pl = (t.config || {}).plan || {};
          const per = periodKey(t), val = k => { const r = db.runtime_state.find(x => x.key === 'usage:' + t.id + ':' + per + ':' + k); return r ? r.value : 0; };
          // = client_billing.number_release (20261127100000_us_firstring_p3.sql): own client, only while scheduled, number + date only
          const rel = (db.number_releases || []).filter(r => r.client_id === c.id && r.tenant_id === t.id && r.status === 'scheduled')
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
          return { client_id: c.id, client_status: c.status, tenant_id: t.id, number: t.twilio_number || null,
            number_release: rel ? { number: rel.number, release_at: rel.release_at } : null,
            subscription: { plan_code: s.plan_code, scheduled_plan_code: s.scheduled_plan_code || null, status: s.status, provider: s.provider, card_on_file: s.card_on_file,
              trial_ends_at: s.trial_ends_at || null, current_period_start: s.current_period_start || null, current_period_end: s.current_period_end || null,
              cancel_at_period_end: !!s.cancel_at_period_end, ends_at: s.ends_at || null, trial_duplicate: !!s.trial_duplicate },
            service: { mode: pl.service || 'full', reason: pl.service_reason || '' }, period: { label: per, start: pl.period_start || null, end: pl.period_end || null },
            usage: { voice_minutes: val('voice_minutes') || 0, needs_addon_approval: val('needs_addon_approval') === true },
            setup: db.provisioning_jobs.filter(j => j.tenant_id === t.id).map(j => ({ kind: j.kind, status: j.status === 'done' ? 'done' : ['pending', 'running'].indexOf(j.status) !== -1 ? 'working' : 'delayed', updated_at: j.updated_at })),
            mock_checkout: true };
        });
      },
      trialEligible(phone) { return run((db, u) => eligible(db, u, phone)); },
      mockCheckout(plan, trialDays, phone) {
        return run((db, u) => {
          const days = trialDays == null ? 14 : trialDays;
          if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(plan || '')) throw bErr('bad_plan_code');
          const c = mine(db, u), s = c && subOf(db, c.id);
          if (s && s.status !== 'canceled') throw bErr('already_subscribed');
          const el = eligible(db, u, phone); if (days > 0 && !el.eligible) throw bErr(el.reason);
          return upsertCore(db, { provider: 'mock', provider_subscription_id: 'mock_' + rnd(20), status: days > 0 ? 'trialing' : 'active', plan_code: plan, user_id: u.id,
            provider_customer_id: 'mock_cus', trial_ends_at: days > 0 ? iso(Date.now() + days * 86400000) : null, current_period_start: days > 0 ? null : now(),
            current_period_end: days > 0 ? null : iso(Date.now() + 30 * 86400000), card_on_file: true, business_phone: phone });
        });
      },
      changePlan(plan, startNow) {
        return run((db, u) => {
          const s = ownSub(db, u);
          if (['trialing', 'active', 'past_due'].indexOf(s.status) === -1) throw bErr('subscription_not_active');
          if (s.plan_code === plan && !startNow) throw bErr('same_plan');
          const base = { provider: s.provider, provider_subscription_id: s.provider_subscription_id, plan_code: s.plan_code, status: s.status };
          if (s.status === 'active' && (PLAN_RANK[plan] || 99) < (PLAN_RANK[s.plan_code] || 99) && !startNow) return Object.assign(upsertCore(db, Object.assign(base, { scheduled_plan_code: plan })), { applied: true, scheduled: true });
          const go = startNow && s.status === 'trialing';
          return Object.assign(upsertCore(db, Object.assign(base, { plan_code: plan, status: go ? 'active' : s.status, trial_ends_at: go ? now() : null,
            current_period_start: go ? now() : null, current_period_end: go ? iso(Date.now() + 30 * 86400000) : null })), { applied: true });
        });
      },
      cancelPlan() {
        return run((db, u) => {
          const s = ownSub(db, u), base = { provider: s.provider, provider_subscription_id: s.provider_subscription_id, plan_code: s.plan_code };
          if (s.status === 'trialing') return Object.assign(upsertCore(db, Object.assign(base, { status: 'canceled', canceled_at: now(), cancel_at_period_end: false })), { applied: true });
          return Object.assign(upsertCore(db, Object.assign(base, { status: s.status, cancel_at_period_end: true, scheduled_plan_code: s.scheduled_plan_code })), { applied: true });
        });
      },
      resumePlan() {
        return run((db, u) => {
          const s = ownSub(db, u), base = { provider: s.provider, provider_subscription_id: s.provider_subscription_id, plan_code: s.plan_code, status: 'active' };
          if (s.status === 'active' && s.cancel_at_period_end) return Object.assign(upsertCore(db, Object.assign(base, { cancel_at_period_end: false })), { applied: true });
          return Object.assign(upsertCore(db, Object.assign(base, { current_period_start: now(), current_period_end: iso(Date.now() + 30 * 86400000), cancel_at_period_end: false, card_on_file: true })), { applied: true });
        });
      },
      // public.billing_checkout_start (sign-up screen): consent + one subscription per account + one trial per phone
      checkoutStart(plan, phone, agreementVersion, consentText, trial) {
        return run((db, u) => {
          if (!PLAN_RANK[plan]) throw bErr('bad_plan_code');
          const ph = usE164(phone); if (!ph) throw bErr('phone_invalid');
          if (String(consentText || '').trim().length < 20) throw bErr('consent_required');
          if (!/^[0-9]{1,3}\.[0-9]{1,3}$/.test(agreementVersion || '')) throw bErr('bad_agreement_version');
          const c = mine(db, u), s = c && subOf(db, c.id);
          if (s && s.status !== 'canceled') throw bErr('already_subscribed');
          const t = trial !== false;
          if (t && s) throw bErr('trial_already_used');   // a returning client starts paid
          if (t) { const el = eligible(db, u, ph); if (!el.eligible) throw bErr(el.reason); }
          if (db.billing_checkouts.filter(x => x.user_id === u.id && Date.parse(x.created_at) > Date.now() - 86400000).length >= 30) throw bErr('too_many_checkouts');
          const row = { id: uuid(), ref: 'chk_' + Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''), user_id: u.id,
            plan_code: plan, trial: t, business_phone: ph, agreement_version: agreementVersion, consent_text: String(consentText).trim().slice(0, 600),
            user_agent: (navigator.userAgent || '').slice(0, 300), status: 'open', created_at: now() };
          db.billing_checkouts.push(row);
          return { ref: row.ref, plan_code: plan, trial: t, business_phone: ph };
        });
      },
      // Edge Function paddle-billing, for a provider 'paddle' subscription: here the Paddle API call AND the webhook that
      // follows it are applied at once (same rules as supabase/functions/_shared/paddle_billing.ts). The call is kept in
      // db.paddle_calls so the tests can check what would go to Paddle.
      paddleAction(action, extra) {
        return run((db, u) => {
          const s = ownSub(db, u), x = extra || {};
          if (s.provider !== 'paddle') throw bErr('not_paddle');
          const call = (method, path, body) => db.paddle_calls.push({ method, path, body: body || {}, at: now() });
          const base = { provider: 'paddle', provider_subscription_id: s.provider_subscription_id, plan_code: s.plan_code, status: s.status, scheduled_plan_code: s.scheduled_plan_code };
          const sid = s.provider_subscription_id;
          if (action === 'change_plan') {
            const plan = x.plan_code;
            if (!PLAN_RANK[plan]) throw bErr('bad_plan_code');
            if (s.status === 'past_due') throw bErr('past_due_update_card');
            if (['trialing', 'active'].indexOf(s.status) === -1) throw bErr('subscription_not_active');
            if (plan === s.plan_code && !s.scheduled_plan_code) throw bErr('same_plan');
            if (s.status === 'trialing') { call('PATCH', '/subscriptions/' + sid, { price: plan + ':trial', proration_billing_mode: 'do_not_bill' }); upsertCore(db, Object.assign(base, { plan_code: plan, scheduled_plan_code: null })); return { ok: true, pending: true, applies: 'now' }; }
            if (plan === s.plan_code) { call('PATCH', '/subscriptions/' + sid, { price: plan + ':paid', proration_billing_mode: 'do_not_bill' }); upsertCore(db, Object.assign(base, { scheduled_plan_code: null })); return { ok: true, pending: true, applies: 'now' }; }
            if (PLAN_RANK[plan] > PLAN_RANK[s.plan_code]) { call('PATCH', '/subscriptions/' + sid, { price: plan + ':paid', proration_billing_mode: 'prorated_immediately' }); upsertCore(db, Object.assign(base, { plan_code: plan, scheduled_plan_code: null })); return { ok: true, pending: true, applies: 'now' }; }
            call('PATCH', '/subscriptions/' + sid, { price: plan + ':paid', proration_billing_mode: 'full_next_billing_period' });
            upsertCore(db, Object.assign(base, { scheduled_plan_code: plan }));
            return { ok: true, pending: true, applies: 'next_period', scheduled: true };
          }
          if (action === 'start_now') {
            if (s.status !== 'trialing') throw bErr('not_trialing');
            call('POST', '/subscriptions/' + sid + '/activate');
            upsertCore(db, Object.assign(base, { status: 'active', current_period_start: now(), current_period_end: iso(Date.now() + 30 * 86400000) }));
            return { ok: true, pending: true };
          }
          if (action === 'cancel') {
            if (s.status === 'trialing') { call('POST', '/subscriptions/' + sid + '/cancel', { effective_from: 'immediately' }); upsertCore(db, Object.assign(base, { status: 'canceled', canceled_at: now(), cancel_at_period_end: false, scheduled_plan_code: null })); return { ok: true, pending: true, ends: 'now' }; }
            if (s.status !== 'active') throw bErr('subscription_not_active');
            call('POST', '/subscriptions/' + sid + '/cancel', { effective_from: 'next_billing_period' });
            upsertCore(db, Object.assign(base, { cancel_at_period_end: true }));
            return { ok: true, pending: true, ends: 'period_end' };
          }
          if (action === 'resume') {
            if (s.status === 'active' && s.cancel_at_period_end) { call('PATCH', '/subscriptions/' + sid, { scheduled_change: null }); upsertCore(db, Object.assign(base, { cancel_at_period_end: false })); return { ok: true, pending: true }; }
            if (s.status === 'paused') { call('POST', '/subscriptions/' + sid + '/resume', { effective_from: 'immediately' }); upsertCore(db, Object.assign(base, { status: 'active' })); return { ok: true, pending: true }; }
            if (s.status === 'canceled') return { ok: false, resubscribe: true };
            if (s.status === 'past_due') return { ok: true, update_card: true, update_payment_method: location.origin + '/start/?paddle_portal=demo#billing' };
            throw bErr('nothing_to_resume');
          }
          if (action === 'update_card' || action === 'manage') {
            call('POST', '/customers/' + (s.provider_customer_id || 'ctm_mock') + '/portal-sessions', { subscription_ids: [sid] });
            return { ok: true, url: location.origin + '/start/?paddle_portal=' + (action === 'update_card' ? 'card' : 'overview') + '#billing' };
          }
          throw bErr('bad_action');
        });
      },
      // admin: paddle-billing action money_back (full refund of the first paid charge within 30 days, then the plan ends)
      adminPaddleRefund(clientId) {
        return run((db, u) => {
          admin(db, u);
          const s = subOf(db, clientId); if (!s) throw bErr('no_subscription');
          if (s.provider !== 'paddle') throw bErr('not_paddle');
          const claim = db.trial_claims.find(x => x.phone === s.business_phone);
          if (s.money_back_used_at || (claim && claim.money_back_used_at)) throw bErr('money_back_already_used');
          if (!s.first_paid_at || !s.first_paid_transaction_id || Date.parse(s.first_paid_at) < Date.now() - 30 * 86400000) throw bErr('money_back_window_closed');
          db.paddle_calls.push({ method: 'POST', path: '/adjustments', body: { action: 'refund', type: 'full', transaction_id: s.first_paid_transaction_id }, at: now() });
          s.money_back_used_at = now(); s.money_back_refund_id = 'adj_mock' + rnd(10); if (claim) claim.money_back_used_at = s.money_back_used_at;
          if (s.status !== 'canceled') {
            db.paddle_calls.push({ method: 'POST', path: '/subscriptions/' + s.provider_subscription_id + '/cancel', body: { effective_from: 'immediately' }, at: now() });
            upsertCore(db, { provider: 'paddle', provider_subscription_id: s.provider_subscription_id, plan_code: s.plan_code, status: 'canceled', canceled_at: now(), cancel_at_period_end: false });
          }
          return { ok: true, refund_id: s.money_back_refund_id, refund_status: 'pending_approval', plan_ended: true };
        });
      },
      confirmForwardingTest(id) {
        return run((db, u) => {
          const it = db.onboarding_items.find(o => o.id === id);
          if (!it || it.key !== 'forward_calls' || !db.clients.some(c => c.id === it.client_id && c.user_id === u.id)) throw bErr('not_your_item');
          if (!(it.data || {}).test_unverified_at) throw bErr('no_test_call');
          if (it.data.test_direct) throw bErr('called_directly');
          // 20261129100200_us_forwarding_self_confirmed.sql: recorded as UNVERIFIED, an admin-only event + one admin e-mail
          it.status = 'done'; it.done_at = now(); it.data = Object.assign({}, it.data, { test_call_at: it.data.test_unverified_at, verified: 'self_confirmed',
            unverified: true, self_confirmed_at: now(), self_confirmed_by: 'client' });
          db.events.push({ id: uuid(), actor: 'client', entity: 'client', entity_id: it.client_id, user_id: u.id, type: 'forwarding_self_confirmed',
            payload: { item: it.id, test_call_id: it.data.test_call_id || null, test_call_at: it.data.test_unverified_at, by: 'client' }, client_visible: false, created_at: now() });
          if (!db.outbox.some(m => m.template === 'admin_provisioning_alert' && m.idem_key === 'admin_provisioning_alert:forwarding_self_confirmed:' + it.id)) {
            db.outbox.push({ id: uuid(), idem_key: 'admin_provisioning_alert:forwarding_self_confirmed:' + it.id, to: 'owner', template: 'admin_provisioning_alert',
              subject: 'Call forwarding unverified', payload: { step: 'forwarding_self_confirmed' }, created_at: now() });
          }
          autoGoLive(db, it.client_id);
          return it;
        });
      },
      adminSubscriptions() {
        return run((db, u) => {
          admin(db, u);
          return db.clients.filter(c => c.billing_mode === 'subscription' && subOf(db, c.id)).map(c => {
            const s = subOf(db, c.id), t = db.tenants.find(x => x.client_id === c.id), p = db.profiles.find(x => x.id === c.user_id) || {};
            const claim = db.trial_claims.find(x => x.phone === s.business_phone) || {};
            const sv = (((t || {}).config || {}).plan || {});
            return { client_id: c.id, client_status: c.status, business_name: c.business_name || p.company || p.email, email: p.email, created_at: s.created_at,
              subscription: Object.assign({}, s, { business_phone: undefined }), money_back_used_at: s.money_back_used_at || claim.money_back_used_at || null,
              tenant: t ? { id: t.id, slug: t.slug, status: t.status, twilio_number: t.twilio_number || null, service: sv.service || 'full', service_reason: sv.service_reason || '' } : null,
              jobs: db.provisioning_jobs.filter(j => t && j.tenant_id === t.id).map(j => ({ kind: j.kind, status: j.status, attempts: j.attempts || 0, last_error: j.last_error || null,
                dry_run: !!j.dry_run, updated_at: j.updated_at, passed: (j.result || {}).passed, failed: (j.result || {}).failed, number: (j.result || {}).number || (j.result || {}).would_buy || null })),
              checklist: { done: db.onboarding_items.filter(o => o.client_id === c.id && OPTIONAL_ITEMS.indexOf(o.key) === -1 && o.status === 'done').length,
                required: db.onboarding_items.filter(o => o.client_id === c.id && OPTIONAL_ITEMS.indexOf(o.key) === -1).length } };
          }).sort((a, b) => b.created_at.localeCompare(a.created_at));
        });
      },
      adminRetryProvisioning(clientId, kind) {
        return run((db, u) => {
          admin(db, u);
          if (['number', 'golive_sim', 'setup'].indexOf(kind) === -1) throw bErr('bad_kind');
          const s = subOf(db, clientId); if (!s) throw bErr('no_subscription');
          if (kind === 'setup') { s.trial_duplicate = false; const t = provisionClient(db, s); const j = db.provisioning_jobs.find(x => x.tenant_id === t.id && x.kind === 'number'); if (j && j.status === 'held') j.status = 'pending'; syncClient(db, clientId); }
          else {
            const t = db.tenants.find(x => x.client_id === clientId); if (!t) throw bErr('no_tenant');
            let j = db.provisioning_jobs.find(x => x.tenant_id === t.id && x.kind === kind);
            if (!j) { j = { id: uuid(), tenant_id: t.id, client_id: clientId, kind, result: {}, created_at: now() }; db.provisioning_jobs.push(j); }
            Object.assign(j, { status: 'pending', attempts: 0, last_error: null, updated_at: now() });
          }
          return { ok: true, kind };
        });
      },
      adminForceGolive(clientId) {
        return run((db, u) => {
          admin(db, u);
          const t = db.tenants.find(x => x.client_id === clientId && x.twilio_number); if (!t) throw bErr('no_number');
          const c = db.clients.find(x => x.id === clientId);
          t.status = 'live'; c.status = 'live'; c.go_live_at = c.go_live_at || now();
          return { ok: true };
        });
      },
      adminMarkMoneyBack(clientId) {
        return run((db, u) => {
          admin(db, u);
          const s = subOf(db, clientId); if (!s) throw bErr('no_subscription');
          const claim = db.trial_claims.find(x => x.phone === s.business_phone);
          if (s.money_back_used_at || (claim && claim.money_back_used_at)) throw bErr('money_back_already_used');
          s.money_back_used_at = now(); if (claim) claim.money_back_used_at = s.money_back_used_at;
          return { ok: true };
        });
      }
    };
  }

  // ------------------------------------------------------------------ P2: FirstRing phase 2 (runtime agent, 2026-11-25)
  // Mirrors supabase/migrations/20261125200000_us_firstring_p2.sql: Spanish by plan + the remembered choice
  // (tenant_plan_spanish, update_tenant_settings key `spanish`), number release after the service ended
  // (number_release_sync, admin_subscriptions_extra / admin_postpone_number_release / admin_release_number_now) and a
  // stand-in for the runtime's release tick + the go-live live AI check result (tests: StartMock.admin.p2Tick).
  const P2_SPANISH_CODES = ['FR_PRO', 'FR_BUSINESS'];   // = private.plan_has_spanish (price book features 'spanish')
  const p2PlanHasSpanish = code => {
    const pb = (window.Start && window.Start.PB) || window.ADMIN_PB || {};
    const p = (pb.plans || []).find(x => x.code === code);
    return p ? (p.features || []).indexOf('spanish') !== -1 : P2_SPANISH_CODES.indexOf(code) !== -1;
  };
  function p2PlanSpanish(t) {   // private.tenant_plan_spanish (after the plan block is written)
    const cfg = t.config || {}, plan = cfg.plan; if (!plan || typeof plan !== 'object') return;
    const v = cfg.voice && typeof cfg.voice === 'object' ? cfg.voice : {};
    const want = p2PlanHasSpanish(plan.code) && v.spanish_off !== true ? ['en', 'es'] : ['en'];
    if (JSON.stringify(v.languages) !== JSON.stringify(want)) t.config = Object.assign({}, cfg, { voice: Object.assign({}, v, { languages: want }) });
  }
  function p2HasSpanish(db, tid) {   // private.tenant_has_spanish
    const t = db.tenants.find(x => x.id === tid), c = t && db.clients.find(x => x.id === t.client_id);
    return !!(t && c && c.billing_mode === 'subscription' && p2PlanHasSpanish(((t.config || {}).plan || {}).code));
  }
  function p2SetSpanish(t, on) {
    t.config = Object.assign({}, t.config || {}, { voice: Object.assign({}, (t.config || {}).voice || {}, { spanish_off: !on, languages: on ? ['en', 'es'] : ['en'] }) });
  }
  function p2Window(sub, at) {   // private.number_release_window
    if (!sub) return { eligible: false };
    const [service, reason] = subService(sub, at);
    if (service !== 'message_only' || ['canceled', 'trial_ended'].indexOf(reason) === -1) return { eligible: false, reason: '' };
    const ended = reason === 'trial_ended' ? sub.trial_ends_at : sub.status === 'canceled' ? (sub.ends_at || sub.canceled_at) : sub.current_period_end;
    return { eligible: !!ended && Date.parse(ended) <= (at || Date.now()), reason, ended_at: ended };
  }
  function p2ReleaseSync(db, cid) {   // private.number_release_sync (every subscription write + hourly)
    db.number_releases = db.number_releases || [];
    const t = db.tenants.find(x => x.client_id === cid); if (!t) return;
    const sub = subOf(db, cid), w = p2Window(sub), r = db.number_releases.find(x => x.tenant_id === t.id);
    if (w.eligible && t.twilio_number) {
      const rel = Date.parse(w.ended_at) + 30 * 86400000;
      const fresh = { subscription_id: sub.id, number: t.twilio_number, reason: w.reason, status: 'scheduled', service_ended_at: w.ended_at,
        warn_at: iso(rel - 7 * 86400000), release_at: iso(rel), warned_at: null, released_at: null, canceled_at: null, cancel_reason: null,
        force: false, postponed_count: 0, attempts: 0, last_error: null, dry_run: false, result: {}, updated_at: now() };
      if (!r) db.number_releases.push(Object.assign({ id: uuid(), tenant_id: t.id, client_id: cid, created_at: now() }, fresh));
      else if (r.status === 'canceled' || (r.status === 'released' && r.number !== t.twilio_number)) Object.assign(r, fresh);
      return;
    }
    if (r && ['scheduled', 'held', 'failed'].indexOf(r.status) !== -1) {
      Object.assign(r, { status: 'canceled', canceled_at: now(), updated_at: now(),
        cancel_reason: sub && ['active', 'trialing'].indexOf(sub.status) !== -1 && !w.reason ? 'resubscribed' : 'service_not_ended' });
    }
  }
  // what /jobs/tick does for releases (runtime/app/provisioning.py, TWILIO_RELEASE_LIVE off = dry run) + the AI check result
  function p2Tick(opts) {
    const db = load(), o = opts || {}, out = { warned: 0, held: 0, canceled: 0 };
    db.number_releases = db.number_releases || [];
    [...new Set(db.subscriptions.map(s => s.client_id))].forEach(cid => p2ReleaseSync(db, cid));
    db.number_releases.filter(r => r.status === 'scheduled').forEach(r => {
      if (!p2Window(subOf(db, r.client_id)).eligible) { Object.assign(r, { status: 'canceled', cancel_reason: 'service_not_ended' }); out.canceled++; return; }
      if (!r.warned_at && !r.force && (Date.parse(r.warn_at) <= Date.now() || Date.parse(r.release_at) <= Date.now())) {
        r.warned_at = now(); if (Date.parse(r.release_at) < Date.now() + 7 * 86400000 - 3600000) r.release_at = iso(Date.now() + 7 * 86400000);
        db.outbox.push({ id: uuid(), to: 'owner', template: 'number_release_warning', subject: 'Your receptionist’s number will be released', created_at: now() });
        out.warned++; return;
      }
      if (Date.parse(r.release_at) <= Date.now()) { Object.assign(r, { status: 'held', dry_run: true, result: { would_release: r.number, dry_run: true } }); out.held++; }
    });
    if (o.ai) {   // the go-live job's live AI check (GOLIVE_LIVE_AI_CHECK=1 in the runtime)
      const pass = o.ai === 'pass';
      const transcript = [{ who: 'assistant', text: 'Thanks for calling. I’m the virtual assistant, an AI. This call may be recorded and transcribed.' },
        { who: 'customer', text: 'Hi, I need someone to come out and take a look, it’s about ac repair' },
        { who: 'assistant', text: pass ? 'I can get a technician out. What’s the ZIP code for the service address?' : 'Our team will give you an exact price on site.',
          model_text: pass ? undefined : 'Sure, that’s $99 and I guarantee it. You could also try another company.', guard: pass ? undefined : ['reply:price'] },
        { who: 'customer', text: 'The ZIP is 77002, I’m at 123 Main St, Springfield, my name is Test Caller' },
        { who: 'assistant', text: pass ? 'I have Thursday 12 PM to 4 PM or Friday 8 AM to 12 PM. Which works better?' : 'Our team will give you an exact price on site.' }];
      const ai = o.ai === 'error' ? { status: 'error', attempts: 3, error: 'timeout after 90s', problems: [], problems_he: [], transcript: [], cost_usd: 0.0021, tokens: { input_tokens: 1800, output_tokens: 0 }, model_calls: 3 }
        : { status: pass ? 'passed' : 'failed', attempts: 1, problems: pass ? [] : ['price', 'promise', 'other_business', 'booking'],
            problems_he: pass ? [] : ['Agent said a price that is not on the list', 'Agent made a promise / gave a discount', 'Agent mentioned another business', 'Agent did not offer an appointment time'],
            transcript, cost_usd: 0.0384, tokens: { input_tokens: 11200, output_tokens: 310 }, model_calls: 7 };
      db.provisioning_jobs.filter(j => j.kind === 'golive_sim' && (!o.client || j.client_id === o.client)).forEach(j => {
        Object.assign(j, { status: pass ? 'done' : o.ai === 'error' ? 'held' : 'failed', updated_at: now(),
          result: { passed: pass, failed: pass ? [] : ['live_ai'], checks: [], ai_check: ai } });
        if (pass) tryGoLive(db, j.client_id);
      });
    }
    store(db);
    return out;
  }
  function p2Api() {
    const run = fn => { const db = load(), u = me(db); if (!u) return fail('not_authenticated'); try { const r = fn(db, u); store(db); return later(r); } catch (e) { return fail(e.code || e.message); } };
    const admin = (db, u) => { if (!(db.profiles.find(p => p.id === u.id) || {}).is_admin) throw bErr('not_admin'); };
    const relOf = (db, cid) => (db.number_releases || []).filter(r => r.client_id === cid).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
    const open = r => { if (!r || ['scheduled', 'held', 'failed'].indexOf(r.status) === -1) throw bErr('no_release_scheduled'); return r; };
    return {
      adminSubscriptionsExtra() {
        return run((db, u) => {
          admin(db, u);
          return db.clients.filter(c => c.billing_mode === 'subscription').map(c => {
            const r = relOf(db, c.id), j = db.provisioning_jobs.filter(x => x.client_id === c.id && x.kind === 'golive_sim').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
            const fw = db.onboarding_items.filter(o => o.client_id === c.id && o.key === 'forward_calls').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
            return { client_id: c.id, release: r ? Object.assign({}, r, { result: undefined, would_release: (r.result || {}).would_release || null }) : null,
              golive: j ? { status: j.status, updated_at: j.updated_at, passed: (j.result || {}).passed, ai_check: (j.result || {}).ai_check || null } : null,
              // 20261129100200_us_forwarding_self_confirmed.sql: unverified = done without carrier forwarding data
              forwarding: fw ? { status: fw.status, verified: (fw.data || {}).verified || null, unverified: fw.status === 'done' && (fw.data || {}).verified !== 'forwarded_from',
                self_confirmed_at: (fw.data || {}).self_confirmed_at || null, self_confirmed_by: (fw.data || {}).self_confirmed_by || null,
                test_call_at: (fw.data || {}).test_call_at || null } : null };
          });
        });
      },
      adminPostponeNumberRelease(clientId, days) {
        return run((db, u) => {
          admin(db, u);
          const n = days == null ? 14 : days; if (!(n >= 1 && n <= 180)) throw bErr('bad_days');
          const r = open(relOf(db, clientId)), rel = Math.max(Date.parse(r.release_at), Date.now()) + n * 86400000;
          Object.assign(r, { release_at: iso(rel), warn_at: iso(Math.max(rel - 7 * 86400000, Date.now())), warned_at: null, status: 'scheduled', force: false,
            attempts: 0, last_error: null, postponed_count: (r.postponed_count || 0) + 1, updated_at: now() });
          return { ok: true, release_at: r.release_at, warn_at: r.warn_at };
        });
      },
      adminReleaseNumberNow(clientId) {
        return run((db, u) => {
          admin(db, u);
          const r = open(relOf(db, clientId));
          if (!p2Window(subOf(db, clientId)).eligible) throw bErr('subscription_not_ended');
          Object.assign(r, { release_at: now(), warn_at: iso(Math.min(Date.parse(r.warn_at), Date.now())), status: 'scheduled', force: true, attempts: 0, last_error: null, updated_at: now() });
          return { ok: true, release_at: r.release_at };
        });
      }
    };
  }

  // ------------------------------------------------------------------ admin (task A7): see mock-admin section below
  window.StartMock = {
    create: C => Object.assign(create(C), adminApi(C), portalBApi(C), billingApi(), p2Api()),
    MOCK_ADMIN_EMAIL,
    admin: {
      reset() { ls.del(KEY); ls.del(SKEY); },
      db: load,
      inbox: email => load().outbox.filter(m => !email || m.to === email),
      seed,
      seedAdmin,   // A7: demo data for /start/admin/
      // a questionnaire as stored BEFORE 2026-11-25 (e.g. a FirstRing one), for the signed-in user; written directly, like
      // existing rows in the database (the client API refuses new FirstRing questionnaires: offer_not_offered)
      legacyQuestionnaire: o => { const db = load(), u = me(db); if (!u) throw new Error('not_authenticated');
        const x = o || {}, q = { id: uuid(), user_id: u.id, offer: x.offer || 'RCP', niche: x.niche || 'home_services', status: x.status || 'draft',
          answers: clone(x.answers || { offer: x.offer || 'RCP', niche: x.niche || 'home_services' }), summary: clone(x.summary || []), utm: {},
          submitted_at: x.status && x.status !== 'draft' ? now() : null, created_at: now(), updated_at: now() };
        db.questionnaires.push(q); store(db); return q.id; },
      seedTenant: opts => seedTenant(opts),    // B7: tenant + receptionist demo data for the signed-in client ({niche:'real_estate'} = real-estate tenant)
      seedResults: () => seedResults(),        // appointment manager: Results panel / no-show demo data
      simulateCall: (tid, opts) => simulateCall(tid, opts),  // B7: a call reaches the tenant number ({forwardedFrom, from}; default = forwarded by the business line)
      seedDispatch: opts => seedDispatch(opts), // ADD-DISPATCH demo data (tools/e2e_dispatch.mjs)
      runtimeTick: opts => runtimeTick(opts),   // FirstRing: what /jobs/tick does (dry-run number, go-live check {golive: 'pass'|'fail'})
      billing: (patch, opts) => billingTravel(patch, opts),   // FirstRing: change the signed-in client's subscription + hourly sync
      paddleWebhook: opts => paddleWebhook(opts),             // sign-up with Paddle: what paddle-webhook does for subscription.created (by ref)
      paddleFirstCharge: (daysAgo) => { const db = load(), u = me(db), c = db.clients.find(x => x.user_id === (u || {}).id && x.billing_mode === 'subscription'), s = c && subOf(db, c.id);
        if (!s) throw new Error('no_subscription'); s.first_paid_at = iso(Date.now() - (daysAgo || 0) * 86400000); s.first_paid_transaction_id = 'txn_mock' + rnd(12); store(db); return clone(s); },
      setUsage: (tid, minutes) => setUsage(tid, minutes),     // FirstRing: this period's voice minutes
      p2Tick: opts => p2Tick(opts)   // FirstRing phase 2: release tick (dry run) + go-live AI check result {ai: 'pass'|'fail'|'error'}
    }
  };
})();
