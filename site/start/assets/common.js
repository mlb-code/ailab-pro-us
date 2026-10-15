/* Client portal shared helpers (EN, LTR). Loaded after config.js, mock/mock-backend.js, backend.js.
   Brand strings and prices are never typed here: they are read from /assets/brand.json and /assets/pricebook.json
   (copies of config/*.json made by tools/sync_config.py). */
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let BRAND = {}, PB = {};
  async function loadConfig() {
    const get = async u => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error('config ' + r.status); return r.json(); };
    try { [BRAND, PB] = await Promise.all([get('/assets/brand.json'), get('/assets/pricebook.json')]); }
    catch (e) { BRAND = BRAND || {}; PB = PB || {}; }
    PB._niches = (BRAND.niches || []).map(n => ({ key: n.key, label: n.label, early: n.status === 'early_access' }));
    fillBrand();
    analytics();
    return { BRAND, PB };
  }
  function fillBrand() {
    $$('[data-brand]').forEach(el => { const v = BRAND[el.dataset.brand]; if (typeof v === 'string' && v) el.firstChild ? (el.firstChild.nodeValue = v) : (el.textContent = v); });
    if (BRAND.name && document.title.indexOf(BRAND.name) === -1) document.title = document.title + ' · ' + BRAND.name;
    const f = $('#footer');
    if (f) {
      const sup = BRAND.support_email ? ' · <a href="mailto:' + esc(BRAND.support_email) + '">' + esc(BRAND.support_email) + '</a>' : '';
      f.innerHTML = '<div class="footer__legal"><span>' + esc(BRAND.name || '') + '</span>' +
        '<a href="/legal/terms/">Terms</a><a href="/legal/privacy/">Privacy</a><a href="/legal/service-agreement/">Service Agreement</a>' +
        '<span>' + esc((BRAND.disclaimers && BRAND.disclaimers.footer) || '') + sup + '</span></div>';
    }
  }
  // GA4 + Clarity only when their IDs are configured (brand.json analytics.ga4_id / clarity_id).
  function analytics() {
    const cl = BRAND.analytics && BRAND.analytics.clarity_id;   // Microsoft Clarity, only when an ID is configured
    if (cl && !window.clarity) {
      window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
      const c = document.createElement('script'); c.async = true; c.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(cl);
      document.head.appendChild(c);
    }
    const id = BRAND.analytics && BRAND.analytics.ga4_id;
    if (!id || window.gtag) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date()); window.gtag('config', id);
    const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
  }
  // Funnel events must be declared in brand.json analytics.events; the name is built from parts so it lives only there.
  function trackFunnel(parts, params) {
    const n = parts.join('_');
    if (((BRAND.analytics && BRAND.analytics.events) || []).indexOf(n) !== -1) track(n, params);
  }
  // Promised quote turnaround, one wording everywhere: brand.json quote_sla_text (e.g. "within 24 hours").
  const sla = () => BRAND.quote_sla_text || 'soon';
  const slaCap = () => { const t = sla(); return t.charAt(0).toUpperCase() + t.slice(1); };
  // Website timeline, one wording everywhere (owner decision): first draft in 3 business days, live in WEB.delivery_business_days.
  const webTimeline = () => {
    const it = (PB.items || []).find(i => i.code === 'WEB');
    const live = it && it.delivery_business_days ? ', live in ' + it.delivery_business_days + ' business days' : '';
    return 'First draft in 3 business days' + live + ' after we have your content.';
  };
  function track(name, params) { try { if (window.gtag) window.gtag('event', name, params || {}); } catch (e) { /* analytics never breaks the page */ } }

  const money = cents => cents == null ? '' : '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  function priceOf(code) {
    const it = (PB.items || []).find(i => i.code === code);
    return it ? { setup: it.setup_cents, monthly: it.monthly_cents, name: it.name } : null;
  }
  function fmtDate(iso, withTime, tz) {
    if (!iso) return '';
    try {
      const o = { month: 'short', day: 'numeric', year: 'numeric' };
      if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
      if (tz) o.timeZone = tz;
      return new Intl.DateTimeFormat('en-US', o).format(new Date(iso));
    } catch (e) { return String(iso).slice(0, 10); }
  }
  const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

  let toastTimer;
  function toast(text, ms) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  const msgHtml = (text, kind) => text ? '<div class="notice notice--' + (kind || 'err') + '" role="' + (kind === 'ok' || kind === 'info' ? 'status' : 'alert') + '">' + esc(text) + '</div>' : '';

  const ERR = {
    questionnaire_locked: 'This questionnaire was already submitted and can’t be changed.',
    offer_required: 'Please choose what you’d like a quote for (step 1).',
    too_many_questionnaires: 'You’ve reached the questionnaire limit. Email us and we’ll open more.',
    too_many_files: 'You can attach up to 5 files.',
    invalid_timezone: 'Please pick a time zone from the list.',
    provider_disabled: 'Google sign-in isn’t available yet. Use your email instead.',
    mock_no_file_storage: 'Demo mode keeps file names only, not the files.',
    not_authenticated: 'Your session ended. Please sign in again.',
    backend_off: 'The client portal is opening soon.'
  };
  function errText(e) {
    const m = (e && (e.code || e.message || e.error_description || e.msg)) || String(e || '');
    for (const k in ERR) if (m.indexOf(k) !== -1) return ERR[k];
    if (/rate limit|too many|429|security purposes/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
    if (/expired|invalid.*(otp|token)|token.*(invalid|expired)/i.test(m)) return 'That code is wrong or has expired. You can request a new one.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Can’t reach the server. Check your connection and try again.';
    if (/payload too large|exceeded the maximum allowed size|413/i.test(m)) return 'That file is too large (10 MB max).';
    if (/mime type|invalid_mime/i.test(m)) return 'That file type isn’t supported. Images, PDF, Word, Excel or text work.';
    return 'Something went wrong. Please try again — if it keeps happening, email us.';
  }

  // header nav: signed-in = portal link + email + sign out; signed-out = back to site
  function renderHeader(session, opts) {
    const nav = $('#navlinks'); if (!nav) return;
    opts = opts || {};
    let h = '';
    if (session) {
      if (opts.portalLink) h += '<a href="/start/">Your portal</a>';
      h += '<span class="who" title="' + esc(session.user.email) + '">' + esc(session.user.email) + '</span>';
      h += '<button type="button" class="btn btn--ghost btn--sm" id="logoutBtn">Sign out</button>';
    } else {
      h += '<a href="/">Back to site</a>';
    }
    nav.innerHTML = h;
    const lb = $('#logoutBtn');
    if (lb) lb.addEventListener('click', async () => { await window.Backend.signOut(); location.href = '/start/'; });
  }

  function mockBanner() {
    if (window.Backend.mode !== 'mock' || $('#mockBanner')) return;
    const b = document.createElement('div');
    b.id = 'mockBanner'; b.className = 'mockbar'; b.setAttribute('role', 'note');
    b.textContent = 'Demo mode: data stays in this browser and no e-mails are sent.';
    document.body.insertBefore(b, document.body.firstChild);
  }

  function offline(root) {
    root.innerHTML = '<span class="eyebrow">Client portal</span><h1 class="t">The client portal opens soon.</h1>' +
      '<p class="lead">In the meantime, email us and we’ll send you the questionnaire link as soon as it’s live.</p>' +
      (BRAND.support_email ? '<a class="btn btn--primary" href="mailto:' + esc(BRAND.support_email) + '">Email us</a>' : '');
  }

  const ls = {
    get: k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del: k => { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del: k => { try { sessionStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };

  window.Start = {
    $, $$, esc, loadConfig, get BRAND() { return BRAND; }, get PB() { return PB; }, track, trackFunnel, sla, slaCap, webTimeline, money, priceOf, fmtDate, fmtSize,
    toast, msgHtml, errText, renderHeader, mockBanner, offline, ls, ss
  };
})();
