-- FirstRing phase 3 follow-ups (20261127100000_us_firstring_p3.sql): the customer sees the number release date in
-- client_billing (own client only, only while scheduled), and the runtime reads the account e-mail (service role only).
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with FIRSTRING_P3_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/firstring_p3_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  r jsonb; ca uuid; ta uuid; cb uuid; rel public.number_releases; c int := 0; s text;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ua, 'p3-a@example.com'), (ub, 'p3-b@example.com');
  update public.profiles set company = 'Release Air HVAC', phone = '(713) 555-0150' where id = ua;
  update public.profiles set company = 'Other Plumbing', phone = '+13125550151' where id = ub;
  update private.settings set billing_mock_enabled = true where id = 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 14);
  ca := (r ->> 'client_id')::uuid; ta := (r ->> 'tenant_id')::uuid;
  if public.client_billing() -> 'number_release' is distinct from 'null'::jsonb then
    raise exception 'FAIL a running trial shows a release: %', public.client_billing() -> 'number_release'; end if; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 14);
  cb := (r ->> 'client_id')::uuid;

  -- A's number, then A cancels the trial: the release is scheduled (20261125200000_us_firstring_p2.sql)
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.tenants set twilio_number = '+17135550152' where id = ta;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.billing_cancel();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into rel from public.number_releases where tenant_id = ta;
  if rel.status is distinct from 'scheduled' then raise exception 'FAIL setup: release not scheduled %', to_jsonb(rel); end if;

  -- ================================================================ 1. the customer sees the date (own client only)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.client_billing() -> 'number_release';
  if r ->> 'number' is distinct from '+17135550152' or (r ->> 'release_at')::timestamptz is distinct from rel.release_at then
    raise exception 'FAIL client sees the release %', r; end if; c := c + 1;
  if (select count(*) from jsonb_object_keys(r)) <> 2 then raise exception 'FAIL only number + date are shown: %', r; end if; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  if public.client_billing() -> 'number_release' is distinct from 'null'::jsonb then
    raise exception 'FAIL client B sees A''s release: %', public.client_billing() -> 'number_release'; end if; c := c + 1;
  -- held (dry run), then canceled: nothing shown
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.number_releases set status = 'held', dry_run = true where id = rel.id;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if public.client_billing() -> 'number_release' is distinct from 'null'::jsonb then raise exception 'FAIL held release shown'; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.number_releases set status = 'canceled', canceled_at = now() where id = rel.id;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if public.client_billing() -> 'number_release' is distinct from 'null'::jsonb then raise exception 'FAIL canceled release shown'; end if; c := c + 1;
  -- the rest of the billing read is unchanged
  r := public.client_billing();
  if r #>> '{subscription,status}' is distinct from 'canceled' or r ->> 'number' is distinct from '+17135550152' or r ->> 'client_id' is distinct from ca::text
     or not (r ? 'usage' and r ? 'setup' and r ? 'service' and r ? 'period' and r ? 'mock_checkout') then
    raise exception 'FAIL client_billing keys %', r; end if; c := c + 1;
  perform set_config('role', 'anon', true); perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform public.client_billing(); raise exception 'FAIL anon billing';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- ================================================================ 2. the account e-mail (service role only)
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  if public.runtime_account_email(ca) is distinct from 'p3-a@example.com' then
    raise exception 'FAIL account e-mail = sign-in address: %', public.runtime_account_email(ca); end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.profiles set contact_email = 'Owner@ReleaseAir.test' where id = ua;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  if public.runtime_account_email(ca) is distinct from 'owner@releaseair.test' then
    raise exception 'FAIL account e-mail = contact e-mail when set: %', public.runtime_account_email(ca); end if; c := c + 1;
  if public.runtime_account_email(cb) is distinct from 'p3-b@example.com' then raise exception 'FAIL per client'; end if;
  if public.runtime_account_email(gen_random_uuid()) is not null then raise exception 'FAIL unknown client'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  begin s := public.runtime_account_email(ca); raise exception 'FAIL a client read another account''s e-mail: %', s;
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('role', 'anon', true); perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin s := public.runtime_account_email(ca); raise exception 'FAIL anon read the account e-mail: %', s;
  exception when insufficient_privilege then null; end; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  raise exception 'FIRSTRING_P3_TESTS_PASSED (% checks)', c;
end $$;
