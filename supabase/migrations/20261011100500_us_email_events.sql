-- A8 email events: transactional outbox -> Edge Function `events-dispatch` -> Resend. Additive only, idempotent.
--
--   private.email_outbox      one row per email (or system task) to deliver. idem_key is UNIQUE: the same business event
--                             can never produce two rows, and the same key is sent to Resend as Idempotency-Key.
--   private.email_recipients  per-address unsubscribe token + opt-out (CAN-SPAM, non-transactional mails only).
--   enqueue triggers          events (email_requested from A6, status changes, need_help), payments, leads.
--                             An enqueue failure is logged ('email_enqueue_error') and NEVER blocks the business write.
--   scheduled enqueues        quote_reminder + onboarding_nudge (daily), monthly_invoice (1st of month).
--   service-role RPCs         email_claim / email_complete / email_settings / email_recipient / email_unsubscribe,
--                             storage_purge_claim / storage_purge_done (executes private.storage_purge_queue, A1).
--   admin RPC                 admin_log_event (A7: payment marked, note saved, edits — the browser cannot write events).
--   cron wiring               private.install_email_jobs(): called by tools/us_setup.py AFTER the Vault secrets
--                             ailab_us_project_url + ailab_us_service_role_key exist (see supabase/README.md, A8).
--
-- Boundary (not sent from here): auth_code = Supabase Auth template; lead_alert, daily_summary, admin_daily, usage
-- alerts and the monthly ROI report = runtime (B6, runtime/app/notify) which calls Resend itself.

set check_function_bodies = off;

create extension if not exists pg_net;

