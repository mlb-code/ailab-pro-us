// Legal pages (A9): mailto links + the draft banner, from config at runtime.
// Source: ../../assets/brand.json (copied from config/brand.json by tools/sync_config.py).
// Entity, address, email, governing law and version are stamped into the HTML by tools/build_landing.py
// (<span data-cfg="brand:...">), so the pages read correctly without JS. build_landing also stamps the banner's
// `hidden` attribute from "legal_final"; this script re-applies the same rule (banner shown only when legal_final !== true).
// Legacy <span data-brand="..."> elements are still filled. If brand.json is missing, the HTML stays as stamped.
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
      var b = document.querySelector('.draft-banner');
      if (b) b.hidden = brand.legal_final === true;
    })
    .catch(function () { /* keep the HTML defaults */ });
})();
