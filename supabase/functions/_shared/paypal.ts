// PayPal REST client for the Edge Functions: OAuth client credentials (token cached per isolate), Orders v2
// (create / show / capture), Payments v2 (show capture / refund), Webhooks v1 (verify-webhook-signature).
// No SDK: one injectable fetch, so the tests drive a mocked PayPal and never reach the network.
// Secrets = Edge Function secrets only: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV (sandbox | live),
// PAYPAL_WEBHOOK_ID. They go only into the Authorization header of PayPal calls: never logged, never returned.
// Israeli merchant: standard JS SDK buttons + guest card checkout only (no advanced card fields, Apple Pay or vaulting).

export type PaypalEnv = "sandbox" | "live";
export const PAYPAL_API: Record<PaypalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};
export interface PaypalConfig { env: PaypalEnv; clientId: string; secret: string; webhookId: string }

/** null when PayPal is not configured on this project (no secrets yet): the pay functions answer paypal_off. */
export function paypalConfigFromEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): PaypalConfig | null {
  const env = (get("PAYPAL_ENV") ?? "").trim();
  const clientId = (get("PAYPAL_CLIENT_ID") ?? "").trim();
  const secret = (get("PAYPAL_CLIENT_SECRET") ?? "").trim();
  if ((env !== "sandbox" && env !== "live") || !clientId || !secret) return null;
  return { env, clientId, secret, webhookId: (get("PAYPAL_WEBHOOK_ID") ?? "").trim() };
}

/** A PayPal API refusal: HTTP status, PayPal error name, first detail issue (e.g. INSTRUMENT_DECLINED), debug id. */
export class PaypalError extends Error {
  constructor(public status: number, public ppName: string, public issue = "", public debugId = "") {
    super(`paypal ${status} ${ppName}${issue ? ":" + issue : ""}${debugId ? " debug_id=" + debugId : ""}`);
  }
}

// access tokens per (env, client id), shared by every request of this isolate; refreshed 5 minutes before expiry
const TOKENS = new Map<string, { token: string; exp: number }>();
export const clearPaypalTokenCache = () => TOKENS.clear();

export interface PaypalClientOptions { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

export class PaypalClient {
  readonly base: string;
  constructor(readonly cfg: PaypalConfig, private opts: PaypalClientOptions = {}) {
    this.base = PAYPAL_API[cfg.env];
  }
  static fromEnv(opts: PaypalClientOptions = {}): PaypalClient | null {
    const cfg = paypalConfigFromEnv();
    return cfg ? new PaypalClient(cfg, opts) : null;
  }
  private get key() { return `${this.cfg.env}|${this.cfg.clientId}`; }
  private fetchFn(url: string, init: RequestInit) { return (this.opts.fetch ?? fetch)(url, init); }
  private now() { return (this.opts.now ?? Date.now)(); }
  private signal() { return AbortSignal.timeout(this.opts.timeoutMs ?? 20_000); }

  async token(): Promise<string> {
    const hit = TOKENS.get(this.key);
    if (hit && hit.exp > this.now()) return hit.token;
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(`${this.cfg.clientId}:${this.cfg.secret}`), Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        signal: this.signal(),
      });
    } catch (e) {
      throw new PaypalError(0, "NETWORK", e instanceof Error ? e.name : "");
    }
    const j = await readJson(r);
    if (!r.ok || typeof j.access_token !== "string" || !j.access_token) {
      TOKENS.delete(this.key);
      throw new PaypalError(r.status, String(j.error ?? "AUTHENTICATION_FAILURE"));   // never the description: it may echo input
    }
    const ttlSeconds = Math.max(60, Number(j.expires_in ?? 0) - 300);
    TOKENS.set(this.key, { token: j.access_token, exp: this.now() + ttlSeconds * 1000 });
    return j.access_token;
  }

  /** One API call. A 401 (token revoked / expired early) drops the cached token and retries once. */
  async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<T> {
    const tok = await this.token();
    let r: Response;
    try {
      r = await this.fetchFn(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${tok}`, Accept: "application/json", "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: this.signal(),
      });
    } catch (e) {
      throw new PaypalError(0, "NETWORK", e instanceof Error ? e.name : "");
    }
    if (r.status === 401 && retry) {
      await r.body?.cancel();
      TOKENS.delete(this.key);
      return this.req<T>(method, path, body, headers, false);
    }
    const j = await readJson(r);
    if (!r.ok) {
      const d = Array.isArray(j.details) ? (j.details[0] as Record<string, unknown> | undefined) : undefined;
      throw new PaypalError(r.status, String(j.name ?? `HTTP_${r.status}`), String(d?.issue ?? ""), String(j.debug_id ?? ""));
    }
    return j as T;
  }

  createOrder(body: unknown, requestId: string) {
    return this.req<PaypalOrder>("POST", "/v2/checkout/orders", body, { "PayPal-Request-Id": requestId, Prefer: "return=representation" });
  }
  getOrder(id: string) { return this.req<PaypalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`); }
  /** PayPal-Request-Id = one per order: a retried capture returns the first result instead of a second charge. */
  captureOrder(id: string, requestId: string) {
    return this.req<PaypalOrder>("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, undefined,
      { "PayPal-Request-Id": requestId, Prefer: "return=representation" });
  }
  getCapture(id: string) { return this.req<PaypalCapture>("GET", `/v2/payments/captures/${encodeURIComponent(id)}`); }
  /** Full refund when body has no amount. PayPal-Request-Id = one per capture: a double click refunds once. */
  refundCapture(id: string, body: Record<string, unknown>, requestId: string) {
    return this.req<PaypalRefund>("POST", `/v2/payments/captures/${encodeURIComponent(id)}/refund`, body,
      { "PayPal-Request-Id": requestId, Prefer: "return=representation" });
  }

  /** PayPal's verify-webhook-signature API (webhook id = PAYPAL_WEBHOOK_ID). The event goes back byte for byte as
   *  received (PayPal checks a CRC of it), so it is spliced into the request text instead of re-serialised. */
  async verifyWebhook(h: WebhookHeaders, rawEvent: string): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const head = JSON.stringify({ auth_algo: h.auth_algo, cert_url: h.cert_url, transmission_id: h.transmission_id,
      transmission_sig: h.transmission_sig, transmission_time: h.transmission_time, webhook_id: this.cfg.webhookId });
    const body = head.slice(0, -1) + ',"webhook_event":' + rawEvent.trim() + "}";
    const j = await this.req<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", body);
    return j.verification_status === "SUCCESS";
  }
}

