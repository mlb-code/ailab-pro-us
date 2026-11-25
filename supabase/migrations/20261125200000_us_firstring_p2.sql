-- FirstRing phase 2 (owner decision 2026-11-25). Additive and idempotent; nothing here changes 20261125100000_us_subscriptions.sql.
--
-- 1. Number release after the service ended
--    public.number_releases   one row per tenant: the receptionist's number, why/when the service ended, warn_at
--                             (= release_at - number_release_warn_days, default 7) and release_at (= end of service +
--                             number_release_days, default 30), status scheduled|held|released|canceled|failed.
--    private.number_release_sync(client)  on every subscription write (trigger) + hourly (cron): schedules a release when
--                             the service has ENDED (cancelled after the paid period, or the free trial ended unpaid =
--                             private.sub_service message_only 'canceled' / 'trial_ended'); a resubscribe (or anything that
--                             is not "ended": active, trialing, past due, paused) cancels a pending release.
--    The runtime (/jobs/tick, runtime/app/provisioning.py) sends the customer's 7-day warning, re-checks the subscription
--    right before, and releases the number: dry run unless TWILIO_RELEASE_LIVE=1 (row 'held' + Hebrew note to Meir).
--    Admin: admin_postpone_number_release(client, days), admin_release_number_now(client) (confirm in the UI).
--    A released number frees the tenant (twilio_number = null) and removes the old 'number' job, so a later resubscribe
--    buys a new number automatically.
-- 2. Go-live live AI check: the result lives in provisioning_jobs.result.ai_check (runtime/app/golive.py); a model that
--    could not be reached leaves the golive_sim job 'held' (never live without Meir). Read by admin_subscriptions_extra().
-- 3. Spanish on Pro / Business: private.plan_has_spanish(code) (= price book features 'spanish'; runtime/tests checks the
--    list), trigger tenants_plan_spanish keeps voice.languages = plan + the customer's remembered choice
--    (voice.spanish_off), and update_tenant_settings accepts one more whitelisted key: spanish (boolean).
set check_function_bodies = off;

-- ================================================================ settings
alter table private.settings add column if not exists number_release_days int not null default 30;
alter table private.settings add column if not exists number_release_warn_days int not null default 7;

-- ================================================================ table
create table if not exists public.number_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  number text not null check (number ~ '^\+[1-9][0-9]{7,14}$'),
  reason text not null check (reason in ('canceled', 'trial_ended')),
  status text not null default 'scheduled' check (status in ('scheduled', 'held', 'released', 'canceled', 'failed')),
  service_ended_at timestamptz not null,
  warn_at timestamptz not null,
  release_at timestamptz not null,
  warned_at timestamptz,
  released_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text check (length(cancel_reason) <= 200),
  force boolean not null default false,          -- Meir pressed "release now": no waiting for the 7-day warning
  postponed_count int not null default 0 check (postponed_count >= 0),
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (length(last_error) <= 500),
  next_attempt_at timestamptz,
  dry_run boolean not null default false,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object' and octet_length(result::text) < 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (warn_at <= release_at)
);
create index if not exists number_releases_due_idx on public.number_releases (status, release_at);

alter table public.number_releases enable row level security;
revoke all on public.number_releases from public, anon, authenticated;
grant select on public.number_releases to authenticated;      -- admin only (policy)
grant all on public.number_releases to service_role;
drop policy if exists number_releases_admin_select on public.number_releases;
create policy number_releases_admin_select on public.number_releases for select to authenticated
  using ((select private.is_admin()));
drop trigger if exists number_releases_touch on public.number_releases;
create trigger number_releases_touch before update on public.number_releases
  for each row execute function private.touch_updated_at();

