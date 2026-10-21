// Quote page (/quote/) in MOCK mode against the shared browser mock DB (localStorage 'aplp_mock_db_v1', the same store the
// client portal and admin mocks use): view -> viewed, accept -> accepted + e-mail events, token removed from the URL,
// refusals (unsent, anonymised, expired, bad name). Own static server on PORT (default 8936). Exit 0 = all pass.
//   node tools/e2e_quote.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = +(process.env.PORT || 8936);
const BASE = `http://localhost:${PORT}`;
const srv = spawn('python3', ['tools/serve.py', String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());   // never leave the server running, even when a step throws
await new Promise(r => setTimeout(r, 900));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL ' + m); } };

const pb = JSON.parse(fs.readFileSync('site/assets/pricebook.json', 'utf8'));
const brand = JSON.parse(fs.readFileSync('site/assets/brand.json', 'utf8'));
const P = await import(process.cwd() + '/site/assets/pricing.mjs');
const r = P.priceQuote(pb, [{ code: 'RCP' }, { code: 'ADD-CRM' }]);
const now = Date.now(), iso = t => new Date(t).toISOString();
const tok = n => (n + 'x'.repeat(40)).slice(0, 40);
const base = { questionnaire_id: null, user_id: 'u1', items: P.storedItems(r), setup_cents: r.setup_cents, monthly_cents: r.monthly_cents,
  deposit_cents: r.deposit_cents, discount_code: null, scope_md: 'Mock scope for **Rapid Flow**.', assumptions: ['A1'], not_included_extra: [],
  timeline_text: 'About 10 business days.', pay_method: 'paypal_link', pay_link: null, agreement_version: brand.agreement_version,
  accepted_name: null, accepted_at: null, anonymized: false, created_at: iso(now - 864e5), updated_at: iso(now - 864e5) };
// Upwork Direct Contracts: the default rail (quote_view.mjs DEFAULT_PAY_METHOD), with and without the contract link; WEB quote
const QV = await import(process.cwd() + '/site/assets/quote_view.mjs');
const UPWORK_LINK = 'https://www.upwork.com/#E2E-ONLY';
const accepted = { status: 'accepted', accepted_name: 'Mark Ortiz', accepted_at: iso(now - 3600e3), sent_at: iso(now - 864e5), valid_until: iso(now + 13 * 864e5) };
const w = P.priceQuote(pb, [{ code: 'WEB' }]);
const db = {
  profiles: [{ id: 'u1', email: 'mark@example.com', full_name: 'Mark Ortiz', company: 'Rapid Flow Plumbing' }],
  quotes: [
    { ...base, id: 'q1', status: 'sent', public_token: tok('open'), sent_at: iso(now - 864e5), valid_until: iso(now + 13 * 864e5) },
    { ...base, id: 'q2', status: 'draft', public_token: tok('draft'), sent_at: null, valid_until: null },
    { ...base, id: 'q3', status: 'sent', public_token: tok('anon'), sent_at: iso(now - 864e5), valid_until: iso(now + 864e5), anonymized: true },
    { ...base, id: 'q4', status: 'sent', public_token: tok('old'), sent_at: iso(now - 20 * 864e5), valid_until: iso(now - 864e5) },
    { ...base, id: 'q5', status: 'sent', public_token: tok('upwork'), pay_method: 'upwork', sent_at: iso(now - 864e5), valid_until: iso(now + 13 * 864e5) },
    { ...base, ...accepted, id: 'q6', public_token: tok('uplink'), pay_method: 'upwork', pay_link: UPWORK_LINK },
    { ...base, ...accepted, id: 'q7', public_token: tok('nomethod'), pay_method: null },
    { ...base, ...accepted, id: 'q8', public_token: tok('webup'), pay_method: 'upwork', items: P.storedItems(w), setup_cents: w.setup_cents,
      monthly_cents: w.monthly_cents, deposit_cents: w.deposit_cents },
  ],
  events: [], outbox: []
};

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto(BASE + '/quote/');
await page.evaluate(d => localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)), db);
const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('aplp_mock_db_v1')));

await page.goto(`${BASE}/quote/?t=${tok('open')}&mock=1`);
// diagnostics on failure: what the page showed instead of the accept form
await page.waitForSelector('#acceptForm', { timeout: 8000 }).catch(async e => { console.log('page h1:', await page.textContent('h1').catch(() => '?'), '| errors:', errs.join(' / ')); throw e; });
ok(!page.url().includes('?'), 'query (token) removed from URL: ' + page.url());
ok(page.url().endsWith('#t=' + tok('open')), 'token kept in fragment');
ok((await page.textContent('h1')).includes('Rapid Flow Plumbing'), 'renders company');
ok((await page.textContent('.q-sum')).includes(P.wholeDollars ? '$' + (r.setup_cents / 100).toLocaleString('en-US') : ''), 'setup total');
ok((await read()).quotes[0].status === 'viewed', 'sent -> viewed in shared mock DB');
ok(await page.$$eval('[role=listitem]', els => els.every(e => e.parentElement.getAttribute('role') === 'list')), 'listitems inside list');
await page.click('#accBtn');
ok((await page.textContent('#accMsg')).includes('agree'), 'checkbox required');
await page.fill('#accName', '1');
await page.check('#accAgree'); await page.click('#accBtn');
ok((await page.textContent('#accMsg')).includes('full name'), 'name required');
await page.fill('#accName', '  Mark   Ortiz '); await page.click('#accBtn');
await page.waitForSelector('#pay-slot');
const after = await read();
ok(after.quotes[0].status === 'accepted' && after.quotes[0].accepted_name === 'Mark Ortiz', 'accepted in mock DB');
ok(after.events.filter(e => e.type === 'email_requested').map(e => e.payload.template).sort().join() === [['admin', 'quote', 'accepted'], ['quote', 'accepted']].map(p => p.join('_')).join(), 'email events');
ok(after.outbox.length === 2, 'outbox entries');
ok((await page.textContent('#pay-slot')).includes(brand.quote_sla_text), 'no pay link -> SLA text from brand.json');
ok(!(await page.textContent('#pay-slot')).includes('Upwork'), 'paypal_link quote: payment step unchanged (no Upwork text)');
await page.reload(); await page.waitForSelector('.q-signed');
ok((await page.textContent('.q-signed')).includes('Mark Ortiz'), 'accepted state persists (token from fragment)');

