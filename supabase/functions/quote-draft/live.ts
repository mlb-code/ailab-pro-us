// ONE live Claude run on a fixture [NEEDS-CLAUDE, ~$0.05]: deno task quote:live hvac_basic
// Uses ANTHROPIC_API_KEY from the environment (never printed). Writes docs/reports/A6-live.json and the replay file.
import { liveModel } from "../_shared/claude.ts";
import { draftQuote } from "../_shared/quote_engine.ts";
import { MemoryStore } from "../_shared/store.ts";
import { seed } from "../_shared/test_util.ts";

const name = (Deno.args[0] ?? "hvac_basic").replace(/^.*\//, "").replace(/\.json$/, "");
const store = new MemoryStore();
const { qid } = seed(store, name);
const q = await draftQuote(qid, { store, model: liveModel() });
const draft = store.drafts.get(q.id)!;
const out = { fixture: name, status: q.status, setup_cents: q.setup_cents, monthly_cents: q.monthly_cents, deposit_cents: q.deposit_cents,
  items: q.items, scope_md: q.scope_md, review: store.reviews.get(q.id), tokens: draft.tokens, cost_usd: draft.cost_usd };
await Deno.writeTextFile(new URL("../../../docs/reports/A6-live.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
await Deno.writeTextFile(new URL(`../_shared/fixtures/replays/${name}.json`, import.meta.url),
  JSON.stringify({ recorded: true, ...(draft.raw_output as object), output: (draft.raw_output as { output: unknown }).output }, null, 2) + "\n");
console.log(`✅ ${name}: ${q.status}, tokens ${draft.tokens}, $${draft.cost_usd}`);
