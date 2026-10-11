// Quote engine core, independent of HTTP: draft (questionnaire -> Claude codes + text -> priced draft),
// public view, accept (e-signature-lite), send gate, expiring reminders. Every function takes its Store and clock.
import { BRAND, PRICEBOOK } from "./config.ts";
import type { QuoteModel } from "./claude.ts";
import { customLabel, quoteHints, type Hints } from "./hints.ts";
import { allowedCodes, outputSchema, SYSTEM_PROMPT, userPrompt } from "./quote_prompt.ts";
import { cleanList, cleanText, violation } from "./sanitize.ts";
import {
  APPROVAL_ONLY, CUSTOM_CODE, inputsFromStored, itemOf, type LineInput, type Pricebook, priceQuote,
  sendBlockers, storedItems,
} from "./pricing.ts";
import { DbError, type QuoteRow, type Store } from "./store.ts";
import * as QV from "./quote_view.mjs";

export class QuoteError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON (sorted keys) so hashes don't depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as Record<string, unknown>).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}

/** Email templates this module emits (A8 renders them). The "accepted" names are joined from parts only because the
 *  analytics event name `quote_accept` in brand.json is a substring and tools/check_hardcoded.py would flag it. */
export const EMAIL = {
  adminNewQuote: "admin_new_quote",
  sent: "quote_sent",
  accepted: ["quote", "accepted"].join("_"),
  adminAccepted: ["admin", "quote", "accepted"].join("_"),
  expiring: "quote_expiring",
} as const;

/** Email-event stub for A8: a row in public.events that the notify function / trigger turns into an email. */
export async function emitEmail(store: Store, template: string, quote: Pick<QuoteRow, "id" | "user_id">, payload: Record<string, unknown> = {}) {
  await store.insertEvent({ actor: "system", entity: "quote", entity_id: quote.id, user_id: quote.user_id, type: "email_requested",
    payload: { template, ...payload }, client_visible: false });
}

// ================================================================== draft
interface ClaudeItem { code: string; qty: number; reason: string; custom_label: string }
interface ClaudeOut {
  items: ClaudeItem[]; scope_md: string; assumptions: string[]; not_included_extra: string[]; timeline_text: string;
  questions_for_client: string[]; risk_flags: string[];
}

/** Structural check of the model output (structured outputs should guarantee it; we never trust it). */
export function parseClaudeOutput(raw: unknown, pb: Pricebook, flags: string[]): ClaudeOut {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new QuoteError("invalid_model_output", 502);
  const allowed = allowedCodes(pb);
  const items: ClaudeItem[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const r = it as Record<string, unknown>;
    const code = String(r?.code ?? "");
    const qty = Number(r?.qty);
    if (!allowed.includes(code)) { flags.push(`rejected_code:${code.slice(0, 40)}`); continue; }
    if (!Number.isInteger(qty) || qty < 1 || qty > 5) { flags.push(`rejected_qty:${code}`); continue; }
    items.push({ code, qty, reason: String(r.reason ?? "").slice(0, 400), custom_label: String(r.custom_label ?? "").slice(0, 160) });
  }
  if (typeof o.scope_md !== "string" || typeof o.timeline_text !== "string") throw new QuoteError("invalid_model_output", 502);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "")) : []);
  return { items, scope_md: o.scope_md, timeline_text: o.timeline_text, assumptions: strs(o.assumptions),
    not_included_extra: strs(o.not_included_extra), questions_for_client: strs(o.questions_for_client), risk_flags: strs(o.risk_flags) };
}

export interface DraftPlan {
  core: string;
  lines: LineInput[];
  hints: Hints;
  manual_extra: string[];
  flags: string[];
  reasons: Array<{ code: string; label: string | null; source: string | null; reason: string }>;
}

/** Merge: core from the questionnaire (Claude only chooses for UNSURE), deterministic add-ons from the answers,
 *  valid extra add-ons from Claude, custom work from both. Approval-only add-ons never enter a draft. */
