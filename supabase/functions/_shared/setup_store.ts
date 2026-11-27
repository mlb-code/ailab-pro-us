// Data access for the setup assistant, behind two interfaces:
//   SetupStore -> the conversation store: RestSetupStore calls the service-role RPCs of 20261201100000_us_setup_agent.sql
//                 (the rules live in SQL: ownership, lock, idempotency, limits, budget); MemorySetupStore mirrors them for the
//                 Deno tests (supabase/tests/setup_agent_test.sql proves the SQL itself).
//   UserDb     -> everything about settings, AS THE CUSTOMER (their JWT, so RLS and the RPCs' own checks apply): the checklist
//                 items, the tenant config, setup_preview_step and update_onboarding_item. The service key never touches settings.
// deno-lint-ignore-file no-explicit-any
import { serverEnv } from "./keys.ts";
import type { HistoryRow } from "./setup_prompt.ts";
import type { Item } from "./setup_rules.ts";
import { DbError, RestStore } from "./store.ts";

export interface StoredMessage { id: string | number; seq: number; role: "user" | "assistant" | "note"; text: string; blocks: any[]; created_at: string; input?: boolean; client_turn_id?: string | null }
export interface ProposalSummary { id: string; topic: string; item_key: string; status: string; shown_seq: number; error?: string | null }
export interface PendingProposal { id: string; topic: string; item_key: string; data: Record<string, any>; base_hash: string; shown_seq: number }
export interface OpenResult {
  conversation: { id: string; status: "active" | "complete"; topic: string | null; state: Record<string, any>; turns: number };
  client: { id: string; status: string; business_name: string | null };
  golive: { client_status: string; has_number: boolean; sim_status: string | null; number_status: string | null };
  messages: StoredMessage[];
  proposals: ProposalSummary[];
  switches: { enabled: boolean; paused_until: string | null; budget_usd: number; spent_today_usd: number };
  limits: { messages_left_today: number };
}
export interface BeginArgs {
  conversation_id: string; user_id: string; client_turn_id: string | null; role: "user" | "note" | "none"; text: string; blocks: any[]; needs_model: boolean;
}
export type BeginResult =
  | { ok: true; seq: number | null; retry: boolean; lock: string; input_id: string | number | null; input_at: string | null; input_text: string | null;
      state: Record<string, any>; topic: string | null; status: string; turns: number;
      message_count: number; pending: PendingProposal[]; history: HistoryRow[]; limits: { messages_left_today: number } }
  | { replay: true; seq: number; messages: StoredMessage[] }
  | { error: "disabled" | "turn_in_progress" | "paused" | "budget" | "rate_limited" | "limit"; retry_after_s?: number };
export interface TurnOut {
  messages: Array<{ role: "assistant" | "note"; text: string; blocks: any[]; model_json?: any }>;
  proposals: Array<{ id: string; topic: string; item_key: string; data: Record<string, any>; base_hash: string; msg_index: number }>;
  state?: Record<string, any>; topic?: string | null; status?: "active" | "complete"; input_seq?: number | null;
  usage?: { model: string | null; tokens_in: number; tokens_out: number; cost_usd: number };
}
export interface SetupStore {
  open(userId: string): Promise<OpenResult>;
  begin(a: BeginArgs): Promise<BeginResult>;
  finish(conversationId: string, lock: string, turn: TurnOut): Promise<{ messages: Array<{ id: string | number; seq: number; created_at: string }> }>;
  decide(conversationId: string, lock: string, proposalId: string, status: "confirmed" | "failed" | "superseded", error: string | null, seq: number | null): Promise<void>;
  alert(userId: string, kind: "budget" | "auth" | "down", detail: string): Promise<void>;
}

// ------------------------------------------------------------------ PostgREST (deployed function)
export class RestSetupStore extends RestStore implements SetupStore {
  static override fromEnv(): RestSetupStore {
    const { url, key } = serverEnv();
    return new RestSetupStore(url, key);
  }
  private rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.req(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) }) as Promise<T>;
  }
  open(userId: string) { return this.rpc<OpenResult>("setup_agent_open", { p_user: userId }); }
  begin(a: BeginArgs) {
    return this.rpc<BeginResult>("setup_agent_begin_turn", { p_conversation: a.conversation_id, p_user: a.user_id, p_client_turn_id: a.client_turn_id,
      p_role: a.role, p_text: a.text, p_blocks: a.blocks, p_needs_model: a.needs_model });
  }
  finish(conversationId: string, lock: string, turn: TurnOut) {
    return this.rpc<{ messages: Array<{ id: number; seq: number; created_at: string }> }>("setup_agent_finish_turn", { p_conversation: conversationId, p_lock: lock, p_turn: turn });
  }
  async decide(conversationId: string, lock: string, proposalId: string, status: string, error: string | null, seq: number | null) {
    await this.rpc("setup_agent_decide", { p_conversation: conversationId, p_lock: lock, p_proposal: proposalId, p_status: status, p_error: error, p_seq: seq });
  }
  async alert(userId: string, kind: string, detail: string) { await this.rpc("setup_agent_alert", { p_user: userId, p_kind: kind, p_detail: detail }); }
}

