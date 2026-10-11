/* Home-services client site. No libraries. Settings come from <body> data attributes written by build.py:
   data-demo="1"  → call/text buttons show a notice instead of dialing a fictional number; the form sends nothing.
   data-leads=""  → Google Apps Script Web App URL (ends in /exec). Empty = form shows success without sending. */
(function () {
  var body = document.body;
  var DEMO = body.getAttribute('data-demo') === '1';
  var LEADS_URL = body.getAttribute('data-leads') || '';
  document.documentElement.classList.add('js');
  if (DEMO) document.documentElement.classList.add('is-demo');

  function track(name, params) { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); }

  /* header shadow + mobile action bar / demo badge after a little scroll */
  var head = document.querySelector('.site-head');
  var floats = document.querySelectorAll('.demo-badge');
  function onScroll() {
    var y = window.scrollY;
    if (head) head.classList.toggle('scrolled', y > 8);
    for (var i = 0; i < floats.length; i++) floats[i].classList.toggle('show', y > 300);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* mobile menu: hidden with visibility/opacity only (never moved off-screen) */
  var btn = document.querySelector('.menu-btn');
  function setMenu(open) {
    body.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (btn) {
    btn.addEventListener('click', function () { setMenu(!body.classList.contains('menu-open')); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && body.classList.contains('menu-open')) { setMenu(false); btn.focus(); }
    });
    var ml = document.querySelectorAll('.mnav a');
    for (var m = 0; m < ml.length; m++) ml[m].addEventListener('click', function () { setMenu(false); });
  }

  /* call / text buttons: analytics event; on the demo site show a notice instead of dialing */
  var toast;
  function notice(text) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast'; toast.setAttribute('role', 'status');
      body.appendChild(toast);
    }
    toast.textContent = text; toast.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { toast.classList.remove('show'); }, 3600);
  }
  var acts = document.querySelectorAll('a[href^="tel:"], a[href^="sms:"]');
  for (var a = 0; a < acts.length; a++) {
    acts[a].addEventListener('click', function (ev) {
      var isText = this.getAttribute('href').indexOf('sms:') === 0;
      track(isText ? 'click_text' : 'click_call');
      if (DEMO) {
        ev.preventDefault();
        notice(isText ? 'Demo site: on a real site this opens a text message to the business.'
                      : 'Demo site: on a real site this calls the business.');
      }
    });
  }

  /* lead form */
  var form = document.getElementById('lead-form');
  if (form) {
    var ok = document.getElementById('form-msg'), fail = document.getElementById('form-fail');
    function check(f) {
      var v = (f.value || '').trim(), bad;
      if (f.type === 'checkbox') bad = !f.checked;
      else if (f.name === 'phone') bad = v.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length !== 10;
      else if (f.name === 'zip') bad = !/^\d{5}(-\d{4})?$/.test(v);
      else bad = !v;
      f.setAttribute('aria-invalid', bad ? 'true' : 'false');
      var er = document.getElementById(f.id + '-err');
      if (er) er.textContent = bad ? (f.getAttribute('data-err') || 'Required') : '';
      return !bad;
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      ok.classList.remove('show'); fail.classList.remove('show');
      var first = null, req = form.querySelectorAll('[required]');
      for (var i = 0; i < req.length; i++) if (!check(req[i]) && !first) first = req[i];
      if (first) { first.focus(); return; }
      function done() { ok.classList.add('show'); ok.focus(); form.reset(); track('generate_lead'); }
      if (DEMO || (form.website && form.website.value)) { done(); return; }
      /* real site without a leads endpoint: never fake a success, point to phone / text instead */
      if (!LEADS_URL) { fail.classList.add('show'); fail.focus(); return; }
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = String(v); });
      data.source = location.pathname;
      var sb = form.querySelector('[type=submit]'), label = sb.textContent;
      sb.disabled = true; sb.textContent = 'Sending…';
      /* text/plain avoids a CORS preflight; Apps Script reads e.postData.contents */
      fetch(LEADS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (!j || !j.success) throw new Error('rejected'); done(); })
        .catch(function () { fail.classList.add('show'); fail.focus(); })
        .then(function () { sb.disabled = false; sb.textContent = label; });
    });
    var req2 = form.querySelectorAll('[required]');
    for (var r = 0; r < req2.length; r++) req2[r].addEventListener('blur', function () { if (this.getAttribute('aria-invalid')) check(this); });
  }

  var yr = document.querySelectorAll('.yr');
  for (var y = 0; y < yr.length; y++) yr[y].textContent = new Date().getFullYear();
})();
