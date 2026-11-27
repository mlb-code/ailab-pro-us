-- Paddle: link transactions that arrived before their subscription row (promise-vs-reality audit 2026-11-27, row 14).
--
-- Cause: public.billing_paddle_transaction (20261126100000_us_paddle.sql) looks the subscription up by Paddle's
-- subscription id at the moment transaction.completed arrives. Paddle does not guarantee webhook order, and at sign-up
-- transaction.completed is often processed BEFORE subscription.created has written public.subscriptions. The transaction
-- is then stored with client_id = null ("recorded_unlinked") and nothing ever came back to it, so:
--   * the $0 trial transaction stays unlinked (harmless: $0 never starts the money-back window);
--   * a paid start ("Start paid plan", no trial): the first charge never sets subscriptions.first_paid_at, and the
--     30-day money-back button refuses (money_back_window_closed) although the customer paid.
--
-- Fix: public.billing_paddle_link_transactions(p_subscription_id), called by paddle-webhook after every applied
-- subscription event (idempotent): stamps client_id on that subscription's unlinked transactions and, while
-- first_paid_at is still empty, sets it from the earliest completed / paid transaction with a charge > 0 (its billed_at,
-- else when we received it). billing_paddle_transaction itself is unchanged (same signature, same rules).
set check_function_bodies = off;

create or replace function public.billing_paddle_link_transactions(p_subscription_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; t private.paddle_transactions; n int := 0; v_first boolean := false;
begin
  perform private.require_service();
  if p_subscription_id is null then return jsonb_build_object('linked', 0, 'first_paid', false); end if;
  select * into s from public.subscriptions x where x.provider = 'paddle' and x.provider_subscription_id = p_subscription_id for update;
  if s.id is null then return jsonb_build_object('linked', 0, 'first_paid', false); end if;
  update private.paddle_transactions set client_id = s.client_id, updated_at = now()
   where provider_subscription_id = p_subscription_id and client_id is null;
  get diagnostics n = row_count;
  if s.first_paid_at is null then
    select * into t from private.paddle_transactions x
     where x.provider_subscription_id = p_subscription_id and x.status in ('completed', 'paid') and coalesce(x.total_cents, 0) > 0
     order by coalesce(x.billed_at, x.created_at), x.created_at, x.transaction_id limit 1;
    if t.transaction_id is not null then
      update public.subscriptions set first_paid_at = coalesce(t.billed_at, t.created_at),
             first_paid_transaction_id = left(t.transaction_id, 120)
       where id = s.id and first_paid_at is null;
      v_first := found;
    end if;
  end if;
  if n > 0 or v_first then
    perform private.log_event('client', s.client_id, null, 'paddle_transactions_linked',
      jsonb_build_object('subscription', left(p_subscription_id, 120), 'linked', n, 'first_paid', v_first), false);
  end if;
  return jsonb_build_object('linked', n, 'first_paid', v_first, 'client_id', s.client_id);
end $$;

revoke all on function public.billing_paddle_link_transactions(text) from public, anon, authenticated;
grant execute on function public.billing_paddle_link_transactions(text) to service_role;
