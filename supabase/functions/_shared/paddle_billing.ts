// The two Paddle flows, shared by the Edge Functions and the Deno tests:
//   handlePaddleWebhook  verify -> dedupe (event_id) -> map -> billing_upsert_subscription / billing_paddle_transaction -> log.
//                        2xx = done or deliberately ignored (Paddle stops retrying); 5xx = a temporary failure (Paddle retries).
//   billingAction        the portal's plan buttons for a Paddle subscription, done with the server API key; the result reaches
//                        our database through the webhook (one writer), except a downgrade, which is written FIRST as
//                        scheduled_plan_code so the webhook keeps the old plan until the next billing date.
import { DbError } from "./store.ts";
import {
  mapSubscriptionEvent, mapTransactionEvent, PaddleClient, PaddleError, type PriceKind, priceId, rank, refOf,
  SUBSCRIPTION_EVENTS, TRANSACTION_EVENTS, verifySignature,
} from "./paddle.ts";
import type { PaddleStore } from "./paddle_store.ts";

type J = Record<string, unknown>;
// database errors that a retry cannot fix: log + alert Meir + 200 (no 60 retries over two days)
const PERMANENT = ["user_required", "user_not_found", "bad_plan_code", "bad_status", "bad_subscription_id", "bad_provider"];

export interface HookDeps {
  store: PaddleStore; secret: string; prices: Map<string, { plan: string; kind: PriceKind }>;
  nowSec?: () => number; toleranceSec?: number;
}
export async function handlePaddleWebhook(raw: string, headers: Headers, deps: HookDeps): Promise<{ status: number; body: J }> {
  if (raw.length > 512 * 1024) return { status: 413, body: { error: "payload_too_large" } };
  const v = await verifySignature(raw, headers.get("paddle-signature"), deps.secret, deps.nowSec ? deps.nowSec() : undefined, deps.toleranceSec);
  if (!v.ok) return { status: v.reason === "no_secret" ? 503 : 401, body: { error: "invalid_signature", reason: v.reason } };
  let ev: J;
  try { ev = JSON.parse(raw); } catch { return { status: 400, body: { error: "bad_json" } }; }
  const id = typeof ev.event_id === "string" ? ev.event_id : "", type = typeof ev.event_type === "string" ? ev.event_type : "";
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(id) || !type) return { status: 400, body: { error: "bad_event" } };
  const s = deps.store;
  if (await s.eventSeen(id)) return { status: 200, body: { ok: true, result: "duplicate" } };
  const occurred = typeof ev.occurred_at === "string" ? ev.occurred_at : null;
  const entity = typeof (ev.data as J)?.id === "string" ? String((ev.data as J).id) : null;
  let result = "ignored";
  try {
    if (SUBSCRIPTION_EVENTS.includes(type)) result = await onSubscription(ev, deps);
    else if (TRANSACTION_EVENTS.includes(type)) result = await onTransaction(ev, deps);
  } catch (e) {
    if (e instanceof DbError && PERMANENT.includes(e.code)) {
      result = "error:" + e.code;
      await s.alert(entity, e.code, `${type} ${id}`);
    } else {
      console.error("paddle_webhook_failed", type, e instanceof Error ? e.message.slice(0, 120) : "unknown");   // ids only, no payload
      return { status: 500, body: { error: "retry" } };
    }
  }
  await s.eventLog({ event_id: id, type, occurred_at: occurred, entity_id: entity, result });
  console.log("paddle_event", id, type, result);   // ids + outcome only
  return { status: 200, body: { ok: true, result } };
}

