// E2E for the monthly-plan sign-up (2026-11-26) on the MOCK backend:
//   A. Paddle off (default, brand.json as shipped): /start/?plan=FR_X -> sign in -> "Your business" (plan switch, fields,
//      consent required, no em dashes) -> "Your card" with the demo card box -> portal home with the setup checklist running.
//      All three plans; one trial per business phone (ineligible -> "Start paid plan", charged today); no plan in the URL ->
//      the three plans on the portal home; an account with a running plan goes to Billing.
//   B. Paddle on (brand.json served with test values, Paddle.js FAKED locally: nothing reaches paddle.com): Paddle.js loads
//      only on the card step, sandbox + client token, inline checkout with the trial price, customer e-mail, customData ref;
//      payment failure stays on the screen; completed -> "setting up" wait until the webhook (mock) made the subscription.
//      Portal Billing actions for a Paddle subscription (what goes to Paddle: db.paddle_calls), and the admin Paddle ids,
//      dashboard link and 30-day refund button.
// SHOTS_DIR=<dir> saves screenshots of each screen at 1440 and 390.
//   node tools/e2e_signup.mjs        (own static server on E2E_PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8964);
const SHOTS = process.env.SHOTS_DIR || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
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
const brand = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));
const plan = c => pb.plans.find(p => p.code === c);
const usd = c => '$' + (c / 100).toLocaleString('en-US');
const pid = s => 'pri_' + s.padEnd(26, '0');
const PRICES = { FR_STARTER: { trial: pid('startertrial'), paid: pid('starterpaid') }, FR_PRO: { trial: pid('protrial'), paid: pid('propaid') }, FR_BUSINESS: { trial: pid('biztrial'), paid: pid('bizpaid') } };
const TOKEN = 'test_' + 'e2etoken'.repeat(3);
const BRAND_ON = JSON.stringify({ ...brand, payments: { ...brand.payments, paddle: { ...brand.payments.paddle, enabled: true, env: 'sandbox', client_token: TOKEN, prices: PRICES } } });
// stand-in for https://cdn.paddle.com/paddle/v2/paddle.js: records the calls, draws a stub where Paddle's iframe would be
const FAKE_PADDLE = `window.__pd = { loads: (window.__pd && window.__pd.loads || 0) + 1 };
window.Paddle = {
  Environment: { set: e => { window.__pd.env = e; } },
  Initialize: o => { window.__pd.init = o; },
  Checkout: { open: o => {
    window.__pd.open = JSON.parse(JSON.stringify(o));
    const el = document.querySelector('.' + o.settings.frameTarget);
    el.innerHTML = '<div class="fake-paddle" style="border:1px solid #CBC8BD;border-radius:10px;padding:18px;min-height:410px;background:#fff;font:15px system-ui">' +
      '<b>Paddle checkout (test stub)</b><p style="color:#555">Paddle&#39;s secure card form loads here in an iframe: email, card number, expiry, CVC, country and ZIP.</p>' +
      '<div style="height:44px;border:1px solid #ddd;border-radius:6px;margin:10px 0"></div><div style="height:44px;border:1px solid #ddd;border-radius:6px;margin:10px 0"></div>' +
      '<div style="height:44px;background:#3D2BFF;border-radius:6px;margin-top:18px;color:#fff;display:flex;align-items:center;justify-content:center">Start trial</div></div>';
    window.__pd.init.eventCallback({ name: 'checkout.loaded', data: {} });
  } }
};
window.__pd.complete = () => window.__pd.init.eventCallback({ name: 'checkout.completed', data: { transaction_id: 'txn_e2e', status: 'completed', customer: { email: window.__pd.open.customer.email } } });
window.__pd.fail = () => window.__pd.init.eventCallback({ name: 'checkout.payment.failed', data: {} });`;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
let paddleRequests = 0;
async function newPage(browser, { paddle = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.emulateTimezone('America/Chicago');
  await page.evaluateOnNewDocument(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return {}; }; });
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    if (/cdn\.paddle\.com\/paddle\/v2\/paddle\.js$/.test(u)) { paddleRequests++; return r.respond({ status: 200, contentType: 'text/javascript', body: FAKE_PADDLE }); }
    if (/paddle\.com/.test(u)) return r.respond({ status: 599, body: 'blocked in tests' });
    if (paddle && u.startsWith(BASE + '/assets/brand.json')) return r.respond({ status: 200, contentType: 'application/json', body: BRAND_ON });
    return r.continue();
  });
  page.on('console', m => { if (m.type() === 'error' && !/blocked in tests/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('uncaught: ' + e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const body = page => page.evaluate(() => document.body.innerText);
const text = (page, sel) => page.$eval(sel, e => e.innerText).catch(() => '');
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
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const w of [1440, 390]) {
    await page.setViewport({ width: w, height: w === 390 ? 844 : 900 }); await sleep(200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewport({ width: 390, height: 844 });
}
async function signIn(page, url, email) {
  await page.goto(BASE + url + (url.includes('?') ? '&' : '?') + 'mock=1', { waitUntil: 'load' });
  await page.waitForSelector('#email');
  await page.type('#email', email); await page.click('#sendBtn');
  await page.waitForSelector('#mockCode');
  const code = await page.$eval('#mockCode', e => e.textContent);
  await page.type('#code', code);
  if (url.indexOf('admin') !== -1) { await page.click('#verifyBtn'); return; }
  await page.waitForFunction(() => !document.querySelector('#codeForm'), { timeout: 6000 });
}
async function setVal(page, sel, v) { await page.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); }
async function click(page, sel) { await page.$eval(sel, b => b.click()); await sleep(250); }
async function fill(page, { name = 'Dana Miller', company, phone }) {
  await page.waitForSelector('#suForm');
  await setVal(page, '#su_name', name); await setVal(page, '#su_company', company); await setVal(page, '#su_phone', phone);
}
async function signOut(page) { await page.evaluate(() => window.Backend.signOut()); }
let nav = 0;
const portal = async (page, tab) => { await page.goto(BASE + '/start/?r=' + (++nav) + (tab ? '#' + tab : ''), { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]'); await sleep(250); };
const dateIn = days => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }).format(new Date(Date.now() + days * 86400000));

async function main() {
  await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    // ================================================================ A. Paddle off: demo card
    let page = await newPage(browser);
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    console.log('login (plan intent)');
    await page.goto(BASE + '/start/?plan=FR_STARTER&niche=home_services&mock=1', { waitUntil: 'load' });
    await page.waitForSelector('#email');
    ok(/Start your free trial\./.test(await body(page)) && (await page.$eval('main .eyebrow', e => e.textContent)).startsWith(plan('FR_STARTER').name + ' · ' + usd(plan('FR_STARTER').monthly_cents) + '/mo'), 'sign-in screen speaks about the chosen plan + free trial');
    ok(!/fixed quote/i.test(await text(page, 'main')), 'no quote wording on the plan sign-in');
    await shot(page, 'signup-1-signin');
    await page.type('#email', 'dana@coolbreeze.test'); await page.click('#sendBtn');
    await page.waitForSelector('#mockCode');
    await page.type('#code', await page.$eval('#mockCode', e => e.textContent));
    await page.waitForSelector('#suForm', { timeout: 6000 });
    console.log('your business');
    ok(await page.$eval('input[name=su_plan][value=FR_STARTER]', e => e.checked), 'plan from the URL preselected');
    ok((await page.$$eval('input[name=su_plan]', i => i.map(x => x.value))).join() === 'FR_STARTER,FR_PRO,FR_BUSINESS', 'three plans to switch between');
    ok(await page.$eval('input[name=su_niche][value=home_services]', e => e.checked), 'niche from the URL');
    ok(await page.$('#suTzLine') !== null && await page.$eval('#suTzField', e => e.hidden), 'US time zone detected: shown as a line, no extra field');
    const sum = await text(page, '#suSumBox');
    ok(sum.includes(usd(0)) && sum.includes(usd(plan('FR_STARTER').monthly_cents) + ' on ' + dateIn(plan('FR_STARTER').trial_days)) && sum.includes(plan('FR_STARTER').trial_minutes + ' min'), 'summary: $0 today, first charge + date, trial minutes [' + sum.replace(/\n/g, ' ') + ']');
    ok((await text(page, '#suGo')) === 'Start ' + plan('FR_STARTER').trial_days + '-day free trial', 'button: Start 14-day free trial');
    ok(!/—/.test(await body(page)), 'no em dashes on the sign-up screen');
    await shot(page, 'signup-2-business');
    await click(page, '#suGo');
    ok(/Please add your name/.test(await text(page, '#suMsg')), 'name required');
    await fill(page, { company: 'Cool Breeze HVAC', phone: '12345' });
    await click(page, '#suGo');
    ok(/US business phone/.test(await text(page, '#suMsg')), 'non-US / short phone refused');
    await setVal(page, '#su_phone', '(713) 555-0100');
    await click(page, '#suGo');
    ok(/tick the box/.test(await text(page, '#suMsg')) && (await db(page)).billing_checkouts.length === 0, 'consent required: nothing started without the box');
    // plan switch on the screen
    await page.$eval('input[name=su_plan][value=FR_BUSINESS]', x => x.click()); await sleep(80);
    ok((await text(page, '#suSumBox')).includes(usd(plan('FR_BUSINESS').monthly_cents)) && (await text(page, '#suConsentBox')).includes(usd(plan('FR_BUSINESS').monthly_cents) + ' each month'), 'switch plan: summary + consent follow');
    await page.$eval('input[name=su_plan][value=FR_PRO]', x => x.click()); await sleep(80);
    await click(page, '#suConsent');
    ok((await overflow(page)).length === 0, 'your business: no overflow (375-1280)');
    await click(page, '#suGo');
    await page.waitForSelector('#payStub', { timeout: 5000 });
    console.log('your card (demo)');
    let d = await db(page);
    const ck = d.billing_checkouts[0];
    ok(ck && ck.plan_code === 'FR_PRO' && ck.trial === true && ck.business_phone === '+17135550100' && ck.agreement_version === brand.agreement_version &&
       ck.consent_text.includes('Service Agreement (version ' + brand.agreement_version + ')') && ck.consent_text.includes(usd(plan('FR_PRO').monthly_cents)), 'checkout row: plan, trial, phone, agreement version, consent sentence');
    const pr = d.profiles.find(p => p.email === 'dana@coolbreeze.test');
    ok(pr.full_name === 'Dana Miller' && pr.company === 'Cool Breeze HVAC' && pr.phone === '(713) 555-0100' && pr.niche === 'home_services' && pr.timezone === 'America/Chicago', 'profile saved from the sign-up screen');
    ok((await text(page, '.lead')).startsWith(usd(0) + ' today. Your first charge of ' + usd(plan('FR_PRO').monthly_cents) + ' is on ' + dateIn(14)), 'card step: $0 today + the first charge date');
    ok(paddleRequests === 0, 'Paddle off: Paddle.js never loaded');
    ok(/Demo checkout/.test(await text(page, '#payStub')), 'clearly marked demo card box');
    await shot(page, 'signup-3-card-demo');
    await click(page, '#suBack');
    ok(await page.$('#suForm') !== null && await page.$eval('input[name=su_plan][value=FR_PRO]', e => e.checked), 'Back keeps the choices');
    await click(page, '#suConsent'); await click(page, '#suGo');
    await page.waitForSelector('#demoPay');
    await click(page, '#demoPay');
    await page.waitForSelector('[role=tablist]', { timeout: 6000 }); await sleep(300);
    d = await db(page);
    ok(d.subscriptions.length === 1 && d.subscriptions[0].plan_code === 'FR_PRO' && d.subscriptions[0].status === 'trialing' && d.tenants.length === 1 && d.provisioning_jobs.length === 1, 'trial started: subscription + tenant + number job (automation running)');
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).includes('Setup checklist') && /Pro is set up\. Free trial until/.test(await body(page)), 'portal home with the setup checklist');
    await shot(page, 'signup-4-portal-home');
    // a running plan + a plan link again -> Billing
    await page.goto(BASE + '/start/?plan=FR_STARTER&r=1', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]'); await sleep(300);
    ok((await page.$eval('#tab-billing', t => t.getAttribute('aria-selected'))) === 'true' && (await db(page)).subscriptions.length === 1, 'already subscribed: Billing, no second sign-up');

    console.log('starter + business');
    for (const [code, email, phone] of [['FR_STARTER', 'sam@starter.test', '(312) 555-0111'], ['FR_BUSINESS', 'bo@business.test', '(212) 555-0122']]) {
      await signOut(page);
      await signIn(page, '/start/?plan=' + code + '&niche=real_estate', email);
      await fill(page, { company: code + ' Realty', phone });
      ok(await page.$eval('input[name=su_niche][value=real_estate]', e => e.checked), code + ': real-estate niche kept');
      await click(page, '#suConsent'); await click(page, '#suGo');
      await page.waitForSelector('#demoPay'); await click(page, '#demoPay');
      await page.waitForSelector('[role=tablist]', { timeout: 6000 });
      d = await db(page);
      const c = d.clients.find(x => x.user_id === d.profiles.find(p => p.email === email).id);
      const s = d.subscriptions.find(x => x.client_id === c.id);
      ok(s && s.plan_code === code && s.status === 'trialing' && d.tenants.find(t => t.client_id === c.id).config.business.niche === 'real_estate', code + ': trial on the right plan, real-estate tenant');
    }

    console.log('one trial per phone');
    await signOut(page);
    await signIn(page, '/start/?plan=FR_PRO', 'copy@cat.test');
    await fill(page, { company: 'Copycat HVAC', phone: '713-555-0100' });
    const rowsBefore = (await db(page)).billing_checkouts.length;
    await click(page, '#suConsent'); await click(page, '#suGo'); await sleep(300);
    ok(/already had a free trial/.test(await text(page, '#suTrialNote')) && (await text(page, '#suGo')) === 'Start paid plan · ' + usd(plan('FR_PRO').monthly_cents) + '/mo', 'ineligible: Start paid plan, no trial');
    ok(!(await page.$eval('#suConsent', e => e.checked)) && (await text(page, '#suConsentBox')).includes('charged ' + usd(plan('FR_PRO').monthly_cents) + ' today'), 'paid wording: consent re-ticked, charged today');
    ok((await db(page)).billing_checkouts.length === rowsBefore, 'no checkout row before the paid consent');
    await shot(page, 'signup-5-paid-no-trial');
    await click(page, '#suConsent'); await click(page, '#suGo');
    await page.waitForSelector('#demoPay');
    ok((await text(page, '.lead')).startsWith(usd(plan('FR_PRO').monthly_cents) + ' today'), 'card step: charged today');
    await click(page, '#demoPay');
    await page.waitForSelector('[role=tablist]', { timeout: 6000 });
    d = await db(page);
    ok(d.billing_checkouts.find(x => x.user_id === d.profiles.find(p => p.email === 'copy@cat.test').id && x.trial === false) && d.subscriptions.some(s => s.status === 'active' && s.business_phone === '+17135550100' && !s.trial_duplicate), 'paid plan started, no duplicate trial');
    ok(await page.evaluate(() => window.Backend.checkoutStart('FR_PRO', '7135550100', '2.0', 'I agree to the Terms of Service and the Service Agreement.', false).then(() => 'ok', e => e.message)) === 'already_subscribed', 'server rule: one plan per account');
    ok(/consent_required/.test(await page.evaluate(() => window.Backend.checkoutStart('FR_PRO', '3125550999', '2.0', '', true).then(() => 'ok', e => e.message))), 'server rule: consent required');

    console.log('no plan in the URL');
    await signOut(page);
    await signIn(page, '/start/', 'pick@plans.test');
    await page.waitForSelector('#profileForm');
    await page.type('#p_full_name', 'Pat Pick'); await page.type('#p_company', 'Pick Plumbing'); await page.type('#p_phone', '(404) 555-0133');
    await page.click('#pSave');
    await page.waitForSelector('#pickH');
    ok((await page.$$eval('[data-pick]', b => b.map(x => x.dataset.pick))).join() === 'FR_STARTER,FR_PRO,FR_BUSINESS' && /Need a business website instead\?/.test(await body(page)) && await page.$('#startQ') !== null,
       'portal home: the three plans first, the website questionnaire below');
    ok((await overflow(page)).length === 0, 'plan picker: no overflow');
    await shot(page, 'signup-0-pick-plan');
    await click(page, '[data-pick="FR_BUSINESS"]');
    await page.waitForSelector('#suForm');
    ok(await page.$eval('input[name=su_plan][value=FR_BUSINESS]', e => e.checked) && (await page.$eval('#su_phone', e => e.value)) === '(404) 555-0133', 'picked plan opens the sign-up, profile prefilled');
    await page.close();

    // ================================================================ B. Paddle on (fake Paddle.js)
    console.log('paddle checkout');
    page = await newPage(browser, { paddle: true });
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' }); await signOut(page);
    paddleRequests = 0;
    await signIn(page, '/start/?plan=FR_PRO&niche=home_services', 'pia@paddle.test');
    await fill(page, { name: 'Pia Paddle', company: 'Paddle Heating', phone: '(512) 555-0144' });
    ok(paddleRequests === 0, 'Paddle.js not loaded on sign-in / business screen');
    await click(page, '#suConsent'); await click(page, '#suGo');
    await page.waitForSelector('.fake-paddle', { timeout: 6000 });
    const pd = await page.evaluate(() => window.__pd);
    d = await db(page);
    const ref = d.billing_checkouts.find(x => x.business_phone === '+15125550144').ref;
    const uid = d.profiles.find(p => p.email === 'pia@paddle.test').id;
    ok(paddleRequests === 1 && pd.env === 'sandbox' && pd.init.token === TOKEN, 'Paddle.js loaded on the card step only: sandbox + client-side token');
    ok(pd.open.items.length === 1 && pd.open.items[0].priceId === PRICES.FR_PRO.trial && pd.open.items[0].quantity === 1, 'checkout: the trial price of the chosen plan');
    ok(pd.open.customer.email === 'pia@paddle.test' && pd.open.customData.ref === ref && pd.open.customData.user_id === uid && pd.open.customData.business_phone === '+15125550144', 'customer e-mail prefilled, customData ref + user id + business phone');
    ok(pd.open.settings.displayMode === 'inline' && pd.open.settings.frameTarget === 'paddle-frame' && pd.open.settings.allowLogout === false, 'inline checkout in the page');
    ok(await page.$('#payStub') === null && !/Demo checkout/.test(await body(page)), 'no demo box when Paddle is on');
    await shot(page, 'signup-3-card-paddle');
    await page.evaluate(() => window.__pd.fail()); await sleep(150);
    ok(/didn’t go through/.test(await text(page, '#payMsg')) && await page.$('.fake-paddle') !== null, 'payment failed: message, still on the card step');
    await page.evaluate(() => window.__pd.complete()); await sleep(400);
    ok(await page.$('#payWait') !== null && /Setting up your account/.test(await body(page)), 'completed: friendly waiting state while the webhook lags');
    await shot(page, 'signup-3b-waiting');
    ok((await db(page)).subscriptions.filter(s => s.provider === 'paddle').length === 0, 'nothing written by the browser: the webhook writes');
    await page.evaluate(r => window.StartMock.admin.paddleWebhook({ ref: r, subscription_id: 'sub_e2epaddle000000000000001' }), ref);
    await page.waitForSelector('[role=tablist]', { timeout: 8000 });
    d = await db(page);
    let ps = d.subscriptions.find(s => s.provider === 'paddle');
    ok(ps && ps.status === 'trialing' && ps.plan_code === 'FR_PRO' && d.billing_checkouts.find(x => x.ref === ref).status === 'completed', 'webhook -> trialing subscription -> portal home');

    console.log('portal billing (paddle)');
    await portal(page, 'billing');
    ok(await page.$('[data-plan-act="card"]') !== null && await page.$('[data-plan-act="manage"]') !== null, 'Paddle plan: Update card + Receipts');
    await click(page, '[data-plan-act="upgrade"]'); await sleep(2800);
    d = await db(page); ps = d.subscriptions.find(s => s.provider === 'paddle');
    ok(ps.plan_code === 'FR_BUSINESS' && d.paddle_calls.at(-1).body.proration_billing_mode === 'do_not_bill', 'trial upgrade: Paddle do_not_bill, plan now');
    await portal(page, 'billing');
    await click(page, '#panel [data-plan-act="start"]'); await sleep(2800);
    d = await db(page); ps = d.subscriptions.find(s => s.provider === 'paddle');
    ok(ps.status === 'active' && d.paddle_calls.at(-1).path.endsWith('/activate'), 'start paid plan now: Paddle activate');
    await portal(page, 'billing');
    await page.$eval('#planChange', e => { e.open = true; }); await sleep(50);
    await click(page, '#planChange [data-plan-act="downgrade"][data-plan="FR_STARTER"]'); await sleep(2800);
    d = await db(page); ps = d.subscriptions.find(s => s.provider === 'paddle');
    ok(ps.plan_code === 'FR_BUSINESS' && ps.scheduled_plan_code === 'FR_STARTER' && d.paddle_calls.at(-1).body.proration_billing_mode === 'full_next_billing_period', 'downgrade: next billing date, nothing charged now');
    await portal(page, 'billing');
    ok(/Changes to Starter on/.test(await text(page, '#planSched')), 'billing shows the scheduled change');
    await shot(page, 'portal-billing-paddle');
    await click(page, '[data-plan-act="keep"]'); await sleep(2800);
    ok((await db(page)).subscriptions.find(s => s.provider === 'paddle').scheduled_plan_code === null, 'Keep my plan: scheduled downgrade undone');
    await portal(page, 'billing');
    await click(page, '[data-plan-act="card"]'); await sleep(200);
    ok((await page.evaluate(() => window.__opened)).some(u => /paddle_portal=card/.test(u)) && (await db(page)).paddle_calls.at(-1).path.endsWith('/portal-sessions'), 'Update card: Paddle customer-portal link in a new tab');
    await click(page, '[data-plan-act="cancel"]'); await sleep(2800);
    d = await db(page); ps = d.subscriptions.find(s => s.provider === 'paddle');
    ok(ps.cancel_at_period_end && d.paddle_calls.at(-1).body.effective_from === 'next_billing_period', 'cancel: end of the paid period');
    await portal(page, 'billing');
    ok(/Cancelled: works until/.test(await text(page, '#planStatus')), 'billing: works until the period end');
    await click(page, '[data-plan-act="resume"]'); await sleep(2800);
    d = await db(page);
    ok(!d.subscriptions.find(s => s.provider === 'paddle').cancel_at_period_end && JSON.stringify(d.paddle_calls.at(-1).body) === '{"scheduled_change":null}', 'Keep my plan after cancel: scheduled change removed');
    await portal(page, 'billing');
    ok((await overflow(page)).length === 0, 'billing (paddle): no overflow');
    await page.evaluate(() => window.StartMock.admin.paddleFirstCharge(5));

    console.log('admin (paddle)');
    await signOut(page);
    await signIn(page, '/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
    await page.waitForSelector('#digest');
    await page.goto(BASE + '/start/admin/#subscriptions', { waitUntil: 'load' });
    await page.waitForSelector('.subs .sub', { timeout: 6000 });
    let txt = await page.$eval('#subsBody', e => e.innerText);
    ok(txt.includes('sub_e2epaddle000000000000001') && /פתח את המנוי ב-Paddle/.test(txt) && await page.$('[data-paddle-link][href^="https://sandbox-vendors.paddle.com/"]') !== null, 'admin: Paddle ids + sandbox dashboard link');
    ok(/חיוב ראשון/.test(txt) && /פתוח עד/.test(txt) && await page.$('[data-paddlerefund]') !== null, 'admin: first charge date, window open, refund button');
    await shot(page, 'admin-paddle-subscription');
    await click(page, '[data-paddlerefund]'); await sleep(400);
    d = await db(page); ps = d.subscriptions.find(s => s.provider === 'paddle');
    ok(ps.money_back_used_at && ps.status === 'canceled' && d.paddle_calls.some(c => c.path === '/adjustments' && c.body.type === 'full'), 'refund: full refund in Paddle, plan ended, recorded once');
    txt = await page.$eval('#subsBody', e => e.innerText);
    ok(/נוצל ב-/.test(txt) && await page.$('[data-paddlerefund]') === null, 'admin: refund used, button gone');
    ok((await overflow(page)).length === 0, 'admin: no overflow');
    await page.close();
    ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
