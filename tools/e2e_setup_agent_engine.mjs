// E2E: the portal's setup chat (site/start/assets/setup-chat.js) against the REAL setup-agent Edge Function, not the
// hand-written mock (mock/setup-script.js). tools/setup_agent_browser.ts is bundled with `deno bundle` (handler, turn engine,
// in-memory store = the SQL RPCs' mirror, scripted model) and runs inside the page:
//   setup-chat.js -> Backend.setupChat (backend.js's own Supabase adapter, over a stand-in client whose functions.invoke
//   builds a real Request and reads the real Response like supabase-js) -> makeHandler (JWT, strict 4 KB body, contract)
//   -> runTurn. Settings are read from and written to the mock backend's database through update_onboarding_item's mock (the
//   path the forms take, OnboardingConfig.patch = the parity-tested copy of onboarding_patch), so the forms, the tabs, the
//   forwarding test and the automatic go-live all see what the assistant saved. Only the model is scripted.
//   chromium (wire "compact", the default): the home-services journey from the greeting to live, a correction, choices, quick
//     replies, "Edit manually" + forms_saved, Google Calendar OAuth return, the number arriving later (resume), the test call,
//     the line going live (resume), a model failure + "Try again" with the same client_turn_id, reload, HTTP errors as the
//     page sees them (403 / 429 / 400), and the server's kill switch: the plain checklist, identical to the flag off.
//   webkit (wire "json"): first card, typed yes, reload.
// Every request is checked against setup_contract.json Request, every answer against Response / Error.
//   node tools/e2e_setup_agent_engine.mjs     (own static server on E2E_PORT; needs deno on PATH or DENO=<path>)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'site');
const PORT = +(process.env.E2E_PORT || 8972);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const BRAND = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/setup_contract.json'), 'utf8'));

// ------------------------------------------------------------------ the server code, bundled for the browser
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-engine-'));
const BUNDLE = path.join(TMP, 'setup_agent.js');
execFileSync(process.env.DENO || 'deno', ['bundle', '--quiet', '--no-lock', '--platform', 'browser', '-o', BUNDLE, path.join(HERE, 'setup_agent_browser.ts')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });

let brandOn = true;
const server = http.createServer((req, rsp) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p === '/__engine__/setup_agent.js') { rsp.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); fs.createReadStream(BUNDLE).pipe(rsp); return; }
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/assets/brand.json') {
    rsp.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    rsp.end(JSON.stringify(brandOn ? { ...BRAND, setup_agent: { enabled: true } } : BRAND)); return;
  }
  const full = path.normalize(path.join(SITE, p));
  if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
  rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(rsp);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://localhost:${PORT}`;
