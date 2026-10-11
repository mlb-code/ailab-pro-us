-- B7 · client portal phase B (onboarding checklist, receptionist, requests, usage) + admin Tenants tab.
-- Additive only: no A1/A6 object is redefined. Idempotent (create or replace / if not exists / drop ... if exists).
--   1. requests: client may PAUSE a queued request (new column `paused`, editable through requests_guard while queued)
--      and CANCEL (= delete) a queued request (new delete policy; the cancel is logged as an event).
--   2. onboarding checklist rows are created by the DB when the deposit is marked paid (trigger on payments).
--   2b. update_tenant_settings whitelist extended (orchestrator decision 2026-10-11): + after_hours ({mode}) and
--       on_call_number (E.164 or null -> handoff.number/mode + emergency.dial). Same function, same signature.
--   3. call-forwarding test: the client starts a test (server time), the runtime logs a call to the tenant number,
--      a trigger on calls marks the `forward_calls` item done. Go-live request -> event `go_live_requested`.
--   4. usage from runtime_state (service-role-only table) through two security-definer functions:
--      admin_tenant_usage() (admins: usage + Claude/Twilio cost per tenant) and client_tenant_usage() (own tenant: usage only).
--   5. admin_save_tenant(): the admin Tenants editor's single write path (admin only, logged).
-- Tenant config written by CLIENTS still goes only through public.update_tenant_settings
-- (whitelist hours/faq/notify/paused/after_hours/on_call_number).

set check_function_bodies = off;

-- ================================================================ 1. requests: pause + cancel
alter table public.requests add column if not exists paused boolean not null default false;

drop policy if exists requests_client_cancel on public.requests;
create policy requests_client_cancel on public.requests for delete to authenticated
  using ((select private.owns_client(client_id)) and status = 'queued');

create or replace function private.request_cancel_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.is_client_call() then
    perform private.log_event('request', old.id, (select c.user_id from public.clients c where c.id = old.client_id),
      'request_cancelled', jsonb_build_object('title', left(old.title, 200)), true);
  end if;
  return old;
end $$;
drop trigger if exists requests_cancel_log on public.requests;
create trigger requests_cancel_log before delete on public.requests
  for each row execute function private.request_cancel_log();

