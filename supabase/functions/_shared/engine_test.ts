// Quote engine with recorded (replay) Claude outputs + flows: send gate, view, accept, expiry, anonymised, events.
import { BRAND, PRICEBOOK as PB } from "./config.ts";
import { mockModel, replayModel } from "./claude.ts";
import { acceptQuote, draftQuote, EMAIL, emitExpiring, sendQuote, viewQuote } from "./quote_engine.ts";
import { outputSchema } from "./quote_prompt.ts";
import { violation } from "./sanitize.ts";
import { MemoryStore, type QuoteRow } from "./store.ts";
import { assert, eq, rejects, seed } from "./test_util.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const expected = JSON.parse(Deno.readTextFileSync(new URL("expected.json", FIX)));
const FIXTURES = Object.keys(expected).filter((k) => !k.startsWith("$"));

async function drafted(name: string, store = new MemoryStore()) {
  const { qid } = seed(store, name);
  const q = await draftQuote(qid, { store, model: replayModel(), replayKey: name });
  return { store, q, qid };
}
async function sentQuote(name = "plumber_jobber", extra: Record<string, unknown> = {}) {
  const r = await drafted(name);
  const q = await sendQuote({ quote_id: r.q.id, pay_method: "paypal_link", ...extra }, r.store);
  return { ...r, q };
}

for (const name of FIXTURES) {
  Deno.test(`fixture ${name}: totals equal fixtures/expected.json (replay)`, async () => {
    const { q, store, qid } = await drafted(name);
    const e = expected[name];
    eq([q.status, q.setup_cents, q.monthly_cents, q.deposit_cents], [e.status, e.setup_cents, e.monthly_cents, e.deposit_cents], name);
    eq(q.items.map((i) => [i.code, i.qty]), e.items, name + " items");
    eq(q.discount_code, null, "engine never applies a discount");
    eq(store.questionnaires.get(qid)!.status, "quoted");
    assert(store.drafts.has(q.id) && store.reviews.has(q.id), "draft + review saved");
    assert(store.events.some((ev) => ev.payload.template === "admin_new_quote" && ev.entity_id === q.id), "admin_new_quote event");
    assert(q.public_token.length >= 32 && /^[0-9a-f]+$/.test(q.public_token), "random token");
    for (const s of [q.scope_md ?? "", q.timeline_text ?? "", ...q.assumptions, ...q.not_included_extra]) {
      eq(violation(s), null, `client text clean: ${s}`);
    }
  });
}

Deno.test("ServiceTitan -> needs_manual_price, custom line unpriced, reason recorded; cannot be sent", async () => {
  const { q, store } = await drafted("garage_servicetitan");
  eq(q.status, "needs_manual_price");
  const custom = q.items.find((i) => i.code === "CUSTOM")!;
  eq([custom.setup_cents, String(custom.name).includes("ServiceTitan")], [null, true]);
  assert(store.reviews.get(q.id)!.manual_reasons.some((r) => r.includes("ServiceTitan")));
  await rejects(() => sendQuote({ quote_id: q.id }, store), "needs_manual_price");
  eq(store.quotes.get(q.id)!.status, "needs_manual_price", "still unsent");
  eq(store.events.filter((e) => e.payload.template === "quote_sent").length, 0);
  // once Meir prices the custom line (admin edit of items), it can go out
  const items = q.items.map((i) => i.code === "CUSTOM" ? { ...i, unit_setup_cents: 150000, unit_monthly_cents: 5000 } : i);
  await store.updateQuote(q.id, { items });
  const sent = await sendQuote({ quote_id: q.id }, store);
  eq([sent.status, sent.setup_cents], ["sent", PB.items.find((i) => i.code === "RCP")!.setup_cents! + 150000]);
});

