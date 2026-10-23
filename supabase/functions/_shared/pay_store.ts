// Data access for PayPal checkout (pay-create, pay-capture, paypal-webhook, pay-refund, pay-upwork), behind one interface:
//   RestPayStore   -> the service-role RPCs of supabase/migrations/20261021100100_us_paypal_checkout.sql (pay_target,
//                     pay_set_order, pay_record_capture, pay_mark_refunded, pay_lookup, pay_use_upwork, paypal_event_*,
//                     paypal_alert). The rules live in SQL; this side only calls them.
//   MemoryPayStore -> in-process mirror of the same rules for the Deno tests (supabase/tests/paypal_test.sql proves the SQL).
import { DbError, MemoryStore, type PaymentRow, RestStore, type Store } from "./store.ts";
import { serverEnv } from "./keys.ts";

export type PayKind = "deposit" | "final";
export interface PayTarget {
  payment_id: string; kind: PayKind; amount_cents: number; currency: string; status: "due" | "paid" | "refunded";
  provider: string | null; provider_order_id: string | null; provider_capture_id: string | null; paid_at: string | null;
  quote_id: string | null; client_id: string; client_status: string; user_id: string | null; pay_method: string | null;
  products: string[]; checklist_items?: number; checklist_left?: number;
}
export interface CaptureRecord {
  payment_id: string; order_id: string | null; capture_id: string; amount_cents: number; currency: string;
  payer_email: string | null; completed: boolean; source: string; funding?: string;
}
export type AlertKind = "dispute" | "reversed" | "partial_refund" | "mismatch" | "unknown_capture" | "declined";

export interface PayStore extends Store {
  /** the payment row to pay for an accepted PayPal quote (creates the client card on first use); throws DbError codes */
  payTarget(token: string, which: PayKind): Promise<PayTarget>;
  paySetOrder(paymentId: string, orderId: string): Promise<void>;
  payRecordCapture(c: CaptureRecord): Promise<{ result: "paid" | "already_paid" | "pending" | "refunded" }>;
  payMarkRefunded(i: { payment_id: string; capture_id: string; source: string; note?: string }): Promise<{ result: "refunded" | "already_refunded" }>;
  /** a pending capture PayPal declined: forget it so the client can pay again */
  payClearCapture(paymentId: string, captureId: string, status: string): Promise<{ result: "cleared" | "unchanged" }>;
  payLookup(by: { payment_id?: string; capture_id?: string; order_id?: string }): Promise<PayTarget | null>;
  payUseUpwork(token: string): Promise<{ result: "switched" | "already" }>;
  paypalEventSeen(eventId: string): Promise<boolean>;
  paypalEventLog(e: { event_id: string; type: string; resource_id: string | null; payment_id: string | null; result: string }): Promise<void>;
  payAlert(kind: AlertKind, paymentId: string | null, ref: string, payload: Record<string, unknown>): Promise<void>;
}

// ------------------------------------------------------------------ PostgREST RPCs (deployed functions)
export class RestPayStore extends RestStore implements PayStore {
  static override fromEnv(): RestPayStore {
    const { url, key } = serverEnv();
    return new RestPayStore(url, key);
  }
  private rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.req(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) }) as Promise<T>;
  }
  payTarget(token: string, which: PayKind) { return this.rpc<PayTarget>("pay_target", { p_token: token, p_which: which }); }
  async paySetOrder(paymentId: string, orderId: string) { await this.rpc("pay_set_order", { p_payment: paymentId, p_order_id: orderId }); }
  payRecordCapture(c: CaptureRecord) {
    return this.rpc<{ result: "paid" | "already_paid" | "pending" | "refunded" }>("pay_record_capture", {
      p_payment: c.payment_id, p_order_id: c.order_id, p_capture_id: c.capture_id, p_amount_cents: c.amount_cents,
      p_currency: c.currency, p_payer_email: c.payer_email, p_completed: c.completed, p_source: c.source, p_funding: c.funding ?? null,
    });
  }
  payMarkRefunded(i: { payment_id: string; capture_id: string; source: string; note?: string }) {
    return this.rpc<{ result: "refunded" | "already_refunded" }>("pay_mark_refunded",
      { p_payment: i.payment_id, p_capture_id: i.capture_id, p_source: i.source, p_note: i.note ?? null });
  }
  payClearCapture(paymentId: string, captureId: string, status: string) {
    return this.rpc<{ result: "cleared" | "unchanged" }>("pay_clear_capture", { p_payment: paymentId, p_capture_id: captureId, p_status: status });
  }
  payLookup(by: { payment_id?: string; capture_id?: string; order_id?: string }) {
    return this.rpc<PayTarget | null>("pay_lookup", { p_payment: by.payment_id ?? null, p_capture_id: by.capture_id ?? null, p_order_id: by.order_id ?? null });
  }
  payUseUpwork(token: string) { return this.rpc<{ result: "switched" | "already" }>("pay_use_upwork", { p_token: token }); }
  paypalEventSeen(eventId: string) { return this.rpc<boolean>("paypal_event_seen", { p_event_id: eventId }); }
  async paypalEventLog(e: { event_id: string; type: string; resource_id: string | null; payment_id: string | null; result: string }) {
    await this.rpc("paypal_event_log", { p_event_id: e.event_id, p_type: e.type, p_resource_id: e.resource_id, p_payment: e.payment_id, p_result: e.result });
  }
  async payAlert(kind: AlertKind, paymentId: string | null, ref: string, payload: Record<string, unknown>) {
    await this.rpc("paypal_alert", { p_kind: kind, p_payment: paymentId, p_ref: ref, p_payload: payload });
  }
}

