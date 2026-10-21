-- PayPal checkout, phase 1: deposit + final payment by card / PayPal (Edge Functions pay-create, pay-capture,
-- paypal-webhook, pay-refund, pay-upwork). Additive and idempotent; needs 20261021100000_us_paypal_enum.sql first.
--
--   payments            + provider ('paypal'), provider_order_id, provider_capture_id (unique), payer_email (PII: cleared
--                         when retention anonymises the client). RLS unchanged: clients read their own rows, writes are
--                         admin (policy) or these service-role RPCs.
--   clients             one client card per quote (unique quote_id, created only when the data has no duplicates)
--   private.paypal_events  webhook event ids already processed (ids only, no payload, no PII)
--   service-role RPCs   pay_target (find or create the client card + payment rows of an accepted PayPal quote, exactly
--                         what the admin's "פתח כרטיס לקוח" creates), pay_set_order, pay_record_capture (the admin's
--                         "סמן כשולם" UPDATE, so payments_guard / payments_seed_onboarding / payments_to_outbox fire as
--                         before, + payment_receipt / admin_payment_received), pay_mark_refunded, pay_lookup,
--                         pay_use_upwork (client switches the quote to Upwork), pay_clear_capture (a pending capture
--                         PayPal declined), paypal_event_seen / paypal_event_log, paypal_alert (Hebrew owner alert:
--                         dispute, reversal, partial refund, declined, mismatch, unknown capture)
--   e-mail layer        new templates; email_context passes pay_method (quote, else payment row, else the client's
--                         quote) so deposit_received / monthly_invoice / web_deposit_ack stop always rendering Upwork;
--                         final_payment_due on a final payment row insert only once go-live was requested (the client card
--                         creates that row at the start of onboarding; B7's go_live_requested sends the mail then).
-- Amounts are never taken from the browser or from PayPal: every amount comes from public.payments (set from the
-- accepted quote) and PayPal's numbers are only compared with it.

set check_function_bodies = off;

-- ================================================================ columns, indexes
alter table public.payments add column if not exists provider text check (provider in ('paypal'));
alter table public.payments add column if not exists provider_order_id text check (provider_order_id ~ '^[A-Za-z0-9-]{8,64}$');
alter table public.payments add column if not exists provider_capture_id text check (provider_capture_id ~ '^[A-Za-z0-9-]{8,64}$');
alter table public.payments add column if not exists payer_email text check (length(payer_email) <= 320);
create unique index if not exists payments_provider_capture_uniq on public.payments (provider_capture_id) where provider_capture_id is not null;
create index if not exists payments_provider_order_idx on public.payments (provider_order_id) where provider_order_id is not null;

-- one client card per quote (pay_target and the admin can both create it); skipped if old data already has duplicates
do $$ begin
  if not exists (select 1 from public.clients c where c.quote_id is not null group by c.quote_id having count(*) > 1) then
    create unique index if not exists clients_quote_uniq on public.clients (quote_id) where quote_id is not null;
  end if;
end $$;

-- ================================================================ webhook event log (idempotency)
create table if not exists private.paypal_events (
  event_id text primary key check (event_id ~ '^[A-Za-z0-9-]{3,100}$'),
  event_type text not null check (length(event_type) between 3 and 80),
  resource_id text check (length(resource_id) <= 100),
  payment_id uuid,
  result text not null default '' check (length(result) <= 200),
  received_at timestamptz not null default now()
);
alter table private.paypal_events enable row level security;
revoke all on private.paypal_events from public, anon, authenticated;
grant all on private.paypal_events to service_role;

-- ================================================================ retention: the payer's e-mail is personal data
create or replace function private.clients_anonymized_payments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.anonymized_at is not null and old.anonymized_at is null then
    update public.payments x set payer_email = null where x.client_id = new.id and x.payer_email is not null;
  end if;
  return null;
end $$;
drop trigger if exists clients_anonymized_payments on public.clients;
create trigger clients_anonymized_payments after update of anonymized_at on public.clients
  for each row execute function private.clients_anonymized_payments();

-- ================================================================ e-mail layer (redefinitions of A8 functions, same signatures)
create or replace function private.email_templates() returns text[]
language sql immutable set search_path = '' as $$
  select array['lead_capture', 'q_received', 'admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring',
               'quote' || '_accepted', 'admin_quote' || '_accepted', 'deposit_received', 'onboarding_nudge', 'need_help',
               'ready_to_test', 'final_payment_due', 'went_live', 'request_update', 'monthly_invoice', 'task:draft_quote',
               'web_deposit_link_requested', 'web_deposit_ack', 'request_cancelled', 'admin_request_cancelled',
               'payment_receipt', 'admin_payment_received', 'admin_paypal_alert', 'admin_upwork_requested']
$$;

create or replace function private.payments_to_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select c.user_id from public.clients c where c.id = new.client_id);
begin
  if new.kind = 'deposit' and new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    perform private.enqueue_email_safe('deposit_received', 'deposit_received:' || new.client_id, 'client', new.client_id, v_user,
      jsonb_build_object('payment_id', new.id));
  elsif new.kind = 'final' and new.status = 'due' and tg_op = 'INSERT'
        and exists (select 1 from public.onboarding_items i where i.client_id = new.client_id and i.data ? 'go_live_requested_at') then
    -- the client card (admin or PayPal checkout) creates the final row at the start of onboarding: "Final payment before
    -- go-live" is sent only after go-live was requested (B7 go_live_requested uses the same key, so it goes out once)
    perform private.enqueue_email_safe('final_payment_due', 'final_payment_due:' || new.client_id, 'client', new.client_id, v_user,
      jsonb_build_object('payment_id', new.id));
  end if;
  return null;
