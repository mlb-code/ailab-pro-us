-- First-touch UTM on questionnaires (20261025100000_us_questionnaire_utm.sql). One DO block; ALWAYS ends with an error so
-- it rolls back. Success = message starts with UTM_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/questionnaire_utm_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); um uuid := gen_random_uuid();
  qa uuid; qb uuid; j jsonb; n int; c int := 0;
begin
  update private.settings set admin_email = 'utm-admin@example.com' where id = 1;
  insert into auth.users (id, email) values (ua, 'utm-a@example.com'), (ub, 'utm-b@example.com'), (um, 'utm-admin@example.com');

  -- ---------------------------------------------------------------- client A creates a questionnaire with first-touch UTM
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  insert into public.questionnaires (offer, niche, utm) values ('RCP', 'home_services',
    jsonb_build_object('utm_source', 'facebook', 'utm_medium', 'paid', 'utm_campaign', repeat('x', 300),
                       'landing_path', '/real-estate/', 'first_seen', '2026-10-25T10:00:00Z',
                       'evil', 'drop me', 'utm_term', 42, 'utm_content', ''))
    returning id, utm into qa, j;
  if j ->> 'utm_source' <> 'facebook' or j ->> 'utm_medium' <> 'paid' then raise exception 'FAIL utm kept %', j; end if; c := c + 1;
  if length(j ->> 'utm_campaign') <> 200 then raise exception 'FAIL utm value not cut to 200'; end if; c := c + 1;
  if j ? 'evil' then raise exception 'FAIL unknown key kept'; end if; c := c + 1;
  if j ? 'utm_term' then raise exception 'FAIL non-string value kept'; end if; c := c + 1;
  if j ? 'utm_content' then raise exception 'FAIL empty value kept'; end if; c := c + 1;
  if j ->> 'landing_path' <> '/real-estate/' or j ->> 'first_seen' is null then raise exception 'FAIL landing/first_seen %', j; end if; c := c + 1;

  -- write-once: the client cannot change it later (silently kept), other edits still work
  update public.questionnaires set utm = '{"utm_source":"hacked"}', answers = '{"a":1}' where id = qa;
  select utm into j from public.questionnaires where id = qa;
  if j ->> 'utm_source' <> 'facebook' then raise exception 'FAIL client changed utm'; end if; c := c + 1;
  select count(*) into n from public.questionnaires where id = qa and answers ->> 'a' = '1';
  if n <> 1 then raise exception 'FAIL normal update blocked'; end if; c := c + 1;

  -- no utm = empty object; a non-object utm is refused by the check, not stored
  insert into public.questionnaires (offer, niche) values ('WEB', 'home_services') returning utm into j;
  if j <> '{}'::jsonb then raise exception 'FAIL default utm %', j; end if; c := c + 1;
  insert into public.questionnaires (offer, niche, utm) values ('WEB', 'home_services', '["x"]') returning utm into j;
  if j <> '{}'::jsonb then raise exception 'FAIL array utm stored %', j; end if; c := c + 1;

  -- ---------------------------------------------------------------- client B cannot see A's utm
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.questionnaires where id = qa;
  if n <> 0 then raise exception 'FAIL B sees A questionnaire'; end if; c := c + 1;

  -- ---------------------------------------------------------------- admin reads it (reporting) and may correct it
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  select utm into j from public.questionnaires where id = qa;
  if j ->> 'utm_source' <> 'facebook' then raise exception 'FAIL admin cannot read utm'; end if; c := c + 1;

  -- ---------------------------------------------------------------- anon: nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    perform utm from public.questionnaires limit 1;
    raise exception 'FAIL anon read questionnaires';
  exception when insufficient_privilege then null; end; c := c + 1;

  raise exception 'UTM_TESTS_PASSED (% checks)', c;
end $$;
