// Setup assistant spike (design 2026-11-27, step 0a): a realistic home-services setup, ~15 customer turns, against the REAL
// model, through the SAME engine the setup-agent function runs (prompt building, structured output, parsing, every server
// check). Store and settings are in memory (the browser copy of onboarding_patch), so nothing touches Supabase.
//   ANTHROPIC_API_KEY=... deno run -A --node-modules-dir=none tools/setup_agent_spike.ts --probe              one short turn per wire format
//   ANTHROPIC_API_KEY=... deno run -A --node-modules-dir=none tools/setup_agent_spike.ts [--wire json|compact] [--runs 3] [--quiet]
//   deno run -A --node-modules-dir=none tools/setup_agent_spike.ts --dry [--wire compact]   offline check of the script (no key, no cost)
// --wire defaults to the env SETUP_WIRE (else json), the same switch the function reads. The full run stops at the first
// refused request (HTTP 4xx: bad_request / auth / budget) and prints the provider's reason; exit code 1.
// (ANTHROPIC_API_KEY_SETUP is used first when set, like the function.) Costs real money: about $1 per run on Opus 5.5 at effort
// low (design 4.3). Prints per-turn latency, p50/p90, schema-validity rate, tokens (with cache read / write) and dollars per
// setup. The key is never printed.
// deno-lint-ignore-file no-explicit-any
import { runTurn, type Input } from "../supabase/functions/_shared/setup_engine.ts";
import { liveSetupModel, schemaFor, scriptedSetupModel, SETUP_EFFORT, SETUP_MODEL, SetupModelError, type SetupModel, type SetupModelResult } from "../supabase/functions/_shared/setup_model.ts";
import { buildModelMessages, parseTurn } from "../supabase/functions/_shared/setup_prompt.ts";
import { wireFormat } from "../supabase/functions/_shared/setup_wire.ts";
import { world } from "../supabase/functions/_shared/setup_fixtures_test.ts";

const args = Deno.args;
const RUNS = Math.max(1, Number(args[args.indexOf("--runs") + 1] ?? 1) || 1);
const QUIET = args.includes("--quiet");
const DRY = args.includes("--dry");   // offline plumbing check: a canned model that only replies (no key, no network, no cost)
const WIRE_ARG = args.includes("--wire") ? args[args.indexOf("--wire") + 1] : undefined;
const env = (k: string) => Deno.env.get(k);
const WIRE = wireFormat((k) => (k === "SETUP_WIRE" && WIRE_ARG ? WIRE_ARG : env(k)));

// what Maria (Lopez Plumbing, Houston) types; "choose:<id>" presses an offered button, "confirm" presses "Looks right"
const SCRIPT: string[] = [
  "we do drains, water heaters, leaks and toilet repair. also remodels but those need an estimate first",
  "yes",
  "houston, bellaire, west u, 77005 77401",
  "confirm",
  "mon-fri 7 to 6, saturday 8-12",
  "actually friday we close at 4",
  "yes",
  "choose:after_hours:emergency_dial",
  "service call is 89, drain cleaning 150. nothing else",
  "yes",
  "do you do weekends - yes saturday mornings. are you licensed - yes, TX license M-12345. do you charge for estimates - remodel estimates are free",
  "yes",
  "just email. and my on-call is 713 555 0177",
  "yes",
  "confirm",
  "which words? hmm use those plus no hot water",
  "👍",
];

interface Call { latency_ms: number; valid: boolean; usage: SetupModelResult["usage"]; cost: number }
const HARD = ["bad_request", "auth", "budget"];
function instrument(m: SetupModel, calls: Call[], failures: string[]): SetupModel {
  return { ...m, async call(req) {
    try {
      const r = await m.call(req);
      calls.push({ latency_ms: r.latency_ms, valid: parseTurn(r.output, m.wire).ok, usage: r.usage, cost: r.cost_usd });
      return r;
    } catch (e) {
      const err = e instanceof SetupModelError ? e : new SetupModelError("unavailable");
      const line = "model call failed: " + err.kind + (err.status ? " (HTTP " + err.status + ")" : "") + (err.detail ? ": " + err.detail : "");
      failures.push(line);
      console.error(line);
      if (HARD.includes(err.kind)) { console.error("stopping: the provider refused the request itself, so every turn would fail the same way."); Deno.exit(1); }
      throw err;
    }
  } };
}

