// E2E for the portal "Results" tab (appointment manager, 2026-10-23) against the MOCK backend: tab only for receptionist
// clients with a tenant, month numbers + "vs. last month", estimated value after entering the average job value
// (range checked), "Worth calling back" (message + job type, no booking since; one per number), booking statuses
// (Booked / Moved / Confirmed by customer), No-show only for started visits + undo, other tenants refused, no texting
// claims in the panel, keyboard reachable controls, overflow 375/390/414/1280, no console errors.
//   node tools/e2e_appointments.mjs        (own static server on E2E_PORT, default 8962)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8962);
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
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
const body = page => page.evaluate(() => document.querySelector('#panel').innerText);
const db = page => page.evaluate(() => window.StartMock.admin.db());
async function overflow(page) {
  const bad = [];
  for (const w of [375, 390, 414, 1280]) {
    await page.setViewport({ width: w, height: 844 }); await sleep(60);
    const d = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (d > 0) bad.push(w + ':' + d);
  }
  await page.setViewport({ width: 390, height: 844 });
  return bad;
}
async function signIn(page, email, company) {
  await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
  await page.waitForSelector('#email');
  await page.type('#email', email); await page.click('#sendBtn');
  await page.waitForSelector('#mockCode');
  const code = await page.$eval('#mockCode', e => e.textContent);
  await page.type('#code', code);
  await page.waitForFunction(() => !document.querySelector('#codeForm'), { timeout: 5000 });
  await page.waitForSelector('#profileForm');
  await page.type('#p_full_name', 'Dani Levi'); await page.type('#p_company', company); await page.type('#p_phone', '(713) 555-0100');
  await page.type('#p_city', 'Houston'); await page.select('#p_state', 'TX'); await page.click('#pSave');
  await page.waitForSelector('[role=tablist]');
}
async function openResults(page, r) {
  await page.goto(BASE + '/start/?r=' + r + '#results', { waitUntil: 'load' });
  await page.waitForSelector('#rsCalls', { timeout: 8000 });
}

