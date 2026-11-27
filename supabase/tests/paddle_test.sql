-- FirstRing sign-up + Paddle (20261126100000_us_paddle.sql). One DO block; ALWAYS ends with an error so it rolls back.
-- Success = message starts with PADDLE_TESTS_PASSED. Offline: deno run -A --node-modules-dir=none supabase/tests/offline/paddle_run.ts
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ud uuid := gen_random_uuid(); cd uuid;
  r jsonb; ref_a text; ref_b text; ca uuid; n int; c int := 0; s public.subscriptions; consent constant text := 'I agree to the Terms of Service and the Service Agreement v2.0.';
begin
  insert into auth.users (id, email) values (ua, 'pad-a@example.com'), (ub, 'pad-b@example.com'), (uc, 'pad-c@example.com'), (ud, 'pad-d@example.com');
  update public.profiles set company = 'Paddle HVAC', phone = '(713) 555-0142' where id = ua;
  update public.profiles set company = 'Second Try HVAC', phone = '(713) 555-0142' where id = ub;

  -- ---------------------------------------------------------------- sign-up RPC (client)
  begin perform public.billing_checkout_start('FR_PRO', '7135550142', '2.0', consent); raise exception 'FAIL anonymous checkout';
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.billing_checkout_start('FR_GOLD', '7135550142', '2.0', consent); raise exception 'FAIL unknown plan';
  exception when sqlstate 'P0001' then if sqlerrm <> 'bad_plan_code' then raise; end if; end; c := c + 1;
  begin perform public.billing_checkout_start('FR_PRO', '12345', '2.0', consent); raise exception 'FAIL bad phone';
  exception when sqlstate 'P0001' then if sqlerrm <> 'phone_invalid' then raise; end if; end; c := c + 1;
  begin perform public.billing_checkout_start('FR_PRO', '7135550142', '2.0', ''); raise exception 'FAIL no consent';
  exception when sqlstate 'P0001' then if sqlerrm <> 'consent_required' then raise; end if; end; c := c + 1;
  r := public.billing_checkout_start('FR_PRO', '(713) 555-0142', '2.0', consent, true, 'Mozilla/5.0 test');
  ref_a := r ->> 'ref';
  if ref_a !~ '^chk_[0-9a-f]{32}$' or r ->> 'business_phone' <> '+17135550142' or not (r ->> 'trial')::boolean then
    raise exception 'FAIL checkout start %', r; end if; c := c + 1;
  select count(*) into n from public.billing_checkouts; if n <> 1 then raise exception 'FAIL A sees % checkouts', n; end if; c := c + 1;
  begin insert into public.billing_checkouts (ref, user_id, plan_code, trial, business_phone, agreement_version, consent_text)
    values ('chk_' || md5('x'), ua, 'FR_PRO', true, '+17135550142', '2.0', consent); raise exception 'FAIL client inserted a checkout';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.billing_paddle_checkout(ref_a); raise exception 'FAIL client read the service lookup';
  exception when insufficient_privilege then null; end; c := c + 1;
  begin perform public.billing_paddle_transaction('txn_x', 'sub_x', 'completed', 'web', 100, 'USD', now(), now()); raise exception 'FAIL client wrote a transaction';
  exception when insufficient_privilege then null; end; c := c + 1;

  -- B cannot read A's checkout
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.billing_checkouts; if n <> 0 then raise exception 'FAIL B reads A checkouts'; end if; c := c + 1;

  -- ---------------------------------------------------------------- webhook side (service role): A's Paddle subscription
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  r := public.billing_paddle_checkout(ref_a);
  if (r ->> 'user_id')::uuid <> ua or r ->> 'plan_code' <> 'FR_PRO' or r ->> 'email' <> 'pad-a@example.com' then raise exception 'FAIL ref lookup %', r; end if; c := c + 1;
  if public.billing_paddle_checkout('chk_' || md5('nope')) is not null then raise exception 'FAIL unknown ref'; end if; c := c + 1;
  r := public.billing_upsert_subscription('paddle', 'sub_01paddletest0000000000000a', 'trialing', 'FR_PRO', ua, 'ctm_01test',
    now() + interval '14 days', null, null, false, true, null, null, now() - interval '1 minute', '+17135550142');
  ca := (r ->> 'client_id')::uuid;
  if r ->> 'status' <> 'trialing' or (r ->> 'tenant_id') is null then raise exception 'FAIL paddle upsert %', r; end if; c := c + 1;
  if not public.billing_paddle_checkout_done(ref_a, 'sub_01paddletest0000000000000a') then raise exception 'FAIL checkout done'; end if;
  if (public.billing_paddle_checkout(ref_a)) ->> 'status' <> 'completed' then raise exception 'FAIL checkout not completed'; end if; c := c + 1;
  r := public.billing_paddle_lookup('sub_01paddletest0000000000000a');
  if (r ->> 'user_id')::uuid <> ua or r ->> 'provider_customer_id' <> 'ctm_01test' or r ->> 'plan_code' <> 'FR_PRO' then raise exception 'FAIL lookup %', r; end if; c := c + 1;
  if (public.billing_paddle_lookup(null, ua)) ->> 'provider_subscription_id' <> 'sub_01paddletest0000000000000a' then raise exception 'FAIL lookup by user'; end if; c := c + 1;

  -- event ids: idempotent log
  if public.billing_paddle_event_seen('evt_01a') then raise exception 'FAIL unseen event seen'; end if;
  perform public.billing_paddle_event_log('evt_01a', 'subscription.created', now(), 'sub_01paddletest0000000000000a', 'applied');
  perform public.billing_paddle_event_log('evt_01a', 'subscription.created', now(), 'sub_01paddletest0000000000000a', 'again');
  if not public.billing_paddle_event_seen('evt_01a') or (select count(*) from private.paddle_events where event_id = 'evt_01a') <> 1
     or (select result from private.paddle_events where event_id = 'evt_01a') <> 'applied' then raise exception 'FAIL event log idempotency'; end if; c := c + 1;

  -- the $0 trial transaction does not start the money-back window; the first real charge does, once
  r := public.billing_paddle_transaction('txn_01zero', 'sub_01paddletest0000000000000a', 'completed', 'web', 0, 'USD', now(), now());
  if (r ->> 'first_paid')::boolean or (select first_paid_at from public.subscriptions where client_id = ca) is not null then raise exception 'FAIL $0 trial started money-back'; end if; c := c + 1;
  -- trial ends: active, first charge
  perform public.billing_upsert_subscription('paddle', 'sub_01paddletest0000000000000a', 'active', 'FR_PRO', null, null, null,
    now(), now() + interval '1 month', false, true, null, null, now(), null);
  r := public.billing_paddle_transaction('txn_01first', 'sub_01paddletest0000000000000a', 'completed', 'subscription_recurring', 24900, 'usd', now() - interval '2 days', now());
  select * into s from public.subscriptions where client_id = ca;
  if not (r ->> 'first_paid')::boolean or s.first_paid_transaction_id <> 'txn_01first' or s.first_paid_at > now() - interval '1 day' then raise exception 'FAIL first paid %', to_jsonb(s); end if; c := c + 1;
  perform public.billing_paddle_transaction('txn_01first', 'sub_01paddletest0000000000000a', 'completed', 'subscription_recurring', 24900, 'USD', now(), now());
  perform public.billing_paddle_transaction('txn_01second', 'sub_01paddletest0000000000000a', 'completed', 'subscription_recurring', 24900, 'USD', now(), now());
  if (select first_paid_transaction_id from public.subscriptions where client_id = ca) <> 'txn_01first'
     or (select count(*) from private.paddle_transactions where provider_subscription_id = 'sub_01paddletest0000000000000a') <> 3 then
    raise exception 'FAIL first paid moved / duplicate transaction rows'; end if; c := c + 1;
  perform public.billing_paddle_transaction('txn_01fail', 'sub_01paddletest0000000000000a', 'payment_failed', 'subscription_recurring', 24900, 'USD', null, now());
  if (select last_payment_failed_at from public.subscriptions where client_id = ca) is null then raise exception 'FAIL payment failure not noted'; end if; c := c + 1;

  -- money-back: open within 30 days, once per business
  r := public.billing_paddle_money_back_target(ca);
  if r ->> 'transaction_id' <> 'txn_01first' then raise exception 'FAIL money-back target %', r; end if; c := c + 1;
  perform public.billing_paddle_money_back_done(ca, 'adj_01test', null);
  begin perform public.billing_paddle_money_back_target(ca); raise exception 'FAIL money-back twice';
  exception when sqlstate 'P0001' then if sqlerrm <> 'money_back_already_used' then raise; end if; end; c := c + 1;
  if (select money_back_used_at from private.trial_claims where phone = '+17135550142') is null then raise exception 'FAIL claim not marked'; end if; c := c + 1;
  update public.subscriptions set money_back_used_at = null, money_back_refund_id = null, first_paid_at = now() - interval '31 days' where client_id = ca;
  update private.trial_claims set money_back_used_at = null where phone = '+17135550142';
  begin perform public.billing_paddle_money_back_target(ca); raise exception 'FAIL money-back after 30 days';
  exception when sqlstate 'P0001' then if sqlerrm <> 'money_back_window_closed' then raise; end if; end; c := c + 1;

  perform public.billing_paddle_alert('sub_01paddletest0000000000000a', 'unknown_price', 'pri_x');
  if not exists (select 1 from public.events e where e.type = 'paddle_alert' and e.entity_id = ca) then raise exception 'FAIL alert event'; end if; c := c + 1;

  -- ---------------------------------------------------------------- webhook order (20261129100100_us_paddle_link_transactions.sql)
  -- "Start paid plan": the charges arrive BEFORE subscription.created wrote the row -> stored unlinked; the link RPC (called
  -- by paddle-webhook after every subscription event) stamps the client and starts the money-back window from the earliest
  -- charge > 0.
  r := public.billing_paddle_transaction('txn_01dzero', 'sub_01paddletest0000000000000d', 'completed', 'web', 0, 'USD', now() - interval '2 hours', now());
  r := public.billing_paddle_transaction('txn_01dearly', 'sub_01paddletest0000000000000d', 'completed', 'web', 4900, 'USD', now() - interval '1 hour', now());
  r := public.billing_paddle_transaction('txn_01dlate', 'sub_01paddletest0000000000000d', 'completed', 'subscription_recurring', 4900, 'USD', now(), now());
  if (r ->> 'known_subscription')::boolean or (r ->> 'first_paid')::boolean then raise exception 'FAIL setup: early transaction linked %', r; end if;
  r := public.billing_paddle_link_transactions('sub_01paddletest0000000000000d');
  if (r ->> 'linked')::int <> 0 or (r ->> 'first_paid')::boolean then raise exception 'FAIL link before the row exists %', r; end if; c := c + 1;
  r := public.billing_upsert_subscription('paddle', 'sub_01paddletest0000000000000d', 'active', 'FR_STARTER', ud, 'ctm_01testd',
    null, now() - interval '1 hour', now() + interval '30 days', false, true, null, null, now(), '+13125550160');
  cd := (r ->> 'client_id')::uuid;
  if cd is null then raise exception 'FAIL paid-start upsert %', r; end if;
  begin perform public.billing_paddle_money_back_target(cd); raise exception 'FAIL money-back open before the link';
  exception when sqlstate 'P0001' then if sqlerrm <> 'money_back_window_closed' then raise; end if; end; c := c + 1;
  r := public.billing_paddle_link_transactions('sub_01paddletest0000000000000d');
  if (r ->> 'linked')::int <> 3 or not (r ->> 'first_paid')::boolean then raise exception 'FAIL link %', r; end if; c := c + 1;
  select * into s from public.subscriptions where client_id = cd;
  if s.first_paid_transaction_id is distinct from 'txn_01dearly' or s.first_paid_at > now() - interval '50 minutes'
     or s.first_paid_at < now() - interval '70 minutes' then raise exception 'FAIL first paid from the earliest charge %', to_jsonb(s); end if; c := c + 1;
  if exists (select 1 from private.paddle_transactions t where t.provider_subscription_id = 'sub_01paddletest0000000000000d'
              and t.client_id is distinct from cd) then raise exception 'FAIL transactions not stamped with the client'; end if; c := c + 1;
  if (public.billing_paddle_money_back_target(cd)) ->> 'transaction_id' <> 'txn_01dearly' then raise exception 'FAIL money-back target after link'; end if; c := c + 1;
  r := public.billing_paddle_link_transactions('sub_01paddletest0000000000000d');
  if (r ->> 'linked')::int <> 0 or (r ->> 'first_paid')::boolean then raise exception 'FAIL link not idempotent %', r; end if;
  if (select first_paid_transaction_id from public.subscriptions where client_id = cd) <> 'txn_01dearly' then raise exception 'FAIL link moved first paid'; end if; c := c + 1;
  if not exists (select 1 from public.events e where e.type = 'paddle_transactions_linked' and e.entity_id = cd) then
    raise exception 'FAIL link event'; end if; c := c + 1;
  -- A's trial: the first paid date set earlier is never moved by a link
  r := public.billing_paddle_link_transactions('sub_01paddletest0000000000000a');
  if (r ->> 'first_paid')::boolean then raise exception 'FAIL link moved A''s first paid %', r; end if; c := c + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ud, 'role', 'authenticated')::text, true);
  begin perform public.billing_paddle_link_transactions('sub_01paddletest0000000000000d'); raise exception 'FAIL client ran the link';
  exception when insufficient_privilege then null; end; c := c + 1;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ---------------------------------------------------------------- the same business phone: no second trial, paid start allowed
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  begin perform public.billing_checkout_start('FR_STARTER', '713-555-0142', '2.0', consent, true); raise exception 'FAIL second trial';
  exception when sqlstate 'P0001' then if sqlerrm <> 'trial_already_used' then raise; end if; end; c := c + 1;
  r := public.billing_checkout_start('FR_STARTER', '713-555-0142', '2.0', consent, false);
  ref_b := r ->> 'ref'; if (r ->> 'trial')::boolean then raise exception 'FAIL paid start %', r; end if; c := c + 1;
  -- A (subscribed) cannot start a second checkout
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.billing_checkout_start('FR_BUSINESS', '7135550142', '2.0', consent, false); raise exception 'FAIL subscribed user checkout';
  exception when sqlstate 'P0001' then if sqlerrm <> 'already_subscribed' then raise; end if; end; c := c + 1;
  -- a returning client (earlier subscription ended) gets no second trial, even on its own phone number
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  update public.subscriptions set status = 'canceled', canceled_at = now(), ends_at = now() where client_id = ca;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin perform public.billing_checkout_start('FR_PRO', '7135550142', '2.0', consent, true); raise exception 'FAIL trial again after cancel';
  exception when sqlstate 'P0001' then if sqlerrm <> 'trial_already_used' then raise; end if; end; c := c + 1;
  if (public.billing_checkout_start('FR_PRO', '7135550142', '2.0', consent, false)) ->> 'ref' is null then raise exception 'FAIL paid restart'; end if; c := c + 1;
  -- rate limit
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);
  for n in 1 .. 30 loop perform public.billing_checkout_start('FR_PRO', '3125550199', '2.0', consent, true); end loop;
  begin perform public.billing_checkout_start('FR_PRO', '3125550199', '2.0', consent, true); raise exception 'FAIL no rate limit';
  exception when sqlstate 'P0001' then if sqlerrm <> 'too_many_checkouts' then raise; end if; end; c := c + 1;

  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  raise exception 'PADDLE_TESTS_PASSED % checks', c;
end $$;
