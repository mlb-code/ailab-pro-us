/* Client portal data layer. ONE API surface, two adapters:
     mock     -> site/start/assets/mock/mock-backend.js (localStorage, RLS-style ownership checks, guard errors)
     supabase -> supabase-js against the ailab-us project (tables per docs/SPEC.md §4, RLS from supabase/migrations)
   Pages call only window.Backend.* (never supabase-js directly), so switching = SITE_CONFIG.BACKEND (/assets/config.js).

   API (all async unless noted):
     ready()                                   -> resolves when the adapter is usable
     mode (sync)                               -> 'mock' | 'supabase' | 'off'
     googleEnabled / appleEnabled (sync)       -> bool (config.js GOOGLE_ENABLED / APPLE_ENABLED)
     providers (sync)                          -> ['google','apple'] in button order (StartSignin.enabledProviders)
     getSession()                              -> {user:{id,email}} | null
     consumeLink()                             -> session | null   (magic-link return; strips URL params)
     sendCode(email)                           -> void             (one email: magic link + 6-digit code)
     verifyCode(email, code)                   -> session
     signInWithGoogle() / signInWithApple()    -> void (redirects; PKCE; return URL from StartSignin.redirectTarget allow-list)
     signOut()
     getProfile() / saveProfile(patch)         -> profile row
     listQuestionnaires()                      -> rows (own only)
     createQuestionnaire({offer, niche})       -> {id}
     getQuestionnaire(id)                      -> row | null (null = not found OR not yours)
     saveQuestionnaire(id, {offer,niche,answers,summary}) -> {updated_at,status} | null (null = locked)
     submitQuestionnaire(id)                   -> row (status 'submitted')
     deleteQuestionnaire(id)                   (drafts only)
     listAttachments(qid) / uploadAttachment(qid, file) / removeAttachment(att) / downloadUrl(att)
     listQuotes() / getClient() / listPayments()
     payCreate(token, which) / payCapture(token, which, orderId)   card / PayPal checkout (Edge Functions pay-create / pay-capture)
     notify(type, payload)                     -> event stub (see below)
   Phase B (task B7; SQL in supabase/migrations/*_us_portal_b7.sql):
     listOnboarding() / updateOnboarding(id, status, data)       update_onboarding_item RPC (todo|done|need_help + data merge)
     startForwardingTest(itemId)               -> {number, started_at, window_minutes}  (start_forwarding_test RPC)
     calendarConnectUrl(tenantId, provider)    -> {url}  (Edge Function calendar-connect -> runtime /oauth/<p>/ticket; A8/B9)
     getTenant() / updateTenantSettings(tenantId, patch)          update_tenant_settings RPC (whitelist hours/faq/notify/paused)
     listCalls(tenantId) / listSms(tenantId) / listBookings(tenantId) / getUsage(tenantId, month)   (client_tenant_usage RPC)
     listRequests() / createRequest({title, body}) / saveRequest(id, {title, body, position, paused}) / cancelRequest(id)
     listRequestAttachments(rid) / uploadRequestAttachment(rid, file, safeName, mime) / removeRequestAttachment(att)
   Appointment manager (SQL in supabase/migrations/*_us_appointments.sql):
     getResults(tenantId, month) -> Results panel numbers (client_results RPC)
     markNoShow(bookingId, noShow) -> {id, status} (client_mark_no_show RPC: started visits only, undo allowed)
     setAvgJobValue(tenantId, usd|null) -> {avg_job_value_usd} (client_set_avg_job_value RPC)
   Error messages carry the same codes the DB guards raise (questionnaire_locked, offer_required, too_many_files, ...). */