Deno.test("injected fake codes, approval-only add-ons and prices in Claude's text are rejected/removed", async () => {
  const { q, store } = await drafted("locksmith_after_hours");
  const rev = store.reviews.get(q.id)!;
  assert(rev.risk_flags.includes("rejected_code:ADD-FAKE"), "fake code flagged");
  assert(rev.risk_flags.includes("rejected_code:ADD-USAGE") && !q.items.some((i) => i.code === "ADD-USAGE"), "usage block never auto-added");
  assert(!q.scope_md!.includes("$") && !/50%|discount|never miss/i.test(q.scope_md!), "price/promise sentences removed");
  assert(q.scope_md!.includes("Night Key Locksmith") && q.scope_md!.includes("on-call"), "clean sentences kept");
  assert(!q.assumptions.some((a) => /discount/i.test(a)), "discount assumption dropped");
  assert(!/guarantee/i.test(q.timeline_text!), "timeline promise dropped");
  assert(rev.removed.length >= 4, "removals visible to admin");
  const unsure = await drafted("unsure");
  assert(unsure.store.reviews.get(unsure.q.id)!.risk_flags.includes("rejected_code:ADD-FREEBIE"));
});

Deno.test("Claude cannot change the requested core; UNSURE takes Claude's core; rush is never auto-added", async () => {
  const store = new MemoryStore();
  const { qid } = seed(store, "hvac_basic");
  const model = mockModel(() => ({ items: [{ code: "BNDL", qty: 1, reason: "", custom_label: "" }, { code: "ADD-RUSH", qty: 1, reason: "", custom_label: "" }],
    scope_md: "Scope.", assumptions: [], not_included_extra: [], timeline_text: "Ten business days.", questions_for_client: [], risk_flags: [] }));
  const q = await draftQuote(qid, { store, model });
  eq(q.items.map((i) => i.code), ["RCP"]);
  assert(store.reviews.get(q.id)!.risk_flags.some((f) => f.startsWith("claude_core_ignored")));
  const roof = await drafted("roofer_spanish");
  assert(!roof.q.items.some((i) => i.code === "ADD-RUSH"));
  assert(roof.store.reviews.get(roof.q.id)!.risk_flags.some((f) => f.includes("consider ADD-RUSH")));
});

Deno.test("output schema has no price/amount/discount field and only catalog codes", () => {
  const s = JSON.stringify(outputSchema(PB));
  assert(!/price|amount|cents|discount|total|deposit/i.test(s), "no money fields");
  assert(!s.includes("ADD-RUSH") && !s.includes("ADD-USAGE") && !s.includes('"AUTO"'), "approval-only/later codes not offered");
});

Deno.test("malformed model output fails closed (no quote row)", async () => {
  const store = new MemoryStore();
  const { qid } = seed(store, "hvac_basic");
  await rejects(() => draftQuote(qid, { store, model: mockModel(() => "not json") }), "invalid_model_output");
  eq(store.quotes.size, 0);
});

Deno.test("retired, unknown or missing niche: no draft, no Claude call, no quote row", async () => {
  for (const niche of ["dental", "law", null]) { // "dental" = retired 2026-10-12 (no BAAs), still in the DB enum for old rows
    const store = new MemoryStore();
    const { qid } = seed(store, "hvac_basic");
    const q = store.questionnaires.get(qid)!;
    store.questionnaires.set(qid, { ...q, niche, answers: { ...(q.answers ?? {}), niche } } as typeof q);
    let called = 0;
    await rejects(() => draftQuote(qid, { store, model: mockModel(() => { called++; return "{}"; }) }), "niche_not_offered");
    eq(called, 0);
    eq(store.quotes.size, 0);
  }
});

Deno.test("regenerate overwrites a draft; a sent quote cannot be redrafted", async () => {
  const { store, q, qid } = await drafted("hvac_basic");
  const again = await draftQuote(qid, { store, model: replayModel(), replayKey: "hvac_basic" });
  eq([again.id, store.quotes.size], [q.id, 1]);
  await sendQuote({ quote_id: q.id }, store);
  await rejects(() => draftQuote(qid, { store, model: replayModel(), replayKey: "hvac_basic" }), "quote_already_sent");
});

