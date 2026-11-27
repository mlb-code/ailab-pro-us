// Offline runner for supabase/tests/call_notice_record_test.sql (20261130100200_us_call_notice_record.sql): shim + all
// migrations in PGlite (twice: idempotent), the test, then mutation self-tests (each breaks one rule; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/call_notice_record_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/call_notice_record_test.sql");
const PASS = "CALL_NOTICE_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  await db.exec(offline(read("migrations/20261130100200_us_call_notice_record.sql")));   // re-run: idempotent
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.calls")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["notice_lang check removed", "alter table public.calls drop constraint calls_notice_lang_check;"],
  ["notice_version check removed", "alter table public.calls drop constraint calls_notice_version_check;"],
  ["the purge clears the notice record", `create or replace function private.calls_clear_notice() returns trigger language plpgsql as $f$
     begin if new.transcript is null and old.transcript is not null then new.notice_version := null; end if; return new; end $f$;
     create trigger calls_clear_notice before update on public.calls for each row execute function private.calls_clear_notice();`],
  ["client cannot read its calls", "drop policy calls_select on public.calls;"],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nCALL NOTICE RECORD OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
