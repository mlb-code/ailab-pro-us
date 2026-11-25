-- FirstRing phase 3 follow-ups (owner decision 2026-11-25). Additive and idempotent; earlier migrations are not edited.
--
-- 1. public.client_billing(): one more key, number_release = {number, release_at} while the release of the customer's
--    FirstRing number is scheduled (public.number_releases status 'scheduled'), else null. The portal's Billing card shows
--    "Your FirstRing number (...) is kept until <date>. Restart your plan to keep it." Only the caller's own client, only
--    those two fields (no internal status, errors or postponements). The rest of the function is the same as in
--    20261125100000_us_subscriptions.sql (this definition supersedes it).
-- 2. public.runtime_account_email(client): service role only. The account's e-mail (profiles.contact_email when set, else
--    the sign-in address) so the runtime's 7-day number-release warning also reaches the account owner, not only the
--    business's alert addresses (runtime/app/provisioning.py deduplicates the list).
set check_function_bodies = off;

-- ================================================================ 1. the portal's billing read (own client only)
create or replace function public.client_billing() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.clients; sub public.subscriptions; t public.tenants; per text; pre text; jobs jsonb; rel jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  me := private.my_sub_client();
  if me.id is null then return jsonb_build_object('subscription', null,
    'mock_checkout', coalesce((select s.billing_mock_enabled from private.settings s where s.id = 1), false)); end if;
  sub := private.client_sub(me.id);
  select * into t from public.tenants x where x.client_id = me.id order by x.created_at limit 1;
  per := case when t.config #>> '{plan,period_start}' is not null then 'p' || (t.config #>> '{plan,period_start}')
              else to_char(now() at time zone 'utc', 'YYYY-MM') end;
  pre := 'usage:' || t.id || ':' || per || ':';
  select coalesce(jsonb_agg(jsonb_build_object('kind', j.kind,
           'status', case j.status when 'done' then 'done' when 'pending' then 'working' when 'running' then 'working' else 'delayed' end,
           'updated_at', j.updated_at) order by j.kind), '[]'::jsonb)
    into jobs from public.provisioning_jobs j where j.tenant_id = t.id;
  -- the number is kept until release_at; held (dry run) / released / canceled / failed rows are not shown
  select jsonb_build_object('number', r.number, 'release_at', r.release_at) into rel
    from public.number_releases r
   where r.client_id = me.id and r.tenant_id = t.id and r.status = 'scheduled'
   order by r.created_at desc limit 1;
  return jsonb_build_object(
    'client_id', me.id, 'client_status', me.status, 'tenant_id', t.id, 'number', t.twilio_number,
    'subscription', jsonb_build_object('plan_code', sub.plan_code, 'scheduled_plan_code', sub.scheduled_plan_code, 'status', sub.status,
      'provider', sub.provider, 'card_on_file', sub.card_on_file, 'trial_ends_at', sub.trial_ends_at,
      'current_period_start', sub.current_period_start, 'current_period_end', sub.current_period_end,
      'cancel_at_period_end', sub.cancel_at_period_end, 'ends_at', sub.ends_at, 'trial_duplicate', sub.trial_duplicate),
    'service', jsonb_build_object('mode', coalesce(t.config #>> '{plan,service}', 'full'), 'reason', coalesce(t.config #>> '{plan,service_reason}', '')),
    'period', jsonb_build_object('label', per, 'start', t.config #>> '{plan,period_start}', 'end', t.config #>> '{plan,period_end}'),
    'usage', jsonb_build_object(
      'voice_minutes', coalesce((select private.rs_num(r.value) from public.runtime_state r where r.key = pre || 'voice_minutes'), 0),
      'needs_addon_approval', coalesce((select r.value = 'true'::jsonb from public.runtime_state r where r.key = pre || 'needs_addon_approval'), false)),
    'setup', jobs,
    'number_release', rel,
    'mock_checkout', coalesce((select s.billing_mock_enabled from private.settings s where s.id = 1), false));
end $$;

-- ================================================================ 2. the account e-mail for the runtime (service role only)
create or replace function public.runtime_account_email(p_client uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.api_role() not in ('service_role', '') then
    raise exception 'service_role_only' using errcode = '42501';
  end if;
  return (select nullif(btrim(coalesce(nullif(btrim(p.contact_email), ''), p.email)), '')
            from public.clients c join public.profiles p on p.id = c.user_id
           where c.id = p_client);
end $$;

-- ================================================================ privileges
revoke all on function public.client_billing() from public, anon;
grant execute on function public.client_billing() to authenticated, service_role;
revoke all on function public.runtime_account_email(uuid) from public, anon, authenticated;
grant execute on function public.runtime_account_email(uuid) to service_role;
