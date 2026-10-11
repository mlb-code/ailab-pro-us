-- A6 migration checks (20261011100400_us_quote_engine.sql). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with QUOTE_ENGINE_TESTS_PASSED. Run offline: deno run -A --node-modules-dir=none supabase/tests/offline/quote_engine_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); um uuid := gen_random_uuid();
  qa uuid; quo uuid; n int; ok boolean; v jsonb;
begin
  insert into auth.users (id, email) values (ua, 'qe-client@example.com'),
    (um, (select admin_email from private.settings where id = 1));
  insert into public.questionnaires (user_id, offer, niche, status) values (ua, 'RCP', 'home_services', 'submitted') returning id into qa;

  -- service role: insert quote with Claude extras, review row, draft via RPC
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  insert into public.quotes (questionnaire_id, user_id, status, items, setup_cents, monthly_cents, deposit_cents, not_included_extra)
    values (qa, ua, 'draft', '[{"code":"RCP","qty":1}]', 350000, 30000, 175000, '["Car key programming"]') returning id into quo;
  insert into public.quote_reviews (quote_id, manual_reasons, risk_flags) values (quo, '[]', '["x"]');
  perform public.save_quote_draft(quo, 'm', 'h', '{"a":1}', 10, 0.01);
  perform public.save_quote_draft(quo, 'm2', 'h2', '{"a":2}', 20, 0.02);  -- overwrite, not duplicate
  select count(*) into n from private.quote_drafts where quote_id = quo and model = 'm2';
  if n <> 1 then raise exception 'FAIL save_quote_draft upsert'; end if;
  begin
    update public.quotes set not_included_extra = '{"a":1}' where id = quo;
    raise exception 'FAIL not_included_extra must be an array';
  exception when check_violation then null; end;

  -- client: cannot read the review panel, cannot call the draft writer, cannot write reviews
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.quote_reviews;
  if n <> 0 then raise exception 'FAIL client reads quote_reviews'; end if;
  begin
    perform public.save_quote_draft(quo, 'x', 'x', '{}');
    raise exception 'FAIL client executed save_quote_draft';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.quote_reviews (quote_id) values (quo);
    raise exception 'FAIL client inserted quote_reviews';
  exception when insufficient_privilege then null; end;

  -- anon: nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    perform 1 from public.quote_reviews;
    raise exception 'FAIL anon reads quote_reviews';
  exception when insufficient_privilege then null; end;

  -- admin reads the panel
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  select count(*) into n from public.quote_reviews where quote_id = quo;
  if n <> 1 then raise exception 'FAIL admin cannot read quote_reviews'; end if;

  -- anonymisation clears Claude extras and the review row
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  update public.quotes set anonymized = true where id = quo;
  select not_included_extra into v from public.quotes where id = quo;
  select exists (select 1 from public.quote_reviews where quote_id = quo) into ok;
  if v <> '[]'::jsonb or ok then raise exception 'FAIL anonymisation left Claude extras/review'; end if;

  raise exception 'QUOTE_ENGINE_TESTS_PASSED (9 checks)';
end $$;
