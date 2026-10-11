// Offline tests for calendar-connect: Supabase Auth, PostgREST (RLS stand-in) and the runtime are mocked fetches.
import { makeHandler, type Env } from "./index.ts";
import { assert, eq } from "../_shared/test_util.ts";

const T = "11111111-2222-4333-8444-555555555555";
const env: Env = { supabaseUrl: "https://proj.supabase.co", anonKey: "anon", runtimeUrl: "https://rt.example", runtimeToken: "rt-secret" };
type Call = { url: string; init?: RequestInit };

function fakeFetch(opts: { user?: boolean; owns?: boolean; runtime?: number | "down"; url?: string } = {}) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/auth/v1/user")) return new Response(opts.user === false ? "{}" : '{"id":"u1"}', { status: opts.user === false ? 401 : 200 });
    if (url.includes("/rest/v1/tenants")) return new Response(JSON.stringify(opts.owns === false ? [] : [{ id: T }]), { status: 200 });
    if (url.includes("/oauth/")) {
      if (opts.runtime === "down") throw new TypeError("connect refused");
      const st = typeof opts.runtime === "number" ? opts.runtime : 200;
      return new Response(JSON.stringify({ url: opts.url ?? "https://rt.example/oauth/google/start?ticket=abc" }), { status: st });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const req = (body: unknown, jwt = "user-jwt") => new Request("https://fn/calendar-connect", {
  method: "POST", headers: jwt ? { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" } : {}, body: JSON.stringify(body),
});
async function call(body: unknown, opts = {}, jwt?: string) {
  const ff = fakeFetch(opts);
  const res = await makeHandler({ env: () => env, fetch: ff.fn })(req(body, jwt));
  return { status: res.status, body: await res.json(), calls: ff.calls };
}

Deno.test("calendar-connect: owner gets the runtime start URL; secret only goes to the runtime", async () => {
  const r = await call({ tenant_id: T, provider: "google" });
  eq(r.status, 200); eq(r.body.url, "https://rt.example/oauth/google/start?ticket=abc");
  const rt = r.calls.find((c) => c.url === "https://rt.example/oauth/google/ticket")!;
  assert(rt, "runtime ticket called");
  eq((rt.init!.headers as Record<string, string>).Authorization, "Bearer rt-secret");
  eq(JSON.parse(String(rt.init!.body)), { tenant_id: T });
  const pg = r.calls.find((c) => c.url.includes("/rest/v1/tenants"))!;
  eq((pg.init!.headers as Record<string, string>).Authorization, "Bearer user-jwt", "ownership read as the caller (RLS)");
  assert(!r.calls.some((c) => c.url.includes("supabase") && JSON.stringify(c.init ?? {}).includes("rt-secret")), "secret never sent to Supabase");
});
Deno.test("calendar-connect: not the owner -> 403, runtime never called", async () => {
  const r = await call({ tenant_id: T, provider: "google" }, { owns: false });
  eq(r.status, 403); eq(r.body.error, "not_your_tenant");
  assert(!r.calls.some((c) => c.url.includes("/oauth/")));
});
Deno.test("calendar-connect: no / bad session -> 401", async () => {
  eq((await call({ tenant_id: T, provider: "google" }, {}, "")).status, 401);
  const r = await call({ tenant_id: T, provider: "google" }, { user: false });
  eq(r.status, 401); assert(!r.calls.some((c) => c.url.includes("/rest/v1/")));
});
Deno.test("calendar-connect: input validation", async () => {
  eq((await call({ tenant_id: "x", provider: "google" })).body.error, "bad_tenant_id");
  eq((await call({ tenant_id: T, provider: "outlook" })).body.error, "unknown_provider");
});
Deno.test("calendar-connect: runtime not configured / down / bad answer", async () => {
  const a = await call({ tenant_id: T, provider: "google" }, { runtime: 503 });
  eq(a.status, 503); assert(/not configured/.test(a.body.error));
  eq((await call({ tenant_id: T, provider: "google" }, { runtime: "down" })).status, 503);
  eq((await call({ tenant_id: T, provider: "google" }, { url: "https://evil.example/x" })).status, 502);
  const ff = fakeFetch();
  const res = await makeHandler({ env: () => ({ ...env, runtimeToken: "" }), fetch: ff.fn })(req({ tenant_id: T, provider: "calendly" }));
  eq(res.status, 503); assert(!ff.calls.some((c) => c.url.includes("/oauth/")));
});
Deno.test("calendar-connect: GET refused", async () => {
  const res = await makeHandler({ env: () => env, fetch: fakeFetch().fn })(new Request("https://fn/x", { method: "GET" }));
  eq(res.status, 405);
});
