-- FirstRing sign-up and cancellation e-mails (2026-11-26). Additive and idempotent; earlier migrations are not edited.
--
-- Until now a new subscriber got only the payment provider's receipt, and Meir got nothing. Now, once per subscription row:
--   trial_welcome            client (transactional): the subscription row was created 'trialing' (trial end, trial minutes,
--                            first charge, cancel before the trial ends, the one next step = the setup checklist)
--   plan_welcome             client (transactional): the row was created 'active' (paid sign-up without a trial)
--   admin_new_subscription   Meir (Hebrew): every new trialing / active row (business, plan, trial or paid, phone, e-mail)
--   admin_subscription_canceled  Meir (Hebrew): cancel_at_period_end turned on ('scheduled', once a day per subscription),
--                            or the row became 'canceled' without a scheduled cancel before it ('ended', once per subscription)
-- Where: an AFTER trigger on public.subscriptions, so every path is covered (Paddle webhook -> billing_upsert_subscription,
-- the mock provider, admin writes) and the e-mail can never block the subscription write (enqueue_email_safe + a guard).
-- Only INSERT queues the welcome mails: rows that existed before this migration never get one.
-- Idem keys: trial_welcome:<sub> | plan_welcome:<sub> | admin_new_subscription:<sub> |
--            admin_subscription_canceled:<sub>:scheduled:<YYYYMMDD> | admin_subscription_canceled:<sub>:ended
-- Send-time rules (private.email_context): the client mails are skipped for a returning customer (an older subscription
-- exists: subscription_restored already tells them), a duplicate trial (the number is held, Meir decides), or a status that
-- moved on before the dispatcher ran. Client mails are transactional: not gated by private.settings.client_emails_enabled.
set check_function_bodies = off;

-- ================================================================ templates the outbox accepts
create or replace function private.email_templates() returns text[]
language sql immutable set search_path = '' as $$
  select array['lead_capture', 'q_received', 'admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring',
               'quote' || '_accepted', 'admin_quote' || '_accepted', 'deposit_received', 'onboarding_nudge', 'need_help',
               'ready_to_test', 'final_payment_due', 'went_live', 'request_update', 'monthly_invoice', 'task:draft_quote',
               'web_deposit_link_requested', 'web_deposit_ack', 'request_cancelled', 'admin_request_cancelled',
               'payment_receipt', 'admin_payment_received', 'admin_paypal_alert', 'admin_upwork_requested',
               'subscription_message_mode', 'subscription_restored', 'admin_provisioning_alert', 'admin_billing_request',
               'trial_ending', 'trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled']
$$;

-- ================================================================ the trigger
create or replace function private.subscriptions_emails() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid; pl jsonb;
begin
  begin
    select c.user_id into uid from public.clients c where c.id = new.client_id;
    pl := jsonb_build_object('subscription_id', new.id);
    if tg_op = 'INSERT' then
      if new.status in ('trialing', 'active') then
        if new.status = 'trialing' then
          perform private.enqueue_email_safe('trial_welcome', 'trial_welcome:' || new.id, 'client', new.client_id, uid, pl);
        else
          perform private.enqueue_email_safe('plan_welcome', 'plan_welcome:' || new.id, 'client', new.client_id, uid, pl);
        end if;
        perform private.enqueue_email_safe('admin_new_subscription', 'admin_new_subscription:' || new.id, 'client', new.client_id, uid, pl);
      end if;
    elsif new.cancel_at_period_end and not old.cancel_at_period_end and new.status <> 'canceled' then
      perform private.enqueue_email_safe('admin_subscription_canceled',
        'admin_subscription_canceled:' || new.id || ':scheduled:' || to_char(now(), 'YYYYMMDD'), 'client', new.client_id, uid,
        pl || jsonb_build_object('kind', 'scheduled', 'from', new.status));
    elsif new.status = 'canceled' and old.status <> 'canceled' and not old.cancel_at_period_end then
      -- a cancel that was scheduled first was already announced ('scheduled'); this is the immediate one
      perform private.enqueue_email_safe('admin_subscription_canceled', 'admin_subscription_canceled:' || new.id || ':ended',
        'client', new.client_id, uid, pl || jsonb_build_object('kind', 'ended', 'from', old.status));
    end if;
  exception when others then
    begin
      perform private.log_event('client', new.client_id, uid, 'email_enqueue_error',
        jsonb_build_object('template', 'subscriptions_emails', 'error', left(sqlerrm, 300)), false);
    exception when others then null;
    end;
  end;
  return null;
