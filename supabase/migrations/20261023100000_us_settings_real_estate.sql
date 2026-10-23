-- 2026-10-23: real-estate screening editable by the client in the portal ("My receptionist" -> Lead screening questions).
-- Redefines public.update_tenant_settings from 20261011101800_us_settings_portal_b7.sql: every existing check and the
-- on_call_number -> handoff/emergency mapping are kept byte-for-byte; ONE whitelisted key is added:
--   real_estate: {agent_name 0..80, screening (<= 8, unique, from the 8 runtime values, in the order to ask),
--                 renters boolean, meetings {buyer|seller|renter|showing -> 1..80 chars (the runtime checks job types)}}
--   The client may NOT set follow_up_boss (invalid_setting:real_estate.follow_up_boss): the CRM connection is ours.
--   Merge is one level deep for this key only (coalesce(config->'real_estate','{}') || patch->'real_estate'), so
--   follow_up_boss and any key the patch leaves out survive; other keys keep the existing `config || patch` behaviour.
-- Limits mirror runtime/app/tenant_schema.json $defs.RealEstate. Tests: supabase/tests/portal_b7_test.sql (PGlite runner).
set check_function_bodies = off;

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
    if k not in ('hours', 'faq', 'notify', 'paused', 'after_hours', 'on_call_number', 'real_estate') then
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
                    (t.config || (p_patch - 'on_call_number'))
                    || jsonb_build_object(
                         'handoff', coalesce(t.config -> 'handoff', '{}'::jsonb)
                                    || jsonb_build_object('mode', case when jsonb_typeof(oc) = 'null' then 'message' else 'dial' end, 'number', oc),
                         'emergency', coalesce(t.config -> 'emergency', '{}'::jsonb) || jsonb_build_object('dial', oc))
                  else t.config || p_patch end
                  -- real_estate is merged one level deep: follow_up_boss and keys the patch leaves out are kept
                  || case when p_patch ? 'real_estate' then
                       jsonb_build_object('real_estate', coalesce(t.config -> 'real_estate', '{}'::jsonb) || (p_patch -> 'real_estate'))
                     else '{}'::jsonb end
   where t.id = p_tenant_id returning t.config into cfg;
  perform private.log_event('tenant', p_tenant_id,
    (select c.user_id from public.tenants t join public.clients c on c.id = t.client_id where t.id = p_tenant_id),
    'settings_updated', jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)), true);
  return cfg;
end $$;

revoke all on function public.update_tenant_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_tenant_settings(uuid, jsonb) to authenticated, service_role;
