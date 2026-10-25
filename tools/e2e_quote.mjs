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

// ---- card / PayPal checkout (payment.method 'paypal_checkout'). brand.json is served with payments.paypal ON and PayPal's
// SDK is a local fake (window.paypal), so nothing ever reaches paypal.com; any other paypal.com request fails the test.
const PP_CLIENT = 'E2E-ONLY-client-id-0123456789';
const brandOn = JSON.parse(JSON.stringify(brand)); brandOn.payments = { paypal: { enabled: true, env: 'sandbox', client_id: PP_CLIENT } };
const FAKE_SDK = `(function () {
  var F = { CARD: 'card', PAYPAL: 'paypal', PAYLATER: 'paylater', VENMO: 'venmo' };
  window.__pp = window.__pp || { mode: 'approve', renders: [] };
  window.paypal = { FUNDING: F, Buttons: function (o) { return {
    isEligible: function () { return o.fundingSource === F.CARD || o.fundingSource === F.PAYPAL; },
    render: function (el) {
      var box = typeof el === 'string' ? document.querySelector(el) : el;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fake-pp'; b.setAttribute('data-funding', o.fundingSource);
      b.textContent = o.fundingSource === F.CARD ? 'Debit or Credit Card' : 'PayPal'; b.style.width = '100%';
      b.addEventListener('click', function () {
        var m = window.__pp.mode;
        if (m === 'cancel') return o.onCancel({});
        Promise.resolve().then(function () { return o.createOrder({ paymentSource: o.fundingSource }, {}); }).then(function (id) {
          window.__pp.order = id;
          if (m === 'error') return o.onError(new Error('fake sdk failure'));
          return o.onApprove({ orderID: id }, { restart: function () { window.__pp.restarted = (window.__pp.restarted || 0) + 1; } });
        }, function (e) { return o.onError(e); });
      });
      box.appendChild(b); window.__pp.renders.push(o.fundingSource); return Promise.resolve();
    } }; } };
})();`;
const sdkUrls = [], ppLeaks = [];
async function ppPage(on) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('pp: ' + e.message)); p.on('console', m => m.type() === 'error' && errs.push('pp: ' + m.text()));
  if (on) await p.route('**/assets/brand.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(brandOn) }));
  // Playwright tries routes newest first: the catch-all goes in first, the SDK fake after it
  await p.route(/paypal\.com/, r => { ppLeaks.push(r.request().url()); return r.abort(); });
  await p.route('https://www.paypal.com/sdk/js**', r => { sdkUrls.push(r.request().url()); return r.fulfill({ contentType: 'text/javascript', body: FAKE_SDK }); });
  return p;
}
const ppBase = { ...base, pay_method: 'paypal_checkout' };
const ppDb = {
  profiles: db.profiles,
  quotes: [
    { ...ppBase, id: 'p1', status: 'sent', public_token: tok('ppopen'), sent_at: iso(now - 864e5), valid_until: iso(now + 13 * 864e5) },
    { ...ppBase, ...accepted, id: 'p2', public_token: tok('ppcancel') },
    { ...ppBase, ...accepted, id: 'p3', public_token: tok('ppmail') },
  ],
  clients: [], payments: [], events: [], outbox: []
};
const pp = await ppPage(true);
await pp.goto(BASE + '/quote/');
await pp.evaluate(d => localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)), ppDb);
const ppRead = () => pp.evaluate(() => JSON.parse(localStorage.getItem('aplp_mock_db_v1')));
const ppSlot = async () => (await pp.textContent('#pay-slot')).replace(/\s+/g, ' ');
await pp.goto(`${BASE}/quote/?t=${tok('ppopen')}&mock=1`); await pp.waitForSelector('#acceptForm');
ok(sdkUrls.length === 0, 'PayPal SDK not loaded before the quote is accepted');
await pp.check('#accAgree'); await pp.click('#accBtn');
await pp.waitForSelector('#pay-slot .fake-pp');
s = await ppSlot();
for (const t of ['Pay your ' + usd(r.deposit_cents) + ' deposit', 'Secure checkout by PayPal. No PayPal account needed. Receipt by email within a minute.',
  DEP.label + '. ' + DEP.text, other, G.label + ' after go-live.', 'Prefer Upwork’s escrow protection? Pay through Upwork instead']) {
  ok(s.includes(t), 'PayPal step: "' + t + '"');
}
ok(!/Upwork holds the money|We’ll email your secure payment link/.test(s), 'PayPal step: no Upwork or "we\'ll email a link" text');
ok((await pp.$$eval('#pay-slot .fake-pp', l => l.map(x => x.getAttribute('data-funding')))).join() === 'card,paypal', 'card button first, then PayPal');
ok(s.indexOf('Secure checkout by PayPal') < s.indexOf(DEP.text) && s.indexOf(DEP.text) < s.indexOf('Pay through Upwork instead'), 'order: note, reassurance, Upwork link');
const sdk = new URL(sdkUrls[0] || 'https://x/');
ok(sdkUrls.length === 1 && sdk.searchParams.get('client-id') === PP_CLIENT && sdk.searchParams.get('currency') === 'USD' &&
  sdk.searchParams.get('intent') === 'capture' && sdk.searchParams.get('disable-funding') === 'paylater,venmo' && sdk.searchParams.get('components') === 'buttons',
  'SDK URL: client id from brand.json, USD, capture, no Pay Later / Venmo: ' + sdkUrls[0]);
