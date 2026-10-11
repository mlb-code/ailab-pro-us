// Pricing scenarios (PRICEBOOK §4). Expected numbers are derived from pricebook.json, never typed as dollars.
import { PRICEBOOK as PB } from "./config.ts";
import { inputsFromStored, MAX_QTY, priceQuote, sendBlockers, storedItems, validateItems, wholeDollars } from "./pricing.ts";
import { assert, eq } from "./test_util.ts";

const P = (code: string) => PB.items.find((i) => i.code === code)!;
const S = (code: string) => P(code).setup_cents!;
const M = (code: string) => P(code).monthly_cents!;
const dep = (setup: number) => wholeDollars(Math.round(setup * PB.rules.deposit_pct / 100));

Deno.test("1 RCP alone: table price, 50% deposit, not manual", () => {
  const r = priceQuote(PB, [{ code: "RCP" }]);
  eq([r.ok, r.setup_cents, r.monthly_cents, r.deposit_cents, r.final_cents, r.needs_manual_price],
    [true, S("RCP"), M("RCP"), dep(S("RCP")), S("RCP") - dep(S("RCP")), false]);
});

Deno.test("2 WEB alone and 3 BNDL alone", () => {
  const w = priceQuote(PB, [{ code: "WEB" }]);
  eq([w.setup_cents, w.monthly_cents, w.deposit_cents], [S("WEB"), M("WEB"), dep(S("WEB"))]);
  const b = priceQuote(PB, [{ code: "BNDL" }]);
  eq([b.setup_cents, b.monthly_cents, b.deposit_cents], [S("BNDL"), M("BNDL"), dep(S("BNDL"))]);
  assert(S("BNDL") < S("RCP") + S("WEB"), "bundle saves money");
});

Deno.test("4 SPEC journey: RCP + ADD-CRM (Jobber) = setup, monthly and deposit as in SPEC §1 step 8", () => {
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-CRM", qty: 1 }]);
  eq([r.setup_cents, r.monthly_cents, r.deposit_cents], [S("RCP") + S("ADD-CRM"), M("RCP") + M("ADD-CRM"), dep(S("RCP") + S("ADD-CRM"))]);
  eq(r.setup_cents, 470000, "SPEC says $4,700"); eq(r.deposit_cents, 235000, "SPEC says $2,350");
});

Deno.test("5 add-ons with quantity: RCP + ADD-LOC x2 + ADD-ES; bundle accepts RCP and WEB add-ons", () => {
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-LOC", qty: 2 }, { code: "ADD-ES" }]);
  eq(r.setup_cents, S("RCP") + 2 * S("ADD-LOC") + S("ADD-ES"));
  eq(r.monthly_cents, M("RCP") + 2 * M("ADD-LOC") + M("ADD-ES"));
  const b = priceQuote(PB, [{ code: "BNDL" }, { code: "ADD-ES" }, { code: "ADD-BLOG" }]);
  assert(b.ok, b.errors.join());
});

Deno.test("6 WEB with every web extra", () => {
  const codes = ["ADD-PAGE", "ADD-WEB-ES", "ADD-LOGO", "ADD-BLOG"];
  const r = priceQuote(PB, [{ code: "WEB" }, ...codes.map((code) => ({ code }))]);
  eq(r.setup_cents, S("WEB") + codes.reduce((a, c) => a + S(c), 0));
  eq(r.monthly_cents, M("WEB") + codes.reduce((a, c) => a + M(c), 0));
});

Deno.test("7 rush = 25% of setup subtotal before rush, whole dollars; deposit after rush", () => {
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-RUSH" }]);
  const rush = wholeDollars(S("RCP") * PB.rules.rush_pct / 100);
  eq([r.rush_cents, r.setup_cents, r.monthly_cents], [rush, S("RCP") + rush, M("RCP")]);
  eq(r.deposit_cents, dep(S("RCP") + rush));
  eq(r.deposit_cents % 100, 0, "deposit rounded to whole dollars");
  const odd = priceQuote(PB, [{ code: "WEB" }, { code: "ADD-PAGE" }, { code: "ADD-RUSH" }]);
  eq(odd.rush_cents, wholeDollars((S("WEB") + S("ADD-PAGE")) * 0.25));
});

