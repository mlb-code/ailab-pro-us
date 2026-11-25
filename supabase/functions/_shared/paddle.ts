// Paddle Billing (merchant of record) for the FirstRing monthly plans: webhook signature check, the event -> subscription
// mapping (the phase-1 contract public.billing_upsert_subscription), and a small REST client for the plan actions.
// Docs used (2026-11-25): developer.paddle.com webhooks/about/signature-verification, webhooks/about/respond-to-webhooks,
// api-reference/subscriptions/{update,cancel,activate,pause,resume}-subscription, build/trials/update-trials,
// api-reference/customer-portals/create-customer-portal-session, api-reference/adjustments/create-adjustment.
// Secrets only from the environment (PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_ENV); never logged, never returned.
import { BRAND } from "./config.ts";

export type PaddleEnv = "sandbox" | "production";
export const apiBase = (env: PaddleEnv) => env === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
/** Seller dashboard, for the admin links (sandbox and live are separate accounts). */
export const dashboardBase = (env: PaddleEnv) => env === "production" ? "https://vendors.paddle.com" : "https://sandbox-vendors.paddle.com";

export const PLAN_RANK: Record<string, number> = { FR_STARTER: 1, FR_PRO: 2, FR_BUSINESS: 3 };   // = private.plan_rank
export const rank = (code: string | null | undefined) => PLAN_RANK[code ?? ""] ?? 99;

// ------------------------------------------------------------------ config
interface PaddleBrand { enabled?: boolean; env?: string; client_token?: string; prices?: Record<string, { trial?: string; paid?: string }> }
export const paddleBrand = (brand: Record<string, unknown> = BRAND): PaddleBrand =>
  ((brand.payments as Record<string, unknown> | undefined)?.paddle ?? {}) as PaddleBrand;

export type PriceKind = "trial" | "paid";
/** price id -> plan code + kind, from brand.json payments.paddle.prices (only non-empty ids) */
export function priceMap(brand: Record<string, unknown> = BRAND): Map<string, { plan: string; kind: PriceKind }> {
  const m = new Map<string, { plan: string; kind: PriceKind }>();
  for (const [plan, p] of Object.entries(paddleBrand(brand).prices ?? {})) {
    for (const kind of ["trial", "paid"] as const) if (p?.[kind]) m.set(p[kind]!, { plan, kind });
  }
  return m;
}
export function priceId(plan: string, kind: PriceKind, brand: Record<string, unknown> = BRAND): string {
  const id = paddleBrand(brand).prices?.[plan]?.[kind] ?? "";
  if (!/^pri_[a-z0-9]{10,40}$/.test(id)) throw new PaddleError("price_not_configured", 503);
  return id;
}
/** the Paddle path is usable: brand switch on, a client token and all 6 price ids */
export function paddleReady(brand: Record<string, unknown> = BRAND): boolean {
  const p = paddleBrand(brand);
  return p.enabled === true && !!p.client_token && Object.keys(PLAN_RANK).every((c) => !!p.prices?.[c]?.trial && !!p.prices?.[c]?.paid);
}

export interface PaddleSecrets { env: PaddleEnv; apiKey: string; webhookSecret: string }
export function paddleSecretsFromEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): PaddleSecrets {
  const env = (get("PADDLE_ENV") ?? "sandbox").trim() === "production" ? "production" : "sandbox";
  return { env, apiKey: (get("PADDLE_API_KEY") ?? "").trim(), webhookSecret: (get("PADDLE_WEBHOOK_SECRET") ?? "").trim() };
}

export class PaddleError extends Error {
  constructor(public code: string, public status = 400, public paddleCode = "") { super(code); }
}

