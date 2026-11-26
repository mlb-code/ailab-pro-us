// E2E for FirstRing monthly plans (2026-11-25) on the MOCK backend (same rules as 20261125100000_us_subscriptions.sql):
// sign up -> mock trial (provider-agnostic contract) -> tenant + checklist + number job created automatically -> runtime
// tick (dry-run number) -> checklist saves merge into the live config (prices parsed, cities kept, calendar gate,
// "messages only") -> forwarding test must come through the business line -> automatic go-live (no final payment) ->
// Billing: minutes used / included (trial cap, then plan), days left, upgrade / start now / cancel / restart -> message
// mode banner (minutes used up, cancelled) -> one trial per business phone -> admin "Subscriptions" tab (jobs, retry, money-back).
// Screenshots (1440 + 390) of the usage meter, the admin view and the message-mode state go to SHOTS_DIR.
//   node tools/e2e_subscription.mjs        (own static server on E2E_PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8963);
const SHOTS = process.env.SHOTS_DIR || '';
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
const plan = c => (pb.plans || []).find(p => p.code === c);
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
async function shot(page, name, sel) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const w of [1440, 390]) {
    await page.setViewport({ width: w, height: w === 390 ? 844 : 900 }); await sleep(150);
    if (sel) await page.$eval(sel, e => e.scrollIntoView({ block: 'start' })).catch(() => null);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: !sel });
  }
  await page.setViewport({ width: 390, height: 844 });
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
async function profile(page, company, phone) {
  await page.waitForSelector('#profileForm');
  await page.type('#p_full_name', 'Dana Miller'); await page.type('#p_company', company); await page.type('#p_phone', phone);
  await page.click('#pSave');
  await page.waitForSelector('[role=tablist]');
}
let nav = 0;   // a fresh query every time: a goto that only repeats the hash would not reload the page
const portal = async (page, tab) => { await page.goto(BASE + '/start/?r=' + (++nav) + (tab ? '#' + tab : ''), { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]'); await sleep(250); };
async function openStep(page, key) { await page.evaluate(k => { const d = document.querySelector('#ob-' + k); if (d && !d.open) d.open = true; }, key); await sleep(50); }
async function setVal(page, sel, v) { await page.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); }
async function click(page, sel) { await page.$eval(sel, b => b.click()); await sleep(300); }
const item = async (page, key) => (await db(page)).onboarding_items.find(o => o.key === key);
const tenantOf = async page => (await db(page)).tenants[0];

async function main() {
  await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await newPage(browser);
    ok(!!plan('FR_STARTER') && !!plan('FR_PRO') && !!plan('FR_BUSINESS'), 'price book has the three FirstRing plans');
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    await signIn(page, '/start/', 'dana@coolbreeze.test');
    await profile(page, 'Cool Breeze HVAC', '(713) 555-0100');

    // ---------------------------------------------------------------- sign-up: mock trial, everything created automatically
    console.log('signup');
    const r = await page.evaluate(() => window.Backend.mockCheckout('FR_PRO', 14));
    ok(r.status === 'trialing' && r.tenant_id, 'mock checkout: trialing subscription + tenant');
    await portal(page);
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Setup checklist,Requests,Quotes,Billing', 'plan client tabs');
    ok(/Pro is set up\. Free trial until/.test(await body(page)), 'home: plan + trial, no quote/deposit steps');
    let d = await db(page), t = d.tenants[0];
    ok(t.slug === 'cool-breeze-hvac' && t.status === 'sandbox' && !t.twilio_number && t.config.business.name === 'Cool Breeze HVAC' &&
       t.config.business.main_phone === '+17135550100' && t.config.notify.email[0] === 'dana@coolbreeze.test' && t.config.plan.code === 'FR_PRO' &&
       t.config.plan.status === 'trialing' && t.config.plan.service === 'full', 'tenant created from the sign-up profile with the plan block');
    ok(d.onboarding_items.sort((a, b) => a.sort - b.sort).map(o => o.key).join() === 'hours,faq,alerts,calendar,tools,forward_calls,sms', 'subscription checklist order (forward calls last)');
    ok(d.provisioning_jobs.length === 1 && d.provisioning_jobs[0].kind === 'number' && d.provisioning_jobs[0].status === 'pending', 'number job queued');
    const welcome = d.outbox.filter(m => ['trial_welcome', 'plan_welcome', 'admin_new_subscription'].includes(m.template)).map(m => m.template).sort().join();
    ok(welcome === 'admin_new_subscription,trial_welcome' && d.outbox.find(m => m.template === 'trial_welcome').to === 'dana@coolbreeze.test',
      'sign-up: trial_welcome to the customer + admin_new_subscription to Meir, once each');
    await page.click('#tab-onboarding'); await sleep(200);
    ok(/getting your receptionist’s phone number/.test(await body(page)), 'checklist: number on its way');
    ok(!/Request go-live/.test(await body(page)) && !/final payment/i.test(await body(page)), 'no Request go-live / final payment for plan clients');

    // ---------------------------------------------------------------- the runtime tick (dry run: fictional 555-01xx number)
    ok((await page.evaluate(() => window.StartMock.admin.runtimeTick())).done === 1, 'tick: number job done');
    t = await tenantOf(page);
    ok(/^\+171355501\d\d$/.test(t.twilio_number) && t.twilio_number !== t.config.business.main_phone, 'dry-run number near the area code (fictional 555-01xx), never the business line');
    await portal(page, 'onboarding');
    ok(/Go-live is automatic: finish the 5 steps left/.test(await body(page)), 'automatic go-live panel');

    // ---------------------------------------------------------------- checklist saves -> live config
    console.log('checklist');
    await openStep(page, 'hours');
    await page.select('#ob_tz', 'America/Chicago');
    await click(page, '[data-save="hours"]');
    await openStep(page, 'faq');
    await setVal(page, '#ob_services', 'AC repair, Furnace repair');
    await setVal(page, '#ob_area', '77005, 77006, Bellaire, Harris County');
    await page.$eval('input[name=ob_price][value=fixed]', x => x.click()); await sleep(50);
    await setVal(page, '#ob_prices', 'Service call: $89\nask us');
    await setVal(page, '#obf_q0', 'Do you service Trane units?'); await setVal(page, '#obf_a0', 'Yes, all major brands.');
    await click(page, '[data-save="faq"]');
    ok(/“ask us” needs a name and a price/.test(await page.$eval('#msg_faq', e => e.innerText)), 'unreadable price line: clear field error');
    await setVal(page, '#ob_prices', 'Service call: $89\nAC tune-up $79.99 (per unit)');
    await click(page, '[data-save="faq"]');
    t = await tenantOf(page);
    ok(t.config.pricing.mode === 'listed' && t.config.pricing.items.length === 2 && t.config.pricing.items[1].price_usd === 79.99 && t.config.pricing.items[1].note === 'per unit',
       'fixed prices parsed into pricing.items, straight into the live config');
    ok(t.config.business.service_area_zips.join() === '77005,77006' && t.config.business.service_area_places.join() === 'Bellaire,Harris County', 'ZIPs + cities/counties kept');
    ok(t.config.booking.job_types.join() === 'AC repair,Furnace repair' && t.config.faq[0].a === 'Yes, all major brands.', 'services + FAQ merged (no owner merge click)');
    await openStep(page, 'alerts');
    await setVal(page, '#ob_kw', 'gas smell, flooding');
    await click(page, '[data-save="alerts"]');
    ok((await item(page, 'alerts')).status === 'done' && (await tenantOf(page)).config.emergency.keywords.join() === 'gas smell,flooding', 'alerts merged');
    // invalid input: field error, nothing broken
    ok(await page.evaluate(() => window.Backend.listOnboarding().then(ob => window.Backend.updateOnboarding(ob.find(o => o.key === 'faq').id, 'done', { faq: [{ q: 'Q', a: 'y'.repeat(601) }] })).then(() => 'ok', e => e.message)) === 'invalid_setting:faq[0].a',
       'invalid FAQ answer refused with the field path');
    ok((await tenantOf(page)).config.faq[0].a === 'Yes, all major brands.', 'config unchanged after a refused save');

    // calendar: a link alone is not "connected"; explicit messages-only choice
    console.log('calendar');
    await openStep(page, 'calendar');
    await page.$eval('input[name=ob_prov][value=calendly]', x => x.click()); await sleep(50);
    await setVal(page, '#ob_cly', 'https://calendly.com/coolbreeze/service-call');
    await click(page, '[data-save="calendar"]');
    ok((await item(page, 'calendar')).status === 'todo' && /Link saved\. Last step: press “Connect Calendly account”/.test(await body(page)), 'Calendly link alone: step stays open');
    ok(await page.evaluate(() => window.Backend.listOnboarding().then(ob => window.Backend.updateOnboarding(ob.find(o => o.key === 'calendar').id, 'done', { provider: 'google' })).then(() => 'ok', e => e.message)) === 'calendar_not_connected',
       'calendar gate: done refused without a connected calendar');
    await openStep(page, 'calendar');
    await page.$eval('input[name=ob_prov][value=none]', x => x.click()); await sleep(50);
    await click(page, '#ob_calnone');
    ok((await item(page, 'calendar')).status === 'done' && (await tenantOf(page)).config.booking.enabled === false, '"take messages only": step done, booking off');
    await openStep(page, 'tools'); await click(page, '#ob_skip');

    // forwarding: the test call must come through the business line
    console.log('forwarding');
    await openStep(page, 'forward_calls');
    ok(/Try it first/.test(await body(page)) && /call your <?b?>?business/i.test(await page.$eval('#ob-forward_calls', e => e.innerText)), 'forward step: try it first, then the test via the business number');
    await click(page, '#ob_test'); await sleep(200);
    const tid = (await tenantOf(page)).id;
    await page.evaluate(id => window.StartMock.admin.simulateCall(id, { forwardedFrom: '+18325550000' }), tid); await sleep(1600);
    ok((await item(page, 'forward_calls')).status !== 'done' && /forwarded from \(832\) 555-0000, not from your business number/.test(await body(page)), 'call from another line: not accepted, explained');
    await page.evaluate(id => window.StartMock.admin.simulateCall(id, { forwardedFrom: null, from: '+17135550100' }), tid); await portal(page, 'onboarding'); await openStep(page, 'forward_calls');
    if (!/came straight from your business phone/.test(await body(page))) console.log('    debug', JSON.stringify((await item(page, 'forward_calls')).data), (await page.$eval('#ob-forward_calls', e => e.innerText)).slice(-400));
    ok(/came straight from your business phone/.test(await body(page)), 'direct call from the business phone: explained, no confirm button');
    await page.evaluate(id => window.StartMock.admin.simulateCall(id, { forwardedFrom: null, from: '+12815550177' }), tid); await portal(page, 'onboarding'); await openStep(page, 'forward_calls');
    ok(await page.$('#ob_fwdconfirm') !== null, 'no carrier data: the client can confirm the call came through the business number');
    await click(page, '#ob_fwdconfirm'); await sleep(300);
    d = await db(page);
    ok(d.onboarding_items.find(o => o.key === 'forward_calls').data.verified === 'self_confirmed', 'forwarding confirmed (self_confirmed)');
    ok(d.clients[0].status === 'testing' && d.provisioning_jobs.some(j => j.kind === 'golive_sim' && j.status === 'pending'), 'checklist done (texting optional): testing + go-live check queued');
    await portal(page, 'onboarding');
    ok(/running automatic test calls/.test(await body(page)), 'portal: final checks running');

    // ---------------------------------------------------------------- automatic go-live
    console.log('go-live');
    await page.evaluate(() => window.StartMock.admin.runtimeTick());
    d = await db(page);
    ok(d.clients[0].status === 'live' && d.tenants[0].status === 'live', 'go-live check passed + trialing: client and tenant live, no owner step');
    const tpl = d.outbox.map(m => m.template);
    ok(tpl.includes('ready_to_test') && tpl.includes('went_live') && !tpl.includes('final_payment_due'), 'ready_to_test + went_live e-mails, no final payment');
    await portal(page);
    ok(/You’re live on Pro/.test(await body(page)), 'home: live on the plan');

    // ---------------------------------------------------------------- Billing: minutes per plan, trial cap, upgrade
    console.log('billing');
    const pro = plan('FR_PRO'), biz = plan('FR_BUSINESS');
    await portal(page, 'billing');
    ok(new RegExp('0 of ' + pro.trial_minutes + ' min').test(await page.$eval('#planMinutes', e => e.innerText)), 'trial: minutes of the trial cap (price book)');
    ok(/1[34] days left in this trial/.test(await page.$eval('#planDays', e => e.innerText)), 'days left in the period');
    await page.evaluate(id => window.StartMock.admin.setUsage(id, 85), tid); await portal(page, 'billing');
    ok((await page.$eval('#planMinutes', e => e.innerText)).startsWith('85 of') && await page.$('.plan .bar i.is-high') !== null, '85% of the trial: high bar');
    ok(await page.$('[data-plan-act="upgrade"][data-plan="FR_BUSINESS"]') !== null, 'upgrade button to the next plan');
    await shot(page, 'portal-usage-meter', '#planH');
    await click(page, '[data-plan-act="upgrade"]'); await sleep(300);
    ok((await db(page)).subscriptions[0].plan_code === 'FR_BUSINESS' && (await tenantOf(page)).config.plan.code === 'FR_BUSINESS', 'mock upgrade applied immediately');
    // trial minutes used up -> message mode until the plan starts
    await page.evaluate(id => window.StartMock.admin.setUsage(id, 100), tid); await portal(page, 'billing');
    ok(/in message mode/.test(await body(page)) && /until your trial ends or you start your paid plan/.test(await body(page)), 'trial cap reached: message-mode banner (runtime rule)');
    await click(page, '#panel [data-plan-act="start"]'); await sleep(300);
    d = await db(page);
    ok(d.subscriptions[0].status === 'active' && d.tenants[0].config.plan.status === 'active', 'start my paid plan now');
    await portal(page, 'billing');
    ok(new RegExp('0 of ' + Number(biz.included_usage.voice_minutes).toLocaleString('en-US') + ' min').test(await page.$eval('#planMinutes', e => e.innerText)) &&
       !/in message mode/.test(await body(page)), 'paid period: new counter with the plan minutes, full answering');
    ok((await overflow(page)).length === 0, 'billing: no overflow');
    // downgrade from the next period
    ok((await page.evaluate(() => window.Backend.changePlan('FR_STARTER'))).scheduled === true && (await db(page)).subscriptions[0].scheduled_plan_code === 'FR_STARTER', 'downgrade scheduled for the next period');
    // cancel at period end -> message mode after it
    await portal(page, 'billing');
    await click(page, '[data-plan-act="cancel"]'); await sleep(300);
    ok(/Cancelled: works until/.test(await body(page)), 'cancel: works until the end of the paid period');
    d = await db(page);
    ok(d.outbox.filter(m => m.template === 'admin_subscription_canceled' && m.kind === 'scheduled').length === 1 &&
       !d.outbox.some(m => m.template === 'plan_welcome'), 'cancel: one Hebrew alert to Meir; "start paid plan now" was not a new sign-up mail');
    await page.evaluate(() => window.StartMock.admin.billing({ current_period_end: new Date(Date.now() - 60000).toISOString(), scheduled_plan_code: null }));
    await portal(page, 'billing');
    d = await db(page);
    ok(d.tenants[0].config.plan.service === 'message_only' && d.tenants[0].config.plan.service_reason === 'canceled' && d.clients[0].status === 'paused', 'period over: message mode, client paused');
    ok(/Your receptionist is in message mode/.test(await body(page)) && /Turn off call forwarding/i.test(await body(page)), 'message-mode banner with how to turn forwarding off');
    ok(d.outbox.some(m => m.template === 'subscription_message_mode'), 'message-mode e-mail queued');
    await shot(page, 'portal-message-mode', '#mmH');
    await click(page, '#panel [data-plan-act="resume"]'); await sleep(300);
    d = await db(page);
    ok(d.tenants[0].config.plan.service === 'full' && d.clients[0].status === 'live' && d.outbox.some(m => m.template === 'subscription_restored'), 'restart: full answering, live, restored e-mail');

    // ---------------------------------------------------------------- one trial per business phone
    console.log('one trial');
    await page.evaluate(() => window.Backend.signOut());
    await signIn(page, '/start/', 'copy@cat.test');
    await profile(page, 'Copycat HVAC', '713-555-0100');
    ok(await page.evaluate(() => window.Backend.mockCheckout('FR_STARTER', 14).then(() => 'ok', e => e.message)) === 'trial_already_used', 'second trial for the same business phone refused');

    // ---------------------------------------------------------------- admin "Subscriptions"
    console.log('admin');
    await page.evaluate(() => window.Backend.signOut());
    await signIn(page, '/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
    await page.waitForSelector('#digest');
    await page.goto(BASE + '/start/admin/#subscriptions', { waitUntil: 'load' });
    await page.waitForSelector('.subs .sub', { timeout: 5000 });
    let txt = await page.$eval('#subsBody', e => e.innerText);
    ok(txt.includes('Cool Breeze HVAC') && txt.includes(biz.name) && txt.includes('Phone number') && txt.includes('Go-live check') && txt.includes('Done'), 'admin: subscription, plan, jobs');
    ok(txt.includes('Dry run') && txt.includes('Not used'), 'admin: dry-run flag + money-back not used');
    await click(page, '[data-moneyback]'); await sleep(300);
    txt = await page.$eval('#subsBody', e => e.innerText);
    ok(/Used on /.test(txt), 'admin: money-back recorded');
    await click(page, '[data-retry="golive_sim"]'); await sleep(300);
    ok((await db(page)).provisioning_jobs.find(j => j.kind === 'golive_sim').status === 'pending', 'admin: retry queues the job again');
    ok((await overflow(page)).length === 0, 'admin subscriptions: no overflow');
    await sleep(3500);   // let the toast go before the screenshot
    await shot(page, 'admin-subscriptions');
    ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
