// PayPal checkout core, independent of HTTP (Edge Functions pay-create, pay-capture, paypal-webhook, pay-refund, pay-upwork):
//   createPayment   accepted PayPal quote + deposit|final -> a PayPal order for OUR payment row (amount from the DB,
//                   custom_id = invoice_id = payment id); reuses the payment's open (CREATED) order
//   capturePayment  captures server-side, checks custom_id / currency / amount against the row, then marks it paid through
//                   pay_record_capture (= the admin's mark-paid UPDATE: checklist + deposit_received fire as before)
//   handleWebhook   signature verified by PayPal's API (PAYPAL_WEBHOOK_ID); CAPTURE.COMPLETED -> paid (idempotent),
//                   CAPTURE.REFUNDED / REVERSED -> refunded, CUSTOMER.DISPUTE.CREATED -> Hebrew alert to Meir
//   refundPayment   admin only: full refund of a PayPal deposit within the price book's 7-day rule
//   useUpwork       the client switches an unpaid PayPal quote to Upwork Direct Contracts
// Never trusts a PayPal amount (or one from the browser) without matching our row. Logs carry codes, never payloads.
import { BRAND, type Brand, PRICEBOOK } from "./config.ts";
import { captureIdFromLinks, captureOf, orderBody, type PaypalClient, PaypalError, type PaypalMoney, type PaypalOrder, toCents, webhookHeaders } from "./paypal.ts";
import type { AlertKind, PayKind, PayStore, PayTarget } from "./pay_store.ts";
import type { Pricebook } from "./pricing.ts";
import { type PublicQuote, QuoteError, viewQuote } from "./quote_engine.ts";
import * as QV from "./quote_view.mjs";
import { DbError } from "./store.ts";

export interface PayDeps { store: PayStore; paypal: PaypalClient | null; brand?: Brand; pb?: Pricebook; now?: () => Date }
export interface PayResult { status: "paid" | "pending"; which: PayKind; amount_cents: number; reference: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PP_ID = /^[A-Za-z0-9-]{8,64}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

// ------------------------------------------------------------------ guards + error mapping
/** PayPal is usable only when brand.json turns it on AND the Edge Function secrets are the same app + environment as the
 *  browser's SDK client id (otherwise the buyer would approve an order the server cannot see). */
export function paypalReady(deps: { paypal: PaypalClient | null; brand?: Brand }): PaypalClient {
  const brand = deps.brand ?? BRAND;
  const pp = (brand as { payments?: { paypal?: { env?: string; client_id?: string } } }).payments?.paypal;
  if (!QV.paypalOn(brand) || !deps.paypal) throw new QuoteError("paypal_off", 503);
  if (deps.paypal.cfg.clientId !== pp?.client_id || deps.paypal.cfg.env !== pp?.env) {
    console.error("paypal_config_mismatch"); // brand.json payments.paypal vs PAYPAL_CLIENT_ID / PAYPAL_ENV: values never logged
    throw new QuoteError("paypal_off", 503);
  }
  return deps.paypal;
}

// SQL exception texts of the pay_* RPCs (and their MemoryPayStore mirror) -> HTTP codes
const DB_CODES = ["payment_not_found", "not_found", "bad_which", "quote_not_accepted", "not_paypal", "amount_unknown", "deposit_not_paid",
  "final_not_ready", "payment_not_open", "bad_order_id", "bad_capture_id", "payment_not_due", "other_capture", "order_mismatch",
  "amount_mismatch", "capture_mismatch", "payment_not_paid", "deposit_already_paid"];
function fromDb(e: unknown): never {
  if (e instanceof DbError) {
    const code = DB_CODES.find((k) => e.code.includes(k));
    if (!code) { console.error("pay_db_error", e.code.slice(0, 120)); throw new QuoteError("server_error", 500); }
    throw new QuoteError(code, code.endsWith("not_found") ? 404 : 409);
  }
  throw e;
}
function fromPaypal(e: unknown): never {
  if (e instanceof PaypalError) {
    console.error("paypal_api_error", e.message); // status, PayPal error name / issue, debug id: no secret, no payload
    throw new QuoteError(e.status === 0 ? "paypal_unreachable" : "paypal_error", 502);
  }
  throw e;
}
/** Runs a store call and maps its DB refusal codes, whether the store rejects (PostgREST) or throws. */
async function db<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { fromDb(e); }
}
function checkInput(token: string, which: string): PayKind {
  if (!QV.TOKEN_RX.test(token)) throw new QuoteError("not_found", 404);
  if (which !== "deposit" && which !== "final") throw new QuoteError("bad_which");
  return which;
}

