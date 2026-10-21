// POST {payment_id} — admin only (verify_jwt = true + profiles.is_admin): full PayPal refund of a paid PayPal deposit
// within the price book's deposit rule (refund_rules.deposit.window_days from the payment), then the row is marked
// refunded (pay_mark_refunded, logged). PayPal-Request-Id per capture: a double click refunds once. Older refunds, or the
// 30-day guarantee, are done in PayPal itself; the webhook (PAYMENT.CAPTURE.REFUNDED) then marks the row.
import { bearer, errorReply, json, readJson } from "../_shared/http.ts";
import { type PayDeps, refundPayment } from "../_shared/pay.ts";
import { type PayStore, RestPayStore } from "../_shared/pay_store.ts";
import { PaypalClient } from "../_shared/paypal.ts";
import { QuoteError } from "../_shared/quote_engine.ts";

export function makeHandler(deps: { store: () => PayStore; paypal: () => PaypalClient | null } & Omit<PayDeps, "store" | "paypal">) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const store = deps.store();
      const uid = await store.adminFromJwt(bearer(req));
      if (!uid) throw new QuoteError("forbidden", 403);
      const b = await readJson(req, 1024);
      return json(req, await refundPayment({ payment_id: String(b.payment_id ?? ""), admin_uid: uid }, { ...deps, store, paypal: deps.paypal() }));
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPayStore.fromEnv(), paypal: () => PaypalClient.fromEnv() }));
