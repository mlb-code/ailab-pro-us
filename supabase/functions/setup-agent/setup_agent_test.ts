// setup-agent HTTP layer, offline: JWT required, plan clients only, strict body (4 KB, 1,000-character message, no unknown
// keys), 409 / 429 / unavailable, CORS from http.ts, every body against setup_contract.json. The live wiring is checked with
// a fake fetch: settings calls carry the CALLER's JWT and the public key, never the service key.
// deno-lint-ignore-file no-explicit-any
import { BRAND } from "../_shared/config.ts";
import { scriptedSetupModel } from "../_shared/setup_model.ts";
import { MemoryUserDb, RestUserDb } from "../_shared/setup_store.ts";
import { assert, eq } from "../_shared/test_util.ts";
import { addClient, contractErrors, propose, turn, world } from "../_shared/setup_fixtures_test.ts";
import { makeHandler, parseRequest } from "./index.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

let n = 0;
const body = (input: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, client_turn_id: `http-${String(++n).padStart(6, "0")}`, input, ...extra });
const post = (b: unknown, jwt: string | null, headers: Record<string, string> = {}) => new Request("https://fn.test/functions/v1/setup-agent", {
  method: "POST", body: typeof b === "string" ? b : JSON.stringify(b),
  headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers } });
function handler(t: ReturnType<typeof world>, model: any = scriptedSetupModel([])) {
  return makeHandler({ store: () => t.store, db: (jwt) => new MemoryUserDb(t.w, jwt), model: () => model, log: () => {} });
}
async function call(h: (r: Request) => Promise<Response>, req: Request) {
  const res = await h(req);
  const json = await res.json();
  const errs = contractErrors(json, res.status === 200 ? "Response" : "Error");
  if (errs.length && req.method !== "OPTIONS") throw new Error(`contract: ${errs.join("; ")} ${JSON.stringify(json).slice(0, 300)}`);
  return { status: res.status, body: json, headers: res.headers };
}