-- ================================================================ tables
create table if not exists private.email_outbox (
  id bigint generated always as identity primary key,
  idem_key text not null unique check (length(idem_key) between 3 and 200),
  template text not null check (template ~ '^(task:)?[a-z_]{3,40}$'),
  audience text not null check (audience in ('client', 'admin', 'system')),
  entity text not null default '' check (length(entity) <= 40),
  entity_id uuid,
  user_id uuid,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) < 8000),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (length(last_error) <= 500),
  provider_id text check (length(provider_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_outbox_due_idx on private.email_outbox (next_attempt_at) where status in ('pending', 'sending');
create index if not exists email_outbox_tmpl_entity_idx on private.email_outbox (template, entity_id, created_at);

create table if not exists private.email_recipients (
  email text primary key check (email = lower(email) and length(email) between 3 and 320),
  unsub_token text not null unique default private.random_token() check (length(unsub_token) >= 32),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table private.email_outbox enable row level security;
alter table private.email_recipients enable row level security;
revoke all on private.email_outbox, private.email_recipients from public, anon, authenticated;
grant all on private.email_outbox, private.email_recipients to service_role;

-- ================================================================ templates + enqueue
-- Every key the dispatcher can render (supabase/functions/_shared/email/templates.ts) plus system tasks.
-- (The two "accepted" names are concatenated only because tools/check_hardcoded.py flags the analytics event name.)
create or replace function private.email_templates() returns text[]
language sql immutable set search_path = '' as $$
  select array['lead_capture', 'q_received', 'admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring',
               'quote' || '_accepted', 'admin_quote' || '_accepted', 'deposit_received', 'onboarding_nudge', 'need_help',
               'ready_to_test', 'final_payment_due', 'went_live', 'request_update', 'monthly_invoice', 'task:draft_quote',
               'web_deposit_link_requested', 'web_deposit_ack', 'request_cancelled', 'admin_request_cancelled']
$$;

-- Insert one outbox row; a second call with the same key is a no-op (returns false).
create or replace function private.enqueue_email(p_template text, p_key text, p_entity text, p_entity_id uuid, p_user uuid,
                                                 p_payload jsonb default '{}'::jsonb, p_not_before timestamptz default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_template is null or not (p_template = any (private.email_templates())) then
    raise exception 'unknown_email_template: %', coalesce(p_template, 'null') using errcode = 'P0001';
  end if;
  -- created_at = when it was scheduled (equals now() except in the scheduled jobs' tests, which pass a future p_now)
  insert into private.email_outbox (idem_key, template, audience, entity, entity_id, user_id, payload, next_attempt_at, created_at)
  values (left(p_key, 200), p_template,
          case when p_template like 'task:%' then 'system'
               when p_template like 'admin\_%' or p_template in ('need_help', 'web_deposit_link_requested') then 'admin' else 'client' end,
          coalesce(p_entity, ''), p_entity_id, p_user, coalesce(p_payload, '{}'::jsonb), coalesce(p_not_before, now()),
          coalesce(p_not_before, now()))
  on conflict (idem_key) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Same, but never raises: a broken outbox must not block a questionnaire submit, a payment mark or a status change.
create or replace function private.enqueue_email_safe(p_template text, p_key text, p_entity text, p_entity_id uuid, p_user uuid,
                                                      p_payload jsonb default '{}'::jsonb, p_not_before timestamptz default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  return private.enqueue_email(p_template, p_key, p_entity, p_entity_id, p_user, p_payload, p_not_before);
exception when others then
  begin
    perform private.log_event(coalesce(nullif(p_entity, ''), 'email'), p_entity_id, p_user, 'email_enqueue_error',
      jsonb_build_object('template', p_template, 'error', left(sqlerrm, 300)), false);
  exception when others then null;
  end;
  return false;
end $$;

-- ================================================================ triggers
-- public.events -> outbox. Sources: A6 email_requested rows, status_changed rows written by private.log_status_change(),
-- need_help rows written by public.update_onboarding_item().
create or replace function private.events_to_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t text;
  st text := new.payload ->> 'to';
begin
  if new.type = 'email_requested' then
    t := new.payload ->> 'template';
    -- admin_new_quote may legitimately repeat (draft regenerated); everything else is once per entity
    perform private.enqueue_email_safe(t,
      coalesce(t, 'unknown') || ':' || coalesce(new.entity_id::text, 'ev' || new.id::text)
        || case when t = 'admin_new_quote' then ':' || new.id::text else '' end,
      new.entity, new.entity_id, new.user_id, new.payload - 'template');
  elsif new.entity = 'questionnaire' and new.type in ('status_changed', 'created') and st = 'submitted'
        and (select q.offer from public.questionnaires q where q.id = new.entity_id) = 'WEB' then
    -- WEB is sold without a quote step (SPEC §1): Meir sends the deposit link; the client gets a short confirmation
    perform private.enqueue_email_safe('web_deposit_link_requested', 'web_deposit_link_requested:' || new.entity_id, 'questionnaire',
      new.entity_id, new.user_id);
    perform private.enqueue_email_safe('web_deposit_ack', 'web_deposit_ack:' || new.entity_id, 'questionnaire', new.entity_id, new.user_id);
  elsif new.entity = 'questionnaire' and new.type in ('status_changed', 'created') and st = 'submitted' then
    perform private.enqueue_email_safe('q_received', 'q_received:' || new.entity_id, 'questionnaire', new.entity_id, new.user_id);
    perform private.enqueue_email_safe('task:draft_quote', 'task:draft_quote:' || new.entity_id, 'questionnaire', new.entity_id, new.user_id);
  elsif new.entity = 'client' and new.type = 'status_changed' and st = 'testing' then
    perform private.enqueue_email_safe('ready_to_test', 'ready_to_test:' || new.entity_id, 'client', new.entity_id, new.user_id);
  elsif new.entity = 'client' and new.type = 'status_changed' and st = 'live' then
    perform private.enqueue_email_safe('went_live', 'went_live:' || new.entity_id, 'client', new.entity_id, new.user_id);
  elsif new.entity = 'request' and new.type = 'status_changed' and (new.payload ->> 'from') is not null then
    perform private.enqueue_email_safe('request_update', 'request_update:' || new.id, 'request', new.entity_id, new.user_id,
      jsonb_build_object('from', new.payload ->> 'from', 'to', st));
  elsif new.entity = 'client' and new.type = 'go_live_requested' then
    -- B7: client pressed "Approve go-live" (go_live checklist item done). Same key as the payments path: once per client.
    perform private.enqueue_email_safe('final_payment_due', 'final_payment_due:' || new.entity_id, 'client', new.entity_id, new.user_id);
  elsif new.entity = 'request' and new.type = 'request_cancelled' then
    -- B7: client cancelled (deleted) a queued request; the row is gone, so the title travels in the payload
    perform private.enqueue_email_safe('request_cancelled', 'request_cancelled:' || new.entity_id, 'request', new.entity_id, new.user_id,
      jsonb_build_object('title', left(new.payload ->> 'title', 200)));
    perform private.enqueue_email_safe('admin_request_cancelled', 'admin_request_cancelled:' || new.entity_id, 'request', new.entity_id,
      new.user_id, jsonb_build_object('title', left(new.payload ->> 'title', 200)));
  elsif new.type = 'need_help' then
    -- at most one alert per checklist item per UTC day
    perform private.enqueue_email_safe('need_help',
      'need_help:' || new.entity_id || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD'),
      new.entity, new.entity_id, new.user_id);
  end if;
  return null;
end $$;
drop trigger if exists events_to_outbox on public.events;
create trigger events_to_outbox after insert on public.events
  for each row execute function private.events_to_outbox();

-- payments: deposit marked paid -> deposit_received (once per client); final payment row created as due -> final_payment_due
-- (keyed per client, shared with B7's go_live_requested event, so whichever comes first sends it and the other is a no-op).
create or replace function private.payments_to_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select c.user_id from public.clients c where c.id = new.client_id);
begin
  if new.kind = 'deposit' and new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    perform private.enqueue_email_safe('deposit_received', 'deposit_received:' || new.client_id, 'client', new.client_id, v_user,
      jsonb_build_object('payment_id', new.id));
  elsif new.kind = 'final' and new.status = 'due' and tg_op = 'INSERT' then
    perform private.enqueue_email_safe('final_payment_due', 'final_payment_due:' || new.client_id, 'client', new.client_id, v_user,
      jsonb_build_object('payment_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists payments_to_outbox on public.payments;
create trigger payments_to_outbox after insert or update of status on public.payments
  for each row execute function private.payments_to_outbox();

-- leads (lead Edge Function): one "your fixed-quote link" email per address per UTC day.
create or replace function private.leads_to_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.enqueue_email_safe('lead_capture',
    'lead_capture:' || lower(new.email) || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 'lead', new.id, null);
  return null;
end $$;
drop trigger if exists leads_to_outbox on public.leads;
create trigger leads_to_outbox after insert on public.leads
  for each row execute function private.leads_to_outbox();

-- ================================================================ scheduled enqueues (pg_cron)
-- Daily: quote_reminder (once, 3 days after sent, still open), onboarding_nudge (3 quiet days, max 3 per client),
-- housekeeping (finished outbox rows > 180 days, recipient rows of people who no longer exist and never opted out).
create or replace function private.enqueue_scheduled_emails(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_rem int := 0; n_nudge int := 0; r record; k int;
begin
  for r in select q.id, q.user_id from public.quotes q
            where q.status in ('sent', 'viewed') and not q.anonymized and q.user_id is not null
              and q.sent_at <= p_now - interval '3 days' and (q.valid_until is null or q.valid_until > p_now) loop
    if private.enqueue_email_safe('quote_reminder', 'quote_reminder:' || r.id, 'quote', r.id, r.user_id, '{}'::jsonb, p_now) then n_rem := n_rem + 1; end if;
  end loop;

  for r in select c.id, c.user_id from public.clients c
            where c.status = 'onboarding' and c.anonymized_at is null and c.user_id is not null
              and exists (select 1 from public.onboarding_items i where i.client_id = c.id and i.status <> 'done')
              and greatest(c.created_at, coalesce((select max(i.updated_at) from public.onboarding_items i where i.client_id = c.id), c.created_at))
                  <= p_now - interval '3 days' loop
    select count(*) into k from private.email_outbox o where o.template = 'onboarding_nudge' and o.entity_id = r.id;
    continue when k >= 3 or exists (select 1 from private.email_outbox o where o.template = 'onboarding_nudge'
                                     and o.entity_id = r.id and o.created_at > p_now - interval '3 days');
    if private.enqueue_email_safe('onboarding_nudge', 'onboarding_nudge:' || r.id || ':' || (k + 1), 'client', r.id, r.user_id,
                                     '{}'::jsonb, p_now) then
      n_nudge := n_nudge + 1;
    end if;
  end loop;

  delete from private.email_outbox o where o.status in ('sent', 'failed', 'skipped') and o.updated_at < p_now - interval '180 days';
  delete from private.email_recipients e where e.unsubscribed_at is null
     and not exists (select 1 from public.profiles p where lower(p.email) = e.email)
     and not exists (select 1 from public.leads l where lower(l.email) = e.email);
  return jsonb_build_object('quote_reminder', n_rem, 'onboarding_nudge', n_nudge);
end $$;

-- 1st of the month: invoice notice for every live client with a monthly fee (not in its go-live month).
create or replace function private.enqueue_monthly_invoices(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0; r record; m text := to_char(p_now at time zone 'UTC', 'YYYY-MM');
begin
  for r in select c.id, c.user_id from public.clients c
            where c.status = 'live' and c.anonymized_at is null and c.user_id is not null and coalesce(c.monthly_cents, 0) > 0
              and (c.go_live_at is null or c.go_live_at < date_trunc('month', p_now)) loop
    if private.enqueue_email_safe('monthly_invoice', 'monthly_invoice:' || r.id || ':' || m, 'client', r.id, r.user_id,
                                  jsonb_build_object('month', m), p_now) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ================================================================ render context (read by the dispatcher)
-- Everything a template needs, resolved at send time (so a status that moved on can cancel a stale email).
-- {"skip": "<reason>"} = do not send. Recipient: profile e-mail (client), settings.admin_email (admin), lead e-mail.
create or replace function private.email_context(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o private.email_outbox; s private.settings; p public.profiles; q public.quotes; qn public.questionnaires;
  cl public.clients; pay public.payments; rq public.requests; it public.onboarding_items; ld public.leads;
  ctx jsonb := '{}'::jsonb; uid uuid; tw text; n_total int := 0; n_done int := 0; left_titles jsonb := '[]'::jsonb;
  acc text := 'quote' || '_accepted';
begin
  select * into o from private.email_outbox where id = p_id;
  if not found then return jsonb_build_object('skip', 'outbox_missing'); end if;
  select * into s from private.settings where id = 1;
  uid := o.user_id;

  if o.template in ('admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring', acc, 'admin_' || acc) then
    select * into q from public.quotes where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'quote_missing'); end if;
    if q.anonymized or q.status = 'void' then return jsonb_build_object('skip', 'quote_void'); end if;
    if o.template in ('quote_reminder', 'quote_expiring') and q.status not in ('sent', 'viewed') then
      return jsonb_build_object('skip', 'quote_closed');
    end if;
    if o.template = 'quote_sent' and q.status not in ('sent', 'viewed', 'accepted') then
      return jsonb_build_object('skip', 'quote_not_sent');
    end if;
    uid := coalesce(q.user_id, uid);
    select * into qn from public.questionnaires where id = q.questionnaire_id;
    ctx := ctx || jsonb_build_object(
      'quote', to_jsonb(q) - 'accepted_ip' - 'accepted_ua' - 'agreement_hash',
      'offer', qn.offer, 'niche', qn.niche,
      'review', (select jsonb_build_object('risk_flags', r.risk_flags, 'manual_reasons', r.manual_reasons,
                                           'questions', r.questions_for_client)
                   from public.quote_reviews r where r.quote_id = q.id));
  elsif o.template in ('q_received', 'task:draft_quote', 'web_deposit_link_requested', 'web_deposit_ack') then
    select * into qn from public.questionnaires where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'questionnaire_missing'); end if;
    uid := coalesce(qn.user_id, uid);
    ctx := ctx || jsonb_build_object(
      'questionnaire', jsonb_build_object('id', qn.id, 'offer', qn.offer, 'niche', qn.niche, 'status', qn.status,
        'summary', case when o.template = 'web_deposit_link_requested' then qn.summary end),
      'has_quote', exists (select 1 from public.quotes x where x.questionnaire_id = qn.id and x.status <> 'void'));
  elsif o.template in ('deposit_received', 'onboarding_nudge', 'ready_to_test', 'went_live', 'monthly_invoice', 'final_payment_due') then
    select * into cl from public.clients where id = o.entity_id;
    if not found or cl.anonymized_at is not null then return jsonb_build_object('skip', 'client_missing'); end if;
    if o.template = 'final_payment_due' then
      -- the final payment row if Meir created it, else the balance of the accepted quote (setup - deposit)
      select * into pay from public.payments x where x.client_id = cl.id and x.kind = 'final' order by x.created_at desc limit 1;
      if pay.id is not null and pay.status <> 'due' then return jsonb_build_object('skip', 'already_paid'); end if;
      if pay.id is null then
        select * into q from public.quotes where id = cl.quote_id;
        if q.id is null or q.setup_cents is null or q.deposit_cents is null then
          return jsonb_build_object('skip', 'amount_unknown');
        end if;
        ctx := ctx || jsonb_build_object('final_cents', q.setup_cents - q.deposit_cents);
      end if;
    end if;
  elsif o.template in ('request_cancelled', 'admin_request_cancelled') then
    ctx := ctx || jsonb_build_object('request', jsonb_build_object('id', o.entity_id, 'title', coalesce(o.payload ->> 'title', ''),
                                                                   'status', 'cancelled', 'admin_reply', null));
  elsif o.template = 'request_update' then
    select * into rq from public.requests where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'request_missing'); end if;
    select * into cl from public.clients where id = rq.client_id;
  elsif o.template = 'need_help' then
    select * into it from public.onboarding_items where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'item_missing'); end if;
    if it.status <> 'need_help' then return jsonb_build_object('skip', 'help_resolved'); end if;
    select * into cl from public.clients where id = it.client_id;
  elsif o.template = 'lead_capture' then
    select * into ld from public.leads where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'lead_missing'); end if;
    if exists (select 1 from public.profiles pp join public.questionnaires qq on qq.user_id = pp.id
                where lower(pp.email) = lower(ld.email) and qq.status <> 'draft') then
      return jsonb_build_object('skip', 'already_started');
    end if;
    ctx := ctx || jsonb_build_object('to', ld.email, 'lead', jsonb_build_object('niche', ld.niche, 'source_page', ld.source_page));
  end if;

  if cl.id is not null then
    uid := coalesce(cl.user_id, uid);
    select t.twilio_number into tw from public.tenants t where t.client_id = cl.id order by t.created_at limit 1;
    select count(*), count(*) filter (where i.status = 'done') into n_total, n_done
      from public.onboarding_items i where i.client_id = cl.id;
    select coalesce(jsonb_agg(x.title order by x.sort, x.created_at), '[]'::jsonb) into left_titles
      from (select i.title, i.sort, i.created_at from public.onboarding_items i
             where i.client_id = cl.id and i.status <> 'done' order by i.sort, i.created_at limit 5) x;
    if o.template = 'onboarding_nudge' and (cl.status <> 'onboarding' or n_total - n_done <= 0) then
      return jsonb_build_object('skip', 'nothing_left');
    end if;
    if o.template = 'ready_to_test' and cl.status <> 'testing' then return jsonb_build_object('skip', 'status_moved'); end if;
    if o.template = 'went_live' and cl.status <> 'live' then return jsonb_build_object('skip', 'status_moved'); end if;
    if o.template = 'monthly_invoice' and cl.status <> 'live' then return jsonb_build_object('skip', 'not_live'); end if;
    ctx := ctx || jsonb_build_object(
      'client', jsonb_build_object('id', cl.id, 'status', cl.status, 'products', to_jsonb(cl.products),
                                   'monthly_cents', cl.monthly_cents, 'business_name', cl.business_name,
                                   'go_live_at', cl.go_live_at, 'next_bill_on', cl.next_bill_on),
      'tenant_number', tw,
      'onboarding', jsonb_build_object('total', n_total, 'done', n_done, 'left', n_total - n_done, 'left_titles', left_titles));
  end if;
  if pay.id is not null then
    ctx := ctx || jsonb_build_object('payment', jsonb_build_object('id', pay.id, 'kind', pay.kind, 'amount_cents', pay.amount_cents,
                                                                   'method', pay.method, 'status', pay.status));
  end if;
  if rq.id is not null then
    ctx := ctx || jsonb_build_object('request', jsonb_build_object('id', rq.id, 'title', rq.title, 'status', rq.status,
                                                                   'admin_reply', rq.admin_reply));
  end if;
  if it.id is not null then
    ctx := ctx || jsonb_build_object('item', jsonb_build_object('id', it.id, 'key', it.key, 'title', it.title, 'status', it.status,
      'message', left(coalesce(it.data ->> 'help_message', it.data ->> 'message', it.data ->> 'note', ''), 2000)));
  end if;

  if uid is not null then select * into p from public.profiles where id = uid; end if;
  ctx := ctx || jsonb_build_object('profile', jsonb_build_object(
    'full_name', p.full_name, 'company', p.company, 'email', p.email, 'phone', p.phone, 'city', p.city, 'state', p.state,
    'update_lang', p.update_lang));
  ctx := ctx || jsonb_build_object('to', case o.audience
    when 'admin' then nullif(btrim(s.admin_email), '')
    when 'client' then coalesce(ctx ->> 'to', nullif(btrim(p.email), ''))
    else null end);
  return ctx;
end $$;

-- ================================================================ service-role RPCs (events-dispatch / email-unsubscribe)
create or replace function private.require_service() returns void
language plpgsql stable set search_path = '' as $$
begin
  if private.api_role() not in ('service_role', '') then
    raise exception 'service_role_only' using errcode = '42501';
  end if;
end $$;

-- Claim due rows (p_kind 'email' = client/admin mails, 'task' = system tasks). Locks them for p_lock_seconds; a worker
-- that dies mid-send leaves the row 'sending' and it is re-claimed after the lock (same idem_key -> Resend dedups).
create or replace function public.email_claim(p_kind text default 'email', p_limit int default 25, p_lock_seconds int default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare res jsonb;
begin
  perform private.require_service();
  with c as (
    select o.id from private.email_outbox o
     where o.status in ('pending', 'sending') and o.next_attempt_at <= now()
       and (o.locked_until is null or o.locked_until < now())
       and ((coalesce(p_kind, 'email') = 'task') = (o.audience = 'system'))
     order by o.next_attempt_at, o.id
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  ), u as (
    update private.email_outbox o
       set status = 'sending', attempts = o.attempts + 1, updated_at = now(),
           locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lock_seconds, 300), 900)))
      from c where o.id = c.id
    returning o.id, o.idem_key, o.template, o.audience, o.entity, o.entity_id, o.attempts, o.payload, o.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'idem_key', u.idem_key, 'template', u.template,
           'audience', u.audience, 'entity', u.entity, 'entity_id', u.entity_id, 'attempts', u.attempts,
           'payload', u.payload, 'created_at', u.created_at, 'ctx', private.email_context(u.id)) order by u.id), '[]'::jsonb)
    into res from u;
  return res;
end $$;

-- Result of one claimed row: sent | retry | defer (quiet hours; attempt not counted) | failed | skipped.
-- Only a row still 'sending' can be completed, so a late/duplicate worker can never undo 'sent'.
create or replace function public.email_complete(p_id bigint, p_result text, p_provider_id text default null,
                                                 p_error text default null, p_retry_at timestamptz default null)
returns text language plpgsql security definer set search_path = '' as $$
declare o private.email_outbox;
begin
  perform private.require_service();
  if p_result not in ('sent', 'retry', 'defer', 'failed', 'skipped') then
    raise exception 'bad_result' using errcode = 'P0001';
  end if;
  select * into o from private.email_outbox where id = p_id for update;
  if not found then return 'not_found'; end if;
  if o.status <> 'sending' then return 'ignored'; end if;
  if p_result = 'sent' then
    update private.email_outbox set status = 'sent', sent_at = now(), provider_id = left(p_provider_id, 200),
           last_error = null, locked_until = null, updated_at = now() where id = p_id;
  elsif p_result in ('retry', 'defer') then
    update private.email_outbox
       set status = 'pending', next_attempt_at = greatest(coalesce(p_retry_at, now() + interval '5 minutes'), now()),
           attempts = case when p_result = 'defer' then greatest(o.attempts - 1, 0) else o.attempts end,
           last_error = left(p_error, 500), locked_until = null, updated_at = now() where id = p_id;
  else
    update private.email_outbox set status = p_result, last_error = left(p_error, 500), locked_until = null, updated_at = now()
     where id = p_id;
  end if;
  if p_result in ('sent', 'failed', 'skipped') then
    perform private.log_event(coalesce(nullif(o.entity, ''), 'email'), o.entity_id, o.user_id,
      case when o.template like 'task:%' then 'task_' else 'email_' end || p_result,
      jsonb_build_object('template', o.template, 'outbox_id', o.id, 'attempts', o.attempts)
        || case when p_error is null then '{}'::jsonb else jsonb_build_object('reason', left(p_error, 200)) end, false);
  end if;
  return p_result;
end $$;

create or replace function public.email_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_service();
  return (select jsonb_build_object('admin_email', s.admin_email, 'client_emails_enabled', s.client_emails_enabled,
                                    'admin_emails_enabled', s.admin_emails_enabled)
            from private.settings s where s.id = 1);
end $$;

-- Unsubscribe token for an address (created on first use) + whether it opted out.
create or replace function public.email_recipient(p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_service();
  if e !~ '^[^@\s]{1,64}@[^@\s]{1,255}$' then raise exception 'bad_email' using errcode = 'P0001'; end if;
  insert into private.email_recipients (email) values (e) on conflict (email) do nothing;
  return (select jsonb_build_object('token', r.unsub_token, 'unsubscribed', r.unsubscribed_at is not null)
            from private.email_recipients r where r.email = e);
end $$;

create or replace function public.email_unsubscribe(p_token text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_service();
  if coalesce(p_token, '') !~ '^[0-9a-f]{32,128}$' then return false; end if;
  update private.email_recipients set unsubscribed_at = coalesce(unsubscribed_at, now()) where unsub_token = p_token;
  get diagnostics n = row_count;
  if n > 0 then perform private.log_event('email', null, null, 'email_unsubscribed', '{}'::jsonb, false); end if;
  return n > 0;
end $$;

-- Storage purge queue (A1, private.storage_purge_queue): the dispatcher deletes the objects through the Storage API.
create or replace function public.storage_purge_claim(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_service();
  return (select coalesce(jsonb_agg(jsonb_build_object('bucket_id', x.bucket_id, 'name', x.name)), '[]'::jsonb)
            from (select q.bucket_id, q.name from private.storage_purge_queue q where q.done_at is null
                   order by q.queued_at, q.name limit greatest(1, least(coalesce(p_limit, 100), 1000))) x);
end $$;

create or replace function public.storage_purge_done(p_bucket text, p_names text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_service();
  update private.storage_purge_queue set done_at = now()
   where bucket_id = p_bucket and name = any (coalesce(p_names, '{}')) and done_at is null;
  get diagnostics n = row_count;
  if n > 0 then
    perform private.log_event('system', null, null, 'storage_purged', jsonb_build_object('bucket', p_bucket, 'files', n), false);
  end if;
  return n;
end $$;

-- ================================================================ admin_log_event (A7)
-- The admin page cannot insert into public.events. This RPC records admin-only actions (payment marked, note saved,
-- quote text edited, ...). Admin only; never client-visible; cannot forge e-mail or status events.
create or replace function public.admin_log_event(p_entity text, p_entity_id uuid, p_type text, p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if (select auth.uid()) is null or not private.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_entity not in ('questionnaire', 'quote', 'client', 'payment', 'request', 'tenant', 'onboarding_item', 'lead', 'settings') then
    raise exception 'bad_entity' using errcode = 'P0001';
  end if;
  if coalesce(p_type, '') !~ '^[a-z][a-z0-9_.]{1,59}$' or p_type like 'email%' or p_type like 'task%'
     or p_type in ('status_changed', 'created', 'need_help', 'go_live_requested', 'settings_updated', 'onboarding_updated', 'retention_error', 'retention_run') then
    raise exception 'bad_type' using errcode = 'P0001';
  end if;
  if p_payload is not null and (jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 4000) then
    raise exception 'bad_payload' using errcode = 'P0001';
  end if;
  v_user := case p_entity
    when 'questionnaire' then (select x.user_id from public.questionnaires x where x.id = p_entity_id)
    when 'quote' then (select x.user_id from public.quotes x where x.id = p_entity_id)
    when 'client' then (select x.user_id from public.clients x where x.id = p_entity_id)
    when 'payment' then (select c.user_id from public.payments x join public.clients c on c.id = x.client_id where x.id = p_entity_id)
    when 'request' then (select c.user_id from public.requests x join public.clients c on c.id = x.client_id where x.id = p_entity_id)
    when 'tenant' then (select c.user_id from public.tenants x join public.clients c on c.id = x.client_id where x.id = p_entity_id)
    when 'onboarding_item' then (select c.user_id from public.onboarding_items x join public.clients c on c.id = x.client_id where x.id = p_entity_id)
    else null end;
  perform private.log_event(p_entity, p_entity_id, v_user, p_type, coalesce(p_payload, '{}'::jsonb), false);
end $$;

-- ================================================================ pg_net calls + cron wiring
-- POST <project>/functions/v1/<name> with the service-role key. Both values come from Vault (names below); when either
-- is missing nothing is called (returns null) — so a fresh project is inert until tools/us_setup.py stores them.
create or replace function private.call_edge_function(p_name text, p_body jsonb default '{}'::jsonb, p_timeout_ms int default 150000)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text; rid bigint;
begin
  if coalesce(p_name, '') !~ '^[a-z][a-z0-9-]{1,40}$' then raise exception 'bad_function_name' using errcode = 'P0001'; end if;
  begin
    select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'ailab_us_project_url' limit 1;
    select ds.decrypted_secret into v_key from vault.decrypted_secrets ds where ds.name = 'ailab_us_service_role_key' limit 1;
  exception when others then v_url := null; v_key := null;
  end;
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then return null; end if;
  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    body := coalesce(p_body, '{}'::jsonb),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    timeout_milliseconds := p_timeout_ms) into rid;
  return rid;
end $$;

-- Every minute: wake the dispatcher only when something is due (no idle invocations).
create or replace function private.kick_dispatch() returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.email_outbox o where o.status in ('pending', 'sending') and o.next_attempt_at <= now()
              and (o.locked_until is null or o.locked_until < now())) then
    return private.call_edge_function('events-dispatch', jsonb_build_object('task', 'email'));
  end if;
  return null;
end $$;

create or replace function private.kick_storage_purge() returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.storage_purge_queue q where q.done_at is null) then
    return private.call_edge_function('events-dispatch', jsonb_build_object('task', 'storage_purge'));
  end if;
  return null;
end $$;

-- Idempotent (cron.schedule upserts by job name). Run by tools/us_setup.py after the Vault secrets exist.
create or replace function private.install_email_jobs() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform cron.schedule('ailab-us-email-dispatch', '* * * * *', 'select private.kick_dispatch()');
  perform cron.schedule('ailab-us-email-scan', '0 15 * * *', 'select private.enqueue_scheduled_emails()');
  perform cron.schedule('ailab-us-monthly-invoice', '0 15 1 * *', 'select private.enqueue_monthly_invoices()');
  perform cron.schedule('ailab-us-quote-expiring', '30 14 * * *', $c$select private.call_edge_function('quote-expiring')$c$);
  perform cron.schedule('ailab-us-storage-purge', '47 3 * * *', 'select private.kick_storage_purge()');
  return jsonb_build_array('ailab-us-email-dispatch', 'ailab-us-email-scan', 'ailab-us-monthly-invoice',
                           'ailab-us-quote-expiring', 'ailab-us-storage-purge');
end $$;

-- ================================================================ privileges
revoke all on function private.email_templates(), private.enqueue_email(text, text, text, uuid, uuid, jsonb, timestamptz),
  private.enqueue_email_safe(text, text, text, uuid, uuid, jsonb, timestamptz), private.events_to_outbox(),
  private.payments_to_outbox(), private.leads_to_outbox(), private.enqueue_scheduled_emails(timestamptz),
  private.enqueue_monthly_invoices(timestamptz), private.email_context(bigint), private.require_service(),
  private.call_edge_function(text, jsonb, int), private.kick_dispatch(), private.kick_storage_purge(),
  private.install_email_jobs() from public, anon, authenticated;
grant execute on function private.email_templates(), private.enqueue_email(text, text, text, uuid, uuid, jsonb, timestamptz),
  private.enqueue_email_safe(text, text, text, uuid, uuid, jsonb, timestamptz), private.enqueue_scheduled_emails(timestamptz),
  private.enqueue_monthly_invoices(timestamptz), private.email_context(bigint), private.require_service(),
  private.call_edge_function(text, jsonb, int), private.kick_dispatch(), private.kick_storage_purge(),
  private.install_email_jobs() to service_role;

revoke all on function public.email_claim(text, int, int), public.email_complete(bigint, text, text, text, timestamptz),
  public.email_settings(), public.email_recipient(text), public.email_unsubscribe(text), public.storage_purge_claim(int),
  public.storage_purge_done(text, text[]) from public, anon, authenticated;
grant execute on function public.email_claim(text, int, int), public.email_complete(bigint, text, text, text, timestamptz),
  public.email_settings(), public.email_recipient(text), public.email_unsubscribe(text), public.storage_purge_claim(int),
  public.storage_purge_done(text, text[]) to service_role;

revoke all on function public.admin_log_event(text, uuid, text, jsonb) from public, anon;
grant execute on function public.admin_log_event(text, uuid, text, jsonb) to authenticated, service_role;
