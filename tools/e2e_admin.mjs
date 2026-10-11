// E2E for the owner admin (/start/admin/, Hebrew RTL) against the MOCK backend. Puppeteer + local Chrome.
// Covers: access control (non-admin redirected, API refuses), digest, every tab, quote editing only via price-book codes,
// FOUNDING, manual pricing gate, approve-and-send (approved -> sent + quote_sent stub), freeze after send, clients,
// payments, retainer queue (one active), notes never reach the client, events, settings read-only, RTL money isolation,
// overflow at 375/390/414/1280, keyboard tabs, zero console errors.
//   node tools/e2e_admin.mjs           (own static server on E2E_PORT, default 8941)
//   E2E_BASE=http://localhost:8787 node tools/e2e_admin.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';
import * as SERVER from '../supabase/functions/_shared/pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8941);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
let server = null;
function serve() {
  return new Promise(res => {
    server = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const full = path.normalize(path.join(SITE, p));
      if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(full).pipe(rsp);
    }).listen(PORT, '127.0.0.1', res);
  });
}
const BASE = process.env.E2E_BASE || `http://localhost:${PORT}`;
const pb = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/pricebook.json'), 'utf8'));
const brand = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));
const item = c => pb.items.find(i => i.code === c);
const usd = c => '$' + (c / 100).toLocaleString('en-US');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const consoleErrors = [];
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', r => /fonts\.(googleapis|gstatic)\.com/.test(r.url()) ? r.respond({ status: 200, contentType: 'text/css', body: '' }) : r.continue());
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('uncaught: ' + e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const body = page => page.evaluate(() => document.body.innerText);
const waitText = (page, needle, timeout = 5000) => page.waitForFunction(n => document.body.innerText.includes(n), { timeout }, needle).then(() => true).catch(() => false);
const db = page => page.evaluate(() => window.StartMock.admin.db());
async function overflow(page) {
  const bad = [];
  for (const w of [375, 390, 414, 1280]) {
    await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 }); await sleep(60);
    const d = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (d > 0) bad.push(w + ':' + d);
  }
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  return bad;
}
async function signIn(page, url, email) {
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForSelector('#email');
  await page.type('#email', email);
  await page.click('#sendBtn');
  await page.waitForSelector('#mockCode');
  const code = (await page.$eval('#mockCode', e => e.textContent)).trim();
  await page.type('#code', code);
  if (url.indexOf('admin') !== -1) await page.click('#verifyBtn');
}
// hash-only goto does not reload: force a fresh load so the page re-reads the mock DB
async function nav(page, url) { await page.goto(BASE + url, { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); }
async function openTab(page, id) { await page.click('#tab-' + id); await sleep(120); }
async function openRow(page, needle) {
  const ids = await page.$$eval('#alist [data-id]', (bs, n) => bs.filter(b => b.innerText.includes(n)).map(b => b.dataset.id), needle);
  if (!ids.length) return null;
  await page.click('#alist [data-id="' + ids[0] + '"]'); await sleep(200);
  return ids[0];
}

async function main() {
  if (!process.env.E2E_BASE) await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await newPage(browser);
    // ------------------------------------------------------------ access control
    console.log('access');
    await page.goto(BASE + '/start/admin/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#email');
    ok(await page.evaluate(() => document.documentElement.lang === 'he' && document.documentElement.dir === 'rtl'), 'admin page is lang=he dir=rtl');
    ok(/כניסה לניהול/.test(await body(page)), 'signed out → Hebrew sign-in screen');
    ok(await page.$('#mockBanner') !== null, 'mock banner shown');
    // a client signs in on /start/, then opens the admin URL
    await signIn(page, '/start/', 'dani@coolbreeze.test');
    await page.waitForFunction(() => !document.querySelector('#codeForm'), { timeout: 5000 });
    await page.goto(BASE + '/start/admin/', { waitUntil: 'load' });
    await page.waitForFunction(() => location.pathname === '/start/', { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => location.pathname) === '/start/', 'non-admin is redirected to /start/');
    const denied = await page.evaluate(() => window.StartMock.create(window.SITE_CONFIG).adminListQuotes().then(() => 'ok', e => e.message));
    ok(denied === 'not_admin', 'admin API refuses a non-admin (RLS-style)');
    await page.evaluate(() => window.Backend.signOut());
    // ------------------------------------------------------------ admin sign-in + seed
    console.log('admin');
    await signIn(page, '/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
    await page.waitForSelector('#digest', { timeout: 5000 });
    ok(true, 'admin signs in with the email code');
    await page.click('#seedBtn'); await sleep(400);
    await page.waitForSelector('#alist');
    ok(/תקציר יומי/.test(await body(page)), 'daily digest card shown');
    const tiles = await page.$$eval('#digest [data-go] b', bs => bs.map(b => b.textContent.trim()));
    ok(tiles[2] === '1' && tiles[3] === '1', 'digest: 1 draft to approve, 1 needs manual price');
    ok(tiles[0] === '1', 'digest: 1 new lead in 24 h that has not started');
    ok(await page.$$eval('[role=tab]', t => t.length) === 8, '8 tabs (leads, questionnaires, quotes, clients, retainer, tenants, events, settings)');
    // keyboard: RTL arrows
    await page.focus('#tab-quotes'); await page.keyboard.press('ArrowLeft'); await sleep(150);
    ok(await page.evaluate(() => document.activeElement.id === 'tab-clients' && document.querySelector('#tab-clients').getAttribute('aria-selected') === 'true'), 'ArrowLeft moves to the next tab (RTL) and selects it');
    await page.keyboard.press('Home'); await sleep(150);
    ok(await page.evaluate(() => document.activeElement.id === 'tab-leads'), 'Home → first tab');
    // ------------------------------------------------------------ leads
    ok(await page.$$eval('#leadList > li', l => l.length) === 2, 'leads: 2 that did not start a questionnaire');
    await page.click('#fOnly'); await sleep(100);
    ok(await page.$$eval('#leadList > li', l => l.length) === 3, 'leads: 3 with the filter off');
    // ------------------------------------------------------------ questionnaires
    await openTab(page, 'questionnaires');
    await page.evaluate(() => { const d = window.StartMock.admin.db(); const p = d.profiles.find(x => x.email === 'tom@austinplumb.test'); p.full_name = '<img src=x onerror="window.__x=1">'; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#alist [data-id]');
    await openRow(page, 'Austin Plumbing');
    ok(await page.evaluate(() => !window.__x && document.querySelector('#detail').innerText.includes('<img')), 'HTML injection in client data is rendered as text');
    ok(/ServiceTitan/.test(await page.$eval('#detail', d => d.innerText)), 'questionnaire answers shown');
    ok(await page.$('#copyMd') !== null, '"copy to Claude" button');
    // ------------------------------------------------------------ parity: admin (browser, /assets/pricing.mjs) vs server module
    const CASES = [
      ['RCP+CRM', [{ code: 'RCP' }, { code: 'ADD-CRM' }], null, false],
      ['RCP+RUSH+FOUNDING', [{ code: 'RCP' }, { code: 'ADD-ES' }, { code: 'ADD-RUSH' }], 'FOUNDING', false],
      ['BNDL+ADD-CHAT', [{ code: 'BNDL' }, { code: 'ADD-CHAT' }], null, false],
      ['duplicate code', [{ code: 'RCP' }, { code: 'ADD-CRM' }, { code: 'ADD-CRM' }], null, false],
      ['qty 11', [{ code: 'RCP' }, { code: 'ADD-LOC', qty: 11 }], null, false],
      ['MAP manual approved', [{ code: 'MAP', manual_setup_cents: 150000, manual_monthly_cents: 0 }], null, true],
      ['MAP not approved', [{ code: 'MAP', manual_setup_cents: 150000, manual_monthly_cents: 0 }], null, false],
      ['AUTO manual approved', [{ code: 'RCP' }, { code: 'AUTO', manual_setup_cents: 400000, manual_monthly_cents: 50000 }], null, true],
      ['CUSTOM priced', [{ code: 'RCP' }, { code: 'CUSTOM', label: 'ServiceTitan integration', manual_setup_cents: 250000, manual_monthly_cents: 7500 }], null, true],
      ['WEB+ADD-CRM', [{ code: 'WEB' }, { code: 'ADD-CRM' }], null, false],
      ['over threshold', [{ code: 'BNDL' }, { code: 'ADD-LOC', qty: 3 }, { code: 'ADD-CRM', qty: 2 }, { code: 'ADD-RUSH' }], null, false],
      ['retainer only', [{ code: 'RET-CARE' }], null, true]
    ];
    let same = 0;
    for (const [name, lines, disc, appr] of CASES) {
      const a = await page.evaluate((l, d, ap) => { const c = window.AdminCalc(l, d, ap); return { s: c.r.setup_cents, m: c.r.monthly_cents, dep: c.r.deposit_cents, e: c.errors, send: c.sendable }; }, lines, disc, appr);
      const v = SERVER.validateItems(pb, lines, { discount_code: disc, manual_approved: appr });
      const ok1 = a.s === v.totals.setup_cents && a.m === v.totals.monthly_cents && a.dep === v.totals.deposit_cents &&
        JSON.stringify(a.e) === JSON.stringify(v.errors) && a.send === v.ok;
      if (ok1) same++; else console.log('  parity diff ' + name, JSON.stringify(a), JSON.stringify({ t: v.totals, e: v.errors, ok: v.ok }));
    }
    const later = await page.evaluate(() => { const l = [{ code: 'MAP', manual_setup_cents: 150000, manual_monthly_cents: 0 }]; return [window.AdminCalc(l, null, false).sendable, window.AdminCalc(l, null, true).sendable]; });
    ok(later[0] === false && later[1] === true, '"later" offer (MAP) needs manual approval, then it is sendable');
    ok(same === CASES.length, 'admin pricing == server pricing on ' + CASES.length + ' cases (' + same + ' equal)');
    ok(fs.readFileSync(path.join(SITE, 'assets/pricing.mjs'), 'utf8') === fs.readFileSync(path.resolve(HERE, '../supabase/functions/_shared/pricing.mjs'), 'utf8'), 'site/assets/pricing.mjs is a byte copy of the server module');
    ok(!fs.existsSync(path.join(SITE, 'start/assets/admin-pricing.js')), 'no separate admin pricing implementation');
    // ------------------------------------------------------------ quote draft: codes only
    console.log('quotes');
    await openTab(page, 'quotes');
    const q1 = await openRow(page, 'Cool Breeze');
    const exp1 = item('RCP').setup_cents + item('ADD-CRM').setup_cents;
    const tot = () => page.$eval('#totals', t => t.innerText);
    ok((await tot()).includes(usd(exp1)) && (await tot()).includes(usd(item('RCP').monthly_cents + item('ADD-CRM').monthly_cents)), 'draft totals computed from the price book');
    ok(await page.$$eval('[data-ms],[data-mm]', x => x.length) === 0, 'no free amount inputs on fixed-price lines');
    ok(await page.$$eval('#detail .num', ns => ns.every(n => n.getAttribute('dir') === 'ltr')), '$ amounts isolated with dir=ltr');
    await page.select('#addCode', 'ADD-ES'); await page.click('#addBtn'); await sleep(150);
    const exp2 = exp1 + item('ADD-ES').setup_cents;
    ok((await tot()).includes(usd(exp2)), 'adding a code updates the total live');
    ok(!(await page.$$eval('#addCode option', o => o.map(x => x.value))).includes('ADD-PAGE'), 'WEB-only add-ons are not offered on an RCP quote');
    ok(await page.$eval('label:has(#founding) bdi', b => b.getAttribute('dir') === 'ltr' && b.textContent === '(FOUNDING)'), 'FOUNDING label isolated in a ltr bdi');
    await page.click('#founding'); await sleep(100);
    const disc = Math.round(exp2 * pb.rules.discounts.FOUNDING.setup_pct / 100 / 100) * 100;
    ok((await tot()).includes(usd(exp2 - disc)), 'FOUNDING takes ' + pb.rules.discounts.FOUNDING.setup_pct + '% off setup');
    ok((await tot()).includes(usd(item('RCP').monthly_cents + item('ADD-CRM').monthly_cents + item('ADD-ES').monthly_cents)), 'monthly is never discounted');
    await page.$eval('#scope', t => { t.value = 'Edited scope for Cool Breeze.'; });
    await page.click('#saveBtn'); await sleep(300);
    let d1 = (await db(page)).quotes.find(q => q.id === q1);
    ok(d1.setup_cents === exp2 - disc && d1.discount_code === 'FOUNDING' && d1.items.length === 3 && d1.scope_md.startsWith('Edited'), 'save draft stores items, totals, discount and text');
    ok(d1.items.every(i => 'unit_setup_cents' in i && 'unit_monthly_cents' in i && i.setup_cents === i.unit_setup_cents * i.qty), 'items stored in the A6 shape (line totals + unit_*)');
    ok((await db(page)).events.some(e => e.entity_id === q1 && e.type === 'admin_edit'), 'edit logged in events');
    const free = await page.evaluate(id => window.StartMock.create(window.SITE_CONFIG).adminSaveQuote(id, { pay_link: 'http://insecure.test' }).then(() => 'ok', e => e.message), q1);
    ok(free === 'pay_link_https', 'pay link must be https');
    // approve and send
    await page.type('#payLink', 'https://www.paypal.com/invoice/test');
    await page.click('#sendBtn'); await sleep(500);
    d1 = (await db(page)).quotes.find(q => q.id === q1);
    ok(d1.status === 'sent' && !!d1.sent_at && !!d1.valid_until, 'approve-and-send: status sent, sent_at + valid_until set');
    const evs = (await db(page)).events.filter(e => e.entity_id === q1 && e.type === 'status_changed').map(e => e.payload.to);
    ok(evs.includes('approved') && evs.includes('sent'), 'events: draft → approved → sent');
    const mail = (await db(page)).outbox.find(m => m.template === 'quote_sent' && m.quote_id === q1);
    ok(!!mail && mail.to === 'dani@coolbreeze.test' && mail.subject.includes(usd(d1.setup_cents)) && mail.subject.includes(brand.name), 'quote_sent e-mail stub to the client with amounts + brand');
    ok((await db(page)).questionnaires.find(q => q.id === d1.questionnaire_id).status === 'quoted', 'questionnaire moves to quoted');
    // frozen
    await nav(page, '/start/admin/#quotes/' + q1); await page.waitForSelector('#detail .lines');
    ok(await page.$('#addCode') === null && await page.$('#sendBtn') === null, 'sent quote is read-only in the UI');
    ok(await page.$('a[href^="/quote/?t="]') !== null, 'link to the client quote page');
    const frozen = await page.evaluate(id => window.StartMock.create(window.SITE_CONFIG).adminSaveQuote(id, { setup_cents: 1 }).then(() => 'ok', e => e.message), q1);
    ok(frozen === 'quote_frozen_after_send', 'amounts frozen after send (API)');
    // manual price
    await nav(page, '/start/admin/#quotes'); await page.waitForSelector('#alist [data-id]');
    const q2 = await openRow(page, 'Austin Plumbing');
    ok(await page.$$eval('[data-ms]', x => x.length) === 1, 'manual price input only on the custom line');
    const early = await page.evaluate(id => window.StartMock.create(window.SITE_CONFIG).quoteSend(id, { manual_approved: true }).then(() => 'ok', e => e.message), q2);
    ok(early === 'needs_manual_price', 'quoteSend refuses needs_manual_price with no price (API, even with manual_approved)');
    await page.waitForSelector('#reviewBox .review', { timeout: 3000 }).catch(() => {});
    const rv = await page.$eval('#reviewBox', b => b.innerText).catch(() => '');
    ok(rv.includes('Which ServiceTitan plan') && rv.includes('guarantee'), 'quote_reviews panel: risk flags, questions, removed text');
    await page.click('#sendBtn'); await sleep(200);
    ok(/חסר מחיר ידני/.test(await page.$eval('#eMsg', e => e.innerText)), 'UI blocks send while a manual price is missing');
    await page.type('[data-ms]', '2500'); await page.$eval('[data-mm]', i => { i.value = '75'; i.dispatchEvent(new Event('input')); });
    ok(await page.$('#manualOk') === null, 'custom line with both prices = priced (same as server): no extra confirmation');
    await page.click('#sendBtn'); await sleep(500);
    const d2 = (await db(page)).quotes.find(q => q.id === q2);
    ok(d2.status === 'sent' && d2.setup_cents === item('RCP').setup_cents + item('ADD-LOC').setup_cents + 250000, 'manual price entered → sent with the right total');
    // anonymized quote: read-only, cannot be edited or sent
    const amyQ = (await db(page)).questionnaires.find(q => q.niche === 'real_estate' && q.status !== 'draft');
    const regen = await page.evaluate(id => window.StartMock.create(window.SITE_CONFIG).adminRegenerateDraft(id, window.ADMIN_PB).then(r => r.status, e => e.message), amyQ.id);
    ok(regen === 'draft', 'regenerate draft (mock quote-draft) creates a new draft quote');
    // FOUNDING cap: enforced by quote-send (server/mock); the admin only warns and shows the server error
    await page.evaluate(id => { const d = window.StartMock.admin.db(); d.quotes.find(x => x.id === id).discount_code = 'FOUNDING'; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)); }, q2);
    const amyDraft = (await db(page)).quotes.find(q => q.status === 'draft');
    await nav(page, '/start/admin/#quotes/' + amyDraft.id); await page.waitForSelector('#founding');
    ok(/התקרה של/.test(await page.$eval('#detail', d => d.innerText)), 'FOUNDING cap reached → warning in the editor');
    await page.click('#founding'); await page.click('#sendBtn'); await sleep(500);
    ok(/תקרת הלקוחות המייסדים/.test(await page.$eval('#eMsg', e => e.innerText)) && (await db(page)).quotes.find(q => q.id === amyDraft.id).status !== 'sent', 'server refuses FOUNDING over the cap (founding_limit_reached) and the admin shows it');
    const qa = (await db(page)).quotes.find(q => q.status === 'needs_manual_price' || q.status === 'draft');
    if (qa) {
      await page.evaluate(id => { const d = window.StartMock.admin.db(); d.quotes.find(x => x.id === id).anonymized = true; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)); }, qa.id);
      const r1 = await page.evaluate(id => { const m = window.StartMock.create(window.SITE_CONFIG); return Promise.all([m.quoteSend(id, { manual_approved: true }).then(() => 'ok', e => e.message), m.adminSaveQuote(id, { scope_md: 'x' }).then(() => 'ok', e => e.message)]); }, qa.id);
      ok(r1[0] === 'quote_anonymized' && r1[1] === 'quote_anonymized', 'anonymized quote: send and edit refused (API)');
      await nav(page, '/start/admin/#quotes/' + qa.id); await page.waitForSelector('#detail h2');
      ok(await page.$('#sendBtn') === null && await page.$('#addCode') === null && /אנונימיזציה/.test(await page.$eval('#detail', d => d.innerText)), 'anonymized quote is read-only in the UI');
    } else ok(true, 'anonymized check skipped (no open quote left)');
    // ------------------------------------------------------------ client from accepted quote
    console.log('clients');
    const q3 = (await db(page)).quotes.find(q => q.status === 'sent' && q.pay_link === 'https://www.paypal.com/invoice/demo').id;
    await page.evaluate(id => { const d = window.StartMock.admin.db(); const q = d.quotes.find(x => x.id === id); q.status = 'accepted'; q.accepted_at = new Date().toISOString(); q.accepted_name = 'Amy Carter'; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)); }, q3);
    await nav(page, '/start/admin/#quotes/' + q3); await page.waitForSelector('#mkClient');
    await page.click('#mkClient'); await sleep(500);
    const c3 = (await db(page)).clients.find(c => c.quote_id === q3);
    ok(!!c3 && c3.status === 'onboarding', 'accepted quote → client card created');
    ok(await page.evaluate(() => location.hash.startsWith('#clients/')), 'jumps to the new client');
    await page.type('input[id^="ref-"]', 'PP-123'); await page.click('[data-pay]'); await sleep(400);
    const dep = (await db(page)).payments.find(p => p.client_id === c3.id && p.kind === 'deposit');
    ok(dep.status === 'paid' && dep.reference === 'PP-123', 'mark deposit paid with a reference');
    ok((await db(page)).outbox.some(m => m.template === 'deposit_received' && m.to === 'amy@lonestarhomes.test'), 'deposit_received e-mail stub');
    // live client: tenant summary + checklist
    await openTab(page, 'clients');
    await openRow(page, 'Bright Air');
    const det = await page.$eval('#detail', d => d.innerText);
    ok(det.includes('5 מתוך 7'), 'onboarding checklist progress');
    await page.waitForFunction(() => document.querySelector('#tenantBox').innerText.includes('bright-air'), { timeout: 3000 }).catch(() => {});
    const tb = await page.$eval('#tenantBox', d => d.innerText);
    ok(tb.includes('bright-air') && tb.includes('212 / ' + pb.rules.included_usage.voice_minutes), 'tenant config summary + usage from runtime_state');
    await page.select('#cSt', 'paused'); await page.click('#cStSave'); await sleep(400);
    ok((await db(page)).clients.find(c => c.business_name === 'Bright Air Heating & Cooling').status === 'paused', 'client status saved');
    // internal note never reaches the client
    await page.type('#notes', 'SECRET-NOTE-xyz'); await page.click('#notesSave'); await sleep(300);
    ok((await db(page)).admin_notes.some(n => n.body === 'SECRET-NOTE-xyz'), 'internal note saved (admin_notes)');
    // ------------------------------------------------------------ retainer queue
    console.log('requests');
    await openTab(page, 'requests');
    const reqs = (await db(page)).requests;
    const queued = reqs.find(r => r.status === 'queued'), active = reqs.find(r => r.status === 'active');
    await page.select('#rs-' + queued.id, 'active'); await page.click('[data-rsave="' + queued.id + '"]'); await sleep(300);
    ok((await db(page)).requests.find(r => r.id === queued.id).status === 'queued', 'second active request refused');
    ok(/כבר יש בקשה פעילה/.test(await page.$eval('#toast', t => t.innerText)), 'Hebrew error for one-active rule');
    await page.select('#rs-' + active.id, 'done'); await page.type('#ra-' + active.id, 'Added the filter question.'); await page.click('[data-rsave="' + active.id + '"]'); await sleep(300);
    await page.select('#rs-' + queued.id, 'active'); await page.click('[data-rsave="' + queued.id + '"]'); await sleep(300);
    const r2 = (await db(page)).requests;
    ok(r2.find(r => r.id === active.id).status === 'done' && r2.find(r => r.id === queued.id).status === 'active', 'queue: done → next becomes active');
    ok((await db(page)).outbox.filter(m => m.template === 'request_update').length >= 2, 'request_update e-mail stubs');
    // ------------------------------------------------------------ tenants, events, settings
    await openTab(page, 'tenants');
    await page.waitForSelector('#tuBody', { timeout: 3000 }).catch(() => {});
    ok(await page.$('#tuBody') !== null && await page.$('#alist') !== null, 'tenants tab (B7): usage table + tenant list');
    await openTab(page, 'events');
    ok(await page.$$eval('#evList li', l => l.length) > 10, 'events log lists actions');
    ok(!/: email_requested|: admin_edit|: status_changed/.test(await page.$eval('#evList', l => l.innerText)), 'every event type shown in Hebrew (incl. email_requested)');
    await openTab(page, 'settings');
    const st = await page.$eval('#panel', p => p.innerText);
    ok(st.includes('config/brand.json') && st.includes('show_founder_price') && st.includes('כבוי'), 'settings: flags read-only with the brand.json note');
    ok(st.includes('כללי החזרים') && st.includes(pb.refund_rules.deposit.refund_pct + '% החזר') && st.includes('אין חיוב אוטומטי על חריגה'), 'settings: refund rules + overage policy from config');
    ok(await page.$$eval('#panel input, #panel select, #panel textarea', x => x.length) === 0, 'settings has no editable controls');
    ok((await page.$$eval('#outbox li', l => l.length)) > 0, 'mock mailbox shows the e-mail stubs');
    // digest: collapsed on phones, open on desktop
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await nav(page, '/start/admin/#leads'); await page.waitForSelector('#digestDet');
    ok(await page.$eval('#digestDet', d => !d.open), 'digest collapsed at 390');
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 }); await nav(page, '/start/admin/#leads'); await page.waitForSelector('#digestDet');
    ok(await page.$eval('#digestDet', d => d.open), 'digest open at 1280');
    // ------------------------------------------------------------ overflow on every tab (with a detail open)
    console.log('overflow');
    const routes = ['#leads', '#questionnaires', '#quotes', '#clients', '#requests', '#tenants', '#events', '#settings'];
    const anyQ = (await db(page)).quotes.find(q => q.status === 'needs_manual_price' || q.status === 'draft');
    const anyC = (await db(page)).clients[0];
    const anyQn = (await db(page)).questionnaires[0];
    routes.push('#quotes/' + q1, '#clients/' + anyC.id, '#questionnaires/' + anyQn.id);
    if (anyQ) routes.push('#quotes/' + anyQ.id);
    const bad = [];
    for (const r of routes) {
      await nav(page, '/start/admin/' + r); await page.waitForSelector('#panel'); await sleep(200);
      const o = await overflow(page); if (o.length) bad.push(r + ' ' + o.join(','));
    }
    ok(bad.length === 0, 'no horizontal overflow at 375/390/414/1280 (' + bad.join(' | ') + ')');
    // the client never sees the internal note
    await page.click('#logoutBtn'); await sleep(300);
    await signIn(page, '/start/', 'ray@brightair.test');
    await page.waitForSelector('[role=tablist]', { timeout: 5000 }).catch(() => {});
    ok(!(await body(page)).includes('SECRET-NOTE'), 'internal note not shown in the client portal');
    ok(!JSON.stringify(await page.evaluate(() => Promise.all([window.Backend.listQuotes(), window.Backend.getClient(), window.Backend.listPayments()]))).includes('SECRET-NOTE'), 'internal note not in any client API response');
    await page.close();
  } finally {
    await browser.close();
    if (server) server.close();
  }
  // static checks
  const css = fs.readFileSync(path.join(SITE, 'start/assets/admin.css'), 'utf8') + fs.readFileSync(path.join(SITE, 'start/admin/index.html'), 'utf8');
  ok(!/-9999px/.test(css) && /overflow-x:clip/.test(css), 'no -9999px; html overflow-x:clip');
  ok(consoleErrors.length === 0, 'no console errors (' + consoleErrors.slice(0, 3).join(' | ') + ')');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); if (server) server.close(); process.exit(1); });
