-- B7 fix for the B12 gate (docs/reports/B12.md #1): update_tenant_settings validates exactly what the runtime accepts.
-- Limits come from runtime/app/tenant_schema.json (generated from runtime/app/tenants.py) and its pydantic-only rules:
--   faq: maxItems 25; item {q: 1..300, a: 1..600}, no other keys            ($defs.FaqItem, properties.faq)
--   hours.<day>: null | ["HH:MM","HH:MM"], pattern ^([01]\d|2[0-3]):[0-5]\d$, open < close (tenants.py _check_span)
--   notify: {sms[] <= 5 E.164, email[] <= 5 ^[^@\s]+@[^@\s]+\.[^@\s]+$, daily_summary HH:MM|null}, >= 1 sms or email (Notify._someone)
--   after_hours: {mode in book_next_day|message_only|emergency_dial}       ($defs.AfterHours)
--   phone numbers: schema E.164 ^\+[1-9]\d{7,14}$ AND US (+1 + 10 digits, NANP area code) — the product is US-only.
-- Every violation raises 'invalid_setting:<path>' (e.g. invalid_setting:faq[3].a); unknown keys stay 'field_not_allowed: <key>'.
-- supabase/tests/portal_b7_test.sql reads the schema limits from the JSON file (runner) and tests the boundaries.
set check_function_bodies = off;

create or replace function private.is_us_e164(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\+[1-9][0-9]{7,14}$' and (v #>> '{}') ~ '^\+1[2-9][0-9]{9}$'
$$;

create or replace function public.update_tenant_settings(p_tenant_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v jsonb;
  day text;
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
    if k not in ('hours', 'faq', 'notify', 'paused', 'after_hours', 'on_call_number') then
      raise exception 'field_not_allowed: %', k using errcode = 'P0001';
    end if;

    if k = 'paused' and jsonb_typeof(v) <> 'boolean' then
      raise exception 'invalid_setting:paused' using errcode = 'P0001';
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

    if k = 'on_call_number' and not (jsonb_typeof(v) = 'null' or private.is_us_e164(v)) then
      raise exception 'invalid_setting:on_call_number' using errcode = 'P0001';
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

revoke all on function private.is_us_e164(jsonb) from public, anon, authenticated;
grant execute on function private.is_us_e164(jsonb) to service_role;
revoke all on function public.update_tenant_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_tenant_settings(uuid, jsonb) to authenticated, service_role;
