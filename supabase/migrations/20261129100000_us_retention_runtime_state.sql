-- Retention fix before the first paying customer (legal review 2026-11-27, item 2.3): the published privacy policy says
-- "Call transcripts and text message content — 90 days, then deleted automatically", but private.run_retention() only
-- cleared public.calls / public.sms_messages. The runtime also keeps every conversation in public.runtime_state
-- (key convo:<tenant>:<channel>:<id>: transcript, Claude history, the caller's name / address / number), plus a few
-- per-caller rows, and its runtime-written events carry caller details. Those rows lived until the client was deleted.
--
-- run_retention() (same as 20261012100000_us_sms_consent.sql) now also deletes, 90 days after their last write:
--   runtime_state  convo:%        conversations (transcript, collected details)                    -> 'convo_deleted'
--                  lookup:%       carrier line-type cache per number (30-day TTL in the runtime)
--                  lang:%         remembered caller language per number
--                  textback:%  safetextback:%   last text-back per number (24-hour rule)
--                  limit:%        per-number rate-limit state
--                  review:%       last review request per number (90-day rule)                     -> 'caller_state_deleted'
--   events         runtime rows that copy caller details: zapier.pending, alert.pending, zapier.dead_letter (the
--                  payload), email.outbox, sms.outbox                                               -> 'caller_events_deleted'
-- Kept on purpose: smsthread:% (a counter + timestamp per number; deleting it while an old conversation row survives
-- would reopen that conversation), jobs:% (per tenant, pending texts only), usage / spend counters, idempotency flags
-- (sent:%, once:%, zap:%: hashed keys, no content), outq:% (finished jobs are already emptied).
-- The runtime's own TTLs are shorter than 90 days for every key deleted here, so nothing the runtime still needs goes.
set check_function_bodies = off;

-- the daily purge filters on updated_at
create index if not exists runtime_state_updated_idx on public.runtime_state (updated_at);

create or replace function private.run_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_calls int; n_sms int; n_book int; n_consent int; n_convo int; n_state int; n_events int;
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
                            'caller_events_deleted', n_events,
                            'clients_anonymized', n_clients, 'client_errors', n_err);
  perform private.log_event('system', null, null, 'retention_run', res, false);
  return res;
end $$;

revoke all on function private.run_retention() from public, anon, authenticated;
grant execute on function private.run_retention() to service_role;