async function main() {
  await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateTimezone('America/Chicago');
    await page.setRequestInterception(true);
    page.on('request', r => /fonts\.(googleapis|gstatic)\.com/.test(r.url()) ? r.respond({ status: 200, contentType: 'text/css', body: '' }) : r.continue());
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('uncaught: ' + e.message));
    page.on('dialog', d => d.accept());

    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    await signIn(page, 'dani@appt.test', 'Cool Breeze HVAC');
    // deposit paid, no tenant yet: no Results tab
    await page.goto(BASE + '/start/?mock_seed=deposit_paid', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok(!(await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).includes('Results'), 'no tenant: no Results tab');
    // testing + tenant + demo data
    await page.goto(BASE + '/start/?mock_seed=testing', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    const tenant = await page.evaluate(() => window.StartMock.admin.seedTenant());
    await page.evaluate(() => window.StartMock.admin.seedResults());
    await openResults(page, 1);
    const tabs = await page.$$eval('[role=tab]', t => t.map(x => x.textContent));
    ok(tabs.join() === 'Home,Setup checklist,My receptionist,Results,Requests,Quotes,Billing', 'Results tab after My receptionist (' + tabs.join() + ')');
    ok(await page.$eval('#tab-results', t => t.getAttribute('aria-selected')) === 'true', 'deep link #results opens the tab');
    // numbers (seedTenant: 1 booked call + 1 message; seedResults: 2 messages with job types, 1 moved booking, 1 past visit)
    const txt = await body(page);
    const num = id => page.$eval('#' + id + ' .rs__v', e => e.textContent);
    ok(await num('rsCalls') === '4', 'calls answered = 4 (' + await num('rsCalls') + ')');
    // bookings made this month: Maria (seedTenant) + Tess (original, moved: counted once) + Sam = 3
    ok(await num('rsBooked') === '3', 'booked = 3, a moved visit counted once (' + await num('rsBooked') + ')');
    ok(/vs\. last month/.test(txt), 'month-over-month shown');
    ok(/Confirmed by customer/.test(txt) && /Moved \/ cancelled/.test(txt) && /No-shows/.test(txt), 'appointment numbers shown');
    ok(/Enter your average job value/.test(txt), 'no average job value yet: hint, no dollar value');
    ok(!/\btext(s|ing)?\b|\bSMS\b/i.test(txt), 'no texting claims in the Results panel');
    // worth calling back: the two message calls with a job type; the seedTenant message call has no job type
    const back = await page.$$eval('#rsBack li', ls => ls.map(l => l.innerText));
    ok(back.length === 2 && /AC repair/.test(back[0]) && /Maintenance/.test(back[1]), 'worth calling back: 2 calls, newest first (' + back.length + ')');
    ok(await page.$$eval('#rsBack a[href^="tel:+1"]', a => a.length) === 2, 'call-back numbers are tap-to-call links');
    // booking statuses
    ok(/Moved/.test(txt) && /Confirmed by customer/.test(await page.$eval('#rsBookings', e => e.innerText)), 'booking statuses: Moved + Confirmed by customer');
    const noShowBtns = await page.$$('[data-noshow]');
    ok(noShowBtns.length === 1, 'No-show button only for the started visit (' + noShowBtns.length + ')');
    ok((await overflow(page)).length === 0, 'Results: no overflow 375/390/414/1280');

    // average job value: range check, then the estimated value
    await page.$eval('#rsAvg', e => { e.value = '0'; }); await page.click('#rsAvgForm button[type=submit]'); await sleep(150);
    ok(/between 1 and 100,000/.test(await page.$eval('#rsAvgMsg', e => e.innerText)), 'average job value: 0 refused');
    await page.$eval('#rsAvg', e => { e.value = '350'; }); await page.click('#rsAvgForm button[type=submit]');
    await page.waitForFunction(() => /\$1,050/.test(document.querySelector('#rsValue').innerText), { timeout: 5000 }).catch(() => null);
    ok(/\$1,050 estimated value/.test(await page.$eval('#rsValue', e => e.innerText)), 'estimated value = 3 x $350');
    ok((await db(page)).runtime_state.some(r => r.key === 'roi:' + tenant.id + ':avg_job_value_usd' && r.value === 350), 'stored under the runtime key roi:<tenant>:avg_job_value_usd');

    // no-show + undo (keyboard)
    await page.focus('[data-noshow]'); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-undo-noshow]', { timeout: 5000 }).catch(() => null);
    let d1 = await db(page);
    ok(d1.bookings.some(b => b.customer_name === 'Sam Lee' && b.status === 'no_show'), 'No-show saved (keyboard)');
    ok(await page.$eval('#rsBookings', e => /No-show/.test(e.innerText)), 'No-show pill shown');
    await page.click('[data-undo-noshow]'); await page.waitForSelector('[data-noshow]', { timeout: 5000 }).catch(() => null);
    d1 = await db(page);
    ok(d1.bookings.some(b => b.customer_name === 'Sam Lee' && b.status === 'confirmed'), 'No-show undone');
    ok(d1.events.filter(e => /^booking_no_show/.test(e.type) && e.client_visible).length === 2, 'no-show changes logged (client visible)');
    // backend guards (same codes as the SQL)
    const future = d1.bookings.find(b => b.customer_name === 'Tess Brown' && b.status === 'confirmed');
    ok(await page.evaluate(id => window.Backend.markNoShow(id, true).then(() => 'ok', e => e.message), future.id) === 'visit_not_started', 'future visit: no-show refused');
    const moved = d1.bookings.find(b => b.status === 'rescheduled');
    ok(await page.evaluate(id => window.Backend.markNoShow(id, true).then(() => 'ok', e => e.message), moved.id) === 'bad_status', 'moved visit: no-show refused');
    const other = await page.evaluate(() => { const x = window.StartMock.admin.db(); const t = { id: crypto.randomUUID(), client_id: crypto.randomUUID(), slug: 'other-co', status: 'live', config: { business: { timezone: 'America/Chicago' } } }; x.tenants.push(t); x.bookings.push({ id: crypto.randomUUID(), tenant_id: t.id, status: 'confirmed', start_at: new Date(Date.now() - 3600000).toISOString(), created_at: new Date().toISOString() }); localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); return { t: t.id, b: x.bookings[x.bookings.length - 1].id }; });
    ok(await page.evaluate(id => window.Backend.getResults(id).then(() => 'ok', e => e.message), other.t) === 'not_your_tenant', 'other tenant: results refused');
    ok(await page.evaluate(id => window.Backend.markNoShow(id, true).then(() => 'ok', e => e.message), other.b) === 'not_your_tenant', 'other tenant: no-show refused');
    ok(await page.evaluate(id => window.Backend.setAvgJobValue(id, 100).then(() => 'ok', e => e.message), other.t) === 'not_your_tenant', 'other tenant: job value refused');

    // a later booking from a call-back number removes it from the list
    await page.evaluate(() => { const x = window.StartMock.admin.db(); const c = x.calls.find(k => k.call_sid === 'CA-results-1'); x.bookings.push({ id: crypto.randomUUID(), tenant_id: c.tenant_id, contact_e164: c.from_e164, customer_name: 'Came back', job_type: 'AC repair', status: 'confirmed', start_at: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString() }); localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); });
    await openResults(page, 2);
    ok((await page.$$eval('#rsBack li', ls => ls.length)) === 1, 'caller who booked later is no longer worth calling back');
    // My receptionist: human status labels, unchanged layout
    await page.click('#tab-receptionist'); await sleep(200);
    ok(/Moved/.test(await body(page)), 'My receptionist: booking status shown as "Moved"');
    await page.close();
  } finally {
    await browser.close();
    if (server) server.close();
  }
  ok(errors.length === 0, 'no console errors (' + errors.slice(0, 3).join(' | ') + ')');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); if (server) server.close(); process.exit(1); });
