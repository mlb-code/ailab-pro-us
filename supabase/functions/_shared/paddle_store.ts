// Data access for paddle-webhook and paddle-billing, behind one interface:
//   RestPaddleStore   -> the service-role RPCs of 20261125100000_us_subscriptions.sql (billing_upsert_subscription) and
//                        20261126100000_us_paddle.sql (billing_paddle_*). The rules live in SQL; this side only calls them.
//   MemoryPaddleStore -> in-process mirror for the Deno tests (supabase/tests/paddle_test.sql proves the SQL itself).
import { serverEnv } from "./keys.ts";
import type { CheckoutRef, StoredSub, UpsertArgs } from "./paddle.ts";
import { DbError, RestStore } from "./store.ts";

export interface TxArgs {
  p_transaction_id: string; p_subscription_id: string | null; p_status: string; p_origin: string | null; p_total_cents: number | null;
  p_currency: string | null; p_billed_at: string | null; p_occurred_at: string | null;
}
export interface PaddleStore {
  checkoutByRef(ref: string): Promise<CheckoutRef | null>;
  checkoutDone(ref: string, sid: string): Promise<void>;
  lookup(by: { subscription_id?: string; user_id?: string; client_id?: string }): Promise<StoredSub | null>;
  upsert(a: UpsertArgs): Promise<{ subscription_id: string; client_id: string; status: string; stale: boolean; changed: boolean }>;
  eventSeen(id: string): Promise<boolean>;
  eventLog(e: { event_id: string; type: string; occurred_at: string | null; entity_id: string | null; result: string }): Promise<void>;
  transaction(t: TxArgs): Promise<{ known_subscription: boolean; first_paid: boolean }>;
  /** transactions that arrived before the subscription row: link them, set first_paid_at (20261129100100) */
  linkTransactions(sid: string): Promise<{ linked: number; first_paid: boolean }>;
  alert(sid: string | null, kind: string, detail: string): Promise<void>;
  moneyBackTarget(clientId: string): Promise<{ provider_subscription_id: string; transaction_id: string; status: string }>;
  moneyBackDone(clientId: string, refundId: string, adminId: string): Promise<void>;
  userFromJwt(jwt: string): Promise<{ id: string; is_admin: boolean } | null>;
}

