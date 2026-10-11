// Overflow + console gate for the owner admin (/start/admin/, RTL) in Chromium, WebKit and Firefox at 375/390/414/1280.
// Signs in as the mock admin, loads the demo data, then measures every tab and an open detail of each kind.
// usage: node tools/overflow_admin.mjs [baseUrl]   (default: own server on E2E_PORT|8942)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8942);
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
  const go = async url => { await page.goto(BASE + url, { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#panel'); await page.waitForTimeout(150); };

  await page.goto(BASE + '/start/admin/?mock=1', { waitUntil: 'load' });
  await page.evaluate(() => window.StartMock.admin.reset());
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#email');
  await measure('sign-in');
  await page.fill('#email', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
  await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  await page.fill('#code', (await page.textContent('#mockCode')).trim()); await page.click('#verifyBtn');
  await page.waitForSelector('#seedBtn'); await page.evaluate(() => { document.querySelector('#digestDet').open = true; }); await page.click('#seedBtn'); await page.waitForTimeout(400);
  const db = await page.evaluate(() => window.StartMock.admin.db());
  const routes = ['#leads', '#questionnaires', '#quotes', '#clients', '#requests', '#tenants', '#events', '#settings']
    .concat(db.quotes.map(q => '#quotes/' + q.id), db.clients.map(c => '#clients/' + c.id), db.questionnaires.map(q => '#questionnaires/' + q.id));
  for (const r of routes) { await go('/start/admin/' + r); await measure(r.replace(/[0-9a-f-]{36}/, 'id')); }
  errs.forEach(e => problems.push(`${name} console: ${e}`));
  await browser.close();
}

try {
  for (const [n, t] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]]) { console.log(n); await runEngine(n, t); }
} finally { if (server) server.close(); }
console.log(`${checks} viewport checks, ${problems.length} problems`);
problems.slice(0, 30).forEach(p => console.log('  FAIL ' + p));
process.exit(problems.length ? 1 : 0);
