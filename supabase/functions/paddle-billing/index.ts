// POST {action, plan_code?, client_id?, confirm?} with the signed-in user's JWT (verify_jwt = true). The portal's plan
// buttons for a Paddle subscription: change_plan (upgrade now prorated / downgrade at the next billing date / trial change),
// start_now (end the trial, charge now), cancel (trial: now, no charge; paid: at the end of the paid period), resume (undo
// a scheduled cancel / resume a pause), update_card + manage (temporary Paddle customer-portal link). Admin only:
// money_back (full refund of the first paid charge within 30 days, once per business, after an explicit confirm, then the
// plan ends). Calls Paddle with PADDLE_API_KEY (server only); our database follows through the paddle-webhook.
import { bearer, json, readJson } from "../_shared/http.ts";
import { PaddleClient, PaddleError } from "../_shared/paddle.ts";
import { billingAction } from "../_shared/paddle_billing.ts";
import { type PaddleStore, RestPaddleStore } from "../_shared/paddle_store.ts";
import { QuoteError } from "../_shared/quote_engine.ts";
import { DbError } from "../_shared/store.ts";

export function makeHandler(deps: { store: () => PaddleStore; paddle: () => PaddleClient | null; brand?: Record<string, unknown> }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new PaddleError("method_not_allowed", 405);
      const b = await readJson(req, 2048);
      const out = await billingAction({ jwt: bearer(req), action: String(b.action ?? ""), plan_code: typeof b.plan_code === "string" ? b.plan_code : undefined,
        client_id: typeof b.client_id === "string" ? b.client_id : undefined, confirm: b.confirm === true }, { store: deps.store(), paddle: deps.paddle(), brand: deps.brand });
      return json(req, out);
    } catch (e) {
      if (e instanceof PaddleError) return json(req, { error: e.code, ...(e.paddleCode ? { paddle: e.paddleCode } : {}) }, e.status);
      if (e instanceof DbError) return json(req, { error: e.code }, 409);
      if (e instanceof QuoteError) return json(req, { error: e.code }, e.status);   // bad_json / payload_too_large
      console.error("paddle_billing_error", e instanceof Error ? e.message.slice(0, 200) : "unknown");
      return json(req, { error: "server_error" }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPaddleStore.fromEnv(), paddle: () => PaddleClient.fromEnv() }));
