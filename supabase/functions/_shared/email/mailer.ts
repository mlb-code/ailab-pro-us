// Resend client + sender selection. No SDK: one POST https://api.resend.com/emails with an Idempotency-Key
// (= outbox idem_key, so a retried or re-claimed row is de-duplicated by Resend too). fetch is injectable: tests never
// touch the network.
import type { EmailBrand } from "./layout.ts";
import type { SenderKind } from "./templates.ts";

export const RESEND_URL = "https://api.resend.com/emails";

/** From address: brand.smtp_from (global override) -> brand.senders[kind] -> brand.senders.fallback. */
export function pickSender(brand: EmailBrand, kind: SenderKind): string {
  return (brand.smtp_from || "").trim() || (brand.senders?.[kind] || "").trim() || (brand.senders?.fallback || "").trim();
}

export interface OutMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
  tag?: string;
}
export type SendResult =
  | { ok: true; id: string }
  | { ok: false; retry: boolean; error: string; domain?: boolean };

export interface Mailer { send(mail: OutMail, idemKey: string): Promise<SendResult> }

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private fetchFn: typeof fetch = fetch, private timeoutMs = 15000) {}
  static fromEnv(fetchFn: typeof fetch = fetch): ResendMailer | null {
    const k = Deno.env.get("RESEND_API_KEY");
    return k ? new ResendMailer(k, fetchFn) : null;
  }
  async send(m: OutMail, idemKey: string): Promise<SendResult> {
    const body: Record<string, unknown> = { from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text };
    if (m.reply_to) body.reply_to = m.reply_to;
    if (m.headers && Object.keys(m.headers).length) body.headers = m.headers;
    if (m.tag) body.tags = [{ name: "template", value: m.tag.replace(/[^A-Za-z0-9_-]/g, "_") }];
    let r: Response;
    try {
      r = await this.fetchFn(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idemKey.slice(0, 256) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { ok: false, retry: true, error: `network: ${e instanceof Error ? e.name : "error"}` };
    }
    const text = await r.text().catch(() => "");
    let j: Record<string, unknown> = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    if (r.ok) return { ok: true, id: String(j.id ?? "") };
    const msg = String(j.message ?? j.name ?? "").slice(0, 160);
    // unverified sending domain -> caller retries once with senders.fallback
    const domain = (r.status === 403 || r.status === 422) && /domain/i.test(msg);
    // 409 = same idempotency key still in flight; 429 = rate limit; 5xx = provider trouble
    const retry = r.status === 409 || r.status === 429 || r.status >= 500;
    return { ok: false, retry, domain, error: `resend ${r.status}${msg ? ": " + msg : ""}` };
  }
}
