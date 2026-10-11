// lead Edge Function: honeypot, validation, rate limit, idempotent e-mail, event, CORS.
import { makeHandler } from "../lead/index.ts";
import { BRAND } from "./config.ts";
import { IP_PER_HOUR, MemoryLeadStore } from "./lead.ts";
import { assert, eq } from "./test_util.ts";

const post = (body: unknown, ip = "203.0.113.5", origin = BRAND.site_url) =>
  new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip, origin } });

Deno.test("lead: stores valid lead + lead_received event; honeypot, bad input, rate limit, duplicate e-mail", async () => {
  const store = new MemoryLeadStore();
  const h = makeHandler({ store: () => store });
  const ok = await h(post({ email: " Dana@Example.com ", company: "Smile <b>Co</b>", city: "Austin, TX", niche: "dental", source_page: "/dental/",
    utm: { utm_source: "upwork", "bad key!": "x" } }));
  eq([ok.status, await ok.json()], [200, { ok: true, stored: true }]);
  eq(ok.headers.get("access-control-allow-origin"), BRAND.site_url.replace(/\/$/, ""));
  const r = store.rows[0];
  eq([r.email, r.niche, r.source_page, r.utm], ["dana@example.com", "dental", "/dental/", { utm_source: "upwork" }]);
  assert(/^[0-9a-f]{64}$/.test(r.ip_hash) && !r.ip_hash.includes("203"), "ip hashed");
  eq(store.events[0].payload.company, "Smile b Co /b", "markup neutralised");
  eq(store.events[0].type, "lead_received");

  eq((await (await h(post({ email: "bot@example.com", website: "http://spam" }))).json()).stored, false, "honeypot");
  eq((await h(post({ email: "not-an-email" }))).status, 400);
  eq((await h(post({ email: "a@b.co", niche: "law" }))).status, 400, "law niche removed");
  eq((await h(new Request("http://x/", { method: "GET" }))).status, 405);
  eq((await h(post({ email: "x".repeat(5000) + "@a.co" }))).status, 413);
  eq((await (await h(post({ email: "dana@example.com" }))).json()).stored, false, "same e-mail within 10 min: no new row");

  const ip = "198.51.100.1";
  for (let i = 0; i < IP_PER_HOUR; i++) eq((await h(post({ email: `p${i}@example.com` }, ip))).status, 200);
  eq((await h(post({ email: "p99@example.com" }, ip))).status, 429);
  eq(store.rows.length, 1 + IP_PER_HOUR);
  const foreign = await h(post({ email: "z@example.com" }, "192.0.2.9", "https://evil.example"));
  assert(foreign.headers.get("access-control-allow-origin") !== "https://evil.example");
});
