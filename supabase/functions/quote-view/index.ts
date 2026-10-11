// GET ?t=<public_token> (or POST {t}) -> whitelisted public quote JSON; first open marks it viewed.
// No sign-in by design (SPEC §2.4). Refuses missing / unsent / void / anonymised quotes with the same 404.
import { errorReply, json, readJson } from "../_shared/http.ts";
import { QuoteError, viewQuote } from "../_shared/quote_engine.ts";
import { RestStore, type Store } from "../_shared/store.ts";

export function makeHandler(deps: { store: () => Store; now?: () => Date }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      let t = "";
      if (req.method === "GET") t = new URL(req.url).searchParams.get("t") ?? "";
      else if (req.method === "POST") t = String((await readJson(req)).t ?? "");
      else throw new QuoteError("method_not_allowed", 405);
      return json(req, await viewQuote(t, deps.store(), deps.now ? deps.now() : new Date()));
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestStore.fromEnv() }));
