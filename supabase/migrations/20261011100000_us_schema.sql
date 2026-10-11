-- AI Lab Pro US (project ailab-us): schema, guards, RLS, RPCs.
-- Apply in order: 100000 schema, 100100 storage, 100200 retention. Every file is idempotent (safe to re-run).
-- Source of truth: docs/SPEC.md §4 (data model) and §2.3–2.6. Client-facing values are English; admin is Hebrew (UI only).
-- Helper functions live in schema "private" (not exposed through the API: only "public" is in PostgREST's schema list).
-- Niches: home_services, real_estate, dental (dental = hidden / early access, see private.niches). No law niche (owner decision 2026-10-11).

-- Function bodies reference tables created later in this file; don't validate them at creation time.
set check_function_bodies = off;

create schema if not exists private;
revoke all on schema private from public, anon;
-- authenticated needs USAGE so RLS policies can call private.is_admin() etc. Tables in private get no grants.
grant usage on schema private to authenticated, service_role;

-- ================================================================ types
do $$ begin create type public.niche as enum ('home_services', 'real_estate', 'dental');
exception when duplicate_object then null; end $$;
do $$ begin create type public.offer_code as enum ('RCP', 'WEB', 'BNDL', 'UNSURE');
exception when duplicate_object then null; end $$;
do $$ begin create type public.q_status as enum ('draft', 'submitted', 'quoted', 'closed');
exception when duplicate_object then null; end $$;
do $$ begin create type public.quote_status as enum ('draft', 'needs_manual_price', 'approved', 'sent', 'viewed', 'accepted', 'expired', 'void');
exception when duplicate_object then null; end $$;
do $$ begin create type public.pay_method as enum ('paypal_link', 'upwork', 'wire', 'tranzila_link');
exception when duplicate_object then null; end $$;
do $$ begin create type public.client_status as enum ('onboarding', 'building', 'testing', 'live', 'paused', 'cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_kind as enum ('deposit', 'final', 'monthly', 'overage');
exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_status as enum ('due', 'paid', 'refunded');
exception when duplicate_object then null; end $$;
do $$ begin create type public.onboarding_status as enum ('todo', 'done', 'need_help');
exception when duplicate_object then null; end $$;
do $$ begin create type public.request_status as enum ('queued', 'active', 'waiting_on_you', 'done', 'declined');
exception when duplicate_object then null; end $$;
do $$ begin create type public.tenant_status as enum ('sandbox', 'live', 'paused');
exception when duplicate_object then null; end $$;
do $$ begin create type public.call_outcome as enum ('booked', 'message', 'handoff', 'emergency', 'spam', 'abandoned');
exception when duplicate_object then null; end $$;
do $$ begin create type public.sms_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;
do $$ begin create type public.booking_status as enum ('confirmed', 'cancelled', 'completed');
exception when duplicate_object then null; end $$;
do $$ begin create type public.cred_provider as enum ('google', 'calendly', 'twilio_sub');
exception when duplicate_object then null; end $$;

-- ================================================================ private tables
-- Single row. Values are filled by tools/us_setup.py from config/brand.json; change by SQL editor only.
create table if not exists private.settings (
  id int primary key default 1 check (id = 1),
  admin_email text not null default 'laviemb@gmail.com',
  admin_url text not null default '',
  portal_url text not null default '',
  quote_url text not null default '',
  client_from text not null default '',
  admin_from text not null default '',
  reply_to text not null default '',
  client_emails_enabled boolean not null default false,
  admin_emails_enabled boolean not null default true,
  claude_daily_budget_usd numeric(10,2) not null default 10,
  twilio_monthly_budget_usd numeric(10,2) not null default 100,
  updated_at timestamptz not null default now()
);
insert into private.settings (id) values (1) on conflict (id) do nothing;

-- Niche catalogue (flags only; copy lives in config/ + site). Dental is built but hidden until legal review.
create table if not exists private.niches (
  key public.niche primary key,
  label text not null,
  visible boolean not null,
  early_access boolean not null
);
insert into private.niches (key, label, visible, early_access) values
  ('home_services', 'Home services', true, false),
  ('real_estate', 'Real estate', true, false),
  ('dental', 'Dental', false, true)
on conflict (key) do update set label = excluded.label, visible = excluded.visible, early_access = excluded.early_access;

-- ================================================================ helpers
-- Role of the API caller from the JWT: 'authenticated' | 'anon' | 'service_role' | '' (direct SQL / migrations).
create or replace function private.api_role() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = (select auth.uid())), false)
$$;

-- true when the caller is an API client (anon/authenticated) and not an admin. Guards apply only then.
create or replace function private.is_client_call() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.api_role() in ('authenticated', 'anon') and not private.is_admin()
$$;

create or replace function private.owns_client(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.clients c where c.id = p_client and c.user_id = (select auth.uid()))
$$;

create or replace function private.owns_tenant(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tenants t join public.clients c on c.id = t.client_id
                 where t.id = p_tenant and c.user_id = (select auth.uid()))
$$;