Deno.test("send: FOUNDING applied only when admin passes it; valid_until = 14 days; quote_sent event; frozen after send", async () => {
  const { q, store } = await sentQuote("plumber_jobber", { discount_code: "FOUNDING", pay_link: "https://www.paypal.com/invoice/p/#X" });
  const setup = 470000, disc = setup * PB.rules.discounts.FOUNDING.setup_pct / 100;
  eq([q.status, q.discount_code, q.setup_cents, q.deposit_cents, q.monthly_cents], ["sent", "FOUNDING", setup - disc, (setup - disc) / 2, 35000]);
  const days = (new Date(q.valid_until!).getTime() - new Date(q.sent_at!).getTime()) / 864e5;
  eq(Math.round(days), PB.rules.quote_valid_days);
  assert(store.events.some((e) => e.payload.template === "quote_sent"));
  await rejects(() => store.updateQuote(q.id, { setup_cents: 1 }), "quote_frozen_after_send");
  await rejects(() => sendQuote({ quote_id: q.id, pay_link: "javascript:alert(1)" }, store), "quote_not_sendable");
});

Deno.test("view: whitelisted JSON, sets viewed once, includes/excludes from pricebook, refund rule, no internals", async () => {
  const { q, store } = await sentQuote();
  const v = await viewQuote(q.public_token, store);
  eq(store.quotes.get(q.id)!.status, "viewed");
  const firstViewed = store.quotes.get(q.id)!.viewed_at;
  await viewQuote(q.public_token, store);
  eq(store.quotes.get(q.id)!.viewed_at, firstViewed, "viewed_at set once");
  eq(v.includes.find((i) => i.code === "RCP")!.list, PB.items.find((i) => i.code === "RCP")!.includes);
  assert(!v.excludes.some((e) => e.includes("ADD-CRM") || e.includes("Jobber")), "exclusion for a purchased add-on removed");
  assert(v.excludes.some((e) => e.endsWith(" (extra, fixed price)")) && !v.excludes.some((e) => /add-on ADD-/.test(e)),
    "other add-on exclusions shown in plain words, no price-book codes");
  eq(v.refund.deposit, PB.refund_rules.deposit.text);
  eq(v.refund.guarantee, PB.refund_rules.rcp_guarantee.text, "RCP quote carries the satisfaction guarantee");
  eq([v.totals.setup_cents, v.totals.deposit_cents, v.totals.final_cents], [470000, 235000, 235000]);
  eq(v.call_offer_prominent, true, "above the async ceiling -> call offer prominent");
  const s = JSON.stringify(v);
  for (const k of ["reason", "user_id", "questionnaire_id", "accepted_ip", "risk_flags", "prompt_hash", "manual_reasons", q.id]) assert(!s.includes(k), "leak: " + k);
  eq(v.agreement_version, BRAND.agreement_version);
});

Deno.test("view refuses drafts, needs_manual_price, void, anonymised and malformed tokens with the same 404", async () => {
  const { q, store } = await drafted("hvac_basic");
  await rejects(() => viewQuote(q.public_token, store), "not_found");
  await rejects(() => viewQuote("short", store), "not_found");
  await rejects(() => viewQuote("' or 1=1 --aaaaaaaaaaaaaaaaaaaaaaaaaaaa", store), "not_found");
  await sendQuote({ quote_id: q.id }, store);
  store.quotes.get(q.id)!.anonymized = true;
  await rejects(() => viewQuote(q.public_token, store), "not_found");
  await rejects(() => acceptQuote({ token: q.public_token, name: "Dani Levin", agree: true, agreement_version: BRAND.agreement_version, ip: "1.2.3.4", ua: "x" }, store), "not_found");
});

