// POST {t, name, agree, agreement_version} -> e-signature-lite acceptance (SPEC §2.4, ESIGN):
// typed full name + agreement checkbox + server timestamp + hash of agreement version and exact terms + hashed IP/UA.
// Emits email events quote_accepted (client) and admin_quote_accepted (Meir). Refuses expired and anonymised quotes.
import { clientIp, errorReply, json, readJson } from "../_shared/http.ts";
import { acceptQuote, QuoteError } from "../_shared/quote_engine.ts";
import { RestStore, type Store } from "../_shared/store.ts";

export function makeHandler(deps: { store: () => Store; now?: () => Date }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const b = await readJson(req);
      const view = await acceptQuote({
        token: String(b.t ?? ""), name: String(b.name ?? ""), agree: b.agree === true,
        agreement_version: String(b.agreement_version ?? ""), ip: clientIp(req), ua: req.headers.get("user-agent") ?? "",
      }, deps.store(), deps.now ? deps.now() : new Date());
      return json(req, view);
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestStore.fromEnv() }));
