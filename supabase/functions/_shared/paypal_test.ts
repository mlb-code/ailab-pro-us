// PayPal checkout, fully offline: a fake PayPal REST API (OAuth, Orders v2, Payments v2, verify-webhook-signature) behind
// the injectable fetch of PaypalClient, the in-memory pay store, and the HTTP handlers of pay-create, pay-capture,
// paypal-webhook, pay-refund and pay-upwork. Global fetch is replaced by a thrower: any real network call fails the test.
import { BRAND, PRICEBOOK as PB } from "./config.ts";
import { replayModel } from "./claude.ts";
import { MemoryPayStore } from "./pay_store.ts";
import { captureIdFromLinks, captureOf, clearPaypalTokenCache, orderBody, PaypalClient, paypalConfigFromEnv, PaypalError, toCents, toValue } from "./paypal.ts";
import { acceptQuote, draftQuote, sendQuote, viewQuote } from "./quote_engine.ts";
import * as QV from "./quote_view.mjs";
import type { QuoteRow } from "./store.ts";
import { assert, eq, rejects, seed } from "./test_util.ts";
import { makeHandler as createH } from "../pay-create/index.ts";
import { makeHandler as captureH } from "../pay-capture/index.ts";
import { makeHandler as hookH, WEBHOOK_EVENTS } from "../paypal-webhook/index.ts";
import { makeHandler as refundH } from "../pay-refund/index.ts";
import { makeHandler as upworkH } from "../pay-upwork/index.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

// fake credentials, assembled at runtime (public client id shape; the secret must never show up anywhere)
const CLIENT_ID = ["AbCdEfGhIjKlMnOp", "QrStUvWx", "0123456789"].join("-");
const SECRET = "E" + "s3cr3t".repeat(8);
const WEBHOOK_ID = "8PT597110X687430LKGECATA";
const BRAND_ON = { ...structuredClone(BRAND), payments: { paypal: { enabled: true, env: "sandbox", client_id: CLIENT_ID } } } as typeof BRAND;
const rcpName = PB.items.find((i) => i.code === "RCP")!.name;

// ------------------------------------------------------------------ fake PayPal
type Json = Record<string, unknown>;
interface Call { method: string; path: string; headers: Record<string, string>; body: string }
class FakePaypal {
  calls: Call[] = [];
  orders = new Map<string, Json & { purchase_units: Json[] }>();
  captures = new Map<string, Json>();
  n = 0;
  tokenTtl = 32400;
  captureStatus = "COMPLETED";
  capturePatch: Json = {};                      // e.g. { amount: {...} } to fake a mismatch
  captureFail: { status: number; name: string; issue: string } | null = null;
  refundFail: { status: number; name: string; issue: string } | null = null;
  refundStatus = "COMPLETED";
  verify = "SUCCESS";
  fail401Once = false;
  dropCustomId = false;                         // a capture answer without custom_id anywhere
  err = (status: number, name: string, issue = "") =>
    new Response(JSON.stringify({ name, message: "x", debug_id: "f00dbabe", details: issue ? [{ issue }] : [] }), { status });
  ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  paths = (m?: string) => this.calls.filter((c) => !m || c.method === m).map((c) => c.path);
  fetch = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const c: Call = { method: String(init.method ?? "GET"), path: url.pathname, headers, body: String(init.body ?? "") };
    this.calls.push(c);
    assert(url.origin === "https://api-m.sandbox.paypal.com", "sandbox API only: " + url.origin);
    if (c.path === "/v1/oauth2/token") {
      if (headers.authorization !== "Basic " + btoa(`${CLIENT_ID}:${SECRET}`) || c.body !== "grant_type=client_credentials") {
        return Promise.resolve(this.ok({ error: "invalid_client" }, 401));
      }
      this.n++;
      return Promise.resolve(this.ok({ access_token: `A21AA.fake-token-${this.n}`, token_type: "Bearer", expires_in: this.tokenTtl }));
    }
    if (!/^Bearer A21AA\.fake-token-\d+$/.test(headers.authorization ?? "")) return Promise.resolve(this.err(401, "AUTHENTICATION_FAILURE"));
    if (this.fail401Once) { this.fail401Once = false; return Promise.resolve(this.err(401, "AUTHENTICATION_FAILURE")); }
    let m: RegExpExecArray | null;
    if (c.method === "POST" && c.path === "/v2/checkout/orders") {
      const body = JSON.parse(c.body);
      const id = `5O19012${String(++this.n).padStart(3, "0")}TN3647`;
      const o = { id, status: "CREATED", intent: body.intent, purchase_units: body.purchase_units };
      this.orders.set(id, o);
      return Promise.resolve(this.ok(o, 201));
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(c.path)) && c.method === "GET") {
      const o = this.orders.get(m[1]);
      return Promise.resolve(o ? this.ok(o) : this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID"));
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(c.path)) && c.method === "POST") {
      const o = this.orders.get(m[1]);
      if (!o) return Promise.resolve(this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID"));
      if (this.captureFail) return Promise.resolve(this.err(this.captureFail.status, this.captureFail.name, this.captureFail.issue));
      if (o.status === "COMPLETED") return Promise.resolve(this.err(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED"));
      const pu = o.purchase_units[0] as Json & { amount: Json; custom_id: string };
      const cap = { id: `3C6793${String(++this.n).padStart(4, "0")}HH908`, status: this.captureStatus, amount: pu.amount,
        custom_id: pu.custom_id, invoice_id: pu.invoice_id, ...this.capturePatch };
      this.captures.set(cap.id as string, { ...cap });
      Object.assign(o, { status: "COMPLETED", payer: { email_address: "Payer@Example.com" },
        payment_source: { card: { brand: "VISA", last_digits: "4242" } } });
      pu.payments = { captures: [cap] };
      if (this.dropCustomId) { delete (cap as Json).custom_id; delete (pu as Json).custom_id; }
      return Promise.resolve(this.ok(o, 201));
    }
    if ((m = /^\/v2\/payments\/captures\/([^/]+)$/.exec(c.path)) && c.method === "GET") {
      const cap = this.captures.get(m[1]);
      return Promise.resolve(cap ? this.ok(cap) : this.err(404, "RESOURCE_NOT_FOUND"));
    }
    if ((m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(c.path)) && c.method === "POST") {
      if (this.refundFail) return Promise.resolve(this.err(this.refundFail.status, this.refundFail.name, this.refundFail.issue));
      const cap = this.captures.get(m[1]);
      if (!cap) return Promise.resolve(this.err(404, "RESOURCE_NOT_FOUND"));
      cap.status = "REFUNDED";
      return Promise.resolve(this.ok({ id: "1JU08902781691411", status: this.refundStatus }, 201));
    }
    if (c.method === "POST" && c.path === "/v1/notifications/verify-webhook-signature") {
      return Promise.resolve(this.ok({ verification_status: this.verify }));
    }
    return Promise.resolve(this.err(404, "NOT_IN_FAKE"));
  }) as unknown as typeof fetch;
}

