// Offline runner for supabase/tests/firstring_p3_test.sql (FirstRing phase 3, 20261127100000_us_firstring_p3.sql): shim + all
// migrations in PGlite, the test, then mutation self-tests (each breaks one protection; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/firstring_p3_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/firstring_p3_test.sql");
const PASS = "FIRSTRING_P3_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const pub = (name: string, body: string) =>
  `update pg_catalog.pg_proc set prosrc = ${body} where proname = '${name}' and pronamespace = 'public'::regnamespace;`;

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.number_releases")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["the date is not exposed", pub("client_billing", "replace(prosrc, $q$'number_release', rel,$q$, '')")],
  ["held / canceled releases shown", pub("client_billing", "replace(prosrc, $q$r.status = 'scheduled'$q$, 'true')")],
  ["another client's release shown", pub("client_billing", "replace(prosrc, $q$r.client_id = me.id and r.tenant_id = t.id and $q$, '')")],
  ["internal fields shown", pub("client_billing", "replace(prosrc, $q$jsonb_build_object('number', r.number, 'release_at', r.release_at)$q$, $q$to_jsonb(r)$q$)")],
  ["contact e-mail ignored", pub("runtime_account_email", "replace(prosrc, $q$coalesce(nullif(btrim(p.contact_email), ''), p.email)$q$, 'p.email')")],
  ["clients may read account e-mails", `create or replace function public.runtime_account_email(p_client uuid) returns text
    language sql stable security definer set search_path = '' as $f$
      select coalesce(p.contact_email, p.email) from public.clients c join public.profiles p on p.id = c.user_id where c.id = p_client $f$;
    grant execute on function public.runtime_account_email(uuid) to authenticated, anon;`],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nFIRSTRING P3 OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
