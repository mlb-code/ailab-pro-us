// The ONLY module that talks to Claude. Three modes (env CLAUDE_MODE, default "replay"):
//   live   -> official SDK (@anthropic-ai/sdk via npm specifier), structured output, effort from brand.json.
//             The SDK reads ANTHROPIC_API_KEY from the function's environment (Supabase secret); never logged.
//   replay -> recorded outputs from _shared/fixtures/replays/<key>.json (no network, no cost). Key = fixture name or prompt hash.
//   mock   -> a function supplied by the caller (tests).
import { BRAND } from "./config.ts";

export interface ClaudeRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  /** replay lookup key (fixture name); falls back to prompt hash */
  replayKey?: string;
  promptHash: string;
}
export interface ClaudeResult {
  output: unknown; // parsed JSON (still untrusted: validated by quote_engine)
  raw: unknown;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
export interface QuoteModel {
  mode: "live" | "replay" | "mock";
  complete(req: ClaudeRequest): Promise<ClaudeResult>;
}

// USD per million tokens for the configured model (claude-api skill table, 2026-10). Unknown model -> 0 (cost unknown).
const PRICE_PER_MTOK: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20] }; // hardcoded-ok: per-model price table, not the configured model
export function costUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICE_PER_MTOK[model];
  return p ? Math.round(((inTok * p[0] + outTok * p[1]) / 1e6) * 10000) / 10000 : 0;
}

export function mockModel(fn: (req: ClaudeRequest) => unknown): QuoteModel {
  return {
    mode: "mock",
    complete(req) {
      const output = fn(req);
      return Promise.resolve({ output, raw: output, model: BRAND.claude.model, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    },
  };
}

export function replayModel(dir: URL = new URL("./fixtures/replays/", import.meta.url)): QuoteModel {
  return {
    mode: "replay",
    async complete(req) {
      for (const key of [req.replayKey, req.promptHash].filter(Boolean) as string[]) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) continue;
        try {
          const rec = JSON.parse(await Deno.readTextFile(new URL(`${key}.json`, dir)));
          const output = rec.output ?? rec;
          return { output, raw: rec, model: rec.model ?? BRAND.claude.model, input_tokens: rec.input_tokens ?? 0,
            output_tokens: rec.output_tokens ?? 0, cost_usd: 0 };
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }
      throw new Error("replay_not_found");
    },
  };
}

const SDK_SPEC = "npm:@anthropic-ai/sdk@0.130.0";

export function liveModel(): QuoteModel {
  return {
    mode: "live",
    async complete(req) {
      // Built at runtime so offline tests never resolve/download the SDK.
      const spec = SDK_SPEC;
      const { default: Anthropic } = await import(spec);
      const client = new Anthropic();
      const model = BRAND.claude.model;
      // deno-lint-ignore no-explicit-any
      const params: any = {
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: BRAND.claude.effort.quote || "medium", format: { type: "json_schema", schema: req.schema } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      };
      const msg = await client.beta.messages.create(params);
      if (msg.stop_reason === "refusal") throw new Error("claude_refusal");
      if (msg.stop_reason === "max_tokens") throw new Error("claude_max_tokens");
      // deno-lint-ignore no-explicit-any
      const text = (msg.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
      const output = JSON.parse(text);
      const inTok = (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0);
      const outTok = msg.usage?.output_tokens ?? 0;
      return { output, raw: { id: msg.id, model: msg.model, stop_reason: msg.stop_reason, output, usage: msg.usage },
        model: msg.model ?? model, input_tokens: inTok, output_tokens: outTok, cost_usd: costUsd(model, inTok, outTok) };
    },
  };
}

export function modelFromEnv(): QuoteModel {
  const mode = Deno.env.get("CLAUDE_MODE") ?? "replay";
  return mode === "live" ? liveModel() : replayModel();
}
