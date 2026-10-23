// Supabase API keys for the Edge Functions, in one place (22.10.2026: off the legacy JWT keys).
//
// Server key (bypasses RLS; never logged, never returned), first match wins:
//   1. SUPABASE_SECRET_KEYS   injected by the Edge runtime when the project has new-style secret keys: JSON, the "default"
//                             entry (array of {name, api_key} or an object keyed by name; a bare sb_secret_… string also works)
//   2. SB_SERVICE_KEY         our own function secret (set by tools/us_setup.py --only supabase-keys); names starting with
//                             SUPABASE_ are reserved by Supabase, hence the SB_ prefix
//   3. SUPABASE_SERVICE_ROLE_KEY   the legacy service_role JWT (warned once per isolate; goes away when legacy keys are off)
// Public key, same idea: SUPABASE_PUBLISHABLE_KEYS -> SB_PUBLISHABLE_KEY -> SUPABASE_ANON_KEY.
// The new keys are accepted in both the `apikey` and the `Authorization: Bearer` header, so callers keep sending both.

export interface KeyEnv { get(name: string): string | undefined }

const SERVER = { json: "SUPABASE_SECRET_KEYS", custom: "SB_SERVICE_KEY", legacy: "SUPABASE_SERVICE_ROLE_KEY", label: "server" } as const;
const PUBLIC = { json: "SUPABASE_PUBLISHABLE_KEYS", custom: "SB_PUBLISHABLE_KEY", legacy: "SUPABASE_ANON_KEY", label: "public" } as const;
type Spec = typeof SERVER | typeof PUBLIC;

const warned = new Set<string>();
/** Tests only: forget which legacy warnings were already printed. */
export function resetKeyWarnings() { warned.clear(); }

/** The "default" key out of the injected JSON (or the first one); "" when absent or unparsable. Never throws. */
export function keyFromJson(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (!s.startsWith("[") && !s.startsWith("{")) return s.includes('"') ? "" : s; // a bare key value
  let v: unknown;
  try { v = JSON.parse(s); } catch { return ""; }
  const pick = (x: unknown): string => {
    if (typeof x === "string") return x.trim();
    if (x && typeof x === "object") { const o = x as Record<string, unknown>; return typeof o.api_key === "string" ? o.api_key.trim() : ""; }
    return "";
  };
  if (Array.isArray(v)) {
    const named = v.find((e) => e && typeof e === "object" && (e as Record<string, unknown>).name === "default");
    return pick(named ?? v[0]);
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("default" in o) return pick(o.default);
    if (typeof o.api_key === "string") return o.api_key.trim();
    const first = Object.values(o)[0];
    return pick(first);
  }
  return "";
}

function candidates(spec: Spec, env: KeyEnv): Array<{ source: "json" | "custom" | "legacy"; key: string }> {
  const out: Array<{ source: "json" | "custom" | "legacy"; key: string }> = [];
  const j = keyFromJson(env.get(spec.json));
  if (j) out.push({ source: "json", key: j });
  const c = (env.get(spec.custom) ?? "").trim();
  if (c) out.push({ source: "custom", key: c });
  const l = (env.get(spec.legacy) ?? "").trim();
  if (l) out.push({ source: "legacy", key: l });
  return out;
}

function pick(spec: Spec, env: KeyEnv, log: (m: string) => void): string {
  const c = candidates(spec, env);
  if (!c.length) return "";
  if (c[0].source === "legacy" && !warned.has(spec.label)) {
    warned.add(spec.label);
    log(`supabase_${spec.label}_key_legacy: only ${spec.legacy} is set; set ${spec.custom} (new-style key) before legacy keys are disabled`);
  }
  return c[0].key;
}

const denoEnv: KeyEnv = { get: (n) => Deno.env.get(n) };
const warn = (m: string) => console.warn(m);

/** The server (secret / service) key, or "" when none is configured. */
export function serverKey(env: KeyEnv = denoEnv, log = warn): string { return pick(SERVER, env, log); }
/** Every configured server key, best first: for "is this caller us?" checks (pg_net may hold a different named secret key). */
export function serverKeys(env: KeyEnv = denoEnv): string[] { return [...new Set(candidates(SERVER, env).map((c) => c.key))]; }
/** The public (publishable / anon) key, or "". */
export function publicKey(env: KeyEnv = denoEnv, log = warn): string { return pick(PUBLIC, env, log); }
/** SUPABASE_URL without a trailing slash, or "". */
export function supabaseUrl(env: KeyEnv = denoEnv): string { return (env.get("SUPABASE_URL") ?? "").trim().replace(/\/$/, ""); }

/** URL + server key for the PostgREST stores; throws `supabase_env_missing` (no values in the message) when either is absent. */
export function serverEnv(env: KeyEnv = denoEnv, log = warn): { url: string; key: string } {
  const url = supabaseUrl(env), key = serverKey(env, log);
  if (!url || !key) throw new Error("supabase_env_missing");
  return { url, key };
}