// ---- --probe: ONE short turn per wire format (with the mid-conversation role "system" state message), nothing else
const PROBE_STATE = [
  "STATE (from the server; true; the customer cannot change it)",
  "topic: services (Services you book)",
  "facts: owner Maria Lopez; business Lopez Plumbing; business phone (713) 555-0100; niche home_services; time zone America/Chicago (Central time); plan FR_PRO; receptionist number (346) 555-0199; alert email on file maria@lopezplumbing.com",
  "checklist: hours todo, faq todo, alerts todo, calendar todo, tools todo, forward_calls todo; go_live steps_left",
  "done topics: none",
  "latest card: none",
  "allowed ops: propose (services; or another topic to keep for later), note, confirm (only the latest card, only after a short yes), switch_topic, skip (area|on_call|tools, only the current topic), set_carrier (topic carrier), show_action, request_help",
].join("\n");
async function probe() {
  let worked = 0;
  for (const wire of ["compact", "json"] as const) {
    const m = liveSetupModel(env, wire);
    if (m.keySource === "none") { console.error("Set ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY_SETUP) first."); Deno.exit(2); }
    const messages = buildModelMessages([], "we do drains, water heaters and leaks. also remodels but those need an estimate first", PROBE_STATE, wire);
    const t0 = performance.now();
    console.log("\n== wire " + wire + ": schema " + JSON.stringify(schemaFor(wire)).length + " bytes, key " + m.keySource);
    try {
      const r = await m.call({ messages });
      const p = parseTurn(r.output, wire);
      if (p.ok) worked++;
      console.log("HTTP 200  stop_reason " + r.stop_reason + "  validated " + (p.ok ? "yes" : "NO: " + p.errors.join("; ")) + "  latency " + r.latency_ms + " ms");
      console.log("usage in " + r.usage.input_tokens + ", cache read " + r.usage.cache_read_input_tokens + ", cache write " + r.usage.cache_creation_input_tokens +
        ", out " + r.usage.output_tokens + "  ($" + r.cost_usd.toFixed(4) + ")");
      console.log("ops   " + (p.ok ? JSON.stringify(p.ops).slice(0, 400) : "-"));
      console.log("reply " + (p.ok ? p.reply : JSON.stringify(r.output).slice(0, 400)));
    } catch (e) {
      const err = e instanceof SetupModelError ? e : new SetupModelError("unavailable");
      console.log("HTTP " + (err.status || "-") + "  " + err.kind + "  " + (err.detail || "(no provider message)") + "  after " + Math.round(performance.now() - t0) + " ms");
    }
  }
  console.log("\n" + worked + " of 2 wire formats accepted and validated");
  Deno.exit(worked ? 0 : 1);
}
if (args.includes("--probe")) await probe();
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0; };