const newClient = (fake: FakePaypal, extra: Partial<{ env: "sandbox" | "live"; clientId: string; webhookId: string; now: () => number }> = {}) =>
  new PaypalClient({ env: extra.env ?? "sandbox", clientId: extra.clientId ?? CLIENT_ID, secret: SECRET, webhookId: extra.webhookId ?? WEBHOOK_ID },
    { fetch: fake.fetch, now: extra.now });

async function setup(name = "hvac_basic") {
  clearPaypalTokenCache();
  const store = new MemoryPayStore();
  const fake = new FakePaypal();
  const { qid, uid } = seed(store, name);
  const d = await draftQuote(qid, { store, model: replayModel(), replayKey: name, brand: BRAND_ON });
  const s = await sendQuote({ quote_id: d.id }, store, PB, BRAND_ON);
  await acceptQuote({ token: s.public_token, name: "Dani Levin", agree: true, agreement_version: BRAND.agreement_version, ip: "", ua: "" }, store);
  const q = store.quotes.get(d.id)! as QuoteRow;
  const deps = { store: () => store, paypal: () => newClient(fake), brand: BRAND_ON };
  return { store, fake, q, uid, token: q.public_token, deps };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const call = async (h: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) => {
  const r = await h(post(body, headers));
  return { status: r.status, j: await r.json() as Json, r };
};
const depositRow = (store: MemoryPayStore, quoteId: string) => {
  const c = [...store.clients.values()].find((x) => x.quote_id === quoteId)!;
  return [...store.payments.values()].find((p) => p.client_id === c.id && p.kind === "deposit")!;
};
async function payDeposit(e: Awaited<ReturnType<typeof setup>>) {
  const c = await call(createH(e.deps), { t: e.token, which: "deposit" });
  const k = await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id });
  eq([c.status, k.status, k.j.status], [200, 200, "paid"], "pay deposit");
  return { order_id: String(c.j.order_id), capture_id: String(k.j.reference) };
}