-- 64 hex chars from two v4 UUIDs (244 random bits, CSPRNG); no pgcrypto dependency.
create or replace function private.random_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ================================================================ tables
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  full_name text check (length(full_name) <= 200),
  company text check (length(company) <= 200),
  phone text check (length(phone) <= 40),
  city text check (length(city) <= 120),
  state text check (length(state) <= 60),
  timezone text check (length(timezone) <= 64),
  niche public.niche,
  website text check (length(website) <= 300),
  how_heard text check (length(how_heard) <= 300),
  update_lang text not null default 'en' check (update_lang in ('en', 'he')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(email) between 3 and 320 and position('@' in email) > 1),
  niche public.niche,
  source_page text check (length(source_page) <= 300),
  utm jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object' and octet_length(utm::text) < 4000),
  ip_hash text check (length(ip_hash) <= 128),  -- for the lead function's rate limit; never the raw IP
  created_at timestamptz not null default now()
);
create index if not exists leads_email_idx on public.leads (lower(email));
create index if not exists leads_ip_created_idx on public.leads (ip_hash, created_at);

create table if not exists public.questionnaires (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  offer public.offer_code,
  niche public.niche,
  status public.q_status not null default 'draft',
  -- raw form values keyed by question id (site/start/assets/questions.js)
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object' and octet_length(answers::text) < 200000),
  -- ordered [{"q": label, "a": text}] rebuilt by the client on every save
  summary jsonb not null default '[]'::jsonb check (jsonb_typeof(summary) = 'array' and octet_length(summary::text) < 200000),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists questionnaires_user_idx on public.questionnaires (user_id);
create index if not exists questionnaires_status_idx on public.questionnaires (status);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  questionnaire_id uuid references public.questionnaires(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,  -- null after retention anonymised the client (quote kept 7 years)
  status public.quote_status not null default 'draft',
  -- [{code, qty, name, setup_cents, monthly_cents, kind}] computed by pricing.ts from config/pricebook.json
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and octet_length(items::text) < 50000),
  setup_cents bigint check (setup_cents >= 0),
  monthly_cents bigint check (monthly_cents >= 0),
  deposit_cents bigint check (deposit_cents >= 0),
  discount_code text check (discount_code in ('FOUNDING')),
  scope_md text check (length(scope_md) <= 20000),
  assumptions jsonb not null default '[]'::jsonb check (jsonb_typeof(assumptions) = 'array'),
  timeline_text text check (length(timeline_text) <= 4000),
  valid_until timestamptz,
  public_token text not null unique default private.random_token() check (length(public_token) >= 32),
  pay_method public.pay_method,
  pay_link text check (length(pay_link) <= 1000 and pay_link ~ '^https://'),
  agreement_version text check (length(agreement_version) <= 40),
  agreement_hash text check (length(agreement_hash) <= 128),
  accepted_name text check (length(accepted_name) <= 200),
  accepted_ip text check (length(accepted_ip) <= 64),
  accepted_ua text check (length(accepted_ua) <= 1000),
  accepted_at timestamptz,
  sent_at timestamptz,
  viewed_at timestamptz,
  -- true after retention anonymised it (kept 7 years for bookkeeping). quote-view (A6) MUST refuse such quotes;
  -- the public_token is also replaced by a fresh random value, so old links stop resolving.
  anonymized boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quotes_deposit_le_setup check (deposit_cents is null or setup_cents is null or deposit_cents <= setup_cents)
);
create index if not exists quotes_user_idx on public.quotes (user_id);
create index if not exists quotes_questionnaire_idx on public.quotes (questionnaire_id);
create index if not exists quotes_status_idx on public.quotes (status);

