-- Sign-up consent records and the event log get an explicit retention (legal review 2026-11-27, subscription item 9 and
-- privacy item 3.4). Additive and idempotent; earlier migrations are not edited.
--
-- Sign-up consent: public.billing_checkouts (20261126100000_us_paddle.sql) holds what the person agreed to at sign-up: the
-- exact consent sentence, the agreement version, the time, the browser (user agent), the plan, trial or not, the business
-- phone and, once Paddle confirms, the subscription id. No IP address is stored. Its user_id referenced public.profiles ON
-- DELETE CASCADE, and private.anonymize_client() deletes the auth user (-> profile) 30 days after a cancelled client ended,
-- so the record could vanish long before California's automatic-renewal rule (keep it 3 years, or 1 year after the plan
-- ends, whichever is later). Now:
--   * user_id is nullable and the foreign key is ON DELETE SET NULL: deleting the account keeps the record (no name or
--     e-mail in it; the business is still known through the subscription row, which is never deleted);
--   * private.run_retention() (same as 20261129100000_us_retention_runtime_state.sql, plus two steps) deletes a record
--     7 years after sign-up, and not before 1 year after the plan started from it has ended (later of the two: covers
--     the 3-year / 1-year rule and the 7-year contract-record line of the privacy policy).
-- Event log: public.events had no age limit (only the caller-detail copies went after 90 days). run_retention() now also
-- deletes events older than 7 years. Readers: the monthly report and the portal's Results tab read one month at a time,
-- the admin log the latest 300 rows; no idempotency check reads events. Billing evidence lives in subscriptions, payments,
-- private.paddle_transactions and the consent records above.
-- Live database: billing_checkouts is a small table (one row per sign-up press); the foreign key is added NOT VALID and then
-- validated (no long lock), nothing is deleted today (no row is 7 years old). Roll back: re-run run_retention() from
-- 20261129100000_us_retention_runtime_state.sql; to restore the cascade, drop constraint billing_checkouts_user_keep_fkey and
-- add the original "foreign key (user_id) references public.profiles(id) on delete cascade" (first delete rows whose
-- user_id is null, or keep the column nullable).
set check_function_bodies = off;

-- ================================================================ keep the sign-up consent when the account is deleted
alter table public.billing_checkouts alter column user_id drop not null;
do $$
declare con text;
begin
  -- the original foreign key (any name): user_id -> profiles, ON DELETE CASCADE
  for con in select c.conname from pg_catalog.pg_constraint c
              where c.conrelid = 'public.billing_checkouts'::regclass and c.contype = 'f'
                and c.confrelid = 'public.profiles'::regclass and c.confdeltype = 'c' loop
    execute format('alter table public.billing_checkouts drop constraint %I', con);
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.billing_checkouts'::regclass and c.conname = 'billing_checkouts_user_keep_fkey') then
    alter table public.billing_checkouts add constraint billing_checkouts_user_keep_fkey
      foreign key (user_id) references public.profiles(id) on delete set null not valid;
  end if;
end $$;
alter table public.billing_checkouts validate constraint billing_checkouts_user_keep_fkey;

-- ================================================================ daily retention job
create or replace function private.run_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_calls int; n_sms int; n_book int; n_consent int; n_convo int; n_state int; n_events int; n_signup int; n_old_events int;
  n_clients int := 0; n_err int := 0; cid uuid; res jsonb;
begin
  -- transcripts, summaries and caller numbers are personal data: cleared after 90 days
  -- (row kept: outcome, duration, cost — no number hash, a hashed US phone number is trivially reversible)
  update public.calls set transcript = null, summary = null, from_e164 = null
   where started_at < now() - interval '90 days' and (transcript is not null or summary is not null or from_e164 is not null);
  get diagnostics n_calls = row_count;

  delete from public.sms_messages where created_at < now() - interval '90 days';
  get diagnostics n_sms = row_count;

  -- the runtime's copy of every call / text / chat conversation (transcript + collected details): 90 days like the
  -- transcripts above (runtime/app/conversation.py, key convo:<tenant>:<channel>:<id>)
  delete from public.runtime_state where key like 'convo:%' and updated_at < now() - interval '90 days';
  get diagnostics n_convo = row_count;

  -- per-caller runtime state (keyed by a hash of the number), unused once older than the runtime's own TTLs
  delete from public.runtime_state
   where (key like 'lookup:%' or key like 'lang:%' or key like 'textback:%' or key like 'safetextback:%'
          or key like 'limit:%' or key like 'review:%')
     and updated_at < now() - interval '90 days';
  get diagnostics n_state = row_count;

  -- runtime event rows that copy caller details (webhook payloads, alert summaries, outbox copies of e-mails / texts)
  delete from public.events
   where actor = 'runtime' and type in ('zapier.pending', 'alert.pending', 'zapier.dead_letter', 'email.outbox', 'sms.outbox')
     and created_at < now() - interval '90 days';
  get diagnostics n_events = row_count;

  delete from public.bookings where coalesce(end_at, start_at, created_at) < now() - interval '2 years';
  get diagnostics n_book = row_count;

  -- consent log (SA §8 item 7): kept 5 years, NOT with the 90-day transcripts/SMS, and it survives the client's
  -- anonymisation (no FK to tenants, so deleting the tenant does not cascade here)
  delete from public.sms_consent where created_at < now() - interval '5 years';
  get diagnostics n_consent = row_count;

  -- sign-up agreement records (public.billing_checkouts: the consent wording, agreement version, time, browser, business
  -- phone): 7 years after sign-up, and in any case until 1 year after the plan started from it has ended. They survive the
  -- deletion of the account (user_id is set null, 20261130100100), like the texting consent log above.
  delete from public.billing_checkouts b
   where b.created_at < now() - interval '7 years'
     and not exists (select 1 from public.subscriptions s
                      where b.provider_subscription_id is not null and s.provider_subscription_id = b.provider_subscription_id
                        and (s.status <> 'canceled' or coalesce(s.ends_at, s.canceled_at, now()) > now() - interval '1 year'));
  get diagnostics n_signup = row_count;

  -- the service event log (status changes, billing and cancellation events, delivery results; caller-detail copies are
  -- deleted after 90 days above): 7 years at most, like invoices. Nothing reads events that old (reports read one month,
  -- the admin log the latest rows).
  delete from public.events where created_at < now() - interval '7 years';
  get diagnostics n_old_events = row_count;

  for cid in select c.id from public.clients c
              where c.status = 'cancelled' and c.anonymized_at is null and c.ended_at < now() - interval '30 days' loop
    begin
      perform private.anonymize_client(cid);
      n_clients := n_clients + 1;
    exception when others then
      n_err := n_err + 1;
      perform private.log_event('client', cid, null, 'retention_error',
        jsonb_build_object('client_id', cid, 'error', sqlerrm, 'sqlstate', sqlstate), false);
    end;
  end loop;

  res := jsonb_build_object('calls_cleared', n_calls, 'sms_deleted', n_sms, 'bookings_deleted', n_book,
                            'consent_deleted', n_consent, 'convo_deleted', n_convo, 'caller_state_deleted', n_state,
                            'caller_events_deleted', n_events, 'signup_consent_deleted', n_signup,
                            'old_events_deleted', n_old_events,
                            'clients_anonymized', n_clients, 'client_errors', n_err);
  perform private.log_event('system', null, null, 'retention_run', res, false);
  return res;
end $$;


revoke all on function private.run_retention() from public, anon, authenticated;
grant execute on function private.run_retention() to service_role;
