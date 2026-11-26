// Offline runner for supabase/tests/subscription_emails_test.sql (sign-up / cancellation e-mails,
// 20261128100000_us_subscription_emails.sql): shim + all migrations in PGlite, the test, mutation self-tests (each breaks one
// rule; the test must fail), then an end-to-end pass: real sign-ups in the database -> private.email_context -> the Deno
// templates (supabase/functions/_shared/email/templates.ts), so the rendered mails are checked on database data.
//   deno run -A --node-modules-dir=none supabase/tests/offline/subscription_emails_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { BRAND, PRICEBOOK } from "../../functions/_shared/config.ts";
import type { EmailBrand } from "../../functions/_shared/email/layout.ts";
import { type EmailCtx, TEMPLATES } from "../../functions/_shared/email/templates.ts";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const migrations = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
const test = read("tests/subscription_emails_test.sql");
const PASS = "SUBSCRIPTION_EMAILS_TESTS_PASSED";

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
const check = (cond: boolean, what: string) => { console.log((cond ? "✅ " : "❌ ") + what); if (!cond) failed++; };
const db = await fresh();
const msg = await run(db);
check(msg.startsWith(PASS), msg);
const left = (await db.query<{ n: number }>("select count(*)::int n from private.email_outbox")).rows[0].n;
check(left === 0, left === 0 ? "test left no rows behind" : "rows left behind: " + left);

const MUTATIONS: Array<[string, string]> = [
  ["no trigger", "drop trigger subscriptions_emails on public.subscriptions;"],
  ["welcome on every write (not only a new row)", fn("subscriptions_emails", "replace(prosrc, $q$if tg_op = 'INSERT' then$q$, $q$if true then$q$)")],
  ["no admin alert", fn("subscriptions_emails", "replace(prosrc, $q$perform private.enqueue_email_safe('admin_new_subscription'$q$, $q$perform private.enqueue_email_safe('trial_ending'$q$)")],
  ["second alert at the end of a scheduled cancel", fn("subscriptions_emails", "replace(prosrc, $q$and not old.cancel_at_period_end then$q$, $q$then$q$)")],
  ["scheduled cancel not announced", fn("subscriptions_emails", "replace(prosrc, $q$new.cancel_at_period_end and not old.cancel_at_period_end and$q$, $q$false and$q$)")],
  ["returning customer welcomed again", fn("email_context", "replace(prosrc, $q$if older then return$q$, $q$if false then return$q$)")],
  ["duplicate trial welcomed", fn("email_context", "replace(prosrc, $q$if sub.trial_duplicate then return$q$, $q$if false then return$q$)")],
  ["stale trial mail still sent", fn("email_context", "replace(prosrc, $q$o.template = 'trial_welcome' and sub.status <> 'trialing'$q$, $q$false$q$)")],
  ["business phone in the client mail", fn("email_context", "replace(prosrc, $q$and o.audience = 'admin' then$q$, $q$then$q$)")],
  ["the client's latest row instead of the queued one", fn("email_context", "replace(prosrc, $q$x.id = v_sid::uuid and x.client_id = cl.id$q$, $q$x.id = (private.client_sub(cl.id)).id$q$)")],
];
for (const [name, sql] of MUTATIONS) {
  const m = await fresh();
  try { await m.exec(sql); } catch (e) { failed++; console.log(`❌ mutation "${name}" could not be applied: ${e}`); continue; }
  const out = await run(m);
  if (out.startsWith(PASS)) { failed++; console.log(`❌ mutation "${name}" NOT caught`); }
  else console.log(`✅ mutation "${name}" caught → ${out.slice(0, 110)}`);
}

// ---------------------------------------------------------------- end to end: database context -> rendered mail
const e2e = await fresh();
await e2e.exec(`
  insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'trial@example.com'),
    ('22222222-2222-4222-8222-222222222222', 'paid@example.com');
  update public.profiles set company = 'Cool Breeze HVAC', full_name = 'Dana Cool', phone = '(713) 555-0170'
   where id = '11111111-1111-4111-8111-111111111111';
  update public.profiles set company = 'Bee Plumbing', full_name = 'Bo Bee', phone = '+13125550171'
   where id = '22222222-2222-4222-8222-222222222222';
  select public.billing_upsert_subscription('paddle', 'sub_e2e_trial_0001', 'trialing', 'FR_PRO', '11111111-1111-4111-8111-111111111111',
    'ctm_e2e_1', '2026-12-10T15:00:00Z', null, null, false, true, null, null, now(), null);
  select public.billing_upsert_subscription('paddle', 'sub_e2e_paid_0001', 'active', 'FR_STARTER', '22222222-2222-4222-8222-222222222222',
    'ctm_e2e_2', null, '2026-11-26T15:00:00Z', '2026-12-26T15:00:00Z', false, true, null, null, now(), null);
  select public.billing_upsert_subscription('paddle', 'sub_e2e_paid_0001', 'active', 'FR_STARTER', null,
    null, null, null, null, true, null, null, null, now(), null);
`);
type Row = { template: string; audience: string; idem_key: string; payload: Record<string, unknown>; ctx: EmailCtx };
const rows = (await e2e.query<Row>(`select template, audience, idem_key, payload, private.email_context(id) ctx from private.email_outbox
  where template in ('trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled') order by id`)).rows;
