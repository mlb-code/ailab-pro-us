// Drive headless Chrome over the DevTools protocol: real mouse-wheel scrolling + screenshots + console errors.
// Real wheel events matter for pages that use smooth-scroll / ScrollTrigger libraries.
// usage: node tools/cdp-shots.mjs <url> <outPrefix> [W=1440] [H=900] [mobile:0|1] [port=9333] ['[0,900,1800]']
// writes <outPrefix>-00000.png, <outPrefix>-00900.png, ... (outPrefix directory must exist)
import fs from 'node:fs';
import { launch, sleep } from './_chrome.mjs';

const [,, url, outPrefix, Ws, Hs, mobileS, portS, posS] = process.argv;
if (!url || !outPrefix) { console.error('usage: node tools/cdp-shots.mjs <url> <outPrefix> [W] [H] [mobile 0|1] [port] [json positions]'); process.exit(2); }
const W = +Ws || 1440, H = +Hs || 900, mobile = mobileS === '1', port = +portS || 9333;
const positions = JSON.parse(posS || '[0]');

const cdp = await launch({ port, W, H, extraArgs: ['--hide-scrollbars'] });
const { send, evalv } = cdp;
const errors = [];
cdp.onEvent(m => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning'))
    errors.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 200));
});
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile });
if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await send('Page.navigate', { url });
await sleep(4500);
for (const y of positions) {
  if (mobile) { await evalv(`window.scrollTo({top:${y},behavior:'instant'})`); }
  else {
    let delta = y - await evalv('window.scrollY');
    while (Math.abs(delta) > 1) {
      const d = Math.sign(delta) * Math.min(Math.abs(delta), 100);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY: d });
      delta -= d; await sleep(16);
    }
  }
  await sleep(2200);
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outPrefix}-${String(y).padStart(5, '0')}.png`, Buffer.from(result.data, 'base64'));
  process.stdout.write(`shot ${y} (scrollY=${await evalv('Math.round(window.scrollY)')}) `);
}
console.log('\nheight:', await evalv('document.documentElement.scrollHeight'),
  'scrollWidth:', await evalv('document.documentElement.scrollWidth'), 'innerWidth:', await evalv('innerWidth'));
console.log('errors:', JSON.stringify(errors));
cdp.close(); process.exit(errors.length ? 1 : 0);
