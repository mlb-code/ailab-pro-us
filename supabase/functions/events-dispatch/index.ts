// POST (service-role key only; called every minute by pg_cron via pg_net, see private.install_email_jobs()):
//   {"task":"email"}          (default) claim due outbox rows -> render -> Resend; one quote-draft task per run
//   {"task":"storage_purge"}  delete files queued in private.storage_purge_queue (A1 retention) via the Storage API
// Env (Edge runtime): SUPABASE_URL + the server key (_shared/keys.ts: SUPABASE_SECRET_KEYS / SB_SERVICE_KEY / legacy
// SUPABASE_SERVICE_ROLE_KEY), RESEND_API_KEY (function secret). The caller (pg_net, Vault ailab_us_service_role_key) must
// present one of our server keys as Bearer (or apikey), so a named secret key in Vault and the "default" one both work.
import { BRAND } from "../_shared/config.ts";
import { type EmailDb, runDispatch, runStoragePurge } from "../_shared/email/dispatch.ts";
import type { EmailBrand } from "../_shared/email/layout.ts";
import { type Mailer, ResendMailer } from "../_shared/email/mailer.ts";
import { RestEmailDb, safeEqual } from "../_shared/email/rest_db.ts";
import { serverKey, serverKeys, supabaseUrl } from "../_shared/keys.ts";

export interface Deps {
  db: () => EmailDb;
  mailer: () => Mailer | null;
  supabaseUrl: () => string;
  serviceKey: () => string;
  /** every key a trusted caller may present (default: just serviceKey) */
  serviceKeys?: () => string[];
  brand?: EmailBrand;
  now?: () => Date;
  fetchFn?: typeof fetch;
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export function makeHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (req.headers.get("apikey") ?? "").trim();
    const accepted = (deps.serviceKeys?.() ?? [deps.serviceKey()]).filter(Boolean);
    if (!tok || !accepted.some((k) => safeEqual(tok, k))) return reply({ error: "forbidden" }, 403);
    let task = "email";
    try { task = String((JSON.parse((await req.text()) || "{}") as Record<string, unknown>).task ?? "email"); } catch { /* default */ }
    try {
      const common = { db: deps.db(), supabaseUrl: deps.supabaseUrl(), serviceKey: deps.serviceKey(), fetchFn: deps.fetchFn };
      if (task === "storage_purge") return reply(await runStoragePurge(common));
      if (task !== "email") return reply({ error: "bad_task" }, 400);
      return reply(await runDispatch({ ...common, mailer: deps.mailer(), brand: deps.brand ?? (BRAND as EmailBrand), now: deps.now }));
    } catch (e) {
      console.error("events_dispatch_error", e instanceof Error ? e.message.slice(0, 200) : "unknown"); // no payloads, no PII
      return reply({ error: "server_error" }, 500);
    }
  };
}

if (import.meta.main) {
  Deno.serve(makeHandler({
    db: () => RestEmailDb.fromEnv(),
    mailer: () => ResendMailer.fromEnv(),
    supabaseUrl: () => supabaseUrl(),
    serviceKey: () => serverKey(),
    serviceKeys: () => serverKeys(),
  }));
}
