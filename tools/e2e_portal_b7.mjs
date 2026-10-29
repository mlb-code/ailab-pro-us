// E2E for portal phase B (task B7) against the MOCK backend: setup checklist (7 items, video slots, saves, need help,
// forwarding test call, calendar, go-live), My receptionist (calls/SMS/bookings, transcripts as text, Pause AI, settings
// through update_tenant_settings + schema validation, whitelist), Requests (one active, queue reorder, pause, cancel),
// Billing usage, client isolation, admin Tenants tab (usage/cost, JSON editor validated against tenant_schema.json,
// merge onboarding data, create/save tenant, non-admin refused), keyboard, overflow 375/390/414/1280, console errors.
//   node tools/e2e_portal_b7.mjs        (own static server on E2E_PORT, default 8961)
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
const brand = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));   // demo.runtime_url -> chat snippet
const schema = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/tenant_schema.json'), 'utf8'));
// checklist titles as the onboarding videos say them (S3 on-screen list: "1 Title · 2 Title · ... (copy the exact titles ...)")
const welcome = fs.readFileSync(path.resolve(HERE, '../videos/01-welcome/script.md'), 'utf8');
const onScreen = (welcome.split('\n').find(l => /On-screen text \(list, one line per item/.test(l)) || '').replace(/^.*?:\*\*\s*/, '').replace(/\s*\(copy the exact.*$/, '');
const SCRIPT_TITLES = onScreen.split(' · ').map(x => x.replace(/^\d+\s+/, '').trim()).filter(Boolean);
const MIGRATION = fs.readdirSync(path.resolve(HERE, '../supabase/migrations')).filter(f => /_us_portal_b7\.sql$/.test(f)).map(f => fs.readFileSync(path.resolve(HERE, '../supabase/migrations', f), 'utf8')).join('');
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
  await page.click('#pSave');
  await page.waitForSelector('[role=tablist]');
}
async function tabTo(page, id) { await page.click('#tab-' + id); await sleep(150); }
async function openStep(page, key) {
  await page.evaluate(k => { const d = document.querySelector('#ob-' + k); if (d && !d.open) d.open = true; }, key);
  await sleep(50);
}
async function setVal(page, sel, v) { await page.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); }
async function save(page, key) { await page.$eval('[data-save="' + key + '"]', b => b.click()); await sleep(250); }
let window_client_id = null;

