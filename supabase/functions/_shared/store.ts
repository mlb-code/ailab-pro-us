// Data access for the quote functions, behind one interface:
//   RestStore   -> Supabase PostgREST with the service-role key (env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY,
//                  injected by the Edge runtime; never logged, never returned)
//   MemoryStore -> in-process tables for tests; mirrors the DB guard rules that matter here (quotes_guard).

export interface QuoteRow {
  id: string;
  questionnaire_id: string | null;
  user_id: string | null;
  status: string;
  items: Array<Record<string, unknown>>;
  setup_cents: number | null;
  monthly_cents: number | null;
  deposit_cents: number | null;
  discount_code: string | null;
  scope_md: string | null;
  assumptions: string[];
  not_included_extra: string[];
  timeline_text: string | null;
  valid_until: string | null;
  public_token: string;
  pay_method: string | null;
  pay_link: string | null;
  agreement_version: string | null;
  agreement_hash: string | null;
  accepted_name: string | null;
  accepted_ip: string | null;
  accepted_ua: string | null;
  accepted_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  anonymized: boolean;
  created_at: string;
  updated_at: string;
}
export interface QuestionnaireRow {
  id: string; user_id: string; offer: string | null; niche: string | null; status: string;
  answers: Record<string, unknown>; summary: unknown; submitted_at: string | null;
}
export interface ProfileRow { id: string; email: string; full_name: string | null; company: string | null; is_admin: boolean }
export interface EventRow { actor: string; entity: string; entity_id: string | null; user_id: string | null; type: string; payload: Record<string, unknown>; client_visible: boolean }
export interface ReviewRow { quote_id: string; manual_reasons: string[]; risk_flags: string[]; questions_for_client: string[]; hints: Record<string, unknown>; removed: string[]; model: string }
export interface DraftRow { quote_id: string; model: string; prompt_hash: string; raw_output: unknown; tokens: number; cost_usd: number }

export interface Store {
  getQuestionnaire(id: string): Promise<QuestionnaireRow | null>;
  setQuestionnaireStatus(id: string, status: string): Promise<void>;
  getProfile(id: string): Promise<ProfileRow | null>;
  quoteByQuestionnaire(qid: string): Promise<QuoteRow | null>;
  quoteById(id: string): Promise<QuoteRow | null>;
  quoteByToken(token: string): Promise<QuoteRow | null>;
  insertQuote(row: Partial<QuoteRow>): Promise<QuoteRow>;
  updateQuote(id: string, patch: Partial<QuoteRow>): Promise<QuoteRow>;
  quotesExpiringBefore(iso: string): Promise<QuoteRow[]>;
  /** quotes holding a discount slot (sent / viewed / accepted), excluding one quote id */
  countDiscountInUse(code: string, excludeId: string): Promise<number>;
  saveDraft(d: DraftRow): Promise<void>;
  saveReview(r: ReviewRow): Promise<void>;
  insertEvent(e: EventRow): Promise<void>;
  hasEvent(entityId: string, type: string, template?: string): Promise<boolean>;
  /** user id of a valid admin JWT, else null */
  adminFromJwt(jwt: string): Promise<string | null>;
  isServiceKey(token: string): boolean;
}

export class DbError extends Error {
  constructor(public code: string) { super(code); }
}

// ------------------------------------------------------------------ in-memory (tests)
const now = () => new Date().toISOString();
export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); // 64 hex chars, 256 bits
}

export class MemoryStore implements Store {
  questionnaires = new Map<string, QuestionnaireRow>();
  profiles = new Map<string, ProfileRow>();
  quotes = new Map<string, QuoteRow>();
  drafts = new Map<string, DraftRow>();
  reviews = new Map<string, ReviewRow>();
  events: EventRow[] = [];
  admins = new Map<string, string>(); // jwt -> user id
  serviceKey = "test-service-key";
  clock: () => Date = () => new Date();

