/* /start/ portal: ADD-DISPATCH ("Night calls reach a real technician"), inside My receptionist.
   Shown only when the tenant config has a `dispatch` section (the add-on is on the account; our team switches it on).
   - On-call team: up to 5 people {name, mobile, technician|manager}, each with a written alert opt-in (the server stamps
     the time and logs it; the browser never sends a timestamp).
   - Weekly schedule: shifts (day, from, to; "to" earlier than "from" = runs past midnight) with up to 3 people in order.
   - Call-back window promised to the caller when nobody picks up, and the daytime option.
   - Urgent call log: who was tried, who took it and how fast, alerts sent, and a "Handled" button that stops the repeat.
   Data only through window.Backend: saveDispatch (update_dispatch_settings RPC), listDispatchEvents (dispatch_events,
   own tenant by RLS), markDispatchHandled (mark_dispatch_handled RPC). No prices or brand strings typed here. */
(function () {
  const S = window.Start, B = window.Backend, TS = window.TenantSchema;
  const esc = s => S.esc(s);
  const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  const MAX_PEOPLE = 5, MAX_SHIFTS = 28, PER_SHIFT = 3;
  const RESULT = { no_answer: 'no answer', declined: 'declined', accepted: 'took the call', alert_sent: 'alert sent', acknowledged: 'said they’re on it', handled: 'marked handled', opted_out: 'opted out' };
  const fmtPhone = e => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (e || ''); };
  const toE164 = s => window.PortalB.toE164(s);
  const newId = i => 'c' + Date.now().toString(36).slice(-5) + i;

  async function load(d) {
    d.dispatchEvents = [];
    const cfg = (d.tenant && d.tenant.config) || {};
    if (!cfg.dispatch) return d;
    try { d.dispatchEvents = (await B.listDispatchEvents(d.tenant.id)) || []; } catch (e) { d.dispatchEvents = []; }
    return d;
  }

  // ------------------------------------------------------------ editor
  function personRow(p, i, business, brand) {
    const px = 'dp' + i;
    return '<div class="dperson" data-i="' + i + '" data-id="' + esc(p.id || newId(i)) + '" data-stamp="' + esc(p.alerts_opt_in_at || '') + '">' +
      '<div class="field"><label for="' + px + 'n">Name</label><input class="input" id="' + px + 'n" maxlength="60" autocomplete="off" value="' + esc(p.name || '') + '" placeholder="Dan"></div>' +
      '<div class="field"><label for="' + px + 'p">Mobile number</label><input class="input" id="' + px + 'p" inputmode="tel" autocomplete="off" value="' + esc(fmtPhone(p.phone || '')) + '" placeholder="(713) 555-0100"></div>' +
      '<div class="field"><label for="' + px + 'r">Role</label><select class="input" id="' + px + 'r"><option value="tech"' + (p.role !== 'manager' ? ' selected' : '') + '>Technician</option><option value="manager"' + (p.role === 'manager' ? ' selected' : '') + '>Manager (tried last, gets alerts)</option></select></div>' +
      '<label class="check"><input type="checkbox" id="' + px + 'o"' + ((p._opt !== undefined ? p._opt : p.alerts_opt_in_at) ? ' checked' : '') + '> <span>This person agreed to receive on-call alerts (calls and, later, texts) from ' + esc(business) + ' via ' + esc(brand) + '.' +
      (p.alerts_opt_in_at ? ' <span class="muted small">Confirmed ' + esc(S.fmtDate(p.alerts_opt_in_at, false)) + '.</span>' : '') + '</span></label>' +
      '<button type="button" class="linkbtn" data-dprm="' + i + '" aria-label="Remove person ' + (i + 1) + '">Remove</button></div>';
  }
  function shiftRow(s, i, people) {
    const px = 'ds' + i;
    const opt = (sel, first) => (first ? '' : '<option value="">—</option>') + people.map(p => '<option value="' + esc(p.id) + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.name || 'Unnamed') + '</option>').join('');
    return '<div class="dshift" data-i="' + i + '"><div class="row">' +
      '<label class="sr-only" for="' + px + 'd">Shift ' + (i + 1) + ' day</label><select class="input" id="' + px + 'd">' + DAYS.map(([k, l]) => '<option value="' + k + '"' + (k === s.day ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
      '<label class="sr-only" for="' + px + 'a">Shift ' + (i + 1) + ' starts</label><input class="input input--time" type="time" id="' + px + 'a" value="' + esc(s.start || '18:00') + '">' +
      '<span class="muted" aria-hidden="true">to</span><label class="sr-only" for="' + px + 'b">Shift ' + (i + 1) + ' ends</label><input class="input input--time" type="time" id="' + px + 'b" value="' + esc(s.end || '07:00') + '"></div>' +
      '<div class="row">' + [0, 1, 2].map(k => '<label class="small" for="' + px + 'c' + k + '">' + ['Call first', 'then', 'then'][k] + '</label><select class="input" id="' + px + 'c' + k + '">' + opt((s.contacts || [])[k], k === 0) + '</select>').join('') + '</div>' +
      '<button type="button" class="linkbtn" data-dsrm="' + i + '" aria-label="Remove shift ' + (i + 1) + '">Remove shift</button></div>';
  }
  function editorHtml(cfg) {
    const ds = cfg.dispatch || {}, business = (cfg.business || {}).name || 'your business', brand = (S.BRAND && S.BRAND.name) || 'us';
    const people = (ds.contacts || []).length ? ds.contacts : [{}];
    const shifts = (ds.schedule || []).length ? ds.schedule : [];
    return '<p class="muted small">For urgent calls ' + (ds.daytime_too ? 'at any time' : 'outside your opening hours') + ', your receptionist asks for the caller’s first name and ZIP, then rings your on-call person. Only they hear a one-line brief and press 1 to take the call. We try up to 3 of your numbers, then alert your team. ' +
      (ds.enabled ? '<b>Status: on.</b>' : '<b>Status: not switched on yet.</b> Fill this in and we’ll switch it on with you.') + '</p>' +
      '<fieldset class="field"><legend class="label">On-call team (up to ' + MAX_PEOPLE + ')</legend><div id="dPeople">' + people.map((p, i) => personRow(p, i, business, brand)).join('') + '</div>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="dPersonAdd">Add a person</button></fieldset>' +
      '<fieldset class="field"><legend class="label">Weekly on-call schedule</legend><p class="hint">Times are in your business’s time zone. A shift that ends earlier than it starts runs past midnight. Outside every shift we call your managers.</p>' +
      '<div id="dShifts">' + shifts.map((s, i) => shiftRow(s, i, ds.contacts || [])).join('') + '</div>' +
      '<div class="row"><button type="button" class="btn btn--ghost btn--sm" id="dShiftAdd">Add a shift</button><button type="button" class="btn btn--ghost btn--sm" id="dShiftWeek">Same shift every night</button></div></fieldset>' +
      '<div class="field"><label for="dCb">If nobody picks up, the caller hears “a technician will call you back within … minutes”</label><input class="input input--time" type="number" min="5" max="120" step="1" id="dCb" value="' + esc(ds.callback_minutes || 15) + '"></div>' +
      '<label class="check"><input type="checkbox" id="dDay"' + (ds.daytime_too ? ' checked' : '') + '> <span>Also during opening hours (we ring your on-call number from the settings above first)</span></label>' +
      '<div id="rxMsg_dispatch" aria-live="polite"></div><button type="button" class="btn btn--primary btn--sm" data-dsave="1">Save on-call settings</button>';
  }
  function readPeople(all) {
    return S.$$('#dPeople .dperson').map(r => {
      const px = 'dp' + r.dataset.i;
      return { id: r.dataset.id, name: S.$('#' + px + 'n').value.trim(), phoneRaw: S.$('#' + px + 'p').value.trim(), role: S.$('#' + px + 'r').value,
        opt_in: S.$('#' + px + 'o').checked, alerts_opt_in_at: r.dataset.stamp || null };
    }).filter(p => all || p.name || p.phoneRaw);
  }
  function readShifts() {
    return S.$$('#dShifts .dshift').map(r => {
      const px = 'ds' + r.dataset.i;
      const contacts = [0, 1, 2].map(k => S.$('#' + px + 'c' + k).value).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      return { day: S.$('#' + px + 'd').value, start: S.$('#' + px + 'a').value, end: S.$('#' + px + 'b').value, contacts };
    });
  }
  function collect() {
    const errs = [], seen = {};
    const people = readPeople().map((p, i) => {
      const n = toE164(p.phoneRaw);
      if (!p.name) errs.push('Person ' + (i + 1) + ' needs a name.');
      if (!n || /^invalid:/.test(n) || !/^\+1[2-9]\d{9}$/.test(n)) errs.push('Person ' + (i + 1) + ': “' + p.phoneRaw + '” doesn’t look like a US phone number.');
      else if (seen[n]) errs.push('The number ' + fmtPhone(n) + ' is listed twice.'); else seen[n] = 1;
      return { id: p.id, name: p.name, phone: n, role: p.role, opt_in: p.opt_in };
    });
    if (!people.length) errs.push('Add at least one person.');
    if (people.length > MAX_PEOPLE) errs.push('Up to ' + MAX_PEOPLE + ' people.');
    const ids = people.map(p => p.id);
    const schedule = readShifts();
    schedule.forEach((s, i) => {
      if (!s.contacts.length) errs.push('Shift ' + (i + 1) + ': choose who we call first.');
      if (s.contacts.some(c => ids.indexOf(c) === -1)) errs.push('Shift ' + (i + 1) + ': someone in this shift was removed. Pick again.');
      TS.validate({ day: s.day, start: s.start, end: s.end, contacts: s.contacts.length ? s.contacts : ['x'] }, '#/$defs/DispatchShift').forEach(e => errs.push('Shift ' + (i + 1) + ': ' + TS.messageEn(e)));
    });
    if (schedule.length > MAX_SHIFTS) errs.push('Up to ' + MAX_SHIFTS + ' shifts.');
    const cb = Number(S.$('#dCb').value);
    if (!Number.isInteger(cb) || cb < 5 || cb > 120) errs.push('Call-back window: a whole number of minutes from 5 to 120.');
    return { errs, patch: { contacts: people, schedule, callback_minutes: cb, daytime_too: S.$('#dDay').checked } };
  }

  // ------------------------------------------------------------ log
  function logHtml(d) {
    const rows = (d.dispatchEvents || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const optOuts = rows.filter(r => r.result === 'opted_out');
    const calls = {};
    rows.filter(r => r.call_sid).forEach(r => { (calls[r.call_sid] = calls[r.call_sid] || []).push(r); });
    const items = Object.keys(calls).map(k => calls[k]).sort((a, b) => String(b[0].at).localeCompare(String(a[0].at))).map(ev => {
      const sid = ev[0].call_sid, legs = ev.filter(r => r.leg !== null && r.leg !== undefined && ['no_answer', 'declined', 'accepted'].indexOf(r.result) !== -1);
      const took = ev.find(r => r.result === 'accepted'), ack = ev.find(r => r.result === 'acknowledged'), done = ev.find(r => r.result === 'handled');
      const status = took ? ['booked', 'Connected to ' + took.contact_name + (took.wait_s != null ? ' in ' + took.wait_s + ' s' : '')]
        : done ? ['done', 'Handled'] : ack ? ['live', ack.contact_name + ' is on it'] : ['emergency', 'Needs a call-back'];
      const chain = legs.map(r => esc(r.contact_name || 'Someone') + ': ' + esc(RESULT[r.result] || r.result)).join(' → ');
      const alerts = ev.filter(r => r.result === 'alert_sent').map(r => esc(r.contact_name || '')).filter(Boolean);
      return '<li class="call" data-dcall="' + esc(sid) + '"><div class="call__h"><span class="pill pill--' + esc(status[0]) + '">' + esc(status[1]) + '</span><span class="muted small">' + esc(S.fmtDate(ev[0].at, true)) + '</span></div>' +
        (chain ? '<p class="call__s">' + chain + '</p>' : '') + (alerts.length ? '<p class="muted small">Alerts sent: ' + alerts.join(', ') + '</p>' : '') +
        (!took && !done ? '<button type="button" class="btn btn--ghost btn--sm" data-dhandled="' + esc(sid) + '">Mark handled</button>' : '') + '</li>';
    }).join('');
    return '<h3 class="h-sub">Urgent call log</h3>' +
      optOuts.map(r => S.msgHtml((r.contact_name || 'Someone') + ' replied STOP and gets no more on-call alerts. Ask them, or remove them from the team.', 'info')).join('') +
      (items ? '<ul class="calls" id="dLog">' + items + '</ul>' : '<div class="empty">No urgent calls yet. Each one shows who we tried, who took it and how fast.</div>');
  }

  function html(d) {
    const cfg = (d.tenant && d.tenant.config) || {};
    if (!cfg.dispatch) return '';
    return '<details class="card set" id="setDispatch"><summary>Night calls: on-call technicians</summary>' + editorHtml(cfg) + logHtml(d) + '</details>';
  }

  function bind(d, api) {
    const root = S.$('#setDispatch'); if (!root) return;
    const cfg = d.tenant.config, business = (cfg.business || {}).name || 'your business', brand = (S.BRAND && S.BRAND.name) || 'us';
    const redrawPeople = list => { S.$('#dPeople').innerHTML = list.map((p, i) => personRow(p, i, business, brand)).join(''); wire(); };
    const redrawShifts = (list, people) => { S.$('#dShifts').innerHTML = list.map((s, i) => shiftRow(s, i, people)).join(''); wire(); };
    const peopleNow = () => readPeople(true).map(p => ({ id: p.id, name: p.name, phone: toE164(p.phoneRaw) || '', role: p.role, alerts_opt_in_at: p.alerts_opt_in_at, _opt: p.opt_in }));
    function wire() {
      S.$('#dPersonAdd').disabled = S.$$('#dPeople .dperson').length >= MAX_PEOPLE;
      S.$('#dShiftAdd').disabled = S.$$('#dShifts .dshift').length >= MAX_SHIFTS;
      S.$$('[data-dprm]', root).forEach(b => { b.onclick = () => { const cur = peopleNow(); cur.splice(+b.dataset.dprm, 1); redrawPeople(cur.length ? cur : [{}]); S.$('#dPersonAdd').focus(); }; });
      S.$$('[data-dsrm]', root).forEach(b => { b.onclick = () => { const cur = readShifts(); cur.splice(+b.dataset.dsrm, 1); redrawShifts(cur, peopleNow()); S.$('#dShiftAdd').focus(); }; });
    }
    S.$('#dPersonAdd').addEventListener('click', () => {
      const cur = peopleNow(); if (cur.length >= MAX_PEOPLE) return;
      const raw = S.$$('#dPeople .dperson').length; cur.push({ id: newId(raw) });
      redrawPeople(cur); S.$('#dp' + (cur.length - 1) + 'n').focus();
    });
    S.$('#dShiftAdd').addEventListener('click', () => {
      const cur = readShifts(); if (cur.length >= MAX_SHIFTS) return;
      const people = peopleNow(); if (!people.length || !people[0].name) { const el = S.$('#rxMsg_dispatch'); el.innerHTML = S.msgHtml('Add a person with a name first.', 'info'); return; }
      cur.push({ day: 'mon', start: '18:00', end: '07:00', contacts: [people[0].id] }); redrawShifts(cur, people);
      S.$('#ds' + (cur.length - 1) + 'd').focus();
    });
    S.$('#dShiftWeek').addEventListener('click', () => {
      const people = peopleNow(); if (!people.length || !people[0].name) { S.$('#rxMsg_dispatch').innerHTML = S.msgHtml('Add a person with a name first.', 'info'); return; }
      const first = readShifts()[0] || { start: '18:00', end: '07:00', contacts: [people[0].id] };
      redrawShifts(DAYS.map(([k]) => ({ day: k, start: first.start, end: first.end, contacts: first.contacts.length ? first.contacts : [people[0].id] })), people);
      S.$('#ds0d').focus();
    });
    S.$('#dPeople').addEventListener('input', e => {   // names in the shift pickers follow the team list
      if (!/n$/.test(e.target.id)) return;
      const people = peopleNow();
      S.$$('#dShifts select[id$="c0"], #dShifts select[id$="c1"], #dShifts select[id$="c2"]').forEach(sel => {
        S.$$('option', sel).forEach(o => { const p = people.find(x => x.id === o.value); if (p) o.textContent = p.name || 'Unnamed'; });
      });
    });
    wire();
    S.$('[data-dsave]', root).addEventListener('click', async e => {
      const b = e.currentTarget, r = collect(), box = S.$('#rxMsg_dispatch');
      if (r.errs.length) { box.innerHTML = '<div class="notice notice--err" role="alert"><ul class="errs">' + r.errs.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>'; return; }
      b.disabled = true;
      try { await B.saveDispatch(d.tenant.id, r.patch); S.toast('Saved'); await api.refresh('receptionist', ['[data-dsave]'], true); }
      catch (er) { b.disabled = false; box.innerHTML = S.msgHtml(errText(er), 'err'); }
    });
    S.$$('[data-dhandled]', root).forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await B.markDispatchHandled(d.tenant.id, b.dataset.dhandled); S.toast('Marked handled. No more alerts for this call.'); await api.refresh('receptionist', ['[data-dsave]'], true); }
      catch (er) { b.disabled = false; S.toast(errText(er)); }
    }));
  }
  function errText(e) {
    const m = (e && (e.code || e.message)) || '';
    if (/field_not_allowed/.test(m)) return 'That setting can’t be changed here. Send us a Request instead.';
    if (/invalid_setting:dispatch\.contacts\[(\d+)\]\.phone/.test(m)) return 'Person ' + (+/\[(\d+)\]/.exec(m)[1] + 1) + ': a US mobile number, not listed twice.';
    if (/invalid_setting:dispatch\.schedule/.test(m)) return 'A shift needs a day, a start and end time (HH:MM) and someone from your team.';
    if (/invalid_setting:dispatch/.test(m)) return 'Please check the on-call settings and try again.';
    return S.errText(e);
  }
  window.PortalDispatch = { load, html, bind };
})();
