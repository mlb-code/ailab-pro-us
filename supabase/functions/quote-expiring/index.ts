// POST (service-role key; call hourly from pg_cron/pg_net or an external cron) -> one quote_expiring email event
// per open quote with ≤ 48 h left. Expiry itself is done by private.expire_quotes() (A1 cron).
import { bearer, errorReply, json } from "../_shared/http.ts";
import { emitExpiring, QuoteError } from "../_shared/quote_engine.ts";
import { RestStore, type Store } from "../_shared/store.ts";

export function makeHandler(deps: { store: () => Store; now?: () => Date }) {
  return async (req: Request): Promise<Response> => {
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const store = deps.store();
      if (!store.isServiceKey(bearer(req))) throw new QuoteError("forbidden", 403);
      return json(req, { emitted: await emitExpiring(store, deps.now ? deps.now() : new Date()) });
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestStore.fromEnv() }));
