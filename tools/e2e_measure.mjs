// Measurement E2E (2026-10-25): GA4 + Microsoft Clarity (+ optional Meta Pixel, 2026-10-29) via /assets/measure.js, on the
// MOCK backend. Puppeteer + local Chrome. Nothing reaches Google, Microsoft or Meta: googletagmanager.com / clarity.ms /
// connect.facebook.net are answered locally with an empty script, every gtag() call is recorded through a dataLayer spy
// installed before any page script, and fbq() calls stay in the stub's queue (window.fbq.queue) because the real script never runs.
//   1. IDs empty (the shipped config): no tag request, no gtag/clarity/fbq on landing, portal and quote pages.
//   2. IDs set (served as a patched brand.json / landing data-measure): both tags load with the right IDs, GA config has
//      Google signals off, the demo-line tel: click and CTA clicks fire events, Clarity masks every form (and the whole
//      portal), the quote page gets GA only with a token-free page_location and fires quote_open + pay_click.
//   2b. Meta Pixel: fbevents.js requested, queue = set autoConfig false -> init (no advanced matching) -> PageView; track()
//      maps quote_submit -> Lead and pay_click -> InitiateCheckout, everything else trackCustom; loaded on the portal, never on
//      the quote page.
//   3. Global Privacy Control or Do Not Track on: nothing loads even with IDs set.
//   4. First-touch UTM: kept from the first utm_* URL, not overwritten, stored on the questionnaire when it is created.
//   node tools/e2e_measure.mjs            (own static server on E2E_PORT, default: a free port)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
const GA = 'G-TEST12345', CL = 'tst0clar1ty', PX = '100200300400500';
const brandRaw = fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8');
const brand = JSON.parse(brandRaw);
const EV = brand.analytics.events;   // funnel event names live only in brand.json
const evName = (...p) => { const n = p.join('_'); if (!EV.includes(n)) throw new Error('event not in brand.json: ' + n); return n; };

