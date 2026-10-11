// Drives every scripted path of the chat demo on every landing page and asserts the final "booked" bubble.
// Also asserts: no network request is made after the page has loaded (the demo is browser-only), 2-3 chips per step,
// the "This is a demo" note appears, and no horizontal overflow at 375 px after a full conversation.
//
// usage: node tools/demo_test.mjs [baseUrl=http://localhost:8787] [--engine chromium|webkit|firefox]
// Each niche's full tree is walked once (first page it appears on); later pages run 1 path per scenario.
//        (start the static server first: PORT=8901 sh tools/serve.sh)
import { chromium, webkit, firefox } from 'playwright';

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) || 'http://localhost:8787').replace(/\/$/, '');
const engineName = args.includes('--engine') ? args[args.indexOf('--engine') + 1] : 'chromium';
const engine = { chromium, webkit, firefox }[engineName];
const PAGES = ['/', '/home-services/', '/real-estate/', '/dental/', '/demo/'];

function paths(scn) {
  const out = [];
  const walk = (id, acc) => {
    const n = scn.nodes[id];
    if (n.booked) { out.push(acc); return; }
    for (const ch of n.chips) walk(ch.next, [...acc, ch.say]);
  };
  walk(scn.start, []);
  return out;
}

const browser = await engine.launch({ timeout: 60000 });
const STEP_MS = 10000; // per wait; generous so a loaded machine doesn't fail paths
const fullyTested = new Set(); // each niche's full path tree is walked once; other pages get 1 path per scenario
let total = 0, failed = 0, retries = 0;
const fail = (msg) => { failed++; console.log('FAIL ' + msg); };

for (const p of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { window.DEMO_SPEED = 0; });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + p, { waitUntil: 'networkidle' });
  let late = [];
  page.on('request', r => late.push(r.url()));

  const data = JSON.parse(await page.locator('[data-demo-data]').textContent());
  const niches = Object.keys(data);
  for (const niche of niches) {
    if (niches.length > 1) await page.click(`.demo__niche button[data-niche="${niche}"]`);
    for (const scn of data[niche].scenarios) {
      for (const n of Object.values(scn.nodes)) if (!n.booked && (n.chips.length < 2 || n.chips.length > 3)) fail(`${p} ${niche}/${scn.key}: step with ${n.chips.length} chips`);
      const all = paths(scn);
      const todo = fullyTested.has(niche) ? all.slice(0, 1) : all;
      for (const path of todo) {
        total++;
        const label = `${p} ${niche}/${scn.key}: ${path.join(' > ')}`;
        const runPath = async () => {
          await page.click(`.demo__pick[data-scenario="${scn.key}"]`);
          for (const say of path) {
            const chip = page.locator('.chip-reply', { hasText: say }).first();
            await chip.waitFor({ timeout: STEP_MS });
            await chip.click({ timeout: STEP_MS });
          }
          await page.locator('[data-booked]').waitFor({ timeout: STEP_MS });
        };
        try {
          try { await runPath(); }
          catch (e) {
            if (e.name !== 'TimeoutError') throw e;
            retries++; console.log('retry ' + label + ' (timeout)');
            await runPath(); // one automatic retry, timeouts only
          }
          const note = await page.locator('[data-demo-chat] .bubble--system').last().textContent();
          if (!/This is a demo/.test(note)) fail(label + ' (no demo note)');
          const leftover = await page.locator('[data-booked]').textContent();
          if (/\{\w+\}/.test(leftover)) fail(label + ' (unfilled variable: ' + leftover + ')');
        } catch (e) { fail(label + ' (' + e.message.split('\n')[0] + ')'); }
      }
    }
  }
  niches.forEach(n => fullyTested.add(n));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (sw > 0) fail(`${p} horizontal overflow ${sw}px after demo`);
  if (late.length) fail(`${p} network requests during demo: ${late.slice(0, 3).join(', ')}`);
  if (errors.length) fail(`${p} console errors: ${errors.slice(0, 3).join(' | ')}`);
  console.log(`ok   ${p} (${niches.join(', ')})`);
  await ctx.close();
}
await browser.close();
console.log(`demo_test [${engineName}]: ${total} paths, ${failed} failure(s), ${retries} timeout retr${retries === 1 ? 'y' : 'ies'}`);
process.exit(failed ? 1 : 0);
