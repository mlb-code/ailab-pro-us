// Offline runner for supabase/tests/subscription_cancel_yearly_emails_test.sql (the customer's cancellation confirmation and
// yearly renewal reminder, 20261130100000_us_subscription_cancel_yearly_emails.sql): shim + all migrations in PGlite, the
// test, mutation self-tests (each breaks one rule; the test must fail), then an end-to-end pass: real cancellations in the
// database -> private.email_context -> the Deno templates (supabase/functions/_shared/email/templates.ts).
//   deno run -A --node-modules-dir=none supabase/tests/offline/subscription_cancel_yearly_emails_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { BRAND, PRICEBOOK } from "../../functions/_shared/config.ts";
import type { EmailBrand } from "../../functions/_shared/email/layout.ts";
import { type EmailCtx, TEMPLATES } from "../../functions/_shared/email/templates.ts";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/subscription_cancel_yearly_emails_test.sql");
const PASS = "CANCEL_YEARLY_EMAILS_TESTS_PASSED";

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
const sub = (from: string, to: string) => `replace(prosrc, $q$${from}$q$, $q$${to}$q$)`;
const srcOf = async (db: PGlite) =>
  (await db.query<{ s: string }>("select string_agg(prosrc, '' order by oid) s from pg_catalog.pg_proc where pronamespace = 'private'::regnamespace")).rows[0].s;

let failed = 0;
const check = (cond: boolean, what: string) => { console.log((cond ? "✅ " : "❌ ") + what); if (!cond) failed++; };
const db = await fresh();
const msg = await run(db);
check(msg.startsWith(PASS), msg);
const left = (await db.query<{ n: number }>("select count(*)::int n from private.email_outbox")).rows[0].n;
check(left === 0, left === 0 ? "test left no rows behind" : "rows left behind: " + left);

