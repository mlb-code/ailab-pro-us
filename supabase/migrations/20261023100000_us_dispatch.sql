-- ADD-DISPATCH (on-call dispatcher), runtime/app/dispatch.py.
--   public.dispatch_events  one row per step of an urgent call's waterfall: a leg tried (no_answer / declined /
--                           accepted, with the wait in seconds), a staff alert sent, acknowledged (pressed or replied 1),
--                           'handled' (the owner clicked Handled in the portal), 'opted_out' (a staff number texted STOP).
--                           Written by the runtime (service role) and by mark_dispatch_handled(); read by the client
--                           (own tenant) and the admin. Only the staff member's first name, never a phone number.
--   public.update_dispatch_settings(tenant, patch)  the client's on-call editor: contacts (<= 5), weekly schedule,
--                           callback minutes, daytime mode, per-contact alert opt-in (timestamped here + a
--                           sms_consent row, consent_type 'staff_alerts'). `enabled` and `sms_alerts` stay admin-only
--                           (the add-on must be bought; staff SMS waits for A2P 10DLC).
--   public.mark_dispatch_handled(tenant, call_sid)  the portal's "Handled" button: stops the repeat alert.
-- Limits match runtime/app/tenants.py (Dispatch, DispatchContact, DispatchShift). Grants are explicit (Supabase no
-- longer grants new public tables to the API roles by default from 2026-10-30). Idempotent.
set check_function_bodies = off;

create table if not exists public.dispatch_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid references public.calls(id) on delete set null,
  call_sid text check (length(call_sid) <= 64),
  leg smallint check (leg between 0 and 9),
  contact_name text check (length(contact_name) <= 60),
  result text not null check (result in ('no_answer', 'declined', 'accepted', 'alert_sent', 'acknowledged', 'handled',
                                         'opted_out')),
  wait_s integer check (wait_s between 0 and 3600),
  detail text check (length(detail) <= 80),
  at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists dispatch_events_tenant_at_idx on public.dispatch_events (tenant_id, at desc);
create index if not exists dispatch_events_tenant_call_idx on public.dispatch_events (tenant_id, call_sid);

alter table public.dispatch_events enable row level security;
revoke all on public.dispatch_events from public, anon, authenticated;
grant select on public.dispatch_events to authenticated;  -- writes: runtime (service role) and the RPC below
grant all on public.dispatch_events to service_role;

drop policy if exists dispatch_events_select on public.dispatch_events;
create policy dispatch_events_select on public.dispatch_events for select to authenticated
  using ((select private.owns_tenant(tenant_id)) or (select private.is_admin()));

