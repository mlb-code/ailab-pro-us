// POST lead capture from the landing pages. Contract + rules: ../_shared/lead.ts. verify_jwt = false (tools/us_setup.py).
import { clientIp, corsHeaders, json, readJson } from "../_shared/http.ts";
import { captureLead, LeadError, type LeadStore, RestLeadStore } from "../_shared/lead.ts";

export function makeHandler(deps: { store: () => LeadStore; now?: () => Date }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    try {
      if (req.method !== "POST") throw new LeadError("method_not_allowed", 405);
      const body = await readJson(req, 4096);
      return json(req, await captureLead(body, clientIp(req), deps.store(), deps.now ? deps.now() : new Date()));
    } catch (e) {
      if (e instanceof LeadError) return json(req, { error: e.code }, e.status);
      const code = (e as { code?: string }).code;
      if (code === "payload_too_large") return json(req, { error: code }, 413);
      if (code === "bad_json") return json(req, { error: code }, 400);
      console.error("lead_fn_error"); // no payload, no PII
      return json(req, { error: "server_error" }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(makeHandler({ store: () => RestLeadStore.fromEnv() }));
