// E2E for the client portal (/start/) against the MOCK backend. Puppeteer + local Chrome. No network beyond localhost
// (Google Fonts requests are blocked to keep the run offline and deterministic).
//   node tools/e2e_start.mjs            (own static server on E2E_PORT, default 8931)
//   E2E_BASE=http://localhost:8787 node tools/e2e_start.mjs
// Exit 0 = all assertions passed.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromePath } from './_chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../site');
const PORT = +(process.env.E2E_PORT || 8931);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
async function newPage(browser, opts = {}) {
  const page = await browser.newPage();
  // Always the mock backend, whatever /assets/config.js says (it points at the real project once A2 has run).
  // backend.js honours this per-tab flag on localhost; a fresh tab has no sessionStorage, so set it before any script.
  await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('start_force_mock', '1'); } catch (e) { /* storage blocked */ } });
  await page.setViewport({ width: opts.width || 390, height: 844, deviceScaleFactor: 1 });
  await page.emulateTimezone('America/Chicago');
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    if ((opts.founder || opts.brandPatch) && u.endsWith('/assets/brand.json')) {
      const b = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8')); if (opts.founder) b.show_founder_price = true; Object.assign(b, opts.brandPatch || {});
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    }
    r.continue();
  });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('uncaught: ' + e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const text = (page, sel) => page.$eval(sel, el => el.textContent).catch(() => null);
const exists = async (page, sel) => !!(await page.$(sel));
const waitText = (page, needle, timeout = 5000) => page.waitForFunction(n => document.body.innerText.includes(n), { timeout }, needle).then(() => true).catch(() => false);
async function overflowAt(page, widths = [375, 390, 414, 1280]) {
  const bad = [];
  for (const w of widths) {
    await page.setViewport({ width: w, height: 844, deviceScaleFactor: 1 });
    await sleep(60);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (sw > 0) bad.push(w + ':' + sw);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  return bad;
}
const hebrew = page => page.evaluate(() => /[\u0590-\u05FF]/.test(document.body.innerText));
// choice inputs are clicked via the DOM: at 390px the sticky progress bar can cover the scrolled-to point
const pick = (page, sel) => page.$eval(sel, el => el.click());
async function clickNext(page) { await pick(page, '#nextBtn'); await sleep(80); }
async function stepId(page) { return page.evaluate(() => location.hash.slice(1)); }
async function signIn(page, email) {
  await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
  await page.waitForSelector('#email');
  await page.type('#email', email);
  await page.click('#sendBtn');
  await page.waitForSelector('#mockCode');
  const code = await text(page, '#mockCode');
  await page.type('#code', code);   // auto-submits at 6 digits
  await page.waitForFunction(() => !document.querySelector('#codeForm'), { timeout: 5000 });
}
async function fillProfile(page) {
  await page.waitForSelector('#profileForm');
  await page.type('#p_full_name', 'Dani Levi');
  await page.type('#p_company', 'Cool Breeze HVAC');
  await page.type('#p_phone', '(713) 555-0100');
  await page.type('#p_city', 'Houston');
  await page.select('#p_state', 'TX');
  await page.click('#pSave');
}

async function main() {
  if (!process.env.E2E_BASE) await serve();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-first-run'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-start-'));
  try {
    let page = await newPage(browser);
    // ---------------------------------------------------------------- sign in
    console.log('sign in');
    await page.goto(BASE + '/start/?mock=1', { waitUntil: 'load' });
    await page.evaluate(() => window.StartMock.admin.reset());
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#email');
    ok(await exists(page, '#mockBanner') && await page.evaluate(() => window.Backend.mode) === 'mock', 'mock backend + banner (forced per tab)');
    ok(await page.$eval('#googleBtn', b => b.disabled), 'Google button present and disabled (not configured)');
    const brand = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8'));
    ok((await text(page, '.brandmark')).trim() === brand.name, 'brand name filled from brand.json');
    ok((await text(page, '#footer')).includes(brand.disclaimers.footer), 'footer disclaimer from brand.json');
    ok(!(await hebrew(page)), 'no Hebrew on sign-in screen');
    ok((await page.$eval('html', h => h.dir)) === 'ltr', 'page is LTR');
    ok((await overflowAt(page)).length === 0, 'sign-in: no horizontal overflow at 375/390/414/1280');
    await page.type('#email', 'not-an-email');
    await page.click('#sendBtn');
    ok(await waitText(page, 'doesn’t look right'), 'invalid email rejected');
    await page.$eval('#email', e => { e.value = ''; });
    await page.type('#email', 'dani@coolbreeze.test');
    await page.click('#sendBtn');
    await page.waitForSelector('#mockCode');
    ok(!(await page.$eval('#codeForm', f => f.hidden)), 'code form visible after sending');
    const code = await text(page, '#mockCode');
    ok(/^\d{6}$/.test(code), 'mock inbox shows a 6-digit code');
    ok((await page.$eval('#mockLink', a => a.href)).includes('mock_token='), 'mock inbox shows a magic link');
    const wrong = code === '000000' ? '111111' : '000000';
    await page.type('#code', wrong);
    ok(await waitText(page, 'wrong or has expired'), 'wrong code rejected');
    await page.$eval('#code', e => { e.value = ''; });
    await page.$eval('#verifyBtn', b => { b.disabled = false; });
    await page.type('#code', code);
    await page.waitForSelector('#profileForm', { timeout: 5000 });
    ok(true, 'correct code signs in → profile');
    // ---------------------------------------------------------------- profile
    console.log('profile');
    ok((await page.$eval('#p_timezone', s => s.value)) === 'America/Chicago', 'time zone auto-detected');
    ok((await page.$eval('#p_update_lang', s => s.value)) === 'en', 'update_lang defaults to English');
    ok((await page.$$eval('#p_update_lang option', o => o.map(x => x.value))).join() === ',en,he', 'update_lang offers en/he');
    await page.click('#pSave');
    ok(await waitText(page, 'Missing: Full name'), 'profile requires name/business/phone');
    await page.type('#p_full_name', 'Dani Levi'); await page.type('#p_company', 'Cool Breeze HVAC'); await page.type('#p_phone', '123');
    await page.click('#pSave');
    ok(await waitText(page, 'phone number doesn’t look right'), 'bad phone rejected');
    await page.$eval('#p_phone', e => { e.value = ''; }); await page.type('#p_phone', '(713) 555-0100');
    await page.type('#p_city', 'Houston'); await page.select('#p_state', 'TX');
    ok((await overflowAt(page)).length === 0, 'profile: no overflow');
    await page.click('#pSave');
    await page.waitForSelector('[role=tablist]');
    ok((await page.$$eval('[role=tab]', t => t.map(x => x.textContent))).join() === 'Home,Quotes,Billing', 'portal tabs = Home, Quotes, Billing');
    ok(await waitText(page, 'Start the questionnaire'), 'single next action: start questionnaire');
    ok((await text(page, '#hello')) === 'Hi Dani.', 'greets by first name');
    // ---------------------------------------------------------------- questionnaire
    console.log('questionnaire');
    await page.click('#startQ');
    await page.waitForSelector('#stepTitle');
    const qid = await page.evaluate(() => new URLSearchParams(location.search).get('id'));
    ok(/^[0-9a-f-]{36}$/.test(qid), 'questionnaire created');
    ok((await stepId(page)) === 'project', 'starts on project step');
    ok((await page.$$eval('input[name=offer]', i => i.map(x => x.value))).join() === 'RCP,WEB,BNDL,UNSURE', 'offer choices RCP/WEB/BNDL/UNSURE');
    ok((await page.$$eval('input[name=niche]', i => i.map(x => x.value))).join() === 'home_services,real_estate', 'niche closed list (home services + real estate only; no law, no health care)');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('input[name=niche]')].some(i => i.closest('label').innerText.toLowerCase().includes('early access')))), 'no early-access niche offered');
    const pb = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/pricebook.json'), 'utf8'));
    const rcp = pb.items.find(i => i.code === 'RCP');
    const usd = c => '$' + (c / 100).toLocaleString('en-US');
    ok(await waitText(page, usd(rcp.setup_cents) + ' setup + ' + usd(rcp.monthly_cents) + '/mo'), 'offer card price from pricebook.json');
    // the founder price follows brand.json show_founder_price (owner turned it on 2026-10-11); label from the price book
    const flagOn = !!JSON.parse(fs.readFileSync(path.join(SITE, 'assets/brand.json'), 'utf8')).show_founder_price;
    const fLabel = pb.rules.discounts.FOUNDING.label;
    ok(flagOn === !!(await waitText(page, fLabel, flagOn ? 3000 : 300)), 'founder price ' + (flagOn ? 'shown (flag on)' : 'hidden (flag off)'));
    await clickNext(page);
    ok(await waitText(page, 'Please choose what you’d like a quote for'), 'project step requires an offer');
    await pick(page, 'input[name=offer][value=RCP]');
    await pick(page, 'input[name=niche][value=home_services]');
    ok((await text(page, '.lbls span')).startsWith('Step 1 of 7'), 'RCP path = 6 steps + review [' + await text(page, '.lbls span') + ']');
    // branch: UNSURE adds "recommend"
    await pick(page, 'input[name=offer][value=UNSURE]');
    ok((await page.evaluate(() => window.StartQ.stepsFor({ offer: 'UNSURE', niche: 'home_services' }).map(s => s.id).join())) === 'project,recommend,business,calls,tools,finish', 'UNSURE adds the recommend step');
    ok((await page.evaluate(() => document.activeElement && document.activeElement.value)) === 'UNSURE', 'focus kept after branch re-render');
    await clickNext(page);
    ok((await stepId(page)) === 'recommend', 'UNSURE → recommend step');
    ok((await page.$$('#stepTitle ~ .field, #stepTitle ~ fieldset')).length === 3, 'recommend step asks 3 questions');
    await page.click('#prevBtn'); await sleep(80);
    // branch: WEB → website step, no calls
    await pick(page, 'input[name=offer][value=WEB]');
    const webSteps = await page.evaluate(() => window.StartQ.stepsFor({ offer: 'WEB', niche: 'home_services' }).map(s => s.id).join());
    ok(webSteps === 'project,business,website,look,finish', 'WEB branch steps');
    // branch: real estate
    await pick(page, 'input[name=offer][value=RCP]');
    await pick(page, 'input[name=niche][value=real_estate]');
    await clickNext(page); await clickNext(page);
    ok((await text(page, '#stepTitle')) === 'Your leads today', 'real estate: calls step framed as leads');
    ok(await exists(page, 'input[name=re_lead_types][value=renters]') && await exists(page, 'input[name=re_qualify][value=preapproval]'), 'real estate: lead type + pre-approval questions');
    ok(!(await exists(page, 'input[name=after_hours]')), 'real estate: no receptionist after-hours question');
    await clickNext(page);
    ok(await exists(page, 'input[name=re_crm][value=kvcore]'), 'real estate: CRM question incl. kvCORE');
    const crmKeys = await page.$$eval('input[name=re_crm]', i => i.map(x => x.value));
    const pbx = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/pricebook.json'), 'utf8'));
    const cfgCrm = Object.keys(pbx.integration_meta).filter(k => k !== 'other' && k in pbx.integrations && pbx.integration_meta[k].category === 'crm' && pbx.integration_meta[k].niches.includes('real_estate'));
    ok(await page.evaluate(() => [...document.querySelectorAll('input[name=re_crm]')].find(i => i.value === 'kvcore').closest('label').innerText.trim()) === pbx.integration_meta.kvcore.label, 'kvCORE label read from integration_meta');
    ok(crmKeys.join() === cfgCrm.concat(['other', 'none']).join(), 'real estate CRM options = pricebook config (' + crmKeys.join() + ')');
    ok(await page.evaluate(() => { const pb = JSON.parse(JSON.stringify(window.Start.PB)); pb.integrations.test_crm = 'zapier'; pb.integration_meta.test_crm = { label: 'Test CRM', category: 'crm', niches: ['real_estate'] }; return window.StartQ.reCrmOptions({ niche: 'real_estate' }, pb).some(o => o.v === 'test_crm'); }), 'new CRM key in config appears without code change');
    ok(await page.evaluate(() => typeof window.SITE_CONFIG === 'object' && window.Backend.mode === 'mock'), 'portal reads /assets/config.js');
    ok(!(await exists(page, 'input[name=tools][value=follow_up_boss]')) && !(await exists(page, 'input[name=tools][value=kvcore]')), 'real estate: CRM keys (FUB, kvCORE) not duplicated in tools');
    ok(await page.evaluate(() => { const crm = window.StartQ.reCrmOptions({ niche: 'real_estate' }, window.Start.PB).map(o => o.v); return !window.StartQ.toolOptions({ niche: 'real_estate' }, window.Start.PB).some(o => o.v !== 'other' && crm.includes(o.v)); }), 'real estate: no tool appears in both questions');
    await pick(page, 'input[name=re_crm][value=other]');
    ok(await exists(page, '#f_tools_other'), 'CRM "other" reveals the text field');
    // back to project
    await page.goto(BASE + '/start/q/?id=' + qid + '#project', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#stepTitle');
    ok(!(await page.evaluate(() => window.StartQ.toolOptions({ niche: 'home_services' }, window.Start.PB).some(o => o.v === 'follow_up_boss' || o.v === 'kvcore'))), 'home services tools exclude niche-only tools');
    // field count limits
    const counts = await page.evaluate(() => ({ rcp: window.StartQ.countFields('RCP', 'home_services'), prof: window.StartQ.PROFILE.length,
      max: Math.max(...['RCP', 'WEB', 'UNSURE'].flatMap(o => ['home_services', 'real_estate'].map(n => window.StartQ.countFields(o, n)))) }));
    ok(counts.rcp + counts.prof <= 28, 'RCP path ≤ 28 fields incl. profile (' + (counts.rcp + counts.prof) + ')');
    ok(counts.max <= 28, 'every non-bundle path ≤ 28 questionnaire fields');
    // happy path: RCP × home services
    await pick(page, 'input[name=niche][value=home_services]');
    await pick(page, 'input[name=offer][value=RCP]');
    await clickNext(page);
    ok((await stepId(page)) === 'business', 'RCP → business');
    ok((await overflowAt(page)).length === 0, 'business step: no overflow');
    await pick(page, 'input[name=services][value=hvac]');
    const evil = '<img src=x onerror="window.__xss=1">Houston & 77005';
    await page.type('#f_service_area', evil);
    ok(await page.evaluate(id => !!localStorage.getItem('start_q_backup_' + id), qid), 'localStorage backup written while typing');
    await pick(page, 'input[name=locations][value="2"]');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#saveState').textContent), { timeout: 5000 }).catch(() => {});
    ok((await text(page, '#saveState')).startsWith('Saved'), 'autosave shows Saved');
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#stepTitle');
    ok((await stepId(page)) === 'business', 'resume: same step after reload');
    ok((await page.$eval('#f_service_area', i => i.value)) === evil, 'resume: answer restored');
    await clickNext(page);
    ok((await stepId(page)) === 'calls' && (await text(page, '#stepTitle')) === 'Your calls today', 'calls step');
    for (const [k, v] of [['who_answers', 'owner'], ['calls_week', '20_50'], ['missed_pct', '25_50'], ['after_hours', 'voicemail'], ['urgent', 'often'], ['job_value', '200_1k']])
      await pick(page, `input[name=${k}][value="${v}"]`);
    ok((await overflowAt(page)).length === 0, 'calls step: no overflow');
    await clickNext(page);
    ok((await stepId(page)) === 'tools', 'tools step');
    const toolVals = await page.$$eval('input[name=tools]', i => i.map(x => x.value));
    const expected = Object.keys(pb.integration_meta).filter(k => (pb.integration_meta[k].niches || ['*']).some(n => n === '*' || n === 'home_services'));
    ok(toolVals.join() === expected.join(), 'tool picker = pricebook closed list + Zapier + Other');
    ok(toolVals.includes('zapier') && toolVals.includes('other') && toolVals.length === 12, 'tool picker has 10 tools + Zapier + Other');
    ok(await waitText(page, 'no logins needed now'), 'onboarding details deferred until after purchase');
    await pick(page, 'input[name=tools][value=google_calendar]');
    await pick(page, 'input[name=tools][value=jobber]');
    ok(!(await exists(page, '#f_tools_other')), 'tools_other hidden until Other');
    await pick(page, 'input[name=tools][value=other]');
    ok(await exists(page, '#f_tools_other'), 'Other reveals tools_other');
    await page.type('#f_tools_other', 'Square');
    await clickNext(page);
    ok((await stepId(page)) === 'prefs', 'prefs step');
    await pick(page, 'input[name=spanish][value=some]');
    await pick(page, 'input[name=price_on_phone][value=no]');
    await clickNext(page);
    ok((await stepId(page)) === 'finish', 'finish step');
    await pick(page, 'input[name=timeline][value=month]');
    const f1 = path.join(tmp, 'price sheet.pdf'); fs.writeFileSync(f1, '%PDF-1.4 test');
    const f2 = path.join(tmp, 'virus.exe'); fs.writeFileSync(f2, 'MZ');
    const fin = await page.$('#fileIn');
    await fin.uploadFile(f1);
    await page.waitForSelector('#fileList li', { timeout: 5000 });
    ok((await text(page, '#fileList')).includes('price sheet.pdf'), 'file upload listed');
    const fin2 = await page.$('#fileIn'); await fin2.uploadFile(f2); await sleep(200);
    ok(await waitText(page, 'virus.exe: file type not supported'), 'unsupported file type rejected');
    await page.type('#f_more', 'Busy season is June–August.');
    ok((await overflowAt(page)).length === 0, 'finish step: no overflow');
    // keyboard: radios are native inputs reachable by Tab
    ok(await page.evaluate(() => [...document.querySelectorAll('.choice input')].every(i => i.tabIndex >= 0)), 'choices keyboard-focusable');
    await clickNext(page);
    ok((await stepId(page)) === 'review', 'review screen');
    const sumText = await text(page, '.sum');
    ok(sumText.includes('<img src=x onerror="window.__xss=1">Houston & 77005'), 'HTML injection rendered as text');
    ok(!(await exists(page, '.sum img')) && !(await page.evaluate(() => window.__xss)), 'no injected element / script ran');
    ok(sumText.includes('Jobber') && sumText.includes('Google Calendar'), 'summary shows tool labels');
    ok(!(await hebrew(page)), 'no Hebrew in questionnaire');
    const hints = await page.evaluate(id => window.StartQ.quoteHints(JSON.parse(localStorage.getItem('aplp_mock_db_v1')).questionnaires.find(q => q.id === id).answers, window.Start.PB), qid);
    ok(hints.add.some(a => a.code === 'ADD-LOC') && hints.add.some(a => a.code === 'ADD-CRM') && hints.add.some(a => a.code === 'ADD-ES'), 'quote hints: ADD-LOC, ADD-CRM, ADD-ES');
    ok(hints.custom.includes('tool:other'), 'quote hints: Other tool → custom');
    // edit link jumps back
    await page.click('[data-go=business]'); await sleep(80);
    ok((await stepId(page)) === 'business', 'review Edit jumps to the step');
    await page.evaluate(() => { location.hash = 'tools'; }); await sleep(150);
    ok((await text(page, '#stepTitle')) === 'Your tools', 'hashchange draws the step without reload');
    await page.goto(BASE + '/start/q/?id=' + qid + '#review', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#submitBtn');
    ok((await overflowAt(page)).length === 0, 'review: no overflow');
    await page.click('#submitBtn');
    await page.waitForSelector('#doneTitle', { timeout: 5000 });
    ok(await waitText(page, 'You’ll get a written fixed quote ' + brand.quote_sla_text), 'submit → quote promise from brand.quote_sla_text');
    ok(await waitText(page, 'text-back starts after carrier registration, typically 1–2 weeks'), 'what-happens-next: SMS registration line');
    const db = await page.evaluate(() => JSON.parse(localStorage.getItem('aplp_mock_db_v1')));
    const qrow = db.questionnaires.find(q => q.id === qid);
    ok(qrow.status === 'submitted' && qrow.submitted_at && qrow.offer === 'RCP' && qrow.niche === 'home_services', 'row submitted with offer + niche columns');
    ok(Array.isArray(qrow.summary) && qrow.summary.every(s => s.k && s.q != null), 'summary jsonb [{k,q,a}] saved');
    ok(db.events.some(e => e.type === 'q_submitted' && e.entity_id === qid), 'owner-notification event stub recorded');
    ok(db.outbox.some(m => m.template === 'q_received') && db.outbox.some(m => m.template === 'admin_q_submitted'), 'q_received + owner alert in mock outbox');
    ok(db.outbox.find(m => m.template === 'q_received').subject.endsWith(brand.quote_sla_text), 'q_received subject uses brand.quote_sla_text');
    ok(!(await page.evaluate(id => localStorage.getItem('start_q_backup_' + id), qid)), 'backup cleared after submit');
    // locked
    await page.goto(BASE + '/start/q/?id=' + qid, { waitUntil: 'load' }); await page.waitForSelector('#roTitle');
    ok(!(await exists(page, '.step input')) && await waitText(page, 'locked'), 'submitted questionnaire is read-only');
    ok((await page.evaluate(id => window.Backend.saveQuestionnaire(id, { answers: { x: 1 } }), qid)) === null, 'save after submit is refused');
    ok((await page.evaluate(id => window.Backend.submitQuestionnaire(id).then(() => 'ok', e => e.message), qid)) === 'questionnaire_locked', 'resubmit refused (questionnaire_locked)');
    // ---------------------------------------------------------------- portal states
    console.log('portal');
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok(await waitText(page, 'Questionnaire received'), 'home: questionnaire received');
    ok((await text(page, '.stepper [aria-current=step]')).includes('Quote'), 'stepper current = Quote');
    await page.goto(BASE + '/start/?mock_seed=quote_sent', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok((await page.$eval('#nextAction', a => a.getAttribute('href'))).startsWith('/quote/#t='), 'home: next action = review quote (token in fragment)');
    await page.focus('#tab-home'); await page.keyboard.press('ArrowRight'); await sleep(50);
    ok((await page.$eval('#tab-quotes', t => t.getAttribute('aria-selected'))) === 'true', 'tabs: arrow key moves to Quotes');
    ok(await waitText(page, usd(rcp.setup_cents) + ' setup + ' + usd(rcp.monthly_cents) + '/mo'), 'quotes tab shows pricebook totals');
    ok((await overflowAt(page)).length === 0, 'quotes tab: no overflow');
    await page.goto(BASE + '/start/?mock_seed=deposit_paid#billing', { waitUntil: 'load' }); await page.waitForSelector('#panel table');
    ok((await text(page, '#panel')).includes(usd(rcp.setup_cents * pb.rules.deposit_pct / 100)) && (await text(page, '#panel')).includes('Paid'), 'billing: deposit paid at deposit_pct');
    ok((await text(page, '#panel')).includes('Deposit (' + pb.rules.deposit_pct + '% of setup)'), 'billing: deposit % label from pricebook rules');
    ok((await overflowAt(page)).length === 0, 'billing tab: no overflow');
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok((await text(page, '.stepper [aria-current=step]')).includes('Setup checklist'), 'stepper: deposit paid → setup checklist');
    { const dir = path.join(SITE, 'start/assets'); const lit = fs.readdirSync(dir).filter(f => f.endsWith('.js')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && /24 hours|1 business day/.test(l)).map(l => f + ': ' + l.trim().slice(0, 60)));
      ok(lit.length === 0, 'no hard-coded turnaround in portal JS (' + lit.join(' | ') + ')'); }
    // go-live requested (B7 checklist) → status card shows Final payment as the next step
    await page.evaluate(() => { const db = JSON.parse(localStorage.getItem('aplp_mock_db_v1')); const c = db.clients[db.clients.length - 1];
      const ob = db.onboarding_items.filter(o => o.client_id === c.id); ob.forEach(o => { o.status = 'done'; }); if (ob[0]) ob[0].data = Object.assign({}, ob[0].data, { go_live_requested_at: new Date().toISOString() });
      c.status = 'testing'; if (!db.payments.some(p => p.client_id === c.id && p.kind === 'final')) db.payments.push({ id: 'fin-1', client_id: c.id, kind: 'final', amount_cents: 1, method: 'paypal', status: 'due', created_at: new Date().toISOString() });
      localStorage.setItem('aplp_mock_db_v1', JSON.stringify(db)); });
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    ok((await text(page, '.status__text')).includes('Next step: Final payment') && (await text(page, '#goBilling') || '').startsWith('Final payment'), 'go-live requested → next step Final payment');
    await page.click('#goBilling'); await sleep(80);
    ok((await page.$eval('#tab-billing', t => t.getAttribute('aria-selected'))) === 'true', 'Final payment button opens Billing');
    // ---------------------------------------------------------------- RLS: client B
    console.log('isolation');
    await page.click('#logoutBtn'); await page.waitForSelector('#email');
    await signIn(page, 'other@client.test');
    await fillProfile(page);
    await page.waitForSelector('[role=tablist]');
    ok(await waitText(page, 'Start the questionnaire'), 'client B starts empty');
    ok((await page.evaluate(() => window.Backend.listQuestionnaires())).length === 0, 'client B lists no questionnaires of A');
    ok((await page.evaluate(id => window.Backend.getQuestionnaire(id), qid)) === null, 'client B cannot read A’s questionnaire');
    ok((await page.evaluate(() => window.Backend.listQuotes())).length === 0 && (await page.evaluate(() => window.Backend.listPayments())).length === 0, 'client B sees no quotes/payments of A');
    await page.goto(BASE + '/start/q/?id=' + qid, { waitUntil: 'load' });
    ok(await waitText(page, 'Questionnaire not found'), 'client B opening A’s URL → not found');
    ok((await page.evaluate(id => window.Backend.deleteQuestionnaire(id).then(() => 'deleted', e => e.message), qid)) === 'questionnaire_locked', 'client B cannot delete A’s questionnaire');
    // landing intent: /start/?offer=WEB&niche=real_estate → straight into a prefilled questionnaire
    await page.goto(BASE + '/start/?offer=WEB&niche=real_estate', { waitUntil: 'load' });
    await page.waitForSelector('#stepTitle', { timeout: 5000 });
    ok(await page.$eval('input[name=offer][value=WEB]', i => i.checked) && await page.$eval('input[name=niche][value=real_estate]', i => i.checked), 'landing intent prefills offer + niche');
    ok(await waitText(page, 'Agent Website'), 'real estate offer wording (not "receptionist")');
    // delete a draft from the portal
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[data-del]');
    await page.click('[data-del]'); await sleep(300);
    ok((await page.evaluate(() => window.Backend.listQuestionnaires())).length === 0, 'draft deleted from portal');
    // magic link
    await page.click('#logoutBtn'); await page.waitForSelector('#email');
    await page.type('#email', 'dani@coolbreeze.test'); await page.click('#sendBtn'); await page.waitForSelector('#mockLink');
    const link = await page.$eval('#mockLink', a => a.href);
    await page.goto(link, { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]', { timeout: 5000 });
    ok(!(await page.evaluate(() => location.search.includes('mock_token'))), 'magic link signs in and is removed from the URL');
    ok((await page.evaluate(() => window.Backend.listQuestionnaires())).length === 1, 'magic link → same account (A) data');
    // ---------------------------------------------------------------- WEB: no quote step, deposit link
    console.log('web');
    const wid = await page.evaluate(() => window.Backend.createQuestionnaire({ offer: 'WEB', niche: 'home_services' }).then(r => r.id));
    await page.goto(BASE + '/start/q/?id=' + wid, { waitUntil: 'load' }); await page.waitForSelector('#stepTitle');
    ok((await page.evaluate(() => window.StartQ.stepsFor({ offer: 'WEB', niche: 'home_services' }).map(s => s.id).join())) === 'project,business,website,look,finish', 'WEB steps: content-focused, no tools');
    await clickNext(page); await clickNext(page);
    ok((await text(page, '#stepTitle')) === 'Your site details' && await exists(page, '#f_web_hours') && await exists(page, '#f_web_address') && await exists(page, 'input[name=domain]'), 'WEB: hours, address, domain');
    await page.type('#f_web_hours', 'Mon–Fri 7–6');
    await clickNext(page);
    ok(await exists(page, 'input[name=web_tone]') && await exists(page, '#f_web_colors') && await exists(page, 'input[name=content_have][value=logo]') && await exists(page, '#f_web_reviews'), 'WEB: tone, colors, logo/photos, reviews');
    await pick(page, 'input[name=web_tone][value=friendly]');
    await clickNext(page);
    ok(!(await exists(page, 'input[name=decider]')), 'WEB: no decider question');
    await clickNext(page);
    ok((await text(page, '#submitBtn')).includes('deposit link'), 'WEB submit button = request deposit link');
    await pick(page, '#submitBtn'); await page.waitForSelector('#doneTitle', { timeout: 5000 });
    ok(await waitText(page, 'Your deposit link is on its way — we email it ' + brand.quote_sla_text), 'WEB finish: deposit link + brand SLA');
    ok(await waitText(page, 'Draft in 3 business days after we have your content'), 'WEB finish: draft timing');
    ok(!(await waitText(page, 'written fixed quote', 300)) && !(await waitText(page, 'text-back', 300)), 'WEB finish: no quote / receptionist steps');
    ok(await waitText(page, 'Review:') && await waitText(page, 'Go live:'), 'WEB next steps: content → draft → review → go-live');
    ok(!(await exists(page, '#payDeposit')) === !(brand.endpoints && brand.endpoints.payment), 'deposit button only when brand.endpoints.payment exists');
    const wdb = await page.evaluate(() => JSON.parse(localStorage.getItem('aplp_mock_db_v1')));
    ok(wdb.events.some(e => e.type === 'web_deposit_link_requested' && e.entity_id === wid) && wdb.outbox.some(m => m.template === 'admin_web_deposit_link_requested'), 'owner event web_deposit_link_requested');
    ok(!wdb.events.some(e => e.type === 'q_submitted' && e.entity_id === wid), 'WEB does not emit the quote event');
    await page.close();
    // payment endpoint configured → direct deposit button
    page = await newPage(browser, { brandPatch: { endpoints: { payment: 'https://pay.example.test/deposit' } } });
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]', { timeout: 8000 });
    const wid2 = await page.evaluate(() => window.Backend.createQuestionnaire({ offer: 'WEB', niche: 'home_services' }).then(r => r.id));
    await page.goto(BASE + '/start/q/?id=' + wid2 + '#review', { waitUntil: 'load' }); await page.waitForSelector('#submitBtn');
    await pick(page, '#submitBtn'); await page.waitForSelector('#doneTitle', { timeout: 5000 });
    ok((await page.$eval('#payDeposit', a => a.textContent + '|' + a.getAttribute('href'))).startsWith('Pay the ' + pb.rules.deposit_pct + '% deposit|https://pay.example.test/deposit?offer=WEB&ref='), 'endpoints.payment → Pay the deposit button');
    await page.close();
    page = await newPage(browser);
    // BNDL stays on the quote path
    ok(await (async () => { await page.goto(BASE + '/start/', { waitUntil: 'load' }); return page.evaluate(() => window.StartQ.stepsFor({ offer: 'BNDL' }).some(s => s.id === 'tools')); })(), 'BNDL keeps the quote path');
    await page.close();
    // ---------------------------------------------------------------- founder flag (brand.json show_founder_price)
    page = await newPage(browser, { founder: true });
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    await page.click('#startQ').catch(() => {});
    await page.goto(BASE + '/start/', { waitUntil: 'load' }); await page.waitForSelector('[role=tablist]');
    const draftId = await page.evaluate(() => window.Backend.createQuestionnaire({}).then(r => r.id));
    await page.goto(BASE + '/start/q/?id=' + draftId, { waitUntil: 'load' }); await page.waitForSelector('#stepTitle');
    const disc = pb.rules.discounts.FOUNDING.setup_pct;
    ok(await waitText(page, pb.rules.discounts.FOUNDING.label + ': ' + usd(Math.round(rcp.setup_cents * (100 - disc) / 100))), 'founder price shown when flag is on');
    await page.close();
  } finally {
    await browser.close();
    if (server) server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  ok(consoleErrors.length === 0, 'no console errors (' + consoleErrors.slice(0, 3).join(' | ') + ')');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); if (server) server.close(); process.exit(1); });
