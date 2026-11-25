// The setup checklist -> tenant config rules exist twice: in SQL (private.onboarding_patch, the real path) and in the
// browser (site/start/assets/onboarding-config.js: mock backend + admin merge button). This runs both on the same inputs
// and fails on any difference (result or error code).
//   deno run -A --node-modules-dir=none supabase/tests/offline/onboarding_parity_run.ts     exit 0 = same
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const db = new PGlite();
await db.exec(read("tests/offline/supabase_shim.sql"));
for (const m of [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort()) {
  await db.exec(offline(read("migrations/" + m)));
}
(0, eval)(Deno.readTextFileSync(new URL("../site/start/assets/onboarding-config.js", root)));
// deno-lint-ignore no-explicit-any
const JS = (globalThis as any).OnboardingConfig;

const base = { business: { name: "Cool Breeze HVAC", niche: "home_services", timezone: "America/Chicago", main_phone: "+17135550100" },
  hours: { mon: ["08:00", "17:00"] }, booking: { provider: "calendly", windows: [["08:00", "12:00"]], job_types: ["Service call"] },
  notify: { sms: [], email: ["a@example.com"] } };
const re = { ...base, business: { ...base.business, niche: "real_estate" } };
const CASES: Array<[string, unknown, unknown?]> = [
  ["hours", { timezone: "America/New_York", hours: { mon: ["07:00", "18:00"], sat: null }, after_hours: { mode: "message_only" } }],
  ["hours", { hours: { mon: ["18:00", "07:00"] } }], ["hours", { hours: { funday: ["08:00", "09:00"] } }], ["hours", { hours: { mon: null } }],
  ["hours", { timezone: "Mars/Olympus" }], ["hours", { after_hours: { mode: "sleep" } }],
  ["faq", { services: ["AC repair", " Furnace "], faq: [{ q: "Trane?", a: "Yes." }], service_area: "77005, 77006; Bellaire, harris county, Harris County\nWest U 77005",
    price_on_phone: "fixed", fixed_prices: ["Service call: $89", "Drain cleaning - 150", "AC tune-up $79.99 (per unit)", "Tune-up – 60", "call us", "Big $200000"] }],
  ["faq", { price_on_phone: "fixed", fixed_prices: ["ask"] }], ["faq", { price_on_phone: "no" }], ["faq", { services: [] }],
  ["faq", { faq: [{ q: "Q", a: "y".repeat(601) }] }], ["faq", { re_lead_types: ["renters"], re_qualify: ["budget", "timeline"] }, re],
  ["alerts", { notify: { sms: ["+17135550111"], email: ["x@example.com"], daily_summary: null }, on_call_number: "+17135550188",
    emergency: { keywords: [" gas smell ", "flooding"] } }],
  ["alerts", { notify: { sms: [], email: [] } }], ["alerts", { notify: { sms: ["+447700900123"] } }], ["alerts", { on_call_number: null }],
  ["alerts", { notify: { email: ["nope"] } }],
  ["calendar", { booking_mode: "messages_only" }], ["calendar", { provider: "google" }], ["calendar", { provider: "outlook" }],
  ["calendar", { provider: "calendly", booking_link: "https://calendly.com/coolbreeze/visit" }], ["calendar", { booking_link: "http://calendly.com/x" }],
  ["tools", { zapier_webhook_url: "https://hooks.zapier.com/hooks/catch/1/abc/" }], ["tools", { zapier_webhook_url: null }],
  ["tools", { zapier_webhook_url: "http://x" }], ["forward_calls", { business_phone: "+17135550199" }], ["forward_calls", { business_phone: "713" }],
  ["sms", { legal_name: "X", ein: "12-3456789" }],
];
const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
let bad = 0;
for (const [key, data, cfg = base] of CASES) {
  let sql: string, js: string;
  try {
    const r = await db.query<{ c: unknown }>("select private.onboarding_patch($1, $2::jsonb, $3::jsonb) c", [key, JSON.stringify(data), JSON.stringify(cfg)]);
    sql = JSON.stringify(norm(r.rows[0].c));
  } catch (e) { sql = "ERR " + (e instanceof Error ? e.message : String(e)); }
  try { js = JSON.stringify(norm(JS.patch(key, data, cfg))); } catch (e) { js = "ERR " + (e as Error).message; }
  if (sql === js) console.log(`✅ ${key} ${JSON.stringify(data).slice(0, 70)}`);
  else { bad++; console.log(`❌ ${key} ${JSON.stringify(data).slice(0, 70)}\n   sql: ${sql}\n   js:  ${js}`); }
}
console.log(bad ? `\n${bad} DIFFER` : `\nONBOARDING PARITY PASSED (${CASES.length} cases)`);
Deno.exit(bad ? 1 : 0);
