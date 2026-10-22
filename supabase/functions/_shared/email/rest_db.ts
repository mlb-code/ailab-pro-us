// EmailDb over PostgREST RPCs (server key from _shared/keys.ts: new-style secret key first, legacy service_role JWT last;
// never logged). The outbox lives in schema private; only these service-role-only RPCs reach it.
import type { EmailDb, EmailSettings, OutboxJob, Outcome } from "./dispatch.ts";
import { serverEnv } from "../keys.ts";

export class RestEmailDb implements EmailDb {
  constructor(readonly url: string, readonly key: string, private fetchFn: typeof fetch = fetch) {}
  static fromEnv(): RestEmailDb {
    const { url, key } = serverEnv();
    return new RestEmailDb(url, key);
  }
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.fetchFn(`${this.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const text = await r.text();
    if (!r.ok) {
      let code = `http_${r.status}`;
      try { const j = JSON.parse(text); code = j.message || j.code || code; } catch { /* keep */ }
      throw new Error(`rpc ${name}: ${code}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  claim(kind: "email" | "task", limit: number) { return this.rpc<OutboxJob[]>("email_claim", { p_kind: kind, p_limit: limit }); }
  async complete(id: number, o: Outcome) {
    await this.rpc("email_complete", {
      p_id: id, p_result: o.result,
      p_provider_id: o.result === "sent" ? o.provider_id : null,
      p_error: o.result === "sent" ? null : (o.error ?? null),
      p_retry_at: o.result === "retry" || o.result === "defer" ? o.retry_at.toISOString() : null,
    });
  }
  settings() { return this.rpc<EmailSettings>("email_settings", {}); }
  recipient(email: string) { return this.rpc<{ token: string; unsubscribed: boolean }>("email_recipient", { p_email: email }); }
  unsubscribe(token: string) { return this.rpc<boolean>("email_unsubscribe", { p_token: token }); }
  purgeClaim(limit: number) { return this.rpc<Array<{ bucket_id: string; name: string }>>("storage_purge_claim", { p_limit: limit }); }
  purgeDone(bucket: string, names: string[]) { return this.rpc<number>("storage_purge_done", { p_bucket: bucket, p_names: names }); }
}

/** constant-time string compare (service-key check) */
export function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
