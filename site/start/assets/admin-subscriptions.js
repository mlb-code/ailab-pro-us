/* Admin "Subscriptions" tab (FirstRing monthly plans, 2026-11-25; English, LTR). Rendered by admin.js -> tSubs() ->
   AdminSubscriptions.render(panel, ctx). Data: AB.adminSubscriptions() = RPC admin_subscriptions (admin only): each
   subscription with its plan, trial / period dates, card, provider, service mode (full / message mode + why), tenant, the
   automatic setup jobs (number purchase, go-live check) and checklist progress. Buttons: retry a job / the whole setup
   (admin_retry_provisioning), manual go-live (admin_force_golive), record the 30-day money-back (admin_mark_money_back).
   Plan names and prices come from the price book (ctx.PB.plans), never typed here.
   Phase 2 (2026-11-25): AB.adminSubscriptionsExtra = RPC admin_subscriptions_extra: the number release after the service
   ended (scheduled date, warning, dry run) with "postpone 14 days" (admin_postpone_number_release) and "release now"
   (admin_release_number_now, asks first), and the go-live live AI check (status, problems, cost estimate, transcript).
   2026-11-27: extra.forwarding.unverified (the client self-confirmed the forwarding test) shows a "Forwarding unverified" badge. */
(function () {
  let C = null, rows = [], loadErr = null;
  const SUB_ST = { trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', paused: 'Paused', canceled: 'Canceled' };
  const SUB_PILL = { trialing: 'testing', active: 'live', past_due: 'need_help', paused: 'paused', canceled: 'cancelled' };
  const JOB = { number: 'Phone number', golive_sim: 'Go-live check' };
  const JOB_ST = { pending: 'Waiting to run', running: 'Running now', done: 'Done', failed: 'Failed', held: 'Held' };
  const JOB_PILL = { pending: 'todo', running: 'todo', done: 'live', failed: 'need_help', held: 'need_help' };
  const WHY = { trial_ended: 'trial ended without payment', canceled: 'canceled', past_due: 'payment failed (after the grace period)', paused: 'paused', '': '' };
  const E = { not_admin: 'You do not have admin access.', no_number: 'This client has no phone number yet.', no_tenant: 'This client has no tenant.',
    no_subscription: 'This client has no subscription.', money_back_already_used: 'The money-back refund was already used for this business.',
    money_back_window_closed: 'More than 30 days since the first charge: no automatic refund. If you still refund, do it in Paddle.',
    paddle_off: 'Paddle is not connected on the server (PADDLE_API_KEY missing).', not_paddle: 'This subscription is not in Paddle.', paddle_error: 'Paddle refused the action. Check the Paddle dashboard.' };
  // Paddle (2026-11-26): ids + dashboard links; within 30 days of the first paid charge, a full refund through Paddle
  // (AB.adminPaddleRefund = paddle-billing money_back: refund + the plan ends; asks first; once per business)
  const paddleCfg = () => ((C.BRAND || window.ADMIN_BRAND || {}).payments || {}).paddle || {};
  const dash = () => paddleCfg().env === 'production' ? 'https://vendors.paddle.com' : 'https://sandbox-vendors.paddle.com';
  const mbOpen = s => !!(s.first_paid_at && s.first_paid_transaction_id && Date.parse(s.first_paid_at) > Date.now() - 30 * 86400000);
  const err = e => { const m = (e && [e.code, e.message].filter(Boolean).join(' ')) || ''; for (const k in E) if (m.indexOf(k) !== -1) return E[k]; return C.errText(e); };
  const planName = code => ((C.PB.plans || []).find(p => p.code === code) || {}).name || code || '—';
  const planPrice = code => { const p = (C.PB.plans || []).find(x => x.code === code); return p && p.monthly_cents ? C.moneyText(p.monthly_cents) + ' per month' : ''; };
  const d8 = v => v ? C.fmtDate(v) : '—';

  // phase 2 (2026-11-25): number release after the service ended + the go-live live AI check (RPC admin_subscriptions_extra)
  let extra = {};
  const REL_ST = { scheduled: 'Scheduled', held: 'Held (dry run)', released: 'Released', canceled: 'Canceled', failed: 'Failed' };
  const REL_PILL = { scheduled: 'todo', held: 'need_help', released: 'paused', canceled: 'live', failed: 'need_help' };
  const REL_WHY = { canceled: 'Subscription canceled', trial_ended: 'Trial ended without payment' };
  const CANCEL_WHY = { resubscribed: 'Client restarted the plan', number_changed: 'The number changed', service_not_ended: 'Service did not end' };
  const AI_ST = { passed: 'Passed', failed: 'Failed', error: 'Did not run: needs manual approval' };
  // English text for the live AI check problem codes (runtime golive.py); unknown codes fall back to the backend's text
  const PROBLEM = { greeting: 'Greeting does not include the business name', details: 'Agent did not ask for the key details (ZIP / address / name / phone)',
    booking: 'Agent did not offer an appointment time', message: 'Agent did not take a message (messages-only mode)',
    offered_times: 'Agent offered times although booking is off', price: 'Agent said a price that is not on the list',
    promise: 'Agent made a promise / gave a discount', other_business: 'Agent mentioned another business' };
  const problemsOf = a => (a.problems || []).length ? a.problems.map((c, i) => PROBLEM[c] || (a.problems_he || [])[i] || c) : (a.problems_he || []);
  const AI_PILL = { passed: 'live', failed: 'need_help', error: 'need_help' };
  Object.assign(E, { no_release_scheduled: 'No release is scheduled for this client.', subscription_not_ended: 'The subscription is still active: the number cannot be released.', bad_days: 'Invalid number of days.' });
  async function loadExtra() {
    extra = {};
    if (!C.AB.adminSubscriptionsExtra) return;
    try { (await C.AB.adminSubscriptionsExtra() || []).forEach(x => { extra[x.client_id] = x; }); } catch (e) { extra = {}; }
  }
  async function load() { try { rows = await C.AB.adminSubscriptions(); loadErr = null; } catch (e) { rows = []; loadErr = err(e); } await loadExtra(); }

  // 2026-11-27 (20261129100200_us_forwarding_self_confirmed.sql): forwarding step passed without a verified forward
  function fwdUnverified(r) { const f = (extra[r.client_id] || {}).forwarding; return !!(f && f.unverified); }
  function releaseHtml(r, rel) {
    if (!rel) return '';
    const esc = C.esc, open = ['scheduled', 'held', 'failed'].indexOf(rel.status) !== -1;
    const facts = [['Number', rel.number], ['Why', REL_WHY[rel.reason] || rel.reason], ['Service ended', d8(rel.service_ended_at)],
      ['Client warning (7 days before)', rel.warned_at ? 'Sent on ' + d8(rel.warned_at) : 'Will be sent on ' + d8(rel.warn_at)],
      ['Release date', d8(rel.release_at) + (rel.force ? ' · "Release now" was pressed' : '')]];
    if (rel.postponed_count) facts.push(['Postponed', rel.postponed_count + ' times']);
    if (rel.status === 'held') facts.push(['Dry run', 'Not released because TWILIO_RELEASE_LIVE is off' + (rel.would_release ? ' (would have released: ' + rel.would_release + ')' : '')]);
    if (rel.status === 'released') facts.push(['Released on', d8(rel.released_at)]);
    if (rel.status === 'canceled') facts.push(['Canceled because', CANCEL_WHY[rel.cancel_reason] || rel.cancel_reason || '—']);
    if (rel.last_error) facts.push(['Error', rel.last_error]);
    return '<h4>Number release <span class="pill pill--' + (REL_PILL[rel.status] || 'todo') + '">' + esc(REL_ST[rel.status] || rel.status) + '</span></h4>' +
      '<dl class="kv rel" data-release="' + esc(r.client_id) + '">' + facts.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd><bdi dir="auto">' + esc(v) + '</bdi></dd>').join('') + '</dl>' +
      (open ? '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" data-postpone="' + esc(r.client_id) + '">Postpone 14 days</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-relnow="' + esc(r.client_id) + '" data-number="' + esc(rel.number) + '">Release now</button></div>' : '');
  }

  function aiHtml(g) {
    const a = g && g.ai_check; if (!a) return '';
    const esc = C.esc, tok = a.tokens || {};
    const lines = (a.transcript || []).map(t => '<div class="small"><b>' + (t.who === 'customer' ? 'Caller' : 'Agent') + ':</b> <bdi dir="ltr" lang="en">' + esc(t.text) + '</bdi>' +
      (t.model_text ? '<br><span class="muted">The model wrote (fixed by the guard): <bdi dir="ltr" lang="en">' + esc(t.model_text) + '</bdi></span>' : '') + '</div>').join('');
    return '<div class="aichk" data-aicheck="' + esc(a.status) + '"><b>Test call with the real model</b> <span class="pill pill--' + (AI_PILL[a.status] || 'todo') + '">' + esc(AI_ST[a.status] || a.status) + '</span>' +
      (problemsOf(a).length ? '<div class="small aiprob">' + problemsOf(a).map(p => '<div>• ' + esc(p) + '</div>').join('') + '</div>' : '') +
      (a.error ? '<br><span class="small">Error: <bdi dir="ltr">' + esc(a.error) + '</bdi></span>' : '') +
      '<br><span class="muted small">Attempts: ' + esc(a.attempts || 0) + ' · model calls: ' + esc(a.model_calls || 0) + ' · tokens: <bdi dir="ltr">' + esc((tok.input_tokens || 0) + ' in / ' + (tok.output_tokens || 0) + ' out') + '</bdi>' +
      ' · estimated cost: <bdi dir="ltr">$' + esc(Number(a.cost_usd || 0).toFixed(4)) + '</bdi></span>' +
      (lines ? '<details class="aitx"><summary class="small">Call transcript</summary>' + lines + '</details>' : '') + '</div>';
  }

  function render(p, ctx) {
    C = ctx;
    p.innerHTML = '<section class="card" aria-labelledby="subsH"><div class="row"><h2 id="subsH">FirstRing subscriptions</h2>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="subsReload">Refresh</button></div>' +
      '<p class="muted small">All automatic: sign-up → tenant + checklist → number purchase (dry run while TWILIO_PROVISION_LIVE is off) → client fills in → simulator check → go-live. Here you see what got stuck and press "Retry".</p>' +
      '<div id="subsBody"><p class="muted">Loading…</p></div></section>';
    C.$('#subsReload').addEventListener('click', async () => { await load(); draw(); });
    load().then(draw);
  }

  function jobHtml(r, j) {
    const esc = C.esc;
    return '<li class="sjob"><span class="grow"><b>' + esc(JOB[j.kind] || j.kind) + '</b> <span class="pill pill--' + (JOB_PILL[j.status] || 'todo') + '">' + esc(JOB_ST[j.status] || j.status) + '</span>' +
      (j.dry_run ? ' <span class="pill pill--todo">Dry run</span>' : '') +
      (j.number ? ' <bdi dir="ltr" class="mono">' + esc(j.number) + '</bdi>' : '') +
      (j.kind === 'golive_sim' && j.failed && j.failed.length ? '<br><span class="small">Failed: <bdi dir="ltr">' + esc(j.failed.join(', ')) + '</bdi></span>' : '') +
      (j.last_error ? '<br><span class="small">Error: <bdi dir="ltr">' + esc(j.last_error) + '</bdi></span>' : '') +
      '<br><span class="muted small">Attempts: ' + esc(j.attempts || 0) + ' · updated ' + esc(d8(j.updated_at)) + '</span>' +
      (j.kind === 'golive_sim' ? aiHtml((extra[r.client_id] || {}).golive) : '') + '</span>' +
      (j.status !== 'running' ? '<button type="button" class="btn btn--ghost btn--sm" data-retry="' + esc(j.kind) + '" data-client="' + esc(r.client_id) + '">' + (j.kind === 'golive_sim' ? 'Run the check again' : 'Retry') + '</button>' : '') + '</li>';
  }

  function draw() {
    const esc = C.esc, box = C.$('#subsBody'); if (!box) return;
    if (loadErr) { box.innerHTML = '<div class="notice notice--err" role="alert"><div>' + esc(loadErr) + '</div></div>'; return; }
    if (!rows.length) { box.innerHTML = '<p class="empty">No subscriptions yet.</p>'; return; }
    box.innerHTML = '<ul class="subs">' + rows.map(r => {
      const s = r.subscription || {}, t = r.tenant || null, mm = t && t.service === 'message_only';
      const facts = [['Plan', planName(s.plan_code) + (planPrice(s.plan_code) ? ' · ' + planPrice(s.plan_code) : '') + (s.scheduled_plan_code ? ' (moves to ' + planName(s.scheduled_plan_code) + ' next period)' : '')],
        ['Subscription status', SUB_ST[s.status] || s.status], ['Trial until', d8(s.trial_ends_at)], ['Current period until', d8(s.current_period_end) + (s.cancel_at_period_end ? ' · cancels at period end' : '')],
        ['Card on file', s.card_on_file ? 'Yes' : 'No'], ['Payment provider', (s.provider || '') + (s.provider_subscription_id ? ' · ' + s.provider_subscription_id : '')],
        ['Line mode', !t ? 'No tenant yet' : mm ? 'Messages only (' + (WHY[t.service_reason] || t.service_reason) + ')' : 'Full answering'],
        ['Tenant', t ? t.slug + ' · ' + (t.twilio_number || 'no number') : '—'], ['Checklist', (r.checklist || {}).done + ' of ' + (r.checklist || {}).required + ' required steps'],
        ['Money-back (30 days)', r.money_back_used_at ? 'Used on ' + d8(r.money_back_used_at) + (s.money_back_refund_id ? ' · ' + s.money_back_refund_id : '')
          : s.first_paid_at ? 'Not used · first charge ' + d8(s.first_paid_at) + (mbOpen(s) ? ' · open until ' + d8(new Date(Date.parse(s.first_paid_at) + 30 * 86400000).toISOString()) : ' · window closed') : 'Not used · no charge yet']];
      const pad = s.provider === 'paddle';
      if (pad) facts.push(['Paddle', 'subscription ' + (s.provider_subscription_id || '—') + ' · customer ' + (s.provider_customer_id || '—')]);
      return '<li class="card sub" data-sub="' + esc(r.client_id) + '"><div class="row"><h3>' + esc(r.business_name || r.email || '—') + '</h3>' +
        '<span class="pill pill--' + (SUB_PILL[s.status] || 'todo') + '">' + esc(SUB_ST[s.status] || s.status) + '</span>' + C.pill('client', r.client_status) +
        (s.trial_duplicate ? '<span class="pill pill--need_help">Second trial for the same phone</span>' : '') + (mm ? '<span class="pill pill--paused">Messages only</span>' : '') +
        (fwdUnverified(r) ? '<span class="pill pill--pending" data-fwd-unverified title="The test call came without carrier forwarding data: call the business line to check">Forwarding unverified (self-confirmed)</span>' : '') + '</div>' +
        '<p class="muted small"><bdi dir="ltr">' + esc(r.email || '') + '</bdi></p>' +
        '<dl class="kv">' + facts.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd><bdi dir="auto">' + esc(v) + '</bdi></dd>').join('') + '</dl>' +
        (pad ? '<p class="small plan-ids"><a href="' + esc(dash() + '/subscriptions-v2/' + encodeURIComponent(s.provider_subscription_id || '')) + '" target="_blank" rel="noopener" data-paddle-link>Open subscription in Paddle</a>' +
          (s.provider_customer_id ? ' · <a href="' + esc(dash() + '/customers-v2/' + encodeURIComponent(s.provider_customer_id)) + '" target="_blank" rel="noopener">Customer in Paddle</a>' : '') +
          (s.last_payment_failed_at ? ' · <b>Payment failed ' + esc(d8(s.last_payment_failed_at)) + '</b>' : '') + '</p>' : '') +
        '<h4>Automatic setup</h4><ul class="plist sjobs">' + ((r.jobs || []).length ? r.jobs.map(j => jobHtml(r, j)).join('') : '<li class="muted small">No jobs yet.</li>') + '</ul>' +
        releaseHtml(r, (extra[r.client_id] || {}).release) +
        '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" data-retry="setup" data-client="' + esc(r.client_id) + '">Retry: setup</button>' +
        (t && t.twilio_number && r.client_status !== 'live' ? '<button type="button" class="btn btn--ghost btn--sm" data-golive="' + esc(r.client_id) + '">Go live manually</button>' : '') +
        (!r.money_back_used_at && pad && mbOpen(s) ? '<button type="button" class="btn btn--ghost btn--sm" data-paddlerefund="' + esc(r.client_id) + '">Refund in Paddle (30 days)</button>' : '') +
        (r.money_back_used_at ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-moneyback="' + esc(r.client_id) + '">Mark: money refunded (30 days)</button>') +
        (t ? '<button type="button" class="btn btn--ghost btn--sm" data-tenant="' + esc(t.id) + '">Open tenant editor</button>' : '') + '</div>' +
        '<div class="smsg" id="smsg-' + esc(r.client_id) + '" aria-live="polite"></div></li>';
    }).join('') + '</ul>';
    const say = (cid, text, ok) => { const el = C.$('#smsg-' + cid); if (el) el.innerHTML = '<div class="notice ' + (ok ? 'notice--ok' : 'notice--err') + '" role="' + (ok ? 'status' : 'alert') + '"><div>' + C.esc(text) + '</div></div>'; };
    const act = (sel, fn, okText, ask) => C.$$(sel, box).forEach(b => b.addEventListener('click', async () => {
      const cid = b.dataset.client || b.dataset.golive || b.dataset.moneyback || b.dataset.postpone || b.dataset.relnow || b.dataset.paddlerefund;
      if (ask && !confirm(typeof ask === 'function' ? ask(b) : ask)) return;
      b.disabled = true;
      try { await fn(b); C.toast(okText); await load(); draw(); } catch (e) { b.disabled = false; say(cid, err(e)); }
    }));
    act('[data-retry]', b => C.AB.adminRetryProvisioning(b.dataset.client, b.dataset.retry), 'Sent again. The runtime picks it up on its next pass (up to 10 minutes).');
    act('[data-golive]', b => C.AB.adminForceGolive(b.dataset.golive), 'The client is live.', 'Go live without waiting for the automatic check?');
    act('[data-paddlerefund]', b => C.AB.adminPaddleRefund(b.dataset.paddlerefund), 'Refund sent to Paddle and the plan has ended. Paddle approves refunds shortly.',
      'Refund the full first charge to the client through Paddle and end the plan now?\n(Once per business, up to 30 days after the first charge. This cannot be undone.)');
    act('[data-moneyback]', b => C.AB.adminMarkMoneyBack(b.dataset.moneyback), 'Recorded: money-back used.', 'Record that the client got the 30-day refund? (The refund itself is done in the payment provider.)');
    act('[data-postpone]', b => C.AB.adminPostponeNumberRelease(b.dataset.postpone, 14), 'Release postponed 14 days. The client gets a new warning before the new date.');
    act('[data-relnow]', b => C.AB.adminReleaseNumberNow(b.dataset.relnow), 'Sent for release. The runtime releases it on its next pass (dry run: only recorded, and you get an email).',
      b => 'Release the number ' + b.dataset.number + ' now?\nThe client will not be able to get calls on this number, and it cannot be brought back.\n(While TWILIO_RELEASE_LIVE is off: only recorded, nothing is released.)');
    C.$$('[data-tenant]', box).forEach(b => b.addEventListener('click', () => C.go('tenants', b.dataset.tenant)));
  }

  window.AdminSubscriptions = { render };
})();