Deno.test("http: 401 without or with a bad JWT, 403 for a quote client, 405 for GET, CORS limited to the site", async () => {
  const t = world();
  const h = handler(t);
  eq((await call(h, post(body({ type: "resume" }), null))).body, { error: "not_signed_in" });
  eq((await call(h, post(body({ type: "resume" }), "jwt-unknown"))).status, 401);
  const q = addClient(t.w, { billing: "quote" });
  const r = await call(h, post(body({ type: "resume" }), q.jwt));
  eq([r.status, r.body.error], [403, "not_a_plan_client"]);
  eq((await call(h, new Request("https://fn.test/", { method: "GET", headers: { Authorization: `Bearer ${t.jwt}` } }))).status, 405);
  const pre = await h(new Request("https://fn.test/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
  assert(pre.headers.get("access-control-allow-origin") !== "https://evil.example");
  const ok = await call(h, post(body({ type: "resume" }), t.jwt, { origin: BRAND.site_url }));
  eq([ok.status, ok.headers.get("access-control-allow-origin")], [200, BRAND.site_url]);
  eq(ok.body.messages[0].role, "assistant");
});
Deno.test("http: body limits and strict input (413, bad_input)", async () => {
  const t = world();
  const h = handler(t);
  eq((await call(h, post("x".repeat(5000), t.jwt))).status, 413);
  eq((await call(h, post("{not json", t.jwt))).body.error, "bad_json");
  const bad = [
    body({ type: "message", text: "x".repeat(1001) }), body({ type: "message", text: "   " }), body({ type: "resume" }, { v: 2 }),
    body({ type: "resume" }, { tenant_id: t.tenantId }), body({ type: "message", text: "hi", proposal_id: "x" }),
    body({ type: "event", event: "drop_tables" }), body({ type: "confirm", proposal_id: "x".repeat(41) }), body({ type: "write", path: "x" }),
    { v: 1, client_turn_id: "short", input: { type: "resume" } }, { v: 1, client_turn_id: "has spaces in it", input: { type: "resume" } },
  ];
  for (const b of bad) eq((await call(h, post(b, t.jwt))).body.error, "bad_input", JSON.stringify(b).slice(0, 80));
  eq(parseRequest(body({ type: "message", text: "  hi  " }) as any).input, { type: "message", text: "hi" });
});
Deno.test("http: 409 while a turn is in flight, 429 over the limit, 200 unavailable when the model fails", async () => {
  const t = world();
  const h = handler(t, scriptedSetupModel([{ throws: "timeout" }]));
  await call(h, post(body({ type: "resume" }), t.jwt));
  const r = await call(h, post(body({ type: "message", text: "drains" }), t.jwt));
  eq([r.status, r.body.status, r.body.fallback.reason], [200, "unavailable", "assistant_unavailable"]);
  // the lock held by another request
  const conv = [...t.store.convs.values()][0];
  conv.lock_until = Date.now() + 60000;
  eq((await call(h, post(body({ type: "message", text: "again" }), t.jwt))).body, { error: "turn_in_progress" });
  conv.lock_until = 0;
  const now = Date.now();
  for (let i = 0; i < 12; i++) t.store.messages.push({ id: 1000 + i, conversation_id: conv.id, seq: 1000 + i, role: "user", text: "x", blocks: [],
    client_turn_id: "old-" + i + "-xxxxx", created_at: new Date(now).toISOString(), cost_usd: 0, at: now });
  const lim = await call(h, post(body({ type: "message", text: "again" }), t.jwt));
  eq(lim.status, 429); assert(lim.body.retry_after_s >= 1);
});
Deno.test("http: a full card round trip through the handler; another user's JWT cannot touch it", async () => {
  const t = world();
  const h = handler(t, scriptedSetupModel([turn("Services.", [propose("services", { items: ["Drain cleaning"] })])]));
  await call(h, post(body({ type: "resume" }), t.jwt));
  const r = await call(h, post(body({ type: "message", text: "drain cleaning" }), t.jwt));
  const card = r.body.messages.flatMap((m: any) => m.blocks).find((b: any) => b.type === "summary_card");
  const other = addClient(t.w);
  const hb = await call(h, post(body({ type: "confirm", proposal_id: card.proposal_id }), other.jwt));
  eq(hb.status, 200); eq(t.w.writes.length, 0, "B's request runs in B's own conversation: A's card is unknown there");
  eq(t.store.proposals.get(card.proposal_id).status, "pending");
  await call(h, post(body({ type: "confirm", proposal_id: card.proposal_id }), t.jwt));
  eq(t.item("faq").data.services, ["Drain cleaning"]);
});
Deno.test("live wiring: settings go through PostgREST with the caller's JWT + the public key, never the service key", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const f = ((u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), headers: init?.headers as Record<string, string>, body: init?.body as string });
    if (String(u).endsWith("/auth/v1/user")) return Promise.resolve(new Response('{"id":"u1"}'));
    if (String(u).includes("/rpc/update_onboarding_item")) return Promise.resolve(new Response('{"id":"i1","key":"hours","status":"todo","data":{}}'));
    return Promise.resolve(new Response("[]"));
  }) as typeof fetch;
  const db = new RestUserDb("https://proj.supabase.co", "sb_publishable_x", "user-jwt", f);
  eq(await db.user(), { id: "u1" });
  await db.rows("u1", "c1");
  await db.preview("i1", { hours: {} }, null);
  await db.update("i1", "todo", { hours: {} });
  for (const c of calls) {
    eq([c.headers.Authorization, c.headers.apikey], ["Bearer user-jwt", "sb_publishable_x"], c.url);
  }
  assert(calls.some((c) => c.url.endsWith("/rest/v1/rpc/update_onboarding_item") && JSON.parse(c.body!).p_id === "i1"));
  assert(calls.some((c) => c.url.endsWith("/rest/v1/rpc/setup_preview_step")));
  assert(calls.some((c) => c.url.includes("onboarding_items?select=") && c.url.includes("client_id=eq.c1")));
});