let pass = 0, failN = 0;
const ok = (cond, name) => { if (cond) pass++; else { failN++; console.log('  FAIL ' + name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ contract (a JSON Schema subset: what setup_contract.json uses)
function validate(v, sc, at, errs) {
  if (sc.$ref) sc = sc.$ref.split('/').slice(1).reduce((o, k) => o[k], CONTRACT);
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
  const okType = x => x === t || (x === 'number' && t === 'integer');
  if (sc.anyOf) { if (!sc.anyOf.some(s2 => { const e2 = []; validate(v, s2, at, e2); return !e2.length; })) errs.push(at + ': no anyOf branch'); return; }
  if ('const' in sc && v !== sc.const) errs.push(at + ': const');
  if (sc.enum && !sc.enum.includes(v)) errs.push(at + ': enum ' + JSON.stringify(v));
  if (sc.type && !(Array.isArray(sc.type) ? sc.type.some(okType) : okType(sc.type))) { errs.push(at + ': type ' + t); return; }
  if (typeof v === 'string') { if (sc.maxLength != null && v.length > sc.maxLength) errs.push(at + ': maxLength'); if (sc.minLength != null && v.length < sc.minLength) errs.push(at + ': minLength'); if (sc.pattern && !new RegExp(sc.pattern).test(v)) errs.push(at + ': pattern'); }
  if (typeof v === 'number' && sc.minimum != null && v < sc.minimum) errs.push(at + ': minimum');
  if (Array.isArray(v)) { if (sc.maxItems != null && v.length > sc.maxItems) errs.push(at + ': maxItems'); if (sc.items) v.forEach((x, i) => validate(x, sc.items, at + '[' + i + ']', errs)); }
  if (t === 'object') {
    (sc.required || []).forEach(k => { if (!(k in v)) errs.push(at + ': missing ' + k); });
    if (sc.additionalProperties === false) Object.keys(v).forEach(k => { if (!(sc.properties || {})[k]) errs.push(at + ': extra ' + k); });
    Object.keys(sc.properties || {}).forEach(k => { if (k in v) validate(v[k], sc.properties[k], at + '.' + k, errs); });
  }
}
const schemaErrors = (x, def) => { const e = []; validate(x, CONTRACT.$defs[def], def, e); return e; };

// ------------------------------------------------------------------ in the page: the real handler behind Backend.setupChat
const HARNESS = wire => {
  const SAVE = '__sa_engine_v1';
  window.__saSteps = [];   // the scripted model's outputs, in order (pushed by the test)
  window.__saRec = [];     // every request body + HTTP status + response body
  const jwtOf = uid => 'test-jwt-' + uid;
  let H = null;
  async function harness() {
    if (H) return H;
    const E = await import(location.origin + '/__engine__/setup_agent.js');   // absolute: an init script has no base URL in WebKit
    const world = new E.MemoryWorld((k, d, c) => window.OnboardingConfig.patch(k, d, c));
    const store = new E.MemorySetupStore(world);
    let clock = Date.now();
    try {   // the conversation survives reloads (the database would keep it)
      const s = JSON.parse(localStorage.getItem(SAVE) || 'null');
      if (s) { s.convs.forEach(([k, v]) => store.convs.set(k, v)); store.messages.push(...s.messages); s.proposals.forEach(([k, v]) => store.proposals.set(k, v)); Object.assign(store.settings, s.settings); clock = s.clock; }
    } catch (e) { /* a fresh store */ }
    store.clock = () => clock;
    const sync = async () => {   // the mock database -> the world the handler reads (RLS, ownership, credentials)
      const db = window.StartMock.admin.db(), s = await window.Backend.getSession();
      world.users.clear(); world.clients.clear(); world.tenants.clear(); world.items.clear(); world.profiles.clear(); world.credentials.clear();
      if (s && s.user) world.users.set(jwtOf(s.user.id), s.user.id);
      db.clients.forEach(c => world.clients.set(c.id, { id: c.id, user_id: c.user_id, billing_mode: H.forceQuote ? 'quote' : c.billing_mode, status: c.status, business_name: c.business_name || null }));
      db.tenants.forEach(t => world.tenants.set(t.id, { id: t.id, client_id: t.client_id, config: t.config || {}, twilio_number: t.twilio_number || null }));
      db.onboarding_items.forEach(o => world.items.set(o.id, { id: o.id, client_id: o.client_id, key: o.key, title: o.title, sort: o.sort, status: o.status, data: o.data || {} }));
      db.profiles.forEach(p => world.profiles.set(p.id, { full_name: p.full_name || null, company: p.company || null, email: p.email || null, contact_email: p.contact_email || null }));
      db.tenant_credentials.forEach(k => world.credentials.add(k.tenant_id + ':' + k.provider));
      return s && s.user ? jwtOf(s.user.id) : '';
    };
    // reads and previews: the in-memory mirror over the synced world; writes: the mock's update_onboarding_item (the forms' path)
    class PageDb extends E.MemoryUserDb {
      async update(itemId, status, data) {
        let it;
        try { it = await window.Backend.updateOnboarding(itemId, status, data); } catch (e) { throw new E.DbError(String(e.code || e.message)); }
        await sync();
        const { client_id: _c, ...row } = it; return row;
      }
    }
    const model = E.scriptedSetupModel(window.__saSteps, undefined, wire);
    const handler = E.makeHandler({ store: () => store, db: jwt => new PageDb(world, jwt), model: () => H.noModel ? null : model, log: () => {} });
    const save = () => { try { localStorage.setItem(SAVE, JSON.stringify({ convs: [...store.convs], messages: store.messages, proposals: [...store.proposals], settings: store.settings, clock })); } catch (e) { /* full */ } };
    // supabase-js functions.invoke: non-2xx -> FunctionsHttpError with the Response as .context; a throw -> FunctionsFetchError
    const sb = { functions: { async invoke(name, opts) {
      const jwt = await sync();
      if (!H.freezeClock) clock = Math.max(clock + 6000, Date.now());   // a quick typist stays under 12 a minute
      const body = JSON.stringify(opts.body);
      let res;
      try { res = await handler(new Request(location.origin + '/functions/v1/' + name, { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body })); }
      catch (e) { return { data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError', context: e }) }; }
      finally { save(); }
      const rec = { req: JSON.parse(body), status: res.status, res: await res.clone().json().catch(() => null) };
      window.__saRec.push(rec); try { window.__saPush(rec); } catch (e) { /* not recorded */ }
      if (!res.ok) return { data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { name: 'FunctionsHttpError', context: res }) };
      return { data: await res.json(), error: null };
    } } };
    H = { E, world, store, model, sync, save, adapter: window.Backend.supabaseAdapter(sb), forceQuote: false, noModel: false, freezeClock: false };
    window.__saH = H;
    return H;
  }
  window.__saHarness = harness;
  const t = setInterval(() => {
    const B = window.Backend;
    if (!B || !B.setupChat || B.__eng) return;
    clearInterval(t); B.__eng = 1;
    B.setupChat = async (input, turnId) => (await harness()).adapter.setupChat(input, turnId);
  }, 2);
  // the scripted model's steps (setup_fixtures_test.ts helpers)
  window.__sa = {
    turn: (reply, ops) => ({ reply, ops: ops || [] }),
    propose: (topic, data) => ({ op: 'propose', topic, data }),
    confirmLatest: reply => req => ({ reply: reply || 'Saved.', ops: [{ op: 'confirm', proposal_id: (/latest card: proposal_id ([0-9a-f-]{36})/.exec(String(req.messages[req.messages.length - 1].content)) || [])[1] || 'none' }] }),
    days: spec => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, spec[d] ? { closed: false, open: spec[d][0], close: spec[d][1] } : { closed: true, open: '', close: '' }])),
    push: (...s) => window.__saSteps.push(...s)
  };
};

async function newContext(browserType, wire) {
  const browser = await browserType.launch({ timeout: 60000 });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Chicago' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.addInitScript(HARNESS, wire);
  const ALL = [];
  await ctx.exposeBinding('__saPush', (src, rec) => { ALL.push(rec); });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => { errs.push('uncaught: ' + e.message); if (process.env.SA_DEBUG) console.log('PAGEERROR', e.stack); });
  page.on('dialog', d => d.accept());
  return { browser, ctx, page, errs, ALL };
}
let nav = 0;
async function signUp(page, email, name, company, phone) {
  await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
  await page.evaluate(() => { window.StartMock.admin.reset(); sessionStorage.clear(); localStorage.removeItem('__sa_engine_v1'); });
  await page.goto(BASE + '/start/?mock=1&r=' + (++nav), { waitUntil: 'load' });
  await page.fill('#email', email); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  await page.fill('#code', (await page.textContent('#mockCode')).trim());
  await page.waitForSelector('#profileForm');
  await page.evaluate(async ([n, c, ph]) => { await window.Backend.saveProfile({ full_name: n, company: c, phone: ph, niche: 'home_services' }); }, [name, company, phone]);
  await page.evaluate(() => window.Backend.mockCheckout('FR_PRO', 14));
}
const portal = async (page, tab) => { await page.goto(BASE + '/start/?r=' + (++nav) + (tab ? '#' + tab : ''), { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]'); };
const count = page => page.evaluate(() => (window.__saRec || []).length);
async function idle(page, n0) {
  await page.waitForFunction(n => (window.__saRec || []).length > n && !document.querySelector('#saTyping') && !document.querySelector('#saLog[data-sync]'), n0, { timeout: 15000 });
  await sleep(150);
}
const steps = (page, js, arg) => page.evaluate(js, arg);
async function say(page, text, step) {
  if (step) await steps(page, step);
  const n = await count(page);
  await page.fill('#saText', text); await page.press('#saText', 'Enter');
  await idle(page, n);
}
async function press(page, sel) { const n = await count(page); await page.click(sel); await idle(page, n); }
const lastText = page => page.evaluate(() => { const b = [...document.querySelectorAll('#saLog .sa-m--in .bubble--in')].pop(); return b ? b.textContent : ''; });
const logText = page => page.evaluate(() => (document.querySelector('#saLog') || {}).textContent || '');
const pendingCard = '#saLog section.scard[data-status="pending"]';
const db = page => page.evaluate(() => window.StartMock.admin.db());
const item = async (page, key) => (await db(page)).onboarding_items.find(o => o.key === key);
const tenant = async page => (await db(page)).tenants[0];
const recs = page => page.evaluate(() => window.__saRec.slice());
/** the page's Backend.setupChat (backend.js adapter): the answer, or the error as the page sees it */
const direct = (page, input, id) => page.evaluate(async ([i, t]) => {
  try { return { ok: await window.Backend.setupChat(i, t) }; } catch (e) { return { code: e.code, status: e.status, retry_after_s: e.retry_after_s }; }
}, [input, id || 'direct-' + Math.random().toString(36).slice(2, 12)]);
const norm = h => String(h).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID').replace(/\?v=[0-9a-f]+/g, '');

function contractCheck(ALL, label) {
  const bad = [];
  ALL.forEach((r, i) => {
    if (!/^bad-/.test(r.req.client_turn_id)) schemaErrors(r.req, 'Request').forEach(e => bad.push(i + ' request ' + e));   // bad-*: sent invalid on purpose
    (r.status === 200 ? schemaErrors(r.res, 'Response') : schemaErrors(r.res, 'Error')).forEach(e => bad.push(i + ' ' + (r.req.input || {}).type + ' ' + e));
  });
  ok(ALL.length > 0 && !bad.length, label + ': ' + ALL.length + ' requests and answers match setup_contract.json' + (bad.length ? ' [' + bad.slice(0, 6).join(' | ') + ']' : ''));
}

// ------------------------------------------------------------------ chromium: the whole journey on the real engine
async function journey() {
  const { browser, page, errs, ALL } = await newContext(chromium, 'compact');
  try {
    console.log('chromium (wire compact): home services journey on the real setup-agent handler');
    await signUp(page, 'maria@lopezplumbing.test', 'Maria Lopez', 'Lopez Plumbing', '(713) 555-0100');
    await portal(page, 'onboarding');
    await page.waitForSelector('#saLog'); await page.waitForFunction(() => document.querySelectorAll('#saLog .bubble--in').length >= 2);
    await sleep(200);
    const greet = await page.$$eval('#saLog .bubble--in', b => b.map(x => x.textContent));
    ok(/Hi Maria, I'm the FirstRing setup assistant, an AI\./.test(greet[0]), 'greeting from the server: first name, says it is an AI [' + greet[0] + ']');
    ok(/processed by our AI provider \(Anthropic\)/.test(await page.$$eval('#saLog .sa-note', n => n.map(x => x.textContent).join('|'))), 'the server\'s AI disclosure shows as a note');
    ok(/what jobs should the receptionist book/i.test(greet[greet.length - 1]), 'first question: services');
    ok(await page.$eval('#saText', t => t.placeholder) === 'List the jobs you book', 'the server\'s composer hint is the placeholder');
    ok((await page.evaluate(() => window.__saH.model.requests.length)) === 0, 'the greeting costs no model call');

    // services: card -> "Looks right"
    await say(page, 'drains, water heaters, leaks', () => __sa.push(__sa.turn("Here's what I understood.", [__sa.propose('services', { items: ['Drain cleaning', 'Water heater repair', 'Leak repair'] })])));
    ok(await page.$$eval(pendingCard + ' .scard__f li', l => l.map(x => x.textContent).join('|')) === 'Drain cleaning|Water heater repair|Leak repair', 'services card (kind list) from the engine');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.card === 'confirm'), 'focus on the card\'s "Looks right"');
    await press(page, pendingCard + ' [data-card=confirm]');
    let it = await item(page, 'faq'), t = await tenant(page);
    ok(it.data.services.join() === 'Drain cleaning,Water heater repair,Leak repair' && it.data.via === 'setup_assistant' && it.status === 'todo', 'confirm wrote the FULL faq item through update_onboarding_item (todo until the step is complete)');
    ok(t.config.booking.job_types.join() === 'Drain cleaning,Water heater repair,Leak repair', 'the live config follows (onboarding_apply rules)');
    ok(await page.$eval('#saLog section.scard', s => s.dataset.status === 'confirmed' && !s.querySelector('[data-card]')), 'the card turns "Saved" without buttons');
    ok(/Saved\. Where do you work\?/.test(await lastText(page)), 'next: area');

    // area: a typed "yes" confirms (model op), the page re-reads the card statuses
    await say(page, 'Houston, Bellaire, 77005', () => __sa.push(__sa.turn('Your area.', [__sa.propose('area', { text: 'Houston, Bellaire, 77005' })])));
    ok(/77005/.test(await page.textContent(pendingCard)), 'area card');
    await say(page, 'yes', () => __sa.push(__sa.confirmLatest()));
    await page.waitForFunction(() => !document.querySelector('#saLog section.scard[data-status="pending"]'));
    t = await tenant(page);
    ok(t.config.business.service_area_zips.join() === '77005' && /Houston/.test((t.config.business.service_area_places || []).join()), 'typed "yes": saved; the card shows Saved after the resume refresh');

    // hours + a correction (supersede), then the after-hours choices
    await say(page, 'mon-fri 7 to 6, sat 8-12', () => __sa.push(__sa.turn('Your hours.', [__sa.propose('hours', { days: __sa.days({ mon: ['07:00', '18:00'], tue: ['07:00', '18:00'], wed: ['07:00', '18:00'], thu: ['07:00', '18:00'], fri: ['07:00', '18:00'], sat: ['08:00', '12:00'] }) })])));
    ok(/Central time/.test(await page.textContent(pendingCard)) && /Mon–Fri 7:00 AM–6:00 PM/.test(await page.textContent(pendingCard)), 'hours card (kind hours): 7 AM–6 PM, Central time');
    await say(page, 'actually friday we close at 4', () => __sa.push(__sa.turn('Updated.', [__sa.propose('hours', { days: __sa.days({ mon: ['07:00', '18:00'], tue: ['07:00', '18:00'], wed: ['07:00', '18:00'], thu: ['07:00', '18:00'], fri: ['07:00', '16:00'], sat: ['08:00', '12:00'] }) })])));
    const st1 = await page.$$eval('#saLog section.scard', s => s.map(x => x.dataset.status));
    ok(st1.slice(-2).join() === 'superseded,pending', 'a correction replaces the card (' + st1.join() + ')');
    await press(page, pendingCard + ' [data-card=confirm]');
    t = await tenant(page);
    ok(t.config.hours.fri.join() === '07:00,16:00' && t.config.hours.sun === null, 'corrected hours saved');
    ok((await page.$$eval('#saLog .sa-chips.sa-live .chip', c => c.length)) === 3, 'after-hours choices (3)');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(3)');
    it = await item(page, 'hours'); t = await tenant(page);
    ok(it.status === 'done' && t.config.after_hours.mode === 'emergency_dial', 'a choice is its own confirmation: hours step done');
    ok(/1 of 5 steps done/.test(await page.textContent('#obCount')), 'header progress from the server: 1 of 5');

    // prices, FAQ
    await say(page, 'service call is 89', () => __sa.push(__sa.turn('Prices it may say.', [__sa.propose('prices', { mention: true, items: [{ name: 'Service call', price_usd: 89, note: '' }] })])));
    ok(/Service call: \$89/.test(await page.textContent(pendingCard)), 'prices card');
    // a save the database refuses (as if a rule changed between the card and the confirm): failed card, the forms' words
    await page.evaluate(() => { const p = [...window.__saH.store.proposals.values()].filter(x => x.status === 'pending').pop(); p.data.faq = [{ q: '', a: 'no question' }]; window.__saH.save(); });
    await press(page, pendingCard + ' [data-card=confirm]');
    ok(await page.$('#saLog section.scard[data-status="failed"]') !== null && /Not saved/.test(await page.textContent('#saLog section.scard[data-status="failed"]')), 'refused save: the card says Not saved');
    const formsWords = await page.evaluate(() => window.PortalB.settingsErr(Object.assign(new Error('invalid_setting:faq[0].q'), { code: 'invalid_setting:faq[0].q' })));
    ok((await page.$$eval('#saLog .sa-notice', n => n.map(x => x.textContent))).includes(formsWords), 'the engine\'s error text = the forms\' wording (' + formsWords + ')');
    ok(await page.$('#saLog .sa-openform[data-openform="faq"]') !== null && /What should I change\?/.test(await lastText(page)), 'open_form to the FAQ step, and a question');
    await say(page, 'just the service call, 89', () => __sa.push(__sa.turn('Prices it may say.', [__sa.propose('prices', { mention: true, items: [{ name: 'Service call', price_usd: 89, note: '' }] })])));
    await press(page, pendingCard + ' [data-card=confirm]');
    ok((await tenant(page)).config.pricing.items.length === 1, 'prices saved on the second card');
    await say(page, 'do you work weekends? yes, saturday mornings', () => __sa.push(__sa.turn('Your questions.', [__sa.propose('faq', { items: [{ q: 'Do you work weekends?', a: 'Yes, Saturday mornings.' }] })])));
    ok((await page.$$eval(pendingCard + ' .sa-faq li', l => l.length)) === 1, 'FAQ card (kind faq)');
    await press(page, pendingCard + ' [data-card=confirm]');
    it = await item(page, 'faq');
    ok(it.status === 'done', 'services & FAQ step done');

    // alerts: quick reply, skip on-call by quick reply, emergency words
    const email = (await tenant(page)).config.notify.email[0];
    ok(new RegExp('I have ' + email.replace(/[.]/g, '\\.')).test(await lastText(page)), 'alerts question names the e-mail on file');
    await steps(page, e => __sa.push(__sa.turn('Alerts.', [__sa.propose('alerts', { emails: [e], mobiles: [], daily_summary: '19:00' })])), email);
    let n = await count(page); await page.click('#saQuick .chip'); await idle(page, n);   // "Just email"
    ok((ALL[ALL.length - 1].req.input || {}).text === 'just email', 'a quick reply sends its input');
    await press(page, pendingCard + ' [data-card=confirm]');
    await steps(page, () => __sa.push(__sa.turn('OK.', [{ op: 'skip', topic: 'on_call' }])));
    n = await count(page); await page.click('#saQuick .chip'); await idle(page, n);   // "No on-call number"
    ok(/No problem, skipped\./.test(await lastText(page)), 'on-call skipped');
    await say(page, 'flooding, burst pipe', () => __sa.push(__sa.turn('Emergency words.', [__sa.propose('emergency', { keywords: ['flooding', 'burst pipe'] })])));
    await press(page, pendingCard + ' [data-card=confirm]');
    it = await item(page, 'alerts');
    ok(it.status === 'done' && (await tenant(page)).config.emergency.keywords.join() === 'flooding,burst pipe', 'alerts step done');
    ok(/calendar/i.test(await lastText(page)), 'next: calendar');

    // "Edit manually": the forms show the assistant's answers; a form save is noticed
    await page.click('#saManual'); await page.waitForSelector('.obsteps');
    await page.evaluate(() => { document.querySelector('#ob-hours').open = true; document.querySelector('#ob-faq').open = true; });
    ok(await page.$eval('#obh_fri_c', i => i.value) === '16:00' && await page.$eval('#ob_services', i => i.value) === 'Drain cleaning, Water heater repair, Leak repair', 'the forms show what the assistant saved');
    await page.fill('#obh_sat_c', '13:00'); await page.click('[data-save="hours"]'); await page.waitForTimeout(400);
    n = await count(page);
    await page.click('[data-saview="chat"]'); await idle(page, n);
    ok(ALL.slice(n).some(r => r.req.input.type === 'event' && r.req.input.event === 'forms_saved'), 'back to chat sends forms_saved');
    ok(/I see you updated business hours in the form\./.test(await logText(page)), 'the engine saw the form change [' + (await lastText(page)) + ']');

    // calendar: Google OAuth round trip
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');
    ok(await page.$('#saLog [data-calconnect="google"]') !== null, 'connect_calendar action (google)');
    await Promise.all([page.waitForURL(/#onboarding/), page.click('#saLog [data-calconnect="google"]')]);
    await page.waitForFunction(() => { const l = document.querySelector('#saLog'); return !!l && /Google Calendar connected\./.test(l.textContent) && !document.querySelector('#saTyping') && !l.dataset.sync; });
    await sleep(200);
    ok((await item(page, 'calendar')).status === 'done', 'calendar done after the OAuth return (event calendar_returned)');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');   // tools: skip
    ok((await item(page, 'tools')).status === 'done', 'tools skipped');

    // forwarding: "yes" (no model), carrier, then no number yet
    ok(/Is that the number your customers call\?/.test(await lastText(page)), 'business number question');
    const calls0 = await page.evaluate(() => window.__saH.model.requests.length);
    n = await count(page); await page.click('#saQuick .chip:nth-child(1)'); await idle(page, n);   // Yes
    ok((await page.evaluate(() => window.__saH.model.requests.length)) === calls0, '"yes" to the business number needs no model call');
    ok((await page.$$eval('#saLog .sa-chips.sa-live .chip', c => c.map(x => x.textContent))).includes('Verizon'), 'carrier choices');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');   // Verizon
    ok((await item(page, 'forward_calls')).data.carrier === 'verizon', 'carrier saved');
    ok(await page.$('#saLog .acard--test_call') !== null && /being set up/.test(await page.textContent('#saLog .acard--test_call')), 'no number yet: test card state no_number');
    ok((await recs(page)).slice(-1)[0].res.progress.go_live === 'waiting_number', 'go_live waiting_number');
    // the number arrives; the customer comes back (the e-mail): resume tells them and shows the instructions
    await page.evaluate(() => window.StartMock.admin.runtimeTick());
    t = await tenant(page);
    await portal(page, 'onboarding');
    await page.waitForFunction(() => document.querySelector('#saLog .acard--forwarding_instructions'), null, { timeout: 8000 }).catch(() => {});
    await sleep(200);
    ok(/your receptionist's number is ready/i.test(await logText(page)), 'resume after the number arrived: the assistant says so');
    const fw = await page.$('#saLog .acard--forwarding_instructions') ? await page.textContent('#saLog .acard--forwarding_instructions') : '';
    ok(/Forwarding for Verizon/.test(fw) && fw.includes('*71' + t.twilio_number.slice(2)), 'forwarding instructions with the Verizon dial code');
    ok(await page.$('#saLog .acard--test_call [data-test="start"]') !== null, 'test call card: ready, with the button');

    // test call -> forwarded by the business line -> passed -> testing -> live
    await press(page, '#saLog .acard--test_call [data-test="start"]');
    ok(!!(await item(page, 'forward_calls')).data.test_started_at && /Test started/.test(await lastText(page)), 'Test call: start_forwarding_test, then the engine says what to do');
    n = await count(page);
    await page.evaluate(tid => window.StartMock.admin.simulateCall(tid), t.id);
    await idle(page, n);
    await page.waitForFunction(() => /All required steps are done/.test(document.querySelector('#saLog') ? document.querySelector('#saLog').textContent : ''), null, { timeout: 10000 }).catch(() => {});
    ok(/Your test call came through\. Forwarding works\./.test(await logText(page)), 'test_changed -> passed');
    ok((await db(page)).clients[0].status === 'testing' && (await recs(page)).slice(-1)[0].res.progress.go_live === 'testing', 'client testing; go_live testing');
    ok(await page.$('#saDone') !== null && /You’re all set/.test(await page.textContent('#saDone')), 'status complete: the finished card');
    await page.evaluate(() => window.StartMock.admin.runtimeTick());
    await page.waitForFunction(() => /You're live\./.test(document.querySelector('#saLog') ? document.querySelector('#saLog').textContent : ''), null, { timeout: 20000 }).catch(() => {});
    ok((await db(page)).clients[0].status === 'live' && /You're live\./.test(await logText(page)), 'went live: the assistant says so on the next resume');
    await page.waitForFunction(() => !window.PortalSetupChat._state().applying && !document.querySelector('#saLog[data-sync]'), null, { timeout: 10000 });
    await sleep(300);
    ok(/You’re live/.test(await page.textContent('#saDone')), 'finished card: You’re live');

    // a model failure: "Try again" resends the same client_turn_id and gets the stored text answered
    await say(page, 'change my hours', () => __sa.push({ throws: 'unavailable' }));
    ok(/didn’t get that through/.test(await page.textContent('#saBanner')) && await page.$('#saBanner [data-saretry]') !== null, 'model down: "Sorry, I didn’t get that through" with Try again');
    const failed = ALL[ALL.length - 1];
    ok(failed.res.status === 'unavailable' && failed.res.fallback.reason === 'assistant_unavailable' && failed.res.messages[0].unanswered === true, 'server: unavailable, the message kept unanswered');
    await steps(page, () => __sa.push(__sa.turn('Sure.', [{ op: 'switch_topic', topic: 'hours' }])));
    await press(page, '#saBanner [data-saretry]');
    const retry = ALL[ALL.length - 1];
    ok(retry.req.client_turn_id === failed.req.client_turn_id && retry.status === 200 && retry.res.status !== 'unavailable', 'Try again: the same client_turn_id, answered');
    ok(/Here's what's saved now/.test(await page.textContent(pendingCard)), 'switch_topic: the saved hours as a card');
    await press(page, pendingCard + ' [data-card=change]');
    ok(/What should I change\?/.test(await lastText(page)), '"Change something" asks what to change');

    // reload resumes the same thread
    const before = await page.$$eval('#saLog > li[data-key]', l => l.length);
    await portal(page, 'onboarding');
    await page.waitForFunction(k => document.querySelectorAll('#saLog > li[data-key]').length >= k, before);
    ok((await page.$$eval('#saLog > li[data-key]', l => l.length)) === before, 'reload: the same thread (' + before + ' messages)');

    // HTTP errors as the page sees them (backend.js adapter: code, status, retry_after_s)
    let r = await direct(page, { type: 'message', text: 'x'.repeat(1001) }, 'bad-toolong01');
    ok(r.code === 'bad_input' && r.status === 400, 'over 1,000 characters: 400 bad_input [' + JSON.stringify(r) + ']');
    r = await direct(page, { type: 'nope' }, 'bad-nope0001');
    ok(r.code === 'bad_input' && r.status === 400, 'unknown input type: 400 bad_input');
    await page.evaluate(() => { window.__saH.forceQuote = true; });
    r = await direct(page, { type: 'resume' });
    ok(r.code === 'not_a_plan_client' && r.status === 403, 'not a plan client: 403 not_a_plan_client');
    await page.evaluate(() => { window.__saH.forceQuote = false; window.__saH.freezeClock = true; });
    let limited = null;
    for (let i = 0; i < 14 && !limited; i++) { const x = await direct(page, { type: 'event', event: 'back_online' }); if (x.code) limited = x; }
    ok(limited && limited.code === 'rate_limited' && limited.status === 429 && limited.retry_after_s > 0, '12 a minute: 429 rate_limited with retry_after_s [' + JSON.stringify(limited) + ']');
    await page.evaluate(() => { window.__saH.freezeClock = false; });

    // the server's kill switch (private.settings.setup_agent_enabled = false): a calm answer, the plain checklist
    await page.evaluate(() => { window.__saH.store.settings.enabled = false; window.__saH.save(); });
    r = await direct(page, { type: 'message', text: 'hello' });
    ok(r.ok && r.ok.status === 'unavailable' && r.ok.fallback.reason === 'disabled' && r.ok.composer.enabled === false && r.ok.messages.length === 0, 'switch off: HTTP 200, status unavailable, fallback disabled, nothing stored');
    await portal(page, 'onboarding');
    await page.waitForSelector('.obsteps'); await sleep(300);
    const offChat = norm(await page.innerHTML('#panel'));
    ok(await page.$('#saLog') === null && await page.$('[data-saview]') === null, 'switch off: no chat, no Chat/Edit manually switch');
    brandOn = false;
    await portal(page, 'onboarding');
    await page.waitForSelector('.obsteps'); await sleep(300);
    const flagOff = norm(await page.innerHTML('#panel'));
    // the only difference allowed: the step the conversation was on is opened (fallback.item_key), as for any fallback
    ok(/<details class="obstep" id="ob-hours" data-key="hours" open="">/.test(offChat), 'switch off: the checklist opens at the conversation\'s step (hours)');
    const closed = h => h.replace(/(<details class="obstep"[^>]*?) open=""/g, '$1');
    ok(closed(offChat) === closed(flagOff), 'switch off on the server = exactly the checklist the portal shows with brand.json setup_agent off');
    if (process.env.SA_DEBUG && closed(offChat) !== closed(flagOff)) { let i = 0; while (offChat[i] === flagOff[i]) i++; console.log('DIFF@' + i, '\n  server-off: ' + offChat.slice(i - 200, i + 300), '\n  flag-off:   ' + flagOff.slice(i - 200, i + 300)); }
    brandOn = true;

    contractCheck(ALL, 'chromium');
    ok(errs.length === 0, 'no console errors' + (errs.length ? ' [' + errs.slice(0, 3).join(' | ') + ']' : ''));
  } finally { await browser.close(); }
}

// ------------------------------------------------------------------ webkit (wire json): first card, typed yes, reload
async function shortRun() {
  const { browser, page, errs, ALL } = await newContext(webkit, 'json');
  try {
    console.log('webkit (wire json): card, typed yes, reload');
    await signUp(page, 'ray@brightair.test', 'Ray Diaz', 'Bright Air', '(602) 555-0100');
    await portal(page, 'onboarding');
    await page.waitForFunction(() => document.querySelectorAll('#saLog .bubble--in').length >= 2);
    await say(page, 'ac repair and tune ups', () => __sa.push(__sa.turn("Here's what I understood.", [__sa.propose('services', { items: ['AC repair', 'Tune-up'] })])));
    ok(await page.$$eval(pendingCard + ' .scard__f li', l => l.map(x => x.textContent).join('|')) === 'AC repair|Tune-up', 'webkit: services card');
    await say(page, 'yes', () => __sa.push(__sa.confirmLatest()));
    await page.waitForFunction(() => !document.querySelector('#saLog section.scard[data-status="pending"]'));
    ok((await tenant(page)).config.booking.job_types.join() === 'AC repair,Tune-up', 'webkit: typed yes saved');
    const before = await page.$$eval('#saLog > li[data-key]', l => l.length);
    await portal(page, 'onboarding');
    await page.waitForFunction(k => document.querySelectorAll('#saLog > li[data-key]').length >= k, before);
    ok((await page.$$eval('#saLog > li[data-key]', l => l.length)) === before && /Where do you work/.test(await lastText(page)), 'webkit: reload resumes');
    contractCheck(ALL, 'webkit');
    ok(errs.length === 0, 'webkit: no console errors' + (errs.length ? ' [' + errs.slice(0, 3).join(' | ') + ']' : ''));
  } finally { await browser.close(); }
}

try {
  if (!process.env.SA_ONLY_WK) await journey();
  await shortRun();
} catch (e) { failN++; console.log('  FAIL (exception) ' + (e && e.stack || e)); }
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`e2e_setup_agent_engine: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
