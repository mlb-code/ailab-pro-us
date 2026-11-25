// Paddle Billing, fully offline: signature checks, event mapping for every handled event type, idempotency and
// out-of-order delivery, plan mapping (incl. the downgrade that waits for the next billing date), and the portal actions
// against a fake Paddle REST API behind the injectable fetch. Global fetch is replaced by a thrower: any real network call
// fails the test. Secrets here are fake values assembled at runtime.
import { BRAND } from "./config.ts";
import {
  apiBase, mapSubscriptionEvent, PaddleClient, paddleReady, parseSignature, priceId, priceMap, signForTest, type StoredSub,
  verifySignature, WEBHOOK_EVENTS,
} from "./paddle.ts";
import { billingAction } from "./paddle_billing.ts";
import { MemoryPaddleStore } from "./paddle_store.ts";
import { assert, eq, rejects } from "./test_util.ts";
import { makeHandler as hookH } from "../paddle-webhook/index.ts";
import { makeHandler as billH } from "../paddle-billing/index.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const SECRET = ["pdl", "ntfset", "01testsecret", "x".repeat(20)].join("_");
const API_KEY = ["pdl", "sdbx", "apikey", "01test", "y".repeat(30)].join("_");
const pid = (s: string) => "pri_" + s.padEnd(26, "0");
const PRICES = {
  FR_STARTER: { trial: pid("startertrial"), paid: pid("starterpaid") },
  FR_PRO: { trial: pid("protrial"), paid: pid("propaid") },
  FR_BUSINESS: { trial: pid("biztrial"), paid: pid("bizpaid") },
};
const BRAND_ON = { ...structuredClone(BRAND), payments: { ...(BRAND.payments as object), paddle: { enabled: true, env: "sandbox", client_token: "test_" + "a".repeat(27), prices: PRICES } } };
const MAP = priceMap(BRAND_ON);
const USER = crypto.randomUUID(), REF = "chk_" + "a".repeat(32), SID = "sub_01hv8x29kz0t586xy6zn1a62ny";
const DAY = 86400000, t0 = Date.parse("2026-12-01T10:00:00Z");
const at = (ms: number) => new Date(ms).toISOString();

function sub(status: string, price: string, extra: Record<string, unknown> = {}) {
  return {
    id: SID, status, customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4", collection_mode: "automatic", custom_data: { ref: REF },
    items: [{ status: status === "trialing" ? "trialing" : "active", quantity: 1, recurring: true, price: { id: price },
      trial_dates: status === "trialing" ? { starts_at: at(t0), ends_at: at(t0 + 14 * DAY) } : null }],
    current_billing_period: status === "canceled" || status === "paused" ? null : { starts_at: at(t0), ends_at: at(t0 + 30 * DAY) },
    scheduled_change: null, canceled_at: null, ...extra,
  };
}
let n = 0;
const event = (type: string, data: unknown, occurredMs = t0 + (n++) * 1000, id = "evt_" + crypto.randomUUID().replace(/-/g, "")) =>
  ({ event_id: id, event_type: type, occurred_at: at(occurredMs), notification_id: "ntf_x", data });

function freshStore() {
  const s = new MemoryPaddleStore();
  s.checkouts.set(REF, { ref: REF, user_id: USER, plan_code: "FR_PRO", trial: true, business_phone: "+17135550142", status: "open" });
  return s;
}
async function post(h: (r: Request) => Promise<Response>, body: unknown, opts: { secret?: string; ts?: number; tamper?: boolean; header?: string | null } = {}) {
  const raw = JSON.stringify(body);
  const header = opts.header !== undefined ? opts.header : await signForTest(raw, opts.secret ?? SECRET, opts.ts ?? Math.floor(Date.now() / 1000));
  const sent = opts.tamper ? raw.replace('"status":"trialing"', '"status":"active"') : raw;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header) headers["Paddle-Signature"] = header;
  const r = await h(new Request("https://x.test/functions/v1/paddle-webhook", { method: "POST", headers, body: sent }));
  return { status: r.status, body: await r.json() };
}
const hook = (store: MemoryPaddleStore) => hookH({ store: () => store, secret: () => SECRET, brand: BRAND_ON });

