// Scripted chat demo (A4). Browser only: no network calls. Data = <script type="application/json" data-demo-data>
// rendered by tools/build_landing.py from site/_content/<niche>.json.
// Tree: scenario.nodes[id] = { system?, bot: [text], chips: [{ say, next, set? }] } or a final node with { bot, booked }.
// Speed: window.DEMO_SPEED (0 = instant, used by tools/demo_test.mjs); reduced motion = faster.
// Live mode (B8): when a runtime URL is configured (data-live on [data-demo], from brand.json demo.runtime_url;
// window.DEMO_LIVE_URL; or ?live=<url> on localhost only; data-live is ignored on localhost; ?mock=1 = scripted)
// and GET <url>/demo/status answers live within 4 s, a text box lets the visitor type to the real assistant (POST /demo/session, /demo/chat). Any error, timeout, limit or
// budget stop shows "Live demo paused" and falls back to the scripted demo. No URL configured = no network calls.
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function speed() {
    var s = window.DEMO_SPEED;
    return typeof s === 'number' ? s : (reduce ? 0.25 : 1);
  }
  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, Math.max(0, ms * speed())); });
  }
  function fill(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function track(name, params) {
    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
      if (typeof window.clarity === 'function') window.clarity('event', name);
    } catch (e) { /* analytics must never break the demo */ }
  }

  function Demo(root) {
    this.root = root;
    this.data = JSON.parse(root.querySelector('[data-demo-data]').textContent);
    this.niche = root.getAttribute('data-niche');
    this.chat = root.querySelector('[data-demo-chat]');
    this.end = root.querySelector('[data-demo-end]');
    this.picks = root.querySelector('.demo__picks');
    this.run = 0;
    this.started = false;
    var self = this;
    root.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t || !root.contains(t)) return;
      if (t.hasAttribute('data-scenario')) self.start(t.getAttribute('data-scenario'), true);
      else if (t.hasAttribute('data-niche')) self.setNiche(t.getAttribute('data-niche'));
      else if (t.hasAttribute('data-demo-restart')) self.reset(true);
    });
  }

  Demo.prototype.setNiche = function (key) {
    if (!this.data[key]) return;
    this.niche = key;
    this.root.setAttribute('data-niche', key);
    this.root.querySelectorAll('[data-niche]').forEach(function (b) {
      if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', String(b.getAttribute('data-niche') === key));
    });
    var d = this.data[key];
    var biz = this.root.querySelector('[data-demo-biz]');
    var line = this.root.querySelector('[data-demo-line]');
    var av = this.root.querySelector('.phone__av');
    if (biz) biz.textContent = d.business;
    if (line) line.textContent = d.line + ' · AI assistant';
    if (av) av.textContent = d.business.charAt(0);
    if (d.cta) document.querySelectorAll('[data-niche-cta]').forEach(function (x) { x.setAttribute('href', d.cta); });
    if (d.product) document.querySelectorAll('[data-demo-product]').forEach(function (x) { x.textContent = d.product; });
    var picks = this.picks;
    picks.textContent = '';
    d.scenarios.forEach(function (s) {
      var b = el('button', 'demo__pick', s.label);
      b.type = 'button';
      b.setAttribute('data-scenario', s.key);
      b.setAttribute('aria-pressed', 'false');
      picks.appendChild(b);
    });
    var tr = this.root.querySelector('.transcript');
    if (tr) tr.hidden = key !== Object.keys(this.data)[0];
    this.reset(false);
  };

  Demo.prototype.reset = function (focusPicks) {
    this.run++;
    this.chat.textContent = '';
    this.chat.appendChild(el('p', 'bubble bubble--system', 'Pick a situation to start. You play the customer.'));
    this.end.hidden = true;
    this.picks.querySelectorAll('[data-scenario]').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    if (focusPicks) {
      var first = this.picks.querySelector('[data-scenario]');
      if (first) first.focus({ preventScroll: true });
    }
  };

  Demo.prototype.scroll = function () {
    this.chat.scrollTop = this.chat.scrollHeight;
  };

  Demo.prototype.add = function (node) {
    this.chat.appendChild(node);
    this.scroll();
    return node;
  };

  Demo.prototype.start = function (key, byUser) {
    var d = this.data[this.niche];
    var scn = d.scenarios.filter(function (s) { return s.key === key; })[0];
    if (!scn) return;
    this.reset(false);
    this.kbd = false;
    this.chat.textContent = '';
    this.picks.querySelectorAll('[data-scenario]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-scenario') === key));
    });
    if (byUser) this.touched = true;
    if (byUser && !this.started) { this.started = true; track(this.root.getAttribute('data-ev-start') || 'demo', { niche: this.niche }); }
    this.root.setAttribute('data-state', 'running');
    this.step(scn, scn.start, {}, this.run);
  };

  Demo.prototype.step = async function (scn, id, vars, run) {
    var self = this;
    var node = scn.nodes[id];
    if (node.system) this.add(el('p', 'bubble bubble--system', fill(node.system, vars)));
    for (var i = 0; i < (node.bot || []).length; i++) {
      var text = fill(node.bot[i], vars);
      var typing = this.add(el('p', 'bubble bubble--in bubble--typing'));
      typing.setAttribute('aria-label', 'typing');
      typing.innerHTML = '<i></i><i></i><i></i>';
      await wait(Math.min(1300, 450 + text.length * 9));
      if (run !== this.run) return;
      typing.remove();
      this.add(el('p', 'bubble bubble--in', text));
      await wait(250);
      if (run !== this.run) return;
    }
    if (node.booked) return this.finish(node.booked, vars);
    var box = this.add(el('div', 'chat__choices'));
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Your reply');
    node.chips.forEach(function (ch) {
      var b = el('button', 'chip-reply', ch.say);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (run !== self.run) return;
        var hadFocus = box.contains(document.activeElement);
        box.remove();
        var out = self.add(el('p', 'bubble bubble--out', ch.say));
        if (hadFocus) { self.kbd = true; out.tabIndex = -1; out.focus({ preventScroll: true }); }
        var next = Object.assign({}, vars, ch.set || {});
        wait(300).then(function () { if (run === self.run) self.step(scn, ch.next, next, run); });
      });
      box.appendChild(b);
    });
    this.scroll();
    if (this.kbd) { var f = box.querySelector('button'); if (f) f.focus({ preventScroll: true }); }
  };

  Demo.prototype.finish = function (bk, vars) {
    var card = el('div', 'bubble bubble--booked');
    card.setAttribute('data-booked', '');
    card.appendChild(el('span', 'k', 'Booked'));
    card.appendChild(el('b', null, fill(bk.title, vars)));
    card.appendChild(el('span', null, fill(bk.when, vars)));
    if (bk.detail) card.appendChild(el('span', null, fill(bk.detail, vars)));
    this.add(card);
    if (this.kbd) { card.tabIndex = -1; card.focus({ preventScroll: true }); this.kbd = false; }
    this.add(el('p', 'bubble bubble--system', 'This is a demo. No real booking was made.'));
    this.end.hidden = false;
    this.root.setAttribute('data-state', 'booked');
    this.scroll();
  };

  // Auto-play the first scenario once when the phone scrolls into view (until the visitor picks one).
  function autoplay(d) {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      if (d.touched) return;
      var first = d.picks.querySelector('[data-scenario]');
      if (first) d.start(first.getAttribute('data-scenario'), false);
    }, { threshold: 0.5 });
    io.observe(d.chat);
  }

  // ------------------------------------------------------------------ live mode (B8)
  var PROBE_MS = 4000, TURN_MS = 25000, MAX_CHARS = 500;
  var PAUSED_TEXT = 'Live demo paused. Showing the scripted demo instead.';

  function liveUrl(root) {
    var u = '', local = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    try {
      var sp = new URLSearchParams(window.location.search);
      if (sp.get('mock') === '1') return '';  // ?mock=1 forces the scripted demo anywhere
      var q = sp.get('live');
      if (q && local) u = q;
    } catch (e) { /* old browsers: no override */ }
    // Local dev / tests never reach the production runtime by default: on localhost data-live is ignored
    // (opt in with ?live=<url> or window.DEMO_LIVE_URL).
    u = u || window.DEMO_LIVE_URL || (local ? '' : root.getAttribute('data-live')) || '';
    return /^https?:\/\/[^\s]+$/.test(u) ? u.replace(/\/+$/, '') : '';
  }

  function request(url, body, ms) {
    var ctl = 'AbortController' in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    var opts = { method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' };
    if (ctl) opts.signal = ctl.signal;
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    return Promise.race([
      fetch(url, opts).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; });
      }),
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms + 50); })
    ]).then(function (x) { clearTimeout(timer); return x; }, function (e) { clearTimeout(timer); throw e; });
  }

  function Live(demo, url) {
    this.demo = demo;
    this.url = url;
    this.niches = [];
    this.on = false;
    this.token = null;
    this.busy = false;
    this.form = null;
  }

  Live.prototype.probe = function () {
    var self = this;
    return request(this.url + '/demo/status', null, PROBE_MS).then(function (r) {
      if (r.status === 200 && r.body.live && Array.isArray(r.body.niches) && r.body.niches.length) {
        self.niches = r.body.niches;
        self.on = true;
        self.build();
        self.sync();
      }
    }, function () { /* runtime unreachable: scripted demo only */ });
  };

  Live.prototype.ready = function () {
    return this.on && this.niches.indexOf(this.demo.niche) !== -1;
  };

  Live.prototype.build = function () {
    var d = this.demo, self = this;
    var form = el('form', 'demo__live');
    form.setAttribute('data-demo-live', '');
    form.setAttribute('autocomplete', 'off');
    form.style.cssText = 'display:flex;gap:8px;padding:8px 6px 4px;min-width:0';
    var label = el('label', 'sr-only', 'Type a message as the customer');
    label.setAttribute('for', 'demo-live-input');
    var input = el('input', 'input');
    input.id = 'demo-live-input';
    input.type = 'text';
    input.maxLength = MAX_CHARS;
    input.placeholder = 'Or type your own message…';
    input.setAttribute('enterkeyhint', 'send');
    input.style.cssText = 'flex:1 1 auto;min-width:0;min-height:44px';
    var send = el('button', 'btn btn--primary btn--sm', 'Send');
    send.type = 'submit';
    send.style.cssText = 'flex:none';
    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(send);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = input.value.trim();
      if (!text || self.busy) return;
      input.value = '';
      self.say(text);
    });
    var note = el('p', 'phone__demo');
    note.setAttribute('data-live-note', '');
    note.setAttribute('role', 'status');
    note.hidden = true;
    var phone = d.chat.parentNode;
    phone.insertBefore(form, d.end);
    phone.insertBefore(note, d.chat);
    this.form = form;
    this.input = input;
    this.send = send;
    this.note = note;
  };

  Live.prototype.sync = function () {
    if (!this.form) return;
    this.form.hidden = !this.ready();
    if (!this.token && this.input) this.input.placeholder = 'Or type your own message…';
    this.form.style.display = this.form.hidden ? 'none' : 'flex';
    var first = this.demo.chat.querySelector('.bubble--system');
    if (this.ready() && first && this.demo.chat.children.length === 1) {
      first.textContent = 'Pick a situation, or type your own message below. You play the customer.';
    }
  };

  Live.prototype.lock = function (on) {
    this.busy = on;
    if (this.input) this.input.disabled = on;
    if (this.send) this.send.disabled = on;
  };

  Live.prototype.pause = function () {
    var d = this.demo;
    this.on = false;
    this.token = null;
    this.lock(false);
    if (this.form) { this.form.hidden = true; this.form.style.display = 'none'; }
    if (this.note) { this.note.textContent = PAUSED_TEXT; this.note.hidden = false; }
    d.root.setAttribute('data-live-state', 'paused');
    var first = d.data[d.niche].scenarios[0];
    wait(400).then(function () { d.start(first.key, false); });
  };

  Live.prototype.typing = function () {
    var t = this.demo.add(el('p', 'bubble bubble--in bubble--typing'));
    t.setAttribute('aria-label', 'typing');
    t.innerHTML = '<i></i><i></i><i></i>';
    return t;
  };

  Live.prototype.open = function (run) {
    var d = this.demo, self = this;
    return request(this.url + '/demo/session', { niche: d.niche }, PROBE_MS).then(function (r) {
      if (run !== d.run) return false;
      if (r.status !== 200 || !r.body.token) throw new Error('session ' + r.status);
      self.token = r.body.token;
      if (self.input) self.input.placeholder = 'Type your reply…';
      d.add(el('p', 'bubble bubble--in', r.body.greeting));
      return true;
    });
  };

  Live.prototype.say = function (text) {
    var d = this.demo, self = this;
    var fresh = !this.token;
    if (fresh) {
      d.run++;
      d.chat.textContent = '';
      d.end.hidden = true;
      d.picks.querySelectorAll('[data-scenario]').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      d.add(el('p', 'bubble bubble--system', 'Live demo: you are texting the AI assistant. No real booking is made.'));
      d.root.setAttribute('data-state', 'running');
      d.touched = true;
      if (!d.started) { d.started = true; track(d.root.getAttribute('data-ev-start') || 'demo', { niche: d.niche, mode: 'live' }); }
    }
    var run = d.run;
    this.lock(true);
    var opened = fresh ? this.open(run) : Promise.resolve(true);
    opened.then(function (ok) {
      if (!ok || run !== d.run) { self.lock(false); return; }
      d.add(el('p', 'bubble bubble--out', text));
      var typing = self.typing();
      return self.turn(text, run, true).then(function (r) {
        typing.remove();
        if (run !== d.run) { self.lock(false); return; }
        self.lock(false);
        if (r.reply) d.add(el('p', 'bubble bubble--in', r.reply));
        if (r.booked) {
          d.finish({ title: r.booked.job_type || 'Visit', when: r.booked.label || '' }, {});
          self.token = null;
        } else if (r.ended || r.remaining === 0) {
          self.token = null;
          d.end.hidden = false;
        }
        if (self.input && !('ontouchstart' in window)) self.input.focus({ preventScroll: true });
      }, function (e) { typing.remove(); throw e; });
    }).catch(function () {
      if (run === d.run) self.pause(); else self.lock(false);
    });
  };

  // One chat turn; a rotated/expired session (409) is reopened once and the message re-sent.
  Live.prototype.turn = function (text, run, retry) {
    var self = this, d = this.demo;
    return request(this.url + '/demo/chat', { token: this.token, message: text }, TURN_MS).then(function (r) {
      if (r.status === 200) return r.body;
      if ((r.status === 409 || r.status === 401) && retry && run === d.run) {
        self.token = null;
        return request(self.url + '/demo/session', { niche: d.niche }, PROBE_MS).then(function (s) {
          if (s.status !== 200 || !s.body.token) throw new Error('session ' + s.status);
          self.token = s.body.token;
          return self.turn(text, run, false);
        });
      }
      throw new Error('chat ' + r.status);
    });
  };

  function attachLive(demo) {
    var url = liveUrl(demo.root);
    if (!url) return;
    var live = demo.live = new Live(demo, url);
    var setNiche = demo.setNiche, start = demo.start, reset = demo.reset;
    demo.setNiche = function (k) { live.token = null; setNiche.call(demo, k); live.sync(); };
    demo.start = function (k, byUser) { live.token = null; live.lock(false); start.call(demo, k, byUser); };
    demo.reset = function (f) { if (f) live.token = null; reset.call(demo, f); live.sync(); };
    live.probe();
  }

  function init() {
    document.querySelectorAll('[data-demo]').forEach(function (root) {
      try { root.__demo = new Demo(root); attachLive(root.__demo); autoplay(root.__demo); } catch (e) { /* leave the static transcript */ }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
