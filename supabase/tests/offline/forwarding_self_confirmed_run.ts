// Offline runner for supabase/tests/forwarding_self_confirmed_test.sql (20261129100200_us_forwarding_self_confirmed.sql):
// shim + all migrations in PGlite, the test, then mutation self-tests (each breaks one rule; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/forwarding_self_confirmed_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/forwarding_self_confirmed_test.sql");
const PASS = "FORWARDING_SELF_CONFIRMED_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const patch = (fn: string, from: string, to: string) =>
  `update pg_catalog.pg_proc set prosrc = replace(prosrc, $q$${from}$q$, $q$${to}$q$) where proname = '${fn}' and pronamespace = 'public'::regnamespace;`;

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.clients")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["self-confirm not marked unverified", patch("confirm_forwarding_test", "'unverified', true,", "")],
  ["no admin e-mail", patch("confirm_forwarding_test", "perform private.enqueue_email_safe(", "perform private.enqueue_email_safe('x' || ")],
  ["admin event visible to the client", patch("confirm_forwarding_test", "'by', case when by_admin then 'admin' else 'client' end), false);", "'by', case when by_admin then 'admin' else 'client' end), true);")],
  ["admin view hides it", patch("admin_subscriptions_extra", "'unverified', o.status = 'done' and o.data ->> 'verified' is distinct from 'forwarded_from',", "'unverified', false,")],
  ["admin view calls a verified forward unverified", patch("admin_subscriptions_extra", "is distinct from 'forwarded_from',", "is not null,")],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nFORWARDING SELF-CONFIRMED OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
