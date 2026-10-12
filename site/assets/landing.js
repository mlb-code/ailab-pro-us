// Landing pages (A4): analytics events + early-access lead form. No network calls unless the visitor submits the form.
// Events (names from config brand.json analytics.events): demo_start, quote_start. gtag/clarity load only when IDs exist.
(function () {
  'use strict';
  function track(name, params) {
    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
      if (typeof window.clarity === 'function') window.clarity('event', name);
    } catch (e) { /* never block navigation */ }
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('[data-ev]');
    if (a) track(a.getAttribute('data-ev'), { page: location.pathname });
  });

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
        utm: Object.fromEntries(new URLSearchParams(location.search))
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

  // "What happens to a missed call": desktop = scroll-scrubbed with GSAP (cdnjs); phones = a timed sequence in view.
  var steps = document.querySelector('.steps3');
  if (steps && motion) {
    var desktop = window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches;
    if (!desktop) {
      steps.setAttribute('data-seq', '');
      once(steps, 0.25, function () { steps.classList.add('is-in'); });
    } else {
      var cdn = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/';
      var load = function (src, cb) {
        var s = document.createElement('script');
        s.src = src; s.async = true; s.onload = cb; s.onerror = function () { /* steps stay fully visible */ };
        document.head.appendChild(s);
      };
      load(cdn + 'gsap.min.js', function () {
        load(cdn + 'ScrollTrigger.min.js', function () {
          var g = window.gsap;
          if (!g || !window.ScrollTrigger) return;
          g.registerPlugin(window.ScrollTrigger);
          var tl = g.timeline({ scrollTrigger: { trigger: steps, start: 'top 82%', end: 'bottom 50%', scrub: 0.6 } });
          tl.fromTo(steps, { '--p': 0 }, { '--p': 1, ease: 'none', duration: 3 }, 0);
          [].forEach.call(steps.children, function (li, i) {
            tl.fromTo(li, { opacity: 0.22 }, { opacity: 1, duration: 0.7, ease: 'power1.out' }, i);
            var n = li.querySelector('.n');
            if (n) tl.fromTo(n, { yPercent: 35, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.8, ease: 'power2.out' }, i);
          });
          var live = document.querySelector('.hero .live');
          if (live) g.to(live, { yPercent: -5, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
        });
      });
    }
  }

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
