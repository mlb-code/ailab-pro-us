-- Retention + housekeeping jobs (pg_cron). Idempotent: cron.schedule() with an existing job name updates that job.
-- SPEC §4/§8: transcripts + SMS 90 days, bookings 2 years.
-- Cancelled client, 30 days after it ended: personal + operational data deleted, but bookkeeping records
-- (payments, the accepted quote = the order) are KEPT 7 years (Israeli bookkeeping law), anonymised:
-- only client_id + business name + amounts remain. See supabase/tests/README.md "Retention".
-- Storage files cannot be deleted from SQL safely: they are queued in private.storage_purge_queue and
-- physically removed through the Storage API by A8/B6 (notify / runtime retention job).
-- Also: sent/viewed quotes past valid_until become 'expired'.

set check_function_bodies = off;

create extension if not exists pg_cron;

-- Files waiting for physical deletion via the Storage API (service role). done_at set by the deleting job.
create table if not exists private.storage_purge_queue (
  bucket_id text not null,
  name text not null,
  reason text not null default 'client_retention',
  queued_at timestamptz not null default now(),
  done_at timestamptz,
  primary key (bucket_id, name)
);
alter table private.storage_purge_queue enable row level security;
revoke all on private.storage_purge_queue from public, anon, authenticated;
grant all on private.storage_purge_queue to service_role;

-- Queue every client-files object of a user (all of them live under "{uid}/"). Returns how many were queued.
create or replace function private.queue_storage_purge(p_user uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into private.storage_purge_queue (bucket_id, name)
  select o.bucket_id, o.name from storage.objects o
   where o.bucket_id = 'client-files' and o.name like p_user::text || '/%'
  on conflict (bucket_id, name) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Strip e-mail addresses and phone-like digit runs from free text (payments.reference etc.).
create or replace function private.scrub_pii(t text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(coalesce(t, ''), '[^\s@]+@[^\s@]+\.[^\s@]+', '[removed]', 'g'),
           '\+?[0-9][0-9 ().-]{6,}[0-9]', '[removed]', 'g')), '')
$$;