Deno.test("8 custom item -> needs_manual_price; priced custom resolves it", () => {
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "CUSTOM", label: "ServiceTitan integration" }]);
  eq([r.ok, r.needs_manual_price], [true, true]);
  assert(r.manual_reasons[0].startsWith("custom:"));
  const p = priceQuote(PB, [{ code: "RCP" }, { code: "CUSTOM", label: "ServiceTitan integration", manual_setup_cents: 250000, manual_monthly_cents: 10000 }]);
  eq([p.needs_manual_price, p.setup_cents], [false, S("RCP") + 250000]);
  // "from" offers are never auto-priced
  const f = priceQuote(PB, [{ code: "RCP" }, { code: "AUTO" }]);
  assert(f.needs_manual_price && f.manual_reasons.includes("from:AUTO"));
});

Deno.test("9 setup over the threshold -> needs_manual_price until Meir confirms", () => {
  const lines = [{ code: "BNDL" }, { code: "ADD-LOC", qty: 2 }, { code: "ADD-CRM", qty: 2 }, { code: "ADD-ES" }, { code: "ADD-REV" }];
  const r = priceQuote(PB, lines);
  assert(r.setup_cents > PB.rules.manual_price_setup_over_cents, "scenario must exceed threshold");
  eq([r.needs_manual_price, r.manual_reasons], [true, ["setup_over_threshold"]]);
  eq(priceQuote(PB, lines, { manual_approved: true }).needs_manual_price, false);
  // exactly at the threshold is still automatic
  assert(!priceQuote(PB, [{ code: "RCP" }]).manual_reasons.includes("setup_over_threshold"));
});

Deno.test("10 FOUNDING discount: 30% off setup only (after rush), monthly untouched, deposit from discounted setup", () => {
  const base = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-CRM" }, { code: "ADD-RUSH" }]);
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-CRM" }, { code: "ADD-RUSH" }], { discount_code: "FOUNDING" });
  const pct = PB.rules.discounts.FOUNDING.setup_pct;
  eq(r.discount_cents, wholeDollars(base.setup_cents * pct / 100));
  eq([r.setup_cents, r.monthly_cents], [base.setup_cents - r.discount_cents, base.monthly_cents]);
  eq(r.deposit_cents, dep(r.setup_cents));
  const bad = priceQuote(PB, [{ code: "RCP" }], { discount_code: "HALFOFF" });
  eq(bad.errors, ["unknown_discount:HALFOFF"]);
});

Deno.test("11 rejections: unknown code, two cores, no core, wrong add-on, chat on bundle, bad qty, duplicates", () => {
  eq(priceQuote(PB, [{ code: "RCP" }, { code: "ADD-FREE" }]).errors, ["unknown_code:ADD-FREE"]);
  eq(priceQuote(PB, [{ code: "RCP" }, { code: "WEB" }]).errors, ["more_than_one_core_offer"]);
  eq(priceQuote(PB, [{ code: "ADD-ES" }]).errors, ["no_core_offer", "addon_requires_core:ADD-ES"]);
  eq(priceQuote(PB, [{ code: "WEB" }, { code: "ADD-ES" }]).errors, ["addon_not_applicable:ADD-ES:WEB"]);
  eq(priceQuote(PB, [{ code: "RCP" }, { code: "ADD-BLOG" }]).errors, ["addon_not_applicable:ADD-BLOG:RCP"]);
  eq(priceQuote(PB, [{ code: "BNDL" }, { code: "ADD-CHAT" }]).errors, ["already_included:ADD-CHAT:BNDL"]);
  eq(priceQuote(PB, [{ code: "RCP" }, { code: "ADD-LOC", qty: 0 }]).errors, ["bad_qty:ADD-LOC"]);
  eq(priceQuote(PB, [{ code: "RCP" }, { code: "ADD-LOC", qty: 1.5 }]).errors, ["bad_qty:ADD-LOC"]);
  eq(priceQuote(PB, [{ code: "RCP" }, { code: "ADD-ES" }, { code: "ADD-ES" }]).errors, ["duplicate_code:ADD-ES"]);
  eq(priceQuote(PB, [{ code: "RCP", qty: 2 }]).errors, ["core_qty:RCP"]);
});

Deno.test("12 stored items round-trip and send gate", () => {
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-ES" }, { code: "CUSTOM", label: "Outlook calendar", manual_setup_cents: 60000, manual_monthly_cents: 0 }]);
  const again = priceQuote(PB, inputsFromStored(storedItems(r)));
  eq([again.setup_cents, again.monthly_cents, again.needs_manual_price], [r.setup_cents, r.monthly_cents, false]);
  const q = { items: storedItems(r), setup_cents: r.setup_cents, monthly_cents: r.monthly_cents, deposit_cents: r.deposit_cents, status: "approved" };
  eq(sendBlockers(PB, q), []);
  eq(sendBlockers(PB, { ...q, setup_cents: 1 }), ["stored_totals_mismatch"]);
  const manual = priceQuote(PB, [{ code: "RCP" }, { code: "CUSTOM", label: "ServiceTitan" }]);
  assert(sendBlockers(PB, { ...q, items: storedItems(manual) }).includes("needs_manual_price"));
});

