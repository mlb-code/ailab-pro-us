import { assert, eq } from "./test_util.ts";
function throwsMsg(fn: () => unknown, msg: string) {
  try { fn(); } catch (e) { eq((e as Error).message, msg); return; }
  throw new Error("expected a throw");
}
import { keyFromJson, publicKey, resetKeyWarnings, serverEnv, serverKey, serverKeys, supabaseUrl } from "./keys.ts";

const env = (m: Record<string, string>) => ({ get: (n: string) => m[n] });
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const SECRET = "sb_secret_default000000000000000000"; // test value, not a real key
const CUSTOM = "sb_secret_custom0000000000000000000";
const LEGACY = "eyJhbGciOi.legacy.servicerole";

Deno.test("keys: injected secret keys JSON wins (default entry, any shape)", () => {
  resetKeyWarnings(); logs.length = 0;
  const arr = JSON.stringify([{ name: "other", api_key: "sb_secret_other" }, { name: "default", api_key: SECRET }]);
  eq(serverKey(env({ SUPABASE_SECRET_KEYS: arr, SB_SERVICE_KEY: CUSTOM, SUPABASE_SERVICE_ROLE_KEY: LEGACY }), log), SECRET);
  eq(serverKey(env({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) }), log), SECRET);
  eq(serverKey(env({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: { api_key: SECRET } }) }), log), SECRET);
  eq(serverKey(env({ SUPABASE_SECRET_KEYS: ` ${SECRET} ` }), log), SECRET); // bare value
  eq(serverKey(env({ SUPABASE_SECRET_KEYS: JSON.stringify([{ name: "x", api_key: "sb_secret_first" }]) }), log), "sb_secret_first");
  eq(logs, []);
});

Deno.test("keys: unparsable JSON is ignored, next candidate wins", () => {
  resetKeyWarnings(); logs.length = 0;
  eq(keyFromJson("{not json"), "");
  eq(keyFromJson("[]"), "");
  eq(keyFromJson(""), "");
  eq(serverKey(env({ SUPABASE_SECRET_KEYS: "{bad", SB_SERVICE_KEY: CUSTOM, SUPABASE_SERVICE_ROLE_KEY: LEGACY }), log), CUSTOM);
  eq(logs, []);
});

Deno.test("keys: custom secret before legacy, no warning", () => {
  resetKeyWarnings(); logs.length = 0;
  eq(serverKey(env({ SB_SERVICE_KEY: CUSTOM, SUPABASE_SERVICE_ROLE_KEY: LEGACY }), log), CUSTOM);
  eq(publicKey(env({ SB_PUBLISHABLE_KEY: "sb_publishable_x", SUPABASE_ANON_KEY: "anon.jwt.x" }), log), "sb_publishable_x");
  eq(logs, []);
});

Deno.test("keys: only legacy present -> used, warned once, value never in the warning", () => {
  resetKeyWarnings(); logs.length = 0;
  const e = env({ SUPABASE_SERVICE_ROLE_KEY: LEGACY, SUPABASE_ANON_KEY: "anon.jwt.x" });
  eq(serverKey(e, log), LEGACY);
  eq(serverKey(e, log), LEGACY);
  eq(publicKey(e, log), "anon.jwt.x");
  eq(logs.length, 2); // one for server, one for public
  eq(logs[0].startsWith("supabase_server_key_legacy"), true);
  eq(logs[1].startsWith("supabase_public_key_legacy"), true);
  for (const l of logs) assert(!l.includes(LEGACY) && !l.includes("anon.jwt.x"), "key value leaked into the warning");
});

Deno.test("keys: none present -> empty, serverEnv throws without values", () => {
  resetKeyWarnings(); logs.length = 0;
  eq(serverKey(env({}), log), "");
  eq(publicKey(env({}), log), "");
  eq(serverKeys(env({})), []);
  throwsMsg(() => serverEnv(env({ SUPABASE_URL: "https://x.supabase.co/" }), log), "supabase_env_missing");
  throwsMsg(() => serverEnv(env({ SB_SERVICE_KEY: CUSTOM }), log), "supabase_env_missing");
  eq(logs, []);
});

Deno.test("keys: serverEnv strips the trailing slash; serverKeys lists every distinct key, best first", () => {
  resetKeyWarnings();
  const e = env({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), SB_SERVICE_KEY: CUSTOM,
    SUPABASE_SERVICE_ROLE_KEY: LEGACY });
  eq(serverEnv(e, log), { url: "https://x.supabase.co", key: SECRET });
  eq(supabaseUrl(e), "https://x.supabase.co");
  eq(serverKeys(e), [SECRET, CUSTOM, LEGACY]);
  eq(serverKeys(env({ SB_SERVICE_KEY: CUSTOM, SUPABASE_SERVICE_ROLE_KEY: CUSTOM })), [CUSTOM]);
});
