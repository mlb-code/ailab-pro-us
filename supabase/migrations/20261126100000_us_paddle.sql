-- FirstRing sign-up + Paddle Billing (merchant of record), phase 2 of the monthly plans. Additive and idempotent; the
-- phase-1 contract (public.billing_upsert_subscription, 20261125100000_us_subscriptions.sql) is used as is.
--
--   public.billing_checkouts   one row per "Start free trial" / "Start paid plan" press on the sign-up screen: plan, trial or
--                              not, business phone, the exact consent sentence + agreement version the person ticked, and a
--                              random ref. The browser passes ONLY the ref to Paddle (customData); the webhook trusts the
--                              user / phone / plan of the ref row, never ids typed into the browser. RLS: own rows + admin.
--   billing_checkout_start     the sign-up RPC (signed-in client): checks the plan, a US business phone, the consent, "one
--                              subscription per account" and, for a trial, billing_trial_eligible(phone). Rate limited.
--   private.paddle_events      webhook event ids already processed (idempotency; Paddle may deliver twice / out of order).
--   private.paddle_transactions every Paddle transaction we saw (completed / payment_failed), for the 30-day money-back:
--                              public.subscriptions.first_paid_at = the first transaction with a charge > 0.
--   service-role RPCs          billing_paddle_* for the Edge Functions paddle-webhook and paddle-billing (never the browser).
--   money-back                 billing_paddle_money_back_target / billing_paddle_money_back_done: the admin refund button
--                              (paddle-billing, action money_back) works only within 30 days of first_paid_at, once per business.
set check_function_bodies = off;

-- ================================================================ columns
alter table public.subscriptions add column if not exists first_paid_at timestamptz;
alter table public.subscriptions add column if not exists first_paid_transaction_id text check (length(first_paid_transaction_id) <= 120);
alter table public.subscriptions add column if not exists last_payment_failed_at timestamptz;
alter table public.subscriptions add column if not exists money_back_refund_id text check (length(money_back_refund_id) <= 120);