Deno.test("13 later offers: needs_manual_price until manual price + approval, then sendable; later-only quotes allowed", () => {
  // fixed later offer (MAP): table price, but never auto-quoted
  const map = priceQuote(PB, [{ code: "RCP" }, { code: "MAP" }]);
  eq([map.ok, map.needs_manual_price, map.manual_reasons], [true, true, ["later_offer:MAP"]]);
  const mapOk = priceQuote(PB, [{ code: "RCP" }, { code: "MAP" }], { manual_approved: true });
  eq([mapOk.needs_manual_price, mapOk.setup_cents], [false, S("RCP") + S("MAP")]);
  // "from" offers: approval alone is not enough, a manual price is required
  for (const code of ["AUTO", "AGENT", "SYS", "APP"]) {
    const a = priceQuote(PB, [{ code: "RCP" }, { code }], { manual_approved: true });
    assert(a.needs_manual_price && a.manual_reasons.includes(`from:${code}`), code + " needs a manual price");
    const b = priceQuote(PB, [{ code: "RCP" }, { code }]);
    assert(b.manual_reasons.includes(`later_offer:${code}`), code + " needs approval");
    const c = priceQuote(PB, [{ code: "RCP" }, { code, manual_setup_cents: 900000, manual_monthly_cents: 45000 }], { manual_approved: true });
    eq([c.needs_manual_price, c.setup_cents, c.monthly_cents], [false, S("RCP") + 900000, M("RCP") + 45000], code);
  }
  // retainers alone (no core) are a valid quote once approved
  for (const code of ["RET-CARE", "RET-GROW", "RET-STUDIO"]) {
    const r = priceQuote(PB, [{ code }], { manual_approved: true });
    eq([r.ok, r.needs_manual_price, r.monthly_cents], [true, false, M(code)], code);
    eq(priceQuote(PB, [{ code }]).manual_reasons, [`later_offer:${code}`]);
  }
  eq(priceQuote(PB, [{ code: "RET-CARE" }, { code: "ADD-ES" }], { manual_approved: true }).errors, ["addon_requires_core:ADD-ES"]);
  // round-trip keeps Meir's price on from/later lines
  const st = storedItems(priceQuote(PB, [{ code: "RCP" }, { code: "AUTO", manual_setup_cents: 400000, manual_monthly_cents: 50000 }], { manual_approved: true }));
  eq(priceQuote(PB, inputsFromStored(st, PB), { manual_approved: true }).setup_cents, S("RCP") + 400000);
});

Deno.test("14 validateItems = server verdict (admin runs it before send), incl. FOUNDING cap and qty limit", () => {
  const ok = validateItems(PB, [{ code: "RCP" }, { code: "ADD-CRM" }], { discount_code: "FOUNDING", founding_used: 2 });
  eq([ok.ok, ok.blockers], [true, []]);
  eq(validateItems(PB, [{ code: "RCP" }], { discount_code: "FOUNDING", founding_used: 3 }).blockers, ["founding_limit_reached"]);
  eq(validateItems(PB, [{ code: "BNDL" }, { code: "ADD-CHAT" }]).blockers, ["already_included:ADD-CHAT:BNDL"]);
  eq(validateItems(PB, [{ code: "RCP" }, { code: "ADD-CRM" }, { code: "ADD-CRM" }]).blockers, ["duplicate_code:ADD-CRM"]);
  eq(validateItems(PB, [{ code: "RCP" }, { code: "ADD-LOC", qty: MAX_QTY + 1 }]).blockers, ["bad_qty:ADD-LOC"]);
  eq(validateItems(PB, [{ code: "RCP" }, { code: "MAP" }]).blockers, ["needs_manual_price"]);
  // stored-shape items accepted too
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-RUSH" }]);
  eq(validateItems(PB, storedItems(r)).totals.setup_cents, r.setup_cents);
});

Deno.test("15 browser copy site/assets/pricing.mjs is byte-identical (sync_config)", () => {
  const a = Deno.readTextFileSync(new URL("./pricing.mjs", import.meta.url));
  const b = Deno.readTextFileSync(new URL("../../../site/assets/pricing.mjs", import.meta.url));
  eq(a === b, true, "run python3 tools/sync_config.py");
});