// ------------------------------------------------------------------ in-memory mirror (tests)
export interface OutboxStub { template: string; key: string; entity_id: string | null; payload: Record<string, unknown> }

export class MemoryPayStore extends MemoryStore implements PayStore {
  outbox: OutboxStub[] = [];
  paypalEvents = new Map<string, { type: string; resource_id: string | null; payment_id: string | null; result: string }>();
  alerts: Array<{ kind: AlertKind; payment_id: string | null; ref: string; payload: Record<string, unknown> }> = [];
  /** mirrors private.enqueue_email: one row per key */
  private enqueue(template: string, key: string, entity_id: string | null, payload: Record<string, unknown> = {}) {
    if (this.outbox.some((o) => o.key === key)) return false;
    this.outbox.push({ template, key, entity_id, payload });
    return true;
  }
  private quoteOf(token: string) {
    const q = [...this.quotes.values()].find((x) => x.public_token === token);
    if (!/^[A-Za-z0-9]{32,128}$/.test(token) || !q || q.anonymized || !["sent", "viewed", "accepted", "expired"].includes(q.status)) {
      throw new DbError("not_found");
    }
    return q;
  }
  private rowsOf(clientId: string, kind: string) {
    const rank = (p: PaymentRow) => (p.status === "paid" ? 1 : 0);
    return [...this.payments.values()].filter((p) => p.client_id === clientId && p.kind === kind)
      .sort((a, b) => rank(b) - rank(a) || b.created_at.localeCompare(a.created_at));
  }
  private addPayment(clientId: string, kind: string, amount: number, method: string | null): PaymentRow {
    const p: PaymentRow = { id: crypto.randomUUID(), client_id: clientId, kind, amount_cents: amount, method, status: "due", reference: null,
      paid_at: null, provider: null, provider_order_id: null, provider_capture_id: null, payer_email: null,
      created_at: new Date(this.clock().getTime() + this.payments.size).toISOString() };
    this.payments.set(p.id, p);
    return p;
  }
  private targetOf(p: PaymentRow): PayTarget {
    const c = this.clients.get(p.client_id)!;
    const q = c.quote_id ? this.quotes.get(c.quote_id) : undefined;
    const ob = this.checklist.get(c.id);
    return {
      payment_id: p.id, kind: p.kind as PayKind, amount_cents: p.amount_cents, currency: "USD", status: p.status as PayTarget["status"],
      provider: p.provider, provider_order_id: p.provider_order_id, provider_capture_id: p.provider_capture_id, paid_at: p.paid_at,
      quote_id: q?.id ?? null, client_id: c.id, client_status: c.status, user_id: c.user_id, pay_method: q?.pay_method ?? null,
      products: [...c.products], checklist_items: ob?.total ?? 0, checklist_left: ob?.left ?? 0,
    };
  }
  /** test hook: checklist size per client (the SQL counts onboarding_items) */
  checklist = new Map<string, { total: number; left: number }>();

