-- Runtime key/value state (rate limits, spend, monthly usage counters) for runtime/app/store.py StateStore.
-- Contract (store.py): table public.runtime_state (id, key, tenant_id, value jsonb, updated_at);
-- select by key (globally unique), update by id, insert {key, tenant_id, value, updated_at} — all through PostgREST
-- with the SERVICE ROLE key. Public schema only because PostgREST must reach it; anon/authenticated get no grants
-- and no usable policy, so nothing is readable or writable except by the service role (which bypasses RLS).
-- Rows of a tenant disappear with the tenant (retention / anonymisation cascades).

set check_function_bodies = off;

create table if not exists public.runtime_state (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (length(key) between 1 and 200),
  tenant_id uuid references public.tenants(id) on delete cascade,
  value jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists runtime_state_tenant_idx on public.runtime_state (tenant_id);

alter table public.runtime_state enable row level security;
revoke all on public.runtime_state from public, anon, authenticated;
grant all on public.runtime_state to service_role;

-- Documentary policy (service_role bypasses RLS anyway); no policy exists for anon/authenticated.
drop policy if exists runtime_state_service_only on public.runtime_state;
create policy runtime_state_service_only on public.runtime_state for all to service_role
  using ((select private.api_role()) = 'service_role') with check ((select private.api_role()) = 'service_role');
