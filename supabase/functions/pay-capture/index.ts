// POST {t, which, order_id} -> {status: "paid"|"pending", which, amount_cents, reference}: captures the buyer-approved
// PayPal order SERVER-SIDE (only the order pay-create made last for this payment), checks custom_id / currency / amount
// against our row and marks it paid through pay_record_capture: the same UPDATE as the admin's "סמן כשולם", so
// deposit_received + the setup checklist fire as before, plus payment_receipt (client) and admin_payment_received (Meir).
// Public (verify_jwt = false); 422 instrument_declined = the SDK lets the buyer choose another card.
import { errorReply, json, readJson } from "../_shared/http.ts";
import { capturePayment, type PayDeps } from "../_shared/pay.ts";
import { type PayStore, RestPayStore } from "../_shared/pay_store.ts";
import { PaypalClient } from "../_shared/paypal.ts";
import { QuoteError } from "../_shared/quote_engine.ts";

export function makeHandler(deps: { store: () => PayStore; paypal: () => PaypalClient | null } & Omit<PayDeps, "store" | "paypal">) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const b = await readJson(req, 2048);
      const out = await capturePayment({ token: String(b.t ?? ""), which: String(b.which ?? "deposit"), order_id: String(b.order_id ?? "") },
        { ...deps, store: deps.store(), paypal: deps.paypal() });
      return json(req, out);
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPayStore.fromEnv(), paypal: () => PaypalClient.fromEnv() }));