-- ================================================================ 2. onboarding checklist seeding
-- Items per product: receptionist (RCP/BNDL) = exactly the 7 items of SPEC 6.8, in the order of the onboarding videos
-- (videos/*/script.md); the go-live request lives in the last item (data.go_live_requested_at). WEB-only: 3 items.
create or replace function private.seed_onboarding(p_client uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  prods text[];
  n int := 0;
  k int;
  rec record;
begin
  select c.products into prods from public.clients c where c.id = p_client;
  if prods is null then return 0; end if;
  for rec in
    select * from (values
      ('forward_calls', 'Turn on call forwarding',  1, true,  false),
      ('calendar',      'Connect your calendar',    2, true,  false),
      ('hours',         'Business details & hours', 3, true,  true),
      ('faq',           'FAQ',                      4, true,  false),
      ('alerts',        'Who gets alerts',          5, true,  true),
      ('tools',         'Connect other tools',      6, true,  false),
      ('sms',           'SMS registration info',    7, true,  false),
      ('web_content',   'Website content',          6, false, true)
    ) as v(key, title, sort, for_rcp, for_web)
  loop
    if (rec.for_rcp and (prods && array['RCP', 'BNDL'])) or (rec.for_web and prods = array['WEB']) then
      insert into public.onboarding_items (client_id, key, title, sort)
      values (p_client, rec.key, rec.title, rec.sort)
      on conflict (client_id, key) do nothing;
      get diagnostics k = row_count;
      n := n + k;
    end if;
  end loop;
  return n;
end $$;

create or replace function private.payments_seed_onboarding() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'deposit' and new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    perform private.seed_onboarding(new.client_id);
  end if;
  return new;
end $$;
drop trigger if exists payments_seed_onboarding on public.payments;
create trigger payments_seed_onboarding after insert or update of status on public.payments
  for each row execute function private.payments_seed_onboarding();

-- go-live request: the client stamps data.go_live_requested_at on its last checklist item (update_onboarding_item)
-- -> one event the e-mail layer (A8) turns into final_payment_due + an owner notice.
create or replace function private.onboarding_go_live_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.data ? 'go_live_requested_at') and not (coalesce(old.data, '{}'::jsonb) ? 'go_live_requested_at') then
    perform private.log_event('client', new.client_id, (select c.user_id from public.clients c where c.id = new.client_id),
      'go_live_requested', jsonb_build_object('item_id', new.id), true);
  end if;
  return new;
end $$;
drop trigger if exists onboarding_go_live_event on public.onboarding_items;
create trigger onboarding_go_live_event after update of data on public.onboarding_items
  for each row execute function private.onboarding_go_live_event();

-- ================================================================ 2b. update_tenant_settings: whitelist + after_hours, on_call_number
-- Redefinition of the A1 function (same signature, grants kept). Original checks unchanged; two keys added:
--   after_hours    {"mode": "book_next_day"|"message_only"|"emergency_dial"} (exactly that key)
--   on_call_number "+1..." (E.164, same pattern as tenant_schema.json) or null -> handoff {mode dial|message, number}
--                  and emergency.dial; the other handoff/emergency fields (hours, keywords) are kept.
create or replace function public.update_tenant_settings(p_tenant_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v jsonb;
  day text;
  cfg jsonb;
  oc jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then
    raise exception 'not_your_tenant' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch_must_be_object' using errcode = 'P0001';
  end if;
  for k, v in select key, value from jsonb_each(p_patch) loop
    if k not in ('hours', 'faq', 'notify', 'paused', 'after_hours', 'on_call_number') then
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
    if k = 'after_hours' then
      if jsonb_typeof(v) <> 'object' or (select count(*) from jsonb_object_keys(v)) <> 1 or not (v ? 'mode')
         or (v ->> 'mode') not in ('book_next_day', 'message_only', 'emergency_dial') then
        raise exception 'after_hours_bad_mode' using errcode = 'P0001';
      end if;
    end if;
    if k = 'on_call_number' then
      if not (jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\+[1-9][0-9]{7,14}$')) then
        raise exception 'on_call_number_bad' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  oc := p_patch -> 'on_call_number';
  update public.tenants t
     set config = case when p_patch ? 'on_call_number' then
                    (t.config || (p_patch - 'on_call_number'))
                    || jsonb_build_object(
                         'handoff', coalesce(t.config -> 'handoff', '{}'::jsonb)
                                    || jsonb_build_object('mode', case when jsonb_typeof(oc) = 'null' then 'message' else 'dial' end, 'number', oc),
                         'emergency', coalesce(t.config -> 'emergency', '{}'::jsonb) || jsonb_build_object('dial', oc))
                  else t.config || p_patch end
   where t.id = p_tenant_id returning t.config into cfg;
  perform private.log_event('tenant', p_tenant_id,
    (select c.user_id from public.tenants t join public.clients c on c.id = t.client_id where t.id = p_tenant_id),
    'settings_updated', jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)), true);
  return cfg;
end $$;
revoke all on function public.update_tenant_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_tenant_settings(uuid, jsonb) to authenticated, service_role;

-- ================================================================ 3. call-forwarding test
-- Client presses "Test call": the server stamps the start time (no client clock) and returns the number to call.
create or replace function public.start_forwarding_test(p_item uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  it public.onboarding_items;
  num text;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  select * into it from public.onboarding_items o where o.id = p_item;
  if not found or it.key <> 'forward_calls' or not (private.owns_client(it.client_id) or private.is_admin()) then
    raise exception 'not_your_item' using errcode = '42501';
  end if;
  select t.twilio_number into num from public.tenants t where t.client_id = it.client_id and t.twilio_number is not null
   order by t.created_at limit 1;
  if num is null then raise exception 'no_forwarding_number' using errcode = 'P0001'; end if;
  update public.onboarding_items o
     set data = o.data || jsonb_build_object('test_started_at', now(), 'test_number', num)
   where o.id = p_item;
  return jsonb_build_object('number', num, 'started_at', now(), 'window_minutes', 30);
end $$;

-- A call logged by the runtime (service role) for the tenant within 30 min of the test start marks the item done.
-- Never fails the runtime's insert (any error is swallowed).
create or replace function private.calls_forwarding_test() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  it public.onboarding_items;
begin
  begin
    select o.* into it from public.onboarding_items o join public.tenants t on t.client_id = o.client_id
     where t.id = new.tenant_id and o.key = 'forward_calls' and o.status <> 'done'
       and (o.data ->> 'test_started_at') is not null
     limit 1;
    if found and new.started_at between (it.data ->> 'test_started_at')::timestamptz - interval '1 minute'
                                     and (it.data ->> 'test_started_at')::timestamptz + interval '30 minutes' then
      update public.onboarding_items o
         set status = 'done', data = o.data || jsonb_build_object('test_call_at', new.started_at, 'test_call_id', new.id)
       where o.id = it.id;
      perform private.log_event('onboarding_item', it.id, (select c.user_id from public.clients c where c.id = it.client_id),
        'forwarding_test_passed', jsonb_build_object('call_id', new.id), true);
    end if;
  exception when others then
    null;
  end;
  return new;
end $$;
drop trigger if exists calls_forwarding_test on public.calls;
create trigger calls_forwarding_test after insert on public.calls
  for each row execute function private.calls_forwarding_test();

-- ================================================================ 4. usage from runtime_state
-- runtime keys (runtime/app/usage.py, hooks_b56.py): usage:<tenant>:<YYYY-MM>:{voice_minutes|sms_segments|owner_sms_segments|
-- needs_addon_approval}, spend:<tenant>:<YYYY-MM-DD> (Claude USD), cost:twilio:<tenant>:<YYYY-MM-DD> (Twilio USD).
-- Only these prefixes are read; conversation state, jobs and queues in runtime_state stay service-role only.
create or replace function private.rs_num(v jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case jsonb_typeof(v)
           when 'number' then (v #>> '{}')::numeric
           when 'object' then case when jsonb_typeof(v -> 'usd') = 'number' then (v ->> 'usd')::numeric end
         end
$$;

create or replace function public.admin_tenant_usage(p_month text default null)
returns table (tenant_id uuid, slug text, month text, voice_minutes numeric, sms_segments numeric, owner_sms_segments numeric,
               needs_addon_approval boolean, claude_usd numeric, twilio_usd numeric, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  m text := coalesce(nullif(p_month, ''), to_char(now() at time zone 'utc', 'YYYY-MM'));
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if m !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'bad_month' using errcode = 'P0001'; end if;
  return query
  select t.id, t.slug, m,
    coalesce(sum(private.rs_num(r.value)) filter (where r.key = 'usage:' || t.id || ':' || m || ':voice_minutes'), 0),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key = 'usage:' || t.id || ':' || m || ':sms_segments'), 0),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key = 'usage:' || t.id || ':' || m || ':owner_sms_segments'), 0),
    coalesce(bool_or(r.value = 'true'::jsonb) filter (where r.key = 'usage:' || t.id || ':' || m || ':needs_addon_approval'), false),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key like 'spend:' || t.id || ':' || m || '-%'), 0),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key like 'cost:twilio:' || t.id || ':' || m || '-%'), 0),
    max(r.updated_at)
  from public.tenants t
  left join public.runtime_state r
    on r.key like 'usage:' || t.id || ':%' or r.key like 'spend:' || t.id || ':%' or r.key like 'cost:twilio:' || t.id || ':%'
  group by t.id, t.slug
  order by t.slug;
end $$;

-- Client view of its own tenant: usage counts only (no cost), for the Billing tab.
create or replace function public.client_tenant_usage(p_tenant_id uuid, p_month text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m text := coalesce(nullif(p_month, ''), to_char(now() at time zone 'utc', 'YYYY-MM'));
  pre text := 'usage:' || p_tenant_id || ':' || m || ':';
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then raise exception 'not_your_tenant' using errcode = '42501'; end if;
  if m !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'bad_month' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'month', m,
    'voice_minutes', coalesce((select private.rs_num(r.value) from public.runtime_state r where r.key = pre || 'voice_minutes'), 0),
    'sms_segments', coalesce((select private.rs_num(r.value) from public.runtime_state r where r.key = pre || 'sms_segments'), 0),
    'needs_addon_approval', coalesce((select r.value = 'true'::jsonb from public.runtime_state r where r.key = pre || 'needs_addon_approval'), false));
end $$;

-- ================================================================ 5. admin tenant editor write path
-- The browser validates config against runtime/app/tenant_schema.json first; the runtime validates again on load.
create or replace function public.admin_save_tenant(p_id uuid, p_client_id uuid, p_slug text, p_status public.tenant_status,
                                                    p_twilio_number text, p_config jsonb)
returns public.tenants
language plpgsql security definer set search_path = '' as $$
declare
  t public.tenants;
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'config_must_be_object' using errcode = 'P0001'; end if;
  if p_id is null then
    insert into public.tenants (client_id, slug, status, twilio_number, config)
    values (p_client_id, p_slug, coalesce(p_status, 'sandbox'), nullif(p_twilio_number, ''), p_config)
    returning * into t;
  else
    update public.tenants x
       set slug = coalesce(p_slug, x.slug), status = coalesce(p_status, x.status),
           twilio_number = nullif(p_twilio_number, ''), config = p_config
     where x.id = p_id returning * into t;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  perform private.log_event('tenant', t.id, (select c.user_id from public.clients c where c.id = t.client_id),
    case when p_id is null then 'tenant_created' else 'tenant_saved' end,
    jsonb_build_object('slug', t.slug, 'status', t.status), false);
  return t;
end $$;

-- ================================================================ privileges
revoke all on function private.request_cancel_log(), private.seed_onboarding(uuid), private.payments_seed_onboarding(),
  private.onboarding_go_live_event(), private.calls_forwarding_test(), private.rs_num(jsonb) from public, anon, authenticated;
grant execute on function private.seed_onboarding(uuid), private.rs_num(jsonb) to service_role;

revoke all on function public.start_forwarding_test(uuid) from public, anon;
revoke all on function public.admin_tenant_usage(text) from public, anon;
revoke all on function public.client_tenant_usage(uuid, text) from public, anon;
revoke all on function public.admin_save_tenant(uuid, uuid, text, public.tenant_status, text, jsonb) from public, anon;
grant execute on function public.start_forwarding_test(uuid) to authenticated, service_role;
grant execute on function public.admin_tenant_usage(text) to authenticated, service_role;
grant execute on function public.client_tenant_usage(uuid, text) to authenticated, service_role;
grant execute on function public.admin_save_tenant(uuid, uuid, text, public.tenant_status, text, jsonb) to authenticated, service_role;
