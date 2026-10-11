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
  const TABLES = ['users', 'profiles', 'questionnaires', 'attachments', 'quotes', 'clients', 'payments', 'events', 'outbox', 'otps'];
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
        niche: null, website: null, how_heard: null, update_lang: 'en', is_admin: false, created_at: now(), updated_at: now() });
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

  window.StartMock = {
    create,
    admin: {
      reset() { ls.del(KEY); ls.del(SKEY); },
      db: load,
      inbox: email => load().outbox.filter(m => !email || m.to === email),
      seed
    }
  };
})();