// ------------------------------------------------------------------ config + client
Deno.test("config: PayPal on only with enabled + client id; the default rail follows it; quote-send refuses PayPal while off", async () => {
  eq([QV.paypalOn(BRAND), QV.defaultPayMethod(BRAND)], [false, "upwork"], "repo config: off, Upwork stays the default");
  eq([QV.paypalOn(BRAND_ON), QV.defaultPayMethod(BRAND_ON)], [true, "paypal_checkout"]);
  const noId = { ...BRAND_ON, payments: { paypal: { enabled: true, env: "sandbox", client_id: "" } } };
  eq(QV.paypalOn(noId), false, "enabled without a client id = off");
  const store = new MemoryPayStore();
  const { qid } = seed(store, "hvac_basic");
  const d = await draftQuote(qid, { store, model: replayModel(), replayKey: "hvac_basic" });
  eq(d.pay_method, "upwork", "PayPal off: drafts start on Upwork");
  await rejects(() => sendQuote({ quote_id: d.id, pay_method: "paypal_checkout" }, store), "paypal_off");
  eq((await sendQuote({ quote_id: d.id, pay_method: "paypal_checkout" }, store, PB, BRAND_ON)).pay_method, "paypal_checkout");
  eq(paypalConfigFromEnv(() => undefined), null, "no secrets = not configured");
  eq(paypalConfigFromEnv((k) => ({ PAYPAL_ENV: "prod", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y" } as Record<string, string>)[k]), null, "bad env");
  eq(paypalConfigFromEnv((k) => ({ PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: " id ", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "w" } as Record<string, string>)[k]),
    { env: "live", clientId: "id", secret: "s", webhookId: "w" });
  eq([toValue(175000), toValue(5), toValue(12345)], ["1750.00", "0.05", "123.45"]);
  eq([toCents("1750.00"), toCents("1750"), toCents("0.5"), toCents("-1.00"), toCents("1.005"), toCents("abc"), toCents(null)], [175000, 175000, 50, null, null, null, null]);
  eq(captureIdFromLinks([{ rel: "self", href: "https://api.paypal.com/v2/payments/refunds/1JU08902781691411" },
    { rel: "up", href: "https://api.paypal.com/v2/payments/captures/2GG279541U471931P" }]), "2GG279541U471931P");
});

Deno.test("token: one OAuth call per isolate, refreshed before expiry, a 401 drops it and retries once; secret only in Basic auth", async () => {
  clearPaypalTokenCache();
  const fake = new FakePaypal();
  let t = 1_000_000;
  const pp = newClient(fake, { now: () => t });
  await pp.getOrder("UNKNOWN0001").catch(() => {});
  await pp.getOrder("UNKNOWN0002").catch(() => {});
  eq(fake.paths().filter((p) => p === "/v1/oauth2/token").length, 1, "cached");
  t += (fake.tokenTtl - 300) * 1000 + 1;   // inside the 5-minute safety margin -> refresh
  await pp.getOrder("UNKNOWN0003").catch(() => {});
  eq(fake.paths().filter((p) => p === "/v1/oauth2/token").length, 2, "refreshed before expiry");
  fake.fail401Once = true;
  await pp.getOrder("UNKNOWN0004").catch(() => {});
  eq(fake.paths().filter((p) => p === "/v1/oauth2/token").length, 3, "401 -> new token, one retry");
  for (const c of fake.calls) {
    assert(!c.body.includes(SECRET) && !c.path.includes(SECRET), "secret never in a body or URL");
    if (c.path !== "/v1/oauth2/token") assert(!String(c.headers.authorization).startsWith("Basic"), "API calls use the bearer token");
  }
  const bad = new PaypalClient({ env: "sandbox", clientId: CLIENT_ID, secret: "wrong", webhookId: "" }, { fetch: fake.fetch });
  clearPaypalTokenCache();
  const e = await bad.getOrder("X1234567").then(() => null, (x) => x);
  assert(e instanceof PaypalError && e.status === 401 && !String(e.message).includes("wrong"), "auth failure without echoing the secret");
});

Deno.test("orderBody / captureOf: our ids, integer money, no shipping; capture fields read from PayPal's answer", () => {
  const b = orderBody({ payment_id: "p-1", reference_id: "deposit", amount_cents: 175000, currency: "USD", description: "d".repeat(200), brand_name: BRAND.name });
  eq(b.intent, "CAPTURE");
  eq(b.purchase_units[0], { reference_id: "deposit", custom_id: "p-1", invoice_id: "p-1", description: "d".repeat(127), amount: { currency_code: "USD", value: "1750.00" } });
  eq(b.application_context, { brand_name: BRAND.name, shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" });
  const info = captureOf({ id: "ORD12345", purchase_units: [{ custom_id: "p-1", payments: { captures: [{ id: "CAP12345", status: "COMPLETED", amount: { currency_code: "USD", value: "1750.00" } }] } }],
    payer: { email_address: "a@b.co" }, payment_source: { card: { brand: "MASTERCARD", last_digits: "0005" } } }, "p-1");
  eq(info, { capture_id: "CAP12345", status: "COMPLETED", amount_cents: 175000, currency: "USD", custom_id: "p-1", order_id: "ORD12345",
    payer_email: "a@b.co", funding: "Mastercard ending in 0005" });
  eq(captureOf({ id: "ORD12345", purchase_units: [{}] }), null, "no capture yet");
});

// ------------------------------------------------------------------ pay-create
Deno.test("pay-create: amount from our row (never the browser), USD, custom_id = invoice_id = payment id; open order reused", async () => {
  const e = await setup();
  const { status, j, r } = await call(createH(e.deps), { t: e.token, which: "deposit", amount: 1, amount_cents: 1, currency: "EUR" }, { origin: "https://evil.example" });
  eq(status, 200);
  assert(r.headers.get("access-control-allow-origin") !== "https://evil.example", "CORS: brand origin only");
  const dep = depositRow(e.store, e.q.id);
  eq([dep.provider, dep.provider_order_id, dep.amount_cents, dep.method], ["paypal", j.order_id, e.q.deposit_cents, "paypal_checkout"]);
  const create = e.fake.calls.find((c) => c.method === "POST" && c.path === "/v2/checkout/orders")!;
  const body = JSON.parse(create.body);
  eq(body.purchase_units[0].amount, { currency_code: "USD", value: toValue(e.q.deposit_cents!) }, "amount = the quote's deposit");
  eq([body.purchase_units[0].custom_id, body.purchase_units[0].invoice_id], [dep.id, dep.id]);
  eq(body.purchase_units[0].description, `${BRAND.name} – ${rcpName} deposit`);
  assert(/^[0-9a-f-]{36}$/.test(create.headers["paypal-request-id"]), "PayPal-Request-Id on create");
  eq(e.store.clients.size, 1, "the client card was opened (same rows as the admin's button)");
  // second click: the open (CREATED) order is reused, nothing new at PayPal
  const again = await call(createH(e.deps), { t: e.token, which: "deposit" });
  eq([again.status, again.j.order_id], [200, j.order_id]);
  eq(e.fake.paths("POST").filter((p) => p === "/v2/checkout/orders").length, 1, "reused");
  // the order went stale at PayPal (voided / expired): a fresh one, which becomes the only capturable order
  (e.fake.orders.get(String(j.order_id)) as Json).status = "VOIDED";
  const fresh = await call(createH(e.deps), { t: e.token, which: "deposit" });
  assert(fresh.status === 200 && fresh.j.order_id !== j.order_id, "new order");
  eq(depositRow(e.store, e.q.id).provider_order_id, fresh.j.order_id);
  const old = await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: j.order_id });
  eq([old.status, old.j.error], [409, "order_mismatch"], "the superseded order can't be captured");
  assert(!e.fake.paths("POST").some((p) => p.endsWith("/capture")), "PayPal capture never called for it");
});

Deno.test("pay-create refusals: PayPal off / misconfigured 503, bad token 404, not accepted, switched to Upwork, final before the deposit", async () => {
  const e = await setup();
  const off = { ...e.deps, brand: BRAND };
  eq((await call(createH(off), { t: e.token })).j.error, "paypal_off", "brand.json off");
  eq((await call(createH({ ...e.deps, paypal: () => null }), { t: e.token })).status, 503, "no secrets");
  const other = { ...e.deps, paypal: () => newClient(e.fake, { clientId: "ZzZzZzZzZzZzZzZzZzZz" }) };
  eq((await call(createH(other), { t: e.token })).j.error, "paypal_off", "server app != browser client id");
  const live = { ...e.deps, paypal: () => newClient(e.fake, { env: "live" }) };
  eq((await call(createH(live), { t: e.token })).j.error, "paypal_off", "live secrets with a sandbox page");
  eq(e.fake.calls.length, 0, "PayPal never called while off");
  eq((await call(createH(e.deps), { t: "short" })).status, 404);
  eq((await call(createH(e.deps), { t: "x".repeat(40) })).status, 404);
  eq((await call(createH(e.deps), { t: e.token, which: "monthly" })).j.error, "bad_which");
  eq((await call(createH(e.deps), { t: e.token, which: "final" })).j.error, "deposit_not_paid");
  eq((await createH(e.deps)(new Request("http://x/", { method: "GET" }))).status, 405);
  eq((await createH(e.deps)(new Request("http://x/", { method: "OPTIONS" }))).status, 200);
  eq((await call(createH(e.deps), "x".repeat(3000))).status, 413);
  // a sent (not yet accepted) PayPal quote
  const s2 = new MemoryPayStore();
  const { qid } = seed(s2, "plumber_jobber");
  const d = await draftQuote(qid, { store: s2, model: replayModel(), replayKey: "plumber_jobber", brand: BRAND_ON });
  const sent = await sendQuote({ quote_id: d.id }, s2, PB, BRAND_ON);
  eq((await call(createH({ ...e.deps, store: () => s2 }), { t: sent.public_token })).j.error, "quote_not_accepted");
  // switched to Upwork on the quote page
  eq((await call(upworkH({ store: () => e.store }), { t: e.token })).status, 200);
  eq((await call(createH(e.deps), { t: e.token })).j.error, "not_paypal");
});

// ------------------------------------------------------------------ pay-capture
Deno.test("pay-capture: captured server-side, marked paid through the mark-paid path (receipt, owner notice, deposit_received); idempotent", async () => {
  const e = await setup();
  const { order_id, capture_id } = await payDeposit(e);
  const dep = depositRow(e.store, e.q.id);
  eq([dep.status, dep.provider_capture_id, dep.payer_email, dep.method], ["paid", capture_id, "payer@example.com", "paypal_checkout"]);
  const cap = e.fake.calls.find((c) => c.path.endsWith("/capture"))!;
  eq(cap.headers["paypal-request-id"], `capture-${order_id}`, "one PayPal-Request-Id per order: a retried capture never charges twice");
  eq(e.store.outbox.map((o) => o.template).sort(), ["admin_payment_received", "deposit_received", "payment_receipt"]);
  eq(e.store.outbox.find((o) => o.template === "payment_receipt")!.payload.funding, "Visa ending in 4242");
  assert(e.store.events.some((x) => x.type === "payment_captured" && x.entity_id === dep.id), "logged");
  // the browser retries the same capture: answered from our row, PayPal not called again
  const again = await call(captureH(e.deps), { t: e.token, which: "deposit", order_id });
  eq([again.status, again.j.status, again.j.reference], [200, "paid", capture_id]);
  eq(e.fake.paths("POST").filter((p) => p.endsWith("/capture")).length, 1);
  eq(e.store.outbox.length, 3, "no second receipt");
  eq((await call(createH(e.deps), { t: e.token })).j.error, "already_paid");
  eq((await viewQuote(e.token, e.store)).pay_state.deposit!.status, "paid", "the quote page shows the paid state on reload");
  const s = JSON.stringify(await viewQuote(e.token, e.store));
  assert(!s.includes(capture_id) && !s.includes("payer@example.com") && !s.includes(dep.id), "public view: no provider ids, e-mail or row id");
});

Deno.test("pay-capture refuses a capture that doesn't match our row: amount, currency, custom_id (not paid, Meir alerted)", async () => {
  for (const [patch, what] of [[{ amount: { currency_code: "USD", value: "1.00" } }, "amount"], [{ amount: { currency_code: "EUR", value: "1750.00" } }, "currency"],
    [{ custom_id: "someone-else" }, "custom_id"]] as Array<[Json, string]>) {
    const e = await setup();
    e.fake.capturePatch = patch;
    const c = await call(createH(e.deps), { t: e.token });
    const k = await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id });
    eq([k.status, k.j.error], [409, "amount_mismatch"], what);
    const dep = depositRow(e.store, e.q.id);
    eq([dep.status, dep.provider_capture_id], ["due", null], `${what}: not marked paid`);
    eq(e.store.alerts.map((a) => a.kind), ["mismatch"], `${what}: Meir alerted`);
    assert(String(e.store.alerts[0].payload.problems).includes(what === "custom_id" ? "custom_id" : what), "problem named");
    assert(!e.store.outbox.some((o) => o.template === "payment_receipt"), "no receipt");
  }
  // PayPal's answer without custom_id: still ours, because it is the order we created for this row -> paid, no alert
  const e = await setup();
  e.fake.dropCustomId = true;
  const c = await call(createH(e.deps), { t: e.token });
  const k = await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id });
  eq([k.status, k.j.status, depositRow(e.store, e.q.id).status, e.store.alerts.length], [200, "paid", "paid", 0], "no custom_id, our order");
});

