// Offline runner for supabase/tests/setup_agent_test.sql (20261201100000_us_setup_agent.sql): shim + all migrations in
// PGlite, the setup-agent migration applied a SECOND time (idempotency), the test, a preview-vs-trigger parity check on the
// onboarding parity cases, then mutation self-tests (each breaks one guard; the test must fail).
//   deno run -A --node-modules-dir=none supabase/tests/offline/setup_agent_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const MIGRATION = "20261201100000_us_setup_agent.sql";
const test = read("tests/setup_agent_test.sql");
const PASS = "SETUP_AGENT_TESTS_PASSED";

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("tests/offline/supabase_shim.sql"));
  for (const m of migrations) await db.exec(offline(read("migrations/" + m)));
  return db;
}
async function run(db: PGlite): Promise<string> {
  try { await db.exec(test); return "did not raise"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const patch = (schema: string, fn: string, from: string, to: string) =>
  `do $p$ begin
     if not exists (select 1 from pg_catalog.pg_proc where proname = '${fn}' and pronamespace = '${schema}'::regnamespace
                     and strpos(prosrc, $q$${from}$q$) > 0) then raise exception 'mutation target not found in ${schema}.${fn}'; end if;
   end $p$;
   update pg_catalog.pg_proc set prosrc = replace(prosrc, $q$${from}$q$, $q$${to}$q$) where proname = '${fn}' and pronamespace = '${schema}'::regnamespace;`;

let failed = 0;
const ok = (m: string) => console.log("✅ " + m);
const bad = (m: string) => { failed++; console.log("❌ " + m); };

const db = await fresh();
try { await db.exec(offline(read("migrations/" + MIGRATION))); ok("second application of the migration is a no-op"); }
catch (e) { bad("second application failed: " + (e instanceof Error ? e.message : e)); }
const msg = await run(db);
msg.startsWith(PASS) ? ok(msg) : bad(msg);
const left = (await db.query<{ n: number }>("select count(*)::int n from public.setup_conversations")).rows[0].n
  + (await db.query<{ n: number }>("select count(*)::int n from public.clients")).rows[0].n;
left === 0 ? ok("test left no rows behind") : bad("rows left behind: " + left);
const cols = (await db.query<{ n: number }>(`select count(*)::int n from information_schema.columns where table_schema = 'private'
  and table_name = 'settings' and column_name in ('setup_agent_enabled', 'setup_agent_daily_budget_usd', 'setup_agent_paused_until')`)).rows[0].n;
cols === 3 ? ok("private.settings switches present") : bad("private.settings switches: " + cols);

// ---- preview == the trigger's expression on the onboarding parity cases (same result or the same error code)
{
  const CASES: Array<[string, unknown]> = [
    ["hours", { timezone: "America/New_York", hours: { mon: ["07:00", "18:00"], sat: null }, after_hours: { mode: "message_only" } }],
    ["hours", { hours: { mon: ["18:00", "07:00"] } }], ["hours", { hours: { funday: ["08:00", "09:00"] } }], ["hours", { hours: { mon: null } }],
    ["hours", { timezone: "Mars/Olympus" }], ["hours", { after_hours: { mode: "sleep" } }],
    ["faq", { services: ["AC repair", " Furnace "], faq: [{ q: "Trane?", a: "Yes." }], service_area: "77005, 77006; Bellaire, harris county",
      price_on_phone: "fixed", fixed_prices: ["Service call: $89", "Drain cleaning - 150", "call us"] }],
    ["faq", { price_on_phone: "no" }], ["faq", { services: [] }], ["faq", { faq: [{ q: "Q", a: "y".repeat(601) }] }],
    ["alerts", { notify: { sms: ["+17135550111"], email: ["x@example.com"], daily_summary: null }, on_call_number: "+17135550188",
      emergency: { keywords: [" gas smell ", "flooding"] } }],
    ["alerts", { notify: { sms: [], email: [] } }], ["alerts", { notify: { sms: ["+447700900123"] } }], ["alerts", { on_call_number: null }],
    ["calendar", { booking_mode: "messages_only" }], ["calendar", { provider: "outlook" }],
    ["calendar", { provider: "calendly", booking_link: "https://calendly.com/coolbreeze/visit" }], ["calendar", { booking_link: "http://calendly.com/x" }],
    ["tools", { zapier_webhook_url: "https://hooks.zapier.com/hooks/catch/1/abc/" }], ["tools", { zapier_webhook_url: "http://x" }],
    ["forward_calls", { business_phone: "+17135550199" }], ["forward_calls", { business_phone: "713" }],
  ];
  const p = await fresh();
  const uid = crypto.randomUUID();
  await p.exec(`insert into auth.users (id, email) values ('${uid}', 'par@example.com');
    update public.profiles set company = 'Parity HVAC', phone = '(713) 555-0142' where id = '${uid}';
    update private.settings set billing_mock_enabled = true where id = 1;
    set role authenticated; select set_config('request.jwt.claims', '{"sub": "${uid}", "role": "authenticated"}', false);
    select public.billing_mock_checkout('FR_PRO', 14); reset role; select set_config('request.jwt.claims', '', false);`);
  const items = (await p.query<{ id: string; key: string }>(`select o.id, o.key from public.onboarding_items o join public.clients c on c.id = o.client_id
    where c.user_id = '${uid}'`)).rows;
  let diff = 0;
  for (const [key, data] of CASES) {
    const it = items.find((i) => i.key === key)!;
    const one = async (sql: string, asUser: boolean) => {
      try {
        if (asUser) await p.exec(`set role authenticated; select set_config('request.jwt.claims', '{"sub": "${uid}", "role": "authenticated"}', false);`);
        const r = await p.query<{ c: unknown }>(sql, [it.id, JSON.stringify(data)]);
        return JSON.stringify(r.rows[0].c);
      } catch (e) { return "ERR " + (e instanceof Error ? e.message : String(e)); }
      finally { await p.exec("reset role; select set_config('request.jwt.claims', '', false);"); }
    };
    const pv = await one("select public.setup_preview_step($1::uuid, $2::jsonb) c", true);
    const tr = await one(`select private.onboarding_patch(o.key, o.data || $2::jsonb, t.config) c from public.onboarding_items o
      join public.tenants t on t.client_id = o.client_id where o.id = $1::uuid`, false);
    if (pv !== tr) { diff++; console.log(`   ${key} ${JSON.stringify(data).slice(0, 60)}\n     preview: ${pv.slice(0, 160)}\n     trigger: ${tr.slice(0, 160)}`); }
  }
  diff ? bad(`preview differs from the trigger on ${diff} of ${CASES.length} cases`) : ok(`preview == trigger on ${CASES.length} parity cases`);
  await p.close();
}

const MUTATIONS: Array<[string, string]> = [
  ["service RPC granted to clients", "grant execute on function public.setup_agent_begin_turn(uuid, uuid, text, text, text, jsonb, boolean) to authenticated;"],
  ["kill switch ignored", patch("public", "setup_agent_begin_turn", "if not coalesce((sw ->> 'enabled')::boolean, false) then", "if false then")],
  ["no turn lock", patch("public", "setup_agent_begin_turn", "if cv.lock_until is not null and cv.lock_until > now() then return jsonb_build_object('error', 'turn_in_progress'); end if;", "")],
  ["no idempotency", patch("public", "setup_agent_begin_turn", "if found then", "if false then")],
  ["minute limit off", patch("public", "setup_agent_begin_turn", "n_min >= 12", "n_min >= 1200")],
  ["budget ignored", patch("public", "setup_agent_begin_turn", "(sw ->> 'spent_today_usd')::numeric >= (sw ->> 'budget_usd')::numeric", "false")],
  ["confirm before the card", patch("public", "setup_agent_decide", "pr.shown_seq >= p_seq", "false")],
  ["decide in any conversation", patch("public", "setup_agent_decide", "p.id = p_proposal and p.conversation_id = cv.id", "p.id = p_proposal")],
  ["finish without the lock token", patch("private", "setup_agent_held", "cv.lock_token is distinct from p_lock", "false")],
  ["another user's conversation", patch("private", "setup_agent_conv", "cv.user_id is distinct from p_user", "false") +
    patch("private", "setup_agent_conv", "cl.user_id is distinct from p_user or ", "")],
  ["clients may write messages", `grant insert on public.setup_messages to authenticated;
     create policy forge on public.setup_messages for insert to authenticated with check (conversation_id is not null);`],
  ["proposals readable by everyone", `drop policy setup_proposals_select on public.setup_proposals;
     create policy setup_proposals_select on public.setup_proposals for select to authenticated using (client_id is not null);`],
  ["preview skips ownership", patch("public", "setup_preview_step", "not (private.owns_client(it.client_id) or private.is_admin())", "false")],
  ["preview for quote clients", patch("public", "setup_preview_step", "cl.billing_mode is distinct from 'subscription'", "false")],
  ["alert e-mail every time", patch("public", "setup_agent_alert", "to_char(now() at time zone 'utc', 'YYYYMMDD')", "gen_random_uuid()::text")],
  ["retention too early", patch("private", "setup_retention", "interval '90 days'", "interval '88 days'")],
  ["anonymised client keeps its transcript", "drop trigger setup_agent_client_anonymized on public.clients;"],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); await m.close(); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
  await m.close();
}
console.log(failed ? `\n${failed} FAILED` : "\nSETUP AGENT OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
