-- Setup assistant store and guards (20261201100000_us_setup_agent.sql): RLS (owner reads, nobody writes through the API),
-- service-only RPCs, the kill switch, ownership of conversations and proposals, one turn at a time, idempotent
-- client_turn_id, rate limits (minute / hour / day / total), the global daily budget, the provider alert (one e-mail a day,
-- pause), confirm-after-card, supersede, the read-only preview, retention (91 days deleted, 89 kept), anonymisation.
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with SETUP_AGENT_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/setup_agent_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uq uuid := gen_random_uuid(); ad uuid := gen_random_uuid();
  r jsonb; ca uuid; ta uuid; cb uuid; cq uuid; conv_a uuid; conv_b uuid; lk uuid; lk2 uuid; p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid(); p3 uuid := gen_random_uuid(); pb uuid := gen_random_uuid(); it public.onboarding_items;
  cfg_before jsonb; data_before jsonb; n int; c int := 0; i int; s int; msg text;
  svc constant text := 'service_role';
begin
  insert into auth.users (id, email) values (ua, 'sa-a@example.com'), (ub, 'sa-b@example.com'), (uq, 'sa-q@example.com'),
    (ad, 'sa-admin@example.com');
  update public.profiles set company = 'Lopez Plumbing', phone = '(713) 555-0100', full_name = 'Maria Lopez' where id = ua;
  update public.profiles set company = 'Other Co', phone = '(713) 555-0101' where id = ub;
  update public.profiles set is_admin = true where id = ad;
  update private.settings set billing_mock_enabled = true where id = 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_PRO', 14); ca := (r ->> 'client_id')::uuid; ta := (r ->> 'tenant_id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := public.billing_mock_checkout('FR_STARTER', 14); cb := (r ->> 'client_id')::uuid;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into public.clients (user_id, products, status) values (uq, '{RCP}', 'onboarding') returning id into cq;   -- a quote client
  insert into public.onboarding_items (client_id, key, title) values (cq, 'hours', 'Business hours');

  -- ================================================================ privileges: the API roles cannot drive the store
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.setup_agent_open(ua); raise exception 'FAIL authenticated called setup_agent_open';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.setup_agent_alert(ua, 'down', 'x'); raise exception 'FAIL authenticated called setup_agent_alert';
  exception when insufficient_privilege then null; end; c := c + 1;
  if has_function_privilege('authenticated', 'public.setup_agent_begin_turn(uuid, uuid, text, text, text, jsonb, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.setup_agent_finish_turn(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.setup_agent_decide(uuid, uuid, uuid, text, text, int)', 'execute')
     or has_function_privilege('anon', 'public.setup_preview_step(uuid, jsonb, public.onboarding_status)', 'execute') then
    raise exception 'FAIL service RPC / preview grants too wide'; end if; c := c + 1;

  -- ================================================================ open: plan clients only, one conversation per client
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.setup_agent_open(ua); conv_a := (r #>> '{conversation,id}')::uuid;
  if conv_a is null or (r #>> '{client,id}')::uuid <> ca or r -> 'conversation' ? 'lock_token' then raise exception 'FAIL open %', r; end if; c := c + 1;
  if (public.setup_agent_open(ua) #>> '{conversation,id}')::uuid <> conv_a then raise exception 'FAIL second open made a new conversation'; end if; c := c + 1;
  if (r #>> '{switches,enabled}')::boolean then raise exception 'FAIL the assistant is ON by default'; end if; c := c + 1;
  if (r #>> '{switches,budget_usd}')::numeric <> 30 then raise exception 'FAIL default daily budget %', r -> 'switches'; end if; c := c + 1;
  begin perform public.setup_agent_open(uq); raise exception 'FAIL quote client got a conversation';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text; if msg <> 'not_a_plan_client' then raise exception 'FAIL quote client: %', msg; end if;
  end; c := c + 1;
  conv_b := (public.setup_agent_open(ub) #>> '{conversation,id}')::uuid;

  -- ================================================================ kill switch (default off) blocks every turn
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0001', 'user', 'hi', '[]', false);
  if r ->> 'error' is distinct from 'disabled' then raise exception 'FAIL kill switch %', r; end if; c := c + 1;
  update private.settings set setup_agent_enabled = true where id = 1;

  -- ================================================================ one turn at a time, lock token, idempotency
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0001', 'user', 'mon-fri 7 to 6', '[]', true);
  if not coalesce((r ->> 'ok')::boolean, false) or (r ->> 'seq')::int <> 1 then raise exception 'FAIL begin %', r; end if; c := c + 1;
  lk := (r ->> 'lock')::uuid;
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0002', 'user', 'again', '[]', true);
  if r ->> 'error' is distinct from 'turn_in_progress' then raise exception 'FAIL concurrent turn %', r; end if; c := c + 1;
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0001', 'user', 'mon-fri 7 to 6', '[]', true);
  if r ->> 'error' is distinct from 'turn_in_progress' then raise exception 'FAIL retry while locked %', r; end if; c := c + 1;
  begin perform public.setup_agent_finish_turn(conv_a, gen_random_uuid(), '{"messages": []}'); raise exception 'FAIL foreign lock finished';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'lock_lost' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_begin_turn(conv_a, ub, 'turn-b-001', 'user', 'x', '[]', true); raise exception 'FAIL another user used A''s conversation';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.setup_agent_begin_turn(conv_a, ua, 'bad id with spaces', 'user', 'x', '[]', true); raise exception 'FAIL bad turn id';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'bad_input' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_begin_turn(conv_a, ua, 'turn-long1', 'user', repeat('x', 1001), '[]', true); raise exception 'FAIL 1001 chars';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'bad_input' then raise; end if; end; c := c + 1;
  -- the turn ends: one assistant message carrying a card (proposal p1, hours)
  r := public.setup_agent_finish_turn(conv_a, lk, jsonb_build_object(
    'messages', jsonb_build_array(jsonb_build_object('role', 'assistant', 'text', 'Here is what I understood.',
      'blocks', jsonb_build_array(jsonb_build_object('type', 'summary_card', 'proposal_id', p1)), 'model_json', '{"reply": "x", "ops": []}'::jsonb)),
    'proposals', jsonb_build_array(jsonb_build_object('id', p1, 'topic', 'hours', 'item_key', 'hours',
      'data', '{"hours": {"mon": ["07:00", "18:00"]}}'::jsonb, 'base_hash', 'h1', 'msg_index', 0)),
    'state', '{"notes": {}}'::jsonb, 'topic', 'hours', 'input_seq', 1,
    'usage', jsonb_build_object('model', 'm', 'tokens_in', 1000, 'tokens_out', 200, 'cost_usd', 0.02)));
  if (r #>> '{messages,0,seq}')::int <> 2 then raise exception 'FAIL finish seq %', r; end if; c := c + 1;
  if (select shown_seq from public.setup_proposals where id = p1) <> 2 then raise exception 'FAIL shown_seq'; end if; c := c + 1;
  if (select lock_token from public.setup_conversations where id = conv_a) is not null then raise exception 'FAIL lock not cleared'; end if; c := c + 1;
  if (select cost_usd from public.setup_messages where conversation_id = conv_a and seq = 1) <> 0.02
     or (select cost_usd from public.setup_conversations where id = conv_a) <> 0.02 then raise exception 'FAIL usage not recorded'; end if; c := c + 1;
  begin perform public.setup_agent_finish_turn(conv_a, lk, '{"messages": []}'); raise exception 'FAIL a used lock finished twice';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'lock_lost' then raise; end if; end; c := c + 1;
  -- a replayed request gets the stored answer, nothing new is stored
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0001', 'user', 'changed text', '[]', true);
  if not coalesce((r ->> 'replay')::boolean, false) or (r #>> '{messages,0,seq}')::int <> 2 or jsonb_array_length(r -> 'messages') <> 1 then
    raise exception 'FAIL replay %', r; end if; c := c + 1;
  if (select count(*) from public.setup_messages where conversation_id = conv_a) <> 2 then raise exception 'FAIL replay stored a row'; end if; c := c + 1;

  -- ================================================================ proposals: confirm after the card, once, own conversation only
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0003', 'user', 'yes', '[]', false); lk := (r ->> 'lock')::uuid;
  s := (r ->> 'seq')::int;
  if not (r -> 'pending' @> jsonb_build_array(jsonb_build_object('id', p1))) then raise exception 'FAIL pending list %', r -> 'pending'; end if; c := c + 1;
  begin perform public.setup_agent_decide(conv_a, lk, gen_random_uuid(), 'confirmed', null, s); raise exception 'FAIL forged proposal id';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'unknown_proposal' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_decide(conv_a, lk, p1, 'confirmed', null, 2); raise exception 'FAIL confirm not after the card';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'confirm_before_card' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_decide(conv_a, gen_random_uuid(), p1, 'confirmed', null, s); raise exception 'FAIL decide without the lock';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'lock_lost' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_decide(conv_a, lk, p1, 'pending', null, s); raise exception 'FAIL decide back to pending';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'bad_status' then raise; end if; end; c := c + 1;
  r := public.setup_agent_decide(conv_a, lk, p1, 'confirmed', null, s);
  if r ->> 'status' <> 'confirmed' then raise exception 'FAIL confirm %', r; end if; c := c + 1;
  begin perform public.setup_agent_decide(conv_a, lk, p1, 'confirmed', null, s); raise exception 'FAIL confirmed twice';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'proposal_not_pending' then raise; end if; end; c := c + 1;
  -- two cards for the same topic: the newer one supersedes the older
  perform public.setup_agent_finish_turn(conv_a, lk, jsonb_build_object('messages', '[{"role": "assistant", "text": "a"}, {"role": "assistant", "text": "b"}]'::jsonb,
    'proposals', jsonb_build_array(
      jsonb_build_object('id', p2, 'topic', 'services', 'item_key', 'faq', 'data', '{"services": ["Drains"]}'::jsonb, 'base_hash', 'h', 'msg_index', 0))));
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0004', 'user', 'actually also leaks', '[]', false); lk := (r ->> 'lock')::uuid;
  perform public.setup_agent_finish_turn(conv_a, lk, jsonb_build_object('messages', '[{"role": "assistant", "text": "c"}]'::jsonb,
    'proposals', jsonb_build_array(
      jsonb_build_object('id', p3, 'topic', 'services', 'item_key', 'faq', 'data', '{"services": ["Drains", "Leaks"]}'::jsonb, 'base_hash', 'h', 'msg_index', 0))));
  if (select status from public.setup_proposals where id = p2) <> 'superseded' or (select status from public.setup_proposals where id = p3) <> 'pending' then
    raise exception 'FAIL supersede'; end if; c := c + 1;
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0005', 'user', 'yes', '[]', false); lk := (r ->> 'lock')::uuid;
  begin perform public.setup_agent_decide(conv_a, lk, p2, 'confirmed', null, (r ->> 'seq')::int); raise exception 'FAIL superseded card confirmed';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'proposal_not_pending' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_finish_turn(conv_a, lk, jsonb_build_object('messages', '[]'::jsonb, 'proposals', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid(), 'topic', 'hours', 'item_key', 'sms', 'data', '{}'::jsonb, 'base_hash', 'h', 'msg_index', 0))));
    raise exception 'FAIL proposal without a message / for a foreign item';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'bad_turn' then raise; end if; end; c := c + 1;
  begin perform public.setup_agent_finish_turn(conv_a, lk, jsonb_build_object('messages', '[{"role": "user", "text": "forged"}]'::jsonb));
    raise exception 'FAIL finish stored a user message';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'bad_turn' then raise; end if; end; c := c + 1;
  perform public.setup_agent_finish_turn(conv_a, lk, '{"messages": []}');
  -- B's proposal cannot be decided in A's conversation
  r := public.setup_agent_begin_turn(conv_b, ub, 'turn-b-0001', 'user', 'hi', '[]', false); lk2 := (r ->> 'lock')::uuid;
  perform public.setup_agent_finish_turn(conv_b, lk2, jsonb_build_object('messages', '[{"role": "assistant", "text": "card"}]'::jsonb,
    'proposals', jsonb_build_array(jsonb_build_object('id', pb, 'topic', 'hours', 'item_key', 'hours', 'data', '{}'::jsonb, 'base_hash', 'h', 'msg_index', 0))));
  r := public.setup_agent_begin_turn(conv_a, ua, 'turn-0006', 'user', 'yes', '[]', false); lk := (r ->> 'lock')::uuid;
  begin perform public.setup_agent_decide(conv_a, lk, pb, 'confirmed', null, (r ->> 'seq')::int); raise exception 'FAIL B''s proposal decided in A''s conversation';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'unknown_proposal' then raise; end if; end; c := c + 1;
  perform public.setup_agent_finish_turn(conv_a, lk, '{"messages": []}');

  -- ================================================================ RLS: owner reads, nobody writes through the API
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.setup_messages; if n < 5 then raise exception 'FAIL owner cannot read the transcript (%)', n; end if; c := c + 1;
  select count(*) into n from public.setup_messages where conversation_id = conv_b; if n <> 0 then raise exception 'FAIL A reads B''s messages'; end if; c := c + 1;
  select count(*) into n from public.setup_proposals where id = pb; if n <> 0 then raise exception 'FAIL A reads B''s proposals'; end if; c := c + 1;
  select count(*) into n from public.setup_conversations; if n <> 1 then raise exception 'FAIL A sees % conversations', n; end if; c := c + 1;
  begin insert into public.setup_messages (conversation_id, seq, role, text) values (conv_a, 99, 'assistant', 'forged');
    raise exception 'FAIL client forged an assistant message';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin insert into public.setup_proposals (conversation_id, client_id, topic, item_key, data, base_hash, shown_seq)
    values (conv_a, ca, 'hours', 'hours', '{}', 'h', 1); raise exception 'FAIL client forged a proposal';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin update public.setup_proposals set status = 'pending' where id = p2; raise exception 'FAIL client updated a proposal';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin update public.setup_conversations set lock_until = null; raise exception 'FAIL client cleared the lock';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin delete from public.setup_messages; raise exception 'FAIL client deleted messages';
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  select count(*) into n from public.setup_conversations; if n < 2 then raise exception 'FAIL admin cannot read conversations'; end if; c := c + 1;
  perform set_config('role', 'anon', true); perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform 1 from public.setup_messages limit 1; raise exception 'FAIL anon read messages';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- ================================================================ preview: same result / error as the trigger, writes nothing
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select * into it from public.onboarding_items where client_id = ca and key = 'hours';
  select config into cfg_before from public.tenants where id = ta; data_before := it.data;
  r := public.setup_preview_step(it.id, '{"hours": {"mon": ["07:00", "18:00"], "sun": null}, "after_hours": {"mode": "emergency_dial"}}');
  if r -> 'hours' <> '{"mon": ["07:00", "18:00"], "sun": null}'::jsonb or r #>> '{after_hours,mode}' <> 'emergency_dial' then
    raise exception 'FAIL preview result %', r; end if; c := c + 1;
  begin perform public.setup_preview_step(it.id, '{"hours": {"mon": ["18:00", "07:00"]}}'); raise exception 'FAIL preview accepted closing before opening';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'invalid_setting:hours.mon' then raise; end if; end; c := c + 1;
  if (select config from public.tenants where id = ta) <> cfg_before or (select data from public.onboarding_items where id = it.id) <> data_before then
    raise exception 'FAIL preview wrote something'; end if; c := c + 1;
  select * into it from public.onboarding_items where client_id = ca and key = 'calendar';
  begin perform public.setup_preview_step(it.id, '{"provider": "google"}', 'done'); raise exception 'FAIL preview: calendar done without a connection';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'calendar_not_connected' then raise; end if; end; c := c + 1;
  r := public.setup_preview_step(it.id, '{"booking_mode": "messages_only", "provider": null}', 'done');
  if (r #>> '{booking,enabled}')::boolean is not false then raise exception 'FAIL preview messages only %', r -> 'booking'; end if; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  begin perform public.setup_preview_step(it.id, '{}'); raise exception 'FAIL B previewed A''s item';
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', uq, 'role', 'authenticated')::text, true);
  select * into it from public.onboarding_items where client_id = cq and key = 'hours';
  begin perform public.setup_preview_step(it.id, '{}'); raise exception 'FAIL preview for a quote client';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'not_a_plan_client' then raise; end if; end; c := c + 1;

  -- ================================================================ rate limits
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  delete from public.setup_messages where conversation_id = conv_b;
  for i in 1 .. 12 loop
    r := public.setup_agent_begin_turn(conv_b, ub, 'minute-' || lpad(i::text, 4, '0'), 'user', 'm', '[]', false);
    if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'FAIL turn % of 12 refused %', i, r; end if;
    perform public.setup_agent_finish_turn(conv_b, (r ->> 'lock')::uuid, '{"messages": [{"role": "assistant", "text": "ok"}]}');
  end loop;
  r := public.setup_agent_begin_turn(conv_b, ub, 'minute-0013', 'user', 'm', '[]', false);
  if r ->> 'error' is distinct from 'rate_limited' or (r ->> 'retry_after_s')::int not between 1 and 60 then raise exception 'FAIL minute limit %', r; end if; c := c + 1;
  if (public.setup_agent_open(ub) #>> '{limits,messages_left_today}')::int <> 138 then raise exception 'FAIL messages_left_today'; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.setup_messages set created_at = now() - interval '5 minutes' where conversation_id = conv_b;
  insert into public.setup_messages (conversation_id, seq, role, text, client_turn_id, created_at)
    select conv_b, 1000 + g, 'user', 'h', 'hour-' || g, now() - interval '30 minutes' from generate_series(1, 48) g;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.setup_agent_begin_turn(conv_b, ub, 'hour-0061', 'user', 'h', '[]', false);
  if r ->> 'error' is distinct from 'rate_limited' or (r ->> 'retry_after_s')::int not between 61 and 3600 then raise exception 'FAIL hour limit %', r; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.setup_messages set created_at = now() - interval '3 hours' where conversation_id = conv_b;
  insert into public.setup_messages (conversation_id, seq, role, text, client_turn_id, created_at)
    select conv_b, 2000 + g, 'user', 'd', 'day-' || g, now() - interval '5 hours' from generate_series(1, 90) g;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.setup_agent_begin_turn(conv_b, ub, 'day-00151', 'user', 'd', '[]', false);
  if r ->> 'error' is distinct from 'rate_limited' or (r ->> 'retry_after_s')::int <= 3600 then raise exception 'FAIL day limit (150) %', r; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.setup_messages set created_at = now() - interval '3 days' where conversation_id = conv_b;
  insert into public.setup_messages (conversation_id, seq, role, text, client_turn_id, created_at)
    select conv_b, 3000 + g, 'user', 't', 'total-' || g, now() - interval '3 days' from generate_series(1, 450) g;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.setup_agent_begin_turn(conv_b, ub, 'total-0601', 'user', 't', '[]', false);
  if r ->> 'error' is distinct from 'limit' then raise exception 'FAIL 600 per conversation %', r; end if; c := c + 1;

  -- ================================================================ global daily budget + provider alerts
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update private.settings set setup_agent_daily_budget_usd = 1 where id = 1;
  update public.setup_messages set cost_usd = 1.5 where conversation_id = conv_a and seq = 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.setup_agent_begin_turn(conv_a, ua, 'budget-001', 'user', 'hours?', '[]', true);
  if r ->> 'error' is distinct from 'budget' or (r ->> 'retry_after_s')::int not between 1 and 86400 then raise exception 'FAIL budget %', r; end if; c := c + 1;
  if exists (select 1 from public.setup_messages where client_turn_id = 'budget-001') then raise exception 'FAIL a refused turn stored the text'; end if; c := c + 1;
  r := public.setup_agent_begin_turn(conv_a, ua, 'budget-002', 'user', 'Looks right', '[]', false);   -- a button press needs no model
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'FAIL budget blocked a no-model turn %', r; end if; c := c + 1;
  perform public.setup_agent_finish_turn(conv_a, (r ->> 'lock')::uuid, '{"messages": []}');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update private.settings set setup_agent_daily_budget_usd = 30 where id = 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.setup_agent_alert(ua, 'down', 'provider 5xx');
  if (select setup_agent_paused_until from private.settings where id = 1) is not null then raise exception 'FAIL down paused the assistant'; end if; c := c + 1;
  perform public.setup_agent_alert(ua, 'auth', 'http 401');
  perform public.setup_agent_alert(ua, 'auth', 'http 401 again');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select count(*) into n from private.email_outbox o where o.template = 'admin_provisioning_alert' and o.payload ->> 'step' = 'setup_agent_auth';
  if n <> 1 then raise exception 'FAIL auth alert e-mails: % (want 1 a day)', n; end if; c := c + 1;
  select count(*) into n from public.events e where e.type = 'setup_agent_auth' and not e.client_visible;
  if n <> 2 then raise exception 'FAIL auth alert events %', n; end if; c := c + 1;
  if (select setup_agent_paused_until from private.settings where id = 1) < now() + interval '59 minutes' then raise exception 'FAIL auth did not pause'; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  r := public.setup_agent_begin_turn(conv_a, ua, 'paused-001', 'user', 'hi', '[]', true);
  if r ->> 'error' is distinct from 'paused' or (r ->> 'retry_after_s')::int not between 3000 and 3600 then raise exception 'FAIL pause %', r; end if; c := c + 1;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update private.settings set setup_agent_paused_until = null where id = 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  perform public.setup_agent_alert(ua, 'request', 'model bad_request (HTTP 400): invalid_request_error: The compiled grammar is too large');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select setup_agent_paused_until from private.settings where id = 1) is null
     or not exists (select 1 from private.email_outbox o where o.payload ->> 'step' = 'setup_agent_request' and o.payload ->> 'error' like '%compiled grammar%') then
    raise exception 'FAIL a refused request (server defect) must pause and alert'; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', svc)::text, true);
  begin perform public.setup_agent_alert(ua, 'other', 'x'); raise exception 'FAIL unknown alert kind';
  exception when others then get stacked diagnostics msg = message_text; if msg <> 'bad_kind' then raise; end if; end; c := c + 1;

  -- ================================================================ retention (90 days after the last activity) + anonymisation
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.setup_conversations set last_activity_at = now() - interval '91 days', state = '{"notes": {"faq": {"q": "x"}}}' where id = conv_a;
  update public.setup_conversations set last_activity_at = now() - interval '89 days' where id = conv_b;
  r := private.setup_retention();
  if exists (select 1 from public.setup_messages where conversation_id = conv_a) or exists (select 1 from public.setup_proposals where conversation_id = conv_a) then
    raise exception 'FAIL retention kept A''s text'; end if; c := c + 1;
  if (select state from public.setup_conversations where id = conv_a) <> '{}'::jsonb or (select cost_usd from public.setup_conversations where id = conv_a) = 0 then
    raise exception 'FAIL retention: row should stay with counters, without memory'; end if; c := c + 1;
  if not exists (select 1 from public.setup_messages where conversation_id = conv_b) then raise exception 'FAIL retention deleted at 89 days'; end if; c := c + 1;
  if not exists (select 1 from public.events where type = 'setup_retention_run') then raise exception 'FAIL retention not logged'; end if; c := c + 1;
  if not exists (select 1 from cron.job where jobname = 'ailab-us-setup-retention' and command = 'select private.setup_retention()') then
    raise exception 'FAIL retention cron job'; end if; c := c + 1;
  update public.clients set anonymized_at = now() where id = cb;
  if exists (select 1 from public.setup_conversations where client_id = cb) then raise exception 'FAIL anonymised client kept its conversation'; end if; c := c + 1;
  delete from auth.users where id = ua;
  if exists (select 1 from public.setup_conversations where id = conv_a) then raise exception 'FAIL deleted user kept the conversation'; end if; c := c + 1;

  raise exception 'SETUP_AGENT_TESTS_PASSED (% checks)', c;
end $$;
