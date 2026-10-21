// Card / PayPal checkout after the quote page, on the MOCK backend with brand.json payments.paypal ON (served by a route)
// and PayPal's JS SDK faked locally (nothing reaches paypal.com):
//   portal  the final payment in the go-live step and on Billing (card first, then PayPal), paid -> receipt + owner notice,
//           status texts, no overflow 375/390/414
//   admin   PayPal methods first + preselected, PayPal ids on the client card, "החזר" (refund) with a Hebrew confirm,
//           refused outside the 7-day rule (no button), console clean
//   node tools/e2e_paypal_portal.mjs        (own static server on E2E_PORT, default 8971)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = +(process.env.E2E_PORT || 8971);
const BASE = `http://localhost:${PORT}`;
const srv = spawn('python3', ['tools/serve.py', String(PORT)], { stdio: 'ignore', env: { ...process.env, SERVE_QUIET: '1' } });
process.on('exit', () => srv.kill());
await new Promise(r => setTimeout(r, 900));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pb = JSON.parse(fs.readFileSync('site/assets/pricebook.json', 'utf8'));
const brand = JSON.parse(fs.readFileSync('site/assets/brand.json', 'utf8'));
const brandOn = JSON.parse(JSON.stringify(brand)); brandOn.payments = { paypal: { enabled: true, env: 'sandbox', client_id: 'E2E-ONLY-client-id-0123456789' } };
const usd = c => '$' + (c / 100).toLocaleString('en-US');
const FAKE_SDK = `(function () {
  var F = { CARD: 'card', PAYPAL: 'paypal' };
  window.paypal = { FUNDING: F, Buttons: function (o) { return {
    isEligible: function () { return true; },
    render: function (el) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fake-pp'; b.setAttribute('data-funding', o.fundingSource);
      b.textContent = o.fundingSource === F.CARD ? 'Debit or Credit Card' : 'PayPal'; b.style.width = '100%';
      b.addEventListener('click', function () {
        Promise.resolve().then(function () { return o.createOrder({ paymentSource: o.fundingSource }, {}); })
          .then(function (id) { return o.onApprove({ orderID: id }, { restart: function () {} }); }, function (e) { return o.onError(e); });
      });
      el.appendChild(b); return Promise.resolve();
    } }; } };
})();`;

