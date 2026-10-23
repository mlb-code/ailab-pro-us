-- 23.10.2026 appointment manager + Results panel (runtime/app/appointments.py, site/start/assets/portal-results.js).
-- No new tables. New columns are written by the runtime (service role) only; clients read them through the existing
-- RLS select policies on bookings / calls, and change exactly one thing (no-show) through a checked RPC.
-- Explicit grants on every function (Supabase 2026-10-30: no default privileges on new objects in public).
set check_function_bodies = off;

alter table public.bookings add column if not exists confirmed_at timestamptz;
alter table public.bookings add column if not exists rescheduled_from_id uuid references public.bookings(id) on delete set null;
alter table public.calls add column if not exists known_caller boolean;
alter table public.calls add column if not exists job_type text check (length(job_type) <= 200);
create index if not exists bookings_tenant_contact_idx on public.bookings (tenant_id, contact_e164);
create index if not exists calls_tenant_from_idx on public.calls (tenant_id, from_e164);

-- ------------------------------------------------------------------ no-show (client or admin)
-- Only a visit that has started; only between 'confirmed' and 'no_show' (undo allowed).
create or replace function public.client_mark_no_show(p_booking_id uuid, p_no_show boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  select * into b from public.bookings x where x.id = p_booking_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not (private.owns_tenant(b.tenant_id) or private.is_admin()) then raise exception 'not_your_tenant' using errcode = '42501'; end if;
  if coalesce(p_no_show, true) then
    if b.status::text <> 'confirmed' then raise exception 'bad_status' using errcode = 'P0001'; end if;
    if b.start_at is null or b.start_at > now() then raise exception 'visit_not_started' using errcode = 'P0001'; end if;
    update public.bookings x set status = 'no_show'::public.booking_status where x.id = b.id;
  else
    if b.status::text <> 'no_show' then raise exception 'bad_status' using errcode = 'P0001'; end if;
    update public.bookings x set status = 'confirmed'::public.booking_status where x.id = b.id;
  end if;
  perform private.log_event('tenant', b.tenant_id, (select auth.uid()),
    case when coalesce(p_no_show, true) then 'booking_no_show' else 'booking_no_show_undone' end,
    jsonb_build_object('booking_id', b.id), true);
  return jsonb_build_object('id', b.id, 'status', case when coalesce(p_no_show, true) then 'no_show' else 'confirmed' end);
end $$;

-- ------------------------------------------------------------------ average job value (for "estimated value")
-- Same runtime_state key the runtime's reports read (reports.avg_job_value_key): roi:<tenant>:avg_job_value_usd.
create or replace function public.client_set_avg_job_value(p_tenant_id uuid, p_value numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := 'roi:' || p_tenant_id || ':avg_job_value_usd';
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then raise exception 'not_your_tenant' using errcode = '42501'; end if;
  if p_value is not null and not (p_value > 0 and p_value <= 100000) then raise exception 'avg_job_value_range' using errcode = 'P0001'; end if;
  if p_value is null then
    delete from public.runtime_state r where r.key = k;
  else
    insert into public.runtime_state (key, tenant_id, value, updated_at) values (k, p_tenant_id, to_jsonb(round(p_value, 2)), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  perform private.log_event('tenant', p_tenant_id, (select auth.uid()), 'avg_job_value_set', jsonb_build_object('usd', p_value), true);
  return jsonb_build_object('avg_job_value_usd', p_value);
end $$;

-- ------------------------------------------------------------------ Results panel
-- Same numbers as runtime/app/reports.py results_data (activity + appointment_counts + worth_calling_back), for one
-- local month of the tenant and the month before. "Answered" = booked/message/handoff/emergency; after hours = outside
-- the tenant's opening hours in its own time zone; booked = bookings made in the month (cancelled excluded, a moved
-- booking counted once); worth calling back = calls that ended with a message, have a job type, and no booking from
-- the same number since (newest first, one per number, 10 at most).
create or replace function private.results_month(p_tenant uuid, p_start timestamptz, p_end timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select x.config, coalesce(x.config #>> '{business,timezone}', 'UTC') as tz from public.tenants x where x.id = p_tenant
  ), c as (
    select k.*, (k.started_at at time zone (select tz from t)) as local_at
    from public.calls k where k.tenant_id = p_tenant and k.started_at >= p_start and k.started_at < p_end
  ), ans as (
    select c.*, (select t.config -> 'hours' -> ((array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from c.local_at)::int]) from t) as span
    from c where c.outcome in ('booked', 'message', 'handoff', 'emergency')
  ), b as (
    select k.* from public.bookings k where k.tenant_id = p_tenant
  ), ev as (
    select e.type from public.events e where e.entity = 'tenant' and e.entity_id = p_tenant
      and e.type like 'appointment.%' and e.created_at >= p_start and e.created_at < p_end
  )
  select jsonb_build_object(
    'calls_answered', (select count(*) from ans),
    'after_hours_calls', (select count(*) from ans where ans.span is null or jsonb_typeof(ans.span) <> 'array'
                            or ans.local_at::time < (ans.span ->> 0)::time or ans.local_at::time >= (ans.span ->> 1)::time),
    'booked', (select count(*) from b where b.created_at >= p_start and b.created_at < p_end and b.rescheduled_from_id is null
                 and b.status::text in ('confirmed', 'completed', 'rescheduled', 'no_show')),
    'messages', (select count(*) from c where c.outcome in ('message', 'handoff')),
    'confirmations', (select count(*) from b where b.confirmed_at >= p_start and b.confirmed_at < p_end),
    'reschedules', (select count(*) from ev where ev.type = 'appointment.rescheduled'),
    'cancellations', (select count(*) from ev where ev.type = 'appointment.cancelled'),
    'no_shows', (select count(*) from b where b.status::text = 'no_show' and b.start_at >= p_start and b.start_at < p_end))
$$;

create or replace function public.client_results(p_tenant_id uuid, p_month text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  m text;
  s timestamptz; e timestamptz; ps timestamptz;
  cur jsonb; prev jsonb; avg numeric; back jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not (private.owns_tenant(p_tenant_id) or private.is_admin()) then raise exception 'not_your_tenant' using errcode = '42501'; end if;
  select coalesce(x.config #>> '{business,timezone}', 'UTC') into tz from public.tenants x where x.id = p_tenant_id;
  if tz is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  m := coalesce(nullif(p_month, ''), to_char(now() at time zone tz, 'YYYY-MM'));
  if m !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'bad_month' using errcode = 'P0001'; end if;
  s := (m || '-01')::timestamp at time zone tz;
  e := ((m || '-01')::date + interval '1 month')::timestamp at time zone tz;
  ps := ((m || '-01')::date - interval '1 month')::timestamp at time zone tz;
  cur := private.results_month(p_tenant_id, s, e);
  prev := private.results_month(p_tenant_id, ps, s);
  select private.rs_num(r.value) into avg from public.runtime_state r where r.key = 'roi:' || p_tenant_id || ':avg_job_value_usd';
  select coalesce(jsonb_agg(jsonb_build_object('at', q.started_at, 'phone', q.from_e164, 'job_type', q.job_type,
                                              'summary', left(coalesce(q.summary, ''), 200)) order by q.started_at desc), '[]'::jsonb)
    into back
  from (
    select z.* from (
      select distinct on (k.from_e164) k.started_at, k.from_e164, k.job_type, k.summary
      from public.calls k
      where k.tenant_id = p_tenant_id and k.started_at >= s and k.started_at < e and k.outcome = 'message'
        and coalesce(k.job_type, '') <> '' and coalesce(k.from_e164, '') <> ''
      order by k.from_e164, k.started_at desc
    ) z
    where not exists (select 1 from public.bookings b where b.tenant_id = p_tenant_id and b.contact_e164 = z.from_e164
                      and b.created_at > z.started_at)
    order by z.started_at desc
    limit 10
  ) q;
  return cur || jsonb_build_object(
    'month', m, 'previous', prev || jsonb_build_object('month', to_char(ps at time zone tz, 'YYYY-MM')),
    'avg_job_value_usd', avg,
    'est_value_usd', case when avg is null then null else round((cur ->> 'booked')::numeric * avg, 2) end,
    'worth_calling_back', back);
end $$;

-- ------------------------------------------------------------------ privileges (explicit, 2026-10-30 change)
revoke all on function private.results_month(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function private.results_month(uuid, timestamptz, timestamptz) to service_role;
revoke all on function public.client_mark_no_show(uuid, boolean) from public, anon;
revoke all on function public.client_set_avg_job_value(uuid, numeric) from public, anon;
revoke all on function public.client_results(uuid, text) from public, anon;
grant execute on function public.client_mark_no_show(uuid, boolean) to authenticated, service_role;
grant execute on function public.client_set_avg_job_value(uuid, numeric) to authenticated, service_role;
grant execute on function public.client_results(uuid, text) to authenticated, service_role;
