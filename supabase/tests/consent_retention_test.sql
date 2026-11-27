-- Sign-up consent records and the event log (20261130100100_us_consent_retention.sql, legal review 2026-11-27 subscription
-- item 9, privacy item 3.4): the consent record survives the deletion of the account (user_id set null, wording / version /
-- time / browser intact); private.run_retention() deletes it 7 years after sign-up but never before 1 year after its plan
-- ended; events older than 7 years are deleted, younger ones stay.
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with CONSENT_RETENTION_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/consent_retention_run.ts
do $$
declare
  u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); cl uuid; cl2 uuid; j jsonb; n int; c int := 0;
  b public.billing_checkouts; k text; con record;
  consent constant text := 'I agree to the Terms of Service and the Service Agreement (version 9.9). Test consent sentence.';
  ref_kept constant text := 'chk_' || md5('kept');
  ref_old_ended constant text := 'chk_' || md5('old-ended');
  ref_old_recent constant text := 'chk_' || md5('old-recent-end');
  ref_old_active constant text := 'chk_' || md5('old-active');
  ref_old_open constant text := 'chk_' || md5('old-open');
  ref_young constant text := 'chk_' || md5('young');
begin
  -- the foreign key: set null, no cascade left
  select c.confdeltype as del, c.convalidated as ok into con from pg_catalog.pg_constraint c
   where c.conrelid = 'public.billing_checkouts'::regclass and c.conname = 'billing_checkouts_user_keep_fkey';
  if con.del is distinct from 'n' or con.ok is not true then raise exception 'FAIL billing_checkouts FK is not a validated SET NULL: %', to_jsonb(con); end if; c := c + 1;
  if exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.billing_checkouts'::regclass and c.contype = 'f'
              and c.confdeltype = 'c') then raise exception 'FAIL a cascading FK is left on billing_checkouts'; end if; c := c + 1;

  -- ================================================================ 1. the account is deleted: the consent record stays
  insert into auth.users (id, email) values (u, 'cr-a@example.com'), (u2, 'cr-b@example.com');
  insert into public.clients (user_id, products, status, billing_mode, business_name) values (u, '{RCP}', 'cancelled', 'subscription', 'Keep Plumbing')
    returning id into cl;
  insert into public.clients (user_id, products, status, billing_mode, business_name) values (u2, '{RCP}', 'live', 'subscription', 'Old HVAC')
    returning id into cl2;
  insert into public.billing_checkouts (ref, user_id, plan_code, trial, business_phone, agreement_version, consent_text, user_agent,
                                        status, provider_subscription_id, completed_at)
  values (ref_kept, u, 'FR_PRO', true, '+17135550301', '9.9', consent, 'Mozilla/5.0 test', 'completed', 'sub_cr_kept_01', now());
  insert into public.subscriptions (client_id, plan_code, status, provider, provider_subscription_id, canceled_at, ends_at)
  values (cl, 'FR_PRO', 'canceled', 'paddle', 'sub_cr_kept_01', now() - interval '40 days', now() - interval '40 days');
  j := private.anonymize_client(cl);
  if (j ->> 'user_deleted')::boolean is not true or exists (select 1 from public.profiles where id = u) then
    raise exception 'FAIL setup: the account was not deleted %', j; end if;
  select * into b from public.billing_checkouts where ref = ref_kept;
  if b.id is null then raise exception 'FAIL the sign-up consent was deleted with the account'; end if; c := c + 1;
  if b.user_id is not null or b.consent_text is distinct from consent or b.agreement_version is distinct from '9.9'
     or b.user_agent is distinct from 'Mozilla/5.0 test' or b.created_at is null or b.business_phone is distinct from '+17135550301'
     or b.provider_subscription_id is distinct from 'sub_cr_kept_01' then
    raise exception 'FAIL consent record changed: %', to_jsonb(b); end if; c := c + 1;
  -- the business behind it is still known (the subscription and the anonymised client are kept)
  if (select c2.business_name from public.subscriptions s join public.clients c2 on c2.id = s.client_id
       where s.provider_subscription_id = b.provider_subscription_id) is distinct from 'Keep Plumbing' then
    raise exception 'FAIL consent record no longer leads to the business'; end if; c := c + 1;

  -- ================================================================ 2. 7 years, and 1 year after the plan ended
  insert into public.billing_checkouts (ref, user_id, plan_code, trial, business_phone, agreement_version, consent_text, status,
                                        provider_subscription_id, created_at)
  values (ref_old_ended, u2, 'FR_PRO', true, '+17135550302', '9.9', consent, 'completed', 'sub_cr_old_ended', now() - interval '7 years 1 day'),
         (ref_old_recent, u2, 'FR_PRO', true, '+17135550302', '9.9', consent, 'completed', 'sub_cr_old_recent', now() - interval '7 years 1 day'),
         (ref_old_active, u2, 'FR_PRO', true, '+17135550302', '9.9', consent, 'completed', 'sub_cr_old_active', now() - interval '7 years 1 day'),
         (ref_old_open, u2, 'FR_PRO', true, '+17135550302', '9.9', consent, 'open', null, now() - interval '7 years 1 day'),
         (ref_young, u2, 'FR_PRO', true, '+17135550302', '9.9', consent, 'completed', 'sub_cr_young', now() - interval '6 years');
  insert into public.subscriptions (client_id, plan_code, status, provider, provider_subscription_id, canceled_at, ends_at) values
    (cl2, 'FR_PRO', 'canceled', 'paddle', 'sub_cr_old_ended', now() - interval '2 years', now() - interval '2 years'),
    (cl2, 'FR_PRO', 'canceled', 'paddle', 'sub_cr_old_recent', now() - interval '6 months', now() - interval '6 months'),
    (cl2, 'FR_PRO', 'canceled', 'paddle', 'sub_cr_young', now() - interval '3 years', now() - interval '3 years');
  insert into public.subscriptions (client_id, plan_code, status, provider, provider_subscription_id)
  values (cl2, 'FR_PRO', 'active', 'paddle', 'sub_cr_old_active');

  -- ================================================================ 3. events: 7 years
  insert into public.events (actor, entity, entity_id, type, payload, created_at) values
    ('system', 'client', cl2, 'cr_test_old', '{}', now() - interval '7 years 1 day'),
    ('runtime', 'tenant', null, 'cr_test_old', '{}', now() - interval '8 years'),
    ('system', 'client', cl2, 'cr_test_young', '{}', now() - interval '6 years 11 months'),
    ('system', 'client', cl2, 'cr_test_young', '{}', now() - interval '1 day');

  j := private.run_retention();

  foreach k in array array[ref_old_ended, ref_old_open] loop
    if exists (select 1 from public.billing_checkouts where ref = k) then raise exception 'FAIL consent older than 7 years kept: %', k; end if; c := c + 1;
  end loop;
  foreach k in array array[ref_kept, ref_old_recent, ref_old_active, ref_young] loop
    if not exists (select 1 from public.billing_checkouts where ref = k) then raise exception 'FAIL consent deleted too early: %', k; end if; c := c + 1;
  end loop;
  select count(*) into n from public.events where type = 'cr_test_old';
  if n <> 0 then raise exception 'FAIL events older than 7 years kept (%)', n; end if; c := c + 1;
  select count(*) into n from public.events where type = 'cr_test_young';
  if n <> 2 then raise exception 'FAIL events younger than 7 years deleted (% of 2 left)', n; end if; c := c + 1;
  if (j ->> 'signup_consent_deleted')::int is distinct from 2 or (j ->> 'old_events_deleted')::int < 2 or not (j ? 'convo_deleted') then
    raise exception 'FAIL retention counts %', j; end if; c := c + 1;

  raise exception 'CONSENT_RETENTION_TESTS_PASSED (% checks)', c;
end $$;
