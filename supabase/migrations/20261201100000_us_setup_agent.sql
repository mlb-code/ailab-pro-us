-- Setup assistant (design docs/setup-agent-design-2026-11-27.md, internal repo, sections 2.4-2.6 and 4.1): the conversation
-- store of the setup-agent Edge Function, its guards, and a read-only preview of a checklist step.
--
--   public.setup_conversations / setup_messages / setup_proposals
--        one conversation per plan client; the owner (and admin) may READ them (RLS), nobody but the service role writes
--   public.setup_agent_open / begin_turn / finish_turn / decide / alert       service role only (the Edge Function)
--        begin_turn is the only way in: ownership, one turn at a time (row lock + lock_until + lock_token), idempotent
--        client_turn_id, per-user rate limits, the kill switch and the global daily budget are all enforced HERE
--   public.setup_preview_step(item, data)   the customer's own JWT: exactly what onboarding_apply would compute, writes nothing
--   private.setup_retention()                 messages + proposals deleted 90 days after the last activity (cron 03:29 UTC)
--   private.settings.setup_agent_enabled (default OFF), setup_agent_daily_budget_usd (30), setup_agent_paused_until
--
-- Additive and idempotent: new tables / columns / functions / one new trigger on public.clients (delete the conversation when
-- retention anonymises the client). Nothing existing is replaced. Applying it twice is a no-op.
set check_function_bodies = off;

-- ================================================================ tables
create table if not exists public.setup_conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'complete')),
  topic text check (length(topic) <= 40),
  -- server memory: {notes, attempts, last_card, prov, ...}; never the source of truth for what is saved
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object' and octet_length(state::text) < 16000),
  turns int not null default 0,
  model text check (length(model) <= 80),
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  cost_usd numeric(10,4) not null default 0,
  lock_until timestamptz,                       -- one turn at a time
  lock_token uuid,                              -- the turn that holds the lock (finish/decide must present it)
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists setup_conversations_user_idx on public.setup_conversations (user_id);
create index if not exists setup_conversations_activity_idx on public.setup_conversations (last_activity_at);

create table if not exists public.setup_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.setup_conversations(id) on delete cascade,
  seq int not null,
  role text not null check (role in ('user', 'assistant', 'note')),
  text text not null default '' check (length(text) <= 2000),
  blocks jsonb not null default '[]'::jsonb check (jsonb_typeof(blocks) = 'array' and octet_length(blocks::text) < 16000),
  client_turn_id text check (length(client_turn_id) <= 64),   -- set on the customer's input only (message, button, event)
  model_json jsonb,                              -- the assistant turn as sent back to the model (replay)
  tokens_in int, tokens_out int, cost_usd numeric(10,4),     -- the turn's usage, on its input message
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
create unique index if not exists setup_messages_turn_idx on public.setup_messages (conversation_id, client_turn_id)
  where client_turn_id is not null;
create index if not exists setup_messages_created_idx on public.setup_messages (created_at);

create table if not exists public.setup_proposals (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.setup_conversations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  topic text not null check (length(topic) <= 40),
  item_key text not null check (item_key in ('hours', 'faq', 'alerts', 'calendar', 'tools', 'forward_calls')),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) < 20000),  -- the FULL item data written
  base_hash text not null check (length(base_hash) <= 128),   -- item data + config subset at proposal time
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'superseded', 'failed')),
  shown_seq int not null,                        -- the assistant message that carried the card
  error text check (length(error) <= 120),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists setup_proposals_conv_idx on public.setup_proposals (conversation_id, status);
create index if not exists setup_proposals_client_idx on public.setup_proposals (client_id);

alter table private.settings add column if not exists setup_agent_enabled boolean not null default false;
alter table private.settings add column if not exists setup_agent_daily_budget_usd numeric not null default 30;
alter table private.settings add column if not exists setup_agent_paused_until timestamptz;

-- ================================================================ RLS: the owner (and admin) read; nobody writes through the API
alter table public.setup_conversations enable row level security;
alter table public.setup_messages enable row level security;
alter table public.setup_proposals enable row level security;

