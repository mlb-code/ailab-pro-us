-- A6 quote engine: columns and helpers the Edge Functions quote-draft / quote-view / quote-accept / quote-send need.
-- Additive only (never edits earlier migrations). Idempotent.
--   * quotes.not_included_extra  client-specific exclusions drafted by Claude, approved by Meir with the rest of the text
--   * public.quote_reviews       admin-only side panel for a draft: manual-price reasons, risk flags, internal questions,
--                                deterministic hints, sanitizer removals. Written by the service role only.
--   * public.save_quote_draft()  service-role-only writer for private.quote_drafts (private schema is not exposed to PostgREST)
--   * anonymisation cleanup      when retention sets quotes.anonymized, Claude text added here is removed too

set check_function_bodies = off;

alter table public.quotes add column if not exists not_included_extra jsonb not null default '[]'::jsonb;
do $$ begin
  alter table public.quotes add constraint quotes_not_included_extra_array
    check (jsonb_typeof(not_included_extra) = 'array' and octet_length(not_included_extra::text) < 10000);
exception when duplicate_object then null; end $$;

create table if not exists public.quote_reviews (
  quote_id uuid primary key references public.quotes(id) on delete cascade,
  manual_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(manual_reasons) = 'array'),
  risk_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(risk_flags) = 'array'),
  questions_for_client jsonb not null default '[]'::jsonb check (jsonb_typeof(questions_for_client) = 'array'),
  hints jsonb not null default '{}'::jsonb check (jsonb_typeof(hints) = 'object'),
  removed jsonb not null default '[]'::jsonb check (jsonb_typeof(removed) = 'array'),
  model text check (length(model) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(manual_reasons::text) + octet_length(risk_flags::text) + octet_length(questions_for_client::text)
         + octet_length(hints::text) + octet_length(removed::text) < 100000)
);

alter table public.quote_reviews enable row level security;
revoke all on public.quote_reviews from public, anon, authenticated;
grant all on public.quote_reviews to service_role;
grant select on public.quote_reviews to authenticated;   -- admin only (policy); writes = service role (quote-draft)

drop policy if exists quote_reviews_admin_select on public.quote_reviews;
create policy quote_reviews_admin_select on public.quote_reviews for select to authenticated
  using ((select private.is_admin()));

drop trigger if exists quote_reviews_touch on public.quote_reviews;
create trigger quote_reviews_touch before update on public.quote_reviews
  for each row execute function private.touch_updated_at();

-- private.quote_drafts writer (one row per quote; regenerate = overwrite). Service role only.
create or replace function public.save_quote_draft(p_quote_id uuid, p_model text, p_prompt_hash text, p_raw_output jsonb,
                                                   p_tokens int default null, p_cost_usd numeric default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.api_role() <> 'service_role' and private.api_role() <> '' then
    raise exception 'service_role_only' using errcode = '42501';
  end if;
  insert into private.quote_drafts (quote_id, model, prompt_hash, raw_output, tokens, cost_usd, created_at)
  values (p_quote_id, p_model, p_prompt_hash, p_raw_output, p_tokens, p_cost_usd, now())
  on conflict (quote_id) do update
    set model = excluded.model, prompt_hash = excluded.prompt_hash, raw_output = excluded.raw_output,
        tokens = excluded.tokens, cost_usd = excluded.cost_usd, created_at = now();
end $$;
revoke all on function public.save_quote_draft(uuid, text, text, jsonb, int, numeric) from public, anon, authenticated;
grant execute on function public.save_quote_draft(uuid, text, text, jsonb, int, numeric) to service_role;

-- Retention: anonymising a kept quote also drops the Claude-written extras and the admin review panel.
create or replace function private.quotes_anon_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.anonymized and not old.anonymized then
    new.not_included_extra := '[]'::jsonb;
    delete from public.quote_reviews r where r.quote_id = new.id;
  end if;
  return new;
end $$;
revoke all on function private.quotes_anon_cleanup() from public, anon, authenticated;
drop trigger if exists quotes_anon_cleanup on public.quotes;
create trigger quotes_anon_cleanup before update of anonymized on public.quotes
  for each row execute function private.quotes_anon_cleanup();
