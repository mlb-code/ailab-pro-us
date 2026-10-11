/* Admin "Tenants" tab (task B7; Hebrew, RTL). Rendered by admin.js -> tTenants() -> AdminTenants.render(panel, ctx).
   - Usage + cost per tenant this month: AB.adminTenantUsage(month) = RPC admin_tenant_usage (security definer, is_admin();
     reads only usage:/spend:/cost:twilio: keys of runtime_state, which stays service-role-only).
   - Tenant config editor: JSON validated in the browser against /assets/tenant_schema.json (TenantSchema = generic validator;
     the schema is a byte copy of runtime/app/tenant_schema.json, generated from the runtime's pydantic model). Save is
     blocked while invalid and goes through AB.adminSaveTenant = RPC admin_save_tenant (admin only, logged in events).
   - "Merge onboarding data": copies what the client entered in the setup checklist (time zone, emergency, calendar link, ...)
     into the editor, for review before saving. Nothing is saved without the button.
   - Simulator run: needs a runtime endpoint (/admin/sim-run) that does not exist yet -> button disabled with a note. */
(function () {
  const TS = window.TenantSchema;
  let C = null;           // ctx from admin.js
  let month = new Date().toISOString().slice(0, 7);
  let usage = [], usageErr = null;
  const draft = {};       // unsaved editor text per tenant/client key

  const E = {
    not_admin: 'אין לך הרשאת ניהול.', config_must_be_object: 'הקונפיג חייב להיות אובייקט JSON.', bad_month: 'חודש לא תקין.',
    tenants_slug_key: 'ה-slug כבר תפוס. בוחרים slug אחר.', tenants_twilio_number_key: 'המספר כבר משויך ל-tenant אחר.',
    tenants_slug_check: 'slug: אותיות קטנות באנגלית, ספרות ומקפים, 3–60 תווים.', tenants_twilio_number_check: 'מספר Twilio חייב להיות בפורמט E.164, למשל +17135550100.'
  };
  const err = e => { const m = (e && (e.code || e.message)) || ''; for (const k in E) if (m.indexOf(k) !== -1) return E[k]; return C.errText(e); };
  const toE164 = s => { const dg = String(s || '').replace(/\D/g, ''); return /^\+/.test(String(s || '').trim()) ? '+' + dg : dg.length === 10 ? '+1' + dg : dg.length === 11 && dg[0] === '1' ? '+' + dg : null; };
  const money = usd => C.money(Math.round((usd || 0) * 100));
  const keyOf = (t, cid) => t ? t.id : 'new-' + cid;

  function messageHe(e) {
    const p = e.params || {};
    const m = {
      type: 'סוג שגוי (צריך ' + p.expected + ')', enum: 'ערך לא מותר. מותר: ' + (p.allowed || []).join(', '), const: 'חייב להיות ' + JSON.stringify(p.value),
      minLength: 'שדה ריק או קצר מדי', maxLength: 'ארוך מדי (עד ' + p.n + ' תווים)', pattern: 'פורמט שגוי' + (p.hint ? ' (' + p.hint + ')' : ''),
      minimum: 'קטן מהמינימום ' + p.n, maximum: 'גדול מהמקסימום ' + p.n, exclusiveMinimum: 'חייב להיות גדול מ-' + p.n, exclusiveMaximum: 'חייב להיות קטן מ-' + p.n,
      minItems: 'צריך לפחות ' + p.n + ' פריטים', maxItems: 'מותר עד ' + p.n + ' פריטים', required: 'שדה חובה חסר', additional: 'שדה לא מוכר בסכמה',
      extra_item: 'יותר מדי פריטים', unknown_field: 'שדה לא מוכר בסכמה'
    }[e.code] || 'לא תקין';
    return { path: e.path || '(config)', text: m };
  }
  async function loadUsage() {
    try { usage = await C.AB.adminTenantUsage(month); usageErr = null; } catch (e) { usage = []; usageErr = err(e); }
  }

  function render(p, ctx) {
    C = ctx;
    const esc = C.esc;
    p.innerHTML = '<section class="card tusage" aria-labelledby="tuH"><div class="row tusage__h"><h2 id="tuH">שימוש ועלות החודש</h2>' +
      '<label class="sr-only" for="tuMonth">חודש</label><input class="input ltr" type="month" id="tuMonth" dir="ltr" value="' + esc(month) + '"></div>' +
      '<div id="tuBody"><p class="muted">טוען…</p></div></section>' +
      '<div class="split"><div><ul class="alist" id="alist"></ul></div><section class="detail card" id="detail" tabindex="-1" aria-live="polite"></section></div>';
    C.$('#tuMonth').addEventListener('change', async e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { month = e.target.value; await loadUsage(); drawUsage(); } });
    TS.load().catch(() => null).then(() => { drawList(); drawDetail(); });
    loadUsage().then(drawUsage);
  }

  function drawUsage() {
    const esc = C.esc, box = C.$('#tuBody'); if (!box) return;
    if (usageErr) { box.innerHTML = '<div class="notice notice--err" role="alert"><div>' + esc(usageErr) + '</div></div>'; return; }
    if (!usage.length) { box.innerHTML = '<p class="empty">אין tenants עדיין.</p>'; return; }
    const inc = (C.PB.rules || {}).included_usage || {};
    const pct = (v, m) => m ? Math.round(v / m * 100) + '%' : '';
    box.innerHTML = '<div class="table-wrap"><table class="table tu"><caption class="sr-only">שימוש ועלות לכל tenant</caption><thead><tr><th scope="col">Tenant</th><th scope="col">לקוח</th><th scope="col">דקות קול</th><th scope="col">מקטעי SMS</th>' +
      '<th scope="col">Claude</th><th scope="col">Twilio</th><th scope="col">עלות מול החודשי</th></tr></thead><tbody>' + usage.map(u => {
        const t = C.D.tenants.find(x => x.id === u.tenant_id) || {}, c = C.D.clients.find(x => x.id === t.client_id);
        const cost = (+u.claude_usd || 0) + (+u.twilio_usd || 0), fee = c && c.monthly_cents ? c.monthly_cents / 100 : 0;
        return '<tr><td><bdi dir="ltr">' + esc(u.slug) + '</bdi></td><td>' + esc(C.clientName(c) || '—') + '</td>' +
          '<td><span dir="ltr" class="num">' + esc(Math.round(u.voice_minutes || 0)) + ' / ' + esc(inc.voice_minutes || '—') + '</span> ' + esc(pct(u.voice_minutes || 0, inc.voice_minutes)) + '</td>' +
          '<td><span dir="ltr" class="num">' + esc(Math.round(u.sms_segments || 0)) + ' / ' + esc(inc.sms_segments || '—') + '</span> ' + esc(pct(u.sms_segments || 0, inc.sms_segments)) + '</td>' +
          '<td>' + money(u.claude_usd) + '</td><td>' + money(u.twilio_usd) + '</td>' +
          '<td>' + money(cost) + (fee ? ' <span class="muted small">(' + esc(Math.round(cost / fee * 100)) + '% מ-<span dir="ltr">' + esc(C.moneyText ? C.moneyText(c.monthly_cents) : '') + '</span>)</span>' : '') +
          (u.needs_addon_approval ? ' <span class="pill pill--need_help">עבר 100% — לאשר חבילה עם הלקוח</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="muted small">המקור: runtime_state דרך הפונקציה admin_tenant_usage (רק מפתחות usage/spend/cost). אין חיוב אוטומטי על חריגה.</p>';
  }

  function validity(t) {
    if (!TS.schema) return '';
    const n = TS.validate(t.config || {}).length;
    return n ? '<span class="pill pill--need_help">' + n + ' שגיאות</span>' : '<span class="pill pill--live">תקין</span>';
  }
  function drawList() {
    const esc = C.esc, ul = C.$('#alist'); if (!ul) return;
    const noTenant = C.D.clients.filter(c => c.status !== 'cancelled' && !C.D.tenants.some(t => t.client_id === c.id) && (c.products || []).some(x => x === 'RCP' || x === 'BNDL'));
    const rows = C.D.tenants.map(t => '<li><button type="button" data-k="' + esc(t.id) + '" aria-current="' + (C.sel === t.id) + '"><span class="l1"><b dir="ltr">' + esc(t.slug) + '</b>' + C.pill('tenant', t.status) + '</span>' +
      '<span class="l2">' + esc(C.clientName(C.D.clients.find(c => c.id === t.client_id))) + ' · ' + validity(t) + '</span></button></li>').join('') +
      noTenant.map(c => '<li><button type="button" data-k="new-' + esc(c.id) + '" aria-current="' + (C.sel === 'new-' + c.id) + '"><span class="l1"><b>' + esc(C.clientName(c)) + '</b><span class="pill pill--todo">אין tenant</span></span>' +
        '<span class="l2">יצירת tenant חדש ללקוח</span></button></li>').join('');
    ul.innerHTML = rows || '<li class="empty">אין לקוחות עם מוצר receptionist עדיין.</li>';
    C.$$('[data-k]', ul).forEach(b => b.addEventListener('click', () => C.go('tenants', b.dataset.k)));
  }

  function onboardingOf(clientId) { return C.D.onboarding.filter(o => o.client_id === clientId).sort((a, b) => a.sort - b.sort); }
  function drawDetail() {
    const esc = C.esc, box = C.$('#detail'); if (!box) return;
    const sel = C.sel || '';
    const t = C.D.tenants.find(x => x.id === sel) || null;
    const cid = t ? t.client_id : (/^new-/.test(sel) ? sel.slice(4) : null);
    const c = cid && C.D.clients.find(x => x.id === cid);
    if (!c) { box.innerHTML = '<p class="muted">בוחרים tenant מהרשימה (או לקוח בלי tenant כדי ליצור אחד).</p>'; return; }
    const k = keyOf(t, c.id);
    const text = draft[k] != null ? draft[k] : JSON.stringify(t ? t.config : {}, null, 2);
    const ob = onboardingOf(c.id);
    const statuses = ['sandbox', 'live', 'paused'];
    box.innerHTML = '<h2>' + (t ? 'Tenant <bdi dir="ltr">' + esc(t.slug) + '</bdi>' : 'tenant חדש') + '</h2><p class="muted small">' + esc(C.clientName(c)) + ' · ' + C.pill('client', c.status) + '</p>' +
      '<div class="row2"><div class="field"><label for="tSlug">slug</label><input class="input ltr" dir="ltr" id="tSlug" maxlength="60" value="' + esc(t ? t.slug : suggestSlug(c)) + '"></div>' +
      '<div class="field"><label for="tStatus">סטטוס</label><select class="select" id="tStatus">' + statuses.map(s => C.opt(s, (C.ST.tenant || {})[s] || s, t ? t.status : 'sandbox')).join('') + '</select></div>' +
      '<div class="field"><label for="tNum">מספר Twilio</label><input class="input ltr" dir="ltr" id="tNum" inputmode="tel" placeholder="+17135550100" value="' + esc(t && t.twilio_number || '') + '"></div></div>' +
      '<div class="field"><label for="tJson">קונפיג (JSON, נבדק מול tenant_schema.json)</label><textarea class="textarea ltr mono tjson" dir="ltr" lang="en" id="tJson" spellcheck="false" rows="22">' + esc(text) + '</textarea></div>' +
      '<div id="tMsg" aria-live="polite"></div>' +
      '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" id="tCheck">בדיקה מול הסכמה</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="tMerge"' + (ob.length ? '' : ' disabled') + '>מיזוג נתוני הקליטה</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="tFmt">סידור JSON</button>' +
      '<button type="button" class="btn btn--primary btn--sm" id="tSave">' + (t ? 'שמירה' : 'יצירת tenant') + '</button></div>' +
      '<p class="muted small">בדיקות שקיימות רק במודל של ה-runtime (פתיחה לפני סגירה, "listed" צריך פריטים, dial צריך מספר, לפחות איש קשר אחד להתראות) רצות כשה-runtime טוען את ה-tenant.</p>' +
      '<div class="btnrow"><button type="button" class="btn btn--ghost btn--sm" id="tSim" disabled aria-describedby="tSimNote">הרץ 20 תרחישי סימולטור</button></div>' +
      '<p class="muted small" id="tSimNote">דורש endpoint ‏<bdi dir="ltr">/admin/sim-run</bdi> ב-runtime (עוד לא קיים; B12). בינתיים: <bdi dir="ltr">python -m sim run --all</bdi>.</p>' +
      '<h3>נתוני הקליטה מהלקוח</h3>' + (ob.length ? '<ul class="plist obdata">' + ob.map(o => '<li><span class="grow"><b dir="ltr" lang="en">' + esc(o.title) + '</b> ' + C.pill('ob', o.status) +
        (o.data && o.data.help_message ? '<br><span class="small">בקשת עזרה: <bdi dir="auto">' + esc(o.data.help_message) + '</bdi></span>' : '') +
        (o.data && Object.keys(o.data).length ? '<details><summary class="small">נתונים</summary><pre dir="ltr" class="mono small">' + esc(JSON.stringify(o.data, null, 2)) + '</pre></details>' : '') + '</span></li>').join('') + '</ul>'
        : '<p class="muted">הצ\'ק-ליסט עוד לא נפתח (נפתח כשהמקדמה מסומנת כשולמה).</p>');
    C.focusDetail();
    const ta = C.$('#tJson');
    ta.addEventListener('input', () => { draft[k] = ta.value; });
    C.$('#tCheck').addEventListener('click', () => check(true));
    C.$('#tFmt').addEventListener('click', () => { const v = parse(); if (v.ok) { ta.value = JSON.stringify(v.value, null, 2); draft[k] = ta.value; } });
    C.$('#tMerge').addEventListener('click', () => {
      const v = parse(); if (!v.ok) return;
      ta.value = JSON.stringify(fromOnboarding(c, ob, v.value), null, 2); draft[k] = ta.value;
      check(false); C.toast('נתוני הקליטה מוזגו לעורך. עוד לא נשמר.');
    });
    C.$('#tSave').addEventListener('click', async e => {
      const b = e.currentTarget;
      const v = check(false); if (!v) return;
      const slug = C.$('#tSlug').value.trim(), num = C.$('#tNum').value.trim();
      if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(slug)) { msg([E.tenants_slug_check]); return; }
      if (num && !/^\+[1-9][0-9]{6,14}$/.test(num)) { msg([E.tenants_twilio_number_check]); return; }
      b.disabled = true;
      try {
        const saved = await C.AB.adminSaveTenant({ id: t ? t.id : null, client_id: c.id, slug, status: C.$('#tStatus').value, twilio_number: num || null, config: v });
        delete draft[k];
        await C.refresh(); C.go('tenants', saved.id); C.toast(t ? 'ה-tenant נשמר.' : 'ה-tenant נוצר.');
      } catch (er) { b.disabled = false; msg([err(er)]); }
    });
    if (draft[k] != null || t) check(false, true);
  }
  function suggestSlug(c) {
    return (C.clientName(c) || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).padEnd(3, '0') || 'tenant';
  }
  function parse() {
    try { const v = JSON.parse(C.$('#tJson').value); if (!v || typeof v !== 'object' || Array.isArray(v)) { msg([E.config_must_be_object]); return { ok: false }; } return { ok: true, value: v }; }
    catch (e) { msg(['JSON לא תקין: ' + e.message]); return { ok: false }; }
  }
  // lines are plain text (escaped here); html=true only for lines this file built from escaped parts
  function msg(lines, ok, html) {
    const esc = C.esc;
    C.$('#tMsg').innerHTML = ok ? '<div class="notice notice--ok" role="status"><div>' + esc(lines[0]) + '</div></div>'
      : '<div class="notice notice--err" role="alert"><ul class="errs">' + lines.map(l => '<li>' + (html ? l : esc(l)) + '</li>').join('') + '</ul></div>';
  }
  // returns the parsed config when valid, else null (and shows the errors)
  function check(announce, quiet) {
    const v = parse(); if (!v.ok) return null;
    if (!TS.schema) { msg(['הסכמה (tenant_schema.json) לא נטענה. רעננו את הדף.']); return null; }
    const errs = TS.validate(v.value).map(messageHe);
    if (errs.length) {
      msg(errs.slice(0, 40).map(e => '<bdi dir="ltr" class="mono">' + C.esc(e.path) + '</bdi>: ' + C.esc(e.text)).concat(errs.length > 40 ? ['ועוד ' + (errs.length - 40) + '…'] : []), false, true);
      return null;
    }
    if (announce || !quiet) msg(['הקונפיג תקין מול tenant_schema.json.'], true);
    return v.value;
  }

  // client checklist data -> tenant config (review in the editor, then save)
  function fromOnboarding(c, items, base) {
    const cfg = JSON.parse(JSON.stringify(base || {}));
    const get = key => (items.find(i => i.key === key) || {}).data || {};
    const p = C.prof(c.user_id) || {};
    const q = C.D.qs.filter(x => x.user_id === c.user_id).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0] || {};
    cfg.business = Object.assign({}, { name: c.business_name || p.company || '', niche: p.niche || q.niche || 'home_services', timezone: p.timezone || '' }, toE164(p.phone) ? { main_phone: toE164(p.phone) } : {}, cfg.business || {});
    const h = get('hours'); if (h.hours) cfg.hours = h.hours; if (h.timezone) cfg.business.timezone = h.timezone; if (h.after_hours) cfg.after_hours = h.after_hours;
    const f = get('faq'); if (f.faq) cfg.faq = f.faq;
    cfg.booking = Object.assign({}, cfg.booking || {});
    if (f.services) cfg.booking.job_types = f.services;
    const cal = get('calendar'); if (cal.provider) cfg.booking.provider = cal.provider; if (cal.booking_link) cfg.booking.booking_link = cal.booking_link;
    if (!cfg.booking.windows) cfg.booking.windows = [['08:00', '12:00'], ['12:00', '16:00']];
    const a = get('alerts');
    if (a.notify) cfg.notify = a.notify;
    if (a.emergency) cfg.emergency = Object.assign({}, cfg.emergency || {}, a.emergency);
    if (a.on_call_number !== undefined) cfg.handoff = Object.assign({}, cfg.handoff || {}, { mode: a.on_call_number ? 'dial' : 'message', number: a.on_call_number || null });
    const z = get('tools'); if (z.zapier_webhook_url) cfg.zapier = Object.assign({}, cfg.zapier || {}, { webhook_url: z.zapier_webhook_url });
    return cfg;
  }

  window.AdminTenants = { render, fromOnboarding };
})();
