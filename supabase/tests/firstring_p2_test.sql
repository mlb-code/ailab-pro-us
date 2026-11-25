-- FirstRing phase 2 (20261125200000_us_firstring_p2.sql): number release scheduling, the admin release buttons, the go-live
-- AI check result in the admin, Spanish by plan + the customer's remembered choice. One DO block; ALWAYS ends with an error
-- so it rolls back. Success = message starts with FIRSTRING_P2_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/firstring_p2_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); ad uuid := gen_random_uuid();
  r jsonb; ca uuid; ta uuid; cb uuid; tb uuid; t public.tenants; rel public.number_releases; sub public.subscriptions;
  n int; c int := 0; d timestamptz; s text;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ua, 'p2-a@example.com'), (ub, 'p2-b@example.com'), (ad, 'p2-admin@example.com');
  update public.profiles set company = 'Spanish Air HVAC', phone = '(713) 555-0120' where id = ua;
  update public.profiles set company = 'Starter Plumbing', phone = '+13125550121' where id = ub;
  update public.profiles set is_admin = true where id = ad;
  update private.settings set billing_mock_enabled = true where id = 1;

  -- ================================================================ Spanish: on automatically on Pro
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 14);
  ca := (r ->> 'client_id')::uuid; ta := (r ->> 'tenant_id')::uuid;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 14);
  cb := (r ->> 'client_id')::uuid; tb := (r ->> 'tenant_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select config #> '{voice,languages}' from public.tenants where id = ta) is distinct from '["en", "es"]'::jsonb then
    raise exception 'FAIL Pro starts with Spanish: %', (select config -> 'voice' from public.tenants where id = ta); end if; c := c + 1;
  if (select config #> '{voice,languages}' from public.tenants where id = tb) is distinct from '["en"]'::jsonb then
    raise exception 'FAIL Starter has no Spanish'; end if; c := c + 1;

  -- the customer switches it off: saved into the live config, remembered; the key itself is never merged
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.update_tenant_settings(ta, '{"spanish": false}');
  if r #> '{voice,languages}' is distinct from '["en"]'::jsonb or r #> '{voice,spanish_off}' is distinct from 'true'::jsonb or r ? 'spanish'
     or r #>> '{voice,greeting}' is distinct from '' then
    raise exception 'FAIL spanish off %', r; end if; c := c + 1;
  begin perform public.update_tenant_settings(ta, '{"spanish": "yes"}'); raise exception 'FAIL spanish non-boolean accepted';
  exception when sqlstate 'P0001' then if sqlerrm is distinct from 'invalid_setting:spanish' then raise exception 'FAIL spanish type: %', sqlerrm; end if; end; c := c + 1;
  -- downgrade (trial: now) -> English only, choice kept; upgrade -> still off (remembered)
  perform public.billing_change_plan('FR_STARTER');
  select * into t from public.tenants where id = ta;
  if t.config #> '{voice,languages}' is distinct from '["en"]'::jsonb or t.config #> '{voice,spanish_off}' is distinct from 'true'::jsonb then
    raise exception 'FAIL downgrade %', t.config -> 'voice'; end if; c := c + 1;
  begin perform public.update_tenant_settings(ta, '{"spanish": true}'); raise exception 'FAIL Spanish switched on on Starter';
  exception when sqlstate 'P0001' then if sqlerrm is distinct from 'spanish_not_in_plan' then raise exception 'FAIL starter toggle: %', sqlerrm; end if; end; c := c + 1;
  perform public.billing_change_plan('FR_BUSINESS');
  if (select config #> '{voice,languages}' from public.tenants where id = ta) is distinct from '["en"]'::jsonb then
    raise exception 'FAIL upgrade ignored the remembered off'; end if; c := c + 1;
  r := public.update_tenant_settings(ta, '{"spanish": true}');
  if r #> '{voice,languages}' is distinct from '["en", "es"]'::jsonb or r #> '{voice,spanish_off}' is distinct from 'false'::jsonb then
    raise exception 'FAIL spanish on %', r -> 'voice'; end if; c := c + 1;
  perform public.billing_change_plan('FR_STARTER');
  if (select config #> '{voice,languages}' from public.tenants where id = ta) is distinct from '["en"]'::jsonb then raise exception 'FAIL downgrade 2'; end if;
  perform public.billing_change_plan('FR_PRO');
  if (select config #> '{voice,languages}' from public.tenants where id = ta) is distinct from '["en", "es"]'::jsonb then
    raise exception 'FAIL upgrade turns Spanish back on'; end if; c := c + 1;
  -- someone else's tenant
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  begin perform public.update_tenant_settings(ta, '{"spanish": false}'); raise exception 'FAIL other client changed Spanish';
  exception when insufficient_privilege then null; end; c := c + 1;
  -- the existing whitelist is unchanged
  begin perform public.update_tenant_settings(tb, '{"voice": {"languages": ["en", "es"]}}'); raise exception 'FAIL voice writable';
  exception when sqlstate 'P0001' then if sqlerrm not like 'field_not_allowed%' then raise exception 'FAIL whitelist: %', sqlerrm; end if; end; c := c + 1;
  r := public.update_tenant_settings(tb, '{"paused": true}');
  if (r ->> 'paused')::boolean is not true then raise exception 'FAIL paused still works'; end if; c := c + 1;
  -- even a direct admin write of voice.languages cannot give Starter Spanish
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.tenants set config = jsonb_set(config, '{voice}', '{"languages": ["en", "es"]}') where id = tb;
  if (select config #> '{voice,languages}' from public.tenants where id = tb) is distinct from '["en"]'::jsonb then
    raise exception 'FAIL Starter got Spanish by a direct write'; end if; c := c + 1;

  -- ================================================================ number release: the trial is cancelled
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.tenants set twilio_number = '+17135550142' where id = ta;
  update public.provisioning_jobs set status = 'done', result = '{"number": "+17135550142"}' where tenant_id = ta and kind = 'number';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.number_releases; if n is distinct from 0 then raise exception 'FAIL release before the end'; end if; c := c + 1;
  perform public.billing_cancel();   -- in the trial: ends now
  select count(*) into n from public.number_releases; if n is distinct from 0 then raise exception 'FAIL client reads number_releases'; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into rel from public.number_releases where tenant_id = ta;
  select * into sub from public.subscriptions where client_id = ca;
  if rel.id is null or rel.status is distinct from 'scheduled' or rel.number is distinct from '+17135550142' or rel.reason is distinct from 'canceled'
     or rel.service_ended_at is distinct from sub.ends_at or rel.release_at is distinct from sub.ends_at + interval '30 days'
     or rel.warn_at is distinct from rel.release_at - interval '7 days' or rel.warned_at is not null then
    raise exception 'FAIL release scheduled %', to_jsonb(rel); end if; c := c + 1;
  perform private.number_release_sync(ca); perform private.number_release_sync_all();
  select count(*) into n from public.number_releases where tenant_id = ta; if n is distinct from 1 then raise exception 'FAIL % rows', n; end if;
  if (select release_at from public.number_releases where tenant_id = ta) is distinct from rel.release_at then raise exception 'FAIL sync moved the date'; end if; c := c + 1;
  if not exists (select 1 from cron.job where jobname = 'ailab-us-number-release') then raise exception 'FAIL no hourly job'; end if; c := c + 1;

  -- admin: sees it, postpones it (a new warning goes out before the new date), the client cannot
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.admin_postpone_number_release(ca, 10); raise exception 'FAIL client postponed';
  exception when insufficient_privilege then null; end;
  begin perform public.admin_release_number_now(ca); raise exception 'FAIL client released';
  exception when insufficient_privilege then null; end;
  begin perform public.admin_subscriptions_extra(); raise exception 'FAIL client read the admin extra';
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := (select x from jsonb_array_elements(public.admin_subscriptions_extra()) x where x ->> 'client_id' = ca::text);
  if r #>> '{release,status}' is distinct from 'scheduled' or r #>> '{release,number}' is distinct from '+17135550142' then raise exception 'FAIL admin extra %', r; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.number_releases set warned_at = now() where tenant_id = ta;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := public.admin_postpone_number_release(ca, 10);
  select * into rel from public.number_releases where tenant_id = ta;
  if rel.release_at is distinct from sub.ends_at + interval '40 days' or rel.postponed_count is distinct from 1 or rel.warned_at is not null
     or rel.warn_at is distinct from rel.release_at - interval '7 days' then raise exception 'FAIL postpone %', to_jsonb(rel); end if; c := c + 1;
  begin perform public.admin_postpone_number_release(ca, 0); raise exception 'FAIL 0 days';
  exception when sqlstate 'P0001' then null; end; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  perform private.number_release_sync_all();
  if (select release_at from public.number_releases where tenant_id = ta) is distinct from sub.ends_at + interval '40 days' then
    raise exception 'FAIL the hourly sync undid the postponement'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := public.admin_release_number_now(ca);
  select * into rel from public.number_releases where tenant_id = ta;
  if not rel.force or rel.release_at > now() or rel.status is distinct from 'scheduled' then raise exception 'FAIL release now %', to_jsonb(rel); end if; c := c + 1;

  -- resubscribing before the release cancels it at once
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set created_at = created_at - interval '1 hour' where client_id = ca;  -- one transaction: older rows first
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.billing_mock_checkout('FR_PRO', 0);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into rel from public.number_releases where tenant_id = ta;
  if rel.status is distinct from 'canceled' or rel.cancel_reason is distinct from 'resubscribed' then raise exception 'FAIL resubscribe %', to_jsonb(rel); end if; c := c + 1;
  if (select twilio_number from public.tenants where id = ta) is distinct from '+17135550142' then raise exception 'FAIL the number changed'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  begin perform public.admin_release_number_now(ca); raise exception 'FAIL released an active subscription';
  exception when sqlstate 'P0002' then null; end; c := c + 1;

  -- cancel again (paid month): nothing until the paid period is over; then a fresh schedule from the period end
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from public.number_releases where tenant_id = ta) is distinct from 'canceled' then raise exception 'FAIL scheduled inside the paid month'; end if; c := c + 1;
  d := now() - interval '2 days';
  update public.subscriptions set current_period_end = d where client_id = ca and status = 'active';
  select * into rel from public.number_releases where tenant_id = ta;
  if rel.status is distinct from 'scheduled' or rel.service_ended_at is distinct from d or rel.release_at is distinct from d + interval '30 days' or rel.warned_at is not null
     or rel.force or rel.postponed_count is distinct from 0 then raise exception 'FAIL schedule after the paid period %', to_jsonb(rel); end if; c := c + 1;

  -- the runtime released it: the tenant is free and the old number job is gone, so a resubscribe buys a new number
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.number_releases set status = 'released', released_at = now() where tenant_id = ta;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select twilio_number from public.tenants where id = ta) is not null then raise exception 'FAIL tenant keeps the released number'; end if;
  if exists (select 1 from public.provisioning_jobs where tenant_id = ta and kind = 'number') then raise exception 'FAIL old number job kept'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set created_at = created_at - interval '1 hour' where client_id = ca;  -- one transaction: older rows first
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.billing_resume();   -- the customer restarts the plan
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from public.provisioning_jobs where tenant_id = ta and kind = 'number' and status = 'pending') then
    raise exception 'FAIL no new number after resubscribing'; end if;
  if (select status from public.number_releases where tenant_id = ta) is distinct from 'released' then raise exception 'FAIL released row changed'; end if; c := c + 1;

  -- ================================================================ trial ended unpaid; past due and paused never
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.tenants set twilio_number = '+13125550143' where id = tb;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set trial_ends_at = now() - interval '6 hours' where client_id = cb;   -- inside the 12 h grace
  perform private.number_release_sync_all();
  if exists (select 1 from public.number_releases where tenant_id = tb) then raise exception 'FAIL release inside the trial grace'; end if; c := c + 1;
  d := now() - interval '31 days';
  update public.subscriptions set trial_ends_at = d where client_id = cb;
  perform private.billing_sync(); perform private.number_release_sync_all();
  select * into rel from public.number_releases where tenant_id = tb;
  if rel.status is distinct from 'scheduled' or rel.reason is distinct from 'trial_ended' or rel.service_ended_at is distinct from d or rel.release_at is distinct from d + interval '30 days' then
    raise exception 'FAIL trial ended unpaid %', to_jsonb(rel); end if; c := c + 1;
  update public.subscriptions set status = 'past_due', past_due_since = now() - interval '60 days',
         current_period_end = now() - interval '40 days' where client_id = cb;
  select * into rel from public.number_releases where tenant_id = tb;
  if rel.status is distinct from 'canceled' then raise exception 'FAIL past due (even beyond grace) is never released %', to_jsonb(rel); end if; c := c + 1;
  update public.subscriptions set status = 'paused', past_due_since = null, paused_at = now() - interval '60 days' where client_id = cb;
  perform private.number_release_sync_all();
  if (select status from public.number_releases where tenant_id = tb) is distinct from 'canceled' then raise exception 'FAIL paused released'; end if; c := c + 1;

  -- ================================================================ go-live AI check result -> admin; held = never auto-live
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.tenants set twilio_number = '+13125550143' where id = tb;
  insert into public.provisioning_jobs (tenant_id, client_id, kind, status, result)
  values (tb, cb, 'golive_sim', 'pending', '{}') on conflict (tenant_id, kind) do update set status = 'pending';
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set status = 'trialing', paused_at = null, trial_ends_at = now() + interval '7 days' where client_id = cb;
  update public.onboarding_items set status = 'done' where client_id = cb;
  update public.clients set status = 'testing' where id = cb;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.provisioning_jobs set status = 'held', result = '{"passed": false, "failed": ["live_ai"], "ai_check": {"status": "error",
    "attempts": 3, "error": "timeout after 90s", "transcript": [], "cost_usd": 0}}' where tenant_id = tb and kind = 'golive_sim';
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from public.clients where id = cb) is distinct from 'testing' or private.try_go_live(cb) then raise exception 'FAIL held check went live'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := (select x from jsonb_array_elements(public.admin_subscriptions_extra()) x where x ->> 'client_id' = cb::text);
  if r #>> '{golive,status}' is distinct from 'held' or r #>> '{golive,ai_check,status}' is distinct from 'error' or (r #>> '{golive,ai_check,attempts}')::int is distinct from 3 then
    raise exception 'FAIL admin sees the AI check %', r; end if; c := c + 1;
  perform public.admin_force_golive(cb);   -- Meir approves by hand
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from public.clients where id = cb) is distinct from 'live' then raise exception 'FAIL manual approval'; end if; c := c + 1;

  select count(*) into n from public.events where type like 'number_release%';
  if n < 4 then raise exception 'FAIL release events logged: %', n; end if; c := c + 1;

  raise exception 'FIRSTRING_P2_TESTS_PASSED (% checks)', c;
end $$;
