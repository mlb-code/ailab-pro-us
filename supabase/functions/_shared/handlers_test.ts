// HTTP layer: auth on draft/send/expiring, method checks, CORS, IP/UA capture, error codes, payload limits.
import { BRAND } from "./config.ts";
import { replayModel } from "./claude.ts";
import { makeHandler as draftH } from "../quote-draft/index.ts";
import { makeHandler as viewH } from "../quote-view/index.ts";
import { makeHandler as acceptH } from "../quote-accept/index.ts";
import { makeHandler as sendH } from "../quote-send/index.ts";
import { makeHandler as expH } from "../quote-expiring/index.ts";
import { MemoryStore } from "./store.ts";
import { assert, eq, seed } from "./test_util.ts";

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

Deno.test("HTTP: draft needs service key or admin; send needs admin; view/accept are public; CORS limited", async () => {
  const store = new MemoryStore();
  store.admins.set("admin-jwt", "admin-uid");
  const { qid } = seed(store, "plumber_jobber");
  const draft = draftH({ store: () => store, model: () => {
    const m = replayModel(); return { mode: m.mode, complete: (r) => m.complete({ ...r, replayKey: "plumber_jobber" }) };
  } });
  eq((await draft(post("http://x/", { questionnaire_id: qid }))).status, 403);
  eq((await draft(post("http://x/", { questionnaire_id: qid }, { authorization: "Bearer client-jwt" }))).status, 403);
  eq((await draft(post("http://x/", { questionnaire_id: "nope" }, { authorization: "Bearer admin-jwt" }))).status, 400);
  const r = await draft(post("http://x/", { questionnaire_id: qid }, { authorization: `Bearer ${store.serviceKey}` }));
  const { quote_id, status } = await r.json();
  eq([r.status, status], [200, "draft"]);

  const send = sendH({ store: () => store });
  eq((await send(post("http://x/", { quote_id }, { authorization: `Bearer ${store.serviceKey}` }))).status, 403, "service key is not an admin");
  const s = await send(post("http://x/", { quote_id, pay_method: "paypal_link" }, { authorization: "Bearer admin-jwt" }));
  eq([s.status, (await s.json()).status], [200, "sent"]);
  const token = store.quotes.get(quote_id)!.public_token;

  const view = viewH({ store: () => store });
  const v = await view(new Request(`http://x/?t=${token}`, { headers: { origin: "https://evil.example" } }));
  eq(v.status, 200);
  assert(v.headers.get("access-control-allow-origin") !== "https://evil.example", "no CORS for foreign origins");
  const local = () => view(new Request(`http://x/?t=${token}`, { headers: { origin: "http://localhost:8900" } }));
  assert((await local()).headers.get("access-control-allow-origin") !== "http://localhost:8900", "no localhost CORS in production");
  Deno.env.set("SIM_MODE", "1");
  try { eq((await local()).headers.get("access-control-allow-origin"), "http://localhost:8900", "localhost allowed in sim/dev"); }
  finally { Deno.env.delete("SIM_MODE"); }
  const pv = await view(post("http://x/", { t: token }));
  eq(pv.status, 200, "POST {t} (token not in URL)");
  eq((await view(new Request("http://x/?t=nope"))).status, 404);

  const accept = acceptH({ store: () => store });
  eq((await accept(new Request(`http://x/?t=${token}`))).status, 405);
  eq((await accept(post("http://x/", "x".repeat(9000)))).status, 413);
  const a = await accept(post("http://x/", { t: token, name: "Mark Ortiz", agree: true, agreement_version: BRAND.agreement_version },
    { "x-forwarded-for": "198.51.100.7, 10.0.0.1", "user-agent": "UA-test" }));
  eq([a.status, (await a.json()).status], [200, "accepted"]);
  const row = store.quotes.get(quote_id)!;
  assert(row.accepted_ip && row.accepted_ip.length === 64 && !row.accepted_ip.includes("198.51"));

  const exp = expH({ store: () => store });
  eq((await exp(post("http://x/", {}))).status, 403);
  eq((await exp(post("http://x/", {}, { authorization: `Bearer ${store.serviceKey}` }))).status, 200);
});