-- ================================================================ when did the service end (null = it has not)
create or replace function private.number_release_window(sub public.subscriptions, p_now timestamptz default now())
returns table (eligible boolean, reason text, ended_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare sv record;
begin
  eligible := false; reason := ''; ended_at := null;
  if sub.id is null then return next; return; end if;
  select * into sv from private.sub_service(sub, p_now);
  if sv.service <> 'message_only' or sv.reason not in ('canceled', 'trial_ended') then return next; return; end if;
  reason := sv.reason;
  ended_at := case when sv.reason = 'trial_ended' then sub.trial_ends_at
                   when sub.status = 'canceled' then coalesce(sub.ends_at, sub.canceled_at)
                   else sub.current_period_end end;                      -- active + cancel_at_period_end, period over
  eligible := ended_at is not null and ended_at <= p_now;
  return next;
end $$;

-- schedule / cancel the release of a client's number (idempotent). Returns the row's status, or null (no tenant).
create or replace function private.number_release_sync(p_client uuid, p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = '' as $$
declare
  t public.tenants; sub public.subscriptions; w record; r public.number_releases; st private.settings;
  days int; warn int; rel timestamptz; uid uuid;
begin
  select * into st from private.settings where id = 1;
  days := greatest(coalesce(st.number_release_days, 30), 1);
  warn := least(greatest(coalesce(st.number_release_warn_days, 7), 1), days);
  select * into t from public.tenants x where x.client_id = p_client order by x.created_at limit 1;
  if t.id is null then return null; end if;
  uid := (select c.user_id from public.clients c where c.id = p_client);
  sub := private.client_sub(p_client);
  select * into w from private.number_release_window(sub, p_now);
  select * into r from public.number_releases x where x.tenant_id = t.id;
  if w.eligible and t.twilio_number is not null then
    rel := w.ended_at + make_interval(days => days);
    if r.id is null then
      insert into public.number_releases (tenant_id, client_id, subscription_id, number, reason, service_ended_at, warn_at, release_at)
      values (t.id, p_client, sub.id, t.twilio_number, w.reason, w.ended_at, rel - make_interval(days => warn), rel)
      returning * into r;
      perform private.log_event('tenant', t.id, uid, 'number_release_scheduled',
        jsonb_build_object('release_at', rel, 'reason', w.reason), false);
    elsif r.status = 'canceled' or (r.status = 'released' and r.number is distinct from t.twilio_number) then
      update public.number_releases x set subscription_id = sub.id, number = t.twilio_number, reason = w.reason, status = 'scheduled',
             service_ended_at = w.ended_at, warn_at = rel - make_interval(days => warn), release_at = rel, warned_at = null,
             released_at = null, canceled_at = null, cancel_reason = null, force = false, postponed_count = 0, attempts = 0,
             last_error = null, next_attempt_at = null, dry_run = false, result = '{}'::jsonb
       where x.id = r.id returning * into r;
      perform private.log_event('tenant', t.id, uid, 'number_release_scheduled',
        jsonb_build_object('release_at', rel, 'reason', w.reason), false);
    end if;   -- scheduled / held / failed / released: kept (postponements and Meir's decisions survive)
    return r.status;
  end if;
  if r.id is not null and r.status in ('scheduled', 'held', 'failed') then
    update public.number_releases x set status = 'canceled', canceled_at = p_now,
           cancel_reason = case when sub.status in ('active', 'trialing') and w.reason = '' then 'resubscribed'
                                when t.twilio_number is distinct from r.number then 'number_changed'
                                else 'service_not_ended' end
     where x.id = r.id returning * into r;
    perform private.log_event('tenant', t.id, uid, 'number_release_canceled', jsonb_build_object('why', r.cancel_reason), false);
  end if;
  return r.status;
end $$;

create or replace function private.number_release_sync_all(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare rec record; n int := 0;
begin
  for rec in select distinct s.client_id from public.subscriptions s loop
    begin
      perform private.number_release_sync(rec.client_id, p_now);
      n := n + 1;
    exception when others then
      perform private.log_event('client', rec.client_id, null, 'number_release_sync_error', jsonb_build_object('error', left(sqlerrm, 300)), false);
    end;
  end loop;
  return n;
end $$;
select cron.schedule('ailab-us-number-release', '23 * * * *', 'select private.number_release_sync_all()');

-- every subscription write (webhook, mock, admin): a resubscribe cancels at once. Never blocks the billing write.
create or replace function private.subscriptions_number_release() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.number_release_sync(new.client_id);
  exception when others then
    perform private.log_event('client', new.client_id, null, 'number_release_sync_error', jsonb_build_object('error', left(sqlerrm, 300)), false);
  end;
  return null;
end $$;
drop trigger if exists subscriptions_number_release on public.subscriptions;
create trigger subscriptions_number_release after insert or update on public.subscriptions
  for each row execute function private.subscriptions_number_release();

-- runtime result -> a released number frees the tenant for a later resubscribe (a new 'number' job is queued then)
create or replace function private.number_releases_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select c.user_id from public.clients c where c.id = new.client_id);
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.status = 'released' then
    delete from public.provisioning_jobs j where j.tenant_id = new.tenant_id and j.kind = 'number';
    update public.tenants t set twilio_number = null where t.id = new.tenant_id and t.twilio_number = new.number;
    perform private.log_event('tenant', new.tenant_id, uid, 'number_released', '{}'::jsonb, false);
  elsif new.status in ('held', 'failed') then
    perform private.log_event('tenant', new.tenant_id, uid, 'number_release_' || new.status,
      jsonb_build_object('error', left(coalesce(new.last_error, ''), 300), 'dry_run', new.dry_run), false);
  end if;
  return null;
end $$;
drop trigger if exists number_releases_after on public.number_releases;
create trigger number_releases_after after update of status on public.number_releases
  for each row execute function private.number_releases_after();

-- ================================================================ admin (Hebrew "מנויים" tab)
-- per subscription client: the number release row and the go-live live AI check (transcript of the scripted test call)
create or replace function public.admin_subscriptions_extra() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'client_id', c.id,
      'release', (select to_jsonb(r) - 'result' || jsonb_build_object('would_release', r.result ->> 'would_release')
                    from public.number_releases r where r.client_id = c.id order by r.created_at desc limit 1),
      'golive', (select jsonb_build_object('status', j.status, 'updated_at', j.updated_at, 'passed', j.result -> 'passed',
                                           'ai_check', j.result -> 'ai_check')
                   from public.provisioning_jobs j where j.client_id = c.id and j.kind = 'golive_sim'
                  order by j.updated_at desc limit 1)))
    from public.clients c where c.billing_mode = 'subscription'), '[]'::jsonb);
