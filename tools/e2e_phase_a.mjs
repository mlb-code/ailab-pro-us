// A10 phase-A gate: the whole sale journey end to end on the MOCK backend (Puppeteer + local Chrome, offline).
//   landing / → "Get my fixed quote" → /start/ sign-in (link + 6-digit code) → profile → RCP questionnaire → submit
//   → admin: draft → approve & send → client opens /quote/#t=<token> → accept (name + consent) → portal "Pay deposit"
//   → admin: client card + mark deposit paid → 7-step checklist → early go-live refused → testing → go-live request
//   → final payment card. Plus the WEB self-serve path and the real-estate branch.
// Runs at 390 and 1280. Fails on any assertion, any console error / uncaught exception / local HTTP >= 400,
// any horizontal overflow, or any request to Supabase / Anthropic / Resend.
//   node tools/e2e_phase_a.mjs              (own static server on E2E_PORT, default: a free port)
//   E2E_WIDTHS=390 node tools/e2e_phase_a.mjs
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
const WIDTHS = (process.env.E2E_WIDTHS || '390,1280').split(',').map(Number);
const brand = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));
const pb = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/pricebook.json'), 'utf8'));
const item = c => pb.items.find(i => i.code === c);
const usd = c => '$' + (c / 100).toLocaleString('en-US');
const UPWORK_LINK = 'https://www.upwork.com/#E2E-PHASE-A';