create table if not exists private.quote_drafts (
  quote_id uuid primary key references public.quotes(id) on delete cascade,
  model text not null,
  prompt_hash text not null,
  raw_output jsonb not null,
  tokens int check (tokens >= 0),
  cost_usd numeric(10,4) check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,  -- null after retention anonymised the client
  quote_id uuid references public.quotes(id) on delete set null,
  products text[] not null default '{}' check (products <@ array['RCP','WEB','BNDL']::text[]),
  status public.client_status not null default 'onboarding',
  go_live_at timestamptz,
  monthly_cents bigint check (monthly_cents >= 0),
  next_bill_on date,
  ended_at timestamptz,  -- set when status becomes cancelled; retention anonymises 30 days later
  business_name text check (length(business_name) <= 200),  -- snapshot kept after anonymisation (bookkeeping)
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clients_user_idx on public.clients (user_id);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  kind public.payment_kind not null,
  amount_cents bigint not null check (amount_cents >= 0),
  method text check (length(method) <= 40),
  status public.payment_status not null default 'due',
  reference text check (length(reference) <= 300),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payments_client_idx on public.payments (client_id);

create table if not exists public.onboarding_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{1,60}$'),
  title text not null check (length(title) <= 200),
  video_url text check (length(video_url) <= 1000),
  sort int not null default 0,
  status public.onboarding_status not null default 'todo',
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and octet_length(data::text) < 20000),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, key)
);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  body text not null default '' check (length(body) <= 10000),
  status public.request_status not null default 'queued',
  position int not null default 0,
  admin_reply text check (length(admin_reply) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists requests_client_idx on public.requests (client_id, position);
-- one active request per client (SPEC §2.5)
create unique index if not exists requests_one_active on public.requests (client_id) where status = 'active';

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  questionnaire_id uuid references public.questionnaires(id) on delete cascade,
  request_id uuid references public.requests(id) on delete cascade,
  storage_path text not null unique check (length(storage_path) <= 500),
  filename text not null check (length(filename) between 1 and 255),
  size bigint not null check (size between 0 and 10485760),
  mime_type text check (length(mime_type) <= 200),
  created_at timestamptz not null default now(),
  constraint attachments_one_parent check (num_nonnulls(questionnaire_id, request_id) = 1)
);
create index if not exists attachments_owner_idx on public.attachments (owner_id);
create index if not exists attachments_q_idx on public.attachments (questionnaire_id);
create index if not exists attachments_r_idx on public.attachments (request_id);

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
  status public.tenant_status not null default 'sandbox',
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and octet_length(config::text) < 100000),
  twilio_number text unique check (twilio_number ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tenants_client_idx on public.tenants (client_id);

create table if not exists private.tenant_credentials (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider public.cred_provider not null,
  ciphertext text not null,  -- AES-GCM with CRED_KEY (runtime only); never plaintext
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_sid text not null unique check (length(call_sid) <= 64),
  from_e164 text check (length(from_e164) <= 20),
  started_at timestamptz not null default now(),
  duration_s int check (duration_s >= 0),
  outcome public.call_outcome,
  transcript jsonb check (transcript is null or jsonb_typeof(transcript) = 'array'),
  summary text check (length(summary) <= 4000),
  cost_usd numeric(10,4) check (cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index if not exists calls_tenant_started_idx on public.calls (tenant_id, started_at desc);

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_e164 text not null check (length(contact_e164) <= 20),
  direction public.sms_direction not null,
  body text not null check (length(body) <= 2000),
  twilio_sid text unique check (length(twilio_sid) <= 64),
  created_at timestamptz not null default now()
);
create index if not exists sms_tenant_created_idx on public.sms_messages (tenant_id, created_at desc);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid references public.calls(id) on delete set null,
  customer_name text check (length(customer_name) <= 200),
  contact_e164 text check (length(contact_e164) <= 20),
  address text check (length(address) <= 500),
  job_type text check (length(job_type) <= 200),
  urgency text check (length(urgency) <= 40),
  start_at timestamptz,
  end_at timestamptz,
  provider_event_id text check (length(provider_event_id) <= 300),
  status public.booking_status not null default 'confirmed',
  created_at timestamptz not null default now(),
  constraint bookings_time_order check (end_at is null or start_at is null or end_at > start_at)
);
create index if not exists bookings_tenant_start_idx on public.bookings (tenant_id, start_at);

create table if not exists public.opt_outs (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_e164 text not null check (length(contact_e164) <= 20),
  opted_out_at timestamptz not null default now(),
  primary key (tenant_id, contact_e164)
);

-- Event log. Written only by security-definer triggers / RPCs / service role.
-- user_id = the client the event is about; client_visible = shown in that client's portal.
create table if not exists public.events (
  id bigint generated always as identity primary key,
  actor text not null default '',  -- 'client:<uuid>' | 'admin:<uuid>' | 'system' | 'runtime'
  entity text not null check (length(entity) <= 40),
  entity_id uuid,
  user_id uuid,
  type text not null check (length(type) <= 60),
  payload jsonb not null default '{}'::jsonb,
  client_visible boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists events_entity_idx on public.events (entity, entity_id);
create index if not exists events_user_idx on public.events (user_id, created_at desc);

-- Internal notes: separate admin-only table so no client-readable row ever carries them.
create table if not exists public.admin_notes (
  entity text not null check (entity in ('questionnaire', 'quote', 'client', 'tenant', 'request', 'lead')),
  entity_id uuid not null,
  body text not null default '' check (length(body) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (entity, entity_id)
);

-- ================================================================ event helper
create or replace function private.log_event(p_entity text, p_entity_id uuid, p_user uuid, p_type text,
                                             p_payload jsonb default '{}'::jsonb, p_visible boolean default false)
returns void language sql security definer set search_path = '' as $$
  insert into public.events (actor, entity, entity_id, user_id, type, payload, client_visible)
  values (
    case when (select auth.uid()) is null then
           case when private.api_role() = 'service_role' then 'runtime' else 'system' end
         when private.is_admin() then 'admin:' || (select auth.uid())::text
         else 'client:' || (select auth.uid())::text end,
    p_entity, p_entity_id, p_user, p_type, coalesce(p_payload, '{}'::jsonb), p_visible);
$$;

-- ================================================================ new user -> profile
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, is_admin)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), ''),
    lower(coalesce(new.email, '')) = (select lower(s.admin_email) from private.settings s where s.id = 1)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_user_email_change();

