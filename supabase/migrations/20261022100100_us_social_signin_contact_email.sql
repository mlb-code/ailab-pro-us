-- 22.10.2026: social sign-in (Google / Apple) in the client portal. One person = one auth user id: Supabase links a
-- Google/Apple identity whose verified e-mail matches an existing user to that user (same profile, quotes, portal).
-- Apple "Hide My Email" gives a relay address (…@privaterelay.appleid.com) as the sign-in e-mail; the portal then asks
-- once for a contact e-mail, stored here, and every client e-mail goes to it. profiles.email stays the auth address
-- (admin lookups, is_admin), records stay keyed by user id. Quotes already sent to a real address keep working: the
-- quote page is opened by its public token, not by e-mail.
set check_function_bodies = off;

alter table public.profiles add column if not exists contact_email text;
comment on column public.profiles.contact_email is 'Where client e-mails go when the sign-in address is a relay (Apple Hide My Email); null = use email. Client-editable (profiles_guard normalises + validates).';

-- profiles_guard: as in the schema migration, plus the contact_email rule
create or replace function private.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.is_client_call() then
    if tg_op = 'INSERT' then
      new.id := auth.uid();
      new.is_admin := false;
      new.email := coalesce((select u.email from auth.users u where u.id = auth.uid()), '');
      new.created_at := now();
    else
      new.id := old.id;
      new.is_admin := old.is_admin;
      new.email := old.email;
      new.created_at := old.created_at;
    end if;
  end if;
  if new.timezone is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'invalid_timezone' using errcode = 'P0001';
  end if;
  -- contact e-mail (22.10.2026, social sign-in): normalised; must be a real address, never an Apple relay address
  new.contact_email := nullif(lower(btrim(new.contact_email)), '');
  if new.contact_email is not null and (new.contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
                                        or new.contact_email like '%@privaterelay.appleid.com') then
    raise exception 'invalid_contact_email' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function private.profiles_guard();

-- email_context: client mails go to the contact e-mail when set; templates see "email" = contact and "signin_email" = auth
create or replace function private.email_context(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o private.email_outbox; s private.settings; p public.profiles; q public.quotes; qn public.questionnaires;
  cl public.clients; pay public.payments; rq public.requests; it public.onboarding_items; ld public.leads;
  ctx jsonb := '{}'::jsonb; uid uuid; tw text; n_total int := 0; n_done int := 0; left_titles jsonb := '[]'::jsonb;
  acc text := 'quote' || '_accepted'; v_pid text; v_method text;
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
  elsif o.template in ('deposit_received', 'onboarding_nudge', 'ready_to_test', 'went_live', 'monthly_invoice', 'final_payment_due') then
    select * into cl from public.clients where id = o.entity_id;
    if not found or cl.anonymized_at is not null then return jsonb_build_object('skip', 'client_missing'); end if;
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
    select t.twilio_number into tw from public.tenants t where t.client_id = cl.id order by t.created_at limit 1;
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
    ctx := ctx || jsonb_build_object(
      'client', jsonb_build_object('id', cl.id, 'status', cl.status, 'products', to_jsonb(cl.products),
                                   'monthly_cents', cl.monthly_cents, 'business_name', cl.business_name,
                                   'go_live_at', cl.go_live_at, 'next_bill_on', cl.next_bill_on),
      'tenant_number', tw,
      'onboarding', jsonb_build_object('total', n_total, 'done', n_done, 'left', n_total - n_done, 'left_titles', left_titles));
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