ok(await pp.$eval('#qPayJump', x => x.textContent) === 'Pay deposit ' + usd(r.deposit_cents), 'summary card: "Pay deposit" jump button');
for (const wpx of [320, 375, 390, 414]) {
  await pp.setViewportSize({ width: wpx, height: 800 });
  ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PayPal step: no horizontal overflow at ' + wpx + ' px');
}
await pp.setViewportSize({ width: 390, height: 844 });
await pp.click('#pay-slot .fake-pp[data-funding="card"]');
await pp.waitForSelector('#pay-slot .q-paid');
s = await ppSlot();
let pdb = await ppRead();
const pq = pdb.quotes.find(x => x.id === 'p1'), pc = pdb.clients.find(c => c.quote_id === 'p1');
const pdep = pc && pdb.payments.find(x => x.client_id === pc.id && x.kind === 'deposit');
ok(s.includes('Deposit paid: ' + usd(r.deposit_cents) + '. Thank you!') && s.includes('PayPal reference ' + (pdep && pdep.provider_capture_id)) && s.includes('setup checklist is open'),
  'paid state with the receipt note: ' + s);
ok(!!pdep && pdep.status === 'paid' && pdep.method === 'paypal_checkout' && pdep.amount_cents === r.deposit_cents && pq.status === 'accepted', 'mock DB: client card + deposit paid');
ok(['payment_receipt', 'admin_payment_received', 'deposit_received'].every(t => pdb.outbox.some(m => m.template === t)), 'receipt, owner notice, welcome mail');
ok(await pp.$eval('#pay-slot a.btn', a => a.getAttribute('href')) === '/start/#onboarding', 'paid: link to the setup checklist');
await pp.reload(); await pp.waitForSelector('#pay-slot .q-paid');
ok((await ppSlot()).includes('Deposit paid') && !(await pp.$('#pay-slot .fake-pp')) && !(await pp.$('#qPayJump')), 'paid state persists after reload (pay_state), no buttons');
// cancel, then an error: friendly messages, no money taken, buttons stay, Upwork stays offered
await pp.goto(`${BASE}/quote/?t=${tok('ppcancel')}&mock=1`); await pp.waitForSelector('#pay-slot .fake-pp');
await pp.evaluate(() => { window.__pp.mode = 'cancel'; });
await pp.click('#pay-slot .fake-pp[data-funding="paypal"]'); await pp.waitForSelector('#qPayMsg .notice');
ok((await pp.textContent('#qPayMsg')).includes('Payment not completed. No money was taken.') && (await pp.textContent('#qPayMsg')).includes('Upwork'), 'cancel: retry + Upwork fallback');
await pp.evaluate(() => { window.__pp.mode = 'error'; });
await pp.click('#pay-slot .fake-pp[data-funding="card"]');
await pp.waitForFunction(() => /Something went wrong with the checkout/.test(document.querySelector('#qPayMsg').textContent));
ok(!!(await pp.$('#pay-slot .fake-pp')) && (await ppRead()).payments.every(x => x.status !== 'paid' || x.client_id === pc.id), 'error: nothing paid, buttons still there');
// switch to Upwork: confirm, the request is recorded + Meir's mail, the Upwork step replaces the card checkout
pp.once('dialog', d => d.accept());
await pp.click('#qPayUpwork'); await pp.waitForSelector('#pay-slot .q-upwork');
pdb = await ppRead();
ok(pdb.quotes.find(x => x.id === 'p2').pay_method === 'upwork' && pdb.outbox.some(m => m.template === 'admin_upwork_requested'), 'switched to Upwork + owner mail');
ok((await ppSlot()).includes('securely through Upwork') && !(await pp.$('#pay-slot .fake-pp')), 'Upwork step shown');
// the accepted-quote e-mail button (#t=…&pay=1) opens at the payment step
await pp.goto(`${BASE}/quote/?mock=1#t=${tok('ppmail')}&pay=1`); await pp.waitForSelector('#pay-slot .fake-pp');
ok(await pp.evaluate(() => document.activeElement && document.activeElement.id === 'qPayH'), '&pay=1: focus on the payment step');
// fixture mode (no backend at all): accept + pay simulated in the page
await pp.goto(`${BASE}/quote/?t=fixture-paypal`); await pp.waitForSelector('#acceptForm');
await pp.check('#accAgree'); await pp.click('#accBtn'); await pp.waitForSelector('#pay-slot .fake-pp');
await pp.evaluate(() => { window.__pp.mode = 'approve'; });
await pp.click('#pay-slot .fake-pp[data-funding="card"]'); await pp.waitForSelector('#pay-slot .q-paid');
ok((await ppSlot()).includes('Deposit paid'), 'fixture-paypal: accept + card payment simulated');
ok(ppLeaks.length === 0, 'no request to paypal.com besides the (faked) SDK: ' + ppLeaks.join(' '));

