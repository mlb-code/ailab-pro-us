// Sanitizer + Claude free text that could reach the client (A6 review items 2–3).
import { mockModel } from "./claude.ts";
import { draftQuote } from "./quote_engine.ts";
import { cleanText, violation } from "./sanitize.ts";
import { MemoryStore } from "./store.ts";
import { assert, eq, seed } from "./test_util.ts";

Deno.test("discount/free/promise phrasing is caught (review sentences + variants); harmless phrases pass", () => {
  const bad = ["First month free.", "Half off the build for early clients.", "We'll knock a bit off the price for you.",
    "Setup is on the house.", "No charge for the second line.", "We waive the setup fee.", "Get 20% off today.", "Free of charge.",
    "Complimentary setup for founding clients.", "We'll do the logo for free.", "A special price just for you.", "Discounted rate applies.",
    "Setup is only $1,234.", "You will never miss a call again.", "Fully HIPAA compliant."];
  for (const s of bad) assert(violation(s) !== null, "not caught: " + s);
  const ok = ["Callers can use a toll-free number.", "Feel free to send photos of your work.", "Hands-free booking for your team.",
    "We turn off your old voicemail greeting.", "Setup takes about 10 business days."];
  for (const s of ok) eq(violation(s), null, s);
  const removed: string[] = [];
  eq(cleanText("We build your line. First month free. Half off the build for early clients. We'll knock a bit off the price for you. You get alerts.", 999, removed, "scope_md"),
    "We build your line. You get alerts.");
  eq(removed.length, 3);
});

Deno.test("Claude CUSTOM label with a price is replaced; Claude reasons never stored in client-readable items", async () => {
  const store = new MemoryStore();
  const { qid } = seed(store, "hvac_basic");
  const model = mockModel(() => ({
    items: [{ code: "RCP", qty: 1, reason: "Sell them the $777 upgrade later", custom_label: "" },
      { code: "CUSTOM", qty: 1, reason: "client wants sync, maybe 20% off", custom_label: "ServiceTitan sync for $2,000 flat" }],
    scope_md: "Scope.", assumptions: [], not_included_extra: [], timeline_text: "Ten business days.", questions_for_client: [], risk_flags: [] }));
  const q = await draftQuote(qid, { store, model });
  const custom = q.items.find((i) => i.code === "CUSTOM")!;
  eq(custom.name, "Custom integration (scope to be confirmed)");
  const itemsText = JSON.stringify(q.items);
  assert(!itemsText.includes("$") && !itemsText.includes("reason") && !itemsText.includes("20%"), "no Claude free text in items: " + itemsText);
  const rev = store.reviews.get(q.id)!;
  assert(rev.risk_flags.some((f) => f.startsWith("custom_label_money_replaced")), "flagged for Meir");
  const reasons = (rev.hints as { item_reasons: Array<{ code: string; reason: string }> }).item_reasons;
  assert(reasons.some((r) => r.code === "RCP" && r.reason.includes("upgrade")), "reasons kept for admin only");
});
