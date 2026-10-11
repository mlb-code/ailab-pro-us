/* Tenant config validation in the browser (portal + admin), against /assets/tenant_schema.json — a byte copy of
   runtime/app/tenant_schema.json made by tools/sync_config.py. The schema is generated from the runtime's pydantic model,
   so NO rule is typed here: this file is a generic validator for the JSON-Schema subset that schema uses
   ($ref to #/$defs, anyOf, type, enum, const, pattern, min/maxLength, min/maxItems, items, prefixItems, properties,
   required, additionalProperties, minimum/maximum, exclusiveMinimum/Maximum).
   Cross-field rules that live only in pydantic (open < close, "listed" pricing needs items, dial needs a number,
   notify needs one contact) are re-checked by the runtime when it loads the tenant; the portal forms add their own
   field-level checks for the first two that the client can hit (hours order, at least one alert contact).

   API: TenantSchema.load() -> Promise<schema>
        TenantSchema.validate(value, pointer?) -> [{path, code, params}]   pointer e.g. '#/$defs/Hours' or 'faq' (top-level key)
        TenantSchema.validatePatch(patch) -> errors for each top-level key against its property schema
        TenantSchema.messageEn(err) -> readable text (Hebrew wording for the admin lives in admin-tenants.js) */
(function () {
  let SCHEMA = null, loading = null;
  function load() {
    if (SCHEMA) return Promise.resolve(SCHEMA);
    if (!loading) loading = fetch('/assets/tenant_schema.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('tenant_schema ' + r.status); return r.json(); })
      .then(j => { SCHEMA = j; return j; })
      .catch(e => { loading = null; throw e; });
    return loading;
  }
  const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
  const isType = (v, t) => t === 'number' ? typeof v === 'number' && isFinite(v) : t === 'integer' ? typeof v === 'number' && Number.isInteger(v) : typeOf(v) === t;
  function resolve(ref) {
    if (!/^#\//.test(ref)) throw new Error('only local $ref: ' + ref);
    return ref.slice(2).split('/').reduce((n, k) => n && n[k], SCHEMA);
  }
  const join = (path, k) => typeof k === 'number' ? path + '[' + k + ']' : (path ? path + '.' + k : k);

  function check(v, s, path, out) {
    if (!s || s === true) return;
    if (s.$ref) { check(v, resolve(s.$ref), path, out); return; }
    if (s.anyOf) {
      const fits = s.anyOf.map(sub => { const e = []; check(v, sub, path, e); return e; });
      if (fits.some(e => !e.length)) return;
      // report the branch whose type matches, else a generic "not allowed"
      const typed = s.anyOf.findIndex(sub => { const r = sub.$ref ? resolve(sub.$ref) : sub; return !r.type || isType(v, r.type); });
      if (typed !== -1 && !(v === null)) { fits[typed].forEach(e => out.push(e)); return; }
      out.push({ path, code: 'type', params: { expected: s.anyOf.map(sub => (sub.$ref ? resolve(sub.$ref) : sub).type || 'object').join(' | ') } });
      return;
    }
    if (s.type) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some(t => isType(v, t))) { out.push({ path, code: 'type', params: { expected: ts.join(' | ') } }); return; }
    }
    if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) out.push({ path, code: 'const', params: { value: s.const } });
    if (s.enum && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) out.push({ path, code: 'enum', params: { allowed: s.enum } });
    if (typeof v === 'string') {
      if (s.minLength != null && v.length < s.minLength) out.push({ path, code: 'minLength', params: { n: s.minLength } });
      if (s.maxLength != null && v.length > s.maxLength) out.push({ path, code: 'maxLength', params: { n: s.maxLength } });
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) out.push({ path, code: 'pattern', params: { pattern: s.pattern, hint: s.description || '' } });
    }
    if (typeof v === 'number') {
      if (s.minimum != null && v < s.minimum) out.push({ path, code: 'minimum', params: { n: s.minimum } });
      if (s.maximum != null && v > s.maximum) out.push({ path, code: 'maximum', params: { n: s.maximum } });
      if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) out.push({ path, code: 'exclusiveMinimum', params: { n: s.exclusiveMinimum } });
      if (s.exclusiveMaximum != null && v >= s.exclusiveMaximum) out.push({ path, code: 'exclusiveMaximum', params: { n: s.exclusiveMaximum } });
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) out.push({ path, code: 'minItems', params: { n: s.minItems } });
      if (s.maxItems != null && v.length > s.maxItems) out.push({ path, code: 'maxItems', params: { n: s.maxItems } });
      const pre = s.prefixItems || [];
      v.forEach((x, i) => {
        if (i < pre.length) check(x, pre[i], join(path, i), out);
        else if (s.items !== undefined) {
          if (s.items === false) out.push({ path: join(path, i), code: 'extra_item', params: {} });
          else check(x, s.items, join(path, i), out);
        }
      });
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const props = s.properties || {};
      (s.required || []).forEach(k => { if (!(k in v)) out.push({ path: join(path, k), code: 'required', params: {} }); });
      Object.keys(v).forEach(k => {
        if (k in props) check(v[k], props[k], join(path, k), out);
        else if (s.additionalProperties === false) out.push({ path: join(path, k), code: 'additional', params: {} });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(v[k], s.additionalProperties, join(path, k), out);
      });
    }
  }
  function schemaAt(pointer) {
    if (!SCHEMA) throw new Error('tenant schema not loaded');
    if (!pointer) return SCHEMA;
    if (pointer.charAt(0) === '#') return resolve(pointer);
    return (SCHEMA.properties || {})[pointer];
  }
  function validate(value, pointer) {
    const s = schemaAt(pointer); const out = [];
    if (!s) return [{ path: pointer, code: 'unknown_field', params: {} }];
    check(value, s, pointer && pointer.charAt(0) !== '#' ? pointer : '', out);
    return out;
  }
  function validatePatch(patch) {
    const out = [];
    Object.keys(patch || {}).forEach(k => { validate(patch[k], k).forEach(e => out.push(e)); });
    return out;
  }
  const where = e => e.path || '(config)';
  function messageEn(e) {
    const p = e.params || {};
    const m = {
      type: 'should be ' + p.expected, enum: 'must be one of: ' + (p.allowed || []).join(', '), const: 'must be ' + JSON.stringify(p.value),
      minLength: 'is required', maxLength: 'is too long (max ' + p.n + ' characters)', pattern: p.hint ? 'format: ' + p.hint : 'has the wrong format',
      minimum: 'must be at least ' + p.n, maximum: 'must be at most ' + p.n, exclusiveMinimum: 'must be more than ' + p.n, exclusiveMaximum: 'must be less than ' + p.n,
      minItems: 'needs at least ' + p.n, maxItems: 'allows at most ' + p.n, required: 'is required', additional: 'is not a known setting',
      extra_item: 'has too many entries', unknown_field: 'is not a known setting'
    }[e.code] || 'is not valid';
    return where(e) + ' ' + m;
  }
  window.TenantSchema = { load, validate, validatePatch, messageEn, get schema() { return SCHEMA; } };
})();