Deno.test("pay-capture: INSTRUMENT_DECLINED -> 422 (SDK restart), ORDER_ALREADY_CAPTURED recovered, DECLINED -> 402, PENDING then webhook", async () => {
  const e = await setup();
  const c = await call(createH(e.deps), { t: e.token });
  e.fake.captureFail = { status: 422, name: "UNPROCESSABLE_ENTITY", issue: "INSTRUMENT_DECLINED" };
  eq((await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id })).j.error, "instrument_declined");
  e.fake.captureFail = { status: 500, name: "INTERNAL_SERVER_ERROR", issue: "" };
  eq((await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id })).status, 502);
  e.fake.captureFail = null;
  // PayPal captured but our call timed out: the next capture gets ORDER_ALREADY_CAPTURED -> read the order -> paid
  const ord = e.fake.orders.get(String(c.j.order_id))!;
  await e.deps.paypal().captureOrder(String(c.j.order_id), "out-of-band");
  eq(ord.status, "COMPLETED");
  const k = await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id });
  eq([k.status, k.j.status], [200, "paid"], "recovered");
  eq(depositRow(e.store, e.q.id).status, "paid");

  const d = await setup();
  d.fake.captureStatus = "DECLINED";
  const c2 = await call(createH(d.deps), { t: d.token });
  eq((await call(captureH(d.deps), { t: d.token, which: "deposit", order_id: c2.j.order_id })).status, 402);
  eq(depositRow(d.store, d.q.id).status, "due");

  const p = await setup();
  p.fake.captureStatus = "PENDING";
  const c3 = await call(createH(p.deps), { t: p.token });
  const k3 = await call(captureH(p.deps), { t: p.token, which: "deposit", order_id: c3.j.order_id });
  eq([k3.status, k3.j.status], [200, "pending"]);
  const dep = depositRow(p.store, p.q.id);
  eq([dep.status, !!dep.provider_capture_id, p.store.outbox.length], ["due", true, 0], "pending: ids kept, nothing sent");
  eq((await viewQuote(p.token, p.store)).pay_state.deposit!.status, "pending");
  eq((await call(createH(p.deps), { t: p.token })).j.error, "payment_pending", "no second order while PayPal processes");
  const hook = await webhook(p, completedEvent(dep.provider_capture_id!, dep.id, dep.amount_cents));
  eq([hook.status, hook.j.result], [200, "paid"]);
  eq(depositRow(p.store, p.q.id).status, "paid");
  eq(p.store.outbox.map((o) => o.template).sort(), ["admin_payment_received", "deposit_received", "payment_receipt"]);
});

