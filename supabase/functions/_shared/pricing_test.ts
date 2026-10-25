// Pricing scenarios (PRICEBOOK §4). Expected numbers are derived from pricebook.json, never typed as dollars.
import { PRICEBOOK as PB } from "./config.ts";
import { alreadyIncluded, inputsFromStored, isAvailable, MAX_QTY, priceQuote, sendBlockers, storedItems, validateItems, wholeDollars } from "./pricing.ts";
import type { Pricebook } from "./pricing.ts";
import { allowedCodes, catalogText } from "./quote_prompt.ts";
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
  eq(r.setup_cents, 470000, "SPEC §1 step 8 setup"); eq(r.deposit_cents, 235000, "SPEC §1 step 8 deposit");
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
  const lines = [{ code: "BNDL" }, { code: "ADD-LOC", qty: 2 }, { code: "ADD-CRM", qty: 2 }, { code: "ADD-ES" }, { code: "ADD-DISPATCH" }];
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

// ---- v1.1, owner decision 2026-10-25 (dual-pricing-2026-10.he.md): the approved table, typed once here on purpose
// so a wrong edit of pricebook.json fails. [setup, monthly, plan B monthly] in cents.
const APPROVED: Record<string, [number, number, number]> = {
  RCP: [350000, 30000, 65000], WEB: [190000, 12900, 31900], BNDL: [490000, 40000, 89000],
  "BNDL-NM": [470000, 45000, 92000], "BNDL-GROW": [540000, 50000, 104000],
  "ADD-DISPATCH": [70000, 7500, 14500], "ADD-LEAD": [90000, 12500, 21500], "ADD-QUOTE": [50000, 5000, 10000],
  "ADD-ES": [35000, 3000, 6500], "ADD-REV": [40000, 2500, 6500], "ADD-CHAT": [50000, 2500, 7500],
  "ADD-CRM": [120000, 5000, 17000], "ADD-LOC": [90000, 10000, 19000], "ADD-WEB-ES": [90000, 2000, 11000],
};
const SOON = ["ADD-LEAD", "ADD-QUOTE", "ADD-REV", "BNDL-NM", "BNDL-GROW"];

Deno.test("16 price book v1.1 = the approved A/B table; plan B formula = monthly + setup x 1.2 / 12", () => {
  for (const [code, [s, m, b]] of Object.entries(APPROVED)) {
    eq([S(code), M(code), P(code).plan_b_monthly_cents], [s, m, b], code);
    eq(b, m + wholeDollars(s * 1.2 / 12), code + " plan B formula");
  }
  eq(PB.rules.plan_b_enabled, false, "plan B stays off until the Tranzila USD terminal is confirmed");
});

Deno.test("17 available SMS-free add-ons quote at the new plan A prices", () => {
  const r = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-DISPATCH" }]);
  eq([r.ok, r.setup_cents, r.monthly_cents, r.deposit_cents], [true, 420000, 37500, 210000]);
  const all = ["ADD-DISPATCH", "ADD-LOC", "ADD-ES", "ADD-CRM", "ADD-CHAT"];
  const a = priceQuote(PB, [{ code: "RCP" }, ...all.map((code) => ({ code }))], { manual_approved: true });
  eq([a.ok, a.setup_cents, a.monthly_cents], [true, S("RCP") + all.reduce((x, c) => x + S(c), 0), M("RCP") + all.reduce((x, c) => x + M(c), 0)]);
  const w = priceQuote(PB, [{ code: "WEB" }, { code: "ADD-WEB-ES" }]);
  eq([w.ok, w.setup_cents, w.monthly_cents], [true, 280000, 14900]);
  // FOUNDING: setup only; monthly never discounted
  const f = priceQuote(PB, [{ code: "RCP" }, { code: "ADD-DISPATCH" }], { discount_code: "FOUNDING" });
  eq([f.setup_cents, f.monthly_cents], [420000 - wholeDollars(420000 * 0.3), 37500]);
});

Deno.test("18 coming-soon items (need texting registration) are never quotable", () => {
  for (const code of SOON) {
    assert(!isAvailable(P(code)), code + " is coming soon");
    const core = P(code).group === "core" ? [] : [{ code: "RCP" }];
    const r = priceQuote(PB, [...core, { code }]);
    assert(!r.ok && r.errors.includes(`coming_soon:${code}`), code + ": " + r.errors.join());
    assert(validateItems(PB, [...core, { code }]).blockers.includes(`coming_soon:${code}`), code + " blocked in admin");
    assert(!allowedCodes(PB).includes(code), code + " never offered to Claude");
    assert(!catalogText(PB).includes(`- ${code}:`), code + " not in the catalog Claude sees");
  }
  for (const code of ["RCP", "WEB", "BNDL", "ADD-DISPATCH", "ADD-CHAT", "ADD-CRM", "ADD-ES", "ADD-LOC", "ADD-WEB-ES"]) {
    assert(isAvailable(P(code)) && allowedCodes(PB).includes(code), code + " is sellable");
  }
  // a stored quote that somehow carries a coming-soon line cannot be sent
  const q = { items: [{ code: "RCP", qty: 1, kind: "fixed" }, { code: "ADD-LEAD", qty: 1, kind: "fixed" }], setup_cents: 0, monthly_cents: 0, deposit_cents: 0, status: "approved" };
  assert(sendBlockers(PB, q).includes("coming_soon:ADD-LEAD"));
});

Deno.test("19 plan B is refused while it is not sold; plan A is the default", () => {
  eq(priceQuote(PB, [{ code: "RCP" }], { plan: "B" }).errors, ["plan_b_not_available"]);
  eq(priceQuote(PB, [{ code: "RCP" }], { plan: "A" }).ok, true);
  eq(priceQuote(PB, [{ code: "RCP" }]).setup_cents, S("RCP"));
});

Deno.test("20 a bundle's contained add-ons cannot be added twice (once the bundle is sellable)", () => {
  const pb = structuredClone(PB) as Pricebook;
  pb.rules.core_codes = [...pb.rules.core_codes, "BNDL-NM"];
  for (const i of pb.items) if (["BNDL-NM", "ADD-LEAD"].includes(i.code)) i.availability = "available";
  assert(alreadyIncluded("BNDL-NM", "ADD-DISPATCH", pb) && !alreadyIncluded("BNDL-NM", "ADD-ES", pb));
  eq(priceQuote(pb, [{ code: "BNDL-NM" }, { code: "ADD-DISPATCH" }]).errors, ["already_included:ADD-DISPATCH:BNDL-NM"]);
  const r = priceQuote(pb, [{ code: "BNDL-NM" }, { code: "ADD-ES" }]);
  eq([r.ok, r.setup_cents, r.monthly_cents], [true, S("BNDL-NM") + S("ADD-ES"), M("BNDL-NM") + M("ADD-ES")]);
});

Deno.test("21 the public site copy carries no plan B data and no feature list for coming-soon items", () => {
  const site = JSON.parse(Deno.readTextFileSync(new URL("../../../site/assets/pricebook.json", import.meta.url)));
  eq(site.rules.plan_b_enabled, false);
  eq("term_plan" in site.rules, false);
  // deno-lint-ignore no-explicit-any
  eq(site.items.filter((i: any) => "plan_b_monthly_cents" in i).length, 0);
  // deno-lint-ignore no-explicit-any
  for (const i of site.items.filter((i: any) => i.availability === "coming_soon")) eq([i.includes, i.excludes], [[], []], i.code);
});
