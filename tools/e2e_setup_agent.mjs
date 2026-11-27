// E2E for the setup assistant (2026-11-27, docs/setup-agent-design-2026-11-27.md) on the MOCK backend: brand.json is served
// with setup_agent.enabled = true (shipped: off), the conversation is answered by site/start/assets/mock/setup-script.js.
//   chromium: the whole home-services journey at 390 px (greeting that says it is an AI, every card confirmed by button or a typed
//     "yes", a correction that replaces a card, choices, prices, FAQ, alerts) -> "Edit manually" shows the chat's answers in the
//     forms, a form save is noticed by the chat -> Google Calendar OAuth return lands back in the chat -> tools skipped ->
//     forwarding: no number yet, then the number arrives (resume) -> carrier instructions with the dial code -> test call ->
//     unverified -> self-confirm -> "testing" -> live (automatic) -> reload resumes the same thread -> after go-live a change
//     by chat; a refused save (failed card + notice + open_form); every failure (assistant_unavailable with retry, two in a
//     row -> form, budget, limit, 429, disabled, server down at first open, offline); keyboard-only; the on-screen keyboard
//     (visualViewport) keeps the composer and the newest message visible; flag off and quote clients keep the checklist;
//     every response is checked against contract v1. Real estate: the pre-filled services card.
//   webkit + firefox: a short journey (card, typed yes, correction, reload) and overflow.
//   overflow: 320/375/390/414/768/1280 in all three engines, no console errors.
// SHOTS_DIR=<dir> saves screenshots of the main states at 390 and 1280 (sa-*.png).
//   node tools/e2e_setup_agent.mjs        (own static server on E2E_PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8971);
const SHOTS = process.env.SHOTS_DIR || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const BRAND = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));
let brandOn = true;
const server = http.createServer((req, rsp) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
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

// ------------------------------------------------------------------ contract v1 (design section 2.3), checked on every response
const BLOCKS = {
  summary_card: b => typeof b.proposal_id === 'string' && typeof b.topic === 'string' && typeof b.item_key === 'string' && typeof b.title === 'string' &&
    ['pending', 'confirmed', 'superseded', 'failed'].includes(b.status) && Array.isArray(b.fields) && b.fields.every(f => typeof f.key === 'string' && typeof f.label === 'string' && 'value' in f && typeof f.text === 'string') &&
    Array.isArray(b.actions) && b.actions.every(a => ['confirm', 'change'].includes(a.id) && typeof a.label === 'string'),
  choices: b => typeof b.id === 'string' && Array.isArray(b.options) && b.options.length > 0 && b.options.every(o => typeof o.id === 'string' && typeof o.label === 'string'),
  action: b => (b.action === 'connect_calendar' && ['google', 'calendly'].includes(b.provider)) ||
    (b.action === 'forwarding_instructions' && typeof b.carrier === 'string' && /^\+1\d{10}$/.test(b.forward_to || '')) ||
    (b.action === 'test_call' && ['ready', 'waiting', 'unverified', 'direct', 'mismatch', 'passed', 'no_number'].includes(b.state)),
  open_form: b => typeof b.item_key === 'string' && typeof b.label === 'string',
  notice: b => ['info', 'ok', 'err'].includes(b.kind) && typeof b.text === 'string',
};
const SCHEMA_FILE = [process.env.SETUP_CONTRACT, path.join(SITE, 'assets/setup_contract.json')].find(f => f && fs.existsSync(f));
const SCHEMA = SCHEMA_FILE ? JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) : null;
// a small JSON Schema subset (the keywords setup_contract.json uses)
function validate(v, sc, at, errs) {
  if (sc.$ref) sc = sc.$ref.split('/').slice(1).reduce((o, k) => o[k], SCHEMA);
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
function schemaErrors(x, def) { if (!SCHEMA) return []; const e = []; validate(x, SCHEMA.$defs[def], def, e); return e; }
function contractErrors(res) {
  if (SCHEMA) return schemaErrors(res, 'Response');
  const e = [];
  if (!res || res.v !== 1) e.push('v');
  if (typeof res.conversation_id !== 'string') e.push('conversation_id');
  if (!['active', 'complete', 'unavailable'].includes(res.status)) e.push('status');
  if (!Array.isArray(res.messages)) e.push('messages');
  (res.messages || []).forEach((m, i) => {
    if (typeof m.id !== 'string' || typeof m.seq !== 'number' || !['assistant', 'user', 'note'].includes(m.role) || typeof m.text !== 'string' || typeof m.created_at !== 'string' || !Array.isArray(m.blocks)) e.push('message ' + i);
    if (/<[a-z]/i.test(m.text)) e.push('markup in text ' + i);
    (m.blocks || []).forEach((b, j) => { if (!BLOCKS[b.type] || !BLOCKS[b.type](b)) e.push('block ' + i + '.' + j + ' ' + b.type); });
  });
  const p = res.progress;
  if (!p || !Array.isArray(p.steps) || typeof p.done !== 'number' || typeof p.total !== 'number' || !['waiting_number', 'steps_left', 'testing', 'delayed', 'live'].includes(p.go_live)) e.push('progress');
  else if (!p.steps.every(s => typeof s.key === 'string' && typeof s.title === 'string' && typeof s.status === 'string' && typeof s.required === 'boolean')) e.push('progress.steps');
  if (!res.composer || typeof res.composer.enabled !== 'boolean' || !Array.isArray(res.composer.quick_replies)) e.push('composer');
  if (res.fallback !== null && !(res.fallback && ['assistant_unavailable', 'budget', 'limit', 'disabled'].includes(res.fallback.reason))) e.push('fallback');
  if (!res.limits || typeof res.limits.messages_left_today !== 'number') e.push('limits');
  return e;
}

// ------------------------------------------------------------------ page helpers
const RECORD = () => {   // every Backend.setupChat request + response, for the contract check
  const t = setInterval(() => {
    const B = window.Backend;
    if (!B || !B.setupChat || B.__rec) return;
    const f = B.setupChat; B.__rec = 1; clearInterval(t);
    B.setupChat = async (...a) => {
      const rec = { input: a[0], turn: a[1] }; (window.__sa = window.__sa || []).push(rec);
      const keep = () => { try { if (window.__saPush) window.__saPush(JSON.parse(JSON.stringify(rec))); } catch (e) { /* not recorded */ } };
      try { const r = await f(...a); rec.res = r; keep(); return r; } catch (e) { rec.err = e.code || e.message; keep(); throw e; }
    };
  }, 2);
};
async function newContext(browserType, width) {
  const browser = await browserType.launch({ timeout: 60000 });
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 844 }, timezoneId: 'America/Chicago' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.addInitScript(RECORD);
  const ALL = [];   // every setupChat call of this context, across page loads
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
async function signUp(page, email, name, company, phone, niche) {
  await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
  await page.evaluate(() => { window.StartMock.admin.reset(); sessionStorage.clear(); });
  await page.goto(BASE + '/start/?mock=1&r=' + (++nav), { waitUntil: 'load' });
  await page.fill('#email', email); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  await page.fill('#code', (await page.textContent('#mockCode')).trim());
  await page.waitForSelector('#profileForm');
  await page.evaluate(async ([n, c, ph, ni]) => { await window.Backend.saveProfile({ full_name: n, company: c, phone: ph, niche: ni || 'home_services' }); }, [name, company, phone, niche]);
  await page.evaluate(() => window.Backend.mockCheckout('FR_PRO', 14));
}
const portal = async (page, tab, q) => { await page.goto(BASE + '/start/?r=' + (++nav) + (q || '') + (tab ? '#' + tab : ''), { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]'); };
const calls = page => page.evaluate(() => (window.__sa || []).map(x => ({ input: x.input, err: x.err || null, res: x.res || null })));
async function idle(page, n0) {   // the turn started after n0 recorded calls has answered and the page is drawn
  await page.waitForFunction(n => (window.__sa || []).length > n && (window.__sa || []).every(x => x.res || x.err) && !document.querySelector('#saTyping') && !document.querySelector('#saLog[data-sync]'), n0, { timeout: 15000 });
  await sleep(120);
}
const count = page => page.evaluate(() => (window.__sa || []).length);
async function say(page, text) {
  const n = await count(page);
  await page.fill('#saText', text); await page.press('#saText', 'Enter');
  await idle(page, n);
}
async function press(page, sel) {
  const n = await count(page);
  await page.click(sel);
  await idle(page, n);
}
const lastText = page => page.evaluate(() => { const b = [...document.querySelectorAll('#saLog .sa-m--in .bubble--in')].pop(); return b ? b.textContent : ''; });
const pendingCard = '#saLog section.scard[data-status="pending"]';
const db = page => page.evaluate(() => window.StartMock.admin.db());
const item = async (page, key) => (await db(page)).onboarding_items.find(o => o.key === key);
const tenant = async page => (await db(page)).tenants[0];
async function overflowAt(page, widths) {
  const bad = [];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: w >= 1024 ? 800 : 700 }); await sleep(60);
    const d = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (d > 0) bad.push(w + ':' + d);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  return bad;
}
async function shot(page, name, sel) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const w of [390, 1280]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 }); await sleep(150);
    await page.evaluate(s => {
      document.documentElement.style.scrollBehavior = 'auto';
      const e = s && document.querySelector(s);
      if (e) e.scrollIntoView({ block: 'end' }); else window.scrollTo(0, document.documentElement.scrollHeight);
    }, sel || null);
    await sleep(200);
    await page.screenshot({ path: path.join(SHOTS, `sa-${name}-${w}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

// ------------------------------------------------------------------ chromium: the whole journey
async function journey() {
  const { browser, ctx, page, errs, ALL } = await newContext(chromium, 390);
  try {
    console.log('chromium: home services journey');
    await signUp(page, 'maria@lopezplumbing.test', 'Maria Lopez', 'Lopez Plumbing', '(713) 555-0100');
    await portal(page);
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Setup,Requests,Quotes,Billing', 'plan client with the flag on: the tab is "Setup"');
    const home = await page.textContent('#panel');
    ok(/Setup: 0 of 5 steps done/.test(home) && (await page.textContent('#goOnboarding')) === 'Continue setup with the assistant', 'home: "Setup: 0 of 5" and "Continue setup with the assistant"');
    ok((await page.$$eval('.stepper li', l => l.map(x => x.textContent))).slice(1).join() === 'Setup,Test call,Live', 'home stepper: Setup → Test call → Live');
    await page.evaluate(() => { window.__sa = []; });
    await page.click('#goOnboarding');
    await page.waitForSelector('#saLog'); await page.waitForFunction(() => document.querySelectorAll('#saLog .bubble--in').length >= 2);
    await sleep(150);
    ok(await page.$eval('[data-saview="chat"]', b => b.getAttribute('aria-pressed')) === 'true', 'chat is the default view of Setup');
    const greet = await page.$$eval('#saLog .bubble--in', b => b.map(x => x.textContent));
    ok(/Hi Maria/.test(greet[0]) && /setup assistant, an AI/.test(greet[0]) && /Lopez Plumbing at \(713\) 555-0100/.test(greet[0]), 'greeting: first name, says it is an AI, uses what sign-up collected');
    ok(/Anthropic/.test(await page.textContent('#saDisc')) && await page.$('#saDisc a[href="/legal/privacy/"]') !== null, 'disclosure line with the Privacy Policy link');
    ok(await page.$('#saLog .sa-note') !== null, 'the privacy note from the server is shown as a note');
    ok(/what jobs should the receptionist book/i.test(greet[greet.length - 1]), 'first question: services');
    ok(await page.$eval('#saLog', l => l.getAttribute('role') === 'log' && l.getAttribute('aria-live') === 'polite' && l.getAttribute('aria-relevant') === 'additions'), 'log region: role=log, aria-live polite, additions');
    ok(await page.$eval('#saText', t => t.getAttribute('maxlength') === '1000' && t.getAttribute('enterkeyhint') === 'send' && parseFloat(getComputedStyle(t).fontSize) >= 16), 'composer: 1000 chars, enterkeyhint send, 16 px (no iOS zoom)');
    ok(await page.$eval('#saSend', b => b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().height >= 44), 'send button at least 44×44');
    await shot(page, 'first-open');

    // services: card -> "Looks right" (button)
    await say(page, 'Drain cleaning, Water heater repair, Leak repair');
    ok(await page.$$eval(pendingCard + ' .scard__f li', l => l.map(x => x.textContent).join('|')) === 'Drain cleaning|Water heater repair|Leak repair', 'services card lists the three services');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.card === 'confirm'), 'focus goes to the card’s first button when a card arrives');
    await shot(page, 'card-pending', pendingCard);
    await press(page, pendingCard + ' [data-card=confirm]');
    let it = await item(page, 'faq'), t = await tenant(page);
    ok(it.data.services.join() === 'Drain cleaning,Water heater repair,Leak repair' && it.data.via === 'setup_assistant' && it.status === 'todo', 'services saved into the checklist item (todo until the step is complete)');
    ok(t.config.booking.job_types.join() === 'Drain cleaning,Water heater repair,Leak repair', 'services in the live config (same rules as the form)');
    ok(await page.$eval('#saLog section.scard', s => s.dataset.status === 'confirmed' && /Saved/.test(s.textContent) && !s.querySelector('[data-card]')), 'confirmed card: "Saved", no buttons');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'saText'), 'focus returns to the composer after the reply');
    ok(/Where do you work/.test(await lastText(page)), 'next: area');

    // area: typed "yes" confirms the card just shown
    await say(page, 'Houston, Bellaire, 77005, 77401');
    ok(/77005/.test(await page.textContent(pendingCard)) && /Bellaire/.test(await page.textContent(pendingCard)), 'area card: places and ZIPs');
    await say(page, 'yes');
    t = await tenant(page);
    ok(t.config.business.service_area_zips.join() === '77005,77401' && t.config.business.service_area_places.join() === 'Houston,Bellaire', 'typed "yes" right after the card saves it');

    // hours + a correction
    await say(page, 'mon-fri 7 to 6, saturday 8-12');
    ok(/Mon–Fri 7:00 AM–6:00 PM/.test(await page.textContent(pendingCard)) && /Central time/.test(await page.textContent(pendingCard)), 'hours card: read as 7 AM–6 PM, Central time');
    await say(page, 'yes but friday we close at 4');
    const cardsNow = await page.$$eval('#saLog section.scard', s => s.map(x => x.dataset.status));
    ok(cardsNow.slice(-2).join() === 'superseded,pending', '"yes but …" is a correction: the old card is replaced, a new one is pending (' + cardsNow.join() + ')');
    ok(/Fri 7:00 AM–4:00 PM/.test(await page.textContent(pendingCard)) && /Replaced/.test(await page.$$eval('#saLog section.scard', s => s[s.length - 2].textContent)), 'corrected card shows Friday until 4; the old one says Replaced');
    await shot(page, 'correction', pendingCard);
    await press(page, pendingCard + ' [data-card=confirm]');
    t = await tenant(page);
    ok(t.config.hours.fri.join() === '07:00,16:00' && t.config.hours.sat.join() === '08:00,12:00' && t.config.hours.sun === null, 'corrected hours saved');
    // after hours: choices
    ok((await page.$$eval('#saLog .sa-chips.sa-live .chip', c => c.map(x => x.textContent))).length === 3, 'after-hours choices (3 options)');
    await shot(page, 'choices', '#saLog .sa-chips.sa-live');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(3)');
    it = await item(page, 'hours'); t = await tenant(page);
    ok(it.status === 'done' && t.config.after_hours.mode === 'emergency_dial', 'after-hours choice saved; the hours step is done');
    ok(await page.$('#saLog .sa-chips.sa-live') === null || !(await page.$$eval('#saLog .sa-live .chip', c => c.length)), 'old choices disappear once answered');
    ok(/1 of 5 steps done/.test(await page.textContent('#obCount')), 'header progress: 1 of 5 [' + await page.textContent('#obCount') + ']');

    // prices, FAQ
    await say(page, 'service call is 89, drain cleaning 150. nothing else');
    ok(/Service call: \$89/.test(await page.textContent(pendingCard)) && /Drain cleaning: \$150/.test(await page.textContent(pendingCard)), 'prices card');
    await say(page, 'yes');
    await say(page, 'Do you work weekends? Yes, Saturday mornings. Are you licensed? Yes, Texas license M-12345.');
    ok((await page.$$eval(pendingCard + ' .sa-faq li', l => l.length)) === 2, 'FAQ card: 2 pairs');
    await say(page, 'ok');
    it = await item(page, 'faq'); t = await tenant(page);
    ok(it.status === 'done' && t.config.pricing.mode === 'listed' && t.config.pricing.items.length === 2 && t.config.faq.length === 2, 'services & FAQ step done; prices and FAQ in the live config');

    // alerts (multi-part answer), on-call, emergency words -> one card
    ok(/maria@lopezplumbing\.test/.test(await lastText(page)), 'alerts question shows the sign-up email [' + await page.$$eval('#saLog .bubble', b => b.slice(-4).map(x => x.textContent).join(' || ')) + ']');
    await page.click('#saQuick .chip');   // "Just email"
    await page.waitForFunction(() => /phone number we should ring/.test([...document.querySelectorAll('#saLog .bubble--in')].pop().textContent));
    await say(page, '713 555 0177');
    await say(page, 'use those plus no hot water');
    const al = await page.textContent(pendingCard);
    ok(/\(713\) 555-0177/.test(al) && /no hot water/.test(al) && /7:00 PM/.test(al), 'alerts card: on-call, words (suggestion + own), daily summary 7 PM');
    await press(page, pendingCard + ' [data-card=confirm]');
    it = await item(page, 'alerts'); t = await tenant(page);
    ok(it.status === 'done' && t.config.handoff.number === '+17135550177' && t.config.emergency.keywords.includes('no hot water'), 'alerts step done, on-call + emergency words in the config');
    ok(/calendar/i.test(await lastText(page)), 'next: calendar');

    // "Edit manually": the forms show the chat's answers; a form save is noticed by the chat
    await page.click('#saManual');
    await page.waitForSelector('.obsteps');
    ok(await page.$eval('[data-saview="manual"]', b => b.getAttribute('aria-pressed')) === 'true', '"Edit manually" opens the checklist');
    ok(await page.$('.vslot') === null, 'no video slots in the manual view');
    ok(/Prefer to chat\?/.test(await page.textContent('#obCount')), 'help line: "Prefer to chat? Switch to the setup assistant."');
    ok(await page.$eval('#ob-calendar', d => d.open), 'the form opens at the current step (calendar)');
    await page.evaluate(() => { document.querySelector('#ob-hours').open = true; document.querySelector('#ob-faq').open = true; });
    ok(await page.$eval('#obh_fri_c', i => i.value) === '16:00' && await page.$eval('#ob_services', i => i.value) === 'Drain cleaning, Water heater repair, Leak repair' && await page.$eval('#obf_q0', i => i.value) === 'Do you work weekends?', 'the forms show what the chat saved (hours, services, FAQ)');
    await shot(page, 'manual-view', '#ob-hours');
    await page.fill('#obh_sat_c', '13:00');
    await page.click('[data-save="hours"]'); await page.waitForTimeout(400);
    t = await tenant(page);
    ok(t.config.hours.sat.join() === '08:00,13:00', 'a manual save goes into the config');
    const n1 = await count(page);
    await page.click('[data-saview="chat"]');
    await idle(page, n1);
    const ev = (await calls(page)).slice(n1);
    ok(ev.some(c => c.input.type === 'event' && c.input.event === 'forms_saved'), 'back to chat sends event forms_saved');
    ok(/I see you updated your business hours in the form/.test(await page.$$eval('#saLog .bubble--in', b => b.map(x => x.textContent).join(' | '))), 'the chat says it saw the manual change');

    // calendar: Google OAuth round trip lands back in the chat
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');   // Google Calendar
    ok(await page.$('#saLog [data-calconnect="google"]') !== null, 'connect Google Calendar action card');
    await shot(page, 'calendar-action', '#saLog .acard--connect_calendar');
    await Promise.all([page.waitForURL(/#onboarding/), page.click('#saLog [data-calconnect="google"]')]);
    await page.waitForSelector('#saLog');
    await page.waitForFunction(() => { const l = document.querySelector('#saLog'); return !!l && /Google Calendar connected\./.test(l.textContent) && !document.querySelector('#saTyping') && !l.dataset.sync; });
    await sleep(200);
    it = await item(page, 'calendar');
    ok(it.status === 'done' && it.data.provider === 'google', 'calendar step done after the OAuth return');
    ok(/Back from the calendar sign-in\./.test(await page.$$eval('#saLog .sa-note', n => n.map(x => x.textContent).join('|'))), 'the event shows as a note in the chat');
    ok((await calls(page)).some(c => c.input.type === 'event' && c.input.event === 'calendar_returned'), 'event calendar_returned sent');
    ok(/other tools/i.test(await lastText(page)), 'next after the calendar: tools');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');   // tools:skip
    it = await item(page, 'tools');
    ok(it.status === 'done' && it.data.skipped === true, 'tools skipped');

    // forwarding: the number isn't ready yet -> no_number; it arrives -> resume shows the instructions
    ok(/Is that the number your customers call/.test(await lastText(page)), 'business number confirmation question');
    await press(page, '#saQuick .chip:nth-child(1)');   // Yes (a quick reply)
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');   // Verizon
    ok(await page.$('#saLog .acard--test_call') !== null && /being set up/.test(await page.textContent('#saLog .acard--test_call')), 'no number yet: test card says the number is coming');
    await page.evaluate(() => window.StartMock.admin.runtimeTick());
    t = await tenant(page);
    await portal(page, 'onboarding');
    await page.waitForFunction(() => document.querySelector('#saLog .acard--forwarding_instructions'));
    await sleep(200);
    const digits = t.twilio_number.slice(2);
    const fw = await page.textContent('#saLog .acard--forwarding_instructions');
    ok(/Forwarding for Verizon/.test(fw) && fw.includes('*71' + digits), 'Verizon instructions with the dial code *71<number> (the checklist’s carrier table)');
    ok(await page.$('#saLog #sa_car') !== null && await page.$('#saLog .acard [data-help]') !== null, 'provider picker and "Need help with this step?" in the forwarding card');
    await shot(page, 'forwarding', '#saLog .acard--test_call');
    // test call -> unverified -> self-confirm
    await press(page, '#saLog [data-test="start"]');
    it = await item(page, 'forward_calls');
    ok(!!it.data.test_started_at, 'Test call uses start_forwarding_test');
    ok(/Waiting for the call/.test(await page.textContent('#saLog .acard--test_call:last-of-type')) || /Waiting for the call/.test(await page.textContent('#saLog')), 'waiting state');
    const n2 = await count(page);
    await page.evaluate(tid => window.StartMock.admin.simulateCall(tid, { forwardedFrom: null }), t.id);
    await idle(page, n2);
    ok((await calls(page)).slice(n2).some(c => c.input.type === 'event' && c.input.event === 'test_changed'), 'the poll reports test_changed');
    ok(await page.$('#saLog #ob_fwdconfirm') !== null && /didn’t say which line forwarded it/.test(await lastText(page)), 'unverified: the self-confirm question and button');
    ok(!/didn’t tell us which line/.test(await page.$$eval('#saLog .acard--test_call', a => a[a.length - 1].textContent)), 'the card does not repeat what the message says');
    await shot(page, 'test-unverified', '#saLog #ob_fwdconfirm');
    await press(page, '#saLog #ob_fwdconfirm');
    it = await item(page, 'forward_calls');
    ok(it.status === 'done' && it.data.verified === 'self_confirmed', 'self-confirm uses confirm_forwarding_test');
    await page.waitForFunction(() => /All required steps are done/.test(document.querySelector('#saLog') ? document.querySelector('#saLog').textContent : ''));
    await sleep(300);
    const cl = (await db(page)).clients[0];
    ok(cl.status === 'testing', 'client in testing (automatic go-live checks)');
    ok(await page.$('#saDone') !== null && /You’re all set/.test(await page.textContent('#saDone')), '"You’re all set" with every step');
    ok((await page.$$eval('[role=tab]', t2 => t2.map(x => x.textContent))).includes('My receptionist'), 'tabs updated (My receptionist) without a reload');
    await shot(page, 'complete', '#saDone');
    // automatic go-live -> the chat notices
    await page.evaluate(() => window.StartMock.admin.runtimeTick());
    await page.waitForFunction(() => /You’re live\. Calls forwarded/.test(document.querySelector('#saLog') ? document.querySelector('#saLog').textContent : ''), null, { timeout: 15000 });
    ok((await db(page)).clients[0].status === 'live', 'live');
    await sleep(300);
    ok(/You’re live/.test(await page.textContent('#saDone')), 'finished card: You’re live');
    await shot(page, 'live', '#saLog > li:last-child');

    // reload resumes the same thread
    const before = await page.$$eval('#saLog > li[data-key]', l => l.length);
    await portal(page, 'onboarding');
    await page.waitForFunction(n => document.querySelectorAll('#saLog > li[data-key]').length >= n, before);
    ok((await page.$$eval('#saLog > li[data-key]', l => l.length)) === before, 'reload: the same thread (' + before + ' messages)');
    // another "device": a new browser context with the same mock db
    const dbNow = await db(page), ss2 = await page.evaluate(() => localStorage.getItem('aplp_mock_session_v1'));
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await ctx2.addInitScript(([d, s]) => { if (!sessionStorage.getItem('x')) { localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)); localStorage.setItem('aplp_mock_session_v1', s); sessionStorage.setItem('x', '1'); } }, [dbNow, ss2]);
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + '/start/?mock=1#onboarding', { waitUntil: 'load' });
    await p2.waitForFunction(n => document.querySelectorAll('#saLog > li[data-key]').length >= n, before);
    ok((await p2.$$eval('#saLog > li[data-key]', l => l.length)) === before, 'another device resumes the same conversation');
    await ctx2.close();

    // after go-live: a change by chat
    await say(page, 'change my hours');
    ok(/let’s update that/.test(await lastText(page)), 'after go-live the chat takes changes');
    await say(page, 'mon-fri 8-5');
    await say(page, 'yes');
    t = await tenant(page);
    ok(t.config.hours.mon.join() === '08:00,17:00' && t.config.hours.sat === null, 'hours changed by chat after go-live');

    // a save the server refuses: failed card + the forms' wording + open_form
    await say(page, 'change my services');
    await say(page, 'Drain cleaning, Leak repair');
    // the stored proposal no longer passes the database rules (as if a rule changed between the card and the confirm)
    await page.evaluate(() => { const x = window.StartMock.admin.db(); const p = x.setup_proposals.filter(o => o.status === 'pending').pop(); p.data.faq = [{ q: '', a: 'no question' }]; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); });
    await press(page, pendingCard + ' [data-card=confirm]');
    ok(await page.$('#saLog section.scard[data-status="failed"]') !== null && /Not saved/.test(await page.textContent('#saLog section.scard[data-status="failed"]')), 'refused save: the card says Not saved');
    ok(/FAQ #1 question \(max 300 characters\) wasn’t accepted/.test(await page.textContent('#saLog')) && await page.$('#saLog .sa-openform[data-openform="faq"]') !== null, 'the error in plain words + a button to the form');
    await shot(page, 'failed-save', '#saLog .sa-openform');
    await page.click('#saLog .sa-openform[data-openform="faq"]');
    await page.waitForSelector('#ob-faq[open]');
    ok(true, 'open_form opens the FAQ step');
    await page.click('[data-saview="chat"]'); await page.waitForSelector('#saLog');

    // keyboard only: tab to a card button and confirm with Enter
    await page.focus('#saText'); await page.keyboard.type('change my services'); let n3 = await count(page); await page.keyboard.press('Enter'); await idle(page, n3);
    await page.keyboard.type('Drain cleaning, Leak repair, Toilet repair'); n3 = await count(page); await page.keyboard.press('Enter'); await idle(page, n3);
    ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.card === 'confirm'), 'keyboard: focus lands on "Looks right"');
    ok(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), 'visible focus ring on the card button');
    n3 = await count(page); await page.keyboard.press('Enter'); await idle(page, n3);
    ok((await tenant(page)).config.booking.job_types.join() === 'Drain cleaning,Leak repair,Toilet repair', 'keyboard-only confirm saved');

    // the 1,000-character limit with a counter near it
    await page.fill('#saText', 'x'.repeat(950));
    ok(/50 characters left/.test(await page.textContent('#saHint')) && await page.$eval('#saText', t => t.maxLength === 1000), '1,000-character limit with a counter near it');
    await page.fill('#saText', '');
    // the on-screen keyboard: a fake visualViewport 300 px shorter keeps the composer and the newest message visible
    await page.setViewportSize({ width: 375, height: 700 });
    await page.evaluate(() => {
      const vv = window.visualViewport, H = window.innerHeight - 300;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => H });
      vv.dispatchEvent(new Event('resize'));
      document.querySelector('#saText').focus();
    });
    await sleep(500);
    const kb = await page.evaluate(() => {
      const c = document.querySelector('#saComposer').getBoundingClientRect(), H = window.visualViewport.height;
      const last = [...document.querySelectorAll('#saLog > li')].pop().getBoundingClientRect();
      return { cb: c.bottom, ct: c.top, H, lb: last.bottom, lt: last.top, kb: getComputedStyle(document.documentElement).getPropertyValue('--sa-kb'), y: scrollY, sh: document.documentElement.scrollHeight, ih: innerHeight, pad: document.querySelector('.sa-kbpad').offsetHeight, act: document.activeElement.id, dis: document.querySelector('#saText').disabled };
    });
    ok(kb.cb <= kb.H + 2 && kb.ct > 0, 'keyboard open: the composer sits above the keyboard (' + JSON.stringify(kb) + ')');
    ok(kb.lb <= kb.ct + 4 && kb.lb > 0, 'keyboard open: the newest message stays in view above the composer (' + JSON.stringify(kb) + ')');
    await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
    await page.setViewportSize({ width: 390, height: 844 });

    // contract: every response so far
    const all = ALL.map(c => ({ input: c.input, turn: c.turn, res: c.res || null, err: c.err || null }));
    const bad = all.filter(c => c.res).map(c => contractErrors(c.res)).filter(e => e.length);
    ok(all.filter(c => c.res).length > 25 && !bad.length, 'every response matches contract v1 (' + all.filter(c => c.res).length + ' responses; ' + JSON.stringify(bad.slice(0, 2)) + ')');
    const breq = all.map(c => schemaErrors({ v: 1, client_turn_id: c.turn, input: c.input }, 'Request')).filter(e => e.length);
    ok(!breq.length, 'every request matches the contract (' + JSON.stringify(breq.slice(0, 2)) + ')');
    const types = new Set(); all.forEach(c => ((c.res || {}).messages || []).forEach(m => (m.blocks || []).forEach(b => types.add(b.type + (b.action ? ':' + b.action : '')))));
    ok(['summary_card', 'choices', 'action:connect_calendar', 'action:forwarding_instructions', 'action:test_call', 'notice', 'open_form'].every(x => types.has(x)), 'every block type was rendered (' + [...types].join(', ') + ')');
    const ids = all.filter(c => c.input.type !== 'resume').map(c => c.turn);
    ok(ids.every(x => typeof x === 'string' && x.length >= 16) && new Set(ids).size === ids.length, 'each turn has its own client_turn_id');

    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, 'no horizontal scroll on the finished chat');
    errs.forEach(e => ok(false, 'console: ' + e));
  } finally { await browser.close(); }
}

// ------------------------------------------------------------------ chromium: failures, offline, flag off, quote clients, real estate
async function failures() {
  const { browser, page, ctx, errs } = await newContext(chromium, 390);
  try {
    console.log('chromium: failures');
    await signUp(page, 'sam@fail.test', 'Sam Reed', 'Reed Electric', '(512) 555-0100');
    // the server is down at the first open: the forms, with a way back
    await portal(page, 'onboarding', '&mock_setup_fail=server_error');
    await page.waitForSelector('.obsteps');
    ok(/isn’t available right now/.test(await page.textContent('#saHead')) && await page.$('#saRetryChat') !== null, 'first open fails: the checklist opens with a notice and "Try the chat again"');
    await shot(page, 'unreachable', '#saHead');
    await page.evaluate(() => window.StartMock.admin.setupFail(''));
    await page.click('#saRetryChat');
    await page.waitForFunction(() => document.querySelectorAll('#saLog .bubble--in').length >= 2);
    ok(true, '"Try the chat again" opens the chat');
    // assistant_unavailable once: "Try again" resends the same client_turn_id
    await page.evaluate(() => window.StartMock.admin.setupFail('assistant_unavailable', 1));
    await say(page, 'Panel upgrades, EV chargers');
    ok(await page.$('#saBanner .sa-banner') !== null && /didn’t get that through/.test(await page.textContent('#saBanner')), 'model failure: "Sorry, I didn’t get that through" banner');
    ok(/Not sent/.test(await page.textContent('#saLog .sa-fail')) && await page.$('#saBanner [data-saretry]') !== null && await page.$('#saBanner [data-openform]') !== null, 'the message is marked Not sent; the banner has Try again and the form');
    await shot(page, 'unavailable', '#saComposer');
    const failedTurn = (await calls(page)).pop().turn;
    await press(page, '#saBanner [data-saretry]');
    const retried = (await calls(page)).pop();
    ok(retried.turn === failedTurn && retried.res && retried.res.status === 'active', 'retry resends the same client_turn_id and gets the answer');
    ok(await page.$(pendingCard) !== null && await page.$('#saLog .sa-fail') === null, 'after the retry: the card, no failure marks');
    ok((await db(page)).setup_messages.filter(m => m.role === 'user').length === 1, 'no duplicate user message on the server');
    // a failed message survives a reload: the server marks it unanswered, "Try again" resends the same client_turn_id
    await page.evaluate(() => window.StartMock.admin.setupFail('assistant_unavailable', 1));
    await say(page, 'Austin, Round Rock');
    const lost = (await calls(page)).pop().turn;
    await portal(page, 'onboarding');
    await page.waitForSelector('#saLog .sa-fail [data-saretry]');
    ok(true, 'after a reload the unanswered message shows "Try again"');
    await press(page, '#saLog .sa-fail [data-saretry]');
    const again = (await calls(page)).pop();
    ok(again.turn === lost && again.res && again.res.status === 'active' && await page.$('#saLog .sa-fail') === null, 'the retry after the reload uses the same client_turn_id');
    await say(page, 'Panel upgrades, EV chargers');
    // two failures in a row -> the form for this step
    await page.evaluate(() => window.StartMock.admin.setupFail('assistant_unavailable', 2));
    await say(page, 'yes');
    await press(page, '#saBanner [data-saretry]');
    await page.waitForSelector('.obsteps');
    ok(/can’t answer right now/.test(await page.textContent('#saHead')) && await page.$eval('#ob-faq', d => d.open), 'two failures in a row: the form opens at the current step');
    await page.evaluate(() => window.StartMock.admin.setupFail(''));
    await page.click('#saRetryChat'); await page.waitForSelector('#saLog'); await sleep(400);
    // budget: typing off with the forms offered; the card buttons keep working (they never call the model)
    await page.evaluate(() => window.StartMock.admin.setupFail('budget'));
    let n = await count(page); await page.fill('#saText', 'yes'); await page.press('#saText', 'Enter'); await idle(page, n);
    ok(/taking a break\. Your answers are saved; finish in the form\./.test(await page.textContent('#saBanner')) && await page.$eval('#saSend', b => b.disabled) && await page.$eval('#saText', t => t.disabled), 'budget: "taking a break", typing off');
    ok(await page.$('#saBanner [data-openform]') !== null && await page.$(pendingCard + ' [data-card=confirm]') !== null && !(await page.$eval(pendingCard + ' [data-card=confirm]', b => b.disabled)), 'budget: the form offered, the card buttons still enabled');
    await shot(page, 'budget', '#saComposer');
    await press(page, pendingCard + ' [data-card=confirm]');
    ok((await item(page, 'faq')).data.services.join() === 'Panel upgrades,EV chargers', 'budget: "Looks right" still saves');
    // limit (fallback) and 429
    await page.evaluate(() => window.StartMock.admin.setupFail('limit'));
    n = await count(page); await page.fill('#saText', 'Austin'); await page.press('#saText', 'Enter'); await idle(page, n);
    ok(/You’ve sent a lot of messages; the form is right here/.test(await page.textContent('#saBanner')) && await page.$eval('#saSend', b => b.disabled) && await page.$('#saBanner [data-openform]') !== null, 'limit: typing off, the form is right here');
    await page.evaluate(() => window.StartMock.admin.setupFail('rate_limited'));
    await portal(page, 'onboarding'); await page.waitForSelector('#saLog'); await sleep(300);
    n = await count(page); await page.fill('#saText', 'yes'); await page.press('#saText', 'Enter'); await idle(page, n);
    ok(/You’ve sent a lot of messages/.test(await page.textContent('#saBanner')) && await page.$eval('#saSend', b => b.disabled), '429: the message, the form button, sending paused');
    await page.evaluate(() => window.StartMock.admin.setupFail(''));
    // offline
    await portal(page, 'onboarding'); await page.waitForSelector('#saLog'); await sleep(300);
    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await sleep(200);
    ok(/You’re offline\. Your answers are saved\./.test(await page.textContent('#saComposer')) && await page.$eval('#saSend', b => b.disabled), 'offline: composer disabled with "Your answers are saved"');
    await shot(page, 'offline', '#saComposer');
    n = await count(page);
    await ctx.setOffline(false);
    await sleep(100);
    if (await count(page) === n) await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await idle(page, n);
    ok((await calls(page)).pop().input.event === 'back_online' && !(await page.$eval('#saSend', b => b.disabled)), 'back online: event back_online, composer enabled');
    // the typing indicator
    await page.evaluate(() => sessionStorage.setItem('start_mock_setup_delay', '2500'));
    await page.fill('#saText', 'yes'); await page.press('#saText', 'Enter');
    await page.waitForSelector('#saTyping');
    ok(/Setup assistant is thinking…/.test(await page.textContent('#saTyping')) && await page.$eval('#saText', t => t.readOnly) && await page.$eval('#saSend', b => b.disabled), 'waiting: typing bubble, composer locked (never a frozen screen)');
    await shot(page, 'typing', '#saTyping');
    await page.waitForFunction(() => !document.querySelector('#saTyping'), null, { timeout: 10000 });
    await page.evaluate(() => sessionStorage.removeItem('start_mock_setup_delay'));
    // disabled (server kill switch): today's checklist
    await page.evaluate(() => window.StartMock.admin.setupFail('disabled'));
    await portal(page, 'onboarding');
    await page.waitForFunction(() => document.querySelector('.obsteps') && document.querySelector('#tab-onboarding').textContent === 'Setup checklist');
    ok(await page.$('#saLog') === null && /Your setup checklist/.test(await page.textContent('#panel')), 'server switch off: exactly today’s checklist');
    await page.evaluate(() => window.StartMock.admin.setupFail(''));
    errs.filter(e => !/Failed to load resource/.test(e)).forEach(e => ok(false, 'console: ' + e));

    // flag off: no chat, no network call
    console.log('chromium: flag off, quote client, real estate');
    brandOn = false;
    await page.evaluate(() => { window.__sa = []; });
    await portal(page, 'onboarding');
    await page.waitForSelector('.obsteps');
    ok(await page.$('#saLog') === null && (await page.textContent('#tab-onboarding')) === 'Setup checklist' && (await calls(page)).length === 0, 'flag off: the checklist as before, no setup-agent call');
    ok(await page.$('.vslot[data-video="onb-welcome"]') !== null, 'flag off: unchanged markup (video slots stay)');
    await portal(page);
    ok(/Setup checklist: \d of 5 steps done/.test(await page.textContent('#panel')), 'flag off: home copy unchanged');
    brandOn = true;
    // quote client (deposit paid): the checklist even with the flag on
    await signUp(page, 'q@quote.test', 'Quinn Q', 'Quote Co', '(713) 555-0111');
    await page.evaluate(() => { const x = window.StartMock.admin.db(); x.clients.forEach(c => { c.billing_mode = 'quote'; }); localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); });
    await portal(page, 'onboarding');
    await page.waitForSelector('.obsteps');
    ok(await page.$('#saLog') === null && /Your setup checklist/.test(await page.textContent('#panel')), 'quote client: the checklist with the flag on');
    // real estate: the services card is pre-filled from the product defaults
    await signUp(page, 'jenna@realty.test', 'Jenna Harper', 'Harper Realty', '(713) 555-0122', 'real_estate');
    await page.evaluate(() => { const x = window.StartMock.admin.db(); const q = x.tenants[0]; q.config.business.niche = 'real_estate'; q.config.booking.job_types = ['Buyer consultation', 'Listing consultation', 'Home showing']; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); });
    await portal(page, 'onboarding');
    await page.waitForSelector(pendingCard);
    ok(/Buyer consultation/.test(await page.textContent(pendingCard)) && /Keep these\?/.test(await lastText(page)), 'real estate: pre-filled services card');
    await say(page, 'yes');
    ok(/buyers, sellers, renters, investors/.test(await lastText(page)), 'real estate: lead types next');
    await shot(page, 'real-estate', pendingCard);
  } finally { await browser.close(); }
}

// ------------------------------------------------------------------ webkit + firefox: short journey + overflow everywhere
async function shortJourney(name, type) {
  const { browser, page, errs } = await newContext(type, 375);
  try {
    console.log(name + ': short journey + overflow');
    await signUp(page, name + '@engines.test', 'Avery Longfamilyname-Hyphenated', 'A Very Long Business Name Heating Cooling & Plumbing LLC', '(713) 555-0100');
    await portal(page, 'onboarding');
    await page.waitForFunction(() => document.querySelectorAll('#saLog .bubble--in').length >= 2);
    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, name + ': first open, no horizontal scroll');
    await say(page, 'Supercalifragilisticexpialidocious emergency furnace repair and replacement, Duct cleaning, Thermostat installation and smart-home integration');
    ok(await page.$(pendingCard) !== null, name + ': card');
    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, name + ': long card, no horizontal scroll');
    await say(page, 'yes');
    await say(page, 'skip');
    await say(page, 'mon-fri 7 to 6, saturday 8-12');
    await say(page, 'actually friday we close at 4');
    ok((await page.$$eval('#saLog section.scard', s => s.map(x => x.dataset.status))).slice(-2).join() === 'superseded,pending', name + ': correction replaces the card');
    await press(page, pendingCard + ' [data-card=confirm]');
    ok((await tenant(page)).config.hours.fri.join() === '07:00,16:00', name + ': corrected hours saved');
    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, name + ': choices, no horizontal scroll');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');
    await say(page, 'no');
    await say(page, 'Do you work weekends? Yes, Saturday mornings.');
    await say(page, 'yes');
    await page.click('#saQuick .chip'); await sleep(700);
    await say(page, 'no'); await say(page, 'use those'); await press(page, pendingCard + ' [data-card=confirm]');
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(3)');   // messages only
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(1)');   // tools: skip
    await press(page, '#saQuick .chip:nth-child(1)');                    // the business number: yes
    await page.evaluate(() => window.StartMock.admin.runtimeTick());
    await press(page, '#saLog .sa-chips.sa-live .chip:nth-child(2)');   // AT&T (long instructions)
    ok(/Forwarding for AT&T/.test(await page.textContent('#saLog')), name + ': AT&T instructions');
    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, name + ': forwarding + test card, no horizontal scroll');
    await page.selectOption('#saLog #sa_car', 'zoom'); await sleep(150);
    ok(/Forwarding for Zoom Phone/.test(await page.textContent('#saLog .acard--forwarding_instructions')), name + ': provider picker redraws the instructions');
    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, name + ': longest VoIP instructions, no horizontal scroll');
    const before = await page.$$eval('#saLog > li[data-key]', l => l.length);
    await portal(page, 'onboarding');
    await page.waitForFunction(n => document.querySelectorAll('#saLog > li[data-key]').length >= n, before);
    ok((await page.$$eval('#saLog > li[data-key]', l => l.length)) === before, name + ': reload resumes');
    await page.click('#saManual'); await page.waitForSelector('.obsteps');
    ok((await overflowAt(page, [320, 375, 390, 414, 768, 1280])).length === 0, name + ': manual view, no horizontal scroll');
    errs.forEach(e => ok(false, name + ' console: ' + e));
  } finally { await browser.close(); }
}

try {
  await journey();
  await failures();
  for (const [n, t] of [['webkit', webkit], ['firefox', firefox]]) await shortJourney(n, t);
} catch (e) { console.log('  ERROR ' + (e && e.stack || e)); failN++; }
finally { server.close(); }
console.log(`setup assistant e2e: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