-- ================================================================ tables
create table if not exists public.billing_checkouts (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique check (ref ~ '^chk_[0-9a-f]{32}$'),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_code text not null check (plan_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  trial boolean not null,
  business_phone text not null check (business_phone ~ '^\+1[2-9][0-9]{9}$'),
  agreement_version text not null check (agreement_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  consent_text text not null check (length(consent_text) between 20 and 600),
  user_agent text check (length(user_agent) <= 300),
  status text not null default 'open' check (status in ('open', 'completed')),
  provider_subscription_id text check (length(provider_subscription_id) <= 120),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists billing_checkouts_user_idx on public.billing_checkouts (user_id, created_at desc);

create table if not exists private.paddle_events (
  event_id text primary key check (event_id ~ '^[A-Za-z0-9_-]{3,100}$'),
  event_type text not null check (length(event_type) between 3 and 80),
  occurred_at timestamptz,
  entity_id text check (length(entity_id) <= 120),
  result text not null default '' check (length(result) <= 200),
  received_at timestamptz not null default now()
);

create table if not exists private.paddle_transactions (
  transaction_id text primary key check (transaction_id ~ '^[A-Za-z0-9_-]{3,120}$'),
  provider_subscription_id text check (length(provider_subscription_id) <= 120),
  client_id uuid,
  status text not null check (length(status) between 2 and 40),
  origin text check (length(origin) <= 60),
  total_cents bigint check (total_cents >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  billed_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.billing_checkouts enable row level security;
alter table private.paddle_events enable row level security;
alter table private.paddle_transactions enable row level security;
revoke all on public.billing_checkouts from public, anon, authenticated;
revoke all on private.paddle_events, private.paddle_transactions from public, anon, authenticated;
grant select on public.billing_checkouts to authenticated;   -- own rows / admin (policy); writes only through the RPC
grant all on public.billing_checkouts, private.paddle_events, private.paddle_transactions to service_role;

drop policy if exists billing_checkouts_select on public.billing_checkouts;
create policy billing_checkouts_select on public.billing_checkouts for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- ================================================================ sign-up (signed-in client)
create or replace function public.billing_checkout_start(p_plan_code text, p_business_phone text, p_agreement_version text,
  p_consent_text text, p_trial boolean default true, p_user_agent text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); v_phone text; me public.clients; sub public.subscriptions; el jsonb; n int; v_ref text;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_plan_code is null or private.plan_rank(p_plan_code) >= 99 then raise exception 'bad_plan_code' using errcode = 'P0001'; end if;
  v_phone := private.us_e164(p_business_phone);
  if v_phone is null then raise exception 'phone_invalid' using errcode = 'P0001'; end if;
  if coalesce(length(btrim(p_consent_text)), 0) < 20 then raise exception 'consent_required' using errcode = 'P0001'; end if;
  if coalesce(p_agreement_version, '') !~ '^[0-9]{1,3}\.[0-9]{1,3}$' then raise exception 'bad_agreement_version' using errcode = 'P0001'; end if;
  me := private.my_sub_client();
  if me.id is not null then
    sub := private.client_sub(me.id);
    if sub.id is not null and sub.status <> 'canceled' then raise exception 'already_subscribed' using errcode = 'P0001'; end if;
  end if;
  if coalesce(p_trial, true) then
    -- one free trial per business: a returning client (an earlier subscription, now ended) starts paid
    if sub.id is not null then raise exception 'trial_already_used' using errcode = 'P0001'; end if;
    el := public.billing_trial_eligible(v_phone);
    if not coalesce((el ->> 'eligible')::boolean, false) then raise exception '%', el ->> 'reason' using errcode = 'P0001'; end if;
  end if;
  select count(*) into n from public.billing_checkouts c where c.user_id = uid and c.created_at > now() - interval '1 day';
  if n >= 30 then raise exception 'too_many_checkouts' using errcode = 'P0001'; end if;
  v_ref := 'chk_' || md5(gen_random_uuid()::text || clock_timestamp()::text);
  insert into public.billing_checkouts (ref, user_id, plan_code, trial, business_phone, agreement_version, consent_text, user_agent)
  values (v_ref, uid, p_plan_code, coalesce(p_trial, true), v_phone, p_agreement_version, left(btrim(p_consent_text), 600),
          left(nullif(btrim(coalesce(p_user_agent, '')), ''), 300));
  perform private.log_event('billing', null, uid, 'checkout_started',
    jsonb_build_object('plan', p_plan_code, 'trial', coalesce(p_trial, true), 'agreement_version', p_agreement_version), false);
  return jsonb_build_object('ref', v_ref, 'plan_code', p_plan_code, 'trial', coalesce(p_trial, true), 'business_phone', v_phone);
end $$;

-- ================================================================ service-role RPCs (Edge Functions only)
create or replace function public.billing_paddle_checkout(p_ref text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.billing_checkouts;
begin
  perform private.require_service();
  select * into c from public.billing_checkouts x where x.ref = p_ref;
  if not found then return null; end if;
  return jsonb_build_object('ref', c.ref, 'user_id', c.user_id, 'plan_code', c.plan_code, 'trial', c.trial,
    'business_phone', c.business_phone, 'status', c.status, 'provider_subscription_id', c.provider_subscription_id,
    'email', (select p.email from public.profiles p where p.id = c.user_id));
end $$;

create or replace function public.billing_paddle_checkout_done(p_ref text, p_subscription_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_service();
  update public.billing_checkouts set status = 'completed', completed_at = coalesce(completed_at, now()),
         provider_subscription_id = coalesce(provider_subscription_id, left(p_subscription_id, 120))
   where ref = p_ref;
  return found;
end $$;

-- the stored subscription (by Paddle id, or the latest of a user / a client), with the ids the functions need
create or replace function public.billing_paddle_lookup(p_subscription_id text default null, p_user uuid default null,
  p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions; cl public.clients;
begin
  perform private.require_service();
  if p_subscription_id is not null then
    select * into s from public.subscriptions x where x.provider = 'paddle' and x.provider_subscription_id = p_subscription_id;
  elsif p_client is not null then
    s := private.client_sub(p_client);
  elsif p_user is not null then
    select * into cl from public.clients c where c.user_id = p_user and c.billing_mode = 'subscription' order by c.created_at desc limit 1;
    if cl.id is not null then s := private.client_sub(cl.id); end if;
  end if;
  if s.id is null then return null; end if;
  select * into cl from public.clients where id = s.client_id;
  return jsonb_build_object('subscription_id', s.id, 'client_id', s.client_id, 'user_id', cl.user_id, 'provider', s.provider,
    'provider_subscription_id', s.provider_subscription_id, 'provider_customer_id', s.provider_customer_id,
    'plan_code', s.plan_code, 'scheduled_plan_code', s.scheduled_plan_code, 'status', s.status,
    'cancel_at_period_end', s.cancel_at_period_end, 'trial_ends_at', s.trial_ends_at,
    'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
    'last_event_at', s.last_event_at, 'first_paid_at', s.first_paid_at, 'first_paid_transaction_id', s.first_paid_transaction_id,
    'money_back_used_at', private.money_back_used(s));
end $$;

create or replace function public.billing_paddle_event_seen(p_event_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_service();
  return exists (select 1 from private.paddle_events e where e.event_id = p_event_id);
end $$;

create or replace function public.billing_paddle_event_log(p_event_id text, p_type text, p_occurred_at timestamptz,
  p_entity_id text, p_result text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_service();
  insert into private.paddle_events (event_id, event_type, occurred_at, entity_id, result)
  values (p_event_id, left(p_type, 80), p_occurred_at, left(p_entity_id, 120), left(coalesce(p_result, ''), 200))
  on conflict (event_id) do nothing;
  return found;
end $$;

-- a Paddle transaction (transaction.completed / transaction.payment_failed): the first charge > 0 of a subscription starts
-- the 30-day money-back window; a failed payment is noted (Paddle runs the retries and e-mails the customer itself).
create or replace function public.billing_paddle_transaction(p_transaction_id text, p_subscription_id text, p_status text,
  p_origin text, p_total_cents bigint, p_currency text, p_billed_at timestamptz, p_occurred_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; v_first boolean := false; v_at timestamptz := coalesce(p_billed_at, p_occurred_at, now());
begin
  perform private.require_service();
  if p_subscription_id is not null then
    select * into s from public.subscriptions x where x.provider = 'paddle' and x.provider_subscription_id = p_subscription_id for update;
  end if;
  insert into private.paddle_transactions (transaction_id, provider_subscription_id, client_id, status, origin, total_cents, currency, billed_at)
  values (p_transaction_id, left(p_subscription_id, 120), s.client_id, left(p_status, 40), left(p_origin, 60), p_total_cents,
          upper(nullif(p_currency, '')), p_billed_at)
  on conflict (transaction_id) do update set status = excluded.status, client_id = coalesce(excluded.client_id, private.paddle_transactions.client_id),
    total_cents = coalesce(excluded.total_cents, private.paddle_transactions.total_cents), updated_at = now();
  if s.id is not null and p_status in ('completed', 'paid') and coalesce(p_total_cents, 0) > 0 and s.first_paid_at is null then
    update public.subscriptions set first_paid_at = v_at, first_paid_transaction_id = left(p_transaction_id, 120) where id = s.id;
    v_first := true;
  elsif s.id is not null and p_status = 'payment_failed' then
    update public.subscriptions set last_payment_failed_at = greatest(coalesce(last_payment_failed_at, v_at), v_at) where id = s.id;
  end if;
  return jsonb_build_object('known_subscription', s.id is not null, 'client_id', s.client_id, 'first_paid', v_first);
end $$;

-- something Meir must look at (unknown price, no user for a subscription, a refund that failed): Hebrew admin alert e-mail
-- when the client is known, always an event row.
create or replace function public.billing_paddle_alert(p_subscription_id text, p_kind text, p_detail text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; uid uuid;
begin
  perform private.require_service();
  select * into s from public.subscriptions x where x.provider = 'paddle' and x.provider_subscription_id = p_subscription_id;
  if s.id is not null then select c.user_id into uid from public.clients c where c.id = s.client_id; end if;
  perform private.log_event('client', s.client_id, uid, 'paddle_alert',
    jsonb_build_object('kind', left(p_kind, 60), 'detail', left(coalesce(p_detail, ''), 300), 'subscription', left(p_subscription_id, 120)), false);
  if s.id is not null then
    perform private.enqueue_email_safe('admin_provisioning_alert',
      'admin_provisioning_alert:paddle:' || s.id || ':' || left(p_kind, 40) || ':' || to_char(now(), 'YYYYMMDDHH24'),
      'client', s.client_id, uid, jsonb_build_object('step', 'paddle_' || left(p_kind, 40), 'error', left(coalesce(p_detail, ''), 300)));
  end if;
  return true;
end $$;

-- 30-day money-back on the first paid month: open = a first paid charge less than 30 days ago, not used before by this
-- business (subscription, client or business phone).
create or replace function private.money_back_open(s public.subscriptions, p_now timestamptz default now()) returns boolean
language sql stable security definer set search_path = '' as $$
  select s.id is not null and s.first_paid_at is not null and s.first_paid_transaction_id is not null
     and s.first_paid_at > p_now - interval '30 days' and private.money_back_used(s) is null
$$;

create or replace function public.billing_paddle_money_back_target(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  perform private.require_service();
  s := private.client_sub(p_client);
  if s.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
  if s.provider <> 'paddle' then raise exception 'not_paddle' using errcode = 'P0001'; end if;
  if private.money_back_used(s) is not null then raise exception 'money_back_already_used' using errcode = 'P0001'; end if;
  if not private.money_back_open(s) then raise exception 'money_back_window_closed' using errcode = 'P0001'; end if;
  return jsonb_build_object('client_id', s.client_id, 'provider_subscription_id', s.provider_subscription_id,
    'transaction_id', s.first_paid_transaction_id, 'first_paid_at', s.first_paid_at, 'status', s.status);
end $$;

create or replace function public.billing_paddle_money_back_done(p_client uuid, p_refund_id text, p_admin uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; cl public.clients;
begin
  perform private.require_service();
  select * into cl from public.clients where id = p_client;
  s := private.client_sub(p_client);
  if s.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
  if private.money_back_used(s) is not null then raise exception 'money_back_already_used' using errcode = 'P0001'; end if;
  update public.subscriptions set money_back_used_at = now(), money_back_refund_id = left(p_refund_id, 120) where id = s.id;
  if s.business_phone is not null then
    insert into private.trial_claims (phone, client_id, user_id, money_back_used_at) values (s.business_phone, cl.id, cl.user_id, now())
    on conflict (phone) do update set money_back_used_at = coalesce(private.trial_claims.money_back_used_at, now());
  end if;
  perform private.log_event('client', p_client, cl.user_id, 'money_back_refunded',
    jsonb_build_object('refund_id', left(p_refund_id, 120), 'admin', p_admin), false);
  return jsonb_build_object('ok', true);
end $$;

-- ================================================================ privileges
revoke all on function private.money_back_open(public.subscriptions, timestamptz) from public, anon, authenticated;
revoke all on function public.billing_checkout_start(text, text, text, text, boolean, text) from public, anon;
grant execute on function public.billing_checkout_start(text, text, text, text, boolean, text) to authenticated, service_role;

revoke all on function public.billing_paddle_checkout(text), public.billing_paddle_checkout_done(text, text),
  public.billing_paddle_lookup(text, uuid, uuid), public.billing_paddle_event_seen(text),
  public.billing_paddle_event_log(text, text, timestamptz, text, text),
  public.billing_paddle_transaction(text, text, text, text, bigint, text, timestamptz, timestamptz),
  public.billing_paddle_alert(text, text, text), public.billing_paddle_money_back_target(uuid),
  public.billing_paddle_money_back_done(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.billing_paddle_checkout(text), public.billing_paddle_checkout_done(text, text),
  public.billing_paddle_lookup(text, uuid, uuid), public.billing_paddle_event_seen(text),
  public.billing_paddle_event_log(text, text, timestamptz, text, text),
  public.billing_paddle_transaction(text, text, text, text, bigint, text, timestamptz, timestamptz),
  public.billing_paddle_alert(text, text, text), public.billing_paddle_money_back_target(uuid),
  public.billing_paddle_money_back_done(uuid, text, uuid) to service_role;
