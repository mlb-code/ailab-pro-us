// Offline runner for supabase/tests/firstring_p2_test.sql (FirstRing phase 2, 20261125200000_us_firstring_p2.sql): shim + all
// migrations in PGlite, the test, then mutation self-tests (each breaks one protection; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/firstring_p2_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/firstring_p2_test.sql");
const PASS = "FIRSTRING_P2_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const fn = (name: string, body: string) =>
  `update pg_catalog.pg_proc set prosrc = ${body} where proname = '${name}' and pronamespace = 'private'::regnamespace;`;

let failed = 0;
const db = await fresh();
const msg = await run(db);
const okMain = msg.startsWith(PASS);
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.number_releases")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["a resubscribe does not cancel the release", fn("number_release_sync", "replace(prosrc, $q$r.status in ('scheduled', 'held', 'failed')$q$, 'false')")],
  ["past due / paused counted as ended", fn("number_release_window", "replace(prosrc, $q$sv.reason not in ('canceled', 'trial_ended')$q$, $q$sv.reason not in ('canceled', 'trial_ended', 'past_due', 'paused')$q$)")],
  ["released inside the paid month (dates ignored)", fn("number_release_window", "replace(replace(prosrc, 'select * into sv from private.sub_service(sub, p_now);', $q$select 'message_only'::text service, case when sub.status = 'trialing' then 'trial_ended' else 'canceled' end reason into sv;$q$), 'ended_at <= p_now', 'true')")],
  ["30 days not kept", fn("number_release_sync", "replace(prosrc, 'w.ended_at + make_interval(days => days)', 'w.ended_at')")],
  ["the hourly sync overwrites a postponement", fn("number_release_sync", "replace(prosrc, $q$r.status = 'canceled' or$q$, $q$r.status in ('canceled', 'scheduled') or$q$)")],
  ["clients read number_releases", `drop policy number_releases_admin_select on public.number_releases;
    create policy number_releases_admin_select on public.number_releases for select to authenticated using (auth.uid() is not null);`],
  ["clients may postpone / release", `create or replace function public.admin_postpone_number_release(p_client uuid, p_days int default 14)
    returns jsonb language plpgsql security definer set search_path = '' as $f$ begin
      if p_days not between 1 and 180 then raise exception 'bad_days' using errcode = 'P0001'; end if;
      update public.number_releases set release_at = release_at + make_interval(days => p_days), postponed_count = postponed_count + 1,
        warned_at = null, warn_at = release_at + make_interval(days => p_days) - interval '7 days' where client_id = p_client;
      return '{}'::jsonb; end $f$;`],
  ["release now while subscribed", fn("number_release_window", "replace(prosrc, $q$if sub.id is null then return next; return; end if;$q$, $q$if sub.id is null then return next; return; end if; eligible := true; ended_at := p_now; reason := 'canceled'; return next; return;$q$)")],
  ["a released number blocks the next purchase", "drop trigger number_releases_after on public.number_releases;"],
  ["Spanish not tied to the plan", "drop trigger tenants_plan_spanish on public.tenants;"],
  ["the choice is not remembered", fn("tenant_plan_spanish", "replace(prosrc, $q$and not coalesce((new.config #> '{voice,spanish_off}') = 'true'::jsonb, false)$q$, '')")],
  ["Starter may switch Spanish on", `create or replace function private.tenant_has_spanish(p_tenant uuid) returns boolean language sql stable as $f$ select true $f$;`],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nFIRSTRING P2 OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
