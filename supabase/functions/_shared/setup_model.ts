// The setup assistant's model adapter (design 2026-11-27, sections 3.1 and 4.2-4.4). Same pattern as claude.ts, separate key.
//   buildParams(req, wire)    the exact request body: model from brand.json claude.setup_model, effort claude.effort.setup,
//                             structured output in the wire format (setup_wire.ts; env SETUP_WIRE=compact|json, default compact),
//                             max_tokens 4000, server-side fallback, no thinking setting, no tool_choice
//   liveSetupModel(env)       the official SDK, imported lazily; key ANTHROPIC_API_KEY_SETUP, else ANTHROPIC_API_KEY (never logged)
//   scriptedSetupModel(steps) tests and the offline mock: canned outputs per call, every request recorded. It can only be
//                             injected through makeHandler deps; nothing in the environment selects it.
//   costUsd(model, usage)     dollars from brand.json claude.price_usd_per_mtok [in, out, cache_read, cache_write]
// deno-lint-ignore-file no-explicit-any
import { BRAND } from "./config.ts";
import { type ModelMessage, SETUP_TURN_SCHEMA, systemFor } from "./setup_prompt.ts";
import { type Schema, wireSchema } from "./setup_schema.ts";
import { COMPACT_WIRE_SCHEMA, JSON_WIRE_SCHEMA, toWire, type Wire, wireFormat } from "./setup_wire.ts";

export const SETUP_MODEL: string = (BRAND.claude as any).setup_model || BRAND.claude.model;
export const SETUP_EFFORT: string = (BRAND.claude.effort as any).setup || "low";
export const SETUP_MAX_TOKENS = 4000;

export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export interface SetupModelRequest { messages: ModelMessage[]; system?: string }
export interface SetupModelResult { output: unknown; model: string; usage: Usage; cost_usd: number; stop_reason: string; latency_ms: number }
// bad_request = the provider says OUR request is invalid (schema, parameters): a server defect, never the customer's wording.
export type ModelErrorKind = "timeout" | "unavailable" | "rate_limited" | "auth" | "budget" | "refusal" | "max_tokens" | "bad_output" | "bad_request";
export class SetupModelError extends Error {
  /** status = the provider's HTTP status (0 = none); detail = its error type + message (no customer text; safe to log) */
  constructor(public kind: ModelErrorKind, public retryAfterS: number | null = null, public usage: Usage | null = null,
    public status = 0, public detail = "") { super(kind); }
}
export interface SetupModel {
  mode: "live" | "scripted";
  /** how the model writes its turn (setup_wire.ts); the engine reads the output back with the same format */
  wire: Wire;
  keySource: "dedicated" | "shared" | "none" | "test";
  call(req: SetupModelRequest): Promise<SetupModelResult>;
}

