// Legal pages (A9): fill brand values from config and control the draft banner.
// Source: ../../assets/brand.json (copied from config/brand.json by tools/sync_config.py).
// The draft banner stays visible unless brand.json has "legal_final": true.
// If brand.json is missing, the placeholders and the banner stay as written in the HTML.
(function () {
  function get(obj, path) {
    return path.split('.').reduce(function (o, k) { return o && o[k] !== undefined ? o[k] : undefined; }, obj);
  }
  fetch('../../assets/brand.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (brand) {
      if (!brand) return;
      document.querySelectorAll('[data-brand]').forEach(function (el) {
        var key = el.getAttribute('data-brand');
        var v = get(brand, key);
        // agreement_version lives at the top level of brand.json; accept the old nested path too.
        if (v === undefined && key === 'legal_entity.agreement_version') v = brand.agreement_version;
        if (typeof v === 'string' && v) el.textContent = v;
      });
      document.querySelectorAll('a[data-brand-href]').forEach(function (el) {
        var v = get(brand, el.getAttribute('data-brand-href'));
        if (typeof v === 'string' && v) el.setAttribute('href', (v.indexOf('@') > 0 && v.indexOf(':') < 0) ? 'mailto:' + v : v);
      });
      if (brand.legal_final === true) {
        var b = document.querySelector('.draft-banner');
        if (b) b.hidden = true;
      }
    })
    .catch(function () { /* keep the HTML defaults */ });
})();