async function onSubscription(ev: J, deps: HookDeps): Promise<string> {
  const s = deps.store, d = (ev.data ?? {}) as J, sid = typeof d.id === "string" ? d.id : "";
  const stored = sid ? await s.lookup({ subscription_id: sid }) : null;
  const ref = refOf(ev), checkout = ref ? await s.checkoutByRef(ref) : null;
  const m = mapSubscriptionEvent(ev, deps.prices, stored, checkout);
  if (!m.ok) {
    if (m.reason === "unknown_price" || m.reason === "no_user") await s.alert(sid || null, m.reason, String(ev.event_type));
    return "skipped:" + m.reason;
  }
  const r = await s.upsert(m.args);
  if (ref && ev.event_type === "subscription.created") await s.checkoutDone(ref, sid);
  for (const n of m.notes) await s.alert(sid, n, String(ev.event_type));
  // Paddle does not order webhooks: a transaction.completed processed before this subscription row existed was stored
  // unlinked ("recorded_unlinked"). Link it now, and start the money-back window from its first charge > 0 (a paid start).
  let linkedFirst = false;
  try {
    linkedFirst = (await s.linkTransactions(sid)).first_paid;
  } catch (e) {   // the subscription itself is applied; the next subscription event links again
    console.error("paddle_link_failed", sid, e instanceof Error ? e.message.slice(0, 120) : "unknown");
    await s.alert(sid, "link_transactions_failed", String(ev.event_type));
  }
  return (r.stale ? "stale" : "applied:" + m.args.p_status) + (linkedFirst ? "+first_paid" : "");
}

async function onTransaction(ev: J, deps: HookDeps): Promise<string> {
  const t = mapTransactionEvent(ev);
  if (!t) return "skipped:bad_transaction";
  const r = await deps.store.transaction(t);
  // A charge with no subscription id at all can never be linked later (a one-off or a malformed event): logged for Meir as a
  // paddle_alert event; a money-back for it is a manual refund in the Paddle dashboard. Unlinked WITH an id is normal: the
  // subscription event links it (onSubscription -> linkTransactions).
  if (!r.known_subscription && !t.p_subscription_id && t.p_status !== "payment_failed" && (t.p_total_cents ?? 0) > 0) {
    await deps.store.alert(null, "transaction_without_subscription", `${t.p_transaction_id} ${t.p_total_cents} ${t.p_currency ?? ""}`);
  }
  return t.p_status === "payment_failed" ? "payment_failed" : r.first_paid ? "first_paid" : r.known_subscription ? "recorded" : "recorded_unlinked";
}

// ------------------------------------------------------------------ portal actions
export type Action = "change_plan" | "start_now" | "cancel" | "resume" | "update_card" | "manage" | "money_back";
export interface ActionDeps { store: PaddleStore; paddle: PaddleClient | null; brand?: Record<string, unknown> }
export interface ActionInput { jwt: string; action: string; plan_code?: string; client_id?: string; confirm?: boolean }

