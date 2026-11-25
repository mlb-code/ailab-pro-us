-- Questionnaires: the Business Website only for NEW questionnaires (owner decision 2026-11-25). Additive and idempotent;
-- earlier migrations are not edited.
--
-- FirstRing (RCP, BNDL, UNSURE) is sold only as a monthly plan through the plan sign-up, so a client may no longer create or
-- keep editing a FirstRing questionnaire:
--   * client INSERT: offer must be null or 'WEB'                                  -> 'offer_not_offered' (P0001)
--   * client UPDATE of a draft (incl. submitting it): the resulting offer must be null or 'WEB' (an old FirstRing draft is
--     moved to WEB by the form when it is opened, site/start/assets/q.js)
-- Untouched: every existing row stays readable (RLS unchanged); submitted / quoted / closed rows keep their offer (clients
-- cannot edit them anyway: questionnaires_guard 'questionnaire_locked'); deleting a draft; admin and service-role writes
-- (private.is_client_call() = false), so Meir and the database jobs keep working on legacy rows.
-- Trigger order: BEFORE triggers fire by name, so questionnaires_guard runs first and this check sees the final row.
set check_function_bodies = off;

create or replace function private.questionnaires_offer_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not private.is_client_call() then return new; end if;
  if tg_op = 'UPDATE' and old.status is distinct from 'draft' then return new; end if;   -- locked rows: the other guard
  if new.offer is not null and new.offer::text <> 'WEB' then
    raise exception 'offer_not_offered' using errcode = 'P0001',
      hint = 'FirstRing is a monthly plan: sign up at /start/?plan=PICK. New questionnaires are for the Business Website.';
  end if;
  return new;
end $$;
drop trigger if exists questionnaires_offer_guard on public.questionnaires;
create trigger questionnaires_offer_guard before insert or update on public.questionnaires
  for each row execute function private.questionnaires_offer_guard();

revoke all on function private.questionnaires_offer_guard() from public, anon, authenticated;
