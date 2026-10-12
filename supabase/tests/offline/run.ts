// Offline test runner for supabase/migrations + supabase/tests/rls_test.sql.
// Runs real Postgres (PGlite = Postgres compiled to WASM) in-process: no Docker, no Supabase project, no network
// after the first download of the npm package.
//   deno run -A supabase/tests/offline/run.ts
// Exit code 0 = all green.
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url); // supabase/
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const migrations = [...Deno.readDirSync(new URL("migrations/", root))]
  .filter((e) => e.isFile && e.name.endsWith(".sql")).map((e) => e.name).sort();

let failed = 0;
const ok = (label: string) => console.log(`✅ ${label}`);
const bad = (label: string, err?: unknown) => {
  failed++;
  console.log(`❌ ${label}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`);
};

// pg_cron / pg_net are not available in PGlite; the shim provides cron.schedule(). Only these lines are rewritten.
const offline = (sql: string) =>
  sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] extension $1 skipped");

const db = new PGlite();
await db.exec(read("tests/offline/supabase_shim.sql"));
ok("shim loaded (" + (await db.query<{ v: string }>("select version() v")).rows[0].v.split(" on ")[0] + ")");

for (const pass of [1, 2]) {
  for (const m of migrations) {
    try {
      await db.exec(offline(read("migrations/" + m)));
      ok(`pass ${pass}: ${m}`);
    } catch (e) {
      bad(`pass ${pass}: ${m}`, e);
    }
  }
}

// ---- catalog checks
const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;
const noRls = await q<{ t: string }>(`
  select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
noRls.length ? bad("RLS enabled on every public table", noRls.map((r) => r.t).join(", ")) : ok("RLS enabled on every public table");

const noPolicy = await q<{ t: string }>(`
  select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)`);
noPolicy.length ? bad("≥ 1 policy on every public table", noPolicy.map((r) => r.t).join(", ")) : ok("≥ 1 policy on every public table");

const openPolicies = await q<{ p: string }>(`
  select tablename || '.' || policyname p from pg_policies
  where schemaname in ('public', 'storage') and (roles @> array['authenticated']::name[] or roles @> array['public']::name[])
    and (btrim(coalesce(qual, '')) in ('true', '(true)') or btrim(coalesce(with_check, '')) in ('true', '(true)'))`);
openPolicies.length ? bad("no using(true)/with check(true) policy", openPolicies.map((r) => r.p).join(", ")) : ok("no using(true)/with check(true) policy");

const anonGrants = await q<{ g: string }>(`
  select table_schema || '.' || table_name || ':' || privilege_type g from information_schema.role_table_grants
  where grantee = 'anon' and table_schema in ('public', 'private')`);
anonGrants.length ? bad("anon has no table privileges", anonGrants.map((r) => r.g).join(", ")) : ok("anon has no table privileges in public/private");

const privGrants = await q<{ g: string }>(`
  select table_name || ':' || grantee || ':' || privilege_type g from information_schema.role_table_grants
  where table_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
privGrants.length ? bad("private.* not granted to API roles", privGrants.map((r) => r.g).join(", ")) : ok("private.* tables not granted to anon/authenticated");

const anonFns = await q<{ f: string }>(`
  select n.nspname || '.' || p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'ping'`);
anonFns.length ? bad("anon can execute only public.ping()", anonFns.map((r) => r.f).join(", ")) : ok("anon can execute only public.ping()");

const buckets = await q<{ id: string; public: boolean }>(`select id, public from storage.buckets order by id`);
const bset = buckets.map((b) => `${b.id}:${b.public ? "public" : "private"}`).join(",");
bset === "client-files:private,videos-public:public" ? ok(`buckets ${bset}`) : bad("buckets", bset);

const jobs = await q<{ jobname: string }>(`select jobname from cron.job order by jobname`);
jobs.length === 2 ? ok(`cron jobs: ${jobs.map((j) => j.jobname).join(", ")}`) : bad("cron jobs", JSON.stringify(jobs));

