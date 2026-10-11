-- A8 migration checks (20261011100500_us_email_events.sql). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with EMAIL_EVENTS_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/email_events_run.ts
-- Needs the net/vault stand-ins that email_events_run.ts creates (never on a real project: there they exist already).
do $$
declare
  ua uuid := gen_random_uuid(); um uuid := gen_random_uuid();
  qa uuid; qb uuid; quo uuid; cl uuid; cl2 uuid; rq uuid; it uuid; pay uuid; ob bigint;
  n int; k int; v jsonb; t text; ok boolean; checks int := 0;
  acc text := 'quote' || '_accepted';
begin
  insert into auth.users (id, email) values (ua, 'Dani@Example.com'), (um, (select admin_email from private.settings where id = 1));
  update public.profiles set full_name = 'Dani Levin', company = 'Cool Breeze HVAC' where id = ua;

  -- 1. questionnaire submitted -> q_received + draft task, once
  insert into public.questionnaires (user_id, offer, niche) values (ua, 'RCP', 'home_services') returning id into qa;
  update public.questionnaires set status = 'submitted' where id = qa;
  update public.questionnaires set answers = '{"x":1}' where id = qa;
  select count(*) into n from private.email_outbox where idem_key in ('q_received:' || qa, 'task:draft_quote:' || qa);
  if n <> 2 then raise exception 'FAIL submit -> q_received + task (got %)', n; end if;
  select audience into t from private.email_outbox where idem_key = 'task:draft_quote:' || qa;
  if t <> 'system' then raise exception 'FAIL task audience'; end if;
  checks := checks + 2;

  -- 2. A6 email_requested events -> outbox; duplicates collapse, admin_new_quote may repeat, unknown never blocks
  insert into public.quotes (questionnaire_id, user_id, status, items, setup_cents, monthly_cents, deposit_cents)
    values (qa, ua, 'draft', '[{"code":"RCP","qty":1,"name":"Receptionist"}]', 350000, 30000, 175000) returning id into quo;
  insert into public.events (actor, entity, entity_id, user_id, type, payload) values
    ('system', 'quote', quo, ua, 'email_requested', '{"template":"admin_new_quote"}'),
    ('system', 'quote', quo, ua, 'email_requested', '{"template":"admin_new_quote"}'),
    ('system', 'quote', quo, ua, 'email_requested', '{"template":"quote_sent"}'),
    ('system', 'quote', quo, ua, 'email_requested', '{"template":"quote_sent"}'),
    ('system', 'quote', quo, ua, 'email_requested', jsonb_build_object('template', acc)),
    ('system', 'quote', quo, ua, 'email_requested', '{"template":"bogus_template"}');
  select count(*) into n from private.email_outbox where template = 'admin_new_quote' and entity_id = quo;
  if n <> 2 then raise exception 'FAIL admin_new_quote per event (got %)', n; end if;
  select count(*) into n from private.email_outbox where template = 'quote_sent' and entity_id = quo;
  if n <> 1 then raise exception 'FAIL quote_sent must collapse to one row (got %)', n; end if;
  select audience into t from private.email_outbox where template = 'admin_new_quote' limit 1;
  if t <> 'admin' then raise exception 'FAIL admin audience'; end if;
  select count(*) into n from public.events where type = 'email_enqueue_error' and payload ->> 'template' = 'bogus_template';
  if n <> 1 then raise exception 'FAIL unknown template must log email_enqueue_error'; end if;
  checks := checks + 4;

  -- 3. never block the business write: outbox gone -> submit still works, error logged
  alter table private.email_outbox rename to email_outbox_x;
  insert into public.questionnaires (user_id, offer, niche) values (ua, 'WEB', 'home_services') returning id into qb;
  update public.questionnaires set status = 'submitted' where id = qb;
  select status::text into t from public.questionnaires where id = qb;
  alter table private.email_outbox_x rename to email_outbox;
  if t <> 'submitted' then raise exception 'FAIL submit blocked by email outbox'; end if;
  select count(*) into n from public.events where type = 'email_enqueue_error' and entity_id = qb;
  if n < 1 then raise exception 'FAIL enqueue error not logged'; end if;
  checks := checks + 2;

  -- 4. client lifecycle: deposit paid, testing, live, final payment, go-live request, request status, need_help, lead
  insert into public.clients (user_id, quote_id, products, monthly_cents) values (ua, quo, '{RCP}', 30000) returning id into cl;
  insert into public.payments (client_id, kind, amount_cents) values (cl, 'deposit', 175000) returning id into pay;
  update public.payments set status = 'paid' where id = pay;
  update public.payments set reference = 'PP-1' where id = pay;
  update public.payments set status = 'paid' where id = pay;
  select count(*) into n from private.email_outbox where idem_key = 'deposit_received:' || cl;
  if n <> 1 then raise exception 'FAIL deposit_received once (got %)', n; end if;
  update public.clients set status = 'testing' where id = cl;
  update public.clients set status = 'live' where id = cl;
  select count(*) into n from private.email_outbox where idem_key in ('ready_to_test:' || cl, 'went_live:' || cl);
  if n <> 2 then raise exception 'FAIL ready_to_test + went_live'; end if;
  insert into public.payments (client_id, kind, amount_cents) values (cl, 'final', 175000);
  insert into public.events (actor, entity, entity_id, user_id, type) values ('client', 'client', cl, ua, 'go_live_requested');
  select count(*) into n from private.email_outbox where template = 'final_payment_due';
  if n <> 1 then raise exception 'FAIL final_payment_due once per client (got %)', n; end if;
  insert into public.requests (client_id, title) values (cl, 'Filter size question') returning id into rq;
  update public.requests set status = 'active' where id = rq;
  update public.requests set status = 'done', admin_reply = 'Added.' where id = rq;
  select count(*) into n from private.email_outbox where template = 'request_update' and entity_id = rq;
  if n <> 2 then raise exception 'FAIL request_update per status change (got %)', n; end if;
  insert into public.onboarding_items (client_id, key, title) values (cl, 'calendar_x', 'Connect your calendar') returning id into it;
  insert into public.leads (email, niche) values ('lead@example.com', 'home_services'), ('LEAD@example.com', 'home_services');
  select count(*) into n from private.email_outbox where template = 'lead_capture';
  if n <> 1 then raise exception 'FAIL lead_capture once per address per day (got %)', n; end if;
  checks := checks + 6;

  -- 5. client presses Need help (real RPC, as the client) -> admin mail; a second press the same day collapses
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.update_onboarding_item(it, 'need_help', '{"help_message":"Which calendar?"}');
  perform public.update_onboarding_item(it, 'need_help', '{"help_message":"Still stuck"}');
  -- clients cannot reach the dispatcher RPCs, the outbox or admin_log_event
  begin perform public.email_claim(); raise exception 'FAIL client ran email_claim';
  exception when insufficient_privilege then null; end;
  begin perform public.email_settings(); raise exception 'FAIL client ran email_settings';
  exception when insufficient_privilege then null; end;
  begin perform public.email_unsubscribe(repeat('a', 64)); raise exception 'FAIL client ran email_unsubscribe';
  exception when insufficient_privilege then null; end;
  begin perform 1 from private.email_outbox; raise exception 'FAIL client reads outbox';
  exception when insufficient_privilege then null; end;
  begin perform public.admin_log_event('client', cl, 'payment_marked'); raise exception 'FAIL client ran admin_log_event';
  exception when insufficient_privilege then null; end;
  -- admin: admin_log_event works, cannot forge email/status events
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  perform public.admin_log_event('payment', pay, 'payment_marked_paid', '{"reference":"PP-1"}');
  begin perform public.admin_log_event('quote', quo, 'email_requested', '{"template":"quote_sent"}'); raise exception 'FAIL admin forged email event';
  exception when sqlstate 'P0001' then null; end;
  begin perform public.admin_log_event('quote', quo, 'status_changed'); raise exception 'FAIL admin forged status event';
  exception when sqlstate 'P0001' then null; end;
  begin perform public.email_claim(); raise exception 'FAIL admin JWT ran email_claim';
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  select count(*) into n from private.email_outbox where template = 'need_help' and entity_id = it;
  if n <> 1 then raise exception 'FAIL need_help once per item per day (got %)', n; end if;
  select count(*) into n from public.events where type = 'payment_marked_paid' and user_id = ua and actor = 'admin:' || um and not client_visible;
  if n <> 1 then raise exception 'FAIL admin_log_event row'; end if;
  checks := checks + 8;

  -- 6. claim -> ctx -> complete; a claimed row is invisible to a second claim; completion is one-way
  v := public.email_claim('email', 100);
  if jsonb_array_length(v) < 10 then raise exception 'FAIL claim size %', jsonb_array_length(v); end if;
  select e -> 'ctx' ->> 'to' into t from jsonb_array_elements(v) e where e ->> 'idem_key' = 'q_received:' || qa;
  if t <> 'Dani@Example.com' then raise exception 'FAIL client recipient = profile e-mail (got %)', t; end if;
  select e -> 'ctx' ->> 'to' into t from jsonb_array_elements(v) e where e ->> 'template' = 'need_help';
  if t is distinct from (select admin_email from private.settings where id = 1) then raise exception 'FAIL admin recipient'; end if;
  select e -> 'ctx' -> 'item' ->> 'message' into t from jsonb_array_elements(v) e where e ->> 'template' = 'need_help';
  if t <> 'Still stuck' then raise exception 'FAIL need_help message in ctx'; end if;
  select e -> 'ctx' ->> 'skip' into t from jsonb_array_elements(v) e where e ->> 'template' = 'quote_sent';
  if t <> 'quote_not_sent' then raise exception 'FAIL quote_sent of a draft must be skipped (got %)', t; end if;
  select (e -> 'ctx' ->> 'final_cents')::int into k from jsonb_array_elements(v) e where e ->> 'template' = 'final_payment_due';
  select e -> 'ctx' -> 'payment' ->> 'amount_cents' into t from jsonb_array_elements(v) e where e ->> 'template' = 'final_payment_due';
  if t <> '175000' then raise exception 'FAIL final payment amount in ctx (got %/%)', t, k; end if;
  select e -> 'ctx' -> 'quote' ? 'accepted_ip' into ok from jsonb_array_elements(v) e where e ->> 'template' = 'admin_new_quote' limit 1;
  if ok then raise exception 'FAIL ctx leaks accepted_ip'; end if;
  select count(*) into n from jsonb_array_elements(v) e where e ->> 'audience' = 'system';
  if n <> 0 then raise exception 'FAIL email claim returned tasks'; end if;
  if jsonb_array_length(public.email_claim('email', 100)) <> 0 then raise exception 'FAIL double claim'; end if;
  select (e ->> 'id')::bigint into ob from jsonb_array_elements(v) e where e ->> 'idem_key' = 'q_received:' || qa;
  if public.email_complete(ob, 'sent', 're_123') <> 'sent' then raise exception 'FAIL complete'; end if;
  if public.email_complete(ob, 'retry', null, 'late worker', now()) <> 'ignored' then raise exception 'FAIL sent row reopened'; end if;
  select status into t from private.email_outbox where id = ob;
  if t <> 'sent' then raise exception 'FAIL sent is final'; end if;
  select count(*) into n from public.events where type = 'email_sent' and payload ->> 'outbox_id' = ob::text;
  if n <> 1 then raise exception 'FAIL email_sent event'; end if;
  checks := checks + 11;

  -- retry with a future time is not claimable; an expired lock is re-claimed (crash recovery) with attempts + 1
  select (e ->> 'id')::bigint into ob from jsonb_array_elements(v) e where e ->> 'idem_key' = 'deposit_received:' || cl;
  perform public.email_complete(ob, 'retry', null, 'resend 503', now() + interval '1 hour');
  if jsonb_array_length(public.email_claim('email', 100)) <> 0 then raise exception 'FAIL retry claimable before its time'; end if;
  update private.email_outbox set next_attempt_at = now() - interval '1 second' where id = ob;
  update private.email_outbox set locked_until = now() - interval '1 second' where status = 'sending' and template = 'went_live';
  v := public.email_claim('email', 100);
  select count(*) into n from jsonb_array_elements(v) e where (e ->> 'id')::bigint = ob or e ->> 'template' = 'went_live';
  select max((e ->> 'attempts')::int) into k from jsonb_array_elements(v) e;
  if n <> 2 or k <> 2 then raise exception 'FAIL re-claim after retry/lock expiry (n %, attempts %)', n, k; end if;
  perform public.email_complete(ob, 'defer', null, 'quiet', now() + interval '2 hours');
  select attempts into k from private.email_outbox where id = ob;
  if k <> 1 then raise exception 'FAIL defer must not count an attempt (got %)', k; end if;
  perform public.email_complete((select id from private.email_outbox where template = 'went_live'), 'skipped', null, 'client_emails_disabled');
  select count(*) into n from public.events where type = 'email_skipped' and payload ->> 'reason' = 'client_emails_disabled';
  if n <> 1 then raise exception 'FAIL skipped logged'; end if;
  begin perform public.email_complete(ob, 'bogus'); raise exception 'FAIL bad result accepted';
  exception when sqlstate 'P0001' then null; end;
  checks := checks + 5;

  -- tasks are claimed separately and say whether a quote already exists
  v := public.email_claim('task', 5);
  select (e -> 'ctx' ->> 'has_quote')::boolean into ok from jsonb_array_elements(v) e where e ->> 'idem_key' = 'task:draft_quote:' || qa;
  if ok is not true then raise exception 'FAIL task ctx has_quote'; end if;
  checks := checks + 1;

  -- 7. scheduled: reminder 3 days after sent (once), nudge after 3 quiet days (once per 3 days, max 3), monthly invoice
  update public.quotes set status = 'approved' where id = quo;
  update public.quotes set status = 'sent' where id = quo;
  v := private.enqueue_scheduled_emails(now() + interval '4 days');
  v := private.enqueue_scheduled_emails(now() + interval '4 days');
  select count(*) into n from private.email_outbox where idem_key = 'quote_reminder:' || quo;
  if n <> 1 then raise exception 'FAIL quote_reminder once (got %)', n; end if;
  v := private.enqueue_scheduled_emails(now() + interval '1 day');
  insert into public.clients (user_id, products) values (ua, '{RCP}') returning id into cl2;
  insert into public.onboarding_items (client_id, key, title, sort) values (cl2, 'hours_x', 'Business hours', 1), (cl2, 'faq_x', 'FAQ', 2);
  v := private.enqueue_scheduled_emails(now() + interval '1 day');
  select count(*) into n from private.email_outbox where template = 'onboarding_nudge' and entity_id = cl2;
  if n <> 0 then raise exception 'FAIL nudge before 3 quiet days'; end if;
  v := private.enqueue_scheduled_emails(now() + interval '4 days');
  v := private.enqueue_scheduled_emails(now() + interval '5 days');
  select count(*) into n from private.email_outbox where template = 'onboarding_nudge' and entity_id = cl2;
  if n <> 1 then raise exception 'FAIL nudge more than once per 3 days (got %)', n; end if;
  v := private.enqueue_scheduled_emails(now() + interval '8 days');
  v := private.enqueue_scheduled_emails(now() + interval '12 days');
  v := private.enqueue_scheduled_emails(now() + interval '16 days');
  select count(*) into n from private.email_outbox where template = 'onboarding_nudge' and entity_id = cl2;
  if n <> 3 then raise exception 'FAIL nudge cadence/cap (got %)', n; end if;
  n := private.enqueue_monthly_invoices(now() + interval '40 days');
  k := private.enqueue_monthly_invoices(now() + interval '40 days');
  if n <> 1 or k <> 0 then raise exception 'FAIL monthly invoice once per client per month (% / %)', n, k; end if;
  if private.enqueue_monthly_invoices(now()) <> 0 then raise exception 'FAIL invoice in the go-live month'; end if;
  checks := checks + 4;

  -- 8. unsubscribe tokens
  v := public.email_recipient('Dani@Example.com');
  if (v ->> 'unsubscribed')::boolean or length(v ->> 'token') < 32 then raise exception 'FAIL recipient token'; end if;
  if not public.email_unsubscribe(v ->> 'token') then raise exception 'FAIL unsubscribe'; end if;
  if public.email_unsubscribe(repeat('0', 64)) then raise exception 'FAIL unknown token'; end if;
  if not (public.email_recipient('dani@example.com') ->> 'unsubscribed')::boolean then raise exception 'FAIL unsubscribed flag (case-insensitive)'; end if;
  checks := checks + 3;

  -- 9. storage purge queue RPCs
  insert into private.storage_purge_queue (bucket_id, name) values ('client-files', ua || '/x/aaaaaa-a.pdf'), ('client-files', ua || '/x/bbbbbb-b.pdf');
  if jsonb_array_length(public.storage_purge_claim(10)) <> 2 then raise exception 'FAIL purge claim'; end if;
  if public.storage_purge_done('client-files', array[ua || '/x/aaaaaa-a.pdf']) <> 1 then raise exception 'FAIL purge done'; end if;
  if jsonb_array_length(public.storage_purge_claim(10)) <> 1 then raise exception 'FAIL purge claim after done'; end if;
  checks := checks + 3;

  -- 10. pg_net wiring: inert without Vault secrets; with them, POST to the function with the service key
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  if private.call_edge_function('quote-expiring') is not null then raise exception 'FAIL call without vault secrets'; end if;
  insert into vault.decrypted_secrets (name, decrypted_secret) values
    ('ailab_us_project_url', 'https://ref.supabase.co/'), ('ailab_us_service_role_key', 'svc-test-key');
  perform private.call_edge_function('quote-expiring');
  update private.email_outbox set next_attempt_at = now() - interval '1 minute', locked_until = null where status = 'pending';
  if private.kick_dispatch() is null then raise exception 'FAIL kick_dispatch with due rows'; end if;
  select count(*) into n from net._calls where url = 'https://ref.supabase.co/functions/v1/quote-expiring'
     and headers ->> 'Authorization' = 'Bearer svc-test-key';
  select count(*) into k from net._calls where url like '%/functions/v1/events-dispatch' and body ->> 'task' = 'email';
  if n <> 1 or k <> 1 then raise exception 'FAIL pg_net calls (% / %)', n, k; end if;
  if private.kick_storage_purge() is null then raise exception 'FAIL storage purge kick'; end if;
  v := private.install_email_jobs();
  v := private.install_email_jobs();
  select count(*) into n from cron.job where jobname like 'ailab-us-%';
  if n <> 7 then raise exception 'FAIL cron jobs installed idempotently (got %)', n; end if;
  select schedule into t from cron.job where jobname = 'ailab-us-quote-expiring';
  if t <> '30 14 * * *' then raise exception 'FAIL quote-expiring daily'; end if;
  begin perform private.call_edge_function('../x'); raise exception 'FAIL bad function name';
  exception when sqlstate 'P0001' then null; end;
  checks := checks + 6;

  raise exception 'EMAIL_EVENTS_TESTS_PASSED (% checks)', checks;
end $$;