function describe(t: PayTarget, brand: Brand, pb: Pricebook): string {
  const core = t.products.find((c) => pb.rules.core_codes.includes(c)) ?? t.products[0] ?? "";
  const product = pb.items.find((i) => i.code === core)?.name ?? core;
  return `${brand.name} – ${product} ${t.kind === "deposit" ? "deposit" : "final payment"}`;
}

// ------------------------------------------------------------------ create
export async function createPayment(input: { token: string; which: string }, deps: PayDeps): Promise<{ order_id: string }> {
  const pp = paypalReady(deps);
  const pb = deps.pb ?? PRICEBOOK, brand = deps.brand ?? BRAND;
  const which = checkInput(input.token, input.which);
  const t = await db(() => deps.store.payTarget(input.token, which));
  if (t.status === "paid") throw new QuoteError("already_paid", 409);
  if (t.status === "refunded") throw new QuoteError("payment_refunded", 409);
  if (t.provider_capture_id) throw new QuoteError("payment_pending", 409);
  if (!(Number.isInteger(t.amount_cents) && t.amount_cents > 0)) throw new QuoteError("nothing_due", 409);
  if (t.currency !== pb.currency) throw new QuoteError("currency_mismatch", 409);
  if (t.provider_order_id) {
    let o: PaypalOrder | null = null;
    try { o = await pp.getOrder(t.provider_order_id); } catch (e) { if (!(e instanceof PaypalError && e.status === 404)) fromPaypal(e); }
    if (o && o.status === "COMPLETED") {
      // captured at PayPal while our capture answer was lost: record it now (same checks), then the page shows "paid"
      await recordFromOrder(o, t, deps, "reconcile");
      throw new QuoteError("already_paid", 409);
    }
    const pu = (o?.purchase_units ?? [])[0];
    if (o && o.status === "CREATED" && o.id === t.provider_order_id && pu?.custom_id === t.payment_id &&
        toCents(pu.amount?.value) === t.amount_cents && pu.amount?.currency_code === t.currency) {
      return { order_id: o.id };
    }
    // APPROVED / VOIDED / expired / changed: a fresh order; only the newest one can be captured (pay_set_order)
  }
  const order = await pp.createOrder(orderBody({ payment_id: t.payment_id, reference_id: t.kind, amount_cents: t.amount_cents,
    currency: t.currency, description: describe(t, brand, pb), brand_name: brand.name }), crypto.randomUUID()).catch(fromPaypal);
  const orderId = order.id;
  if (typeof orderId !== "string" || !PP_ID.test(orderId)) throw new QuoteError("paypal_error", 502);
  await db(() => deps.store.paySetOrder(t.payment_id, orderId));
  return { order_id: orderId };
}