// ---- Upwork Direct Contracts
const usd = c => '$' + (c / 100).toLocaleString('en-US');
const slotText = async () => (await page.textContent('#pay-slot')).replace(/\s+/g, ' ');
const G = pb.refund_rules.rcp_guarantee, DEP = pb.refund_rules.deposit;
const other = `The other ${100 - pb.rules.deposit_pct}% (${usd(r.setup_cents - r.deposit_cents)}) is due only after you test your own line.`;
ok(QV.DEFAULT_PAY_METHOD === 'upwork', 'default pay method (quote_view.mjs) is upwork');
await page.goto(`${BASE}/quote/?t=${tok('upwork')}&mock=1`); await page.waitForSelector('#acceptForm');
await page.check('#accAgree'); await page.click('#accBtn'); await page.waitForSelector('#pay-slot .q-upwork');
let s = await slotText();
for (const t of ['Next step: pay your ' + usd(r.deposit_cents) + ' deposit securely through Upwork.', 'email from Upwork with your contract ' + brand.quote_sla_text,
  'Create a free Upwork client account', 'Fund the first milestone (' + usd(r.deposit_cents) + ') by card, PayPal or US bank transfer.', 'escrow',
  'only when you approve the milestone', 'Upwork adds its own small client fees at checkout.',
  'Already have an Upwork account? Reply to your quote email with your Upwork email', DEP.label + '. ' + DEP.text, other, G.label + ' after go-live.']) {
  ok(s.includes(t), 'upwork, no link: "' + t + '"');
}
ok(await page.$$eval('#pay-slot .q-steps li', l => l.length) === 3, 'upwork, no link: 3 numbered steps');
ok(!(await page.$('#pay-slot a')), 'upwork, no link: no payment button');
ok((await read()).quotes[4].status === 'accepted', 'upwork quote accepted in mock DB');

await page.goto(`${BASE}/quote/?t=${tok('uplink')}&mock=1`); await page.waitForSelector('#pay-slot a.btn');
const a = await page.$eval('#pay-slot a.btn', x => [x.textContent, x.getAttribute('href'), x.target, x.rel]);
ok(a[0] === 'Open your Upwork contract' && a[1] === UPWORK_LINK && a[2] === '_blank' && /noopener/.test(a[3]), 'upwork + link: "Open your Upwork contract" in a new tab: ' + a.join(' | '));
s = await slotText();
ok(s.includes('Fund the ' + usd(r.deposit_cents) + ' deposit there by card, PayPal or bank transfer.'), 'upwork + link: one funding line');
ok(s.includes(DEP.text) && s.includes(other) && s.includes(G.label) && !(await page.$('#pay-slot .q-upwork')), 'upwork + link: reassurance lines, no notice');

await page.goto(`${BASE}/quote/?t=${tok('nomethod')}&mock=1`); await page.waitForSelector('#pay-slot');
ok(!!(await page.$('#pay-slot .q-upwork')) && (await slotText()).includes('securely through Upwork'), 'no pay method chosen -> the Upwork path (default)');

await page.goto(`${BASE}/quote/?t=${tok('webup')}&mock=1`); await page.waitForSelector('#pay-slot .q-upwork');
s = await slotText();
ok(s.includes('Next step: pay your ' + usd(w.deposit_cents) + ' deposit') && s.includes('is due only after you review your new website.') && s.includes(DEP.text),
  'WEB on Upwork: deposit, review wording, deposit rule');
ok(!s.includes(G.label), 'WEB on Upwork: no satisfaction guarantee (RCP/BNDL only)');
await page.setViewportSize({ width: 320, height: 700 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Upwork payment step: no horizontal overflow at 320 px');
await page.setViewportSize({ width: 390, height: 844 });

for (const [t, what] of [[tok('draft'), 'draft'], [tok('anon'), 'anonymised'], ['short', 'bad token']]) {
  await page.goto(`${BASE}/quote/?t=${t}&mock=1`); await page.waitForSelector('h1');
  ok((await page.textContent('h1')) === 'Quote not found', what + ' refused');
}
await page.goto(`${BASE}/quote/?t=${tok('old')}&mock=1`); await page.waitForSelector('#accept');
ok(!(await page.$('#acceptForm')) && (await page.textContent('#accept')).includes('expired'), 'expired: no accept form');
ok((await read()).quotes[3].status === 'expired', 'expired status written');
ok(errs.length === 0, 'console errors: ' + errs.join(' | '));
await b.close(); srv.kill();
console.log(`e2e_quote: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
