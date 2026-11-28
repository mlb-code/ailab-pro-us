// The REAL setup-agent Edge Function (handler + turn engine + in-memory store + scripted model), bundled for the browser by
// tools/e2e_setup_agent_engine.mjs (`deno bundle`, at test time, into a temp dir). Lets the portal's setup-chat.js talk to
// the server code instead of the hand-written mock (site/start/assets/mock/setup-script.js). Never deployed, never served
// by the site, holds no keys; the scripted model is the only model in it.
export { makeHandler } from "../supabase/functions/setup-agent/index.ts";
export { MemorySetupStore, MemoryUserDb, MemoryWorld } from "../supabase/functions/_shared/setup_store.ts";
export { scriptedSetupModel } from "../supabase/functions/_shared/setup_model.ts";
export { DEFAULT_WIRE } from "../supabase/functions/_shared/setup_wire.ts";
export { DbError } from "../supabase/functions/_shared/store.ts";
