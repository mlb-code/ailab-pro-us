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
const db = {
  profiles: [{ id: 'u1', email: 'mark@example.com', full_name: 'Mark Ortiz', company: 'Rapid Flow Plumbing' }],
  quotes: [
    { ...base, id: 'q1', status: 'sent', public_token: tok('open'), sent_at: iso(now - 864e5), valid_until: iso(now + 13 * 864e5) },
    { ...base, id: 'q2', status: 'draft', public_token: tok('draft'), sent_at: null, valid_until: null },
    { ...base, id: 'q3', status: 'sent', public_token: tok('anon'), sent_at: iso(now - 864e5), valid_until: iso(now + 864e5), anonymized: true },
    { ...base, id: 'q4', status: 'sent', public_token: tok('old'), sent_at: iso(now - 20 * 864e5), valid_until: iso(now - 864e5) },
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
await page.waitForSelector('#acceptForm');
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
ok(after.events.filter(e => e.type === 'email_requested').map(e => e.payload.template).sort().join() === 'admin_quote_accepted,quote_accepted', 'email events');
ok(after.outbox.length === 2, 'outbox entries');
ok((await page.textContent('#pay-slot')).includes(brand.quote_sla_text), 'no pay link -> SLA text from brand.json');
await page.reload(); await page.waitForSelector('.q-signed');
ok((await page.textContent('.q-signed')).includes('Mark Ortiz'), 'accepted state persists (token from fragment)');

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
