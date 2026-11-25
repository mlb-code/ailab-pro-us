// Offline runner for supabase/tests/paddle_test.sql (sign-up + Paddle, 20261126100000_us_paddle.sql): shim + all
// migrations in PGlite, the test, then mutation self-tests (each breaks one protection; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/paddle_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/paddle_test.sql");

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith("PADDLE_TESTS_PASSED");
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.billing_checkouts")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["clients read every checkout", `drop policy billing_checkouts_select on public.billing_checkouts;
    create policy billing_checkouts_select on public.billing_checkouts for select to authenticated using (auth.uid() is not null);`],
  ["ref lookup callable by clients", `grant execute on function public.billing_paddle_checkout(text) to authenticated;
    create or replace function public.billing_paddle_checkout(p_ref text) returns jsonb language sql stable security definer set search_path = '' as $f$
      select to_jsonb(c) from public.billing_checkouts c where c.ref = p_ref $f$;`],
  ["second trial for the same phone", `update pg_catalog.pg_proc set prosrc = replace(prosrc, 'if coalesce(p_trial, true) then', 'if false then')
    where proname = 'billing_checkout_start';`],
  ["consent not required", `update pg_catalog.pg_proc set prosrc = replace(prosrc, '< 20 then raise exception ''consent_required''', '< 0 then raise exception ''consent_required''')
    where proname = 'billing_checkout_start';`],
  ["money-back window ignored", `create or replace function private.money_back_open(s public.subscriptions, p_now timestamptz default now()) returns boolean
    language sql stable as $f$ select s.id is not null and private.money_back_used(s) is null $f$;`],
  ["first paid date moves", `update pg_catalog.pg_proc set prosrc = replace(prosrc, 'and s.first_paid_at is null then', 'then')
    where proname = 'billing_paddle_transaction';`],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith("PADDLE_TESTS_PASSED")) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nPADDLE OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