const MUTATIONS: Array<[string, string]> = [
  ["no scheduled confirmation", fn("subscriptions_emails", sub("perform private.enqueue_email_safe('subscription_canceled',\n          'subscription_canceled:' || new.id || ':scheduled:'",
    "perform private.enqueue_email_safe('trial_ending',\n          'subscription_canceled:' || new.id || ':scheduled:'"))],
  ["confirmation when canceled now not once", fn("subscriptions_emails", sub("'subscription_canceled:' || new.id || ':ended'", "'subscription_canceled:' || new.id || ':ended:' || clock_timestamp()"))],
  ["refund not confirmed", fn("subscriptions_emails", sub("if new.money_back_refund_id is not null and old.money_back_refund_id is null then", "if false then"))],
  ["refund confirmed on every write", fn("subscriptions_emails", sub("'subscription_canceled:' || new.id || ':refunded'", "'subscription_canceled:' || new.id || ':refunded:' || clock_timestamp()"))],
  ["undone cancel still confirmed", fn("email_context", sub("return jsonb_build_object('skip', 'cancel_undone')", "null"))],
  ["money-back end confirmed twice", fn("email_context", sub("return jsonb_build_object('skip', 'refund_mail')", "null"))],
  ["number release date ignored", fn("email_context", sub("coalesce(nr.release_at, v_base", "coalesce(null, v_base"))],
  ["release window not from the setting", fn("email_context", sub("coalesce(s.number_release_days, 30)", "7"))],
  ["yearly reminder after a cancel", fn("email_context", sub("return jsonb_build_object('skip', 'not_renewing')", "null"))],
  ["yearly reminder for plans that end", fn("enqueue_plan_yearly_reminders", sub("and not s.cancel_at_period_end and", "and"))],
  ["yearly reminder in the first year", fn("enqueue_plan_yearly_reminders", sub("if yrs >= 1 and", "if yrs >= 0 and"))],
  ["yearly reminder not once per year", fn("enqueue_plan_yearly_reminders", sub("':' || yrs, 'client'", "':' || yrs || clock_timestamp(), 'client'"))],
  ["yearly reminder for any status", fn("enqueue_plan_yearly_reminders", sub("where s.status = 'active' and", "where"))],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  const before = await srcOf(m);
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  if (before === await srcOf(m)) { failed++; console.log(`❌ mutation "${name}" did not change any function`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}

// ---------------------------------------------------------------- end to end: database context -> rendered mail
const e2e = await fresh();
await e2e.exec(`
  insert into auth.users (id, email) values ('33333333-3333-4333-8333-333333333333', 'paid@example.com'),
    ('44444444-4444-4444-8444-444444444444', 'trial@example.com');
  update public.profiles set company = 'Bee Plumbing', full_name = 'Bo Bee', phone = '+13125550171'
   where id = '33333333-3333-4333-8333-333333333333';
  update public.profiles set company = 'Cool Breeze HVAC', full_name = 'Dana Cool', phone = '(713) 555-0170'
   where id = '44444444-4444-4444-8444-444444444444';
  select public.billing_upsert_subscription('paddle', 'sub_e2e_paid_0002', 'active', 'FR_STARTER', '33333333-3333-4333-8333-333333333333',
    'ctm_e2e_3', null, '2026-11-26T15:00:00Z', '2026-12-26T15:00:00Z', false, true, null, null, now(), null);
  update public.tenants set twilio_number = '+13125550199'
   where client_id = (select client_id from public.subscriptions where provider_subscription_id = 'sub_e2e_paid_0002');
  select public.billing_upsert_subscription('paddle', 'sub_e2e_paid_0002', 'active', 'FR_STARTER', null,
    null, null, null, null, true, null, null, null, now(), null);
  select public.billing_upsert_subscription('paddle', 'sub_e2e_trial_0002', 'trialing', 'FR_PRO', '44444444-4444-4444-8444-444444444444',
    'ctm_e2e_4', '2026-12-10T15:00:00Z', null, null, false, true, null, null, now(), null);
  select public.billing_upsert_subscription('paddle', 'sub_e2e_trial_0002', 'canceled', 'FR_PRO', null,
    null, null, null, null, false, null, null, now(), now() + interval '1 second', null);
`);
type Row = { template: string; audience: string; payload: Record<string, unknown>; ctx: EmailCtx };
const rows = (await e2e.query<Row>(`select template, audience, payload, private.email_context(id) ctx from private.email_outbox
  where template = 'subscription_canceled' order by id`)).rows;
check(rows.length === 2 && rows.every((r) => !("skip" in r.ctx) && r.audience === "client"),
  "e2e: a scheduled paid cancel + a trial cancel queue 2 confirmations: " + JSON.stringify(rows.map((r) => r.ctx.skip ?? r.payload.kind)));
const B = BRAND as EmailBrand;
const now = new Date("2026-11-27T16:00:00Z");
const render = (r: Row) => TEMPLATES[r.template].render(r.ctx, { brand: B, now, payload: r.payload });
const product = (PRICEBOOK as unknown as { plans: Array<{ code: string; product: string }> }).plans.find((p) => p.code === "FR_STARTER")!.product;
const [paid, trial] = rows.map(render);
check(paid.subject === `Your ${product} plan is canceled: it works until December 26, 2026, and you will not be charged again.` &&
  paid.text.includes("Reserved for you until: January 25, 2027") && paid.text.includes("+1 (312) 555-0199") && paid.text.includes("Hi Bo,") &&
  rows[0].ctx.to === "paid@example.com", "e2e: paid cancel confirmation (subject per the review, number kept 30 days after the period end)");
check(trial.subject === `Your ${product} plan is canceled: your free trial has ended, and you will not be charged.` &&
  trial.text.includes("the trial ended right away") && rows[1].ctx.to === "trial@example.com", "e2e: trial cancel confirmation");
check(!/\{\{|undefined|NaN/.test(paid.text + trial.text), "e2e: no leftovers");

console.log(failed ? `\n${failed} FAILED` : "\nCANCEL + YEARLY EMAILS OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
