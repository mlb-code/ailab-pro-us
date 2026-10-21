-- PayPal checkout migration checks (20261021100000_us_paypal_enum.sql + 20261021100100_us_paypal_checkout.sql).
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with PAYPAL_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/paypal_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); um uuid := gen_random_uuid();
  qa uuid; qb uuid; qc uuid; qd uuid; tok text; tok_b text; tok_c text; tok_d text;
  cl uuid; cl_b uuid; cl_d uuid; dep uuid; fin uuid; j jsonb; v jsonb; n int; k int; t text; ok boolean; c int := 0;
  id_receipt bigint; id_dep bigint;
begin
  update private.settings set admin_email = 'pp-admin@example.com' where id = 1;
  insert into auth.users (id, email) values (ua, 'pp-a@example.com'), (ub, 'pp-b@example.com'), (um, 'pp-admin@example.com');
  update public.profiles set full_name = 'Dana Levin', company = 'Cool Breeze HVAC' where id = ua;
  -- A: accepted PayPal quote; B: accepted Upwork quote; C, D: accepted PayPal quotes for the Upwork switch
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents, pay_method)
    values (ua, 'draft', '[{"code":"RCP","qty":1,"name":"Missed-Call AI Receptionist"}]', 350000, 30000, 175000, 'paypal_checkout')
    returning id, public_token into qa, tok;
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents, pay_method)
    values (ub, 'draft', '[{"code":"WEB","qty":1,"name":"Business Website"}]', 190000, 12900, 95000, 'upwork')
    returning id, public_token into qb, tok_b;
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents, pay_method)
    values (ub, 'draft', '[{"code":"WEB","qty":1,"name":"Business Website"}]', 190000, 12900, 95000, 'paypal_checkout')
    returning id, public_token into qc, tok_c;
  insert into public.quotes (user_id, status, items, setup_cents, monthly_cents, deposit_cents, pay_method)
    values (ub, 'draft', '[{"code":"BNDL","qty":1,"name":"Bundle"}]', 490000, 40000, 245000, 'paypal_checkout')
    returning id, public_token into qd, tok_d;
  update public.quotes set status = 'approved' where id in (qa, qb, qc, qd);
  update public.quotes set status = 'sent' where id in (qa, qb, qc, qd);
  update public.quotes set status = 'accepted', accepted_name = 'Signer', agreement_version = '1.1' where id in (qa, qb, qc, qd);

  -- ---------------------------------------------------------------- 0. grants: the pay RPCs are service-role only
  -- (each also calls private.require_service(); this proves the grant layer on its own)
  select string_agg(p.proname, ',') into t from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and (p.proname like 'pay\_%' or p.proname like 'paypal\_%')
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
          or not has_function_privilege('service_role', p.oid, 'execute'));
  if t is not null then raise exception 'FAIL pay RPC grants: %', t; end if; c := c + 1;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and (p.proname like 'pay\_%' or p.proname like 'paypal\_%');
  if n <> 10 then raise exception 'FAIL expected 10 pay RPCs, found %', n; end if; c := c + 1;

  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ---------------------------------------------------------------- 1. pay_target: client card + rows, once
  j := public.pay_target(tok, 'deposit');
  dep := (j ->> 'payment_id')::uuid; cl := (j ->> 'client_id')::uuid;
  if (j ->> 'amount_cents')::bigint <> 175000 or j ->> 'status' <> 'due' or j ->> 'currency' <> 'USD' or j ->> 'kind' <> 'deposit' then
    raise exception 'FAIL pay_target deposit %', j; end if; c := c + 1;
  select count(*) into n from public.clients where quote_id = qa;
  select count(*) into k from public.payments where client_id = cl;
  if n <> 1 or k <> 2 then raise exception 'FAIL client card rows (clients %, payments %)', n, k; end if; c := c + 1;
  select bool_and(method = 'paypal_checkout' and status = 'due') into ok from public.payments where client_id = cl;
  if not ok then raise exception 'FAIL new rows: method paypal_checkout, due'; end if; c := c + 1;
  select business_name = 'Cool Breeze HVAC' and products = '{RCP}' and status = 'onboarding' and monthly_cents = 30000 into ok
    from public.clients where id = cl;
  if not ok then raise exception 'FAIL client card fields'; end if; c := c + 1;
  j := public.pay_target(tok, 'deposit');
  if (j ->> 'payment_id')::uuid <> dep or (select count(*) from public.clients where quote_id = qa) <> 1 then
    raise exception 'FAIL pay_target not idempotent'; end if; c := c + 1;
  select count(*) into n from private.email_outbox where template = 'final_payment_due';
  if n <> 0 then raise exception 'FAIL final row created with the card sent final_payment_due early (%)', n; end if; c := c + 1;

  -- refusals
  t := ''; begin perform public.pay_target(tok_b, 'deposit'); exception when others then t := sqlerrm; end;
  if t not like '%not_paypal%' then raise exception 'FAIL Upwork quote not refused (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_target('short', 'deposit'); exception when others then t := sqlerrm; end;
  if t not like '%not_found%' then raise exception 'FAIL bad token (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_target(tok, 'final'); exception when others then t := sqlerrm; end;
  if t not like '%deposit_not_paid%' then raise exception 'FAIL final before deposit (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_target(tok, 'monthly'); exception when others then t := sqlerrm; end;
  if t not like '%bad_which%' then raise exception 'FAIL which (%)', t; end if; c := c + 1;

  -- ---------------------------------------------------------------- 2. order + capture checks
  perform public.pay_set_order(dep, 'ORDER0000000001');
  select provider = 'paypal' and provider_order_id = 'ORDER0000000001' into ok from public.payments where id = dep;
  if not ok then raise exception 'FAIL pay_set_order'; end if; c := c + 1;
  t := ''; begin perform public.pay_record_capture(dep, 'ORDER0000000001', 'CAPTURE00000001', 175001, 'USD', null, true); exception when others then t := sqlerrm; end;
  if t not like '%amount_mismatch%' then raise exception 'FAIL amount mismatch accepted (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_record_capture(dep, 'ORDER0000000001', 'CAPTURE00000001', 175000, 'EUR', null, true); exception when others then t := sqlerrm; end;
  if t not like '%amount_mismatch%' then raise exception 'FAIL currency mismatch accepted (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_record_capture(dep, 'ORDER0000000099', 'CAPTURE00000001', 175000, 'USD', null, true); exception when others then t := sqlerrm; end;
  if t not like '%order_mismatch%' then raise exception 'FAIL other order accepted (%)', t; end if; c := c + 1;
  select status = 'due' and provider_capture_id is null into ok from public.payments where id = dep;
  if not ok then raise exception 'FAIL refused captures changed the row'; end if; c := c + 1;

  -- pending: ids stored, still due, no checklist, no mails; the Upwork switch and a new order are refused meanwhile
  j := public.pay_record_capture(dep, 'ORDER0000000001', 'CAPTURE00000001', 175000, 'USD', ' Payer@Example.COM ', false);
  if j ->> 'result' <> 'pending' then raise exception 'FAIL pending result %', j; end if; c := c + 1;
  select status = 'due' and provider_capture_id = 'CAPTURE00000001' and payer_email = 'payer@example.com' into ok from public.payments where id = dep;
  if not ok then raise exception 'FAIL pending row'; end if; c := c + 1;
  if (select count(*) from public.onboarding_items where client_id = cl) <> 0
     or (select count(*) from private.email_outbox where template in ('payment_receipt', 'deposit_received')) <> 0 then
    raise exception 'FAIL pending capture opened the checklist or sent mail'; end if; c := c + 1;
  t := ''; begin perform public.pay_use_upwork(tok); exception when others then t := sqlerrm; end;
  if t not like '%deposit_already_paid%' then raise exception 'FAIL switch to Upwork during a pending capture (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_set_order(dep, 'ORDER0000000002'); exception when others then t := sqlerrm; end;
  if t not like '%payment_not_open%' then raise exception 'FAIL new order during a pending capture (%)', t; end if; c := c + 1;
  -- PayPal declines a pending capture: it is forgotten (the client can pay again); another capture id changes nothing
  if public.pay_clear_capture(dep, 'CAPTURE99999999', 'DECLINED') ->> 'result' <> 'unchanged' then raise exception 'FAIL cleared another capture'; end if;
  j := public.pay_clear_capture(dep, 'CAPTURE00000001', 'DECLINED');
  select provider_capture_id is null and provider_order_id is null and status = 'due' into ok from public.payments where id = dep;
  if j ->> 'result' <> 'cleared' or not ok then raise exception 'FAIL pay_clear_capture %', j; end if; c := c + 1;
  if (select count(*) from public.events where type = 'payment_capture_failed' and entity_id = dep) <> 1 then raise exception 'FAIL capture_failed event'; end if;
  perform public.pay_set_order(dep, 'ORDER0000000001');   -- a new attempt (same order id for the rest of the test)
  j := public.pay_record_capture(dep, 'ORDER0000000001', 'CAPTURE00000001', 175000, 'USD', ' Payer@Example.COM ', false);
  if j ->> 'result' <> 'pending' then raise exception 'FAIL pending again %', j; end if; c := c + 1;

  -- completed (webhook): the mark-paid path -> checklist + deposit_received, receipt + owner notice; once
  j := public.pay_record_capture(dep, null, 'CAPTURE00000001', 175000, 'usd', null, true, 'webhook', 'card');
  if j ->> 'result' <> 'paid' then raise exception 'FAIL completed result %', j; end if; c := c + 1;
  select status = 'paid' and paid_at is not null and method = 'paypal_checkout' and payer_email = 'payer@example.com' into ok
    from public.payments where id = dep;
  if not ok then raise exception 'FAIL paid row'; end if; c := c + 1;
  select count(*) into n from public.onboarding_items where client_id = cl;
  if n <> 7 then raise exception 'FAIL checklist not opened by the capture (% items)', n; end if; c := c + 1;
  select id into id_receipt from private.email_outbox where idem_key = 'payment_receipt:' || dep;
  select id into id_dep from private.email_outbox where idem_key = 'deposit_received:' || cl;
  if id_receipt is null or id_dep is null or id_receipt > id_dep then raise exception 'FAIL receipt + deposit_received (% / %)', id_receipt, id_dep; end if; c := c + 1;
  select count(*) into n from private.email_outbox where idem_key = 'admin_payment_received:' || dep and audience = 'admin';
  if n <> 1 then raise exception 'FAIL owner notice'; end if; c := c + 1;
  select count(*) into n from public.events where type = 'payment_captured' and entity_id = dep and user_id = ua;
  if n <> 1 then raise exception 'FAIL payment_captured event'; end if; c := c + 1;
  j := public.pay_record_capture(dep, 'ORDER0000000001', 'CAPTURE00000001', 175000, 'USD', null, true);
  if j ->> 'result' <> 'already_paid' then raise exception 'FAIL repeat capture %', j; end if; c := c + 1;
  select count(*) into n from private.email_outbox where entity_id in (dep, cl);
  if n <> 3 then raise exception 'FAIL repeat capture sent more mail (%)', n; end if; c := c + 1;
  t := ''; begin perform public.pay_record_capture(dep, 'ORDER0000000001', 'CAPTURE00000002', 175000, 'USD', null, true); exception when others then t := sqlerrm; end;
  if t not like '%payment_not_due%' then raise exception 'FAIL second capture on a paid payment (%)', t; end if; c := c + 1;
  j := public.pay_target(tok, 'deposit');
  if j ->> 'status' <> 'paid' or j ->> 'provider_capture_id' <> 'CAPTURE00000001' then raise exception 'FAIL pay_target after payment %', j; end if; c := c + 1;

  -- ---------------------------------------------------------------- 3. e-mail context: pay_method + payment rows
  select private.email_context(id) into v from private.email_outbox where idem_key = 'deposit_received:' || cl;
  if v ->> 'pay_method' <> 'paypal_checkout' or v -> 'payment' ->> 'provider' <> 'paypal' or v -> 'payment' ->> 'id' <> dep::text then
    raise exception 'FAIL deposit_received ctx %', v; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'payment_receipt:' || dep;
  if v -> 'payment' ->> 'amount_cents' <> '175000' or v -> 'quote' ->> 'id' <> qa::text or v ->> 'to' <> 'pp-a@example.com'
     or v -> 'payment' ? 'payer_email' or v -> 'quote' ? 'accepted_ip' or v ->> 'pay_method' <> 'paypal_checkout' then
    raise exception 'FAIL payment_receipt ctx %', v; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_payment_received:' || dep;
  if v ->> 'to' <> 'pp-admin@example.com' or v -> 'payment' ->> 'payer_email' <> 'payer@example.com' or v -> 'client' ->> 'id' <> cl::text then
    raise exception 'FAIL admin_payment_received ctx %', v; end if; c := c + 1;
  -- Upwork client (B): client-level mails keep rendering Upwork, from the client's quote
  insert into public.clients (user_id, quote_id, products, status, monthly_cents) values (ub, qb, '{WEB}', 'live', 12900) returning id into cl_b;
  perform private.enqueue_email('monthly_invoice', 'monthly_invoice:test:' || cl_b, 'client', cl_b, ub, '{"month":"2026-11"}');
  select private.email_context(id) into v from private.email_outbox where idem_key = 'monthly_invoice:test:' || cl_b;
  if v ->> 'pay_method' <> 'upwork' then raise exception 'FAIL monthly_invoice pay_method %', v ->> 'pay_method'; end if; c := c + 1;
  -- final_payment_due on a final row insert only once go-live was requested
  insert into public.payments (client_id, kind, amount_cents) values (cl_b, 'final', 95000);
  if exists (select 1 from private.email_outbox where idem_key = 'final_payment_due:' || cl_b) then
    raise exception 'FAIL final_payment_due without a go-live request'; end if; c := c + 1;
  insert into public.onboarding_items (client_id, key, title, status, data)
    values (cl_b, 'web_content', 'Website content', 'done', jsonb_build_object('go_live_requested_at', now()));
  insert into public.payments (client_id, kind, amount_cents) values (cl_b, 'final', 95000);
  select count(*) into n from private.email_outbox where idem_key = 'final_payment_due:' || cl_b;
  if n <> 1 then raise exception 'FAIL final_payment_due after go-live request (%)', n; end if; c := c + 1;

  -- ---------------------------------------------------------------- 4. final payment
  t := ''; begin perform public.pay_target(tok, 'final'); exception when others then t := sqlerrm; end;
  if t not like '%final_not_ready%' then raise exception 'FAIL final during onboarding (%)', t; end if; c := c + 1;
  update public.clients set status = 'testing' where id = cl;
  j := public.pay_target(tok, 'final');
  fin := (j ->> 'payment_id')::uuid;
  if j ->> 'kind' <> 'final' or (j ->> 'amount_cents')::bigint <> 175000 or fin = dep then raise exception 'FAIL final target %', j; end if; c := c + 1;

  -- ---------------------------------------------------------------- 5. refunds + lookup
  t := ''; begin perform public.pay_mark_refunded(dep, 'CAPTURE00000099'); exception when others then t := sqlerrm; end;
  if t not like '%capture_mismatch%' then raise exception 'FAIL refund of another capture (%)', t; end if; c := c + 1;
  t := ''; begin perform public.pay_mark_refunded(fin, null); exception when others then t := sqlerrm; end;
  if t not like '%capture_mismatch%' then raise exception 'FAIL refund of an unpaid row (%)', t; end if; c := c + 1;
  j := public.pay_lookup(null, 'CAPTURE00000001', null);
  if (j ->> 'payment_id')::uuid <> dep or (j ->> 'checklist_items')::int <> 7 or j ->> 'quote_id' <> qa::text then
    raise exception 'FAIL pay_lookup by capture %', j; end if; c := c + 1;
  if public.pay_lookup(null, 'NOPE000000000', null) is not null then raise exception 'FAIL pay_lookup unknown capture'; end if; c := c + 1;
  if (public.pay_lookup(null, null, 'ORDER0000000001') ->> 'payment_id')::uuid <> dep then raise exception 'FAIL pay_lookup by order'; end if; c := c + 1;
  j := public.pay_mark_refunded(dep, 'CAPTURE00000001', 'admin:test', 'changed mind');
  if j ->> 'result' <> 'refunded' or (select status from public.payments where id = dep) <> 'refunded' then raise exception 'FAIL refund %', j; end if; c := c + 1;
  if public.pay_mark_refunded(dep, 'CAPTURE00000001') ->> 'result' <> 'already_refunded' then raise exception 'FAIL refund twice'; end if; c := c + 1;
  select count(*) into n from public.events where type = 'payment_refunded' and entity_id = dep;
  if n <> 1 then raise exception 'FAIL payment_refunded event (%)', n; end if; c := c + 1;

  -- ---------------------------------------------------------------- 6. switch to Upwork from the quote page
  j := public.pay_use_upwork(tok_c);
  if j ->> 'result' <> 'switched' or (select pay_method::text from public.quotes where id = qc) <> 'upwork' then
    raise exception 'FAIL switch %', j; end if; c := c + 1;
  select count(*) into n from private.email_outbox where idem_key = 'admin_upwork_requested:' || qc and audience = 'admin';
  if n <> 1 then raise exception 'FAIL Upwork request mail (%)', n; end if; c := c + 1;
  if public.pay_use_upwork(tok_c) ->> 'result' <> 'already' then raise exception 'FAIL switch twice'; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_upwork_requested:' || qc;
  if v -> 'quote' ->> 'id' <> qc::text or v ->> 'to' <> 'pp-admin@example.com' then raise exception 'FAIL Upwork request ctx %', v; end if; c := c + 1;
  t := ''; begin perform public.pay_target(tok_c, 'deposit'); exception when others then t := sqlerrm; end;
  if t not like '%not_paypal%' then raise exception 'FAIL PayPal after the switch (%)', t; end if; c := c + 1;
  -- a quote whose card already exists: the unpaid rows follow the quote to Upwork
  j := public.pay_target(tok_d, 'deposit');
  cl_d := (j ->> 'client_id')::uuid;
  perform public.pay_set_order((j ->> 'payment_id')::uuid, 'ORDER0000000003');
  perform public.pay_use_upwork(tok_d);
  select bool_and(method = 'upwork' and provider is null and provider_order_id is null) into ok from public.payments where client_id = cl_d;
  if not ok then raise exception 'FAIL unpaid rows not moved to Upwork'; end if; c := c + 1;

  -- ---------------------------------------------------------------- 7. webhook log + owner alerts
  if public.paypal_event_seen('WH-TEST-1') then raise exception 'FAIL unseen event reported seen'; end if;
  if not public.paypal_event_log('WH-TEST-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAPTURE00000001', dep, 'paid') then raise exception 'FAIL event log'; end if;
  if public.paypal_event_log('WH-TEST-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAPTURE00000001', dep, 'paid') then raise exception 'FAIL event logged twice'; end if;
  if not public.paypal_event_seen('WH-TEST-1') then raise exception 'FAIL seen event'; end if; c := c + 1;
  if not public.paypal_alert('dispute', dep, 'PP-D-0001', '{"reason":"MERCHANDISE_OR_SERVICE_NOT_RECEIVED"}') then raise exception 'FAIL alert'; end if;
  if public.paypal_alert('dispute', dep, 'PP-D-0001', '{}') then raise exception 'FAIL alert twice'; end if;
  if not public.paypal_alert('unknown_capture', null, 'CAPTURE77777777', '{}') then raise exception 'FAIL alert without a payment'; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_paypal_alert:dispute:PP-D-0001';
  if v ->> 'to' <> 'pp-admin@example.com' or v -> 'payment' ->> 'id' <> dep::text or v -> 'profile' ->> 'company' <> 'Cool Breeze HVAC' then
    raise exception 'FAIL alert ctx %', v; end if; c := c + 1;
  select private.email_context(id) into v from private.email_outbox where idem_key = 'admin_paypal_alert:unknown_capture:CAPTURE77777777';
  if v ->> 'to' <> 'pp-admin@example.com' or v ? 'skip' then raise exception 'FAIL alert ctx without payment %', v; end if; c := c + 1;
  t := ''; begin perform public.paypal_alert('lottery', dep, 'x', '{}'); exception when others then t := sqlerrm; end;
  if t not like '%bad_alert_kind%' then raise exception 'FAIL bad alert kind (%)', t; end if; c := c + 1;

  -- ---------------------------------------------------------------- 8. RLS: clients read their own rows, write nothing
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.payments where provider_capture_id = 'CAPTURE00000001';
  if n <> 1 then raise exception 'FAIL A cannot read its PayPal payment'; end if; c := c + 1;
  update public.payments set status = 'paid', provider_capture_id = 'CAPTUREFORGED01' where id = fin;
  select status = 'due' and provider_capture_id is null into ok from public.payments where id = fin;
  if not ok then raise exception 'FAIL client wrote a payment'; end if; c := c + 1;
  begin perform public.pay_target(tok, 'deposit'); raise exception 'FAIL client ran pay_target';
  exception when insufficient_privilege then null; end;
  begin perform public.pay_record_capture(fin, null, 'CAPTUREFORGED01', 175000, 'USD', null, true); raise exception 'FAIL client ran pay_record_capture';
  exception when insufficient_privilege then null; end;
  begin perform public.pay_mark_refunded(dep, 'CAPTURE00000001'); raise exception 'FAIL client ran pay_mark_refunded';
  exception when insufficient_privilege then null; end;
  begin perform public.pay_use_upwork(tok); raise exception 'FAIL client ran pay_use_upwork';
  exception when insufficient_privilege then null; end;
  begin perform public.paypal_alert('dispute', dep, 'x', '{}'); raise exception 'FAIL client ran paypal_alert';
  exception when insufficient_privilege then null; end;
  begin perform public.pay_clear_capture(dep, 'CAPTURE00000001', 'x'); raise exception 'FAIL client ran pay_clear_capture';
  exception when insufficient_privilege then null; end;
  begin perform 1 from private.paypal_events; raise exception 'FAIL client reads paypal_events';
  exception when insufficient_privilege then null; end;
  c := c + 6;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.payments where client_id = cl;
  if n <> 0 then raise exception 'FAIL B sees A payments'; end if; c := c + 1;
  -- admin may still correct a payment row by hand (policy payments_admin_write)
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  update public.payments set reference = 'checked' where id = dep;
  if (select reference from public.payments where id = dep) is distinct from 'checked' then raise exception 'FAIL admin write'; end if; c := c + 1;

  -- ---------------------------------------------------------------- 9. retention: the payer e-mail goes with the client
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.clients set anonymized_at = now() where id = cl;
  select count(*) into n from public.payments where client_id = cl and payer_email is not null;
  if n <> 0 then raise exception 'FAIL payer_email kept after anonymisation'; end if; c := c + 1;

  raise exception 'PAYPAL_TESTS_PASSED (% checks)', c;
end $$;