// ------------------------------------------------------------------ webhook
const SIG = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55", "paypal-transmission-sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==",
  "paypal-transmission-time": "2026-10-21T09:00:00Z" };
const completedEvent = (captureId: string, customId: string, cents: number, extra: Json = {}) => ({ id: "WH-" + crypto.randomUUID().slice(0, 18).toUpperCase(),
  event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture",
  resource: { id: captureId, status: "COMPLETED", custom_id: customId, amount: { currency_code: "USD", value: toValue(cents) }, ...extra } });
async function webhook(e: Awaited<ReturnType<typeof setup>>, ev: unknown, headers: Record<string, string> = SIG, raw?: string) {
  const r = await hookH(e.deps)(new Request("http://x/", { method: "POST", body: raw ?? JSON.stringify(ev), headers }));
  return { status: r.status, j: await r.json() as Json };
}

Deno.test("webhook: missing / wrong signature -> 400 and nothing changes; verified COMPLETED -> paid once; event forwarded verbatim", async () => {
  const e = await setup();
  const c = await call(createH(e.deps), { t: e.token });
  const dep = depositRow(e.store, e.q.id);
  const ev = completedEvent("8MC585209K746392H", dep.id, dep.amount_cents, { supplementary_data: { related_ids: { order_id: c.j.order_id } } });
  const { "paypal-transmission-sig": _sig, ...noSig } = SIG;
  eq((await webhook(e, ev, noSig)).j.error, "bad_signature");
  e.fake.verify = "FAILURE";
  eq((await webhook(e, ev)).status, 400, "PayPal says the signature is wrong");
  eq([depositRow(e.store, e.q.id).status, e.store.outbox.length], ["due", 0], "nothing changed");
  e.fake.verify = "SUCCESS";
  const raw = JSON.stringify(ev, null, 1) + "\n";   // whitespace PayPal's CRC covers: must go back byte for byte
  const ok = await webhook(e, ev, SIG, raw);
  eq([ok.status, ok.j.result], [200, "paid"]);
  const v = e.fake.calls.filter((x) => x.path === "/v1/notifications/verify-webhook-signature").pop()!;
  assert(v.body.endsWith(',"webhook_event":' + raw.trim() + "}"), "raw event spliced in, not re-serialised");
  const vb = JSON.parse(v.body);
  eq([vb.webhook_id, vb.auth_algo, vb.cert_url, vb.transmission_id, vb.transmission_time], [WEBHOOK_ID, SIG["paypal-auth-algo"], SIG["paypal-cert-url"],
    SIG["paypal-transmission-id"], SIG["paypal-transmission-time"]]);
  eq(depositRow(e.store, e.q.id).status, "paid");
  const dup = await webhook(e, ev);
  eq([dup.status, dup.j.duplicate], [200, true], "same event id: not processed again");
  eq(e.store.outbox.filter((o) => o.template === "payment_receipt").length, 1);
  eq((await webhook({ ...e, deps: { ...e.deps, paypal: () => newClient(e.fake, { webhookId: "" }) } }, ev)).status, 503, "no webhook id = refuse");
  eq((await webhook(e, null, SIG, "{not json")).j.error, "bad_json");
});