const law = await q<{ v: string }>(`select e.enumlabel v from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'niche'`);
const niches = law.map((r) => r.v).join(",");
// "dental" is retired (2026-10-12) and stays in the enum for historical rows only; dropping an enum value is unsafe
niches === "home_services,real_estate,dental" ? ok(`niche enum = ${niches}`) : bad("niche enum", niches);

// tests must never delete from storage.* (real Supabase: storage.protect_delete raises)
/delete\s+from\s+storage\./i.test(read("tests/rls_test.sql").replace(/--[^\n]*/g, ""))
  ? bad("rls_test.sql deletes from storage.* directly") : ok("rls_test.sql has no direct storage delete");
const del = await q<{ ok: boolean }>(`select exists (select 1 from pg_trigger where tgname = 'protect_objects_delete') ok`);
del[0].ok ? ok("storage.protect_delete emulated") : bad("storage.protect_delete not emulated");

// ---- RLS / guard test (ends with an exception on purpose; everything rolls back)
try {
  await db.exec(read("tests/rls_test.sql"));
  bad("rls_test.sql", "finished without the RLS_TESTS_PASSED marker");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  msg.startsWith("RLS_TESTS_PASSED") ? ok(`rls_test.sql → ${msg}`) : bad("rls_test.sql", msg);
}

// rollback really happened
const left = (await q<{ n: number }>(`select count(*)::int n from auth.users`))[0].n;
left === 0 ? ok("rls_test left no rows behind") : bad("rls_test left rows behind", String(left));

// ---- mutation self-test: break one protection at a time; rls_test.sql must then FAIL (proves it is not vacuous)
const mutations: [string, string][] = [
  ["client sees unsent quotes", `drop policy quotes_select on public.quotes;
     create policy quotes_select on public.quotes for select to authenticated using (user_id = (select auth.uid()));`],
  ["profiles guard removed", `drop trigger profiles_guard on public.profiles;`],
  ["anon can read leads", `grant select on public.leads to anon;
     create policy leak on public.leads for select to anon using (email is not null);`],
  ["storage path check removed", `drop policy client_files_insert on storage.objects;
     create policy client_files_insert on storage.objects for insert to authenticated with check (bucket_id = 'client-files');`],
  ["requests guard removed", `drop trigger requests_guard on public.requests;`],
  ["one-active-request index removed", `drop index public.requests_one_active;`],
  ["RLS off on calls", `alter table public.calls disable row level security;`],
  ["credentials readable by clients", `grant execute on function public.runtime_get_credential(uuid, text) to authenticated;
     create or replace function public.runtime_get_credential(p_tenant_id uuid, p_provider text) returns text
     language sql security definer set search_path = '' as $$ select 'leak'::text $$;`],
  ["retention keeps quote drafts", `create or replace function private.anonymize_client(p_client uuid) returns jsonb
     language plpgsql security definer set search_path = '' as $$ begin
       update public.clients set user_id = null, anonymized_at = now() where id = p_client; return '{}'::jsonb; end $$;`],
  ["tenant whitelist bypass", `grant update on public.tenants to authenticated;
     create policy t_upd on public.tenants for update to authenticated using ((select private.owns_tenant(id)));`],
  ["consent log deleted with the client's tenant", `alter table public.sms_consent add constraint sms_consent_tenant_fk
     foreign key (tenant_id) references public.tenants(id) on delete cascade;`],
];
if (!Deno.args.includes("--no-mutations")) {
  for (const [label, sql] of mutations) {
    const m = new PGlite();
    await m.exec(read("tests/offline/supabase_shim.sql"));
    for (const f of migrations) await m.exec(offline(read("migrations/" + f)));
    await m.exec(sql);
    try {
      await m.exec(read("tests/rls_test.sql"));
      bad(`mutation "${label}" not detected`, "no marker");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      msg.startsWith("RLS_TESTS_PASSED") ? bad(`mutation "${label}" not detected`) : ok(`mutation "${label}" caught → ${msg}`);
    }
    await m.close();
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nALL OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