  getQuestionnaire(id: string) { return Promise.resolve(structuredClone(this.questionnaires.get(id) ?? null)); }
  setQuestionnaireStatus(id: string, status: string) {
    const q = this.questionnaires.get(id); if (q) q.status = status; return Promise.resolve();
  }
  getProfile(id: string) { return Promise.resolve(structuredClone(this.profiles.get(id) ?? null)); }
  quoteByQuestionnaire(qid: string) {
    const all = [...this.quotes.values()].filter((q) => q.questionnaire_id === qid && q.status !== "void")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Promise.resolve(structuredClone(all[0] ?? null));
  }
  quoteById(id: string) { return Promise.resolve(structuredClone(this.quotes.get(id) ?? null)); }
  quoteByToken(token: string) {
    return Promise.resolve(structuredClone([...this.quotes.values()].find((q) => q.public_token === token) ?? null));
  }
  insertQuote(row: Partial<QuoteRow>) {
    if (row.status && !["draft", "needs_manual_price"].includes(row.status)) throw new DbError("quote_must_start_as_draft");
    const t = now();
    const q: QuoteRow = {
      id: crypto.randomUUID(), questionnaire_id: null, user_id: null, status: "draft", items: [], setup_cents: null,
      monthly_cents: null, deposit_cents: null, discount_code: null, scope_md: null, assumptions: [], not_included_extra: [],
      timeline_text: null, valid_until: null, public_token: randomToken(), pay_method: null, pay_link: null,
      agreement_version: null, agreement_hash: null, accepted_name: null, accepted_ip: null, accepted_ua: null,
      accepted_at: null, sent_at: null, viewed_at: null, anonymized: false, created_at: t, updated_at: t,
      ...structuredClone(row),
    };
    q.sent_at = q.viewed_at = q.accepted_at = null;
    this.quotes.set(q.id, q);
    return Promise.resolve(structuredClone(q));
  }
  /** Mirrors private.quotes_guard for the transitions the functions use. */
  updateQuote(id: string, patch: Partial<QuoteRow>) {
    const old = this.quotes.get(id);
    if (!old) throw new DbError("not_found");
    const n: QuoteRow = { ...old, ...structuredClone(patch), id: old.id, created_at: old.created_at,
      public_token: old.public_token, sent_at: old.sent_at, viewed_at: old.viewed_at, accepted_at: old.accepted_at };
    const t = this.clock();
    if (n.status !== old.status) {
      if (n.status === "approved" && (n.setup_cents == null || n.monthly_cents == null || n.deposit_cents == null)) throw new DbError("quote_amounts_missing");
      if (old.status === "needs_manual_price" && !["needs_manual_price", "approved", "void", "draft"].includes(n.status)) throw new DbError("manual_price_required");
      if (n.status === "sent") {
        if (!["approved", "sent"].includes(old.status)) throw new DbError("quote_not_approved");
        n.sent_at = t.toISOString();
        n.valid_until = n.valid_until ?? new Date(t.getTime() + 14 * 864e5).toISOString();
      }
      if (n.status === "viewed") {
        if (old.status !== "sent") throw new DbError("invalid_transition");
        n.viewed_at = old.viewed_at ?? t.toISOString();
      }
      if (n.status === "accepted") {
        if (!["sent", "viewed"].includes(old.status)) throw new DbError("quote_not_sent");
        if (old.valid_until && new Date(old.valid_until) < t) throw new DbError("quote_expired");
        if (!(n.accepted_name ?? "").trim() || !n.agreement_version) throw new DbError("acceptance_incomplete");
        n.accepted_at = t.toISOString();
      }
      if (old.status === "accepted" && n.status !== "void") throw new DbError("quote_already_accepted");
    }
    if (old.sent_at && (JSON.stringify(n.items) !== JSON.stringify(old.items) || n.setup_cents !== old.setup_cents ||
      n.monthly_cents !== old.monthly_cents || n.deposit_cents !== old.deposit_cents || n.discount_code !== old.discount_code)) {
      throw new DbError("quote_frozen_after_send");
    }
    n.updated_at = t.toISOString();
    this.quotes.set(id, n);
    return Promise.resolve(structuredClone(n));
  }
  quotesExpiringBefore(iso: string) {
    return Promise.resolve([...this.quotes.values()].filter((q) => ["sent", "viewed"].includes(q.status) && !q.anonymized &&
      q.valid_until && q.valid_until < iso).map((q) => structuredClone(q)));
  }
  countDiscountInUse(code: string, excludeId: string) {
    return Promise.resolve([...this.quotes.values()].filter((q) => q.id !== excludeId && q.discount_code === code &&
      ["sent", "viewed", "accepted"].includes(q.status)).length);
  }
  saveDraft(d: DraftRow) { this.drafts.set(d.quote_id, structuredClone(d)); return Promise.resolve(); }
  saveReview(r: ReviewRow) { this.reviews.set(r.quote_id, structuredClone(r)); return Promise.resolve(); }
  insertEvent(e: EventRow) { this.events.push(structuredClone(e)); return Promise.resolve(); }
  hasEvent(entityId: string, type: string, template?: string) {
    return Promise.resolve(this.events.some((e) => e.entity_id === entityId && e.type === type && (!template || e.payload.template === template)));
  }
  adminFromJwt(jwt: string) { return Promise.resolve(this.admins.get(jwt) ?? null); }
  isServiceKey(token: string) { return token === this.serviceKey; }
}