Deno.test("accept: name + checkbox + version; stores hashes not raw IP/UA; events; idempotent; second signer refused", async () => {
  const { q, store } = await sentQuote();
  const base = { token: q.public_token, name: "  Mark   Ortiz ", agree: true, agreement_version: BRAND.agreement_version, ip: "203.0.113.9", ua: "Mozilla/5.0 Test" };
  await rejects(() => acceptQuote({ ...base, agree: false }, store), "agreement_required");
  await rejects(() => acceptQuote({ ...base, name: " " }, store), "name_required");
  await rejects(() => acceptQuote({ ...base, name: "12" }, store), "name_required");
  await rejects(() => acceptQuote({ ...base, agreement_version: "0.9" }, store), "agreement_version_mismatch");
  const v = await acceptQuote(base, store);
  const row = store.quotes.get(q.id)!;
  eq([row.status, row.accepted_name, v.status, v.accepted!.name], ["accepted", "Mark Ortiz", "accepted", "Mark Ortiz"]);
  assert(row.accepted_at && /^[0-9a-f]{64}$/.test(row.accepted_ip!) && /^[0-9a-f]{64}$/.test(row.accepted_ua!), "hashed ip/ua");
  assert(!row.accepted_ip!.includes("203.0.113") && /^[0-9a-f]{64}$/.test(row.agreement_hash!));
  eq(store.events.filter((e) => [EMAIL.accepted, EMAIL.adminAccepted].includes(String(e.payload.template) as never)).length, 2);
  await acceptQuote(base, store); // double click
  eq(store.events.filter((e) => e.payload.template === EMAIL.accepted).length, 1, "no duplicate events");
  await rejects(() => acceptQuote({ ...base, name: "Someone Else" }, store), "quote_already_accepted");
});

Deno.test("expired quote: view shows expired, accept refused; expiring event emitted once within 48 h", async () => {
  const { q, store } = await sentQuote();
  const in30h = new Date(Date.now() + 30 * 3600e3).toISOString();
  store.quotes.get(q.id)!.valid_until = in30h;
  eq(await emitExpiring(store), 1);
  eq(await emitExpiring(store), 0, "only once");
  const later = new Date(Date.now() + 15 * 864e5);
  const v = await viewQuote(q.public_token, store, later);
  eq([v.status, store.quotes.get(q.id)!.status], ["expired", "expired"]);
  await rejects(() => acceptQuote({ token: q.public_token, name: "Mark Ortiz", agree: true, agreement_version: BRAND.agreement_version, ip: "", ua: "" }, store, later), "quote_expired");
  // guard mirror: even if the status were still 'sent', an accept after valid_until fails
  const r2 = await sentQuote();
  store.quotes.set(r2.q.id, { ...r2.store.quotes.get(r2.q.id)!, valid_until: new Date(Date.now() - 1000).toISOString() } as QuoteRow);
  await rejects(() => acceptQuote({ token: r2.q.public_token, name: "Mark Ortiz", agree: true, agreement_version: BRAND.agreement_version, ip: "", ua: "" }, store), "quote_expired");
});

Deno.test("send: later offer is sendable after Meir's manual price + approval; FOUNDING cap counted in the DB", async () => {
  const { q, store } = await drafted("hvac_basic");
  const items = [...q.items, { code: "AUTO", qty: 1, kind: "from", unit_setup_cents: 400000, unit_monthly_cents: 50000 }];
  await store.updateQuote(q.id, { items });
  await rejects(() => sendQuote({ quote_id: q.id }, store), "needs_manual_price");
  const sent = await sendQuote({ quote_id: q.id, manual_approved: true }, store);
  eq([sent.status, sent.setup_cents], ["sent", 350000 + 400000]);
  // cap: 3 FOUNDING quotes in use -> the 4th is refused server-side
  const cap = PB.rules.discounts.FOUNDING.max_clients!;
  for (let i = 0; i < cap; i++) {
    const d = await drafted("hvac_basic", store);
    await sendQuote({ quote_id: d.q.id, discount_code: "FOUNDING" }, store);
  }
  const extra = await drafted("plumber_jobber", store);
  await rejects(() => sendQuote({ quote_id: extra.q.id, discount_code: "FOUNDING" }, store), "founding_limit_reached");
  eq((await sendQuote({ quote_id: extra.q.id }, store)).status, "sent", "without the discount it still goes out");
});