end $$;

create or replace function private.email_context(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o private.email_outbox; s private.settings; p public.profiles; q public.quotes; qn public.questionnaires;
  cl public.clients; pay public.payments; rq public.requests; it public.onboarding_items; ld public.leads;
  ctx jsonb := '{}'::jsonb; uid uuid; tw text; n_total int := 0; n_done int := 0; left_titles jsonb := '[]'::jsonb;
  acc text := 'quote' || '_accepted'; v_pid text; v_method text;
begin
  select * into o from private.email_outbox where id = p_id;
  if not found then return jsonb_build_object('skip', 'outbox_missing'); end if;
  select * into s from private.settings where id = 1;
  uid := o.user_id;

  if o.template in ('admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring', acc, 'admin_' || acc, 'admin_upwork_requested') then
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
    if o.template = 'deposit_received' then
      -- the deposit row that was marked paid (payments_to_outbox payload), so the mail knows how it was paid
      v_pid := o.payload ->> 'payment_id';
      if v_pid ~ '^[0-9a-fA-F-]{36}$' then
        select * into pay from public.payments x where x.id = v_pid::uuid and x.client_id = cl.id;
      end if;
      if pay.id is null then
        select * into pay from public.payments x where x.client_id = cl.id and x.kind = 'deposit'
         order by (x.status = 'paid') desc, x.created_at desc limit 1;
      end if;
    end if;
  elsif o.template in ('payment_receipt', 'admin_payment_received', 'admin_paypal_alert') then
    if o.entity_id is not null then select * into pay from public.payments x where x.id = o.entity_id; end if;
    if pay.id is null and o.template <> 'admin_paypal_alert' then return jsonb_build_object('skip', 'payment_missing'); end if;
    if o.template <> 'admin_paypal_alert' and pay.status = 'due' then return jsonb_build_object('skip', 'not_paid'); end if;
    if pay.id is not null then
      select * into cl from public.clients c where c.id = pay.client_id;
      if cl.id is not null and cl.anonymized_at is not null then return jsonb_build_object('skip', 'client_missing'); end if;
      if cl.id is not null then select * into q from public.quotes x where x.id = cl.quote_id; end if;
      if q.id is not null then
        ctx := ctx || jsonb_build_object('quote', to_jsonb(q) - 'accepted_ip' - 'accepted_ua' - 'agreement_hash');
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
      'method', pay.method, 'status', pay.status, 'provider', pay.provider, 'provider_capture_id', pay.provider_capture_id,
      'paid_at', pay.paid_at)
      || case when o.audience = 'admin' then jsonb_build_object('payer_email', pay.payer_email) else '{}'::jsonb end);
  end if;
  if rq.id is not null then
    ctx := ctx || jsonb_build_object('request', jsonb_build_object('id', rq.id, 'title', rq.title, 'status', rq.status,
                                                                   'admin_reply', rq.admin_reply));
  end if;
  if it.id is not null then
    ctx := ctx || jsonb_build_object('item', jsonb_build_object('id', it.id, 'key', it.key, 'title', it.title, 'status', it.status,
      'message', left(coalesce(it.data ->> 'help_message', it.data ->> 'message', it.data ->> 'note', ''), 2000)));
  end if;
  -- the payment rail of this mail: the quote's, else the payment row's, else the client's quote, else the questionnaire's
  -- live quote; null = none yet (the template then uses the brand.json default: PayPal checkout when on, else Upwork)
  v_method := coalesce(q.pay_method::text, pay.method,
    case when cl.id is not null then (select x.pay_method::text from public.quotes x where x.id = cl.quote_id) end,
    case when qn.id is not null then (select x.pay_method::text from public.quotes x
                                       where x.questionnaire_id = qn.id and x.status <> 'void' order by x.created_at desc limit 1) end);
  ctx := ctx || jsonb_build_object('pay_method', v_method);

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

