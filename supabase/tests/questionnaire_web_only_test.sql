-- New questionnaires are for the Business Website only (20261127200000_us_questionnaire_web_only.sql); legacy FirstRing rows
-- stay readable and Meir / the service role keep working on them. One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with WEB_ONLY_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/questionnaire_web_only_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); um uuid := gen_random_uuid();
  q1 uuid; q2 uuid; old_draft uuid; old_draft2 uuid; old_sent uuid; c int := 0; n int; o text; s text;
begin
  insert into auth.users (id, email) values (ua, 'webonly-a@example.com'), (um, 'webonly-admin@example.com');
  update public.profiles set is_admin = true where id = um;
  -- legacy rows written before 2026-11-25 (as the old form saved them): an open FirstRing draft, another one, a sent one
  insert into public.questionnaires (user_id, offer, niche, answers) values (ua, 'RCP', 'home_services', '{"offer":"RCP","locations":"1"}') returning id into old_draft;
  insert into public.questionnaires (user_id, offer, niche) values (ua, 'BNDL', 'real_estate') returning id into old_draft2;
  insert into public.questionnaires (user_id, offer, niche) values (ua, 'RCP', 'home_services') returning id into old_sent;
  update public.questionnaires set status = 'submitted' where id = old_sent;

  -- ================================================================ the client
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  insert into public.questionnaires (offer, niche) values ('WEB', 'home_services') returning id into q1;
  insert into public.questionnaires (niche) values ('real_estate') returning id into q2;   -- no offer yet: the form preselects WEB
  if q1 is null or q2 is null then raise exception 'FAIL website questionnaire refused'; end if; c := c + 1;
  foreach s in array array['RCP', 'BNDL', 'UNSURE'] loop
    begin
      execute format('insert into public.questionnaires (offer, niche) values (%L, %L)', s, 'home_services');
      raise exception 'FAIL new % questionnaire accepted', s;
    exception when sqlstate 'P0001' then
      if sqlerrm is distinct from 'offer_not_offered' then raise exception 'FAIL % insert: %', s, sqlerrm; end if;
    end;
  end loop; c := c + 1;
  begin update public.questionnaires set offer = 'RCP' where id = q2; raise exception 'FAIL website draft switched to RCP';
  exception when sqlstate 'P0001' then if sqlerrm is distinct from 'offer_not_offered' then raise exception 'FAIL switch: %', sqlerrm; end if; end; c := c + 1;
  -- legacy rows: readable; an old FirstRing draft can't be edited or sent as FirstRing, only moved to the website or deleted
  select count(*) into n from public.questionnaires where id in (old_draft, old_draft2, old_sent);
  if n <> 3 then raise exception 'FAIL legacy rows not readable (%)', n; end if; c := c + 1;
  if (select offer::text from public.questionnaires where id = old_sent) is distinct from 'RCP' then raise exception 'FAIL sent row changed'; end if;
  begin update public.questionnaires set answers = '{"offer":"RCP","locations":"2"}' where id = old_draft; raise exception 'FAIL old FirstRing draft edited as FirstRing';
  exception when sqlstate 'P0001' then if sqlerrm is distinct from 'offer_not_offered' then raise exception 'FAIL edit: %', sqlerrm; end if; end; c := c + 1;
  begin update public.questionnaires set status = 'submitted' where id = old_draft; raise exception 'FAIL old FirstRing draft sent';
  exception when sqlstate 'P0001' then if sqlerrm is distinct from 'offer_not_offered' then raise exception 'FAIL submit: %', sqlerrm; end if; end; c := c + 1;
  update public.questionnaires set offer = 'WEB', answers = '{"offer":"WEB"}' where id = old_draft;   -- what q.js does on opening
  update public.questionnaires set status = 'submitted' where id = old_draft;
  select offer::text into o from public.questionnaires where id = old_draft;
  if o is distinct from 'WEB' or (select status from public.questionnaires where id = old_draft) is distinct from 'submitted' then
    raise exception 'FAIL moved draft not sent as WEB (%)', o; end if; c := c + 1;
  delete from public.questionnaires where id = old_draft2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL old FirstRing draft not deletable'; end if; c := c + 1;
  begin
    update public.questionnaires set answers = '{"x":1}' where id = old_sent;   -- RLS (drafts only) or questionnaires_guard
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL sent row edited'; end if;
  exception when sqlstate 'P0001' then if sqlerrm is distinct from 'questionnaire_locked' then raise exception 'FAIL locked: %', sqlerrm; end if; end;
  if (select offer::text from public.questionnaires where id = old_sent) is distinct from 'RCP' then raise exception 'FAIL sent row lost its offer'; end if; c := c + 1;

  -- ================================================================ Meir (admin) and the service role keep working on legacy rows
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  update public.questionnaires set status = 'quoted' where id = old_sent;
  if (select status from public.questionnaires where id = old_sent) is distinct from 'quoted' then raise exception 'FAIL admin update'; end if; c := c + 1;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  insert into public.questionnaires (user_id, offer, niche) values (ua, 'RCP', 'home_services') returning id into q2;
  if q2 is null then raise exception 'FAIL service role blocked'; end if; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  raise exception 'WEB_ONLY_TESTS_PASSED (% checks)', c;
end $$;