// PayPal OFF (the repo's brand.json): a paypal_checkout quote shows the safe fallback and never loads the SDK; a paid
// deposit still shows as paid
const off = await ppPage(false);
await off.goto(BASE + '/quote/');
await off.evaluate(d => localStorage.setItem('aplp_mock_db_v1', JSON.stringify(d)), { profiles: db.profiles, quotes: [{ ...ppBase, ...accepted, id: 'o1', public_token: tok('ppoff') }],
  clients: [], payments: [], events: [], outbox: [] });
const n0 = sdkUrls.length;
await off.goto(`${BASE}/quote/?t=${tok('ppoff')}&mock=1`); await off.waitForSelector('#pay-slot');
s = (await off.textContent('#pay-slot')).replace(/\s+/g, ' ');
ok(s.includes('We’ll email your secure payment link for the ' + usd(r.deposit_cents) + ' deposit') && !(await off.$('#qPay')), 'PayPal off: the email-link fallback');
await off.goto(`${BASE}/quote/?t=fixture-paypalpaid`); await off.waitForSelector('#pay-slot .q-paid');
ok((await off.textContent('#pay-slot')).includes('Deposit paid'), 'PayPal off: a paid PayPal deposit still shows as paid');
ok(sdkUrls.length === n0, 'PayPal off: SDK never requested');
ok(errs.length === 0, 'console errors (PayPal): ' + errs.join(' | '));
// price book v1.1: an RCP + ADD-DISPATCH quote (fixture built by the real engine) shows the add-on at the price-book price;
// a coming-soon code is never on a quote, and its feature list never reaches the public price book
const pd = await off.context().newPage();
await pd.goto(`${BASE}/quote/?t=fixture-dispatch`); await pd.waitForSelector('#acceptForm');
const dsp = pb.items.find(i => i.code === 'ADD-DISPATCH'), rcp = pb.items.find(i => i.code === 'RCP');
const qd = P.priceQuote(pb, [{ code: 'RCP' }, { code: 'ADD-DISPATCH' }]);
s = (await pd.textContent('body')).replace(/\s+/g, ' ');
ok(qd.ok && qd.setup_cents === rcp.setup_cents + dsp.setup_cents && qd.monthly_cents === rcp.monthly_cents + dsp.monthly_cents, 'engine: RCP + ADD-DISPATCH = table prices');
ok(s.includes(dsp.name) && s.includes(usd(qd.setup_cents)) && s.includes(usd(qd.monthly_cents)) && s.includes(usd(qd.deposit_cents)), 'fixture-dispatch: dispatch line + totals on the page');
const soonCodes = pb.items.filter(i => i.availability === 'coming_soon').map(i => i.code);
ok(soonCodes.length > 0 && soonCodes.every(c => !P.priceQuote(pb, [{ code: 'RCP' }, { code: c }]).ok), 'coming-soon codes are refused by the engine (browser copy)');
ok(!('term_plan' in pb.rules) && pb.items.every(i => !('plan_b_monthly_cents' in i)), 'public price book: no plan B data');
await b.close(); srv.kill();
console.log(`e2e_quote: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
