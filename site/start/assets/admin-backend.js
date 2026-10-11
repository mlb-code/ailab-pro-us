/* Admin data layer (task A7) for /start/admin/. ONE API, two adapters, same switch as the client portal (backend.js):
     mock     -> window.StartMock.create(C) (mock/mock-backend.js: auth + admin* methods, localStorage)
     supabase -> supabase-js; every read/write goes through RLS, where admin = private.is_admin() (profiles.is_admin)
   The admin page uses only window.AdminBackend.* so both adapters share the method names below.
   Auth (same as Backend): getSession, sendCode, verifyCode, consumeLink, signOut
   Admin: adminWhoami, adminListLeads, adminListProfiles, adminListQuestionnaires, adminListAttachments, downloadUrl,
          adminListQuotes, adminGetQuoteReview, adminRegenerateDraft, adminSaveQuote, quoteSend, adminCreateClientFromQuote,
          adminListClients, adminSaveClient, adminListPayments, adminMarkPaid, adminListOnboarding, adminListTenants,
          adminRuntimeState, adminListRequests, adminSaveRequest, adminListEvents, adminLogEvent, adminGetNote, adminSaveNote, adminOutbox
   Supabase notes:
     - status changes are logged by the DB (log_status_change trigger -> public.events); the browser cannot insert events,
       so adminLogEvent is a no-op there (see docs/reports/A7.md, open item).
     - quote_sent / deposit_received / request_update e-mails: DB triggers of task A8 react to the status change.
     - adminRegenerateDraft calls the quote-draft Edge Function and quoteSend the quote-send Edge Function (task A6):
       quoteSend(id, {discount_code, pay_method, pay_link, manual_approved}) -> {quote_id, status, valid_until}; it re-prices,
       refuses anonymized / needs_manual_price, moves draft -> approved -> sent and emits the quote_sent e-mail event.
     - runtime_state is service-role only: adminRuntimeState returns [] unless an admin read path is added.
   B7 (Tenants tab): adminTenantUsage(month) = RPC admin_tenant_usage (security definer + is_admin(); usage/cost keys only),
     adminSaveTenant({id?, client_id, slug, status, twilio_number, config}) = RPC admin_save_tenant (admin only, logged). */
