// Horizontal-overflow + console-error gate for every page we ship.
// Loads each URL at 375/390/414/1280 px in Chromium, WebKit and Firefox (Playwright) and FAILS when
//   document.documentElement.scrollWidth > window.innerWidth, or any console error / uncaught exception occurs.
//
// usage:
//   node tools/overflow.mjs <url> [url ...]            check pages (exit 0 = all pass, 1 = any failure)
//   node tools/overflow.mjs --self-test                prove both paths with tools/fixtures (own server, no setup)
// options:
//   --engines chromium,webkit,firefox   subset of engines (default: all three)
//   --widths 375,390,414,1280           viewport widths (default as shown)
//   --allow-console <regex>             ignore console errors matching regex (repeatable), e.g. known 3rd-party noise
//   --wait <ms>                         extra settle time after load (default 300)
//   --json                              print a JSON summary as the last line
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WIDTHS = [375, 390, 414, 1280];
const ALL_ENGINES = ['chromium', 'webkit', 'firefox'];

function parseArgs(argv) {
  const o = { urls: [], engines: ALL_ENGINES, widths: DEFAULT_WIDTHS, allow: [], wait: 300, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--json') o.json = true;
    else if (a === '--engines') o.engines = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--widths') o.widths = argv[++i].split(',').map(Number).filter(Boolean);
    else if (a === '--allow-console') o.allow.push(new RegExp(argv[++i]));
    else if (a === '--wait') o.wait = +argv[++i];
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]); process.exit(0); }
    else if (a.startsWith('--')) { console.error('unknown option ' + a); process.exit(2); }
    else o.urls.push(a);
  }
  const bad = o.engines.filter(e => !ALL_ENGINES.includes(e));
  if (bad.length) { console.error('unknown engine(s): ' + bad.join(',')); process.exit(2); }
  return o;
}

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (e) { console.error('playwright is not installed. Run `npm install` in the repo root.'); process.exit(2); }
}

// Check one URL at one width in an open browser. Returns { ok, problems[] }.
async function checkPage(browser, url, width, opts) {
  const height = width >= 1024 ? 800 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = [];
  const keep = text => !opts.allow.some(re => re.test(text));
  page.on('console', m => { if (m.type() === 'error' && keep(m.text())) problems.push('console.error: ' + m.text().slice(0, 200)); });
  page.on('pageerror', e => { const t = String(e && e.message || e); if (keep(t)) problems.push('uncaught: ' + t.slice(0, 200)); });
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    if (resp && resp.status() >= 400) problems.push('HTTP ' + resp.status());
    await page.waitForTimeout(opts.wait);
    const m = await page.evaluate(() => {
      const de = document.documentElement, iw = window.innerWidth;
      const culprits = [];
      if (de.scrollWidth > iw) {
        for (const el of document.body ? document.body.querySelectorAll('*') : []) {
          const r = el.getBoundingClientRect();
          if (r.right > iw + 0.5 || r.left < -0.5) {
            const id = el.id ? '#' + el.id : '';
            const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            culprits.push(`${el.tagName.toLowerCase()}${id}${cls} [${Math.round(r.left)}..${Math.round(r.right)}]`);
            if (culprits.length >= 5) break;
          }
        }
      }
      return { sw: de.scrollWidth, iw, culprits };
    });
    if (m.sw > m.iw) problems.push(`overflow: scrollWidth ${m.sw} > innerWidth ${m.iw}` + (m.culprits.length ? ' · ' + m.culprits.join(', ') : ''));
  } catch (e) {
    problems.push('load failed: ' + String(e.message || e).split('\n')[0]);
  }
  await ctx.close();
  return { ok: problems.length === 0, problems };
}

async function run(urls, opts) {
  const pw = await loadPlaywright();
  const results = [];
  for (const engine of opts.engines) {
    let browser;
    try { browser = await pw[engine].launch(); }
    catch (e) {
      const msg = String(e.message || e).split('\n')[0];
      for (const url of urls) results.push({ engine, url, width: '*', ok: false, problems: ['browser launch failed: ' + msg + ' (try `npx playwright install ' + engine + '`)'] });
      continue;
    }
    for (const url of urls) for (const width of opts.widths) {
      const r = await checkPage(browser, url, width, opts);
      results.push({ engine, url, width, ...r });
    }
    await browser.close();
  }
  return results;
}

function report(results) {
  for (const r of results) {
    const head = `${r.ok ? 'PASS' : 'FAIL'}  ${r.engine.padEnd(8)} ${String(r.width).padStart(4)}  ${r.url}`;
    console.log(head);
    for (const p of r.problems) console.log('        - ' + p);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed` + (failed ? `, ${failed} FAILED` : ''));
  return failed;
}

// Self-test: serve tools/fixtures on an ephemeral port and assert ok passes, wide + console-error fail.
async function selfTest(opts) {
  const dir = path.join(HERE, 'fixtures');
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/__fixture__\//, '');
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/__fixture__/`;
  const cases = [['ok.html', true], ['wide.html', false], ['console-error.html', false]];
  let bad = 0;
  for (const [file, expectPass] of cases) {
    const results = await run([base + file], opts);
    const passed = results.every(r => r.ok);
    const good = passed === expectPass;
    if (!good) bad++;
    console.log(`${good ? 'ok  ' : 'BAD '} ${file.padEnd(20)} expected ${expectPass ? 'pass' : 'fail'}, got ${passed ? 'pass' : 'fail'} (${results.length} checks)`);
    if (!good) report(results);
  }
  server.close();
  console.log(bad ? `\nself-test FAILED (${bad} case(s))` : '\nself-test passed: pass path and fail paths both proven');
  return bad;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.selfTest) {
  process.exit((await selfTest(opts)) ? 1 : 0);
}
if (!opts.urls.length) { console.error('usage: node tools/overflow.mjs <url> [url ...] | --self-test   (see --help)'); process.exit(2); }
const results = await run(opts.urls, opts);
const failed = report(results);
if (opts.json) console.log(JSON.stringify({ total: results.length, failed, results }));
process.exit(failed ? 1 : 0);