async function main() {
  await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await newPage(browser);
    // ---------------------------------------------------------------- schema copy
    ok(JSON.stringify(schema) === JSON.stringify(JSON.parse(runtimeSchema)), 'site/assets/tenant_schema.json = runtime/app/tenant_schema.json (synced, not hand-written)');
    // ---------------------------------------------------------------- client A, before deposit: no phase-B tabs
    console.log('client A');
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    await signIn(page, '/start/', 'dani@b7.test');
    await profile(page, 'Cool Breeze HVAC');
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Quotes,Billing', 'new user: tabs unchanged (Home, Quotes, Billing)');
    await page.goto(BASE + '/start/?mock_seed=accepted', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Requests,Quotes,Billing', 'accepted, deposit due: Requests tab, no checklist yet');
    ok((await db(page)).onboarding_items.length === 0, 'no checklist before the deposit is paid');
    // deposit paid -> 7 items (trigger payments_seed_onboarding)
    await page.goto(BASE + '/start/?mock_seed=deposit_paid', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Setup checklist,Requests,Quotes,Billing', 'deposit paid: Setup checklist tab');
    ok(await waitText(page, 'Your setup checklist is ready: 0 of 7 steps done'), 'home status: checklist ready 0 of 7');
    await page.click('#goOnboarding'); await sleep(200);
    ok(await page.$eval('#tab-onboarding', t => t.getAttribute('aria-selected')) === 'true', 'home next action opens the checklist tab');
    let d0 = await db(page);
    window_client_id = d0.clients[0].id;
    const keys = await page.$$eval('.obstep', ds => ds.map(x => x.dataset.key));
    ok(keys.join() === 'forward_calls,calendar,hours,faq,alerts,tools,sms', 'exactly 7 items in SPEC 6.8 / video order');
    const titles = await page.$$eval('.obstep__t', ts => ts.map(x => x.textContent));
    ok(titles.join('|') === SCRIPT_TITLES.join('|'), 'item titles = videos/01-welcome/script.md (' + SCRIPT_TITLES.join(' · ') + ')');
    ok(SCRIPT_TITLES.every(t => MIGRATION.includes("'" + t + "'")), 'private.seed_onboarding uses the same titles');
    // server-side go-live gate (mock mirrors private.onboarding_go_live_gate)
    ok(await page.evaluate(() => window.Backend.listOnboarding().then(ob => window.Backend.updateOnboarding(ob.find(o => o.key === 'sms').id, 'done', { go_live_requested_at: new Date().toISOString() })).then(() => 'ok', e => e.message)) === 'go_live_not_ready', 'early go-live request refused by the backend');
    ok((await page.$$eval('.obstep .vslot[data-video][data-script]', v => v.length)) === 7, 'every step has a video slot (data-video + data-script)');
    ok(await page.$('.vslot[data-video="onb-welcome"][data-script="01-welcome"]') !== null, 'welcome video slot on top of the checklist');
    ok(await page.$eval('#ob-forward_calls', x => x.open), 'first unfinished step is open');
    ok(await waitText(page, 'appears here when your receptionist is ready to test'), 'forwarding: no number yet -> explained');
    ok((await overflow(page)).length === 0, 'checklist: no overflow 375/390/414/1280');
    // keyboard: summary toggles with Enter
    await page.focus('#ob-calendar > summary'); await page.keyboard.press('Enter'); await sleep(80);
    ok(await page.$eval('#ob-calendar', x => x.open), 'keyboard: Enter on a step summary opens it');
    // calendar: Calendly link validation
    await page.$eval('input[name=ob_prov][value=calendly]', r => r.click()); await sleep(50);
    ok(!(await page.$eval('#ob_cal_calendly', e => e.hidden)) && await page.$eval('#ob_cal_google', e => e.hidden), 'calendar: Calendly panel toggles');
    ok(/Calendly \(paid plan\) or Google Calendar \(free\)/.test(await body(page)), 'calendar text: Calendly (paid plan) or Google Calendar (free)');
    await setVal(page, '#ob_cly', 'https://evil.example/calendly.com/x'); await save(page, 'calendar');
    ok(/doesn’t look like a Calendly booking link/.test(await page.$eval('#msg_calendar', e => e.innerText)), 'calendar: bad Calendly link rejected');
    await setVal(page, '#ob_cly', 'https://calendly.com/coolbreeze/service-call'); await save(page, 'calendar');
    let it = (await db(page)).onboarding_items.find(o => o.key === 'calendar');
    ok(it.status === 'done' && it.data.booking_link === 'https://calendly.com/coolbreeze/service-call' && it.data.provider === 'calendly', 'calendar: Calendly link saved, step done');
    // hours: order check + timezone + after hours
    await openStep(page, 'hours');
    await setVal(page, '#obh_mon_o', '18:00'); await setVal(page, '#obh_mon_c', '08:00'); await save(page, 'hours');
    ok(/Monday: opening time must be before closing time/.test(await page.$eval('#msg_hours', e => e.innerText)), 'hours: open after close rejected');
    await setVal(page, '#obh_mon_o', '07:00'); await setVal(page, '#obh_mon_c', '18:00');
    await page.$eval('#obh_sun_on', c => { c.checked = false; c.dispatchEvent(new Event('change')); });
    ok(await page.$eval('#obh_sun_o', i => i.disabled), 'hours: unchecking a day disables its times');
    await page.select('#ob_tz', 'America/Chicago');
    await page.$eval('input[name=obah][value=message_only]', r => r.click());
    await save(page, 'hours');
    it = (await db(page)).onboarding_items.find(o => o.key === 'hours');
    ok(it.status === 'done' && it.data.timezone === 'America/Chicago' && it.data.hours.mon[0] === '07:00' && it.data.hours.sun === null && it.data.after_hours.mode === 'message_only', 'hours + time zone + after-hours saved');
    // faq: needs services; HTML stays text
    await openStep(page, 'faq');
    await setVal(page, '#ob_services', ''); await save(page, 'faq');
    ok(/Add at least one service/.test(await page.$eval('#msg_faq', e => e.innerText)), 'faq: services required');
    await setVal(page, '#ob_services', 'AC repair, Furnace repair');
    await setVal(page, '#obf_q0', 'Do you service <b>Trane</b>?'); await setVal(page, '#obf_a0', 'Yes, all major brands.');
    await page.click('#obf_faqAdd'); await sleep(50);
    ok((await page.$$('#obf_faq .faqrow')).length === 2 && await page.evaluate(() => document.activeElement.id === 'obf_q1'), 'faq: add a question focuses the new row');
    await setVal(page, '#obf_q1', 'Do you offer financing?'); await save(page, 'faq');
    ok(/needs both a question and an answer/.test(await page.$eval('#msg_faq', e => e.innerText)), 'faq: half-filled row rejected');
    await setVal(page, '#obf_a1', 'Our team can explain options on site.'); await save(page, 'faq');
    it = (await db(page)).onboarding_items.find(o => o.key === 'faq');
    ok(it.status === 'done' && it.data.faq.length === 2 && it.data.services.join() === 'AC repair,Furnace repair', 'faq + services saved');
    // need help
    await openStep(page, 'sms');
    await page.$eval('#ob-sms .help__d', x => { x.open = true; });
    await setVal(page, '#help_sms', 'Where do I find my EIN?');
    await page.$eval('#ob-sms [data-help]', b => b.click()); await sleep(300);
    d0 = await db(page); it = d0.onboarding_items.find(o => o.key === 'sms');
    ok(it.status === 'need_help' && it.data.help_message === 'Where do I find my EIN?', 'need help: item status need_help + message saved');
    ok(d0.outbox.some(m => m.template === 'need_help') && d0.events.some(e => e.type === 'need_help'), 'need help: owner e-mail stub + event');
    ok(await waitText(page, 'We got your message'), 'need help: confirmation shown');
    // sms registration
    await setVal(page, '#ob_legal', 'Cool Breeze HVAC LLC'); await setVal(page, '#ob_ein', '12345'); await setVal(page, '#ob_addr', '1200 Main St, Houston, TX 77002');
    await save(page, 'sms');
    const smsMsg = await page.$eval('#msg_sms', e => e.innerText);
    ok(/EIN has 9 digits/.test(smsMsg) && /confirm the texting rules/.test(smsMsg), 'sms: EIN format + consent required');
    await setVal(page, '#ob_ein', '12-3456789'); await page.$eval('#ob_consent', c => { c.checked = true; }); await save(page, 'sms');
    it = (await db(page)).onboarding_items.find(o => o.key === 'sms');
    ok(it.status === 'done' && it.data.consent === true && /Reply STOP/.test(it.data.consent_text) && it.data.consent_at, 'sms: consent text + time stored');
    // tools: skip
    await openStep(page, 'tools');
    await page.$eval('#ob_skip', b => b.click()); await sleep(300);
    it = (await db(page)).onboarding_items.find(o => o.key === 'tools');
    ok(it.status === 'done' && it.data.skipped === true, 'other tools: optional step can be skipped');

    // ---------------------------------------------------------------- testing: tenant exists -> settings go to the config too
    console.log('testing + tenant');
    await page.goto(BASE + '/start/?mock_seed=testing', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    const tenant = await page.evaluate(() => window.StartMock.admin.seedTenant());
    await page.goto(BASE + '/start/?r=1#onboarding', { waitUntil: 'load' }); await page.waitForSelector('.obsteps');
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Setup checklist,My receptionist,Results,Requests,Quotes,Billing', 'testing + tenant: My receptionist tab');
    // alerts -> notify + on_call_number through update_tenant_settings
    await openStep(page, 'alerts');
    await setVal(page, '#obn_sms', '713 555 01'); await setVal(page, '#obn_email', 'dani@coolbreeze.test'); await setVal(page, '#oboc', '(713) 555-0111'); await setVal(page, '#ob_kw', 'gas smell, flooding');
    await save(page, 'alerts');
    ok(/doesn’t look like a phone number/.test(await page.$eval('#msg_alerts', e => e.innerText)), 'alerts: bad phone rejected');
    await setVal(page, '#obn_sms', '(713) 555-0142, +1 281 555 0177'); await setVal(page, '#obn_email', 'not-an-email');
    await save(page, 'alerts');
    ok(/Alerts: email\[0\]/.test(await page.$eval('#msg_alerts', e => e.innerText)), 'alerts: e-mail checked against tenant_schema.json Notify');
    await setVal(page, '#obn_email', 'Dani@CoolBreeze.test'); await save(page, 'alerts');
    let D = await db(page); let t = D.tenants.find(x => x.id === tenant.id);
    ok(t.config.notify.sms.join() === '+17135550142,+12815550177' && t.config.notify.email[0] === 'dani@coolbreeze.test', 'alerts: notify written to tenant config in E.164');
    ok(t.config.handoff.number === '+17135550111' && t.config.handoff.mode === 'dial' && t.config.emergency.dial === '+17135550111', 'on-call number -> handoff + emergency.dial (whitelisted)');
    ok(D.onboarding_items.find(o => o.key === 'alerts').data.emergency.keywords.join() === 'gas smell,flooding', 'emergency words kept in checklist data (not whitelisted)');
    ok(D.events.some(e => e.type === 'settings_updated' && e.entity_id === tenant.id), 'settings_updated event logged');
    // re-save hours now that the tenant exists -> hours + after_hours in config
    await openStep(page, 'hours'); await save(page, 'hours');
    t = (await db(page)).tenants.find(x => x.id === tenant.id);
    ok(t.config.hours.mon[0] === '07:00' && t.config.after_hours.mode === 'message_only', 'hours + after_hours written to tenant config');
    // forwarding: carrier instructions + test call
    await openStep(page, 'forward_calls');
    const digits = tenant.twilio_number.slice(2);
    await page.select('#ob_car', 'verizon'); await sleep(80);
    ok((await page.$eval('#ob_carhow', e => e.innerText)).includes('*71' + digits), 'forwarding: Verizon code uses the AI line number');
    // AT&T publishes no dial codes (att.com KM1011513): the portal sends the client to the phone's settings
    await page.select('#ob_car', 'att'); await sleep(80);
    const attHow = await page.$eval('#ob_carhow', e => e.innerText);
    ok(/Phone app → Settings → Calling accounts/.test(attHow) && /When unanswered/.test(attHow) && !/\*\*61/.test(attHow) && attHow.includes(digits.slice(-4)), 'forwarding: AT&T = phone settings, no dial code');
    // Comcast Business: VoiceEdge star codes from Comcast's sheet (SLS90624), not the unverified "Voice Manager" menu
    await page.select('#ob_car', 'comcast'); await sleep(80);
    const cbHow = await page.$eval('#ob_carhow', e => e.innerText);
    ok(['*92', '*90', '*93', '*91', digits].every(s => cbHow.includes(s)) && !/Voice Manager/.test(cbHow), 'forwarding: Comcast = VoiceEdge codes *92/*90, off *93/*91');
    // VoIP business phone systems (task 11, 23.10): app / portal menu paths from each vendor's help page, no dial codes, grouped <optgroup>
    const groups = await page.$$eval('#ob_car optgroup', gs => gs.map(g => [g.label, g.querySelectorAll('option').length]));
    ok(groups.length === 2 && groups[0][0] === 'Mobile & landline carriers' && groups[0][1] === 4 && /VoIP/.test(groups[1][0]) && groups[1][1] === 8, 'forwarding: provider list = 4 carriers + 8 VoIP systems in two groups');
    ok((await page.$$eval('#ob_car option', os => os.map(o => o.value))).slice(-1)[0] === 'other', 'forwarding: "Other / not sure" stays last, outside the groups');
    const last4 = digits.slice(-4);
    const VOIP = [
      ['ringcentral', /Incoming call rules/, /If no one answers/, /Forward the call/],
      ['googlevoice', /Ring groups/, /Unanswered calls/, /30 seconds/, /Need help with this step/],
      ['nextiva', /Voice Settings/, /Call forwarding \(unanswered\)/, /rings/],
      ['grasshopper', /Call forwarding numbers/, /Ring in specific order/, /Direct connect/, /25 seconds/],
      ['ooma', /Shared External Line/, /Ring for/, /Need help with this step/],
      ['dialpad', /Main Line/, /Fallback Options/, /external number/, /support team/],
      ['zoom', /Call Handling/, /Add Phone Number/, /Sequential/, /Ringing Duration/],
      ['vonage', /Follow Me/, /10–60 seconds/, /Forward Calls/]];
    for (const [key, ...rx] of VOIP) {
      await page.select('#ob_car', key); await sleep(60);
      const how = await page.$eval('#ob_carhow', e => e.innerText);
      ok(rx.every(r => r.test(how)) && how.includes(last4) && !/\*7\d|\*\*6\d|\*9\d/.test(how) && /final word/.test(how), 'forwarding: ' + key + ' = app/portal path with the AI line number, no dial codes');
      ok(/turn it off|Need help with this step/.test(how), 'forwarding: ' + key + ' says how to undo or points to Need help');
    }
    ok(((await db(page)).onboarding_items.find(o => o.key === 'forward_calls').data || {}).carrier === 'vonage', 'forwarding: VoIP provider choice is saved');
    await page.select('#ob_car', 'att'); await sleep(80);
    ok(/text-back message/.test(await page.$eval('#ob_textback', e => e.innerText)), 'test call: warns that hanging up silent sends a text-back');
    ok(/30 minutes/.test(await page.$eval('#ob-forward_calls', e => e.innerText)), 'test call: 30-minute window explained');
    await page.click('#ob_test'); await sleep(250);
    ok(await waitText(page, 'Test started'), 'test call started');
    ok(!!(await db(page)).onboarding_items.find(o => o.key === 'forward_calls').data.test_started_at, 'test start stamped');
    await page.click('#ob_testsim');
    ok(await page.waitForFunction(() => /Forwarding works/.test(document.body.innerText), { timeout: 4000 }).then(() => true).catch(() => false), 'simulated forwarded call marks the step done (poll)');
    ok((await db(page)).events.some(e => e.type === 'forwarding_test_passed'), 'forwarding_test_passed event');
    // calendly: the saved link is not enough; the OAuth button + the "Job details" question note (mock runtime)
    await openStep(page, 'calendar');
    await page.$eval('input[name=ob_prov][value=calendly]', r => r.click()); await sleep(50);
    const clyPanel = await page.$eval('#ob_cal_calendly', e => e.innerText);
    ok(/Connect Calendly account/.test(clyPanel) && /Job details/.test(clyPanel) && /Invitee questions/.test(clyPanel), 'calendar: Calendly OAuth button + "Job details" question note');
    await page.$eval('#ob_calendly', b => b.click());
    await page.waitForSelector('#calReturn .notice', { timeout: 5000 });
    ok(/Calendly account connected/.test(await page.$eval('#calReturn', e => e.innerText)), 'Calendly OAuth return: connected');
    it = (await db(page)).onboarding_items.find(o => o.key === 'calendar');
    ok(it.data.provider === 'calendly' && it.data.oauth_at && it.data.booking_link === 'https://calendly.com/coolbreeze/service-call', 'calendar: Calendly OAuth recorded, saved link kept');
    ok(/Reconnect Calendly account/.test(await page.$eval('#ob_cal_calendly', e => e.innerText)) && /Connected — Calendly account/.test(await page.$eval('#ob_cal_calendly', e => e.innerText)), 'calendar: Calendly shows connected');
    // google calendar connect (mock runtime)
    await openStep(page, 'calendar');
    await page.$eval('input[name=ob_prov][value=google]', r => r.click());
    await page.$eval('#ob_google', b => b.click());
    // (the Calendly return notice is still on the page: wait for the Google one, not for any notice)
    const gReturn = await page.waitForFunction(() => /Google Calendar connected/.test((document.querySelector('#calReturn') || {}).innerText || ''), { timeout: 5000 }).then(() => true).catch(() => false);
    ok(gReturn && await page.evaluate(() => location.search === ''), 'Google OAuth return: connected, URL cleaned');
    it = (await db(page)).onboarding_items.find(o => o.key === 'calendar');
    ok(it.data.provider === 'google' && it.data.connected_at, 'calendar: Google connection recorded');
    // go-live
    await openStep(page, 'sms');
    ok(await page.$eval('#ob_golive', b => !b.disabled), 'go-live button enabled when all 7 done and status testing');
    await page.$eval('#ob_golive', b => b.click()); await sleep(300);
    D = await db(page);
    ok(D.events.some(e => e.type === 'go_live_requested') && D.outbox.some(m => m.template === 'final_payment_due'), 'go-live request: event + final_payment_due e-mail stub');
    ok(await waitText(page, 'Go-live requested on'), 'go-live requested shown');

    // ---------------------------------------------------------------- My receptionist
    console.log('receptionist');
    await tabTo(page, 'receptionist');
    ok((await page.$$('.calls .call')).length === 3, 'calls listed (2 demo + the forwarding test call)');
    await page.$$eval('.call details.tx', xs => xs.forEach(x => { x.open = true; }));
    ok(await page.$$eval('.call .tx__b', es => es.some(e => e.innerHTML.includes('&lt;b&gt;help&lt;/b&gt;')) && es.every(e => !e.querySelector('b'))), 'transcript HTML rendered as text');
    ok(/Booked/.test(await body(page)) && /\(281\) 555-0177/.test(await body(page)), 'outcome + caller formatted');
    ok(/A quote for a new AC unit please/.test(await page.$eval('#panel', e => e.textContent)), 'SMS thread content present');
    ok(/Maria Lopez/.test(await body(page)), 'bookings listed');
    ok((await overflow(page)).length === 0, 'receptionist: no overflow');
    await page.click('#rxPause'); await sleep(300);
    t = (await db(page)).tenants.find(x => x.id === tenant.id);
    ok(t.config.paused === true && await page.$eval('#rxPause', b => b.getAttribute('aria-pressed')) === 'true', 'Pause AI -> config.paused via update_tenant_settings');
    await page.click('#rxPause'); await sleep(300);
    ok((await db(page)).tenants.find(x => x.id === tenant.id).config.paused === false, 'Resume AI');
    await page.$eval('#setFaq', x => { x.open = true; });
    const n0 = (await page.$$('#rxf_faq .faqrow')).length;
    for (let i = n0; i < 25; i++) await page.$eval('#rxf_faqAdd', b => b.click());
    ok((await page.$$('#rxf_faq .faqrow')).length === 25 && await page.$eval('#rxf_faqAdd', b => b.disabled), 'FAQ limited to 25 (from the schema maxItems)');
    await page.$eval('#setNotify', x => { x.open = true; });
    await setVal(page, '#rxn_sms', ''); await setVal(page, '#rxn_email', '');
    await page.$eval('[data-rxsave="notify"]', b => b.click()); await sleep(150);
    ok(/at least one mobile number or email/.test(await page.$eval('#rxMsg_notify', e => e.innerText)), 'alerts need at least one contact');
    await page.$eval('#setAfter', x => { x.open = true; });
    await page.$eval('input[name=rxah][value=emergency_dial]', r => r.click()); await setVal(page, '#rxoc', '');
    await page.$eval('[data-rxsave="after"]', b => b.click()); await sleep(300);
    t = (await db(page)).tenants.find(x => x.id === tenant.id);
    ok(t.config.after_hours.mode === 'emergency_dial' && t.config.handoff.mode === 'message' && t.config.handoff.number === null, 'receptionist: after-hours + clearing on-call number');
    ok(await page.$eval('#setAfter', x => x.open), 'settings panel stays open after save');
    // whitelist + ownership through the client API (same codes as the RPC)
    ok(await page.evaluate(tid => window.Backend.updateTenantSettings(tid, { booking: { provider: 'fake' } }).then(() => 'ok', e => e.message), tenant.id) === 'field_not_allowed: booking', 'non-whitelisted field refused (field_not_allowed)');
    ok(await page.evaluate(tid => window.Backend.updateTenantSettings(tid, { after_hours: { mode: 'party' } }).then(() => 'ok', e => e.message), tenant.id) === 'invalid_setting:after_hours.mode', 'bad after_hours refused (invalid_setting:after_hours.mode)');
    ok(await page.evaluate(tid => window.Backend.updateTenantSettings(tid, { on_call_number: '7135550111' }).then(() => 'ok', e => e.message), tenant.id) === 'invalid_setting:on_call_number', 'bad on_call_number refused');
    ok(await page.evaluate(tid => window.Backend.updateTenantSettings(tid, { faq: [{ q: 'q', a: 'a'.repeat(601) }] }).then(() => 'ok', e => e.message), tenant.id) === 'invalid_setting:faq[0].a', 'FAQ answer over the schema limit refused (direct call)');
    ok(await page.evaluate(tid => window.Backend.updateTenantSettings(tid, { hours: { mon: ['18:00', '08:00'] } }).then(() => 'ok', e => e.message), tenant.id) === 'invalid_setting:hours.mon', 'reversed hours refused (direct call)');
    ok(await page.evaluate(tid => window.Backend.updateTenantSettings(tid, { notify: { sms: [], email: [] } }).then(() => 'ok', e => e.message), tenant.id) === 'invalid_setting:notify', 'alerts without any contact refused (direct call)');

    // ---------------------------------------------------------------- My receptionist: real-estate add-ons (2026-10-23)
    // Lead screening questions (config.real_estate through update_tenant_settings; follow_up_boss stays ours) + the
    // website chat box snippet (config.webchat, ADD-CHAT). The HVAC tenant above has neither card.
    console.log('receptionist: real estate + chat');
    ok(await page.$('#setScreen') === null && await page.$('#setChat') === null, 'HVAC tenant: no screening card, no chat card');
    const reT = await page.evaluate(() => window.StartMock.admin.seedTenant({ niche: 'real_estate' }));
    ok(reT.id === tenant.id, 'seedTenant({niche: real_estate}) upgrades the client’s tenant');
    await page.goto(BASE + '/start/?r=5#receptionist', { waitUntil: 'load' }); await page.waitForSelector('#rxPause');
    await page.$eval('#setScreen', x => { x.open = true; });
    ok((await page.$$('#rxre_list .qreq')).length === 8 && (await page.$$('#rxre_list input[type=checkbox]:checked')).length === 8, 'screening card: 8 questions, all asked');
    const reLabels = await page.$eval('#setScreen', e => e.innerText);
    ok(/Buying, selling or renting\?/.test(reLabels) && /Pre-approved for a mortgage\? \(buyers\)/.test(reLabels) && /Already working with an agent\?/.test(reLabels), 'screening card: plain-language labels');
    ok(/race, religion, national origin, family status or disability/.test(reLabels) && /fair housing/.test(reLabels), 'screening card: fair-housing note');
    ok(await page.$eval('#rxre_agent', e => e.value) === 'Jenna Harper' && await page.$eval('#rxre_agent', e => e.getAttribute('maxlength')) === String(schema.$defs.RealEstate.properties.agent_name.maxLength), 'agent name shown, max length from the schema');
    ok(await page.$eval('[data-reup="intent"]', b => b.disabled) && await page.$eval('[data-redown="has_agent"]', b => b.disabled), 'first row cannot move up, last cannot move down');
    // at least one question
    await page.$$eval('#rxre_list input[type=checkbox]', cs => cs.forEach(c => { c.checked = false; }));
    await page.$eval('[data-rxsave="screen"]', b => b.click()); await sleep(150);
    ok(/Keep at least one question/.test(await page.$eval('#rxMsg_screen', e => e.innerText)), 'screening: at least one question required');
    ok((await db(page)).tenants.find(x => x.id === tenant.id).config.real_estate.screening.length === 8, 'screening: refused form saved nothing');
    await page.$$eval('#rxre_list input[type=checkbox]', cs => cs.forEach(c => { c.checked = true; }));
    // uncheck Timeline, move "Already working with an agent?" to the top (7 clicks), take rental leads
    await page.$eval('#rxre_q_timeline', c => { c.checked = false; });
    for (let i = 0; i < 7; i++) await page.click('[data-reup="has_agent"]');
    ok((await page.$$eval('#rxre_list .qreq', rs => rs.map(r => r.dataset.rek))).join() === 'has_agent,intent,area,timeline,price_range,pre_approval,property_address,motivation', 'move up reorders the list');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-redown') === 'has_agent'), 'focus moves to the row’s other arrow when up is no longer possible');
    ok(!(await page.$eval('#rxre_q_timeline', c => c.checked)), 'unchecked question stays unchecked after reordering');
    await page.$eval('#rxre_renters', c => { c.checked = true; });
    await setVal(page, '#rxre_agent', '  Jenna Harper  ');
    await page.$eval('[data-rxsave="screen"]', b => b.click()); await sleep(300);
    let re = (await db(page)).tenants.find(x => x.id === tenant.id).config.real_estate;
    ok(re.screening[0] === 'has_agent' && re.screening.indexOf('timeline') === -1 && re.screening.length === 7, 'screening saved: has_agent first, timeline skipped');
    ok(re.renters === true && re.agent_name === 'Jenna Harper', 'renters + trimmed agent name saved');
    ok(re.follow_up_boss && re.follow_up_boss.enabled === false && re.meetings && typeof re.meetings === 'object', 'follow_up_boss + meetings kept (one-level merge, never sent by the portal)');
    ok((await db(page)).events.filter(e => e.type === 'settings_updated' && e.entity_id === tenant.id).pop().payload.fields.join() === 'real_estate', 'settings_updated logs only real_estate');
    ok(await page.$eval('#setScreen', x => x.open) && (await page.$$eval('#rxre_list .qreq', rs => rs.map(r => r.dataset.rek)))[0] === 'has_agent' && !(await page.$eval('#rxre_q_timeline', c => c.checked)), 'after save: card stays open, order + skipped question shown from the config');
    // renters off again
    await page.$eval('#rxre_renters', c => { c.checked = false; }); await page.$eval('[data-rxsave="screen"]', b => b.click()); await sleep(300);
    ok((await db(page)).tenants.find(x => x.id === tenant.id).config.real_estate.renters === false, 'renters checkbox saves false too');
    // chat box card
    const runtimeUrl = brand.demo.runtime_url.replace(/\/+$/, '');
    await page.$eval('#setChat', x => { x.open = true; });
    const snip = await page.$eval('#rxwc_snip', e => e.value);
    ok(snip === '<script src="' + runtimeUrl + '/chat/widget.js" data-tenant="' + tenant.slug + '" async></script>', 'chat card: exact embed snippet from brand.json demo.runtime_url + tenant slug');
    ok(await page.$eval('#rxwc_snip', e => e.readOnly), 'chat card: snippet is read-only');
    const chatTxt = await page.$eval('#setChat', e => e.innerText);
    ok(/right before the closing <\/body> tag/.test(chatTxt) && /any site builder/.test(chatTxt), 'chat card: paste instruction');
    ok(/https:\/\/example-realty\.test/.test(await page.$eval('#rxwc_origins', e => e.innerText)) && /Chat only works on these addresses\. To add one, send us a Request\./.test(chatTxt), 'chat card: allowed website addresses (read-only) + note');
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; });
    await page.click('#rxwc_copy'); await sleep(100);
    ok(await page.evaluate(() => window.__copied) === snip && /Copied/.test(await page.$eval('#rxMsg_chat', e => e.innerText)), 'Copy button copies the snippet');
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
    await page.click('#rxwc_copy'); await sleep(100);
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'rxwc_snip' && document.activeElement.selectionEnd > 10), 'Copy fallback selects the snippet text');
    // webchat off -> no card
    await page.evaluate(id => { const x = window.StartMock.admin.db(); x.tenants.find(t => t.id === id).config.webchat.enabled = false; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); }, tenant.id);
    await page.goto(BASE + '/start/?r=6#receptionist', { waitUntil: 'load' }); await page.waitForSelector('#rxPause');
    ok(await page.$('#setChat') === null && await page.$('#setScreen') !== null, 'webchat.enabled false: no chat card (screening card stays)');
    await page.evaluate(id => { const x = window.StartMock.admin.db(); x.tenants.find(t => t.id === id).config.webchat.enabled = true; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); }, tenant.id);
    // direct calls (same codes as the RPC)
    const direct = patch => page.evaluate((tid, p) => window.Backend.updateTenantSettings(tid, p).then(() => 'ok', e => e.message), tenant.id, patch);
    ok(await direct({ real_estate: { follow_up_boss: { enabled: true } } }) === 'invalid_setting:real_estate.follow_up_boss', 'client cannot set follow_up_boss');
    ok(await direct({ real_estate: { screening: ['intent', 'intent'] } }) === 'invalid_setting:real_estate.screening', 'duplicate screening question refused');
    ok(await direct({ real_estate: { screening: ['zip_code'] } }) === 'invalid_setting:real_estate.screening', 'unknown screening question refused');
    ok(await direct({ real_estate: { agent_name: 'x'.repeat(81) } }) === 'invalid_setting:real_estate.agent_name', 'agent name over 80 refused');
    ok(await direct({ real_estate: { meetings: { landlord: 'x' } } }) === 'invalid_setting:real_estate.meetings.landlord', 'unknown meeting key refused');
    ok(await direct({ real_estate: { crm: 1 } }) === 'invalid_setting:real_estate', 'unknown real_estate key refused');
    ok(await direct({ webchat: { enabled: false } }) === 'field_not_allowed: webchat', 'webchat is not client-editable');
    ok(await direct({ real_estate: { meetings: { buyer: 'Buyer consultation' } } }) === 'ok', 'meetings accepted on a direct call (runtime checks job types)');
    re = (await db(page)).tenants.find(x => x.id === tenant.id).config.real_estate;
    ok(re.meetings.buyer === 'Buyer consultation' && re.screening[0] === 'has_agent' && re.follow_up_boss.enabled === false, 'partial patch keeps screening + follow_up_boss');
    await page.goto(BASE + '/start/?r=7#receptionist', { waitUntil: 'load' }); await page.waitForSelector('#rxPause');
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
    ok((await overflow(page)).length === 0, 'receptionist with screening + chat cards: no overflow 375/390/414/1280');

    // ---------------------------------------------------------------- Requests
    console.log('requests');
    await tabTo(page, 'requests');
    await page.click('#reqSend'); await sleep(100);
    ok(/write what you need/.test(await page.$eval('#reqMsg', e => e.innerText)), 'request title required');
    for (const title of ['Add a question about filter size', 'Change Saturday hours', 'Spanish greeting']) {
      await setVal(page, '#reqTitle', title); await page.click('#reqSend'); await page.waitForFunction(() => !document.querySelector('#reqTitle').value, { timeout: 3000 }).catch(() => {});
      await sleep(150);
    }
    let qs = await page.$$eval('.qreq b', b => b.map(x => x.textContent));
    ok(qs.join('|') === 'Add a question about filter size|Change Saturday hours|Spanish greeting', 'three requests queued in order');
    const lastId = await page.$eval('.qreq:last-child', e => e.dataset.id);
    await page.click('[data-up="' + lastId + '"]'); await sleep(300);
    qs = await page.$$eval('.qreq b', b => b.map(x => x.textContent));
    ok(qs[1] === 'Spanish greeting', 'move up reorders the queue');
    ok(await page.evaluate(() => document.activeElement && (document.activeElement.dataset.up || document.activeElement.dataset.down)) !== undefined, 'focus stays on the move button');
    await page.click('[data-pause="' + lastId + '"]'); await sleep(300);
    ok((await db(page)).requests.find(r => r.id === lastId).paused === true && /Paused/.test(await page.$eval('.qreq[data-id="' + lastId + '"]', e => e.innerText)), 'pause a queued request');
    const firstId = await page.$eval('.qreq:first-child', e => e.dataset.id);
    // admin makes the first request active (one active per client); client can no longer edit or cancel it
    await page.evaluate(id => { const x = window.StartMock.admin.db(); x.requests.find(r => r.id === id).status = 'active'; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); }, firstId);
    ok(await page.evaluate(id => window.Backend.saveRequest(id, { title: 'hijack' }).then(() => 'ok', e => e.message), firstId) === 'request_locked', 'active request locked for the client');
    ok(await page.evaluate(id => window.Backend.cancelRequest(id).then(() => 'ok', e => e.message), firstId) === 'request_locked', 'active request cannot be cancelled');
    const st = await page.evaluate(id => window.Backend.saveRequest(id, { status: 'active', paused: false }).then(r => r.status), lastId);
    ok(st === 'queued', 'client cannot activate a request (status kept)');
    await page.goto(BASE + '/start/?r=2#requests', { waitUntil: 'load' }); await page.waitForSelector('#reqForm');
    ok((await page.$$('.req')).length >= 1 && /In progress/.test(await body(page)), 'active request shown as In progress');
    const midId = await page.$eval('.qreq:first-child', e => e.dataset.id);
    await page.click('[data-cancel="' + midId + '"]'); await sleep(300);
    D = await db(page);
    ok(!D.requests.some(r => r.id === midId) && D.events.some(e => e.type === 'request_cancelled' && e.entity_id === midId), 'cancel = removed + logged');
    ok((await overflow(page)).length === 0, 'requests: no overflow');

    // ---------------------------------------------------------------- Billing usage
    await tabTo(page, 'billing');
    const bill = await page.$eval('#panel', e => e.innerText);
    ok(bill.includes('37 of ' + pb.rules.included_usage.voice_minutes.toLocaleString('en-US')) && bill.includes('112 of ' + pb.rules.included_usage.sms_segments.toLocaleString('en-US')), 'billing: usage vs included (pricebook)');
    ok(/never charge for extra minutes or texts on our own/.test(bill) && !/Claude|Twilio/.test(bill), 'billing: no-auto-overage note, no cost data for clients');
    ok((await overflow(page)).length === 0, 'billing: no overflow');
    // keyboard tabs
    await page.focus('#tab-home'); await page.keyboard.press('ArrowRight'); await sleep(80);
    ok(await page.$eval('#tab-onboarding', t => t.getAttribute('aria-selected')) === 'true', 'tabs: ArrowRight from Home -> Setup checklist');

    // ---------------------------------------------------------------- client B isolation
    console.log('isolation');
    await page.click('#logoutBtn'); await page.waitForSelector('#email');
    await signIn(page, '/start/', 'other@b7.test'); await profile(page, 'Other Co');
    const iso = await page.evaluate(async tid => ({
      ob: (await window.Backend.listOnboarding()).length, t: await window.Backend.getTenant(), calls: (await window.Backend.listCalls(tid)).length,
      req: (await window.Backend.listRequests()).length,
      w: await window.Backend.updateTenantSettings(tid, { paused: true }).then(() => 'ok', e => e.message),
      u: await window.Backend.getUsage(tid).then(() => 'ok', e => e.message)
    }), tenant.id);
    ok(iso.ob === 0 && iso.t === null && iso.calls === 0 && iso.req === 0, 'client B sees none of A’s checklist, tenant, calls, requests');
    ok(iso.w === 'not_your_tenant' && iso.u === 'not_your_tenant', 'client B cannot change A’s settings or read A’s usage');
    ok(await page.evaluate(() => window.StartMock.create(window.SITE_CONFIG).adminTenantUsage().then(() => 'ok', e => e.message)) === 'not_admin', 'client cannot call admin usage');
    ok(await page.evaluate(() => window.StartMock.create(window.SITE_CONFIG).adminSaveTenant({ client_id: 'x', slug: 'abc', config: {} }).then(() => 'ok', e => e.message)) === 'not_admin', 'client cannot call admin_save_tenant');

    // ---------------------------------------------------------------- admin Tenants tab
    console.log('admin tenants');
    await page.evaluate(() => window.Backend.signOut());
    await signIn(page, '/start/admin/', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()));
    await page.waitForSelector('#digest');
    await page.$eval('#seedBtn', b => b.click()); await sleep(500);
    await page.goto(BASE + '/start/admin/#tenants', { waitUntil: 'load' });
    await page.waitForSelector('#tuBody table', { timeout: 5000 });
    const usageTxt = await page.$eval('#tuBody', e => e.innerText);
    ok(usageTxt.includes('bright-air') && usageTxt.includes('212 / ' + pb.rules.included_usage.voice_minutes), 'admin usage: A7 demo tenant usage');
    ok(usageTxt.includes(tenant.slug) && usageTxt.includes('37 / ') && usageTxt.includes('$0.42') && usageTxt.includes('$1.37'), 'admin usage: runtime key layout (usage/spend/cost:twilio)');
    // bright-air demo config is not schema-valid -> errors listed in Hebrew
    await page.click('#alist [data-k]'); await sleep(200);
    const sel1 = await page.evaluate(() => location.hash);
    await page.goto(BASE + '/start/admin/' + sel1, { waitUntil: 'load' });
    await page.waitForSelector('#tJson');
    const brightId = (await db(page)).tenants.find(x => x.slug === 'bright-air').id;
    await page.goto(BASE + '/start/admin/#tenants/' + brightId, { waitUntil: 'load' }); await page.waitForSelector('#tJson'); await sleep(200);
    const errTxt = await page.$eval('#tMsg', e => e.innerText);
    ok(/business\.main_phone/.test(errTxt) && /שדה חובה חסר/.test(errTxt) && /business\.niche/.test(errTxt), 'editor: schema errors (required, enum) in Hebrew with paths');
    await page.click('#tSave'); await sleep(200);
    ok((await db(page)).tenants.find(x => x.id === brightId).config.business.main_phone === undefined, 'invalid config is not saved');
    await page.$eval('#tJson', e => { e.value = '{ broken'; }); await page.click('#tCheck');
    ok(/JSON לא תקין/.test(await page.$eval('#tMsg', e => e.innerText)), 'editor: invalid JSON reported');
    // fix it: valid config
    const valid = { business: { name: 'Bright Air', niche: 'home_services', timezone: 'America/Phoenix', main_phone: '+16025550100' }, hours: { mon: ['07:00', '18:00'] },
      booking: { windows: [['08:00', '12:00']], job_types: ['AC repair'] }, notify: { email: ['ray@brightair.test'] } };
    await page.$eval('#tJson', (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); }, JSON.stringify(valid));
    await page.click('#tCheck');
    ok(/תקין מול tenant_schema.json/.test(await page.$eval('#tMsg', e => e.innerText)), 'editor: valid config passes');
    await page.click('#tSave'); await sleep(400);
    D = await db(page);
    ok(D.tenants.find(x => x.id === brightId).config.business.main_phone === '+16025550100' && D.events.some(e => e.type === 'tenant_saved' && e.entity_id === brightId), 'tenant saved through adminSaveTenant + event');
    // A's tenant: merge onboarding data
    await page.goto(BASE + '/start/admin/#tenants/' + tenant.id, { waitUntil: 'load' }); await page.waitForSelector('#tMerge'); await sleep(200);
    ok(/Where do I find my EIN/.test(await page.$eval('#detail', e => e.innerText)), 'admin sees checklist progress + help message');
    await page.click('#tMerge'); await sleep(100);
    const merged = JSON.parse(await page.$eval('#tJson', e => e.value));
    ok(merged.business.timezone === 'America/Chicago' && merged.emergency.keywords.join() === 'gas smell,flooding' && merged.booking.provider === 'google' && merged.booking.job_types.join() === 'AC repair,Furnace repair', 'merge onboarding data -> config (time zone, emergency, calendar, services)');
    ok(!((await db(page)).tenants.find(x => x.id === tenant.id).config.emergency || {}).keywords, 'merge does not save by itself');
    await page.click('#tSave'); await sleep(400);
    ok((await db(page)).tenants.find(x => x.id === tenant.id).config.emergency.keywords.length === 2, 'merged config saved');
    // create a tenant for a client without one
    const ray = (await db(page)).clients.find(c => c.business_name === 'Bright Air Heating & Cooling');
    ok(!!ray, 'demo client exists');
    const newC = await page.evaluate(() => { const x = window.StartMock.admin.db(); const c = { id: crypto.randomUUID(), user_id: null, quote_id: null, products: ['RCP'], status: 'onboarding', business_name: 'Quick Fix Garage', monthly_cents: 30000, created_at: new Date().toISOString() }; x.clients.push(c); localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); return c.id; });
    await page.goto(BASE + '/start/admin/?r=3#tenants/new-' + newC, { waitUntil: 'load' }); await page.waitForSelector('#tSlug'); await sleep(150);
    ok((await page.$eval('#tSlug', e => e.value)) === 'quick-fix-garage', 'new tenant: slug suggested from the business name');
    await page.$eval('#tJson', (e, v) => { e.value = v; }, JSON.stringify(Object.assign({}, valid, { business: Object.assign({}, valid.business, { name: 'Quick Fix' }) })));
    await page.$eval('#tNum', e => { e.value = '7135550100'; }); await page.click('#tSave'); await sleep(150);
    ok(/E\.164/.test(await page.$eval('#tMsg', e => e.innerText)), 'twilio number must be E.164');
    await page.$eval('#tNum', e => { e.value = '+17135550188'; }); await page.click('#tSave'); await sleep(400);
    ok((await db(page)).tenants.some(x => x.client_id === newC && x.slug === 'quick-fix-garage' && x.twilio_number === '+17135550188'), 'tenant created for client');
    ok(await page.$('#tSim[disabled]') !== null, 'simulator button present, disabled until the runtime endpoint exists');
    ok((await overflow(page)).length === 0, 'admin tenants: no overflow (RTL)');
    // retainer queue: client-paused request flagged, cannot be activated
    const pausedId = await page.evaluate(() => { const x = window.StartMock.admin.db(); const r = x.requests.find(q => q.status === 'queued'); r.paused = true; localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)); return r.id; });
    await page.goto(BASE + '/start/admin/?r=4#requests', { waitUntil: 'load' }); await page.waitForSelector('#reqList');
    ok(await page.$('#rp-' + pausedId) !== null && /מושהה ע"י הלקוח/.test(await page.$eval('#rp-' + pausedId, e => e.textContent)), 'admin queue: "paused by client" pill');
    await page.select('#rs-' + pausedId, 'active'); await page.click('[data-rsave="' + pausedId + '"]'); await sleep(300);
    ok((await db(page)).requests.find(r => r.id === pausedId).status === 'queued', 'admin cannot activate a paused request (UI)');
    ok(await page.evaluate(id => window.AdminBackend.adminSaveRequest(id, { status: 'active' }).then(() => 'ok', e => e.message), pausedId) === 'request_paused', 'admin cannot activate a paused request (backend)');
    ok(await page.evaluate(() => document.documentElement.lang === 'he' && document.documentElement.dir === 'rtl'), 'admin in Hebrew RTL');
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