(function () {
  const C = window.SITE_CONFIG || {};
  const qs = new URLSearchParams(location.search);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del: k => { try { sessionStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  if (qs.get('mock') === '1' && (local || C.ALLOW_MOCK_SWITCH)) ss.set('start_force_mock', '1');
  if (qs.get('mock') === '0') ss.del('start_force_mock');

  let mode = 'off';
  if (C.BACKEND === 'mock' || ss.get('start_force_mock') === '1') mode = 'mock';
  else if (C.BACKEND === 'supabase' && C.SUPABASE_URL && C.SUPABASE_ANON_KEY) mode = 'supabase';

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Failed to fetch ' + src));
      document.head.appendChild(s);
    });
  }

  function supabaseAdapter(sb) {
    const wrap = s => s ? { user: { id: s.user.id, email: s.user.email || '' } } : null;
    const must = r => { if (r.error) throw r.error; return r.data; };
    const uid = async () => { const { data } = await sb.auth.getSession(); return data.session && data.session.user.id; };
    const QUOTE_EDITABLE = ['items', 'setup_cents', 'monthly_cents', 'deposit_cents', 'discount_code', 'scope_md', 'assumptions', 'timeline_text',
      'pay_method', 'pay_link', 'valid_until', 'status'];
    // Edge Function call; surfaces the function's {error: code} so the UI can map it to Hebrew
    async function fn(name, body) {
      const r = await sb.functions.invoke(name, { body });
      if (r.error) {
        let code = r.error.message;
        try { const j = await r.error.context.json(); if (j && j.error) code = j.error; } catch (e) { /* not JSON */ }
        const e = new Error(code); e.code = code; throw e;
      }
      return r.data;
    }
    const pick = (o, keys) => { const r = {}; keys.forEach(k => { if (k in o) r[k] = o[k]; }); return r; };
    return {
      mode: 'supabase',
      async getSession() { const { data } = await sb.auth.getSession(); return wrap(data.session); },
      async consumeLink() {
        const s = await this.getSession();
        if (/[?&#](code|access_token|error|token_hash)=/.test(location.href)) history.replaceState(null, '', location.pathname);
        return s;
      },
      async sendCode(email) { must(await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + '/start/admin/' } })); },
      async verifyCode(email, code) { return wrap(must(await sb.auth.verifyOtp({ email, token: code, type: 'email' })).session); },
      async signOut() { try { await sb.auth.signOut(); } catch (e) { /* already signed out */ } },

      async adminWhoami() {
        const id = await uid(); if (!id) throw new Error('not_authenticated');
        const p = must(await sb.from('profiles').select('id,email,is_admin').eq('id', id).maybeSingle());
        return { user: { id, email: (p && p.email) || '' }, is_admin: !!(p && p.is_admin) };
      },
      async adminListLeads() { return must(await sb.from('leads').select('id,email,niche,source_page,utm,created_at').order('created_at', { ascending: false }).limit(500)); },
      async adminListProfiles() { return must(await sb.from('profiles').select('*').limit(2000)); },
      async adminListQuestionnaires() { return must(await sb.from('questionnaires').select('*').order('updated_at', { ascending: false }).limit(500)); },
      async adminListAttachments(qid) { return must(await sb.from('attachments').select('*').eq('questionnaire_id', qid).order('created_at')); },
      async downloadUrl(att) { return must(await sb.storage.from(C.BUCKET).createSignedUrl(att.storage_path, 300, { download: att.filename })).signedUrl; },
      async adminListQuotes() { return must(await sb.from('quotes').select('*').order('updated_at', { ascending: false }).limit(500)); },
      async adminGetQuoteReview(id) { return must(await sb.from('quote_reviews').select('*').eq('quote_id', id).maybeSingle()); },
      async adminRegenerateDraft(qid) { return fn('quote-draft', { questionnaire_id: qid, regenerate: true }); },
      async adminSaveQuote(id, patch) { return must(await sb.from('quotes').update(pick(patch, QUOTE_EDITABLE)).eq('id', id).select('*').single()); },
      async quoteSend(id, opts) { return fn('quote-send', Object.assign({ quote_id: id }, opts || {})); },
      async adminCreateClientFromQuote(quoteId) {
        const q = must(await sb.from('quotes').select('*').eq('id', quoteId).single());
        if (q.status !== 'accepted') throw new Error('quote_not_accepted');
        const ex = must(await sb.from('clients').select('*').eq('quote_id', quoteId).maybeSingle());
        if (ex) return ex;
        const core = (q.items || []).map(i => i.code).find(c => ['RCP', 'WEB', 'BNDL'].indexOf(c) !== -1) || 'RCP';
        const c = must(await sb.from('clients').insert({ user_id: q.user_id, quote_id: q.id, products: [core], status: 'onboarding', monthly_cents: q.monthly_cents }).select('*').single());
        must(await sb.from('payments').insert([
          { client_id: c.id, kind: 'deposit', amount_cents: q.deposit_cents || 0, method: q.pay_method, status: 'due' },
          { client_id: c.id, kind: 'final', amount_cents: (q.setup_cents || 0) - (q.deposit_cents || 0), method: q.pay_method, status: 'due' }]));
        return c;
      },
      async adminListClients() { return must(await sb.from('clients').select('*').order('created_at', { ascending: false })); },
      async adminSaveClient(id, patch) { return must(await sb.from('clients').update(pick(patch, ['status'])).eq('id', id).select('*').single()); },
      async adminListPayments() { return must(await sb.from('payments').select('*').order('created_at', { ascending: false })); },
      async adminMarkPaid(paymentId, reference) {
        return must(await sb.from('payments').update({ status: 'paid', reference: reference || null }).eq('id', paymentId).select('*').single());
      },
      async adminListOnboarding() { return must(await sb.from('onboarding_items').select('*').order('sort')); },
      async adminListTenants() { return must(await sb.from('tenants').select('*')); },
      async adminRuntimeState() { return []; },
      async adminListRequests() { return must(await sb.from('requests').select('*').order('position')); },
      async adminSaveRequest(id, patch) { return must(await sb.from('requests').update(pick(patch, ['status', 'admin_reply'])).eq('id', id).select('*').single()); },
      async adminListEvents(limit) { return must(await sb.from('events').select('*').order('created_at', { ascending: false }).limit(limit || 300)); },
      async adminLogEvent() { return { ok: true, via: 'db-trigger' }; },
      async adminGetNote(entity, id) {
        const r = must(await sb.from('admin_notes').select('body').eq('entity', entity).eq('entity_id', id).maybeSingle());
        return (r && r.body) || '';
      },
      async adminSaveNote(entity, id, body) { return must(await sb.from('admin_notes').upsert({ entity, entity_id: id, body }).select('*').single()); },
      async adminOutbox() { return []; },
      async adminTenantUsage(month) { return must(await sb.rpc('admin_tenant_usage', { p_month: month || null })); },
      async adminSaveTenant(row) {
        return must(await sb.rpc('admin_save_tenant', { p_id: row.id || null, p_client_id: row.client_id, p_slug: row.slug, p_status: row.status || 'sandbox',
          p_twilio_number: row.twilio_number || null, p_config: row.config }));
      }
    };
  }

  let impl = null;
  const readyP = (async () => {
    if (mode === 'mock') {
      if (!window.StartMock) throw new Error('mock backend not loaded');
      impl = window.StartMock.create(C);
    } else if (mode === 'supabase') {
      if (!(window.supabase && window.supabase.createClient)) await loadScript(C.SUPABASE_JS);
      impl = supabaseAdapter(window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
        auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      }));
    }
    return impl;
  })();

  const api = { mode, ready: () => readyP };
  ['getSession', 'consumeLink', 'sendCode', 'verifyCode', 'signOut', 'adminWhoami', 'adminListLeads', 'adminListProfiles',
    'adminListQuestionnaires', 'adminListAttachments', 'downloadUrl', 'adminListQuotes', 'adminRegenerateDraft', 'adminSaveQuote',
    'quoteSend', 'adminGetQuoteReview', 'adminCreateClientFromQuote', 'adminListClients', 'adminSaveClient', 'adminListPayments', 'adminMarkPaid',
    'adminListOnboarding', 'adminListTenants', 'adminRuntimeState', 'adminListRequests', 'adminSaveRequest', 'adminListEvents',
    'adminLogEvent', 'adminGetNote', 'adminSaveNote', 'adminOutbox', 'adminTenantUsage', 'adminSaveTenant'].forEach(fn => {
    api[fn] = async (...args) => { await readyP; if (!impl) throw new Error('backend_off'); return impl[fn](...args); };
  });
  window.AdminBackend = api;
})();