export async function billingAction(i: ActionInput, deps: ActionDeps): Promise<J> {
  const s = deps.store;
  const me = await s.userFromJwt(i.jwt);
  if (!me) throw new PaddleError("not_signed_in", 401);
  if (!deps.paddle) throw new PaddleError("paddle_off", 503);
  const p = deps.paddle;
  if (i.action === "money_back") return moneyBack(i, me, deps);
  const sub = await s.lookup({ user_id: me.id });
  if (!sub) throw new PaddleError("no_subscription", 404);
  if (sub.provider !== "paddle") throw new PaddleError("not_paddle", 409);
  const sid = sub.provider_subscription_id;
  const price = (plan: string, kind: PriceKind) => priceId(plan, kind, deps.brand);
  // our own write (a downgrade waiting for the next billing date): keep last_event_at, so Paddle's webhook still applies
  const writeScheduled = (scheduled: string | null) => s.upsert({
    p_provider: "paddle", p_provider_subscription_id: sid, p_status: sub.status, p_plan_code: sub.plan_code, p_user_id: null,
    p_provider_customer_id: null, p_trial_ends_at: null, p_current_period_start: null, p_current_period_end: null,
    p_cancel_at_period_end: null, p_card_on_file: null, p_scheduled_plan_code: scheduled, p_canceled_at: null,
    p_event_at: sub.last_event_at, p_business_phone: null,
  });

  switch (i.action) {
    case "change_plan": {
      const plan = String(i.plan_code ?? "");
      if (rank(plan) >= 99) throw new PaddleError("bad_plan_code");
      if (sub.status === "past_due") throw new PaddleError("past_due_update_card", 409);
      if (!["trialing", "active"].includes(sub.status)) throw new PaddleError("subscription_not_active", 409);
      if (plan === sub.plan_code && !sub.scheduled_plan_code) throw new PaddleError("same_plan", 409);
      if (sub.status === "trialing") {   // in a trial Paddle accepts only do_not_bill; the new plan is billed when the trial ends
        await p.updateItems(sid, price(plan, "trial"), "do_not_bill");
        return { ok: true, pending: true, applies: "now" };
      }
      if (plan === sub.plan_code) {   // "keep my plan": undo a scheduled downgrade
        await writeScheduled(null);
        await p.updateItems(sid, price(plan, "paid"), "do_not_bill");
        return { ok: true, pending: true, applies: "now" };
      }
      if (rank(plan) > rank(sub.plan_code)) {   // upgrade: now, the price difference for the rest of the month (prorated)
        await p.updateItems(sid, price(plan, "paid"), "prorated_immediately");
        return { ok: true, pending: true, applies: "now" };
      }
      await writeScheduled(plan);   // downgrade: from the next billing date, nothing charged now
      try { await p.updateItems(sid, price(plan, "paid"), "full_next_billing_period"); }
      catch (e) { await writeScheduled(sub.scheduled_plan_code); throw e; }
      return { ok: true, pending: true, applies: "next_period", scheduled: true };
    }
    case "start_now":
      if (sub.status !== "trialing") throw new PaddleError("not_trialing", 409);
      await p.activate(sid);   // Paddle charges now and restarts the billing dates from today
      return { ok: true, pending: true };
    case "cancel":
      if (sub.status === "trialing") { await p.cancel(sid, "immediately"); return { ok: true, pending: true, ends: "now" }; }
      if (!["active", "past_due", "paused"].includes(sub.status)) throw new PaddleError("subscription_not_active", 409);
      if (sub.cancel_at_period_end) return { ok: true, pending: false, already: true };
      await p.cancel(sid, sub.status === "active" ? "next_billing_period" : "immediately");
      return { ok: true, pending: true, ends: sub.status === "active" ? "period_end" : "now" };
    case "resume":
      if (sub.status === "active" && sub.cancel_at_period_end) { await p.removeScheduledChange(sid); return { ok: true, pending: true }; }
      if (sub.status === "paused") { await p.resume(sid); return { ok: true, pending: true }; }
      if (sub.status === "canceled") return { ok: false, resubscribe: true };   // Paddle can't reinstate: a new checkout
      if (sub.status === "past_due") return { ok: true, ...(await links(p, sub.provider_customer_id, sid)), update_card: true };
      throw new PaddleError("nothing_to_resume", 409);
    case "update_card":
    case "manage": {
      const l = await links(p, sub.provider_customer_id, sid);
      return { ok: true, url: i.action === "update_card" ? (l.update_payment_method ?? l.overview) : l.overview };
    }
    default:
      throw new PaddleError("bad_action");
  }
}

async function links(p: PaddleClient, customerId: string | null, sid: string) {
  if (!customerId) throw new PaddleError("no_customer", 409);
  return await p.portalLinks(customerId, sid);   // temporary links: returned to the browser, never stored
}

// admin: the 30-day money-back on the first paid month = a full refund of that transaction + the plan ends now
async function moneyBack(i: ActionInput, me: { id: string; is_admin: boolean }, deps: ActionDeps): Promise<J> {
  if (!me.is_admin) throw new PaddleError("forbidden", 403);
  if (i.confirm !== true) throw new PaddleError("confirm_required");
  const cid = String(i.client_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(cid)) throw new PaddleError("bad_client");
  const t = await deps.store.moneyBackTarget(cid);   // raises money_back_window_closed / money_back_already_used / not_paddle
  const adj = await deps.paddle!.refundFull(t.transaction_id, "30-day money-back guarantee: first paid month");
  const refundId = typeof adj.id === "string" ? adj.id : "refund";
  await deps.store.moneyBackDone(cid, refundId, me.id);
  let ended = true;
  if (t.status !== "canceled") {
    try { await deps.paddle!.cancel(t.provider_subscription_id, "immediately"); }
    catch { ended = false; await deps.store.alert(t.provider_subscription_id, "money_back_cancel_failed", "refund " + refundId + " done; cancel in Paddle"); }
  }
  return { ok: true, refund_id: refundId, refund_status: typeof adj.status === "string" ? adj.status : "", plan_ended: ended };
}
