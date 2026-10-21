// POST {t, which: "deposit"|"final"} -> {order_id}: a PayPal order for the payment row of an accepted PayPal quote
// (quote page = deposit, portal = final). Public like quote-view (verify_jwt = false): the quote token is the secret.
// The amount comes from our DB row, never from the browser; custom_id = invoice_id = our payment id. Reuses the
// payment's open order. PayPal off (brand.json payments.paypal or the Edge Function secrets) -> 503 paypal_off.
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (injected), PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV (secrets).
import { errorReply, json, readJson } from "../_shared/http.ts";
import { createPayment, type PayDeps } from "../_shared/pay.ts";
import { type PayStore, RestPayStore } from "../_shared/pay_store.ts";
import { PaypalClient } from "../_shared/paypal.ts";
import { QuoteError } from "../_shared/quote_engine.ts";

export function makeHandler(deps: { store: () => PayStore; paypal: () => PaypalClient | null } & Omit<PayDeps, "store" | "paypal">) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const b = await readJson(req, 2048);
      const out = await createPayment({ token: String(b.t ?? ""), which: String(b.which ?? "deposit") },
        { ...deps, store: deps.store(), paypal: deps.paypal() });
      return json(req, out);
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPayStore.fromEnv(), paypal: () => PaypalClient.fromEnv() }));