-- staff on-call alert opt-ins join the consent log (5-year retention, same table as the customers' texting consent)
alter table public.sms_consent drop constraint if exists sms_consent_consent_type_check;
alter table public.sms_consent add constraint sms_consent_consent_type_check
  check (consent_type in ('text_back', 'booking_texts', 'opt_out', 'opt_in', 'staff_alerts'));

create or replace function public.update_dispatch_settings(p_tenant_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v jsonb;
  e jsonb;
  i int;
  j int;
  cur jsonb;
  prev jsonb;
  ids text[] := '{}';
  phones text[] := '{}';
  contacts jsonb := '[]'::jsonb;
  stamp text;
  cfg jsonb;
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  v_evidence constant text := 'Owner confirmed in the portal that this person agreed to receive on-call alerts';
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then
    raise exception 'not_your_tenant' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch_must_be_object' using errcode = 'P0001';
  end if;
  select coalesce(t.config -> 'dispatch', '{}'::jsonb) into cur from public.tenants t where t.id = p_tenant_id;
  if cur is null then raise exception 'not_found' using errcode = 'P0002'; end if;

  for k, v in select key, value from jsonb_each(p_patch) loop
    if k not in ('daytime_too', 'callback_minutes', 'contacts', 'schedule') then
      raise exception 'field_not_allowed: %', k using errcode = 'P0001';
    end if;
    if k = 'daytime_too' and jsonb_typeof(v) <> 'boolean' then
      raise exception 'invalid_setting:dispatch.daytime_too' using errcode = 'P0001';
    end if;
    if k = 'callback_minutes' and not (jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^[0-9]+$'
                                       and (v #>> '{}')::int between 5 and 120) then
      raise exception 'invalid_setting:dispatch.callback_minutes' using errcode = 'P0001';
    end if;
  end loop;

  if p_patch ? 'contacts' then
    v := p_patch -> 'contacts';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 5 then
      raise exception 'invalid_setting:dispatch.contacts' using errcode = 'P0001';
    end if;
    for i in 0 .. jsonb_array_length(v) - 1 loop
      e := v -> i;
      if jsonb_typeof(e) <> 'object' or exists (select 1 from jsonb_object_keys(e) x where x not in ('id', 'name', 'phone', 'role', 'opt_in')) then
        raise exception 'invalid_setting:dispatch.contacts[%]', i using errcode = 'P0001';
      end if;
      if jsonb_typeof(e -> 'id') is distinct from 'string' or (e ->> 'id') !~ '^[a-z0-9_-]{1,20}$' or (e ->> 'id') = any(ids) then
        raise exception 'invalid_setting:dispatch.contacts[%].id', i using errcode = 'P0001';
      end if;
      if jsonb_typeof(e -> 'name') is distinct from 'string' or length(btrim(e ->> 'name')) not between 1 and 60 then
        raise exception 'invalid_setting:dispatch.contacts[%].name', i using errcode = 'P0001';
      end if;
      if not private.is_us_e164(e -> 'phone') or (e ->> 'phone') = any(phones) then
        raise exception 'invalid_setting:dispatch.contacts[%].phone', i using errcode = 'P0001';
      end if;
      if e ? 'role' and (jsonb_typeof(e -> 'role') is distinct from 'string' or (e ->> 'role') not in ('tech', 'manager')) then
        raise exception 'invalid_setting:dispatch.contacts[%].role', i using errcode = 'P0001';
      end if;
      if e ? 'opt_in' and jsonb_typeof(e -> 'opt_in') <> 'boolean' then
        raise exception 'invalid_setting:dispatch.contacts[%].opt_in', i using errcode = 'P0001';
      end if;
      ids := ids || (e ->> 'id');
      phones := phones || (e ->> 'phone');
      -- the opt-in timestamp is set here, never by the browser; kept while the same number stays opted in
      select x into prev from jsonb_array_elements(coalesce(cur -> 'contacts', '[]'::jsonb)) x where x ->> 'phone' = e ->> 'phone' limit 1;
      stamp := null;
      if coalesce((e ->> 'opt_in')::boolean, false) then
        stamp := coalesce(prev ->> 'alerts_opt_in_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'));
        if prev ->> 'alerts_opt_in_at' is null then
          insert into public.sms_consent (tenant_id, contact_e164, channel, consent_type, decision, evidence, prompt_version)
          values (p_tenant_id, e ->> 'phone', 'manual', 'staff_alerts', 'yes', v_evidence, 'staff-alerts-2026-10-23');
        end if;
      elsif prev ->> 'alerts_opt_in_at' is not null then
        insert into public.sms_consent (tenant_id, contact_e164, channel, consent_type, decision, evidence, prompt_version)
        values (p_tenant_id, e ->> 'phone', 'manual', 'staff_alerts', 'revoked', 'Owner removed the on-call alert opt-in in the portal', 'staff-alerts-2026-10-23');
      end if;
      contacts := contacts || jsonb_build_object('id', e ->> 'id', 'name', btrim(e ->> 'name'), 'phone', e ->> 'phone',
                                                 'role', coalesce(e ->> 'role', 'tech'), 'alerts_opt_in_at', stamp);
    end loop;
  else
    select coalesce(array_agg(x ->> 'id'), '{}') into ids from jsonb_array_elements(coalesce(cur -> 'contacts', '[]'::jsonb)) x;
  end if;

  if p_patch ? 'schedule' then
    v := p_patch -> 'schedule';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 28 then
      raise exception 'invalid_setting:dispatch.schedule' using errcode = 'P0001';
    end if;
    for i in 0 .. jsonb_array_length(v) - 1 loop
      e := v -> i;
      if jsonb_typeof(e) <> 'object' or exists (select 1 from jsonb_object_keys(e) x where x not in ('day', 'start', 'end', 'contacts'))
         or jsonb_typeof(e -> 'day') is distinct from 'string' or (e ->> 'day') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
         or jsonb_typeof(e -> 'start') is distinct from 'string' or (e ->> 'start') !~ hhmm
         or jsonb_typeof(e -> 'end') is distinct from 'string' or (e ->> 'end') !~ hhmm
         or jsonb_typeof(e -> 'contacts') is distinct from 'array' or jsonb_array_length(e -> 'contacts') not between 1 and 5 then
        raise exception 'invalid_setting:dispatch.schedule[%]', i using errcode = 'P0001';
      end if;
      for j in 0 .. jsonb_array_length(e -> 'contacts') - 1 loop
        if jsonb_typeof(e -> 'contacts' -> j) is distinct from 'string' or not ((e -> 'contacts' ->> j) = any(ids)) then
          raise exception 'invalid_setting:dispatch.schedule[%].contacts', i using errcode = 'P0001';
        end if;
      end loop;
    end loop;
  elsif p_patch ? 'contacts' then  -- contacts changed without a new schedule: every reference must still exist
    if exists (select 1 from jsonb_array_elements(coalesce(cur -> 'schedule', '[]'::jsonb)) s,
                             jsonb_array_elements_text(s -> 'contacts') r where not (r = any(ids))) then
      raise exception 'invalid_setting:dispatch.schedule' using errcode = 'P0001';
    end if;
  end if;

  cfg := cur || (p_patch - 'contacts') || case when p_patch ? 'contacts' then jsonb_build_object('contacts', contacts) else '{}'::jsonb end;
  if coalesce((cfg ->> 'enabled')::boolean, false) and jsonb_array_length(coalesce(cfg -> 'contacts', '[]'::jsonb)) = 0 then
    raise exception 'invalid_setting:dispatch.contacts' using errcode = 'P0001';  -- the runtime needs someone to call
  end if;
  update public.tenants t set config = t.config || jsonb_build_object('dispatch', cfg)
   where t.id = p_tenant_id returning t.config into cfg;
  perform private.log_event('tenant', p_tenant_id,
    (select c.user_id from public.tenants t join public.clients c on c.id = t.client_id where t.id = p_tenant_id),
    'settings_updated', jsonb_build_object('fields', jsonb_build_array('dispatch')), true);
  return cfg -> 'dispatch';
end $$;

create or replace function public.mark_dispatch_handled(p_tenant_id uuid, p_call_sid text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then
    raise exception 'not_your_tenant' using errcode = '42501';
  end if;
  if not exists (select 1 from public.dispatch_events d where d.tenant_id = p_tenant_id and d.call_sid = p_call_sid) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.dispatch_events d where d.tenant_id = p_tenant_id and d.call_sid = p_call_sid
             and d.result = 'handled') then
    return;
  end if;
  insert into public.dispatch_events (tenant_id, call_id, call_sid, result, contact_name, detail)
  select p_tenant_id, (select d.call_id from public.dispatch_events d where d.tenant_id = p_tenant_id
                       and d.call_sid = p_call_sid and d.call_id is not null limit 1),
         p_call_sid, 'handled', 'Owner', 'portal';
end $$;

revoke all on function public.update_dispatch_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_dispatch_settings(uuid, jsonb) to authenticated, service_role;
revoke all on function public.mark_dispatch_handled(uuid, text) from public, anon;
grant execute on function public.mark_dispatch_handled(uuid, text) to authenticated, service_role;