drop policy if exists setup_conversations_select on public.setup_conversations;
create policy setup_conversations_select on public.setup_conversations for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));
drop policy if exists setup_messages_select on public.setup_messages;
create policy setup_messages_select on public.setup_messages for select to authenticated
  using (exists (select 1 from public.setup_conversations c where c.id = conversation_id
                  and ((select private.owns_client(c.client_id)) or (select private.is_admin()))));
drop policy if exists setup_proposals_select on public.setup_proposals;
create policy setup_proposals_select on public.setup_proposals for select to authenticated
  using ((select private.owns_client(client_id)) or (select private.is_admin()));

revoke all on public.setup_conversations, public.setup_messages, public.setup_proposals from public, anon, authenticated;
grant select on public.setup_conversations, public.setup_messages, public.setup_proposals to authenticated;
grant all on public.setup_conversations, public.setup_messages, public.setup_proposals to service_role;
revoke all on sequence public.setup_messages_id_seq from public, anon, authenticated;
grant usage, select on sequence public.setup_messages_id_seq to service_role;

-- ================================================================ helpers
-- the user's FirstRing plan client (same rule as private.my_sub_client(), for a user id given by the Edge Function)
create or replace function private.setup_agent_client(p_user uuid) returns public.clients
language sql stable security definer set search_path = '' as $$
  select c.* from public.clients c where c.user_id = p_user and c.billing_mode = 'subscription'
   order by c.created_at desc limit 1
$$;

-- today's (UTC) spend of the assistant across every conversation
create or replace function private.setup_agent_spent_today() returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(m.cost_usd), 0) from public.setup_messages m
   where m.created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc') and m.cost_usd is not null
$$;

-- the conversation of THIS user, locked for the rest of the transaction; raises when it is not theirs
create or replace function private.setup_agent_conv(p_conversation uuid, p_user uuid) returns public.setup_conversations
language plpgsql security definer set search_path = '' as $$
declare cv public.setup_conversations; cl public.clients;
begin
  select * into cv from public.setup_conversations c where c.id = p_conversation for update;
  if not found or cv.user_id is distinct from p_user then raise exception 'not_your_conversation' using errcode = '42501'; end if;
  select * into cl from public.clients c where c.id = cv.client_id;
  if cl.user_id is distinct from p_user or cl.billing_mode is distinct from 'subscription' then
    raise exception 'not_a_plan_client' using errcode = '42501';
  end if;
  return cv;
end $$;

-- the switches every turn sees: kill switch, pause after a provider alert, global daily budget
create or replace function private.setup_agent_switches() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', coalesce(s.setup_agent_enabled, false), 'paused_until', s.setup_agent_paused_until,
                            'budget_usd', s.setup_agent_daily_budget_usd, 'spent_today_usd', private.setup_agent_spent_today())
    from private.settings s where s.id = 1
$$;

-- inputs (messages, buttons, events) of a conversation in the last p_window, for the rate limits
create or replace function private.setup_agent_inputs(p_conversation uuid, p_window interval) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.setup_messages m
   where m.conversation_id = p_conversation and m.client_turn_id is not null and m.created_at > now() - p_window
$$;

-- ================================================================ service RPCs (setup-agent Edge Function, service role only)
create or replace function public.setup_agent_open(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cl public.clients; cv public.setup_conversations; t public.tenants; sim text; num text;
begin
  perform private.require_service();
  if p_user is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  cl := private.setup_agent_client(p_user);
  if cl.id is null then raise exception 'not_a_plan_client' using errcode = '42501'; end if;
  insert into public.setup_conversations (client_id, user_id) values (cl.id, p_user) on conflict (client_id) do nothing;
  select * into cv from public.setup_conversations c where c.client_id = cl.id;
  if cv.user_id is distinct from p_user then   -- the client card moved to another user: the old transcript is not theirs
    delete from public.setup_conversations c where c.id = cv.id;
    insert into public.setup_conversations (client_id, user_id) values (cl.id, p_user) returning * into cv;
  end if;
  select * into t from public.tenants x where x.client_id = cl.id order by x.created_at limit 1;
  select j.status into sim from public.provisioning_jobs j where j.client_id = cl.id and j.kind = 'golive_sim' order by j.updated_at desc limit 1;
  select j.status into num from public.provisioning_jobs j where j.client_id = cl.id and j.kind = 'number' order by j.updated_at desc limit 1;
  return jsonb_build_object(
    'conversation', to_jsonb(cv) - 'lock_token',
    'client', jsonb_build_object('id', cl.id, 'status', cl.status, 'business_name', cl.business_name),
    'golive', jsonb_build_object('client_status', cl.status, 'has_number', t.twilio_number is not null, 'sim_status', sim,
                                 'number_status', num),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'seq', x.seq, 'role', x.role, 'text', x.text,
                            'blocks', x.blocks, 'created_at', x.created_at, 'input', x.client_turn_id is not null,
                            'client_turn_id', x.client_turn_id) order by x.seq)
                          from (select * from public.setup_messages m where m.conversation_id = cv.id order by m.seq desc limit 200) x), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'topic', p.topic, 'item_key', p.item_key, 'status', p.status,
                             'shown_seq', p.shown_seq, 'error', p.error) order by p.created_at)
                           from (select * from public.setup_proposals q where q.conversation_id = cv.id order by q.created_at desc limit 200) p), '[]'::jsonb),
    'switches', private.setup_agent_switches(),
    'limits', jsonb_build_object('messages_left_today', greatest(0, 150 - private.setup_agent_inputs(cv.id, interval '24 hours'))));