const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
export function costUsd(model: string, u: Partial<Usage>): number {
  const p = ((BRAND.claude as any).price_usd_per_mtok ?? {})[model] as number[] | undefined;
  if (!Array.isArray(p) || p.length !== 4) return 0;   // unknown model: cost unknown (the Workspace cap still applies)
  const usd = ((u.input_tokens ?? 0) * p[0] + (u.output_tokens ?? 0) * p[1] + (u.cache_read_input_tokens ?? 0) * p[2]
    + (u.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export function schemaFor(wire: Wire): Schema {
  return wire === "compact" ? COMPACT_WIRE_SCHEMA : wire === "json" ? JSON_WIRE_SCHEMA : wireSchema(SETUP_TURN_SCHEMA);
}
/** The request body (no key). The system prompt is cached; the new user message carries the second breakpoint. */
export function buildParams(req: SetupModelRequest, wire: Wire = wireFormat()): Record<string, unknown> {
  return {
    model: SETUP_MODEL,
    max_tokens: SETUP_MAX_TOKENS,
    system: [{ type: "text", text: req.system ?? systemFor(wire), cache_control: { type: "ephemeral" } }],
    messages: req.messages,
    output_config: { effort: SETUP_EFFORT, format: { type: "json_schema", schema: schemaFor(wire) } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
}

const usageOf = (u: any): Usage => ({ input_tokens: u?.input_tokens ?? 0, output_tokens: u?.output_tokens ?? 0,
  cache_read_input_tokens: u?.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0 });

/** SDK / HTTP error -> what the customer and the admin alert need. */
export function mapError(e: any): SetupModelError {
  if (e instanceof SetupModelError) return e;
  const name = String(e?.name ?? e?.constructor?.name ?? "");
  const status = typeof e?.status === "number" ? e.status : 0;
  const msg = String(e?.message ?? "") + " " + JSON.stringify(e?.error ?? {});
  const h = e?.headers, ra = typeof h?.get === "function" ? h.get("retry-after") : h?.["retry-after"];
  const retry = Number.isFinite(Number(ra)) && Number(ra) > 0 ? Math.ceil(Number(ra)) : null;
  const detail = providerDetail(e);
  const err = (k: ModelErrorKind, r: number | null = null) => new SetupModelError(k, r, null, status, detail);
  if (/Timeout/i.test(name) || /timed? ?out/i.test(msg) && !status) return err("timeout");
  if (status === 401 || status === 403) return err("auth");
  if (status === 402 || (status === 400 && /credit balance|spend limit|spending limit|usage limit|billing/i.test(msg))) return err("budget");
  if (status === 429) return err("rate_limited", retry);
  if (status >= 500 || /Connection/i.test(name) || !status) return err("unavailable", retry);
  return err("bad_request");   // any other 4xx: our request is invalid (a server defect); never retried in a loop
}
/** "invalid_request_error: The compiled grammar is too large…" from the SDK error body (the provider's words, no customer text). */
export function providerDetail(e: any): string {
  const body = e?.error?.error ?? e?.error ?? {};
  const type = typeof body?.type === "string" && body.type !== "error" ? body.type : "";
  const message = typeof body?.message === "string" ? body.message : String(e?.message ?? "");
  return [type, message].filter(Boolean).join(": ").replace(/\s+/g, " ").slice(0, 300);
}

export function liveSetupModel(env: (k: string) => string | undefined = (k) => Deno.env.get(k), wire: Wire = wireFormat(env)): SetupModel {
  const dedicated = (env("ANTHROPIC_API_KEY_SETUP") ?? "").trim(), shared = (env("ANTHROPIC_API_KEY") ?? "").trim();
  const apiKey = dedicated || shared;
  const keySource = dedicated ? "dedicated" : shared ? "shared" : "none";
  let client: any = null;
  return {
    mode: "live",
    wire,
    keySource,
    async call(req) {
      if (!apiKey) throw new SetupModelError("auth");
      if (!client) {
        // a failed SDK load must reach the log with its message (live test 2026-11-28: it surfaced as a bare "unavailable")
        try {
          // a LITERAL specifier: the hosted bundle only carries npm packages it can see statically (live test 2026-11-28:
          // with a variable the function failed with "Could not find constraint '@anthropic-ai/sdk@0.130.0'"). Still lazy.
          const { default: Anthropic } = await import("npm:@anthropic-ai/sdk@0.130.0");
          client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
        } catch (e) { throw mapError(e); }
      }
      const t0 = Date.now();
      let msg: any;
      try { msg = await client.beta.messages.create(buildParams(req, wire)); } catch (e) { throw mapError(e); }
      const usage = usageOf(msg.usage), model = String(msg.model ?? SETUP_MODEL);
      if (msg.stop_reason === "refusal") throw new SetupModelError("refusal", null, usage);
      if (msg.stop_reason === "max_tokens") throw new SetupModelError("max_tokens", null, usage);
      const text = (msg.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
      let output: unknown;
      try { output = JSON.parse(text); } catch { throw new SetupModelError("bad_output", null, usage); }
      return { output, model, usage, cost_usd: costUsd(SETUP_MODEL, usage), stop_reason: String(msg.stop_reason), latency_ms: Date.now() - t0 };
    },
  };
}

/** A step: the output as an INTERNAL turn (written in the model's wire format before it is returned), a function of the
 *  request, { raw } = exactly this output (no conversion), or an error kind to throw. */
export type ScriptStep = unknown | ((req: SetupModelRequest, n: number) => unknown) | { throws: ModelErrorKind; retry_after_s?: number; detail?: string } | { raw: unknown };
export function scriptedSetupModel(steps: ScriptStep[], usage: Partial<Usage> = { input_tokens: 900, output_tokens: 250, cache_read_input_tokens: 6000 },
  wire: Wire = "internal") {
  const requests: SetupModelRequest[] = [];
  const model: SetupModel & { requests: SetupModelRequest[]; left: () => number } = {
    mode: "scripted",
    wire,
    keySource: "test",
    requests,
    left: () => steps.length - requests.length,
    call(req) {
      const n = requests.length;
      requests.push(structuredClone(req));
      if (n >= steps.length) return Promise.reject(new SetupModelError("unavailable"));
      const step = steps[n] as any;
      if (step && typeof step === "object" && "throws" in step) {
        return Promise.reject(new SetupModelError(step.throws, step.retry_after_s ?? null, null, step.throws === "bad_request" ? 400 : 0, step.detail ?? ""));
      }
      const output = step && typeof step === "object" && "raw" in step ? structuredClone(step.raw)
        : toWire(wire, typeof step === "function" ? step(req, n) : structuredClone(step));
      const u = { ...ZERO, ...usage };
      return Promise.resolve({ output, model: SETUP_MODEL, usage: u, cost_usd: costUsd(SETUP_MODEL, u), stop_reason: "end_turn", latency_ms: 1 });
    },
  };
  return model;
}
