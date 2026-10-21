// POST from PayPal (server to server; verify_jwt = false, no CORS). The signature is verified by PayPal's
// verify-webhook-signature API with PAYPAL_WEBHOOK_ID before anything is read; a bad / missing signature -> 400 and
// nothing changes. Handled: PAYMENT.CAPTURE.COMPLETED (paid, idempotent), PAYMENT.CAPTURE.REFUNDED / REVERSED
// (refunded; partial refund or reversal -> Hebrew alert), PAYMENT.CAPTURE.DECLINED (a pending capture declined: the
// client can pay again, Meir alerted), CUSTOMER.DISPUTE.CREATED (Hebrew alert to Meir). Amounts are only compared with
// our DB row. 2xx = processed or ignored; 5xx = PayPal retries (up to 25 times over 3 days).
// Subscribe the webhook to exactly WEBHOOK_EVENTS (tools/us_setup.py --only paypal does it; private guide
// docs/kits/paypal-setup.he.md).
import { handleWebhook, type PayDeps } from "../_shared/pay.ts";
import { type PayStore, RestPayStore } from "../_shared/pay_store.ts";
import { PaypalClient } from "../_shared/paypal.ts";

export const WEBHOOK_EVENTS = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.CAPTURE.DECLINED", "CUSTOMER.DISPUTE.CREATED"];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export function makeHandler(deps: { store: () => PayStore; paypal: () => PaypalClient | null } & Omit<PayDeps, "store" | "paypal">) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    try {
      const raw = await req.text();
      const out = await handleWebhook(raw, req.headers, { ...deps, store: deps.store(), paypal: deps.paypal() });
      return reply(out.body, out.status);
    } catch (e) {
      console.error("paypal_webhook_error", e instanceof Error ? e.message.slice(0, 200) : "unknown"); // no payload, no PII
      return reply({ error: "server_error" }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPayStore.fromEnv(), paypal: () => PaypalClient.fromEnv() }));
