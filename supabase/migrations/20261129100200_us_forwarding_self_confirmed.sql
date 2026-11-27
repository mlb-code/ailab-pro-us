-- Call-forwarding step: a self-confirmed test is recorded as UNVERIFIED and Meir is told (promise-vs-reality audit
-- 2026-11-27, journey step 7). The path stays (it is how a forwarding test is passed when the carrier sends no
-- ForwardedFrom, and how Meir tests from Israel), but it no longer looks the same as a verified forward:
--
--   public.confirm_forwarding_test   same rules as 20261125100000_us_subscriptions.sql; the item's data now also carries
--                                    unverified: true, self_confirmed_at and self_confirmed_by ('client' | 'admin');
--                                    an admin-only event forwarding_self_confirmed; and an admin e-mail
--                                    (admin_provisioning_alert, step 'forwarding_self_confirmed', once per item).
--   public.admin_subscriptions_extra same as 20261125200000_us_firstring_p2.sql plus 'forwarding' per client:
--                                    {status, verified ('forwarded_from' | 'self_confirmed' | null), unverified,
--                                    self_confirmed_at, test_call_at}, for the "Subscriptions" admin tab.
set check_function_bodies = off;

create or replace function public.confirm_forwarding_test(p_item uuid) returns public.onboarding_items
language plpgsql security definer set search_path = '' as $$
declare it public.onboarding_items; uid uuid; by_admin boolean;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  select * into it from public.onboarding_items o where o.id = p_item;
  if not found or it.key <> 'forward_calls' or not (private.owns_client(it.client_id) or private.is_admin()) then
    raise exception 'not_your_item' using errcode = '42501';
  end if;
  if (it.data ->> 'test_unverified_at') is null then raise exception 'no_test_call' using errcode = 'P0001'; end if;
  if coalesce((it.data ->> 'test_direct')::boolean, false) then raise exception 'called_directly' using errcode = 'P0001'; end if;
  if (it.data ->> 'test_unverified_at')::timestamptz < (it.data ->> 'test_started_at')::timestamptz - interval '1 minute' then
    raise exception 'no_test_call' using errcode = 'P0001';
  end if;
  by_admin := not private.owns_client(it.client_id);
  update public.onboarding_items o
     set status = 'done', data = o.data || jsonb_build_object('test_call_at', it.data ->> 'test_unverified_at', 'verified', 'self_confirmed',
                                                              'unverified', true, 'self_confirmed_at', now(),
                                                              'self_confirmed_by', case when by_admin then 'admin' else 'client' end)
   where o.id = p_item returning * into it;
  uid := (select c.user_id from public.clients c where c.id = it.client_id);
  perform private.log_event('onboarding_item', it.id, uid,
    'forwarding_test_passed', jsonb_build_object('verified', 'self_confirmed', 'unverified', true), true);
  -- for Meir only: the test call reached the line without carrier forwarding data, so forwarding from the business line
  -- is not proven
  perform private.log_event('client', it.client_id, uid, 'forwarding_self_confirmed',
    jsonb_build_object('item', it.id, 'test_call_id', it.data ->> 'test_call_id', 'test_call_at', it.data ->> 'test_unverified_at',
                       'by', case when by_admin then 'admin' else 'client' end), false);
  perform private.enqueue_email_safe('admin_provisioning_alert', 'admin_provisioning_alert:forwarding_self_confirmed:' || it.id,
    'client', it.client_id, uid, jsonb_build_object('step', 'forwarding_self_confirmed',
      'error', 'Call forwarding: UNVERIFIED, self-confirmed by the ' || case when by_admin then 'admin' else 'client' end
               || '. The test call reached the line without carrier forwarding data, so we cannot tell whether calls to the '
               || 'business line are really forwarded. Call the business line yourself (or ask the client to) before relying on it.'));
  return it;
end $$;

create or replace function public.admin_subscriptions_extra() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'client_id', c.id,
      'release', (select to_jsonb(r) - 'result' || jsonb_build_object('would_release', r.result ->> 'would_release')
                    from public.number_releases r where r.client_id = c.id order by r.created_at desc limit 1),
      'golive', (select jsonb_build_object('status', j.status, 'updated_at', j.updated_at, 'passed', j.result -> 'passed',
                                           'ai_check', j.result -> 'ai_check')
                   from public.provisioning_jobs j where j.client_id = c.id and j.kind = 'golive_sim'
                  order by j.updated_at desc limit 1),
      'forwarding', (select jsonb_build_object('status', o.status, 'verified', o.data ->> 'verified',
                                               'unverified', o.status = 'done' and o.data ->> 'verified' is distinct from 'forwarded_from',
                                               'self_confirmed_at', o.data ->> 'self_confirmed_at',
                                               'self_confirmed_by', o.data ->> 'self_confirmed_by',
                                               'test_call_at', o.data ->> 'test_call_at')
                       from public.onboarding_items o where o.client_id = c.id and o.key = 'forward_calls'
                      order by o.created_at desc limit 1)))
    from public.clients c where c.billing_mode = 'subscription'), '[]'::jsonb);
end $$;

revoke all on function public.confirm_forwarding_test(uuid), public.admin_subscriptions_extra() from public, anon;
grant execute on function public.confirm_forwarding_test(uuid), public.admin_subscriptions_extra() to authenticated, service_role;
