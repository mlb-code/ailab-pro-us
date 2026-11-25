// E2E for FirstRing phase 2 (2026-11-25) on the MOCK backend (same rules as 20261125200000_us_firstring_p2.sql):
//   Spanish: "Answer in Spanish too" in My receptionist -> on by default on Pro, saved straight into the live config,
//            remembered across a downgrade (locked "Available on Pro" on Starter) and an upgrade;
//   number release: cancelled plan -> scheduled release (30 days after the end, warning 7 days before) -> admin
//            "postpone 14 days" / "release now" (confirm) -> dry-run tick holds it -> resubscribing cancels it;
//            phase 3: the customer's Billing card + home status say until when the number is kept, with ONE restart button,
//            nothing when no release is scheduled; the button restarts the plan and the line goes away;
//   go-live live AI check: a failed scripted test call keeps the client in testing; the admin sees problems, cost and the
//            transcript and approves by hand.
// SHOTS_DIR=<dir> saves p2-* (and p3-portal-release-*) screenshots at 1440 and 390.
//   node tools/e2e_firstring_p2.mjs        (own static server on E2E_PORT)
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
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  return page;
}
const dialogs = [];
const body = page => page.evaluate(() => document.body.innerText);
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
    if (sel) await page.$eval(sel, e => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, Math.max(0, e.getBoundingClientRect().top + window.scrollY - 90)); }).catch(() => null);
    await sleep(250);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: false });
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
let nav = 0;
const portal = async (page, tab) => { await page.goto(BASE + '/start/?r=' + (++nav) + (tab ? '#' + tab : ''), { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]'); await sleep(250); };
const admin = async page => { await page.goto(BASE + '/start/admin/?r=' + (++nav) + '#subscriptions', { waitUntil: 'load' }); await page.waitForSelector('.subs .sub', { timeout: 6000 }); await sleep(300); };
async function click(page, sel) { await page.$eval(sel, b => b.click()); await sleep(350); }
// a new plan client, its checklist finished through the API (the checklist UI itself is covered by e2e_subscription)
async function newClient(page, email, company, phone, code) {
  await signOut(page).catch(() => null);
  await signIn(page, '/start/', email);
  await profile(page, company, phone);
  const r = await page.evaluate(c => window.Backend.mockCheckout(c, 14), code);
  await page.evaluate(() => window.StartMock.admin.runtimeTick());   // dry-run number
  await page.evaluate(async () => {
    const ob = await window.Backend.listOnboarding();
    for (const o of ob.filter(x => ['tools', 'sms'].indexOf(x.key) === -1)) {
      await window.Backend.updateOnboarding(o.id, 'done', o.key === 'calendar' ? { booking_mode: 'messages_only', provider: '' } : {});
    }
  });
  return r;
}
const signOut = async page => { await page.goto(BASE + '/start/?mock=1&r=' + (++nav), { waitUntil: 'load' }); await page.evaluate(() => window.Backend.signOut()); };
const myTenant = async (page, cid) => (await db(page)).tenants.find(t => t.client_id === cid);

async function main() {
  await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await newPage(browser);
    const pro = plan('FR_PRO'), starter = plan('FR_STARTER'), biz = plan('FR_BUSINESS');
    ok(pro.features.includes('spanish') && biz.features.includes('spanish') && !starter.features.includes('spanish'), 'price book: Spanish on Pro + Business only');
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());

    // ================================================================ Spanish
    console.log('spanish');
    const a = await newClient(page, 'dana@spanishair.test', 'Spanish Air HVAC', '(713) 555-0130', 'FR_PRO');
    await page.evaluate(() => window.StartMock.admin.runtimeTick());   // go-live check (simulator only) -> live
    let d = await db(page);
    ok(d.clients.find(c => c.id === a.client_id).status === 'live', 'Pro client live (checklist + simulator check)');
    ok(JSON.stringify((await myTenant(page, a.client_id)).config.voice.languages) === '["en","es"]', 'Pro: Spanish on automatically in the live config');
    await portal(page, 'receptionist');
    ok(await page.$('#rxEs') !== null && await page.$eval('#rxEs', e => e.checked && !e.disabled), 'My receptionist: "Answer in Spanish too" on, can be changed');
    ok(/Answer in Spanish too/.test(await body(page)) && !/Available on/.test(await page.$eval('#setSpanish', e => e.innerText)), 'switch label, no lock on Pro');
    await shot(page, 'p2-spanish-pro', '#setSpanish');
    await click(page, '#rxEs'); await sleep(400);
    let t = await myTenant(page, a.client_id);
    ok(JSON.stringify(t.config.voice.languages) === '["en"]' && t.config.voice.spanish_off === true && !('spanish' in t.config), 'switched off: saved into voice.languages + remembered (no stray key)');
    ok(await page.$eval('#rxEs', e => !e.checked), 'switch shows off after the reload');
    // downgrade to Starter (trial: now) -> locked, English only; the API refuses too
    await page.evaluate(() => window.Backend.changePlan('FR_STARTER'));
    await portal(page, 'receptionist');
    ok(await page.$eval('#rxEs', e => e.disabled && !e.checked), 'Starter: switch locked and off');
    ok(new RegExp('Available on ' + pro.name).test(await page.$eval('#setSpanish', e => e.innerText)), 'Starter: "Available on Pro"');
    ok(await page.evaluate(id => window.Backend.updateTenantSettings(id, { spanish: true }).then(() => 'ok', e => e.message), a.tenant_id) === 'spanish_not_in_plan', 'Starter: the backend refuses Spanish');
    ok((await overflow(page)).length === 0, 'receptionist tab (Starter): no overflow');
    await shot(page, 'p2-spanish-starter', '#setSpanish');
    // upgrade to Business -> still off (the customer switched it off); switch on -> on; downgrade + upgrade -> on again
    await page.evaluate(() => window.Backend.changePlan('FR_BUSINESS'));
    ok(JSON.stringify((await myTenant(page, a.client_id)).config.voice.languages) === '["en"]', 'upgrade keeps the remembered "off"');
    await portal(page, 'receptionist');
    await click(page, '#rxEs'); await sleep(400);
    ok(JSON.stringify((await myTenant(page, a.client_id)).config.voice.languages) === '["en","es"]', 'switched on again on Business');
    await page.evaluate(() => window.Backend.changePlan('FR_STARTER'));
    ok(JSON.stringify((await myTenant(page, a.client_id)).config.voice.languages) === '["en"]', 'downgrade: English only');
    await page.evaluate(() => window.Backend.changePlan('FR_PRO'));
    ok(JSON.stringify((await myTenant(page, a.client_id)).config.voice.languages) === '["en","es"]', 'upgrade: Spanish back on (customer had it on)');
    ok((await overflow(page)).length === 0, 'receptionist tab (Pro): no overflow');

    // ================================================================ number release
    console.log('release');
    // plan client: the home steps are the plan's (no Questionnaire / Quote / Deposit)
    await portal(page);
    const stepsTxt = await page.$$eval('.stepper li', li => li.map(x => x.textContent.trim()));
    ok(stepsTxt.length === 4 && /^Plan started · trial until \w{3} \d{1,2}, \d{4}$/.test(stepsTxt[0]) && stepsTxt.slice(1).join() === 'Setup checklist,Test call,Live',
      'plan home steps: Plan started (trial until …) → Setup checklist → Test call → Live (' + stepsTxt.join(' | ') + ')');
    ok((await page.$eval('.stepper [aria-current=step]', e => e.textContent)).includes('Live') && !/Questionnaire|Quote|Deposit/.test(await page.$eval('.stepper', e => e.textContent)), 'plan home: current = Live, no quote-era steps');
    ok((await overflow(page)).length === 0, 'plan home steps: no overflow');
    await shot(page, 'p3-portal-home-plan-steps', '.status');
    await portal(page, 'billing');
    ok(!(await page.$('#planRelease')) && !/is kept until/.test(await body(page)), 'no release scheduled: the Billing card says nothing about it');
    // the free trial ended 25 days ago without a paid plan (the same path as a cancelled plan whose paid month is over)
    const ended = new Date(Date.now() - 25 * 86400000).toISOString();
    await page.evaluate(e => window.StartMock.admin.billing({ trial_ends_at: e }), ended);
    d = await db(page);
    let rel = (d.number_releases || []).find(r => r.client_id === a.client_id);
    ok(rel && rel.status === 'scheduled' && rel.reason === 'trial_ended' && rel.number === (await myTenant(page, a.client_id)).twilio_number, 'trial ended unpaid: release scheduled for the receptionist number');
    ok(rel && Math.round((Date.parse(rel.release_at) - Date.parse(ended)) / 86400000) === 30 && Math.round((Date.parse(rel.release_at) - Date.parse(rel.warn_at)) / 86400000) === 7,
       'release 30 days after the end, warning 7 days before');
    const tick1 = await page.evaluate(() => window.StartMock.admin.p2Tick());
    ok(tick1.warned === 1 && (await db(page)).outbox.some(m => m.template === 'number_release_warning'), 'tick: 7-day warning e-mail to the customer');
    rel = (await db(page)).number_releases.find(r => r.client_id === a.client_id);
    ok(Math.round((Date.parse(rel.release_at) - Date.now()) / 86400000) === 7, 'warned late (5 days left): the release moves to 7 days after the warning');
    // phase 3: the customer sees until when the number is kept (client_billing.number_release), with the restart button
    const num = rel.number, pretty = '(' + num.slice(2, 5) + ') ' + num.slice(5, 8) + '-' + num.slice(8);
    await portal(page, 'billing');
    const relDate = await page.evaluate(iso => window.Start.fmtDate(iso), rel.release_at);
    const relLine = 'Your FirstRing number ' + pretty + ' is kept until ' + relDate + '. Restart your plan to keep it.';
    ok((await page.$eval('#planRelease #planReleaseText', e => e.textContent).catch(() => '')) === relLine && /\d{4}/.test(relDate), 'Billing card: "' + relLine + '"');
    ok(await page.$eval('#planRelease', e => !!e.closest('.plan')).catch(() => false), 'the line is inside the plan card');
    ok((await page.$$('[data-plan-act]')).length === 1 && !!(await page.$('#planRelease #planReleaseRestart[data-plan-act=resume]')),
      'Billing: one action only, the restart button in the release box (no upgrade / cancel / start on an ended plan)');
    ok((await page.$eval('#planStatus', e => e.textContent)).startsWith('Free trial ended ') && !(await page.$('#planDays')), 'ended trial: "Free trial ended <date>", no days-left line');
    ok((await page.evaluate(() => window.Backend.getBilling())).number_release.number === num, 'mock client_billing.number_release = number + date');
    ok((await overflow(page)).length === 0, 'Billing with the release date: no overflow');
    await shot(page, 'p3-portal-release', '#planH');
    await portal(page);
    ok((await page.$eval('.status__text', e => e.textContent)).includes(relLine) && !!(await page.$('#goBilling')), 'home status: the same line + Open Billing');
    await shot(page, 'p3-portal-home-release', '.status');
    // admin
    await signOut(page);
    await signIn(page, '/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
    await page.waitForSelector('#digest');
    await admin(page);
    let txt = await page.$eval('#subsBody', e => e.innerText);
    ok(/שחרור מספר/.test(txt) && /מתוזמן/.test(txt) && /תאריך שחרור/.test(txt) && /נשלחה ב-/.test(txt), 'admin: release scheduled, date, warning sent');
    ok(await page.$('[data-postpone]') !== null && await page.$('[data-relnow]') !== null, 'admin: postpone + release now buttons');
    const before = Date.parse(rel.release_at);
    await click(page, '[data-postpone]'); await sleep(300);
    rel = (await db(page)).number_releases.find(r => r.client_id === a.client_id);
    ok(Math.round((Date.parse(rel.release_at) - before) / 86400000) === 14 && rel.postponed_count === 1 && !rel.warned_at, 'postpone: 14 days later, a new warning before the new date');
    await sleep(3200);   // let the toast go before the screenshot
    ok((await overflow(page)).length === 0, 'admin with the release block: no overflow');
    await shot(page, 'p2-admin-release', '.rel');
    dialogs.length = 0;
    await click(page, '[data-relnow]'); await sleep(300);
    ok(dialogs.some(m => /לשחרר עכשיו את המספר/.test(m)), 'release now asks first');
    rel = (await db(page)).number_releases.find(r => r.client_id === a.client_id);
    ok(rel.force === true && Date.parse(rel.release_at) <= Date.now(), 'release now: due now');
    const tick2 = await page.evaluate(() => window.StartMock.admin.p2Tick());
    ok(tick2.held === 1 && (await db(page)).number_releases.find(r => r.client_id === a.client_id).status === 'held', 'dry-run tick: held, nothing released');
    await admin(page);
    ok(/מוחזק \(מצב ניסוי\)/.test(await page.$eval('#subsBody', e => e.innerText)), 'admin: held (dry run) shown');
    // resubscribe before the real release -> canceled
    await signOut(page);
    await signIn(page, '/start/', 'dana@spanishair.test');
    await page.evaluate(() => window.Backend.resumePlan());
    rel = (await db(page)).number_releases.find(r => r.client_id === a.client_id);
    ok(rel.status === 'canceled' && rel.cancel_reason === 'resubscribed', 'resubscribing cancels the release');
    // phase 3: the plan ends again -> the date is back; the box's button restarts the plan and the line goes away
    await page.evaluate(() => window.StartMock.admin.billing({ status: 'canceled', canceled_at: new Date(Date.now() - 26 * 86400000).toISOString(),
      ends_at: new Date(Date.now() - 25 * 86400000).toISOString(), cancel_at_period_end: false }));
    rel = (await db(page)).number_releases.find(r => r.client_id === a.client_id);
    ok(rel.status === 'scheduled', 'plan ended again: release scheduled again');
    await portal(page, 'billing');
    ok(!!(await page.$('#planReleaseRestart')), 'Billing: release box with the restart button');
    await click(page, '#planReleaseRestart');
    await page.waitForFunction(() => !document.querySelector('#planRelease'), { timeout: 6000 }).catch(() => null);
    rel = (await db(page)).number_releases.find(r => r.client_id === a.client_id);
    ok(rel.status === 'canceled' && rel.cancel_reason === 'resubscribed' && !(await page.$('#planRelease')) && !/is kept until/.test(await body(page)),
      'restart from the box: plan active, release canceled, the line is gone');
    await portal(page);
    ok(!/is kept until/.test(await page.$eval('.status__text', e => e.textContent)), 'home status: no release line after the restart');

    // ================================================================ go-live live AI check (fails -> stays in testing)
    console.log('ai check');
    const b = await newClient(page, 'lee@bee.test', 'Bee Plumbing', '(312) 555-0131', 'FR_STARTER');
    await page.evaluate(cid => window.StartMock.admin.p2Tick({ ai: 'fail', client: cid }), b.client_id);
    d = await db(page);
    ok(d.clients.find(c => c.id === b.client_id).status === 'testing', 'failed AI check: client stays in testing');
    await signOut(page);
    await signIn(page, '/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
    await page.waitForSelector('#digest');
    await admin(page);
    const card = `[data-sub="${b.client_id}"]`;
    txt = await page.$eval(card, e => e.innerText);
    ok(/שיחת בדיקה עם המודל האמיתי/.test(txt) && /נכשלה/.test(txt) && /הסוכן אמר מחיר/.test(txt) && /עלות משוערת/.test(txt), 'admin: AI check failed, problems in Hebrew, cost estimate');
    await page.$eval(card + ' .aitx', e => { e.open = true; }); await sleep(100);
    ok(/תמליל השיחה/.test(await page.$eval(card, e => e.innerText)) && /\$99/.test(await page.$eval(card + ' .aitx', e => e.innerText)), 'admin: transcript incl. what the model tried to say');
    ok(await page.$(card + ' [data-golive]') !== null, 'admin: manual go-live available');
    ok((await overflow(page)).length === 0, 'admin with the AI check: no overflow');
    await shot(page, 'p2-admin-golive-ai', card + ' .aichk');
    await click(page, card + ' [data-golive]'); await sleep(300);
    ok((await db(page)).clients.find(c => c.id === b.client_id).status === 'live', 'Meir approves by hand: live');
    ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); try { server && server.close(); } catch (x) { /* closed */ } process.exit(1); });
