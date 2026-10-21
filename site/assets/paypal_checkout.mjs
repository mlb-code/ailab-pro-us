// Card / PayPal checkout in the browser, shared by the quote page (deposit) and the client portal (final payment).
// Loads PayPal's JS SDK only when a payment step is on screen, renders the "Debit or Credit Card" button first and the
// PayPal button second (Pay Later and Venmo off), and talks to OUR server only through the page's callbacks:
//   create()          -> order id (Edge Function pay-create: the amount comes from our database, never from here)
//   capture(orderId)  -> {status: 'paid'|'pending', reference} (pay-capture, server-side capture)
// Israeli merchant: standard buttons + guest card checkout only (no advanced card fields, Apple Pay or saved cards).
// On/off = brand.json payments.paypal (paypalOn, the same rule the Edge Functions and tools/sync_config.py use).
import { paypalOn } from './quote_view.mjs';

export const SDK_URL = 'https://www.paypal.com/sdk/js';
export const on = brand => paypalOn(brand);

/** SDK URL: client id from brand.json, currency of the quote, capture now, buttons only, no Pay Later / Venmo. */
export function sdkSrc(brand, currency) {
  const p = brand.payments.paypal;
  return SDK_URL + '?client-id=' + encodeURIComponent(p.client_id) + '&currency=' + encodeURIComponent(currency || 'USD') +
    '&intent=capture&components=buttons&disable-funding=paylater,venmo';
}

let sdk = null;   // one SDK load per page
export function loadSdk(brand, currency) {
  if (window.paypal && window.paypal.Buttons) return Promise.resolve(window.paypal);
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = sdkSrc(brand, currency);
    s.async = true;
    s.dataset.ppSdk = '1';
    // the quote page sends no referrer at all (meta referrer); PayPal gets the site origin only, never the path or token
    s.referrerPolicy = 'origin';
    s.onload = () => (window.paypal && window.paypal.Buttons ? resolve(window.paypal) : reject(new Error('sdk_load_failed')));
    s.onerror = () => reject(new Error('sdk_load_failed'));
    document.head.appendChild(s);
  }).catch(e => {
    sdk = null;
    const old = document.querySelector('script[data-pp-sdk]');
    if (old) old.remove();   // a retry loads it again
    throw e;
  });
  return sdk;
}

/** Plain-language message for a failed step. `fallback` = the other way to pay on this page (sentence or ''). */
export function messageFor(code, fallback) {
  const c = String(code || '');
  const alt = fallback ? ' ' + fallback : '';
  if (c === 'cancel') return 'Payment not completed. No money was taken. You can try again.' + alt;
  if (/declined/.test(c)) return 'The payment was declined. No money was taken. You can try another card.' + alt;
  if (c === 'sdk_load_failed' || c === 'not_eligible') return 'The secure checkout didn’t load. Check your connection and try again.' + alt;
  if (/paypal_off|paypal_unreachable/.test(c)) return 'Card payment isn’t available right now. No money was taken.' + alt;
  if (/Failed to fetch|NetworkError|network/i.test(c)) return 'Can’t reach the server. Check your connection and try again. No money was taken.';
  return 'Something went wrong with the checkout. No money was taken. Please try again.' + alt;
}

const codeOf = e => String((e && (e.code || e.message)) || e || '');

/**
 * Render the buttons into `el` (needs children [data-pp="card"] and [data-pp="paypal"]; an optional [data-pp-loading]
 * placeholder is removed once they are on screen). Options:
 *   brand, currency, create(), capture(orderId), onResult(result), onFail(code), onCancel()
 * Resolves when rendered; rejects with Error('sdk_load_failed' | 'not_eligible').
 */
export async function mount(el, o) {
  const pp = await loadSdk(o.brand, o.currency);
  let lastCode = '';   // the SDK may wrap errors thrown in createOrder: keep our server's code for onError
  const common = {
    createOrder: async () => {
      try { return await o.create(); } catch (e) { lastCode = codeOf(e); throw e; }
    },
    onApprove: async (data, actions) => {
      try {
        o.onResult(await o.capture(data && data.orderID));
      } catch (e) {
        const c = codeOf(e);
        if (c === 'instrument_declined' && actions && typeof actions.restart === 'function') return actions.restart();   // pick another card
        o.onFail(c);
      }
    },
    onCancel: () => o.onCancel(),
    onError: err => { const c = lastCode || codeOf(err); lastCode = ''; o.onFail(c); },
  };
  const slots = [[pp.FUNDING.CARD, '[data-pp="card"]', { layout: 'vertical', shape: 'rect', height: 48, color: 'black' }],
    [pp.FUNDING.PAYPAL, '[data-pp="paypal"]', { layout: 'vertical', shape: 'rect', height: 48, color: 'gold', label: 'paypal' }]];
  let shown = 0;
  for (const [funding, sel, style] of slots) {
    const box = el.querySelector(sel);
    const b = pp.Buttons(Object.assign({ fundingSource: funding, style }, common));
    if (box && b.isEligible()) { await b.render(box); shown++; } else if (box) box.hidden = true;
  }
  const loading = el.querySelector('[data-pp-loading]');
  if (loading) loading.remove();
  if (!shown) throw new Error('not_eligible');
}