// ------------------------------------------------------------------ signature
Deno.test("signature: valid, tampered body, wrong secret, stale, missing / malformed header, rotation", async () => {
  const raw = '{"event_id":"evt_1","event_type":"subscription.created"}', now = 1764583200;
  const h = await signForTest(raw, SECRET, now);
  eq(await verifySignature(raw, h, SECRET, now), { ok: true }, "valid");
  eq(await verifySignature(raw + " ", h, SECRET, now), { ok: false, reason: "bad_signature" }, "a changed byte (even whitespace)");
  eq(await verifySignature(raw, h, SECRET + "x", now), { ok: false, reason: "bad_signature" }, "wrong secret");
  eq(await verifySignature(raw, h, SECRET, now + 301), { ok: false, reason: "stale_timestamp" }, "older than the tolerance");
  eq(await verifySignature(raw, h, SECRET, now - 301), { ok: false, reason: "stale_timestamp" }, "from the future");
  eq(await verifySignature(raw, h, SECRET, now + 299), { ok: true }, "within the skew tolerance");
  eq(await verifySignature(raw, null, SECRET, now), { ok: false, reason: "missing_header" }, "no header");
  eq(await verifySignature(raw, "ts=abc;h1=zz", SECRET, now), { ok: false, reason: "bad_header" }, "malformed");
  eq(await verifySignature(raw, h, "", now), { ok: false, reason: "no_secret" }, "secret not set = refuse");
  const rot = `ts=${now};h1=${"0".repeat(64)};h1=${h.split("h1=")[1]}`;
  eq(await verifySignature(raw, rot, SECRET, now), { ok: true }, "secret rotation: any h1 may match");
  eq(parseSignature(h)!.ts, now);
});

Deno.test("webhook HTTP: invalid signatures change nothing", async () => {
  const s = freshStore(), h = hook(s), body = event("subscription.created", sub("trialing", PRICES.FR_PRO.trial));
  eq((await post(h, body, { tamper: true })).status, 401, "tampered body");
  eq((await post(h, body, { secret: SECRET + "nope" })).status, 401, "wrong secret");
  eq((await post(h, body, { ts: Math.floor(Date.now() / 1000) - 3600 })).body.reason, "stale_timestamp", "stale timestamp");
  eq((await post(h, body, { header: null })).body.reason, "missing_header", "no header");
  eq(s.upserts.length + s.events.size, 0, "nothing applied or logged");
  const off = await post(hookH({ store: () => s, secret: () => "", brand: BRAND_ON }), body);
  eq(off.status, 503, "no secret configured: refuse (Paddle retries later)");
  eq((await hook(s)(new Request("https://x.test", { method: "GET" }))).status, 405);
});

