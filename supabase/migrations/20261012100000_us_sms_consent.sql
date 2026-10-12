-- Legal v1.1 (2026-10-12): texting-consent log + "transcript withheld" flag (docs/reports/legal-residual/02-tcpa-recording.md,
-- Service Agreement §8 items 3b, 4, 7; Privacy §3.2, §7).
--   public.sms_consent  one row per texting-consent answer at booking (yes / no / unclear / no_answer), opt-out (revoked:
--                       STOP words, a sentence, or spoken on a call), opt-in, and missed-call text (notice). Written only by
--                       the runtime (service role, runtime/app/store.py TenantStore.record_consent). Kept 5 years (TCPA 4-year
--                       limitation + margin) by private.run_retention(), NOT purged with the 90-day transcripts, and NOT
--                       deleted when a client is anonymised: tenant_id has no foreign key on purpose (the log is evidence
--                       after the tenant row is gone). Evidence = a short snippet (<= 300 chars), never a transcript.
--   public.calls.transcript_withheld  the caller objected to recording: the runtime keeps only the greeting (proof of the
--                       notice) and a marker, never the caller's words.
-- Idempotent (safe to re-run).

set check_function_bodies = off;

create table if not exists public.sms_consent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,  -- no FK: survives tenant deletion / client anonymisation (5-year evidence)
  contact_e164 text not null check (length(contact_e164) <= 20),
  channel text not null check (channel in ('voice', 'sms', 'carrier', 'manual')),
  consent_type text not null check (consent_type in ('text_back', 'booking_texts', 'opt_out', 'opt_in')),
  decision text not null check (decision in ('yes', 'no', 'unclear', 'no_answer', 'notice', 'revoked')),
  evidence text check (length(evidence) <= 300),
  call_sid text check (length(call_sid) <= 64),
  prompt_version text check (length(prompt_version) <= 40),
  created_at timestamptz not null default now()
);
create index if not exists sms_consent_tenant_contact_idx on public.sms_consent (tenant_id, contact_e164, created_at desc);
create index if not exists sms_consent_created_idx on public.sms_consent (created_at);

alter table public.sms_consent enable row level security;
revoke all on public.sms_consent from public, anon, authenticated;
grant all on public.sms_consent to service_role;
grant select on public.sms_consent to authenticated;  -- admin only (policy); writes: runtime (service role) only

drop policy if exists sms_consent_admin_select on public.sms_consent;
create policy sms_consent_admin_select on public.sms_consent for select to authenticated
  using ((select private.is_admin()));

alter table public.calls add column if not exists transcript_withheld boolean not null default false;

-- run_retention: same as 20261011100200 plus the 5-year consent-log purge (and its count in the result)
create or replace function private.run_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_calls int; n_sms int; n_book int; n_consent int; n_clients int := 0; n_err int := 0; cid uuid; res jsonb;
begin
  -- transcripts, summaries and caller numbers are personal data: cleared after 90 days
  -- (row kept: outcome, duration, cost — no number hash, a hashed US phone number is trivially reversible)
  update public.calls set transcript = null, summary = null, from_e164 = null
   where started_at < now() - interval '90 days' and (transcript is not null or summary is not null or from_e164 is not null);
  get diagnostics n_calls = row_count;

  delete from public.sms_messages where created_at < now() - interval '90 days';
  get diagnostics n_sms = row_count;

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
                            'consent_deleted', n_consent,
                            'clients_anonymized', n_clients, 'client_errors', n_err);
  perform private.log_event('system', null, null, 'retention_run', res, false);
  return res;
end $$;

revoke all on function private.run_retention() from public, anon, authenticated;
grant execute on function private.run_retention() to service_role;
