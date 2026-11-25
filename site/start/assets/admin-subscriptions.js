/* Admin "מנויים" tab (FirstRing monthly plans, 2026-11-25; Hebrew, RTL). Rendered by admin.js -> tSubs() ->
   AdminSubscriptions.render(panel, ctx). Data: AB.adminSubscriptions() = RPC admin_subscriptions (admin only): each
   subscription with its plan, trial / period dates, card, provider, service mode (full / message mode + why), tenant, the
   automatic setup jobs (number purchase, go-live check) and checklist progress. Buttons: retry a job / the whole setup
   (admin_retry_provisioning), manual go-live (admin_force_golive), record the 30-day money-back (admin_mark_money_back).
   Plan names and prices come from the price book (ctx.PB.plans), never typed here.
   Phase 2 (2026-11-25): AB.adminSubscriptionsExtra = RPC admin_subscriptions_extra: the number release after the service
   ended (scheduled date, warning, dry run) with "postpone 14 days" (admin_postpone_number_release) and "release now"
   (admin_release_number_now, asks first), and the go-live live AI check (status, problems, cost estimate, transcript). */
(function () {
  let C = null, rows = [], loadErr = null;
  const SUB_ST = { trialing: 'ניסיון חינם', active: 'פעיל', past_due: 'תשלום נכשל', paused: 'מושהה', canceled: 'בוטל' };
  const SUB_PILL = { trialing: 'testing', active: 'live', past_due: 'need_help', paused: 'paused', canceled: 'cancelled' };
  const JOB = { number: 'מספר טלפון', golive_sim: 'בדיקת עלייה לאוויר' };
  const JOB_ST = { pending: 'ממתין לריצה', running: 'רץ עכשיו', done: 'הושלם', failed: 'נכשל', held: 'מוחזק' };
  const JOB_PILL = { pending: 'todo', running: 'todo', done: 'live', failed: 'need_help', held: 'need_help' };
  const WHY = { trial_ended: 'הניסיון נגמר בלי תשלום', canceled: 'בוטל', past_due: 'תשלום נכשל (אחרי תקופת חסד)', paused: 'מושהה', '': '' };
  const E = { not_admin: 'אין לך הרשאת ניהול.', no_number: 'אין עדיין מספר טלפון ללקוח.', no_tenant: 'אין tenant ללקוח.',
    no_subscription: 'אין מנוי ללקוח.', money_back_already_used: 'ההחזר הכספי כבר נוצל לעסק הזה.',
    money_back_window_closed: 'עברו יותר מ-30 יום מהחיוב הראשון: אין החזר אוטומטי. אם בכל זאת מחזירים, עושים את זה ב-Paddle.',
    paddle_off: 'Paddle לא מחובר בשרת (חסר PADDLE_API_KEY).', not_paddle: 'המנוי הזה לא ב-Paddle.', paddle_error: 'Paddle סירב לפעולה. לבדוק בלוח הבקרה של Paddle.' };
  // Paddle (2026-11-26): ids + dashboard links; within 30 days of the first paid charge, a full refund through Paddle
  // (AB.adminPaddleRefund = paddle-billing money_back: refund + the plan ends; asks first; once per business)
  const paddleCfg = () => ((C.BRAND || window.ADMIN_BRAND || {}).payments || {}).paddle || {};
  const dash = () => paddleCfg().env === 'production' ? 'https://vendors.paddle.com' : 'https://sandbox-vendors.paddle.com';
  const mbOpen = s => !!(s.first_paid_at && s.first_paid_transaction_id && Date.parse(s.first_paid_at) > Date.now() - 30 * 86400000);
  const err = e => { const m = (e && (e.code || e.message)) || ''; for (const k in E) if (m.indexOf(k) !== -1) return E[k]; return C.errText(e); };
  const planName = code => ((C.PB.plans || []).find(p => p.code === code) || {}).name || code || '—';
  const planPrice = code => { const p = (C.PB.plans || []).find(x => x.code === code); return p && p.monthly_cents ? C.moneyText(p.monthly_cents) + ' לחודש' : ''; };
  const d8 = v => v ? C.fmtDate(v) : '—';

  // phase 2 (2026-11-25): number release after the service ended + the go-live live AI check (RPC admin_subscriptions_extra)
  let extra = {};
  const REL_ST = { scheduled: 'מתוזמן', held: 'מוחזק (מצב ניסוי)', released: 'שוחרר', canceled: 'בוטל', failed: 'נכשל' };
  const REL_PILL = { scheduled: 'todo', held: 'need_help', released: 'paused', canceled: 'live', failed: 'need_help' };
  const REL_WHY = { canceled: 'המנוי בוטל', trial_ended: 'הניסיון נגמר בלי תשלום' };
  const CANCEL_WHY = { resubscribed: 'הלקוח חידש את המנוי', number_changed: 'המספר השתנה', service_not_ended: 'השירות לא הסתיים' };
  const AI_ST = { passed: 'עברה', failed: 'נכשלה', error: 'לא רצה: צריך אישור ידני' };
  const AI_PILL = { passed: 'live', failed: 'need_help', error: 'need_help' };
  Object.assign(E, { no_release_scheduled: 'אין שחרור מתוזמן ללקוח הזה.', subscription_not_ended: 'המנוי עדיין פעיל: אי אפשר לשחרר את המספר.', bad_days: 'מספר ימים לא תקין.' });
  async function loadExtra() {
    extra = {};
    if (!C.AB.adminSubscriptionsExtra) return;
    try { (await C.AB.adminSubscriptionsExtra() || []).forEach(x => { extra[x.client_id] = x; }); } catch (e) { extra = {}; }
  }
  async function load() { try { rows = await C.AB.adminSubscriptions(); loadErr = null; } catch (e) { rows = []; loadErr = err(e); } await loadExtra(); }

  function releaseHtml(r, rel) {
    if (!rel) return '';
    const esc = C.esc, open = ['scheduled', 'held', 'failed'].indexOf(rel.status) !== -1;
    const facts = [['מספר', rel.number], ['למה', REL_WHY[rel.reason] || rel.reason], ['השירות הסתיים', d8(rel.service_ended_at)],
      ['אזהרה ללקוח (7 ימים לפני)', rel.warned_at ? 'נשלחה ב-' + d8(rel.warned_at) : 'תישלח ב-' + d8(rel.warn_at)],
      ['תאריך שחרור', d8(rel.release_at) + (rel.force ? ' · "שחרר עכשיו" נלחץ' : '')]];
    if (rel.postponed_count) facts.push(['נדחה', rel.postponed_count + ' פעמים']);
    if (rel.status === 'held') facts.push(['מצב ניסוי', 'לא שוחרר כי TWILIO_RELEASE_LIVE כבוי' + (rel.would_release ? ' (היה משוחרר: ' + rel.would_release + ')' : '')]);
    if (rel.status === 'released') facts.push(['שוחרר ב-', d8(rel.released_at)]);
    if (rel.status === 'canceled') facts.push(['בוטל כי', CANCEL_WHY[rel.cancel_reason] || rel.cancel_reason || '—']);
    if (rel.last_error) facts.push(['שגיאה', rel.last_error]);
    return '<h4>שחרור מספר <span class="pill pill--' + (REL_PILL[rel.status] || 'todo') + '">' + esc(REL_ST[rel.status] || rel.status) + '</span></h4>' +
      '<dl class="kv rel" data-release="' + esc(r.client_id) + '">' + facts.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd><bdi dir="auto">' + esc(v) + '</bdi></dd>').join('') + '</dl>' +
      (open ? '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" data-postpone="' + esc(r.client_id) + '">דחה ב-14 יום</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-relnow="' + esc(r.client_id) + '" data-number="' + esc(rel.number) + '">שחרר עכשיו</button></div>' : '');
  }

  function aiHtml(g) {
    const a = g && g.ai_check; if (!a) return '';
    const esc = C.esc, tok = a.tokens || {};
    const lines = (a.transcript || []).map(t => '<div class="small"><b>' + (t.who === 'customer' ? 'מתקשר' : 'סוכן') + ':</b> <bdi dir="ltr" lang="en">' + esc(t.text) + '</bdi>' +
      (t.model_text ? '<br><span class="muted">המודל כתב (תוקן ע"י השומר): <bdi dir="ltr" lang="en">' + esc(t.model_text) + '</bdi></span>' : '') + '</div>').join('');
    return '<div class="aichk" data-aicheck="' + esc(a.status) + '"><b>שיחת בדיקה עם המודל האמיתי</b> <span class="pill pill--' + (AI_PILL[a.status] || 'todo') + '">' + esc(AI_ST[a.status] || a.status) + '</span>' +
      ((a.problems_he || []).length ? '<div class="small aiprob">' + a.problems_he.map(p => '<div>• ' + esc(p) + '</div>').join('') + '</div>' : '') +
      (a.error ? '<br><span class="small">שגיאה: <bdi dir="ltr">' + esc(a.error) + '</bdi></span>' : '') +
      '<br><span class="muted small">ניסיונות: ' + esc(a.attempts || 0) + ' · קריאות למודל: ' + esc(a.model_calls || 0) + ' · טוקנים: <bdi dir="ltr">' + esc((tok.input_tokens || 0) + ' in / ' + (tok.output_tokens || 0) + ' out') + '</bdi>' +
      ' · עלות משוערת: <bdi dir="ltr">$' + esc(Number(a.cost_usd || 0).toFixed(4)) + '</bdi></span>' +
      (lines ? '<details class="aitx"><summary class="small">תמליל השיחה</summary>' + lines + '</details>' : '') + '</div>';
  }

  function render(p, ctx) {
    C = ctx;
    p.innerHTML = '<section class="card" aria-labelledby="subsH"><div class="row"><h2 id="subsH">מנויי FirstRing</h2>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="subsReload">רענון</button></div>' +
      '<p class="muted small">הכל אוטומטי: הרשמה ← tenant + צ\'ק-ליסט ← קניית מספר (במצב ניסוי כל עוד TWILIO_PROVISION_LIVE כבוי) ← הלקוח ממלא ← בדיקת סימולטור ← עלייה לאוויר. כאן רואים מה נתקע, ולוחצים "נסה שוב".</p>' +
      '<div id="subsBody"><p class="muted">טוען…</p></div></section>';
    C.$('#subsReload').addEventListener('click', async () => { await load(); draw(); });
    load().then(draw);
  }

  function jobHtml(r, j) {
    const esc = C.esc;
    return '<li class="sjob"><span class="grow"><b>' + esc(JOB[j.kind] || j.kind) + '</b> <span class="pill pill--' + (JOB_PILL[j.status] || 'todo') + '">' + esc(JOB_ST[j.status] || j.status) + '</span>' +
      (j.dry_run ? ' <span class="pill pill--todo">מצב ניסוי</span>' : '') +
      (j.number ? ' <bdi dir="ltr" class="mono">' + esc(j.number) + '</bdi>' : '') +
      (j.kind === 'golive_sim' && j.failed && j.failed.length ? '<br><span class="small">נכשלו: <bdi dir="ltr">' + esc(j.failed.join(', ')) + '</bdi></span>' : '') +
      (j.last_error ? '<br><span class="small">שגיאה: <bdi dir="ltr">' + esc(j.last_error) + '</bdi></span>' : '') +
      '<br><span class="muted small">ניסיונות: ' + esc(j.attempts || 0) + ' · עודכן ' + esc(d8(j.updated_at)) + '</span>' +
      (j.kind === 'golive_sim' ? aiHtml((extra[r.client_id] || {}).golive) : '') + '</span>' +
      (j.status !== 'running' ? '<button type="button" class="btn btn--ghost btn--sm" data-retry="' + esc(j.kind) + '" data-client="' + esc(r.client_id) + '">' + (j.kind === 'golive_sim' ? 'הרץ שוב את הבדיקה' : 'נסה שוב') + '</button>' : '') + '</li>';
  }

  function draw() {
    const esc = C.esc, box = C.$('#subsBody'); if (!box) return;
    if (loadErr) { box.innerHTML = '<div class="notice notice--err" role="alert"><div>' + esc(loadErr) + '</div></div>'; return; }
    if (!rows.length) { box.innerHTML = '<p class="empty">אין מנויים עדיין.</p>'; return; }
    box.innerHTML = '<ul class="subs">' + rows.map(r => {
      const s = r.subscription || {}, t = r.tenant || null, mm = t && t.service === 'message_only';
      const facts = [['חבילה', planName(s.plan_code) + (planPrice(s.plan_code) ? ' · ' + planPrice(s.plan_code) : '') + (s.scheduled_plan_code ? ' (יורד ל-' + planName(s.scheduled_plan_code) + ' בתקופה הבאה)' : '')],
        ['סטטוס מנוי', SUB_ST[s.status] || s.status], ['ניסיון עד', d8(s.trial_ends_at)], ['תקופה נוכחית עד', d8(s.current_period_end) + (s.cancel_at_period_end ? ' · מבוטל בסוף התקופה' : '')],
        ['כרטיס אשראי שמור', s.card_on_file ? 'כן' : 'לא'], ['ספק תשלום', (s.provider || '') + (s.provider_subscription_id ? ' · ' + s.provider_subscription_id : '')],
        ['מצב הקו', !t ? 'אין tenant עדיין' : mm ? 'הודעות בלבד (' + (WHY[t.service_reason] || t.service_reason) + ')' : 'מענה מלא'],
        ['Tenant', t ? t.slug + ' · ' + (t.twilio_number || 'בלי מספר') : '—'], ['צ\'ק-ליסט', (r.checklist || {}).done + ' מתוך ' + (r.checklist || {}).required + ' שלבי חובה'],
        ['החזר כספי (30 יום)', r.money_back_used_at ? 'נוצל ב-' + d8(r.money_back_used_at) + (s.money_back_refund_id ? ' · ' + s.money_back_refund_id : '')
          : s.first_paid_at ? 'לא נוצל · חיוב ראשון ' + d8(s.first_paid_at) + (mbOpen(s) ? ' · פתוח עד ' + d8(new Date(Date.parse(s.first_paid_at) + 30 * 86400000).toISOString()) : ' · החלון נסגר') : 'לא נוצל · עוד אין חיוב']];
      const pad = s.provider === 'paddle';
      if (pad) facts.push(['Paddle', 'מנוי ' + (s.provider_subscription_id || '—') + ' · לקוח ' + (s.provider_customer_id || '—')]);
      return '<li class="card sub" data-sub="' + esc(r.client_id) + '"><div class="row"><h3>' + esc(r.business_name || r.email || '—') + '</h3>' +
        '<span class="pill pill--' + (SUB_PILL[s.status] || 'todo') + '">' + esc(SUB_ST[s.status] || s.status) + '</span>' + C.pill('client', r.client_status) +
        (s.trial_duplicate ? '<span class="pill pill--need_help">ניסיון שני לאותו טלפון</span>' : '') + (mm ? '<span class="pill pill--paused">הודעות בלבד</span>' : '') + '</div>' +
        '<p class="muted small"><bdi dir="ltr">' + esc(r.email || '') + '</bdi></p>' +
        '<dl class="kv">' + facts.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd><bdi dir="auto">' + esc(v) + '</bdi></dd>').join('') + '</dl>' +
        (pad ? '<p class="small plan-ids"><a href="' + esc(dash() + '/subscriptions-v2/' + encodeURIComponent(s.provider_subscription_id || '')) + '" target="_blank" rel="noopener" data-paddle-link>פתח את המנוי ב-Paddle</a>' +
          (s.provider_customer_id ? ' · <a href="' + esc(dash() + '/customers-v2/' + encodeURIComponent(s.provider_customer_id)) + '" target="_blank" rel="noopener">הלקוח ב-Paddle</a>' : '') +
          (s.last_payment_failed_at ? ' · <b>תשלום נכשל ' + esc(d8(s.last_payment_failed_at)) + '</b>' : '') + '</p>' : '') +
        '<h4>הקמה אוטומטית</h4><ul class="plist sjobs">' + ((r.jobs || []).length ? r.jobs.map(j => jobHtml(r, j)).join('') : '<li class="muted small">אין עבודות עדיין.</li>') + '</ul>' +
        releaseHtml(r, (extra[r.client_id] || {}).release) +
        '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" data-retry="setup" data-client="' + esc(r.client_id) + '">נסה שוב: הקמה</button>' +
        (t && t.twilio_number && r.client_status !== 'live' ? '<button type="button" class="btn btn--ghost btn--sm" data-golive="' + esc(r.client_id) + '">העלה לאוויר ידנית</button>' : '') +
        (!r.money_back_used_at && pad && mbOpen(s) ? '<button type="button" class="btn btn--ghost btn--sm" data-paddlerefund="' + esc(r.client_id) + '">החזר כספי ב-Paddle (30 יום)</button>' : '') +
        (r.money_back_used_at ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-moneyback="' + esc(r.client_id) + '">סמן: הוחזר כסף (30 יום)</button>') +
        (t ? '<button type="button" class="btn btn--ghost btn--sm" data-tenant="' + esc(t.id) + '">לעורך ה-tenant</button>' : '') + '</div>' +
        '<div class="smsg" id="smsg-' + esc(r.client_id) + '" aria-live="polite"></div></li>';
    }).join('') + '</ul>';
    const say = (cid, text, ok) => { const el = C.$('#smsg-' + cid); if (el) el.innerHTML = '<div class="notice ' + (ok ? 'notice--ok' : 'notice--err') + '" role="' + (ok ? 'status' : 'alert') + '"><div>' + C.esc(text) + '</div></div>'; };
    const act = (sel, fn, okText, ask) => C.$$(sel, box).forEach(b => b.addEventListener('click', async () => {
      const cid = b.dataset.client || b.dataset.golive || b.dataset.moneyback || b.dataset.postpone || b.dataset.relnow || b.dataset.paddlerefund;
      if (ask && !confirm(typeof ask === 'function' ? ask(b) : ask)) return;
      b.disabled = true;
      try { await fn(b); C.toast(okText); await load(); draw(); } catch (e) { b.disabled = false; say(cid, err(e)); }
    }));
    act('[data-retry]', b => C.AB.adminRetryProvisioning(b.dataset.client, b.dataset.retry), 'נשלח שוב. ה-runtime ירוץ בסבב הבא (עד 10 דקות).');
    act('[data-golive]', b => C.AB.adminForceGolive(b.dataset.golive), 'הלקוח עלה לאוויר.', 'להעלות לאוויר בלי לחכות לבדיקה האוטומטית?');
    act('[data-paddlerefund]', b => C.AB.adminPaddleRefund(b.dataset.paddlerefund), 'ההחזר נשלח ל-Paddle והמנוי הסתיים. Paddle מאשר החזרים תוך זמן קצר.',
      'להחזיר ללקוח את כל החיוב הראשון דרך Paddle ולסיים את המנוי עכשיו?\n(פעם אחת לעסק, עד 30 יום מהחיוב הראשון. אי אפשר לבטל.)');
    act('[data-moneyback]', b => C.AB.adminMarkMoneyBack(b.dataset.moneyback), 'נרשם שההחזר נוצל.', 'לרשום שהלקוח קיבל את ההחזר של 30 יום? (ההחזר עצמו נעשה בספק התשלום)');
    act('[data-postpone]', b => C.AB.adminPostponeNumberRelease(b.dataset.postpone, 14), 'השחרור נדחה ב-14 יום. הלקוח יקבל אזהרה חדשה לפני התאריך החדש.');
    act('[data-relnow]', b => C.AB.adminReleaseNumberNow(b.dataset.relnow), 'נשלח לשחרור. ה-runtime ישחרר בסבב הבא (במצב ניסוי: רק נרשם ותקבל מייל).',
      b => 'לשחרר עכשיו את המספר ' + b.dataset.number + '?\nהלקוח לא יוכל לקבל שיחות במספר הזה, ואי אפשר להחזיר אותו.\n(כל עוד TWILIO_RELEASE_LIVE כבוי: רק נרשם, שום דבר לא משתחרר.)');
    C.$$('[data-tenant]', box).forEach(b => b.addEventListener('click', () => C.go('tenants', b.dataset.tenant)));
  }

  window.AdminSubscriptions = { render };
})();