// ------------------------------------------------------------------ webhook signature (Paddle-Signature: ts=<unix>;h1=<hex>)
export function parseSignature(header: string | null): { ts: number; h1: string[] } | null {
  if (!header || header.length > 2000) return null;
  let ts = NaN; const h1: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("="); if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "ts" && /^\d{9,11}$/.test(v)) ts = Number(v);
    else if (k === "h1" && /^[0-9a-f]{64}$/i.test(v)) h1.push(v.toLowerCase());
  }
  return Number.isFinite(ts) && h1.length ? { ts, h1 } : null;
}
async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameHex(a: string, b: string): boolean {   // constant time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** HMAC-SHA256 of `${ts}:${rawBody}` with the destination's secret key; any h1 may match (secret rotation). The timestamp
 *  must be within toleranceSec of now (replay guard; Paddle's SDKs use 5 s, we allow clock skew + slow edge cold starts). */
export async function verifySignature(rawBody: string, header: string | null, secret: string,
  nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!secret) return { ok: false, reason: "no_secret" };
  const sig = parseSignature(header);
  if (!sig) return { ok: false, reason: header ? "bad_header" : "missing_header" };
  if (Math.abs(nowSec - sig.ts) > toleranceSec) return { ok: false, reason: "stale_timestamp" };
  const want = await hmacHex(secret, `${sig.ts}:${rawBody}`);
  return sig.h1.some((h) => sameHex(h, want)) ? { ok: true } : { ok: false, reason: "bad_signature" };
}
/** for tests and the local simulator only: the header Paddle would send */
export async function signForTest(rawBody: string, secret: string, ts = Math.floor(Date.now() / 1000)): Promise<string> {
  return `ts=${ts};h1=${await hmacHex(secret, `${ts}:${rawBody}`)}`;
}

// ------------------------------------------------------------------ event -> billing_upsert_subscription
export const SUBSCRIPTION_EVENTS = ["subscription.created", "subscription.updated", "subscription.activated", "subscription.trialing",
  "subscription.past_due", "subscription.paused", "subscription.resumed", "subscription.canceled"];
export const TRANSACTION_EVENTS = ["transaction.completed", "transaction.payment_failed"];
/** subscribe the notification destination to exactly these */
export const WEBHOOK_EVENTS = [...SUBSCRIPTION_EVENTS, ...TRANSACTION_EVENTS];
const STATUSES = ["trialing", "active", "past_due", "paused", "canceled"];

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? v as J : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export interface StoredSub {
  subscription_id: string; client_id: string; user_id: string | null; provider: string; provider_subscription_id: string;
  provider_customer_id: string | null; plan_code: string; scheduled_plan_code: string | null; status: string;
  cancel_at_period_end: boolean; trial_ends_at: string | null; current_period_start: string | null; current_period_end: string | null;
  last_event_at: string | null; first_paid_at?: string | null; first_paid_transaction_id?: string | null; money_back_used_at?: string | null;
}
export interface CheckoutRef { ref: string; user_id: string; plan_code: string; trial: boolean; business_phone: string; status: string; email?: string }
/** = the parameters of public.billing_upsert_subscription (null = keep the stored value, except plan / status / scheduled) */
export interface UpsertArgs {
  p_provider: "paddle"; p_provider_subscription_id: string; p_status: string; p_plan_code: string; p_user_id: string | null;
  p_provider_customer_id: string | null; p_trial_ends_at: string | null; p_current_period_start: string | null;
  p_current_period_end: string | null; p_cancel_at_period_end: boolean | null; p_card_on_file: boolean | null;
  p_scheduled_plan_code: string | null; p_canceled_at: string | null; p_event_at: string | null; p_business_phone: string | null;
}
export type MapResult = { ok: true; args: UpsertArgs; notes: string[] } | { ok: false; reason: string; notes: string[] };

/** the recurring item that carries the plan (first item whose price id is one of ours) */
export function planItem(data: J, prices: Map<string, { plan: string; kind: PriceKind }>) {
  const items = Array.isArray(data.items) ? data.items.map(obj) : [];
  for (const it of items) {
    const pid = str(obj(it.price).id);
    if (pid && prices.has(pid)) return { item: it, price_id: pid, ...prices.get(pid)! };
  }
  return null;
}

export function mapSubscriptionEvent(ev: J, prices: Map<string, { plan: string; kind: PriceKind }>, stored: StoredSub | null,
  checkout: CheckoutRef | null): MapResult {
  const notes: string[] = [];
  const d = obj(ev.data), sid = str(d.id), status = str(d.status);
  if (!sid || !/^sub_[A-Za-z0-9]{6,60}$/.test(sid)) return { ok: false, reason: "bad_subscription_id", notes };
  if (!status || !STATUSES.includes(status)) return { ok: false, reason: "bad_status", notes };
  const pi = planItem(d, prices);
  if (!pi) return { ok: false, reason: "unknown_price", notes };
  const user = checkout?.user_id ?? null;
  if (!stored && !user) return { ok: false, reason: "no_user", notes };
  if (checkout && stored && stored.user_id && checkout.user_id !== stored.user_id) notes.push("ref_user_mismatch");
  if (checkout && checkout.trial === false && status === "trialing") notes.push("trial_without_trial_checkout");
  const period = obj(d.current_billing_period), sched = obj(d.scheduled_change);
  const trialEnd = str(obj(pi.item.trial_dates).ends_at);
  const periodStart = status === "trialing" ? null : str(period.starts_at), periodEnd = status === "trialing" ? null : str(period.ends_at);

  // A downgrade waits for the next billing date: paddle-billing writes scheduled_plan_code first and then puts the lower
  // price on the Paddle subscription (full_next_billing_period). While the stored period is not over, keep the old plan.
  let plan = pi.plan, scheduled: string | null = null;
  if (stored?.scheduled_plan_code) {
    const samePeriod = !!stored.current_period_end && (!periodStart || Date.parse(periodStart) < Date.parse(stored.current_period_end));
    if (pi.plan === stored.scheduled_plan_code && rank(pi.plan) < rank(stored.plan_code) && status !== "trialing" && samePeriod) {
      plan = stored.plan_code; scheduled = pi.plan;
    } else if (pi.plan === stored.plan_code) {
      scheduled = stored.scheduled_plan_code;   // the change is not on Paddle yet (or this event predates it)
    }
  }
  const automatic = (str(d.collection_mode) ?? "automatic") === "automatic";
  return {
    ok: true, notes,
    args: {
      p_provider: "paddle", p_provider_subscription_id: sid, p_status: status, p_plan_code: plan,
      p_user_id: stored ? null : user, p_provider_customer_id: str(d.customer_id),
      p_trial_ends_at: trialEnd, p_current_period_start: periodStart, p_current_period_end: periodEnd,
      p_cancel_at_period_end: status === "canceled" ? false : str(sched.action) === "cancel",
      p_card_on_file: automatic && status !== "past_due" ? true : null,
      p_scheduled_plan_code: status === "canceled" ? null : scheduled,
      p_canceled_at: str(d.canceled_at), p_event_at: str(ev.occurred_at),
      p_business_phone: stored ? null : checkout?.business_phone ?? null,
    },
  };
}

/** transaction.completed / transaction.payment_failed -> billing_paddle_transaction (amounts: Paddle sends strings in cents) */
export function mapTransactionEvent(ev: J) {
  const d = obj(ev.data), totals = obj(obj(d.details).totals);
  const tid = str(d.id);
  if (!tid || !/^txn_[A-Za-z0-9]{6,60}$/.test(tid)) return null;
  const n = Number(totals.grand_total ?? totals.total ?? NaN);
  return {
    p_transaction_id: tid, p_subscription_id: str(d.subscription_id),
    p_status: ev.event_type === "transaction.payment_failed" ? "payment_failed" : (str(d.status) ?? "completed"),
    p_origin: str(d.origin), p_total_cents: Number.isFinite(n) && n >= 0 ? Math.round(n) : null,
    p_currency: str(totals.currency_code) ?? str(d.currency_code), p_billed_at: str(d.billed_at), p_occurred_at: str(ev.occurred_at),
  };
}
export const refOf = (ev: J): string | null => {
  const r = str(obj(obj(ev.data).custom_data).ref);
  return r && /^chk_[0-9a-f]{32}$/.test(r) ? r : null;
};

// ------------------------------------------------------------------ REST client (server API key; never in the browser)
export class PaddleClient {
  constructor(private s: PaddleSecrets, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}
  static fromEnv(fetchFn?: typeof fetch): PaddleClient | null {
    const s = paddleSecretsFromEnv();
    return s.apiKey ? new PaddleClient(s, fetchFn) : null;
  }
  get env() { return this.s.env; }
  async req(method: string, path: string, body?: unknown): Promise<J> {
    let r: Response;
    try {
      r = await this.fetchFn(apiBase(this.s.env) + path, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${this.s.apiKey}`, "Content-Type": "application/json", "Paddle-Version": "1" },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new PaddleError("paddle_unreachable", 502);
    }
    const text = await r.text();
    let j: J = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!r.ok) {
      const code = str(obj(j.error).code) ?? `http_${r.status}`;
      throw new PaddleError("paddle_error", r.status >= 500 ? 502 : 409, code);
    }
    return obj(j.data);
  }
  updateItems(sid: string, priceId: string, mode: string) {
    return this.req("PATCH", `/subscriptions/${encodeURIComponent(sid)}`,
      { items: [{ price_id: priceId, quantity: 1 }], proration_billing_mode: mode, on_payment_failure: "prevent_change" });
  }
  removeScheduledChange(sid: string) { return this.req("PATCH", `/subscriptions/${encodeURIComponent(sid)}`, { scheduled_change: null }); }
  cancel(sid: string, effectiveFrom: "immediately" | "next_billing_period") {
    return this.req("POST", `/subscriptions/${encodeURIComponent(sid)}/cancel`, { effective_from: effectiveFrom });
  }
  activate(sid: string) { return this.req("POST", `/subscriptions/${encodeURIComponent(sid)}/activate`, {}); }
  resume(sid: string) { return this.req("POST", `/subscriptions/${encodeURIComponent(sid)}/resume`, { effective_from: "immediately" }); }
  async portalLinks(customerId: string, sid: string) {
    const d = await this.req("POST", `/customers/${encodeURIComponent(customerId)}/portal-sessions`, { subscription_ids: [sid] });
    const urls = obj(d.urls), sub = (Array.isArray(urls.subscriptions) ? urls.subscriptions.map(obj) : []).find((x) => x.id === sid) ?? {};
    return { overview: str(obj(urls.general).overview), update_payment_method: str(sub.update_subscription_payment_method) };
  }
  refundFull(transactionId: string, reason: string) {
    return this.req("POST", "/adjustments", { action: "refund", type: "full", transaction_id: transactionId, reason });
  }
}
