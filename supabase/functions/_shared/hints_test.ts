// Drift guard: the TS port must give exactly what the questionnaire's own quoteHints() (site/start/assets/questions.js) gives.
import { PRICEBOOK as PB } from "./config.ts";
import { quoteHints } from "./hints.ts";
import { eq } from "./test_util.ts";

const src = Deno.readTextFileSync(new URL("../../../site/start/assets/questions.js", import.meta.url));
// deno-lint-ignore no-explicit-any
const win: Record<string, any> = {};
new Function("window", src)(win);
const fixtures = [...Deno.readDirSync(new URL("./fixtures/", import.meta.url))]
  .filter((e) => e.isFile && e.name.endsWith(".json") && e.name !== "expected.json").map((e) => e.name);

Deno.test(`hints parity with questions.js on ${fixtures.length} fixtures + edge answers`, () => {
  const cases = fixtures.map((f) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${f}`, import.meta.url))).questionnaire.answers);
  cases.push({ offer: "RCP", niche: "home_services", locations: "4plus", calls_week: "400plus", tools: ["other", "outlook_calendar", "quickbooks"] });
  cases.push({ offer: "RCP", niche: "real_estate", re_crm: "other", tools: [] });
  cases.push({ offer: "BNDL", niche: "home_services", tools: ["servicetitan", "hubspot", "jobber"], timeline: "asap" });
  for (const a of cases) eq(quoteHints(a, PB), win.StartQ.quoteHints(a, PB), JSON.stringify(a).slice(0, 80));
});