end $$;

-- p_role: 'user' (typed message or button) | 'note' (an event) | 'none' (server greeting: lock only, nothing inserted)
-- p_needs_model: the turn will call the model (the kill switch is always checked; pause + budget only then)
create or replace function public.setup_agent_begin_turn(p_conversation uuid, p_user uuid, p_client_turn_id text, p_role text,
                                                         p_text text, p_blocks jsonb default '[]'::jsonb,
                                                         p_needs_model boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cv public.setup_conversations; m public.setup_messages; sw jsonb; v_seq int; v_retry boolean := false; nxt int;
  replies jsonb; n_min int; n_hour int; n_day int; n_all int; tok uuid; oldest timestamptz; retry_s int; v_id bigint; v_at timestamptz;
begin
  perform private.require_service();
  cv := private.setup_agent_conv(p_conversation, p_user);
  if p_role is null or p_role not in ('user', 'note', 'none') then raise exception 'bad_input' using errcode = 'P0001'; end if;
  if p_role <> 'none' and (p_client_turn_id is null or p_client_turn_id !~ '^[A-Za-z0-9_-]{8,64}$') then
    raise exception 'bad_input' using errcode = 'P0001'; end if;
  if length(coalesce(p_text, '')) > 1000 or jsonb_typeof(coalesce(p_blocks, '[]'::jsonb)) <> 'array' then
    raise exception 'bad_input' using errcode = 'P0001'; end if;
  sw := private.setup_agent_switches();
  if not coalesce((sw ->> 'enabled')::boolean, false) then return jsonb_build_object('error', 'disabled'); end if;

  -- idempotency: a known client_turn_id returns the stored reply; a stored input without a reply is a retry
  if p_role <> 'none' then
    select * into m from public.setup_messages x where x.conversation_id = cv.id and x.client_turn_id = p_client_turn_id;
    if found then
      select min(x.seq) into nxt from public.setup_messages x
       where x.conversation_id = cv.id and x.seq > m.seq and x.client_turn_id is not null;
      select jsonb_agg(jsonb_build_object('id', x.id, 'seq', x.seq, 'role', x.role, 'text', x.text, 'blocks', x.blocks,
                                          'created_at', x.created_at) order by x.seq) into replies
        from public.setup_messages x
       where x.conversation_id = cv.id and x.seq > m.seq and (nxt is null or x.seq < nxt) and x.client_turn_id is null;
      if replies is not null or m.role = 'note' then
        return jsonb_build_object('replay', true, 'seq', m.seq, 'messages', coalesce(replies, '[]'::jsonb));
      end if;
      v_retry := true; v_seq := m.seq; v_id := m.id; v_at := m.created_at;
    end if;
  end if;
  if cv.lock_until is not null and cv.lock_until > now() then return jsonb_build_object('error', 'turn_in_progress'); end if;

  if p_needs_model then
    if (sw ->> 'paused_until') is not null and (sw ->> 'paused_until')::timestamptz > now() then
      return jsonb_build_object('error', 'paused',
        'retry_after_s', ceil(extract(epoch from (sw ->> 'paused_until')::timestamptz - now()))::int);
    end if;
    if (sw ->> 'spent_today_usd')::numeric >= (sw ->> 'budget_usd')::numeric then
      return jsonb_build_object('error', 'budget', 'retry_after_s',
        ceil(extract(epoch from (date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc' - now()))::int);
    end if;
  end if;

  if p_role <> 'none' and not v_retry then
    -- per-user limits (one conversation per client): 12 a minute, 60 an hour, 150 a day, 600 in total
    n_all := (select count(*)::int from public.setup_messages x where x.conversation_id = cv.id and x.client_turn_id is not null);
    if n_all >= 600 then return jsonb_build_object('error', 'limit'); end if;
    n_min := private.setup_agent_inputs(cv.id, interval '1 minute');
    n_hour := private.setup_agent_inputs(cv.id, interval '1 hour');
    n_day := private.setup_agent_inputs(cv.id, interval '24 hours');
    if n_min >= 12 or n_hour >= 60 or n_day >= 150 then
      select min(x.created_at) into oldest from (select y.created_at from public.setup_messages y
        where y.conversation_id = cv.id and y.client_turn_id is not null
          and y.created_at > now() - case when n_day >= 150 then interval '24 hours' when n_hour >= 60 then interval '1 hour' else interval '1 minute' end
        order by y.created_at desc limit case when n_day >= 150 then 150 when n_hour >= 60 then 60 else 12 end) x;
      retry_s := greatest(1, ceil(extract(epoch from oldest + case when n_day >= 150 then interval '24 hours'
                                    when n_hour >= 60 then interval '1 hour' else interval '1 minute' end - now()))::int);
      return jsonb_build_object('error', 'rate_limited', 'retry_after_s', retry_s);
    end if;
    select coalesce(max(x.seq), 0) + 1 into v_seq from public.setup_messages x where x.conversation_id = cv.id;
    insert into public.setup_messages (conversation_id, seq, role, text, blocks, client_turn_id)
    values (cv.id, v_seq, p_role, coalesce(p_text, ''), coalesce(p_blocks, '[]'::jsonb), p_client_turn_id)
    returning id, created_at into v_id, v_at;
  end if;

  tok := gen_random_uuid();
  update public.setup_conversations c set lock_until = now() + interval '90 seconds', lock_token = tok, last_activity_at = now()
   where c.id = cv.id;
  return jsonb_build_object('ok', true, 'seq', v_seq, 'retry', v_retry, 'lock', tok, 'input_id', v_id, 'input_at', v_at,
    'input_text', (select x.text from public.setup_messages x where x.id = v_id),
    'state', cv.state, 'topic', cv.topic, 'status', cv.status, 'turns', cv.turns,
    'message_count', (select count(*)::int from public.setup_messages x where x.conversation_id = cv.id),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'topic', p.topic, 'item_key', p.item_key, 'data', p.data,
                           'base_hash', p.base_hash, 'shown_seq', p.shown_seq) order by p.created_at)
                         from public.setup_proposals p where p.conversation_id = cv.id and p.status = 'pending'), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('seq', x.seq, 'role', x.role, 'text', x.text, 'model_json', x.model_json,
                           'input', x.client_turn_id is not null) order by x.seq)
                         from (select * from public.setup_messages y where y.conversation_id = cv.id
                                  and (v_seq is null or y.seq < v_seq) order by y.seq desc limit 60) x), '[]'::jsonb),
    'limits', jsonb_build_object('messages_left_today', greatest(0, 150 - private.setup_agent_inputs(cv.id, interval '24 hours'))));
