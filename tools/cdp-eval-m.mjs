// Mobile variant of cdp-eval: 390x844, mobile metrics + touch emulation (pointer:coarse).
// usage: node tools/cdp-eval-m.mjs <url> '<expression>' [port=9380] [waitMs=5000]
import { launch, sleep } from './_chrome.mjs';

const [,, url, expr, portS, waitS] = process.argv;
if (!url || !expr) { console.error("usage: node tools/cdp-eval-m.mjs <url> '<expr>' [port] [waitMs]"); process.exit(2); }
const port = +portS || 9380;
const cdp = await launch({ port, W: 390, H: 844 });
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await cdp.send('Page.navigate', { url }); await sleep(+waitS || 5000);
const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result));
cdp.close(); process.exit(0);