const server = http.createServer((req, rsp) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const full = path.normalize(path.join(SITE, p));
  if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
  rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(rsp);
});
await new Promise(r => server.listen(+(process.env.E2E_PORT || 0), '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0, W = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL [' + W + '] ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];

async function run(browser, width) {
  W = width;
  const page = await browser.newPage();
  await page.setViewport({ width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1 });
  await page.emulateTimezone('America/Chicago');
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (/supabase\.co|anthropic\.com|resend\.com/.test(u)) { problems.push(width + ' live call attempted: ' + u); return r.abort(); }
    if (/fonts\.(googleapis|gstatic)\.com|googletagmanager|clarity\.ms/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });
  page.on('console', m => { if (m.type() === 'error') problems.push(width + ' console ' + page.url().replace(BASE, '') + ' :: ' + m.text()); });
  page.on('pageerror', e => problems.push(width + ' uncaught ' + page.url().replace(BASE, '') + ' :: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) problems.push(width + ' HTTP ' + r.status() + ' ' + r.url().replace(BASE, '')); });
  page.on('dialog', d => d.accept());

  const goto = async u => { await page.goto(BASE + u, { waitUntil: 'load' }); };
  const fresh = async u => { await goto(u); await page.reload({ waitUntil: 'load' }); };   // hash-only goto does not reload
  const body = () => page.evaluate(() => document.body.innerText);
  const waitText = (t, ms = 6000) => page.waitForFunction(x => document.body.innerText.includes(x), { timeout: ms }, t).then(() => true).catch(() => false);
  const pick = sel => page.$eval(sel, el => el.click());
  const db = () => page.evaluate(() => JSON.parse(localStorage.getItem('aplp_mock_db_v1')));
  // wait until the mock DB satisfies a predicate (no fixed sleeps: stable under CPU load)
  const until = (src, arg, ms = 10000) => page.waitForFunction(new Function('a', 'const d = JSON.parse(localStorage.getItem("aplp_mock_db_v1") || "{}"); return (' + src + ')(d, a);'), { timeout: ms, polling: 100 }, arg).then(() => true).catch(() => false);
  const noOverflow = async label => { const d = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(d <= 0, label + ': no horizontal overflow (' + d + ')'); };
  const signOut = () => page.evaluate(() => localStorage.removeItem('aplp_mock_session_v1'));
  async function codeSignIn(url, email, admin) {
    await fresh(url); await page.waitForSelector('#email');
    await page.type('#email', email); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
    const code = (await page.$eval('#mockCode', e => e.textContent)).trim();
    ok(/^\d{6}$/.test(code), url + ': 6-digit code in the mock inbox');
    await page.type('#code', code);
    if (admin) { await page.click('#verifyBtn').catch(() => {}); await page.waitForSelector('#digest', { timeout: 10000 }); }
  }
  async function profile(name, company, phone) {
    await page.waitForSelector('#profileForm');
    await page.type('#p_full_name', name); await page.type('#p_company', company); await page.type('#p_phone', phone);
    await page.type('#p_city', 'Houston').catch(() => {}); await page.select('#p_state', 'TX').catch(() => {});
    await page.click('#pSave');
    await page.waitForFunction(() => location.pathname.startsWith('/start/q/') || document.querySelector('[role=tablist]'), { timeout: 10000 });
    await sleep(300);
  }
  const next = async () => { await pick('#nextBtn'); await sleep(150); };
  // fills every visible, still-empty question on the current step with its first option / a short text
  const fillStep = () => page.evaluate(() => {
    const names = new Set([...document.querySelectorAll('#stepBody input[type=radio], form input[type=radio]')].map(i => i.name));
    names.forEach(n => { const g = [...document.querySelectorAll('input[name="' + n + '"]')]; if (!g.some(x => x.checked)) g[0].click(); });
    const cbNames = new Set([...document.querySelectorAll('input[type=checkbox]')].map(i => i.name).filter(Boolean));
    cbNames.forEach(n => { const g = [...document.querySelectorAll('input[name="' + n + '"]')]; if (!g.some(x => x.checked) && g[0].closest('[data-required], .field--req, fieldset')) g[0].click(); });
    document.querySelectorAll('input[type=text][required], textarea[required]').forEach(t => { if (!t.value) { t.value = 'Austin, TX'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
  });

  // ---------------------------------------------------------------- landing → sign-in → RCP questionnaire
  await goto('/start/?mock=1'); await page.evaluate(() => window.StartMock.admin.reset());
  // every public page: no unresolved {template} tokens from tools/build_landing.py in the visible text
  for (const u of ['/', '/home-services/', '/real-estate/', '/website/', '/demo/', '/legal/terms/', '/legal/privacy/', '/legal/service-agreement/']) {
    await goto(u);
    const raw = await page.evaluate(() => [...new Set(document.body.innerText.match(/\{[a-z_][a-z0-9_:.\-]*\}/gi) || [])]);
    ok(raw.length === 0, u + ': no unresolved template tokens' + (raw.length ? ' (' + raw.join(' ') + ')' : ''));
  }
  await goto('/');
  await noOverflow('landing /');
  const cta = await page.$$eval('a', as => (as.find(a => /Get my fixed quote/i.test(a.textContent)) || {}).getAttribute?.('href') || null);
  ok(cta === '/start/?offer=RCP&niche=home_services', 'landing CTA "Get my fixed quote" → /start/?offer=RCP&niche=home_services (' + cta + ')');
  await goto(cta);
  ok(await page.evaluate(() => window.Backend && window.Backend.mode) === 'mock', '/start/ runs on the mock backend');
  await page.waitForSelector('#email');
  await page.type('#email', 'dani@coolbreeze.test'); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  ok(!!(await page.$eval('#mockLink', a => a.href).catch(() => '')), 'sign-in: magic link in the mock inbox');
  await page.type('#code', (await page.$eval('#mockCode', e => e.textContent)).trim());
  await profile('Dani Levi', 'Cool Breeze HVAC', '(713) 555-0100');
  ok(page.url().includes('/start/q/'), 'landing intent opens the questionnaire right after the profile');
  await page.waitForSelector('#stepTitle');
  ok(await page.$eval('input[name=offer][value=RCP]', i => i.checked).catch(() => false), 'intent: RCP preselected');
  ok(await page.$eval('input[name=niche][value=home_services]', i => i.checked).catch(() => false), 'intent: home services preselected');
  // 3 screens (spec 2026-10-29): profile, then "What you need" and "Extras that change the price"; no review screen
  ok(await waitText('Step 2 of 3'), 'questionnaire opens on step 2 of 3');
  await pick('input[name=offer][value=RCP]'); await pick('input[name=niche][value=home_services]');
  await pick('input[name=services][value=hvac]'); await pick('input[name=locations][value="1"]'); await noOverflow('q/need'); await next();
  ok(await page.evaluate(() => location.hash) === '#extras' && await waitText('Step 3 of 3'), 'RCP questionnaire: step 3 of 3 is the last screen');
  for (const [k, v] of [['calls_week', '20_50'], ['spanish', 'no'], ['dispatch', 'no']]) await pick(`input[name=${k}][value="${v}"]`);
  await pick('input[name=tools][value=google_calendar]'); await pick('input[name=tools][value=jobber]'); await noOverflow('q/extras');
  ok(!(await page.$('#nextBtn')) && await page.$eval('#submitBtn', b => b.textContent) === 'Get my fixed quote', 'step 3 ends with "Get my fixed quote" (no review screen)');
  await page.click('#submitBtn'); await page.waitForSelector('#doneTitle', { timeout: 10000 });
  ok(await waitText('written fixed quote ' + brand.quote_sla_text), 'done screen: quote promise from brand.quote_sla_text');
  await noOverflow('q/done');
  let d = await db();
  const qn = d.questionnaires.find(q => q.status === 'submitted' && q.offer === 'RCP');
  ok(!!qn && qn.niche === 'home_services', 'questionnaire submitted with offer RCP + niche');
  ok(d.outbox.some(m => m.template === 'q_received' && m.subject.endsWith(brand.quote_sla_text)), 'q_received e-mail (mock) uses quote_sla_text');

  // ---------------------------------------------------------------- admin: draft → approve & send
  await signOut();
  await codeSignIn('/start/admin/?mock=1', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()), true);
  d = await db();
  if (!d.quotes.some(q => q.questionnaire_id === qn.id)) {
    await fresh('/start/admin/#questionnaires'); await page.waitForSelector('#alist [data-id]');
    await page.click('#alist [data-id="' + qn.id + '"]').catch(() => page.click('#alist [data-id]')); await sleep(300);
    await page.waitForSelector('#mkDraft', { timeout: 4000 }); await page.click('#mkDraft'); await until('(d, id) => (d.quotes || []).some(q => q.questionnaire_id === id)', qn.id);
  }
  d = await db();
  const draft = d.quotes.find(q => q.questionnaire_id === qn.id);
  const expSetup = item('RCP').setup_cents + item('ADD-CRM').setup_cents, expMonthly = item('RCP').monthly_cents + item('ADD-CRM').monthly_cents;
  ok(!!draft && draft.items.map(i => i.code).join('+') === 'RCP+ADD-CRM', 'draft = RCP + ADD-CRM (Jobber) like SPEC §1');
  ok(!!draft && draft.setup_cents === expSetup && draft.monthly_cents === expMonthly, 'draft totals from the price book (' + usd(expSetup) + ' + ' + usd(expMonthly) + '/mo)');
  ok(d.outbox.some(m => m.template === 'admin_new_quote'), 'admin_new_quote e-mail (mock)');
  await fresh('/start/admin/#quotes/' + draft.id); await page.waitForSelector('#detail .lines', { timeout: 10000 });
  await noOverflow('admin quote editor');
  // payment rail: Upwork Direct Contracts is preselected; Meir pastes the contract link (optional)
  ok(await page.$eval('#payMethod', s => s.value) === 'upwork', 'admin: pay method preselected = Upwork');
  await page.type('#payLink', UPWORK_LINK);
  await page.click('#sendBtn'); await until('(d, id) => d.quotes.some(q => q.id === id && q.status === "sent")', draft.id);
  d = await db();
  const sent = d.quotes.find(q => q.id === draft.id);
  ok(sent.status === 'sent' && !!sent.public_token, 'approve & send → sent, with a public token');
  ok(sent.pay_method === 'upwork' && sent.pay_link === UPWORK_LINK, 'sent on Upwork with the contract link');
  ok(d.outbox.some(m => m.template === 'quote_sent' && m.subject.includes(usd(expSetup)) && m.subject.includes(brand.name)), 'quote_sent e-mail (mock) with amounts + brand');

  // ---------------------------------------------------------------- client: quote page via #t= → accept
  await signOut();
  await fresh('/quote/#t=' + encodeURIComponent(sent.public_token));
  await page.waitForSelector('#acceptForm', { timeout: 10000 }).catch(() => {});
  const qtxt = await body();
  ok(!/Quote not found/i.test(qtxt) && !!(await page.$('#acceptForm')), 'quote page opens the mock quote by #t= token');
  ok(qtxt.includes(usd(expSetup)) && qtxt.includes(usd(sent.deposit_cents)), 'quote page shows setup total and deposit');
  for (const k of ['Included', 'Not included']) ok(qtxt.includes(k), 'quote page has "' + k + '" (from the price book)');
  ok(!(await page.evaluate(() => location.search)), 'token kept out of the query string');
  await noOverflow('quote page');
  await page.$eval('#accName', i => { i.value = ''; }); await page.click('#accBtn'); await sleep(200);
  ok(/full name/i.test(await page.$eval('#accMsg', e => e.innerText).catch(() => '')) || await page.$eval('#accName', i => !i.validity.valid), 'accept without a name is refused');
  await page.type('#accName', 'Dani Levi'); await page.click('#accBtn'); await sleep(200);
  ok(/agree/i.test(await page.$eval('#accMsg', e => e.innerText).catch(() => '')), 'accept without consent is refused');
  await page.click('#accAgree'); await page.click('#accBtn'); await until('(d, id) => d.quotes.some(q => q.id === id && q.status === "accepted")', sent.id);
  d = await db();
  const acc = d.quotes.find(q => q.id === sent.id);
  ok(acc.status === 'accepted' && acc.accepted_name === 'Dani Levi' && !!acc.agreement_version, 'accept stores status, name and agreement version');
  ok(d.outbox.some(m => m.template === 'admin_quote_accepted'), 'admin_quote_accepted e-mail (mock)');
  ok(await waitText('Open your Upwork contract'), 'quote page after accept: deposit step = "Open your Upwork contract"');
  ok(await page.$eval('#pay-slot a.btn', a => a.getAttribute('href')).catch(() => '') === UPWORK_LINK, 'the button opens the Upwork contract link');
  ok(/Fund the \$[\d,]+ deposit there by card, PayPal or bank transfer\./.test(await page.$eval('#pay-slot', e => e.innerText).catch(() => '')), 'funding line under the button');
  await noOverflow('quote page, Upwork deposit step');

  // ---------------------------------------------------------------- portal: deposit step
  await codeSignIn('/start/?mock=1', 'dani@coolbreeze.test');
  await page.waitForSelector('.status', { timeout: 10000 });
  ok(/Pay deposit/.test(await page.$eval('.status', e => e.innerText)), 'portal: next action "Pay deposit ' + usd(sent.deposit_cents) + '"');
  await noOverflow('portal deposit');

  // ---------------------------------------------------------------- admin: client card + deposit paid
  await signOut();
  await codeSignIn('/start/admin/?mock=1', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()), true);
  d = await db();
  if (!d.clients.some(c => c.quote_id === sent.id)) {
    await fresh('/start/admin/#quotes/' + sent.id); await page.waitForSelector('#mkClient', { timeout: 10000 });
    await page.click('#mkClient'); await until('(d, id) => d.clients.some(c => c.quote_id === id)', sent.id);
  }
  d = await db();
  const cl = d.clients.find(c => c.quote_id === sent.id);
  ok(!!cl, 'client card exists for the accepted quote');
  await fresh('/start/admin/#clients/' + cl.id); await page.waitForSelector('[data-pay]', { timeout: 10000 });
  await page.type('input[id^="ref-"]', 'PP-0001'); await page.click('[data-pay]'); await until('(d, id) => d.onboarding_items.filter(o => o.client_id === id).length === 7 && d.outbox.some(m => m.template === "deposit_received")', cl.id);
  await noOverflow('admin client');
  d = await db();
  ok(d.payments.some(p => p.client_id === cl.id && p.kind === 'deposit' && p.status === 'paid' && p.reference === 'PP-0001'), 'deposit marked paid with a reference');
  ok(d.outbox.some(m => m.template === 'deposit_received'), 'deposit_received e-mail (mock)');
  ok(d.onboarding_items.filter(o => o.client_id === cl.id).length === 7, 'deposit paid → 7 checklist items');

  // ---------------------------------------------------------------- client: checklist + go-live gate
  await signOut();
  await codeSignIn('/start/?mock=1', 'dani@coolbreeze.test'); await page.waitForSelector('#goOnboarding', { timeout: 10000 });
  await page.click('#goOnboarding'); await sleep(400);
  const steps = await page.$$eval('.obstep', s => s.map(x => x.dataset.key));
  ok(steps.join() === 'forward_calls,calendar,hours,faq,alerts,tools,sms', 'checklist = 7 steps in SPEC §6.8 order');
  ok(await page.$eval('#ob_golive', b => b.disabled).catch(() => true), 'go-live button disabled before testing');
  await noOverflow('checklist');
  await page.evaluate(async () => { const ob = await window.Backend.listOnboarding(); for (const o of ob) if (o.key !== 'sms') await window.Backend.updateOnboarding(o.id, 'done', {}).catch(() => {}); });
  const early = await page.evaluate(() => window.Backend.listOnboarding().then(ob => window.Backend.updateOnboarding(ob.find(o => o.key === 'sms').id, 'done', { go_live_requested_at: new Date().toISOString() })).then(() => 'ok', e => e.message));
  ok(early === 'go_live_not_ready', 'early go-live request refused (' + early + ')');
  await signOut();
  await codeSignIn('/start/admin/?mock=1', await page.evaluate(() => window.StartMock.MOCK_ADMIN_EMAIL()), true);
  await fresh('/start/admin/#clients/' + cl.id); await page.waitForSelector('#cSt', { timeout: 10000 });
  await page.select('#cSt', 'testing'); await page.click('#cStSave'); await until('(d, id) => d.clients.some(c => c.id === id && c.status === "testing")', cl.id);
  ok((await db()).outbox.some(m => m.template === 'ready_to_test'), 'status testing → ready_to_test e-mail (mock)');
  await signOut();
  await codeSignIn('/start/?mock=1', 'dani@coolbreeze.test'); await page.waitForSelector('[role=tablist]', { timeout: 10000 });
  await fresh('/start/#onboarding'); await page.waitForSelector('.obsteps', { timeout: 10000 });
  await page.$eval('#ob-sms', x => { x.open = true; });
  await page.$eval('#ob_legal', e => { e.value = 'Cool Breeze HVAC LLC'; });
  await page.$eval('#ob_ein', e => { e.value = '12-3456789'; });
  await page.$eval('#ob_addr', e => { e.value = '1200 Main St, Houston, TX 77002'; });
  await page.$eval('#ob_consent', c => { c.checked = true; });
  await page.$eval('#ob-sms [data-save]', b => b.click()); await until('d => d.onboarding_items.filter(o => o.status === "done").length >= 7');
  await page.waitForFunction(() => { const b = document.querySelector('#ob_golive'); return b && !b.disabled; }, { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('#ob_golive', b => !b.disabled).catch(() => false), 'go-live button enabled: 7/7 done and status testing');
  await page.$eval('#ob_golive', b => b.click()); await until('d => d.events.some(e => e.type === "go_live_requested") && d.outbox.some(m => m.template === "final_payment_due")');
  d = await db();
  ok(d.events.some(e => e.type === 'go_live_requested') && d.outbox.some(m => m.template === 'final_payment_due'), 'go-live request → event + final_payment_due e-mail (mock)');
  await fresh('/start/'); await page.waitForSelector('.status', { timeout: 10000 });
  ok(/Final payment/.test(await page.$eval('.status', e => e.innerText)), 'portal home after go-live request: final payment step');
  await noOverflow('portal final payment');

  // ---------------------------------------------------------------- WEB: package → content questionnaire → deposit link (no quote)
  await signOut();
  await goto('/website/');
  const web = await page.$$eval('a', as => (as.find(a => /Choose this package/i.test(a.textContent)) || {}).getAttribute?.('href') || null);
  ok(web === '/start/?offer=WEB' || /^\/start\/\?offer=WEB/.test(web || ''), '/website/ CTA → /start/?offer=WEB (' + web + ')');
  await goto(web); await page.waitForSelector('#email');
  await page.type('#email', 'web@shine.test'); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  await page.type('#code', (await page.$eval('#mockCode', e => e.textContent)).trim());
  await profile('Wendy Ward', 'Shine Cleaning', '(512) 555-0100');
  ok(page.url().includes('/start/q/'), 'WEB intent opens the content questionnaire');
  await page.waitForSelector('#stepTitle');
  await pick('input[name=offer][value=WEB]'); await pick('input[name=niche][value=home_services]');
  await pick('input[name=services][value=cleaning]'); await next();
  ok(await page.evaluate(() => location.hash) === '#extras' && await waitText('Step 3 of 3'), 'WEB questionnaire: 2 screens, no review');
  await pick('input[name=has_website][value=no]'); await pick('input[name=content_have][value=logo]'); await noOverflow('WEB q/extras');
  ok(/deposit link/i.test(await page.$eval('#submitBtn', b => b.textContent).catch(() => '')), 'WEB submit button asks for the deposit link (no quote)');
  await page.click('#submitBtn'); await page.waitForSelector('#doneTitle', { timeout: 10000 });
  const wd = await body();
  ok(/deposit link/i.test(wd) && !/written fixed quote/i.test(wd), 'WEB done screen: deposit link, no quote step');
  ok(!/alerts, calendar/i.test(wd), 'WEB done screen: no receptionist checklist wording');
  ok((await db()).events.some(e => e.type === 'web_deposit_link_requested'), 'event web_deposit_link_requested');
  await noOverflow('WEB done');

  // ---------------------------------------------------------------- real estate: landing → questionnaire branch
  await signOut();
  await goto('/real-estate/');
  ok(!/receptionist/i.test(await body()), '/real-estate/ never says "receptionist"');
  const re = await page.$$eval('a', as => (as.find(a => /fixed quote/i.test(a.textContent)) || {}).getAttribute?.('href') || null);
  ok(re === '/start/?offer=RCP&niche=real_estate', 'real-estate CTA keeps the niche (' + re + ')');
  await goto(re); await page.waitForSelector('#email');
  await page.type('#email', 'amy@lonestar.test'); await page.click('#sendBtn'); await page.waitForSelector('#mockCode');
  await page.type('#code', (await page.$eval('#mockCode', e => e.textContent)).trim());
  await profile('Amy Carter', 'Lone Star Homes', '(214) 555-0100');
  await page.waitForSelector('#stepTitle');
  ok(await page.$eval('input[name=niche][value=real_estate]', i => i.checked).catch(() => false), 'real-estate niche preselected');
  await pick('input[name=locations][value="1"]'); await next();
  ok((await page.$eval('#f_calls_week legend', e => e.textContent)) === 'Leads per week' && !!(await page.$('input[name=re_crm]')), 'real-estate branch: leads per week + CRM question');
  ok(!/receptionist/i.test(await body()), 'real-estate questionnaire never says "receptionist"');
  await noOverflow('real-estate questionnaire');
  await page.close();
}

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
try {
  for (const w of WIDTHS) { console.log('width ' + w); await run(browser, w); }
} catch (e) { fail++; console.log('  ABORT [' + W + '] ' + (e && e.stack || e)); }
finally { await browser.close(); server.close(); }
ok(problems.length === 0, 'no console errors, uncaught exceptions, local HTTP errors or live calls');
for (const p of [...new Set(problems)].slice(0, 20)) console.log('  ' + p);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
