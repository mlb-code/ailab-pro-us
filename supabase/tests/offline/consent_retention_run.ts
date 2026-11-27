// Offline runner for supabase/tests/consent_retention_test.sql (20261130100100_us_consent_retention.sql): shim + all
// migrations in PGlite, the test, then mutation self-tests (each breaks one rule; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/consent_retention_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/consent_retention_test.sql");
const PASS = "CONSENT_RETENTION_TESTS_PASSED";

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
const src = async (db: PGlite) =>
  (await db.query<{ s: string }>("select prosrc s from pg_catalog.pg_proc where proname = 'run_retention' and pronamespace = 'private'::regnamespace")).rows[0].s;

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.billing_checkouts")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string, boolean]> = [
  ["consent cascades with the account (old foreign key)", `alter table public.billing_checkouts drop constraint billing_checkouts_user_keep_fkey;
    alter table public.billing_checkouts add constraint billing_checkouts_user_keep_fkey foreign key (user_id) references public.profiles(id) on delete cascade;`, false],
  ["consent kept forever", patch("where b.created_at < now() - interval '7 years'", "where false and b.created_at < now() - interval '7 years'"), true],
  ["consent deleted after 3 years", patch("where b.created_at < now() - interval '7 years'", "where b.created_at < now() - interval '3 years'"), true],
  ["no year after the plan ended", patch("or coalesce(s.ends_at, s.canceled_at, now()) > now() - interval '1 year'", "or false"), true],
  ["events kept forever", patch("delete from public.events where created_at < now() - interval '7 years'", "delete from public.events where false"), true],
  ["events deleted after 1 year", patch("delete from public.events where created_at < now() - interval '7 years'", "delete from public.events where created_at < now() - interval '1 year'"), true],
  ["counts not reported", patch("'signup_consent_deleted', n_signup,", ""), true],
];
const orig = await src(db);
for (const [name, sql, fnPatch] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  if (fnPatch && await src(m) === orig) { failed++; console.log(`❌ mutation "${name}" did not change the function`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nCONSENT RETENTION OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