  async payTarget(token: string, which: PayKind) {
    const q = this.quoteOf(token);
    if (!["deposit", "final"].includes(which)) throw new DbError("bad_which");
    if (q.status !== "accepted") throw new DbError("quote_not_accepted");
    if (q.pay_method !== "paypal_checkout") throw new DbError("not_paypal");
    if (q.setup_cents == null || q.deposit_cents == null) throw new DbError("amount_unknown");
    let c = [...this.clients.values()].filter((x) => x.quote_id === q.id).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!c) {
      if (which === "final") throw new DbError("deposit_not_paid");
      const core = q.items.map((i) => String(i.code)).find((x) => ["RCP", "WEB", "BNDL"].includes(x)) ?? "RCP";
      c = { id: crypto.randomUUID(), user_id: q.user_id, quote_id: q.id, products: [core], status: "onboarding", monthly_cents: q.monthly_cents,
        business_name: (q.user_id && this.profiles.get(q.user_id)?.company) || null, anonymized_at: null, created_at: this.clock().toISOString() };
      this.clients.set(c.id, c);
      this.addPayment(c.id, "deposit", q.deposit_cents, q.pay_method);
      this.addPayment(c.id, "final", q.setup_cents - q.deposit_cents, q.pay_method);
    }
    if (c.anonymized_at || c.status === "cancelled") throw new DbError("not_found");
    const dep = this.rowsOf(c.id, "deposit")[0];
    let pay: PaymentRow | undefined;
    if (which === "deposit") pay = dep ?? this.addPayment(c.id, "deposit", q.deposit_cents, q.pay_method);
    else {
      if (!dep || dep.status !== "paid") throw new DbError("deposit_not_paid");
      if (!["testing", "live"].includes(c.status)) throw new DbError("final_not_ready");
      pay = this.rowsOf(c.id, "final")[0] ?? this.addPayment(c.id, "final", q.setup_cents - q.deposit_cents, q.pay_method);
    }
    return Promise.resolve(structuredClone(this.targetOf(pay)));
  }
  async paySetOrder(paymentId: string, orderId: string) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId)) throw new DbError("bad_order_id");
    const p = this.payments.get(paymentId);
    if (!p || p.status !== "due" || p.provider_capture_id) throw new DbError("payment_not_open");
    Object.assign(p, { provider: "paypal", provider_order_id: orderId });
    return Promise.resolve();
  }
  async payRecordCapture(c: CaptureRecord) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(c.capture_id)) throw new DbError("bad_capture_id");
    const p = this.payments.get(c.payment_id);
    if (!p) throw new DbError("payment_not_found");
    if (p.provider_capture_id === c.capture_id && (p.status !== "due" || !c.completed)) {
      return Promise.resolve({ result: p.status === "paid" ? "already_paid" as const : p.status === "refunded" ? "refunded" as const : "pending" as const });
    }
    if (p.status !== "due") throw new DbError("payment_not_due");
    if (p.provider_capture_id && p.provider_capture_id !== c.capture_id) throw new DbError("other_capture");
    if (c.order_id && p.provider_order_id && p.provider_order_id !== c.order_id) throw new DbError("order_mismatch");
    if (c.amount_cents !== p.amount_cents || c.currency.toUpperCase() !== "USD") throw new DbError("amount_mismatch");
    const email = (c.payer_email ?? "").trim().toLowerCase() || null;
    Object.assign(p, { provider: "paypal", method: "paypal_checkout", provider_order_id: c.order_id ?? p.provider_order_id,
      provider_capture_id: c.capture_id, payer_email: email ?? p.payer_email });
    const cl = this.clients.get(p.client_id)!;
    if (!c.completed) {
      this.events.push({ actor: "runtime", entity: "payment", entity_id: p.id, user_id: cl.user_id, type: "payment_pending", payload: { capture_id: c.capture_id }, client_visible: false });
      return Promise.resolve({ result: "pending" as const });
    }
    this.enqueue("payment_receipt", `payment_receipt:${p.id}`, p.id, { funding: c.funding ?? "" });
    this.enqueue("admin_payment_received", `admin_payment_received:${p.id}`, p.id, { source: c.source });
    Object.assign(p, { status: "paid", paid_at: this.clock().toISOString() });
    if (p.kind === "deposit") this.enqueue("deposit_received", `deposit_received:${p.client_id}`, p.client_id, { payment_id: p.id });
    this.events.push({ actor: "runtime", entity: "payment", entity_id: p.id, user_id: cl.user_id, type: "payment_captured",
      payload: { kind: p.kind, amount_cents: p.amount_cents, capture_id: c.capture_id, source: c.source }, client_visible: true });
    return Promise.resolve({ result: "paid" as const });
  }
  async payMarkRefunded(i: { payment_id: string; capture_id: string; source: string; note?: string }) {
    const p = this.payments.get(i.payment_id);
    if (!p) throw new DbError("payment_not_found");
    if (p.provider !== "paypal" || p.provider_capture_id !== i.capture_id) throw new DbError("capture_mismatch");
    if (p.status === "refunded") return Promise.resolve({ result: "already_refunded" as const });
    if (p.status !== "paid") throw new DbError("payment_not_paid");
    p.status = "refunded";
    this.events.push({ actor: "runtime", entity: "payment", entity_id: p.id, user_id: this.clients.get(p.client_id)?.user_id ?? null,
      type: "payment_refunded", payload: { capture_id: i.capture_id, source: i.source, note: i.note ?? "" }, client_visible: false });
    return Promise.resolve({ result: "refunded" as const });
  }
  async payClearCapture(paymentId: string, captureId: string, status: string) {
    const p = this.payments.get(paymentId);
    if (!p || p.status !== "due" || p.provider_capture_id !== captureId) return { result: "unchanged" as const };
    Object.assign(p, { provider_capture_id: null, provider_order_id: null });
    this.events.push({ actor: "runtime", entity: "payment", entity_id: p.id, user_id: this.clients.get(p.client_id)?.user_id ?? null,
      type: "payment_capture_failed", payload: { capture_id: captureId, status }, client_visible: false });
    return { result: "cleared" as const };
  }
  async payLookup(by: { payment_id?: string; capture_id?: string; order_id?: string }) {
    const all = [...this.payments.values()];
    const p = by.payment_id ? this.payments.get(by.payment_id)
      : by.capture_id ? all.find((x) => x.provider_capture_id === by.capture_id)
      : by.order_id ? all.filter((x) => x.provider_order_id === by.order_id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
      : undefined;
    return Promise.resolve(p ? structuredClone(this.targetOf(p)) : null);
  }
  async payUseUpwork(token: string) {
    const q = this.quoteOf(token);
    if (q.status !== "accepted") throw new DbError("quote_not_accepted");
    if (q.pay_method === "upwork") return Promise.resolve({ result: "already" as const });
    if (q.pay_method !== "paypal_checkout") throw new DbError("not_paypal");
    const ids = [...this.clients.values()].filter((c) => c.quote_id === q.id).map((c) => c.id);
    const rows = [...this.payments.values()].filter((p) => ids.includes(p.client_id));
    if (rows.some((p) => p.kind === "deposit" && (p.status !== "due" || p.provider_capture_id))) throw new DbError("deposit_already_paid");
    q.pay_method = "upwork";
    for (const p of rows) if (p.status === "due" && !p.provider_capture_id) Object.assign(p, { method: "upwork", provider: null, provider_order_id: null });
    this.events.push({ actor: "runtime", entity: "quote", entity_id: q.id, user_id: q.user_id, type: "pay_method_changed",
      payload: { from: "paypal_checkout", to: "upwork", by: "client" }, client_visible: true });
    this.enqueue("admin_upwork_requested", `admin_upwork_requested:${q.id}`, q.id);
    return Promise.resolve({ result: "switched" as const });
  }
  async paypalEventSeen(eventId: string) { return Promise.resolve(this.paypalEvents.has(eventId)); }
  async paypalEventLog(e: { event_id: string; type: string; resource_id: string | null; payment_id: string | null; result: string }) {
    if (!this.paypalEvents.has(e.event_id)) this.paypalEvents.set(e.event_id, { type: e.type, resource_id: e.resource_id, payment_id: e.payment_id, result: e.result });
    return Promise.resolve();
  }
  async payAlert(kind: AlertKind, paymentId: string | null, ref: string, payload: Record<string, unknown>) {
    const key = `admin_paypal_alert:${kind}:${(ref || paymentId || "none").slice(0, 120)}`;
    if (this.enqueue("admin_paypal_alert", key, paymentId, { ...payload, kind, ref })) this.alerts.push({ kind, payment_id: paymentId, ref, payload });
    return Promise.resolve();
  }
}