export class RestPaddleStore extends RestStore implements PaddleStore {
  static override fromEnv(): RestPaddleStore {
    const { url, key } = serverEnv();
    return new RestPaddleStore(url, key);
  }
  private rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.req(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) }) as Promise<T>;
  }
  checkoutByRef(ref: string) { return this.rpc<CheckoutRef | null>("billing_paddle_checkout", { p_ref: ref }); }
  async checkoutDone(ref: string, sid: string) { await this.rpc("billing_paddle_checkout_done", { p_ref: ref, p_subscription_id: sid }); }
  lookup(by: { subscription_id?: string; user_id?: string; client_id?: string }) {
    return this.rpc<StoredSub | null>("billing_paddle_lookup",
      { p_subscription_id: by.subscription_id ?? null, p_user: by.user_id ?? null, p_client: by.client_id ?? null });
  }
  upsert(a: UpsertArgs) { return this.rpc<{ subscription_id: string; client_id: string; status: string; stale: boolean; changed: boolean }>("billing_upsert_subscription", { ...a }); }
  eventSeen(id: string) { return this.rpc<boolean>("billing_paddle_event_seen", { p_event_id: id }); }
  async eventLog(e: { event_id: string; type: string; occurred_at: string | null; entity_id: string | null; result: string }) {
    await this.rpc("billing_paddle_event_log", { p_event_id: e.event_id, p_type: e.type, p_occurred_at: e.occurred_at, p_entity_id: e.entity_id, p_result: e.result });
  }
  transaction(t: TxArgs) { return this.rpc<{ known_subscription: boolean; first_paid: boolean }>("billing_paddle_transaction", { ...t }); }
  linkTransactions(sid: string) {
    return this.rpc<{ linked: number; first_paid: boolean }>("billing_paddle_link_transactions", { p_subscription_id: sid });
  }
  async alert(sid: string | null, kind: string, detail: string) {
    await this.rpc("billing_paddle_alert", { p_subscription_id: sid, p_kind: kind, p_detail: detail });
  }
  moneyBackTarget(clientId: string) {
    return this.rpc<{ provider_subscription_id: string; transaction_id: string; status: string }>("billing_paddle_money_back_target", { p_client: clientId });
  }
  async moneyBackDone(clientId: string, refundId: string, adminId: string) {
    await this.rpc("billing_paddle_money_back_done", { p_client: clientId, p_refund_id: refundId, p_admin: adminId });
  }
  async userFromJwt(jwt: string) {
    if (!jwt) return null;
    const r = await this.fetchFn(`${this.url}/auth/v1/user`, { headers: { apikey: this.key, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u?.id) return null;
    const p = await this.getProfile(u.id);
    return { id: u.id as string, is_admin: !!p?.is_admin };
  }
}

// ------------------------------------------------------------------ in-memory mirror (tests)
const iso = () => new Date().toISOString();
export class MemoryPaddleStore implements PaddleStore {
  checkouts = new Map<string, CheckoutRef>();
  subs = new Map<string, StoredSub & { card_on_file: boolean; canceled_at: string | null; money_back_used_at: string | null; refund_id?: string }>();
  events = new Map<string, { type: string; result: string }>();
  txs = new Map<string, Record<string, unknown>>();
  alerts: Array<{ sid: string | null; kind: string; detail: string }> = [];
  upserts: UpsertArgs[] = [];
  users = new Map<string, { id: string; is_admin: boolean }>();   // jwt -> user
  profiles = new Set<string>();
  failNext = "";   // a DbError code the next upsert throws (tests)

  checkoutByRef(ref: string) { return Promise.resolve(this.checkouts.get(ref) ?? null); }
  checkoutDone(ref: string, _sid: string) { const c = this.checkouts.get(ref); if (c) c.status = "completed"; return Promise.resolve(); }
  lookup(by: { subscription_id?: string; user_id?: string; client_id?: string }) {
    const all = [...this.subs.values()];
    const s = by.subscription_id ? this.subs.get(by.subscription_id) : all.filter((x) => (by.user_id && x.user_id === by.user_id) || (by.client_id && x.client_id === by.client_id)).pop();
    return Promise.resolve(s ? structuredClone(s) : null);
  }
  upsert(a: UpsertArgs) {   // same rules as private.upsert_subscription_core (the parts the webhook relies on)
    if (this.failNext) { const c = this.failNext; this.failNext = ""; return Promise.reject(new DbError(c)); }
    this.upserts.push(structuredClone(a));
    let s = this.subs.get(a.p_provider_subscription_id);
    if (s && s.last_event_at && a.p_event_at && a.p_event_at < s.last_event_at) {
      return Promise.resolve({ subscription_id: s.subscription_id, client_id: s.client_id, status: s.status, stale: true, changed: false });
    }
    if (!s) {
      if (!a.p_user_id) return Promise.reject(new DbError("user_required"));
      if (this.profiles.size && !this.profiles.has(a.p_user_id)) return Promise.reject(new DbError("user_not_found"));
      s = { subscription_id: crypto.randomUUID(), client_id: crypto.randomUUID(), user_id: a.p_user_id, provider: "paddle",
        provider_subscription_id: a.p_provider_subscription_id, provider_customer_id: null, plan_code: a.p_plan_code, scheduled_plan_code: null,
        status: a.p_status, cancel_at_period_end: false, trial_ends_at: null, current_period_start: null, current_period_end: null,
        last_event_at: null, card_on_file: false, canceled_at: null, money_back_used_at: null, first_paid_at: null, first_paid_transaction_id: null };
      this.subs.set(a.p_provider_subscription_id, s);
    }
    Object.assign(s, {
      plan_code: a.p_plan_code, scheduled_plan_code: a.p_scheduled_plan_code, status: a.p_status,
      provider_customer_id: a.p_provider_customer_id ?? s.provider_customer_id, card_on_file: a.p_card_on_file ?? s.card_on_file,
      trial_ends_at: a.p_trial_ends_at ?? s.trial_ends_at, current_period_start: a.p_current_period_start ?? s.current_period_start,
      current_period_end: a.p_current_period_end ?? s.current_period_end, cancel_at_period_end: a.p_cancel_at_period_end ?? s.cancel_at_period_end,
      canceled_at: a.p_status === "canceled" ? (a.p_canceled_at ?? s.canceled_at ?? iso()) : null,
      last_event_at: [a.p_event_at ?? iso(), s.last_event_at ?? ""].sort().pop(),
    });
    return Promise.resolve({ subscription_id: s.subscription_id, client_id: s.client_id, status: s.status, stale: false, changed: true });
  }
  eventSeen(id: string) { return Promise.resolve(this.events.has(id)); }
  eventLog(e: { event_id: string; type: string; occurred_at: string | null; entity_id: string | null; result: string }) {
    if (!this.events.has(e.event_id)) this.events.set(e.event_id, { type: e.type, result: e.result });
    return Promise.resolve();
  }
  transaction(t: TxArgs) {
    this.txs.set(t.p_transaction_id, { ...t });
    const s = t.p_subscription_id ? this.subs.get(t.p_subscription_id) : undefined;
    if (s) this.linked.add(t.p_transaction_id);
    let first = false;
    if (s && ["completed", "paid"].includes(t.p_status) && (t.p_total_cents ?? 0) > 0 && !s.first_paid_at) {
      s.first_paid_at = t.p_billed_at ?? t.p_occurred_at ?? iso(); s.first_paid_transaction_id = t.p_transaction_id; first = true;
    }
    return Promise.resolve({ known_subscription: !!s, first_paid: first });
  }
  linked = new Set<string>();   // transaction ids linked to their subscription (mirror of paddle_transactions.client_id)
  failLink = false;              // tests: the link RPC is missing / fails
  linkTransactions(sid: string) {   // same rules as public.billing_paddle_link_transactions
    if (this.failLink) return Promise.reject(new DbError("http_404"));
    const s = this.subs.get(sid);
    if (!s) return Promise.resolve({ linked: 0, first_paid: false });
    const mine = [...this.txs.values()].filter((t) => t.p_subscription_id === sid);
    let linked = 0;
    for (const t of mine) if (!this.linked.has(String(t.p_transaction_id))) { this.linked.add(String(t.p_transaction_id)); linked++; }
    let first = false;
    if (!s.first_paid_at) {
      const paid = mine.filter((t) => ["completed", "paid"].includes(String(t.p_status)) && Number(t.p_total_cents ?? 0) > 0)
        .sort((a, b) => String(a.p_billed_at ?? a.p_occurred_at ?? "").localeCompare(String(b.p_billed_at ?? b.p_occurred_at ?? "")));
      if (paid.length) {
        s.first_paid_at = String(paid[0].p_billed_at ?? paid[0].p_occurred_at ?? iso()); s.first_paid_transaction_id = String(paid[0].p_transaction_id);
        first = true;
      }
    }
    return Promise.resolve({ linked, first_paid: first });
  }
  alert(sid: string | null, kind: string, detail: string) { this.alerts.push({ sid, kind, detail }); return Promise.resolve(); }
  moneyBackTarget(clientId: string) {
    const s = [...this.subs.values()].find((x) => x.client_id === clientId);
    if (!s) return Promise.reject(new DbError("no_subscription"));
    if (s.money_back_used_at) return Promise.reject(new DbError("money_back_already_used"));
    if (!s.first_paid_at || !s.first_paid_transaction_id || Date.parse(s.first_paid_at) < Date.now() - 30 * 86400000) return Promise.reject(new DbError("money_back_window_closed"));
    return Promise.resolve({ provider_subscription_id: s.provider_subscription_id, transaction_id: s.first_paid_transaction_id, status: s.status });
  }
  moneyBackDone(clientId: string, refundId: string, _adminId: string) {
    const s = [...this.subs.values()].find((x) => x.client_id === clientId);
    if (s) { s.money_back_used_at = iso(); s.refund_id = refundId; }
    return Promise.resolve();
  }
  userFromJwt(jwt: string) { return Promise.resolve(this.users.get(jwt) ?? null); }
}