// ------------------------------------------------------------------ capture
async function recordFromOrder(order: PaypalOrder, t: PayTarget, deps: PayDeps, source: string): Promise<{ status: "paid" | "pending"; capture_id: string }> {
  const cap = captureOf(order, t.payment_id);
  if (!cap) throw new QuoteError("paypal_error", 502);
  // ours = our payment id as custom_id, or (if PayPal's answer leaves custom_id out) the order we created for this row
  const ours = cap.custom_id ? cap.custom_id === t.payment_id : !!cap.order_id && cap.order_id === t.provider_order_id;
  const bad = [
    !ours ? "custom_id" : "",
    cap.currency !== t.currency ? "currency" : "",
    cap.amount_cents !== t.amount_cents ? "amount" : "",
    cap.order_id && t.provider_order_id && cap.order_id !== t.provider_order_id ? "order" : "",
  ].filter(Boolean);
  if (bad.length) {
    if (cap.status === "COMPLETED" || cap.status === "PENDING") {
      // money moved, but not as our row says: never mark it paid; Meir decides (refund in PayPal)
      await deps.store.payAlert("mismatch", t.payment_id, cap.capture_id, { problems: bad.join(","), capture_status: cap.status,
        paypal_amount: money({ value: cap.amount_cents == null ? "" : String(cap.amount_cents / 100), currency_code: cap.currency }), source });
    }
    console.error("paypal_capture_mismatch", bad.join(","));
    throw new QuoteError("amount_mismatch", 409);
  }
  if (cap.status !== "COMPLETED" && cap.status !== "PENDING") throw new QuoteError("capture_declined", 402);
  const r = await db(() => deps.store.payRecordCapture({ payment_id: t.payment_id, order_id: cap.order_id || t.provider_order_id, capture_id: cap.capture_id,
    amount_cents: cap.amount_cents as number, currency: cap.currency, payer_email: cap.payer_email || null,
    completed: cap.status === "COMPLETED", source, funding: cap.funding }));
  if (r.result === "refunded") throw new QuoteError("payment_refunded", 409);
  return { status: r.result === "pending" ? "pending" : "paid", capture_id: cap.capture_id };
}

export async function capturePayment(input: { token: string; which: string; order_id: string }, deps: PayDeps): Promise<PayResult> {
  const pp = paypalReady(deps);
  const which = checkInput(input.token, input.which);
  if (!PP_ID.test(input.order_id)) throw new QuoteError("bad_order_id");
  const t = await db(() => deps.store.payTarget(input.token, which));
  const out = (status: "paid" | "pending", ref: string | null): PayResult => ({ status, which, amount_cents: t.amount_cents, reference: ref });
  if (t.status === "paid") {
    if (t.provider_order_id === input.order_id) return out("paid", t.provider_capture_id); // a retried capture call
    throw new QuoteError("already_paid", 409);
  }
  if (t.status === "refunded") throw new QuoteError("payment_refunded", 409);
  if (t.provider_order_id !== input.order_id) throw new QuoteError("order_mismatch", 409); // only the order we created last
  if (t.provider_capture_id) return out("pending", t.provider_capture_id);
  let order: PaypalOrder;
  try {
    order = await pp.captureOrder(input.order_id, `capture-${input.order_id}`);
  } catch (e) {
    if (!(e instanceof PaypalError)) throw e;
    if (e.issue === "ORDER_ALREADY_CAPTURED") order = await pp.getOrder(input.order_id).catch(fromPaypal);
    else if (e.issue === "INSTRUMENT_DECLINED") throw new QuoteError("instrument_declined", 422); // the SDK restarts: another card
    else if (e.issue === "ORDER_NOT_APPROVED" || e.issue === "PAYER_ACTION_REQUIRED") throw new QuoteError("order_not_approved", 409);
    else if (e.status === 404) throw new QuoteError("order_not_found", 409);
    else fromPaypal(e);
  }
  const r = await recordFromOrder(order, t, deps, "capture");
  return out(r.status, r.capture_id);
}

// ------------------------------------------------------------------ switch to Upwork (quote page link)
export async function useUpwork(token: string, deps: { store: PayStore; now?: () => Date }): Promise<PublicQuote> {
  if (!QV.TOKEN_RX.test(token)) throw new QuoteError("not_found", 404);
  await db(() => deps.store.payUseUpwork(token));
  return viewQuote(token, deps.store, deps.now ? deps.now() : new Date());
}