// ------------------------------------------------------------------ the customer's own access
export interface UserRows {
  items: Item[];
  tenant: { id: string; config: Record<string, any>; twilio_number: string | null } | null;
  profile: { full_name: string | null; company: string | null; email: string | null; contact_email: string | null } | null;
}
export interface UserDb {
  /** who the JWT belongs to (Supabase Auth); null = not signed in */
  user(): Promise<{ id: string } | null>;
  rows(userId: string, clientId: string): Promise<UserRows>;
  /** public.setup_preview_step: the config the save would produce, or throws DbError(invalid_setting:<path> | ...) */
  preview(itemId: string, data: Record<string, any>, status: string | null): Promise<Record<string, any>>;
  /** public.update_onboarding_item (merges data; onboarding_apply validates and updates the live config) */
  update(itemId: string, status: string | null, data: Record<string, any>): Promise<Item>;
}

export class RestUserDb implements UserDb {
  constructor(private url: string, private anonKey: string, private jwt: string, private f: typeof fetch = (...a) => fetch(...a)) {}
  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.anonKey, Authorization: `Bearer ${this.jwt}`, Accept: "application/json", ...extra };
  }
  private async req(path: string, init: RequestInit = {}) {
    const r = await this.f(`${this.url}/rest/v1/${path}`, { ...init, headers: this.headers(init.body ? { "Content-Type": "application/json" } : {}) });
    const text = await r.text();
    if (!r.ok) {
      let code = `http_${r.status}`;
      try { const j = JSON.parse(text); code = j.message || j.code || code; } catch { /* keep the http code */ }
      throw new DbError(code);
    }
    return text ? JSON.parse(text) : null;
  }
  async user() {
    const r = await this.f(`${this.url}/auth/v1/user`, { headers: this.headers() });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    return u && typeof u.id === "string" ? { id: u.id } : null;
  }
  async rows(userId: string, clientId: string): Promise<UserRows> {
    const c = encodeURIComponent(clientId), u = encodeURIComponent(userId);
    const [items, tenants, profiles] = await Promise.all([
      this.req(`onboarding_items?select=id,key,title,status,data,sort&client_id=eq.${c}&order=sort.asc`),
      this.req(`tenants?select=id,config,twilio_number&client_id=eq.${c}&order=created_at.asc&limit=1`),
      this.req(`profiles?select=full_name,company,email,contact_email&id=eq.${u}`),
    ]);
    return { items: items ?? [], tenant: (tenants ?? [])[0] ?? null, profile: (profiles ?? [])[0] ?? null };
  }
  preview(itemId: string, data: Record<string, any>, status: string | null) {
    return this.req("rpc/setup_preview_step", { method: "POST", body: JSON.stringify({ p_item: itemId, p_data: data, p_status: status }) });
  }
  update(itemId: string, status: string | null, data: Record<string, any>) {
    return this.req("rpc/update_onboarding_item", { method: "POST", body: JSON.stringify({ p_id: itemId, p_status: status, p_data: data }) });
  }
}

// ------------------------------------------------------------------ in-memory mirrors (tests)
type Patch = (key: string, data: any, cfg: any) => any;
/** One fake Supabase project: users by JWT, clients, checklist items, tenants, connected calendars. update/preview follow
 *  update_onboarding_item + onboarding_apply (patch = onboarding-config.js, the parity-tested copy of onboarding_patch). */
