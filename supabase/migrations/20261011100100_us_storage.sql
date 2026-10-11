-- Storage buckets for ailab-us. Idempotent.
--   client-files  (private): {owner uid}/{questionnaire id | request id}/{rand}-{ascii-name}, ≤ 10MB, ≤ 5 files per item,
--                 upload/delete only while the item is editable (questionnaire = draft; request = queued / waiting_on_you).
--   videos-public (public):  onboarding videos (≤ 50MB = Free-plan upload cap); anyone can download by public URL, only admin can upload/replace/delete.
-- quote-pdf (SPEC §4, "later phase") is intentionally not created yet.

set check_function_bodies = off;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-files', 'client-files', false, 10485760, array[
  'image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif','image/svg+xml',
  'application/pdf','text/plain','text/csv',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos-public', 'videos-public', true, 52428800, array['video/mp4','video/webm','image/png','image/jpeg','image/webp','text/vtt'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- true when p_name = <me>/<my editable questionnaire or request>/<rand>-<ascii name>
create or replace function private.client_path_is_editable(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  parts text[] := string_to_array(p_name, '/');
  item uuid;
  me uuid := (select auth.uid());
begin
  if me is null or coalesce(array_length(parts, 1), 0) <> 3 or parts[1] <> me::text then
    return false;
  end if;
  if parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or parts[3] !~ '^[A-Za-z0-9]{6,40}-[A-Za-z0-9._-]{1,200}$' then
    return false;
  end if;
  item := parts[2]::uuid;
  return exists (select 1 from public.questionnaires q where q.id = item and q.user_id = me and q.status = 'draft')
      or exists (select 1 from public.requests r join public.clients c on c.id = r.client_id
                 where r.id = item and c.user_id = me and r.status in ('queued', 'waiting_on_you'));
end $$;

-- true when the folder of p_name holds fewer than 5 objects
create or replace function private.client_folder_has_room(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from storage.objects o
          where o.bucket_id = 'client-files'
            and split_part(o.name, '/', 1) = split_part(p_name, '/', 1)
            and split_part(o.name, '/', 2) = split_part(p_name, '/', 2)) < 5
$$;

revoke all on function private.client_path_is_editable(text) from public, anon;
revoke all on function private.client_folder_has_room(text) from public, anon;
grant execute on function private.client_path_is_editable(text) to authenticated;
grant execute on function private.client_folder_has_room(text) to authenticated;

-- client-files
drop policy if exists client_files_insert on storage.objects;
create policy client_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'client-files'
              and (((select private.client_path_is_editable(name)) and (select private.client_folder_has_room(name)))
                   or (select private.is_admin())));

drop policy if exists client_files_select on storage.objects;
create policy client_files_select on storage.objects for select to authenticated
  using (bucket_id = 'client-files'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or (select private.is_admin())));

drop policy if exists client_files_delete on storage.objects;
create policy client_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'client-files'
         and ((select private.client_path_is_editable(name)) or (select private.is_admin())));
-- no UPDATE policy for clients: files cannot be overwritten (upload with upsert=false)

-- videos-public: admin manages; public download needs no policy (public bucket URL)
drop policy if exists videos_admin_select on storage.objects;
create policy videos_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'videos-public' and (select private.is_admin()));
drop policy if exists videos_admin_insert on storage.objects;
create policy videos_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'videos-public' and (select private.is_admin()));
drop policy if exists videos_admin_update on storage.objects;
create policy videos_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'videos-public' and (select private.is_admin()))
  with check (bucket_id = 'videos-public' and (select private.is_admin()));
drop policy if exists videos_admin_delete on storage.objects;
create policy videos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'videos-public' and (select private.is_admin()));
