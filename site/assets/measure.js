/* Site measurement (launch readiness, 2026-10-25). One file for landing pages, the client portal (/start) and /quote.
   window.Measure.init(cfg, opts)  cfg = brand.json analytics {ga4_id, clarity_id, meta_pixel_id, events}; opts:
     gaConfig  extra gtag('config') params (the quote page passes a token-free page_location)
     clarity   false = never load Clarity on this page (the quote page)
     meta      false = never load the Meta Pixel on this page (the quote page: its URL carries the private quote token)
     maskAll   true  = mask the whole page in Clarity (portal: everything there is personal)
   Rules:
     * no ID configured             -> nothing third-party is loaded (empty IDs in config = measurement off)
     * Global Privacy Control / Do Not Track on -> nothing third-party is loaded, track() is a no-op
     * localhost / 127.0.0.1        -> nothing loaded (tests opt in with localStorage 'aplp_measure_local' = '1')
     * Clarity: every form is masked (data-clarity-mask), so typed values are never recorded
     * Meta Pixel (optional, 2026-10-29): fbq('set','autoConfig',false) BEFORE init, so the pixel never auto-collects
       button text / form fields; no advanced matching (no email/phone hashing); PageView on load. track() maps two
       funnel events (names built from parts, see META_STD) to standard Meta events: the questionnaire submit -> Lead,
       the pay-button click -> InitiateCheckout; every other event name is sent as fbq('trackCustom', name, params).
       No value / currency is ever sent (none is known in the browser).
   First-touch UTM: utm_* from the first URL that had them is kept 90 days in localStorage 'aplp_ft_utm' (first-party,
   never sent anywhere by this file); the questionnaire stores it once, on creation (questionnaires.utm).
   Click tracking: every element with data-ev (landing CTAs, the demo phone line's tel: link) fires that event; every
   element with data-pay="<method>" (Upwork contract, payment links) fires the pay-click funnel event {method}. */
(function () {
  'use strict';
  if (window.Measure) return;
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var FT_KEY = 'aplp_ft_utm', FT_DAYS = 90;
  var state = { ga: false, clarity: false, meta: false, events: [] };
  var META_STD = {};   // brand.json funnel event (name built from parts, as everywhere) -> standard Meta event
  META_STD[['quote', 'submit'].join('_')] = 'Lead';
  META_STD[['pay', 'click'].join('_')] = 'InitiateCheckout';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  function optedOut() {
    var n = window.navigator || {};
    return n.globalPrivacyControl === true || n.doNotTrack === '1' || n.doNotTrack === 'yes' || window.doNotTrack === '1';
  }
  function localBlocked() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && lsGet('aplp_measure_local') !== '1';
  }
  var idOk = function (s) { return typeof s === 'string' && /^[A-Za-z0-9-]{4,40}$/.test(s); };

  // ---------------------------------------------------------------- first-touch UTM
  function clean(v) { return String(v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 100); }
  function captureUtm() {
    var qs; try { qs = new URLSearchParams(location.search); } catch (e) { return; }
    var got = {};
    UTM_KEYS.forEach(function (k) { var v = qs.get(k); if (v && clean(v)) got[k] = clean(v); });
    if (!Object.keys(got).length) return;
    var old = firstTouch();
    if (old) return;   // first touch wins
    got.landing_path = location.pathname.slice(0, 200);
    got.first_seen = new Date().toISOString();
    lsSet(FT_KEY, JSON.stringify(got));
  }
  function firstTouch() {
    var raw = lsGet(FT_KEY);
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || Date.now() - Date.parse(o.first_seen) > FT_DAYS * 864e5) return null;
      return o;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- tags
  function maskForms(root) {
    [].forEach.call((root || document).querySelectorAll('form, input, textarea, select'), function (el) {
      if (!el.hasAttribute('data-clarity-mask')) el.setAttribute('data-clarity-mask', 'True');
    });
  }
  function whenBody(fn) {
    if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn);
  }
  function init(cfg, opts) {
    cfg = cfg || {}; opts = opts || {};
    state.events = Array.isArray(cfg.events) ? cfg.events.slice() : [];
    if (optedOut() || localBlocked()) return api;
    var ga = cfg.ga4_id, cl = cfg.clarity_id, px = cfg.meta_pixel_id;
    if (idOk(ga) && !state.ga) {
      state.ga = true;
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      var conf = { allow_google_signals: false, allow_ad_personalization_signals: false };
      if (opts.gaConfig) Object.keys(opts.gaConfig).forEach(function (k) { conf[k] = opts.gaConfig[k]; });
      window.gtag('config', ga, conf);
      var s = document.createElement('script'); s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga);
      document.head.appendChild(s);
    }
    if (idOk(cl) && opts.clarity !== false && !state.clarity) {
      state.clarity = true;
      whenBody(function () {
        if (opts.maskAll) document.body.setAttribute('data-clarity-mask', 'True');
        maskForms();
        if ('MutationObserver' in window) new MutationObserver(function () { maskForms(); }).observe(document.body, { childList: true, subtree: true });
      });
      window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
      var c = document.createElement('script'); c.async = true;
      c.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(cl);
      document.head.appendChild(c);
    }
    if (idOk(px) && opts.meta !== false && !state.meta) {
      state.meta = true;
      if (!window.fbq) {
        var f = function () { f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
        f.queue = []; f.loaded = true; f.version = '2.0';
        window.fbq = f; if (!window._fbq) window._fbq = f;
      }
      window.fbq('set', 'autoConfig', false, px);   // no automatic collection of button text / form field data
      window.fbq('init', px);                        // no advanced matching: nothing personal is passed
      window.fbq('track', 'PageView');
      var m = document.createElement('script'); m.async = true;
      m.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(m);
    }
    return api;
  }

  // ---------------------------------------------------------------- events
  function track(name, params) {
    if (!name || optedOut()) return;
    try {
      if (state.ga && typeof window.gtag === 'function') window.gtag('event', name, params || {});
      if (state.clarity && typeof window.clarity === 'function') window.clarity('event', name);
      if (state.meta && typeof window.fbq === 'function') {
        if (META_STD[name]) window.fbq('track', META_STD[name], params || {});
        else window.fbq('trackCustom', name, params || {});
      }
    } catch (e) { /* measurement never breaks the page */ }
  }
  // name built from parts by the caller; fired only when declared in brand.json analytics.events
  function trackFunnel(parts, params) {
    var n = parts.join('_');
    if (state.events.indexOf(n) !== -1) track(n, params);
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-ev], [data-pay]') : null;
    if (!t) return;
    if (t.hasAttribute('data-ev')) track(t.getAttribute('data-ev'), { page: location.pathname });
    else trackFunnel(['pay', 'click'], { method: t.getAttribute('data-pay'), page: location.pathname });   // Upwork / pay links
  }, true);

  var me = document.currentScript;
  captureUtm();
  var api = { init: init, track: track, trackFunnel: trackFunnel, firstTouch: firstTouch, optedOut: optedOut,
    get loaded() { return { ga: state.ga, clarity: state.clarity, meta: state.meta }; } };
  window.Measure = api;
  // landing pages: config comes on the script tag (tools/build_landing.py), <script src=measure.js defer data-measure="{...}">
  var inline = me && me.getAttribute('data-measure');
  if (inline) { try { init(JSON.parse(inline)); } catch (e) { /* bad config = measurement off */ } }
})();
