// E2E for ADD-DISPATCH in the portal (portal-dispatch.js) against the MOCK backend: the "Night calls" section only when the
// tenant has the add-on, on-call team editor (validation, opt-in confirmation, add/remove, same shift every night), save
// through saveDispatch (mirrors update_dispatch_settings), urgent call log (chain, time to pick up, STOP flag) and the
// Handled button, keyboard, overflow 375/390/414/1280, console errors.
//   node tools/e2e_dispatch.mjs        (own static server on E2E_PORT, default 8961)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8961);
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
const pb = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/pricebook.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/tenant_schema.json'), 'utf8'));
const runtimeSchema = fs.readFileSync(path.resolve(HERE, '../runtime/app/tenant_schema.json'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.emulateTimezone('America/Chicago');
  await page.setRequestInterception(true);
  page.on('request', r => /fonts\.(googleapis|gstatic)\.com/.test(r.url()) ? r.respond({ status: 200, contentType: 'text/css', body: '' }) : r.continue());
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('uncaught: ' + e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const body = page => page.evaluate(() => document.body.innerText);
const waitText = (page, needle, timeout = 5000) => page.waitForFunction(n => document.body.innerText.includes(n), { timeout }, needle).then(() => true).catch(() => false);
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
async function signIn(page, pathName, email) {
  await page.goto(BASE + pathName + '?mock=1', { waitUntil: 'load' });
  await page.waitForSelector('#email');
  await page.type('#email', email); await page.click('#sendBtn');
  await page.waitForSelector('#mockCode');
  const code = await page.$eval('#mockCode', e => e.textContent);
  await page.type('#code', code);
  if (pathName.indexOf('admin') !== -1) { await page.click('#verifyBtn'); return; }
  await page.waitForFunction(() => !document.querySelector('#codeForm'), { timeout: 5000 });
}
async function profile(page, company) {
  await page.waitForSelector('#profileForm');
  await page.type('#p_full_name', 'Dani Levi'); await page.type('#p_company', company); await page.type('#p_phone', '(713) 555-0100');
  await page.type('#p_city', 'Houston'); await page.select('#p_state', 'TX'); await page.click('#pSave');
  await page.waitForSelector('[role=tablist]');
}
async function tabTo(page, id) { await page.click('#tab-' + id); await sleep(150); }
async function openStep(page, key) {
  await page.evaluate(k => { const d = document.querySelector('#ob-' + k); if (d && !d.open) d.open = true; }, key);
  await sleep(50);
}
async function setVal(page, sel, v) { await page.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); }
async function save(page, key) { await page.$eval('[data-save="' + key + '"]', b => b.click()); await sleep(250); }

async function main() {
  await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await newPage(browser);
    ok(JSON.stringify(schema) === runtimeSchema.trim() || JSON.stringify(schema) === JSON.stringify(JSON.parse(runtimeSchema)), 'tenant schema synced');
    ok(!!(schema.$defs && schema.$defs.Dispatch && schema.$defs.DispatchShift), 'schema has Dispatch + DispatchShift');
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    await signIn(page, '/start/', 'dani@dispatch.test');
    await profile(page, 'Cool Breeze HVAC');
    await page.goto(BASE + '/start/?mock_seed=testing', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    const tenantId = (await page.evaluate(() => window.StartMock.admin.seedTenant())).id;
    await page.goto(BASE + '/start/?r=1#receptionist', { waitUntil: 'load' }); await page.waitForSelector('#setAfter');
    ok(await page.$('#setDispatch') === null, 'no add-on: no Night calls section');

    // ---------------------------------------------------------------- with the add-on
    await page.evaluate(() => window.StartMock.admin.seedDispatch());
    await page.goto(BASE + '/start/?r=2#receptionist', { waitUntil: 'load' }); await page.waitForSelector('#setDispatch');
    await page.focus('#setDispatch > summary'); await page.keyboard.press('Enter'); await sleep(80);
    ok(await page.$eval('#setDispatch', x => x.open), 'keyboard: Enter opens the Night calls section');
    let text = await page.$eval('#setDispatch', e => e.innerText);
    ok(/Status: on\./.test(text) && /up to 3 of your numbers/.test(text), 'status + how it works');
    ok(/Connected to Dan in 18 s/.test(text), 'log: accepted call with time to pick up');
    ok(/Dan: no answer → Maria: no answer/.test(text) && /Alerts sent: Dan, Maria/.test(text) && /Needs a call-back/.test(text), 'log: waterfall chain + alerts + open status');
    ok(/Maria replied STOP and gets no more on-call alerts/.test(text), 'log: STOP from staff flagged');
    ok(!/\+1713|\(713\) 555-02/.test(await page.$eval('#dLog', e => e.innerText)), 'log shows no phone numbers');
    ok((await page.$$('#dShifts .dshift')).length === 7 && (await page.$$('#dPeople .dperson')).length === 2, 'editor loaded: 2 people, 7 shifts');
    ok(/agreed to receive on-call alerts .* from Cool Breeze HVAC via /.test(text) && /Confirmed /.test(text), 'opt-in wording names the business + platform; confirmation date shown');
    ok((await overflow(page)).length === 0, 'Night calls open: no overflow 375/390/414/1280');

    // handled
    await page.$eval('[data-dhandled="CAdispatch2"]', b => b.click()); await sleep(400);
    ok((await db(page)).dispatch_events.some(r => r.call_sid === 'CAdispatch2' && r.result === 'handled'), 'Handled: row written');
    await page.$eval('#setDispatch', x => { x.open = true; });
    ok(/Handled/.test(await page.$eval('#dLog', e => e.innerText)) && await page.$('[data-dhandled="CAdispatch2"]') === null, 'Handled: status shown, button gone');

    // add a person: validation, then save with opt-in
    await page.$eval('#setDispatch', x => { x.open = true; });
    await page.click('#dPersonAdd'); await sleep(60);
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'dp2n'), 'add person focuses the new name');
    await setVal(page, '#dp2n', 'Bo'); await setVal(page, '#dp2p', '555-01');
    await page.$eval('[data-dsave]', b => b.click()); await sleep(200);
    ok(/Person 3: “555-01” doesn’t look like a US phone number/.test(await page.$eval('#rxMsg_dispatch', e => e.innerText)), 'bad phone rejected');
    await setVal(page, '#dp2p', '(713) 555-0201');
    await page.$eval('[data-dsave]', b => b.click()); await sleep(200);
    ok(/listed twice/.test(await page.$eval('#rxMsg_dispatch', e => e.innerText)), 'duplicate phone rejected');
    await setVal(page, '#dp2p', '(713) 555-0202'); await page.$eval('#dp2o', c => { c.checked = true; });
    await page.select('#ds0c1', 'maria');
    await setVal(page, '#dCb', '3');
    await page.$eval('[data-dsave]', b => b.click()); await sleep(200);
    ok(/from 5 to 120/.test(await page.$eval('#rxMsg_dispatch', e => e.innerText)), 'call-back window range');
    await setVal(page, '#dCb', '20');
    await page.$eval('[data-dsave]', b => b.click()); await sleep(500);
    let disp = (await db(page)).tenants.find(t => t.id === tenantId).config.dispatch;
    const bo = disp.contacts.find(c => c.name === 'Bo');
    ok(disp.contacts.length === 3 && bo && bo.phone === '+17135550202' && bo.alerts_opt_in_at && !('opt_in' in bo), 'saved: new person with server-stamped opt-in');
    ok(disp.callback_minutes === 20 && disp.schedule[0].contacts.join() === 'dan,maria' && disp.enabled === true, 'saved: call-back window, shift order, enabled untouched');
    ok(disp.contacts.find(c => c.id === 'dan').alerts_opt_in_at === (await db(page)).tenants.find(t => t.id === tenantId).config.dispatch.contacts.find(c => c.id === 'dan').alerts_opt_in_at, 'existing opt-in kept');

    // remove a person used in a shift -> error; same shift every night
    await page.$eval('#setDispatch', x => { x.open = true; });
    await page.$eval('[data-dprm="1"]', b => b.click()); await sleep(60);
    await page.$eval('[data-dsave]', b => b.click()); await sleep(200);
    ok(/someone in this shift was removed/.test(await page.$eval('#rxMsg_dispatch', e => e.innerText)), 'removed person still in a shift: rejected');
    await page.click('#dShiftWeek'); await sleep(60);
    ok((await page.$$('#dShifts .dshift')).length === 7, 'same shift every night: 7 shifts');
    await page.select('#ds0c1', ''); await sleep(20);
    await page.click('#dShiftWeek'); await sleep(60);
    await page.$eval('[data-dsave]', b => b.click()); await sleep(500);
    disp = (await db(page)).tenants.find(t => t.id === tenantId).config.dispatch;
    ok(disp.contacts.length === 2 && !disp.contacts.some(c => c.id === 'maria') && disp.schedule.length === 7 && disp.schedule.every(s => s.contacts.join() === 'dan'), 'saved after removing the manager');
    // whitelist on the backend
    ok(await page.evaluate(id => window.Backend.saveDispatch(id, { enabled: false }).then(() => 'ok', e => e.message), tenantId) === 'field_not_allowed: enabled', 'backend: enabled is admin-only');
    ok(await page.evaluate(id => window.Backend.markDispatchHandled(id, 'CA-none').then(() => 'ok', e => e.message), tenantId) === 'not_found', 'backend: handled needs a logged call');
    ok((await overflow(page)).length === 0, 'after edits: no overflow');
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
