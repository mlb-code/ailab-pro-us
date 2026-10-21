// POST {t} -> the public quote view: "Prefer Upwork's escrow protection? Pay through Upwork instead" on the quote page.
// The accepted PayPal quote (and its unpaid payment rows) moves to Upwork Direct Contracts, the change is logged and Meir
// gets admin_upwork_requested (Hebrew, the same contract checklist as admin_quote_accepted). Refused once the deposit is
// paid or pending. Public (verify_jwt = false); needs no PayPal secrets.
import { errorReply, json, readJson } from "../_shared/http.ts";
import { useUpwork } from "../_shared/pay.ts";
import { type PayStore, RestPayStore } from "../_shared/pay_store.ts";
import { QuoteError } from "../_shared/quote_engine.ts";

export function makeHandler(deps: { store: () => PayStore; now?: () => Date }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const b = await readJson(req, 1024);
      return json(req, await useUpwork(String(b.t ?? ""), { store: deps.store(), now: deps.now }));
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestPayStore.fromEnv() }));
