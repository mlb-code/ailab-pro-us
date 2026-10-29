/* /start/ — sign in (Continue with Google / Sign in with Apple when configured in config.js, then email magic link + 6-digit
   code), profile, portal (Home / Quotes / Billing). Social sign-in rules live in signin.js (StartSignin).
   Phase B tabs (Setup checklist, My receptionist, Requests) and the Billing usage card come from portal-b.js (task B7),
   shown only once the signed-in user has a client record. */
(function () {
  const S = window.Start, B = window.Backend, Q = window.StartQ, SI = window.StartSignin;
  const app = S.$('#app');
  let session = null, profile = null;

  const focusMain = () => { window.scrollTo(0, 0); app.focus({ preventScroll: true }); };
  const setMsg = (el, text, kind) => { el.innerHTML = S.msgHtml(text, kind); };
  // Apple logo (Sign in with Apple HIG: left-aligned glyph, white on black) and Google "G" (Sign in with Google branding guidelines)
  const APPLE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>';
  const GOOGLE_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true" width="18" height="18"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

  // intent from the landing pages: /start/?offer=WEB&niche=home_services
  (function keepIntent() {
    const p = new URLSearchParams(location.search);
    const offer = (p.get('offer') || '').toUpperCase(), niche = p.get('niche') || '';
    if (['RCP', 'WEB', 'BNDL', 'UNSURE'].indexOf(offer) !== -1 || niche) S.ss.set('start_intent', JSON.stringify({ offer: offer || null, niche: niche || null }));
  })();

  // ------------------------------------------------------------ sign in
  function showLogin(errText) {
    S.renderHeader(null);
    const providers = B.providers;
    const social = providers.length ? providers.map(p =>
      '<button type="button" class="btn btn--block sbtn sbtn--' + p + '" id="' + p + 'Btn" data-provider="' + p + '">' +
      (p === 'apple' ? APPLE_SVG : GOOGLE_SVG) + '<span>' + S.esc(SI.providerLabel(p)) + '</span></button>').join('') +
      '<p class="muted small center trust" id="trustLine">Secure sign-in. We never see or store your password. ' +
      '<a href="/legal/privacy/">Privacy</a> · <a href="/legal/terms/">Terms</a></p>' +
      '<div class="or">or with your email</div>' : '';
    app.innerHTML =
      '<span class="eyebrow">Fixed quote · no sales call</span>' +
      '<h1 class="t">Get your written fixed quote.</h1>' +
      '<p class="lead">Sign in' + (providers.length ? ' with ' + providers.map(SI.providerName).join(' or ') + ', or' : '') + ' with your email, and answer a short questionnaire (about 3 minutes, 3 screens). You’ll get a written fixed quote ' + S.esc(S.sla()) + '. No password, no phone call.</p>' +
      '<div class="card login">' + social +
      '<form id="emailForm" novalidate><div class="field"><label for="email">Email address</label>' +
      '<input class="input" type="email" id="email" name="email" autocomplete="email" inputmode="email" placeholder="you@yourbusiness.com" required></div>' +
      '<button class="btn btn--primary btn--block" type="submit" id="sendBtn">Email me a sign-in link</button></form>' +
      '<form id="codeForm" novalidate hidden><p id="codeSent"></p>' +
      '<div class="field"><label for="code">Or type the 6-digit code from the email</label>' +
      '<input class="input code" type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required></div>' +
      '<button class="btn btn--primary btn--block" type="submit" id="verifyBtn">Sign in</button>' +
      '<div class="row linkrow"><button type="button" class="linkbtn" id="resendBtn">Send a new code</button><span class="spacer"></span>' +
      '<button type="button" class="linkbtn" id="changeEmail">Use a different email</button></div>' +
      '<p class="muted small">Don’t see it? Check your spam or promotions folder. You can click the link or type the code. The code helps if the link opens in a different browser.</p></form>' +
      '<div id="mockInbox"></div><div id="loginMsg"></div></div>' +
      '<p class="muted small fine">We use your answers only to prepare your quote. You can ask us to delete them at any time. See our <a href="/legal/privacy/">Privacy Policy</a>.</p>';

    const loginMsg = S.$('#loginMsg'), emailForm = S.$('#emailForm'), codeForm = S.$('#codeForm'), emailIn = S.$('#email'), codeIn = S.$('#code');
    if (errText) setMsg(loginMsg, errText.kind ? errText.text : 'Sign-in didn’t finish: ' + errText);
    S.$$('.sbtn').forEach(btn => btn.addEventListener('click', async e => {
      const p = e.currentTarget.getAttribute('data-provider'), b = e.currentTarget;
      b.disabled = true; setMsg(loginMsg, '');
      try { S.ss.set('start_login', p); await (p === 'apple' ? B.signInWithApple() : B.signInWithGoogle()); }
      catch (err) { b.disabled = false; setMsg(loginMsg, SI.oauthErrorText({ error: 'server_error', description: String(err && (err.message || err.code) || '') }, p).text); }
    }));

    let timer = null;
    function cooldown() {
      let n = 60; const rb = S.$('#resendBtn'); rb.disabled = true;
      clearInterval(timer);
      timer = setInterval(() => {
        n--; rb.textContent = n > 0 ? 'Send a new code (' + n + ')' : 'Send a new code';
        if (n <= 0) { clearInterval(timer); rb.disabled = false; }
      }, 1000);
    }
    function showMockInbox(email) {
      const box = S.$('#mockInbox');
      if (B.mode !== 'mock' || !window.StartMock) { box.innerHTML = ''; return; }
      const m = window.StartMock.admin.inbox(email).filter(x => x.template === 'auth_code').pop();
      box.innerHTML = m ? '<div class="notice mockmail" role="note"><div><b>Demo inbox</b> (no real e-mail in demo mode)<br>' +
        'Code: <span class="mono" id="mockCode">' + S.esc(m.code) + '</span> · <a href="' + S.esc(m.link) + '" id="mockLink">Open the sign-in link</a></div></div>' : '';
    }
    function showCode(email) {
      emailForm.hidden = true; codeForm.hidden = false;
      S.$('#codeSent').innerHTML = 'We sent a sign-in link and a 6-digit code to <b>' + S.esc(email) + '</b>.';
      codeIn.value = ''; codeIn.focus();
      showMockInbox(email);
    }
    async function send(email) { await B.sendCode(email); S.ss.set('start_otp_email', email); cooldown(); }

    emailForm.addEventListener('submit', async e => {
      e.preventDefault(); setMsg(loginMsg, '');
      const email = emailIn.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setMsg(loginMsg, 'That email address doesn’t look right.'); emailIn.focus(); return; }
      const btn = S.$('#sendBtn'); btn.disabled = true; btn.textContent = 'Sending…';
      try { await send(email); showCode(email); }
      catch (err) { setMsg(loginMsg, S.errText(err)); }
      finally { btn.disabled = false; btn.textContent = 'Email me a sign-in link'; }
    });
    codeIn.addEventListener('input', () => {
      codeIn.value = codeIn.value.replace(/\D/g, '').slice(0, 6);
      if (codeIn.value.length === 6) codeForm.requestSubmit ? codeForm.requestSubmit() : codeForm.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    codeForm.addEventListener('submit', async e => {
      e.preventDefault(); setMsg(loginMsg, '');
      const email = S.ss.get('start_otp_email'), token = codeIn.value.trim();
      if (!/^\d{6}$/.test(token)) { setMsg(loginMsg, 'The code has 6 digits.'); return; }
      const btn = S.$('#verifyBtn'); if (btn.disabled) return;
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const s = await B.verifyCode(email, token);
        S.ss.del('start_otp_email'); S.ss.set('start_login', 'email');
        await enter(s);
      } catch (err) { setMsg(loginMsg, S.errText(err)); btn.disabled = false; btn.textContent = 'Sign in'; codeIn.select(); }
    });
    S.$('#resendBtn').addEventListener('click', async () => {
      setMsg(loginMsg, '');
      try { await send(S.ss.get('start_otp_email')); showMockInbox(S.ss.get('start_otp_email')); setMsg(loginMsg, 'We sent a new code.', 'ok'); }
      catch (err) { setMsg(loginMsg, S.errText(err)); }
    });
    S.$('#changeEmail').addEventListener('click', () => {
      S.ss.del('start_otp_email'); codeForm.hidden = true; emailForm.hidden = false; S.$('#mockInbox').innerHTML = ''; emailIn.focus();
    });
    const pending = S.ss.get('start_otp_email');
    if (pending) { emailIn.value = pending; showCode(pending); }
  }

  // ------------------------------------------------------------ after sign in
  const profileDone = p => !!(p && p.full_name && p.company && p.phone);
  async function enter(s) {
    session = s;
    const m = S.ss.get('start_login'); if (m) { S.track('login', { method: m }); S.ss.del('start_login'); }
    try { profile = await B.getProfile(); }
    catch (err) { app.innerHTML = S.msgHtml(S.errText(err)); return; }
    S.renderHeader(session, { email: SI.displayEmail(profile, session) });
    if (!profileDone(profile) || SI.needsContactEmail(profile)) { showProfile(true); return; }
    if (await followIntent()) return;
    showPortal();
  }

  // landing CTA → straight into a questionnaire (reuses an open draft)
  async function followIntent() {
    let intent = null; try { intent = JSON.parse(S.ss.get('start_intent') || 'null'); } catch (e) { /* ignore */ }
    if (!intent) return false;
    S.ss.del('start_intent');
    try {
      const list = await B.listQuestionnaires();
      const draft = list.find(q => q.status === 'draft');
      if (draft) { location.href = '/start/q/?id=' + draft.id; return true; }
      await startNew(intent);
      return true;
    } catch (err) { return false; }
  }
  async function startNew(init) {
    const niches = (S.PB._niches || []).map(n => n.key);
    const utm = (window.Measure && window.Measure.firstTouch()) || null;   // first-touch utm_* kept by /assets/measure.js
    const r = await B.createQuestionnaire({ offer: init && init.offer || null, niche: init && niches.indexOf(init.niche) !== -1 ? init.niche : null, utm });
    S.trackFunnel(['quote', 'start'], { offer: init && init.offer || '' });
    location.href = '/start/q/?id=' + r.id;
  }

  // ------------------------------------------------------------ profile
  function detectTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } }
  function profileField(f) {
    let v = profile[f.k];
    if (v == null || v === '') v = f.k === 'timezone' ? detectTz() : (f.def || '');
    const id = 'p_' + f.k;
    const req = f.req ? ' <span class="req">required</span>' : '';
    const hint = f.hint ? '<span class="hint" id="' + id + '_h">' + S.esc(f.hint) + '</span>' : '';
    const desc = f.hint ? ' aria-describedby="' + id + '_h"' : '';
    let input;
    if (f.type === 'select') {
      const opts = f.opts.slice();
      if (v && !opts.some(o => o.v === v)) opts.unshift({ v, l: v.replace(/_/g, ' ') });   // e.g. a detected non-US time zone
      input = '<select class="select" id="' + id + '" name="' + f.k + '"' + desc + (f.auto ? ' autocomplete="' + f.auto + '"' : '') + '><option value="">Choose…</option>' +
        opts.map(o => '<option value="' + S.esc(o.v) + '"' + (o.v === v ? ' selected' : '') + '>' + S.esc(o.l) + '</option>').join('') + '</select>';
    } else {
      input = '<input class="input" id="' + id + '" name="' + f.k + '" type="' + (f.type === 'url' ? 'text' : f.type) + '"' + desc +
        (f.auto ? ' autocomplete="' + f.auto + '"' : '') + (f.type === 'tel' ? ' inputmode="tel"' : '') + (f.type === 'url' ? ' inputmode="url"' : '') +
        (f.ph ? ' placeholder="' + S.esc(f.ph) + '"' : '') + (f.req ? ' required aria-required="true"' : '') + ' value="' + S.esc(v) + '" maxlength="200">';
    }
    return '<div class="field' + (f.half ? ' half' : '') + '"><label for="' + id + '">' + S.esc(f.label) + req + '</label>' + hint + input + '</div>';
  }
  // Apple "Hide My Email" (or any relay address): quotes and receipts go to an address the person recognises, so a contact
  // e-mail is asked for once, first. Records stay keyed to the auth user id; the relay address keeps working for sign-in.
  const profileFields = () => (SI.isRelayEmail(profile && profile.email) ? [Q.PROFILE_CONTACT] : []).concat(Q.PROFILE);
  function showProfile(first) {
    const relay = SI.needsContactEmail(profile);
    app.innerHTML = '<span class="eyebrow">' + (first ? 'Step 1 of 3 · About you' : 'Your details') + '</span>' +
      '<h1 class="t">' + (first ? 'Nice to meet you.' : 'Your details') + '</h1>' +
      '<p class="lead">' + (first ? 'About 3 minutes. Everything saves as you go.' : 'Update them any time.') + '</p>' +
      (relay ? '<div class="notice notice--info" role="status" id="relayNote">You signed in with Apple and chose to hide your email. Tell us where to send your quote and receipts; your Apple sign-in keeps working.</div>' : '') +
      '<form id="profileForm" class="card" novalidate><div class="pgrid">' + profileFields().map(profileField).join('') + '</div>' +
      '<div id="profileMsg"></div><div class="navbtns">' +
      (first ? '' : '<button type="button" class="btn btn--ghost" id="pCancel">Cancel</button>') +
      '<button type="submit" class="btn btn--primary" id="pSave">' + (first ? 'Continue →' : 'Save') + '</button></div></form>';
    focusMain();
    if (!first) S.$('#pCancel').addEventListener('click', () => showPortal());
    S.$('#profileForm').addEventListener('submit', async e => {
      e.preventDefault();
      const box = S.$('#profileMsg'); setMsg(box, '');
      S.$$('.field--error').forEach(x => x.classList.remove('field--error'));
      const row = {}, fields = profileFields();
      fields.forEach(f => { row[f.k] = (S.$('#p_' + f.k).value || '').trim() || null; });
      const missing = fields.filter(f => f.req && !row[f.k]);
      const bad = (k, text) => { const el = S.$('#p_' + k); el.closest('.field').classList.add('field--error'); el.setAttribute('aria-invalid', 'true'); setMsg(box, text); el.focus(); };
      if (missing.length) { bad(missing[0].k, 'Missing: ' + missing.map(f => f.label).join(', ') + '.'); return; }
      if ('contact_email' in row && row.contact_email) {
        row.contact_email = row.contact_email.toLowerCase();
        if (!SI.validEmail(row.contact_email)) { bad('contact_email', 'That email address doesn’t look right.'); return; }
        if (SI.isRelayEmail(row.contact_email)) { bad('contact_email', 'Please use an address you read, not the Apple relay address.'); return; }
      }
      const digits = (row.phone || '').replace(/\D/g, '');
      if (!/^\+?[0-9()\-\s.]{7,24}$/.test(row.phone) || digits.length < 10 || digits.length > 15) { bad('phone', 'That phone number doesn’t look right.'); return; }
      row.update_lang = profile.update_lang || 'en';   // not asked; the owner changes it in the admin
      if (!profile.timezone) { const tz = detectTz(); if (tz) row.timezone = tz; }   // detected silently; corrected in the checklist (Business hours)
      const btn = S.$('#pSave'); btn.disabled = true;
      try { profile = await B.saveProfile(row); }
      catch (err) { btn.disabled = false; setMsg(box, S.errText(err)); return; }
      S.renderHeader(session, { email: SI.displayEmail(profile, session) });
      S.toast('Saved');
      if (first && await followIntent()) return;
      showPortal();
    });
    if (first) { const f = profileFields().find(x => !S.$('#p_' + x.k).value); if (f && matchMedia('(pointer:fine)').matches) S.$('#p_' + f.k).focus(); }
  }

  // ------------------------------------------------------------ portal
  const STAGES = ['Questionnaire', 'Quote', 'Deposit', 'Setup checklist', 'Testing', 'Live'];
  const QSTATUS = { draft: 'Draft', submitted: 'Submitted', quoted: 'Quoted', closed: 'Closed' };
  const QUOTE_STATUS = { sent: 'Ready to review', viewed: 'Viewed', accepted: 'Accepted', expired: 'Expired', void: 'Withdrawn' };
  const depPct = () => (S.PB.rules && S.PB.rules.deposit_pct) || 50;
  const payKind = k => ({ deposit: 'Deposit (' + depPct() + '% of setup)', final: 'Final payment before go-live', monthly: 'Monthly fee', overage: 'Usage overage' })[k] || k;
  const PAY_STATUS = { due: 'Due', paid: 'Paid', refunded: 'Refunded' };
  const quoteUrl = q => '/quote/#t=' + encodeURIComponent(q.public_token || '');   // token in the fragment: never sent to servers/logs
  const offerName = (code, niche) => { const o = Q.offerOpts({ niche }).find(x => x.v === code); return o ? o.l : 'Questionnaire'; };

  function stageOf(d) {
    const live = d.quotes.find(q => q.status === 'accepted');
    const open = d.quotes.find(q => q.status === 'sent' || q.status === 'viewed');
    const dep = d.payments.find(p => p.kind === 'deposit');
    if (d.client && d.client.status === 'live') {
      const rcp = (d.client.products || []).some(p => p === 'RCP' || p === 'BNDL');
      return { i: 5, text: rcp ? 'You’re live. Calls you miss are answered for you.' : 'You’re live. Your website is online.', action: null };
    }
    const glr = (d.ob || []).find(o => o.data && o.data.go_live_requested_at);
    const fin = d.payments.find(p => p.kind === 'final' && p.status !== 'paid');
    // card / PayPal checkout for the final payment (portal-b.js finalPay: null = Upwork / a link from us, as before)
    const fp = d.client && glr && window.PortalB && window.PortalB.finalPay ? window.PortalB.finalPay(d) : null;
    if (fp && fp.state === 'paid') return { i: 4, text: 'Final payment received — thank you. Next, we set your go-live date and email you when it’s live.', action: null };
    if (fp && fp.state === 'pending') return { i: 4, text: 'PayPal is processing your final payment. We’ll email you as soon as it clears. No need to pay again.', action: null };
    if (d.client && glr && (fin || d.client.status === 'testing')) {
      const amt = fin ? ' (' + S.money(fin.amount_cents) + ')' : '';
      if (fp) return { i: 4, text: 'Go-live requested. Last step: pay the final ' + S.money(fp.amount) + ' by card or PayPal. It takes about a minute; you’re switched live once it’s paid.', action: { id: 'goBilling', label: 'Pay the final ' + S.money(fp.amount) } };
      return { i: 4, text: 'Go-live requested. Next step: Final payment' + amt + ' — we email your secure link ' + S.sla() + '; you’re switched live once it’s paid.', action: { id: 'goBilling', label: 'Final payment' + amt } };
    }
    if (d.client && d.client.status === 'testing') return { i: 4, text: 'Your setup is ready to test. Check your email for the test number.', action: null };
    if (dep && dep.status === 'paid') {
      const ob = d.ob || [], left = ob.filter(o => o.status !== 'done').length;
      if (ob.length) return { i: 3, text: 'Deposit received — thank you. Your setup checklist is ready: ' + (ob.length - left) + ' of ' + ob.length + ' steps done.', action: { id: 'goOnboarding', label: left ? 'Continue the setup checklist' : 'Review your setup' } };
      return { i: 3, text: 'Deposit received — thank you. Your setup checklist opens here shortly; we’ll email you when it’s ready.', action: null };
    }
    if (live) {
      return live.pay_link
        ? { i: 2, text: 'Quote accepted. Next: the deposit (' + S.money(live.deposit_cents) + ').', action: { href: live.pay_link, label: 'Pay deposit ' + S.money(live.deposit_cents), ext: true, pay: 'link' } }
        : { i: 2, text: 'Quote accepted. We’ll send your secure payment link ' + S.sla() + '.', action: { href: quoteUrl(live), label: 'View your quote' } };
    }
    if (open) return { i: 1, text: 'Your fixed quote is ready.', action: { href: quoteUrl(open), label: 'Review your quote' } };
    const sub = d.qs.find(q => q.status !== 'draft');
    if (sub && sub.offer === 'WEB') return { i: 2, text: 'Content received. Your deposit link is on its way — we email it ' + S.sla() + '. ' + S.webTimeline(), action: { href: '/start/q/?id=' + sub.id, label: 'View your answers' } };
    if (sub) return { i: 1, text: 'Questionnaire received. You’ll get a written fixed quote ' + S.sla() + '.', action: { href: '/start/q/?id=' + sub.id, label: 'View your answers' } };
    const draft = d.qs.find(q => q.status === 'draft');
    if (draft) return { i: 0, text: 'Your questionnaire is saved. Pick up where you left off.', action: { href: '/start/q/?id=' + draft.id, label: 'Continue the questionnaire' } };
    return { i: 0, text: 'About 3 minutes, saved as you go. You’ll get a written fixed quote ' + S.sla() + '.', action: { id: 'startQ', label: 'Start the questionnaire' } };
  }

  function homeHtml(d) {
    const st = stageOf(d);
    const steps = STAGES.map((s, i) => '<li class="' + (i < st.i ? 'is-done' : i === st.i ? 'is-current' : '') + '"' + (i === st.i ? ' aria-current="step"' : '') + '><span>' + s + '</span></li>').join('');
    const a = st.action;
    const btn = !a ? '' : a.id ? '<button type="button" class="btn btn--primary" id="' + a.id + '">' + S.esc(a.label) + '</button>'
      : '<a class="btn btn--primary" href="' + S.esc(a.href) + '"' + (a.ext ? ' target="_blank" rel="noopener"' : '') + (a.pay ? ' data-pay="' + S.esc(a.pay) + '"' : '') + ' id="nextAction">' + S.esc(a.label) + '</a>';
    let list = '';
    if (d.qs.length) {
      list = '<h2 class="h-sec">Your questionnaires</h2><ul class="qlist">' + d.qs.map(q => {
        const draft = q.status === 'draft';
        const when = draft ? 'Updated ' + S.fmtDate(q.updated_at, true) : 'Submitted ' + S.fmtDate(q.submitted_at || q.updated_at);
        return '<li class="qitem"><div class="tt"><h3>' + S.esc(q.offer ? offerName(q.offer, q.niche) : 'New questionnaire') + '</h3>' +
          '<div class="meta"><span class="pill pill--' + q.status + '">' + QSTATUS[q.status] + '</span> · ' + when + '</div></div>' +
          '<div class="acts">' + (draft ? '<button type="button" class="linkbtn" data-del="' + q.id + '">Delete</button>' : '') +
          '<a class="btn btn--sm ' + (draft ? 'btn--primary' : 'btn--ghost') + '" href="/start/q/?id=' + q.id + '">' + (draft ? 'Continue' : 'View') + '</a></div></li>';
      }).join('') + '</ul>' +
      (d.qs.some(q => q.status === 'draft') ? '' : '<p class="spaced"><button type="button" class="linkbtn" id="anotherQ">Start another questionnaire</button></p>');
    }
    const cal = S.BRAND.calendly_url ? '<p class="muted small spaced">Prefer a quick 15-min video call? <a href="' + S.esc(S.BRAND.calendly_url) + '" target="_blank" rel="noopener">Pick a time</a>.</p>' : '';
    return '<section class="card status"><h2 class="h-card">Where things stand</h2><ol class="stepper" aria-label="Progress">' + steps + '</ol>' +
      '<p class="status__text">' + S.esc(st.text) + '</p>' + (btn ? '<div class="btn-row">' + btn + '</div>' : '') + '</section>' +
      '<div id="homeMsg"></div>' + list + cal;
  }

  function quotesHtml(d) {
    if (!d.quotes.length) return '<div class="empty"><b>No quotes yet.</b> After you submit the questionnaire, your written fixed quote appears here ' + S.esc(S.sla()) + '.</div>';
    return '<ul class="qlist">' + d.quotes.map(q => '<li class="qitem"><div class="tt"><h3>' + S.money(q.setup_cents) + ' setup + ' + S.money(q.monthly_cents) + '/mo</h3>' +
      '<div class="meta"><span class="pill pill--' + q.status + '">' + (QUOTE_STATUS[q.status] || q.status) + '</span> · Sent ' + S.fmtDate(q.sent_at) +
      (q.valid_until && q.status !== 'accepted' ? ' · Valid until ' + S.fmtDate(q.valid_until) : '') + '</div>' +
      '<div class="meta">' + (q.items || []).map(i => S.esc(i.code) + (i.qty > 1 ? ' ×' + i.qty : '')).join(' · ') + '</div></div>' +
      '<div class="acts"><a class="btn btn--sm btn--primary" href="' + S.esc(quoteUrl(q)) + '">Open quote</a></div></li>').join('') + '</ul>';
  }

  function billingHtml(d) {
    let h = '';
    if (d.client && d.client.monthly_cents) {
      h += '<div class="card"><h2 class="h-card">Monthly plan</h2><p>' + S.money(d.client.monthly_cents) + '/mo' +
        (d.client.next_bill_on ? ' · next bill ' + S.fmtDate(d.client.next_bill_on + 'T12:00:00Z') : ' · starts on your go-live date') + '</p></div>';
    }
    if (window.PortalB) h = window.PortalB.usageHtml(d) + h;
    // the final payment by card / PayPal, once go-live was requested (or the client is already live with it still due)
    const fp = d.client && window.PortalB && window.PortalB.finalPay ? window.PortalB.finalPay(d) : null;
    const glr = (d.ob || []).some(o => o.data && o.data.go_live_requested_at);
    if (fp && (fp.state === 'due' || fp.state === 'pending') && (glr || d.client.status === 'live')) {
      h = '<section class="card ppay-card" aria-label="Final payment">' + window.PortalB.finalPayHtml(fp, 'billing') + '</section>' + h;
    }
    if (!d.payments.length) return h + '<div class="empty"><b>No payments yet.</b> Payments you make (deposit, final payment, monthly fees) are listed here.</div>';
    return h + '<div class="table-wrap"><table class="table"><caption class="sr-only">Payments</caption><thead><tr><th scope="col">Payment</th><th scope="col" class="num">Amount</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead><tbody>' +
      d.payments.map(p => '<tr><td>' + S.esc(payKind(p.kind)) + '</td><td class="num">' + S.money(p.amount_cents) + '</td><td>' +
        S.esc(p.status === 'due' && p.provider_capture_id ? 'Processing' : PAY_STATUS[p.status] || p.status) +
        '</td><td>' + S.fmtDate(p.paid_at || p.created_at) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  const BASE_TABS = [['home', 'Home', homeHtml], ['quotes', 'Quotes', quotesHtml], ['billing', 'Billing', billingHtml]];
  let TABS = BASE_TABS;
  const withPhaseB = d => window.PortalB ? [BASE_TABS[0]].concat(window.PortalB.tabs(d), BASE_TABS.slice(1)) : BASE_TABS;
  async function showPortal(tab) {
    tab = tab || (location.hash.replace('#', '') || 'home');
    app.innerHTML = '<p class="muted">Loading…</p>';
    let d;
    try {
      const [qs, quotes, client, payments] = await Promise.all([B.listQuestionnaires(), B.listQuotes(), B.getClient(), B.listPayments()]);
      d = { qs: qs || [], quotes: quotes || [], client, payments: payments || [] };
      window.__profile = profile; window.__profileTz = profile && profile.timezone || undefined;
      if (window.PortalB) {
        await window.PortalB.load(d);
        if (await window.PortalB.handleCalendarReturn(d)) { await window.PortalB.load(d); tab = 'onboarding'; }
      }
    } catch (err) { app.innerHTML = S.msgHtml(S.errText(err)); return; }
    TABS = withPhaseB(d);
    if (!TABS.some(t => t[0] === tab)) tab = 'home';
    const first = (profile.full_name || '').trim().split(/\s+/)[0];
    app.innerHTML = '<div class="phead"><div><span class="eyebrow">' + S.esc(profile.company || 'Client portal') + '</span>' +
      '<h1 class="t" id="hello">' + (first ? 'Hi ' + S.esc(first) + '.' : 'Welcome.') + '</h1></div>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="editProfile">Your details</button></div>' +
      '<div class="tabs" role="tablist" aria-label="Portal sections">' + TABS.map(t => '<button type="button" role="tab" id="tab-' + t[0] + '" aria-controls="panel" aria-selected="' + (t[0] === tab) + '" tabindex="' + (t[0] === tab ? 0 : -1) + '" data-tab="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>' +
      '<div id="panel" role="tabpanel" aria-labelledby="tab-' + tab + '" tabindex="0">' + TABS.find(t => t[0] === tab)[2](d) + '</div>';
    history.replaceState(null, '', '/start/' + (tab === 'home' ? '' : '#' + tab));
    bindPortal(d, tab);
  }

  function bindPortal(d, tab) {
    S.$('#editProfile').addEventListener('click', () => showProfile(false));
    const tabs = S.$$('[role=tab]');
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => switchTab(d, b.dataset.tab));
      b.addEventListener('keydown', e => {
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1;
        if (j != null) { e.preventDefault(); switchTab(d, tabs[j].dataset.tab); S.$('#tab-' + tabs[j].dataset.tab).focus(); }
      });
    });
    bindPanel(d, tab);
  }
  function switchTab(d, tab) {
    S.$$('[role=tab]').forEach(b => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    const panel = S.$('#panel');
    panel.setAttribute('aria-labelledby', 'tab-' + tab);
    panel.innerHTML = TABS.find(t => t[0] === tab)[2](d);
    history.replaceState(null, '', '/start/' + (tab === 'home' ? '' : '#' + tab));
    bindPanel(d, tab);
  }
  // phase B panels re-load their data and redraw in place; focus goes to the first matching selector
  function phaseBApi(d) {
    return {
      async refresh(tab, focusSels, keepOpen) {
        const open = keepOpen ? S.$$('#panel details[open]').map(x => x.id).filter(Boolean) : [];
        try { await window.PortalB.load(d); } catch (err) { S.toast(S.errText(err)); }
        const tabsNow = withPhaseB(d);
        if (tabsNow.map(t => t[0]).join() !== TABS.map(t => t[0]).join()) { showPortal(tab); return; }
        switchTab(d, tab);
        open.forEach(id => { const el = document.getElementById(id); if (el) el.open = true; });
        const el = (focusSels || []).map(sel => S.$(sel)).find(x => x && !x.disabled);
        if (el) el.focus();
      }
    };
  }
  function bindPanel(d, tab) {
    if (window.PortalB && window.PortalB.bind(d, tab, phaseBApi(d))) return;
    const gob = S.$('#goOnboarding');
    if (gob) gob.addEventListener('click', () => { switchTab(d, 'onboarding'); S.$('#tab-onboarding').focus(); });
    const gbill = S.$('#goBilling');
    if (gbill) gbill.addEventListener('click', () => { switchTab(d, 'billing'); S.$('#tab-billing').focus(); });
    if (tab === 'billing' && window.PortalB && window.PortalB.mountFinalPay) window.PortalB.mountFinalPay(d, document, () => showPortal('billing'));
    if (tab !== 'home') return;
    ['#startQ', '#anotherQ'].forEach(sel => {
      const b = S.$(sel); if (!b) return;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await startNew(null); } catch (err) { b.disabled = false; setMsg(S.$('#homeMsg'), S.errText(err)); }
      });
    });
    S.$$('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this draft? This can’t be undone.')) return;
      b.disabled = true;
      try { await B.deleteQuestionnaire(b.dataset.del); S.toast('Draft deleted'); showPortal('home'); }
      catch (err) { b.disabled = false; setMsg(S.$('#homeMsg'), S.errText(err)); }
    }));
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    await S.loadConfig();
    if (B.mode === 'off') { S.offline(app); return; }
    S.mockBanner();
    let s = null, err = null;
    const p = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, ''));
    // a provider's "no" comes back in the URL (hash or query) before any session; read it, then the URL is cleaned
    const oerr = SI.readOauthError(location.search, location.hash);
    try { s = await B.consumeLink(); } catch (e) { err = S.errText(e); }
    if (oerr) { err = SI.oauthErrorText(oerr, S.ss.get('start_login')); S.ss.del('start_login'); }
    if (SI.urlHasTokens(location.href)) history.replaceState(null, '', location.pathname);
    // demo/test aid: /start/?mock=1&mock_seed=quote_sent moves the signed-in demo user forward
    if (s && B.mode === 'mock' && p.get('mock_seed') && window.StartMock) {
      try { window.StartMock.admin.seed(p.get('mock_seed'), S.PB); } catch (e) { /* unknown stage */ }
      history.replaceState(null, '', '/start/' + location.hash);
    }
    if (s) await enter(s); else showLogin(err);
  }
  boot();
})();