-- ================================================================ guards
-- profiles: a client can edit its own row but never id/email/is_admin; timezone must be a real IANA name.
create or replace function private.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.is_client_call() then
    if tg_op = 'INSERT' then
      new.id := auth.uid();
      new.is_admin := false;
      new.email := coalesce((select u.email from auth.users u where u.id = auth.uid()), '');
      new.created_at := now();
    else
      new.id := old.id;
      new.is_admin := old.is_admin;
      new.email := old.email;
      new.created_at := old.created_at;
    end if;
  end if;
  if new.timezone is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'invalid_timezone' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function private.profiles_guard();

-- questionnaires: client owns drafts; can only move draft -> submitted (needs an offer); locked afterwards.
create or replace function private.questionnaires_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if private.is_client_call() then
      new.user_id := auth.uid();
      new.status := 'draft';
      new.submitted_at := null;
      if (select count(*) from public.questionnaires q where q.user_id = auth.uid()) >= 20 then
        raise exception 'too_many_questionnaires' using errcode = 'P0001';
      end if;
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if private.is_client_call() then
    if old.status <> 'draft' then
      raise exception 'questionnaire_locked' using errcode = 'P0001';
    end if;
    if new.status not in ('draft', 'submitted') then
      raise exception 'invalid_status' using errcode = 'P0001';
    end if;
    new.id := old.id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  if new.status = 'submitted' and old.status = 'draft' then
    if new.offer is null then
      raise exception 'offer_required' using errcode = 'P0001';
    end if;
    new.submitted_at := now();
  elsif new.status = 'draft' then
    new.submitted_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists questionnaires_guard on public.questionnaires;
create trigger questionnaires_guard before insert or update on public.questionnaires
  for each row execute function private.questionnaires_guard();

-- quotes: clients have no write grants at all (accept goes through the quote-accept Edge Function).
-- Invariants for everyone (admin and service role included):
--   * cannot be sent while needs_manual_price is unresolved (must pass through approved first)
--   * cannot be accepted after valid_until, or unless it was sent
--   * timestamps are set by the database
create or replace function private.quotes_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'needs_manual_price') then
      raise exception 'quote_must_start_as_draft' using errcode = 'P0001';
    end if;
    new.sent_at := null; new.viewed_at := null; new.accepted_at := null;
    new.created_at := now();
  else
    new.id := old.id;
    new.created_at := old.created_at;
    -- anonymisation (retention) is one-way and may rotate the token and strip Claude text from items
    if old.anonymized and not new.anonymized then
      raise exception 'quote_anonymized' using errcode = 'P0001';
    end if;
    if not (new.anonymized and not old.anonymized) then
      new.public_token := old.public_token;
    end if;
    new.sent_at := old.sent_at;
    new.viewed_at := old.viewed_at;
    new.accepted_at := old.accepted_at;
    if new.status is distinct from old.status then
      if new.status = 'approved' and (new.setup_cents is null or new.monthly_cents is null or new.deposit_cents is null) then
        raise exception 'quote_amounts_missing' using errcode = 'P0001';
      end if;
      if old.status = 'needs_manual_price' and new.status not in ('needs_manual_price', 'approved', 'void', 'draft') then
        raise exception 'manual_price_required' using errcode = 'P0001';
      end if;
      if new.status = 'sent' and old.status not in ('approved', 'sent') then
        raise exception 'quote_not_approved' using errcode = 'P0001';
      end if;
      if new.status = 'sent' then
        if new.setup_cents is null or new.monthly_cents is null or new.deposit_cents is null then
          raise exception 'quote_amounts_missing' using errcode = 'P0001';
        end if;
        new.sent_at := now();
        new.valid_until := coalesce(new.valid_until, now() + interval '14 days');
      end if;
      if new.status = 'viewed' then
        if old.status <> 'sent' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
        new.viewed_at := coalesce(old.viewed_at, now());
      end if;
      if new.status = 'accepted' then
        if old.status not in ('sent', 'viewed') then
          raise exception 'quote_not_sent' using errcode = 'P0001';
        end if;
        if old.valid_until is not null and old.valid_until < now() then
          raise exception 'quote_expired' using errcode = 'P0001';
        end if;
        if coalesce(btrim(new.accepted_name), '') = '' or new.agreement_version is null then
          raise exception 'acceptance_incomplete' using errcode = 'P0001';
        end if;
        new.accepted_at := now();
      end if;
      if old.status = 'accepted' and new.status <> 'void' then
        raise exception 'quote_already_accepted' using errcode = 'P0001';
      end if;
    end if;
    -- after sending, amounts and line items are frozen (void + new quote instead)
    if old.sent_at is not null and ((new.items is distinct from old.items and not (new.anonymized and not old.anonymized)) or new.setup_cents is distinct from old.setup_cents
        or new.monthly_cents is distinct from old.monthly_cents or new.deposit_cents is distinct from old.deposit_cents
        or new.discount_code is distinct from old.discount_code) then
      raise exception 'quote_frozen_after_send' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists quotes_guard on public.quotes;
create trigger quotes_guard before insert or update on public.quotes
  for each row execute function private.quotes_guard();

