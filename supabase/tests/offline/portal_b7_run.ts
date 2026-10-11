// Offline runner for supabase/tests/portal_b7_test.sql (B7 migration): shim + all migrations in PGlite, then the test.
//   deno run -A --node-modules-dir=none supabase/tests/offline/portal_b7_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const db = new PGlite();
await db.exec(read("tests/offline/supabase_shim.sql"));
for (const m of [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort()) {
  await db.exec(offline(read("migrations/" + m)));
}
// limits in the test come from the runtime's schema, not from the test itself
const schema = Deno.readTextFileSync(new URL("../runtime/app/tenant_schema.json", root));
await db.query("select set_config('b7.schema', $1, false)", [schema]);
try {
  await db.exec(read("tests/portal_b7_test.sql"));
  console.log("❌ portal_b7_test.sql did not raise");
  Deno.exit(1);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log((msg.startsWith("PORTAL_B7_TESTS_PASSED") ? "✅ " : "❌ ") + msg);
  Deno.exit(msg.startsWith("PORTAL_B7_TESTS_PASSED") ? 0 : 1);
}