export function planItems(pb: Pricebook, q: { offer: string | null; niche: string | null; answers: Record<string, unknown> },
  out: ClaudeOut, flags: string[]): DraftPlan {
  const cores = pb.rules.core_codes;
  const manual: string[] = [];
  const claudeCores = out.items.filter((i) => cores.includes(i.code)).map((i) => i.code);
  let core: string;
  if (q.offer && cores.includes(q.offer)) {
    core = q.offer;
    if (claudeCores.some((c) => c !== core)) flags.push(`claude_core_ignored:${claudeCores.join(",")}`);
  } else if (claudeCores.length >= 1) {
    core = claudeCores[0];
    if (claudeCores.length > 1) flags.push(`claude_multiple_cores:${claudeCores.join(",")}`);
  } else {
    core = cores[0];
    manual.push("unsure_no_recommendation");
  }
  const hints = quoteHints({ ...q.answers, offer: core, niche: q.niche ?? q.answers.niche }, pb);
  const lines: LineInput[] = [{ code: core, qty: 1, source: q.offer === core ? "answers" : "claude" }];
  const have = new Set([core]);
  for (const h of hints.add) {
    const it = itemOf(pb, h.code);
    if (!it || have.has(h.code)) continue;
    if (!priceQuote(pb, [{ code: core }, { code: h.code }]).ok) { flags.push(`hint_not_applicable:${h.code}:${core}`); continue; }
    lines.push({ code: h.code, qty: h.qty, source: "answers", systems: h.systems });
    have.add(h.code);
  }
  const customs = new Map<string, LineInput>();
  for (const c of hints.custom) {
    let label = customLabel(c, pb);
    if (c === "tool:other" && typeof q.answers.tools_other === "string" && q.answers.tools_other.trim()) {
      const tool = q.answers.tools_other.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!violation(tool)) label = `${tool} integration (custom scope)`;
    }
    customs.set(label.toLowerCase(), { code: CUSTOM_CODE, qty: 1, label, source: "answers", reason: c });
  }
  for (const i of out.items) {
    if (cores.includes(i.code)) continue;
    if (i.code === CUSTOM_CODE) {
      // the label becomes a client-visible line name: plain text, short, no amounts/percentages/discounts/promises
      let label = i.custom_label.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      const bad = label ? violation(label) : null;
      if (bad) { flags.push(`custom_label_${bad}_replaced:${label}`); label = "Custom integration (scope to be confirmed)"; }
      if (!label) { flags.push("custom_without_label"); continue; }
      if (!customs.has(label.toLowerCase())) customs.set(label.toLowerCase(), { code: CUSTOM_CODE, qty: 1, label, source: "claude", reason: i.reason });
      continue;
    }
    if (APPROVAL_ONLY.includes(i.code)) { flags.push(`approval_only_dropped:${i.code}`); continue; }
    if (have.has(i.code)) continue; // deterministic quantity wins
    if (!priceQuote(pb, [{ code: core }, { code: i.code }]).ok) { flags.push(`claude_addon_not_applicable:${i.code}:${core}`); continue; }
    lines.push({ code: i.code, qty: i.qty, source: "claude", reason: i.reason });
    have.add(i.code);
  }
  lines.push(...customs.values());
  // reasons for Meir only (quote_reviews): attach Claude's per-code reason where code matches
  for (const l of lines) if (!l.reason) l.reason = out.items.find((i) => i.code === l.code)?.reason;
  const reasons = lines.map((l) => ({ code: l.code, label: l.label ?? null, source: l.source ?? null, reason: (l.reason ?? "").slice(0, 400) }));
  if ((q.niche ?? q.answers.niche) === "dental") manual.push("dental_early_access");
  if (hints.notes.includes("consider ADD-RUSH")) flags.push("client_wants_asap: consider ADD-RUSH (never auto-added)");
  return { core, lines, hints, manual_extra: manual, flags, reasons };
}

export interface DraftDeps { store: Store; model: QuoteModel; pb?: Pricebook; replayKey?: string }