Deno.test("webhook: amounts never trusted: mismatch / double payment -> alert, unknown capture -> alert, nothing marked paid", async () => {
  const e = await setup();
  await call(createH(e.deps), { t: e.token });
  const dep = depositRow(e.store, e.q.id);
  const m = await webhook(e, completedEvent("8MC585209K746392H", dep.id, dep.amount_cents - 100));
  eq([m.j.result, depositRow(e.store, e.q.id).status], ["mismatch", "due"]);
  eq(e.store.alerts.map((a) => a.kind), ["mismatch"]);
  const u = await webhook(e, completedEvent("0VF52814937998046", "not-ours", 4200));
  eq(u.j.result, "unknown_capture");
  eq(e.store.alerts.map((a) => a.kind), ["mismatch", "unknown_capture"]);
  // paid by one capture, then a second completed capture for the same row = a double charge -> Meir must refund it
  await payDeposit(e);
  const paidBy = depositRow(e.store, e.q.id).provider_capture_id!;
  const d2 = await webhook(e, completedEvent("9XX52814937998999", dep.id, dep.amount_cents));
  eq(d2.j.result, "mismatch");
  assert(String(e.store.alerts.at(-1)!.payload.problems).includes("double_payment"));
  eq(depositRow(e.store, e.q.id).provider_capture_id, paidBy, "the row keeps its own capture");
});

