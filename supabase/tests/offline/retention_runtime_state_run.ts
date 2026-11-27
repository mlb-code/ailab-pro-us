// Offline runner for supabase/tests/retention_runtime_state_test.sql (20261129100000_us_retention_runtime_state.sql): shim +
// all migrations in PGlite, the test, then mutation self-tests (each breaks one rule; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/retention_runtime_state_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/retention_runtime_state_test.sql");
const PASS = "RETENTION_STATE_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const patch = (from: string, to: string) =>
  `update pg_catalog.pg_proc set prosrc = replace(prosrc, $q$${from}$q$, $q$${to}$q$) where proname = 'run_retention' and pronamespace = 'private'::regnamespace;`;

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.runtime_state")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["conversations kept forever", patch("key like 'convo:%' and updated_at", "false and updated_at")],
  ["conversations deleted at once", patch("key like 'convo:%' and updated_at < now() - interval '90 days'", "key like 'convo:%'")],
  ["caller state kept", patch("key like 'lookup:%' or key like 'lang:%'", "false")],
  ["thread counters deleted too", patch("or key like 'review:%')", "or key like 'review:%' or key like 'smsthread:%')")],
  ["counters deleted too", patch("or key like 'review:%')", "or key like 'review:%' or key like 'usage:%')")],
  ["caller events kept", patch("type in ('zapier.pending', 'alert.pending', 'zapier.dead_letter', 'email.outbox', 'sms.outbox')", "false")],
  ["every old runtime event deleted", patch("actor = 'runtime' and type in ('zapier.pending', 'alert.pending', 'zapier.dead_letter', 'email.outbox', 'sms.outbox')", "actor = 'runtime'")],
  ["admin events deleted", patch("where actor = 'runtime' and type in", "where type in")],
  ["counts not reported", patch("'convo_deleted', n_convo,", "")],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const changed = (await m.query<{ s: string }>("select prosrc s from pg_catalog.pg_proc where proname = 'run_retention'")).rows[0].s;
  const orig = (await db.query<{ s: string }>("select prosrc s from pg_catalog.pg_proc where proname = 'run_retention'")).rows[0].s;
  if (changed === orig) { failed++; console.log(`❌ mutation "${name}" did not change the function`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nRETENTION (RUNTIME STATE) OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