// ------------------------------------------------------------------ mapping per event type
Deno.test("events: created (trial) -> activated -> scheduled cancel -> canceled; user + phone only from the ref row", async () => {
  const s = freshStore(), h = hook(s);
  const created = event("subscription.created", { ...sub("trialing", PRICES.FR_PRO.trial), transaction_id: "txn_01abc", custom_data: { ref: REF, user_id: crypto.randomUUID(), business_phone: "+12125550000" } });
  const r = await post(h, created);
  eq([r.status, r.body.result], [200, "applied:trialing"]);
  let a = s.upserts.at(-1)!;
  eq([a.p_user_id, a.p_business_phone, a.p_plan_code, a.p_status, a.p_trial_ends_at, a.p_current_period_end, a.p_card_on_file, a.p_cancel_at_period_end],
    [USER, "+17135550142", "FR_PRO", "trialing", at(t0 + 14 * DAY), null, true, false], "trial row: ids typed in the browser (customData user_id/phone) are ignored");
  eq(s.checkouts.get(REF)!.status, "completed", "checkout ref marked done");
  await post(h, event("subscription.trialing", sub("trialing", PRICES.FR_PRO.trial)));
  eq(s.upserts.at(-1)!.p_user_id, null, "existing row: no user id needed");
  await post(h, event("subscription.activated", sub("active", PRICES.FR_PRO.trial, { current_billing_period: { starts_at: at(t0 + 14 * DAY), ends_at: at(t0 + 44 * DAY) } })));
  a = s.upserts.at(-1)!;
  eq([a.p_status, a.p_current_period_start, a.p_current_period_end, a.p_plan_code], ["active", at(t0 + 14 * DAY), at(t0 + 44 * DAY), "FR_PRO"], "activated: paid period");
  await post(h, event("subscription.updated", sub("active", PRICES.FR_PRO.trial, { scheduled_change: { action: "cancel", effective_at: at(t0 + 44 * DAY), resume_at: null } })));
  eq(s.subs.get(SID)!.cancel_at_period_end, true, "scheduled cancel -> cancel_at_period_end");
  await post(h, event("subscription.updated", sub("active", PRICES.FR_PRO.trial)));
  eq(s.subs.get(SID)!.cancel_at_period_end, false, "scheduled change removed -> undone");
  await post(h, event("subscription.past_due", sub("past_due", PRICES.FR_PRO.trial)));
  eq([s.upserts.at(-1)!.p_status, s.upserts.at(-1)!.p_card_on_file], ["past_due", null], "past_due: card state unknown, not set");
  await post(h, event("subscription.paused", sub("paused", PRICES.FR_PRO.trial, { paused_at: at(t0) })));
  eq([s.subs.get(SID)!.status, s.upserts.at(-1)!.p_current_period_end], ["paused", null]);
  await post(h, event("subscription.resumed", sub("active", PRICES.FR_PRO.trial)));
  eq(s.subs.get(SID)!.status, "active");
  await post(h, event("subscription.canceled", sub("canceled", PRICES.FR_PRO.trial, { canceled_at: at(t0 + 44 * DAY) })));
  a = s.upserts.at(-1)!;
  eq([a.p_status, a.p_canceled_at, a.p_cancel_at_period_end, a.p_scheduled_plan_code], ["canceled", at(t0 + 44 * DAY), false, null], "canceled");
  eq([...s.events.values()].every((e) => e.result.startsWith("applied")), true, "every event logged as applied");
});

Deno.test("idempotency and out-of-order delivery", async () => {
  const s = freshStore(), h = hook(s);
  const created = event("subscription.created", sub("trialing", PRICES.FR_PRO.trial), t0);
  const updated = event("subscription.updated", sub("trialing", PRICES.FR_BUSINESS.trial), t0 + 60000);
  // the newer update arrives FIRST (before created): the row is created from it (user from the ref)
  eq((await post(h, updated)).body.result, "applied:trialing");
  eq(s.subs.get(SID)!.plan_code, "FR_BUSINESS");
  eq((await post(h, created)).body.result, "stale", "older event: no change");
  eq(s.subs.get(SID)!.plan_code, "FR_BUSINESS", "plan from the newer event kept");
  eq((await post(h, created)).body.result, "duplicate", "same event id again: skipped");
  eq((await post(h, updated)).body.result, "duplicate");
  eq(s.upserts.length, 2, "two upserts, no third");
});

Deno.test("plan mapping: price ids -> plan codes; unknown price / no user -> 200 + alert", async () => {
  eq(MAP.get(PRICES.FR_STARTER.paid), { plan: "FR_STARTER", kind: "paid" });
  eq(MAP.get(PRICES.FR_BUSINESS.trial), { plan: "FR_BUSINESS", kind: "trial" });
  eq(MAP.size, 6);
  eq(priceId("FR_PRO", "paid", BRAND_ON), PRICES.FR_PRO.paid);
  await rejects(() => Promise.resolve().then(() => priceId("FR_PRO", "paid", BRAND)), "price_not_configured");
  eq([paddleReady(BRAND_ON), paddleReady(BRAND)], [true, false], "brand.json ships with Paddle off (placeholders)");
  const s = freshStore(), h = hook(s);
  const r = await post(h, event("subscription.created", sub("trialing", "pri_" + "z".repeat(26))));
  eq([r.status, r.body.result, s.alerts.at(-1)?.kind], [200, "skipped:unknown_price", "unknown_price"]);
  const r2 = await post(h, event("subscription.created", { ...sub("trialing", PRICES.FR_PRO.trial), custom_data: null }));
  eq([r2.status, r2.body.result, s.alerts.at(-1)?.kind], [200, "skipped:no_user", "no_user"], "a subscription made outside our sign-up");
  eq(s.upserts.length, 0);
});

