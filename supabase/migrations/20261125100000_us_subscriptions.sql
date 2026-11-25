-- FirstRing monthly plans (owner decision 2026-11-25): sign up -> live within hours, no manual step by the owner.
-- Additive and idempotent. Provider-agnostic: the payment phase (Paddle, merchant of record) calls ONE function,
-- public.billing_upsert_subscription(...), from its webhook; a mock provider path (public.billing_mock_checkout and the
-- client billing RPCs) is used by the local mock backend and the tests, and is OFF unless private.settings.billing_mock_enabled.
--
--   public.subscriptions      one row per client subscription: plan_code, status (trialing|active|past_due|paused|canceled),
--                             trial / period dates, cancel_at_period_end, scheduled_plan_code (downgrade at period end),
--                             card_on_file, provider ('mock'|'paddle'|'manual') + provider ids. RLS: the client reads its own,
--                             the admin reads/writes, the service role writes (webhook). Every write re-syncs the client.
--   private.trial_claims      one free trial per business phone number (E.164).
--   public.provisioning_jobs  work for the runtime cron (/jobs/tick): 'number' (buy the Twilio number; dry run unless
--                             TWILIO_PROVISION_LIVE=1 in the runtime) and 'golive_sim' (simulator checks on the real config).
--                             Admin-only read; the runtime (service role) updates them; a trigger acts on the result.
--   provisioning              on trialing/active: client card (billing_mode 'subscription'), tenant (slug, sandbox, config
--                             built from the sign-up profile: business name, niche, trade, time zone from the profile or the
--                             area code, main phone, alert e-mail), the subscription checklist, the number job. Safe to retry.
--   config.plan               written ONLY here (tenants trigger): code, status, period, service 'full'|'message_only' +
--                             reason. The runtime reads minutes and features from the price book by code (app/plans.py).
--   service mode              message_only when the trial ended unpaid, cancelled (after the paid period), past due beyond
--                             private.settings.past_due_grace_days, or paused. The line keeps answering (short message flow);
--                             the client gets an e-mail (subscription_message_mode / subscription_restored). Hourly cron.
--   checklist                 subscription order: hours, services & FAQ, alerts, calendar, (tools), forward calls last,
--                             (texting registration, optional). Every save merges into tenants.config at once
--                             (private.onboarding_apply, same checks as the schema; bad input -> invalid_setting:<path>).
--   go-live                   EIN / texting no longer gates go-live (all clients). Calendar step done only with a connected
--                             calendar (credential) or the explicit "take messages only" choice. The forwarding test passes
--                             only for a call forwarded FROM the business line (calls.forwarded_from = business.main_phone),
--                             or after the client confirms a call that arrived without carrier data. Checklist complete ->
--                             client 'testing' + golive_sim job -> passed + subscription trialing/active -> client and tenant
--                             'live' (ready_to_test + went_live e-mails). No final payment for subscription clients.
--   usage                     plan clients are metered per billing period: runtime_state usage:<tenant>:p<YYYY-MM-DD>:...
--                             (client_billing() returns this period's minutes; admin_tenant_usage() adds them to the month).
set check_function_bodies = off;

-- ================================================================ settings + columns
alter table private.settings add column if not exists billing_mock_enabled boolean not null default false;
alter table private.settings add column if not exists past_due_grace_days int not null default 7;
alter table private.settings add column if not exists trial_end_grace_hours int not null default 12;

alter table public.clients add column if not exists billing_mode text not null default 'quote';
alter table public.clients add column if not exists billing_paused boolean not null default false;
do $$ begin
  alter table public.clients add constraint clients_billing_mode_check check (billing_mode in ('quote', 'subscription'));
exception when duplicate_object then null; end $$;

-- Twilio's ForwardedFrom (the line that forwarded the call); written by the runtime (app/voice.py)
alter table public.calls add column if not exists forwarded_from text check (length(forwarded_from) <= 20);

-- ================================================================ tables
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  plan_code text not null check (plan_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  scheduled_plan_code text check (scheduled_plan_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled')),
  provider text not null check (provider in ('mock', 'paddle', 'manual')),
  provider_subscription_id text not null check (length(provider_subscription_id) between 3 and 120),
  provider_customer_id text check (length(provider_customer_id) <= 120),
  card_on_file boolean not null default false,
  trial_began_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ends_at timestamptz,
  past_due_since timestamptz,
  paused_at timestamptz,
  business_phone text check (business_phone ~ '^\+1[2-9][0-9]{9}$'),
  trial_duplicate boolean not null default false,
  last_event_at timestamptz,
  money_back_used_at timestamptz,   -- the 30-day money-back on the first paid month (once per business), set by the admin
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
alter table public.subscriptions add column if not exists money_back_used_at timestamptz;
create index if not exists subscriptions_client_idx on public.subscriptions (client_id, created_at desc);

create table if not exists private.trial_claims (
  phone text primary key check (phone ~ '^\+1[2-9][0-9]{9}$'),
  client_id uuid,
  user_id uuid,
  subscription_id uuid,
  claimed_at timestamptz not null default now(),
  money_back_used_at timestamptz   -- once per business: also kept here, by business phone
);
alter table private.trial_claims add column if not exists money_back_used_at timestamptz;

create table if not exists public.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  kind text not null check (kind in ('number', 'golive_sim')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'held')),
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (length(last_error) <= 500),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object' and octet_length(result::text) < 50000),
  dry_run boolean not null default false,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, kind)
);

alter table public.subscriptions enable row level security;
alter table public.provisioning_jobs enable row level security;
alter table private.trial_claims enable row level security;
revoke all on public.subscriptions, public.provisioning_jobs from public, anon, authenticated;
revoke all on private.trial_claims from public, anon, authenticated;
grant select, insert, update, delete on public.subscriptions to authenticated;   -- writes: admin only (policy)
grant select on public.provisioning_jobs to authenticated;                       -- admin only (policy)
grant all on public.subscriptions, public.provisioning_jobs, private.trial_claims to service_role;

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists subscriptions_admin_write on public.subscriptions;
create policy subscriptions_admin_write on public.subscriptions for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists provisioning_jobs_admin_select on public.provisioning_jobs;
create policy provisioning_jobs_admin_select on public.provisioning_jobs for select to authenticated
  using ((select private.is_admin()));

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function private.touch_updated_at();
drop trigger if exists provisioning_jobs_touch on public.provisioning_jobs;
create trigger provisioning_jobs_touch before update on public.provisioning_jobs
  for each row execute function private.touch_updated_at();

-- ================================================================ helpers
create or replace function private.us_e164(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p is null then null
    when btrim(p) ~ '^\+' and regexp_replace(p, '\D', '', 'g') ~ '^1[2-9][0-9]{9}$' then '+' || regexp_replace(p, '\D', '', 'g')
    when regexp_replace(p, '\D', '', 'g') ~ '^[2-9][0-9]{9}$' then '+1' || regexp_replace(p, '\D', '', 'g')
    when regexp_replace(p, '\D', '', 'g') ~ '^1[2-9][0-9]{9}$' then '+' || regexp_replace(p, '\D', '', 'g')
  end
$$;

-- Plan order for upgrade (now) vs downgrade (next period). Codes only; prices and minutes live in the price book.
create or replace function private.plan_rank(p_code text) returns int
language sql immutable set search_path = '' as $$
  select case p_code when 'FR_STARTER' then 1 when 'FR_PRO' then 2 when 'FR_BUSINESS' then 3 else 99 end
$$;

-- Time zone of a NANP area code. Same table as runtime/app/area_codes.py (runtime/tests/test_subscriptions_sql_sync.py
-- checks that both say the same).
create or replace function private.area_code_tz(p_e164 text) returns text
language plpgsql immutable set search_path = '' as $$
declare v_ac text := substring(coalesce(p_e164, '') from '^\+1([2-9][0-9]{2})[2-9][0-9]{6}$');
begin
  if v_ac is null then return null; end if;
  return case
    when v_ac = any(array['203','475','860','959','302','202','771','239','305','321','324','352','386','407','448','561','645','656','689','727','728','754','772','786','813','850','863','904','941','954','229','404','470','478','678','706','762','770','912','943','207','227','240','301','410','443','667','339','351','413','508','617','774','781','857','978','603','201','551','609','640','732','848','856','862','908','973','212','315','329','332','347','363','516','518','585','607','624','631','646','680','716','718','838','845','914','917','929','934','252','336','472','704','743','828','910','919','980','984','216','220','234','283','326','330','380','419','436','440','513','567','614','740','937','215','223','267','272','412','445','484','570','582','610','717','724','814','835','878','401','803','821','839','843','854','864','802','276','434','540','571','686','703','757','804','826','948','304','681','502','606','859','423','865']) then 'America/New_York'
    when v_ac = any(array['231','248','269','313','517','586','616','679','734','810','906','947','989']) then 'America/Detroit'
    when v_ac = any(array['260','317','463','574','765','812','930']) then 'America/Indiana/Indianapolis'
    when v_ac = any(array['205','251','256','334','483','659','938','327','479','501','870','217','224','309','312','331','447','464','618','630','708','730','773','779','815','847','861','872','319','515','563','641','712','219','316','620','785','913','270','364','225','318','337','504','985','218','320','507','612','651','763','924','952','228','601','662','769','314','417','557','573','636','660','816','975','308','402','531','701','405','539','572','580','918','605','615','629','731','901','931','210','214','254','281','325','346','361','409','430','432','469','512','682','713','726','737','806','817','830','832','903','936','940','945','956','972','979','262','274','353','414','534','608','715','920']) then 'America/Chicago'
    when v_ac = any(array['303','719','720','970','983','406','505','575','385','435','801','307','915']) then 'America/Denver'
    when v_ac = any(array['208','986']) then 'America/Boise'
    when v_ac = any(array['480','520','602','623','928']) then 'America/Phoenix'
    when v_ac = any(array['209','213','279','310','323','341','350','369','408','415','424','442','510','530','559','562','619','626','628','650','657','661','669','707','714','747','760','805','818','820','831','840','858','909','916','925','949','951','702','725','775','458','503','541','971','206','253','360','425','509','564']) then 'America/Los_Angeles'
    when v_ac = any(array['907']) then 'America/Anchorage'
    when v_ac = any(array['808']) then 'Pacific/Honolulu'
    when v_ac = any(array['787','939','340']) then 'America/Puerto_Rico'
    when v_ac = any(array['416','647','437','905','289','365','742','613','343','519','226','548','705','249','807','514','438','450','579','819','873','418','581','367']) then 'America/Toronto'
    when v_ac = any(array['204','431']) then 'America/Winnipeg'
    when v_ac = any(array['306','639']) then 'America/Regina'
    when v_ac = any(array['403','587','825','780','368']) then 'America/Edmonton'
    when v_ac = any(array['604','778','236','250','672']) then 'America/Vancouver'
    when v_ac = any(array['902','782']) then 'America/Halifax'
    when v_ac = any(array['506']) then 'America/Moncton'
    when v_ac = any(array['709']) then 'America/St_Johns'
  end;
end $$;

create or replace function private.valid_tz(p text) returns boolean
language sql stable set search_path = '' as $$
  select p is not null and length(p) <= 64 and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p)