end $$;
drop trigger if exists subscriptions_emails on public.subscriptions;
create trigger subscriptions_emails after insert or update of status, cancel_at_period_end on public.subscriptions
  for each row execute function private.subscriptions_emails();

-- ================================================================ render context
-- Same as 20261125100000_us_subscriptions.sql (the latest version), plus: the four templates above in the client branch, their
-- subscription row from payload.subscription_id (id, period start, trial_duplicate, created_at; Meir's mails also the business
-- phone and `returning`), and the send-time skips for the client mails (returning_client, trial_duplicate, status_moved).
create or replace function private.email_context(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o private.email_outbox; s private.settings; p public.profiles; q public.quotes; qn public.questionnaires;
  cl public.clients; pay public.payments; rq public.requests; it public.onboarding_items; ld public.leads;
  ctx jsonb := '{}'::jsonb; uid uuid; tw text; n_total int := 0; n_done int := 0; left_titles jsonb := '[]'::jsonb;
  acc text := 'quote' || '_accepted'; v_pid text; v_method text; sub public.subscriptions; svc text; svr text;
  v_sid text; older boolean := false;
  started constant text[] := array['trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled'];
begin
  select * into o from private.email_outbox where id = p_id;
  if not found then return jsonb_build_object('skip', 'outbox_missing'); end if;
  select * into s from private.settings where id = 1;
  uid := o.user_id;

  if o.template in ('admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring', acc, 'admin_' || acc, 'admin_upwork_requested') then
    select * into q from public.quotes where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'quote_missing'); end if;
    if q.anonymized or q.status = 'void' then return jsonb_build_object('skip', 'quote_void'); end if;
    if o.template in ('quote_reminder', 'quote_expiring') and q.status not in ('sent', 'viewed') then
      return jsonb_build_object('skip', 'quote_closed');
    end if;
    if o.template = 'quote_sent' and q.status not in ('sent', 'viewed', 'accepted') then
      return jsonb_build_object('skip', 'quote_not_sent');
    end if;
    uid := coalesce(q.user_id, uid);
    select * into qn from public.questionnaires where id = q.questionnaire_id;
    ctx := ctx || jsonb_build_object(
      'quote', to_jsonb(q) - 'accepted_ip' - 'accepted_ua' - 'agreement_hash',
      'offer', qn.offer, 'niche', qn.niche,
      'review', (select jsonb_build_object('risk_flags', r.risk_flags, 'manual_reasons', r.manual_reasons,
                                           'questions', r.questions_for_client)
                   from public.quote_reviews r where r.quote_id = q.id));
  elsif o.template in ('q_received', 'task:draft_quote', 'web_deposit_link_requested', 'web_deposit_ack') then
    select * into qn from public.questionnaires where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'questionnaire_missing'); end if;
    uid := coalesce(qn.user_id, uid);
    ctx := ctx || jsonb_build_object(
      'questionnaire', jsonb_build_object('id', qn.id, 'offer', qn.offer, 'niche', qn.niche, 'status', qn.status,
        'summary', case when o.template = 'web_deposit_link_requested' then qn.summary end),
      'has_quote', exists (select 1 from public.quotes x where x.questionnaire_id = qn.id and x.status <> 'void'));
  elsif o.template in ('deposit_received', 'onboarding_nudge', 'ready_to_test', 'went_live', 'monthly_invoice', 'final_payment_due',
                       'subscription_message_mode', 'subscription_restored', 'admin_provisioning_alert', 'admin_billing_request',
                       'trial_ending', 'trial_welcome', 'plan_welcome', 'admin_new_subscription', 'admin_subscription_canceled') then
    select * into cl from public.clients where id = o.entity_id;
    if not found or cl.anonymized_at is not null then return jsonb_build_object('skip', 'client_missing'); end if;
    if o.template = 'final_payment_due' and cl.billing_mode = 'subscription' then return jsonb_build_object('skip', 'subscription_client'); end if;
    if o.template = 'final_payment_due' then
      -- the final payment row if Meir created it, else the balance of the accepted quote (setup - deposit)
      select * into pay from public.payments x where x.client_id = cl.id and x.kind = 'final' order by x.created_at desc limit 1;
      if pay.id is not null and pay.status <> 'due' then return jsonb_build_object('skip', 'already_paid'); end if;
      if pay.id is null then
        select * into q from public.quotes where id = cl.quote_id;
        if q.id is null or q.setup_cents is null or q.deposit_cents is null then
          return jsonb_build_object('skip', 'amount_unknown');
        end if;
        ctx := ctx || jsonb_build_object('final_cents', q.setup_cents - q.deposit_cents);
      end if;
    end if;
    if o.template = 'deposit_received' then
      -- the deposit row that was marked paid (payments_to_outbox payload), so the mail knows how it was paid
      v_pid := o.payload ->> 'payment_id';
      if v_pid ~ '^[0-9a-fA-F-]{36}$' then
        select * into pay from public.payments x where x.id = v_pid::uuid and x.client_id = cl.id;
      end if;
      if pay.id is null then
        select * into pay from public.payments x where x.client_id = cl.id and x.kind = 'deposit'
         order by (x.status = 'paid') desc, x.created_at desc limit 1;
      end if;
    end if;
  elsif o.template in ('payment_receipt', 'admin_payment_received', 'admin_paypal_alert') then
    if o.entity_id is not null then select * into pay from public.payments x where x.id = o.entity_id; end if;
    if pay.id is null and o.template <> 'admin_paypal_alert' then return jsonb_build_object('skip', 'payment_missing'); end if;
    if o.template <> 'admin_paypal_alert' and pay.status = 'due' then return jsonb_build_object('skip', 'not_paid'); end if;
    if pay.id is not null then
      select * into cl from public.clients c where c.id = pay.client_id;
      if cl.id is not null and cl.anonymized_at is not null then return jsonb_build_object('skip', 'client_missing'); end if;
      if cl.id is not null then select * into q from public.quotes x where x.id = cl.quote_id; end if;
      if q.id is not null then
        ctx := ctx || jsonb_build_object('quote', to_jsonb(q) - 'accepted_ip' - 'accepted_ua' - 'agreement_hash');
      end if;
    end if;
  elsif o.template in ('request_cancelled', 'admin_request_cancelled') then
    ctx := ctx || jsonb_build_object('request', jsonb_build_object('id', o.entity_id, 'title', coalesce(o.payload ->> 'title', ''),
                                                                   'status', 'cancelled', 'admin_reply', null));
  elsif o.template = 'request_update' then
    select * into rq from public.requests where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'request_missing'); end if;
    select * into cl from public.clients where id = rq.client_id;
  elsif o.template = 'need_help' then
    select * into it from public.onboarding_items where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'item_missing'); end if;
    if it.status <> 'need_help' then return jsonb_build_object('skip', 'help_resolved'); end if;
    select * into cl from public.clients where id = it.client_id;
  elsif o.template = 'lead_capture' then
    select * into ld from public.leads where id = o.entity_id;
    if not found then return jsonb_build_object('skip', 'lead_missing'); end if;
    if exists (select 1 from public.profiles pp join public.questionnaires qq on qq.user_id = pp.id
                where lower(pp.email) = lower(ld.email) and qq.status <> 'draft') then
      return jsonb_build_object('skip', 'already_started');
    end if;
    ctx := ctx || jsonb_build_object('to', ld.email, 'lead', jsonb_build_object('niche', ld.niche, 'source_page', ld.source_page));
  end if;

  if cl.id is not null then
    uid := coalesce(cl.user_id, uid);
    select t.twilio_number, t.config #>> '{plan,service}', t.config #>> '{plan,service_reason}' into tw, svc, svr
      from public.tenants t where t.client_id = cl.id order by t.created_at limit 1;
    select count(*), count(*) filter (where i.status = 'done') into n_total, n_done
      from public.onboarding_items i where i.client_id = cl.id;
    select coalesce(jsonb_agg(x.title order by x.sort, x.created_at), '[]'::jsonb) into left_titles
      from (select i.title, i.sort, i.created_at from public.onboarding_items i
             where i.client_id = cl.id and i.status <> 'done' order by i.sort, i.created_at limit 5) x;
    if o.template = 'onboarding_nudge' and (cl.status <> 'onboarding' or n_total - n_done <= 0) then
      return jsonb_build_object('skip', 'nothing_left');
    end if;
    if o.template = 'ready_to_test' and cl.status <> 'testing' then return jsonb_build_object('skip', 'status_moved'); end if;
    if o.template = 'went_live' and cl.status <> 'live' then return jsonb_build_object('skip', 'status_moved'); end if;
    if o.template = 'monthly_invoice' and cl.status <> 'live' then return jsonb_build_object('skip', 'not_live'); end if;
    if o.template = 'monthly_invoice' and cl.billing_mode = 'subscription' then return jsonb_build_object('skip', 'subscription_client'); end if;
    if o.template = 'subscription_message_mode' and coalesce(svc, 'full') <> 'message_only' then return jsonb_build_object('skip', 'service_restored'); end if;
    if o.template = 'subscription_restored' and coalesce(svc, 'full') <> 'full' then return jsonb_build_object('skip', 'service_changed'); end if;
    if o.template = 'trial_ending' and (private.client_sub(cl.id)).status is distinct from 'trialing' then
      return jsonb_build_object('skip', 'trial_over');
    end if;
    -- sign-up / cancellation mails: the subscription row they were queued for (payload.subscription_id)
    if o.template = any (started) then
      v_sid := o.payload ->> 'subscription_id';
      if v_sid ~ '^[0-9a-fA-F-]{36}$' then
        select * into sub from public.subscriptions x where x.id = v_sid::uuid and x.client_id = cl.id;
      end if;
      if sub.id is null then return jsonb_build_object('skip', 'subscription_missing'); end if;
      older := exists (select 1 from public.subscriptions x where x.client_id = cl.id and x.id <> sub.id and x.created_at < sub.created_at);
      if o.template in ('trial_welcome', 'plan_welcome') then
        -- a returning customer gets subscription_restored (full answering back) instead of a second welcome
        if older then return jsonb_build_object('skip', 'returning_client'); end if;
        -- second trial for the same business phone: the number is held and Meir decides (admin_provisioning_alert)
        if sub.trial_duplicate then return jsonb_build_object('skip', 'trial_duplicate'); end if;
        if o.template = 'trial_welcome' and sub.status <> 'trialing' then return jsonb_build_object('skip', 'status_moved'); end if;
        if o.template = 'plan_welcome' and sub.status <> 'active' then return jsonb_build_object('skip', 'status_moved'); end if;
      end if;
    end if;
    ctx := ctx || jsonb_build_object(
      'client', jsonb_build_object('id', cl.id, 'status', cl.status, 'products', to_jsonb(cl.products),
                                   'monthly_cents', cl.monthly_cents, 'business_name', cl.business_name,
                                   'go_live_at', cl.go_live_at, 'next_bill_on', cl.next_bill_on, 'billing_mode', cl.billing_mode),
      'tenant_number', tw,
      'onboarding', jsonb_build_object('total', n_total, 'done', n_done, 'left', n_total - n_done, 'left_titles', left_titles));
    if cl.billing_mode = 'subscription' then
      if sub.id is null then sub := private.client_sub(cl.id); end if;
      ctx := ctx || jsonb_build_object('subscription', jsonb_build_object('plan_code', sub.plan_code, 'status', sub.status,
        'trial_ends_at', sub.trial_ends_at, 'current_period_end', sub.current_period_end, 'cancel_at_period_end', sub.cancel_at_period_end,
        'ends_at', sub.ends_at, 'provider', sub.provider, 'service', coalesce(svc, 'full'), 'service_reason', coalesce(svr, ''),
        'reason', coalesce(o.payload ->> 'reason', svr, ''))
        || case when o.template = any (started) then jsonb_build_object('id', sub.id, 'current_period_start', sub.current_period_start,
             'trial_duplicate', sub.trial_duplicate, 'created_at', sub.created_at) else '{}'::jsonb end
        -- the business phone and the returning flag only in Meir's mails
        || case when o.template = any (started) and o.audience = 'admin' then jsonb_build_object('business_phone', sub.business_phone,
             'returning', older) else '{}'::jsonb end);
    end if;
  end if;
  if pay.id is not null then
    ctx := ctx || jsonb_build_object('payment', jsonb_build_object('id', pay.id, 'kind', pay.kind, 'amount_cents', pay.amount_cents,
      'method', pay.method, 'status', pay.status, 'provider', pay.provider, 'provider_capture_id', pay.provider_capture_id,
      'paid_at', pay.paid_at)
      || case when o.audience = 'admin' then jsonb_build_object('payer_email', pay.payer_email) else '{}'::jsonb end);
  end if;
  if rq.id is not null then
    ctx := ctx || jsonb_build_object('request', jsonb_build_object('id', rq.id, 'title', rq.title, 'status', rq.status,
                                                                   'admin_reply', rq.admin_reply));
  end if;
  if it.id is not null then
    ctx := ctx || jsonb_build_object('item', jsonb_build_object('id', it.id, 'key', it.key, 'title', it.title, 'status', it.status,
      'message', left(coalesce(it.data ->> 'help_message', it.data ->> 'message', it.data ->> 'note', ''), 2000)));
  end if;
  -- the payment rail of this mail: the quote's, else the payment row's, else the client's quote, else the questionnaire's
  -- live quote; null = none yet (the template then uses the brand.json default: PayPal checkout when on, else Upwork)
  v_method := coalesce(q.pay_method::text, pay.method,
    case when cl.id is not null then (select x.pay_method::text from public.quotes x where x.id = cl.quote_id) end,
    case when qn.id is not null then (select x.pay_method::text from public.quotes x
                                       where x.questionnaire_id = qn.id and x.status <> 'void' order by x.created_at desc limit 1) end);
  ctx := ctx || jsonb_build_object('pay_method', v_method);

  if uid is not null then select * into p from public.profiles where id = uid; end if;
  ctx := ctx || jsonb_build_object('profile', jsonb_build_object(
    'full_name', p.full_name, 'company', p.company, 'email', coalesce(nullif(btrim(p.contact_email), ''), p.email),
    'signin_email', p.email, 'phone', p.phone, 'city', p.city, 'state', p.state,
    'update_lang', p.update_lang));
  ctx := ctx || jsonb_build_object('to', case o.audience
    when 'admin' then nullif(btrim(s.admin_email), '')
    when 'client' then coalesce(ctx ->> 'to', nullif(btrim(p.contact_email), ''), nullif(btrim(p.email), ''))
    else null end);
  return ctx;
end $$;

revoke all on function private.subscriptions_emails() from public, anon, authenticated;