Deno.test("downgrade waits for the next billing date; the renewal applies it", () => {
  const stored: StoredSub = { subscription_id: "x", client_id: "c", user_id: USER, provider: "paddle", provider_subscription_id: SID, provider_customer_id: "ctm_1",
    plan_code: "FR_BUSINESS", scheduled_plan_code: "FR_STARTER", status: "active", cancel_at_period_end: false, trial_ends_at: null,
    current_period_start: at(t0), current_period_end: at(t0 + 30 * DAY), last_event_at: at(t0) };
  const same = mapSubscriptionEvent(event("subscription.updated", sub("active", PRICES.FR_STARTER.paid)), MAP, stored, null);
  assert(same.ok);
  eq([same.args.p_plan_code, same.args.p_scheduled_plan_code], ["FR_BUSINESS", "FR_STARTER"], "same period: old plan kept, change scheduled");
  const renewed = mapSubscriptionEvent(event("subscription.updated", sub("active", PRICES.FR_STARTER.paid,
    { current_billing_period: { starts_at: at(t0 + 30 * DAY), ends_at: at(t0 + 60 * DAY) } })), MAP, stored, null);
  assert(renewed.ok);
  eq([renewed.args.p_plan_code, renewed.args.p_scheduled_plan_code], ["FR_STARTER", null], "next period: new plan");
  const before = mapSubscriptionEvent(event("subscription.updated", sub("active", PRICES.FR_BUSINESS.paid)), MAP, stored, null);
  assert(before.ok);
  eq([before.args.p_plan_code, before.args.p_scheduled_plan_code], ["FR_BUSINESS", "FR_STARTER"], "event before the PATCH: still scheduled");
  const up = mapSubscriptionEvent(event("subscription.updated", sub("active", PRICES.FR_PRO.paid)), MAP, { ...stored, plan_code: "FR_STARTER", scheduled_plan_code: null }, null);
  assert(up.ok);
  eq([up.args.p_plan_code, up.args.p_scheduled_plan_code], ["FR_PRO", null], "upgrade: now");
});

Deno.test("transactions: first paid charge (money-back window), \$0 trial charge, payment failed", async () => {
  const s = freshStore(), h = hook(s);
  await post(h, event("subscription.created", sub("trialing", PRICES.FR_PRO.trial)));
  const tx = (type: string, id: string, total: string, origin: string) => event(type, { id, status: type === "transaction.completed" ? "completed" : "past_due", origin,
    subscription_id: SID, billed_at: at(t0), details: { totals: { total, grand_total: total, currency_code: "USD" } } });
  eq((await post(h, tx("transaction.completed", "txn_01zerotrial", "0", "web"))).body.result, "recorded", "$0 sign-up transaction");
  eq(s.subs.get(SID)!.first_paid_at, null);
  eq((await post(h, tx("transaction.completed", "txn_01firstpaid", "24900", "subscription_recurring"))).body.result, "first_paid");
  eq(s.subs.get(SID)!.first_paid_transaction_id, "txn_01firstpaid");
  eq((await post(h, tx("transaction.completed", "txn_01second", "24900", "subscription_recurring"))).body.result, "recorded", "later charges do not move it");
  eq((await post(h, tx("transaction.payment_failed", "txn_01failed", "24900", "subscription_recurring"))).body.result, "payment_failed");
  eq(s.txs.get("txn_01failed")!.p_status, "payment_failed");
  eq(s.txs.get("txn_01firstpaid")!.p_total_cents, 24900);
});

