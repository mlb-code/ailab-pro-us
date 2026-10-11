# supabase/tests

| File | What it is |
|---|---|
| `rls_test.sql` | One `DO` block: creates 4 users (client A, client B, admin, cancelled client C), fixtures in every table, then checks RLS, guard triggers, RPC whitelists, storage policies, anon access and the retention/expiry jobs (159 checks). It **always ends with an error** so everything rolls back. Success = message starts with `RLS_TESTS_PASSED`; failure = `FAIL <which check>`. |
| `offline/supabase_shim.sql` | OFFLINE ONLY. Minimal stand-in for Supabase internals (roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`, `storage.buckets/objects`, `storage.foldername()`, `cron.schedule()`, Supabase's default grants, and the `storage.protect_delete` trigger that blocks direct DELETE on storage tables). Never apply to a real project. |
| `offline/run.ts` | Runs everything in real Postgres 18 compiled to WASM (PGlite), in-process. No Docker, no Supabase project. |

## Retention (what `private.run_retention()` does, daily 03:17 UTC via pg_cron)

| Data | Rule |
|---|---|
| Call transcripts, summaries, caller number (`from_e164`) | cleared after 90 days (row kept: outcome, duration, cost; no number hash — a hashed US number is reversible) |
| SMS messages | deleted after 90 days |
| Bookings | deleted 2 years after the job date |
| Cancelled client, 30 days after `ended_at` | `private.anonymize_client()`: **personal + operational data deleted** — tenant (→ calls/SMS/bookings/opt-outs/credentials), onboarding items, requests (+ attachments), **every `private.quote_drafts` row** of the client's quotes (Claude raw output), **every `admin_notes` row on the client's entities** (client, its quotes, questionnaires, tenants, requests, leads with the same e-mail). If the user has no other live client and is not admin: also the user's events, unaccepted quotes, leads with the same e-mail and the auth user (→ profile, questionnaires, attachments). |
| Bookkeeping records (Israeli bookkeeping law: keep 7 years) | **kept, anonymised**: `clients` row (client_id, `business_name` snapshot, products, amounts, `user_id = null`, `anonymized_at`), `payments` (amounts/kind/status/dates; e-mails and phone numbers scrubbed from `reference`), the accepted quote = the order (line items reduced to code/qty/name/kind/amounts, totals, agreement version, `accepted_at`). Removed from it: `scope_md`, `timeline_text`, `assumptions`, item `reason`, signer name/IP/UA, `user_id`. Its `public_token` is replaced by a fresh random value and `anonymized = true` (one-way, guarded). **A6: `quote-view` / `quote-accept` must refuse any quote with `anonymized = true`.** There is no separate `orders` table. |
| Failure isolation | the 90-day / 2-year cleanup runs first and never depends on clients; each client is anonymised in its own `begin … exception` block — on error a `retention_error` event (`entity='client'`, payload `client_id`, `error`, `sqlstate`) is logged, nothing of that client is changed, the loop continues, and the client is retried the next day. |
| Storage files | cannot be deleted safely from SQL: `private.queue_storage_purge(uid)` puts every `client-files/{uid}/…` object into `private.storage_purge_queue`. **Physical deletion via the Storage API (service role) is done by A8/B6**, which then set `done_at`. |

Tested in `rls_test.sql` (client C section): drafts = 0, notes = 0 on all entities, no name/phone in the kept quote, old token no longer resolves, anonymisation irreversible, forced failure of one client → `retention_error` + others processed, retry, idempotent re-run.

## Run offline (no Docker, no project)

```bash
deno run -A --node-modules-dir=none supabase/tests/offline/run.ts            # full run (~5 s)
deno run -A --node-modules-dir=none supabase/tests/offline/run.ts --no-mutations
python3 tools/sql_lint.py supabase/migrations                                # static lint, stdlib only
```

`run.ts` does:
1. loads the shim, applies every migration **twice** (idempotency);
2. catalog checks: RLS on every `public` table, ≥ 1 policy each, no `(true)` policies, anon has no table grants and can execute only `public.ping()`, `private.*` not granted to API roles, buckets, cron jobs, niche enum (`home_services, real_estate, dental`; no law);
3. runs `rls_test.sql` and verifies the rollback left nothing behind;
4. **mutation self-test**: breaks one protection at a time (10 mutations: unsent quotes visible, profile guard dropped, anon lead read, storage path check, request guard, one-active index, RLS off on calls, credentials readable by clients, retention that only flags the client, tenant whitelist bypass) and asserts `rls_test.sql` catches each.

Never `delete from storage.*` in tests or functions (real Supabase raises; files go through `private.storage_purge_queue` + Storage API). The rollback is guaranteed on a real project too: the whole test is one `DO` statement.

Offline differences from a real project: `create extension pg_cron|pg_net` lines are skipped (the shim provides `cron.schedule`); Postgres 18 (PGlite) vs 17 (Supabase); storage/auth are simplified tables, so Storage API behaviour (MIME/size limits, upsert) is not exercised.

## Run against a real project (after A2)

- `python3 tools/us_setup.py --only test` (runs `rls_test.sql` through the Management API), or
- Supabase SQL editor: paste `rls_test.sql`, run, expect `ERROR: RLS_TESTS_PASSED (159 checks)`, or
- with Docker + Supabase CLI: `supabase db reset && psql "$LOCAL_DB" -f supabase/tests/rls_test.sql`.

### Manual checks that only a real project can prove
1. `select * from cron.job` shows `ailab-us-retention` and `ailab-us-expire-quotes`.
2. PostgREST: `GET /rest/v1/settings` with the anon key → 404/401 (`private` is not an exposed schema).
3. Storage API: upload 11 MB to `client-files` → rejected; upload `.exe` → rejected (MIME list); `videos-public` file reachable by public URL without auth.
4. Re-run all migrations from the SQL editor → no errors (idempotent).
