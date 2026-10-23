-- Appointment manager migrations (20261023100000/100 us_appointments*). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with APPOINTMENTS_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/appointments_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); um uuid := gen_random_uuid();
  ca uuid; cb uuid; ta uuid; tb uuid; bpast uuid; bfuture uuid; bmoved uuid; bnew uuid; bb uuid;
  j jsonb; n int; c int := 0; st text;
  cfg jsonb := '{"business":{"timezone":"America/Chicago"},"hours":{"mon":["08:00","17:00"],"tue":["08:00","17:00"],"wed":["08:00","17:00"],"thu":["08:00","17:00"],"fri":["08:00","17:00"],"sat":null,"sun":null}}';
begin
  update private.settings set admin_email = 'appt-admin@example.com' where id = 1;
  insert into auth.users (id, email) values (ua, 'appt-a@example.com'), (ub, 'appt-b@example.com'), (um, 'appt-admin@example.com');
  insert into public.clients (user_id, products, status) values (ua, '{RCP}', 'live') returning id into ca;
  insert into public.clients (user_id, products, status) values (ub, '{RCP}', 'live') returning id into cb;
  insert into public.tenants (client_id, slug, config) values (ca, 'appt-a', cfg) returning id into ta;
  insert into public.tenants (client_id, slug, config) values (cb, 'appt-b', cfg) returning id into tb;

  -- data for October 2026 (America/Chicago) and September (the month before)
  insert into public.calls (tenant_id, call_sid, from_e164, started_at, outcome, job_type, summary) values
    (ta, 'CA1', '+17135550101', '2026-10-05 15:00:00+00', 'booked', 'AC repair', 'booked'),           -- Mon 10:00 local: in hours
    (ta, 'CA2', '+17135550102', '2026-10-06 03:00:00+00', 'message', 'AC repair', 'wants a quote'),   -- Mon 22:00 local: after hours
    (ta, 'CA3', '+17135550103', '2026-10-10 16:00:00+00', 'message', 'Maintenance', 'tune-up'),       -- Saturday: after hours
    (ta, 'CA4', '+17135550104', '2026-10-07 16:00:00+00', 'message', null, 'no job type'),            -- no job type: not listed
    (ta, 'CA5', '+17135550105', '2026-10-08 16:00:00+00', 'message', 'AC repair', 'booked later'),    -- booked later: not listed
    (ta, 'CA6', '+17135550106', '2026-10-08 17:00:00+00', 'spam', 'AC repair', 'x'),
    (ta, 'CA7', '+17135550107', '2026-09-15 15:00:00+00', 'message', 'AC repair', 'september');
  insert into public.bookings (tenant_id, contact_e164, customer_name, job_type, start_at, end_at, status, created_at, confirmed_at) values
    (ta, '+17135550101', 'Mike Smith', 'AC repair', '2026-10-06 13:00:00+00', '2026-10-06 17:00:00+00', 'confirmed', '2026-10-05 15:01:00+00', '2026-10-05 20:00:00+00')
    returning id into bpast;
  insert into public.bookings (tenant_id, contact_e164, customer_name, job_type, start_at, end_at, status, created_at) values
    (ta, '+17135550105', 'Late Booker', 'AC repair', now() + interval '3 days', now() + interval '3 days 4 hours', 'confirmed', '2026-10-09 15:00:00+00')
    returning id into bfuture;
  insert into public.bookings (tenant_id, contact_e164, customer_name, job_type, start_at, end_at, status, created_at) values
    (ta, '+17135550109', 'Moved Twice', 'Maintenance', '2026-10-20 13:00:00+00', '2026-10-20 17:00:00+00', 'rescheduled', '2026-10-12 15:00:00+00')
    returning id into bmoved;
  insert into public.bookings (tenant_id, contact_e164, customer_name, job_type, start_at, end_at, status, created_at, rescheduled_from_id) values
    (ta, '+17135550109', 'Moved Twice', 'Maintenance', '2026-10-22 13:00:00+00', '2026-10-22 17:00:00+00', 'confirmed', '2026-10-13 15:00:00+00', bmoved)
    returning id into bnew;
  insert into public.bookings (tenant_id, contact_e164, customer_name, start_at, status, created_at) values
    (ta, '+17135550110', 'Cancelled', '2026-10-21 13:00:00+00', 'cancelled', '2026-10-14 15:00:00+00'),
    (ta, '+17135550111', 'September', '2026-09-21 13:00:00+00', 'confirmed', '2026-09-14 15:00:00+00');
  insert into public.bookings (tenant_id, contact_e164, customer_name, start_at, status, created_at) values
    (tb, '+17135550199', 'Other tenant', now() - interval '1 day', 'confirmed', now() - interval '2 days') returning id into bb;
  insert into public.events (actor, entity, entity_id, type, created_at) values
    ('runtime', 'tenant', ta, 'appointment.rescheduled', '2026-10-13 15:00:00+00'),
    ('runtime', 'tenant', ta, 'appointment.cancelled', '2026-10-14 15:00:00+00'),
    ('runtime', 'tenant', ta, 'appointment.confirmed', '2026-10-05 20:00:00+00'),
    ('runtime', 'tenant', tb, 'appointment.cancelled', '2026-10-14 15:00:00+00');

  -- new statuses exist; columns exist
  select count(*) into n from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'booking_status' and e.enumlabel in ('rescheduled', 'no_show');
  if n <> 2 then raise exception 'FAIL booking_status values (%)', n; end if; c := c + 1;

  -- ---------------------------------------------------------------- client A
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  j := public.client_results(ta, '2026-10');
  if (j ->> 'calls_answered')::int <> 5 then raise exception 'FAIL calls_answered %', j; end if; c := c + 1;
  if (j ->> 'after_hours_calls')::int <> 2 then raise exception 'FAIL after_hours_calls %', j; end if; c := c + 1;
  -- booked: Mike + Late Booker + the original of the moved one (replacement not double counted); cancelled excluded
  if (j ->> 'booked')::int <> 3 then raise exception 'FAIL booked %', j; end if; c := c + 1;
  if (j ->> 'messages')::int <> 4 then raise exception 'FAIL messages %', j; end if; c := c + 1;
  if (j ->> 'confirmations')::int <> 1 or (j ->> 'reschedules')::int <> 1 or (j ->> 'cancellations')::int <> 1 then
    raise exception 'FAIL appointment counts %', j; end if; c := c + 1;
  if (j -> 'previous' ->> 'month') <> '2026-09' or (j -> 'previous' ->> 'booked')::int <> 1 or (j -> 'previous' ->> 'messages')::int <> 1 then
    raise exception 'FAIL previous month %', j -> 'previous'; end if; c := c + 1;
  if jsonb_array_length(j -> 'worth_calling_back') <> 2 then raise exception 'FAIL worth_calling_back %', j -> 'worth_calling_back'; end if; c := c + 1;
  if (j -> 'worth_calling_back' -> 0 ->> 'phone') <> '+17135550103' then raise exception 'FAIL newest first %', j -> 'worth_calling_back'; end if; c := c + 1;
  if j -> 'est_value_usd' <> 'null'::jsonb then raise exception 'FAIL est value without avg %', j; end if; c := c + 1;
  -- average job value -> estimated value; range checked; stored under the runtime's key
  j := public.client_set_avg_job_value(ta, 350);
  j := public.client_results(ta, '2026-10');
  if (j ->> 'est_value_usd')::numeric <> 1050 then raise exception 'FAIL est value %', j; end if; c := c + 1;
  begin perform public.client_set_avg_job_value(ta, 0); raise exception 'FAIL avg 0 accepted';
  exception when others then if sqlerrm <> 'avg_job_value_range' then raise; end if; end; c := c + 1;
  begin perform public.client_set_avg_job_value(tb, 100); raise exception 'FAIL set B avg';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.client_results(tb, null); raise exception 'FAIL A read B results';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.client_results(ta, 'oct'); raise exception 'FAIL bad month accepted';
  exception when others then if sqlerrm <> 'bad_month' then raise; end if; end; c := c + 1;
  -- no-show: past visit only, own tenant only, undo
  j := public.client_mark_no_show(bpast, true);
  select status::text into st from public.bookings where id = bpast;
  if st <> 'no_show' then raise exception 'FAIL no_show not set (%)', st; end if; c := c + 1;
  j := public.client_results(ta, '2026-10');
  if (j ->> 'no_shows')::int <> 1 or (j ->> 'booked')::int <> 3 then raise exception 'FAIL no_show counts %', j; end if; c := c + 1;
  j := public.client_mark_no_show(bpast, false);
  select status::text into st from public.bookings where id = bpast;
  if st <> 'confirmed' then raise exception 'FAIL no_show undo (%)', st; end if; c := c + 1;
  begin perform public.client_mark_no_show(bfuture, true); raise exception 'FAIL future visit marked';
  exception when others then if sqlerrm <> 'visit_not_started' then raise; end if; end; c := c + 1;
  begin perform public.client_mark_no_show(bmoved, true); raise exception 'FAIL moved visit marked';
  exception when others then if sqlerrm <> 'bad_status' then raise; end if; end; c := c + 1;
  begin perform public.client_mark_no_show(bb, true); raise exception 'FAIL marked B booking';
  exception when insufficient_privilege then null; end; c := c + 1;
  select count(*) into n from public.events where entity_id = ta and type in ('booking_no_show', 'booking_no_show_undone') and client_visible;
  if n <> 2 then raise exception 'FAIL no-show events (%)', n; end if; c := c + 1;
  -- clients still cannot write bookings or read runtime_state directly
  begin update public.bookings set status = 'no_show' where id = bpast; get diagnostics n = row_count;
    if n > 0 then raise exception 'FAIL direct booking update'; end if;
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform 1 from public.runtime_state; raise exception 'FAIL client reads runtime_state';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform private.results_month(ta, now(), now()); raise exception 'FAIL client ran private.results_month';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- ---------------------------------------------------------------- admin: may read any tenant
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  j := public.client_results(tb, '2026-10');
  if (j ->> 'cancellations')::int <> 1 then raise exception 'FAIL admin results B %', j; end if; c := c + 1;

  -- ---------------------------------------------------------------- anon: nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform public.client_results(ta, null); raise exception 'FAIL anon ran client_results';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.client_mark_no_show(bpast, true); raise exception 'FAIL anon ran client_mark_no_show';
  exception when insufficient_privilege then null; end; c := c + 1;

  raise exception 'APPOINTMENTS_TESTS_PASSED (% checks)', c;
end $$;