Deno.test("database errors: permanent -> 200 + alert; temporary -> 500, not marked seen (Paddle retries)", async () => {
  const s = freshStore(), h = hook(s);
  s.failNext = "user_not_found";
  const e1 = event("subscription.created", sub("trialing", PRICES.FR_PRO.trial));
  eq((await post(h, e1)).body.result, "error:user_not_found");
  eq(s.alerts.at(-1)!.kind, "user_not_found");
  s.failNext = "http_503";
  const e2 = event("subscription.updated", sub("trialing", PRICES.FR_PRO.trial));
  eq((await post(h, e2)).status, 500);
  eq(s.events.has(e2.event_id), false, "not logged: the retry is processed");
  eq((await post(h, e2)).body.result, "applied:trialing", "retry succeeds");
  eq(WEBHOOK_EVENTS.join(), "subscription.created,subscription.updated,subscription.activated,subscription.trialing,subscription.past_due,subscription.paused,subscription.resumed,subscription.canceled,transaction.completed,transaction.payment_failed");
});

// ------------------------------------------------------------------ portal actions against a fake Paddle API
interface Call { method: string; path: string; auth: string; version: string; body: Record<string, unknown> }
function fakePaddle(failPath = "") {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : {};
    const hd = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", path: u.pathname, auth: hd.get("authorization") ?? "", version: hd.get("paddle-version") ?? "", body });
    assert(u.origin === apiBase("sandbox"), "sandbox base URL");
    if (failPath && u.pathname.includes(failPath)) return new Response(JSON.stringify({ error: { code: "subscription_locked_pending_changes" } }), { status: 400 });
    if (u.pathname.endsWith("/portal-sessions")) {
      return new Response(JSON.stringify({ data: { id: "cpls_1", urls: { general: { overview: "https://customer-portal.paddle.com/cpl_1?token=t1" },
        subscriptions: [{ id: SID, update_subscription_payment_method: "https://customer-portal.paddle.com/cpl_1/pm?token=t2", cancel_subscription: "x", view_subscription: "y" }] } } }), { status: 201 });
    }
    if (u.pathname === "/adjustments") return new Response(JSON.stringify({ data: { id: "adj_01test", status: "pending_approval" } }), { status: 201 });
    return new Response(JSON.stringify({ data: { id: SID } }), { status: 200 });
  }) as typeof fetch;
  return { calls, client: new PaddleClient({ env: "sandbox", apiKey: API_KEY, webhookSecret: SECRET }, f) };
}
function withSub(status: string, plan: string, extra: Partial<StoredSub> = {}) {
  const s = freshStore();
  s.users.set("jwt-user", { id: USER, is_admin: false });
  s.users.set("jwt-admin", { id: crypto.randomUUID(), is_admin: true });
  s.subs.set(SID, { subscription_id: "s1", client_id: "00000000-0000-4000-8000-000000000001", user_id: USER, provider: "paddle", provider_subscription_id: SID,
    provider_customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4", plan_code: plan, scheduled_plan_code: null, status, cancel_at_period_end: false,
    trial_ends_at: null, current_period_start: at(t0), current_period_end: at(t0 + 30 * DAY), last_event_at: at(t0), card_on_file: true,
    canceled_at: null, money_back_used_at: null, first_paid_at: null, first_paid_transaction_id: null, ...extra });
  return s;
}
const act = (s: MemoryPaddleStore, p: ReturnType<typeof fakePaddle>, action: string, extra: Record<string, unknown> = {}, jwt = "jwt-user") =>
  billingAction({ jwt, action, ...extra }, { store: s, paddle: p.client, brand: BRAND_ON });

