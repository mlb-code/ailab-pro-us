// Load a page in headless Chrome (desktop metrics) and evaluate a JS expression (await supported); prints JSON.
// usage: node tools/cdp-eval.mjs <url> '<expression>' [port=9340] [W=1440] [H=900] [waitMs=5000]
import { launch, sleep } from './_chrome.mjs';

const [,, url, expr, portS, Ws, Hs, waitS] = process.argv;
if (!url || !expr) { console.error("usage: node tools/cdp-eval.mjs <url> '<expr>' [port] [W] [H] [waitMs]"); process.exit(2); }
const port = +portS || 9340, W = +Ws || 1440, H = +Hs || 900;
const cdp = await launch({ port, W, H });
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url }); await sleep(+waitS || 5000);
const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 0));
cdp.close(); process.exit(0);