export class MemoryWorld {
  users = new Map<string, string>();      // jwt -> user id
  clients = new Map<string, { id: string; user_id: string; billing_mode: string; status: string; business_name: string | null }>();
  items = new Map<string, Item & { client_id: string }>();
  tenants = new Map<string, { id: string; client_id: string; config: any; twilio_number: string | null }>();
  credentials = new Set<string>();        // `${tenant_id}:${provider}`
  profiles = new Map<string, { full_name: string | null; company: string | null; email: string | null; contact_email: string | null }>();
  writes: Array<{ item: string; status: string | null; data: any }> = [];
  constructor(public patch: Patch) {}
  owns(uid: string, clientId: string) { return this.clients.get(clientId)?.user_id === uid; }
}
export class MemoryUserDb implements UserDb {
  constructor(private w: MemoryWorld, private jwt: string) {}
  private uid() { return this.w.users.get(this.jwt) ?? null; }
  user() { const id = this.uid(); return Promise.resolve(id ? { id } : null); }
  rows(userId: string, clientId: string) {
    const uid = this.uid();
    const mine = uid === userId && this.w.owns(uid, clientId);   // RLS: other people's rows are simply not returned
    const items = mine ? [...this.w.items.values()].filter((i) => i.client_id === clientId).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map(({ client_id: _c, ...i }) => structuredClone(i)) : [];
    const t = mine ? [...this.w.tenants.values()].find((x) => x.client_id === clientId) : undefined;
    return Promise.resolve({ items, tenant: t ? structuredClone({ id: t.id, config: t.config, twilio_number: t.twilio_number }) : null,
      profile: mine ? structuredClone(this.w.profiles.get(uid!) ?? null) : null });
  }
  private check(itemId: string, data: any, status: string | null) {
    const uid = this.uid();
    if (!uid) throw new DbError("not_signed_in");
    const it = this.w.items.get(itemId);
    if (!it || !this.w.owns(uid, it.client_id)) throw new DbError("not_your_item");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DbError("data_must_be_object");
    const cl = this.w.clients.get(it.client_id)!;
    const merged = { ...it.data, ...data };
    const t = [...this.w.tenants.values()].find((x) => x.client_id === it.client_id);
    if (it.key === "calendar" && status === "done" && it.status !== "done" && merged.booking_mode !== "messages_only"
        && !(t && this.w.credentials.has(`${t.id}:${merged.provider ?? ""}`))) throw new DbError("calendar_not_connected");
    let cfg = t?.config ?? {};
    try { if (cl.billing_mode === "subscription") cfg = this.w.patch(it.key, merged, cfg); }
    catch (e) { throw new DbError((e as any).code ?? (e as Error).message); }
    if (JSON.stringify(merged).length >= 20000) throw new DbError("data_too_large");
    return { it, merged, t, cfg, cl };
  }
  preview(itemId: string, data: any, status: string | null) {
    try {
      const { cl, cfg } = this.check(itemId, data, status);
      if (cl.billing_mode !== "subscription") throw new DbError("not_a_plan_client");
      return Promise.resolve(structuredClone(cfg));
    } catch (e) { return Promise.reject(e); }
  }
  update(itemId: string, status: string | null, data: any) {
    try {
      const { it, merged, t, cfg } = this.check(itemId, data, status);
      this.w.writes.push({ item: itemId, status, data: structuredClone(data) });
      it.data = merged;
      if (status) it.status = status as Item["status"];
      if (t) t.config = cfg;
      const { client_id: _c, ...row } = it;
      return Promise.resolve(structuredClone(row));
    } catch (e) { return Promise.reject(e); }
  }
}

