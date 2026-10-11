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
})();