// ------------------------------------------------------------------ admin refund
export async function refundPayment(input: { payment_id: string; admin_uid: string }, deps: PayDeps): Promise<{ status: "refunded"; refund_status: string }> {
  const pp = deps.paypal;
  if (!pp) throw new QuoteError("paypal_off", 503);
  if (!UUID.test(input.payment_id)) throw new QuoteError("bad_payment_id");
  const pb = deps.pb ?? PRICEBOOK, brand = deps.brand ?? BRAND, now = deps.now ? deps.now() : new Date();
  const p = await db(() => deps.store.payLookup({ payment_id: input.payment_id }));
  if (!p) throw new QuoteError("payment_not_found", 404);
  const captureId = p.provider_capture_id;
  if (p.provider !== "paypal" || !captureId) throw new QuoteError("not_paypal", 409);
  if (p.status === "refunded") return { status: "refunded", refund_status: "ALREADY_REFUNDED" };
  if (p.status !== "paid") throw new QuoteError("not_paid", 409);
  if (p.kind !== "deposit") throw new QuoteError("not_deposit", 409);
  // price book: deposit refunded in full on request within window_days of the payment (the checklist part is Meir's call)
  const days = Number((pb.refund_rules.deposit as { window_days?: number }).window_days ?? 7);
  if (!p.paid_at || now.getTime() - Date.parse(p.paid_at) > days * 864e5) throw new QuoteError("refund_window_passed", 409);
  let status = "";
  try {
    const r = await pp.refundCapture(captureId, { note_to_payer: `Refund of your ${brand.name} deposit.`.slice(0, 255) }, `refund-${captureId}`);
    status = String(r.status ?? "");
  } catch (e) {
    if (e instanceof PaypalError && e.issue === "CAPTURE_FULLY_REFUNDED") status = "COMPLETED"; // refunded in PayPal already
    else if (e instanceof PaypalError) {
      console.error("paypal_refund_error", e.message);
      throw new QuoteError(e.issue === "REFUND_TIME_LIMIT_EXCEEDED" ? "refund_window_passed" : "paypal_refund_failed", e.status === 0 ? 502 : 409);
    } else throw e;
  }
  if (status !== "COMPLETED" && status !== "PENDING") throw new QuoteError("paypal_refund_failed", 502);
  await db(() => deps.store.payMarkRefunded({ payment_id: p.payment_id, capture_id: captureId, source: `admin:${input.admin_uid}`, note: status }));
  return { status: "refunded", refund_status: status };
}

// ------------------------------------------------------------------ webhook
interface WebhookEvent { id?: unknown; event_type?: unknown; resource_type?: unknown; resource?: Record<string, unknown> }
const money = (m: PaypalMoney | undefined) => {
  const v = str(m?.value), c = str(m?.currency_code);
  return /^\d{1,12}(\.\d{1,2})?$/.test(v) && /^[A-Z]{3}$/.test(c) ? `${v} ${c}` : "";
};
const clip = (v: unknown, n: number) => str(v).replace(/[^\w .:@+-]/g, "").slice(0, n);