-- Anonymise one cancelled client. Keeps: clients row (status, products, amounts, business_name, quote_id),
-- payments (amounts, kind, status, dates; reference scrubbed), accepted quote = the order (code/qty/name/amount
-- line items, totals, agreement version, accepted_at). The kept quote loses: Claude texts (scope_md,
-- timeline_text, assumptions, item "reason"), signer name/IP/UA, user_id; its public_token is rotated and
-- anonymized = true (quote-view refuses it). Deletes: every private.quote_drafts row of the client's quotes,
-- every admin note on the client's entities, tenants (+ calls, sms, bookings, opt-outs, credentials), onboarding
-- items, requests (+ attachments), and — when the user has no other non-anonymised client and is not admin —
-- the user's events, unaccepted quotes, leads with the same e-mail and the auth user (cascades: profile,
-- questionnaires, attachments). Storage files are queued for purge (physical delete: A8/B6).
create or replace function private.anonymize_client(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cl public.clients;
  v_user uuid;
  v_email text;
  v_delete_user boolean;
  n_files int := 0;
begin
  select * into cl from public.clients where id = p_client for update;
  if not found or cl.anonymized_at is not null then
    return jsonb_build_object('client', p_client, 'skipped', true);
  end if;
  v_user := cl.user_id;
  select p.email into v_email from public.profiles p where p.id = v_user;
  v_delete_user := v_user is not null
    and not exists (select 1 from public.clients c where c.user_id = v_user and c.id <> p_client and c.anonymized_at is null)
    and not coalesce((select p.is_admin from public.profiles p where p.id = v_user), false);

  -- internal notes on everything that is deleted or anonymised
  delete from public.admin_notes n where
       (n.entity = 'client' and n.entity_id = p_client)
    or (n.entity = 'quote' and n.entity_id = cl.quote_id)
    or (n.entity = 'tenant' and n.entity_id in (select t.id from public.tenants t where t.client_id = p_client))
    or (n.entity = 'request' and n.entity_id in (select r.id from public.requests r where r.client_id = p_client))
    or (v_delete_user and (
          (n.entity = 'quote' and n.entity_id in (select q.id from public.quotes q where q.user_id = v_user))
       or (n.entity = 'questionnaire' and n.entity_id in (select q.id from public.questionnaires q where q.user_id = v_user))
       or (n.entity = 'lead' and n.entity_id in (select l.id from public.leads l where lower(l.email) = lower(v_email)))));

  -- Claude raw outputs (contain names/phones) of every quote of this client
  delete from private.quote_drafts d where d.quote_id = cl.quote_id
     or (v_delete_user and d.quote_id in (select q.id from public.quotes q where q.user_id = v_user));

  update public.clients c
     set business_name = coalesce(c.business_name, (select p.company from public.profiles p where p.id = v_user)),
         user_id = null, anonymized_at = now()
   where c.id = p_client;

  update public.payments set reference = private.scrub_pii(reference) where client_id = p_client;

  update public.quotes q
     set accepted_name = null, accepted_ip = null, accepted_ua = null, user_id = null,
         scope_md = null, timeline_text = null, assumptions = '[]'::jsonb,
         items = coalesce((select jsonb_agg((select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(it) as e(k, v)
                                             where k in ('code', 'qty', 'name', 'kind', 'setup_cents', 'monthly_cents')))
                           from jsonb_array_elements(q.items) it), '[]'::jsonb),
         public_token = private.random_token(), anonymized = true
   where q.id = cl.quote_id;

  delete from public.tenants where client_id = p_client;
  delete from public.onboarding_items where client_id = p_client;
  delete from public.requests where client_id = p_client;

  if v_user is not null then
    n_files := private.queue_storage_purge(v_user);
  end if;
  if v_delete_user then
    delete from public.quotes q where q.user_id = v_user and q.status <> 'accepted';
    update public.quotes q set user_id = null where q.user_id = v_user;  -- other accepted quotes keep amounts only
    delete from public.events e where e.user_id = v_user;
    delete from public.leads l where lower(l.email) = lower(v_email);
    delete from auth.users u where u.id = v_user;  -- cascades: profile, questionnaires, attachments
  end if;

  return jsonb_build_object('client', p_client, 'files_queued', n_files, 'user_deleted', v_delete_user);
end $$;

-- Daily job. Each part is independent: the 90-day cleanup always runs, and a failure on one client is caught,
-- logged as a 'retention_error' event (client id + error text) and the loop continues with the next client.
create or replace function private.run_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_calls int; n_sms int; n_book int; n_clients int := 0; n_err int := 0; cid uuid; res jsonb;
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
                            'clients_anonymized', n_clients, 'client_errors', n_err);
  perform private.log_event('system', null, null, 'retention_run', res, false);
  return res;
end $$;

create or replace function private.expire_quotes() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.quotes set status = 'expired'
   where status in ('sent', 'viewed') and valid_until is not null and valid_until < now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function private.run_retention() from public, anon, authenticated;
revoke all on function private.expire_quotes() from public, anon, authenticated;
revoke all on function private.anonymize_client(uuid) from public, anon, authenticated;
revoke all on function private.queue_storage_purge(uuid) from public, anon, authenticated;
revoke all on function private.scrub_pii(text) from public, anon, authenticated;
grant execute on function private.run_retention(), private.expire_quotes(), private.anonymize_client(uuid),
  private.queue_storage_purge(uuid), private.scrub_pii(text) to service_role;

select cron.schedule('ailab-us-retention', '17 3 * * *', 'select private.run_retention()');
select cron.schedule('ailab-us-expire-quotes', '7 * * * *', 'select private.expire_quotes()');