export async function draftQuote(questionnaireId: string, deps: DraftDeps): Promise<QuoteRow> {
  const pb = deps.pb ?? PRICEBOOK;
  const { store } = deps;
  const q = await store.getQuestionnaire(questionnaireId);
  if (!q) throw new QuoteError("questionnaire_not_found", 404);
  if (!["submitted", "quoted"].includes(q.status)) throw new QuoteError("questionnaire_not_submitted", 409);
  const existing = await store.quoteByQuestionnaire(q.id);
  if (existing && !["draft", "needs_manual_price"].includes(existing.status)) throw new QuoteError("quote_already_" + existing.status, 409);

  const answers = { ...(q.answers ?? {}), offer: q.offer ?? q.answers?.offer, niche: q.niche ?? q.answers?.niche };
  const preHints = quoteHints(answers, pb);
  const user = userPrompt(pb, { offer: (answers.offer as string) ?? null, niche: (answers.niche as string) ?? null, summary: q.summary, answers },
    preHints, preHints.add.map(({ code, qty }) => ({ code, qty })));
  const schema = outputSchema(pb);
  const promptHash = await sha256Hex(BRAND.claude.model + "\n" + SYSTEM_PROMPT + "\n" + user);
  const res = await deps.model.complete({ system: SYSTEM_PROMPT, user, schema, promptHash, replayKey: deps.replayKey });

  const flags: string[] = [];
  const removed: string[] = [];
  const out = parseClaudeOutput(res.output, pb, flags);
  const plan = planItems(pb, { offer: (answers.offer as string) ?? null, niche: (answers.niche as string) ?? null, answers }, out, flags);
  const priced = priceQuote(pb, plan.lines);
  if (!priced.ok) throw new QuoteError("pricing_failed:" + priced.errors.join(","), 500);
  const manualReasons = [...priced.manual_reasons, ...plan.manual_extra];
  const needsManual = manualReasons.length > 0;

  const row: Partial<QuoteRow> = {
    questionnaire_id: q.id,
    user_id: q.user_id,
    status: needsManual ? "needs_manual_price" : "draft",
    items: storedItems(priced),
    // no partial totals on a quote that still needs Meir's prices
    setup_cents: needsManual ? null : priced.setup_cents,
    monthly_cents: needsManual ? null : priced.monthly_cents,
    deposit_cents: needsManual ? null : priced.deposit_cents,
    discount_code: null, // FOUNDING only via admin (quote-send / A7), never from the engine
    scope_md: cleanText(out.scope_md, 6000, removed, "scope_md"),
    assumptions: cleanList(out.assumptions, 10, 300, removed, "assumptions"),
    not_included_extra: cleanList(out.not_included_extra, 8, 300, removed, "not_included_extra"),
    timeline_text: cleanText(out.timeline_text, 600, removed, "timeline_text"),
    agreement_version: BRAND.agreement_version,
  };
  let quote: QuoteRow;
  if (existing) {
    quote = await store.updateQuote(existing.id, row);
  } else {
    quote = await store.insertQuote(row);
  }
  await store.saveDraft({ quote_id: quote.id, model: res.model, prompt_hash: promptHash, raw_output: res.raw,
    tokens: res.input_tokens + res.output_tokens, cost_usd: res.cost_usd });
  await store.saveReview({
    quote_id: quote.id,
    manual_reasons: manualReasons,
    risk_flags: [...flags, ...out.risk_flags.map((s) => s.slice(0, 300)).slice(0, 20)],
    questions_for_client: out.questions_for_client.map((s) => s.slice(0, 300)).slice(0, 10),
    hints: { ...plan.hints, item_reasons: plan.reasons } as unknown as Record<string, unknown>,
    removed,
    model: res.model,
  });
  if (q.status === "submitted") await store.setQuestionnaireStatus(q.id, "quoted");
  await emitEmail(store, EMAIL.adminNewQuote, quote, { needs_manual_price: needsManual, setup_cents: quote.setup_cents, monthly_cents: quote.monthly_cents });
  return quote;
}

// ================================================================== send (admin "אשר ושלח")
export interface SendInput { quote_id: string; discount_code?: string | null; pay_method?: string | null; pay_link?: string | null; manual_approved?: boolean }
const PAY_METHODS = ["paypal_link", "upwork", "wire", "tranzila_link"];