Deno.test("actions: upgrade now (prorated), downgrade next period (scheduled first), trial change, keep plan", async () => {
  let s = withSub("active", "FR_STARTER"), p = fakePaddle();
  eq((await act(s, p, "change_plan", { plan_code: "FR_PRO" })).applies, "now");
  eq([p.calls[0].method, p.calls[0].path, p.calls[0].body.proration_billing_mode, (p.calls[0].body.items as Array<{ price_id: string }>)[0].price_id, p.calls[0].body.on_payment_failure],
    ["PATCH", "/subscriptions/" + SID, "prorated_immediately", PRICES.FR_PRO.paid, "prevent_change"], "upgrade PATCH");
  eq([p.calls[0].auth, p.calls[0].version], ["Bearer " + API_KEY, "1"], "server API key + Paddle-Version");

  s = withSub("active", "FR_BUSINESS"); p = fakePaddle();
  eq((await act(s, p, "change_plan", { plan_code: "FR_STARTER" })).applies, "next_period");
  eq([s.upserts[0].p_scheduled_plan_code, s.upserts[0].p_plan_code, s.upserts[0].p_event_at], ["FR_STARTER", "FR_BUSINESS", at(t0)], "scheduled written before the PATCH, last_event_at kept");
  eq([p.calls[0].body.proration_billing_mode, (p.calls[0].body.items as Array<{ price_id: string }>)[0].price_id], ["full_next_billing_period", PRICES.FR_STARTER.paid]);
  s.subs.get(SID)!.scheduled_plan_code = "FR_STARTER"; p = fakePaddle();
  await act(s, p, "change_plan", { plan_code: "FR_BUSINESS" });
  eq([s.subs.get(SID)!.scheduled_plan_code, (p.calls[0].body.items as Array<{ price_id: string }>)[0].price_id], [null, PRICES.FR_BUSINESS.paid], "keep my plan: scheduled downgrade undone");

  s = withSub("active", "FR_BUSINESS"); p = fakePaddle("/subscriptions/");
  await rejects(() => act(s, p, "change_plan", { plan_code: "FR_STARTER" }), "paddle_error");
  eq(s.subs.get(SID)!.scheduled_plan_code, null, "Paddle refused the downgrade: scheduled reverted");

  s = withSub("trialing", "FR_PRO"); p = fakePaddle();
  await act(s, p, "change_plan", { plan_code: "FR_STARTER" });
  eq([p.calls[0].body.proration_billing_mode, (p.calls[0].body.items as Array<{ price_id: string }>)[0].price_id], ["do_not_bill", PRICES.FR_STARTER.trial], "trial: do_not_bill, trial price");
  await rejects(() => act(withSub("active", "FR_PRO"), fakePaddle(), "change_plan", { plan_code: "FR_PRO" }), "same_plan");
  await rejects(() => act(withSub("past_due", "FR_PRO"), fakePaddle(), "change_plan", { plan_code: "FR_BUSINESS" }), "past_due_update_card");
  await rejects(() => act(withSub("active", "FR_PRO"), fakePaddle(), "change_plan", { plan_code: "FR_GOLD" }), "bad_plan_code");
});

Deno.test("actions: start now, cancel (trial now / paid at period end), resume, update card, resubscribe", async () => {
  let s = withSub("trialing", "FR_PRO"), p = fakePaddle();
  await act(s, p, "start_now");
  eq([p.calls[0].method, p.calls[0].path], ["POST", `/subscriptions/${SID}/activate`]);
  await rejects(() => act(withSub("active", "FR_PRO"), fakePaddle(), "start_now"), "not_trialing");
  p = fakePaddle();
  eq((await act(withSub("trialing", "FR_PRO"), p, "cancel")).ends, "now");
  eq([p.calls[0].path, p.calls[0].body.effective_from], [`/subscriptions/${SID}/cancel`, "immediately"], "trial cancel: immediately, nothing charged");
  p = fakePaddle();
  eq((await act(withSub("active", "FR_PRO"), p, "cancel")).ends, "period_end");
  eq(p.calls[0].body.effective_from, "next_billing_period");
  p = fakePaddle();
  await act(withSub("active", "FR_PRO", { cancel_at_period_end: true }), p, "resume");
  eq([p.calls[0].method, JSON.stringify(p.calls[0].body)], ["PATCH", '{"scheduled_change":null}'], "undo cancel: remove the scheduled change");
  p = fakePaddle();
  await act(withSub("paused", "FR_PRO"), p, "resume");
  eq([p.calls[0].path, p.calls[0].body.effective_from], [`/subscriptions/${SID}/resume`, "immediately"]);
  eq((await act(withSub("canceled", "FR_PRO"), fakePaddle(), "resume")).resubscribe, true, "ended: a new checkout");
  p = fakePaddle();
  const u = await act(withSub("active", "FR_PRO"), p, "update_card");
  eq([u.url, p.calls[0].path, (p.calls[0].body.subscription_ids as string[])[0]], ["https://customer-portal.paddle.com/cpl_1/pm?token=t2", "/customers/ctm_01hv6y1jedq4p1n0yqn5ba3ky4/portal-sessions", SID]);
  eq((await act(withSub("past_due", "FR_PRO"), fakePaddle(), "resume")).update_card, true, "past due: pay with a new card");
});

