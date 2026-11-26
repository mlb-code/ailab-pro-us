-- FirstRing sign-up / cancellation e-mails (20261128100000_us_subscription_emails.sql): queued exactly once per subscription
-- row (right template, audience, idem key, payload), the send-time context (right row, recipient, no admin-only fields in the
-- client mail) and the skips (status moved, returning customer, duplicate trial). Cancellation alerts to Meir: scheduled once
-- a day, ended only when it was not scheduled first. One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with SUBSCRIPTION_EMAILS_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/subscription_emails_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ud uuid := gen_random_uuid();
  r jsonb; v jsonb; ca uuid; cb uuid; cc uuid; cd uuid; sa uuid; sa2 uuid; sb uuid; sc uuid; sd uuid; o private.email_outbox;
  n int; c int := 0; s text;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ua, 'se-a@example.com'), (ub, 'se-b@example.com'), (uc, 'se-c@example.com'),
    (ud, 'se-d@example.com');
  update public.profiles set company = 'Cool Breeze HVAC', full_name = 'Dana Cool', phone = '(713) 555-0160' where id = ua;
  update public.profiles set company = 'Bee Plumbing', phone = '+13125550161' where id = ub;
  update public.profiles set company = 'Cee Electric', phone = '+12145550162' where id = uc;
  update public.profiles set company = 'Copycat HVAC', phone = '+12145550163' where id = ud;
  update private.settings set billing_mock_enabled = true, admin_email = 'meir-test@example.com' where id = 1;

  -- ================================================================ 1. trial sign-up: one client mail + one admin alert
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 14);
  ca := (r ->> 'client_id')::uuid; sa := (r ->> 'subscription_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select string_agg(template || '|' || audience || '|' || idem_key, ',' order by template) into s from private.email_outbox
   where entity_id = ca and template in ('trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled');
  if s is distinct from 'admin_new_subscription|admin|admin_new_subscription:' || sa || ',trial_welcome|client|trial_welcome:' || sa then
    raise exception 'FAIL trial sign-up queues trial_welcome + admin_new_subscription: %', s; end if; c := c + 1;
  select * into o from private.email_outbox where idem_key = 'trial_welcome:' || sa;
  if o.entity is distinct from 'client' or o.user_id is distinct from ua or o.payload ->> 'subscription_id' is distinct from sa::text or o.status is distinct from 'pending' then
    raise exception 'FAIL trial_welcome row %', to_jsonb(o); end if; c := c + 1;

  -- the client mail: own row, own address, plan + trial end, no admin-only fields
  v := private.email_context(o.id);
  if v ? 'skip' or v ->> 'to' is distinct from 'se-a@example.com' or v #>> '{subscription,id}' is distinct from sa::text or v #>> '{subscription,plan_code}' is distinct from 'FR_PRO'
     or v #>> '{subscription,status}' is distinct from 'trialing' or (v #>> '{subscription,trial_ends_at}') is null or v #>> '{subscription,provider}' is distinct from 'mock'
     or v #>> '{client,billing_mode}' is distinct from 'subscription' or v #>> '{client,status}' is distinct from 'onboarding' or v #>> '{profile,company}' is distinct from 'Cool Breeze HVAC' then
    raise exception 'FAIL trial_welcome context %', v; end if; c := c + 1;
  if (v -> 'subscription') ? 'business_phone' or (v -> 'subscription') ? 'returning' then
    raise exception 'FAIL admin-only fields in the client mail %', v -> 'subscription'; end if; c := c + 1;
  -- Meir's alert: his address, the business phone, not returning
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_new_subscription:' || sa;
  if v ? 'skip' or v ->> 'to' is distinct from 'meir-test@example.com' or v #>> '{subscription,business_phone}' is distinct from '+17135550160'
     or (v #>> '{subscription,returning}')::boolean is not false or (v #>> '{subscription,trial_duplicate}')::boolean is not false or v #>> '{profile,full_name}' is distinct from 'Dana Cool' then
    raise exception 'FAIL admin_new_subscription context %', v; end if; c := c + 1;

  -- webhook replay (same provider id, service role) and a plan change: nothing new
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.billing_upsert_subscription('mock', (select provider_subscription_id from public.subscriptions where id = sa), 'trialing', 'FR_PRO', ua);
  perform public.billing_upsert_subscription('mock', (select provider_subscription_id from public.subscriptions where id = sa), 'trialing', 'FR_PRO', ua);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.billing_change_plan('FR_BUSINESS');
  -- "start my paid plan now": the same row goes trialing -> active. Not a new subscription: no plan_welcome.
  perform public.billing_change_plan('FR_BUSINESS', true);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from public.subscriptions where id = sa) is distinct from 'active' then raise exception 'FAIL setup: start now'; end if;
  select count(*) into n from private.email_outbox where entity_id = ca
     and template in ('trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled');
  if n <> 2 then raise exception 'FAIL replays / plan changes queued more mails: % rows', n; end if; c := c + 1;
  -- the trial mail not sent yet when the trial already turned paid: skipped at send time
  select private.email_context(id) into v from private.email_outbox where idem_key = 'trial_welcome:' || sa;
  if v ->> 'skip' is distinct from 'status_moved' then raise exception 'FAIL trial_welcome after the trial ended: %', v; end if; c := c + 1;

  -- ================================================================ 2. paid sign-up (no trial)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 0);
  cb := (r ->> 'client_id')::uuid; sb := (r ->> 'subscription_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select string_agg(template || '|' || audience, ',' order by template) into s from private.email_outbox where entity_id = cb
     and template in ('trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled');
  if s is distinct from 'admin_new_subscription|admin,plan_welcome|client' then raise exception 'FAIL paid sign-up mails: %', s; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'plan_welcome:' || sb;
  if v ? 'skip' or v ->> 'to' is distinct from 'se-b@example.com' or v #>> '{subscription,status}' is distinct from 'active' or v #>> '{subscription,plan_code}' is distinct from 'FR_STARTER'
     or (v #>> '{subscription,current_period_end}') is null or (v #>> '{subscription,current_period_start}') is null then
    raise exception 'FAIL plan_welcome context %', v; end if; c := c + 1;

  -- ================================================================ 3. cancellation alerts to Meir
  -- B (paid) cancels: at the end of the paid period -> 'scheduled', once; the end itself is not a second alert
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cb and template = 'admin_subscription_canceled';
  select * into o from private.email_outbox where entity_id = cb and template = 'admin_subscription_canceled';
  if n <> 1 or o.audience is distinct from 'admin' or o.idem_key is distinct from 'admin_subscription_canceled:' || sb || ':scheduled:' || to_char(now(), 'YYYYMMDD')
     or o.payload ->> 'kind' is distinct from 'scheduled' or o.payload ->> 'from' is distinct from 'active' then
    raise exception 'FAIL scheduled cancel alert (% rows) %', n, to_jsonb(o); end if; c := c + 1;
  v := private.email_context(o.id);
  if v ? 'skip' or v ->> 'to' is distinct from 'meir-test@example.com' or (v #>> '{subscription,cancel_at_period_end}')::boolean is not true
     or v #>> '{subscription,business_phone}' is distinct from '+13125550161' then raise exception 'FAIL scheduled cancel context %', v; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.billing_upsert_subscription('mock', (select provider_subscription_id from public.subscriptions where id = sb), 'canceled', 'FR_STARTER',
    null, null, null, null, null, false, null, null, now());
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cb and template = 'admin_subscription_canceled';
  if n <> 1 then raise exception 'FAIL the end of a scheduled cancel is a second alert (% rows)', n; end if; c := c + 1;

  -- C cancels during the trial: canceled at once -> 'ended', once
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_BUSINESS', 14);
  cc := (r ->> 'client_id')::uuid; sc := (r ->> 'subscription_id')::uuid;
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cc and template = 'admin_subscription_canceled';
  select * into o from private.email_outbox where entity_id = cc and template = 'admin_subscription_canceled';
  if n <> 1 or o.idem_key is distinct from 'admin_subscription_canceled:' || sc || ':ended' or o.payload ->> 'kind' is distinct from 'ended' or o.payload ->> 'from' is distinct from 'trialing' then
    raise exception 'FAIL trial cancel alert (% rows) %', n, to_jsonb(o); end if; c := c + 1;
  if (private.email_context(o.id) #>> '{subscription,status}') is distinct from 'canceled' then raise exception 'FAIL ended context'; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'trial_welcome:' || sc;
  if v ->> 'skip' is distinct from 'status_moved' then raise exception 'FAIL trial mail after a cancel: %', v; end if; c := c + 1;

  -- ================================================================ 4. returning customer: Meir is told, no second welcome
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.billing_upsert_subscription('mock', (select provider_subscription_id from public.subscriptions where id = sa), 'canceled', 'FR_BUSINESS',
    null, null, null, null, null, false, null, null, now());
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set created_at = created_at - interval '40 days' where id = sa;   -- one transaction = one now()
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 0);
  sa2 := (r ->> 'subscription_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (r ->> 'client_id')::uuid is distinct from ca or sa2 = sa then raise exception 'FAIL setup: resubscribe %', r; end if;
  select count(*) into n from private.email_outbox where idem_key in ('plan_welcome:' || sa2, 'admin_new_subscription:' || sa2);
  if n <> 2 then raise exception 'FAIL resubscribe queues its two rows (%)', n; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'plan_welcome:' || sa2;
  if v ->> 'skip' is distinct from 'returning_client' then raise exception 'FAIL returning customer welcomed again: %', v; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_new_subscription:' || sa2;
  if v ? 'skip' or (v #>> '{subscription,returning}')::boolean is not true or v #>> '{subscription,id}' is distinct from sa2::text then
    raise exception 'FAIL admin alert for a returning customer %', v; end if; c := c + 1;

  -- ================================================================ 5. second trial for the same business phone
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.billing_upsert_subscription('paddle', 'sub_dup_trial_0001', 'trialing', 'FR_PRO', ud, 'ctm_1', now() + interval '14 days',
    null, null, false, true, null, null, now(), '(713) 555-0160');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  cd := (r ->> 'client_id')::uuid; sd := (r ->> 'subscription_id')::uuid;
  if (r ->> 'trial_duplicate')::boolean is not true then raise exception 'FAIL setup: duplicate trial %', r; end if;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'trial_welcome:' || sd;
  if v ->> 'skip' is distinct from 'trial_duplicate' then raise exception 'FAIL duplicate trial gets the welcome: %', v; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_new_subscription:' || sd;
  if v ? 'skip' or (v #>> '{subscription,trial_duplicate}')::boolean is not true or v #>> '{subscription,provider}' is distinct from 'paddle' then
    raise exception 'FAIL admin alert for a duplicate trial %', v; end if; c := c + 1;

  -- ================================================================ 6. never blocks, unknown rows skipped
  select count(*) into n from public.events where type = 'email_enqueue_error';
  if n <> 0 then raise exception 'FAIL enqueue errors logged: %', n; end if; c := c + 1;
  perform private.enqueue_email('trial_welcome', 'trial_welcome:test-missing', 'client', cb, ub, jsonb_build_object('subscription_id', gen_random_uuid()));
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select private.email_context(id) into v from private.email_outbox where idem_key = 'trial_welcome:test-missing';
  if v ->> 'skip' is distinct from 'subscription_missing' then raise exception 'FAIL unknown subscription id: %', v; end if; c := c + 1;
  -- the existing subscription mails still read the client's latest row
  perform private.enqueue_email('trial_ending', 'trial_ending:test-latest', 'client', ca, ua);
  select private.email_context(id) into v from private.email_outbox where idem_key = 'trial_ending:test-latest';
  if v ->> 'skip' is distinct from 'trial_over' then raise exception 'FAIL trial_ending context changed: %', v; end if; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  raise exception 'SUBSCRIPTION_EMAILS_TESTS_PASSED (% checks)', c;
end $$;