export async function handleWebhook(raw: string, headers: Headers, deps: PayDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const pp = deps.paypal;
  if (!pp || !pp.cfg.webhookId) return { status: 503, body: { error: "paypal_off" } };
  if (raw.length > 65536) return { status: 413, body: { error: "payload_too_large" } };
  const h = webhookHeaders(headers);
  if (!h) return { status: 400, body: { error: "bad_signature" } };
  let ev: WebhookEvent;
  try { ev = JSON.parse(raw); } catch { return { status: 400, body: { error: "bad_json" } }; }
  if (!ev || typeof ev !== "object" || !/^[A-Za-z0-9-]{3,100}$/.test(str(ev.id)) || !/^[A-Z][A-Z0-9._]{2,79}$/.test(str(ev.event_type))) {
    return { status: 400, body: { error: "bad_event" } };
  }
  let verified = false;
  try { verified = await pp.verifyWebhook(h, raw); } catch (e) {
    console.error("paypal_verify_error", e instanceof Error ? e.message.slice(0, 160) : "unknown");
    return { status: 503, body: { error: "verify_unavailable" } }; // PayPal retries the delivery
  }
  if (!verified) { console.error("paypal_webhook_bad_signature"); return { status: 400, body: { error: "bad_signature" } }; }
  const eventId = str(ev.id), type = str(ev.event_type);
  if (await deps.store.paypalEventSeen(eventId)) return { status: 200, body: { ok: true, duplicate: true } };
  const out = await processEvent(type, str(ev.resource_type), ev.resource ?? {}, pp, deps);
  await deps.store.paypalEventLog({ event_id: eventId, type, resource_id: out.resource_id || null, payment_id: out.payment_id, result: out.result });
  return { status: 200, body: { ok: true, result: out.result } };
}

type Outcome = { result: string; payment_id: string | null; resource_id: string };