Deno.test("actions: auth, provider, Paddle off; HTTP handler never returns the key", async () => {
  await rejects(() => act(withSub("active", "FR_PRO"), fakePaddle(), "cancel", {}, "bad-jwt"), "not_signed_in");
  await rejects(() => act(withSub("active", "FR_PRO", { provider: "mock" }), fakePaddle(), "cancel"), "not_paddle");
  await rejects(() => billingAction({ jwt: "jwt-user", action: "cancel" }, { store: withSub("active", "FR_PRO"), paddle: null, brand: BRAND_ON }), "paddle_off");
  const s = withSub("active", "FR_PRO"), p = fakePaddle("/cancel");
  const h = billH({ store: () => s, paddle: () => p.client, brand: BRAND_ON });
  const r = await h(new Request("https://x.test/functions/v1/paddle-billing", { method: "POST", headers: { Authorization: "Bearer jwt-user", Origin: BRAND.site_url }, body: JSON.stringify({ action: "cancel" }) }));
  const text = await r.text();
  eq([r.status, JSON.parse(text).error, JSON.parse(text).paddle], [409, "paddle_error", "subscription_locked_pending_changes"]);
  assert(!text.includes(API_KEY) && !text.includes(SECRET), "no secret in the reply");
  eq((await h(new Request("https://x.test", { method: "POST", headers: { Authorization: "Bearer jwt-user" }, body: "{" }))).status, 400);
});

Deno.test("admin money-back: confirm, admin only, window, once; refund + plan ends", async () => {
  const cid = "00000000-0000-4000-8000-000000000001";
  let s = withSub("active", "FR_PRO", { first_paid_at: at(Date.now() - 5 * DAY), first_paid_transaction_id: "txn_01firstpaid" }), p = fakePaddle();
  await rejects(() => act(s, p, "money_back", { client_id: cid, confirm: true }), "forbidden");
  await rejects(() => act(s, p, "money_back", { client_id: cid }, "jwt-admin"), "confirm_required");
  const r = await act(s, p, "money_back", { client_id: cid, confirm: true }, "jwt-admin");
  eq([r.refund_id, r.refund_status, r.plan_ended], ["adj_01test", "pending_approval", true]);
  eq([p.calls[0].path, p.calls[0].body.action, p.calls[0].body.type, p.calls[0].body.transaction_id], ["/adjustments", "refund", "full", "txn_01firstpaid"]);
  eq([p.calls[1].path, p.calls[1].body.effective_from], [`/subscriptions/${SID}/cancel`, "immediately"]);
  await rejects(() => act(s, fakePaddle(), "money_back", { client_id: cid, confirm: true }, "jwt-admin"), "money_back_already_used");
  s = withSub("active", "FR_PRO", { first_paid_at: at(Date.now() - 31 * DAY), first_paid_transaction_id: "txn_01firstpaid" }); p = fakePaddle();
  await rejects(() => act(s, p, "money_back", { client_id: cid, confirm: true }, "jwt-admin"), "money_back_window_closed");
  eq(p.calls.length, 0, "nothing sent to Paddle outside the window");
});
