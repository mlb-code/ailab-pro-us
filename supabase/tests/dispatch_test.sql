-- ADD-DISPATCH migration checks (20261023100000_us_dispatch.sql). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with DISPATCH_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/dispatch_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  ca uuid; cb uuid; ta uuid; tb uuid; n int; j jsonb; s1 text; s2 text; c int := 0; bad text;
  good constant jsonb := '{"callback_minutes":20,"daytime_too":false,
    "contacts":[{"id":"dan","name":" Dan ","phone":"+17135550201","role":"tech","opt_in":true},
                {"id":"maria","name":"Maria","phone":"+17135550203","role":"manager","opt_in":false}],
    "schedule":[{"day":"mon","start":"18:00","end":"07:00","contacts":["dan","maria"]}]}';
begin
  insert into auth.users (id, email) values (ua, 'd-a@example.com'), (ub, 'd-b@example.com');
  insert into public.clients (user_id, products, status) values (ua, '{RCP}', 'live') returning id into ca;
  insert into public.clients (user_id, products, status) values (ub, '{RCP}', 'live') returning id into cb;
  insert into public.tenants (client_id, slug, config) values (ca, 'd-a', '{"dispatch":{"enabled":true,"sms_alerts":false}}') returning id into ta;
  insert into public.tenants (client_id, slug, config) values (cb, 'd-b', '{}') returning id into tb;
  insert into public.dispatch_events (tenant_id, call_sid, leg, contact_name, result, wait_s) values
    (ta, 'CA-a', 0, 'Dan', 'no_answer', null), (tb, 'CA-b', 0, 'Bo', 'accepted', 9);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  -- save: contacts + schedule; opt-in stamped by the server; admin-only keys untouched
  j := public.update_dispatch_settings(ta, good);
  if j ->> 'enabled' <> 'true' or j ->> 'sms_alerts' <> 'false' or (j ->> 'callback_minutes')::int <> 20 then raise exception 'FAIL merge %', j; end if; c := c + 1;
  if j #>> '{contacts,0,name}' <> 'Dan' or j #>> '{contacts,0,alerts_opt_in_at}' is null or jsonb_typeof(j #> '{contacts,1,alerts_opt_in_at}') <> 'null'
     or j #> '{contacts,0}' ? 'opt_in' then raise exception 'FAIL contacts %', j -> 'contacts'; end if; c := c + 1;
  s1 := j #>> '{contacts,0,alerts_opt_in_at}';
  j := public.update_dispatch_settings(ta, good);
  if j #>> '{contacts,0,alerts_opt_in_at}' <> s1 then raise exception 'FAIL opt-in stamp not kept'; end if; c := c + 1;
  -- whitelist + validation (each must raise)
  foreach bad in array array[
    '{"enabled":true}', '{"sms_alerts":true}', '{"callback_minutes":2}', '{"callback_minutes":"15"}', '{"daytime_too":"yes"}',
    '{"contacts":[{"id":"a","name":"A","phone":"+447700900123"}]}', '{"contacts":[{"id":"A!","name":"A","phone":"+17135550201"}]}',
    '{"contacts":[{"id":"a","name":"A","phone":"+17135550201"},{"id":"b","name":"B","phone":"+17135550201"}]}',
    '{"contacts":[{"id":"a","name":"","phone":"+17135550201"}]}', '{"contacts":[{"id":"a","name":"A","phone":"+17135550201","role":"boss"}]}',
    '{"contacts":[{"id":"a","name":"A","phone":"+17135550201","x":1}]}', '{"contacts":[]}',
    '{"schedule":[{"day":"mon","start":"18:00","end":"07:00","contacts":["ghost"]}]}',
    '{"schedule":[{"day":"funday","start":"18:00","end":"07:00","contacts":["dan"]}]}',
    '{"schedule":[{"day":"mon","start":"25:00","end":"07:00","contacts":["dan"]}]}',
    '{"contacts":[{"id":"x","name":"X","phone":"+17135550209"}]}'] loop
    begin
      perform public.update_dispatch_settings(ta, bad::jsonb);
      raise exception 'FAIL accepted %', bad;
    exception when sqlstate 'P0001' then
      if sqlerrm like 'FAIL%' then raise; end if;
    end;
    c := c + 1;
  end loop;
  -- other tenant / events isolation
  begin perform public.update_dispatch_settings(tb, good); raise exception 'FAIL A wrote B';
  exception when insufficient_privilege then null; end; c := c + 1;
  select count(*) into n from public.dispatch_events;
  if n <> 1 then raise exception 'FAIL A sees % dispatch rows', n; end if; c := c + 1;
  begin insert into public.dispatch_events (tenant_id, result) values (ta, 'handled'); raise exception 'FAIL client inserted';
  exception when insufficient_privilege then null; end; c := c + 1;
  -- handled: once, only for a call that has a dispatch log
  perform public.mark_dispatch_handled(ta, 'CA-a');
  perform public.mark_dispatch_handled(ta, 'CA-a');
  select count(*) into n from public.dispatch_events where call_sid = 'CA-a' and result = 'handled';
  if n <> 1 then raise exception 'FAIL handled rows %', n; end if; c := c + 1;
  begin perform public.mark_dispatch_handled(ta, 'CA-none'); raise exception 'FAIL handled unknown call';
  exception when sqlstate 'P0002' then null; end; c := c + 1;
  begin perform public.mark_dispatch_handled(tb, 'CA-b'); raise exception 'FAIL A handled B';
  exception when insufficient_privilege then null; end; c := c + 1;
  -- opt-out of the alerts by the owner: revoked row
  perform public.update_dispatch_settings(ta, jsonb_set(good, '{contacts,0,opt_in}', 'false'));

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  select string_agg(decision, ',' order by decision) into s2 from public.sms_consent
   where tenant_id = ta and consent_type = 'staff_alerts' and contact_e164 = '+17135550201';
  if s2 <> 'revoked,yes' then raise exception 'FAIL consent log %', s2; end if; c := c + 1;
  select count(*) into n from public.sms_consent where tenant_id = ta and contact_e164 = '+17135550203';
  if n <> 0 then raise exception 'FAIL consent row without opt-in'; end if; c := c + 1;

  -- anon: nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform public.mark_dispatch_handled(ta, 'CA-a'); raise exception 'FAIL anon handled';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform 1 from public.dispatch_events; raise exception 'FAIL anon reads events';
  exception when insufficient_privilege then null; end; c := c + 1;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  raise exception 'DISPATCH_TESTS_PASSED (% checks)', c;
end $$;
