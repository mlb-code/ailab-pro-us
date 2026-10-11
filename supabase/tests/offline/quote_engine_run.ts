// Offline runner for supabase/tests/quote_engine_test.sql (A6 migration): shim + all migrations in PGlite, then the test.
//   deno run -A --node-modules-dir=none supabase/tests/offline/quote_engine_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const db = new PGlite();
await db.exec(read("tests/offline/supabase_shim.sql"));
for (const m of [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort()) {
  await db.exec(offline(read("migrations/" + m)));
}
try {
  await db.exec(read("tests/quote_engine_test.sql"));
  console.log("❌ quote_engine_test.sql did not raise");
  Deno.exit(1);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log((msg.startsWith("QUOTE_ENGINE_TESTS_PASSED") ? "✅ " : "❌ ") + msg);
  Deno.exit(msg.startsWith("QUOTE_ENGINE_TESTS_PASSED") ? 0 : 1);
}
