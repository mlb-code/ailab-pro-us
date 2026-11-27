-- Call notice record (20261130100200_us_call_notice_record.sql, legal decisions 2026-11-27 item 2): the three columns exist,
-- accept what the runtime writes, refuse anything else, stay after the 90-day purge and are readable by the client through
-- the existing calls policy. One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with CALL_NOTICE_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/call_notice_record_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ca uuid; t uuid; c1 uuid; c int := 0; r record;
begin
  insert into auth.users (id, email) values (ua, 'notice-a@example.com');
  insert into public.clients (user_id, products, status) values (ua, '{RCP}', 'live') returning id into ca;
  insert into public.tenants (client_id, slug, config) values (ca, 'notice-test', '{}'::jsonb) returning id into t;
  insert into public.calls (tenant_id, call_sid, from_e164, started_at, transcript, summary, notice_version, notice_lang)
    values (t, 'CAnotice1', '+17135550123', now() - interval '100 days', '[]'::jsonb, 'x', '2026-11-27-nosms', 'en')
    returning id into c1;
  update public.calls set notice_completed_at = started_at + interval '6 seconds' where id = c1;
  insert into public.calls (tenant_id, call_sid, notice_version, notice_lang) values (t, 'CAnotice2', '2026-11-27', 'en+es');
  insert into public.calls (tenant_id, call_sid) values (t, 'CAnotice3');   -- an older runtime: no notice record
  c := c + 1;

  begin
    insert into public.calls (tenant_id, call_sid, notice_lang) values (t, 'CAnotice4', 'es');
    raise exception 'FAIL notice_lang es accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.calls (tenant_id, call_sid, notice_version) values (t, 'CAnotice5', repeat('v', 41));
    raise exception 'FAIL a 41-character notice_version accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.calls (tenant_id, call_sid, notice_version) values (t, 'CAnotice6', '');
    raise exception 'FAIL an empty notice_version accepted';
  exception when check_violation then null;
  end;
  c := c + 1;

  -- the 90-day purge clears transcript, summary and number; the notice record stays on the row
  perform private.run_retention();
  select * into r from public.calls where id = c1;
  if r.transcript is not null or r.from_e164 is not null then raise exception 'FAIL the purge did not run'; end if;
  if r.notice_version is distinct from '2026-11-27-nosms' or r.notice_lang is distinct from 'en'
     or r.notice_completed_at is distinct from r.started_at + interval '6 seconds' then
    raise exception 'FAIL the notice record did not survive the purge: %', row_to_json(r);
  end if;
  c := c + 1;

  -- the client reads its own calls' notice record (existing calls_select policy)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if (select count(*) from public.calls where notice_version is not null) <> 2 then
    raise exception 'FAIL the client does not see the notice record of its calls';
  end if;
  c := c + 1;
  perform set_config('role', 'postgres', true);

  raise exception 'CALL_NOTICE_TESTS_PASSED (% checks)', c;
end $$;
