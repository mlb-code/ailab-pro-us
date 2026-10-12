// B8: live chat demo in the browser, against a runtime in sim mode (mock brain) or a dead URL.
//
// usage: node tools/demo_live_test.mjs --live http://localhost:8961 [baseUrl=http://localhost:8901] [--engine chromium|webkit|firefox]
//        --live <up runtime>  : live box appears on live niches, a typed conversation books (mock brain), and a failing /demo/chat (abort, 503 budget, 429 limit) shows
//                               "Live demo paused" and the scripted demo then completes to "booked".
//        --live http://localhost:9 (dead): no live box, scripted paths still complete, no console errors.
// Start first:  PORT=8901 sh tools/serve.sh   and   (cd runtime && .venv/bin/python -m sim serve --port 8961)
// The page is opened with ?live=<url> (honoured on localhost only).
import { chromium, webkit, firefox } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const live = opt('--live', '').replace(/\/$/, '');
const base = (args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--live' && args[i - 1] !== '--engine') || 'http://localhost:8901').replace(/\/$/, '');
const engineName = opt('--engine', 'chromium');
const engine = { chromium, webkit, firefox }[engineName];
if (!live) { console.log('need --live <runtime url>'); process.exit(2); }

let up = false;
try { up = (await fetch(live + '/health', { signal: AbortSignal.timeout(2000) })).ok; } catch { up = false; }

const browser = await engine.launch();
let failed = 0, total = 0;
const check = (ok, msg) => { total++; if (!ok) { failed++; console.log('FAIL ' + msg); } };

async function open(path, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { window.DEMO_SPEED = 0; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION|net::|CORS|Fetch API|NetworkError|Load failed/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}${path}?live=${encodeURIComponent(live)}`, { waitUntil: 'load' });
  await page.waitForTimeout(up ? 600 : 4600); // probe answers (up) or times out (dead, 4 s)
  return { ctx, page, errors };
}

async function scriptedToBooked(page, label) {
  const data = JSON.parse(await page.locator('[data-demo-data]').textContent());
  const niche = await page.locator('[data-demo]').getAttribute('data-niche');
  const scn = data[niche].scenarios[0];
  await page.click(`.demo__pick[data-scenario="${scn.key}"]`);
  let id = scn.start;
  while (!scn.nodes[id].booked) {
    const ch = scn.nodes[id].chips[0];
    const chip = page.locator('.chip-reply', { hasText: ch.say }).first();
    await chip.waitFor({ timeout: 4000 });
    await chip.click();
    id = ch.next;
  }
  await page.locator('[data-booked]').waitFor({ timeout: 4000 });
  check(true, label);
}

async function overflow(page, label) {
  for (const w of [375, 390, 414, 1280]) {
    await page.setViewportSize({ width: w, height: 860 });
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(sw <= 0, `${label} overflow ${sw}px at ${w}`);
  }
}

async function typeAndWait(page, text) {
  const before = await page.locator('[data-demo-chat] .bubble--in:not(.bubble--typing)').count();
  await page.fill('[data-demo-live] input', text);
  await page.click('[data-demo-live] button[type=submit]');
  await page.waitForFunction(n => document.querySelectorAll('[data-demo-chat] .bubble--in:not(.bubble--typing)').length > n
    || document.querySelector('[data-live-note]:not([hidden])'), before, { timeout: 15000 });
}

if (up) {
  // 1. live conversation books on /demo/ (home services), real estate has the box, mock brain path
  {
    const { ctx, page, errors } = await open('/demo/');
    const box = page.locator('[data-demo-live]');
    check(await box.isVisible(), '/demo/ live box visible (home_services)');
    try {
      for (const t of ['My AC is blowing warm air', '77005', 'the first one works', 'My name is Dana Lee', '1200 Main Street, Houston 77005']) await typeAndWait(page, t);
      await page.locator('[data-booked]').waitFor({ timeout: 8000 });
      const note = await page.locator('[data-demo-chat] .bubble--system').last().textContent();
      check(/This is a demo/.test(note), '/demo/ live booked + demo note');
      check(/Live demo/.test(await page.locator('[data-demo-chat] .bubble--system').first().textContent()), '/demo/ live label');
    } catch (e) { check(false, '/demo/ live booking (' + e.message.split('\n')[0] + ')'); }
    await overflow(page, '/demo/ after live chat');
    await page.setViewportSize({ width: 390, height: 860 });
    await page.click('.demo__niche button[data-niche="real_estate"]');
    check(await box.isVisible(), '/demo/ live box visible (real_estate)');
    try {
      await typeAndWait(page, 'Is 1420 Oak Ridge Dr still available?');
      const txt = await page.locator('[data-demo-chat]').textContent();
      check(/Maple & Main Realty/.test(txt), '/demo/ real estate greeting');
    } catch (e) { check(false, '/demo/ real estate turn (' + e.message.split('\n')[0] + ')'); }
    check(!errors.length, '/demo/ console errors: ' + errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
  // 2. failures mid-conversation -> "Live demo paused" + scripted demo completes
  for (const [name, fulfil] of [
    ['abort', r => r.abort()],
    ['budget 503', r => r.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base }, body: '{"paused":true,"reason":"budget"}' })],
    ['limit 429', r => r.fulfill({ status: 429, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base }, body: '{"paused":true,"reason":"session_limit"}' })],
  ]) {
    const { ctx, page, errors } = await open('/home-services/');
    await page.route(live + '/demo/chat', fulfil);
    try {
      await page.fill('[data-demo-live] input', 'My AC is blowing warm air');
      await page.click('[data-demo-live] button[type=submit]');
      await page.locator('[data-live-note]:not([hidden])').waitFor({ timeout: 8000 });
      check(/Live demo paused/.test(await page.locator('[data-live-note]').textContent()), `${name}: paused note`);
      check(!(await page.locator('[data-demo-live]').isVisible()), `${name}: live box hidden`);
      await scriptedToBooked(page, `${name}: scripted fallback books`);
    } catch (e) { check(false, `${name} (` + e.message.split('\n')[0] + ')'); }
    await overflow(page, `/home-services/ ${name}`);
    check(!errors.length, `${name} console errors: ` + errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} else {
  for (const p of ['/', '/home-services/', '/real-estate/', '/demo/']) {
    const { ctx, page, errors } = await open(p);
    check(!(await page.locator('[data-demo-live]').count()), `${p} dead runtime: no live box`);
    try { await scriptedToBooked(page, `${p} dead runtime: scripted books`); } catch (e) { check(false, `${p} scripted (${e.message.split('\n')[0]})`); }
    check(!errors.length, `${p} console errors: ` + errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
}
await browser.close();
console.log(`demo_live_test [${engineName}] runtime ${up ? 'UP' : 'DOWN'}: ${total} checks, ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
