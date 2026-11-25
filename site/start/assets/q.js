/* /start/q/?id=... — questionnaire wizard: screens 2 and 3 of 3 (the profile in home.js is screen 1), branches by
   offer × niche, autosave (debounced) + localStorage backup, resumable (#step id in the URL), submit from the last
   screen locks it, read-only view afterwards. No review screen: every answer is visible on its screen; changes after
   submit go by email (or Meir fixes them in the admin). Files are not uploaded here any more (portal, after the deposit).
   Since 2026-11-25 a new questionnaire offers the Business Website only (StartQ.NEW_OFFERS, preselected); FirstRing is the
   monthly plan sign-up (a line under the offer links to it). Submitted questionnaires of any offer still show read-only. */
(function () {
  const S = window.Start, B = window.Backend, Q = window.StartQ;
  const app = S.$('#app');
  const id = new URLSearchParams(location.search).get('id');
  const BK = 'start_q_backup_' + id;
  const FIRST = 'need';

  let session, q, answers = {}, stepId = FIRST, movedFrom = null;   // movedFrom: the FirstRing offer an old draft held
  let dirty = false, saving = null, saveTimer = null, lastSaved = null, saveFailed = false;
  const openFolds = {};   // step id -> the person opened/closed its "Add more details" fold (kept across in-place re-renders)
  const PB = () => S.PB;
  const steps = () => Q.stepsFor(answers);
  const R = x => Q.resolve(x, answers, PB());

  // ------------------------------------------------------------ save
  function setState() {
    const el = S.$('#saveState'); if (!el) return;
    el.classList.toggle('bad', saveFailed);
    el.textContent = saveFailed ? 'Not saved yet, retrying…' : (saving || dirty) ? 'Saving…'
      : lastSaved ? 'Saved ✓ ' + lastSaved.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  }
  function markDirty() {
    dirty = true;
    S.ls.set(BK, { answers, ts: Date.now() });
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200);
    setState();
  }
  // a pick list only keeps choices this path still offers (e.g. an older real-estate draft holding Jobber): what is saved,
  // summarised and quoted is exactly what the person can see and change on screen
  function offered(a) {
    const out = Object.assign({}, a);
    Q.fieldsFor(a).forEach(f => {
      if (f.type !== 'multi' || !Array.isArray(out[f.k])) return;
      const ok = Q.optsOf(f, a, PB()).map(o => o.v);
      out[f.k] = out[f.k].filter(v => ok.indexOf(v) !== -1);
    });
    return out;
  }
  function payload() {
    const a = offered(answers);
    return { offer: a.offer || null, niche: a.niche || null, answers: Q.visibleAnswers(a), summary: Q.buildSummary(a, PB()) };
  }
  async function save() {
    clearTimeout(saveTimer);
    if (saving) { await saving; if (!dirty) return true; }
    if (!dirty) return true;
    dirty = false; setState();
    saving = (async () => {
      let data = null, failed = false;
      try { data = await B.saveQuestionnaire(id, payload()); } catch (e) { failed = true; }
      if (failed) { dirty = true; saveFailed = true; saveTimer = setTimeout(save, 5000); return false; }
      if (!data) { saveFailed = false; S.ls.del(BK); location.reload(); return false; }   // locked (submitted elsewhere)
      saveFailed = false; lastSaved = new Date(); q.updated_at = data.updated_at;
      if (!dirty) S.ls.del(BK);
      return true;
    })();
    const ok = await saving; saving = null; setState();
    return ok;
  }
  // back/forward or a typed #step: draw that step (drafts only; render() itself uses replaceState, so no loop)
  window.addEventListener('hashchange', () => {
    if (!q || q.status !== 'draft' || !app.querySelector('.progress')) return;
    const h = location.hash.replace('#', '');
    if (h && h !== stepId && Q.stepsFor(answers).some(s => s.id === h) && (h === FIRST || (answers.offer && answers.niche))) go(h);
  });
  window.addEventListener('beforeunload', e => { if (dirty || saving) { save(); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) save(); });

  // ------------------------------------------------------------ fields
  // each card: name + the regular price from the price book; the founding-client offer is one line under the group
  function offerCards(f) {
    return Q.newOfferOpts(answers).map(o => {   // new questionnaires: the website only (FirstRing = monthly plan sign-up)
      const p = S.priceOf(o.v);
      const price = p ? S.money(p.setup) + ' setup + ' + S.money(p.monthly) + '/mo' : 'We’ll suggest the right fit';
      return choice('radio', f.k, o.v, '<b>' + S.esc(o.l) + '</b><span>' + price + '</span>', answers[f.k] === o.v);
    }).join('');
  }
  function founderNote() {
    const disc = S.BRAND.show_founder_price && PB().rules && PB().rules.discounts && PB().rules.discounts.FOUNDING;   // brand.json flag
    if (!disc || !disc.setup_pct) return '';
    // label, % and number of clients from the price book; the condition is the one on the landing pages and in the Service Agreement
    return '<p class="founder" id="founderNote">' + S.esc(disc.label || 'Founding-client price') + ': ' + S.esc(String(disc.setup_pct)) + '% off setup for our first ' +
      S.esc(String(disc.max_clients)) + ' clients, if you let us write a short case study about your results.</p>';
  }
  // FirstRing is a monthly plan now (no questionnaire, no quote): one line under the offer, a notice when this draft had
  // asked for it before (its offer was moved to the website on opening)
  function planNote() {
    const re = Q.isRE(answers), prod = re ? 'the AI lead assistant' : 'the AI receptionist';
    const sr = (PB().rules || {}).subscription || {}, name = sr.product || 'FirstRing';
    const href = '/start/?plan=PICK' + (answers.niche ? '&niche=' + encodeURIComponent(answers.niche) : '');
    const link = '<a href="' + S.esc(href) + '" id="planLink">See the plans</a>';
    return movedFrom
      ? '<div class="notice notice--info" role="status" id="planNote"><div>' + S.esc(name) + ', ' + prod + ', is now a monthly plan with a free trial: no questionnaire and no quote. ' + link + '. This questionnaire is for a website.</div></div>'
      : '<p class="small muted" id="planNote">Looking for ' + S.esc(name) + ', ' + prod + '? It’s a monthly plan with a free trial. ' + link + '.</p>';
  }
  function nicheCards(f) {
    return (PB()._niches || []).map(n => choice('radio', f.k, n.key, '<b>' + S.esc(n.label) + '</b>' + (n.early ? '<span class="badge badge--acc">Early access</span>' : ''), answers[f.k] === n.key)).join('');
  }
  function choice(type, k, v, inner, on) {
    return '<label class="choice"><input type="' + type + '" name="' + k + '" data-k="' + k + '" value="' + S.esc(v) + '"' + (on ? ' checked' : '') + '><span class="choice__t">' + inner + '</span></label>';
  }
  function fieldHtml(f) {
    const v = answers[f.k], fid = 'f_' + f.k, label = R(f.label);
    const req = f.req ? ' <span class="req">required</span>' : '';
    const hint = f.hint ? '<span class="hint" id="' + fid + '_h">' + S.esc(R(f.hint)) + '</span>' : '';
    const desc = f.hint ? ' aria-describedby="' + fid + '_h"' : '';
    if (f.type === 'note') return '<div class="notice" role="note" id="' + fid + '">' + S.esc(f.text) + '</div>';
    if (f.type === 'text') {
      return '<div class="field"><label for="' + fid + '">' + S.esc(label) + req + '</label>' + hint +
        '<input class="input" type="text" id="' + fid + '" data-k="' + f.k + '" maxlength="500"' + desc + (f.ph ? ' placeholder="' + S.esc(f.ph) + '"' : '') + ' value="' + S.esc(v || '') + '"></div>';
    }
    if (f.type === 'textarea') {
      const ta = '<textarea class="textarea" id="' + fid + '" data-k="' + f.k + '" maxlength="8000"' + desc + '>' + S.esc(v || '') + '</textarea>';
      return '<div class="field"><label for="' + fid + '">' + S.esc(label) + req + '</label>' + hint + ta + '</div>';
    }
    if (['single', 'multi', 'offer', 'niche'].indexOf(f.type) !== -1) {
      const multi = f.type === 'multi';
      let inner;
      if (f.type === 'offer') inner = offerCards(f);
      else if (f.type === 'niche') inner = nicheCards(f);
      else {
        const opts = Q.optsOf(f, answers, PB());
        inner = opts.map(o => choice(multi ? 'checkbox' : 'radio', f.k, o.v, S.esc(o.l), multi ? (Array.isArray(v) && v.indexOf(o.v) !== -1) : v === o.v)).join('');
      }
      // short labels sit side by side (2 per row on a phone), and so does a long multi list (the tools)
      const opts = f.type === 'niche' ? (PB()._niches || []).map(n => ({ l: n.label })) : Q.optsOf(f, answers, PB());
      const compact = f.type !== 'offer' && (opts.every(o => o.l.length <= 22) || (multi && opts.length > 6));
      return '<fieldset class="field" id="' + fid + '"' + desc + '><legend class="label">' + S.esc(label) + req + '</legend>' + hint +
        '<div class="choices' + (compact ? ' choices--compact' : '') + (f.type === 'offer' ? ' choices--offer' : '') + '"' + (multi ? '' : ' role="radiogroup" aria-label="' + S.esc(label) + '"') + '>' + inner + '</div>' +
        (f.type === 'offer' ? founderNote() + planNote() : '') + '</fieldset>';
    }
    return '';
  }
  // questions that change the price are shown; the rest (Q.optional) wait in one closed "Add more details (optional)" fold.
  // The fold opens by itself when it already holds an answer (coming back), and keeps the person's open/closed choice.
  const hasAnswer = k => { const v = answers[k]; return v != null && v !== '' && !(Array.isArray(v) && !v.length); };
  function stepHtml(s) {
    const fields = s.fields.filter(f => Q.visible(f, answers));
    const main = fields.filter(f => !Q.optional(f, answers)), more = fields.filter(f => Q.optional(f, answers));
    const open = s.id in openFolds ? openFolds[s.id] : more.some(f => hasAnswer(f.k));
    const fold = more.length ? '<details class="fold" id="fold_' + s.id + '"' + (open ? ' open' : '') + '><summary class="fold__s" id="fold_' + s.id + '_s">Add more details (optional)</summary>' +
      '<div class="fold__b">' + more.map(fieldHtml).join('') + '</div></details>' : '';
    const sub = R(s.sub);
    return '<section class="step" aria-labelledby="stepTitle"><h1 class="t step__title" id="stepTitle" tabindex="-1">' + S.esc(R(s.title)) + '</h1>' +
      (sub ? '<p class="sub">' + S.esc(sub) + '</p>' : '') + main.map(fieldHtml).join('') + fold + '<div id="stepMsg"></div></section>';
  }
  // the read-only view after submit (what the admin and the quote engine read)
  // It shows the summary stored when the questionnaire was sent (question + answer as the person saw them), so questions
  // asked back then and removed since (services, content_have) still show; rows without a stored summary are rebuilt.
  function summaryHtml() {
    const rows = Array.isArray(q.summary) && q.summary.length && q.summary.every(r => r && r.q != null) ? q.summary
      : steps().flatMap(s => s.fields.filter(f => Q.visible(f, answers) && f.type !== 'note').map(f => ({ q: R(f.label), a: Q.valueText(f, answers[f.k], answers, PB()) })));
    return '<ul class="sum">' + rows.map(r => {
      const t = String(r.a || '').trim();
      return '<li><div class="sum__q"><span>' + S.esc(String(r.q)) + '</span></div><div class="sum__a' + (t ? '' : ' none') + '">' + (t ? S.esc(t) : 'Not answered') + '</div></li>';
    }).join('') + '</ul>';
  }

  // ------------------------------------------------------------ render
  // the profile (home.js) is screen 1 of N+1, so step i here is screen i+2
  function render(focus) {
    const list = steps(), N = list.length;
    let i = list.findIndex(s => s.id === stepId);
    if (i < 0) { stepId = FIRST; i = 0; }
    const last = i === N - 1;
    const pct = Math.round(((i + 1) / (N + 1)) * 100);
    const label = 'Step ' + (i + 2) + ' of ' + (N + 1) + ' · ' + R(list[i].title);
    const cur = app.querySelector('details.fold');   // remember the fold's open/closed state before the step is redrawn
    if (cur) openFolds[cur.id.replace('fold_', '')] = cur.open;
    const body = stepHtml(list[i]) + '<div id="subMsg"></div><div class="navbtns">' +
      (i > 0 ? '<button type="button" class="btn btn--ghost" id="prevBtn">← Back</button>' : '<a class="btn btn--ghost" href="/start/" id="exitBtn">Save and exit</a>') +
      (last ? '<button type="button" class="btn btn--primary" id="submitBtn">' + submitLabel() + '</button>' : '<button type="button" class="btn btn--primary" id="nextBtn">Continue →</button>') + '</div>' +
      (last ? '<p class="muted small center spaced" id="lockNote">Your answers lock after you send. Missed something? Reply to our email.</p>' : '') +
      (i > 0 ? '<p class="center spaced"><a class="linkbtn" href="/start/" id="exitBtn2">Save and finish later</a></p>' : '');
    app.innerHTML = '<div class="progress"><div class="bar" role="progressbar" aria-label="Questionnaire progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="lbls"><span>' + S.esc(label) + '</span><span class="savestate" id="saveState" aria-live="polite"></span></div></div>' + body;
    setState(); bind();
    history.replaceState(null, '', '/start/q/?id=' + encodeURIComponent(id) + '#' + stepId);
    if (focus) { window.scrollTo(0, 0); const h = S.$('#stepTitle'); if (h) h.focus({ preventScroll: true }); }
  }

  function go(target) {
    stepId = target;
    if (dirty) save();
    render(true);
  }

  function validateStep() {
    if (stepId !== FIRST) return true;
    const miss = ['offer', 'niche'].filter(k => !answers[k]);
    if (!miss.length) return true;
    S.$('#stepMsg').innerHTML = S.msgHtml(miss[0] === 'offer' ? 'Please choose what you’d like a quote for.' : 'Please choose your industry.');
    const first = S.$('#f_' + miss[0] + ' input'); if (first) first.focus();
    return false;
  }

  function bind() {
    app.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      const handler = () => {
        if (el.type === 'checkbox') {
          const f = Q.fieldsFor(answers).find(x => x.k === k);
          if (f && f.none && el.checked)   // the "none" option is exclusive with the others
            app.querySelectorAll('input[data-k="' + k + '"]:checked').forEach(x => { if (x !== el && (el.value === f.none || x.value === f.none)) x.checked = false; });
          answers[k] = Array.from(app.querySelectorAll('input[data-k="' + k + '"]:checked')).map(x => x.value);
        } else answers[k] = el.value;
        markDirty();
        // branching fields re-render the current step in place (keeps focus on the same control)
        if (['offer', 'niche', 'tools', 're_crm'].indexOf(k) !== -1) {
          const val = el.value, type = el.type;
          render(false);
          const back = app.querySelector('input[data-k="' + k + '"][value="' + CSS.escape(val) + '"]');
          if (back && type !== 'text') back.focus();
        }
      };
      el.addEventListener(el.type === 'checkbox' || el.type === 'radio' ? 'change' : 'input', handler);
    });
    const list = steps(), i = list.findIndex(s => s.id === stepId);
    const nb = S.$('#nextBtn'), pb = S.$('#prevBtn');
    if (nb) nb.addEventListener('click', () => { if (validateStep()) go(list[i + 1].id); });
    if (pb) pb.addEventListener('click', () => go(list[Math.max(0, i - 1)].id));
    ['#exitBtn', '#exitBtn2'].forEach(s => { const a = S.$(s); if (a) a.addEventListener('click', async e => { e.preventDefault(); await save(); location.href = '/start/'; }); });
    const sb = S.$('#submitBtn'); if (sb) sb.addEventListener('click', submit);
  }

  // ------------------------------------------------------------ submit
  const receptionist = () => ['RCP', 'BNDL', 'UNSURE'].indexOf(answers.offer) !== -1;
  const isWeb = () => answers.offer === 'WEB';
  const submitLabel = () => isWeb() ? 'Send and get my deposit link' : 'Get my fixed quote';
  const depPct = () => PB().rules && PB().rules.deposit_pct || 50;
  // WEB is sold without a quote step: a deposit link (or the payment endpoint from brand.json, when configured)
  function payEndpoint() {
    const e = S.BRAND.endpoints && S.BRAND.endpoints.payment;
    return typeof e === 'string' && /^https:\/\//.test(e) ? e : null;
  }
  function nextStepsHtml() {
    const dep = depPct();
    if (isWeb()) {
      const web = [
        '<b>Content:</b> after the ' + dep + '% deposit, your portal asks for the rest (domain, hours, photos, logo). Nothing to upload now.',
        '<b>Review:</b> you check every page and send changes in writing.',
        '<b>Go live:</b> we connect your domain and switch the site on after the final payment.'
      ];
      return '<h2 class="h-sec">What happens next</h2><ol class="next">' + web.map(x => '<li>' + x + '</li>').join('') + '</ol>';
    }
    const items = [
      '<b>Accept online</b> and pay a ' + dep + '% deposit. No call needed.',
      '<b>Setup checklist</b> in your portal, with a short video per step. Nothing to upload now.'
    ];
    if (receptionist()) items.push('<b>Going live:</b> phone answering starts right away. Texting (text-back and text alerts) is coming soon, after US carrier registration; until then, alerts come by email.');
    return '<h2 class="h-sec">What happens next</h2><ol class="next">' + items.map(x => '<li>' + x + '</li>').join('') + '</ol>';
  }
  // one optional tap after submit: profiles.how_heard (never blocks anything; a failure is silent)
  function howHeardHtml() {
    return '<section class="card spaced" id="howHeard"><fieldset class="field"><legend class="label">How did you hear about us? (optional)</legend>' +
      '<div class="choices choices--compact">' + Q.HOW_HEARD.map(o => choice('radio', 'how_heard', o.v, S.esc(o.l), false)).join('') + '</div></fieldset><div id="howMsg" aria-live="polite"></div></section>';
  }
  function bindHowHeard() {
    app.querySelectorAll('input[name=how_heard]').forEach(el => el.addEventListener('change', async () => {
      app.querySelectorAll('input[name=how_heard]').forEach(x => { x.disabled = true; });
      try { await B.saveProfile({ how_heard: el.value }); S.$('#howMsg').innerHTML = S.msgHtml('Thanks!', 'ok'); } catch (e) { /* optional; never shown as an error */ }
    }));
  }
  async function submit() {
    const box = S.$('#subMsg'); box.innerHTML = '';
    if (!answers.offer || !answers.niche) { box.innerHTML = S.msgHtml('Please choose an offer and your industry (step 2).'); return; }
    const btn = S.$('#submitBtn'); btn.disabled = true; btn.textContent = 'Sending…';
    const ok = await save();
    if (!ok) { btn.disabled = false; btn.textContent = submitLabel(); box.innerHTML = S.msgHtml('We couldn’t save. Check your connection and try again.'); return; }
    try { q = await B.submitQuestionnaire(id); }
    catch (err) { btn.disabled = false; btn.textContent = submitLabel(); box.innerHTML = S.msgHtml(S.errText(err)); return; }
    S.ls.del(BK);
    const evt = isWeb() ? 'web_deposit_link_requested' : 'q_submitted';
    try { await B.notify(evt, { entity: 'questionnaire', id, offer: answers.offer, niche: answers.niche, extras: answers.web_extras || [] }); } catch (e) { /* event stub never blocks */ }
    S.trackFunnel(['quote', 'submit'], { offer: answers.offer, niche: answers.niche });
    history.replaceState(null, '', '/start/q/?id=' + encodeURIComponent(id));
    const pay = isWeb() && payEndpoint();
    const lead = isWeb()
      ? '<p class="lead" id="doneLead">Your deposit link is on its way — we email it ' + S.esc(S.sla()) + ' to <b>' + S.esc(session.user.email) + '</b>. ' + S.esc(S.webTimeline()) + '</p>' +
        (pay ? '<div class="btn-row spaced-b"><a class="btn btn--primary" id="payDeposit" data-pay="web_deposit" href="' + S.esc(pay + (pay.indexOf('?') === -1 ? '?' : '&') + 'offer=WEB&ref=' + encodeURIComponent(id)) + '">Pay the ' + depPct() + '% deposit</a></div>' : '')
      : '<p class="lead" id="doneLead">You’ll get a written fixed quote ' + S.esc(S.sla()) + ', by email to <b>' + S.esc(session.user.email) + '</b> and here in your portal.</p>';
    app.innerHTML = '<span class="eyebrow">Submitted</span><h1 class="t" id="doneTitle" tabindex="-1">Thanks — we have everything we need.</h1>' + lead +
      nextStepsHtml() + '<div class="btn-row spaced"><a class="btn btn--primary" href="/start/">Go to your portal</a></div>' + howHeardHtml();
    bindHowHeard();
    window.scrollTo(0, 0); S.$('#doneTitle').focus({ preventScroll: true });
  }

  function renderReadOnly() {
    const st = { submitted: 'Submitted', quoted: 'Quoted', closed: 'Closed' }[q.status] || q.status;
    app.innerHTML = '<span class="eyebrow">Your questionnaire</span><h1 class="t" tabindex="-1" id="roTitle">Your answers</h1>' +
      '<p class="muted spaced-b"><span class="pill pill--' + S.esc(q.status) + '">' + S.esc(st) + '</span> · Submitted ' + S.fmtDate(q.submitted_at, true) + '</p>' +
      '<p class="muted spaced-b">Submitted questionnaires are locked. Remembered something? Email us, or start a new questionnaire from your portal.</p>' +
      summaryHtml() + '<div class="navbtns"><a class="btn btn--ghost" href="/start/">← Your portal</a></div>';
  }

  // ------------------------------------------------------------ boot
  const notFound = text => { app.innerHTML = S.msgHtml(text || 'Questionnaire not found.') + '<p class="spaced"><a class="btn btn--ghost" href="/start/">Go to your portal</a></p>'; };
  async function boot() {
    await S.loadConfig();
    if (B.mode === 'off') { S.offline(app); return; }
    S.mockBanner();
    try { session = await B.getSession(); } catch (e) { session = null; }
    if (!session) {   // shown in place (a redirect here aborts in-flight font loads → console errors in Firefox)
      S.renderHeader(null);
      app.innerHTML = '<span class="eyebrow">Your questionnaire</span><h1 class="t">Please sign in to continue.</h1>' +
        '<p class="lead">Your answers are saved to your account. Sign in with the email you used and you’ll pick up where you left off.</p>' +
        '<a class="btn btn--primary" href="/start/">Sign in</a>';
      return;
    }
    S.renderHeader(session, { portalLink: true });
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { notFound(); return; }
    try { q = await B.getQuestionnaire(id); }
    catch (err) { notFound(S.errText(err)); return; }
    if (!q) { notFound(); return; }
    answers = Object.assign({}, q.answers || {});
    if (q.offer && !answers.offer) answers.offer = q.offer;
    if (q.niche && !answers.niche) answers.niche = q.niche;
    if (q.status !== 'draft') { renderReadOnly(); return; }
    const bk = S.ls.get(BK);
    if (bk && bk.answers && bk.ts > Date.parse(q.updated_at) + 1000) { answers = bk.answers; dirty = true; setTimeout(save, 300); }
    // the website is the only offer of a new questionnaire: preselected; an old draft that asked for FirstRing (RCP, BNDL,
    // UNSURE) is moved to it at once (FirstRing = the monthly plan sign-up) and says so
    const was = answers.offer;
    if (Q.NEW_OFFERS.indexOf(was) === -1) { answers.offer = Q.NEW_OFFERS[0]; movedFrom = Q.LEGACY_OFFERS.indexOf(was) !== -1 ? was : null; }
    if ((!q.answers || !Object.keys(q.answers).length) && (answers.offer || answers.niche)) { dirty = true; save(); }   // landing prefill → stored at once
    else if (JSON.stringify(offered(answers)) !== JSON.stringify(answers)) { answers = offered(answers); dirty = true; save(); }   // a choice no longer offered (old draft) → dropped at once, never quoted
    else if (answers.offer !== was) { dirty = true; save(); }
    const h = location.hash.replace('#', '');
    stepId = Q.stepsFor(answers).some(s => s.id === h) && !movedFrom ? h : FIRST;   // a moved draft opens where the notice is
    if (stepId !== FIRST && (!answers.offer || !answers.niche)) stepId = FIRST;
    render(false);
  }
  boot();
})();
