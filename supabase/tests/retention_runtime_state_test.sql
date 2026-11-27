-- Retention of the runtime's caller data (20261129100000_us_retention_runtime_state.sql): private.run_retention() deletes
-- conversation rows (runtime_state convo:%), per-caller runtime state and caller-detail event rows 90 days after their
-- last write, and keeps everything younger, the counters, idempotency flags, SMS thread counters and other events.
-- One DO block; ALWAYS ends with an error so it rolls back. Success = message starts with RETENTION_STATE_TESTS_PASSED.
-- Offline: deno run -A --node-modules-dir=none supabase/tests/offline/retention_runtime_state_run.ts
do $$
declare
  u uuid := gen_random_uuid(); cl uuid; t uuid; j jsonb; n int; c int := 0;
  old constant timestamptz := now() - interval '91 days';
  young constant timestamptz := now() - interval '89 days';
  k text;
begin
  insert into auth.users (id, email) values (u, 'ret-state@example.com');
  insert into public.clients (user_id, products) values (u, '{RCP}') returning id into cl;
  insert into public.tenants (client_id, slug, config) values (cl, 'ret-state-tenant', '{}') returning id into t;

  -- runtime_state: what must go (older than 90 days) ...
  insert into public.runtime_state (key, tenant_id, value, updated_at) values
    ('convo:' || t || ':voice:CA_old', t, '{"transcript":[{"who":"customer","text":"I am Dana at 1 Main St"}],"collected":{"name":"Dana"}}', old),
    ('convo:' || t || ':sms:sms-abc-1', t, '{"transcript":[{"who":"customer","text":"hi"}]}', old),
    ('lookup:abc123', null, '{"type":"mobile"}', old),
    ('lang:' || t || ':abc123', t, '"es"', old),
    ('textback:' || t || ':abc123', t, '"2026-01-01T00:00:00+00:00"', old),
    ('safetextback:' || t || ':abc123:2026-01-01', t, 'true', old),
    ('limit:' || t || ':abc123', t, '{"episodes":1}', old),
    ('review:' || t || ':abc123', t, '"2026-01-01T00:00:00+00:00"', old);
  -- ... and what must stay: younger conversations / caller state, counters, flags, thread counters, queue rows
  insert into public.runtime_state (key, tenant_id, value, updated_at) values
    ('convo:' || t || ':voice:CA_young', t, '{"transcript":[]}', young),
    ('lang:' || t || ':def456', t, '"en"', young),
    ('smsthread:' || t || ':abc123', t, '{"n":1}', old),
    ('usage:' || t || ':2026-08:voice_minutes', t, '12', old),
    ('sent:' || t || ':lead_alert:x:email', t, 'true', old),
    ('jobs:' || t, t, '[]', old),
    ('spend:global:2026-08-01', null, '1.5', old),
    ('outq:index', null, '[]', old);

  -- events: runtime rows that copy caller details go after 90 days; other events stay
  insert into public.events (actor, entity, entity_id, type, payload, created_at) values
    ('runtime', 'tenant', t, 'zapier.pending', '{"event":"lead.created","name":"Dana","address":"1 Main St"}', old),
    ('runtime', 'tenant', t, 'alert.pending', '{"kind":"lead","contact":"+17135550123","summary":"AC broken"}', old),
    ('runtime', 'tenant', t, 'zapier.dead_letter', '{"event":"lead.created","payload":{"data":{"name":"Dana"}}}', old),
    ('runtime', 'email', null, 'email.outbox', '{"to":["owner@example.com"],"text":"Dana, 1 Main St"}', old),
    ('runtime', 'sms', null, 'sms.outbox', '{"to":"+17135550123","body":"hi"}', old),
    ('runtime', 'tenant', t, 'zapier.pending', '{"event":"lead.created","name":"Young"}', young),
    ('runtime', 'tenant', t, 'appointment.rescheduled', '{}', old),            -- monthly Results history
    ('runtime', 'tenant', t, 'usage.alert', '{"kind":"usage_80"}', old),
    ('admin:' || u, 'tenant', t, 'zapier.pending', '{"note":"not a runtime row"}', old);

  j := private.run_retention();

  -- deleted
  select count(*) into n from public.runtime_state where tenant_id = t and key like 'convo:%' and updated_at < now() - interval '90 days';
  if n <> 0 then raise exception 'FAIL old conversations kept (%)', n; end if; c := c + 1;
  foreach k in array array['lookup:abc123', 'lang:' || t || ':abc123', 'textback:' || t || ':abc123',
                           'safetextback:' || t || ':abc123:2026-01-01', 'limit:' || t || ':abc123', 'review:' || t || ':abc123'] loop
    if exists (select 1 from public.runtime_state where key = k) then raise exception 'FAIL old caller state kept: %', k; end if; c := c + 1;
  end loop;
  select count(*) into n from public.events where entity_id = t and type in ('zapier.pending', 'alert.pending', 'zapier.dead_letter')
     and actor = 'runtime' and created_at < now() - interval '90 days';
  if n <> 0 then raise exception 'FAIL old caller events kept (%)', n; end if; c := c + 1;
  select count(*) into n from public.events where type in ('email.outbox', 'sms.outbox') and created_at < now() - interval '90 days';
  if n <> 0 then raise exception 'FAIL old outbox copies kept (%)', n; end if; c := c + 1;
  if (j ->> 'convo_deleted')::int < 2 or (j ->> 'caller_state_deleted')::int < 6 or (j ->> 'caller_events_deleted')::int < 5 then
    raise exception 'FAIL retention counts %', j; end if; c := c + 1;

  -- kept
  if not exists (select 1 from public.runtime_state where key = 'convo:' || t || ':voice:CA_young') then
    raise exception 'FAIL a conversation younger than 90 days was deleted'; end if; c := c + 1;
  if not exists (select 1 from public.runtime_state where key = 'lang:' || t || ':def456') then
    raise exception 'FAIL young caller state deleted'; end if; c := c + 1;
  select count(*) into n from public.runtime_state where tenant_id = t and (key like 'smsthread:%' or key like 'usage:%'
     or key like 'sent:%' or key like 'jobs:%');
  if n <> 4 then raise exception 'FAIL counters / flags / thread counters deleted (% of 4 left)', n; end if; c := c + 1;
  if not exists (select 1 from public.runtime_state where key = 'spend:global:2026-08-01')
     or not exists (select 1 from public.runtime_state where key = 'outq:index') then
    raise exception 'FAIL global state deleted'; end if; c := c + 1;
  select count(*) into n from public.events where entity_id = t
     and (type in ('appointment.rescheduled', 'usage.alert') or actor <> 'runtime' or created_at > now() - interval '90 days');
  if n <> 4 then raise exception 'FAIL other events deleted (% of 4 left)', n; end if; c := c + 1;
  if not exists (select 1 from public.tenants where id = t) then raise exception 'FAIL the tenant itself was touched'; end if; c := c + 1;
  select count(*) into n from public.events where type = 'retention_run' and payload ? 'convo_deleted';
  if n < 1 then raise exception 'FAIL retention_run event has no convo count'; end if; c := c + 1;

  -- idempotent: a second run deletes nothing more of ours
  j := private.run_retention();
  if (select count(*) from public.runtime_state where tenant_id = t) <> 6 then
    raise exception 'FAIL second run changed kept rows'; end if; c := c + 1;

  raise exception 'RETENTION_STATE_TESTS_PASSED (% checks)', c;
end $$;