Deno.test("webhook: REFUNDED (full, per PayPal's capture) -> refunded; partial -> alert only; REVERSED -> refunded + alert; DISPUTE -> alert", async () => {
  const e = await setup();
  const { capture_id } = await payDeposit(e);
  const up = [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/1JU08902781691411" },
    { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${capture_id}` }];
  const refundEv = (type: string, id: string) => ({ id, event_type: type, resource_type: "refund",
    resource: { id: "1JU08902781691411", status: "COMPLETED", amount: { currency_code: "USD", value: "999999.00" }, links: up } });
  e.fake.captures.get(capture_id)!.status = "PARTIALLY_REFUNDED";
  const part = await webhook(e, refundEv("PAYMENT.CAPTURE.REFUNDED", "WH-PART-0001"));
  eq([part.j.result, depositRow(e.store, e.q.id).status], ["partial_refund", "paid"], "partial: stays paid (the event's amount is ignored)");
  eq(e.store.alerts.at(-1)!.kind, "partial_refund");
  e.fake.captures.get(capture_id)!.status = "REFUNDED";
  const full = await webhook(e, refundEv("PAYMENT.CAPTURE.REFUNDED", "WH-FULL-0001"));
  eq([full.j.result, depositRow(e.store, e.q.id).status], ["refunded", "refunded"]);
  eq((await webhook(e, refundEv("PAYMENT.CAPTURE.REFUNDED", "WH-FULL-0002"))).j.result, "already_refunded");
  eq((await viewQuote(e.token, e.store)).pay_state.deposit!.status, "refunded");

  const r = await setup();
  const rc = await payDeposit(r);
  const rev = await webhook(r, { id: "WH-REV-0001", event_type: "PAYMENT.CAPTURE.REVERSED", resource_type: "refund",
    resource: { id: "6WK2X1238H2387C", amount: { currency_code: "USD", value: "-1.00" }, links: [{ rel: "up", href: `https://api.paypal.com/v2/payments/captures/${rc.capture_id}` }] } });
  eq([rev.j.result, depositRow(r.store, r.q.id).status, r.store.alerts.at(-1)!.kind], ["refunded", "refunded", "reversed"]);

  const dsp = await webhook(r, { id: "WH-DSP-0001", event_type: "CUSTOMER.DISPUTE.CREATED", resource_type: "dispute",
    resource: { dispute_id: "PP-D-27803", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", dispute_amount: { currency_code: "USD", value: "1750.00" },
      disputed_transactions: [{ seller_transaction_id: rc.capture_id }], seller_response_due_date: "2026-10-31T23:59:59Z" } });
  eq(dsp.j.result, "alerted");
  const a = r.store.alerts.at(-1)!;
  eq([a.kind, a.ref, a.payment_id, a.payload.reason], ["dispute", "PP-D-27803", depositRow(r.store, r.q.id).id, "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"]);
  eq(r.store.outbox.filter((o) => o.key === "admin_paypal_alert:dispute:PP-D-27803").length, 1, "one owner mail per dispute");
  eq((await webhook(r, { id: "WH-OTHER-001", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "X" } })).j.result, "ignored");
  eq(WEBHOOK_EVENTS, ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.DECLINED", "CUSTOMER.DISPUTE.CREATED"]);
});

Deno.test("webhook: a PENDING capture PayPal declines is forgotten (the client can pay again, Meir alerted); a paid row is never touched", async () => {
  const p = await setup();
  p.fake.captureStatus = "PENDING";
  const c = await call(createH(p.deps), { t: p.token });
  await call(captureH(p.deps), { t: p.token, which: "deposit", order_id: c.j.order_id });
  const dep = depositRow(p.store, p.q.id), cap = dep.provider_capture_id!;
  eq((await call(createH(p.deps), { t: p.token })).j.error, "payment_pending", "blocked while pending");
  const dec = await webhook(p, { id: "WH-DEC-0001", event_type: "PAYMENT.CAPTURE.DECLINED", resource_type: "capture",
    resource: { id: cap, status: "DECLINED", amount: { currency_code: "USD", value: toValue(dep.amount_cents) } } });
  eq([dec.j.result, depositRow(p.store, p.q.id).provider_capture_id, depositRow(p.store, p.q.id).status], ["cleared", null, "due"]);
  eq(p.store.alerts.at(-1)!.kind, "declined");
  eq((await viewQuote(p.token, p.store)).pay_state.deposit!.status, "due", "the quote page shows the buttons again");
  p.fake.captureStatus = "COMPLETED";
  const again = await call(createH(p.deps), { t: p.token });
  const k = await call(captureH(p.deps), { t: p.token, which: "deposit", order_id: again.j.order_id });
  eq([again.status, k.j.status], [200, "paid"], "paid on the second try");
  const late = await webhook(p, { id: "WH-DEC-0002", event_type: "PAYMENT.CAPTURE.DECLINED", resource_type: "capture",
    resource: { id: String(k.j.reference), status: "DECLINED" } });
  eq([late.j.result, depositRow(p.store, p.q.id).status], ["mismatch", "paid"], "declined after paid: alert only");
});

// ------------------------------------------------------------------ pay-refund
Deno.test("pay-refund: admin only, full PayPal refund of a deposit within the 7-day rule, idempotent; refusals never call PayPal", async () => {
  const e = await setup();
  await payDeposit(e);
  const dep = depositRow(e.store, e.q.id);
  e.store.admins.set("admin-jwt", "admin-uid");
  const h = refundH(e.deps);
  eq((await call(h, { payment_id: dep.id })).status, 403, "no JWT");
  eq((await call(h, { payment_id: dep.id }, { authorization: "Bearer client-jwt" })).status, 403, "not an admin");
  const days = Number((PB.refund_rules.deposit as { window_days?: number }).window_days);
  const later = await call(refundH({ ...e.deps, now: () => new Date(Date.parse(dep.paid_at!) + (days + 1) * 864e5) }), { payment_id: dep.id },
    { authorization: "Bearer admin-jwt" });
  eq([later.status, later.j.error], [409, "refund_window_passed"]);
  assert(!e.fake.paths().some((p) => p.endsWith("/refund")), "outside the window: PayPal not called");
  const ok = await call(h, { payment_id: dep.id }, { authorization: "Bearer admin-jwt" });
  eq([ok.status, ok.j.status, depositRow(e.store, e.q.id).status], [200, "refunded", "refunded"]);
  const rq = e.fake.calls.find((c) => c.path.endsWith("/refund"))!;
  eq([rq.headers["paypal-request-id"], JSON.parse(rq.body).amount], [`refund-${dep.provider_capture_id}`, undefined], "full refund, one request id per capture");
  assert(e.store.events.some((x) => x.type === "payment_refunded" && String(x.payload.source) === "admin:admin-uid"), "who refunded");
  eq((await call(h, { payment_id: dep.id }, { authorization: "Bearer admin-jwt" })).j.refund_status, "ALREADY_REFUNDED");
  eq(e.fake.paths().filter((p) => p.endsWith("/refund")).length, 1, "a second click refunds nothing");
  // not PayPal / not paid / final / bad id
  const final = [...e.store.payments.values()].find((p) => p.kind === "final")!;
  eq((await call(h, { payment_id: final.id }, { authorization: "Bearer admin-jwt" })).j.error, "not_paypal");
  eq((await call(h, { payment_id: "nope" }, { authorization: "Bearer admin-jwt" })).j.error, "bad_payment_id");
  eq((await call(h, { payment_id: crypto.randomUUID() }, { authorization: "Bearer admin-jwt" })).status, 404);
  // PayPal already refunded it (dashboard): synced
  const f = await setup();
  await payDeposit(f);
  f.store.admins.set("admin-jwt", "admin-uid");
  f.fake.refundFail = { status: 422, name: "UNPROCESSABLE_ENTITY", issue: "CAPTURE_FULLY_REFUNDED" };
  eq((await call(refundH(f.deps), { payment_id: depositRow(f.store, f.q.id).id }, { authorization: "Bearer admin-jwt" })).j.status, "refunded");
  eq(depositRow(f.store, f.q.id).status, "refunded");
  f.fake.refundFail = null;
});

// ------------------------------------------------------------------ pay-upwork + final payment
Deno.test("pay-upwork: the quote and its unpaid rows move to Upwork, Meir gets the contract checklist; refused once paid", async () => {
  const e = await setup();
  await call(createH(e.deps), { t: e.token });
  const u = await call(upworkH({ store: () => e.store }), { t: e.token });
  eq([u.status, (u.j.payment as Json).method], [200, "upwork"], "the public view comes back on Upwork");
  eq(e.store.quotes.get(e.q.id)!.pay_method, "upwork");
  const rows = [...e.store.payments.values()];
  assert(rows.every((p) => p.method === "upwork" && p.provider === null && p.provider_order_id === null), "rows follow");
  eq(e.store.outbox.map((o) => o.template), ["admin_upwork_requested"]);
  eq((await call(upworkH({ store: () => e.store }), { t: e.token })).status, 200, "idempotent");
  eq(e.store.outbox.length, 1);
  const p = await setup();
  await payDeposit(p);
  eq((await call(upworkH({ store: () => p.store }), { t: p.token })).j.error, "deposit_already_paid");
  eq((await call(upworkH({ store: () => p.store }), { t: "bad" })).status, 404);
});

Deno.test("final payment (portal): only after the deposit and from testing; its own order and receipt; no checklist mail again", async () => {
  const e = await setup("bndl");
  await payDeposit(e);
  eq((await call(createH(e.deps), { t: e.token, which: "final" })).j.error, "final_not_ready", "during onboarding");
  const c = [...e.store.clients.values()][0];
  c.status = "testing";
  const fc = await call(createH(e.deps), { t: e.token, which: "final" });
  eq(fc.status, 200);
  const body = JSON.parse(e.fake.calls.filter((x) => x.method === "POST" && x.path === "/v2/checkout/orders").pop()!.body);
  const bndl = PB.items.find((i) => i.code === "BNDL")!.name;
  eq([body.purchase_units[0].description, body.purchase_units[0].amount.value, body.purchase_units[0].reference_id],
    [`${BRAND.name} – ${bndl} final payment`, toValue(e.q.setup_cents! - e.q.deposit_cents!), "final"]);
  const k = await call(captureH(e.deps), { t: e.token, which: "final", order_id: fc.j.order_id });
  eq([k.status, k.j.status, k.j.which], [200, "paid", "final"]);
  eq((await viewQuote(e.token, e.store)).pay_state.final!.status, "paid");
  eq(e.store.outbox.filter((o) => o.template === "deposit_received").length, 1, "no second welcome mail");
  eq(e.store.outbox.filter((o) => o.template === "payment_receipt").length, 2, "one receipt per payment");
});

Deno.test("no secret or token in logs or responses, whatever fails", async () => {
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    const e = await setup();
    const outs: string[] = [];
    e.fake.captureFail = { status: 500, name: "INTERNAL_SERVER_ERROR", issue: "" };
    const c = await call(createH(e.deps), { t: e.token });
    outs.push(JSON.stringify((await call(captureH(e.deps), { t: e.token, which: "deposit", order_id: c.j.order_id })).j));
    outs.push(JSON.stringify((await call(createH({ ...e.deps, paypal: () => newClient(e.fake, { clientId: "ZzZzZzZzZzZzZzZzZzZz" }) }), { t: e.token })).j));
    e.fake.verify = "FAILURE";
    outs.push(JSON.stringify((await webhook(e, completedEvent("8MC585209K746392H", "x", 1))).j));
    const all = seen.join("\n") + outs.join("\n");
    assert(seen.length >= 2, "errors were logged");
    for (const s of [SECRET, "fake-token", btoa(`${CLIENT_ID}:${SECRET}`), WEBHOOK_ID]) assert(!all.includes(s), "leaked: " + s.slice(0, 6));
  } finally {
    console.error = orig;
  }
});