end $$;

-- the lock holder only; checked again on every write of the turn
create or replace function private.setup_agent_held(p_conversation uuid, p_lock uuid) returns public.setup_conversations
language plpgsql security definer set search_path = '' as $$
declare cv public.setup_conversations;
begin
  select * into cv from public.setup_conversations c where c.id = p_conversation for update;
  if not found or p_lock is null or cv.lock_token is distinct from p_lock then raise exception 'lock_lost' using errcode = 'P0001'; end if;
  return cv;
end $$;

-- p_turn: {messages: [{role, text, blocks, model_json}], proposals: [{id, topic, item_key, data, base_hash, msg_index}],
--          state, topic, status, input_seq, usage: {model, tokens_in, tokens_out, cost_usd}}
create or replace function public.setup_agent_finish_turn(p_conversation uuid, p_lock uuid, p_turn jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cv public.setup_conversations; v_seq int; i int; msg jsonb; seqs int[] := '{}'; ids jsonb := '[]'::jsonb; pr jsonb; r record;
  n_msg int; n_pr int; v_model text; t_in bigint; t_out bigint; v_cost numeric;
begin
  perform private.require_service();
  cv := private.setup_agent_held(p_conversation, p_lock);
  if jsonb_typeof(p_turn) is distinct from 'object' then raise exception 'bad_turn' using errcode = 'P0001'; end if;
  n_msg := coalesce(jsonb_array_length(case when jsonb_typeof(p_turn -> 'messages') = 'array' then p_turn -> 'messages' end), 0);
  n_pr := coalesce(jsonb_array_length(case when jsonb_typeof(p_turn -> 'proposals') = 'array' then p_turn -> 'proposals' end), 0);
  if n_msg > 8 or n_pr > 4 then raise exception 'bad_turn' using errcode = 'P0001'; end if;
  select coalesce(max(x.seq), 0) into v_seq from public.setup_messages x where x.conversation_id = cv.id;
  for i in 0 .. n_msg - 1 loop
    msg := p_turn -> 'messages' -> i;
    if coalesce(msg ->> 'role', '') not in ('assistant', 'note') then raise exception 'bad_turn' using errcode = 'P0001'; end if;
    v_seq := v_seq + 1;
    insert into public.setup_messages (conversation_id, seq, role, text, blocks, model_json)
    values (cv.id, v_seq, msg ->> 'role', coalesce(msg ->> 'text', ''), coalesce(msg -> 'blocks', '[]'::jsonb),
            case when jsonb_typeof(msg -> 'model_json') = 'object' then msg -> 'model_json' end)
    returning jsonb_build_object('id', id, 'seq', seq, 'created_at', created_at) into pr;
    seqs := seqs || v_seq; ids := ids || jsonb_build_array(pr);
  end loop;
  for i in 0 .. n_pr - 1 loop
    pr := p_turn -> 'proposals' -> i;
    if (pr ->> 'msg_index') is null or (pr ->> 'msg_index')::int not between 0 and n_msg - 1
       or coalesce(pr ->> 'topic', '') !~ '^[a-z_]{2,40}$' then
      raise exception 'bad_turn' using errcode = 'P0001'; end if;
    -- a newer card for the same topic replaces the older pending one
    update public.setup_proposals p set status = 'superseded', decided_at = now()
     where p.conversation_id = cv.id and p.topic = pr ->> 'topic' and p.status = 'pending';
    insert into public.setup_proposals (id, conversation_id, client_id, topic, item_key, data, base_hash, shown_seq)
    values ((pr ->> 'id')::uuid, cv.id, cv.client_id, pr ->> 'topic', pr ->> 'item_key', pr -> 'data', pr ->> 'base_hash',
            seqs[(pr ->> 'msg_index')::int + 1]);
  end loop;
  v_model := left(nullif(p_turn #>> '{usage,model}', ''), 80);
  t_in := greatest(0, coalesce((p_turn #>> '{usage,tokens_in}')::bigint, 0));
  t_out := greatest(0, coalesce((p_turn #>> '{usage,tokens_out}')::bigint, 0));
  v_cost := least(10, greatest(0, coalesce((p_turn #>> '{usage,cost_usd}')::numeric, 0)));
  if (p_turn ->> 'input_seq') is not null and (t_in > 0 or t_out > 0 or v_cost > 0) then
    update public.setup_messages x set tokens_in = coalesce(x.tokens_in, 0) + t_in, tokens_out = coalesce(x.tokens_out, 0) + t_out,
           cost_usd = coalesce(x.cost_usd, 0) + v_cost
     where x.conversation_id = cv.id and x.seq = (p_turn ->> 'input_seq')::int;
  end if;
  update public.setup_conversations c
     set state = case when jsonb_typeof(p_turn -> 'state') = 'object' then p_turn -> 'state' else c.state end,
         topic = case when p_turn ? 'topic' then left(p_turn ->> 'topic', 40) else c.topic end,
         status = case when p_turn ->> 'status' in ('active', 'complete') then p_turn ->> 'status' else c.status end,
         completed_at = case when p_turn ->> 'status' = 'complete' then coalesce(c.completed_at, now())
                             when p_turn ->> 'status' = 'active' then null else c.completed_at end,
         turns = c.turns + case when n_msg > 0 then 1 else 0 end,
         model = coalesce(v_model, c.model), tokens_in = c.tokens_in + t_in, tokens_out = c.tokens_out + t_out,
         cost_usd = c.cost_usd + v_cost, lock_until = null, lock_token = null, last_activity_at = now()
   where c.id = cv.id;
  return jsonb_build_object('messages', ids);
end $$;

-- a stored proposal changes state once: pending -> confirmed | failed | superseded. A confirm must come after the card.
create or replace function public.setup_agent_decide(p_conversation uuid, p_lock uuid, p_proposal uuid, p_status text,
                                                     p_error text default null, p_seq int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cv public.setup_conversations; pr public.setup_proposals;
begin
  perform private.require_service();
  cv := private.setup_agent_held(p_conversation, p_lock);
  if p_status is null or p_status not in ('confirmed', 'failed', 'superseded') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  select * into pr from public.setup_proposals p where p.id = p_proposal and p.conversation_id = cv.id for update;
  if not found then raise exception 'unknown_proposal' using errcode = 'P0001'; end if;
  if pr.status <> 'pending' then raise exception 'proposal_not_pending' using errcode = 'P0001'; end if;
  if p_status = 'confirmed' and (p_seq is null or pr.shown_seq >= p_seq) then raise exception 'confirm_before_card' using errcode = 'P0001'; end if;
  update public.setup_proposals p set status = p_status, error = left(p_error, 120), decided_at = now()
   where p.id = pr.id returning * into pr;
  return jsonb_build_object('id', pr.id, 'status', pr.status);
end $$;

-- provider trouble: one admin e-mail per kind per day; budget / auth also pause the assistant for an hour
create or replace function public.setup_agent_alert(p_user uuid, p_kind text, p_detail text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare cl public.clients;
begin
  perform private.require_service();
  if p_kind is null or p_kind not in ('budget', 'auth', 'down') then raise exception 'bad_kind' using errcode = 'P0001'; end if;
  cl := private.setup_agent_client(p_user);
  perform private.log_event('client', cl.id, p_user, 'setup_agent_' || p_kind, jsonb_build_object('detail', left(coalesce(p_detail, ''), 300)), false);
  perform private.enqueue_email_safe('admin_provisioning_alert',
    'admin_provisioning_alert:setup_agent:' || p_kind || ':' || to_char(now() at time zone 'utc', 'YYYYMMDD'),
    'client', cl.id, p_user, jsonb_build_object('step', 'setup_agent_' || p_kind,
      'error', 'Setup assistant: ' || left(coalesce(nullif(p_detail, ''), p_kind), 300)));
  if p_kind in ('budget', 'auth') then
    update private.settings s set setup_agent_paused_until = greatest(coalesce(s.setup_agent_paused_until, now()), now() + interval '1 hour')
     where s.id = 1;
  end if;
end $$;

-- ================================================================ preview (the customer's JWT): what saving this step would do
-- Same ownership rule as update_onboarding_item, plan clients only; returns private.onboarding_patch(key, item.data || data,
-- config), the expression onboarding_apply evaluates, so it raises the same invalid_setting:<path>. With p_status 'done' on
-- the calendar step it also mirrors the calendar_not_connected check. Writes nothing.
create or replace function public.setup_preview_step(p_item uuid, p_data jsonb, p_status public.onboarding_status default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare it public.onboarding_items; cl public.clients; cfg jsonb; merged jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  select * into it from public.onboarding_items o where o.id = p_item;
  if not found or not (private.owns_client(it.client_id) or private.is_admin()) then
    raise exception 'not_your_item' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'data_must_be_object' using errcode = 'P0001'; end if;
  select * into cl from public.clients c where c.id = it.client_id;
  if cl.billing_mode is distinct from 'subscription' then raise exception 'not_a_plan_client' using errcode = 'P0001'; end if;
  merged := it.data || p_data;
  if octet_length(merged::text) >= 20000 then raise exception 'data_too_large' using errcode = 'P0001'; end if;
  if it.key = 'calendar' and p_status = 'done' and coalesce(merged ->> 'booking_mode', '') <> 'messages_only'
     and not exists (select 1 from public.tenants x join private.tenant_credentials k on k.tenant_id = x.id
                      where x.client_id = it.client_id and k.provider::text = coalesce(merged ->> 'provider', '')) then
    raise exception 'calendar_not_connected' using errcode = 'P0001';
  end if;
  select x.config into cfg from public.tenants x where x.client_id = it.client_id order by x.created_at limit 1;
  return private.onboarding_patch(it.key, merged, coalesce(cfg, '{}'::jsonb));
end $$;

-- ================================================================ retention: 90 days after the last activity
create or replace function private.setup_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_msg int; n_pr int; n_conv int;
begin
  with old as (select c.id from public.setup_conversations c where c.last_activity_at < now() - interval '90 days'),
       d as (delete from public.setup_messages m using old where m.conversation_id = old.id returning 1)
  select count(*)::int into n_msg from d;
  with old as (select c.id from public.setup_conversations c where c.last_activity_at < now() - interval '90 days'),
       d as (delete from public.setup_proposals p using old where p.conversation_id = old.id returning 1)
  select count(*)::int into n_pr from d;
  -- the row stays (counters, cost); its memory (partial answers) goes with the text
  update public.setup_conversations c set state = '{}'::jsonb, topic = null
   where c.last_activity_at < now() - interval '90 days' and (c.state <> '{}'::jsonb or c.topic is not null);
  get diagnostics n_conv = row_count;
  perform private.log_event('retention', null, null, 'setup_retention_run',
    jsonb_build_object('messages', n_msg, 'proposals', n_pr, 'conversations', n_conv), false);
  return jsonb_build_object('messages', n_msg, 'proposals', n_pr, 'conversations', n_conv);
end $$;

-- a client anonymised by retention (private.anonymize_client) loses its setup conversation at once
create or replace function private.setup_agent_client_anonymized() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.setup_conversations c where c.client_id = new.id;
  return null;
end $$;
drop trigger if exists setup_agent_client_anonymized on public.clients;
create trigger setup_agent_client_anonymized after update of anonymized_at on public.clients
  for each row when (new.anonymized_at is not null and old.anonymized_at is null)
  execute function private.setup_agent_client_anonymized();

select cron.schedule('ailab-us-setup-retention', '29 3 * * *', 'select private.setup_retention()');

-- ================================================================ privileges
revoke all on function private.setup_agent_client(uuid), private.setup_agent_spent_today(), private.setup_agent_conv(uuid, uuid),
  private.setup_agent_switches(), private.setup_agent_inputs(uuid, interval), private.setup_agent_held(uuid, uuid),
  private.setup_retention(), private.setup_agent_client_anonymized() from public, anon, authenticated;
grant execute on function private.setup_agent_client(uuid), private.setup_agent_spent_today(), private.setup_agent_conv(uuid, uuid),
  private.setup_agent_switches(), private.setup_agent_inputs(uuid, interval), private.setup_agent_held(uuid, uuid),
  private.setup_retention() to service_role;

revoke all on function public.setup_agent_open(uuid),
  public.setup_agent_begin_turn(uuid, uuid, text, text, text, jsonb, boolean),
  public.setup_agent_finish_turn(uuid, uuid, jsonb),
  public.setup_agent_decide(uuid, uuid, uuid, text, text, int),
  public.setup_agent_alert(uuid, text, text) from public, anon, authenticated;
grant execute on function public.setup_agent_open(uuid),
  public.setup_agent_begin_turn(uuid, uuid, text, text, text, jsonb, boolean),
  public.setup_agent_finish_turn(uuid, uuid, jsonb),
  public.setup_agent_decide(uuid, uuid, uuid, text, text, int),
  public.setup_agent_alert(uuid, text, text) to service_role;

revoke all on function public.setup_preview_step(uuid, jsonb, public.onboarding_status) from public, anon;
grant execute on function public.setup_preview_step(uuid, jsonb, public.onboarding_status) to authenticated, service_role;