async function processEvent(type: string, resourceType: string, r: Record<string, unknown>, pp: PaypalClient, deps: PayDeps): Promise<Outcome> {
  const { store } = deps;
  const alert = (kind: AlertKind, paymentId: string | null, ref: string, payload: Record<string, unknown>) =>
    store.payAlert(kind, paymentId, ref.slice(0, 120), { ...payload, event_type: type });

  if (type === "PAYMENT.CAPTURE.COMPLETED") {
    const captureId = str(r.id), customId = str(r.custom_id);
    const orderId = str((r.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids?.order_id);
    let p = UUID.test(customId) ? await store.payLookup({ payment_id: customId }) : null;
    if (!p && PP_ID.test(captureId)) p = await store.payLookup({ capture_id: captureId });
    if (!p && PP_ID.test(orderId)) p = await store.payLookup({ order_id: orderId });
    const amount = r.amount as PaypalMoney | undefined;
    if (!p) {
      // not one of our checkout payments (e.g. a PayPal invoice paid by hand): Meir checks and marks it himself
      await alert("unknown_capture", null, captureId || "capture", { paypal_amount: money(amount), capture_id: clip(captureId, 64) });
      return { result: "unknown_capture", payment_id: null, resource_id: captureId };
    }
    const bad = [
      p.provider_order_id && PP_ID.test(orderId) && p.provider_order_id !== orderId ? "order" : "",
      toCents(amount?.value) !== p.amount_cents ? "amount" : "",
      str(amount?.currency_code) !== p.currency ? "currency" : "",
      p.status === "paid" && p.provider_capture_id !== captureId ? "double_payment" : "",
    ].filter(Boolean);
    if (bad.length || !PP_ID.test(captureId)) {
      await alert("mismatch", p.payment_id, captureId || p.payment_id, { problems: bad.join(",") || "capture_id", paypal_amount: money(amount) });
      return { result: "mismatch", payment_id: p.payment_id, resource_id: captureId };
    }
    if (p.status !== "due") return { result: p.status === "paid" ? "already_paid" : p.status, payment_id: p.payment_id, resource_id: captureId };
    const rec = await db(() => store.payRecordCapture({ payment_id: p.payment_id, order_id: PP_ID.test(orderId) ? orderId : null, capture_id: captureId,
      amount_cents: p.amount_cents, currency: p.currency, payer_email: null, completed: true, source: "webhook" }));
    return { result: rec.result, payment_id: p.payment_id, resource_id: captureId };
  }

  if (type === "PAYMENT.CAPTURE.DECLINED") {
    // a capture PayPal held as PENDING (e.g. a risk review) was declined: the client must be able to pay again
    const captureId = str(r.id);
    const p = PP_ID.test(captureId) ? await store.payLookup({ capture_id: captureId }) : null;
    if (!p) return { result: "ignored", payment_id: null, resource_id: captureId };
    if (p.status !== "due") {   // never touch a paid / refunded row; Meir looks at it
      await alert("mismatch", p.payment_id, captureId, { problems: "declined_after_" + p.status, paypal_amount: money(r.amount as PaypalMoney) });
      return { result: "mismatch", payment_id: p.payment_id, resource_id: captureId };
    }
    const c = await db(() => store.payClearCapture(p.payment_id, captureId, str(r.status) || "DECLINED"));
    if (c.result === "cleared") await alert("declined", p.payment_id, captureId, { paypal_amount: money(r.amount as PaypalMoney) });
    return { result: c.result, payment_id: p.payment_id, resource_id: captureId };
  }

  if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
    const captureId = captureIdFromLinks(r.links) ?? (resourceType === "capture" && PP_ID.test(str(r.id)) ? str(r.id) : "");
    let p = captureId ? await store.payLookup({ capture_id: captureId }) : null;
    if (!p && UUID.test(str(r.custom_id))) {
      const x = await store.payLookup({ payment_id: str(r.custom_id) });
      if (x && x.provider_capture_id && (!captureId || x.provider_capture_id === captureId)) p = x;
    }
    const cid = p?.provider_capture_id;
    if (!p || !cid) {
      await alert("unknown_capture", null, captureId || str(r.id) || "refund", { paypal_amount: money(r.amount as PaypalMoney), capture_id: clip(captureId, 64) });
      return { result: "unknown_capture", payment_id: null, resource_id: captureId };
    }
    const pid = p.payment_id, before = p.status;
    if (type === "PAYMENT.CAPTURE.REVERSED") {
      // PayPal took the money back (chargeback / dispute decision): no longer paid, and Meir must know
      if (before === "paid") await db(() => store.payMarkRefunded({ payment_id: pid, capture_id: cid, source: "paypal:reversed" }));
      await alert("reversed", pid, cid, { paypal_amount: money(r.amount as PaypalMoney), status_before: before });
      return { result: before === "paid" ? "refunded" : before, payment_id: pid, resource_id: cid };
    }
    // full or partial? PayPal's capture is the authority, not the event's amount
    const cap = await pp.getCapture(cid);
    if (cap.status === "REFUNDED") {
      if (before !== "paid") return { result: before === "refunded" ? "already_refunded" : before, payment_id: pid, resource_id: cid };
      const m = await db(() => store.payMarkRefunded({ payment_id: pid, capture_id: cid, source: "paypal:refunded", note: clip(r.id, 64) }));
      return { result: m.result, payment_id: pid, resource_id: cid };
    }
    if (cap.status === "PARTIALLY_REFUNDED") {
      await alert("partial_refund", pid, str(r.id) || cid, { refund_amount: money(r.amount as PaypalMoney) });
      return { result: "partial_refund", payment_id: pid, resource_id: cid };
    }
    return { result: "ignored", payment_id: pid, resource_id: cid };
  }

  if (type === "CUSTOMER.DISPUTE.CREATED") {
    const disputeId = clip(r.dispute_id, 64) || "dispute";
    const txs = Array.isArray(r.disputed_transactions) ? (r.disputed_transactions as Array<Record<string, unknown>>) : [];
    const captureId = txs.map((x) => str(x?.seller_transaction_id)).find((x) => PP_ID.test(x)) ?? "";
    const p = captureId ? await store.payLookup({ capture_id: captureId }) : null;
    await alert("dispute", p?.payment_id ?? null, disputeId, { reason: clip(r.reason, 80), status: clip(r.status, 40),
      stage: clip(r.dispute_life_cycle_stage, 40), paypal_amount: money(r.dispute_amount as PaypalMoney), capture_id: captureId,
      response_due: clip(r.seller_response_due_date, 40) });
    return { result: "alerted", payment_id: p?.payment_id ?? null, resource_id: disputeId };
  }
  return { result: "ignored", payment_id: null, resource_id: clip(r.id, 64) };
}