// ------------------------------------------------------------------ PostgREST (deployed functions)
export class RestStore implements Store {
  constructor(private url: string, private key: string) {}
  static fromEnv(): RestStore {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("supabase_env_missing");
    return new RestStore(url.replace(/\/$/, ""), key);
  }
  private async req(path: string, init: RequestInit = {}, prefer = "return=representation") {
    const r = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", Prefer: prefer, ...(init.headers ?? {}) },
    });
    const text = await r.text();
    if (!r.ok) {
      let code = `http_${r.status}`;
      try { const j = JSON.parse(text); code = j.message || j.code || code; } catch { /* keep http code */ }
      throw new DbError(code);
    }
    return text ? JSON.parse(text) : null;
  }
  private one = async <T>(path: string): Promise<T | null> => ((await this.req(path)) as T[])[0] ?? null;
  getQuestionnaire(id: string) { return this.one<QuestionnaireRow>(`questionnaires?id=eq.${encodeURIComponent(id)}&select=*`); }
  async setQuestionnaireStatus(id: string, status: string) {
    await this.req(`questionnaires?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) }, "return=minimal");
  }
  getProfile(id: string) { return this.one<ProfileRow>(`profiles?id=eq.${encodeURIComponent(id)}&select=id,email,full_name,company,is_admin`); }
  quoteByQuestionnaire(qid: string) {
    return this.one<QuoteRow>(`quotes?questionnaire_id=eq.${encodeURIComponent(qid)}&status=neq.void&order=created_at.desc&limit=1&select=*`);
  }
  quoteById(id: string) { return this.one<QuoteRow>(`quotes?id=eq.${encodeURIComponent(id)}&select=*`); }
  quoteByToken(token: string) { return this.one<QuoteRow>(`quotes?public_token=eq.${encodeURIComponent(token)}&select=*`); }
  async insertQuote(row: Partial<QuoteRow>) { return ((await this.req("quotes", { method: "POST", body: JSON.stringify(row) })) as QuoteRow[])[0]; }
  async updateQuote(id: string, patch: Partial<QuoteRow>) {
    return ((await this.req(`quotes?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })) as QuoteRow[])[0];
  }
  async quotesExpiringBefore(iso: string) {
    return (await this.req(`quotes?status=in.(sent,viewed)&anonymized=is.false&valid_until=lt.${encodeURIComponent(iso)}&select=*`)) as QuoteRow[];
  }
  async countDiscountInUse(code: string, excludeId: string) {
    return ((await this.req(`quotes?discount_code=eq.${encodeURIComponent(code)}&status=in.(sent,viewed,accepted)` +
      `&id=neq.${encodeURIComponent(excludeId)}&select=id`)) as unknown[]).length;
  }
  async saveDraft(d: DraftRow) {
    await this.req("rpc/save_quote_draft", { method: "POST", body: JSON.stringify({ p_quote_id: d.quote_id, p_model: d.model,
      p_prompt_hash: d.prompt_hash, p_raw_output: d.raw_output, p_tokens: d.tokens, p_cost_usd: d.cost_usd }) }, "return=minimal");
  }
  async saveReview(r: ReviewRow) {
    await this.req("quote_reviews?on_conflict=quote_id", { method: "POST", body: JSON.stringify(r) }, "resolution=merge-duplicates,return=minimal");
  }
  async insertEvent(e: EventRow) { await this.req("events", { method: "POST", body: JSON.stringify(e) }, "return=minimal"); }
  async hasEvent(entityId: string, type: string, template?: string) {
    const t = template ? `&payload->>template=eq.${encodeURIComponent(template)}` : "";
    return ((await this.req(`events?entity_id=eq.${encodeURIComponent(entityId)}&type=eq.${encodeURIComponent(type)}${t}&select=id&limit=1`)) as unknown[]).length > 0;
  }
  async adminFromJwt(jwt: string) {
    const r = await fetch(`${this.url}/auth/v1/user`, { headers: { apikey: this.key, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return null;
    const u = await r.json();
    const p = await this.getProfile(u.id);
    return p?.is_admin ? u.id : null;
  }
  isServiceKey(token: string) {
    // constant-time compare
    if (token.length !== this.key.length) return false;
    let d = 0;
    for (let i = 0; i < token.length; i++) d |= token.charCodeAt(i) ^ this.key.charCodeAt(i);
    return d === 0;
  }
}
