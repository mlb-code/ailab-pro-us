// Scripted chat demo (A4). Browser only: no network calls. Data = <script type="application/json" data-demo-data>
// rendered by tools/build_landing.py from site/_content/<niche>.json.
// Tree: scenario.nodes[id] = { system?, bot: [text], chips: [{ say, next, set? }] } or a final node with { bot, booked }.
// Speed: window.DEMO_SPEED (0 = instant, used by tools/demo_test.mjs); reduced motion = faster.
// B8 will add a live mode in front of this; the scripted mode stays as the fallback.
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

  function init() {
    document.querySelectorAll('[data-demo]').forEach(function (root) {
      try { root.__demo = new Demo(root); autoplay(root.__demo); } catch (e) { /* leave the static transcript */ }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
