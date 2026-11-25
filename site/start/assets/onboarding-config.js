/* Setup checklist data -> tenant config, the browser copy of private.onboarding_patch / parse_price_lines /
   parse_service_area (supabase/migrations/20261125100000_us_subscriptions.sql). Same rules, same error codes
   (invalid_setting:<path>); supabase/tests/offline/onboarding_parity_run.ts runs both on the same inputs and compares.
   Used by: the mock backend (every checklist save of a FirstRing plan client goes straight into the live config, like the
   database trigger) and the admin "merge onboarding data" button for quote clients. No DOM, no network.
     OnboardingConfig.patch(key, data, cfg)   -> new config (throws Error with .code = 'invalid_setting:<path>')
     OnboardingConfig.merge(cfg, items)       -> every item's data applied in checklist order (bad items skipped)
     OnboardingConfig.parsePrices(lines)      -> [{name, price_usd, note}]   (unreadable lines skipped)
     OnboardingConfig.parseArea(text)         -> {zips: [...], places: [...]}  */
(function (root) {
  const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const US = v => typeof v === 'string' && /^\+1[2-9][0-9]{9}$/.test(v);
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const TZ_OK = tz => { try { return typeof tz === 'string' && tz.length <= 64 && !!new Intl.DateTimeFormat('en-US', { timeZone: tz }) && /\//.test(tz); } catch (e) { return false; } };
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const fail = path => { const e = new Error('invalid_setting:' + path); e.code = e.message; throw e; };
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const trimSet = (s, chars) => { let a = 0, b = s.length; while (a < b && chars.indexOf(s[a]) !== -1) a++; while (b > a && chars.indexOf(s[b - 1]) !== -1) b--; return s.slice(a, b); };

  function parsePrices(lines) {
    const out = [];
    for (const raw of Array.isArray(lines) ? lines : []) {
      const line = String(raw).trim();
      let m = /\$\s?([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(.*)$/.exec(line), name;
      if (m) name = line.replace(/\s*[:–—-]?\s*\$\s?[0-9].*$/, '');
      else {
        m = /[:–—-]\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(.*)$/.exec(line);
        if (!m) continue;
        name = line.replace(/\s*[:–—-]\s*[0-9]{1,6}(?:\.[0-9]{1,2})?\s*.*$/, '');
      }
      name = trimSet(name, ' :–—-').slice(0, 80);
      const note = trimSet(m[2] || '', ' ()').slice(0, 160);
      const price = Number(m[1]);
      if (!name || price > 100000) continue;
      out.push({ name, price_usd: price, note });
      if (out.length >= 30) break;
    }
    return out;
  }
  function parseArea(text) {
    const s = String(text || ''), zips = [], places = [], seen = {};
    (s.match(/\b[0-9]{5}\b/g) || []).forEach(z => { if (zips.indexOf(z) === -1 && zips.length < 500) zips.push(z); });
    s.split(/[,;\n]+/).forEach(x => {
      const t = trimSet(x.replace(/\b[0-9]{5}\b/g, '').trim(), ' .').slice(0, 80);
      if (!t || !/[A-Za-z]/.test(t) || seen[t.toLowerCase()] || places.length >= 50) return;
      seen[t.toLowerCase()] = 1; places.push(t);
    });
    return { zips, places };
  }
  function checkHours(v) {
    if (!isObj(v)) fail('hours');
    Object.keys(v).forEach(d => {
      const x = v[d];
      if (DAYS.indexOf(d) === -1) fail('hours.' + d);
      if (!(x === null || (Array.isArray(x) && x.length === 2 && HHMM.test(x[0]) && HHMM.test(x[1]) && x[0] < x[1]))) fail('hours.' + d);
    });
    if (!Object.keys(v).some(d => Array.isArray(v[d]))) fail('hours');
  }
  function patch(key, data, cfg) {
    cfg = clone(cfg || {}); const d = data || {};
    const sub = k => (cfg[k] = isObj(cfg[k]) ? cfg[k] : {});
    if (key === 'hours') {
      if ('hours' in d) { checkHours(d.hours); cfg.hours = clone(d.hours); }
      if ('timezone' in d) { if (!TZ_OK(d.timezone)) fail('business.timezone'); sub('business').timezone = d.timezone; }
      if ('after_hours' in d) {
        if (!isObj(d.after_hours) || ['book_next_day', 'message_only', 'emergency_dial'].indexOf(d.after_hours.mode) === -1) fail('after_hours.mode');
        cfg.after_hours = { mode: d.after_hours.mode };
      }
    } else if (key === 'faq') {
      if ('faq' in d) {
        if (!Array.isArray(d.faq) || d.faq.length > 25) fail('faq');
        d.faq.forEach((e, i) => {
          if (!e || typeof e.q !== 'string' || e.q.length < 1 || e.q.length > 300) fail('faq[' + i + '].q');
          if (typeof e.a !== 'string' || e.a.length < 1 || e.a.length > 600) fail('faq[' + i + '].a');
        });
        cfg.faq = d.faq.map(e => ({ q: e.q, a: e.a }));
      }
      if ('services' in d) {
        const v = d.services;
        if (!Array.isArray(v) || v.length < 1 || v.length > 30 || v.some(x => typeof x !== 'string' || x.trim().length < 1 || x.trim().length > 80)) fail('booking.job_types');
        sub('booking').job_types = v.map(x => x.trim());
      }
      if ('service_area' in d) { const a = parseArea(d.service_area); sub('business').service_area_zips = a.zips; sub('business').service_area_places = a.places; }
      if (d.price_on_phone === 'fixed') {
        const items = parsePrices(d.fixed_prices);
        cfg.pricing = items.length ? { mode: 'listed', items } : { mode: 'none', items: [] };
      } else if (d.price_on_phone === 'no') cfg.pricing = { mode: 'none', items: [] };
      if (((cfg.business || {}).niche) === 'real_estate') {
        if (Array.isArray(d.re_lead_types)) sub('real_estate').renters = d.re_lead_types.indexOf('renters') !== -1;
        if (Array.isArray(d.re_qualify)) {
          const map = [['timeline', 'timeline'], ['budget', 'price_range'], ['preapproval', 'pre_approval'], ['areas', 'area'], ['property', 'property_address']];
          sub('real_estate').screening = ['intent'].concat(map.filter(([k]) => d.re_qualify.indexOf(k) !== -1).map(([, v]) => v), ['has_agent']);
        }
      }
    } else if (key === 'alerts') {
      if ('notify' in d) {
        const v = d.notify;
        if (!isObj(v) || Object.keys(v).some(k => ['sms', 'email', 'daily_summary'].indexOf(k) === -1)) fail('notify');
        const sms = v.sms === undefined ? [] : v.sms, em = v.email === undefined ? [] : v.email;
        if (!Array.isArray(sms) || sms.length > 5) fail('notify.sms');
        sms.forEach((x, i) => { if (!US(x)) fail('notify.sms[' + i + ']'); });
        if (!Array.isArray(em) || em.length > 5) fail('notify.email');
        em.forEach((x, i) => { if (typeof x !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x) || x.length > 320) fail('notify.email[' + i + ']'); });
        if ('daily_summary' in v && !(v.daily_summary === null || (typeof v.daily_summary === 'string' && HHMM.test(v.daily_summary)))) fail('notify.daily_summary');
        if (sms.length + em.length === 0) fail('notify');
        cfg.notify = Object.assign({}, cfg.notify || {}, clone(v));
      }
      if ('on_call_number' in d) {
        const oc = d.on_call_number;
        if (!(oc === null || US(oc))) fail('on_call_number');
        cfg.handoff = Object.assign({}, cfg.handoff || {}, { mode: oc === null ? 'message' : 'dial', number: oc });
        cfg.emergency = Object.assign({}, cfg.emergency || {}, { dial: oc });
      }
      if (d.emergency && Array.isArray(d.emergency.keywords)) {
        const v = d.emergency.keywords;
        if (v.length > 40 || v.some(x => typeof x !== 'string' || x.trim().length < 1 || x.trim().length > 60)) fail('emergency.keywords');
        cfg.emergency = Object.assign({}, cfg.emergency || {}, { keywords: v.map(x => x.trim()) });
      }
    } else if (key === 'calendar') {
      if (d.booking_mode === 'messages_only') sub('booking').enabled = false;
      else if ('provider' in d) {
        if (['google', 'calendly'].indexOf(d.provider) === -1) fail('booking.provider');
        sub('booking').provider = d.provider; cfg.booking.enabled = true;
      }
      if (typeof d.booking_link === 'string') {
        if (!/^https:\/\/calendly\.com\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\/?$/.test(d.booking_link)) fail('booking.booking_link');
        sub('booking').booking_link = d.booking_link;
      }
    } else if (key === 'tools') {
      if ('zapier_webhook_url' in d) {
        const u = d.zapier_webhook_url;
        if (!(u === null || (typeof u === 'string' && /^https:\/\//.test(u) && u.length <= 500))) fail('zapier.webhook_url');
        cfg.zapier = Object.assign({}, cfg.zapier || {}, { webhook_url: u });
      }
    } else if (key === 'forward_calls') {
      if (typeof d.business_phone === 'string') { if (!US(d.business_phone)) fail('business.main_phone'); sub('business').main_phone = d.business_phone; }
    }
    return cfg;
  }
  function merge(cfg, items) {
    let out = clone(cfg || {});
    (items || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).forEach(it => {
      try { out = patch(it.key, it.data || {}, out); } catch (e) { /* invalid data never breaks the config: skipped */ }
    });
    return out;
  }
  root.OnboardingConfig = { patch, merge, parsePrices, parseArea };
})(typeof window !== 'undefined' ? window : globalThis);
