// Small HTTP helpers shared by the quote functions: CORS (brand origin; localhost only in dev), JSON replies, caller identity.
import { BRAND } from "./config.ts";
import { QuoteError } from "./quote_engine.ts";
import { DbError } from "./store.ts";

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
/** localhost origins only in dev/sim (env SIM_MODE=1 or ALLOW_LOCALHOST_CORS=1); never set on the production project. */
const devCors = () => { try { return Deno.env.get("SIM_MODE") === "1" || Deno.env.get("ALLOW_LOCALHOST_CORS") === "1"; } catch { return false; } };

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const site = (BRAND.site_url || "").replace(/\/$/, "");
  const allowed = origin && (origin === site || (devCors() && LOCAL.test(origin))) ? origin : site;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
}

export function errorReply(req: Request, e: unknown): Response {
  if (e instanceof QuoteError) return json(req, { error: e.code }, e.status);
  if (e instanceof DbError) return json(req, { error: e.code }, 409);
  console.error("quote_fn_error", e instanceof Error ? e.message : "unknown"); // no payloads, no PII
  return json(req, { error: "server_error" }, 500);
}

export const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

/** First hop of X-Forwarded-For (set by the Supabase edge gateway), else CF/real-ip headers. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  return (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "").slice(0, 64);
}

export async function readJson(req: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new QuoteError("payload_too_large", 413);
  try {
    const v = JSON.parse(text || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new QuoteError("bad_json");
  }
}
