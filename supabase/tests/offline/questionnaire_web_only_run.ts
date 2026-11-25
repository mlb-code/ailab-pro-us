// Offline runner for supabase/tests/questionnaire_web_only_test.sql (20261127200000_us_questionnaire_web_only.sql): shim + all
// migrations in PGlite, the test, then mutation self-tests (each breaks one rule; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/questionnaire_web_only_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/questionnaire_web_only_test.sql");
const PASS = "WEB_ONLY_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const fn = (body: string) =>
  `update pg_catalog.pg_proc set prosrc = ${body} where proname = 'questionnaires_offer_guard' and pronamespace = 'private'::regnamespace;`;

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.questionnaires")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["guard removed (FirstRing questionnaires again)", "drop trigger questionnaires_offer_guard on public.questionnaires;"],
  ["RCP still allowed", fn("replace(prosrc, $q$new.offer::text <> 'WEB'$q$, $q$new.offer::text not in ('WEB', 'RCP')$q$)")],
  ["only inserts checked (old draft sent as FirstRing)", fn("replace(prosrc, $q$if tg_op = 'UPDATE' and old.status is distinct from 'draft' then return new; end if;$q$, $q$if tg_op = 'UPDATE' then return new; end if;$q$)")],
  ["admin / service role blocked too", fn("replace(prosrc, $q$if not private.is_client_call() then return new; end if;$q$, '')")],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nWEB-ONLY QUESTIONNAIRE OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
