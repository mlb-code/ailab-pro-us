// Offline runner for supabase/tests/subscriptions_test.sql (FirstRing subscriptions, 20261125100000_us_subscriptions.sql):
// shim + all migrations in PGlite, the test, then mutation self-tests (each breaks one protection; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/subscriptions_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/subscriptions_test.sql");

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
const okMain = msg.startsWith("SUBSCRIPTIONS_TESTS_PASSED");
console.log((okMain ? "✅ " : "❌ ") + msg);
if (!okMain) failed++;
const left = (await db.query<{ n: number }>("select count(*)::int n from public.subscriptions")).rows[0].n;
left === 0 ? console.log("✅ test left no rows behind") : (failed++, console.log("❌ rows left behind: " + left));

const MUTATIONS: Array<[string, string]> = [
  ["clients read every subscription", `drop policy subscriptions_select on public.subscriptions;
    create policy subscriptions_select on public.subscriptions for select to authenticated using (auth.uid() is not null);`],
  ["webhook contract callable by clients", `create or replace function public.billing_upsert_subscription(
    p_provider text, p_provider_subscription_id text, p_status text, p_plan_code text, p_user_id uuid default null,
    p_provider_customer_id text default null, p_trial_ends_at timestamptz default null, p_current_period_start timestamptz default null,
    p_current_period_end timestamptz default null, p_cancel_at_period_end boolean default null, p_card_on_file boolean default null,
    p_scheduled_plan_code text default null, p_canceled_at timestamptz default null, p_event_at timestamptz default null,
    p_business_phone text default null) returns jsonb language plpgsql security definer set search_path = '' as $f$
    begin return private.upsert_subscription_core(p_provider, p_provider_subscription_id, p_status, p_plan_code, p_user_id,
      p_provider_customer_id, p_trial_ends_at, p_current_period_start, p_current_period_end, p_cancel_at_period_end, p_card_on_file,
      p_scheduled_plan_code, p_canceled_at, p_event_at, p_business_phone); end $f$;
    grant execute on function public.billing_upsert_subscription(text, text, text, text, uuid, text, timestamptz, timestamptz,
      timestamptz, boolean, boolean, text, timestamptz, timestamptz, text) to authenticated;`],
  ["one trial per phone not enforced", `create or replace function public.billing_trial_eligible(p_business_phone text default null)
    returns jsonb language sql stable as $f$ select '{"eligible": true, "reason": ""}'::jsonb $f$;`],
  ["checklist saves not merged / calendar gate gone", `drop trigger onboarding_apply on public.onboarding_items;`],
  ["forwarding test accepts any call", `create or replace function private.calls_forwarding_test() returns trigger
    language plpgsql security definer set search_path = '' as $f$ begin
      update public.onboarding_items o set status = 'done' from public.tenants t
       where t.id = new.tenant_id and o.client_id = t.client_id and o.key = 'forward_calls' and (o.data ->> 'test_started_at') is not null;
      return new; end $f$;`],
  ["go-live without the simulator check", `create or replace function private.onboarding_autogolive() returns trigger
    language plpgsql security definer set search_path = '' as $f$ begin
      update public.clients c set status = 'live' where c.id = new.client_id and c.billing_mode = 'subscription'
        and not exists (select 1 from public.onboarding_items o where o.client_id = new.client_id and o.key not in ('tools', 'sms') and o.status <> 'done');
      return null; end $f$;`],
  ["stale webhook events applied", `create or replace function private.upsert_subscription_core_guard() returns void language sql as $f$ select $f$;
    update pg_catalog.pg_proc set prosrc = replace(prosrc, 'p_event_at < sub.last_event_at', 'false') where proname = 'upsert_subscription_core';`],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith("SUBSCRIPTIONS_TESTS_PASSED")) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nSUBSCRIPTIONS OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
