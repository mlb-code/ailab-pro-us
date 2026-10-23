-- B7 migration checks (20261011101700_us_portal_b7.sql). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with PORTAL_B7_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/portal_b7_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); um uuid := gen_random_uuid(); uw uuid := gen_random_uuid();
  ca uuid; cb uuid; cw uuid; pa uuid; pw uuid; ta uuid; tb uuid; it uuid; ra uuid; rq uuid; ract uuid;
  n int; ok boolean; j jsonb; s1 text; sch jsonb; faq_max int; q_max int; a_max int; sms_max int; email_max int; c int := 0; t public.tenants;
begin
  update private.settings set admin_email = 'b7-admin@example.com' where id = 1;
  insert into auth.users (id, email) values (ua, 'b7-a@example.com'), (ub, 'b7-b@example.com'), (um, 'b7-admin@example.com'), (uw, 'b7-w@example.com');
  insert into public.clients (user_id, products, status) values (ua, '{RCP}', 'testing') returning id into ca;
  insert into public.clients (user_id, products, status) values (ub, '{BNDL}', 'onboarding') returning id into cb;
  insert into public.clients (user_id, products, status) values (uw, '{WEB}', 'onboarding') returning id into cw;
  insert into public.payments (client_id, kind, amount_cents, status) values (ca, 'deposit', 175000, 'due') returning id into pa;
  insert into public.payments (client_id, kind, amount_cents, status) values (cw, 'deposit', 95000, 'due') returning id into pw;
  insert into public.tenants (client_id, slug, twilio_number, config) values (ca, 'b7-a', '+17135550199', '{"hours":{}}') returning id into ta;
  insert into public.tenants (client_id, slug, config) values (cb, 'b7-b', '{}') returning id into tb;

  -- ---------------------------------------------------------------- 2. seeding on deposit paid
  select count(*) into n from public.onboarding_items where client_id = ca;
  if n <> 0 then raise exception 'FAIL items before deposit paid (%)', n; end if; c := c + 1;
  update public.payments set status = 'paid' where id = pa;
  select count(*) into n from public.onboarding_items where client_id = ca;
  if n <> 7 then raise exception 'FAIL RCP checklist has % items (want 7)', n; end if; c := c + 1;
  select string_agg(key, ',' order by sort) into s1 from public.onboarding_items where client_id = ca;
  if s1 <> 'forward_calls,calendar,hours,faq,alerts,tools,sms' then raise exception 'FAIL checklist order %', s1; end if; c := c + 1;
  update public.payments set reference = 'x' where id = pa;
  update public.payments set status = 'due' where id = pa;
  update public.payments set status = 'paid' where id = pa;
  select count(*) into n from public.onboarding_items where client_id = ca;
  if n <> 7 then raise exception 'FAIL re-paid duplicates items (%)', n; end if; c := c + 1;
  update public.payments set status = 'paid' where id = pw;
  select count(*) into n from public.onboarding_items where client_id = cw and key in ('hours', 'alerts', 'web_content');
  if n <> 3 or (select count(*) from public.onboarding_items where client_id = cw) <> 3 then raise exception 'FAIL WEB checklist'; end if; c := c + 1;
  select count(*) into n from public.onboarding_items where client_id = cb;
  if n <> 0 then raise exception 'FAIL B seeded without deposit'; end if; c := c + 1;
  select id into it from public.onboarding_items where client_id = ca and key = 'forward_calls';

  -- ---------------------------------------------------------------- client A
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  -- forwarding test: server stamps the start; returns the tenant number
  j := public.start_forwarding_test(it);
  if j ->> 'number' <> '+17135550199' then raise exception 'FAIL start_forwarding_test number %', j; end if; c := c + 1;
  select (data ? 'test_started_at') into ok from public.onboarding_items where id = it;
  if not ok then raise exception 'FAIL test_started_at not stored'; end if; c := c + 1;
  -- usage: own tenant yes, B no, admin function no
  j := public.client_tenant_usage(ta, null);
  if (j ->> 'voice_minutes')::numeric <> 0 then raise exception 'FAIL usage default %', j; end if; c := c + 1;
  begin perform public.client_tenant_usage(tb, null); raise exception 'FAIL A read B usage';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform * from public.admin_tenant_usage(null); raise exception 'FAIL client ran admin_tenant_usage';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.admin_save_tenant(ta, ca, 'b7-a', 'live', null, '{}'); raise exception 'FAIL client ran admin_save_tenant';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform 1 from public.runtime_state; raise exception 'FAIL client reads runtime_state';
  exception when insufficient_privilege then null; end; c := c + 1;
  -- requests: pause (queued only), cancel = delete queued only, logged
  insert into public.requests (client_id, title) values (ca, 'Pause me') returning id into ra;
  insert into public.requests (client_id, title) values (ca, 'Cancel me') returning id into rq;
  update public.requests set paused = true where id = ra;
  select paused into ok from public.requests where id = ra;
  if not ok then raise exception 'FAIL client cannot pause queued request'; end if; c := c + 1;
  delete from public.requests where id = rq;
  select count(*) into n from public.requests where id = rq;
  if n <> 0 then raise exception 'FAIL client cannot cancel queued request'; end if; c := c + 1;
  select count(*) into n from public.events where entity_id = rq and type = 'request_cancelled' and client_visible;
  if n <> 1 then raise exception 'FAIL cancel not logged (%)', n; end if; c := c + 1;
  -- tenant whitelist still holds for clients; after_hours + on_call_number are the two new keys
  begin perform public.update_tenant_settings(ta, '{"emergency":{"keywords":[]}}'); raise exception 'FAIL whitelist bypass';
  exception when others then if sqlerrm not like 'field_not_allowed%' then raise; end if; end; c := c + 1;
  begin perform public.update_tenant_settings(ta, '{"booking":{"provider":"fake"}}'); raise exception 'FAIL booking bypass';
  exception when others then if sqlerrm not like 'field_not_allowed%' then raise; end if; end; c := c + 1;
  update public.tenants set config = config || '{"x":1}' where id = ta;   -- RLS: client cannot write directly (0 rows)
  j := public.update_tenant_settings(ta, '{"after_hours":{"mode":"message_only"},"on_call_number":"+17135550111"}');
  if j -> 'after_hours' <> '{"mode":"message_only"}'::jsonb or j #>> '{handoff,mode}' <> 'dial' or j #>> '{handoff,number}' <> '+17135550111'
     or j #>> '{emergency,dial}' <> '+17135550111' or j ? 'on_call_number' or j ? 'x' then raise exception 'FAIL new whitelist keys %', j; end if; c := c + 1;
  j := public.update_tenant_settings(ta, '{"on_call_number":null}');
  if j #>> '{handoff,mode}' <> 'message' or jsonb_typeof(j #> '{emergency,dial}') <> 'null' then raise exception 'FAIL on_call_number null %', j; end if; c := c + 1;
  -- direct RPC calls (bypassing the UI): every value the runtime would reject is refused with invalid_setting:<path>.
  -- Limits are read from runtime/app/tenant_schema.json (the runner puts it in the setting b7.schema).
  sch := nullif(current_setting('b7.schema', true), '')::jsonb;
  if sch is null then raise exception 'FAIL runner did not pass runtime/app/tenant_schema.json'; end if;
  faq_max := (sch #>> '{properties,faq,maxItems}')::int;
  q_max := (sch #>> '{$defs,FaqItem,properties,q,maxLength}')::int;
  a_max := (sch #>> '{$defs,FaqItem,properties,a,maxLength}')::int;
  sms_max := (sch #>> '{$defs,Notify,properties,sms,maxItems}')::int;
  email_max := (sch #>> '{$defs,Notify,properties,email,maxItems}')::int;
  -- boundaries that must pass
  j := public.update_tenant_settings(ta, jsonb_build_object('faq', (select jsonb_agg(jsonb_build_object('q', repeat('q', q_max), 'a', repeat('a', a_max))) from generate_series(1, faq_max) g)));
  if jsonb_array_length(j -> 'faq') <> faq_max then raise exception 'FAIL faq at the schema limits refused'; end if; c := c + 1;
  for s1 in select jsonb_array_elements_text(sch #> '{$defs,AfterHours,properties,mode,enum}') loop
    j := public.update_tenant_settings(ta, jsonb_build_object('after_hours', jsonb_build_object('mode', s1)));
    if j #>> '{after_hours,mode}' <> s1 then raise exception 'FAIL after_hours %', s1; end if; c := c + 1;
  end loop;
  j := public.update_tenant_settings(ta, jsonb_build_object('notify', jsonb_build_object(
         'sms', (select jsonb_agg('+1713555' || lpad(g::text, 4, '0')) from generate_series(1, sms_max) g),
         'email', (select jsonb_agg('a' || g || '@example.com') from generate_series(1, email_max) g), 'daily_summary', '19:00')));
  if jsonb_array_length(j #> '{notify,sms}') <> sms_max then raise exception 'FAIL notify at the schema limits refused'; end if; c := c + 1;
  j := public.update_tenant_settings(ta, '{"notify":{"email":["only@example.com"],"daily_summary":null},"hours":{"mon":["00:00","23:59"],"sun":null}}');
  c := c + 1;
  -- everything the runtime rejects
  foreach s1 in array array[
    'faq' || '|' || (select jsonb_build_object('faq', jsonb_agg(jsonb_build_object('q', 'q', 'a', 'a'))) from generate_series(1, faq_max + 1) g)::text,
    'faq[0].a' || '|' || jsonb_build_object('faq', jsonb_build_array(jsonb_build_object('q', 'q', 'a', repeat('a', a_max + 1))))::text,
    'faq[0].q' || '|' || jsonb_build_object('faq', jsonb_build_array(jsonb_build_object('q', repeat('q', q_max + 1), 'a', 'a')))::text,
    'faq[0].q|{"faq":[{"q":"","a":"x"}]}', 'faq[1].a|{"faq":[{"q":"x","a":"y"},{"q":"x"}]}', 'faq[0]|{"faq":[{"q":"x","a":"y","z":1}]}',
    'faq|{"faq":{"q":"x"}}',
    'hours.mon|{"hours":{"mon":["18:00","08:00"]}}', 'hours.mon|{"hours":{"mon":["08:00","08:00"]}}', 'hours.tue|{"hours":{"tue":["24:00","25:00"]}}',
    'hours.wed|{"hours":{"wed":["8:00","17:00"]}}', 'hours.thu|{"hours":{"thu":["08:00"]}}', 'hours.xyz|{"hours":{"xyz":null}}', 'hours|{"hours":[]}',
    'notify.sms[0]|{"notify":{"sms":["+1713555"]}}', 'notify.sms[0]|{"notify":{"sms":["+447911123456"]}}', 'notify.sms[0]|{"notify":{"sms":["7135550100"]}}',
    'notify.sms[1]|{"notify":{"sms":["+17135550100","+1713555010"]}}', 'notify.sms[0]|{"notify":{"sms":["+11135550100"]}}',
    'notify.sms' || '|' || jsonb_build_object('notify', jsonb_build_object('sms', (select jsonb_agg('+1713555' || lpad(g::text, 4, '0')) from generate_series(1, sms_max + 1) g)))::text,
    'notify.email' || '|' || jsonb_build_object('notify', jsonb_build_object('email', (select jsonb_agg('a' || g || '@example.com') from generate_series(1, email_max + 1) g)))::text,
    'notify.email[0]|{"notify":{"email":["dani at example"]}}', 'notify|{"notify":{}}', 'notify|{"notify":{"sms":[],"email":[]}}',
    'notify|{"notify":{"daily_summary":"19:00"}}', 'notify|{"notify":{"email":["a@b.co"],"pager":["x"]}}',
    'notify.daily_summary|{"notify":{"email":["a@b.co"],"daily_summary":"7pm"}}',
    'after_hours.mode|{"after_hours":{"mode":"party"}}', 'after_hours|{"after_hours":{"mode":"message_only","x":1}}', 'after_hours.mode|{"after_hours":{}}',
    'on_call_number|{"on_call_number":"7135550111"}', 'on_call_number|{"on_call_number":"+447911123456"}', 'on_call_number|{"on_call_number":"+1713555011"}',
    'on_call_number|{"on_call_number":17135550111}', 'paused|{"paused":"yes"}',
    -- real_estate (2026-10-23): the client edits agent_name / screening / renters / meetings; follow_up_boss is ours
    'real_estate|{"real_estate":[]}', 'real_estate|{"real_estate":{"agent_name":"x","crm":1}}',
    'real_estate.follow_up_boss|{"real_estate":{"follow_up_boss":{"enabled":true}}}',
    'real_estate.follow_up_boss|{"real_estate":{"screening":["intent"],"follow_up_boss":{"enabled":false}}}',
    'real_estate.agent_name|{"real_estate":{"agent_name":123}}',
    'real_estate.agent_name' || '|' || jsonb_build_object('real_estate', jsonb_build_object('agent_name', repeat('a', (sch #>> '{$defs,RealEstate,properties,agent_name,maxLength}')::int + 1)))::text,
    'real_estate.screening|{"real_estate":{"screening":"intent"}}', 'real_estate.screening|{"real_estate":{"screening":["intent","intent"]}}',
    'real_estate.screening|{"real_estate":{"screening":["intent","zip_code"]}}', 'real_estate.screening|{"real_estate":{"screening":[1]}}',
    'real_estate.screening|{"real_estate":{"screening":["intent","area","timeline","price_range","pre_approval","property_address","motivation","has_agent","intent"]}}',
    'real_estate.renters|{"real_estate":{"renters":"yes"}}',
    'real_estate.meetings|{"real_estate":{"meetings":[]}}', 'real_estate.meetings.landlord|{"real_estate":{"meetings":{"landlord":"x"}}}',
    'real_estate.meetings.buyer|{"real_estate":{"meetings":{"buyer":""}}}', 'real_estate.meetings.seller|{"real_estate":{"meetings":{"seller":7}}}'] loop
    begin
      perform public.update_tenant_settings(ta, split_part(s1, '|', 2)::jsonb);
      raise exception 'FAIL accepted %', s1;
    exception when others then
      if sqlerrm <> 'invalid_setting:' || split_part(s1, '|', 1) then raise exception 'FAIL % -> % (want invalid_setting:%)', left(split_part(s1, '|', 2), 80), sqlerrm, split_part(s1, '|', 1); end if;
    end;
    c := c + 1;
  end loop;
  -- a refused patch changes nothing (atomic)
  select config into j from public.tenants where id = ta;
  begin perform public.update_tenant_settings(ta, '{"paused":true,"faq":[{"q":"x"}]}'); exception when others then null; end;
  if (select config from public.tenants where id = ta) <> j then raise exception 'FAIL refused patch partially applied'; end if; c := c + 1;
  -- real_estate (2026-10-23): accepted at the schema limits; the merge is one level deep so follow_up_boss (set by us) survives
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);   -- admin plants the CRM link
  perform public.update_tenant_settings(ta, '{"after_hours":{"mode":"book_next_day"}}');   -- (admin may call it too)
  update public.tenants set config = config || '{"real_estate":{"agent_name":"Old Name","screening":["intent"],"renters":false,"meetings":{"buyer":"Buyer consultation"},"follow_up_boss":{"enabled":true,"source":"Web","assigned_to":"jenna@example.com"}}}'::jsonb where id = ta;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  j := public.update_tenant_settings(ta, jsonb_build_object('real_estate', jsonb_build_object(
         'agent_name', repeat('n', (sch #>> '{$defs,RealEstate,properties,agent_name,maxLength}')::int),
         'screening', (select jsonb_agg(x) from jsonb_array_elements(sch #> '{$defs,RealEstate,properties,screening,items,enum}') x), 'renters', true)));
  if length(j #>> '{real_estate,agent_name}') <> (sch #>> '{$defs,RealEstate,properties,agent_name,maxLength}')::int
     or jsonb_array_length(j #> '{real_estate,screening}') <> (sch #>> '{$defs,RealEstate,properties,screening,maxItems}')::int
     or (j #>> '{real_estate,renters}') <> 'true' then raise exception 'FAIL real_estate at the schema limits refused %', j; end if; c := c + 1;
  if j #> '{real_estate,follow_up_boss}' <> '{"enabled":true,"source":"Web","assigned_to":"jenna@example.com"}'::jsonb
     or j #>> '{real_estate,meetings,buyer}' <> 'Buyer consultation' then raise exception 'FAIL real_estate merge dropped follow_up_boss / meetings %', j; end if; c := c + 1;
  j := public.update_tenant_settings(ta, '{"real_estate":{"screening":["has_agent","intent"],"meetings":{"seller":"Listing consultation","showing":"Home showing"}}}');
  if j #> '{real_estate,screening}' <> '["has_agent","intent"]'::jsonb or j #>> '{real_estate,agent_name}' not like 'nnn%'
     or j #>> '{real_estate,meetings,seller}' <> 'Listing consultation' or j #> '{real_estate,meetings}' ? 'buyer'
     or (j #>> '{real_estate,follow_up_boss,enabled}') <> 'true' then raise exception 'FAIL real_estate partial patch %', j; end if; c := c + 1;
  j := public.update_tenant_settings(ta, '{"real_estate":{"agent_name":"","screening":[]}}');
  if j #>> '{real_estate,agent_name}' <> '' or jsonb_array_length(j #> '{real_estate,screening}') <> 0 then raise exception 'FAIL real_estate empty values %', j; end if; c := c + 1;
  if (select config -> 'after_hours' from public.tenants where id = ta) <> '{"mode":"book_next_day"}'::jsonb then raise exception 'FAIL real_estate patch touched other keys'; end if; c := c + 1;
  begin perform public.update_tenant_settings(tb, '{"after_hours":{"mode":"message_only"}}'); raise exception 'FAIL A wrote B settings';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- ---------------------------------------------------------------- client B cannot touch A
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  begin perform public.start_forwarding_test(it); raise exception 'FAIL B started A test';
  exception when insufficient_privilege then null; end; c := c + 1;
  delete from public.requests where id = ra;
  select count(*) into n from public.requests where id = ra;
  -- B sees 0 rows under RLS; check as owner below

  -- ---------------------------------------------------------------- admin: activate A's request; client can no longer cancel it
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  select count(*) into n from public.requests where id = ra;
  if n <> 1 then raise exception 'FAIL B deleted A request'; end if; c := c + 1;
  begin update public.requests set status = 'active' where id = ra; raise exception 'FAIL paused request activated';
  exception when others then if sqlerrm <> 'request_paused' then raise; end if; end; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  update public.requests set paused = false where id = ra;   -- client resumes
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  update public.requests set status = 'active' where id = ra;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  delete from public.requests where id = ra;
  update public.requests set paused = true where id = ra;
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  select count(*) into n from public.requests where id = ra and status = 'active' and not paused;
  if n <> 1 then raise exception 'FAIL client changed an active request'; end if; c := c + 1;

  -- admin save tenant (insert + update) + event
  t := public.admin_save_tenant(null, cb, 'b7-b2', 'sandbox', '+17135550123', '{"business":{"name":"X"}}');
  if t.slug <> 'b7-b2' or t.twilio_number <> '+17135550123' then raise exception 'FAIL admin_save_tenant insert'; end if; c := c + 1;
  t := public.admin_save_tenant(t.id, cb, 'b7-b2', 'live', '', '{"paused":true}');
  if t.status <> 'live' or t.twilio_number is not null or t.config <> '{"paused":true}'::jsonb then raise exception 'FAIL admin_save_tenant update'; end if; c := c + 1;
  select count(*) into n from public.events where entity_id = t.id and type in ('tenant_created', 'tenant_saved');
  if n <> 2 then raise exception 'FAIL tenant events %', n; end if; c := c + 1;
  begin perform public.admin_save_tenant(t.id, cb, 'b7-b2', 'live', null, '[]'); raise exception 'FAIL array config accepted';
  exception when others then if sqlerrm <> 'config_must_be_object' then raise; end if; end; c := c + 1;

  -- ---------------------------------------------------------------- runtime (service role): usage rows + a forwarded test call
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  insert into public.runtime_state (key, tenant_id, value) values
    ('usage:' || ta || ':' || to_char(now() at time zone 'utc', 'YYYY-MM') || ':voice_minutes', ta, '212'),
    ('usage:' || ta || ':' || to_char(now() at time zone 'utc', 'YYYY-MM') || ':sms_segments', ta, '480.0'),
    ('usage:' || ta || ':' || to_char(now() at time zone 'utc', 'YYYY-MM') || ':needs_addon_approval', ta, 'true'),
    ('spend:' || ta || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'), ta, '0.84'),
    ('spend:' || ta || ':' || to_char(now() at time zone 'utc', 'YYYY-MM') || '-01x', ta, '{"usd": 1.16}'),
    ('cost:twilio:' || ta || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'), ta, '2.5'),
    ('convo:' || ta || ':secret', ta, '{"history":"private"}');
  insert into public.calls (tenant_id, call_sid, from_e164, started_at, outcome) values (ta, 'CA_b7_test', '+17135550100', now(), 'message');
  select status = 'done' and data ? 'test_call_id' into ok from public.onboarding_items where id = it;
  if not ok then raise exception 'FAIL forwarded test call did not mark forward_calls done'; end if; c := c + 1;
  -- a call with garbage test data never breaks the runtime insert
  update public.onboarding_items set status = 'todo', data = '{"test_started_at":"not a date"}' where id = it;
  insert into public.calls (tenant_id, call_sid, started_at) values (ta, 'CA_b7_test2', now());
  select status = 'todo' into ok from public.onboarding_items where id = it;
  if not ok then raise exception 'FAIL garbage test data'; end if; c := c + 1;
  begin perform * from public.admin_tenant_usage(null); raise exception 'FAIL service role ran admin_tenant_usage';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- admin reads usage + costs (only whitelisted key prefixes)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  select (u.voice_minutes = 212 and u.sms_segments = 480 and u.needs_addon_approval and u.claude_usd = 2.00 and u.twilio_usd = 2.5)
    into ok from public.admin_tenant_usage(null) u where u.tenant_id = ta;
  if not coalesce(ok, false) then raise exception 'FAIL admin usage numbers'; end if; c := c + 1;
  select count(*) into n from public.admin_tenant_usage(null);
  if n < 3 then raise exception 'FAIL admin usage lists every tenant (%)', n; end if; c := c + 1;
  begin perform * from public.admin_tenant_usage('2026-1x'); raise exception 'FAIL bad month accepted';
  exception when others then if sqlerrm <> 'bad_month' then raise; end if; end; c := c + 1;

  -- client A: usage counts, no cost fields
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  j := public.client_tenant_usage(ta, null);
  if (j ->> 'voice_minutes')::numeric <> 212 or (j ->> 'sms_segments')::numeric <> 480 or not (j ->> 'needs_addon_approval')::boolean
     or j ? 'claude_usd' then raise exception 'FAIL client usage %', j; end if; c := c + 1;
  -- go-live gate: refused while items are open (no event, final_payment_due:<client> not enqueued)
  begin
    perform public.update_onboarding_item((select id from public.onboarding_items where client_id = ca and key = 'sms'), 'done', '{"go_live_requested_at":"2026-10-11T09:00:00Z"}');
    raise exception 'FAIL early go-live accepted';
  exception when others then if sqlerrm <> 'go_live_not_ready' then raise; end if; end; c := c + 1;
  select count(*) into n from public.events where entity_id = ca and type = 'go_live_requested';
  if n <> 0 then raise exception 'FAIL early go-live logged'; end if; c := c + 1;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  if to_regclass('private.email_outbox') is not null then
    execute 'select count(*) from private.email_outbox where idem_key = $1' into n using 'final_payment_due:' || ca;
    if n <> 0 then raise exception 'FAIL final_payment_due key burned early'; end if;
  end if; c := c + 1;
  update public.onboarding_items set status = 'done' where client_id = ca and key <> 'tools';
  update public.onboarding_items set status = 'todo' where client_id = ca and key = 'tools';   -- optional item may stay open
  update public.clients set status = 'onboarding' where id = ca;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin
    perform public.update_onboarding_item((select id from public.onboarding_items where client_id = ca and key = 'sms'), 'done', '{"go_live_requested_at":"2026-10-11T09:30:00Z"}');
    raise exception 'FAIL go-live accepted while not testing';
  exception when others then if sqlerrm <> 'go_live_not_ready' then raise; end if; end; c := c + 1;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  update public.clients set status = 'testing' where id = ca;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  -- go-live request event (stamped on the last item, once)
  perform public.update_onboarding_item((select id from public.onboarding_items where client_id = ca and key = 'sms'), 'done', '{"go_live_requested_at":"2026-10-11T10:00:00Z"}');
  perform public.update_onboarding_item((select id from public.onboarding_items where client_id = ca and key = 'sms'), 'done', '{"go_live_requested_at":"2026-10-11T11:00:00Z"}');
  select count(*) into n from public.events where entity = 'client' and entity_id = ca and type = 'go_live_requested' and client_visible;
  if n <> 1 then raise exception 'FAIL go_live_requested event (%)', n; end if; c := c + 1;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  if to_regclass('private.email_outbox') is not null then
    execute 'select count(*) from private.email_outbox where idem_key = $1' into n using 'final_payment_due:' || ca;
    if n <> 1 then raise exception 'FAIL final_payment_due not enqueued once after a valid request (%)', n; end if;
  end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- ---------------------------------------------------------------- anon: nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform public.client_tenant_usage(ta, null); raise exception 'FAIL anon usage';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.start_forwarding_test(it); raise exception 'FAIL anon forwarding test';
  exception when insufficient_privilege then null; end; c := c + 1;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  raise exception 'PORTAL_B7_TESTS_PASSED (% checks)', c;
end $$;
