-- Call-forwarding step, self-confirmed = UNVERIFIED (20261129100200_us_forwarding_self_confirmed.sql): the client may still
-- confirm a test call that came without carrier forwarding data, but the item says unverified, Meir gets an admin e-mail and
-- an admin-only event, the admin "Subscriptions" read shows it, and a verified forward stays verified.
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with FORWARDING_SELF_CONFIRMED_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/forwarding_self_confirmed_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); ad uuid := gen_random_uuid();
  r jsonb; ca uuid; ta uuid; cb uuid; tb uuid; it public.onboarding_items; n int; c int := 0;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ua, 'fwd-a@example.com'), (ub, 'fwd-b@example.com'), (ad, 'fwd-admin@example.com');
  update public.profiles set company = 'Self Confirm HVAC', phone = '(713) 555-0130' where id = ua;
  update public.profiles set company = 'Verified Plumbing', phone = '(713) 555-0131' where id = ub;
  update public.profiles set is_admin = true where id = ad;
  update private.settings set billing_mock_enabled = true where id = 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 14);
  ca := (r ->> 'client_id')::uuid; ta := (r ->> 'tenant_id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 14);
  cb := (r ->> 'client_id')::uuid; tb := (r ->> 'tenant_id')::uuid;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.tenants set twilio_number = '+17135550190' where id = ta;
  update public.tenants set twilio_number = '+17135550191' where id = tb;

  -- ================================================================ A: test call without ForwardedFrom, then self-confirm
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select * into it from public.onboarding_items where client_id = ca and key = 'forward_calls';
  perform public.start_forwarding_test(it.id);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into public.calls (tenant_id, call_sid, from_e164, started_at) values (ta, 'CA-fwd-unverified', '+972501234567', now());
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  it := public.confirm_forwarding_test(it.id);
  if it.status <> 'done' or it.data ->> 'verified' <> 'self_confirmed' then raise exception 'FAIL self-confirm path removed %', it.data; end if; c := c + 1;
  if (it.data ->> 'unverified')::boolean is not true or it.data ->> 'self_confirmed_by' <> 'client' or it.data ->> 'self_confirmed_at' is null then
    raise exception 'FAIL not recorded as unverified %', it.data; end if; c := c + 1;
  -- the client may read its own forwarding_test_passed event (activity log) but never the admin-only one
  select count(*) into n from public.events where type = 'forwarding_self_confirmed';
  if n <> 0 then raise exception 'FAIL client reads the admin-only event'; end if; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from public.events e where e.type = 'forwarding_self_confirmed' and e.entity_id = ca and not e.client_visible
     and e.payload ->> 'by' = 'client';
  if n <> 1 then raise exception 'FAIL admin event missing (%)', n; end if; c := c + 1;
  select count(*) into n from private.email_outbox o where o.template = 'admin_provisioning_alert' and o.entity_id = ca
     and o.payload ->> 'step' = 'forwarding_self_confirmed' and o.payload ->> 'error' like '%UNVERIFIED, self-confirmed by the client%';
  if n <> 1 then raise exception 'FAIL admin e-mail missing (%)', n; end if; c := c + 1;

  -- the admin view says so
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := (select x from jsonb_array_elements(public.admin_subscriptions_extra()) x where x ->> 'client_id' = ca::text);
  if r #>> '{forwarding,verified}' <> 'self_confirmed' or (r #>> '{forwarding,unverified}')::boolean is not true
     or r #>> '{forwarding,self_confirmed_by}' <> 'client' then raise exception 'FAIL admin view %', r -> 'forwarding'; end if; c := c + 1;
  -- the release / go-live parts of the admin read are still there
  if not (r ? 'release' and r ? 'golive') then raise exception 'FAIL admin extra lost its keys %', r; end if; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.admin_subscriptions_extra(); raise exception 'FAIL client read the admin extra';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- ================================================================ B: a real forward (ForwardedFrom = business line) stays verified
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select * into it from public.onboarding_items where client_id = cb and key = 'forward_calls';
  perform public.start_forwarding_test(it.id);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into public.calls (tenant_id, call_sid, from_e164, started_at, forwarded_from) values (tb, 'CA-fwd-ok', '+12815550177', now(), '7135550131');
  select * into it from public.onboarding_items where id = it.id;
  if it.status <> 'done' or it.data ->> 'verified' <> 'forwarded_from' or it.data ? 'unverified' then
    raise exception 'FAIL verified forward %', it.data; end if; c := c + 1;
  select count(*) into n from private.email_outbox o where o.entity_id = cb and o.payload ->> 'step' = 'forwarding_self_confirmed';
  if n <> 0 then raise exception 'FAIL admin e-mail for a verified forward'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := (select x from jsonb_array_elements(public.admin_subscriptions_extra()) x where x ->> 'client_id' = cb::text);
  if r #>> '{forwarding,verified}' <> 'forwarded_from' or (r #>> '{forwarding,unverified}')::boolean then
    raise exception 'FAIL admin view of a verified forward %', r -> 'forwarding'; end if; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  raise exception 'FORWARDING_SELF_CONFIRMED_TESTS_PASSED (% checks)', c;
end $$;
