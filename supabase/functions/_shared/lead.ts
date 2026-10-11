// Lead capture for landing pages (early-access / "send me the quote link" forms). Public endpoint (verify_jwt off).
// Contract with site/assets/landing.js (A4): POST JSON {email, company?, city?, niche?, source_page?, utm?, website?}
//   website = honeypot (hidden field; bots fill it) -> 200 {ok:true} and nothing is stored.
// Replies: 200 {ok:true} | 400 {error:"bad_email"|"bad_niche"|...} | 429 {error:"rate_limited"} | 413 | 405.
// Rate limit: ≤ 5 leads per IP hash per hour; the same e-mail within 10 minutes is accepted once (idempotent, no new row).
// Writes public.leads (email, niche, source_page, utm, ip_hash) + public.events {entity:'lead', type:'lead_received'}.
// The raw IP is never stored: ip_hash = SHA-256("lead|<UTC day>|<ip>"), so it only matches within a day.
import { sha256Hex } from "./quote_engine.ts";

export interface LeadRow { email: string; niche: string | null; source_page: string | null; utm: Record<string, string>; ip_hash: string }
export interface LeadStore {
  countByIpSince(ipHash: string, sinceIso: string): Promise<number>;
  existsEmailSince(email: string, sinceIso: string): Promise<boolean>;
  insert(row: LeadRow): Promise<{ id: string }>;
  event(leadId: string, payload: Record<string, unknown>): Promise<void>;
}

export const NICHES = ["home_services", "real_estate", "dental"];
export const IP_PER_HOUR = 5;
const EMAIL_RX = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}\.[A-Za-z]{2,24}$/;

export class LeadError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

export async function captureLead(body: Record<string, unknown>, ip: string, store: LeadStore, now = new Date()): Promise<{ ok: true; stored: boolean }> {
  if (clean(body.website, 200)) return { ok: true, stored: false }; // honeypot
  const email = clean(body.email, 320).toLowerCase();
  if (email.length > 320 || !EMAIL_RX.test(email)) throw new LeadError("bad_email");
  const niche = body.niche == null || body.niche === "" ? null : String(body.niche);
  if (niche !== null && !NICHES.includes(niche)) throw new LeadError("bad_niche");
  let source = clean(body.source_page, 300);
  if (source && !source.startsWith("/")) source = "";
  const utm: Record<string, string> = {};
  if (body.utm && typeof body.utm === "object" && !Array.isArray(body.utm)) {
    for (const [k, v] of Object.entries(body.utm as Record<string, unknown>).slice(0, 12)) {
      const key = clean(k, 40);
      if (/^[a-z0-9_]+$/i.test(key)) utm[key] = clean(v, 200);
    }
  }
  const day = now.toISOString().slice(0, 10);
  const ipHash = await sha256Hex(`lead|${day}|${ip || "unknown"}`);
  if (await store.countByIpSince(ipHash, new Date(now.getTime() - 3600e3).toISOString()) >= IP_PER_HOUR) throw new LeadError("rate_limited", 429);
  if (await store.existsEmailSince(email, new Date(now.getTime() - 600e3).toISOString())) return { ok: true, stored: false };
  const row = await store.insert({ email, niche, source_page: source || null, utm, ip_hash: ipHash });
  // company / city go to the event only (admin-visible, client_visible=false); leads has no such columns (A1 schema)
  await store.event(row.id, { niche, source_page: source || null, company: clean(body.company, 200) || null, city: clean(body.city, 120) || null });
  return { ok: true, stored: true };
}

export class MemoryLeadStore implements LeadStore {
  rows: Array<LeadRow & { id: string; created_at: string }> = [];
  events: Array<{ entity_id: string; type: string; payload: Record<string, unknown> }> = [];
  countByIpSince(h: string, since: string) { return Promise.resolve(this.rows.filter((r) => r.ip_hash === h && r.created_at >= since).length); }
  existsEmailSince(e: string, since: string) { return Promise.resolve(this.rows.some((r) => r.email === e && r.created_at >= since)); }
  insert(row: LeadRow) {
    const r = { ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    this.rows.push(r);
    return Promise.resolve({ id: r.id });
  }
  event(id: string, payload: Record<string, unknown>) { this.events.push({ entity_id: id, type: "lead_received", payload }); return Promise.resolve(); }
}

export class RestLeadStore implements LeadStore {
  constructor(private url: string, private key: string) {}
  static fromEnv() {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("supabase_env_missing");
    return new RestLeadStore(url.replace(/\/$/, ""), key);
  }
  private async req(path: string, init: RequestInit = {}, prefer = "return=representation") {
    const r = await fetch(`${this.url}/rest/v1/${path}`, { ...init, headers: { apikey: this.key, Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json", Prefer: prefer } });
    const t = await r.text();
    if (!r.ok) throw new LeadError("db_error", 500);
    return t ? JSON.parse(t) : null;
  }
  async countByIpSince(h: string, since: string) {
    return ((await this.req(`leads?ip_hash=eq.${encodeURIComponent(h)}&created_at=gte.${encodeURIComponent(since)}&select=id`)) as unknown[]).length;
  }
  async existsEmailSince(e: string, since: string) {
    return ((await this.req(`leads?email=eq.${encodeURIComponent(e)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`)) as unknown[]).length > 0;
  }
  async insert(row: LeadRow) { return ((await this.req("leads", { method: "POST", body: JSON.stringify(row) })) as Array<{ id: string }>)[0]; }
  async event(id: string, payload: Record<string, unknown>) {
    await this.req("events", { method: "POST", body: JSON.stringify({ actor: "system", entity: "lead", entity_id: id, user_id: null,
      type: "lead_received", payload, client_visible: false }) }, "return=minimal");
  }
}