-- ================================================================ service-role RPCs (Edge Functions pay-*, paypal-webhook)
-- The accepted PayPal quote of a public token -> its client card + the payment row to pay (created on first use, the same
-- rows as the admin's "פתח כרטיס לקוח": client onboarding + deposit due + final due). The quote row is locked, so two
-- browser tabs cannot create two cards. Final only after the deposit is paid and the client is testing or live.
create or replace function public.pay_target(p_token text, p_which text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes; cl public.clients; pay public.payments; dep public.payments; v_core text;
begin
  perform private.require_service();
  if coalesce(p_token, '') !~ '^[A-Za-z0-9]{32,128}$' then raise exception 'not_found' using errcode = 'P0002'; end if;
  if coalesce(p_which, '') not in ('deposit', 'final') then raise exception 'bad_which' using errcode = 'P0001'; end if;
  select * into q from public.quotes x where x.public_token = p_token for update;
  if not found or q.anonymized or q.status not in ('sent', 'viewed', 'accepted', 'expired') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if q.status <> 'accepted' then raise exception 'quote_not_accepted' using errcode = 'P0001'; end if;
  if q.pay_method is distinct from 'paypal_checkout' then raise exception 'not_paypal' using errcode = 'P0001'; end if;
  if q.setup_cents is null or q.deposit_cents is null or q.deposit_cents > q.setup_cents then
    raise exception 'amount_unknown' using errcode = 'P0001';
  end if;
  select * into cl from public.clients c where c.quote_id = q.id order by c.created_at limit 1;
  if cl.id is null then
    if p_which = 'final' then raise exception 'deposit_not_paid' using errcode = 'P0001'; end if;
    v_core := (select e ->> 'code' from jsonb_array_elements(q.items) e where e ->> 'code' in ('RCP', 'WEB', 'BNDL') limit 1);
    insert into public.clients (user_id, quote_id, products, status, monthly_cents, business_name)
    values (q.user_id, q.id, array[coalesce(v_core, 'RCP')], 'onboarding', q.monthly_cents,
            (select pr.company from public.profiles pr where pr.id = q.user_id))
    returning * into cl;
    insert into public.payments (client_id, kind, amount_cents, method, status) values
      (cl.id, 'deposit', q.deposit_cents, q.pay_method::text, 'due'),
      (cl.id, 'final', q.setup_cents - q.deposit_cents, q.pay_method::text, 'due');
  end if;
  if cl.anonymized_at is not null or cl.status = 'cancelled' then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into dep from public.payments x where x.client_id = cl.id and x.kind = 'deposit'
   order by (x.status = 'paid') desc, x.created_at desc limit 1;
  if p_which = 'deposit' then
    pay := dep;
    if pay.id is null then
      insert into public.payments (client_id, kind, amount_cents, method, status)
      values (cl.id, 'deposit', q.deposit_cents, q.pay_method::text, 'due') returning * into pay;
    end if;
  else
    if dep.id is null or dep.status <> 'paid' then raise exception 'deposit_not_paid' using errcode = 'P0001'; end if;
    if cl.status not in ('testing', 'live') then raise exception 'final_not_ready' using errcode = 'P0001'; end if;
    select * into pay from public.payments x where x.client_id = cl.id and x.kind = 'final'
     order by (x.status = 'paid') desc, x.created_at desc limit 1;
    if pay.id is null then
      insert into public.payments (client_id, kind, amount_cents, method, status)
      values (cl.id, 'final', q.setup_cents - q.deposit_cents, q.pay_method::text, 'due') returning * into pay;
    end if;
  end if;
  return jsonb_build_object(
    'payment_id', pay.id, 'kind', pay.kind, 'amount_cents', pay.amount_cents, 'currency', 'USD', 'status', pay.status,
    'provider', pay.provider, 'provider_order_id', pay.provider_order_id, 'provider_capture_id', pay.provider_capture_id,
    'paid_at', pay.paid_at, 'quote_id', q.id, 'client_id', cl.id, 'client_status', cl.status, 'user_id', q.user_id,
    'pay_method', q.pay_method, 'products', to_jsonb(cl.products), 'deposit_status', dep.status);
end $$;

-- The PayPal order created for a due payment (the latest one wins; an older open order can no longer be captured).
create or replace function public.pay_set_order(p_payment uuid, p_order_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_service();
  if coalesce(p_order_id, '') !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'bad_order_id' using errcode = 'P0001'; end if;
  update public.payments x set provider = 'paypal', provider_order_id = p_order_id
   where x.id = p_payment and x.status = 'due' and x.provider_capture_id is null;
  if not found then raise exception 'payment_not_open' using errcode = 'P0001'; end if;
end $$;

-- A PayPal capture of one of our payments (pay-capture, or the webhook). Refuses another capture, another order, another
-- amount or currency. Completed -> the admin's mark-paid UPDATE (same triggers) + receipt + owner notice; pending -> ids
-- only (status stays due until PAYMENT.CAPTURE.COMPLETED). Idempotent for the same capture.
create or replace function public.pay_record_capture(p_payment uuid, p_order_id text, p_capture_id text, p_amount_cents bigint,
                                                     p_currency text, p_payer_email text, p_completed boolean,
                                                     p_source text default 'capture', p_funding text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pay public.payments; v_user uuid; v_email text;
begin
  perform private.require_service();
  if coalesce(p_capture_id, '') !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'bad_capture_id' using errcode = 'P0001'; end if;
  select * into pay from public.payments x where x.id = p_payment for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0002'; end if;
  v_user := (select c.user_id from public.clients c where c.id = pay.client_id);
  if pay.provider_capture_id = p_capture_id and (pay.status <> 'due' or not coalesce(p_completed, false)) then
    return jsonb_build_object('result', case pay.status when 'paid' then 'already_paid' when 'refunded' then 'refunded' else 'pending' end,
                              'payment_id', pay.id, 'kind', pay.kind);
  end if;
  if pay.status <> 'due' then raise exception 'payment_not_due' using errcode = 'P0001'; end if;
  if pay.provider_capture_id is not null and pay.provider_capture_id <> p_capture_id then
    raise exception 'other_capture' using errcode = 'P0001';
  end if;
  if p_order_id is not null and pay.provider_order_id is not null and pay.provider_order_id <> p_order_id then
    raise exception 'order_mismatch' using errcode = 'P0001';
  end if;
  if p_amount_cents is distinct from pay.amount_cents or upper(coalesce(p_currency, '')) <> 'USD' then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;
  v_email := nullif(lower(btrim(coalesce(p_payer_email, ''))), '');
  if v_email is not null and (length(v_email) > 320 or v_email !~ '^[^@\s]+@[^@\s]+$') then v_email := null; end if;
  if not coalesce(p_completed, false) then
    update public.payments x set provider = 'paypal', method = 'paypal_checkout', provider_order_id = coalesce(p_order_id, x.provider_order_id),
           provider_capture_id = p_capture_id, payer_email = coalesce(v_email, x.payer_email)
     where x.id = pay.id;
    perform private.log_event('payment', pay.id, v_user, 'payment_pending', jsonb_build_object('provider', 'paypal', 'kind', pay.kind,
      'capture_id', p_capture_id, 'source', left(coalesce(p_source, ''), 40)), false);
    return jsonb_build_object('result', 'pending', 'payment_id', pay.id, 'kind', pay.kind);
  end if;
  -- receipt first (outbox order), then the status UPDATE that fires the existing triggers (deposit_received, checklist)
  perform private.enqueue_email_safe('payment_receipt', 'payment_receipt:' || pay.id, 'payment', pay.id, v_user,
    jsonb_build_object('funding', left(coalesce(p_funding, ''), 40)));
  perform private.enqueue_email_safe('admin_payment_received', 'admin_payment_received:' || pay.id, 'payment', pay.id, v_user,
    jsonb_build_object('source', left(coalesce(p_source, ''), 40)));
  update public.payments x set status = 'paid', provider = 'paypal', method = 'paypal_checkout',
         provider_order_id = coalesce(p_order_id, x.provider_order_id), provider_capture_id = p_capture_id,
         payer_email = coalesce(v_email, x.payer_email)
   where x.id = pay.id;
  perform private.log_event('payment', pay.id, v_user, 'payment_captured', jsonb_build_object('provider', 'paypal', 'kind', pay.kind,
    'amount_cents', pay.amount_cents, 'capture_id', p_capture_id, 'source', left(coalesce(p_source, ''), 40)), true);
  return jsonb_build_object('result', 'paid', 'payment_id', pay.id, 'kind', pay.kind);
end $$;

-- A PayPal refund / reversal of a paid PayPal payment (pay-refund after PayPal accepted it, or the webhook).
create or replace function public.pay_mark_refunded(p_payment uuid, p_capture_id text, p_source text default 'admin',
                                                    p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pay public.payments; v_user uuid;
begin
  perform private.require_service();
  select * into pay from public.payments x where x.id = p_payment for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0002'; end if;
  if pay.provider is distinct from 'paypal' or pay.provider_capture_id is distinct from p_capture_id then
    raise exception 'capture_mismatch' using errcode = 'P0001';
  end if;
  if pay.status = 'refunded' then return jsonb_build_object('result', 'already_refunded', 'payment_id', pay.id); end if;
  if pay.status <> 'paid' then raise exception 'payment_not_paid' using errcode = 'P0001'; end if;
  update public.payments x set status = 'refunded' where x.id = pay.id;
  v_user := (select c.user_id from public.clients c where c.id = pay.client_id);
  perform private.log_event('payment', pay.id, v_user, 'payment_refunded', jsonb_build_object('provider', 'paypal', 'kind', pay.kind,
    'amount_cents', pay.amount_cents, 'capture_id', p_capture_id, 'source', left(coalesce(p_source, ''), 60),
    'note', left(coalesce(p_note, ''), 200)), false);
  return jsonb_build_object('result', 'refunded', 'payment_id', pay.id);
end $$;

-- A capture PayPal held as PENDING (e.g. a risk review of a new seller) was declined in the end (PAYMENT.CAPTURE.DECLINED):
-- forget it, so the client can pay again (pay_set_order refuses a new order while a capture is pending). Paid rows untouched.
create or replace function public.pay_clear_capture(p_payment uuid, p_capture_id text, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  perform private.require_service();
  update public.payments x set provider_capture_id = null, provider_order_id = null
   where x.id = p_payment and x.status = 'due' and x.provider_capture_id = p_capture_id;
  if not found then return jsonb_build_object('result', 'unchanged', 'payment_id', p_payment); end if;
  v_user := (select c.user_id from public.payments x join public.clients c on c.id = x.client_id where x.id = p_payment);
  perform private.log_event('payment', p_payment, v_user, 'payment_capture_failed',
    jsonb_build_object('provider', 'paypal', 'capture_id', p_capture_id, 'status', left(coalesce(p_status, ''), 40)), false);
  return jsonb_build_object('result', 'cleared', 'payment_id', p_payment);
end $$;

-- One payment by id, PayPal capture id or PayPal order id (webhook / refund), with its client and quote.
create or replace function public.pay_lookup(p_payment uuid default null, p_capture_id text default null, p_order_id text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pay public.payments; cl public.clients; q public.quotes;
begin
  perform private.require_service();
  if p_payment is not null then
    select * into pay from public.payments x where x.id = p_payment;
  elsif coalesce(p_capture_id, '') <> '' then
    select * into pay from public.payments x where x.provider_capture_id = p_capture_id;
  elsif coalesce(p_order_id, '') <> '' then
    select * into pay from public.payments x where x.provider_order_id = p_order_id order by x.created_at desc limit 1;
  end if;
  if pay.id is null then return null; end if;
  select * into cl from public.clients c where c.id = pay.client_id;
  select * into q from public.quotes x where x.id = cl.quote_id;
  return jsonb_build_object('payment_id', pay.id, 'kind', pay.kind, 'amount_cents', pay.amount_cents, 'currency', 'USD',
    'status', pay.status, 'provider', pay.provider, 'provider_order_id', pay.provider_order_id,
    'provider_capture_id', pay.provider_capture_id, 'paid_at', pay.paid_at, 'client_id', cl.id, 'client_status', cl.status,
    'user_id', cl.user_id, 'quote_id', q.id, 'pay_method', q.pay_method, 'products', to_jsonb(cl.products),
    'checklist_items', (select count(*) from public.onboarding_items i where i.client_id = cl.id),
    'checklist_left', (select count(*) from public.onboarding_items i where i.client_id = cl.id and i.status <> 'done' and i.key <> 'tools'));
end $$;

-- "Prefer Upwork's escrow protection? Pay through Upwork instead" on the quote page: the quote (and its unpaid rows)
-- move to Upwork Direct Contracts and Meir gets the Hebrew contract checklist. Refused once the deposit is paid / pending.
create or replace function public.pay_use_upwork(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_paid boolean;
begin
  perform private.require_service();
  if coalesce(p_token, '') !~ '^[A-Za-z0-9]{32,128}$' then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into q from public.quotes x where x.public_token = p_token for update;
  if not found or q.anonymized or q.status not in ('sent', 'viewed', 'accepted', 'expired') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if q.status <> 'accepted' then raise exception 'quote_not_accepted' using errcode = 'P0001'; end if;
  if q.pay_method = 'upwork' then return jsonb_build_object('result', 'already', 'quote_id', q.id); end if;
  if q.pay_method is distinct from 'paypal_checkout' then raise exception 'not_paypal' using errcode = 'P0001'; end if;
  select exists (select 1 from public.payments x join public.clients c on c.id = x.client_id
                  where c.quote_id = q.id and x.kind = 'deposit' and (x.status <> 'due' or x.provider_capture_id is not null))
    into v_paid;
  if v_paid then raise exception 'deposit_already_paid' using errcode = 'P0001'; end if;
  update public.quotes x set pay_method = 'upwork' where x.id = q.id;
  update public.payments x set method = 'upwork', provider = null, provider_order_id = null
    from public.clients c where c.id = x.client_id and c.quote_id = q.id and x.status = 'due' and x.provider_capture_id is null;
  perform private.log_event('quote', q.id, q.user_id, 'pay_method_changed',
    jsonb_build_object('from', 'paypal_checkout', 'to', 'upwork', 'by', 'client'), true);
  perform private.enqueue_email_safe('admin_upwork_requested', 'admin_upwork_requested:' || q.id, 'quote', q.id, q.user_id, '{}'::jsonb);
  return jsonb_build_object('result', 'switched', 'quote_id', q.id);
end $$;

create or replace function public.paypal_event_seen(p_event_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_service();
  return exists (select 1 from private.paypal_events e where e.event_id = p_event_id);
end $$;

create or replace function public.paypal_event_log(p_event_id text, p_type text, p_resource_id text, p_payment uuid, p_result text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_service();
  insert into private.paypal_events (event_id, event_type, resource_id, payment_id, result)
  values (p_event_id, left(p_type, 80), left(p_resource_id, 100), p_payment, left(coalesce(p_result, ''), 200))
  on conflict (event_id) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Hebrew owner alert from the webhook. One mail per kind + PayPal reference (dispute id, capture id), never twice.
create or replace function public.paypal_alert(p_kind text, p_payment uuid, p_ref text, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  perform private.require_service();
  if coalesce(p_kind, '') not in ('dispute', 'reversed', 'partial_refund', 'mismatch', 'unknown_capture', 'declined') then
    raise exception 'bad_alert_kind' using errcode = 'P0001';
  end if;
  if p_payload is not null and (jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 3000) then
    raise exception 'bad_payload' using errcode = 'P0001';
  end if;
  v_user := (select c.user_id from public.payments x join public.clients c on c.id = x.client_id where x.id = p_payment);
  perform private.log_event('payment', p_payment, v_user, 'paypal_alert',
    jsonb_build_object('kind', p_kind, 'ref', left(coalesce(p_ref, ''), 120)), false);
  return private.enqueue_email_safe('admin_paypal_alert',
    'admin_paypal_alert:' || p_kind || ':' || left(coalesce(nullif(p_ref, ''), p_payment::text, 'none'), 120),
    'payment', p_payment, v_user, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('kind', p_kind, 'ref', left(coalesce(p_ref, ''), 120)));
end $$;

-- ================================================================ privileges
revoke all on function private.clients_anonymized_payments() from public, anon, authenticated;
revoke all on function public.pay_target(text, text), public.pay_set_order(uuid, text),
  public.pay_record_capture(uuid, text, text, bigint, text, text, boolean, text, text), public.pay_mark_refunded(uuid, text, text, text),
  public.pay_clear_capture(uuid, text, text), public.pay_lookup(uuid, text, text), public.pay_use_upwork(text),
  public.paypal_event_seen(text), public.paypal_event_log(text, text, text, uuid, text), public.paypal_alert(text, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.pay_target(text, text), public.pay_set_order(uuid, text),
  public.pay_record_capture(uuid, text, text, bigint, text, text, boolean, text, text), public.pay_mark_refunded(uuid, text, text, text),
  public.pay_clear_capture(uuid, text, text), public.pay_lookup(uuid, text, text), public.pay_use_upwork(text),
  public.paypal_event_seen(text), public.paypal_event_log(text, text, text, uuid, text), public.paypal_alert(text, uuid, text, jsonb)
  to service_role;
