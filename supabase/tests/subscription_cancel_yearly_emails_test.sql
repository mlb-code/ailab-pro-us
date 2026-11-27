-- Cancellation confirmation + yearly renewal reminder to the customer (20261130100000_us_subscription_cancel_yearly_emails.sql,
-- legal review 2026-11-27 subscription items 2 and 10): queued once per event (template, audience, idem key, payload), the
-- send-time context (own row, own address, number reserved until, refund) and the skips (cancel undone, ended through the
-- money-back, plan no longer renewing); the yearly scan once per subscription year, only for active renewing plans.
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with CANCEL_YEARLY_EMAILS_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/subscription_cancel_yearly_emails_run.ts
do $$
declare
  ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ud uuid := gen_random_uuid(); ue uuid := gen_random_uuid();
  r jsonb; v jsonb; cb uuid; cc uuid; cd uuid; ce uuid; sb uuid; sc uuid; sd uuid; se uuid; o private.email_outbox;
  n int; c int := 0; s text; pe timestamptz;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ub, 'cy-b@example.com'), (uc, 'cy-c@example.com'), (ud, 'cy-d@example.com'),
    (ue, 'cy-e@example.com');
  update public.profiles set company = 'Bee Plumbing', phone = '+13125550181' where id = ub;
  update public.profiles set company = 'Cee Electric', phone = '+12145550182' where id = uc;
  update public.profiles set company = 'Dee Roofing', phone = '+12145550183' where id = ud;
  update public.profiles set company = 'Eee HVAC', phone = '+12145550184' where id = ue;
  update private.settings set billing_mock_enabled = true, admin_email = 'meir-test@example.com', number_release_days = 30 where id = 1;

  -- ================================================================ 1. paid plan canceled at the period end
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 0);
  cb := (r ->> 'client_id')::uuid; sb := (r ->> 'subscription_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.tenants set twilio_number = '+13125550191' where client_id = cb;
  if exists (select 1 from private.email_outbox where entity_id = cb and template = 'subscription_canceled') then
    raise exception 'FAIL a sign-up queued a cancellation mail'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cb and template = 'subscription_canceled';
  select * into o from private.email_outbox where entity_id = cb and template = 'subscription_canceled';
  if n <> 1 or o.audience is distinct from 'client' or o.user_id is distinct from ub
     or o.idem_key is distinct from 'subscription_canceled:' || sb || ':scheduled:' || to_char(now(), 'YYYYMMDD')
     or o.payload ->> 'kind' is distinct from 'scheduled' or o.payload ->> 'from' is distinct from 'active'
     or o.payload ->> 'subscription_id' is distinct from sb::text then
    raise exception 'FAIL scheduled cancel confirmation (% rows) %', n, to_jsonb(o); end if; c := c + 1;
  -- Meir's alert is still queued next to it
  if not exists (select 1 from private.email_outbox where entity_id = cb and template = 'admin_subscription_canceled') then
    raise exception 'FAIL admin alert lost'; end if; c := c + 1;
  v := private.email_context(o.id);
  select current_period_end into pe from public.subscriptions where id = sb;
  if v ? 'skip' or v ->> 'to' is distinct from 'cy-b@example.com' or v #>> '{subscription,id}' is distinct from sb::text
     or (v #>> '{subscription,cancel_at_period_end}')::boolean is not true or v ->> 'tenant_number' is distinct from '+13125550191'
     or (v #>> '{subscription,number_kept_until}')::timestamptz is distinct from pe + interval '30 days'
     or (v #>> '{subscription,refunded}')::boolean is not false or (v -> 'subscription') ? 'business_phone' then
    raise exception 'FAIL scheduled cancel context %', v; end if; c := c + 1;
  -- the client resumes before the mail went out: nothing to confirm any more
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform public.billing_resume();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if private.email_context(o.id) ->> 'skip' is distinct from 'cancel_undone' then
    raise exception 'FAIL undone cancel still confirmed: %', private.email_context(o.id); end if; c := c + 1;
  -- canceled again, then the period ends: the end is not a second confirmation
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.billing_upsert_subscription('mock', (select provider_subscription_id from public.subscriptions where id = sb), 'canceled', 'FR_STARTER',
    null, null, null, null, null, false, null, null, now());
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cb and template = 'subscription_canceled';
  if n <> 1 then raise exception 'FAIL re-cancel the same day / the end of a scheduled cancel queued more (% rows)', n; end if; c := c + 1;

  -- ================================================================ 2. canceled during the trial: ends now
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 14);
  cc := (r ->> 'client_id')::uuid; sc := (r ->> 'subscription_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.tenants set twilio_number = '+12145550192' where client_id = cc;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cc and template = 'subscription_canceled';
  select * into o from private.email_outbox where entity_id = cc and template = 'subscription_canceled';
  if n <> 1 or o.idem_key is distinct from 'subscription_canceled:' || sc || ':ended' or o.payload ->> 'kind' is distinct from 'ended'
     or o.payload ->> 'from' is distinct from 'trialing' then
    raise exception 'FAIL trial cancel confirmation (% rows) %', n, to_jsonb(o); end if; c := c + 1;
  v := private.email_context(o.id);
  if v ? 'skip' or v #>> '{subscription,status}' is distinct from 'canceled' or (v #>> '{subscription,canceled_at}') is null
     or (v #>> '{subscription,number_kept_until}')::timestamptz is distinct from
        (select coalesce(ends_at, canceled_at) from public.subscriptions where id = sc) + interval '30 days' then
    raise exception 'FAIL trial cancel context %', v; end if; c := c + 1;
  -- a scheduled number release wins over the computed date (Meir postponed it)
  insert into public.number_releases (tenant_id, client_id, subscription_id, number, reason, service_ended_at, warn_at, release_at)
  select t.id, cc, sc, t.twilio_number, 'canceled', now(), now() + interval '50 days', now() + interval '57 days'
    from public.tenants t where t.client_id = cc
  on conflict (tenant_id) do update set status = 'scheduled', warn_at = excluded.warn_at, release_at = excluded.release_at;
  if (private.email_context(o.id) #>> '{subscription,number_kept_until}')::timestamptz is distinct from now() + interval '57 days' then
    raise exception 'FAIL number_kept_until ignores the scheduled release: %', private.email_context(o.id) -> 'subscription'; end if; c := c + 1;

  -- ================================================================ 3. 30-day money-back: one 'refunded' confirmation, no 'ended' one
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.billing_upsert_subscription('paddle', 'sub_cy_moneyback_01', 'active', 'FR_PRO', ud, 'ctm_cy', null,
    now() - interval '5 days', now() + interval '25 days', false, true, null, null, now(), '+12145550183');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  cd := (r ->> 'client_id')::uuid; sd := (r ->> 'subscription_id')::uuid;
  insert into private.paddle_transactions (transaction_id, provider_subscription_id, client_id, status, total_cents, currency, billed_at)
  values ('txn_cy_first_01', 'sub_cy_moneyback_01', cd, 'completed', 26893, 'USD', now() - interval '5 days');
  update public.subscriptions set first_paid_at = now() - interval '5 days', first_paid_transaction_id = 'txn_cy_first_01' where id = sd;
  update public.subscriptions set money_back_used_at = now(), money_back_refund_id = 'adj_cy_01' where id = sd;   -- billing_paddle_money_back_done
  update public.subscriptions set money_back_refund_id = 'adj_cy_01' where id = sd;                               -- a replay: nothing new
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.billing_upsert_subscription('paddle', 'sub_cy_moneyback_01', 'canceled', 'FR_PRO', null, null, null, null, null, false,
    null, null, now(), now() + interval '1 second');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select string_agg(idem_key, ',' order by idem_key) into s from private.email_outbox where entity_id = cd and template = 'subscription_canceled';
  if s is distinct from 'subscription_canceled:' || sd || ':ended,subscription_canceled:' || sd || ':refunded' then
    raise exception 'FAIL money-back mails queued: %', s; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'subscription_canceled:' || sd || ':refunded';
  if v ? 'skip' or (v #>> '{subscription,refunded}')::boolean is not true or (v #>> '{subscription,refund_cents}')::int is distinct from 26893
     or v ->> 'to' is distinct from 'cy-d@example.com' then
    raise exception 'FAIL refunded context %', v; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'subscription_canceled:' || sd || ':ended';
  if v ->> 'skip' is distinct from 'refund_mail' then raise exception 'FAIL money-back end also confirmed as a plain cancel: %', v; end if; c := c + 1;

  -- ================================================================ 4. yearly renewal reminder
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ue, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 0);
  ce := (r ->> 'client_id')::uuid; se := (r ->> 'subscription_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if private.enqueue_plan_yearly_reminders(now() + interval '11 months') <> 0 then raise exception 'FAIL reminder before a year'; end if; c := c + 1;
  n := private.enqueue_plan_yearly_reminders(now() + interval '1 year 2 days');
  if n <> 1 or private.enqueue_plan_yearly_reminders(now() + interval '1 year 3 days') <> 0 then
    raise exception 'FAIL year 1 queued % times (then again?)', n; end if; c := c + 1;
  select * into o from private.email_outbox where template = 'plan_yearly_reminder' and entity_id = ce;
  if o.idem_key is distinct from 'plan_yearly_reminder:' || se || ':1' or o.audience is distinct from 'client' or o.user_id is distinct from ue
     or (o.payload ->> 'year')::int is distinct from 1 or o.payload ->> 'subscription_id' is distinct from se::text then
    raise exception 'FAIL yearly reminder row %', to_jsonb(o); end if; c := c + 1;
  v := private.email_context(o.id);
  if v ? 'skip' or v ->> 'to' is distinct from 'cy-e@example.com' or v #>> '{subscription,plan_code}' is distinct from 'FR_PRO'
     or (v #>> '{subscription,current_period_end}') is null then raise exception 'FAIL yearly reminder context %', v; end if; c := c + 1;
  n := private.enqueue_plan_yearly_reminders(now() + interval '2 years 1 day');
  if n <> 1 or not exists (select 1 from private.email_outbox where idem_key = 'plan_yearly_reminder:' || se || ':2') then
    raise exception 'FAIL year 2 reminder (%)', n; end if; c := c + 1;
  -- only active plans that renew: the trial (C, canceled), the money-back plan (D, canceled) and a canceled-at-period-end plan get none
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ue, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if private.enqueue_plan_yearly_reminders(now() + interval '3 years 1 day') <> 0 then raise exception 'FAIL reminder for a plan that ends'; end if; c := c + 1;
  if private.email_context(o.id) ->> 'skip' is distinct from 'not_renewing' then
    raise exception 'FAIL queued reminder still sent after the cancel: %', private.email_context(o.id); end if; c := c + 1;
  select count(*) into n from private.email_outbox where template = 'plan_yearly_reminder' and entity_id in (cb, cc, cd);
  if n <> 0 then raise exception 'FAIL reminders for ended plans: %', n; end if; c := c + 1;
  if not exists (select 1 from cron.job where jobname = 'ailab-us-plan-yearly-reminder' and command like '%enqueue_plan_yearly_reminders%') then
    raise exception 'FAIL cron job missing'; end if; c := c + 1;

  -- ================================================================ 5. never blocks
  select count(*) into n from public.events where type = 'email_enqueue_error';
  if n <> 0 then raise exception 'FAIL enqueue errors logged: %', n; end if; c := c + 1;

  raise exception 'CANCEL_YEARLY_EMAILS_TESTS_PASSED (% checks)', c;
end $$;
