// Offline runner for supabase/tests/email_events_test.sql (A8 migration): shim + net/vault stand-ins + all migrations
// in PGlite, then the test. pg_net and Vault exist on every Supabase project; here they are tiny tables that record calls.
//   deno run -A --node-modules-dir=none supabase/tests/offline/email_events_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const NET_VAULT_SHIM = `
create schema if not exists vault;
create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);
create schema if not exists net;
create table if not exists net._calls (id bigint generated always as identity primary key, url text, body jsonb, headers jsonb, timeout_ms int);
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint language sql as $$
  insert into net._calls (url, body, headers, timeout_ms) values (url, body, headers, timeout_milliseconds) returning id $$;`;
const db = new PGlite();
await db.exec(read("tests/offline/supabase_shim.sql"));
await db.exec(NET_VAULT_SHIM);
for (const m of [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort()) {
  await db.exec(offline(read("migrations/" + m)));
}
try {
  await db.exec(read("tests/email_events_test.sql"));
  console.log("❌ email_events_test.sql did not raise");
  Deno.exit(1);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log((msg.startsWith("EMAIL_EVENTS_TESTS_PASSED") ? "✅ " : "❌ ") + msg);
  Deno.exit(msg.startsWith("EMAIL_EVENTS_TESTS_PASSED") ? 0 : 1);
}
