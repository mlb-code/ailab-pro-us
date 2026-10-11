// Public unsubscribe endpoint for reminder emails (CAN-SPAM; RFC 8058 one-click). Deploy with verify_jwt = false.
//   GET  ?u=<token>   link in the email footer
//   POST ?u=<token>   mail clients' one-click (List-Unsubscribe-Post)
// Plain-text reply (Supabase serves function HTML as text/plain anyway). Same answer for any token: nothing to probe.
// Transactional mail (quotes, payments, account) is not affected — only reminders (quote_reminder, quote_expiring,
// onboarding_nudge).
import { BRAND } from "../_shared/config.ts";
import type { EmailDb } from "../_shared/email/dispatch.ts";
import { RestEmailDb } from "../_shared/email/rest_db.ts";

export function makeHandler(deps: { db: () => Pick<EmailDb, "unsubscribe">; brandName?: string }) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const token = new URL(req.url).searchParams.get("u") ?? "";
    if (/^[0-9a-f]{32,128}$/.test(token)) {
      try { await deps.db().unsubscribe(token); } catch (e) {
        console.error("unsubscribe_error", e instanceof Error ? e.message.slice(0, 120) : "unknown");
        return new Response("Something went wrong. Please reply to any of our emails with \"unsubscribe\".", {
          status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    }
    const name = deps.brandName ?? BRAND.name;
    return new Response(
      `You're unsubscribed from ${name} reminder emails.\n\nYou'll still get emails you need about your quotes, payments and account.\n`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  };
}

if (import.meta.main) Deno.serve(makeHandler({ db: () => RestEmailDb.fromEnv() }));