(function () {
  const C = window.SITE_CONFIG || {};   // /assets/config.js (written by tools/us_setup.py, task A2)
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

  // ------------------------------------------------------------------ supabase adapter
  function supabaseAdapter(sb) {
    const RANGE = 'id,offer,niche,status,created_at,updated_at,submitted_at';
    const wrap = s => s ? { user: { id: s.user.id, email: s.user.email || '' } } : null;
    const uid = async () => { const { data } = await sb.auth.getSession(); return data.session && data.session.user.id; };
    const must = r => { if (r.error) throw r.error; return r.data; };
    // Edge Function call that surfaces the function's {error: code}
    async function invoke(name, body) {
      const r = await sb.functions.invoke(name, { body });
      if (r.error) { let code = r.error.message; try { const j = await r.error.context.json(); if (j && j.error) code = j.error; } catch (e) { /* not JSON */ } throw new Error(code); }
      return r.data;
    }
    const SI = window.StartSignin;
    // Return URL after the provider: only the configured site or local dev (never a third-party origin). PKCE: the
    // browser comes back with ?code=… which supabase-js exchanges itself; no access token ever appears in the URL.
    const returnTo = () => SI.redirectTarget(location.origin, (window.Start && window.Start.BRAND && window.Start.BRAND.site_url) || '', '/start/');
    async function oauth(provider) {
      must(await sb.auth.signInWithOAuth({ provider, options: { redirectTo: returnTo(), scopes: provider === 'google' ? 'openid email profile' : undefined } }));
    }
    return {
      mode: 'supabase',
      googleEnabled: C.GOOGLE_ENABLED === true,
      appleEnabled: C.APPLE_ENABLED === true,
      providers: SI.enabledProviders(C),
      async getSession() { const { data } = await sb.auth.getSession(); return wrap(data.session); },
      async consumeLink() {
        // detectSessionInUrl (PKCE) already exchanged ?code=; just clean the URL (home.js reads a provider error first).
        const s = await this.getSession();
        if (SI.urlHasTokens(location.href)) history.replaceState(null, '', location.pathname);
        return s;
      },
      async sendCode(email) {
        must(await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + '/start/' } }));
      },
      async verifyCode(email, code) {
        const d = must(await sb.auth.verifyOtp({ email, token: code, type: 'email' }));
        return wrap(d.session);
      },
      async signInWithGoogle() { await oauth('google'); },
      async signInWithApple() { await oauth('apple'); },
      async signOut() { try { await sb.auth.signOut(); } catch (e) { /* already signed out */ } },
      async getProfile() { return must(await sb.from('profiles').select('*').eq('id', await uid()).maybeSingle()); },
      async saveProfile(patch) { return must(await sb.from('profiles').update(patch).eq('id', await uid()).select().single()); },
      async listQuestionnaires() {
        return must(await sb.from('questionnaires').select(RANGE).eq('user_id', await uid()).order('updated_at', { ascending: false }));
      },
      async createQuestionnaire(init) {
        return must(await sb.from('questionnaires').insert({ offer: init.offer || null, niche: init.niche || null }).select('id').single());
      },
      async getQuestionnaire(id) { return must(await sb.from('questionnaires').select('*').eq('id', id).maybeSingle()); },
      async saveQuestionnaire(id, patch) {
        return must(await sb.from('questionnaires').update(patch).eq('id', id).select('updated_at,status').maybeSingle());
      },
      async submitQuestionnaire(id) {
        return must(await sb.from('questionnaires').update({ status: 'submitted' }).eq('id', id).select('*').single());
      },
      async deleteQuestionnaire(id) {
        const files = must(await sb.from('attachments').select('storage_path').eq('questionnaire_id', id)) || [];
        if (files.length) await sb.storage.from(C.BUCKET).remove(files.map(f => f.storage_path));
        must(await sb.from('questionnaires').delete().eq('id', id));
      },
      async listAttachments(qid) { return must(await sb.from('attachments').select('*').eq('questionnaire_id', qid).order('created_at')); },
      async uploadAttachment(qid, file, safeName, mime) {
        const rand = Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, '') || 'f00000';
        const path = (await uid()) + '/' + qid + '/' + rand.padEnd(6, '0') + '-' + safeName;
        must(await sb.storage.from(C.BUCKET).upload(path, file, { contentType: mime, upsert: false, cacheControl: '3600' }));
        const r = await sb.from('attachments').insert({ questionnaire_id: qid, storage_path: path, filename: file.name.slice(0, 255), size: file.size, mime_type: mime }).select().single();
        if (r.error) { await sb.storage.from(C.BUCKET).remove([path]); throw r.error; }
        return r.data;
      },
      async removeAttachment(att) {
        must(await sb.from('attachments').delete().eq('id', att.id));
        await sb.storage.from(C.BUCKET).remove([att.storage_path]);
      },
      async downloadUrl(att) {
        return must(await sb.storage.from(C.BUCKET).createSignedUrl(att.storage_path, 300, { download: att.filename })).signedUrl;
      },
      async listQuotes() {
        return must(await sb.from('quotes').select('id,questionnaire_id,status,items,setup_cents,monthly_cents,deposit_cents,valid_until,public_token,pay_method,pay_link,sent_at,viewed_at,accepted_at')
          .order('sent_at', { ascending: false }));
      },
      async getClient() {
        return must(await sb.from('clients').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle());
      },
      async listPayments() { return must(await sb.from('payments').select('*').order('created_at', { ascending: false })); },
      // card / PayPal checkout (Edge Functions pay-create / pay-capture; the quote token is the key, the amount comes from the DB)
      async payCreate(token, which) { return invoke('pay-create', { t: token, which }); },
      async payCapture(token, which, orderId) { return invoke('pay-capture', { t: token, which, order_id: orderId }); },
      // ---------------------------------------------------------- phase B (B7)
      async listOnboarding() { return must(await sb.from('onboarding_items').select('*').order('sort')); },
      async updateOnboarding(id, status, data) {
        return must(await sb.rpc('update_onboarding_item', { p_id: id, p_status: status, p_data: data || null }));
      },
      async startForwardingTest(id) { return must(await sb.rpc('start_forwarding_test', { p_item: id })); },
      async calendarConnectUrl(tenantId, provider) {
        const r = await sb.functions.invoke('calendar-connect', { body: { tenant_id: tenantId, provider } });
        if (r.error) { let code = r.error.message; try { const j = await r.error.context.json(); if (j && j.error) code = j.error; } catch (e) { /* not JSON */ } throw new Error(code); }
        return r.data;
      },
      async getTenant() {
        return must(await sb.from('tenants').select('id,client_id,slug,status,twilio_number,config').order('created_at', { ascending: false }).limit(1).maybeSingle());
      },
      async updateTenantSettings(tenantId, patch) { return must(await sb.rpc('update_tenant_settings', { p_tenant_id: tenantId, p_patch: patch })); },
      async listCalls(tenantId, limit) {
        return must(await sb.from('calls').select('id,call_sid,from_e164,started_at,duration_s,outcome,transcript,summary').eq('tenant_id', tenantId).order('started_at', { ascending: false }).limit(limit || 50));
      },
      async listSms(tenantId, limit) {
        return must(await sb.from('sms_messages').select('id,contact_e164,direction,body,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit || 200));
      },
      async listBookings(tenantId, limit) {
        return must(await sb.from('bookings').select('id,customer_name,contact_e164,address,job_type,urgency,start_at,end_at,status,created_at,confirmed_at,rescheduled_from_id').eq('tenant_id', tenantId).order('start_at', { ascending: false }).limit(limit || 50));
      },
      async getUsage(tenantId, month) { return must(await sb.rpc('client_tenant_usage', { p_tenant_id: tenantId, p_month: month || null })); },
      // appointment manager (migration *_us_appointments.sql)
      async getResults(tenantId, month) { return must(await sb.rpc('client_results', { p_tenant_id: tenantId, p_month: month || null })); },
      async markNoShow(bookingId, noShow) { return must(await sb.rpc('client_mark_no_show', { p_booking_id: bookingId, p_no_show: noShow !== false })); },
      async setAvgJobValue(tenantId, value) { return must(await sb.rpc('client_set_avg_job_value', { p_tenant_id: tenantId, p_value: value })); },
      async listRequests() { return must(await sb.from('requests').select('*').order('position')); },
      async createRequest(row) {
        const c = must(await sb.from('clients').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle());
        if (!c) throw new Error('no_client');
        return must(await sb.from('requests').insert({ client_id: c.id, title: row.title, body: row.body || '' }).select('*').single());
      },
      async saveRequest(id, patch) {
        const p = {}; ['title', 'body', 'position', 'paused'].forEach(k => { if (k in patch) p[k] = patch[k]; });
        return must(await sb.from('requests').update(p).eq('id', id).select('*').maybeSingle());
      },
      async cancelRequest(id) {
        const files = must(await sb.from('attachments').select('storage_path').eq('request_id', id)) || [];
        const r = await sb.from('requests').delete().eq('id', id).select('id');
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) throw new Error('request_locked');
        if (files.length) await sb.storage.from(C.BUCKET).remove(files.map(f => f.storage_path));
        return null;
      },
      async listRequestAttachments(rid) { return must(await sb.from('attachments').select('*').eq('request_id', rid).order('created_at')); },
      async uploadRequestAttachment(rid, file, safeName, mime) {
        const rand = Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, '') || 'f00000';
        const path = (await uid()) + '/' + rid + '/' + rand.padEnd(6, '0') + '-' + safeName;
        must(await sb.storage.from(C.BUCKET).upload(path, file, { contentType: mime, upsert: false, cacheControl: '3600' }));
        const r = await sb.from('attachments').insert({ request_id: rid, storage_path: path, filename: file.name.slice(0, 255), size: file.size, mime_type: mime }).select().single();
        if (r.error) { await sb.storage.from(C.BUCKET).remove([path]); throw r.error; }
        return r.data;
      },
      async removeRequestAttachment(att) {
        must(await sb.from('attachments').delete().eq('id', att.id));
        await sb.storage.from(C.BUCKET).remove([att.storage_path]);
      },
      // Event stub. With Supabase the DB writes the event itself (questionnaires_log trigger -> public.events) and
      // task A8 turns 'submitted' into the q_received (client) + owner e-mails. Nothing to send from the browser.
      // For offer WEB the same 'submitted' trigger fires; A8 must send the owner web_deposit_link_requested (not q_received).
      async notify(type, payload) { return { ok: true, via: 'db-trigger', type, payload }; }
    };
  }

  // ------------------------------------------------------------------ boot
  let impl = null;
  const readyP = (async () => {
    if (mode === 'mock') {
      if (!window.StartMock) throw new Error('mock backend not loaded');
      impl = window.StartMock.create(C);
    } else if (mode === 'supabase') {
      if (!(window.supabase && window.supabase.createClient)) await loadScript(C.SUPABASE_JS);
      const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
        auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      impl = supabaseAdapter(sb);
    }
    return impl;
  })();

  const api = { mode, get googleEnabled() { return !!(impl && impl.googleEnabled); }, get appleEnabled() { return !!(impl && impl.appleEnabled); },
    get providers() { return (impl && impl.providers) || []; }, ready: () => readyP };
  ['getSession', 'consumeLink', 'sendCode', 'verifyCode', 'signInWithGoogle', 'signInWithApple', 'signOut', 'getProfile', 'saveProfile',
    'listQuestionnaires', 'createQuestionnaire', 'getQuestionnaire', 'saveQuestionnaire', 'submitQuestionnaire',
    'deleteQuestionnaire', 'listAttachments', 'uploadAttachment', 'removeAttachment', 'downloadUrl', 'listQuotes',
    'getClient', 'listPayments', 'notify', 'payCreate', 'payCapture',
    // phase B (B7)
    'listOnboarding', 'updateOnboarding', 'startForwardingTest', 'calendarConnectUrl', 'getTenant', 'updateTenantSettings',
    'listCalls', 'listSms', 'listBookings', 'getUsage', 'listRequests', 'createRequest', 'saveRequest', 'cancelRequest',
    'listRequestAttachments', 'uploadRequestAttachment', 'removeRequestAttachment',
    // appointment manager
    'getResults', 'markNoShow', 'setAvgJobValue'].forEach(fn => {
    api[fn] = async (...args) => { await readyP; if (!impl) throw new Error('backend_off'); return impl[fn](...args); };
  });
  window.Backend = api;
})();
