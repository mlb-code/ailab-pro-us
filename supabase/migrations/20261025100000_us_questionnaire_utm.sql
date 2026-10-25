-- 2026-10-25 (launch readiness, measurement): first-touch UTM on the questionnaire.
-- The site keeps the visitor's FIRST utm_* (site/assets/measure.js, localStorage 'aplp_ft_utm', 90 days) and the portal
-- sends it once, when the questionnaire is created (site/start/assets/home.js -> Backend.createQuestionnaire).
--   * new column public.questionnaires.utm jsonb (object, < 2 KB), default {}
--   * questionnaires_guard is redefined from 20261011100000_us_schema.sql: every existing rule is kept byte-for-byte;
--     added: a CLIENT insert keeps only the whitelisted keys (utm_source, utm_medium, utm_campaign, utm_term,
--     utm_content, landing_path, first_seen) with string values, each cut to 200 characters; a CLIENT update can never
--     change utm (first touch is write-once). Admin / service role are not restricted.
-- Not sent to Claude: quote_prompt.ts sends only summary + answers.
-- Tests: supabase/tests/questionnaire_utm_test.sql (offline: supabase/tests/offline/questionnaire_utm_run.ts).
set check_function_bodies = off;

alter table public.questionnaires add column if not exists utm jsonb not null default '{}'::jsonb;
alter table public.questionnaires drop constraint if exists questionnaires_utm_check;
alter table public.questionnaires add constraint questionnaires_utm_check
  check (jsonb_typeof(utm) = 'object' and octet_length(utm::text) < 2000);

create or replace function private.questionnaires_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  v jsonb;
  clean jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    if private.is_client_call() then
      new.user_id := auth.uid();
      new.status := 'draft';
      new.submitted_at := null;
      if (select count(*) from public.questionnaires q where q.user_id = auth.uid()) >= 20 then
        raise exception 'too_many_questionnaires' using errcode = 'P0001';
      end if;
      -- first-touch UTM: whitelisted keys, string values, 200 chars max (anything else is dropped, never an error)
      if new.utm is not null and jsonb_typeof(new.utm) = 'object' then
        for k, v in select key, value from jsonb_each(new.utm) loop
          if k in ('utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing_path', 'first_seen')
             and jsonb_typeof(v) = 'string' and length(v #>> '{}') > 0 then
            clean := clean || jsonb_build_object(k, left(v #>> '{}', 200));
          end if;
        end loop;
      end if;
      new.utm := clean;
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if private.is_client_call() then
    if old.status <> 'draft' then
      raise exception 'questionnaire_locked' using errcode = 'P0001';
    end if;
    if new.status not in ('draft', 'submitted') then
      raise exception 'invalid_status' using errcode = 'P0001';
    end if;
    new.id := old.id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    new.utm := old.utm;   -- first touch is write-once for the client
  end if;
  if new.status = 'submitted' and old.status = 'draft' then
    if new.offer is null then
      raise exception 'offer_required' using errcode = 'P0001';
    end if;
    new.submitted_at := now();
  elsif new.status = 'draft' then
    new.submitted_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists questionnaires_guard on public.questionnaires;
create trigger questionnaires_guard before insert or update on public.questionnaires
  for each row execute function private.questionnaires_guard();

-- Explicit grants (unchanged scope): the new column is covered by the existing table grants; restated here so this
-- migration is self-describing. anon: nothing. RLS policies q_select/q_insert/q_update/q_delete still apply.
revoke all on public.questionnaires from anon;
grant select, insert, update, delete on public.questionnaires to authenticated;
grant all on public.questionnaires to service_role;
revoke all on function private.questionnaires_guard() from public, anon, authenticated;