end $$;

-- "Postpone": the release moves p_days later (1..180); a new warning goes out before the new date
create or replace function public.admin_postpone_number_release(p_client uuid, p_days int default 14) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.number_releases; st private.settings; warn int; rel timestamptz;
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_days is null or p_days not between 1 and 180 then raise exception 'bad_days' using errcode = 'P0001'; end if;
  select * into r from public.number_releases x where x.client_id = p_client order by x.created_at desc limit 1 for update;
  if r.id is null or r.status not in ('scheduled', 'held', 'failed') then raise exception 'no_release_scheduled' using errcode = 'P0002'; end if;
  select * into st from private.settings where id = 1;
  warn := greatest(coalesce(st.number_release_warn_days, 7), 1);
  rel := greatest(r.release_at, now()) + make_interval(days => p_days);
  update public.number_releases x set release_at = rel, warn_at = greatest(least(rel - make_interval(days => warn), rel), now()),
         warned_at = null, status = 'scheduled', force = false, attempts = 0, next_attempt_at = null, last_error = null,
         postponed_count = x.postponed_count + 1
   where x.id = r.id returning * into r;
  perform private.log_event('tenant', r.tenant_id, (select c.user_id from public.clients c where c.id = p_client),
    'number_release_postponed', jsonb_build_object('days', p_days, 'release_at', rel), false);
  return jsonb_build_object('ok', true, 'release_at', r.release_at, 'warn_at', r.warn_at);
end $$;

