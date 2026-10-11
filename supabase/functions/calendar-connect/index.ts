// POST {tenant_id, provider: "google"|"calendly"} — signed-in client (or admin) -> {url} to start the calendar OAuth.
// 1. who is calling: Supabase Auth /auth/v1/user with the caller's JWT;
// 2. ownership: read the tenant through PostgREST AS THE CALLER, so RLS (tenants_select: own client or admin) decides —
//    no service key is used and nothing else about the tenant is returned;
// 3. ticket: POST <RUNTIME_URL>/oauth/<provider>/ticket with the shared secret RUNTIME_ADMIN_TOKEN (runtime/app/calendar/routes.py),
//    which answers {url: "<runtime>/oauth/<provider>/start?ticket=..."} (15 min, single use). The browser never sees the secret.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (both set by Supabase), RUNTIME_URL, RUNTIME_ADMIN_TOKEN (Edge Function secrets; B9).
import { bearer, errorReply, json, readJson } from "../_shared/http.ts";
import { QuoteError } from "../_shared/quote_engine.ts";

export type Env = { supabaseUrl: string; anonKey: string; runtimeUrl: string; runtimeToken: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = ["google", "calendly"];

export function envFromDeno(): Env {
  const g = (k: string) => Deno.env.get(k) ?? "";
  return { supabaseUrl: g("SUPABASE_URL"), anonKey: g("SUPABASE_ANON_KEY"), runtimeUrl: g("RUNTIME_URL"), runtimeToken: g("RUNTIME_ADMIN_TOKEN") };
}

export function makeHandler(deps: { env: () => Env; fetch?: typeof fetch }) {
  const f = deps.fetch ?? fetch;
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return json(req, {});
    try {
      if (req.method !== "POST") throw new QuoteError("method_not_allowed", 405);
      const env = deps.env();
      const jwt = bearer(req);
      if (!jwt) throw new QuoteError("not_signed_in", 401);
      const b = await readJson(req, 1024);
      const tenant = String(b.tenant_id ?? ""), provider = String(b.provider ?? "");
      if (!UUID.test(tenant)) throw new QuoteError("bad_tenant_id");
      if (!PROVIDERS.includes(provider)) throw new QuoteError("unknown_provider");
      if (!env.supabaseUrl || !env.anonKey) throw new QuoteError("server_not_configured", 503);
      const base = env.supabaseUrl.replace(/\/$/, "");
      const auth = { apikey: env.anonKey, Authorization: `Bearer ${jwt}` };
      const u = await f(`${base}/auth/v1/user`, { headers: auth });
      if (!u.ok) throw new QuoteError("not_signed_in", 401);
      const t = await f(`${base}/rest/v1/tenants?select=id&id=eq.${tenant}`, { headers: { ...auth, Accept: "application/json" } });
      if (!t.ok) throw new QuoteError("not_your_tenant", 403);
      const rows = await t.json();
      if (!Array.isArray(rows) || rows.length !== 1) throw new QuoteError("not_your_tenant", 403);
      if (!env.runtimeUrl || !env.runtimeToken) throw new QuoteError(`${provider} calendar connection not configured`, 503);
      let r: Response;
      try {
        r = await f(`${env.runtimeUrl.replace(/\/$/, "")}/oauth/${provider}/ticket`, {
          method: "POST", headers: { Authorization: `Bearer ${env.runtimeToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: tenant }),
        });
      } catch {
        throw new QuoteError("runtime_unreachable", 503);
      }
      if (r.status === 503) throw new QuoteError(`${provider} OAuth not configured`, 503);
      if (r.status === 404) throw new QuoteError("unknown_tenant", 404);
      if (!r.ok) throw new QuoteError("runtime_error", 502);
      const out = await r.json().catch(() => ({}));
      const url = String((out as { url?: string }).url ?? "");
      if (!/^https?:\/\/[^\s]+\/oauth\/(google|calendly)\/start\?ticket=/.test(url)) throw new QuoteError("runtime_error", 502);
      return json(req, { url });
    } catch (e) {
      return errorReply(req, e);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ env: envFromDeno }));