const errs = [], leaks = [], dialogs = [];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.route('**/assets/brand.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(brandOn) }));
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
await ctx.route(/paypal\.com/, r => { leaks.push(r.request().url()); return r.abort(); });   // routes: newest first
await ctx.route('https://www.paypal.com/sdk/js**', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_SDK }));
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
const db = () => page.evaluate(() => window.StartMock.admin.db());
const put = d => page.evaluate(x => localStorage.setItem('aplp_mock_db_v1', JSON.stringify(x)), d);
const text = sel => page.$eval(sel, e => e.innerText.replace(/\s+/g, ' '));
async function overflow() {
  const bad = [];
  for (const w of [375, 390, 414]) {
    await page.setViewportSize({ width: w, height: 844 }); await sleep(60);
    const d = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (d > 0) bad.push(w + ':' + d);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  return bad;
}

try {
  // ---------------------------------------------------------------- a client whose deposit was paid by card on the quote page
  console.log('portal');
  await page.goto(BASE + '/start/?mock=1'); await page.evaluate(() => window.StartMock.admin.reset());
  await page.goto(BASE + '/start/?mock=1');
  await page.fill('#email', 'dana@pp.test'); await page.click('#sendBtn');
  await page.waitForSelector('#mockCode'); await page.fill('#code', (await page.textContent('#mockCode')).trim());
  await page.waitForSelector('#profileForm');
  await page.fill('#p_full_name', 'Dana Levin'); await page.fill('#p_company', 'Rapid Flow Plumbing'); await page.fill('#p_phone', '(713) 555-0100');
  await page.fill('#p_city', 'Houston'); await page.selectOption('#p_state', 'TX'); await page.click('#pSave');
  await page.waitForSelector('[role=tablist]');
  await page.goto(BASE + '/start/?mock_seed=deposit_paid'); await page.waitForSelector('#tab-onboarding');   // checklist seeded lazily
  let d = await db();
  const q = d.quotes[0], c = d.clients[0];
  const dep = d.payments.find(p => p.client_id === c.id && p.kind === 'deposit');
  const finalCents = q.setup_cents - q.deposit_cents;
  q.pay_method = 'paypal_checkout';
  Object.assign(dep, { method: 'paypal_checkout', provider: 'paypal', provider_order_id: 'MOCKORDER0000000001', provider_capture_id: 'MOCKCAP00000000001',
    payer_email: 'dana@pp.test', paid_at: new Date(Date.now() - 3600e3).toISOString() });
  d.payments.push({ id: 'pay-final-1', client_id: c.id, kind: 'final', amount_cents: finalCents, method: 'paypal_checkout', status: 'due', reference: null,
    paid_at: null, provider: null, provider_order_id: null, provider_capture_id: null, payer_email: null, created_at: new Date().toISOString() });
  c.status = 'testing';
  const ob = d.onboarding_items.filter(o => o.client_id === c.id);
  ob.forEach(o => { o.status = 'done'; });
  ob.sort((x, y) => x.sort - y.sort)[ob.length - 1].data = { go_live_requested_at: new Date().toISOString() };
  await put(d);
  await page.goto(BASE + '/start/'); await page.waitForSelector('[role=tablist]');
  ok((await text('.status')).includes('Last step: pay the final ' + usd(finalCents) + ' by card or PayPal'), 'home: final payment by card is the next step');
  // Billing: the pay card with PayPal's buttons
  await page.click('#tab-billing'); await page.waitForSelector('[data-final-pay="billing"] .fake-pp');
  ok((await text('[data-final-pay="billing"]')).includes('Pay the final ' + usd(finalCents)), 'billing: pay card');
  ok((await page.$$eval('[data-final-pay="billing"] .fake-pp', l => l.map(x => x.getAttribute('data-funding')))).join() === 'card,paypal', 'billing: card first');
  ok((await overflow()).length === 0, 'billing pay card: no overflow 375/390/414');
  // the go-live step of the checklist: pay there
  await page.click('#tab-onboarding'); await sleep(150);
  const lastKey = await page.$$eval('.obstep', ds => ds[ds.length - 1].dataset.key);
  await page.evaluate(k => { document.querySelector('#ob-' + k).open = true; }, lastKey);
  await page.waitForSelector('[data-final-pay="golive"] .fake-pp');
  const gl = await text('.golive');
  ok(gl.includes('Go-live requested on') && gl.includes('Last step: the final payment.') && gl.includes('Pay the final ' + usd(finalCents)) &&
    gl.includes('Secure checkout by PayPal. No PayPal account needed. Receipt by email within a minute.'), 'go-live step: requested + final payment buttons: ' + gl);
  ok(!gl.includes('Watch your email for the final payment link'), 'go-live step: no "watch your email" with PayPal on');
  ok((await overflow()).length === 0, 'go-live pay block: no overflow 375/390/414');
  await page.click('[data-final-pay="golive"] .fake-pp[data-funding="card"]');
  await page.waitForFunction(() => /Final payment received/.test(document.querySelector('.golive') && document.querySelector('.golive').innerText), null, { timeout: 6000 });
  d = await db();
  const fin = d.payments.find(p => p.id === 'pay-final-1');
  ok(fin.status === 'paid' && fin.method === 'paypal_checkout' && /^MOCKCAP/.test(fin.provider_capture_id) && fin.amount_cents === finalCents, 'final row paid by card');
  ok(d.outbox.some(m => m.template === 'payment_receipt' && m.payment_id === fin.id) && d.outbox.some(m => m.template === 'admin_payment_received'), 'receipt + owner notice');
  ok(!d.outbox.some(m => m.template === 'deposit_received'), 'no welcome mail for the final payment');
  await page.click('#tab-billing'); await sleep(150);
  ok(!(await page.$('[data-final-pay="billing"]')) && (await text('table')).includes('Final payment before go-live'), 'billing: card gone, final listed');
  await page.click('#tab-home'); await sleep(150);
  ok((await text('.status')).includes('Final payment received — thank you.'), 'home: final payment received');

  // ---------------------------------------------------------------- admin
  console.log('admin');
  await page.evaluate(() => window.Backend.signOut());
  await page.goto(BASE + '/start/admin/?mock=1');
  await page.fill('#email', 'admin@demo.local'); await page.click('#sendBtn');
  await page.waitForSelector('#mockCode'); await page.fill('#code', (await page.textContent('#mockCode')).trim()); await page.click('#verifyBtn');
  await page.waitForSelector('#panel');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE + '/start/admin/#clients/' + c.id); await page.reload(); await page.waitForSelector('#detail h2');
  const pays = await text('#detail .plist');
  ok(pays.includes('PayPal · מזהה חיוב MOCKCAP00000000001') && pays.includes('dana@pp.test') && pays.includes('PayPal · מזהה חיוב ' + fin.provider_capture_id),
    'client card: PayPal provider + capture ids on both rows');
  ok(await page.$$eval('[data-refund]', l => l.length) === 1, 'one refund button: the deposit (paid an hour ago), not the final payment');
  await page.click('[data-refund]'); await sleep(500);
  ok(dialogs.some(m => m.includes('להחזיר ללקוח') && m.includes(usd(q.deposit_cents)) && m.includes('אי אפשר לבטל')), 'Hebrew confirm with the amount: ' + dialogs.join(' | '));
  d = await db();
  ok(d.payments.find(p => p.id === dep.id).status === 'refunded' && d.events.some(e => e.type === 'payment_refunded' && e.entity_id === dep.id), 'deposit refunded + logged');
  ok((await text('#toast')).includes('המקדמה הוחזרה ב-PayPal'), 'toast');
  ok(!(await page.$('[data-refund]')), 'no refund button after the refund');
  // an older PayPal deposit: outside the price book's rule -> no button, the explanation instead (and the API refuses too)
  const days = (pb.refund_rules.deposit || {}).window_days;
  d = await db();
  Object.assign(d.payments.find(p => p.id === dep.id), { status: 'paid', paid_at: new Date(Date.now() - (days + 1) * 864e5).toISOString() });
  await put(d); await page.reload(); await page.waitForSelector('#detail h2');
  ok(!(await page.$('[data-refund]')) && (await text('#detail .plist')).includes('עברו ' + days + ' ימים: החזר רק מתוך PayPal'), 'outside the rule: no button');
  ok(await page.evaluate(id => window.AdminBackend.adminRefundPayment(id).then(() => 'ok', e => e.message), dep.id) === 'refund_window_passed', 'API refuses outside the rule');
  // pay methods with PayPal on: card checkout first and preselected for a quote without a method
  await page.evaluate(() => window.StartMock.admin.seedAdmin(window.ADMIN_PB));
  d = await db();
  const draft = d.quotes.find(x => x.status === 'draft' || x.status === 'needs_manual_price');
  draft.pay_method = null; await put(d);
  await page.goto(BASE + '/start/admin/#quotes/' + draft.id); await page.reload(); await page.waitForSelector('#payMethod');
  const pm = await page.$eval('#payMethod', s => [s.value, Array.from(s.options).map(o => o.value + '=' + o.textContent)]);
  ok(pm[0] === 'paypal_checkout' && pm[1][0] === 'paypal_checkout=PayPal – כפתור בדף ההצעה' && pm[1].some(x => x.startsWith('upwork=')),
    'PayPal on: "PayPal – כפתור בדף ההצעה" first + preselected, Upwork still offered: ' + pm[1].join(', '));
  ok((await overflow()).length === 0, 'admin editor: no overflow');
} finally {
  ok(leaks.length === 0, 'nothing sent to paypal.com: ' + leaks.join(' '));
  ok(errs.length === 0, 'console errors: ' + errs.join(' | '));
  await b.close(); srv.kill();
}
console.log(`e2e_paypal_portal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
