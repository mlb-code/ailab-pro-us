/* /start/?plan=FR_PRO&niche=home_services — monthly-plan sign-up (2026-11-26). Two short screens after sign-in:
     1. Your business: the plan (switchable), name, business name, business phone (US), type of business, time zone only when
        the browser's zone isn't a US one, and the Terms / Service Agreement consent. "Start 14-day free trial", or, when the
        business phone already had a trial, "Start paid plan" (Backend.trialEligible + checkoutStart decide; the server checks again).
     2. Your card: Paddle's inline checkout (Paddle.js loaded only here; brand.json payments.paddle: env, client-side token,
        price ids). customData carries only the checkout ref (+ user id and phone for Paddle's dashboard); the webhook
        trusts the ref row. On success: a short wait until the webhook has made the subscription (polling client_billing),
        then the portal home with the setup checklist already running. Failure / close: stay on the screen.
   Paddle off (default) = a clearly marked demo card box that calls Backend.mockCheckout (mock backend, tests, staging with
   private.settings.billing_mock_enabled). Prices, minutes and trial length come from the price book; no em dashes. */
(function () {
  const S = window.Start, B = window.Backend, Q = window.StartQ, SI = window.StartSignin;
  const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';
  const subRules = () => ((S.PB.rules || {}).subscription) || {};
  const plans = () => { const codes = subRules().plan_codes || []; return (S.PB.plans || []).filter(p => codes.indexOf(p.code) !== -1 && p.availability !== 'retired'); };
  const planOf = code => plans().find(p => p.code === code) || null;
  const mins = p => Number((p.included_usage || {}).voice_minutes || 0).toLocaleString('en-US');
  const trialDays = p => (p && p.trial_days) || subRules().trial_days || 14;
  const trialMinutes = p => (p && p.trial_minutes) || subRules().trial_minutes || 0;
  const pad = () => ((S.BRAND.payments || {}).paddle) || {};
  function paddleOn() {
    const c = pad();
    return c.enabled === true && !!c.client_token && plans().every(p => c.prices && c.prices[p.code] && c.prices[p.code].trial && c.prices[p.code].paid);
  }
  const usE164 = v => { const d = String(v || '').replace(/\D/g, ''); return /^1?[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+1' + d.slice(-10) : null; };
  const fmtPhone = e => e ? '(' + e.slice(2, 5) + ') ' + e.slice(5, 8) + '-' + e.slice(8) : '';
  const usZone = tz => (Q.US_TZ || []).some(o => o.v === tz);
  const detectTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  const firstCharge = p => S.fmtDate(new Date(Date.now() + trialDays(p) * 86400000).toISOString());

  // ------------------------------------------------------------ intent from the plan buttons (kept across the sign-in)
  const KEY = 'start_plan', PLAN_RX = /^[A-Z][A-Z0-9_]{1,40}$/;
  function readUrl() {
    const p = new URLSearchParams(location.search), plan = (p.get('plan') || '').trim().toUpperCase();
    if (PLAN_RX.test(plan)) S.ss.set(KEY, JSON.stringify({ plan, niche: p.get('niche') || null }));
  }
  /** The plan intent as stored, NOT filtered through the price book: it must survive a price book that hasn't loaded
      (or failed once, or was an old cached copy) on the sign-in screen and across the OAuth round trip. show() checks the
      code against the price book later (an unknown code, or PICK, preselects the default plan). */
  function intent() { try { const v = JSON.parse(S.ss.get(KEY) || 'null'); return v && typeof v.plan === 'string' && PLAN_RX.test(v.plan) ? v : null; } catch (e) { return null; } }
  /** the price book has the monthly plans (show() needs them) */
  const ready = () => plans().length > 0;
  const setIntent = (plan, niche) => S.ss.set(KEY, JSON.stringify({ plan, niche: niche || null }));
  const clearIntent = () => S.ss.del(KEY);

  // ------------------------------------------------------------ shared bits
  function planChoices(cur) {
    return '<div class="choices su-plans" role="radiogroup" aria-label="Plan">' + plans().map(p =>
      '<label class="choice su-plan"><input type="radio" name="su_plan" value="' + S.esc(p.code) + '"' + (p.code === cur ? ' checked' : '') + '>' +
      '<span class="choice__t"><span class="su-pn"><strong>' + S.esc(p.name) + '</strong>' + (p.badge ? '<span class="su-badge">' + S.esc(p.badge) + '</span>' : '') + '</span>' +
      '<span><strong class="num">' + S.money(p.monthly_cents) + '</strong>/mo · ' + mins(p) + ' min a month</span></span></label>').join('') + '</div>';
  }
  /** the plan picker on the portal home (no plan in the URL, nothing started yet) */
  function plansCardHtml() {
    if (!plans().length) return '';
    const r = subRules(), p0 = plans()[0];
    return '<section class="card su-pick" aria-labelledby="pickH"><h2 class="h-card" id="pickH">Pick your plan</h2>' +
      '<p class="small">' + S.esc(r.texts && r.texts.trial ? r.texts.trial : trialDays(p0) + '-day free trial.') + ' ' + S.esc((r.texts && r.texts.no_setup) || '') + '</p>' +
      '<ul class="su-cards">' + plans().map(p => '<li class="su-card"><div><b>' + S.esc(p.name) + '</b>' + (p.badge ? ' <span class="badge">' + S.esc(p.badge) + '</span>' : '') +
        '<div class="su-price"><b class="num">' + S.money(p.monthly_cents) + '</b>/mo</div><div class="muted small">' + mins(p) + ' min a month</div></div>' +
        '<button type="button" class="btn btn--sm ' + (p.badge ? 'btn--primary' : 'btn--ghost') + '" data-pick="' + S.esc(p.code) + '">Start free trial</button></li>').join('') + '</ul></section>';
  }
  function bindPlansCard(onPick) {
    S.$$('[data-pick]').forEach(b => b.addEventListener('click', () => onPick(b.dataset.pick)));
  }
  const ERR = {
    trial_already_used: 'This business phone already had a free trial.', phone_invalid: 'Please enter a US business phone number (10 digits).',
    consent_required: 'Please tick the box to agree to the Terms.', already_subscribed: 'You already have a plan.',
    too_many_checkouts: 'Too many tries today. Please email us and we’ll help.', mock_billing_disabled: 'Online sign-up opens very soon. Please email us and we’ll set you up.',
    bad_plan_code: 'Please pick a plan.'
  };
  const errText = e => { const m = (e && (e.code || e.message)) || ''; for (const k in ERR) if (m.indexOf(k) !== -1) return ERR[k]; return S.errText(e); };

  // ------------------------------------------------------------ screen 1: your business
  let st = null;   // { ctx, plan, niche, trial: true|false, checkout }
  function show(ctx) {
    const it = intent() || {};
    st = { ctx, plan: planOf(it.plan) ? it.plan : (planOf('FR_PRO') ? 'FR_PRO' : (plans()[0] || {}).code), niche: it.niche || (ctx.profile && ctx.profile.niche) || 'home_services', trial: st && st.ctx === ctx ? st.trial : true, checkout: null };
    if ((S.PB._niches || []).map(n => n.key).indexOf(st.niche) === -1) st.niche = 'home_services';
    renderForm();
  }
  function consentText() {
    const p = planOf(st.plan), price = S.money(p.monthly_cents);
    return 'I agree to the Terms of Service and the Service Agreement (version ' + (S.BRAND.agreement_version || '') + '). ' +
      (st.trial ? 'After the ' + trialDays(p) + '-day free trial, my card is charged ' + price + ' each month until I cancel.'
        : 'My card is charged ' + price + ' today and then each month until I cancel.');
  }
  function summaryHtml() {
    const p = planOf(st.plan);
    return st.trial
      ? '<dl class="su-sum"><div><dt>Today</dt><dd class="num">' + S.money(0) + '</dd></div><div><dt>Free trial</dt><dd>' + trialDays(p) + ' days, up to ' + trialMinutes(p) + ' min</dd></div>' +
        '<div><dt>First charge</dt><dd>' + S.money(p.monthly_cents) + ' on ' + S.esc(firstCharge(p)) + '</dd></div></dl>'
      : '<dl class="su-sum"><div><dt>Today</dt><dd class="num">' + S.money(p.monthly_cents) + '</dd></div><div><dt>Then</dt><dd>' + S.money(p.monthly_cents) + ' every month</dd></div>' +
        '<div><dt>Minutes</dt><dd>' + mins(p) + ' a month</dd></div></dl>';
  }
  function consentHtml() {
    const ver = S.esc(S.BRAND.agreement_version || ''), p = planOf(st.plan), price = S.money(p.monthly_cents);
    return '<label class="check su-consent"><input type="checkbox" id="suConsent" required aria-required="true"><span>I agree to the <a href="/legal/terms/" target="_blank" rel="noopener">Terms of Service</a> and the ' +
      '<a href="/legal/service-agreement/" target="_blank" rel="noopener">Service Agreement</a> (version ' + ver + '). ' +
      (st.trial ? 'After the ' + trialDays(p) + '-day free trial, my card is charged ' + price + ' each month until I cancel.' : 'My card is charged ' + price + ' today and then each month until I cancel.') + '</span></label>';
  }
  const goLabel = () => st.trial ? 'Start ' + trialDays(planOf(st.plan)) + '-day free trial' : 'Start paid plan · ' + S.money(planOf(st.plan).monthly_cents) + '/mo';
  function field(id, label, input, hint, half) {
    return '<div class="field' + (half ? ' half' : '') + '"><label for="' + id + '">' + S.esc(label) + '</label>' + (hint ? '<span class="hint" id="' + id + '_h">' + S.esc(hint) + '</span>' : '') + input + '</div>';
  }
  function renderForm(keepMsg) {
    const ctx = st.ctx, pr = ctx.profile || {}, app = ctx.app;
    const tz = pr.timezone || detectTz(), tzKnown = usZone(tz);
    const phone = usE164(pr.phone) ? fmtPhone(usE164(pr.phone)) : (pr.phone || '');
    const niches = (S.PB._niches || []).filter(n => !n.early);
    const relay = SI.isRelayEmail(pr.email) && !pr.contact_email;
    const prod = (subRules().product_names || {})[st.niche] || subRules().product || '';
    app.innerHTML = '<span class="eyebrow">Step 1 of 2 · Your business</span>' +
      '<h1 class="t" id="suH">' + (st.trial ? 'Start your free trial.' : 'Start your plan.') + '</h1>' +
      '<p class="lead" id="suLead">' + S.esc(prod) + (st.trial ? ': ' + trialDays(planOf(st.plan)) + ' days free. No charge today. Cancel anytime in your account.' : '. Cancel anytime in your account.') + '</p>' +
      '<form id="suForm" class="card su" novalidate>' +
      '<fieldset class="field"><legend>Your plan</legend>' + planChoices(st.plan) + '</fieldset>' +
      '<div class="pgrid">' +
      (relay ? field('su_email', 'Email for receipts and alerts', '<input class="input" id="su_email" type="email" autocomplete="email" inputmode="email" required aria-describedby="su_email_h" maxlength="200">', 'You hid your email at Apple. Where should we write to you?') : '') +
      field('su_name', 'Your name', '<input class="input" id="su_name" type="text" autocomplete="name" required maxlength="200" value="' + S.esc(pr.full_name || '') + '">', '', true) +
      field('su_company', 'Business name', '<input class="input" id="su_company" type="text" autocomplete="organization" required maxlength="200" value="' + S.esc(pr.company || '') + '">', '', true) +
      field('su_phone', 'Business phone', '<input class="input" id="su_phone" type="tel" inputmode="tel" autocomplete="tel" required aria-describedby="su_phone_h" placeholder="(555) 555-0100" maxlength="24" value="' + S.esc(phone) + '">', 'The number your customers call. US numbers only.') +
      '<fieldset class="field"><legend>Type of business</legend><div class="choices choices--compact" role="radiogroup">' + niches.map(n =>
        '<label class="choice"><input type="radio" name="su_niche" value="' + S.esc(n.key) + '"' + (n.key === st.niche ? ' checked' : '') + '><span class="choice__t">' + S.esc(n.label) + '</span></label>').join('') + '</div></fieldset>' +
      (tzKnown ? '<p class="small su-tz" id="suTzLine"><span>Time zone: <b>' + S.esc((Q.US_TZ.find(o => o.v === tz) || {}).l || tz) + '</b></span> <button type="button" class="linkbtn" id="suTzChange">Change</button></p>' : '') +
      '<div class="field" id="suTzField"' + (tzKnown ? ' hidden' : '') + '><label for="su_tz">Time zone of the business</label><select class="select" id="su_tz"><option value="">Choose…</option>' +
        Q.US_TZ.map(o => '<option value="' + S.esc(o.v) + '"' + (o.v === tz ? ' selected' : '') + '>' + S.esc(o.l) + '</option>').join('') + '</select></div>' +
      '</div>' +
      '<div id="suTrialNote">' + (st.trial ? '' : S.msgHtml('This business phone already had a free trial, so the plan starts today. You can cancel anytime.', 'info')) + '</div>' +
      '<div id="suSumBox">' + summaryHtml() + '</div>' +
      '<div id="suConsentBox">' + consentHtml() + '</div>' +
      '<div id="suMsg">' + (keepMsg || '') + '</div>' +
      '<div class="navbtns"><button type="submit" class="btn btn--primary" id="suGo">' + S.esc(goLabel()) + '</button></div>' +
      '<p class="muted small su-fine">Your card is needed to start' + (st.trial ? ', and it isn’t charged today' : '') + '. Payments are handled by our payment provider, the merchant of record, so it may appear on your card statement.</p>' +
      '</form>';
    window.scrollTo(0, 0); app.focus({ preventScroll: true });
    bindForm();
  }
  function refreshPlanBits() {
    S.$('#suSumBox').innerHTML = summaryHtml();
    const was = S.$('#suConsent') && S.$('#suConsent').checked;
    S.$('#suConsentBox').innerHTML = consentHtml();
    if (was) S.$('#suConsent').checked = true;
    S.$('#suGo').textContent = goLabel();
  }
  function bindForm() {
    const form = S.$('#suForm');
    S.$$('input[name=su_plan]').forEach(r => r.addEventListener('change', () => { st.plan = r.value; setIntent(st.plan, st.niche); refreshPlanBits(); }));
    S.$$('input[name=su_niche]').forEach(r => r.addEventListener('change', () => { st.niche = r.value; }));
    const tzc = S.$('#suTzChange');
    if (tzc) tzc.addEventListener('click', () => { S.$('#suTzField').hidden = false; S.$('#suTzLine').hidden = true; S.$('#su_tz').focus(); });
    S.$('#su_phone').addEventListener('input', () => { if (!st.trial) { st.trial = true; S.$('#suTrialNote').innerHTML = ''; refreshPlanBits(); S.$('#suH').textContent = 'Start your free trial.'; } });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const box = S.$('#suMsg'); box.innerHTML = '';
      S.$$('.field--error', form).forEach(x => x.classList.remove('field--error'));
      const bad = (id, text) => { const el = S.$('#' + id); const f = el.closest('.field') || el.closest('label'); if (f) f.classList.add('field--error'); el.setAttribute('aria-invalid', 'true'); box.innerHTML = S.msgHtml(text); el.focus(); };
      const val = id => (S.$('#' + id) ? S.$('#' + id).value : '').trim();
      if (S.$('#su_email') && !SI.validEmail(val('su_email').toLowerCase())) return bad('su_email', 'That email address doesn’t look right.');
      if (S.$('#su_email') && SI.isRelayEmail(val('su_email').toLowerCase())) return bad('su_email', 'Please use an address you read, not the Apple relay address.');
      if (!val('su_name')) return bad('su_name', 'Please add your name.');
      if (!val('su_company')) return bad('su_company', 'Please add the business name.');
      const ph = usE164(val('su_phone'));
      if (!ph) return bad('su_phone', ERR.phone_invalid);
      const tz = val('su_tz');
      if (!tz) { S.$('#suTzField').hidden = false; return bad('su_tz', 'Please pick the time zone of the business.'); }
      if (!S.$('#suConsent').checked) return bad('suConsent', ERR.consent_required);
      const btn = S.$('#suGo'); btn.disabled = true; btn.textContent = 'One moment…';
      try {
        const row = { full_name: val('su_name'), company: val('su_company'), phone: fmtPhone(ph), niche: st.niche, timezone: tz };
        if (S.$('#su_email')) row.contact_email = val('su_email').toLowerCase();
        st.ctx.profile = await B.saveProfile(row);
        if (st.ctx.onProfile) st.ctx.onProfile(st.ctx.profile);
        if (st.trial) {
          const el = await B.trialEligible(ph);
          if (el && !el.eligible && el.reason === 'trial_already_used') { switchToPaid(); return; }
        }
        const r = await B.checkoutStart(st.plan, ph, S.BRAND.agreement_version || '', consentText(), st.trial);
        st.checkout = r;
        showCheckout();
      } catch (err) {
        const m = (err && (err.code || err.message)) || '';
        if (/trial_already_used/.test(m)) { switchToPaid(); return; }
        if (/already_subscribed/.test(m)) { clearIntent(); S.toast(ERR.already_subscribed); st.ctx.onDone('billing'); return; }
        btn.disabled = false; btn.textContent = goLabel(); box.innerHTML = S.msgHtml(errText(err));
      }
    });
  }
  function switchToPaid() {   // the trial is not available for this business: same screen, paid wording, tick the box again
    st.trial = false;
    renderForm();
    S.$('#suConsent').focus();
  }

  // ------------------------------------------------------------ screen 2: your card
  let paddleP = null, onPaddle = null;
  function loadPaddle() {
    if (paddleP) return paddleP;
    paddleP = new Promise((res, rej) => {
      if (window.Paddle) { res(window.Paddle); return; }
      const s = document.createElement('script');
      s.src = PADDLE_JS; s.async = true; s.onload = () => res(window.Paddle); s.onerror = () => { paddleP = null; rej(new Error('paddle_load_failed')); };
      document.head.appendChild(s);
    }).then(P => {
      if (pad().env !== 'production') P.Environment.set('sandbox');
      P.Initialize({ token: pad().client_token, eventCallback: ev => { if (onPaddle) onPaddle(ev); } });
      return P;
    });
    return paddleP;
  }
  function showCheckout() {
    const app = st.ctx.app, p = planOf(st.plan), r = st.checkout;
    const lead = st.trial ? S.money(0) + ' today. Your first charge of ' + S.money(p.monthly_cents) + ' is on ' + firstCharge(p) + '. Cancel before then and you pay nothing.'
      : S.money(p.monthly_cents) + ' today, then every month. Cancel anytime.';
    const live = paddleOn();
    app.innerHTML = '<span class="eyebrow">Step 2 of 2 · Your card</span><h1 class="t" id="payH">Add your card.</h1><p class="lead">' + S.esc(lead) + '</p>' +
      '<section class="card su-pay" aria-labelledby="payH">' +
      '<div class="su-line"><span><b>' + S.esc(p.name) + '</b> · ' + S.money(p.monthly_cents) + '/mo · ' + mins(p) + ' min</span><span class="muted small">' + S.esc(fmtPhone(r.business_phone)) + '</span></div>' +
      (live ? '<div class="su-checkout" id="payFrame"><p class="muted small" id="payLoading">Loading the secure card form…</p></div>'
        : '<div class="paystub" id="payStub"><p><b>Demo checkout</b></p><p class="muted small">Demo mode: no card is needed and nothing is charged. On the live site, the secure card form of our payment provider appears here.</p>' +
          '<button type="button" class="btn btn--primary btn--block" id="demoPay">' + (st.trial ? 'Use demo card · ' + S.money(0) + ' today' : 'Use demo card') + '</button></div>') +
      '<div id="payMsg" aria-live="polite"></div></section>' +
      '<div class="navbtns"><button type="button" class="btn btn--ghost" id="suBack">Back</button></div>' +
      '<p class="muted small su-fine">Secure checkout by our payment provider. We never see or store your card number.</p>';
    window.scrollTo(0, 0); app.focus({ preventScroll: true });
    S.$('#suBack').addEventListener('click', () => { onPaddle = null; renderForm(); });
    const msg = (t, kind) => { S.$('#payMsg').innerHTML = S.msgHtml(t, kind); };
    if (!live) {
      // real site with Paddle still off and no demo provider: say so plainly instead of a button that can't work
      if (B.mode !== 'mock') B.getBilling().then(b => {
        if (b && b.mock_checkout) return;
        const sup = S.BRAND.support_email || '';
        S.$('#payStub').innerHTML = '<p><b>Card sign-up opens very soon.</b></p><p class="muted small">Your details are saved. Email us' +
          (sup ? ' at <a href="mailto:' + S.esc(sup) + '">' + S.esc(sup) + '</a>' : '') + ' and we’ll start your plan today.</p>';
      }).catch(() => null);
      S.$('#demoPay').addEventListener('click', async e => {
        const b = e.currentTarget; b.disabled = true;
        try { await B.mockCheckout(st.plan, st.trial ? trialDays(p) : 0, r.business_phone); done(); }
        catch (err) { b.disabled = false; msg(errText(err)); }
      });
      return;
    }
    onPaddle = ev => {
      const n = ev && ev.name;
      if (n === 'checkout.loaded') { const l = S.$('#payLoading'); if (l) l.remove(); }
      else if (n === 'checkout.completed') waiting();
      else if (n === 'checkout.payment.failed' || n === 'checkout.payment.error') msg('The card didn’t go through. Please try another card.');
      else if (n === 'checkout.error') msg('The card form had a problem. Please try again in a minute.');
      else if (n === 'checkout.closed') msg('The card form was closed. Your plan hasn’t started yet.', 'info');
    };
    loadPaddle().then(P => {
      const c = pad(), price = c.prices[st.plan][st.trial ? 'trial' : 'paid'], pr = st.ctx.profile || {};
      P.Checkout.open({
        items: [{ priceId: price, quantity: 1 }],
        customer: { email: pr.contact_email || pr.email || (st.ctx.session && st.ctx.session.user.email) || '', address: { countryCode: 'US' } },
        customData: { ref: r.ref, user_id: st.ctx.session.user.id, business_phone: r.business_phone },
        settings: { displayMode: 'inline', frameTarget: 'su-checkout', frameInitialHeight: 450, variant: 'one-page',
          frameStyle: 'width:100%;min-width:286px;background-color:transparent;border:none', allowLogout: false, showAddDiscounts: false, locale: 'en', theme: 'light' }
      });
    }).catch(() => { paddleP = null; msg('The secure card form didn’t load. Check your connection and try again.'); });
  }
  async function waiting() {
    onPaddle = null;
    const box = S.$('.su-pay');
    box.innerHTML = '<div class="su-wait" role="status" id="payWait"><span class="spin" aria-hidden="true"></span><div><b>Card saved. Setting up your account…</b><br><span class="muted small">This takes a few seconds. Please keep this page open.</span></div></div>';
    S.$('#suBack').hidden = true;
    for (let i = 0; i < 45; i++) {
      try { const b = await B.getBilling(); if (b && b.subscription) { done(); return; } } catch (e) { /* keep waiting */ }
      await new Promise(r => setTimeout(r, i < 10 ? 1500 : 3000));
    }
    box.innerHTML = S.msgHtml('Your card is saved. Setting up your account is taking longer than usual. We’ll email you as soon as it’s ready, and it will show in your account.', 'info') +
      '<div class="btn-row"><button type="button" class="btn btn--primary" id="payGoPortal">Go to my account</button></div>';
    S.$('#payGoPortal').addEventListener('click', () => { clearIntent(); st.ctx.onDone('home'); });
  }
  function done() {
    clearIntent();
    S.track('sign_up', { method: st.trial ? 'trial' : 'paid' });
    S.toast(st.trial ? 'Your free trial has started.' : 'Your plan has started.', 4000);
    st.ctx.onDone('home');
  }

  window.StartSignup = { readUrl, intent, ready, setIntent, clearIntent, show, plansCardHtml, bindPlansCard, paddleOn, planOf, loadPaddle };
})();
