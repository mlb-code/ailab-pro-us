// POST {v: 1, client_turn_id, input} with the signed-in customer's JWT -> one setup-assistant turn (contract:
// _shared/setup_contract.json; design 2026-11-27, internal repo). verify_jwt stays on (not in us_setup.py NO_VERIFY_JWT).
// 1. who is calling: Supabase Auth /auth/v1/user with the caller's JWT (like calendar-connect);
// 2. the conversation store: service-role RPCs (20261201100000_us_setup_agent.sql) decide ownership (the caller's own plan
//    client), one turn at a time, idempotency, rate limits, the kill switch and the daily budget;
// 3. settings: read and written ONLY as the caller (PostgREST with their JWT: onboarding_items, tenants,
//    rpc/setup_preview_step, rpc/update_onboarding_item), so RLS and onboarding_apply's checks apply to every write;
// 4. the model: Claude through _shared/setup_model.ts (key ANTHROPIC_API_KEY_SETUP, else ANTHROPIC_API_KEY). A model failure is
//    a 200 with status "unavailable" and a fallback, never an HTTP error.
// Logs: ids, op names, status codes, token counts, latency, key_source. Never message text.
import { bearer, errorReply, json, readJson } from "../_shared/http.ts";
import { publicKey, supabaseUrl } from "../_shared/keys.ts";
import { QuoteError } from "../_shared/quote_engine.ts";
import { type EngineDeps, type Input, runTurn } from "../_shared/setup_engine.ts";
import { liveSetupModel, type SetupModel } from "../_shared/setup_model.ts";
import { RestSetupStore, RestUserDb, type SetupStore, type UserDb } from "../_shared/setup_store.ts";
import { DbError } from "../_shared/store.ts";

export interface Deps {
  store: () => SetupStore;
  db: (jwt: string) => UserDb;
  /** null = no API key: typed messages get fallback "disabled"; the buttons and the transcript keep working */
  model: () => SetupModel | null;
  now?: () => number;
  log?: EngineDeps["log"];
}
const TURN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EVENTS = ["calendar_returned", "test_started", "test_changed", "forms_saved", "back_online"];
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** The request body -> a typed input, or bad_input. Strict: unknown keys are refused (setup_contract.json Request). */
export function parseRequest(b: Record<string, unknown>): { client_turn_id: string; input: Input } {
  const bad = () => new QuoteError("bad_input", 400);
  if (b.v !== 1 || !only(b, ["v", "client_turn_id", "input"]) || typeof b.client_turn_id !== "string" || !TURN_ID.test(b.client_turn_id)) throw bad();
  const i = b.input as Record<string, unknown> | null;
  if (!i || typeof i !== "object" || Array.isArray(i)) throw bad();
  const str = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && v.length <= max;
  switch (i.type) {
    case "resume": if (only(i, ["type"])) return { client_turn_id: b.client_turn_id, input: { type: "resume" } }; break;
    case "message":
      if (only(i, ["type", "text"]) && str(i.text, 1000) && String(i.text).trim()) {
        return { client_turn_id: b.client_turn_id, input: { type: "message", text: String(i.text).trim() } };
      }
      break;
    case "confirm": case "change":
      if (only(i, ["type", "proposal_id"]) && str(i.proposal_id, 40)) {
        return { client_turn_id: b.client_turn_id, input: { type: i.type, proposal_id: String(i.proposal_id) } as Input };
      }
      break;
    case "choose": if (only(i, ["type", "choice_id"]) && str(i.choice_id, 80)) return { client_turn_id: b.client_turn_id, input: { type: "choose", choice_id: String(i.choice_id) } }; break;
    case "event":
      if (only(i, ["type", "event"]) && EVENTS.includes(String(i.event))) {
        return { client_turn_id: b.client_turn_id, input: { type: "event", event: i.event } as Input };
      }
      break;
  }
  throw bad();
}

export function makeHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const jwt = bearer(req);
      if (!jwt) throw new QuoteError("not_signed_in", 401);
      const { client_turn_id, input } = parseRequest(await readJson(req, 4096));
      const db = deps.db(jwt);
      const user = await db.user();
      if (!user) throw new QuoteError("not_signed_in", 401);
      const r = await runTurn({ store: deps.store(), db, model: deps.model(), now: deps.now, log: deps.log }, { userId: user.id, client_turn_id, input });
      return json(req, r.body, r.status);
    } catch (e) {
      if (e instanceof DbError) {
        if (e.code === "not_a_plan_client" || e.code === "not_your_conversation") return json(req, { error: "not_a_plan_client" }, 403);
        if (e.code === "bad_input") return json(req, { error: "bad_input" }, 400);
        if (e.code === "lock_lost") return json(req, { error: "turn_in_progress" }, 409);
        console.error("setup_agent_db_error", e.code.slice(0, 80));   // a code, never data
        return json(req, { error: "server_error" }, 500);
      }
      if (e instanceof Error && e.message === "supabase_env_missing") return json(req, { error: "server_not_configured" }, 503);
      return errorReply(req, e);
    }
  };
}

export function liveDeps(): Deps {
  let keyLogged = false;
  return {
    store: () => RestSetupStore.fromEnv(),
    db: (jwt) => {
      const url = supabaseUrl(), anon = publicKey();
      if (!url || !anon) throw new Error("supabase_env_missing");
      return new RestUserDb(url, anon, jwt);
    },
    model: () => {
      const m = liveSetupModel();
      if (!keyLogged) { keyLogged = true; console.log(JSON.stringify({ ev: "setup_agent_key", key_source: m.keySource, wire: m.wire })); }   // which key, never its value
      return m.keySource === "none" ? null : m;
    },
  };
}

if (import.meta.main) Deno.serve(makeHandler(liveDeps()));
