// Overflow + console gate for EVERY portal screen (signed-out and signed-in), in Chromium, WebKit and Firefox at
// 375/390/414/1280 — the signed-in screens need a session, which tools/overflow.mjs (fresh context per URL) can't make.
// Uses the mock backend. usage: node tools/overflow_start.mjs [baseUrl]   (default: own server on E2E_PORT|8932)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8932);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
const PATHS = [['RCP', 'home_services'], ['RCP', 'real_estate'], ['WEB', 'home_services'], ['BNDL', 'real_estate'], ['UNSURE', 'home_services']];
let checks = 0; const problems = [];

async function runEngine(name, type) {
  const browser = await type.launch({ timeout: 60000 });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // mock backend regardless of /assets/config.js (see backend.js: per-tab flag, honoured on localhost)
  await ctx.addInitScript(() => { try { sessionStorage.setItem('start_force_mock', '1'); } catch (e) { /* storage blocked */ } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60000); // tolerate a loaded machine
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
  const go = async (url, sel) => { await page.goto(BASE + url, { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector(sel); };

  await go('/start/', '#email');
  await page.evaluate(() => window.StartMock.admin.reset());
  await go('/start/', '#email');
  await measure('sign-in');
  await page.fill('#email', 'qa@overflow.test'); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  await measure('sign-in code');
  await page.fill('#code', await page.textContent('#mockCode'));
  await page.waitForSelector('#profileForm');
  await measure('profile');
  await page.evaluate(() => window.Backend.saveProfile({ full_name: 'Quinn Averylongfamilyname-Hyphenated', company: 'A Very Long Business Name Heating Cooling & Plumbing LLC', phone: '7135550100' }));
  for (const [offer, niche] of PATHS) {
    const id = await page.evaluate(([o, n]) => window.Backend.createQuestionnaire({ offer: o, niche: n }).then(r => r.id), [offer, niche]);
    // long answers to stress wrapping
    await page.evaluate(([qid, o, n]) => window.Backend.saveQuestionnaire(qid, { offer: o, niche: n, answers: { offer: o, niche: n,
      services: ['hvac', 'plumbing', 'electrical', 'roofing', 'garage_doors', 'locksmith', 'pest', 'cleaning', 'landscaping', 'other'], locations: '2',
      tools: ['google_calendar', 'jobber', 'other'], tools_other: 'SuperLongToolNameWithoutAnySpacesAtAllToTestWrapping', more: 'x'.repeat(400) } }), [id, offer, niche]);
    const steps = await page.evaluate(([o, n]) => window.StartQ.stepsFor({ offer: o, niche: n }).map(s => s.id), [offer, niche]);
    for (const s of steps) {
      await go(`/start/q/?id=${id}#${s}`, '#stepTitle');
      await measure(`${offer}/${niche} #${s}`);
    }
  }
  const sub = await page.evaluate(() => window.Backend.listQuestionnaires().then(l => l[0].id));
  await page.evaluate(id => window.Backend.submitQuestionnaire(id), sub);
  await go(`/start/q/?id=${sub}`, '#roTitle'); await measure('read-only');
  await go('/start/?mock_seed=deposit_paid', '[role=tablist]'); await measure('portal home');
  for (const t of ['quotes', 'billing']) { await page.click('#tab-' + t); await measure('portal ' + t); }
  await page.click('#editProfile'); await page.waitForSelector('#profileForm'); await measure('profile edit');
  errs.forEach(e => problems.push(`${name} console: ${e}`));
  await browser.close();
}

try {
  for (const [n, t] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]]) { console.log(n); await runEngine(n, t); }
} finally { if (server) server.close(); }
console.log(`${checks} viewport checks, ${problems.length} problems`);
problems.slice(0, 30).forEach(p => console.log('  FAIL ' + p));
process.exit(problems.length ? 1 : 0);