-- "Release now" (the UI asks first): only when the service has really ended; the runtime releases on its next tick
-- (still a dry run unless TWILIO_RELEASE_LIVE=1)
create or replace function public.admin_release_number_now(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.number_releases; w record;
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into r from public.number_releases x where x.client_id = p_client order by x.created_at desc limit 1 for update;
  if r.id is null or r.status not in ('scheduled', 'held', 'failed') then raise exception 'no_release_scheduled' using errcode = 'P0002'; end if;
  select * into w from private.number_release_window(private.client_sub(p_client), now());
  if not coalesce(w.eligible, false) then raise exception 'subscription_not_ended' using errcode = 'P0001'; end if;
  update public.number_releases x set release_at = now(), warn_at = least(x.warn_at, now()), status = 'scheduled', force = true,
         attempts = 0, next_attempt_at = null, last_error = null
   where x.id = r.id returning * into r;
  perform private.log_event('tenant', r.tenant_id, (select c.user_id from public.clients c where c.id = p_client),
    'number_release_now', '{}'::jsonb, false);
  return jsonb_build_object('ok', true, 'release_at', r.release_at);
end $$;

-- ================================================================ 3. Spanish on Pro / Business
-- The plans whose price-book features include 'spanish' (config/pricebook.json plans[].features). Codes only; the
-- runtime test test_firstring_p2.py::test_spanish_plan_list_matches_the_price_book_and_the_sql keeps both in step.
create or replace function private.plan_has_spanish(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_code in ('FR_PRO', 'FR_BUSINESS'), false)
$$;

create or replace function private.tenant_has_spanish(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select c.billing_mode = 'subscription' and private.plan_has_spanish(t.config #>> '{plan,code}')
                     from public.tenants t join public.clients c on c.id = t.client_id where t.id = p_tenant), false)
$$;

-- tenants (runs after tenants_plan_guard, which writes config.plan): voice.languages = the plan + the customer's choice.
-- Downgrade to Starter -> English only; upgrade -> Spanish on, unless the customer switched it off (voice.spanish_off).
create or replace function private.tenant_plan_spanish() returns trigger
language plpgsql security definer set search_path = '' as $$
declare want jsonb;
begin
  if (new.config -> 'plan') is null or jsonb_typeof(new.config -> 'plan') <> 'object' then return new; end if;
  if (select c.billing_mode from public.clients c where c.id = new.client_id) is distinct from 'subscription' then return new; end if;
  want := case when private.plan_has_spanish(new.config #>> '{plan,code}')
                    and not coalesce((new.config #> '{voice,spanish_off}') = 'true'::jsonb, false)
               then '["en", "es"]'::jsonb else '["en"]'::jsonb end;
  if (new.config #> '{voice,languages}') is distinct from want then
    new.config := new.config || jsonb_build_object('voice',
      (case when jsonb_typeof(new.config -> 'voice') = 'object' then new.config -> 'voice' else '{}'::jsonb end)
      || jsonb_build_object('languages', want));
  end if;
  return new;
end $$;
drop trigger if exists tenants_plan_spanish on public.tenants;
create trigger tenants_plan_spanish before insert or update on public.tenants
  for each row execute function private.tenant_plan_spanish();

-- update_tenant_settings: same function as 20261023100000_us_settings_real_estate.sql, every check kept as it was, plus ONE
-- whitelisted key: spanish (boolean) -> voice.languages + voice.spanish_off (the remembered choice). Only for plans that
-- include Spanish (spanish_not_in_plan otherwise); the key itself is never merged into the config.
create or replace function public.update_tenant_settings(p_tenant_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v jsonb;
  day text;
  mk text;   -- real_estate.meetings key
  e jsonb;
  i int;
  cfg jsonb;
  oc jsonb;
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then
    raise exception 'not_your_tenant' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch_must_be_object' using errcode = 'P0001';
  end if;
  for k, v in select key, value from jsonb_each(p_patch) loop
    if k not in ('hours', 'faq', 'notify', 'paused', 'after_hours', 'on_call_number', 'real_estate', 'spanish') then
      raise exception 'field_not_allowed: %', k using errcode = 'P0001';
    end if;

    if k = 'paused' and jsonb_typeof(v) <> 'boolean' then
      raise exception 'invalid_setting:paused' using errcode = 'P0001';
    end if;

    if k = 'spanish' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'invalid_setting:spanish' using errcode = 'P0001'; end if;
      if not private.tenant_has_spanish(p_tenant_id) then raise exception 'spanish_not_in_plan' using errcode = 'P0001'; end if;
    end if;

    if k = 'hours' then
      if jsonb_typeof(v) <> 'object' then raise exception 'invalid_setting:hours' using errcode = 'P0001'; end if;
      for day in select jsonb_object_keys(v) loop
        if day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
          raise exception 'invalid_setting:hours.%', day using errcode = 'P0001';
        end if;
        if not (jsonb_typeof(v -> day) = 'null'
                or (jsonb_typeof(v -> day) = 'array' and jsonb_array_length(v -> day) = 2
                    and jsonb_typeof(v -> day -> 0) = 'string' and jsonb_typeof(v -> day -> 1) = 'string'
                    and (v -> day ->> 0) ~ hhmm and (v -> day ->> 1) ~ hhmm
                    and (v -> day ->> 0) < (v -> day ->> 1))) then
          raise exception 'invalid_setting:hours.%', day using errcode = 'P0001';
        end if;
      end loop;
    end if;

    if k = 'faq' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 25 then
        raise exception 'invalid_setting:faq' using errcode = 'P0001';
      end if;
      for i in 0 .. jsonb_array_length(v) - 1 loop
        e := v -> i;
        if jsonb_typeof(e) <> 'object' or exists (select 1 from jsonb_object_keys(e) x where x not in ('q', 'a')) then
          raise exception 'invalid_setting:faq[%]', i using errcode = 'P0001';
        end if;
        if jsonb_typeof(e -> 'q') is distinct from 'string' or length(e ->> 'q') not between 1 and 300 then
          raise exception 'invalid_setting:faq[%].q', i using errcode = 'P0001';
        end if;
        if jsonb_typeof(e -> 'a') is distinct from 'string' or length(e ->> 'a') not between 1 and 600 then
          raise exception 'invalid_setting:faq[%].a', i using errcode = 'P0001';
        end if;
      end loop;
    end if;

    if k = 'notify' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_object_keys(v) nk where nk not in ('sms', 'email', 'daily_summary')) then
        raise exception 'invalid_setting:notify' using errcode = 'P0001';
      end if;
      if v ? 'sms' then
        if jsonb_typeof(v -> 'sms') <> 'array' or jsonb_array_length(v -> 'sms') > 5 then
          raise exception 'invalid_setting:notify.sms' using errcode = 'P0001';
        end if;
        for i in 0 .. jsonb_array_length(v -> 'sms') - 1 loop
          if not private.is_us_e164(v -> 'sms' -> i) then raise exception 'invalid_setting:notify.sms[%]', i using errcode = 'P0001'; end if;
        end loop;
      end if;
      if v ? 'email' then
        if jsonb_typeof(v -> 'email') <> 'array' or jsonb_array_length(v -> 'email') > 5 then
          raise exception 'invalid_setting:notify.email' using errcode = 'P0001';
        end if;
        for i in 0 .. jsonb_array_length(v -> 'email') - 1 loop
          if jsonb_typeof(v -> 'email' -> i) <> 'string' or (v -> 'email' ->> i) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
             or length(v -> 'email' ->> i) > 320 then
            raise exception 'invalid_setting:notify.email[%]', i using errcode = 'P0001';
          end if;
        end loop;
      end if;
      if v ? 'daily_summary' and not (jsonb_typeof(v -> 'daily_summary') = 'null'
          or (jsonb_typeof(v -> 'daily_summary') = 'string' and (v ->> 'daily_summary') ~ hhmm)) then
        raise exception 'invalid_setting:notify.daily_summary' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_array_length(case when jsonb_typeof(v -> 'sms') = 'array' then v -> 'sms' end), 0)
         + coalesce(jsonb_array_length(case when jsonb_typeof(v -> 'email') = 'array' then v -> 'email' end), 0) = 0 then
        raise exception 'invalid_setting:notify' using errcode = 'P0001';   -- needs at least one SMS number or email
      end if;
    end if;

    if k = 'after_hours' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_object_keys(v) x where x <> 'mode') then
        raise exception 'invalid_setting:after_hours' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v -> 'mode') is distinct from 'string' or (v ->> 'mode') not in ('book_next_day', 'message_only', 'emergency_dial') then
        raise exception 'invalid_setting:after_hours.mode' using errcode = 'P0001';
      end if;
    end if;

    if k = 'real_estate' then
      if jsonb_typeof(v) <> 'object' then raise exception 'invalid_setting:real_estate' using errcode = 'P0001'; end if;
      if v ? 'follow_up_boss' then raise exception 'invalid_setting:real_estate.follow_up_boss' using errcode = 'P0001'; end if;
      if exists (select 1 from jsonb_object_keys(v) x where x not in ('agent_name', 'screening', 'renters', 'meetings')) then
        raise exception 'invalid_setting:real_estate' using errcode = 'P0001';
      end if;
      if v ? 'agent_name' and (jsonb_typeof(v -> 'agent_name') <> 'string' or length(v ->> 'agent_name') > 80) then
        raise exception 'invalid_setting:real_estate.agent_name' using errcode = 'P0001';
      end if;
      if v ? 'screening' then
        if jsonb_typeof(v -> 'screening') <> 'array' or jsonb_array_length(v -> 'screening') > 8 then
          raise exception 'invalid_setting:real_estate.screening' using errcode = 'P0001';
        end if;
        for i in 0 .. jsonb_array_length(v -> 'screening') - 1 loop
          if jsonb_typeof(v -> 'screening' -> i) <> 'string'
             or (v -> 'screening' ->> i) not in ('intent', 'area', 'timeline', 'price_range', 'pre_approval', 'property_address', 'motivation', 'has_agent') then
            raise exception 'invalid_setting:real_estate.screening' using errcode = 'P0001';
          end if;
        end loop;
        if (select count(*) from jsonb_array_elements_text(v -> 'screening')) <> (select count(distinct x) from jsonb_array_elements_text(v -> 'screening') x) then
          raise exception 'invalid_setting:real_estate.screening' using errcode = 'P0001';   -- no duplicates
        end if;
      end if;
      if v ? 'renters' and jsonb_typeof(v -> 'renters') <> 'boolean' then
        raise exception 'invalid_setting:real_estate.renters' using errcode = 'P0001';
      end if;
      if v ? 'meetings' then
        if jsonb_typeof(v -> 'meetings') <> 'object' then raise exception 'invalid_setting:real_estate.meetings' using errcode = 'P0001'; end if;
        for mk in select jsonb_object_keys(v -> 'meetings') loop
          if mk not in ('buyer', 'seller', 'renter', 'showing') or jsonb_typeof(v -> 'meetings' -> mk) <> 'string'
             or length(v -> 'meetings' ->> mk) not between 1 and 80 then
            raise exception 'invalid_setting:real_estate.meetings.%', mk using errcode = 'P0001';
          end if;
        end loop;
      end if;
    end if;

    if k = 'on_call_number' and not (jsonb_typeof(v) = 'null' or private.is_us_e164(v)) then
      raise exception 'invalid_setting:on_call_number' using errcode = 'P0001';
    end if;
  end loop;

  oc := p_patch -> 'on_call_number';
  update public.tenants t
     set config = case when p_patch ? 'on_call_number' then
                    (t.config || (p_patch - 'on_call_number' - 'spanish'))
                    || jsonb_build_object(
                         'handoff', coalesce(t.config -> 'handoff', '{}'::jsonb)
                                    || jsonb_build_object('mode', case when jsonb_typeof(oc) = 'null' then 'message' else 'dial' end, 'number', oc),
                         'emergency', coalesce(t.config -> 'emergency', '{}'::jsonb) || jsonb_build_object('dial', oc))
                  else t.config || (p_patch - 'spanish') end
                  -- real_estate is merged one level deep: follow_up_boss and keys the patch leaves out are kept
                  || case when p_patch ? 'real_estate' then
                       jsonb_build_object('real_estate', coalesce(t.config -> 'real_estate', '{}'::jsonb) || (p_patch -> 'real_estate'))
                     else '{}'::jsonb end
                  -- spanish: the remembered choice + the languages (tenants_plan_spanish recomputes them from the plan)
                  || case when p_patch ? 'spanish' then
                       jsonb_build_object('voice', coalesce(t.config -> 'voice', '{}'::jsonb) || jsonb_build_object(
                         'spanish_off', not (p_patch -> 'spanish')::boolean,
                         'languages', case when (p_patch -> 'spanish')::boolean then '["en", "es"]'::jsonb else '["en"]'::jsonb end))
                     else '{}'::jsonb end
   where t.id = p_tenant_id returning t.config into cfg;
  perform private.log_event('tenant', p_tenant_id,
    (select c.user_id from public.tenants t join public.clients c on c.id = t.client_id where t.id = p_tenant_id),
    'settings_updated', jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)), true);
  return cfg;
end $$;

-- ================================================================ privileges
revoke all on function private.number_release_window(public.subscriptions, timestamptz), private.number_release_sync(uuid, timestamptz),
  private.number_release_sync_all(timestamptz), private.subscriptions_number_release(), private.number_releases_after(),
  private.plan_has_spanish(text), private.tenant_has_spanish(uuid), private.tenant_plan_spanish()
  from public, anon, authenticated;
grant execute on function private.number_release_sync(uuid, timestamptz), private.number_release_sync_all(timestamptz) to service_role;
revoke all on function public.admin_subscriptions_extra(), public.admin_postpone_number_release(uuid, int),
  public.admin_release_number_now(uuid) from public, anon;
grant execute on function public.admin_subscriptions_extra(), public.admin_postpone_number_release(uuid, int),
  public.admin_release_number_now(uuid) to authenticated;
revoke all on function public.update_tenant_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_tenant_settings(uuid, jsonb) to authenticated, service_role;