async function readJson(r: Response): Promise<Record<string, unknown>> {
  const text = await r.text().catch(() => "");
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface WebhookHeaders { auth_algo: string; cert_url: string; transmission_id: string; transmission_sig: string; transmission_time: string }
/** Signature headers of a webhook delivery, or null if one is missing. */
export function webhookHeaders(h: Headers): WebhookHeaders | null {
  const g = (k: string) => (h.get(k) ?? "").trim();
  const out = { auth_algo: g("paypal-auth-algo"), cert_url: g("paypal-cert-url"), transmission_id: g("paypal-transmission-id"),
    transmission_sig: g("paypal-transmission-sig"), transmission_time: g("paypal-transmission-time") };
  return Object.values(out).every((v) => v && v.length <= 600) ? out : null;
}

// ------------------------------------------------------------------ shapes we read (PayPal sends much more)
export interface PaypalMoney { currency_code?: string; value?: string }
export interface PaypalCapture {
  id?: string; status?: string; amount?: PaypalMoney; custom_id?: string; invoice_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } }; links?: Array<{ href?: string; rel?: string }>;
}
export interface PaypalOrder {
  id?: string; status?: string;
  purchase_units?: Array<{ reference_id?: string; custom_id?: string; invoice_id?: string; amount?: PaypalMoney; payments?: { captures?: PaypalCapture[] } }>;
  payer?: { email_address?: string };
  payment_source?: { card?: { brand?: string; last_digits?: string }; paypal?: { email_address?: string } };
}
export interface PaypalRefund { id?: string; status?: string; amount?: PaypalMoney }

// ------------------------------------------------------------------ money + order helpers (integers only)
/** 175000 -> "1750.00" (PayPal amounts are decimal strings). */
export function toValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("bad_amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
/** "1750.00" | "1750" | "1750.5" -> cents; anything else (negative, more decimals, text) -> null. */
export function toCents(value: unknown): number | null {
  const s = String(value ?? "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}

/** Order request: one purchase unit, amount from our payment row, our payment id as custom_id + invoice_id. */
export function orderBody(o: { payment_id: string; reference_id: string; amount_cents: number; currency: string; description: string; brand_name: string }) {
  return {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: o.reference_id,
      custom_id: o.payment_id,
      invoice_id: o.payment_id,
      description: o.description.slice(0, 127),
      amount: { currency_code: o.currency, value: toValue(o.amount_cents) },
    }],
    // services: no shipping address; "Pay Now" on PayPal's page; our brand instead of the account's legal name
    application_context: { brand_name: o.brand_name.slice(0, 127), shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
  };
}

const CARD_BRANDS: Record<string, string> = { VISA: "Visa", MASTERCARD: "Mastercard", AMEX: "American Express", DISCOVER: "Discover" };
export interface CaptureInfo {
  capture_id: string; status: string; amount_cents: number | null; currency: string; custom_id: string; order_id: string;
  payer_email: string; funding: string;
}
/** The capture of our purchase unit in an order (capture / show-order response). */
export function captureOf(order: PaypalOrder, paymentId?: string): CaptureInfo | null {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  const pu = units.find((u) => u?.custom_id === paymentId || (u?.payments?.captures ?? []).some((c) => c?.custom_id === paymentId)) ?? units[0];
  const cap = (pu?.payments?.captures ?? [])[0];
  if (!cap || typeof cap.id !== "string" || !cap.id) return null;
  const card = order.payment_source?.card;
  const brand = card?.brand ? (CARD_BRANDS[card.brand.toUpperCase()] ?? card.brand.charAt(0) + card.brand.slice(1).toLowerCase()) : "";
  const funding = card
    ? `${brand || "Card"}${card.last_digits && /^\d{2,4}$/.test(card.last_digits) ? ` ending in ${card.last_digits}` : ""}`
    : order.payment_source?.paypal ? "PayPal" : "";
  return {
    capture_id: cap.id,
    status: String(cap.status ?? ""),
    amount_cents: toCents(cap.amount?.value),
    currency: String(cap.amount?.currency_code ?? ""),
    custom_id: String(cap.custom_id ?? pu?.custom_id ?? ""),
    order_id: String(order.id ?? ""),
    payer_email: String(order.payer?.email_address ?? order.payment_source?.paypal?.email_address ?? ""),
    funding,
  };
}

/** Capture id of a refund / reversal resource: its "up" link (…/v2/payments/captures/<id>). */
export function captureIdFromLinks(links: unknown): string | null {
  for (const l of Array.isArray(links) ? links : []) {
    const m = /\/v2\/payments\/captures\/([A-Za-z0-9-]{8,64})(?:$|[/?#])/.exec(String((l as { href?: string })?.href ?? ""));
    if (m && (l as { rel?: string }).rel === "up") return m[1];
  }
  return null;
}
