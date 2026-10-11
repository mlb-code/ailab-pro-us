// POST {questionnaire_id} -> Claude-drafted, code-priced quote (status draft | needs_manual_price). Never sends anything.
// Caller: the questionnaire-submitted trigger / A8 (service-role key) or Meir's "צור טיוטה מחדש" (admin JWT).
import { modelFromEnv, type QuoteModel } from "../_shared/claude.ts";
import { bearer, errorReply, json, readJson } from "../_shared/http.ts";
import { draftQuote, QuoteError } from "../_shared/quote_engine.ts";
import { RestStore, type Store } from "../_shared/store.ts";

export function makeHandler(deps: { store: () => Store; model: () => QuoteModel }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const store = deps.store();
      const tok = bearer(req);
      if (!tok || !(store.isServiceKey(tok) || await store.adminFromJwt(tok))) throw new QuoteError("forbidden", 403);
      const body = await readJson(req);
      const id = String(body.questionnaire_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new QuoteError("bad_questionnaire_id");
      const q = await draftQuote(id, { store, model: deps.model() });
      return json(req, { quote_id: q.id, status: q.status });
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestStore.fromEnv(), model: modelFromEnv }));
