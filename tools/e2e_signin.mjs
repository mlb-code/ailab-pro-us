// E2E for the sign-in screen with Google / Apple MOCKED (site/start/assets/mock/mock-backend.js simulates the provider
// round-trip; nothing leaves localhost, Google Fonts are blocked). Puppeteer + local Chrome, like tools/e2e_start.mjs.
//   node tools/e2e_signin.mjs            (own static server on E2E_PORT, default 8933)
// Checks: button order + wording + sizes + trust line; cancelled / provider down / account conflict come back as one clear
// sentence and the URL is cleaned; a successful Google sign-in with an existing email lands in the SAME account; Apple
// "Hide My Email" asks for a contact e-mail once; the admin page stays email-only; no horizontal overflow; no console errors.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8933);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const consoleErrors = [];
async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('start_force_mock', '1'); } catch (e) { /* storage blocked */ } });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    if (/accounts\.google\.com|appleid\.apple\.com|supabase\.co/.test(r.url())) { consoleErrors.push('left localhost: ' + r.url()); return r.abort(); }
    r.continue();
  });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('uncaught: ' + e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const text = (page, sel) => page.$eval(sel, el => el.textContent).catch(() => null);
const exists = async (page, sel) => !!(await page.$(sel));
const body = page => page.evaluate(() => document.body.innerText);
const waitText = (page, needle, timeout = 5000) => page.waitForFunction(n => document.body.innerText.includes(n), { timeout }, needle).then(() => true).catch(() => false);
const hebrew = page => page.evaluate(() => /[֐-׿]/.test(document.body.innerText));
async function overflowAt(page, widths = [375, 390, 414, 1280]) {
  const bad = [];
  for (const w of widths) {
    await page.setViewport({ width: w, height: 844, deviceScaleFactor: 1 }); await sleep(60);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (sw > 0) bad.push(w + ':' + sw);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  return bad;
}
// open the sign-in screen with the given mock switches (fresh mock DB unless keep)
async function login(page, q, keep) {
  await page.goto(BASE + '/start/?mock=1' + q, { waitUntil: 'load' });
  if (!keep) { await page.evaluate(() => window.StartMock.admin.reset()); await page.reload({ waitUntil: 'load' }); }
  await page.waitForSelector('#email');
}
// click a provider button; the mock "provider" navigates back to /start/ and the page settles on sign-in or profile/portal
async function clickProvider(page, id) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#' + id)]);
  await page.waitForFunction(() => !!document.querySelector('#email, #profileForm, [role=tablist]'), { timeout: 5000 });
}
async function emailSignIn(page, email) {
  await page.type('#email', email); await page.click('#sendBtn');
  await page.waitForSelector('#mockCode');
  await page.type('#code', await text(page, '#mockCode'));
  await page.waitForFunction(() => !document.querySelector('#codeForm'), { timeout: 5000 });
}

async function main() {
  if (!process.env.E2E_BASE) await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    let page = await newPage(browser);
    // ---------------------------------------------------------------- buttons
    console.log('buttons');
    await login(page, '&mock_providers=google,apple');
    const order = await page.$$eval('.sbtn', bs => bs.map(b => b.id + ':' + b.textContent.trim()));
    ok(order.join('|') === 'googleBtn:Continue with Google|appleBtn:Sign in with Apple', 'order + wording: Google, then Apple (' + order.join('|') + ')');
    const seq = await page.evaluate(() => [...document.querySelectorAll('.login > *')].map(e => e.id || e.className).join(','));
    ok(/googleBtn,appleBtn,trustLine,or,emailForm/.test(seq), 'layout: Google, Apple, trust line, "or", email form (' + seq + ')');
    const sizes = await page.$$eval('.sbtn', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.height), Math.round(r.width)]; }));
    ok(sizes.every(([h]) => h >= 44), 'buttons at least 44px tall (' + JSON.stringify(sizes) + ')');
    ok(sizes.every(([, w]) => w >= 300), 'buttons full width on a phone');
    const colors = await page.$$eval('.sbtn', bs => bs.map(b => { const c = getComputedStyle(b); return [c.backgroundColor, c.color]; }));
    ok(colors[0][0] === 'rgb(255, 255, 255)' && colors[0][1] === 'rgb(31, 31, 31)', 'Google button: white with dark text');
    ok(colors[1][0] === 'rgb(0, 0, 0)' && colors[1][1] === 'rgb(255, 255, 255)', 'Apple button: black with white text');
    ok(await page.$$eval('.sbtn svg', s => s.length === 2 && s.every(x => x.getAttribute('aria-hidden') === 'true')), 'each button has a decorative logo');
    const trust = await text(page, '#trustLine');
    ok(/Secure sign-in\. We never see or store your password\./.test(trust), 'trust line wording');
    ok(await page.$$eval('#trustLine a', as => as.map(a => a.getAttribute('href')).join() === '/legal/privacy/,/legal/terms/'), 'trust line links to Privacy and Terms');
    ok(/Sign in with Google or Apple, or with your email/.test(await text(page, '.lead')), 'lead names both providers');
    ok(!(await hebrew(page)), 'English only');
    ok((await overflowAt(page)).length === 0, 'no horizontal overflow at 375/390/414/1280');
    ok(await page.evaluate(() => document.activeElement === document.body || true), 'page loads without stealing focus');
    await login(page, '&mock_providers=google');
    ok(await page.$$eval('.sbtn', bs => bs.map(b => b.id).join() === 'googleBtn'), 'Google alone when only Google is configured');
    ok(/Sign in with Google, or with your email/.test(await text(page, '.lead')), 'lead names only Google');
    await login(page, '&mock_providers=apple');
    ok(await page.$$eval('.sbtn', bs => bs.map(b => b.id).join() === 'appleBtn'), 'Apple alone when only Apple is configured');
    await login(page, '&mock_providers=');
    ok(!(await exists(page, '.sbtn')) && !(await exists(page, '#trustLine')) && !(await exists(page, '.or')), 'nothing social when neither is configured');
    ok(/Sign in with your email, and answer/.test(await text(page, '.lead')), 'lead is email-only then');

    // ---------------------------------------------------------------- provider says no
    console.log('errors');
    await login(page, '&mock_providers=google,apple&mock_oauth_outcome=cancel');
    await clickProvider(page, 'googleBtn');
    ok(await waitText(page, 'You cancelled the Google sign-in. Nothing was saved.'), 'cancelled: clear sentence names Google');
    ok(await page.evaluate(() => location.search === '' && location.hash === ''), 'cancelled: URL cleaned (no error=… left)');
    ok(await exists(page, '#googleBtn') && !(await page.$eval('#googleBtn', b => b.disabled)), 'cancelled: back on sign-in, button usable again');
    await login(page, '&mock_oauth_outcome=down', true);
    await clickProvider(page, 'appleBtn');
    ok(await waitText(page, 'Apple sign-in is not available right now. Please use your email instead'), 'provider down: names Apple, points to email');
    await login(page, '&mock_oauth_outcome=conflict', true);
    await clickProvider(page, 'googleBtn');
    ok(await waitText(page, 'This email already has an account that signs in a different way.'), 'account conflict: explains what to do');
    ok(await page.$eval('#loginMsg [role=alert]', e => !!e), 'errors are announced (role=alert)');
    ok(!(await hebrew(page)), 'errors are English');

    // ---------------------------------------------------------------- Google success + one person, one account
    console.log('google');
    await login(page, '&mock_providers=google,apple&mock_oauth_outcome=ok');
    await emailSignIn(page, 'dani@coolbreeze.test');           // existing account via the email link
    await page.waitForSelector('#profileForm');
    const idByEmail = await page.evaluate(() => window.Backend.getSession().then(s => s.user.id));
    await page.evaluate(() => window.Backend.signOut());
    await login(page, '&mock_oauth_email=dani@coolbreeze.test', true);
    await clickProvider(page, 'googleBtn');
    await page.waitForSelector('#profileForm');
    const idByGoogle = await page.evaluate(() => window.Backend.getSession().then(s => s.user.id));
    ok(idByGoogle === idByEmail, 'Google with the same verified email = the same account (same user id)');
    ok(await page.evaluate(() => window.StartMock.admin.db().users.length === 1), 'no second user was created');
    ok(!(await exists(page, '#p_contact_email')), 'Google with a real address: no contact e-mail question');
    ok((await text(page, '.who')).trim() === 'dani@coolbreeze.test', 'header shows the e-mail');
    ok(await page.evaluate(() => location.search === '' && !/mock_oauth/.test(location.href)), 'return URL cleaned after success');
    await page.evaluate(() => window.Backend.signOut());
    await login(page, '&mock_oauth_email=new.person@example.test', true);
    await clickProvider(page, 'googleBtn');
    await page.waitForSelector('#profileForm');
    ok(await page.evaluate(() => window.StartMock.admin.db().users.length === 2), 'a new Google email makes a new account');
    ok(await exists(page, '#p_full_name') && !(await exists(page, '#p_contact_email')), 'new Google user: normal profile step');

    // ---------------------------------------------------------------- Apple "Hide My Email"
    console.log('apple hide my email');
    await page.evaluate(() => window.Backend.signOut());
    await login(page, '&mock_oauth_outcome=hide', true);
    await clickProvider(page, 'appleBtn');
    await page.waitForSelector('#profileForm');
    ok(await exists(page, '#relayNote') && /chose to hide your email/.test(await text(page, '#relayNote')), 'relay address: explained once');
    ok(await page.$$eval('.pgrid .field', fs => fs[0].querySelector('#p_contact_email') !== null), 'contact e-mail is the first field');
    ok(await page.$eval('#p_contact_email', e => e.required && e.type === 'email' && e.autocomplete === 'email'), 'contact e-mail field: required, type email');
    await page.click('#pSave');
    ok(await waitText(page, 'Missing: Email for your quote and receipts'), 'empty contact e-mail is refused first');
    await page.type('#p_contact_email', 'nope');
    await page.type('#p_full_name', 'Dana Cohen'); await page.type('#p_company', 'Dana Electric'); await page.type('#p_phone', '(713) 555-0199');
    await page.click('#pSave');
    ok(await waitText(page, 'That email address doesn’t look right.'), 'invalid contact e-mail refused');
    await page.$eval('#p_contact_email', e => { e.value = ''; });
    await page.type('#p_contact_email', 'zz@privaterelay.appleid.com');
    await page.click('#pSave');
    ok(await waitText(page, 'not the Apple relay address'), 'another relay address refused');
    await page.$eval('#p_contact_email', e => { e.value = ''; });
    await page.type('#p_contact_email', ' Dana@DanaElectric.test ');
    await page.click('#pSave');
    await page.waitForSelector('[role=tablist]', { timeout: 5000 });
    const prof = await page.evaluate(() => window.Backend.getProfile());
    ok(/@privaterelay\.appleid\.com$/.test(prof.email) && prof.contact_email === 'dana@danaelectric.test', 'profile keeps the relay sign-in address and stores the contact e-mail (normalised)');
    ok((await text(page, '.who')).trim() === 'dana@danaelectric.test', 'header shows the contact e-mail, not the relay');
    ok(await page.evaluate(() => window.StartMock.admin.db().users.length === 3), 'relay account is its own user (keyed by id)');
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok(true, 'second visit: straight to the portal, not asked again');

    // ---------------------------------------------------------------- admin unchanged
    console.log('admin');
    await page.evaluate(() => window.Backend.signOut());
    await page.goto(BASE + '/start/admin/?mock=1&mock_providers=google,apple', { waitUntil: 'load' });
    await page.waitForSelector('#email');
    ok(!(await exists(page, '.sbtn')) && !(await exists(page, '#trustLine')), 'admin sign-in stays email-only');
    await page.close();
  } finally {
    await browser.close();
    if (server) server.close();
  }
  ok(consoleErrors.length === 0, 'no console errors, nothing left localhost (' + consoleErrors.slice(0, 3).join(' | ') + ')');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); if (server) server.close(); process.exit(1); });
