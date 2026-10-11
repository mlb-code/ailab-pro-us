-- Supabase forbids DELETE on storage.objects from SQL (trigger storage.protect_delete): files are removed only
-- through the Storage API. This migration (idempotent) re-states the queue-only contract and fails loudly if any
-- function in public/private ever deletes from storage tables directly.
--   * private.queue_storage_purge(uid)   — queue a user's client-files objects (used by anonymize_client)
--   * physical deletion: A8/B6 read private.storage_purge_queue with the service role, delete via the Storage API,
--     then set done_at.

set check_function_bodies = off;

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
revoke all on function private.queue_storage_purge(uuid) from public, anon, authenticated;
grant execute on function private.queue_storage_purge(uuid) to service_role;

do $$
declare bad text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and p.prosrc ~* 'delete\s+from\s+storage\.';
  if bad is not null then
    raise exception 'functions deleting storage objects directly: % (use private.storage_purge_queue)', bad;
  end if;
end $$;
