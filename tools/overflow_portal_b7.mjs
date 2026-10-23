// Overflow + console gate for portal phase B (task B7) in Chromium, WebKit and Firefox at 375/390/414/1280:
// client Setup checklist (every step open + error states), My receptionist (transcripts + settings open), Requests,
// Billing usage, and the admin Tenants tab (usage table, editor with errors, new-tenant form). Long values stress wrapping.
// usage: node tools/overflow_portal_b7.mjs [baseUrl]   (default: own server on E2E_PORT|8963)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8963);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
let server = null;
const BASE = process.argv[2] || `http://localhost:${PORT}`;
if (!process.argv[2]) {
  server = http.createServer((req, rsp) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const full = path.normalize(path.join(SITE, p));
    if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
    rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' }); fs.createReadStream(full).pipe(rsp);
  });
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
}
const WIDTHS = [375, 390, 414, 1280];
let checks = 0; const problems = [];

async function runEngine(name, type) {
  const browser = await type.launch({ timeout: 60000 });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60000); // tolerate a loaded machine
  page.on('dialog', d => d.accept());
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('uncaught: ' + e.message));
  const measure = async label => {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w >= 1024 ? 800 : 844 });
      await page.waitForTimeout(40);
      const d = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      checks++;
      if (d > 0) problems.push(`${name} ${w}px ${label}: overflow ${d}px`);
    }
  };
  const fresh = async (url, sel) => { await page.goto(BASE + url, { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector(sel); await page.waitForTimeout(150); };
  const signIn = async (url, email, admin) => {
    await fresh(url, '#email');
    await page.fill('#email', email); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
    await page.fill('#code', (await page.textContent('#mockCode')).trim());
    if (admin) await page.click('#verifyBtn');
  };

  await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
  await page.evaluate(() => window.StartMock.admin.reset());
  await signIn('/start/', 'qa-b7@overflow.test');
  await page.waitForSelector('#profileForm');
  await page.evaluate(() => window.Backend.saveProfile({ full_name: 'Quinn Averylongfamilyname-Hyphenated', company: 'A Very Long Business Name Heating Cooling & Plumbing LLC', phone: '7135550100' }));
  await fresh('/start/?mock_seed=testing', '[role=tablist]');
  const t = await page.evaluate(() => window.StartMock.admin.seedTenant());
  // long data everywhere
  await page.evaluate(async tid => {
    const B = window.Backend, long = 'Supercalifragilisticexpialidociousword'.repeat(3);
    const ob = await B.listOnboarding();
    for (const o of ob) await B.updateOnboarding(o.id, o.key === 'faq' ? 'need_help' : 'todo', { help_message: 'Help ' + long, booking_link: 'https://calendly.com/' + long, website: long });
    await B.updateTenantSettings(tid, { faq: [{ q: 'Q ' + long, a: 'A ' + long }], notify: { sms: ['+17135550142', '+17135550143', '+17135550144'], email: [long.toLowerCase().slice(0, 60) + '@example.com'] } });
    await B.createRequest({ title: 'Title ' + long, body: 'Body ' + long });
    await B.createRequest({ title: 'Short one', body: '' });
    const x = window.StartMock.admin.db();
    x.calls.forEach(c => { c.summary = c.summary + ' ' + long; });
    x.requests[0].status = 'waiting_on_you'; x.requests[0].admin_reply = 'Reply ' + long;
    localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x));
  }, t.id);
  await fresh('/start/?r=1#onboarding', '.obsteps');
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await measure('checklist all open');
  await page.evaluate(() => document.querySelectorAll('[data-save]').forEach(b => b.click()));
  await page.waitForTimeout(300);
  await measure('checklist with errors');
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await page.selectOption('#ob_car', 'att'); await page.waitForTimeout(80);
  await measure('checklist carrier codes');
  await page.selectOption('#ob_car', 'zoom'); await page.waitForTimeout(80);
  await measure('checklist VoIP menu path (Zoom Phone, longest entry)');
  await fresh('/start/?r=2#receptionist', '#rxPause');
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await measure('receptionist all open');
  await fresh('/start/?r=3#requests', '#reqForm'); await measure('requests');
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await fresh('/start/?r=4#billing', '#panel'); await measure('billing usage');
  await page.evaluate(() => window.Backend.signOut());
  // admin Tenants
  await signIn('/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()), true);
  await page.waitForSelector('#seedBtn'); await page.evaluate(() => { document.querySelector('#digestDet').open = true; }); await page.click('#seedBtn'); await page.waitForTimeout(400);
  const db = await page.evaluate(() => window.StartMock.admin.db());
  await fresh('/start/admin/?r=1#tenants', '#tuBody table'); await measure('admin tenants');
  for (const x of db.tenants) { await fresh('/start/admin/?r=2#tenants/' + x.id, '#tJson'); await page.evaluate(() => document.querySelectorAll('#detail details').forEach(d => { d.open = true; })); await measure('admin tenant ' + x.slug); }
  const free = db.clients.find(c => !db.tenants.some(x => x.client_id === c.id));
  if (free) { await fresh('/start/admin/?r=3#tenants/new-' + free.id, '#tJson'); await measure('admin new tenant'); }
  errs.forEach(e => problems.push(`${name} console: ${e}`));
  await browser.close();
}

try {
  for (const [n, t] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]]) { console.log(n); await runEngine(n, t); }
} finally { if (server) server.close(); }
console.log(`${checks} viewport checks, ${problems.length} problems`);
problems.slice(0, 30).forEach(p => console.log('  FAIL ' + p));
process.exit(problems.length ? 1 : 0);
