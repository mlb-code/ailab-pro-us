// POST {quote_id, discount_code?, pay_method?, pay_link?, manual_approved?} — admin only ("אשר ושלח").
// Re-prices from stored codes, applies FOUNDING if Meir chose it, refuses while a manual price is missing,
// moves draft -> approved -> sent (DB sets sent_at + valid_until) and emits the quote_sent email event.
import { bearer, errorReply, json, readJson } from "../_shared/http.ts";
import { QuoteError, sendQuote } from "../_shared/quote_engine.ts";
import { RestStore, type Store } from "../_shared/store.ts";

export function makeHandler(deps: { store: () => Store }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const store = deps.store();
      if (!(await store.adminFromJwt(bearer(req)))) throw new QuoteError("forbidden", 403);
      const b = await readJson(req);
      const q = await sendQuote({
        quote_id: String(b.quote_id ?? ""),
        discount_code: b.discount_code === undefined ? undefined : (b.discount_code as string | null),
        pay_method: (b.pay_method as string | null | undefined) ?? undefined,
        pay_link: (b.pay_link as string | null | undefined) ?? undefined,
        manual_approved: b.manual_approved === true,
      }, store);
      return json(req, { quote_id: q.id, status: q.status, valid_until: q.valid_until });
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestStore.fromEnv() }));
