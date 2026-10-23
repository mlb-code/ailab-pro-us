/* /start/ portal phase B (task B7): Setup checklist (onboarding), My receptionist, Requests, and the usage card on Billing.
   Loaded after home.js's dependencies; home.js asks window.PortalB for extra tabs once the client has a `clients` row.
   Data only through window.Backend (mock or Supabase, same method names). Tenant settings are validated against
   /assets/tenant_schema.json (TenantSchema, a copy of runtime/app/tenant_schema.json) and written ONLY through
   Backend.updateTenantSettings = the update_tenant_settings RPC (whitelist of 6 keys: hours, faq, notify, paused,
   after_hours, on_call_number). Everything else (time zone, emergency words, calendar link, services, SMS registration, ...)
   is saved as the checklist item's data (update_onboarding_item RPC) and merged into the tenant config by the owner in
   the admin. The go-live request is gated on the server too (private.onboarding_go_live_gate).
   Client-facing text: US English. No prices or brand strings typed here (pricebook/brand JSON only). */
(function () {
  const S = window.Start, B = window.Backend, TS = window.TenantSchema, Q = window.StartQ;
  const esc = s => S.esc(s);
  const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  const OB_STATUS = { todo: 'To do', done: 'Done', need_help: 'Help requested' };
  const OUTCOME = { booked: 'Booked', message: 'Message taken', handoff: 'Transferred', emergency: 'Emergency', spam: 'Spam / silent', abandoned: 'Hung up early' };
  const REQ_STATUS = { queued: 'In queue', active: 'In progress', waiting_on_you: 'Waiting on you', done: 'Done', declined: 'Closed' };
  // video slot per step: data-video = slot id (video_url fills it), data-script = the B11 script that covers the step
  // video slot per step: data-video = slot id (video_url fills it), data-script = the folder in videos/ whose script.md covers it
  const VIDEO_SCRIPT = { forward_calls: '02-call-forwarding', calendar: '03-connect-calendar', hours: '04-hours-faq-alerts', faq: '04-hours-faq-alerts',
    alerts: '04-hours-faq-alerts', tools: '06-connect-other-tools', sms: '05-sms-registration', web_content: '09-website-handoff' };
  const AFTER_HOURS = [['book_next_day', 'Book the next open slot'], ['message_only', 'Take a message only'], ['emergency_dial', 'Take a message, and call my on-call number for emergencies']];
  const CALENDLY_RX = /^https:\/\/calendly\.com\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\/?$/;
  const EIN_RX = /^[0-9]{2}-?[0-9]{7}$/;
  const EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'pdf', 'txt', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'zip'];
  // carrier instructions for "forward when busy / no answer". {n} = 10-digit forwarding number, {N} = 1 + number
  const CARRIERS = [
    ['verizon', 'Verizon', ['On your business phone, dial <b class="mono">*71{n}</b> and press Call. Wait for the confirmation tone, then hang up.', 'To turn it off later: dial <b class="mono">*73</b>.']],
    // AT&T publishes no dial codes: forwarding is set in the phone itself (att.com/support/article/wireless/KM1011513,
    // Android path from att.com/device-support/article/140337/Google/pixel-10). iOS has only "forward all calls".
    ['att', 'AT&T', ['AT&T sets this in your phone, not with a dial code. <b>Android:</b> Phone app → Settings → Calling accounts → your SIM → Call forwarding. Turn on <b>When unanswered</b> and <b>When busy</b> (and <b>When unreachable</b>) and enter <b class="mono">{fmt}</b> for each.', 'Leave <b>Always forward</b> off, so your phone still rings first.', '<b>iPhone:</b> Settings → Phone → Call Forwarding forwards <i>every</i> call. For “busy / no answer” only, use “Need help with this step?” below and we’ll set it up with you.', 'To turn it off later: switch the same options off.']],
    ['tmobile', 'T-Mobile', ['Dial <b class="mono">**61*{N}#</b> (no answer), then <b class="mono">**67*{N}#</b> (busy) and <b class="mono">**62*{N}#</b> (unreachable). Press Call after each.', 'To turn it off later: dial <b class="mono">##004#</b>.']],
    // Comcast Business VoiceEdge star codes (Comcast sheet SLS90624, 2018): busy *90 / off *91, no answer *92 / off *93.
    ['comcast', 'Comcast Business', ['On your Comcast Business (VoiceEdge) phone, dial <b class="mono">*92</b>, then <b class="mono">{n}</b> (no answer). Then dial <b class="mono">*90</b>, then <b class="mono">{n}</b> (busy). Wait for the confirmation after each.', 'Or in the Comcast Business app / VoiceEdge portal: Call Forwarding → turn on <b>No Answer</b> and <b>Busy</b>, forward to <b class="mono">{fmt}</b>. Save.', 'To turn it off later: dial <b class="mono">*93</b> (no answer) and <b class="mono">*91</b> (busy).', 'Other Comcast Business phone products use their own guide: use “Need help with this step?” if these don’t match your phone.']],
    ['ringcentral', 'RingCentral', ['In the RingCentral admin portal open your number → Call Handling & Forwarding.', 'Under “When no one answers”, forward to the external number <b class="mono">{fmt}</b>. Save.']],
    ['googlevoice', 'Google Voice', ['Google Voice can’t pass unanswered calls to another number on every plan.', 'Use “Need help with this step?” below and we’ll work it out with you in writing.']],
    ['other', 'Other / not sure', ['Look for “conditional call forwarding” or “forward when busy / no answer” in your phone provider’s settings or support pages.', 'Forward to <b class="mono">{fmt}</b>.']]];
  const SMS_CONSENT = 'I confirm that my business will text only people who contacted us first (a call or a text), to reply about their request, confirm a booking and send one reminder — no marketing. Every first message names my business and says “Reply STOP to opt out”, and anyone who replies STOP gets no more texts. I am responsible for my business’s use of text messages under the Service Agreement.';

  let state = { open: null, testPoll: null, calendarReturn: null };

  // ------------------------------------------------------------ data
  const isRcp = d => !!(d.client && (d.client.products || []).some(p => p === 'RCP' || p === 'BNDL'));
  async function load(d) {
    Object.assign(d, { ob: [], tenant: null, requests: [], usage: null, calls: [], sms: [], bookings: [], reqFiles: {} });
    if (!d.client) return d;
    try { await TS.load(); d.schemaOk = true; } catch (e) { d.schemaOk = false; }
    const [ob, tenant, reqs] = await Promise.all([B.listOnboarding(), B.getTenant().catch(() => null), B.listRequests()]);
    d.ob = (ob || []).filter(o => o.client_id === d.client.id || !o.client_id); d.tenant = tenant; d.requests = reqs || [];
    if (tenant && isRcp(d)) {
      const [usage, calls, sms, bookings] = await Promise.all([B.getUsage(tenant.id).catch(() => null), B.listCalls(tenant.id), B.listSms(tenant.id), B.listBookings(tenant.id)]);
      Object.assign(d, { usage, calls: calls || [], sms: sms || [], bookings: bookings || [] });
    }
    return d;
  }
  function tabs(d) {
    if (!d.client) return [];
    const t = [];
    if (d.ob.length) t.push(['onboarding', d.client.status === 'live' ? 'Setup' : 'Setup checklist', onboardingHtml]);
    if (isRcp(d) && d.tenant && ['testing', 'live', 'paused'].indexOf(d.client.status) !== -1) t.push(['receptionist', 'My receptionist', receptionistHtml]);
    t.push(['requests', 'Requests', requestsHtml]);
    return t;
  }

  // ------------------------------------------------------------ small helpers
  function toE164(s) {
    s = String(s || '').trim(); if (!s) return null;
    const digits = s.replace(/\D/g, '');
    if (s.charAt(0) === '+') return '+' + digits;
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
    return 'invalid:' + s;
  }
  const fmtPhone = e => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (e || ''); };
  const list = s => String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  const tz = d => (d.tenant && d.tenant.config && d.tenant.config.business && d.tenant.config.business.timezone) || (window.__profileTz || undefined);
  const when = (iso, d) => S.fmtDate(iso, true, tz(d));
  const pill = (cls, text) => '<span class="pill pill--' + esc(cls) + '">' + esc(text) + '</span>';
  const errBox = (id, errs) => { const el = S.$('#' + id); if (el) el.innerHTML = errs && errs.length ? '<div class="notice notice--err" role="alert"><ul class="errs">' + errs.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul></div>' : ''; };
  const okBox = (id, text) => { const el = S.$('#' + id); if (el) el.innerHTML = S.msgHtml(text, 'ok'); };
  const schemaErrs = (value, pointer, label) => TS.validate(value, pointer).map(e => (label ? label + ': ' : '') + TS.messageEn(e));
  const depPct = () => (S.PB.rules && S.PB.rules.deposit_pct) || 50;
  const tzLabel = v => { const o = (Q.US_TZ || []).find(x => x.v === v); return o ? o.l : (v || '').replace(/_/g, ' '); };

  // ------------------------------------------------------------ shared editors (checklist + receptionist settings)
  function hoursEditor(px, hours) {
    // nothing saved yet -> a weekday starting point the client adjusts
    hours = hours && Object.keys(hours).length ? hours : { mon: ['08:00', '17:00'], tue: ['08:00', '17:00'], wed: ['08:00', '17:00'], thu: ['08:00', '17:00'], fri: ['08:00', '17:00'] };
    return '<fieldset class="field hours"><legend class="label">Opening hours</legend><p class="hint">Uncheck the days you’re closed. Times are in your business’s time zone.</p>' +
      DAYS.map(([k, l]) => {
        const v = Array.isArray(hours[k]) ? hours[k] : null;
        return '<div class="hrow"><label class="check"><input type="checkbox" id="' + px + '_' + k + '_on"' + (v ? ' checked' : '') + '> <span>' + l + '</span></label>' +
          '<label class="sr-only" for="' + px + '_' + k + '_o">' + l + ' opens</label><input class="input" type="time" id="' + px + '_' + k + '_o" value="' + esc(v ? v[0] : '08:00') + '"' + (v ? '' : ' disabled') + '>' +
          '<span class="muted" aria-hidden="true">to</span><label class="sr-only" for="' + px + '_' + k + '_c">' + l + ' closes</label><input class="input" type="time" id="' + px + '_' + k + '_c" value="' + esc(v ? v[1] : '17:00') + '"' + (v ? '' : ' disabled') + '></div>';
      }).join('') + '</fieldset>';
  }
  function bindHours(px) {
    DAYS.forEach(([k]) => {
      const on = S.$('#' + px + '_' + k + '_on'); if (!on) return;
      on.addEventListener('change', () => { S.$('#' + px + '_' + k + '_o').disabled = !on.checked; S.$('#' + px + '_' + k + '_c').disabled = !on.checked; });
    });
  }
  function readHours(px) {
    const hours = {}, errs = [];
    DAYS.forEach(([k, l]) => {
      if (!S.$('#' + px + '_' + k + '_on').checked) { hours[k] = null; return; }
      const o = S.$('#' + px + '_' + k + '_o').value, c = S.$('#' + px + '_' + k + '_c').value;
      hours[k] = [o, c];
      if (o && c && o >= c) errs.push(l + ': opening time must be before closing time.');
    });
    if (!DAYS.some(([k]) => hours[k])) errs.push('Pick at least one open day.');
    return { hours, errs: errs.concat(schemaErrs(hours, '#/$defs/Hours', 'Hours')) };
  }
  function faqEditor(px, faq) {
    faq = (faq && faq.length ? faq : [{ q: '', a: '' }]);
    return '<div class="faq" id="' + px + '_faq">' + faq.map((f, i) => faqRow(px, i, f)).join('') + '</div>' +
      '<div class="row"><button type="button" class="btn btn--ghost btn--sm" id="' + px + '_faqAdd">Add a question</button><span class="muted small" id="' + px + '_faqCnt"></span></div>';
  }
  function faqRow(px, i, f) {
    return '<div class="faqrow" data-i="' + i + '"><div class="field"><label for="' + px + '_q' + i + '">Question ' + (i + 1) + '</label><input class="input" id="' + px + '_q' + i + '" maxlength="300" value="' + esc(f.q || '') + '" placeholder="Do you service Trane units?"></div>' +
      '<div class="field"><label for="' + px + '_a' + i + '">Answer</label><textarea class="textarea short" id="' + px + '_a' + i + '" maxlength="600" placeholder="Yes, all major brands.">' + esc(f.a || '') + '</textarea></div>' +
      '<button type="button" class="linkbtn" data-faqrm="' + i + '" aria-label="Remove question ' + (i + 1) + '">Remove</button></div>';
  }
  function readFaq(px) {
    const rows = S.$$('#' + px + '_faq .faqrow').map(r => {
      const i = r.dataset.i; return { q: S.$('#' + px + '_q' + i).value.trim(), a: S.$('#' + px + '_a' + i).value.trim() };
    }).filter(f => f.q || f.a);
    const errs = [];
    rows.forEach((f, i) => { if (!f.q || !f.a) errs.push('Question ' + (i + 1) + ' needs both a question and an answer.'); });
    return { faq: rows, errs: errs.length ? errs : schemaErrs(rows, 'faq', 'FAQ') };
  }
  function bindFaq(px) {
    const max = ((TS.schema && TS.schema.properties && TS.schema.properties.faq) || {}).maxItems || 25;
    const box = S.$('#' + px + '_faq'), add = S.$('#' + px + '_faqAdd'), cnt = S.$('#' + px + '_faqCnt');
    const sync = () => { const n = S.$$('.faqrow', box).length; cnt.textContent = n + ' of ' + max; add.disabled = n >= max; };
    add.addEventListener('click', () => {
      const cur = readFaqRaw(px); if (cur.length >= max) return;
      cur.push({ q: '', a: '' }); box.innerHTML = cur.map((f, i) => faqRow(px, i, f)).join(''); wireRm(); sync();
      S.$('#' + px + '_q' + (cur.length - 1)).focus();
    });
    function wireRm() {
      S.$$('[data-faqrm]', box).forEach(b => b.addEventListener('click', () => {
        const cur = readFaqRaw(px); cur.splice(+b.dataset.faqrm, 1); if (!cur.length) cur.push({ q: '', a: '' });
        box.innerHTML = cur.map((f, i) => faqRow(px, i, f)).join(''); wireRm(); sync(); add.focus();
      }));
    }
    wireRm(); sync();
  }
  const readFaqRaw = px => S.$$('#' + px + '_faq .faqrow').map(r => ({ q: S.$('#' + px + '_q' + r.dataset.i).value, a: S.$('#' + px + '_a' + r.dataset.i).value }));
  function notifyEditor(px, n) {
    n = n || {};
    const ds = n.daily_summary === undefined ? '19:00' : n.daily_summary;
    return '<div class="field"><label for="' + px + '_sms">Mobile numbers for text alerts</label><span class="hint" id="' + px + '_smsH">Up to 5, separated by commas. US numbers like (713) 555-0100.</span>' +
      '<input class="input" id="' + px + '_sms" inputmode="tel" autocomplete="tel" aria-describedby="' + px + '_smsH" value="' + esc((n.sms || []).map(fmtPhone).join(', ')) + '"></div>' +
      '<div class="field"><label for="' + px + '_email">Emails for lead alerts</label><span class="hint" id="' + px + '_emH">Up to 5, separated by commas.</span>' +
      '<input class="input" id="' + px + '_email" inputmode="email" aria-describedby="' + px + '_emH" value="' + esc((n.email || []).join(', ')) + '"></div>' +
      '<div class="field"><span class="label" id="' + px + '_dsL">Daily summary</span><div class="row"><label class="check"><input type="checkbox" id="' + px + '_dsOn"' + (ds ? ' checked' : '') + '> <span>Send me a summary every day at</span></label>' +
      '<label class="sr-only" for="' + px + '_ds">Daily summary time</label><input class="input input--time" type="time" id="' + px + '_ds" value="' + esc(ds || '19:00') + '"' + (ds ? '' : ' disabled') + '></div></div>';
  }
  function bindNotify(px) { const on = S.$('#' + px + '_dsOn'); on.addEventListener('change', () => { S.$('#' + px + '_ds').disabled = !on.checked; }); }
  function readNotify(px) {
    const errs = [];
    const sms = list(S.$('#' + px + '_sms').value).map(toE164);
    sms.filter(x => /^invalid:/.test(x)).forEach(x => errs.push('“' + x.slice(8) + '” doesn’t look like a phone number.'));
    const email = list(S.$('#' + px + '_email').value).map(x => x.toLowerCase());
    const notify = { sms: sms.filter(x => !/^invalid:/.test(x)), email, daily_summary: S.$('#' + px + '_dsOn').checked ? S.$('#' + px + '_ds').value : null };
    if (!notify.sms.length && !notify.email.length) errs.push('Add at least one mobile number or email, so lead alerts reach someone.');
    return { notify, errs: errs.length ? errs : schemaErrs(notify, '#/$defs/Notify', 'Alerts') };
  }

  function afterHoursEditor(px, mode) {
    mode = mode || 'book_next_day';
    return '<fieldset class="field"><legend class="label">After hours</legend><div class="choices" role="radiogroup" aria-label="After hours">' +
      AFTER_HOURS.map(([v, l]) => '<label class="choice"><input type="radio" name="' + px + '" value="' + v + '"' + (v === mode ? ' checked' : '') + '><span class="choice__t">' + esc(l) + '</span></label>').join('') + '</div></fieldset>';
  }
  function readAfterHours(px) {
    const v = (S.$('input[name=' + px + ']:checked') || {}).value;
    const after_hours = { mode: v };
    return { after_hours, errs: v ? schemaErrs(after_hours, '#/$defs/AfterHours', 'After hours') : ['Choose what happens after hours.'] };
  }
  function onCallEditor(px, num) {
    return '<div class="field"><label for="' + px + '">On-call number (optional)</label><span class="hint" id="' + px + 'H">Who we try for urgent jobs and when a caller asks for a person. We ring it for 20 seconds, then take a message.</span>' +
      '<input class="input" id="' + px + '" inputmode="tel" autocomplete="tel" aria-describedby="' + px + 'H" value="' + esc(fmtPhone(num || '')) + '"></div>';
  }
  function readOnCall(px) {
    const raw = S.$('#' + px).value.trim(); if (!raw) return { number: null, errs: [] };
    const n = toE164(raw);
    if (/^invalid:/.test(n)) return { number: null, errs: ['The on-call number doesn’t look like a phone number.'] };
    return { number: n, errs: schemaErrs(n, '#/$defs/Handoff/properties/number/anyOf/0', 'On-call number') };
  }

  // ------------------------------------------------------------ Setup checklist
  function videoSlot(it) {
    const url = it.video_url && /^https:\/\//.test(it.video_url) ? it.video_url : '';
    const inner = url ? (/\.mp4(\?|$)/i.test(url) ? '<video controls preload="none" src="' + esc(url) + '" aria-label="Video: ' + esc(it.title) + '"></video>'
      : '<a class="btn btn--ghost btn--sm" href="' + esc(url) + '" target="_blank" rel="noopener">Watch the 2-minute video</a>')
      : '<div class="vslot__ph" role="img" aria-label="Video for this step is coming soon"><span aria-hidden="true">▶</span> Short video for this step — coming soon</div>';
    return '<div class="vslot" data-video="onb-' + esc(it.key) + '" data-script="' + esc(VIDEO_SCRIPT[it.key] || '') + '">' + inner + '</div>';
  }
  function onboardingHtml(d) {
    const items = d.ob.slice().sort((a, b) => a.sort - b.sort);
    const done = items.filter(i => i.status === 'done').length;
    const pct = items.length ? Math.round(done / items.length * 100) : 0;
    if (!state.open || !items.some(i => i.key === state.open)) state.open = (items.find(i => i.status !== 'done') || {}).key || null;
    return '<section class="card obhead"><h2 class="h-card">Your setup checklist</h2><p>' + done + ' of ' + items.length + ' steps done. Each step has a short video and saves as you go. Stuck? Use “Need help” in the step and we’ll answer in writing.</p>' +
      '<div class="bar" role="progressbar" aria-label="Setup checklist progress" aria-valuemin="0" aria-valuemax="' + items.length + '" aria-valuenow="' + done + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="vslot spaced" data-video="onb-welcome" data-script="01-welcome"><div class="vslot__ph" role="img" aria-label="Welcome video coming soon"><span aria-hidden="true">▶</span> Welcome — what happens now (video coming soon)</div></div></section>' +
      (d.schemaOk === false ? S.msgHtml('Some settings can’t be checked right now. Please reload the page.') : '') +
      '<div id="calReturn"></div><ol class="obsteps">' + items.map((it, i) => '<li><details class="obstep" id="ob-' + esc(it.key) + '" data-key="' + esc(it.key) + '"' + (state.open === it.key ? ' open' : '') + '>' +
        '<summary><span class="obstep__n" aria-hidden="true">' + (i + 1) + '</span><span class="obstep__t">' + esc(it.title) + '</span>' + pill(it.status, OB_STATUS[it.status] || it.status) + '</summary>' +
        '<div class="obstep__b">' + videoSlot(it) + stepBody(it, d) + helpBox(it) + '</div></details></li>').join('') + '</ol>';
  }
  function helpBox(it) {
    const sent = it.status === 'need_help' && it.data && it.data.help_message;
    return '<div class="help">' + (sent ? S.msgHtml('We got your message and will reply in writing ' + S.sla() + '.', 'info') : '') +
      '<details class="help__d"><summary>Need help with this step?</summary><div class="field"><label for="help_' + esc(it.key) + '">Tell us what’s unclear — no call needed.</label>' +
      '<textarea class="textarea short" id="help_' + esc(it.key) + '" maxlength="2000"></textarea></div>' +
      '<button type="button" class="btn btn--ghost btn--sm" data-help="' + esc(it.id) + '">Send to our team</button><div id="helpMsg_' + esc(it.key) + '"></div></details></div>';
  }
  const saveBtn = (it, label) => '<div id="msg_' + esc(it.key) + '" aria-live="polite"></div><div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-save="' + esc(it.key) + '">' + esc(label || 'Save this step') + '</button></div>';
  // the go-live request sits in the LAST checklist item (sms for the receptionist, web_content for websites)
  const lastItem = d => d.ob.slice().sort((x, y) => x.sort - y.sort).pop();
  function goLiveHtml(it, d) {
    if (lastItem(d) !== it) return '';
    const data = it.data || {};
    const left = d.ob.filter(o => o.status !== 'done' && o.key !== 'tools');   // 'tools' (Zapier) is optional
    const testing = d.client && d.client.status === 'testing';
    const why = left.length ? 'Finish the checklist first (' + left.length + ' step' + (left.length === 1 ? '' : 's') + ' left).' : !testing ? 'This opens once your receptionist is ready to test — we’ll email you.' : '';
    const fp = finalPay(d);   // card / PayPal checkout for the final payment (null = Upwork / a link from us, as before)
    const how = fp ? 'Then you pay the final payment here, by card or PayPal (' + (100 - depPct()) + '% of setup); you’re switched live once it’s paid.'
      : 'We send the final payment link (' + (100 - depPct()) + '% of setup); you’re switched live once it’s paid.';
    return '<div class="golive"><h3 class="h-sub">Request go-live</h3><p>When everything is done and you’ve tried your test number, request go-live (the day your ' + (isRcp(d) ? 'receptionist' : 'website') + ' starts working for real customers). ' + how + '</p>' +
      (data.go_live_requested_at
        ? (fp ? S.msgHtml('Go-live requested on ' + S.fmtDate(data.go_live_requested_at) + '. Last step: the final payment.', 'ok') + finalPayHtml(fp, 'golive')
          : S.msgHtml('Go-live requested on ' + S.fmtDate(data.go_live_requested_at) + '. Watch your email for the final payment link.', 'ok'))
        : '<div id="msg_golive" aria-live="polite">' + (why ? '<p class="muted small" id="golWhy">' + esc(why) + '</p>' : '') + '</div><div class="btn-row"><button type="button" class="btn btn--primary btn--sm" id="ob_golive" data-item="' + esc(it.id) + '"' + (why ? ' disabled aria-describedby="golWhy"' : '') + '>Request go-live</button></div>') + '</div>';
  }

  // ------------------------------------------------------------ final payment by card / PayPal (Edge Functions pay-create /
  // pay-capture with which=final). Only for a quote paid by PayPal checkout while brand.json payments.paypal is on; the
  // amount comes from our payment row. Same rule as paypalOn() in /assets/quote_view.mjs.
  const ppOn = () => { const p = S.BRAND.payments && S.BRAND.payments.paypal; return !!(p && p.enabled === true && /^[A-Za-z0-9_-]{16,128}$/.test(p.client_id || '')); };
  function finalPay(d) {
    if (!d.client || !ppOn()) return null;
    const quotes = d.quotes || [];
    const q = quotes.find(x => x.id === d.client.quote_id) || quotes.find(x => x.status === 'accepted');
    if (!q || q.pay_method !== 'paypal_checkout' || !q.public_token) return null;
    const row = (d.payments || []).find(p => p.kind === 'final') || null;
    const amount = row ? row.amount_cents : (q.setup_cents || 0) - (q.deposit_cents || 0);
    const state = !row ? 'due' : row.status === 'due' && row.provider_capture_id ? 'pending' : row.status;
    return { quote: q, row, amount, state };
  }
  function finalPayHtml(fp, where) {
    if (fp.state === 'paid') return S.msgHtml('Final payment received' + (fp.row && fp.row.paid_at ? ' on ' + S.fmtDate(fp.row.paid_at) : '') + '. Thank you! Next, we set your go-live date and email you when it’s live.', 'ok');
    if (fp.state === 'pending') return S.msgHtml('PayPal is processing your final payment. We’ll email you as soon as it clears. No need to pay again.', 'info');
    if (fp.state === 'refunded') return S.msgHtml('Your final payment was refunded. Questions? Reply to any of our emails.', 'info');
    return '<div class="ppay" data-final-pay="' + esc(where) + '"><h3 class="h-sub">Pay the final ' + S.money(fp.amount) + '</h3>' +
      '<div class="ppay__btns" data-pp-wrap><div data-pp="card"></div><div data-pp="paypal"></div><p class="muted small" data-pp-loading>Loading secure checkout…</p></div>' +
      '<p class="small muted">Secure checkout by PayPal. No PayPal account needed. Receipt by email within a minute.</p>' +
      '<div class="ppay__msg" aria-live="polite"></div></div>';
  }
  /** Mount the buttons of a finalPayHtml block found under `root`; `after` reloads the page data once paid. */
  async function mountFinalPay(d, root, after) {
    const block = root && root.querySelector('[data-final-pay]');
    const fp = finalPay(d);
    if (!block || !fp) return;
    const box = block.querySelector('[data-pp-wrap]'), msg = block.querySelector('.ppay__msg');
    const say = (t, k) => { msg.innerHTML = t ? S.msgHtml(t, k || 'err') : ''; };
    const alt = 'Or reply to any of our emails and we’ll send you a payment link.';
    let PC = null;
    try {
      PC = await import('/assets/paypal_checkout.mjs');
      await PC.mount(box, {
        brand: S.BRAND, currency: (S.PB && S.PB.currency) || 'USD',
        create: async () => { say(''); return (await B.payCreate(fp.quote.public_token, 'final')).order_id; },
        capture: orderId => B.payCapture(fp.quote.public_token, 'final', orderId),
        onResult: async r => {
          S.toast(r && r.status === 'pending' ? 'Payment processing' : 'Final payment received');
          try { d.payments = await B.listPayments(); } catch (e) { /* the refresh below shows the old state */ }
          after();
        },
        onFail: async code => {
          if (/already_paid|payment_pending/.test(code)) { try { d.payments = await B.listPayments(); after(); return; } catch (e) { /* message below */ } }
          say(PC.messageFor(code, alt));
        },
        onCancel: () => say(PC.messageFor('cancel', ''), 'info'),
      });
    } catch (e) {
      say(PC ? PC.messageFor(String(e && e.message || e), alt) : 'The secure checkout didn’t load. Check your connection and try again. ' + alt);
    }
  }
  function stepBody(it, d) {
    const data = it.data || {}, cfg = (d.tenant && d.tenant.config) || {};
    const prof = window.__profile || {};
    switch (it.key) {
      case 'forward_calls': {
        const num = d.tenant && d.tenant.twilio_number;
        const car = data.carrier || '';
        return '<p>Send the calls you miss to your receptionist. Your phone still rings first; only unanswered or busy calls are forwarded.</p>' +
          (num ? '<p>Your receptionist’s number: <b class="mono bignum" id="ob_fwdnum">' + esc(fmtPhone(num)) + '</b></p>' : S.msgHtml('Your receptionist’s number appears here when your receptionist is ready to test. We’ll email you. You can do the other steps first.', 'info')) +
          '<div class="field"><label for="ob_car">Your phone provider</label><select class="select" id="ob_car"><option value="">Choose…</option>' + CARRIERS.map(c => '<option value="' + c[0] + '"' + (c[0] === car ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('') + '</select></div>' +
          '<div id="ob_carhow">' + carrierHow(car, num) + '</div>' +
          (num ? '<h3 class="h-sub">Test call</h3><p>Press “Test call”. You then have 30 minutes: call your business number from another phone, let it ring out, and say a few words to the receptionist. This step turns to Done when the call arrives.</p>' +
            '<p class="notice" role="note" id="ob_textback">Heads-up: if you hang up without speaking, the phone you called from gets our “Sorry we missed your call” text-back message. That’s expected during a test.</p>' +
            '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" id="ob_test"' + (it.status === 'done' ? ' disabled' : '') + ' aria-describedby="ob_textback">Test call</button>' +
            (B.mode === 'mock' ? '<button type="button" class="btn btn--ghost btn--sm" id="ob_testsim" hidden>Simulate the forwarded call (demo mode)</button>' : '') + '</div><div id="msg_forward_calls" aria-live="polite">' +
            (data.test_call_at ? S.msgHtml('Call received ' + when(data.test_call_at, d) + '. Forwarding works.', 'ok') : '') + '</div>' : '');
      }
      case 'calendar': {
        const prov = data.provider || '';
        const g = data.provider === 'google' && data.connected_at;
        const cly = data.provider === 'calendly' && data.connected_at && data.oauth_at;  // OAuth done (not just the link)
        return '<p>Your receptionist books into your calendar: <b>Calendly (paid plan) or Google Calendar (free)</b>. Calendly’s booking connection needs a paid Calendly plan on your account.</p>' +
          '<fieldset class="field"><legend class="label">Your calendar</legend><div class="choices choices--compact" role="radiogroup" aria-label="Your calendar">' +
          ['calendly', 'google'].map(v => '<label class="choice"><input type="radio" name="ob_prov" value="' + v + '"' + (prov === v ? ' checked' : '') + '><span class="choice__t">' + (v === 'calendly' ? 'Calendly (paid plan)' : 'Google Calendar (free)') + '</span></label>').join('') + '</div></fieldset>' +
          '<div id="ob_cal_calendly"' + (prov === 'calendly' ? '' : ' hidden') + '><div class="field"><label for="ob_cly">Your Calendly booking link</label><span class="hint" id="ob_clyH">Looks like https://calendly.com/your-name/service-call</span>' +
          '<input class="input" id="ob_cly" inputmode="url" aria-describedby="ob_clyH" value="' + esc(data.booking_link || '') + '"></div>' + saveBtn(it, 'Save Calendly link') +
          '<h3 class="h-sub">Allow booking</h3>' + (cly ? S.msgHtml('Connected — Calendly account, ' + S.fmtDate(data.oauth_at) + '.', 'ok') : '') +
          (d.tenant ? '<p>The link alone isn’t enough: to book visits, your receptionist needs permission from your Calendly account. You’ll sign in with Calendly and allow it. We never see your password.</p><div class="btn-row"><button type="button" class="btn btn--primary btn--sm" id="ob_calendly">' + (cly ? 'Reconnect Calendly account' : 'Connect Calendly account') + '</button></div><div id="msg_calendly" aria-live="polite"></div>'
            : '<p class="muted">The “Connect Calendly account” button turns on once we’ve set up your receptionist — we’ll email you. Save your link now.</p>') +
          '<p class="notice" role="note" id="ob_clyq">One more thing in Calendly: open your event type → <b>Invitee questions</b> and add a question named exactly <b class="mono">Job details</b> (optional, one line). Your receptionist writes the caller’s phone, job and address into it, so they show on every booking.</p></div>' +
          '<div id="ob_cal_google"' + (prov === 'google' ? '' : ' hidden') + '>' + (g ? S.msgHtml('Connected — Google Calendar, ' + S.fmtDate(data.connected_at) + '.', 'ok') : '') +
          (d.tenant ? '<p>You’ll sign in with Google and allow access to calendar events only. We never see your password.</p><div class="btn-row"><button type="button" class="btn btn--primary btn--sm" id="ob_google">' + (g ? 'Reconnect Google Calendar' : 'Connect Google Calendar') + '</button></div><div id="msg_google" aria-live="polite"></div>'
            : '<p class="muted">This button turns on once we’ve set up your receptionist — we’ll email you. You can pick Calendly now instead.</p>') + '</div>';
      }
      case 'hours': {
        const tzv = data.timezone || (cfg.business || {}).timezone || prof.timezone || '';
        const opts = (Q.US_TZ || []).slice(); if (tzv && !opts.some(o => o.v === tzv)) opts.unshift({ v: tzv, l: tzv.replace(/_/g, ' ') });
        return '<p>When is someone usually there to answer, and what should happen after hours?</p>' +
          '<div class="field"><label for="ob_tz">Time zone</label><select class="select" id="ob_tz"><option value="">Choose…</option>' + opts.map(o => '<option value="' + esc(o.v) + '"' + (o.v === tzv ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') + '</select></div>' +
          hoursEditor('obh', data.hours || cfg.hours) + afterHoursEditor('obah', (data.after_hours || cfg.after_hours || {}).mode) + saveBtn(it);
      }
      case 'faq':
        return '<p>What do callers ask most? Your receptionist answers only from this list and hands anything else to you.</p>' +
          '<div class="field"><label for="ob_services">Services you book</label><span class="hint" id="ob_servicesH">Separated by commas, e.g. AC repair, Furnace repair, Maintenance.</span>' +
          '<input class="input" id="ob_services" aria-describedby="ob_servicesH" value="' + esc((data.services || (cfg.booking || {}).job_types || []).join(', ')) + '"></div>' +
          '<h3 class="h-sub">Frequently asked questions</h3>' + faqEditor('obf', data.faq || cfg.faq) + saveBtn(it);
      case 'alerts': {
        const em = data.emergency || cfg.emergency || {};
        const oc = data.on_call_number !== undefined ? data.on_call_number : ((cfg.handoff || {}).number || em.dial || '');
        return '<p>Who hears about every new lead and booking right away, and who we call for urgent jobs.</p>' + notifyEditor('obn', data.notify || cfg.notify) +
          onCallEditor('oboc', oc) +
          '<div class="field"><label for="ob_kw">Emergency words</label><span class="hint" id="ob_kwH">Separated by commas, e.g. gas smell, carbon monoxide, flooding, no heat. If a caller says one, you’re alerted right away (and anyone in danger is told to call 911 first).</span>' +
          '<textarea class="textarea short" id="ob_kw" aria-describedby="ob_kwH">' + esc((em.keywords || []).join(', ')) + '</textarea></div>' + saveBtn(it);
      }
      case 'tools':
        return '<p>Optional. If you use other tools (a CRM, a spreadsheet), we can send each new lead and booking to them through Zapier (an app that connects apps). Don’t use Zapier? Skip this step.</p>' +
          '<div class="field"><label for="ob_zap">Zapier webhook URL</label><span class="hint" id="ob_zapH">From “Webhooks by Zapier → Catch Hook”. Starts with https://</span>' +
          '<input class="input" id="ob_zap" inputmode="url" aria-describedby="ob_zapH" value="' + esc(data.zapier_webhook_url || '') + '"></div>' +
          (data.skipped ? S.msgHtml('Skipped. You can add a webhook later here or with a Request.', 'info') : '') +
          '<div id="msg_tools" aria-live="polite"></div><div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-save="tools">Save webhook</button>' +
          '<button type="button" class="btn btn--ghost btn--sm" id="ob_skip" data-item="' + esc(it.id) + '">Skip — I don’t use other tools</button></div>';
      case 'sms':
        return '<p>Phone carriers require every business that texts to register (called A2P 10DLC). We file it for you; it typically takes 1–2 weeks. Calls are answered in the meantime.</p>' +
          '<div class="pgrid"><div class="field"><label for="ob_legal">Legal business name <span class="req">required</span></label><input class="input" id="ob_legal" maxlength="200" value="' + esc(data.legal_name || '') + '"></div>' +
          '<div class="field half"><label for="ob_ein">EIN <span class="req">required</span></label><input class="input" id="ob_ein" inputmode="numeric" placeholder="12-3456789" maxlength="10" value="' + esc(data.ein || '') + '"></div>' +
          '<div class="field half"><label for="ob_web">Website (optional)</label><input class="input" id="ob_web" inputmode="url" maxlength="200" value="' + esc(data.website || '') + '"></div>' +
          '<div class="field"><label for="ob_addr">Business address <span class="req">required</span></label><input class="input" id="ob_addr" autocomplete="street-address" maxlength="300" value="' + esc(data.address || '') + '"></div></div>' +
          '<label class="check consent"><input type="checkbox" id="ob_consent"' + (data.consent ? ' checked' : '') + '> <span>' + esc(SMS_CONSENT) + '</span></label>' + saveBtn(it) + goLiveHtml(it, d);
      case 'web_content':
        return '<p>Tell us what your website should say. Photos and your logo can go in a link (Google Drive, Dropbox) or a Request with files.</p>' +
          '<div class="field"><label for="ob_about">About your business</label><textarea class="textarea" id="ob_about" maxlength="4000">' + esc(data.about || '') + '</textarea></div>' +
          '<div class="field"><label for="ob_domain">Domain you already own (optional)</label><input class="input" id="ob_domain" maxlength="200" value="' + esc(data.domain || '') + '"></div>' +
          '<div class="field"><label for="ob_assets">Link to photos / logo (optional)</label><input class="input" id="ob_assets" inputmode="url" maxlength="500" value="' + esc(data.assets_link || '') + '"></div>' + saveBtn(it) + goLiveHtml(it, d);
      default:
        return saveBtn(it, 'Mark as done');
    }
  }
  function carrierHow(car, num) {
    const c = CARRIERS.find(x => x[0] === car); if (!c) return '';
    const digits = (num || '').replace(/^\+1/, '').replace(/\D/g, '');
    const fill = s => s.replace(/\{n\}/g, digits ? esc(digits) : 'your-forwarding-number').replace(/\{N\}/g, digits ? '1' + esc(digits) : 'your-forwarding-number').replace(/\{fmt\}/g, num ? esc(fmtPhone(num)) : 'your forwarding number');
    return '<ol class="how">' + c[2].map(s => '<li>' + fill(s) + '</li>').join('') + '</ol><p class="muted small">Codes can differ by plan; your provider’s support page has the final word.</p>';
  }

  // save handlers per step -> {status, data, settings?} or {errs}
  function collect(key, d) {
    switch (key) {
      case 'hours': {
        const h = readHours('obh'); const tzv = S.$('#ob_tz').value; const ah = readAfterHours('obah');
        const errs = h.errs.concat(ah.errs); if (!tzv) errs.unshift('Pick your time zone.');
        return errs.length ? { errs } : { data: { hours: h.hours, timezone: tzv, after_hours: ah.after_hours }, settings: { hours: h.hours, after_hours: ah.after_hours } };
      }
      case 'faq': {
        const services = list(S.$('#ob_services').value);
        const f = readFaq('obf');
        const errs = (services.length ? schemaErrs(services, '#/$defs/Booking/properties/job_types', 'Services') : ['Add at least one service you book.']).concat(f.errs);
        if (!f.faq.length) errs.push('Add at least one question and answer.');
        return errs.length ? { errs } : { data: { services, faq: f.faq }, settings: { faq: f.faq } };
      }
      case 'alerts': {
        const n = readNotify('obn'), oc = readOnCall('oboc');
        const keywords = list(S.$('#ob_kw').value);
        const errs = n.errs.concat(oc.errs);
        if (!keywords.length) errs.push('Add at least one emergency word.');
        if (errs.length) return { errs };
        const emergency = { keywords, dial: oc.number };
        const e2 = schemaErrs(emergency, '#/$defs/Emergency', 'Emergency');
        return e2.length ? { errs: e2 } : { data: { notify: n.notify, on_call_number: oc.number, emergency }, settings: { notify: n.notify, on_call_number: oc.number } };
      }
      case 'tools': {
        const zap = S.$('#ob_zap').value.trim();
        if (!zap) return { errs: ['Paste your Zapier webhook URL, or press “Skip”.'] };
        const errs = schemaErrs(zap, '#/$defs/Zapier/properties/webhook_url/anyOf/0', 'Zapier webhook URL');
        return errs.length ? { errs } : { data: { zapier_webhook_url: zap, skipped: false } };
      }
      case 'calendar': {
        const link = S.$('#ob_cly').value.trim();
        if (!CALENDLY_RX.test(link)) return { errs: ['That doesn’t look like a Calendly booking link (https://calendly.com/your-name/event).'] };
        const e = schemaErrs(link, '#/$defs/Booking/properties/booking_link');
        return e.length ? { errs: e } : { data: { provider: 'calendly', booking_link: link, connected_at: new Date().toISOString() } };
      }
      case 'sms': {
        const legal = S.$('#ob_legal').value.trim(), ein = S.$('#ob_ein').value.trim(), addr = S.$('#ob_addr').value.trim(), web = S.$('#ob_web').value.trim();
        const errs = [];
        if (!legal) errs.push('Legal business name is required.');
        if (!EIN_RX.test(ein)) errs.push('EIN has 9 digits, like 12-3456789.');
        if (addr.length < 8) errs.push('Business address is required.');
        if (web && !/^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(web)) errs.push('Website doesn’t look right.');
        if (!S.$('#ob_consent').checked) errs.push('Please confirm the texting rules (checkbox).');
        return errs.length ? { errs } : { data: { legal_name: legal, ein, address: addr, website: web || null, consent: true, consent_text: SMS_CONSENT, consent_at: new Date().toISOString() } };
      }
      case 'web_content': {
        const about = S.$('#ob_about').value.trim(), assets = S.$('#ob_assets').value.trim();
        if (about.length < 20) return { errs: ['Tell us a little more about your business (a few sentences).'] };
        if (assets && !/^https:\/\//.test(assets)) return { errs: ['The photos link should start with https://'] };
        return { data: { about, domain: S.$('#ob_domain').value.trim() || null, assets_link: assets || null } };
      }
      default: return { data: {} };
    }
  }

  async function saveStep(d, key, api) {
    const it = d.ob.find(o => o.key === key); if (!it) return;
    const r = collect(key, d);
    if (r.errs) { errBox('msg_' + key, r.errs); const first = S.$('#msg_' + key + ' [role=alert]'); if (first) first.scrollIntoView({ block: 'nearest' }); return; }
    if (JSON.stringify(Object.assign({}, it.data, r.data)).length >= 19000) { errBox('msg_' + key, ['This is too long to save. Please shorten some answers.']); return; }
    const btn = S.$('[data-save="' + key + '"]'); if (btn) btn.disabled = true;
    try {
      // whitelisted receptionist settings go to the live config too (only once a tenant exists)
      if (r.settings && d.tenant) await B.updateTenantSettings(d.tenant.id, r.settings);
      await B.updateOnboarding(it.id, 'done', Object.assign({ saved_at: new Date().toISOString() }, r.data));
      S.toast('Saved');
      const next = d.ob.slice().sort((a, b) => a.sort - b.sort).find(o => o.status !== 'done' && o.key !== key);
      state.open = next ? next.key : key;
      await api.refresh('onboarding', ['#ob-' + state.open + ' > summary']);
    } catch (e) { if (btn) btn.disabled = false; errBox('msg_' + key, [settingsErr(e)]); }
  }
  function settingsErr(e) {
    const m = (e && (e.code || e.message)) || '';
    if (/field_not_allowed/.test(m)) return 'That setting can’t be changed here. Send us a Request instead.';
    if (/not_your/.test(m)) return 'You can only change your own settings.';
    const inv = /invalid_setting:([\w.\[\]]+)/.exec(m);
    if (inv) {
      const p = inv[1], n = /\[(\d+)\]/.exec(p), num = n ? ' #' + (+n[1] + 1) : '';
      const what = /^faq/.test(p) ? 'FAQ' + num + (/\.a$/.test(p) ? ' answer (max 600 characters)' : /\.q$/.test(p) ? ' question (max 300 characters)' : ' (up to 25 questions)')
        : /^hours/.test(p) ? 'Hours for ' + (p.split('.')[1] || 'a day') + ' (opening must be before closing, HH:MM)'
        : /^notify\.sms/.test(p) ? 'Text-alert number' + num + ' (a US mobile number, up to 5)'
        : /^notify\.email/.test(p) ? 'Alert email' + num + ' (up to 5)'
        : /^notify\.daily/.test(p) ? 'Daily summary time' : /^notify/.test(p) ? 'Alerts (add at least one mobile number or email)'
        : /^after_hours/.test(p) ? 'After-hours choice' : /^on_call/.test(p) ? 'On-call number (a US phone number)' : p;
      return what + ' wasn’t accepted. Please check it and save again.';
    }
    if (/data_too_large/.test(m)) return 'This is too long to save. Please shorten some answers.';
    if (/go_live_not_ready/.test(m)) return 'Go-live opens once every step is done and your receptionist is ready to test.';
    if (/no_forwarding_number/.test(m)) return 'Your forwarding number isn’t ready yet. We’ll email you when it is.';
    return S.errText(e);
  }

  function bindOnboarding(d, api) {
    S.$$('.obstep').forEach(det => det.addEventListener('toggle', () => { if (det.open) state.open = det.dataset.key; }));
    S.$$('[data-save]').forEach(b => b.addEventListener('click', () => saveStep(d, b.dataset.save, api)));
    if (S.$('#obh_mon_on')) bindHours('obh');
    if (S.$('#obf_faq')) bindFaq('obf');
    if (S.$('#obn_sms')) bindNotify('obn');
    S.$$('input[name=ob_prov]').forEach(r => r.addEventListener('change', () => {
      const v = (S.$('input[name=ob_prov]:checked') || {}).value;
      S.$('#ob_cal_calendly').hidden = v !== 'calendly';
      S.$('#ob_cal_google').hidden = v !== 'google';
    }));
    const gb = S.$('#ob_google');
    if (gb) gb.addEventListener('click', async () => {
      gb.disabled = true;
      try { const r = await B.calendarConnectUrl(d.tenant.id, 'google'); location.assign(r.url); }
      catch (e) { gb.disabled = false; errBox('msg_google', [/not configured|503/.test(String(e && e.message)) ? 'Google Calendar connection isn’t available yet. Choose Calendly or use “Need help”.' : settingsErr(e)]); }
    });
    const cb = S.$('#ob_calendly');
    if (cb) cb.addEventListener('click', async () => {
      cb.disabled = true;
      try { const r = await B.calendarConnectUrl(d.tenant.id, 'calendly'); location.assign(r.url); }
      catch (e) { cb.disabled = false; errBox('msg_calendly', [/not configured|503/.test(String(e && e.message)) ? 'Calendly connection isn’t available yet. Save your link and use “Need help” and we’ll connect it with you.' : settingsErr(e)]); }
    });
    const car = S.$('#ob_car');
    if (car) car.addEventListener('change', async () => {
      S.$('#ob_carhow').innerHTML = carrierHow(car.value, d.tenant && d.tenant.twilio_number);
      const it = d.ob.find(o => o.key === 'forward_calls');
      try { await B.updateOnboarding(it.id, null, { carrier: car.value || null }); } catch (e) { /* carrier choice is a convenience */ }
    });
    const tb = S.$('#ob_test');
    if (tb) tb.addEventListener('click', async () => {
      const it = d.ob.find(o => o.key === 'forward_calls');
      tb.disabled = true;
      try {
        const r = await B.startForwardingTest(it.id);
        S.$('#msg_forward_calls').innerHTML = S.msgHtml('Test started. Call your business number now from another phone and don’t answer. Waiting for the call to reach ' + fmtPhone(r.number) + '…', 'info');
        const sim = S.$('#ob_testsim'); if (sim) sim.hidden = false;
        pollTest(d, it.id, api);
      } catch (e) { tb.disabled = false; errBox('msg_forward_calls', [settingsErr(e)]); }
    });
    const sim = S.$('#ob_testsim');
    if (sim) sim.addEventListener('click', () => { try { window.StartMock.admin.simulateCall(d.tenant.id); } catch (e) { /* demo only */ } });
    const gl = S.$('#ob_golive');
    if (gl) gl.addEventListener('click', async () => {
      const it = d.ob.find(o => o.id === gl.dataset.item);
      gl.disabled = true;
      try { await B.updateOnboarding(it.id, null, { go_live_requested_at: new Date().toISOString() }); S.toast('Go-live requested'); state.open = it.key; await api.refresh('onboarding', ['#ob-' + it.key + ' > summary']); }
      catch (e) { gl.disabled = false; errBox('msg_golive', [settingsErr(e)]); }
    });
    const sk = S.$('#ob_skip');
    if (sk) sk.addEventListener('click', async () => {
      sk.disabled = true;
      try { await B.updateOnboarding(sk.dataset.item, 'done', { skipped: true, zapier_webhook_url: null }); S.toast('Step skipped'); state.open = null; await api.refresh('onboarding', ['#ob-tools > summary']); }
      catch (e) { sk.disabled = false; errBox('msg_tools', [settingsErr(e)]); }
    });
    S.$$('[data-help]').forEach(b => b.addEventListener('click', async () => {
      const it = d.ob.find(o => o.id === b.dataset.help); const ta = S.$('#help_' + it.key);
      const text = ta.value.trim();
      if (text.length < 5) { errBox('helpMsg_' + it.key, ['Please write a few words about what you need.']); ta.focus(); return; }
      b.disabled = true;
      try { await B.updateOnboarding(it.id, 'need_help', { help_message: text, help_at: new Date().toISOString() }); S.toast('Sent — we’ll reply in writing'); state.open = it.key; await api.refresh('onboarding', ['#ob-' + it.key + ' > summary']); }
      catch (e) { b.disabled = false; errBox('helpMsg_' + it.key, [settingsErr(e)]); }
    }));
    if (state.calendarReturn) { const r = state.calendarReturn; state.calendarReturn = null; S.$('#calReturn').innerHTML = S.msgHtml(r.text, r.kind); }
    const last = lastItem(d);
    if (last) mountFinalPay(d, document, () => { state.open = last.key; api.refresh('onboarding', ['#ob-' + last.key + ' > summary']); });
  }
  function pollTest(d, itemId, api) {
    clearInterval(state.testPoll);
    const until = Date.now() + 30 * 60000;
    state.testPoll = setInterval(async () => {
      if (Date.now() > until || !S.$('#ob_test')) { clearInterval(state.testPoll); return; }
      try {
        const ob = await B.listOnboarding(); const it = ob.find(o => o.id === itemId);
        if (it && it.status === 'done') { clearInterval(state.testPoll); S.toast('Test call received'); state.open = 'forward_calls'; await api.refresh('onboarding', ['#ob-forward_calls > summary']); }
      } catch (e) { /* keep polling */ }
    }, B.mode === 'mock' ? 700 : 5000);
  }
  // return from the runtime's OAuth callback: /start/?calendar=google&result=connected|cancelled|error
  async function handleCalendarReturn(d) {
    const p = new URLSearchParams(location.search);
    const prov = p.get('calendar'), res = p.get('result');
    if (!prov || !res) return false;
    history.replaceState(null, '', '/start/#onboarding');
    const it = d.ob.find(o => o.key === 'calendar');
    if (res === 'connected' && it && ['google', 'calendly'].indexOf(prov) !== -1) {
      const at = new Date().toISOString();  // data is merged server-side: the saved Calendly link stays
      try { await B.updateOnboarding(it.id, 'done', Object.assign({ provider: prov, connected_at: at }, prov === 'calendly' ? { oauth_at: at } : {})); } catch (e) { /* shown below */ }
      state.calendarReturn = { text: (prov === 'google' ? 'Google Calendar' : 'Calendly account') + ' connected. Thank you!' + (prov === 'calendly' ? ' Remember the “Job details” question in Calendly.' : ''), kind: 'ok' };
    } else state.calendarReturn = { text: res === 'cancelled' ? 'Calendar connection was cancelled. You can try again any time.' : 'The calendar didn’t connect. Please try again or use “Need help”.', kind: res === 'cancelled' ? 'info' : 'err' };
    state.open = 'calendar';
    return true;
  }

  // ------------------------------------------------------------ My receptionist
  function receptionistHtml(d) {
    const t = d.tenant, cfg = t.config || {};
    const paused = !!cfg.paused || t.status === 'paused';
    const st = t.status === 'live' ? (paused ? 'Paused' : 'Live') : t.status === 'paused' ? 'Paused' : 'Testing';
    const calls = d.calls.map(c => '<li class="call"><div class="call__h">' + pill(c.outcome || 'message', OUTCOME[c.outcome] || 'Call') +
      '<b class="mono">' + esc(fmtPhone(c.from_e164) || 'Unknown number') + '</b><span class="muted small">' + esc(when(c.started_at, d)) + (c.duration_s != null ? ' · ' + Math.max(1, Math.round(c.duration_s / 60)) + ' min' : '') + '</span></div>' +
      (c.summary ? '<p class="call__s">' + esc(c.summary) + '</p>' : '') +
      (c.transcript && c.transcript.length ? '<details class="tx"><summary>Transcript</summary><div class="tx__b">' + c.transcript.map(m =>
        '<div class="bubble ' + (m.who === 'customer' ? 'bubble--in' : 'bubble--out') + '"><span class="sr-only">' + (m.who === 'customer' ? 'Caller: ' : 'Receptionist: ') + '</span>' + esc(m.text) + '</div>').join('') + '</div></details>' : '') + '</li>').join('');
    const threads = {};
    d.sms.forEach(m => { (threads[m.contact_e164] = threads[m.contact_e164] || []).push(m); });
    const sms = Object.keys(threads).map(k => {
      const ms = threads[k].slice().sort((a, b) => a.created_at.localeCompare(b.created_at)), last = ms[ms.length - 1];
      return '<li><details class="tx"><summary><b class="mono">' + esc(fmtPhone(k)) + '</b> <span class="muted small">' + esc(when(last.created_at, d)) + ' · ' + ms.length + ' message' + (ms.length === 1 ? '' : 's') + '</span></summary><div class="tx__b">' +
        ms.map(m => '<div class="bubble ' + (m.direction === 'inbound' ? 'bubble--in' : 'bubble--out') + '"><span class="sr-only">' + (m.direction === 'inbound' ? 'Customer: ' : 'Receptionist: ') + '</span>' + esc(m.body) + '</div>').join('') + '</div></details></li>';
    }).join('');
    const bookings = d.bookings.map(b => '<li class="bk"><div><b>' + esc(b.job_type || 'Job') + '</b> · ' + esc(b.customer_name || '') + '</div><div class="muted small">' + esc(when(b.start_at, d)) +
      (b.address ? ' · ' + esc(b.address) : '') + (b.contact_e164 ? ' · <span class="mono">' + esc(fmtPhone(b.contact_e164)) + '</span>' : '') + '</div>' + (b.status !== 'confirmed' ? pill(b.status, b.status) : '') + '</li>').join('');
    return '<section class="card rx"><div class="rx__h"><div><h2 class="h-card">Your receptionist</h2><p>' + pill(paused ? 'paused' : t.status, st) + (t.twilio_number ? ' <span class="mono">' + esc(fmtPhone(t.twilio_number)) + '</span>' : '') + '</p></div>' +
      '<button type="button" class="btn btn--sm ' + (paused ? 'btn--primary' : 'btn--ghost') + '" id="rxPause" aria-pressed="' + paused + '">' + (paused ? 'Resume AI' : 'Pause AI') + '</button></div>' +
      '<p class="muted small" id="rxPauseHint">While paused, the AI assistant doesn’t talk to callers or send texts. Resume any time.</p><div id="rxMsg" aria-live="polite"></div></section>' +
      '<h2 class="h-sec">Recent calls</h2>' + (calls ? '<ul class="calls">' + calls + '</ul>' : '<div class="empty">No calls yet. Calls your receptionist answers show up here with a summary and transcript.</div>') +
      '<h2 class="h-sec">Text messages</h2>' + (sms ? '<ul class="calls">' + sms + '</ul>' : '<div class="empty">No text conversations yet.</div>') +
      '<h2 class="h-sec">Bookings</h2>' + (bookings ? '<ul class="calls">' + bookings + '</ul>' : '<div class="empty">No bookings yet.</div>') +
      '<h2 class="h-sec">Settings</h2><p class="muted small">You can change hours, FAQ, who gets alerts, after-hours handling' + (isRealEstate(cfg) ? ', the on-call number and your lead screening questions' : ' and the on-call number') + ' here. For anything else, send a Request.</p>' +
      '<details class="card set" id="setHours"><summary>Opening hours</summary><p class="muted small">Time zone: ' + esc(tzLabel((cfg.business || {}).timezone)) + '</p>' + hoursEditor('rxh', cfg.hours) + '<div id="rxMsg_hours" aria-live="polite"></div><button type="button" class="btn btn--primary btn--sm" data-rxsave="hours">Save hours</button></details>' +
      '<details class="card set" id="setFaq"><summary>Frequently asked questions</summary>' + faqEditor('rxf', cfg.faq) + '<div id="rxMsg_faq" aria-live="polite"></div><button type="button" class="btn btn--primary btn--sm" data-rxsave="faq">Save FAQ</button></details>' +
      '<details class="card set" id="setNotify"><summary>Who gets alerts</summary>' + notifyEditor('rxn', cfg.notify) + '<div id="rxMsg_notify" aria-live="polite"></div><button type="button" class="btn btn--primary btn--sm" data-rxsave="notify">Save alerts</button></details>' +
      '<details class="card set" id="setAfter"><summary>After hours & on-call number</summary>' + afterHoursEditor('rxah', (cfg.after_hours || {}).mode) + onCallEditor('rxoc', (cfg.handoff || {}).number || (cfg.emergency || {}).dial) +
      '<div id="rxMsg_after" aria-live="polite"></div><button type="button" class="btn btn--primary btn--sm" data-rxsave="after">Save</button></details>' +
      (isRealEstate(cfg) ? screeningHtml(cfg) : '') + webchatHtml(t, cfg);
  }
  function bindReceptionist(d, api) {
    bindHours('rxh'); bindFaq('rxf'); bindNotify('rxn'); bindScreening(); bindWebchat();
    S.$('#rxPause').addEventListener('click', async e => {
      const b = e.currentTarget, next = b.getAttribute('aria-pressed') !== 'true';
      if (next && !confirm('Pause the AI assistant? It stops answering calls and texts until you resume.')) return;
      b.disabled = true;
      const patch = { paused: next };
      const errs = schemaErrs(next, 'paused');
      if (errs.length) { errBox('rxMsg', errs); b.disabled = false; return; }
      try { await B.updateTenantSettings(d.tenant.id, patch); S.toast(next ? 'AI paused' : 'AI resumed'); await api.refresh('receptionist', ['#rxPause']); }
      catch (er) { b.disabled = false; errBox('rxMsg', [settingsErr(er)]); }
    });
    S.$$('[data-rxsave]').forEach(b => b.addEventListener('click', async () => {
      const k = b.dataset.rxsave;
      let patch = {}, errs;
      if (k === 'after') {
        const ah = readAfterHours('rxah'), oc = readOnCall('rxoc');
        errs = ah.errs.concat(oc.errs); patch = { after_hours: ah.after_hours, on_call_number: oc.number };
      } else if (k === 'screen') {
        const r = readScreening(); errs = r.errs; patch = { real_estate: r.real_estate };   // never meetings / follow_up_boss
      } else {
        const r = k === 'hours' ? readHours('rxh') : k === 'faq' ? readFaq('rxf') : readNotify('rxn');
        errs = r.errs; patch[k] = r[k];
      }
      if (errs.length) { errBox('rxMsg_' + k, errs); return; }
      // on_call_number is a settings shortcut (-> handoff.number + emergency.dial), already checked by readOnCall
      const sp = Object.assign({}, patch); delete sp.on_call_number;
      const e2 = TS.validatePatch(sp).map(TS.messageEn);
      if (e2.length) { errBox('rxMsg_' + k, e2); return; }
      b.disabled = true;
      try { await B.updateTenantSettings(d.tenant.id, patch); S.toast('Saved'); await api.refresh('receptionist', ['[data-rxsave="' + k + '"]'], true); }
      catch (er) { b.disabled = false; errBox('rxMsg_' + k, [k === 'screen' ? screeningErr(er) : settingsErr(er)]); }
    }));
  }

  // ------------------------------------------------------------ add-ons in "My receptionist": real-estate lead screening
  // (config.real_estate, only when business.niche is real_estate) and the website chat box snippet (config.webchat, ADD-CHAT).
  // The client edits agent_name / screening (order = the order asked) / renters; meetings and follow_up_boss are ours.
  const RE_QUESTIONS = [['intent', 'Buying, selling or renting?'], ['area', 'Which area or property?'], ['timeline', 'Timeline'], ['price_range', 'Price range / budget'],
    ['pre_approval', 'Pre-approved for a mortgage? (buyers)'], ['property_address', 'Property address (sellers)'], ['motivation', 'What’s prompting the move? (sellers)'], ['has_agent', 'Already working with an agent?']];
  const FAIR_HOUSING = 'We never ask about race, religion, national origin, family status or disability, and the assistant never steers callers toward or away from an area (fair housing).';
  const isRealEstate = cfg => !!(cfg && cfg.business && cfg.business.niche === 'real_estate');
  const reLabel = k => (RE_QUESTIONS.find(q => q[0] === k) || [k, k])[1];
  function screeningHtml(cfg) {
    const re = cfg.real_estate || {};
    const max = ((TS.schema && TS.schema.$defs && TS.schema.$defs.RealEstate && TS.schema.$defs.RealEstate.properties.agent_name) || {}).maxLength || 80;
    const asked = Array.isArray(re.screening) ? re.screening.filter(k => RE_QUESTIONS.some(q => q[0] === k)) : RE_QUESTIONS.map(q => q[0]);
    const order = asked.concat(RE_QUESTIONS.map(q => q[0]).filter(k => asked.indexOf(k) === -1));   // skipped questions sit at the bottom, unchecked
    const rows = order.map((k, i) => '<li class="qreq" data-rek="' + esc(k) + '"><label class="check qreq__t"><input type="checkbox" id="rxre_q_' + esc(k) + '"' + (asked.indexOf(k) !== -1 ? ' checked' : '') + '> <span>' + esc(reLabel(k)) + '</span></label>' +
      '<div class="qreq__a"><button type="button" class="btn btn--ghost btn--sm" data-reup="' + esc(k) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up: ' + esc(reLabel(k)) + '">↑</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" data-redown="' + esc(k) + '"' + (i === order.length - 1 ? ' disabled' : '') + ' aria-label="Move down: ' + esc(reLabel(k)) + '">↓</button></div></li>').join('');
    return '<details class="card set" id="setScreen"><summary>Lead screening questions</summary>' +
      '<p class="muted small">What your assistant asks a new lead, in this order. Uncheck a question to skip it. Use the arrows to change the order — the list order is the order the assistant asks.</p>' +
      '<div class="field"><label for="rxre_agent">Agent name (optional)</label><span class="hint" id="rxre_agentH">The agent your assistant works for, e.g. “Jenna Harper”. Leave it empty to use your brokerage name only.</span>' +
      '<input class="input" id="rxre_agent" maxlength="' + max + '" autocomplete="off" aria-describedby="rxre_agentH" value="' + esc(re.agent_name || '') + '"></div>' +
      '<span class="label" id="rxre_listL">Questions, in the order asked</span><ol class="queue" id="rxre_list" aria-labelledby="rxre_listL">' + rows + '</ol>' +
      '<label class="check spaced"><input type="checkbox" id="rxre_renters"' + (re.renters ? ' checked' : '') + '> <span>Also take rental leads (otherwise a renter gets a message to your team)</span></label>' +
      '<p class="notice small" role="note" id="rxre_fair">' + esc(FAIR_HOUSING) + '</p>' +
      '<div id="rxMsg_screen" aria-live="polite"></div><button type="button" class="btn btn--primary btn--sm" data-rxsave="screen">Save screening questions</button></details>';
  }
  function bindScreening() {
    const box = S.$('#rxre_list'); if (!box) return;
    const sync = () => { const rows = S.$$('.qreq', box); rows.forEach((r, i) => { S.$('[data-reup]', r).disabled = i === 0; S.$('[data-redown]', r).disabled = i === rows.length - 1; }); };
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-reup],[data-redown]'); if (!b || b.disabled) return;
      const row = b.closest('.qreq'), up = b.hasAttribute('data-reup');
      const other = up ? row.previousElementSibling : row.nextElementSibling; if (!other) return;
      box.insertBefore(up ? row : other, up ? other : row);   // move one step; checkbox states travel with the row
      sync(); (b.disabled ? S.$(up ? '[data-redown]' : '[data-reup]', row) : b).focus();
    });
  }
  function readScreening() {
    const errs = [];
    const screening = S.$$('#rxre_list .qreq').filter(r => S.$('input[type=checkbox]', r).checked).map(r => r.dataset.rek);
    const agent_name = S.$('#rxre_agent').value.trim();
    if (!screening.length) errs.push('Keep at least one question, so the assistant learns what the caller needs.');
    if (agent_name.length > 80) errs.push('Agent name is too long (max 80 characters).');
    const real_estate = { agent_name, screening, renters: S.$('#rxre_renters').checked };
    return { real_estate, errs: errs.length ? errs : schemaErrs(real_estate, 'real_estate', 'Screening') };
  }
  function screeningErr(e) {
    const m = (e && (e.code || e.message)) || '';
    if (/invalid_setting:real_estate\.follow_up_boss|invalid_setting:real_estate\.meetings/.test(m)) return 'That part of the screening setup is managed by us. Send us a Request.';
    if (/invalid_setting:real_estate\.agent_name/.test(m)) return 'Agent name wasn’t accepted (up to 80 characters). Please check it and save again.';
    if (/invalid_setting:real_estate\.screening/.test(m)) return 'The question list wasn’t accepted (each question once, from the list above). Please reload and try again.';
    if (/invalid_setting:real_estate\.renters/.test(m)) return 'The rental-leads choice wasn’t accepted. Please try again.';
    if (/invalid_setting:real_estate/.test(m)) return 'Screening settings weren’t accepted. Please reload and try again.';
    return settingsErr(e);
  }
  // Chat box for the client's website (ADD-CHAT). The snippet is <script src="<runtime>/chat/widget.js" data-tenant="<slug>" async>
  // — the runtime URL comes from brand.json demo.runtime_url; allowed website addresses are set by us (Request).
  function webchatHtml(t, cfg) {
    const wc = cfg.webchat; if (!wc || !wc.enabled) return '';
    const base = String((S.BRAND.demo && S.BRAND.demo.runtime_url) || '').replace(/\/+$/, '');
    const snippet = '<script src="' + base + '/chat/widget.js" data-tenant="' + (t.slug || '') + '" async></' + 'script>';
    const origins = Array.isArray(wc.allowed_origins) ? wc.allowed_origins : [];
    return '<details class="card set" id="setChat"><summary>Chat box for your website</summary>' +
      '<p class="muted small">Your assistant can also answer visitors on your website, with the same hours, FAQ and alerts. Add this one line to your site:</p>' +
      '<div class="field"><label for="rxwc_snip">Code to copy</label><textarea class="textarea short mono" id="rxwc_snip" rows="3" readonly spellcheck="false">' + esc(snippet) + '</textarea></div>' +
      '<div class="btn-row"><button type="button" class="btn btn--ghost btn--sm" id="rxwc_copy">Copy</button></div><div id="rxMsg_chat" aria-live="polite"></div>' +
      '<p class="small">Paste this line right before the closing <code class="mono">&lt;/body&gt;</code> tag on your website. It works on any site builder that lets you add custom HTML.</p>' +
      '<h3 class="h-sub">Allowed website addresses</h3>' + (origins.length ? '<ul class="small" id="rxwc_origins">' + origins.map(o => '<li class="mono">' + esc(o) + '</li>').join('') + '</ul>' : '<p class="muted small" id="rxwc_origins">No website address yet — send us a Request with your website address.</p>') +
      '<p class="muted small">Chat only works on these addresses. To add one, send us a Request.</p></details>';
  }
  function bindWebchat() {
    const cp = S.$('#rxwc_copy'), ta = S.$('#rxwc_snip'); if (!cp || !ta) return;
    cp.addEventListener('click', async () => {
      const done = () => okBox('rxMsg_chat', 'Copied. Now paste it into your website, just before </body>.');
      try { await navigator.clipboard.writeText(ta.value); done(); return; } catch (e) { /* no clipboard permission: fall back to selecting */ }
      ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
      let ok = false; try { ok = document.execCommand && document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) done(); else errBox('rxMsg_chat', ['Copy didn’t work in this browser. The code is selected above — press Ctrl+C (or Cmd+C on a Mac) to copy it.']);
    });
  }

  // ------------------------------------------------------------ Requests
  function requestsHtml(d) {
    const rs = d.requests.slice().sort((a, b) => a.position - b.position);
    const cur = rs.filter(r => r.status === 'active' || r.status === 'waiting_on_you');
    const queue = rs.filter(r => r.status === 'queued');
    const past = rs.filter(r => r.status === 'done' || r.status === 'declined');
    const card = r => '<article class="card req" aria-labelledby="rq_' + esc(r.id) + '"><div class="req__h"><h3 id="rq_' + esc(r.id) + '">' + esc(r.title) + '</h3>' + pill(r.status, REQ_STATUS[r.status]) + '</div>' +
      (r.body ? '<p class="req__b">' + esc(r.body) + '</p>' : '') + (r.admin_reply ? '<div class="reply"><span class="eyebrow">Our reply</span><p>' + esc(r.admin_reply) + '</p></div>' : '') +
      (r.status === 'waiting_on_you' ? '<p class="small">We need something from you — see our reply above. You can add files below.</p>' + filesBox(r) : '') + '</article>';
    return '<section class="card"><h2 class="h-card">New request</h2><p class="muted small">Changes, new questions for your receptionist, anything. We work on one request at a time; the rest wait in the order you set.</p>' +
      '<form id="reqForm" novalidate><div class="field"><label for="reqTitle">What do you need? <span class="req">required</span></label><input class="input" id="reqTitle" maxlength="200" placeholder="Add a question about filter sizes"></div>' +
      '<div class="field"><label for="reqBody">Details</label><textarea class="textarea" id="reqBody" maxlength="10000"></textarea></div>' +
      '<div class="field"><label for="reqFiles">Files (optional, up to 5, 10 MB each)</label><input class="input" type="file" id="reqFiles" multiple accept=".' + EXT.join(',.') + '"></div>' +
      '<div id="reqMsg" aria-live="polite"></div><button type="submit" class="btn btn--primary btn--sm" id="reqSend">Send request</button></form></section>' +
      '<h2 class="h-sec">In progress</h2>' + (cur.length ? cur.map(card).join('') : '<div class="empty">Nothing in progress right now.</div>') +
      '<h2 class="h-sec">Queue</h2>' + (queue.length ? '<p class="muted small">Next up is at the top. Move requests up or down, pause one to skip it for now, or cancel it.</p><ol class="queue">' + queue.map((r, i) =>
        '<li class="qreq' + (r.paused ? ' is-paused' : '') + '" data-id="' + esc(r.id) + '"><div class="qreq__t"><b>' + esc(r.title) + '</b>' + (r.paused ? ' ' + pill('paused', 'Paused') : '') + (r.body ? '<span class="muted small">' + esc(r.body.slice(0, 160)) + (r.body.length > 160 ? '…' : '') + '</span>' : '') + '</div>' +
        '<div class="qreq__a"><button type="button" class="btn btn--ghost btn--sm" data-up="' + esc(r.id) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up: ' + esc(r.title) + '">↑</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-down="' + esc(r.id) + '"' + (i === queue.length - 1 ? ' disabled' : '') + ' aria-label="Move down: ' + esc(r.title) + '">↓</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-pause="' + esc(r.id) + '" aria-pressed="' + !!r.paused + '">' + (r.paused ? 'Resume' : 'Pause') + '</button>' +
        '<button type="button" class="linkbtn" data-cancel="' + esc(r.id) + '" aria-label="Cancel: ' + esc(r.title) + '">Cancel</button></div></li>').join('') + '</ol>'
        : '<div class="empty">The queue is empty.</div>') +
      '<div id="qMsg" aria-live="polite"></div>' +
      (past.length ? '<details class="past"><summary>Finished (' + past.length + ')</summary>' + past.map(card).join('') + '</details>' : '');
  }
  function filesBox(r) {
    return '<div class="field"><label for="rf_' + esc(r.id) + '">Add files</label><input class="input" type="file" id="rf_' + esc(r.id) + '" data-rfiles="' + esc(r.id) + '" multiple accept=".' + EXT.join(',.') + '"></div><div id="rfMsg_' + esc(r.id) + '"></div>';
  }
  async function uploadFiles(rid, files) {
    const errs = [];
    for (const file of Array.from(files || []).slice(0, 5)) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (EXT.indexOf(ext) === -1) { errs.push(file.name + ': file type not supported.'); continue; }
      if (file.size > 10 * 1048576) { errs.push(file.name + ': larger than 10 MB.'); continue; }
      const safe = (file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'file') + '.' + ext;
      try { await B.uploadRequestAttachment(rid, file, safe, file.type || 'application/octet-stream'); } catch (e) { errs.push(file.name + ': ' + S.errText(e)); }
    }
    return errs;
  }
  const REQ_ERR = { request_locked: 'This request is already being worked on, so it can’t be changed.', too_many_requests: 'You have 25 open requests — that’s the limit. Cancel one or wait for us to finish one.',
    request_title_length: 'Please give the request a short title (up to 200 characters).', no_client: 'Requests open once your project has started.' };
  const reqErr = e => { const m = (e && (e.code || e.message)) || ''; for (const k in REQ_ERR) if (m.indexOf(k) !== -1) return REQ_ERR[k]; return S.errText(e); };
  function bindRequests(d, api) {
    S.$('#reqForm').addEventListener('submit', async e => {
      e.preventDefault();
      const title = S.$('#reqTitle').value.trim(), body = S.$('#reqBody').value.trim();
      if (!title) { errBox('reqMsg', ['Please write what you need in the first box.']); S.$('#reqTitle').focus(); return; }
      const btn = S.$('#reqSend'); btn.disabled = true;
      try {
        const r = await B.createRequest({ title, body });
        const errs = await uploadFiles(r.id, S.$('#reqFiles').files);
        S.toast('Request sent');
        await api.refresh('requests', ['#reqTitle']);
        if (errs.length) errBox('qMsg', ['Your request was saved, but some files weren’t: ' + errs.join(' ')]);
      } catch (er) { btn.disabled = false; errBox('reqMsg', [reqErr(er)]); }
    });
    const queue = () => d.requests.filter(r => r.status === 'queued').sort((a, b) => a.position - b.position);
    async function move(id, dir) {
      const q = queue(), i = q.findIndex(r => r.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= q.length) return;
      const order = q.slice(); const [x] = order.splice(i, 1); order.splice(j, 0, x);
      const base = Math.min.apply(null, q.map(r => r.position));
      try {
        for (let k = 0; k < order.length; k++) if (order[k].position !== base + k) await B.saveRequest(order[k].id, { position: base + k });
        await api.refresh('requests', ['[data-' + (dir < 0 ? 'up' : 'down') + '="' + id + '"]', '[data-' + (dir < 0 ? 'down' : 'up') + '="' + id + '"]']);
      } catch (er) { errBox('qMsg', [reqErr(er)]); }
    }
    S.$$('[data-up]').forEach(b => b.addEventListener('click', () => move(b.dataset.up, -1)));
    S.$$('[data-down]').forEach(b => b.addEventListener('click', () => move(b.dataset.down, 1)));
    S.$$('[data-pause]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await B.saveRequest(b.dataset.pause, { paused: b.getAttribute('aria-pressed') !== 'true' }); await api.refresh('requests', ['[data-pause="' + b.dataset.pause + '"]']); }
      catch (er) { b.disabled = false; errBox('qMsg', [reqErr(er)]); }
    }));
    S.$$('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Cancel this request? It will be removed from your queue.')) return;
      b.disabled = true;
      try { await B.cancelRequest(b.dataset.cancel); S.toast('Request cancelled'); await api.refresh('requests', ['#reqTitle']); }
      catch (er) { b.disabled = false; errBox('qMsg', [reqErr(er)]); }
    }));
    S.$$('[data-rfiles]').forEach(inp => inp.addEventListener('change', async () => {
      const errs = await uploadFiles(inp.dataset.rfiles, inp.files);
      if (errs.length) errBox('rfMsg_' + inp.dataset.rfiles, errs); else { okBox('rfMsg_' + inp.dataset.rfiles, 'Files added.'); inp.value = ''; }
    }));
  }

  // ------------------------------------------------------------ Billing: usage card
  function usageHtml(d) {
    if (!d.usage || !isRcp(d)) return '';
    const inc = (S.PB.rules && S.PB.rules.included_usage) || {};
    const meter = (label, v, max, unit) => {
      const pct = max ? Math.min(100, Math.round(v / max * 100)) : 0;
      return '<div class="meter"><div class="meter__l"><span>' + esc(label) + '</span><span class="num">' + Math.round(v).toLocaleString('en-US') + (max ? ' of ' + Number(max).toLocaleString('en-US') + ' ' + unit : ' ' + unit) + '</span></div>' +
        '<div class="bar" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="' + (max || 0) + '" aria-valuenow="' + Math.round(v) + '"><i class="' + (pct >= 100 ? 'is-full' : pct >= 80 ? 'is-high' : '') + '" style="width:' + pct + '%"></i></div></div>';
    };
    const addon = (S.PB.items || []).find(i => i.code === 'ADD-USAGE');
    return '<section class="card usage"><h2 class="h-card">This month’s usage</h2>' + meter('Call minutes', d.usage.voice_minutes || 0, inc.voice_minutes, 'min') + meter('Text messages', d.usage.sms_segments || 0, inc.sms_segments, 'segments') +
      '<p class="muted small">We never charge for extra minutes or texts on our own. We alert you at 80% and 100% of your monthly minutes and texts. We add more' + (addon && addon.monthly_cents ? ' (' + S.money(addon.monthly_cents) + '/mo)' : '') + ' only if you say yes.</p>' +
      (d.usage.needs_addon_approval ? S.msgHtml('You’ve used everything included this month. Your receptionist keeps answering; we’ll email you about adding more minutes and texts.', 'info') : '') + '</section>';
  }

  // ------------------------------------------------------------ dispatch from home.js
  function bind(d, tab, api) {
    if (tab === 'onboarding') { bindOnboarding(d, api); return true; }
    if (tab === 'receptionist') { bindReceptionist(d, api); return true; }
    if (tab === 'requests') { bindRequests(d, api); return true; }
    return false;
  }
  window.PortalB = { load, tabs, bind, usageHtml, handleCalendarReturn, toE164, finalPay, finalPayHtml, mountFinalPay };
})();
