// Offline runner for supabase/tests/paypal_test.sql (PayPal checkout migrations): shim + all migrations in PGlite (twice,
// like run.ts, so the new files are proven idempotent), then the test.
//   deno run -A --node-modules-dir=none supabase/tests/offline/paypal_run.ts      exit 0 = pass
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));
const offline = (sql: string) => sql.replace(/^\s*create extension if not exists (pg_cron|pg_net)\b[^;]*;/gim, "-- [offline] $1 skipped");
const db = new PGlite();
await db.exec(read("tests/offline/supabase_shim.sql"));
const files = [...Deno.readDirSync(new URL("migrations/", root))].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
for (const pass of [1, 2]) {
  for (const m of files) {
    try {
      await db.exec(offline(read("migrations/" + m)));
    } catch (e) {
      console.log(`❌ pass ${pass}: ${m}: ${e instanceof Error ? e.message : String(e)}`);
      Deno.exit(1);
    }
  }
}
try {
  await db.exec(read("tests/paypal_test.sql"));
  console.log("❌ paypal_test.sql did not raise");
  Deno.exit(1);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log((msg.startsWith("PAYPAL_TESTS_PASSED") ? "✅ " : "❌ ") + msg);
  Deno.exit(msg.startsWith("PAYPAL_TESTS_PASSED") ? 0 : 1);
}