create or replace function private.clients_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.created_at := old.created_at;
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      new.ended_at := now();
    elsif new.status <> 'cancelled' then
      new.ended_at := null;
    end if;
    if new.status = 'live' and old.status <> 'live' and new.go_live_at is null then
      new.go_live_at := now();
    end if;
  else
    new.created_at := now();
    new.ended_at := case when new.status = 'cancelled' then now() else null end;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists clients_guard on public.clients;
create trigger clients_guard before insert or update on public.clients
  for each row execute function private.clients_guard();

create or replace function private.payments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status <> 'paid') then
    new.paid_at := coalesce(new.paid_at, now());
  elsif new.status = 'due' then
    new.paid_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists payments_guard on public.payments;
create trigger payments_guard before insert or update on public.payments
  for each row execute function private.payments_guard();

-- requests: client inserts (always queued, end of queue) and edits title/body/position only while queued.
create or replace function private.requests_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if private.is_client_call() then
      if not private.owns_client(new.client_id) then
        raise exception 'not_your_client' using errcode = 'P0001';
      end if;
      new.status := 'queued';
      new.admin_reply := null;
      new.position := coalesce((select max(r.position) + 1 from public.requests r where r.client_id = new.client_id), 0);
      if (select count(*) from public.requests r where r.client_id = new.client_id and r.status in ('queued', 'active', 'waiting_on_you')) >= 25 then
        raise exception 'too_many_requests' using errcode = 'P0001';
      end if;
    end if;
    new.created_at := now();
  else
    new.id := old.id;
    new.created_at := old.created_at;
    if private.is_client_call() then
      if old.status <> 'queued' then
        raise exception 'request_locked' using errcode = 'P0001';
      end if;
      new.client_id := old.client_id;
      new.status := old.status;
      new.admin_reply := old.admin_reply;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists requests_guard on public.requests;
create trigger requests_guard before insert or update on public.requests
  for each row execute function private.requests_guard();

-- attachments: max 5 per item; client may attach only to its own draft questionnaire or open request;
-- storage_path must be {owner}/{item id}/{rand}-{ascii-name}.
create or replace function private.attachments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare item uuid := coalesce(new.questionnaire_id, new.request_id);
begin
  if private.is_client_call() then
    new.owner_id := auth.uid();
    if new.questionnaire_id is not null and not exists (
         select 1 from public.questionnaires q where q.id = new.questionnaire_id and q.user_id = auth.uid() and q.status = 'draft') then
      raise exception 'item_locked' using errcode = 'P0001';
    end if;
    if new.request_id is not null and not exists (
         select 1 from public.requests r join public.clients c on c.id = r.client_id
         where r.id = new.request_id and c.user_id = auth.uid() and r.status in ('queued', 'waiting_on_you')) then
      raise exception 'item_locked' using errcode = 'P0001';
    end if;
  end if;
  if split_part(new.storage_path, '/', 1) <> new.owner_id::text
     or split_part(new.storage_path, '/', 2) <> item::text
     or split_part(new.storage_path, '/', 3) !~ '^[A-Za-z0-9]{6,40}-[A-Za-z0-9._-]{1,200}$'
     or split_part(new.storage_path, '/', 4) <> '' then
    raise exception 'bad_path' using errcode = 'P0001';
  end if;
  if (select count(*) from public.attachments a
      where a.questionnaire_id is not distinct from new.questionnaire_id
        and a.request_id is not distinct from new.request_id) >= 5 then
    raise exception 'too_many_files' using errcode = 'P0001';
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists attachments_guard on public.attachments;
create trigger attachments_guard before insert on public.attachments
  for each row execute function private.attachments_guard();

create or replace function private.onboarding_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists onboarding_guard on public.onboarding_items;
create trigger onboarding_guard before insert or update on public.onboarding_items
  for each row execute function private.onboarding_guard();

drop trigger if exists tenants_touch on public.tenants;
create trigger tenants_touch before update on public.tenants
  for each row execute function private.touch_updated_at();
drop trigger if exists admin_notes_touch on public.admin_notes;
create trigger admin_notes_touch before insert or update on public.admin_notes
  for each row execute function private.touch_updated_at();

-- ================================================================ status-change log
create or replace function private.log_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ent text := case tg_table_name when 'questionnaires' then 'questionnaire' when 'quotes' then 'quote'
                                 when 'clients' then 'client' when 'requests' then 'request' else tg_table_name end;
  v_owner uuid;
  st text := to_jsonb(new) ->> 'status';
  vis boolean;
begin
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> 'status') is not distinct from st then
    return null;
  end if;
  v_owner := coalesce((to_jsonb(new) ->> 'user_id')::uuid,
                    (select c.user_id from public.clients c where c.id = (to_jsonb(new) ->> 'client_id')::uuid));
  vis := case ent when 'quote' then st in ('sent', 'viewed', 'accepted', 'expired') else true end;
  perform private.log_event(ent, new.id, v_owner, case when tg_op = 'INSERT' then 'created' else 'status_changed' end,
    jsonb_build_object('from', case when tg_op = 'UPDATE' then to_jsonb(old) ->> 'status' end, 'to', st), vis);
  return null;
