// POST from Paddle (server to server; verify_jwt = false, no CORS). Paddle-Signature (ts + h1 = HMAC-SHA256 of
// "ts:raw body" with the notification destination's secret, PADDLE_WEBHOOK_SECRET) is checked on the RAW body before
// anything is parsed; bad / missing / stale -> 401 and nothing changes. Each event id is applied once (private.paddle_events);
// older events never overwrite newer ones (billing_upsert_subscription compares occurred_at). 200 = applied or ignored;
// 500 = temporary failure, Paddle retries. Subscribe the destination to exactly WEBHOOK_EVENTS.
import { BRAND } from "../_shared/config.ts";
import { paddleSecretsFromEnv, priceMap, WEBHOOK_EVENTS } from "../_shared/paddle.ts";
import { handlePaddleWebhook } from "../_shared/paddle_billing.ts";
import { type PaddleStore, RestPaddleStore } from "../_shared/paddle_store.ts";

export { WEBHOOK_EVENTS };
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export function makeHandler(deps: { store: () => PaddleStore; secret: () => string; brand?: Record<string, unknown>; nowSec?: () => number }) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    try {
      const raw = await req.text();   // the raw body: the signature is over these exact bytes
      const out = await handlePaddleWebhook(raw, req.headers, { store: deps.store(), secret: deps.secret(), prices: priceMap(deps.brand ?? BRAND), nowSec: deps.nowSec });
      return reply(out.body, out.status);
    } catch (e) {
      console.error("paddle_webhook_error", e instanceof Error ? e.message.slice(0, 200) : "unknown");   // no payload, no PII
      return reply({ error: "server_error" }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPaddleStore.fromEnv(), secret: () => paddleSecretsFromEnv().webhookSecret }));
