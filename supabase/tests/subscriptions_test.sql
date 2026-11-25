-- FirstRing subscriptions (20261125100000_us_subscriptions.sql). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with SUBSCRIPTIONS_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/subscriptions_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ad uuid := gen_random_uuid();
  uq uuid := gen_random_uuid();
  r jsonb; r2 jsonb; ca uuid; ta uuid; t public.tenants; cl public.clients; sub public.subscriptions; n int; c int := 0;
  it public.onboarding_items; cfg jsonb; s text; callid uuid; cq uuid; tq uuid;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ua, 'owner-a@example.com'), (ub, 'owner-b@example.com'), (uc, 'owner-c@example.com'),
    (ad, 'admin-sub@example.com'), (uq, 'quote-q@example.com');
  update public.profiles set company = 'Cool Breeze HVAC', phone = '(713) 555-0100', timezone = null where id = ua;
  update public.profiles set company = 'Bee Plumbing', phone = '+13125550111', timezone = 'America/Chicago' where id = ub;
  update public.profiles set company = 'Copycat HVAC', phone = '713-555-0100' where id = uc;
  update public.profiles set is_admin = true where id = ad;
  update private.settings set billing_mock_enabled = false where id = 1;

  -- ---------------------------------------------------------------- mock checkout is OFF by default
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.billing_mock_checkout('FR_STARTER'); raise exception 'FAIL mock checkout while disabled';
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update private.settings set billing_mock_enabled = true where id = 1;

  -- ---------------------------------------------------------------- A signs up (mock trial): automatic setup
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 14);
  if r ->> 'status' <> 'trialing' or (r ->> 'tenant_id') is null then raise exception 'FAIL checkout %', r; end if; c := c + 1;
  ca := (r ->> 'client_id')::uuid; ta := (r ->> 'tenant_id')::uuid;
  begin perform public.billing_mock_checkout('FR_PRO'); raise exception 'FAIL second checkout';
  exception when sqlstate 'P0001' then if sqlerrm <> 'already_subscribed' then raise exception 'FAIL second checkout: %', sqlerrm; end if; end; c := c + 1;
  r := public.client_billing();
  if r #>> '{subscription,plan_code}' <> 'FR_STARTER' or r #>> '{service,mode}' <> 'full' or r ->> 'number' is not null
     or r #>> '{setup,0,status}' <> 'working' or r #>> '{period,label}' !~ '^p[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' then
    raise exception 'FAIL client_billing %', r; end if; c := c + 1;
  -- client cannot write subscriptions or read jobs
  begin update public.subscriptions set status = 'active' where client_id = ca;
    get diagnostics n = row_count; if n > 0 then raise exception 'FAIL client updated its subscription'; end if;
  exception when insufficient_privilege then null; end; c := c + 1;
  select count(*) into n from public.provisioning_jobs; if n <> 0 then raise exception 'FAIL client reads jobs'; end if; c := c + 1;
  begin perform public.billing_upsert_subscription('mock', 'mock_x', 'active', 'FR_PRO', ua);
    raise exception 'FAIL client called the webhook contract';
  exception when insufficient_privilege then null; end; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into cl from public.clients where id = ca;
  select * into t from public.tenants where id = ta;
  if cl.billing_mode <> 'subscription' or cl.status <> 'onboarding' or cl.products <> '{RCP}' or cl.business_name <> 'Cool Breeze HVAC' then
    raise exception 'FAIL client card %', to_jsonb(cl); end if; c := c + 1;
  if t.slug <> 'cool-breeze-hvac' or t.status <> 'sandbox' or t.twilio_number is not null
     or t.config #>> '{business,name}' <> 'Cool Breeze HVAC' or t.config #>> '{business,timezone}' <> 'America/Chicago'  -- 713 = Houston
     or t.config #>> '{business,main_phone}' <> '+17135550100' or t.config #>> '{notify,email,0}' <> 'owner-a@example.com'
     or t.config #>> '{plan,code}' <> 'FR_STARTER' or t.config #>> '{plan,status}' <> 'trialing' or t.config #>> '{plan,service}' <> 'full'
     or t.config #>> '{voice,greeting}' <> '' or jsonb_array_length(t.config #> '{booking,job_types}') < 1 then
    raise exception 'FAIL tenant config %', t.config; end if; c := c + 1;
  select string_agg(key, ',' order by sort) into s from public.onboarding_items where client_id = ca;
  if s <> 'hours,faq,alerts,calendar,tools,forward_calls,sms' then raise exception 'FAIL checklist order %', s; end if; c := c + 1;
  select count(*) into n from public.provisioning_jobs where tenant_id = ta and kind = 'number' and status = 'pending';
  if n <> 1 then raise exception 'FAIL number job'; end if; c := c + 1;

  -- ---------------------------------------------------------------- the webhook contract: idempotent, stale events ignored
  select * into sub from public.subscriptions where client_id = ca;
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.billing_upsert_subscription('mock', sub.provider_subscription_id, 'trialing', 'FR_STARTER', null, null, sub.trial_ends_at,
         null, null, null, true, null, null, now() + interval '1 second');
  r2 := public.billing_upsert_subscription('mock', sub.provider_subscription_id, 'trialing', 'FR_STARTER', null, null, sub.trial_ends_at,
         null, null, null, true, null, null, now() + interval '1 second');
  if (r ->> 'subscription_id') <> (r2 ->> 'subscription_id') then raise exception 'FAIL upsert not idempotent'; end if; c := c + 1;
  r := public.billing_upsert_subscription('mock', sub.provider_subscription_id, 'canceled', 'FR_STARTER', null, null, null, null, null,
         null, null, null, null, now() - interval '1 hour');
  if (r ->> 'stale')::boolean is not true then raise exception 'FAIL stale event applied %', r; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from public.subscriptions where client_id = ca; if n <> 1 then raise exception 'FAIL % subscriptions', n; end if;
  select count(*) into n from public.tenants where client_id = ca; if n <> 1 then raise exception 'FAIL % tenants', n; end if;
  select count(*) into n from public.provisioning_jobs where tenant_id = ta; if n <> 1 then raise exception 'FAIL % jobs', n; end if; c := c + 1;
  -- a new subscription id needs the user
  begin perform public.billing_upsert_subscription('paddle', 'sub_new', 'active', 'FR_PRO'); raise exception 'FAIL no user accepted';
  exception when sqlstate 'P0001' then if sqlerrm <> 'user_required' then raise; end if; end; c := c + 1;
  foreach s in array array['bad status', 'free'] loop
    begin perform public.billing_upsert_subscription('mock', 'mock_bad', s, 'FR_PRO', ua); raise exception 'FAIL bad status %', s;
    exception when sqlstate 'P0001' then if sqlerrm like 'FAIL%' then raise; end if; end;
  end loop; c := c + 1;

  -- ---------------------------------------------------------------- one trial per business phone
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  if (public.billing_trial_eligible() ->> 'eligible')::boolean then raise exception 'FAIL same phone eligible'; end if;
  begin perform public.billing_mock_checkout('FR_STARTER'); raise exception 'FAIL second trial for the same phone';
  exception when sqlstate 'P0001' then if sqlerrm <> 'trial_already_used' then raise; end if; end; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  r := public.billing_upsert_subscription('paddle', 'sub_dup', 'trialing', 'FR_STARTER', uc, 'ctm_1', now() + interval '14 days');
  if (r ->> 'trial_duplicate')::boolean is not true then raise exception 'FAIL duplicate not flagged %', r; end if;
  select count(*) into n from public.provisioning_jobs j join public.tenants x on x.id = j.tenant_id
   where x.client_id = (r ->> 'client_id')::uuid and j.status = 'held';
  if n <> 1 then raise exception 'FAIL duplicate trial number not held'; end if;
  select count(*) into n from private.email_outbox where template = 'admin_provisioning_alert' and entity_id = (r ->> 'client_id')::uuid;
  if n <> 1 then raise exception 'FAIL duplicate trial: no note to Meir'; end if; c := c + 1;

  -- ---------------------------------------------------------------- B cannot see A
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.subscriptions; if n <> 0 then raise exception 'FAIL B sees % subscriptions', n; end if;
  if public.client_billing() ->> 'subscription' is not null then raise exception 'FAIL B billing'; end if;
  begin perform public.admin_subscriptions(); raise exception 'FAIL non-admin list'; exception when insufficient_privilege then null; end;
  begin perform public.admin_retry_provisioning(ca, 'number'); raise exception 'FAIL non-admin retry'; exception when insufficient_privilege then null; end;
  c := c + 1;
  perform set_config('role', 'anon', true); perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform public.client_billing(); raise exception 'FAIL anon billing';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- ---------------------------------------------------------------- the runtime buys the number (job done)
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.tenants set twilio_number = '+17135550142' where id = ta;
  update public.provisioning_jobs set status = 'done', result = '{"number": "+17135550142", "dry_run": true}', dry_run = true
   where tenant_id = ta and kind = 'number';
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from public.events where entity_id = ta and type = 'number_assigned' and client_visible;
  if n <> 1 then raise exception 'FAIL number_assigned event'; end if; c := c + 1;

  -- ---------------------------------------------------------------- checklist saves go straight into the live config
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select * into it from public.onboarding_items where client_id = ca and key = 'hours';
  perform public.update_onboarding_item(it.id, 'done', '{"timezone": "America/New_York", "hours": {"mon": ["07:00", "18:00"], "tue": ["07:00", "18:00"], "sat": null}, "after_hours": {"mode": "message_only"}}');
  select * into it from public.onboarding_items where client_id = ca and key = 'faq';
  perform public.update_onboarding_item(it.id, 'done', jsonb_build_object('services', jsonb_build_array('AC repair', 'Furnace repair'),
    'faq', jsonb_build_array(jsonb_build_object('q', 'Do you service Trane units?', 'a', 'Yes, all major brands.')),
    'service_area', '77005, 77006, Bellaire, Harris County; West University Place 77005',
    'price_on_phone', 'fixed', 'fixed_prices', jsonb_build_array('Service call: $89', 'Drain cleaning - 150', 'AC tune-up $79.99 (per unit)', 'call us')));
  select * into it from public.onboarding_items where client_id = ca and key = 'alerts';
  perform public.update_onboarding_item(it.id, 'done', '{"notify": {"sms": [], "email": ["dispatch@coolbreeze.example"], "daily_summary": null}, "on_call_number": "+17135550188", "emergency": {"keywords": ["gas smell", "flooding"]}}');
  select config into cfg from public.tenants where id = ta;
  if cfg #>> '{business,timezone}' <> 'America/New_York' or cfg #>> '{hours,mon,0}' <> '07:00' or cfg #>> '{after_hours,mode}' <> 'message_only'
     or cfg #> '{booking,job_types}' <> '["AC repair", "Furnace repair"]' or cfg #>> '{faq,0,a}' <> 'Yes, all major brands.'
     or cfg #> '{business,service_area_zips}' <> '["77005", "77006"]'
     or cfg #> '{business,service_area_places}' <> '["Bellaire", "Harris County", "West University Place"]'
     or cfg #>> '{pricing,mode}' <> 'listed' or jsonb_array_length(cfg #> '{pricing,items}') <> 3
     or cfg #> '{pricing,items,0}' <> '{"name": "Service call", "note": "", "price_usd": 89}'
     or cfg #> '{pricing,items,1}' <> '{"name": "Drain cleaning", "note": "", "price_usd": 150}'
     or cfg #> '{pricing,items,2}' <> '{"name": "AC tune-up", "note": "per unit", "price_usd": 79.99}'
     or cfg #>> '{notify,email,0}' <> 'dispatch@coolbreeze.example' or cfg #>> '{handoff,mode}' <> 'dial'
     or cfg #>> '{emergency,dial}' <> '+17135550188' or cfg #> '{emergency,keywords}' <> '["gas smell", "flooding"]'
     or cfg #>> '{plan,code}' <> 'FR_STARTER' then
    raise exception 'FAIL merged config %', cfg; end if; c := c + 1;
  -- fixed prices that cannot be read -> the safe mode, never "listed" with no items
  select * into it from public.onboarding_items where client_id = ca and key = 'faq';
  perform public.update_onboarding_item(it.id, 'done', '{"price_on_phone": "fixed", "fixed_prices": ["ask us"]}');
  if (select config #>> '{pricing,mode}' from public.tenants where id = ta) <> 'none' then raise exception 'FAIL unreadable prices'; end if; c := c + 1;
  perform public.update_onboarding_item(it.id, 'done', '{"price_on_phone": "fixed", "fixed_prices": ["Service call: $89"]}');
  -- invalid input: a clear field error, config and item unchanged
  foreach s in array array['{"faq": [{"q": "Q?", "a": "' || repeat('y', 601) || '"}]}', '{"services": []}'] loop
    begin perform public.update_onboarding_item(it.id, 'done', s::jsonb); raise exception 'FAIL accepted %', left(s, 40);
    exception when sqlstate 'P0001' then if sqlerrm not like 'invalid_setting:%' then raise exception 'FAIL error %', sqlerrm; end if; end;
  end loop;
  select * into it from public.onboarding_items where id = it.id;
  if (it.data -> 'faq' -> 0 ->> 'a') <> 'Yes, all major brands.' then raise exception 'FAIL item changed by a refused save'; end if; c := c + 1;
  select * into it from public.onboarding_items where client_id = ca and key = 'hours';
  begin perform public.update_onboarding_item(it.id, 'done', '{"timezone": "Mars/Olympus"}'); raise exception 'FAIL bad tz';
  exception when sqlstate 'P0001' then if sqlerrm <> 'invalid_setting:business.timezone' then raise; end if; end; c := c + 1;

  -- ---------------------------------------------------------------- calendar: a link alone is not "connected"
  select * into it from public.onboarding_items where client_id = ca and key = 'calendar';
  begin perform public.update_onboarding_item(it.id, 'done', '{"provider": "calendly", "booking_link": "https://calendly.com/coolbreeze/visit"}');
    raise exception 'FAIL link alone marked the calendar done';
  exception when sqlstate 'P0001' then if sqlerrm <> 'calendar_not_connected' then raise; end if; end; c := c + 1;
  perform public.update_onboarding_item(it.id, 'todo', '{"provider": "calendly", "booking_link": "https://calendly.com/coolbreeze/visit"}');
  if (select config #>> '{booking,booking_link}' from public.tenants where id = ta) <> 'https://calendly.com/coolbreeze/visit' then
    raise exception 'FAIL link not merged'; end if;
  perform public.update_onboarding_item(it.id, 'done', '{"booking_mode": "messages_only"}');
  if (select config #>> '{booking,enabled}' from public.tenants where id = ta) <> 'false' then raise exception 'FAIL messages-only'; end if; c := c + 1;
  select * into it from public.onboarding_items where client_id = ca and key = 'tools';
  perform public.update_onboarding_item(it.id, 'done', '{"skipped": true, "zapier_webhook_url": null}');

  -- ---------------------------------------------------------------- forwarding test: must come through the business line
  select * into it from public.onboarding_items where client_id = ca and key = 'forward_calls';
  perform public.start_forwarding_test(it.id);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into public.calls (tenant_id, call_sid, from_e164, started_at, forwarded_from) values (ta, 'CA-mis', '+12815550177', now(), '+18325550000');
  select * into it from public.onboarding_items where id = it.id;
  if it.status = 'done' or it.data ->> 'test_mismatch_from' <> '+18325550000' then raise exception 'FAIL mismatch accepted %', it.data; end if; c := c + 1;
  insert into public.calls (tenant_id, call_sid, from_e164, started_at) values (ta, 'CA-direct', '+17135550100', now());
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.confirm_forwarding_test(it.id); raise exception 'FAIL direct call confirmed';
  exception when sqlstate 'P0001' then if sqlerrm <> 'called_directly' then raise; end if; end; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into public.calls (tenant_id, call_sid, from_e164, started_at, forwarded_from) values (ta, 'CA-ok', '+12815550177', now(), '7135550100')
    returning id into callid;
  select * into it from public.onboarding_items where id = it.id;
  if it.status <> 'done' or it.data ->> 'verified' <> 'forwarded_from' then raise exception 'FAIL forwarded call not accepted %', it.data; end if; c := c + 1;

  -- ---------------------------------------------------------------- checklist done -> testing + go-live check -> live
  select * into cl from public.clients where id = ca;
  if cl.status <> 'testing' then raise exception 'FAIL status after checklist %', cl.status; end if;
  select count(*) into n from public.provisioning_jobs where tenant_id = ta and kind = 'golive_sim' and status = 'pending';
  if n <> 1 then raise exception 'FAIL golive job'; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.provisioning_jobs set status = 'failed', result = '{"passed": false, "failed": ["booking"]}' where tenant_id = ta and kind = 'golive_sim';
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from public.clients where id = ca) <> 'testing' then raise exception 'FAIL live on a failed check'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  perform public.admin_retry_provisioning(ca, 'golive_sim');
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  update public.provisioning_jobs set status = 'done', result = '{"passed": true, "failed": []}' where tenant_id = ta and kind = 'golive_sim';
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into cl from public.clients where id = ca; select * into t from public.tenants where id = ta;
  if cl.status <> 'live' or t.status <> 'live' or cl.go_live_at is null then raise exception 'FAIL auto go-live % %', cl.status, t.status; end if;
  select string_agg(template, ',' order by template) into s from private.email_outbox where entity_id = ca and template in ('ready_to_test', 'went_live', 'final_payment_due');
  if s <> 'ready_to_test,went_live' then raise exception 'FAIL go-live mails %', s; end if; c := c + 1;
  if (private.email_context((select id from private.email_outbox where entity_id = ca and template = 'went_live')) #>> '{client,billing_mode}') <> 'subscription' then
    raise exception 'FAIL email context billing_mode'; end if; c := c + 1;

  -- ---------------------------------------------------------------- usage per billing period
  insert into public.runtime_state (key, tenant_id, value) values
    ('usage:' || ta || ':' || 'p' || (select config #>> '{plan,period_start}' from public.tenants where id = ta) || ':voice_minutes', ta, '42');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if (public.client_billing() #>> '{usage,voice_minutes}')::numeric <> 42 then raise exception 'FAIL period usage'; end if; c := c + 1;

  -- ---------------------------------------------------------------- upgrade now, downgrade next period, cancel, resume
  r := public.billing_change_plan('FR_PRO');
  if (select plan_code from public.subscriptions where client_id = ca) <> 'FR_PRO' then raise exception 'FAIL trial upgrade %', r; end if;
  r := public.billing_change_plan('FR_STARTER', true);   -- start the paid plan now (trial minutes used up)
  select * into sub from public.subscriptions where client_id = ca;
  if sub.status <> 'active' or sub.plan_code <> 'FR_STARTER' or sub.current_period_end is null then raise exception 'FAIL start now %', to_jsonb(sub); end if;
  r := public.billing_change_plan('FR_BUSINESS');
  if (select plan_code from public.subscriptions where client_id = ca) <> 'FR_BUSINESS' then raise exception 'FAIL upgrade'; end if;
  r := public.billing_change_plan('FR_PRO');
  select * into sub from public.subscriptions where client_id = ca;
  if sub.plan_code <> 'FR_BUSINESS' or sub.scheduled_plan_code <> 'FR_PRO' then raise exception 'FAIL downgrade not scheduled %', to_jsonb(sub); end if;
  if (select config #>> '{plan,code}' from public.tenants where id = ta) <> 'FR_BUSINESS' then raise exception 'FAIL plan block'; end if; c := c + 1;
  r := public.billing_cancel();
  select * into sub from public.subscriptions where client_id = ca;
  if not sub.cancel_at_period_end or (select config #>> '{plan,service}' from public.tenants where id = ta) <> 'full' then
    raise exception 'FAIL cancel at period end'; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set current_period_end = now() - interval '1 minute', scheduled_plan_code = null where client_id = ca;
  perform private.billing_sync();
  select * into t from public.tenants where id = ta; select * into cl from public.clients where id = ca;
  if t.config #>> '{plan,service}' <> 'message_only' or t.config #>> '{plan,service_reason}' <> 'canceled' or cl.status <> 'paused' then
    raise exception 'FAIL period over -> message mode % %', t.config -> 'plan', cl.status; end if;
  select count(*) into n from private.email_outbox where entity_id = ca and template = 'subscription_message_mode';
  if n <> 1 then raise exception 'FAIL message-mode mail %', n; end if;
  perform private.billing_sync();
  select count(*) into n from private.email_outbox where entity_id = ca and template = 'subscription_message_mode';
  if n <> 1 then raise exception 'FAIL message-mode mail twice'; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_resume();
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into t from public.tenants where id = ta; select * into cl from public.clients where id = ca;
  if t.config #>> '{plan,service}' <> 'full' or cl.status <> 'live' then raise exception 'FAIL resume % %', t.config -> 'plan', cl.status; end if;
  select count(*) into n from private.email_outbox where entity_id = ca and template = 'subscription_restored';
  if n <> 1 then raise exception 'FAIL restored mail'; end if; c := c + 1;

  -- past due: full during the grace period, message mode after it
  select * into sub from public.subscriptions where client_id = ca;
  perform public.billing_upsert_subscription('mock', sub.provider_subscription_id, 'past_due', sub.plan_code, null, null, null, null, null,
          null, null, null, null, now() + interval '2 seconds');
  if (select config #>> '{plan,service}' from public.tenants where id = ta) <> 'full' then raise exception 'FAIL past due in grace'; end if;
  update public.subscriptions set past_due_since = now() - interval '8 days' where client_id = ca;
  perform private.billing_sync();
  if (select config #>> '{plan,service_reason}' from public.tenants where id = ta) <> 'past_due' then raise exception 'FAIL past due after grace'; end if; c := c + 1;

  -- trial that ended without payment (provider never confirmed) -> message mode; reminder 3 days before the end
  r := public.billing_upsert_subscription('paddle', 'sub_b', 'trialing', 'FR_PRO', ub, 'ctm_b', now() + interval '2 days');
  perform private.billing_sync();
  select count(*) into n from private.email_outbox where template = 'trial_ending' and entity_id = (r ->> 'client_id')::uuid;
  if n <> 1 then raise exception 'FAIL trial reminder'; end if; c := c + 1;
  update public.subscriptions set trial_ends_at = now() - interval '13 hours' where provider_subscription_id = 'sub_b';
  perform private.billing_sync();
  if (select config #>> '{plan,service_reason}' from public.tenants where client_id = (r ->> 'client_id')::uuid) <> 'trial_ended' then
    raise exception 'FAIL trial ended'; end if; c := c + 1;

  -- ---------------------------------------------------------------- admin view, retry, money-back once
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  r := public.admin_subscriptions();
  if jsonb_array_length(r) <> 3 or not exists (select 1 from jsonb_array_elements(r) x where x ->> 'client_id' = ca::text
       and x #>> '{tenant,slug}' = 'cool-breeze-hvac' and jsonb_array_length(x -> 'jobs') = 2 and (x #>> '{checklist,required}')::int = 5)
     or r::text like '%713555010%' then
    raise exception 'FAIL admin list %', left(r::text, 400); end if; c := c + 1;
  perform public.admin_mark_money_back(ca);
  begin perform public.admin_mark_money_back(ca); raise exception 'FAIL money-back twice';
  exception when sqlstate 'P0001' then if sqlerrm <> 'money_back_already_used' then raise; end if; end;
  if not exists (select 1 from jsonb_array_elements(public.admin_subscriptions()) x where x ->> 'client_id' = ca::text and x ->> 'money_back_used_at' is not null) then
    raise exception 'FAIL money-back not visible'; end if; c := c + 1;
  -- the copycat business (same phone) shows the money-back as used too
  if not exists (select 1 from jsonb_array_elements(public.admin_subscriptions()) x where x #>> '{subscription,provider_subscription_id}' = 'sub_dup'
                 and x ->> 'money_back_used_at' is not null) then raise exception 'FAIL money-back per business'; end if; c := c + 1;

  -- ---------------------------------------------------------------- quote clients: old flow untouched
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into public.clients (user_id, products, status) values (uq, '{RCP}', 'testing') returning id into cq;
  insert into public.tenants (client_id, slug, config) values (cq, 'quote-q', '{"hours": {"mon": ["08:00", "17:00"]}}') returning id into tq;
  perform private.seed_onboarding(cq);
  update public.onboarding_items set status = 'done' where client_id = cq and key not in ('sms', 'tools', 'calendar');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uq, 'role', 'authenticated')::text, true);
  select * into it from public.onboarding_items where client_id = cq and key = 'hours';
  perform public.update_onboarding_item(it.id, 'done', '{"timezone": "America/Denver", "hours": {"mon": ["09:00", "12:00"]}}');
  if (select config from public.tenants where id = tq) <> '{"hours": {"mon": ["08:00", "17:00"]}}' then raise exception 'FAIL quote config merged'; end if;
  select * into it from public.onboarding_items where client_id = cq and key = 'calendar';
  begin perform public.update_onboarding_item(it.id, 'done', '{"provider": "calendly", "booking_link": "https://calendly.com/q/v"}');
    raise exception 'FAIL quote calendar link alone';
  exception when sqlstate 'P0001' then if sqlerrm <> 'calendar_not_connected' then raise; end if; end;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into private.tenant_credentials (tenant_id, provider, ciphertext) values (tq, 'calendly', 'ct');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uq, 'role', 'authenticated')::text, true);
  perform public.update_onboarding_item(it.id, 'done', '{"provider": "calendly", "oauth_at": "2026-11-25T10:00:00Z"}');
  -- go-live request without the texting registration (sms step open): accepted now
  select * into it from public.onboarding_items where client_id = cq and key = 'sms';
  perform public.update_onboarding_item(it.id, null, jsonb_build_object('go_live_requested_at', now()));
  if (select status from public.onboarding_items where id = it.id) <> 'todo' then raise exception 'FAIL sms status changed'; end if;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox where entity_id = cq and template = 'final_payment_due';
  if n <> 1 then raise exception 'FAIL quote client final payment mail %', n; end if;
  c := c + 1;
  if (select status from public.clients where id = cq) <> 'testing' then raise exception 'FAIL quote client auto-live'; end if; c := c + 1;

  raise exception 'SUBSCRIPTIONS_TESTS_PASSED (% checks)', c;
end $$;