$$;

-- 'Cool Breeze HVAC' -> 'cool-breeze-hvac' (then -2, -3 ... when taken); matches the tenants.slug check
create or replace function private.unique_slug(p_name text) returns text
language plpgsql stable set search_path = '' as $$
declare base text; s text; n int := 1;
begin
  base := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-');
  base := left(base, 40);
  base := btrim(base, '-');
  if length(base) < 3 then base := 'fr-' || coalesce(nullif(base, ''), 'line'); end if;
  s := base;
  while exists (select 1 from public.tenants t where t.slug = s) loop
    n := n + 1;
    s := base || '-' || n;
  end loop;
  return s;
end $$;

-- service mode of a subscription now: (service 'full'|'message_only', reason)
create or replace function private.sub_service(sub public.subscriptions, p_now timestamptz default now())
returns table (service text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare st private.settings;
begin
  select * into st from private.settings where id = 1;
  if sub.id is null then service := 'full'; reason := ''; return next; return; end if;
  if sub.status = 'trialing' then
    if sub.trial_ends_at is not null and sub.trial_ends_at + make_interval(hours => coalesce(st.trial_end_grace_hours, 12)) < p_now then
      service := 'message_only'; reason := 'trial_ended';
    else service := 'full'; reason := ''; end if;
  elsif sub.status = 'active' then
    if sub.cancel_at_period_end and sub.current_period_end is not null and sub.current_period_end < p_now then
      service := 'message_only'; reason := 'canceled';
    else service := 'full'; reason := ''; end if;
  elsif sub.status = 'past_due' then
    if coalesce(sub.past_due_since, p_now) + make_interval(days => coalesce(st.past_due_grace_days, 7)) < p_now then
      service := 'message_only'; reason := 'past_due';
    else service := 'full'; reason := ''; end if;
  elsif sub.status = 'paused' then
    service := 'message_only'; reason := 'paused';
  else  -- canceled
    if coalesce(sub.ends_at, sub.canceled_at, p_now) <= p_now then
      service := 'message_only'; reason := 'canceled';
    else service := 'full'; reason := ''; end if;
  end if;
  return next;
end $$;

create or replace function private.client_sub(p_client uuid) returns public.subscriptions
language sql stable security definer set search_path = '' as $$
  select s.* from public.subscriptions s where s.client_id = p_client order by s.created_at desc limit 1
$$;

-- the config.plan block for a client's tenant (null = no subscription)
create or replace function private.plan_block(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sub public.subscriptions; sv record; ps timestamptz; pe timestamptz;
begin
  sub := private.client_sub(p_client);
  if sub.id is null then return null; end if;
  select * into sv from private.sub_service(sub);
  if sub.status = 'trialing' then
    ps := coalesce(sub.trial_began_at, sub.created_at); pe := sub.trial_ends_at;
  else
    ps := coalesce(sub.current_period_start, sub.trial_ends_at, sub.created_at); pe := sub.current_period_end;
  end if;
  return jsonb_build_object('code', sub.plan_code, 'status', sub.status,
    'trial_ends_at', sub.trial_ends_at, 'period_start', to_char(ps at time zone 'utc', 'YYYY-MM-DD"T"HH24MI'),  -- minute precision: a trial and a paid period started the same day never share a usage counter
    'period_end', pe, 'service', sv.service, 'service_reason', sv.reason);
end $$;

-- ================================================================ tenant config from the sign-up profile
create or replace function private.default_tenant_config(p_client uuid, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  cl public.clients; p public.profiles; q public.questionnaires; tz text; v_phone text; niche text; svc jsonb; trade text;
  email text;
begin
  select * into cl from public.clients where id = p_client;
  select * into p from public.profiles where id = cl.user_id;
  select * into q from public.questionnaires x where x.user_id = cl.user_id order by x.updated_at desc limit 1;
  v_phone := coalesce(private.us_e164(p_phone), private.us_e164(p.phone));
  tz := case when private.valid_tz(p.timezone) then p.timezone end;
  tz := coalesce(tz, private.area_code_tz(v_phone), 'America/New_York');
  niche := case when coalesce(q.niche::text, p.niche::text) = 'real_estate' then 'real_estate' else 'home_services' end;
  trade := left(btrim(coalesce(q.answers ->> 'trade', '')), 60);
  svc := case when jsonb_typeof(q.answers -> 'services') = 'array'
              then (select jsonb_agg(y) from (select left(btrim(x), 80) y from jsonb_array_elements_text(q.answers -> 'services') x
                     where btrim(x) <> '' limit 30) z) end;
  if svc is null or jsonb_array_length(svc) = 0 then
    svc := case niche when 'real_estate' then '["Buyer consultation", "Listing consultation", "Home showing"]'::jsonb
                      else jsonb_build_array(coalesce(nullif(trade, '') || ' service call', 'Service call'), 'Estimate') end;
  end if;
  email := lower(coalesce(nullif(btrim(p.contact_email), ''), nullif(btrim(p.email), '')));
  return jsonb_build_object(
    'business', jsonb_build_object('name', left(coalesce(nullif(btrim(cl.business_name), ''), nullif(btrim(p.company), ''),
                                                         nullif(btrim(p.full_name), ''), 'Your business'), 120),
                                   'niche', niche, 'trade', trade, 'timezone', tz, 'service_area_zips', '[]'::jsonb)
                || case when v_phone is not null then jsonb_build_object('main_phone', v_phone) else '{}'::jsonb end,
    'voice', jsonb_build_object('greeting', ''),  -- empty = the runtime greets with the business name + the call notice
    'hours', jsonb_build_object('mon', jsonb_build_array('08:00', '17:00'), 'tue', jsonb_build_array('08:00', '17:00'),
                                'wed', jsonb_build_array('08:00', '17:00'), 'thu', jsonb_build_array('08:00', '17:00'),
                                'fri', jsonb_build_array('08:00', '17:00'), 'sat', null, 'sun', null),
    'booking', jsonb_build_object('provider', 'calendly', 'enabled', true, 'job_types', svc,
                                  'windows', '[["08:00", "12:00"], ["12:00", "16:00"]]'::jsonb),
    'notify', jsonb_build_object('sms', '[]'::jsonb, 'email', case when email is not null then jsonb_build_array(email) else '[]'::jsonb end,
                                 'daily_summary', '19:00'),
    'paused', false);
end $$;

-- ================================================================ checklist (subscription order)
-- forward_calls comes LAST: the client sets up hours/FAQ/alerts/calendar first, tries the receptionist's number, and only
-- then forwards real customers (the site says the same: "You call it yourself, then turn on call forwarding").
create or replace function private.seed_onboarding_subscription(p_client uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0; k int; rec record;
begin
  for rec in select * from (values
      ('hours',         'Business hours',            1),
      ('faq',           'Services & FAQ',            2),
      ('alerts',        'Emergencies & alerts',      3),
      ('calendar',      'Connect your calendar',     4),
      ('tools',         'Connect other tools',       5),
      ('forward_calls', 'Forward your missed calls', 6),
      ('sms',           'Texting registration (optional, later)', 7)) as v(key, title, sort) loop
    insert into public.onboarding_items (client_id, key, title, sort) values (p_client, rec.key, rec.title, rec.sort)
    on conflict (client_id, key) do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end $$;

-- ================================================================ provisioning
create or replace function private.provision_client(p_sub uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sub public.subscriptions; cl public.clients; t public.tenants; p public.profiles; cfg jsonb;
begin
  select * into sub from public.subscriptions where id = p_sub;
  if not found then raise exception 'subscription_missing' using errcode = 'P0002'; end if;
  select * into cl from public.clients where id = sub.client_id for update;
  select * into p from public.profiles where id = cl.user_id;
  if cl.business_name is null and p.company is not null then
    update public.clients set business_name = left(p.company, 200) where id = cl.id returning * into cl;
  end if;
  select * into t from public.tenants x where x.client_id = cl.id order by x.created_at limit 1;
  if t.id is null then
    cfg := private.default_tenant_config(cl.id, sub.business_phone);
    insert into public.tenants (client_id, slug, status, config)
    values (cl.id, private.unique_slug(cfg #>> '{business,name}'), 'sandbox', cfg)
    returning * into t;
    perform private.log_event('tenant', t.id, cl.user_id, 'tenant_created', jsonb_build_object('slug', t.slug, 'auto', true), false);
  end if;
  perform private.seed_onboarding_subscription(cl.id);
  if t.twilio_number is null then
    insert into public.provisioning_jobs (tenant_id, client_id, kind, status, last_error)
    values (t.id, cl.id, 'number', case when sub.trial_duplicate then 'held' else 'pending' end,
            case when sub.trial_duplicate then 'duplicate_trial: this business phone already had a free trial' end)
    on conflict (tenant_id, kind) do update
      set status = case when excluded.status = 'held' then 'held'
                        when public.provisioning_jobs.status in ('failed', 'held') and not sub.trial_duplicate then 'pending'
                        else public.provisioning_jobs.status end,
          last_error = case when excluded.status = 'held' then excluded.last_error else public.provisioning_jobs.last_error end;
  end if;
  return jsonb_build_object('client_id', cl.id, 'tenant_id', t.id, 'slug', t.slug);
end $$;

-- client card + tenant plan block + client status follow the subscription (idempotent; every subscription write)
create or replace function private.sync_client_billing(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare sub public.subscriptions; sv record; cl public.clients;
begin
  sub := private.client_sub(p_client);
  if sub.id is null then return; end if;
  select * into sv from private.sub_service(sub);
  -- the tenants trigger recomputes config.plan (and sends the service-change e-mail) on this touch
  update public.tenants t set config = t.config where t.client_id = p_client
     and (t.config -> 'plan') is distinct from private.plan_block(p_client);
  select * into cl from public.clients where id = p_client;
  update public.clients c
     set next_bill_on = case when sub.status in ('active', 'trialing') then coalesce(sub.current_period_end, sub.trial_ends_at)::date end,
         status = case when sv.service = 'message_only' and c.status = 'live' then 'paused'::public.client_status
                       when sv.service = 'full' and c.status = 'paused' and c.billing_paused then 'live'::public.client_status
                       else c.status end,
         billing_paused = case when sv.service = 'message_only' and c.status = 'live' then true
                               when sv.service = 'full' and c.status = 'paused' and c.billing_paused then false
                               else c.billing_paused end
   where c.id = p_client
     and (c.next_bill_on is distinct from case when sub.status in ('active', 'trialing') then coalesce(sub.current_period_end, sub.trial_ends_at)::date end
          or (sv.service = 'message_only' and c.status = 'live') or (sv.service = 'full' and c.status = 'paused' and c.billing_paused));
  if sv.service = 'full' then perform private.try_go_live(p_client); end if;
end $$;

-- subscription + passed go-live check + complete checklist -> live (client and tenant). Idempotent.
create or replace function private.try_go_live(p_client uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare cl public.clients; sub public.subscriptions; sv record;
begin
  select * into cl from public.clients where id = p_client;
  if cl.billing_mode <> 'subscription' or cl.status <> 'testing' then return false; end if;
  sub := private.client_sub(p_client);
  if sub.id is null or sub.status not in ('trialing', 'active') then return false; end if;
  select * into sv from private.sub_service(sub);
  if sv.service <> 'full' then return false; end if;
  if not exists (select 1 from public.provisioning_jobs j join public.tenants t on t.id = j.tenant_id
                  where t.client_id = p_client and j.kind = 'golive_sim' and j.status = 'done'
                    and coalesce((j.result ->> 'passed')::boolean, false)) then return false; end if;
  if exists (select 1 from public.onboarding_items o where o.client_id = p_client and o.key not in ('tools', 'sms')
              and o.status <> 'done') then return false; end if;
  if not exists (select 1 from public.tenants t where t.client_id = p_client and t.twilio_number is not null) then return false; end if;
  update public.tenants set status = 'live' where client_id = p_client and status = 'sandbox';
  update public.clients set status = 'live' where id = p_client;
  perform private.log_event('client', p_client, cl.user_id, 'auto_go_live', jsonb_build_object('plan', sub.plan_code), true);
  return true;
end $$;

-- tenants: config.plan always comes from the subscription; a service change e-mails the client once
create or replace function private.tenant_plan_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare blk jsonb; old_sv text; new_sv text; sub public.subscriptions; cl public.clients;
begin
  select * into cl from public.clients where id = new.client_id;
  if cl.billing_mode is distinct from 'subscription' then return new; end if;
  blk := private.plan_block(new.client_id);
  if blk is null then return new; end if;
  new.config := coalesce(new.config, '{}'::jsonb) || jsonb_build_object('plan', blk);
  if tg_op = 'UPDATE' then
    old_sv := coalesce(old.config #>> '{plan,service}', 'full');
    new_sv := blk ->> 'service';
    sub := private.client_sub(new.client_id);
    if old_sv = 'full' and new_sv = 'message_only' then
      perform private.enqueue_email_safe('subscription_message_mode',
        'subscription_message_mode:' || sub.id || ':' || (blk ->> 'service_reason') || ':' || to_char(now(), 'YYYYMMDD'),
        'client', new.client_id, cl.user_id, jsonb_build_object('reason', blk ->> 'service_reason'));
      perform private.log_event('tenant', new.id, cl.user_id, 'service_message_only', jsonb_build_object('reason', blk ->> 'service_reason'), true);
    elsif old_sv = 'message_only' and new_sv = 'full' then
      perform private.enqueue_email_safe('subscription_restored', 'subscription_restored:' || sub.id || ':' || to_char(now(), 'YYYYMMDDHH24'),
        'client', new.client_id, cl.user_id);
      perform private.log_event('tenant', new.id, cl.user_id, 'service_restored', '{}'::jsonb, true);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tenants_plan_guard on public.tenants;
create trigger tenants_plan_guard before insert or update on public.tenants
  for each row execute function private.tenant_plan_guard();

create or replace function private.subscriptions_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.sync_client_billing(new.client_id);
  return null;
end $$;
drop trigger if exists subscriptions_after on public.subscriptions;
create trigger subscriptions_after after insert or update on public.subscriptions
  for each row execute function private.subscriptions_after();

-- ================================================================ THE contract for the payment phase
-- Idempotent upsert keyed by (provider, provider_subscription_id). Out-of-order webhooks: an event older than the last
-- applied one (p_event_at < last_event_at) changes nothing (stale = true). First event for a subscription needs p_user_id
-- (the signed-in user who started the checkout: Paddle custom_data). Plan change = a new p_plan_code (upgrade now) or
-- p_scheduled_plan_code (downgrade at period end). Cancel at period end = p_cancel_at_period_end; ended = status 'canceled'.
create or replace function private.upsert_subscription_core(
  p_provider text, p_provider_subscription_id text, p_status text, p_plan_code text, p_user_id uuid,
  p_provider_customer_id text, p_trial_ends_at timestamptz, p_current_period_start timestamptz,
  p_current_period_end timestamptz, p_cancel_at_period_end boolean, p_card_on_file boolean,
  p_scheduled_plan_code text, p_canceled_at timestamptz, p_event_at timestamptz, p_business_phone text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  sub public.subscriptions; cl public.clients; pr public.profiles; v_phone text; dup boolean := false; claim private.trial_claims;
  prov jsonb := null; is_new boolean := false; uid uuid;
begin
  if p_provider is null or p_provider not in ('mock', 'paddle', 'manual') then raise exception 'bad_provider' using errcode = 'P0001'; end if;
  if p_status is null or p_status not in ('trialing', 'active', 'past_due', 'paused', 'canceled') then
    raise exception 'bad_status' using errcode = 'P0001';
  end if;
  if p_plan_code is null or p_plan_code !~ '^[A-Z][A-Z0-9_]{1,40}$' then raise exception 'bad_plan_code' using errcode = 'P0001'; end if;
  if p_scheduled_plan_code is not null and p_scheduled_plan_code !~ '^[A-Z][A-Z0-9_]{1,40}$' then
    raise exception 'bad_plan_code' using errcode = 'P0001';
  end if;
  if coalesce(length(p_provider_subscription_id), 0) not between 3 and 120 then raise exception 'bad_subscription_id' using errcode = 'P0001'; end if;

  select * into sub from public.subscriptions s where s.provider = p_provider and s.provider_subscription_id = p_provider_subscription_id
    for update;
  if found and sub.last_event_at is not null and p_event_at is not null and p_event_at < sub.last_event_at then
    return jsonb_build_object('subscription_id', sub.id, 'client_id', sub.client_id, 'status', sub.status, 'stale', true, 'changed', false);
  end if;

  if not found then
    is_new := true;
    if p_user_id is null then raise exception 'user_required' using errcode = 'P0001'; end if;
    select * into pr from public.profiles where id = p_user_id;
    if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
    -- one subscription client per user: reuse it (re-subscribing after a cancel keeps the same line and number)
    select * into cl from public.clients c where c.user_id = p_user_id and c.billing_mode = 'subscription'
      order by c.created_at desc limit 1 for update;
    if not found then
      insert into public.clients (user_id, products, status, billing_mode, business_name)
      values (p_user_id, '{RCP}', 'onboarding', 'subscription', left(pr.company, 200)) returning * into cl;
    end if;
    v_phone := coalesce(private.us_e164(p_business_phone), private.us_e164(pr.phone));
  else
    select * into cl from public.clients where id = sub.client_id for update;
    v_phone := coalesce(private.us_e164(p_business_phone), sub.business_phone);
  end if;
  uid := cl.user_id;

  -- one free trial per business phone number
  if p_status = 'trialing' and v_phone is not null then
    insert into private.trial_claims (phone, client_id, user_id) values (v_phone, cl.id, uid) on conflict (phone) do nothing;
    select * into claim from private.trial_claims t where t.phone = v_phone;
    dup := claim.client_id is distinct from cl.id;
  end if;

  if is_new then
    insert into public.subscriptions (client_id, plan_code, scheduled_plan_code, status, provider, provider_subscription_id,
      provider_customer_id, card_on_file, trial_began_at, trial_ends_at, current_period_start, current_period_end,
      cancel_at_period_end, canceled_at, ends_at, past_due_since, paused_at, business_phone, trial_duplicate, last_event_at)
    values (cl.id, p_plan_code, p_scheduled_plan_code, p_status, p_provider, p_provider_subscription_id, p_provider_customer_id,
      coalesce(p_card_on_file, false), case when p_status = 'trialing' then now() end, p_trial_ends_at, p_current_period_start,
      p_current_period_end, coalesce(p_cancel_at_period_end, false), case when p_status = 'canceled' then coalesce(p_canceled_at, now()) end,
      case when p_status = 'canceled' then coalesce(p_current_period_end, p_canceled_at, now()) end,
      case when p_status = 'past_due' then now() end, case when p_status = 'paused' then now() end, v_phone, dup,
      coalesce(p_event_at, now()))
    returning * into sub;
  else
    update public.subscriptions s set
      plan_code = p_plan_code,
      scheduled_plan_code = p_scheduled_plan_code,
      status = p_status,
      provider_customer_id = coalesce(p_provider_customer_id, s.provider_customer_id),
      card_on_file = coalesce(p_card_on_file, s.card_on_file),
      trial_began_at = case when p_status = 'trialing' then coalesce(s.trial_began_at, now()) else s.trial_began_at end,
      trial_ends_at = coalesce(p_trial_ends_at, s.trial_ends_at),
      current_period_start = coalesce(p_current_period_start, s.current_period_start),
      current_period_end = coalesce(p_current_period_end, s.current_period_end),
      cancel_at_period_end = coalesce(p_cancel_at_period_end, s.cancel_at_period_end),
      canceled_at = case when p_status = 'canceled' then coalesce(p_canceled_at, s.canceled_at, now()) else null end,
      ends_at = case when p_status = 'canceled' then coalesce(s.ends_at, p_current_period_end, s.current_period_end, p_canceled_at, now())
                     else null end,
      past_due_since = case when p_status = 'past_due' then coalesce(s.past_due_since, now()) else null end,
      paused_at = case when p_status = 'paused' then coalesce(s.paused_at, now()) else null end,
      business_phone = coalesce(v_phone, s.business_phone),
      trial_duplicate = s.trial_duplicate or dup,
      last_event_at = greatest(coalesce(p_event_at, now()), s.last_event_at)
    where s.id = sub.id returning * into sub;
  end if;

  if sub.status in ('trialing', 'active') then
    begin
      prov := private.provision_client(sub.id);
    exception when others then
      perform private.log_event('client', cl.id, uid, 'provisioning_error', jsonb_build_object('error', left(sqlerrm, 300)), false);
      perform private.enqueue_email_safe('admin_provisioning_alert', 'admin_provisioning_alert:setup:' || sub.id || ':' || to_char(now(), 'YYYYMMDDHH24'),
        'client', cl.id, uid, jsonb_build_object('step', 'setup', 'error', left(sqlerrm, 300)));
    end;
    perform private.sync_client_billing(cl.id);
  end if;
  if dup then
    perform private.log_event('client', cl.id, uid, 'trial_duplicate', jsonb_build_object('phone_claimed_by', claim.client_id), false);
    perform private.enqueue_email_safe('admin_provisioning_alert', 'admin_provisioning_alert:dup:' || sub.id,
      'client', cl.id, uid, jsonb_build_object('step', 'duplicate_trial', 'error', 'This business phone already had a free trial'));
  end if;
  perform private.log_event('client', cl.id, uid, 'subscription_updated',
    jsonb_build_object('plan', sub.plan_code, 'status', sub.status, 'provider', sub.provider, 'new', is_new), true);
  return jsonb_build_object('subscription_id', sub.id, 'client_id', cl.id, 'tenant_id', prov ->> 'tenant_id', 'status', sub.status,
                            'plan_code', sub.plan_code, 'stale', false, 'changed', true, 'trial_duplicate', sub.trial_duplicate);
end $$;

create or replace function public.billing_upsert_subscription(
  p_provider text, p_provider_subscription_id text, p_status text, p_plan_code text, p_user_id uuid default null,
  p_provider_customer_id text default null, p_trial_ends_at timestamptz default null,
  p_current_period_start timestamptz default null, p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default null, p_card_on_file boolean default null, p_scheduled_plan_code text default null,
  p_canceled_at timestamptz default null, p_event_at timestamptz default null, p_business_phone text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if private.api_role() not in ('service_role', '') then raise exception 'service_role_only' using errcode = '42501'; end if;
  return private.upsert_subscription_core(p_provider, p_provider_subscription_id, p_status, p_plan_code, p_user_id,
    p_provider_customer_id, p_trial_ends_at, p_current_period_start, p_current_period_end, p_cancel_at_period_end,
    p_card_on_file, p_scheduled_plan_code, p_canceled_at, p_event_at, p_business_phone);
end $$;

-- ================================================================ client RPCs (portal Billing tab)
create or replace function private.my_sub_client() returns public.clients
language sql stable security definer set search_path = '' as $$
  select c.* from public.clients c where c.user_id = (select auth.uid()) and c.billing_mode = 'subscription'
   order by c.created_at desc limit 1
$$;

create or replace function public.billing_trial_eligible(p_business_phone text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_phone text; claim private.trial_claims; me public.clients;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  v_phone := coalesce(private.us_e164(p_business_phone), private.us_e164((select p.phone from public.profiles p where p.id = (select auth.uid()))));
  if v_phone is null then return jsonb_build_object('eligible', false, 'reason', 'phone_required'); end if;
  select * into claim from private.trial_claims t where t.phone = v_phone;
  me := private.my_sub_client();
  if claim.phone is not null and claim.client_id is distinct from me.id then
    return jsonb_build_object('eligible', false, 'reason', 'trial_already_used');
  end if;
  return jsonb_build_object('eligible', true, 'reason', '');
end $$;

-- Mock provider (local mock backend / tests / a staging project): OFF unless private.settings.billing_mock_enabled.
create or replace function public.billing_mock_checkout(p_plan_code text, p_trial_days int default 14,
                                                        p_business_phone text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare el jsonb; me public.clients; sub public.subscriptions;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if not coalesce((select s.billing_mock_enabled from private.settings s where s.id = 1), false) then
    raise exception 'mock_billing_disabled' using errcode = '42501';
  end if;
  if p_trial_days is null or p_trial_days not between 0 and 30 then raise exception 'bad_trial_days' using errcode = 'P0001'; end if;
  me := private.my_sub_client();
  if me.id is not null then
    sub := private.client_sub(me.id);
    if sub.id is not null and sub.status <> 'canceled' then raise exception 'already_subscribed' using errcode = 'P0001'; end if;
  end if;
  el := public.billing_trial_eligible(p_business_phone);
  if p_trial_days > 0 and not (el ->> 'eligible')::boolean then
    raise exception '%', el ->> 'reason' using errcode = 'P0001';
  end if;
  return private.upsert_subscription_core('mock', 'mock_' || replace(gen_random_uuid()::text, '-', ''),
    case when p_trial_days > 0 then 'trialing' else 'active' end, p_plan_code, (select auth.uid()), 'mock_cus',
    case when p_trial_days > 0 then now() + make_interval(days => p_trial_days) end,
    case when p_trial_days > 0 then null else now() end, case when p_trial_days > 0 then null else now() + interval '1 month' end,
    false, true, null, null, now(), p_business_phone);
end $$;

-- What the portal shows: subscription, service mode, this period's usage, setup progress (no internal errors)
create or replace function public.client_billing() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.clients; sub public.subscriptions; t public.tenants; per text; pre text; jobs jsonb;
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
    'mock_checkout', coalesce((select s.billing_mock_enabled from private.settings s where s.id = 1), false));
end $$;

-- Plan change (upgrade button): mock/manual = applied now; paddle = recorded for the payment phase + note to Meir.
-- p_start_now: end the trial now and start the paid period (trial minutes used up).
create or replace function public.billing_change_plan(p_plan_code text, p_start_now boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.clients; sub public.subscriptions;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_plan_code is null or p_plan_code !~ '^[A-Z][A-Z0-9_]{1,40}$' then raise exception 'bad_plan_code' using errcode = 'P0001'; end if;
  me := private.my_sub_client();
  sub := private.client_sub(me.id);
  if sub.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
  if sub.status not in ('trialing', 'active', 'past_due') then raise exception 'subscription_not_active' using errcode = 'P0001'; end if;
  if sub.plan_code = p_plan_code and not coalesce(p_start_now, false) then raise exception 'same_plan' using errcode = 'P0001'; end if;
  perform private.log_event('client', me.id, me.user_id, 'plan_change_requested',
    jsonb_build_object('from', sub.plan_code, 'to', p_plan_code, 'start_now', coalesce(p_start_now, false), 'provider', sub.provider), true);
  if sub.provider = 'paddle' then
    perform private.enqueue_email_safe('admin_billing_request', 'admin_billing_request:plan:' || sub.id || ':' || p_plan_code || ':' || to_char(now(), 'YYYYMMDDHH24'),
      'client', me.id, me.user_id, jsonb_build_object('what', 'plan_change', 'to', p_plan_code, 'start_now', coalesce(p_start_now, false)));
    return jsonb_build_object('applied', false, 'pending', true, 'provider', sub.provider);
  end if;
  -- downgrade of a paid period: from the next period (scheduled_plan_code); upgrades and trial changes: now
  if sub.status = 'active' and private.plan_rank(p_plan_code) < private.plan_rank(sub.plan_code) and not coalesce(p_start_now, false) then
    return private.upsert_subscription_core(sub.provider, sub.provider_subscription_id, sub.status, sub.plan_code, null, null, null, null,
      null, null, null, p_plan_code, null, null, null) || jsonb_build_object('applied', true, 'scheduled', true);
  end if;
  return private.upsert_subscription_core(sub.provider, sub.provider_subscription_id,
    case when coalesce(p_start_now, false) and sub.status = 'trialing' then 'active' else sub.status end, p_plan_code, null, null,
    case when coalesce(p_start_now, false) and sub.status = 'trialing' then now() end,
    case when coalesce(p_start_now, false) and sub.status = 'trialing' then now() end,
    case when coalesce(p_start_now, false) and sub.status = 'trialing' then now() + interval '1 month' end,
    null, null, null, null, null, null) || jsonb_build_object('applied', true);
end $$;

-- Cancel: mock = at the end of the paid period (in the trial: now, nothing is charged); paddle = request + note to Meir.
create or replace function public.billing_cancel() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.clients; sub public.subscriptions;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  me := private.my_sub_client();
  sub := private.client_sub(me.id);
  if sub.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
  perform private.log_event('client', me.id, me.user_id, 'cancel_requested', jsonb_build_object('provider', sub.provider), true);
  if sub.provider = 'paddle' then
    perform private.enqueue_email_safe('admin_billing_request', 'admin_billing_request:cancel:' || sub.id || ':' || to_char(now(), 'YYYYMMDD'),
      'client', me.id, me.user_id, jsonb_build_object('what', 'cancel'));
    return jsonb_build_object('applied', false, 'pending', true, 'provider', sub.provider);
  end if;
  if sub.status = 'trialing' then
    return private.upsert_subscription_core(sub.provider, sub.provider_subscription_id, 'canceled', sub.plan_code, null, null, null, null,
      null, false, null, null, now(), null, null) || jsonb_build_object('applied', true);
  end if;
  return private.upsert_subscription_core(sub.provider, sub.provider_subscription_id, sub.status, sub.plan_code, null, null, null, null,
    null, true, null, sub.scheduled_plan_code, null, null, null) || jsonb_build_object('applied', true);
end $$;

-- Resume / resubscribe: mock = active again now (new period); paddle = request + note to Meir.
create or replace function public.billing_resume() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.clients; sub public.subscriptions;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  me := private.my_sub_client();
  sub := private.client_sub(me.id);
  if sub.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
  perform private.log_event('client', me.id, me.user_id, 'resume_requested', jsonb_build_object('provider', sub.provider), true);
  if sub.provider = 'paddle' then
    perform private.enqueue_email_safe('admin_billing_request', 'admin_billing_request:resume:' || sub.id || ':' || to_char(now(), 'YYYYMMDD'),
      'client', me.id, me.user_id, jsonb_build_object('what', 'resume'));
    return jsonb_build_object('applied', false, 'pending', true, 'provider', sub.provider);
  end if;
  if sub.status = 'active' and sub.cancel_at_period_end then
    return private.upsert_subscription_core(sub.provider, sub.provider_subscription_id, 'active', sub.plan_code, null, null, null, null,
      null, false, null, null, null, null, null) || jsonb_build_object('applied', true);
  end if;
  return private.upsert_subscription_core(sub.provider, sub.provider_subscription_id, 'active', sub.plan_code, null, null, null, now(),
    now() + interval '1 month', false, true, null, null, null, null) || jsonb_build_object('applied', true);
end $$;

-- ================================================================ admin RPCs (Hebrew "מנויים" tab)
create or replace function public.admin_subscriptions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
    select jsonb_build_object(
      'client_id', c.id, 'client_status', c.status, 'business_name', coalesce(c.business_name, p.company, p.email),
      'email', p.email, 'created_at', s.created_at,
      'subscription', to_jsonb(s) - 'business_phone',
      'money_back_used_at', private.money_back_used(s),
      'tenant', case when t.id is null then null else jsonb_build_object('id', t.id, 'slug', t.slug, 'status', t.status,
                  'twilio_number', t.twilio_number, 'service', coalesce(t.config #>> '{plan,service}', 'full'),
                  'service_reason', coalesce(t.config #>> '{plan,service_reason}', '')) end,
      'jobs', coalesce((select jsonb_agg(jsonb_build_object('kind', j.kind, 'status', j.status, 'attempts', j.attempts,
                 'last_error', j.last_error, 'dry_run', j.dry_run, 'updated_at', j.updated_at,
                 'passed', j.result -> 'passed', 'failed', j.result -> 'failed', 'number', coalesce(j.result ->> 'number', j.result ->> 'would_buy'))
                 order by j.kind) from public.provisioning_jobs j where j.tenant_id = t.id), '[]'::jsonb),
      'checklist', jsonb_build_object(
        'done', (select count(*) from public.onboarding_items o where o.client_id = c.id and o.key not in ('tools', 'sms') and o.status = 'done'),
        'required', (select count(*) from public.onboarding_items o where o.client_id = c.id and o.key not in ('tools', 'sms')))) x
    from public.subscriptions s
    join public.clients c on c.id = s.client_id
    left join public.profiles p on p.id = c.user_id
    left join lateral (select * from public.tenants tt where tt.client_id = c.id order by tt.created_at limit 1) t on true
    where s.id = (select s2.id from public.subscriptions s2 where s2.client_id = c.id order by s2.created_at desc limit 1)) q), '[]'::jsonb);
end $$;

-- Retry buttons: 'number' / 'golive_sim' = queue the job again (the runtime picks it up on the next tick);
-- 'setup' = run the automatic setup again (client card, tenant, checklist, number job).
create or replace function public.admin_retry_provisioning(p_client uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenants; sub public.subscriptions; cl public.clients;
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_kind not in ('number', 'golive_sim', 'setup') then raise exception 'bad_kind' using errcode = 'P0001'; end if;
  select * into cl from public.clients where id = p_client;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  sub := private.client_sub(p_client);
  if p_kind = 'setup' then
    if sub.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
    if sub.trial_duplicate then update public.subscriptions set trial_duplicate = false where id = sub.id; end if;  -- Meir decided
    perform private.provision_client(sub.id);
    perform private.sync_client_billing(p_client);
  else
    select * into t from public.tenants x where x.client_id = p_client order by x.created_at limit 1;
    if t.id is null then raise exception 'no_tenant' using errcode = 'P0002'; end if;
    insert into public.provisioning_jobs (tenant_id, client_id, kind, status, attempts, next_attempt_at, last_error)
    values (t.id, p_client, p_kind, 'pending', 0, null, null)
    on conflict (tenant_id, kind) do update set status = 'pending', attempts = 0, next_attempt_at = null, last_error = null;
  end if;
  perform private.log_event('client', p_client, cl.user_id, 'provisioning_retry', jsonb_build_object('kind', p_kind), false);
  return jsonb_build_object('ok', true, 'kind', p_kind);
end $$;

-- 30-day money-back on the first paid month, once per business: the admin records it (the refund itself is done in the
-- payment provider). Kept on the subscription and on the business phone's trial claim.
create or replace function public.admin_mark_money_back(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sub public.subscriptions; cl public.clients;
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into cl from public.clients where id = p_client;
  sub := private.client_sub(p_client);
  if sub.id is null then raise exception 'no_subscription' using errcode = 'P0002'; end if;
  if private.money_back_used(sub) is not null then raise exception 'money_back_already_used' using errcode = 'P0001'; end if;
  update public.subscriptions set money_back_used_at = now() where id = sub.id;
  if sub.business_phone is not null then
    insert into private.trial_claims (phone, client_id, user_id, money_back_used_at) values (sub.business_phone, cl.id, cl.user_id, now())
    on conflict (phone) do update set money_back_used_at = coalesce(private.trial_claims.money_back_used_at, now());
  end if;
  perform private.log_event('client', p_client, cl.user_id, 'money_back_used', '{}'::jsonb, false);
  return jsonb_build_object('ok', true);
end $$;

create or replace function private.money_back_used(sub public.subscriptions) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce(sub.money_back_used_at,
                  (select t.money_back_used_at from private.trial_claims t where t.phone = sub.business_phone),
                  (select max(x.money_back_used_at) from public.subscriptions x where x.client_id = sub.client_id))
$$;

-- Admin override: switch live without waiting for the automatic check (e.g. a check failed on wording only)
create or replace function public.admin_force_golive(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cl public.clients;
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into cl from public.clients where id = p_client;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.tenants t where t.client_id = p_client and t.twilio_number is not null) then
    raise exception 'no_number' using errcode = 'P0001';
  end if;
  update public.tenants set status = 'live' where client_id = p_client and status = 'sandbox';
  update public.clients set status = 'live' where id = p_client and status <> 'live';
  perform private.log_event('client', p_client, cl.user_id, 'admin_go_live', '{}'::jsonb, false);
  return jsonb_build_object('ok', true);
end $$;

-- ================================================================ provisioning job results (runtime -> database)
create or replace function private.provisioning_jobs_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select c.user_id from public.clients c where c.id = new.client_id);
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.kind = 'number' and new.status = 'done' then
    perform private.log_event('tenant', new.tenant_id, uid, 'number_assigned', jsonb_build_object('dry_run', new.dry_run), true);
  elsif new.kind = 'golive_sim' and new.status = 'done' and coalesce((new.result ->> 'passed')::boolean, false) then
    perform private.log_event('tenant', new.tenant_id, uid, 'golive_check_passed', '{}'::jsonb, false);
    perform private.try_go_live(new.client_id);
  elsif new.status in ('failed', 'held') then
    perform private.log_event('tenant', new.tenant_id, uid, 'provisioning_' || new.status,
      jsonb_build_object('kind', new.kind, 'error', left(coalesce(new.last_error, ''), 300)), false);
  end if;
  return null;
end $$;
drop trigger if exists provisioning_jobs_after on public.provisioning_jobs;
create trigger provisioning_jobs_after after update of status on public.provisioning_jobs
  for each row execute function private.provisioning_jobs_after();

-- ================================================================ checklist saves -> live config (subscription clients)
-- "Service call: $89", "Drain cleaning - 150", "AC tune-up $79.99 (per unit)" -> {name, price_usd, note}; unreadable lines skipped
create or replace function private.parse_price_lines(p_lines jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare line text; m text[]; out jsonb := '[]'::jsonb; nm text; note text;
begin
  if jsonb_typeof(p_lines) <> 'array' then return out; end if;
  for line in select btrim(x) from jsonb_array_elements_text(p_lines) x loop
    -- the first "$amount"; without a $, an amount after ":" or a dash ("Drain cleaning - 150")
    m := regexp_match(line, '\$\s?([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(.*)$');
    if m is not null then
      nm := regexp_replace(line, '\s*[:–—-]?\s*\$\s?[0-9].*$', '');
    else
      m := regexp_match(line, '[:–—-]\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(.*)$');
      if m is null then continue; end if;
      nm := regexp_replace(line, '\s*[:–—-]\s*[0-9]{1,6}(?:\.[0-9]{1,2})?\s*.*$', '');
    end if;
    nm := left(btrim(nm, ' :–—-'), 80);
    note := left(btrim(coalesce(m[2], ''), ' ()'), 160);
    if nm = '' or (m[1])::numeric > 100000 then continue; end if;
    out := out || jsonb_build_array(jsonb_build_object('name', nm, 'price_usd', (m[1])::numeric, 'note', note));
    exit when jsonb_array_length(out) >= 30;
  end loop;
  return out;
end $$;

-- free-text service area -> {zips: [...5 digits...], places: [...cities/counties...]}
create or replace function private.parse_service_area(p text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'zips', coalesce((select jsonb_agg(z order by first) from (
              select m[1] z, min(ord) first from regexp_matches(coalesce(p, ''), '\m([0-9]{5})\M', 'g') with ordinality r(m, ord)
               group by m[1] order by min(ord) limit 500) zz), '[]'::jsonb),
    'places', coalesce((select jsonb_agg(t order by ord) from (
              select t, ord from (
                select distinct on (lower(t)) t, ord from (
                  select left(btrim(regexp_replace(x, '\m[0-9]{5}\M', '', 'g'), ' .'), 80) t, ord
                    from regexp_split_to_table(coalesce(p, ''), '[,;\n]+') with ordinality s(x, ord)) a
                 where t <> '' and t ~ '[A-Za-z]' order by lower(t), ord) b
               order by ord limit 50) c), '[]'::jsonb))
$$;

create or replace function private.check_hours(v jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare day text;
begin
  if jsonb_typeof(v) <> 'object' then raise exception 'invalid_setting:hours' using errcode = 'P0001'; end if;
  for day in select jsonb_object_keys(v) loop
    if day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then raise exception 'invalid_setting:hours.%', day using errcode = 'P0001'; end if;
    if not (jsonb_typeof(v -> day) = 'null' or (jsonb_typeof(v -> day) = 'array' and jsonb_array_length(v -> day) = 2
            and (v -> day ->> 0) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and (v -> day ->> 1) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            and (v -> day ->> 0) < (v -> day ->> 1))) then
      raise exception 'invalid_setting:hours.%', day using errcode = 'P0001';
    end if;
  end loop;
  if not exists (select 1 from jsonb_each(v) e where jsonb_typeof(e.value) = 'array') then
    raise exception 'invalid_setting:hours' using errcode = 'P0001';   -- at least one open day
  end if;
end $$;

-- One checklist step's data -> the new tenant config. Same limits as runtime/app/tenant_schema.json; bad input raises
-- invalid_setting:<path> (the portal shows it next to the field). Mirrored by site/start/assets/onboarding-config.js.
create or replace function private.onboarding_patch(p_key text, d jsonb, cfg jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb; i int; e jsonb; area jsonb; items jsonb; oc jsonb; scr jsonb;
begin
  cfg := coalesce(cfg, '{}'::jsonb);
  d := coalesce(d, '{}'::jsonb);
  if p_key = 'hours' then
    if d ? 'hours' then perform private.check_hours(d -> 'hours'); cfg := cfg || jsonb_build_object('hours', d -> 'hours'); end if;
    if d ? 'timezone' then
      if not private.valid_tz(d ->> 'timezone') then raise exception 'invalid_setting:business.timezone' using errcode = 'P0001'; end if;
      cfg := jsonb_set(cfg, '{business,timezone}', d -> 'timezone', true);
    end if;
    if d ? 'after_hours' then
      if jsonb_typeof(d -> 'after_hours') <> 'object' or (d #>> '{after_hours,mode}') is null
         or (d #>> '{after_hours,mode}') not in ('book_next_day', 'message_only', 'emergency_dial') then
        raise exception 'invalid_setting:after_hours.mode' using errcode = 'P0001';
      end if;
      cfg := cfg || jsonb_build_object('after_hours', jsonb_build_object('mode', d #>> '{after_hours,mode}'));
    end if;
  elsif p_key = 'faq' then
    if d ? 'faq' then
      v := d -> 'faq';
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 25 then raise exception 'invalid_setting:faq' using errcode = 'P0001'; end if;
      for i in 0 .. jsonb_array_length(v) - 1 loop
        e := v -> i;
        if jsonb_typeof(e -> 'q') is distinct from 'string' or length(e ->> 'q') not between 1 and 300 then
          raise exception 'invalid_setting:faq[%].q', i using errcode = 'P0001'; end if;
        if jsonb_typeof(e -> 'a') is distinct from 'string' or length(e ->> 'a') not between 1 and 600 then
          raise exception 'invalid_setting:faq[%].a', i using errcode = 'P0001'; end if;
      end loop;
      cfg := cfg || jsonb_build_object('faq', (select coalesce(jsonb_agg(jsonb_build_object('q', x ->> 'q', 'a', x ->> 'a')), '[]'::jsonb)
                                                 from jsonb_array_elements(v) x));
    end if;
    if d ? 'services' then
      v := d -> 'services';
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 30
         or exists (select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string' or length(btrim(x #>> '{}')) not between 1 and 80) then
        raise exception 'invalid_setting:booking.job_types' using errcode = 'P0001';
      end if;
      cfg := jsonb_set(cfg, '{booking,job_types}', (select jsonb_agg(btrim(x)) from jsonb_array_elements_text(v) x), true);
    end if;
    if d ? 'service_area' then
      area := private.parse_service_area(d ->> 'service_area');
      cfg := jsonb_set(jsonb_set(cfg, '{business,service_area_zips}', area -> 'zips', true),
                       '{business,service_area_places}', area -> 'places', true);
    end if;
    if d ->> 'price_on_phone' = 'fixed' then
      items := private.parse_price_lines(d -> 'fixed_prices');
      cfg := cfg || jsonb_build_object('pricing', case when jsonb_array_length(items) > 0
               then jsonb_build_object('mode', 'listed', 'items', items) else jsonb_build_object('mode', 'none', 'items', '[]'::jsonb) end);
    elsif d ->> 'price_on_phone' = 'no' then
      cfg := cfg || jsonb_build_object('pricing', jsonb_build_object('mode', 'none', 'items', '[]'::jsonb));
    end if;
    if (cfg #>> '{business,niche}') = 'real_estate' then
      if jsonb_typeof(d -> 're_lead_types') = 'array' then
        cfg := cfg || jsonb_build_object('real_estate', coalesce(cfg -> 'real_estate', '{}'::jsonb)
                 || jsonb_build_object('renters', (d -> 're_lead_types') ? 'renters'));
      end if;
      if jsonb_typeof(d -> 're_qualify') = 'array' then
        scr := jsonb_build_array('intent') || coalesce((select jsonb_agg(m.v order by m.o) from (values
                 ('timeline', 'timeline', 1), ('budget', 'price_range', 2), ('preapproval', 'pre_approval', 3), ('areas', 'area', 4),
                 ('property', 'property_address', 5)) as m(k, v, o) where (d -> 're_qualify') ? m.k), '[]'::jsonb)
               || jsonb_build_array('has_agent');
        cfg := cfg || jsonb_build_object('real_estate', coalesce(cfg -> 'real_estate', '{}'::jsonb) || jsonb_build_object('screening', scr));
      end if;
    end if;
  elsif p_key = 'alerts' then
    if d ? 'notify' then
      v := d -> 'notify';
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_object_keys(v) k where k not in ('sms', 'email', 'daily_summary')) then
        raise exception 'invalid_setting:notify' using errcode = 'P0001'; end if;
      if jsonb_typeof(coalesce(v -> 'sms', '[]')) <> 'array' or jsonb_array_length(coalesce(v -> 'sms', '[]')) > 5 then
        raise exception 'invalid_setting:notify.sms' using errcode = 'P0001'; end if;
      for i in 0 .. jsonb_array_length(coalesce(v -> 'sms', '[]')) - 1 loop
        if not private.is_us_e164(v -> 'sms' -> i) then raise exception 'invalid_setting:notify.sms[%]', i using errcode = 'P0001'; end if;
      end loop;
      if jsonb_typeof(coalesce(v -> 'email', '[]')) <> 'array' or jsonb_array_length(coalesce(v -> 'email', '[]')) > 5 then
        raise exception 'invalid_setting:notify.email' using errcode = 'P0001'; end if;
      for i in 0 .. jsonb_array_length(coalesce(v -> 'email', '[]')) - 1 loop
        if jsonb_typeof(v -> 'email' -> i) <> 'string' or (v -> 'email' ->> i) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v -> 'email' ->> i) > 320 then
          raise exception 'invalid_setting:notify.email[%]', i using errcode = 'P0001'; end if;
      end loop;
      if v ? 'daily_summary' and not (jsonb_typeof(v -> 'daily_summary') = 'null'
          or (v ->> 'daily_summary') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
        raise exception 'invalid_setting:notify.daily_summary' using errcode = 'P0001'; end if;
      if jsonb_array_length(coalesce(v -> 'sms', '[]')) + jsonb_array_length(coalesce(v -> 'email', '[]')) = 0 then
        raise exception 'invalid_setting:notify' using errcode = 'P0001'; end if;
      cfg := cfg || jsonb_build_object('notify', coalesce(cfg -> 'notify', '{}'::jsonb) || v);
    end if;
    if d ? 'on_call_number' then
      oc := d -> 'on_call_number';
      if not (jsonb_typeof(oc) = 'null' or private.is_us_e164(oc)) then raise exception 'invalid_setting:on_call_number' using errcode = 'P0001'; end if;
      cfg := cfg || jsonb_build_object(
        'handoff', coalesce(cfg -> 'handoff', '{}'::jsonb) || jsonb_build_object('mode', case when jsonb_typeof(oc) = 'null' then 'message' else 'dial' end, 'number', oc),
        'emergency', coalesce(cfg -> 'emergency', '{}'::jsonb) || jsonb_build_object('dial', oc));
    end if;
    if jsonb_typeof(d #> '{emergency,keywords}') = 'array' then
      v := d #> '{emergency,keywords}';
      if jsonb_array_length(v) > 40 or exists (select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string'
                                                or length(btrim(x #>> '{}')) not between 1 and 60) then
        raise exception 'invalid_setting:emergency.keywords' using errcode = 'P0001'; end if;
      cfg := cfg || jsonb_build_object('emergency', coalesce(cfg -> 'emergency', '{}'::jsonb)
               || jsonb_build_object('keywords', (select coalesce(jsonb_agg(btrim(x)), '[]'::jsonb) from jsonb_array_elements_text(v) x)));
    end if;
  elsif p_key = 'calendar' then
    if d ->> 'booking_mode' = 'messages_only' then
      cfg := jsonb_set(cfg, '{booking,enabled}', 'false', true);
    elsif d ? 'provider' then
      if (d ->> 'provider') not in ('google', 'calendly') then raise exception 'invalid_setting:booking.provider' using errcode = 'P0001'; end if;
      cfg := jsonb_set(jsonb_set(cfg, '{booking,provider}', d -> 'provider', true), '{booking,enabled}', 'true', true);
    end if;
    if d ? 'booking_link' and jsonb_typeof(d -> 'booking_link') = 'string' then
      if (d ->> 'booking_link') !~ '^https://calendly\.com/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)?/?$' then
        raise exception 'invalid_setting:booking.booking_link' using errcode = 'P0001'; end if;
      cfg := jsonb_set(cfg, '{booking,booking_link}', d -> 'booking_link', true);
    end if;
  elsif p_key = 'tools' then
    if d ? 'zapier_webhook_url' then
      if not (jsonb_typeof(d -> 'zapier_webhook_url') = 'null' or ((d ->> 'zapier_webhook_url') ~ '^https://' and length(d ->> 'zapier_webhook_url') <= 500)) then
        raise exception 'invalid_setting:zapier.webhook_url' using errcode = 'P0001'; end if;
      cfg := cfg || jsonb_build_object('zapier', coalesce(cfg -> 'zapier', '{}'::jsonb) || jsonb_build_object('webhook_url', d -> 'zapier_webhook_url'));
    end if;
  elsif p_key = 'forward_calls' then
    if d ? 'business_phone' and jsonb_typeof(d -> 'business_phone') = 'string' then
      if not private.is_us_e164(d -> 'business_phone') then raise exception 'invalid_setting:business.main_phone' using errcode = 'P0001'; end if;
      cfg := jsonb_set(cfg, '{business,main_phone}', d -> 'business_phone', true);
    end if;
  end if;
  return cfg;
end $$;

create or replace function private.onboarding_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cl public.clients; t public.tenants; tid uuid;
begin
  -- calendar step (every client): done only with a connected calendar (a stored credential for the chosen provider) or
  -- the explicit "take messages only" choice. A saved Calendly link alone is not a connection.
  if new.key = 'calendar' and new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') and private.is_client_call()
     and coalesce(new.data ->> 'booking_mode', '') <> 'messages_only'
     and not exists (select 1 from public.tenants x join private.tenant_credentials k on k.tenant_id = x.id
                      where x.client_id = new.client_id and k.provider::text = coalesce(new.data ->> 'provider', '')) then
    raise exception 'calendar_not_connected' using errcode = 'P0001';
  end if;
  select * into cl from public.clients where id = new.client_id;
  if cl.billing_mode is distinct from 'subscription' then return new; end if;
  if tg_op = 'UPDATE' and new.data is not distinct from old.data then return new; end if;
  select x.id into tid from public.tenants x where x.client_id = new.client_id order by x.created_at limit 1;
  if tid is null then return new; end if;
  update public.tenants x set config = private.onboarding_patch(new.key, new.data, x.config) where x.id = tid
    and x.config is distinct from private.onboarding_patch(new.key, new.data, x.config);
  return new;
end $$;
drop trigger if exists onboarding_apply on public.onboarding_items;
create trigger onboarding_apply before update on public.onboarding_items
  for each row execute function private.onboarding_apply();

-- checklist complete (tools + texting optional) -> testing + the go-live simulator job
create or replace function private.onboarding_autogolive() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cl public.clients; t public.tenants;
begin
  select * into cl from public.clients where id = new.client_id;
  if cl.billing_mode is distinct from 'subscription' or cl.status not in ('onboarding', 'building', 'testing') then return null; end if;
  if exists (select 1 from public.onboarding_items o where o.client_id = new.client_id and o.key not in ('tools', 'sms') and o.status <> 'done') then
    return null;
  end if;
  select * into t from public.tenants x where x.client_id = new.client_id order by x.created_at limit 1;
  if t.id is null or t.twilio_number is null then return null; end if;
  if cl.status <> 'testing' then update public.clients set status = 'testing' where id = cl.id; end if;
  if not exists (select 1 from public.provisioning_jobs j where j.tenant_id = t.id and j.kind = 'golive_sim'
                  and (j.status in ('pending', 'running') or (j.status = 'done' and coalesce((j.result ->> 'passed')::boolean, false)))) then
    insert into public.provisioning_jobs (tenant_id, client_id, kind, status) values (t.id, cl.id, 'golive_sim', 'pending')
    on conflict (tenant_id, kind) do update set status = 'pending', attempts = 0, next_attempt_at = null, last_error = null;
  end if;
  perform private.try_go_live(cl.id);
  return null;
end $$;
drop trigger if exists onboarding_autogolive on public.onboarding_items;
create trigger onboarding_autogolive after update of status, data on public.onboarding_items
  for each row execute function private.onboarding_autogolive();

-- ================================================================ go-live gate: texting registration no longer required
-- (same function as 20261011101700_us_portal_b7.sql; 'sms' joins the optional 'tools')
create or replace function private.onboarding_go_live_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.data ? 'go_live_requested_at') and not (coalesce(old.data, '{}'::jsonb) ? 'go_live_requested_at')
     and private.is_client_call() then
    if (new.status <> 'done' and new.key not in ('tools', 'sms'))
       or (select c.status from public.clients c where c.id = new.client_id) is distinct from 'testing'
       or exists (select 1 from public.onboarding_items o
                  where o.client_id = new.client_id and o.id <> new.id and o.key not in ('tools', 'sms') and o.status <> 'done') then
      raise exception 'go_live_not_ready' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ================================================================ forwarding test: the call must come through the business line
-- calls.forwarded_from (Twilio ForwardedFrom) = business.main_phone -> done. Another line -> test_mismatch_* (not done).
-- No carrier data -> test_unverified_* (not done; the client may confirm it with public.confirm_forwarding_test).
create or replace function private.calls_forwarding_test() returns trigger
language plpgsql security definer set search_path = '' as $$
declare it public.onboarding_items; main text; fwd text;
begin
  begin
    select o.* into it from public.onboarding_items o join public.tenants t on t.client_id = o.client_id
     where t.id = new.tenant_id and o.key = 'forward_calls' and o.status <> 'done'
       and (o.data ->> 'test_started_at') is not null
     limit 1;
    if found and new.started_at between (it.data ->> 'test_started_at')::timestamptz - interval '1 minute'
                                     and (it.data ->> 'test_started_at')::timestamptz + interval '30 minutes' then
      select private.us_e164(t.config #>> '{business,main_phone}') into main from public.tenants t where t.id = new.tenant_id;
      fwd := private.us_e164(new.forwarded_from);
      if fwd is not null and fwd = main then
        update public.onboarding_items o
           set status = 'done', data = o.data || jsonb_build_object('test_call_at', new.started_at, 'test_call_id', new.id,
                                                                    'verified', 'forwarded_from')
         where o.id = it.id;
        perform private.log_event('onboarding_item', it.id, (select c.user_id from public.clients c where c.id = it.client_id),
          'forwarding_test_passed', jsonb_build_object('call_id', new.id, 'verified', 'forwarded_from'), true);
      elsif fwd is not null then
        update public.onboarding_items o
           set data = o.data || jsonb_build_object('test_mismatch_at', new.started_at, 'test_mismatch_from', fwd, 'test_call_id', new.id)
         where o.id = it.id;
      else
        update public.onboarding_items o
           set data = o.data || jsonb_build_object('test_unverified_at', new.started_at, 'test_call_id', new.id,
                                                   'test_direct', coalesce(private.us_e164(new.from_e164) = main, false))
         where o.id = it.id;
      end if;
    end if;
  exception when others then
    null;
  end;
  return new;
end $$;

create or replace function public.confirm_forwarding_test(p_item uuid) returns public.onboarding_items
language plpgsql security definer set search_path = '' as $$
declare it public.onboarding_items;
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
  update public.onboarding_items o
     set status = 'done', data = o.data || jsonb_build_object('test_call_at', it.data ->> 'test_unverified_at', 'verified', 'self_confirmed')
   where o.id = p_item returning * into it;
  perform private.log_event('onboarding_item', it.id, (select c.user_id from public.clients c where c.id = it.client_id),
    'forwarding_test_passed', jsonb_build_object('verified', 'self_confirmed'), true);
  return it;
end $$;

-- ================================================================ usage: plan periods in the admin month view
create or replace function public.admin_tenant_usage(p_month text default null)
returns table (tenant_id uuid, slug text, month text, voice_minutes numeric, sms_segments numeric, owner_sms_segments numeric,
               needs_addon_approval boolean, claude_usd numeric, twilio_usd numeric, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  m text := coalesce(nullif(p_month, ''), to_char(now() at time zone 'utc', 'YYYY-MM'));
begin
  if (select auth.uid()) is null or not private.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if m !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'bad_month' using errcode = 'P0001'; end if;
  return query
  select t.id, t.slug, m,
    coalesce(sum(private.rs_num(r.value)) filter (where r.key = 'usage:' || t.id || ':' || m || ':voice_minutes'
                                                   or r.key like 'usage:' || t.id || ':p' || m || '-%:voice_minutes'), 0),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key = 'usage:' || t.id || ':' || m || ':sms_segments'
                                                   or r.key like 'usage:' || t.id || ':p' || m || '-%:sms_segments'), 0),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key = 'usage:' || t.id || ':' || m || ':owner_sms_segments'), 0),
    coalesce(bool_or(r.value = 'true'::jsonb) filter (where r.key = 'usage:' || t.id || ':' || m || ':needs_addon_approval'
                                                       or r.key like 'usage:' || t.id || ':p' || m || '-%:needs_addon_approval'), false),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key like 'spend:' || t.id || ':' || m || '-%'), 0),
    coalesce(sum(private.rs_num(r.value)) filter (where r.key like 'cost:twilio:' || t.id || ':' || m || '-%'), 0),
    max(r.updated_at)
  from public.tenants t
  left join public.runtime_state r
    on r.key like 'usage:' || t.id || ':%' or r.key like 'spend:' || t.id || ':%' or r.key like 'cost:twilio:' || t.id || ':%'
  group by t.id, t.slug
  order by t.slug;
end $$;

-- ================================================================ hourly: trial ends, grace periods, scheduled downgrades
create or replace function private.billing_sync(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  -- mock/manual subscriptions: a scheduled downgrade takes effect when the period ends (Paddle sends its own webhook)
  update public.subscriptions s set plan_code = s.scheduled_plan_code, scheduled_plan_code = null,
         current_period_start = s.current_period_end, current_period_end = s.current_period_end + interval '1 month'
   where s.provider in ('mock', 'manual') and s.scheduled_plan_code is not null and s.status = 'active'
     and s.current_period_end is not null and s.current_period_end <= p_now;
  -- reminder 3 days before the trial ends (once per subscription)
  for r in select s.id, s.client_id, c.user_id from public.subscriptions s join public.clients c on c.id = s.client_id
            where s.status = 'trialing' and s.trial_ends_at is not null and s.trial_ends_at > p_now
              and s.trial_ends_at <= p_now + interval '3 days' loop
    perform private.enqueue_email_safe('trial_ending', 'trial_ending:' || r.id, 'client', r.client_id, r.user_id);
  end loop;
  for r in select distinct s.client_id from public.subscriptions s loop
    begin
      perform private.sync_client_billing(r.client_id);
      n := n + 1;
    exception when others then
      perform private.log_event('client', r.client_id, null, 'billing_sync_error', jsonb_build_object('error', left(sqlerrm, 300)), false);
    end;
  end loop;
  return n;
end $$;
select cron.schedule('ailab-us-billing-sync', '11 * * * *', 'select private.billing_sync()');

-- ================================================================ e-mail layer (redefinitions, same signatures)
create or replace function private.email_templates() returns text[]
language sql immutable set search_path = '' as $$
  select array['lead_capture', 'q_received', 'admin_new_quote', 'quote_sent', 'quote_reminder', 'quote_expiring',
               'quote' || '_accepted', 'admin_quote' || '_accepted', 'deposit_received', 'onboarding_nudge', 'need_help',
               'ready_to_test', 'final_payment_due', 'went_live', 'request_update', 'monthly_invoice', 'task:draft_quote',
               'web_deposit_link_requested', 'web_deposit_ack', 'request_cancelled', 'admin_request_cancelled',
               'payment_receipt', 'admin_payment_received', 'admin_paypal_alert', 'admin_upwork_requested',
               'subscription_message_mode', 'subscription_restored', 'admin_provisioning_alert', 'admin_billing_request',
               'trial_ending']
$$;

-- Same as 20261022100100_us_social_signin_contact_email.sql (the latest version, contact_email kept), plus: client.billing_mode, a `subscription` object for subscription
-- clients, the 4 subscription templates, and final_payment_due skipped for subscription clients (no final payment).
create or replace function private.email_context(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o private.email_outbox; s private.settings; p public.profiles; q public.quotes; qn public.questionnaires;
  cl public.clients; pay public.payments; rq public.requests; it public.onboarding_items; ld public.leads;
  ctx jsonb := '{}'::jsonb; uid uuid; tw text; n_total int := 0; n_done int := 0; left_titles jsonb := '[]'::jsonb;
  acc text := 'quote' || '_accepted'; v_pid text; v_method text; sub public.subscriptions; svc text; svr text;
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
                       'trial_ending') then
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
    ctx := ctx || jsonb_build_object(
      'client', jsonb_build_object('id', cl.id, 'status', cl.status, 'products', to_jsonb(cl.products),
                                   'monthly_cents', cl.monthly_cents, 'business_name', cl.business_name,
                                   'go_live_at', cl.go_live_at, 'next_bill_on', cl.next_bill_on, 'billing_mode', cl.billing_mode),
      'tenant_number', tw,
      'onboarding', jsonb_build_object('total', n_total, 'done', n_done, 'left', n_total - n_done, 'left_titles', left_titles));
    if cl.billing_mode = 'subscription' then
      sub := private.client_sub(cl.id);
      ctx := ctx || jsonb_build_object('subscription', jsonb_build_object('plan_code', sub.plan_code, 'status', sub.status,
        'trial_ends_at', sub.trial_ends_at, 'current_period_end', sub.current_period_end, 'cancel_at_period_end', sub.cancel_at_period_end,
        'ends_at', sub.ends_at, 'provider', sub.provider, 'service', coalesce(svc, 'full'), 'service_reason', coalesce(svr, ''),
        'reason', coalesce(o.payload ->> 'reason', svr, '')));
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

-- ================================================================ privileges
revoke all on function private.us_e164(text), private.area_code_tz(text), private.valid_tz(text), private.unique_slug(text),
  private.sub_service(public.subscriptions, timestamptz), private.client_sub(uuid), private.plan_block(uuid),
  private.default_tenant_config(uuid, text), private.seed_onboarding_subscription(uuid), private.provision_client(uuid),
  private.sync_client_billing(uuid), private.try_go_live(uuid), private.tenant_plan_guard(), private.subscriptions_after(),
  private.upsert_subscription_core(text, text, text, text, uuid, text, timestamptz, timestamptz, timestamptz, boolean, boolean, text,
                                   timestamptz, timestamptz, text),
  private.my_sub_client(), private.provisioning_jobs_after(), private.parse_price_lines(jsonb), private.parse_service_area(text),
  private.check_hours(jsonb), private.onboarding_patch(text, jsonb, jsonb), private.onboarding_apply(), private.onboarding_autogolive(),
  private.billing_sync(timestamptz), private.plan_rank(text), private.money_back_used(public.subscriptions)
  from public, anon, authenticated;
grant execute on function private.billing_sync(timestamptz), private.provision_client(uuid), private.sync_client_billing(uuid),
  private.onboarding_patch(text, jsonb, jsonb), private.parse_price_lines(jsonb), private.parse_service_area(text),
  private.area_code_tz(text), private.us_e164(text) to service_role;

revoke all on function public.billing_upsert_subscription(text, text, text, text, uuid, text, timestamptz, timestamptz, timestamptz,
  boolean, boolean, text, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.billing_upsert_subscription(text, text, text, text, uuid, text, timestamptz, timestamptz, timestamptz,
  boolean, boolean, text, timestamptz, timestamptz, text) to service_role;

revoke all on function public.billing_trial_eligible(text), public.billing_mock_checkout(text, int, text), public.client_billing(),
  public.billing_change_plan(text, boolean), public.billing_cancel(), public.billing_resume(), public.admin_subscriptions(),
  public.admin_retry_provisioning(uuid, text), public.admin_force_golive(uuid), public.confirm_forwarding_test(uuid),
  public.admin_tenant_usage(text), public.admin_mark_money_back(uuid) from public, anon;
grant execute on function public.billing_trial_eligible(text), public.billing_mock_checkout(text, int, text), public.client_billing(),
  public.billing_change_plan(text, boolean), public.billing_cancel(), public.billing_resume(), public.admin_subscriptions(),
  public.admin_retry_provisioning(uuid, text), public.admin_force_golive(uuid), public.confirm_forwarding_test(uuid),
  public.admin_tenant_usage(text), public.admin_mark_money_back(uuid) to authenticated, service_role;
