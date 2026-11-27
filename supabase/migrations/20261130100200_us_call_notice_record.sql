-- Call notice record per call (legal decisions 2026-11-27, item 2). Additive and idempotent; earlier migrations are not
-- edited. Three nullable columns on public.calls, written only by the runtime (service role):
--   notice_version       the version id of the call notice the call played (runtime guard.disclosure_version():
--                        '2026-11-27' = with the texting clause, '2026-11-27-nosms' = without it)
--   notice_lang          'en', or 'en+es' when the Spanish notice was played too (a Spanish line, ADD-ES)
--   notice_completed_at  the first moment the runtime knew the notice had finished playing: the ConversationRelay
--                        session started (Twilio opens it only after the <Say> with the notice) or the first speech turn
--                        arrived (gather, message mode, safe mode: <Say> before <Gather>). Null = the caller hung up
--                        before the notice ended (or the call predates this migration).
-- None of them is personal data; they stay on the call row, which outlives the 90-day purge of transcript, summary and
-- caller number (private.run_retention() is unchanged) and is deleted with the account, as the Privacy Policy section 7 says.
-- The runtime drops these columns from its writes while the database does not have them (app.message_mode.insert_call /
-- notice_completed), so either deploy order is safe; apply this before the runtime to keep the record from the first call.
-- Live database: add column without a default is a catalog-only change (no table rewrite); the check constraints are
-- added NOT VALID and validated (existing rows are null, so validation is instant).
-- Roll back: alter table public.calls drop column if exists notice_version, drop column if exists notice_lang,
--            drop column if exists notice_completed_at;  (the runtime keeps working without them)

alter table public.calls add column if not exists notice_version text;
alter table public.calls add column if not exists notice_lang text;
alter table public.calls add column if not exists notice_completed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.calls'::regclass and conname = 'calls_notice_version_check') then
    alter table public.calls add constraint calls_notice_version_check
      check (notice_version is null or length(notice_version) between 1 and 40) not valid;
    alter table public.calls validate constraint calls_notice_version_check;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.calls'::regclass and conname = 'calls_notice_lang_check') then
    alter table public.calls add constraint calls_notice_lang_check
      check (notice_lang is null or notice_lang in ('en', 'en+es')) not valid;
    alter table public.calls validate constraint calls_notice_lang_check;
  end if;
end $$;

comment on column public.calls.notice_version is 'Call notice version played (runtime guard.disclosure_version); legal decisions 2026-11-27 item 2';
comment on column public.calls.notice_lang is 'Languages of the call notice played: en, or en+es';
comment on column public.calls.notice_completed_at is 'First moment the runtime knew the call notice had finished (relay session start or first speech turn); null = hung up during it';