let withIds = false;
const server = http.createServer((req, rsp) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const full = path.normalize(path.join(SITE, p));
  if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
  let body = fs.readFileSync(full);
  if (withIds && p === '/assets/brand.json') {
    const b = JSON.parse(brandRaw); b.analytics.ga4_id = GA; b.analytics.clarity_id = CL; b.analytics.meta_pixel_id = PX; body = JSON.stringify(b);
  } else if (withIds && p.endsWith('.html')) {
    body = String(body).replace(/(data-measure="\{&quot;ga4_id&quot;:&quot;)(&quot;,&quot;clarity_id&quot;:&quot;)(&quot;,&quot;meta_pixel_id&quot;:&quot;)(&quot;)/, `$1${GA}$2${CL}$3${PX}$4`);
  }
  rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  rsp.end(body);
});
await new Promise(r => server.listen(+(process.env.E2E_PORT || 0), '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0, CASE = '';
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL [' + CASE + '] ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];

async function newPage(browser, { privacy } = {}) {
  const ctx = await browser.createBrowserContext();   // fresh storage per page: no session / UTM leaks between cases
  const page = await ctx.newPage();
  const rec = { tags: [], calls: [] };
  await page.exposeFunction('__measureRec', s => rec.calls.push(JSON.parse(s)));
  await page.evaluateOnNewDocument(privacy => {
    try { localStorage.setItem('aplp_measure_local', '1'); sessionStorage.setItem('start_force_mock', '1'); } catch (e) { /* blocked */ }
    if (privacy === 'gpc') Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
    if (privacy === 'dnt') Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1' });
    const dl = []; const push = dl.push.bind(dl);
    dl.push = function () { for (const a of arguments) { try { window.__measureRec(JSON.stringify(Array.from(a))); } catch (e) { /* not ready */ } } return push.apply(null, arguments); };
    window.dataLayer = dl;
    const cq = [];   // record Clarity calls too: the stub below never replaces window.clarity
    Object.defineProperty(window, '__clarityCalls', { value: cq });
  }, privacy || '');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (/supabase\.co|anthropic\.com|resend\.com|paypal\.com/.test(u)) { problems.push('live call attempted: ' + u); return r.abort(); }
    if (/googletagmanager\.com|clarity\.ms|connect\.facebook\.net/.test(u)) { rec.tags.push(u); return r.respond({ status: 200, contentType: 'text/javascript', body: '' }); }
    if (/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });
  page.on('pageerror', e => problems.push('uncaught ' + page.url().replace(BASE, '') + ' :: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push('console ' + page.url().replace(BASE, '') + ' :: ' + m.text()); });
  page.on('dialog', d => d.accept());
  return { page, rec };
}
const events = rec => rec.calls.filter(c => c[0] === 'event').map(c => c[1]);
const configs = rec => rec.calls.filter(c => c[0] === 'config');
// fbq() calls: the stub queue (fbevents.js is answered with an empty script, so nothing ever drains it)
const fbqCalls = page => page.evaluate(() => (window.fbq && window.fbq.queue ? window.fbq.queue : []).map(a => Array.from(a)));
const settle = () => sleep(400);
// click without following the link (tel:, external)
const clickNoNav = (page, sel) => page.$eval(sel, el => {
  el.addEventListener('click', e => e.preventDefault(), { once: true });
  el.click();
});

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox'] });
try {
  // ------------------------------------------------------------------ 1. IDs empty (shipped config)
  CASE = 'ids empty';
  ok(!brand.analytics.ga4_id && !brand.analytics.clarity_id && !brand.analytics.meta_pixel_id, 'shipped brand.json has empty GA4 / Clarity / Meta Pixel IDs');
  ok('meta_pixel_id' in brand.analytics, 'brand.json analytics declares meta_pixel_id');
  withIds = false;
  for (const u of ['/', '/real-estate/', '/demo/', '/start/', '/quote/#t=fixture']) {
    const { page, rec } = await newPage(browser);
    await page.goto(BASE + u, { waitUntil: 'load' }); await settle();
    const g = await page.evaluate(() => ({ gtag: typeof window.gtag, clarity: typeof window.clarity, fbq: typeof window.fbq, m: !!window.Measure }));
    ok(g.m, u + ': measure.js loaded');
    ok(rec.tags.length === 0, u + ': no tag request (' + rec.tags.join(', ') + ')');
    ok(g.gtag === 'undefined' && g.clarity === 'undefined' && g.fbq === 'undefined', u + ': no gtag / clarity / fbq function');
    ok(rec.calls.length === 0, u + ': nothing pushed to dataLayer');
    await page.browserContext().close();
  }

  // ------------------------------------------------------------------ 2. IDs set: landing
  withIds = true;
  CASE = 'landing ids set';
  {
    const { page, rec } = await newPage(browser);
    await page.goto(BASE + '/?utm_source=facebook&utm_medium=paid&utm_campaign=launch_oct', { waitUntil: 'load' }); await settle();
    ok(rec.tags.some(u => u.includes('googletagmanager.com/gtag/js?id=' + GA)), 'GA4 tag requested with the configured ID');
    ok(rec.tags.some(u => u.includes('clarity.ms/tag/' + CL)), 'Clarity tag requested with the configured ID');
    const cf = configs(rec)[0];
    ok(cf && cf[1] === GA, 'gtag config uses the configured ID');
    ok(cf && cf[2] && cf[2].allow_google_signals === false && cf[2].allow_ad_personalization_signals === false, 'Google signals + ad personalisation off');
    const masked = await page.evaluate(() => [...document.querySelectorAll('form, input, textarea, select')].every(e => e.getAttribute('data-clarity-mask') === 'True'));
    ok(masked, 'every form / input is masked for Clarity');
    // Meta Pixel: script requested, stub queue in the documented order, no advanced matching, autoConfig off
    ok(rec.tags.some(u => u.includes('connect.facebook.net/en_US/fbevents.js')), 'Meta Pixel script requested');
    const fq = await fbqCalls(page);
    const fqs = fq.map(c => c.slice(0, 2).join(' '));
    ok(fqs[0] === 'set autoConfig' && fq[0][2] === false && fq[0][3] === PX, 'fbq set autoConfig false (before init)');
    ok(fqs[1] === 'init ' + PX && fq[1].length === 2, 'fbq init with the configured ID and no advanced-matching object');
    ok(fqs[2] === 'track PageView', 'fbq track PageView');
    ok(await page.evaluate(() => window.Measure.loaded.meta === true && window.Measure.loaded.ga === true && window.Measure.loaded.clarity === true), 'Measure.loaded reports ga + clarity + meta');
    ok(await page.$('a[href^="tel:"][data-ev]') !== null, 'demo line tel: link carries data-ev');
    await clickNoNav(page, 'a[href^="tel:"][data-ev]'); await sleep(100);
    const telEv = await page.$eval('a[href^="tel:"][data-ev]', a => a.getAttribute('data-ev'));
    ok(events(rec).includes(telEv), 'demo line click -> event "' + telEv + '"');
    await clickNoNav(page, '[data-ev="' + evName('quote', 'start') + '"]'); await sleep(100);
    ok(events(rec).includes(evName('quote', 'start')), 'CTA click -> quote_start');
    {
      const q = await fbqCalls(page);
      ok(q.some(c => c[0] === 'trackCustom' && c[1] === evName('quote', 'start')), 'quote_start -> fbq trackCustom quote_start (unmapped event)');
      ok(q.some(c => c[0] === 'trackCustom' && c[1] === telEv), 'demo line click -> fbq trackCustom ' + telEv);
      // mapped funnel events -> standard Meta events (fired through the public API: the submit / pay steps live on other pages)
      await page.evaluate((a, b) => { window.Measure.track(a, { page: '/x' }); window.Measure.track(b, { method: 'upwork' }); }, evName('quote', 'submit'), evName('pay', 'click'));
      const q2 = await fbqCalls(page);
      ok(q2.some(c => c[0] === 'track' && c[1] === 'Lead'), 'quote_submit -> fbq track Lead');
      ok(q2.some(c => c[0] === 'track' && c[1] === 'InitiateCheckout' && c[2] && c[2].method === 'upwork'), 'pay_click -> fbq track InitiateCheckout {method}');
      ok(!q2.some(c => c[0] === 'trackCustom' && (c[1] === evName('quote', 'submit') || c[1] === evName('pay', 'click'))), 'mapped events are not also sent as custom events');
      ok(!JSON.stringify(q2).includes('"em"'), 'no advanced matching fields in any fbq call');
    }
    const ft = await page.evaluate(() => JSON.parse(localStorage.getItem('aplp_ft_utm') || 'null'));
    ok(ft && ft.utm_source === 'facebook' && ft.utm_medium === 'paid' && ft.utm_campaign === 'launch_oct' && ft.landing_path === '/' && ft.first_seen, 'first-touch UTM stored');
    await page.goto(BASE + '/real-estate/?utm_source=google&utm_medium=cpc', { waitUntil: 'load' }); await settle();
    const ft2 = await page.evaluate(() => JSON.parse(localStorage.getItem('aplp_ft_utm') || 'null'));
    ok(ft2 && ft2.utm_source === 'facebook', 'a later utm_* visit does not overwrite the first touch');

    // ---------------------------------------------------------------- portal: sign in (mock), questionnaire start
    CASE = 'portal ids set';
    rec.tags.length = 0; rec.calls.length = 0;
    await page.goto(BASE + '/start/?offer=RCP', { waitUntil: 'load' });
    await page.waitForSelector('#email');
    await page.type('#email', 'measure-e2e@example.com'); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
    const code = (await page.$eval('#mockCode', e => e.textContent)).trim();
    await page.type('#code', code);
    await page.waitForSelector('#profileForm', { timeout: 10000 });
    ok(rec.tags.some(u => u.includes(GA)) && rec.tags.some(u => u.includes(CL)), 'portal loads GA4 + Clarity');
    ok(rec.tags.some(u => u.includes('connect.facebook.net')), 'portal loads the Meta Pixel (page views + funnel names only)');
    ok((await fbqCalls(page)).some(c => c[0] === 'init' && c[1] === PX), 'portal: fbq init with the configured ID');
    ok(await page.evaluate(() => document.body.getAttribute('data-clarity-mask') === 'True'), 'portal: whole page masked for Clarity');
    await page.type('#p_full_name', 'Dana Measure'); await page.type('#p_company', 'Measure HVAC'); await page.type('#p_phone', '7135550199');
    await page.type('#p_city', 'Houston').catch(() => {}); await page.select('#p_state', 'TX').catch(() => {});
    await page.click('#pSave');
    await page.waitForFunction(() => location.pathname.startsWith('/start/q/'), { timeout: 10000 }); await settle();
    ok(events(rec).includes(evName('quote', 'start')), 'questionnaire created -> quote_start');
    const qn = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('aplp_mock_db_v1') || '{}'); return (d.questionnaires || []).slice(-1)[0]; });
    ok(qn && qn.utm && qn.utm.utm_source === 'facebook' && qn.utm.utm_campaign === 'launch_oct' && qn.utm.landing_path === '/', 'first-touch UTM stored on the questionnaire');
    await page.browserContext().close();
  }
  {
    CASE = 'admin ids set';
    const { page, rec } = await newPage(browser);
    await page.goto(BASE + '/start/admin/', { waitUntil: 'load' }); await settle();
    ok(page.url().includes('/start/admin/'), 'admin page stays on /start/admin/');
    ok(rec.tags.length === 0, 'admin screens load no tags (' + rec.tags.join(', ') + ')');
    await page.browserContext().close();
  }

  // ------------------------------------------------------------------ quote page: GA only, token-free, quote_open + pay_click
  CASE = 'quote ids set';
  {
    const { page, rec } = await newPage(browser);
    await page.goto(BASE + '/quote/?t=fixture-upworklink', { waitUntil: 'load' });
    await page.waitForSelector('[data-pay]', { timeout: 10000 }); await settle();
    ok(rec.tags.some(u => u.includes(GA)), 'quote page loads GA4');
    ok(!rec.tags.some(u => /clarity\.ms/.test(u)), 'quote page never loads Clarity');
    ok(!rec.tags.some(u => /facebook\.net/.test(u)), 'quote page never loads the Meta Pixel');
    ok(await page.evaluate(() => typeof window.fbq === 'undefined' && window.Measure.loaded.meta === false), 'quote page: no fbq, loaded.meta false');
    const cf = configs(rec)[0];
    ok(cf && cf[2] && cf[2].page_location === BASE + '/quote/' && cf[2].page_referrer === '', 'GA page_location has no token');
    ok(!JSON.stringify(rec.calls).includes('fixture-upworklink'), 'token never reaches GA');
    ok(events(rec).includes(evName('quote', 'open')), 'quote_open fired');
    await clickNoNav(page, '[data-pay]'); await sleep(100);
    const pc = rec.calls.find(c => c[0] === 'event' && c[1] === evName('pay', 'click'));
    ok(pc && pc[2] && pc[2].method === 'upwork', 'Upwork contract click -> pay_click {method: upwork}');
    await page.browserContext().close();
  }
  {
    const { page, rec } = await newPage(browser);
    await page.goto(BASE + '/quote/#t=fixture', { waitUntil: 'load' });
    await page.waitForSelector('#acceptForm', { timeout: 10000 });
    await page.type('#accName', 'Dana Measure'); await page.click('#accAgree'); await page.click('#accBtn'); await settle();
    ok(events(rec).includes(evName('quote', 'accept')), 'accept -> quote_accept');
    await page.browserContext().close();
  }

  // ------------------------------------------------------------------ 3. GPC / DNT: nothing even with IDs
  for (const priv of ['gpc', 'dnt']) {
    CASE = priv;
    for (const u of ['/', '/start/', '/quote/#t=fixture']) {
      const { page, rec } = await newPage(browser, { privacy: priv });
      await page.goto(BASE + u, { waitUntil: 'load' }); await settle();
      ok(rec.tags.length === 0 && rec.calls.length === 0, u + ': no tag, no dataLayer call');
      ok(await page.evaluate(() => typeof window.fbq === 'undefined'), u + ': no fbq');
      await page.browserContext().close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
problems.forEach(p => { fail++; console.log('  FAIL ' + p); });
console.log((fail ? '❌' : '✅') + ' e2e_measure: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
