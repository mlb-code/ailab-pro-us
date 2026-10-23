/* /start/ portal: "Results" tab (appointment manager, 2026-10-23). Loaded before portal-b.js, which adds the tab for
   receptionist clients (RCP/BNDL) with a tenant and asks this module for its data, HTML and event handlers.
   Shows this month vs. last month (calls answered, after hours, bookings, messages, customer confirmations, moves,
   cancellations, no-shows), the estimated value (bookings x the average job value the client enters), the calls worth
   calling back (a message was taken, a job type is known, no booking from that number since) and the booking list
   with statuses and a "No-show" button for visits that have started.
   Data only through window.Backend: getResults (client_results RPC), markNoShow (client_mark_no_show RPC, started
   visits only, undo allowed), setAvgJobValue (client_set_avg_job_value RPC). Client-facing text: US English. */
(function () {
  const S = window.Start, B = window.Backend;
  const esc = s => S.esc(s);
  const STATUS = { confirmed: 'Booked', rescheduled: 'Moved', cancelled: 'Cancelled', no_show: 'No-show', completed: 'Done' };
  const fmtPhone = e => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (e || ''); };
  const tz = d => (d.tenant && d.tenant.config && d.tenant.config.business && d.tenant.config.business.timezone) || (window.__profileTz || undefined);
  const when = (iso, d) => S.fmtDate(iso, true, tz(d));
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');
  const monthLabel = m => { const p = String(m || '').split('-'); return p.length === 2 ? new Date(Date.UTC(+p[0], +p[1] - 1, 15)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) : ''; };

  async function load(d) {
    d.results = null;
    if (!d.tenant) return d;
    try { d.results = await B.getResults(d.tenant.id); } catch (e) { d.results = null; }
    return d;
  }
  function statusOf(b) {
    if (b.status === 'confirmed' && b.confirmed_at) return ['confirmed', 'Confirmed by customer'];
    return [b.status, STATUS[b.status] || b.status];
  }
  const started = b => !!b.start_at && Date.parse(b.start_at) <= Date.now();

  function stat(label, value, prev, id) {
    let delta = '';
    if (prev != null) {
      const diff = value - prev;
      delta = '<span class="muted small">' + (prev === 0 && value === 0 ? 'same as last month' : (diff === 0 ? 'same as last month' : (diff > 0 ? '+' : '−') + Math.abs(diff) + ' vs. last month')) + '</span>';
    }
    return '<div class="rs__stat"' + (id ? ' id="' + id + '"' : '') + '><span class="rs__l">' + esc(label) + '</span><b class="num rs__v">' + esc(String(value)) + '</b>' + delta + '</div>';
  }

  function html(d) {
    const r = d.results;
    if (!r) return '<div class="empty">Results are not available right now. Please try again later.</div>';
    const p = r.previous || {};
    const stats = [
      stat('Calls answered', r.calls_answered, p.calls_answered, 'rsCalls'),
      stat('After hours', r.after_hours_calls, p.after_hours_calls),
      stat('Jobs booked', r.booked, p.booked, 'rsBooked'),
      stat('Messages taken', r.messages, p.messages),
      stat('Confirmed by customer', r.confirmations, p.confirmations),
      stat('Moved / cancelled', r.reschedules + ' / ' + r.cancellations, null),
      stat('No-shows', r.no_shows, p.no_shows)].join('');
    const value = r.est_value_usd != null
      ? '<p id="rsValue"><b class="num">' + usd(r.est_value_usd) + '</b> estimated value of booked jobs (' + esc(String(r.booked)) + ' × ' + usd(r.avg_job_value_usd) + ' average job). This is an estimate, not revenue.</p>'
      : '<p id="rsValue" class="muted">Enter your average job value to see the estimated value of the jobs your receptionist booked.</p>';
    const back = (r.worth_calling_back || []).map(c => '<li class="call"><div class="call__h"><a class="mono" href="tel:' + esc(c.phone) + '">' + esc(fmtPhone(c.phone)) + '</a><span class="muted small">' + esc(when(c.at, d)) + ' · ' + esc(c.job_type) + '</span></div>' +
      (c.summary ? '<p class="call__s">' + esc(c.summary) + '</p>' : '') + '</li>').join('');
    const bookings = (d.bookings || []).map(b => {
      const st = statusOf(b);
      const btn = b.status === 'confirmed' && started(b) ? '<button type="button" class="btn btn--ghost btn--sm" data-noshow="' + esc(b.id) + '">Mark no-show</button>'
        : b.status === 'no_show' ? '<button type="button" class="btn btn--ghost btn--sm" data-undo-noshow="' + esc(b.id) + '">Undo no-show</button>' : '';
      return '<li class="bk rs__bk"><div><b>' + esc(b.job_type || 'Job') + '</b> · ' + esc(b.customer_name || '') + ' <span class="pill pill--' + esc(st[0]) + '">' + esc(st[1]) + '</span></div>' +
        '<div class="muted small">' + esc(when(b.start_at, d)) + (b.contact_e164 ? ' · <span class="mono">' + esc(fmtPhone(b.contact_e164)) + '</span>' : '') + '</div>' + (btn ? '<div>' + btn + '</div>' : '') + '</li>';
    }).join('');
    const avg = r.avg_job_value_usd != null ? String(r.avg_job_value_usd) : '';
    return '<section class="card rs"><h2 class="h-card">' + esc(monthLabel(r.month)) + ' so far</h2><div class="rs__grid">' + stats + '</div>' + value +
      '<form class="rs__avg" id="rsAvgForm" novalidate><label for="rsAvg">Your average job value (USD)</label><div class="rs__row"><input id="rsAvg" class="num" type="number" inputmode="decimal" min="1" max="100000" step="1" value="' + esc(avg) + '">' +
      '<button type="submit" class="btn btn--primary btn--sm">Save</button></div><div id="rsAvgMsg" aria-live="polite"></div></form></section>' +
      '<h2 class="h-sec">Worth calling back</h2><p class="muted small">Callers this month who left a message about a job and have not booked since.</p>' +
      (back ? '<ul class="calls" id="rsBack">' + back + '</ul>' : '<div class="empty" id="rsBack">No one to call back right now.</div>') +
      '<h2 class="h-sec">Bookings</h2>' + (bookings ? '<ul class="calls" id="rsBookings">' + bookings + '</ul>' : '<div class="empty">No bookings yet.</div>') +
      '<div id="rsMsg" aria-live="polite"></div>';
  }

  function bind(d, api) {
    const msg = (id, text, kind) => { const el = S.$('#' + id); if (el) el.innerHTML = text ? S.msgHtml(text, kind || 'err') : ''; };
    const form = S.$('#rsAvgForm');
    if (form) form.addEventListener('submit', async e => {
      e.preventDefault();
      const raw = S.$('#rsAvg').value.trim(), v = raw === '' ? null : Number(raw);
      if (v !== null && !(v > 0 && v <= 100000)) { msg('rsAvgMsg', 'Enter an amount between 1 and 100,000.'); return; }
      const b = form.querySelector('button'); b.disabled = true;
      try { await B.setAvgJobValue(d.tenant.id, v); S.toast('Saved'); await api.refresh('results', ['#rsAvg']); }
      catch (er) { b.disabled = false; msg('rsAvgMsg', S.errText(er)); }
    });
    S.$$('[data-noshow],[data-undo-noshow]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.noshow || b.dataset.undoNoshow, on = !!b.dataset.noshow;
      b.disabled = true;
      try { await B.markNoShow(id, on); S.toast(on ? 'Marked as no-show' : 'No-show removed'); await api.refresh('results', ['#rsBookings button']); }
      catch (er) { b.disabled = false; msg('rsMsg', S.errText(er)); }
    }));
    return true;
  }

  window.PortalResults = { load, html, bind, statusOf };
})();