const iso = (d: Date) => d.toISOString();
/** Mirror of the SQL RPCs: same limits (12/min, 60/h, 150/day, 600 total), lock token, idempotency, budget, supersede. */
export class MemorySetupStore implements SetupStore {
  convs = new Map<string, any>();
  messages: Array<StoredMessage & { conversation_id: string; client_turn_id: string | null; model_json?: any; cost_usd: number; at: number }> = [];
  proposals = new Map<string, any>();
  settings = { enabled: true, budget_usd: 30, paused_until: null as string | null };
  alerts: Array<{ user: string; kind: string; detail: string }> = [];
  clock: () => number = () => Date.now();
  constructor(private world: MemoryWorld) {}
  private client(uid: string) {
    return [...this.world.clients.values()].filter((c) => c.user_id === uid && c.billing_mode === "subscription").pop() ?? null;
  }
  private spent() {
    const day = new Date(this.clock()); day.setUTCHours(0, 0, 0, 0);
    return this.messages.filter((m) => m.at >= day.getTime()).reduce((a, m) => a + (m.cost_usd || 0), 0);
  }
  private inputs(cid: string, ms: number) { return this.messages.filter((m) => m.conversation_id === cid && m.client_turn_id && m.at > this.clock() - ms); }
  private msgsOf(cid: string) { return this.messages.filter((m) => m.conversation_id === cid).sort((a, b) => a.seq - b.seq); }
  private pub = (m: any): StoredMessage => ({ id: String(m.id), seq: m.seq, role: m.role, text: m.text, blocks: structuredClone(m.blocks), created_at: m.created_at,
    input: !!m.client_turn_id, client_turn_id: m.client_turn_id ?? null });
  open(userId: string) {
    const cl = this.client(userId);
    if (!cl) return Promise.reject(new DbError("not_a_plan_client"));
    let cv = [...this.convs.values()].find((c) => c.client_id === cl.id);
    if (!cv) {
      cv = { id: crypto.randomUUID(), client_id: cl.id, user_id: userId, status: "active", topic: null, state: {}, turns: 0, lock_until: 0, lock_token: null };
      this.convs.set(cv.id, cv);
    }
    const t = [...this.world.tenants.values()].find((x) => x.client_id === cl.id);
    return Promise.resolve(structuredClone({
      conversation: { id: cv.id, status: cv.status, topic: cv.topic, state: cv.state, turns: cv.turns },
      client: { id: cl.id, status: cl.status, business_name: cl.business_name },
      golive: { client_status: cl.status, has_number: !!t?.twilio_number, sim_status: null, number_status: null },
      messages: this.msgsOf(cv.id).slice(-200).map(this.pub),
      proposals: [...this.proposals.values()].filter((p) => p.conversation_id === cv.id).map((p) => ({ id: p.id, topic: p.topic, item_key: p.item_key, status: p.status, shown_seq: p.shown_seq, error: p.error ?? null })),
      switches: { enabled: this.settings.enabled, paused_until: this.settings.paused_until, budget_usd: this.settings.budget_usd, spent_today_usd: this.spent() },
      limits: { messages_left_today: Math.max(0, 150 - this.inputs(cv.id, 86400000).length) },
    }));
  }
  begin(a: BeginArgs): Promise<BeginResult> {
    const cv = this.convs.get(a.conversation_id);
    const cl = cv ? this.world.clients.get(cv.client_id) : null;
    if (!cv || cv.user_id !== a.user_id || cl?.user_id !== a.user_id) return Promise.reject(new DbError("not_your_conversation"));
    if (a.role !== "none" && !/^[A-Za-z0-9_-]{8,64}$/.test(a.client_turn_id ?? "")) return Promise.reject(new DbError("bad_input"));
    if ((a.text ?? "").length > 1000) return Promise.reject(new DbError("bad_input"));
    if (!this.settings.enabled) return Promise.resolve({ error: "disabled" });
    let seq: number | null = null, retry = false, input: any = null;
    if (a.role !== "none") {
      const m = this.messages.find((x) => x.conversation_id === cv.id && x.client_turn_id === a.client_turn_id);
      if (m) {
        const next = this.msgsOf(cv.id).find((x) => x.seq > m.seq && x.client_turn_id);
        const replies = this.msgsOf(cv.id).filter((x) => x.seq > m.seq && (!next || x.seq < next.seq) && !x.client_turn_id);
        if (replies.length || m.role === "note") return Promise.resolve({ replay: true, seq: m.seq, messages: replies.map(this.pub) });
        retry = true; seq = m.seq; input = m;
      }
    }
    if (cv.lock_until > this.clock()) return Promise.resolve({ error: "turn_in_progress" });
    if (a.needs_model) {
      if (this.settings.paused_until && Date.parse(this.settings.paused_until) > this.clock()) {
        return Promise.resolve({ error: "paused", retry_after_s: Math.ceil((Date.parse(this.settings.paused_until) - this.clock()) / 1000) });
      }
      if (this.spent() >= this.settings.budget_usd) return Promise.resolve({ error: "budget", retry_after_s: 3600 });
    }
    if (a.role !== "none" && !retry) {
      if (this.messages.filter((m) => m.conversation_id === cv.id && m.client_turn_id).length >= 600) return Promise.resolve({ error: "limit" });
      const lim: Array<[number, number]> = [[86400000, 150], [3600000, 60], [60000, 12]];
      for (const [ms, max] of lim) {
        const ins = this.inputs(cv.id, ms);
        if (ins.length >= max) {
          const oldest = ins.sort((x, y) => y.at - x.at).slice(0, max).pop()!;
          return Promise.resolve({ error: "rate_limited", retry_after_s: Math.max(1, Math.ceil((oldest.at + ms - this.clock()) / 1000)) });
        }
      }
      seq = (this.msgsOf(cv.id).pop()?.seq ?? 0) + 1;
      const now = this.clock();
      input = { id: this.messages.length + 1, conversation_id: cv.id, seq, role: a.role, text: a.text ?? "", blocks: a.blocks ?? [],
        client_turn_id: a.client_turn_id, created_at: iso(new Date(now)), cost_usd: 0, at: now };
      this.messages.push(input);
    }
    cv.lock_until = this.clock() + 90000; cv.lock_token = crypto.randomUUID();
    const history = this.msgsOf(cv.id).filter((m) => seq === null || m.seq < seq).slice(-60)
      .map((m) => ({ seq: m.seq, role: m.role, text: m.text, model_json: m.model_json ?? null, input: !!m.client_turn_id }));
    return Promise.resolve(structuredClone({ ok: true as const, seq, retry, lock: cv.lock_token, input_id: input?.id ?? null,
      input_at: input?.created_at ?? null, input_text: input?.text ?? null, state: cv.state, topic: cv.topic, status: cv.status, turns: cv.turns,
      message_count: this.msgsOf(cv.id).length,
      pending: [...this.proposals.values()].filter((p) => p.conversation_id === cv.id && p.status === "pending")
        .map((p) => ({ id: p.id, topic: p.topic, item_key: p.item_key, data: p.data, base_hash: p.base_hash, shown_seq: p.shown_seq })),
      history, limits: { messages_left_today: Math.max(0, 150 - this.inputs(cv.id, 86400000).length) } }));
  }
  private held(cid: string, lock: string) {
    const cv = this.convs.get(cid);
    if (!cv || !lock || cv.lock_token !== lock) throw new DbError("lock_lost");
    return cv;
  }
  finish(cid: string, lock: string, turn: TurnOut) {
    try {
      const cv = this.held(cid, lock);
      if (turn.messages.length > 8 || turn.proposals.length > 4) throw new DbError("bad_turn");
      let seq = this.msgsOf(cid).pop()?.seq ?? 0;
      const out: Array<{ id: number; seq: number; created_at: string }> = [], seqs: number[] = [];
      for (const m of turn.messages) {
        if (!["assistant", "note"].includes(m.role) || (m.text ?? "").length > 2000 || JSON.stringify(m.blocks ?? []).length >= 16000) throw new DbError("bad_turn");
        seq++;
        const now = this.clock(), id = this.messages.length + 1;
        this.messages.push({ id, conversation_id: cid, seq, role: m.role, text: m.text ?? "", blocks: structuredClone(m.blocks ?? []), client_turn_id: null,
          model_json: m.model_json ?? null, created_at: iso(new Date(now)), cost_usd: 0, at: now });
        out.push({ id, seq, created_at: iso(new Date(now)) }); seqs.push(seq);
      }
      for (const p of turn.proposals) {
        if (p.msg_index < 0 || p.msg_index >= seqs.length || !/^[a-z_]{2,40}$/.test(p.topic)
            || !["hours", "faq", "alerts", "calendar", "tools", "forward_calls"].includes(p.item_key)) throw new DbError("bad_turn");
        for (const q of this.proposals.values()) if (q.conversation_id === cid && q.topic === p.topic && q.status === "pending") q.status = "superseded";
        this.proposals.set(p.id, { ...structuredClone(p), conversation_id: cid, client_id: cv.client_id, status: "pending", shown_seq: seqs[p.msg_index] });
      }
      if (turn.state) { if (JSON.stringify(turn.state).length >= 16000) throw new DbError("bad_turn"); cv.state = structuredClone(turn.state); }
      if (turn.topic !== undefined) cv.topic = turn.topic;
      if (turn.status) cv.status = turn.status;
      if (turn.messages.length) cv.turns++;
      const input = this.messages.find((m) => m.conversation_id === cid && m.seq === turn.input_seq);
      if (input && turn.usage) input.cost_usd += turn.usage.cost_usd;
      cv.lock_until = 0; cv.lock_token = null;
      return Promise.resolve({ messages: out });
    } catch (e) { return Promise.reject(e); }
  }
  decide(cid: string, lock: string, pid: string, status: "confirmed" | "failed" | "superseded", error: string | null, seq: number | null) {
    try {
      this.held(cid, lock);
      const p = this.proposals.get(pid);
      if (!p || p.conversation_id !== cid) throw new DbError("unknown_proposal");
      if (p.status !== "pending") throw new DbError("proposal_not_pending");
      if (status === "confirmed" && (seq === null || p.shown_seq >= seq)) throw new DbError("confirm_before_card");
      p.status = status; p.error = error;
      return Promise.resolve();
    } catch (e) { return Promise.reject(e); }
  }
  alert(user: string, kind: "budget" | "auth" | "down", detail: string) {
    this.alerts.push({ user, kind, detail });
    if (kind !== "down") this.settings.paused_until = new Date(this.clock() + 3600000).toISOString();
    return Promise.resolve();
  }
}
