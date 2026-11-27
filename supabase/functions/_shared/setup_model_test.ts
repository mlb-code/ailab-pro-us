// Setup assistant model adapter + prompt: the request shape (model and effort from brand.json, structured output without the
// keywords the API rejects, server-side fallback, no thinking setting, no tool_choice), cost from the brand price table,
// error mapping, key selection, prompt contents, output parsing. No network.
// deno-lint-ignore-file no-explicit-any
import { BRAND, PRICEBOOK } from "./config.ts";
import { buildParams, costUsd, liveSetupModel, mapError, SETUP_MODEL } from "./setup_model.ts";
import { buildModelMessages, parseTurn, SETUP_SYSTEM, SETUP_TURN_SCHEMA } from "./setup_prompt.ts";
import { validate, wireSchema } from "./setup_schema.ts";
import { assert, eq, rejects } from "./test_util.ts";
import { days } from "./setup_fixtures_test.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

function walk(v: any, f: (k: string, x: any) => void) {
  if (Array.isArray(v)) v.forEach((x) => walk(x, f));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { f(k, x); walk(x, f); }
}
Deno.test("request: model + effort from brand.json, structured output, fallback, cached system; no thinking / tool_choice", () => {
  const p: any = buildParams({ messages: buildModelMessages([], "hi", "STATE") });
  eq(p.model, (BRAND.claude as any).setup_model); eq(SETUP_MODEL, (BRAND.claude as any).setup_model);
  eq(p.output_config.effort, (BRAND.claude.effort as any).setup); eq(p.output_config.effort, "low");
  eq(p.output_config.format.type, "json_schema"); eq(p.max_tokens, 4000);
  eq([p.betas, p.fallbacks], [["server-side-fallback-2026-07-01"], "default"]);
  eq(p.system[0].cache_control, { type: "ephemeral" });
  for (const k of ["thinking", "tool_choice", "tools", "temperature", "top_p", "top_k"]) assert(!(k in p), `no ${k}`);
  const banned = new Set(["maxLength", "minLength", "pattern", "minimum", "maximum", "maxItems"]);
  walk(p.output_config.format.schema, (k, x) => {
    assert(!banned.has(k), `wire schema keeps ${k}`);
    if (k === "minItems") assert(x <= 1, "minItems above 1 is not accepted by structured outputs");
    if (x && typeof x === "object" && x.type === "object") eq(x.additionalProperties, false, "every object is closed");
  });
  eq(JSON.stringify(wireSchema(SETUP_TURN_SCHEMA)), JSON.stringify(p.output_config.format.schema));
});
Deno.test("messages: history replayed as user text + assistant model_json, user message cached, state message last", () => {
  const m = buildModelMessages([
    { seq: 1, role: "assistant", text: "Hi, I'm the setup assistant" }, { seq: 2, role: "note", text: "disclosure" },
    { seq: 3, role: "user", text: "drains" }, { seq: 4, role: "assistant", text: "card", model_json: { reply: "card", ops: [] } },
  ], "yes", "STATE topic: services");
  eq(m.map((x) => x.role), ["user", "assistant", "user", "system"], "starts with a user message; notes and the greeting are not sent");
  eq(JSON.parse(String(m[1].content)), { reply: "card", ops: [] });
  eq((m[2].content as any)[0].cache_control, { type: "ephemeral" });
  eq(m[3].content, "STATE topic: services");
});
Deno.test("cost: brand.json price table with cache read / write prices", () => {
  const p = (BRAND.claude as any).price_usd_per_mtok[SETUP_MODEL];
  eq(costUsd(SETUP_MODEL, { input_tokens: 1e6 }), p[0]); eq(costUsd(SETUP_MODEL, { output_tokens: 1e6 }), p[1]);
  eq(costUsd(SETUP_MODEL, { cache_read_input_tokens: 1e6 }), p[2]); eq(costUsd(SETUP_MODEL, { cache_creation_input_tokens: 1e6 }), p[3]);
  eq(costUsd("unknown-model", { input_tokens: 1e6 }), 0);
});
Deno.test("errors -> kinds: timeout, 429 with retry-after, 401/403 auth, spend limit, 5xx, connection, other 4xx", () => {
  eq(mapError({ name: "APIConnectionTimeoutError", message: "Request timed out." }).kind, "timeout");
  const rl = mapError({ status: 429, headers: new Headers({ "retry-after": "7" }), message: "rate limited" });
  eq([rl.kind, rl.retryAfterS], ["rate_limited", 7]);
  eq([mapError({ status: 401 }).kind, mapError({ status: 403 }).kind], ["auth", "auth"]);
  eq(mapError({ status: 400, message: "Your credit balance is too low to access the Anthropic API." }).kind, "budget");
  eq(mapError({ status: 400, error: { error: { message: "Workspace spend limit reached" } } }).kind, "budget");
  eq([mapError({ status: 529 }).kind, mapError({ name: "APIConnectionError", message: "fetch failed" }).kind], ["unavailable", "unavailable"]);
  eq(mapError({ status: 400, message: "messages: bad" }).kind, "bad_output");
});
Deno.test("key: ANTHROPIC_API_KEY_SETUP first, then ANTHROPIC_API_KEY; none = auth without any network call", async () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  eq(liveSetupModel(env({ ANTHROPIC_API_KEY_SETUP: "a".repeat(20), ANTHROPIC_API_KEY: "b".repeat(20) })).keySource, "dedicated");
  eq(liveSetupModel(env({ ANTHROPIC_API_KEY: "b".repeat(20) })).keySource, "shared");
  const none = liveSetupModel(env({}));
  eq(none.keySource, "none");
  await rejects(() => none.call({ messages: [] }), "auth");
});
Deno.test("prompt: AI disclosure, truthfulness, no secrets asked, fair housing, product facts from the price book", () => {
  assert(SETUP_SYSTEM.includes("setup assistant, an AI"));
  assert(/Never invent prices, hours/.test(SETUP_SYSTEM));
  assert(/Never ask|Ask for passwords, card numbers/.test(SETUP_SYSTEM));
  assert(SETUP_SYSTEM.includes("fair housing"));
  for (const p of (PRICEBOOK as any).plans) assert(SETUP_SYSTEM.includes(`${p.name}: $${Math.round(p.monthly_cents / 100)} a month`), p.name);
  assert(SETUP_SYSTEM.includes("Business texting (SMS) is not on yet"), "texting status from brand.json");
  assert(!/\$\{|undefined|NaN/.test(SETUP_SYSTEM), "nothing unresolved");
});
Deno.test("output parsing: schema-checked; long replies cut; foreign keys refused", () => {
  const ok = parseTurn({ reply: "Here's what I understood.", ops: [{ op: "propose", topic: "hours", data: { days: days({ mon: ["09:00", "17:00"] }) } }] });
  assert(ok.ok);
  const long = parseTurn({ reply: "word ".repeat(100), ops: [] });
  assert(long.ok && [...long.reply].length <= 351);
  assert(!parseTurn({ reply: "x", ops: [{ op: "propose", topic: "hours", data: { days: days({}), tenant_id: "t" } }] }).ok);
  assert(!parseTurn({ reply: "x", ops: [{ op: "confirm", proposal_id: "x".repeat(41) }] }).ok);
  assert(!parseTurn({ reply: "x", ops: Array(5).fill({ op: "skip", topic: "area" }) }).ok, "at most 4 ops");
  assert(!parseTurn({ reply: "x", ops: [{ op: "propose", topic: "prices", data: { mention: true, items: [{ name: "a", price_usd: 200001, note: "" }] } }] }).ok, "price limit");
  assert(!parseTurn({ reply: "x", ops: [{ op: "set_carrier", carrier: "evilcorp" }] }).ok);
  assert(!parseTurn("not json").ok);
  eq(validate(SETUP_TURN_SCHEMA, { reply: "x", ops: [{ op: "show_action", action: "open_form", provider: null }] }), []);
});
