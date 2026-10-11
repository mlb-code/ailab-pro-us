-- RLS / guard / RPC / retention test for the ailab-us schema.
-- The block ALWAYS ends with an error on purpose, so everything it created is ROLLED BACK
-- (no test users or rows left behind).
--   SUCCESS = error text starts with: RLS_TESTS_PASSED   (followed by the number of checks)
--   FAILURE = error text starts with: FAIL              (names the check that broke)
-- Run: Supabase SQL editor (paste all), Management API / tools/us_setup.py --only test,
--      or offline: deno run -A --node-modules-dir=none supabase/tests/offline/run.ts

do $test$
declare
  ua uuid := gen_random_uuid();  -- client A
  uc uuid := gen_random_uuid();  -- cancelled client C (retention)
  qc uuid; quo_c uuid; quo_c2 uuid; cc uuid; tc uuid; pc uuid; rc uuid; lc uuid; cy uuid; tok_c text;
  ub uuid := gen_random_uuid();  -- client B
  um uuid := gen_random_uuid();  -- admin (auto-admin by email)
  qa uuid; qa2 uuid; qb uuid;
  quo_a_draft uuid; quo_a_sent uuid; quo_b_sent uuid; quo_manual uuid;
  ca uuid; cb uuid; cx uuid;
  pa uuid; oa uuid; ob uuid;
  ra uuid; ra2 uuid; rb uuid;
  ta uuid; tb uuid; call_a uuid;
  n int; ok boolean; j jsonb; c int := 0;
  tbl text;