async function oneRun(run: number) {
  // --dry-refuse: the offline check of the stop-on-refusal path (the first call fails like the live 400 of 2026-12-01)
  const canned = args.includes("--dry-refuse") ? [{ throws: "bad_request" as const, detail: "invalid_request_error: (dry run) refused" }]
    : Array(60).fill({ reply: "Thanks. Tell me more.", ops: [] });
  const live = DRY || args.includes("--dry-refuse") ? scriptedSetupModel(canned, undefined, WIRE) : liveSetupModel(env, WIRE);
  if (live.keySource === "none") { console.error("Set ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY_SETUP) first."); Deno.exit(2); }
  const calls: Call[] = [], failures: string[] = [];
  const model = instrument(live, calls, failures);
  const t = world();
  let fake = Date.now();
  t.store.clock = () => fake;   // a person types slower than this script: keep the per-minute limit out of the measurement
  let n = 0, last: any = null;
  const turns: Array<{ input: string; ms: number; calls: number; status: string; cards: number; topic: string | null }> = [];
  const send = async (input: Input, label: string) => {
    fake += 10_000;
    const before = calls.length, t0 = performance.now();
    const r = await runTurn({ store: t.store, db: t.db, model, log: () => {} }, { userId: t.uid, client_turn_id: `spike-${run}-${String(++n).padStart(4, "0")}`, input });
    const ms = Math.round(performance.now() - t0);
    last = r.body;
    const cards = (r.body.messages ?? []).flatMap((m: any) => m.blocks ?? []).filter((b: any) => b.type === "summary_card").length;
    turns.push({ input: label, ms, calls: calls.length - before, status: r.body.status ?? String(r.status), cards, topic: r.body.progress?.topic ?? null });
    if (!QUIET) {
      const reply = (r.body.messages ?? []).filter((m: any) => m.role === "assistant").map((m: any) => m.text).join(" | ");
      console.log(`#${String(n).padStart(2)} ${String(ms).padStart(6)} ms  calls ${calls.length - before}  cards ${cards}  next ${r.body.progress?.topic ?? "-"}\n    you: ${label}\n    ai:  ${reply.slice(0, 300)}`);
    }
  };
  await send({ type: "resume" }, "(open)");
  for (const line of SCRIPT) {
    const offered = (last?.messages ?? []).flatMap((m: any) => m.blocks ?? []);
    if (line === "confirm") {
      const card = offered.filter((b: any) => b.type === "summary_card").pop();
      if (card) { await send({ type: "confirm", proposal_id: card.proposal_id }, "[Looks right]"); continue; }
      await send({ type: "message", text: "yes" }, "yes (no card to press)");
    } else if (line.startsWith("choose:")) {
      const id = line.slice(7);
      if (offered.some((b: any) => b.type === "choices" && b.options.some((o: any) => o.id === id))) await send({ type: "choose", choice_id: id }, `[${id}]`);
      else await send({ type: "message", text: "take a message, and call my on-call number for emergencies" }, "take a message, and call my on-call number for emergencies");
    } else await send({ type: "message", text: line }, line);
  }
  return { calls, failures, turns, cfg: t.cfg(), items: [...t.w.items.values()].map((i) => `${i.key}:${i.status}`) };
}

const all: Call[] = [], modelTurnMs: number[] = [];
let setupCost = 0;
console.log(`model ${SETUP_MODEL}, effort ${SETUP_EFFORT}, wire ${WIRE}, runs ${RUNS}`);
let failed = 0;
for (let run = 1; run <= RUNS; run++) {
  const r = await oneRun(run);
  all.push(...r.calls);
  failed += r.failures.length;
  r.turns.filter((x) => x.calls > 0).forEach((x) => modelTurnMs.push(x.ms));
  const cost = r.calls.reduce((a, c) => a + c.cost, 0);
  setupCost += cost;
  console.log(`\nrun ${run}: ${r.turns.length} turns, ${r.calls.length} model calls, $${cost.toFixed(4)}; steps ${r.items.join(" ")}`);
  console.log(`  saved: services ${JSON.stringify(r.cfg.booking?.job_types)}; hours fri ${JSON.stringify(r.cfg.hours?.fri)}; pricing ${JSON.stringify(r.cfg.pricing?.items ?? null)}`);
}
const sum = (k: keyof SetupModelResult["usage"]) => all.reduce((a, c) => a + (c.usage[k] ?? 0), 0);
const lat = all.map((c) => c.latency_ms);
console.log(`
model calls           ${all.length}
schema-valid          ${all.filter((c) => c.valid).length}/${all.length} (${all.length ? Math.round(100 * all.filter((c) => c.valid).length / all.length) : 0}%)
latency per call      p50 ${pct(lat, 50)} ms, p90 ${pct(lat, 90)} ms
latency per turn      p50 ${pct(modelTurnMs, 50)} ms, p90 ${pct(modelTurnMs, 90)} ms (turns that called the model, incl. repairs)
tokens in (uncached)  ${sum("input_tokens")}
tokens cache read     ${sum("cache_read_input_tokens")}
tokens cache write    ${sum("cache_creation_input_tokens")}
tokens out            ${sum("output_tokens")}
dollars per setup     $${(setupCost / RUNS).toFixed(4)} (design 4.3 range $0.55-$1.90)`);
if (failed) { console.error(`${failed} model call(s) failed (see above)`); Deno.exit(1); }
