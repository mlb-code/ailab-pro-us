-- 22.10.2026: pg_net -> Edge Functions with the new-style Supabase keys.
-- Vault `ailab_us_service_role_key` now holds a secret key (sb_secret_…, written by tools/us_setup.py --only vault) instead
-- of the legacy service_role JWT. The Edge gateway reads new keys from the `apikey` header, and events-dispatch accepts the
-- key as Bearer or apikey (supabase/functions/events-dispatch), so both headers are sent. Same name in Vault on purpose:
-- nothing else changes, and the legacy JWT keeps working until it is switched off in the dashboard.
set check_function_bodies = off;

create or replace function private.call_edge_function(p_name text, p_body jsonb default '{}'::jsonb, p_timeout_ms int default 150000)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text; rid bigint;
begin
  if coalesce(p_name, '') !~ '^[a-z][a-z0-9-]{1,40}$' then raise exception 'bad_function_name' using errcode = 'P0001'; end if;
  begin
    select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'ailab_us_project_url' limit 1;
    select ds.decrypted_secret into v_key from vault.decrypted_secrets ds where ds.name = 'ailab_us_service_role_key' limit 1;
  exception when others then v_url := null; v_key := null;
  end;
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then return null; end if;
  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    body := coalesce(p_body, '{}'::jsonb),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'apikey', v_key, 'Content-Type', 'application/json'),
    timeout_milliseconds := p_timeout_ms) into rid;
  return rid;
end $$;
