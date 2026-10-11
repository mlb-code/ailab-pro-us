// Shared helper for the raw-CDP tools: locate a local Chrome and launch it headless
// with a remote-debugging port. Override the binary with CHROME_PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function chromePath() {
  const p = CANDIDATES.find(c => fs.existsSync(c));
  if (!p) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
  return p;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Launch Chrome and return { chrome, ws, send, evalv, close }.
export async function launch({ port, W, H, extraArgs = [] }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `cdp-prof-${port}-`));
  const chrome = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${port}`, '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files', `--window-size=${W},${H}`,
    '--no-first-run', `--user-data-dir=${profile}`, ...extraArgs, 'about:blank'], { stdio: 'ignore' });
  let list = null;
  for (let i = 0; i < 40 && !list; i++) {
    await sleep(300);
    try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (e) { /* not up yet */ }
  }
  if (!list) { chrome.kill(); throw new Error('Chrome did not start (port ' + port + ')'); }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method) listeners.forEach(fn => fn(m));
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalv = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const close = () => {
    try { ws.close(); } catch (e) { /* already closed */ }
    chrome.kill();
    // Chrome may still be flushing the profile; cleanup is best-effort.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* leave temp dir */ }
  };
  return { chrome, ws, send, evalv, close, onEvent: fn => listeners.push(fn) };
}