begin
  -- ============================================================ fixtures (as the migration owner)
  update private.settings set admin_email = 'rls-admin@example.com' where id = 1;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (ua, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@example.com', '{"full_name":"User A"}', '{}', now(), now()),
         (ub, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@example.com', '{}', '{}', now(), now()),
         (um, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'RLS-Admin@example.com', '{}', '{}', now(), now());
  select count(*) into n from public.profiles where id in (ua, ub, um);
  if n <> 3 then raise exception 'FAIL profiles not auto-created (%)', n; end if; c := c + 1;
  select is_admin into ok from public.profiles where id = um;
  if not ok then raise exception 'FAIL admin email not auto-admin'; end if; c := c + 1;
  select is_admin into ok from public.profiles where id = ua;
  if ok then raise exception 'FAIL client auto-admin'; end if; c := c + 1;

  insert into public.questionnaires (user_id, offer, niche, answers) values (ub, 'RCP', 'home_services', '{"x":1}') returning id into qb;
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents)
    values (ua, 'draft', '[{"code":"RCP","qty":1}]', 350000, 30000, 175000) returning id into quo_a_draft;
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents)
    values (ua, 'draft', '[{"code":"RCP","qty":1}]', 350000, 30000, 175000) returning id into quo_a_sent;
  update public.quotes set status = 'approved' where id = quo_a_sent;
  update public.quotes set status = 'sent' where id = quo_a_sent;
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents)
    values (ub, 'draft', '[{"code":"WEB","qty":1}]', 190000, 12900, 95000) returning id into quo_b_sent;
  update public.quotes set status = 'approved' where id = quo_b_sent;
  update public.quotes set status = 'sent' where id = quo_b_sent;
  insert into public.quotes (user_id, status, items) values (ub, 'needs_manual_price', '[{"code":"ADD-CRM","qty":1,"custom":"ServiceTitan"}]')
    returning id into quo_manual;

  insert into public.clients (user_id, quote_id, products, monthly_cents) values (ua, quo_a_sent, '{RCP}', 30000) returning id into ca;
  insert into public.clients (user_id, quote_id, products, monthly_cents) values (ub, quo_b_sent, '{WEB}', 12900) returning id into cb;
  insert into public.payments (client_id, kind, amount_cents) values (ca, 'deposit', 175000) returning id into pa;
  insert into public.payments (client_id, kind, amount_cents) values (cb, 'deposit', 95000);
  insert into public.onboarding_items (client_id, key, title) values (ca, 'calendar', 'Connect your calendar') returning id into oa;
  insert into public.onboarding_items (client_id, key, title) values (cb, 'calendar', 'Connect your calendar') returning id into ob;
  insert into public.requests (client_id, title) values (cb, 'B request') returning id into rb;
  insert into public.tenants (client_id, slug, config, twilio_number)
    values (ca, 'rls-tenant-a', '{"hours":{"mon":["07:00","18:00"]},"booking":{"provider":"google"},"guard":{"daily_budget_usd":3},"paused":false}', '+17135550100')
    returning id into ta;
  insert into public.tenants (client_id, slug, config) values (cb, 'rls-tenant-b', '{}') returning id into tb;
  insert into public.calls (tenant_id, call_sid, from_e164, outcome, transcript, summary)
    values (ta, 'CA_rls_a', '+12145550101', 'booked', '[{"r":"caller","t":"hi"}]', 'AC repair') returning id into call_a;
  insert into public.calls (tenant_id, call_sid, outcome) values (tb, 'CA_rls_b', 'message');
  insert into public.sms_messages (tenant_id, contact_e164, direction, body) values (ta, '+12145550101', 'outbound', 'Hi from A'),
    (tb, '+12145550102', 'outbound', 'Hi from B');
  insert into public.bookings (tenant_id, call_id, customer_name, start_at, end_at)
    values (ta, call_a, 'Pat', now() + interval '1 day', now() + interval '1 day 2 hours');
  insert into public.bookings (tenant_id, customer_name) values (tb, 'Lee');
  insert into public.opt_outs (tenant_id, contact_e164) values (ta, '+12145550199');
  insert into public.leads (email, niche, source_page) values ('lead@example.com', 'real_estate', '/real-estate/');
  insert into public.admin_notes (entity, entity_id, body) values ('client', ca, 'internal: slow payer');
  insert into private.quote_drafts (quote_id, model, prompt_hash, raw_output) values (quo_a_draft, 'test-model', 'h', '{}');

  -- ============================================================ client A
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- profiles
  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAIL A sees % profiles', n; end if; c := c + 1;
  update public.profiles set is_admin = true, email = 'evil@example.com', full_name = 'A updated', timezone = 'America/Chicago' where id = ua;
  select not is_admin and email = 'rls-a@example.com' and full_name = 'A updated' into ok from public.profiles where id = ua;
  if not ok then raise exception 'FAIL client changed is_admin/email or could not edit own profile'; end if; c := c + 1;
  update public.profiles set full_name = 'hacked' where id = ub;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL A updated B profile'; end if; c := c + 1;
  ok := false;
  begin update public.profiles set timezone = 'Mars/Olympus' where id = ua; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL invalid timezone accepted'; end if; c := c + 1;

  -- questionnaires
  insert into public.questionnaires (niche, answers) values ('home_services', '{"a":1}') returning id into qa;
  insert into public.questionnaires (user_id, status) values (ub, 'quoted') returning id into qa2;
  select user_id = ua and status = 'draft' into ok from public.questionnaires where id = qa2;
  if not ok then raise exception 'FAIL insert spoof user_id/status'; end if; c := c + 1;
  select count(*) into n from public.questionnaires where id = qb;
  if n <> 0 then raise exception 'FAIL A sees B questionnaire'; end if; c := c + 1;
  update public.questionnaires set answers = '{"hacked":1}' where id = qb;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL A updated B questionnaire'; end if; c := c + 1;
  delete from public.questionnaires where id = qb;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL A deleted B questionnaire'; end if; c := c + 1;
  ok := false;
  begin update public.questionnaires set status = 'quoted' where id = qa; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client set status quoted'; end if; c := c + 1;
  ok := false;
  begin update public.questionnaires set status = 'submitted' where id = qa; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL submit without offer'; end if; c := c + 1;

  -- attachments + storage (while draft)
  for i in 1..5 loop
    insert into storage.objects (bucket_id, name, owner) values ('client-files', ua::text || '/' || qa::text || '/abc12' || i || '-f.png', ua);
    insert into public.attachments (questionnaire_id, storage_path, filename, size) values (qa, ua::text || '/' || qa::text || '/abc12' || i || '-f.png', 'f.png', 1000);
  end loop;
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner) values ('client-files', ua::text || '/' || qa::text || '/abc126-f.png', ua);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 6th storage object allowed'; end if; c := c + 1;
  ok := false;
  begin insert into public.attachments (questionnaire_id, storage_path, filename, size) values (qa, ua::text || '/' || qa::text || '/abc126-f.png', 'f.png', 1);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 6th attachment row allowed'; end if; c := c + 1;
  ok := false;
  begin insert into public.attachments (questionnaire_id, storage_path, filename, size) values (qb, ua::text || '/' || qb::text || '/abc127-f.png', 'f.png', 1);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL A attached to B questionnaire'; end if; c := c + 1;
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner) values ('client-files', ub::text || '/' || qb::text || '/abc128-f.png', ua);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL A uploaded into B folder'; end if; c := c + 1;
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner) values ('videos-public', 'onboarding/x.mp4', ua);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client uploaded to videos-public'; end if; c := c + 1;

  update public.questionnaires set offer = 'RCP' where id = qa;
  update public.questionnaires set status = 'submitted' where id = qa;
  select status = 'submitted' and submitted_at is not null into ok from public.questionnaires where id = qa;
  if not ok then raise exception 'FAIL submit'; end if; c := c + 1;
  update public.questionnaires set answers = '{"late":1}' where id = qa;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client edited submitted questionnaire'; end if; c := c + 1;
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner) values ('client-files', ua::text || '/' || qa::text || '/late01-f.png', ua);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL upload after submit'; end if; c := c + 1;

  -- quotes
  select count(*) into n from public.quotes;
  if n <> 1 then raise exception 'FAIL A sees % quotes (expected only own sent)', n; end if; c := c + 1;
  update public.quotes set setup_cents = 1, deposit_cents = 1 where id = quo_a_sent;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client changed quote amounts'; end if; c := c + 1;
  update public.quotes set status = 'accepted', accepted_name = 'A' where id = quo_a_sent;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client accepted quote directly'; end if; c := c + 1;
  ok := false;
  begin insert into public.quotes (user_id, items, setup_cents) values (ua, '[]', 1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client inserted a quote'; end if; c := c + 1;

  -- clients / payments / onboarding
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'FAIL A sees % clients', n; end if; c := c + 1;
  update public.clients set status = 'live', monthly_cents = 0 where id = ca;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client changed own client status'; end if; c := c + 1;
  select count(*) into n from public.payments;
  if n <> 1 then raise exception 'FAIL A sees % payments', n; end if; c := c + 1;
  update public.payments set status = 'paid' where id = pa;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client marked payment paid'; end if; c := c + 1;
  update public.onboarding_items set status = 'done' where id = oa;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client updated onboarding item directly'; end if; c := c + 1;
  perform public.update_onboarding_item(oa, 'need_help', '{"message":"Where is the calendar ID?"}');
  select status = 'need_help' and data ->> 'message' is not null into ok from public.onboarding_items where id = oa;
  if not ok then raise exception 'FAIL onboarding RPC on own item'; end if; c := c + 1;
  ok := false;
  begin perform public.update_onboarding_item(ob, 'done', null); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL onboarding RPC on B item'; end if; c := c + 1;

  -- requests
  insert into public.requests (client_id, title, status, admin_reply) values (ca, 'Change FAQ', 'active', 'spoof') returning id into ra;
  select status = 'queued' and admin_reply is null into ok from public.requests where id = ra;
  if not ok then raise exception 'FAIL request insert guard'; end if; c := c + 1;
  ok := false;
  begin insert into public.requests (client_id, title) values (cb, 'into B'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL A inserted request for B'; end if; c := c + 1;
  select count(*) into n from public.requests where id = rb;
  if n <> 0 then raise exception 'FAIL A sees B request'; end if; c := c + 1;
  update public.requests set title = 'Change FAQ v2', status = 'done' where id = ra;
  select title = 'Change FAQ v2' and status = 'queued' into ok from public.requests where id = ra;
  if not ok then raise exception 'FAIL queued request edit / status lock'; end if; c := c + 1;
  insert into public.requests (client_id, title) values (ca, 'Second') returning id into ra2;

  -- tenants + RPC whitelist
  select count(*) into n from public.tenants;
  if n <> 1 then raise exception 'FAIL A sees % tenants', n; end if; c := c + 1;
  update public.tenants set config = '{}' where id = ta;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client wrote tenant config directly'; end if; c := c + 1;
  j := public.update_tenant_settings(ta, '{"hours":{"sat":["08:00","12:00"],"sun":null},"paused":true,
          "faq":[{"q":"Do you service Trane?","a":"Yes."}],"notify":{"sms":["+17135550111"],"email":["dani@example.com"]}}');
  if not (j -> 'hours' ? 'sat' and (j ->> 'paused')::boolean and j -> 'booking' ->> 'provider' = 'google') then
    raise exception 'FAIL whitelisted tenant settings update (%)', j; end if; c := c + 1;
  ok := false;
  begin perform public.update_tenant_settings(ta, '{"booking":{"provider":"calendly"}}'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL non-whitelisted tenant field accepted'; end if; c := c + 1;
  ok := false;
  begin perform public.update_tenant_settings(ta, '{"guard":{"daily_budget_usd":999}}'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client raised its own budget'; end if; c := c + 1;
  ok := false;
  begin perform public.update_tenant_settings(ta, '{"faq":[{"x":"1","y":"2"}]}'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL malformed faq accepted'; end if; c := c + 1;
  ok := false;
  begin perform public.update_tenant_settings(tb, '{"paused":true}'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL A changed B tenant'; end if; c := c + 1;

  -- runtime data
  select count(*) into n from public.calls;
  if n <> 1 then raise exception 'FAIL A sees % calls', n; end if; c := c + 1;
  select count(*) into n from public.sms_messages;
  if n <> 1 then raise exception 'FAIL A sees % sms', n; end if; c := c + 1;
  select count(*) into n from public.bookings;
  if n <> 1 then raise exception 'FAIL A sees % bookings', n; end if; c := c + 1;
  ok := false;
  begin insert into public.calls (tenant_id, call_sid) values (ta, 'CA_fake'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client inserted a call'; end if; c := c + 1;
  select count(*) into n from public.opt_outs;
  if n <> 0 then raise exception 'FAIL client sees opt_outs'; end if; c := c + 1;

  -- events, notes, leads, private
  select count(*) into n from public.events where user_id is distinct from ua or not client_visible;
  if n <> 0 then raise exception 'FAIL client sees foreign or internal events (%)', n; end if; c := c + 1;
  select count(*) into n from public.events where entity = 'request' and entity_id = ra;
  if n < 1 then raise exception 'FAIL own request event not visible'; end if; c := c + 1;
  select count(*) into n from public.admin_notes;
  if n <> 0 then raise exception 'FAIL client sees admin notes'; end if; c := c + 1;
  ok := false;
  begin insert into public.admin_notes (entity, entity_id, body) values ('client', ca, 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client wrote admin notes'; end if; c := c + 1;
  select count(*) into n from public.leads;
  if n <> 0 then raise exception 'FAIL client sees leads'; end if; c := c + 1;
  ok := false;
  begin insert into public.leads (email) values ('x@example.com'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client inserted lead'; end if; c := c + 1;
  ok := false;
  begin select count(*) into n from private.settings; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client read private.settings'; end if; c := c + 1;
  ok := false;
  begin select count(*) into n from private.quote_drafts; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client read private.quote_drafts'; end if; c := c + 1;
  ok := false;
  begin perform private.run_retention(); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client ran retention'; end if; c := c + 1;
  ok := false;
  begin perform public.runtime_put_credential(ta, 'google', 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client wrote a credential'; end if; c := c + 1;
  ok := false;
  begin perform public.runtime_get_credential(ta, 'google'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client read a credential'; end if; c := c + 1;
  ok := false;
  begin select count(*) into n from private.tenant_credentials; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client read private.tenant_credentials'; end if; c := c + 1;
  ok := false;
  begin select count(*) into n from public.runtime_state; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client read runtime_state'; end if; c := c + 1;
  ok := false;
  begin insert into public.runtime_state (key, tenant_id, value) values ('spoof', ta, '0'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL client wrote runtime_state'; end if; c := c + 1;

  -- ============================================================ client B
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.questionnaires where user_id = ua;
  if n <> 0 then raise exception 'FAIL B sees A questionnaires'; end if; c := c + 1;
  select count(*) into n from public.attachments where owner_id = ua;
  if n <> 0 then raise exception 'FAIL B sees A attachment rows'; end if; c := c + 1;
  select count(*) into n from storage.objects where bucket_id = 'client-files' and name like ua::text || '/%';
  if n <> 0 then raise exception 'FAIL B lists A files'; end if; c := c + 1;
  select count(*) into n from public.quotes where user_id = ua;
  if n <> 0 then raise exception 'FAIL B sees A quotes'; end if; c := c + 1;
  select count(*) into n from public.quotes where id = quo_manual;
  if n <> 0 then raise exception 'FAIL B sees own unsent quote'; end if; c := c + 1;
  select count(*) into n from public.tenants where id = ta;
  if n <> 0 then raise exception 'FAIL B sees A tenant'; end if; c := c + 1;
  select count(*) into n from public.calls where tenant_id = ta;
  if n <> 0 then raise exception 'FAIL B sees A calls'; end if; c := c + 1;
  select count(*) into n from public.payments where client_id = ca;
  if n <> 0 then raise exception 'FAIL B sees A payments'; end if; c := c + 1;
  select count(*) into n from public.onboarding_items where client_id = ca;
  if n <> 0 then raise exception 'FAIL B sees A onboarding'; end if; c := c + 1;
  select count(*) into n from public.events where user_id = ua;
  if n <> 0 then raise exception 'FAIL B sees A events'; end if; c := c + 1;
  select count(*) into n from public.clients where id = ca;
  if n <> 0 then raise exception 'FAIL B sees A client row'; end if; c := c + 1;
  select count(*) into n from public.sms_messages where tenant_id = ta;
  if n <> 0 then raise exception 'FAIL B sees A sms'; end if; c := c + 1;
  select count(*) into n from public.bookings where tenant_id = ta;
  if n <> 0 then raise exception 'FAIL B sees A bookings'; end if; c := c + 1;
  select count(*) into n from public.requests where client_id = ca;
  if n <> 0 then raise exception 'FAIL B sees A requests'; end if; c := c + 1;
  update public.requests set title = 'B was here' where id = ra2;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B edited A request'; end if; c := c + 1;
  delete from storage.objects where bucket_id = 'client-files' and name like ua::text || '/%';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B deleted A files'; end if; c := c + 1;
  delete from public.attachments where owner_id = ua;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B deleted A attachment rows'; end if; c := c + 1;
  ok := false;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('client-files', ub::text || '/' || ra2::text || '/abc555-b.png', ub);
    insert into public.attachments (request_id, storage_path, filename, size) values (ra2, ub::text || '/' || ra2::text || '/abc555-b.png', 'b.png', 1);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL B attached a file to A request'; end if; c := c + 1;
  update public.questionnaires set user_id = ua where id = qb;
  select user_id = ub into ok from public.questionnaires where id = qb;
  if not coalesce(ok, false) then raise exception 'FAIL B moved its questionnaire to A'; end if; c := c + 1;

  -- ============================================================ admin
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  select count(*) into n from public.questionnaires where id in (qa, qa2, qb);
  if n <> 3 then raise exception 'FAIL admin sees % questionnaires', n; end if; c := c + 1;
  select count(*) into n from public.quotes where id in (quo_a_draft, quo_a_sent, quo_b_sent, quo_manual);
  if n <> 4 then raise exception 'FAIL admin sees % quotes', n; end if; c := c + 1;
  select count(*) into n from public.leads;
  if n < 1 then raise exception 'FAIL admin cannot read leads'; end if; c := c + 1;
  select count(*) into n from public.opt_outs;
  if n < 1 then raise exception 'FAIL admin cannot read opt_outs'; end if; c := c + 1;
  select count(*) into n from storage.objects where bucket_id = 'client-files' and name like ua::text || '/%';
  if n <> 5 then raise exception 'FAIL admin storage list (%)', n; end if; c := c + 1;
  select count(*) into n from public.admin_notes where entity_id = ca;
  if n <> 1 then raise exception 'FAIL admin cannot read notes'; end if; c := c + 1;
  ok := false;
  begin update public.quotes set status = 'sent' where id = quo_manual; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL needs_manual_price quote sent'; end if; c := c + 1;
  ok := false;
  begin update public.quotes set setup_cents = 1 where id = quo_a_sent; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL amounts changed after send'; end if; c := c + 1;
  ok := false;
  begin update public.requests set status = 'active' where id in (ra, ra2); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL two active requests allowed'; end if; c := c + 1;
  update public.requests set status = 'active' where id = ra;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL admin activates request'; end if; c := c + 1;
  update public.profiles set is_admin = true where id = ub;
  select is_admin into ok from public.profiles where id = ub;
  if not ok then raise exception 'FAIL admin cannot grant admin'; end if; c := c + 1;
  update public.profiles set is_admin = false where id = ub;

  -- client A cannot edit an active request any more
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  update public.requests set title = 'late edit' where id = ra;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL client edited active request'; end if; c := c + 1;

  -- ============================================================ service role (Edge Functions / runtime)
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform public.runtime_put_credential(ta, 'google', 'v1:ciphertext-1', now() + interval '1 hour');
  perform public.runtime_put_credential(ta, 'google', 'v1:ciphertext-2', null);  -- upsert
  if public.runtime_get_credential(ta, 'google') is distinct from 'v1:ciphertext-2' then
    raise exception 'FAIL service role credential put/get'; end if; c := c + 1;
  if public.runtime_get_credential(ta, 'calendly') is not null then raise exception 'FAIL missing credential not null'; end if; c := c + 1;
  ok := false;
  begin perform public.runtime_put_credential(ta, 'dropbox', 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL unknown credential provider accepted'; end if; c := c + 1;
  insert into public.runtime_state (key, tenant_id, value, updated_at) values ('rate:sms:' || ta::text, ta, '3', now());
  insert into public.runtime_state (key, value) values ('budget:global:2026-10', '{"usd": 1.25}');
  update public.runtime_state set value = '4', updated_at = now()
   where id = (select r.id from public.runtime_state r where r.key = 'rate:sms:' || ta::text);
  select value = '4'::jsonb into ok from public.runtime_state where key = 'rate:sms:' || ta::text;
  if not coalesce(ok, false) then raise exception 'FAIL service role runtime_state insert/update/select'; end if; c := c + 1;
  ok := false;
  begin insert into public.runtime_state (key, value) values ('budget:global:2026-10', '0'); exception when unique_violation then ok := true; end;
  if not ok then raise exception 'FAIL runtime_state key not unique'; end if; c := c + 1;
  ok := false;
  begin update public.quotes set status = 'accepted' where id = quo_a_sent; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL accept without name/agreement'; end if; c := c + 1;
  update public.quotes set status = 'accepted', accepted_name = 'User A', agreement_version = '1.0-draft',
    accepted_ip = '203.0.113.5', accepted_ua = 'test' where id = quo_a_sent;
  select accepted_at is not null into ok from public.quotes where id = quo_a_sent;
  if not ok then raise exception 'FAIL service-role accept'; end if; c := c + 1;
  insert into public.calls (tenant_id, call_sid, from_e164, outcome, transcript, started_at)
    values (ta, 'CA_old', '+12145550188', 'message', '[{"r":"caller","t":"old"}]', now() - interval '100 days');
  insert into public.sms_messages (tenant_id, contact_e164, direction, body, created_at)
    values (ta, '+12145550101', 'inbound', 'old', now() - interval '100 days');
  update public.quotes set valid_until = now() - interval '1 day' where id = quo_b_sent;

  -- ============================================================ anon
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  foreach tbl in array array['profiles','leads','questionnaires','quotes','clients','payments','onboarding_items','requests',
                             'attachments','tenants','calls','sms_messages','bookings','opt_outs','events','admin_notes','runtime_state'] loop
    n := 0;
    begin execute format('select count(*) from public.%I', tbl) into n; exception when insufficient_privilege then n := 0; end;
    if n <> 0 then raise exception 'FAIL anon reads public.%', tbl; end if;
    c := c + 1;
  end loop;
  ok := false;
  begin insert into public.leads (email) values ('anon@example.com'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL anon inserted lead'; end if; c := c + 1;
  ok := false;
  begin perform public.update_tenant_settings(ta, '{"paused":true}'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL anon called update_tenant_settings'; end if; c := c + 1;
  if public.ping() <> 'ok' then raise exception 'FAIL ping'; end if; c := c + 1;
  ok := false;
  begin perform public.runtime_get_credential(ta, 'google'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL anon read a credential'; end if; c := c + 1;
  ok := false;
  begin insert into public.runtime_state (key, value) values ('anon', '1'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL anon wrote runtime_state'; end if; c := c + 1;

  -- ============================================================ jobs (as owner)
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  if private.expire_quotes() < 1 then raise exception 'FAIL expire_quotes'; end if; c := c + 1;
  ok := false;
  begin update public.quotes set status = 'accepted', accepted_name = 'B', agreement_version = '1.0-draft' where id = quo_b_sent;
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL expired quote accepted'; end if; c := c + 1;
  -- cancelled client C with a full history; plus a cancelled second client of B (B stays: has an active client)
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (uc, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-c@example.com', '{}', '{}', now(), now());
  update public.profiles set company = 'C Plumbing LLC', phone = '+17135550177' where id = uc;
  insert into public.questionnaires (user_id, offer, answers) values (uc, 'RCP', '{"phone":"+17135550177"}') returning id into qc;
  insert into public.quotes (user_id, questionnaire_id, items, setup_cents, monthly_cents, deposit_cents)
    values (uc, qc, '[{"code":"RCP","qty":1,"name":"Missed-Call AI Receptionist","reason":"Chris C said +1 713 555 0177 is busy"}]',
            350000, 30000, 175000) returning id into quo_c;
  update public.quotes set scope_md = 'For Chris C of C Plumbing, call +1 713 555 0177', timeline_text = 'Chris is away in May',
    assumptions = '["Chris C provides calendar access"]' where id = quo_c;
  update public.quotes set status = 'approved' where id = quo_c;
  update public.quotes set status = 'sent' where id = quo_c;
  update public.quotes set status = 'accepted', accepted_name = 'Chris C', agreement_version = '1.0-draft',
    accepted_ip = '198.51.100.7', accepted_ua = 'ua' where id = quo_c;
  select public_token into tok_c from public.quotes where id = quo_c;
  insert into public.quotes (user_id, items) values (uc, '[]') returning id into quo_c2;
  insert into private.quote_drafts (quote_id, model, prompt_hash, raw_output)
    values (quo_c, 'test-model', 'h', '{"name":"Chris C","phone":"+17135550177"}'), (quo_c2, 'test-model', 'h', '{}');
  insert into public.leads (email, niche) values ('rls-c@example.com', 'home_services') returning id into lc;
  insert into public.clients (user_id, quote_id, products, status) values (uc, quo_c, '{RCP}', 'cancelled') returning id into cc;
  update public.clients set ended_at = now() - interval '31 days' where id = cc;
  insert into public.payments (client_id, kind, amount_cents, status, method, reference)
    values (cc, 'deposit', 175000, 'paid', 'paypal_link', 'PayPal 9XK21 from chris@cplumbing.com tel +1 (713) 555-0177') returning id into pc;
  insert into public.tenants (client_id, slug, config) values (cc, 'rls-tenant-c', '{}') returning id into tc;
  insert into public.calls (tenant_id, call_sid, transcript) values (tc, 'CA_rls_c', '[{"r":"caller","t":"c"}]');
  insert into public.requests (client_id, title) values (cc, 'C request') returning id into rc;
  insert into public.runtime_state (key, tenant_id, value) values ('usage:' || tc::text || ':2026-10', tc, '{"min": 12}');
  insert into public.admin_notes (entity, entity_id, body) values ('client', cc, 'internal C'), ('quote', quo_c, 'q note'),
    ('quote', quo_c2, 'q2 note'), ('questionnaire', qc, 'qn note'), ('tenant', tc, 't note'), ('request', rc, 'r note'),
    ('lead', lc, 'lead note');
  insert into storage.objects (bucket_id, name, owner) values ('client-files', uc::text || '/' || qc::text || '/abc999-c.pdf', uc);
  insert into public.attachments (owner_id, questionnaire_id, storage_path, filename, size)
    values (uc, qc, uc::text || '/' || qc::text || '/abc999-c.pdf', 'c.pdf', 10);
  insert into public.clients (user_id, products, status) values (ub, '{RCP}', 'cancelled') returning id into cx;
  update public.clients set ended_at = now() - interval '31 days' where id = cx;
  -- a client whose anonymisation fails must not stop the run
  insert into public.clients (user_id, products, status) values (ub, '{WEB}', 'cancelled') returning id into cy;
  update public.clients set ended_at = now() - interval '31 days' where id = cy;
  execute format($f$create function private._t_boom() returns trigger language plpgsql as $b$
    begin if new.id = %L::uuid then raise exception 'boom for test'; end if; return new; end $b$$f$, cy);
  create trigger _t_boom before update on public.clients for each row execute function private._t_boom();
  j := private.run_retention();
  drop trigger _t_boom on public.clients;
  select count(*) into n from public.sms_messages where body = 'old';
  if n <> 0 then raise exception 'FAIL retention sms'; end if; c := c + 1;
  select transcript is null into ok from public.calls where call_sid = 'CA_old';
  if not ok then raise exception 'FAIL retention transcript'; end if; c := c + 1;
  select transcript is not null into ok from public.calls where call_sid = 'CA_rls_a';
  if not ok then raise exception 'FAIL retention removed a fresh transcript'; end if; c := c + 1;
  if (j ->> 'clients_anonymized')::int <> 2 or (j ->> 'client_errors')::int <> 1 then
    raise exception 'FAIL retention count (%)', j; end if; c := c + 1;
  select count(*) into n from public.events where type = 'retention_error' and entity_id = cy and payload ->> 'error' like '%boom%';
  if n <> 1 then raise exception 'FAIL retention_error event missing'; end if; c := c + 1;
  select anonymized_at is null and user_id = ub into ok from public.clients where id = cy;
  if not coalesce(ok, false) then raise exception 'FAIL failed client partially changed'; end if; c := c + 1;
  select from_e164 is null into ok from public.calls where call_sid = 'CA_old';
  if not ok then raise exception 'FAIL caller number kept after 90 days'; end if; c := c + 1;
  select from_e164 is not null into ok from public.calls where call_sid = 'CA_rls_a';
  if not ok then raise exception 'FAIL fresh caller number cleared'; end if; c := c + 1;
  select user_id is null and anonymized_at is not null and business_name = 'C Plumbing LLC' into ok from public.clients where id = cc;
  if not coalesce(ok, false) then raise exception 'FAIL cancelled client row not kept+anonymised'; end if; c := c + 1;
  select amount_cents = 175000 and status = 'paid' and reference !~ '@' and reference !~ '555' and reference like 'PayPal 9XK21%'
    into ok from public.payments where id = pc;
  if not coalesce(ok, false) then raise exception 'FAIL payment not kept or PII not scrubbed'; end if; c := c + 1;
  select status = 'accepted' and setup_cents = 350000 and accepted_name is null and accepted_ip is null and user_id is null
    into ok from public.quotes where id = quo_c;
  if not coalesce(ok, false) then raise exception 'FAIL accepted quote not kept+anonymised'; end if; c := c + 1;
  select count(*) into n from public.quotes where user_id = uc;
  if n <> 0 then raise exception 'FAIL unaccepted quote of C kept'; end if; c := c + 1;
  select count(*) into n from auth.users where id = uc;
  if n <> 0 then raise exception 'FAIL C auth user not deleted'; end if; c := c + 1;
  select count(*) into n from public.profiles where id = uc;
  if n <> 0 then raise exception 'FAIL C profile not deleted'; end if; c := c + 1;
  select count(*) into n from public.questionnaires where id = qc;
  if n <> 0 then raise exception 'FAIL C questionnaire not deleted'; end if; c := c + 1;
  select count(*) into n from public.attachments where owner_id = uc;
  if n <> 0 then raise exception 'FAIL C attachments not deleted'; end if; c := c + 1;
  select count(*) into n from public.tenants where id = tc;
  if n <> 0 then raise exception 'FAIL C tenant not deleted'; end if; c := c + 1;
  select count(*) into n from public.calls where call_sid = 'CA_rls_c';
  if n <> 0 then raise exception 'FAIL C calls not deleted'; end if; c := c + 1;
  select count(*) into n from public.runtime_state where tenant_id = tc;
  if n <> 0 then raise exception 'FAIL C runtime_state not deleted'; end if; c := c + 1;
  select count(*) into n from public.requests where id = rc;
  if n <> 0 then raise exception 'FAIL C requests not deleted'; end if; c := c + 1;
  select count(*) into n from public.admin_notes where entity_id = cc;
  if n <> 0 then raise exception 'FAIL C internal notes not deleted'; end if; c := c + 1;
  select count(*) into n from public.admin_notes where entity_id in (cc, quo_c, quo_c2, qc, tc, rc, lc);
  if n <> 0 then raise exception 'FAIL C notes left on other entities (%)', n; end if; c := c + 1;
  select count(*) into n from private.quote_drafts where quote_id in (quo_c, quo_c2);
  if n <> 0 then raise exception 'FAIL C quote drafts left (%)', n; end if; c := c + 1;
  select scope_md is null and timeline_text is null and assumptions = '[]'::jsonb
     and items::text !~ '(Chris|555|reason)' and items -> 0 ->> 'code' = 'RCP'
    into ok from public.quotes where id = quo_c;
  if not coalesce(ok, false) then raise exception 'FAIL personal text left in kept quote'; end if; c := c + 1;
  select anonymized and public_token <> tok_c and length(public_token) >= 32 into ok from public.quotes where id = quo_c;
  if not coalesce(ok, false) then raise exception 'FAIL kept quote token not rotated/flagged'; end if; c := c + 1;
  select count(*) into n from public.quotes where public_token = tok_c;
  if n <> 0 then raise exception 'FAIL old quote link still resolves'; end if; c := c + 1;
  ok := false;
  begin update public.quotes set anonymized = false where id = quo_c; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL anonymisation reversible'; end if; c := c + 1;
  select count(*) into n from public.leads where id = lc;
  if n <> 0 then raise exception 'FAIL C lead kept'; end if; c := c + 1;
  select count(*) into n from public.events where user_id = uc;
  if n <> 0 then raise exception 'FAIL C events not deleted'; end if; c := c + 1;
  select count(*) into n from private.storage_purge_queue where name like uc::text || '/%' and done_at is null;
  if n <> 1 then raise exception 'FAIL C storage file not queued for purge (%)', n; end if; c := c + 1;
  select count(*) into n from auth.users where id = ub;
  if n <> 1 then raise exception 'FAIL B deleted although B has an active client'; end if; c := c + 1;
  select user_id is null and anonymized_at is not null into ok from public.clients where id = cx;
  if not coalesce(ok, false) then raise exception 'FAIL B cancelled client not anonymised'; end if; c := c + 1;
  j := private.run_retention();
  if (j ->> 'clients_anonymized')::int <> 1 or (j ->> 'client_errors')::int <> 0 then raise exception 'FAIL failed client not retried (%)', j; end if; c := c + 1;
  j := private.run_retention();
  if (j ->> 'clients_anonymized')::int <> 0 or (j ->> 'client_errors')::int <> 0 then raise exception 'FAIL retention not idempotent (%)', j; end if; c := c + 1;
  select count(*) into n from public.clients where id in (ca, cb);
  if n <> 2 then raise exception 'FAIL retention removed active clients'; end if; c := c + 1;

  raise exception 'RLS_TESTS_PASSED (% checks)', c;
end $test$;