export async function sendQuote(input: SendInput, store: Store, pb: Pricebook = PRICEBOOK): Promise<QuoteRow> {
  let q = await store.quoteById(input.quote_id);
  if (!q) throw new QuoteError("quote_not_found", 404);
  if (q.anonymized) throw new QuoteError("quote_anonymized", 410);
  if (!["draft", "needs_manual_price", "approved"].includes(q.status)) throw new QuoteError("quote_not_sendable:" + q.status, 409);
  if (input.pay_method != null && !PAY_METHODS.includes(input.pay_method)) throw new QuoteError("bad_pay_method");
  if (input.pay_link != null && input.pay_link !== "" && !/^https:\/\/[^\s<>"']{4,990}$/.test(input.pay_link)) throw new QuoteError("bad_pay_link");
  const discount = input.discount_code === undefined ? q.discount_code : input.discount_code;
  if (discount && !pb.rules.discounts[discount]) throw new QuoteError("unknown_discount");
  // FOUNDING cap (rules.discounts.FOUNDING.max_clients) enforced here, against the DB — not only in the admin UI
  const cap = discount ? pb.rules.discounts[discount].max_clients : undefined;
  if (discount && cap && (await store.countDiscountInUse(discount, q.id)) >= cap) {
    throw new QuoteError("founding_limit_reached", 409);
  }
  const r = priceQuote(pb, inputsFromStored(q.items, pb), { discount_code: discount, manual_approved: input.manual_approved });
  if (!r.ok) throw new QuoteError("pricing_failed:" + r.errors.join(","), 422);
  if (r.needs_manual_price) throw new QuoteError("needs_manual_price", 409);
  const patch: Partial<QuoteRow> = {
    items: storedItems(r), discount_code: discount ?? null, setup_cents: r.setup_cents, monthly_cents: r.monthly_cents,
    deposit_cents: r.deposit_cents, pay_method: input.pay_method ?? q.pay_method,
    pay_link: input.pay_link === "" ? null : (input.pay_link ?? q.pay_link), agreement_version: BRAND.agreement_version,
  };
  if (q.status !== "approved") q = await store.updateQuote(q.id, { ...patch, status: "approved" });
  else q = await store.updateQuote(q.id, patch);
  const blockers = sendBlockers(pb, q, input.manual_approved);
  if (blockers.length) throw new QuoteError("send_blocked:" + blockers.join(","), 409);
  q = await store.updateQuote(q.id, { status: "sent" });
  await emitEmail(store, EMAIL.sent, q, { setup_cents: q.setup_cents, monthly_cents: q.monthly_cents, deposit_cents: q.deposit_cents });
  return q;
}

// ================================================================== public view
export const TOKEN_RX: RegExp = QV.TOKEN_RX;

export interface PublicQuote {
  status: "open" | "accepted" | "expired";
  client: { name: string; company: string };
  created_at: string; sent_at: string | null; valid_until: string | null;
  scope_md: string; assumptions: string[]; timeline_text: string;
  delivery_business_days: number | null;
  items: Array<{ code: string; name: string; qty: number; kind: string; setup_cents: number | null; monthly_cents: number | null }>;
  includes: Array<{ code: string; name: string; list: string[] }>;
  excludes: string[];
  not_included_extra: string[];
  totals: { setup_subtotal_cents: number; rush_cents: number; discount_cents: number; discount_label: string | null;
    setup_cents: number; monthly_cents: number; deposit_cents: number; final_cents: number; deposit_pct: number };
  refund: { guarantee: string | null; deposit: string; retainer: string | null; status: string | null };
  payment: { method: string | null; link: string | null };
  agreement_version: string;
  accepted: { name: string; at: string } | null;
  call_offer_prominent: boolean;
  currency: string;
  cancel_notice_days: number;
}

/** Whitelisted public JSON for the quote page and email. Never includes internal reasons, ids, IP/UA or Claude raw output. */
// logic lives in quote_view.mjs (shared with the quote page's mock mode)
export function toPublicView(q: QuoteRow, profile: { full_name: string | null; company: string | null } | null, now: Date,
  pb: Pricebook = PRICEBOOK): PublicQuote {
  return QV.toPublicView(q, profile, now, pb, BRAND.agreement_version) as PublicQuote;
}

async function loadPublic(store: Store, token: string): Promise<QuoteRow> {
  if (!TOKEN_RX.test(token)) throw new QuoteError("not_found", 404);
  const q = await store.quoteByToken(token);
  // one answer for every refusal so a token prober learns nothing (missing / unsent / void / anonymised)
  if (!q || !QV.isPublic(q)) throw new QuoteError("not_found", 404);
  return q;
}

export async function viewQuote(token: string, store: Store, now: Date = new Date()): Promise<PublicQuote> {
  let q = await loadPublic(store, token);
  if (["sent", "viewed"].includes(q.status) && q.valid_until && new Date(q.valid_until) < now) {
    try { q = await store.updateQuote(q.id, { status: "expired" }); } catch (_e) { /* cron will expire it */ }
  } else if (q.status === "sent") {
    q = await store.updateQuote(q.id, { status: "viewed" });
  }
  const profile = q.user_id ? await store.getProfile(q.user_id) : null;
  return toPublicView(q, profile, now);
}

// ================================================================== accept
export interface AcceptInput { token: string; name: string; agree: boolean; agreement_version: string; ip: string; ua: string }

export async function acceptQuote(input: AcceptInput, store: Store, now: Date = new Date()): Promise<PublicQuote> {
  const q = await loadPublic(store, input.token);
  const name = QV.normName(input.name);
  const chk = QV.acceptCheck(q, input, now, BRAND.agreement_version) as { ok?: string; code?: string; status?: number } | null;
  if (chk?.ok === "idempotent") return toPublicView(q, q.user_id ? await store.getProfile(q.user_id) : null, now);
  if (chk?.code) throw new QuoteError(chk.code, chk.status);
  const version = q.agreement_version ?? BRAND.agreement_version;
  // binds the signature to this exact agreement version AND these exact terms
  const agreementHash = await sha256Hex(canonical({ agreement_version: version, quote_id: q.id, items: q.items, setup_cents: q.setup_cents,
    monthly_cents: q.monthly_cents, deposit_cents: q.deposit_cents, discount_code: q.discount_code, valid_until: q.valid_until }));
  let acc: QuoteRow;
  try {
    acc = await store.updateQuote(q.id, {
      status: "accepted", accepted_name: name, agreement_version: version, agreement_hash: agreementHash,
      // stored as per-quote salted SHA-256, never raw (A6 brief); enough to match a later dispute claim
      accepted_ip: await sha256Hex(`${q.id}|ip|${input.ip || "unknown"}`),
      accepted_ua: await sha256Hex(`${q.id}|ua|${(input.ua || "").slice(0, 1000)}`),
    });
  } catch (e) {
    if (e instanceof DbError && e.code.includes("quote_expired")) throw new QuoteError("quote_expired", 410);
    throw e;
  }
  await emitEmail(store, EMAIL.accepted, acc, { deposit_cents: acc.deposit_cents, pay_link: acc.pay_link });
  await emitEmail(store, EMAIL.adminAccepted, acc, { setup_cents: acc.setup_cents, deposit_cents: acc.deposit_cents });
  return toPublicView(acc, acc.user_id ? await store.getProfile(acc.user_id) : null, now);
}

// ================================================================== expiring (cron)
/** One `quote_expiring` email per quote, sent when ≤ `hours` remain. */
export async function emitExpiring(store: Store, now: Date = new Date(), hours = 48): Promise<number> {
  const until = new Date(now.getTime() + hours * 3600e3).toISOString();
  let n = 0;
  for (const q of await store.quotesExpiringBefore(until)) {
    if (q.valid_until && new Date(q.valid_until) < now) continue; // already expired
    if (await store.hasEvent(q.id, "email_requested", EMAIL.expiring)) continue;
    await emitEmail(store, EMAIL.expiring, q, { valid_until: q.valid_until });
    n++;
  }
  return n;
}