end $$;

drop trigger if exists questionnaires_log on public.questionnaires;
create trigger questionnaires_log after insert or update of status on public.questionnaires
  for each row execute function private.log_status_change();
drop trigger if exists quotes_log on public.quotes;
create trigger quotes_log after insert or update of status on public.quotes
  for each row execute function private.log_status_change();
drop trigger if exists clients_log on public.clients;
create trigger clients_log after insert or update of status on public.clients
  for each row execute function private.log_status_change();
drop trigger if exists requests_log on public.requests;
create trigger requests_log after insert or update of status on public.requests
  for each row execute function private.log_status_change();

-- ================================================================ RPCs for clients
-- Tenant settings: the ONLY client write path into tenants.config. Whitelist: hours, faq, notify, paused.
create or replace function public.update_tenant_settings(p_tenant_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v jsonb;
  day text;
  cfg jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then
    raise exception 'not_your_tenant' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch_must_be_object' using errcode = 'P0001';
  end if;
  for k, v in select key, value from jsonb_each(p_patch) loop
    if k not in ('hours', 'faq', 'notify', 'paused') then
      raise exception 'field_not_allowed: %', k using errcode = 'P0001';
    end if;
    if k = 'paused' and jsonb_typeof(v) <> 'boolean' then
      raise exception 'paused_must_be_boolean' using errcode = 'P0001';
    end if;
    if k = 'hours' then
      if jsonb_typeof(v) <> 'object' then raise exception 'hours_must_be_object' using errcode = 'P0001'; end if;
      for day in select jsonb_object_keys(v) loop
        if day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
          raise exception 'hours_bad_day: %', day using errcode = 'P0001';
        end if;
        if not (jsonb_typeof(v -> day) = 'null'
                or (jsonb_typeof(v -> day) = 'array' and jsonb_array_length(v -> day) = 2
                    and (v -> day ->> 0) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                    and (v -> day ->> 1) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) then
          raise exception 'hours_bad_value: %', day using errcode = 'P0001';
        end if;
      end loop;
    end if;
    if k = 'faq' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 25 then
        raise exception 'faq_must_be_array_max_25' using errcode = 'P0001';
      end if;
      if exists (select 1 from jsonb_array_elements(v) e
                 where jsonb_typeof(e) <> 'object'
                    or not (e ? 'q' and e ? 'a')
                    or (select count(*) from jsonb_object_keys(e)) <> 2
                    or jsonb_typeof(e -> 'q') <> 'string' or jsonb_typeof(e -> 'a') <> 'string'
                    or length(e ->> 'q') not between 1 and 300 or length(e ->> 'a') not between 1 and 1000) then
        raise exception 'faq_bad_entry' using errcode = 'P0001';
      end if;
    end if;
    if k = 'notify' then
      if jsonb_typeof(v) <> 'object'
         or exists (select 1 from jsonb_object_keys(v) nk where nk not in ('sms', 'email', 'daily_summary')) then
        raise exception 'notify_bad_shape' using errcode = 'P0001';
      end if;
      if v ? 'sms' and (jsonb_typeof(v -> 'sms') <> 'array' or jsonb_array_length(v -> 'sms') > 5
          or exists (select 1 from jsonb_array_elements(v -> 'sms') e
                     where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^\+[1-9][0-9]{6,14}$')) then
        raise exception 'notify_bad_sms' using errcode = 'P0001';
      end if;
      if v ? 'email' and (jsonb_typeof(v -> 'email') <> 'array' or jsonb_array_length(v -> 'email') > 5
          or exists (select 1 from jsonb_array_elements(v -> 'email') e
                     where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$')) then
        raise exception 'notify_bad_email' using errcode = 'P0001';
      end if;
      if v ? 'daily_summary' and not (jsonb_typeof(v -> 'daily_summary') = 'null'
          or (v ->> 'daily_summary') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
        raise exception 'notify_bad_time' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  update public.tenants t set config = t.config || p_patch where t.id = p_tenant_id returning t.config into cfg;
  perform private.log_event('tenant', p_tenant_id,
    (select c.user_id from public.tenants t join public.clients c on c.id = t.client_id where t.id = p_tenant_id),
    'settings_updated', jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)), true);
  return cfg;
end $$;

-- Onboarding checklist item: client sets status (todo/done/need_help) and merges data. Nothing else.
create or replace function public.update_onboarding_item(p_id uuid, p_status public.onboarding_status, p_data jsonb default null)
returns public.onboarding_items
language plpgsql security definer set search_path = '' as $$
declare
  it public.onboarding_items;
  v_owner uuid;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  select * into it from public.onboarding_items o where o.id = p_id;
  if not found or not (private.owns_client(it.client_id) or private.is_admin()) then
    raise exception 'not_your_item' using errcode = '42501';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'data_must_be_object' using errcode = 'P0001';
  end if;
  update public.onboarding_items o
     set status = coalesce(p_status, o.status), data = o.data || coalesce(p_data, '{}'::jsonb)
   where o.id = p_id returning * into it;
  select c.user_id into v_owner from public.clients c where c.id = it.client_id;
  perform private.log_event('onboarding_item', it.id, v_owner,
    case when p_status = 'need_help' then 'need_help' else 'onboarding_updated' end,
    jsonb_build_object('key', it.key, 'status', it.status), true);
  return it;
end $$;

-- ================================================================ RPCs for the runtime (service role only)
-- runtime/app/store.py (SupabaseStore) calls these via /rest/v1/rpc/*. Ciphertext only (AES-GCM, CRED_KEY lives in
-- Railway); the database never sees plaintext. Not executable by anon/authenticated (grants + api_role check).
create or replace function public.runtime_put_credential(p_tenant_id uuid, p_provider text, p_ciphertext text,
                                                         p_expires_at timestamptz default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.api_role() not in ('service_role', '') then
    raise exception 'service_role_only' using errcode = '42501';
  end if;
  if coalesce(length(p_ciphertext), 0) = 0 then
    raise exception 'ciphertext_required' using errcode = 'P0001';
  end if;
  insert into private.tenant_credentials (tenant_id, provider, ciphertext, expires_at, updated_at)
  values (p_tenant_id, p_provider::public.cred_provider, p_ciphertext, p_expires_at, now())
  on conflict (tenant_id, provider) do update
    set ciphertext = excluded.ciphertext, expires_at = excluded.expires_at, updated_at = now();
end $$;

create or replace function public.runtime_get_credential(p_tenant_id uuid, p_provider text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if private.api_role() not in ('service_role', '') then
    raise exception 'service_role_only' using errcode = '42501';
  end if;
  return (select c.ciphertext from private.tenant_credentials c
          where c.tenant_id = p_tenant_id and c.provider = p_provider::public.cred_provider);
end $$;

revoke all on function public.runtime_put_credential(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.runtime_get_credential(uuid, text) from public, anon, authenticated;
grant execute on function public.runtime_put_credential(uuid, text, text, timestamptz) to service_role;
grant execute on function public.runtime_get_credential(uuid, text) to service_role;

-- ================================================================ RLS
alter table public.profiles enable row level security;
alter table public.leads enable row level security;
alter table public.questionnaires enable row level security;
alter table public.quotes enable row level security;
alter table public.clients enable row level security;
alter table public.payments enable row level security;
alter table public.onboarding_items enable row level security;
alter table public.requests enable row level security;
alter table public.attachments enable row level security;
alter table public.tenants enable row level security;
alter table public.calls enable row level security;
alter table public.sms_messages enable row level security;
alter table public.bookings enable row level security;
alter table public.opt_outs enable row level security;
alter table public.events enable row level security;
alter table public.admin_notes enable row level security;
alter table private.settings enable row level security;
alter table private.niches enable row level security;
alter table private.quote_drafts enable row level security;
alter table private.tenant_credentials enable row level security;

-- Grants. Supabase's default privileges grant ALL to anon/authenticated on new tables: reset, then grant the minimum.
revoke all on public.profiles, public.leads, public.questionnaires, public.quotes, public.clients, public.payments,
  public.onboarding_items, public.requests, public.attachments, public.tenants, public.calls, public.sms_messages,
  public.bookings, public.opt_outs, public.events, public.admin_notes from anon, authenticated;
revoke all on private.settings, private.niches, private.quote_drafts, private.tenant_credentials from public, anon, authenticated;
grant all on public.profiles, public.leads, public.questionnaires, public.quotes, public.clients, public.payments,
  public.onboarding_items, public.requests, public.attachments, public.tenants, public.calls, public.sms_messages,
  public.bookings, public.opt_outs, public.events, public.admin_notes to service_role;
grant all on private.settings, private.niches, private.quote_drafts, private.tenant_credentials to service_role;

grant select, insert, update on public.profiles to authenticated;
grant select on public.leads to authenticated;                                   -- admin only (policy); insert = lead Edge Function
grant select, insert, update, delete on public.questionnaires to authenticated;
grant select, insert, update, delete on public.quotes to authenticated;          -- writes: admin only (policies)
grant select, insert, update, delete on public.clients to authenticated;         -- writes: admin only
grant select, insert, update, delete on public.payments to authenticated;        -- writes: admin only
grant select, insert, update, delete on public.onboarding_items to authenticated; -- writes: admin only; clients via RPC
grant select, insert, update, delete on public.requests to authenticated;
grant select, insert, delete on public.attachments to authenticated;
grant select, insert, update, delete on public.tenants to authenticated;         -- writes: admin only; clients via RPC
grant select on public.calls, public.sms_messages, public.bookings to authenticated; -- writes: runtime (service role) only
grant select on public.opt_outs to authenticated;                                -- admin only (policy)
grant select on public.events to authenticated;
grant select, insert, update, delete on public.admin_notes to authenticated;     -- admin only (policy)

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()))
  with check (id = (select auth.uid()) or (select private.is_admin()));

-- leads (admin read)
drop policy if exists leads_admin_select on public.leads;
create policy leads_admin_select on public.leads for select to authenticated
  using ((select private.is_admin()));

-- questionnaires
drop policy if exists q_select on public.questionnaires;
create policy q_select on public.questionnaires for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists q_insert on public.questionnaires;
create policy q_insert on public.questionnaires for insert to authenticated
  with check (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists q_update on public.questionnaires;
create policy q_update on public.questionnaires for update to authenticated
  using ((user_id = (select auth.uid()) and status = 'draft') or (select private.is_admin()))
  with check ((user_id = (select auth.uid()) and status in ('draft', 'submitted')) or (select private.is_admin()));
drop policy if exists q_delete on public.questionnaires;
create policy q_delete on public.questionnaires for delete to authenticated
  using ((user_id = (select auth.uid()) and status = 'draft') or (select private.is_admin()));

-- quotes: client sees own only once sent; all writes admin (or service role)
drop policy if exists quotes_select on public.quotes;
create policy quotes_select on public.quotes for select to authenticated
  using ((user_id = (select auth.uid()) and sent_at is not null
          and status in ('sent', 'viewed', 'accepted', 'expired', 'void'))
         or (select private.is_admin()));
drop policy if exists quotes_admin_write on public.quotes;
create policy quotes_admin_write on public.quotes for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- clients / payments / onboarding_items: client reads own; admin writes
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists clients_admin_write on public.clients;
create policy clients_admin_write on public.clients for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists payments_admin_write on public.payments;
create policy payments_admin_write on public.payments for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

drop policy if exists onboarding_select on public.onboarding_items;
create policy onboarding_select on public.onboarding_items for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists onboarding_admin_write on public.onboarding_items;
create policy onboarding_admin_write on public.onboarding_items for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- requests: client reads own, inserts, edits while queued; admin everything
drop policy if exists requests_select on public.requests;
create policy requests_select on public.requests for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists requests_insert on public.requests;
create policy requests_insert on public.requests for insert to authenticated
  with check ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists requests_update on public.requests;
create policy requests_update on public.requests for update to authenticated
  using (((select private.owns_client(client_id)) and status = 'queued') or (select private.is_admin()))
  with check (((select private.owns_client(client_id)) and status = 'queued') or (select private.is_admin()));
drop policy if exists requests_admin_delete on public.requests;
create policy requests_admin_delete on public.requests for delete to authenticated
  using ((select private.is_admin()));

-- attachments
drop policy if exists att_select on public.attachments;
create policy att_select on public.attachments for select to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists att_insert on public.attachments;
create policy att_insert on public.attachments for insert to authenticated
  with check (owner_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists att_delete on public.attachments;
create policy att_delete on public.attachments for delete to authenticated
  using ((owner_id = (select auth.uid()) and (
            exists (select 1 from public.questionnaires q
                    where q.id = questionnaire_id and q.user_id = (select auth.uid()) and q.status = 'draft')
            or exists (select 1 from public.requests r
                       where r.id = request_id and r.status in ('queued', 'waiting_on_you'))))
         or (select private.is_admin()));

-- tenants: client reads own; writes admin (clients via update_tenant_settings)
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists tenants_admin_write on public.tenants;
create policy tenants_admin_write on public.tenants for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- runtime data: client reads own tenant's rows; nobody writes through the API
drop policy if exists calls_select on public.calls;
create policy calls_select on public.calls for select to authenticated
  using ((select private.owns_tenant(tenant_id)) or (select private.is_admin()));
drop policy if exists sms_select on public.sms_messages;
create policy sms_select on public.sms_messages for select to authenticated
  using ((select private.owns_tenant(tenant_id)) or (select private.is_admin()));
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings for select to authenticated
  using ((select private.owns_tenant(tenant_id)) or (select private.is_admin()));
drop policy if exists opt_outs_admin_select on public.opt_outs;
create policy opt_outs_admin_select on public.opt_outs for select to authenticated
  using ((select private.is_admin()));

-- events: client reads own client-visible rows; admin all
drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using ((user_id = (select auth.uid()) and client_visible) or (select private.is_admin()));

-- admin notes
drop policy if exists admin_notes_admin on public.admin_notes;
create policy admin_notes_admin on public.admin_notes for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- ================================================================ function privileges
-- Supabase grants EXECUTE on new functions to anon/authenticated by default: reset.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.api_role() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.is_client_call() to authenticated;
grant execute on function private.owns_client(uuid) to authenticated;
grant execute on function private.owns_tenant(uuid) to authenticated;
grant execute on function private.random_token() to authenticated, service_role;
grant execute on all functions in schema private to service_role;

revoke all on function public.update_tenant_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_tenant_settings(uuid, jsonb) to authenticated, service_role;
revoke all on function public.update_onboarding_item(uuid, public.onboarding_status, jsonb) from public, anon;
grant execute on function public.update_onboarding_item(uuid, public.onboarding_status, jsonb) to authenticated, service_role;

-- ================================================================ keep-alive
-- Called daily by a GitHub Action (Free projects pause after 7 idle days). Returns no data.
create or replace function public.ping() returns text
language sql stable security invoker set search_path = '' as $$ select 'ok'::text $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated, service_role;
