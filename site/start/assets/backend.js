/* Client portal data layer. ONE API surface, two adapters:
     mock     -> site/start/assets/mock/mock-backend.js (localStorage, RLS-style ownership checks, guard errors)
     supabase -> supabase-js against the ailab-us project (tables per docs/SPEC.md §4, RLS from supabase/migrations)
   Pages call only window.Backend.* (never supabase-js directly), so switching = SITE_CONFIG.BACKEND (/assets/config.js).

   API (all async unless noted):
     ready()                                   -> resolves when the adapter is usable
     mode (sync)                               -> 'mock' | 'supabase' | 'off'
     googleEnabled (sync)                      -> bool
     getSession()                              -> {user:{id,email}} | null
     consumeLink()                             -> session | null   (magic-link return; strips URL params)
     sendCode(email)                           -> void             (one email: magic link + 6-digit code)
     verifyCode(email, code)                   -> session
     signInWithGoogle()                        -> void (redirects)
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
     notify(type, payload)                     -> event stub (see below)
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
    return {
      mode: 'supabase',
      googleEnabled: !!C.GOOGLE_ENABLED,
      async getSession() { const { data } = await sb.auth.getSession(); return wrap(data.session); },
      async consumeLink() {
        // detectSessionInUrl (PKCE) already exchanged ?code=; just clean the URL.
        const s = await this.getSession();
        if (/[?&#](code|access_token|error|token_hash)=/.test(location.href)) history.replaceState(null, '', location.pathname);
        return s;
      },
      async sendCode(email) {
        must(await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + '/start/' } }));
      },
      async verifyCode(email, code) {
        const d = must(await sb.auth.verifyOtp({ email, token: code, type: 'email' }));
        return wrap(d.session);
      },
      async signInWithGoogle() {
        must(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/start/' } }));
      },
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
      // Event stub. With Supabase the DB writes the event itself (questionnaires_log trigger -> public.events) and
      // task A8 turns 'submitted' into the q_received (client) + owner e-mails. Nothing to send from the browser.
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

  const api = { mode, get googleEnabled() { return !!(impl && impl.googleEnabled); }, ready: () => readyP };
  ['getSession', 'consumeLink', 'sendCode', 'verifyCode', 'signInWithGoogle', 'signOut', 'getProfile', 'saveProfile',
    'listQuestionnaires', 'createQuestionnaire', 'getQuestionnaire', 'saveQuestionnaire', 'submitQuestionnaire',
    'deleteQuestionnaire', 'listAttachments', 'uploadAttachment', 'removeAttachment', 'downloadUrl', 'listQuotes',
    'getClient', 'listPayments', 'notify'].forEach(fn => {
    api[fn] = async (...args) => { await readyP; if (!impl) throw new Error('backend_off'); return impl[fn](...args); };
  });
  window.Backend = api;
})();