check(rows.map((r) => r.template).join() === "trial_welcome,admin_new_subscription,plan_welcome,admin_new_subscription,admin_subscription_canceled",
  "e2e: Paddle trial + paid sign-up + scheduled cancel queue 5 mails in order: " + rows.map((r) => r.template).join());
const B = BRAND as EmailBrand;
const SITE = B.site_url.replace(/\/$/, "");
const now = new Date("2026-11-26T16:00:00Z");
const render = (r: Row) => TEMPLATES[r.template].render(r.ctx, { brand: B, now, payload: r.payload });
const plan = (code: string) => (PRICEBOOK as unknown as { plans: Array<{ code: string; name: string; product: string; monthly_cents: number; trial_minutes: number;
  included_usage: { voice_minutes: number } }> }).plans.find((p) => p.code === code)!;
const pro = plan("FR_PRO"), starter = plan("FR_STARTER");
const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US");
for (const r of rows) check(!("skip" in r.ctx) && TEMPLATES[r.template].audience === r.audience, `e2e: ${r.template} audience ${r.audience}, not skipped`);
const [t, at, p, ap, ac] = rows.map(render);
check(t.subject === `Your free trial of ${pro.product} ${pro.name} has started` && t.text.includes("December 10, 2026") &&
  t.text.includes(`Up to ${pro.trial_minutes} minutes of calls`) && t.text.includes(`${usd(pro.monthly_cents)} on December 10, 2026, unless you cancel`) &&
  t.text.includes("finish the setup checklist") && t.text.includes("goes live on its own") && t.text.includes("Cancel anytime in your portal (Billing) before December 10, 2026") &&
  t.html.includes(`href="${SITE}/start/#onboarding"`) && t.text.includes("Paddle") && t.text.includes("Hi Dana,"),
  "e2e: trial_welcome rendered from the database row (plan, trial end, minutes, first charge, next step, portal link)");
check(rows[0].ctx.to === "trial@example.com" && rows[1].ctx.to === "laviemb@gmail.com", "e2e: recipients = the customer / Meir (settings.admin_email)");
check(!/SMS|text message|guarantee|results/i.test(t.text + p.text), "e2e: no SMS claims or promised results in the client mails");
check(p.subject === `Your ${starter.product} ${starter.name} plan has started` && p.text.includes(`${usd(starter.monthly_cents)}/mo`) &&
  p.text.includes("December 26, 2026") && p.text.includes(`${starter.included_usage.voice_minutes} minutes of calls a month`) &&
  p.text.includes((PRICEBOOK.rules as unknown as { subscription: { texts: { cancel: string } } }).subscription.texts.cancel),
  "e2e: plan_welcome rendered (monthly, minutes, next charge, the price-book cancel sentence)");
check(at.subject === `🎉 מנוי חדש: Cool Breeze HVAC · ${pro.name} · ניסיון חינם` && at.text.includes("+1 (713) 555-0170") && at.text.includes("trial@example.com") &&
  at.html.includes(`href="${SITE}/start/admin/#subscriptions"`) && at.html.includes('dir="rtl"'), "e2e: admin_new_subscription (Hebrew, trial, phone, e-mail, admin link)");
check(ap.subject === `🎉 מנוי חדש: Bee Plumbing · ${starter.name} · בתשלום` && ap.text.includes("+1 (312) 555-0171"), "e2e: admin_new_subscription (paid)");
check(ac.subject.startsWith(`ביטול מנוי: Bee Plumbing · ${starter.name} (פעיל עד `) && ac.text.includes("מנוי בתשלום"), "e2e: admin_subscription_canceled (scheduled, paid)");

console.log(failed ? `\n${failed} FAILED` : "\nSUBSCRIPTION EMAILS OFFLINE CHECKS PASSED");
Deno.exit(failed ? 1 : 0);
