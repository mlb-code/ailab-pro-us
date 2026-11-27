// Landing pages (A4): analytics events + early-access lead form. No network calls unless the visitor submits the form.
// Measurement (tags, [data-ev] clicks, first-touch UTM) is /assets/measure.js, loaded before this file.
(function () {
  'use strict';
  // Click events ([data-ev]) and GA4 loading live in /assets/measure.js.

  // Early-access form: POST to the lead endpoint when configured, else open a prefilled email.
  document.querySelectorAll('form[data-lead]').forEach(function (form) {
    var msg = form.querySelector('[data-lead-msg]');
    function say(text, err) {
      msg.textContent = text;
      msg.classList.toggle('is-err', !!err);
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = form.elements.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        form.elements.email.closest('.field').classList.add('field--error');
        say('Please enter a valid email.', true);
        form.elements.email.focus();
        return;
      }
      form.elements.email.closest('.field').classList.remove('field--error');
      var data = {
        email: email,
        company: form.elements.company.value.trim(),
        city: form.elements.city.value.trim(),
        website: form.elements.website ? form.elements.website.value : '',
        niche: form.getAttribute('data-niche'),
        source_page: location.pathname,
        utm: (window.Measure && window.Measure.firstTouch()) || Object.fromEntries(new URLSearchParams(location.search))
      };
      var endpoint = form.getAttribute('data-endpoint');
      var button = form.querySelector('button[type=submit]');
      if (data.website) { say(form.getAttribute('data-ok')); form.reset(); return; } // honeypot: bots get a fake success
      if (!endpoint) {
        var to = form.getAttribute('data-mailto');
        var body = 'Please add me to early access.\n\nEmail: ' + data.email + '\nPractice: ' + data.company + '\nCity/state: ' + data.city;
        say(form.getAttribute('data-fallback'));
        if (to) location.href = 'mailto:' + to + '?subject=' + encodeURIComponent('Early access: ' + data.niche) + '&body=' + encodeURIComponent(body);
        return;
      }
      button.disabled = true;
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          say(form.getAttribute('data-ok'));
          form.reset();
        })
        .catch(function () { say('Something went wrong. Please try again in a minute.', true); })
        .then(function () { button.disabled = false; });
    });
  });

  // ---------------------------------------------------------------- design pass (2026-10)
  var motion = document.documentElement.classList.contains('motion');
  var hasIO = 'IntersectionObserver' in window;
  function once(el, threshold, fn) {
    if (!hasIO) { fn(); return; }
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); fn(); }
    }, { threshold: threshold });
    io.observe(el);
  }

  // Hero "live line": missed call → typing → text-back → reply → booked card lands. Plays once in view, again on CTA hover.
  document.querySelectorAll('[data-live]').forEach(function (fig) {
    if (!motion) return;
    var rows = [].slice.call(fig.querySelectorAll('ol > li'));
    var clock = fig.querySelector('[data-live-clock]');
    var elapsed = fig.querySelector('[data-live-elapsed]');
    var finalText = elapsed ? elapsed.textContent : '';
    var short = function (li) { return (li.getAttribute('data-t') || '').split(' ')[0]; };
    var timers = [], playing = false;
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function play() {
      if (playing) return;
      playing = true;
      timers.forEach(clearTimeout); timers = [];
      rows.forEach(function (li) { li.classList.remove('is-in', 'is-typing'); });
      if (clock && rows[0]) clock.textContent = short(rows[0]);
      var t = 200;
      rows.forEach(function (li) {
        var chat = /\bk-(ai|lead)\b/.test(li.className);
        if (chat) { later(function () { li.classList.add('is-typing'); }, t); t += 950; }
        later(function () {
          li.classList.remove('is-typing'); li.classList.add('is-in');
          if (clock) clock.textContent = short(li);
        }, t);
        t += chat ? 550 : 750;
      });
      var total = t, start = null;
      if (elapsed) {
        (function tick(now) {
          if (start === null) start = now;
          var p = Math.min(1, (now - start) / total), s = Math.round(p * 118);
          if (playing) elapsed.textContent = '+' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
          if (p < 1 && playing) requestAnimationFrame(tick);
        })(performance.now());
      }
      later(function () { playing = false; if (elapsed) elapsed.textContent = finalText; }, total + 150);
    }
    fig.classList.add('is-armed');
    once(fig, 0.35, play);
    document.querySelectorAll('.hero .btn--primary').forEach(function (b) {
      b.addEventListener('mouseenter', function () { if (!playing && rows[rows.length - 1].classList.contains('is-in')) play(); });
    });
  });

  // Folds (2026-11-25): closed <details class="fold"> sections. A link to #id opens the fold it points at (or sits in)
  // and scrolls to it; printing opens every closed fold (and FAQ answer), then puts them back.
  function openFor(hash) {
    var id = (hash || '').replace(/^#/, '');
    if (!id) return;
    var el;
    try { el = document.getElementById(decodeURIComponent(id)); } catch (e) { return; }
    if (!el) return;
    var opened = false;
    for (var d = el; d; d = d.parentElement) {
      if (d.tagName === 'DETAILS' && !d.open) { d.open = true; opened = true; }
    }
    if (opened) el.scrollIntoView({ block: 'start' });
  }
  openFor(location.hash);
  window.addEventListener('hashchange', function () { openFor(location.hash); });
  document.addEventListener('click', function (e) {  // a same-page link to the hash already in the URL fires no hashchange
    var a = e.target.closest && e.target.closest('a[href*="#"]');
    if (a && a.pathname === location.pathname && a.hash && a.hash === location.hash) openFor(a.hash);
  });
  var printed = [];
  window.addEventListener('beforeprint', function () {
    printed = [].filter.call(document.querySelectorAll('main details'), function (d) { return !d.open; });
    printed.forEach(function (d) { d.open = true; });
  });
  window.addEventListener('afterprint', function () { printed.forEach(function (d) { d.open = false; }); printed = []; });

  // "Why" stats (design v2): numbers count up once in view. The final value is the DOM text (no-JS / reduced motion).
  document.querySelectorAll('[data-count]').forEach(function (el) {
    if (!motion) return;
    var m = /^(\D*)(\d+)(.*)$/.exec(el.textContent.trim());
    if (!m) return;
    var to = +m[2];
    once(el, 0.6, function () {
      var start = null;
      (function tick(now) {
        if (start === null) start = now;
        var p = Math.min(1, (now - start) / 1100), e = 1 - Math.pow(1 - p, 3);
        el.textContent = m[1] + Math.round(to * e) + m[3];
        if (p < 1) requestAnimationFrame(tick);
      })(performance.now());
    });
  });

  // Sticky CTA bar on phones: visible only while no other CTA-bearing block (hero buttons, demo, pricing, band, footer) is on screen.
  var bar = document.querySelector('[data-mbar]');
  if (bar && hasIO) {
    var seen = new Set();
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); });
      bar.classList.toggle('is-on', seen.size === 0);
    }, { rootMargin: '-64px 0px 0px 0px' });
    document.querySelectorAll('.hero .btn-row, #demo, #pricing, #early-access, .band, .footer').forEach(function (el) { io.observe(el); });
  }
})();
