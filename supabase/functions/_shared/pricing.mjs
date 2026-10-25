// Quote pricing — ONE implementation for the server (Deno Edge Functions, via pricing.ts) and the browser admin
// (site/assets/pricing.mjs, a byte-identical copy made by tools/sync_config.py; --check reports drift).
// Pure ES module: no imports, no I/O, no globals. Rules = docs/PRICEBOOK.md §4, values = config/pricebook.json.
// Claude never supplies a number: it picks codes; every amount below is computed here.

/** Pseudo-code for work that has no pricebook row (ServiceTitan, EHR, Outlook, "other" tool…): always manual. */
export const CUSTOM_CODE = "CUSTOM";
/** Add-ons only ever added by Meir/the client, never by the engine (rush is offered; usage needs approval). */
export const APPROVAL_ONLY = ["ADD-RUSH", "ADD-USAGE"];
/** Max quantity per line (server and admin editor). */
export const MAX_QTY = 10;
/** Add-ons a core already contains without listing them in `contains` (BNDL includes the web chat widget). */
const ALREADY_INCLUDED = { BNDL: ["ADD-CHAT"] };

/** false = "coming soon" in the price book: listed on the site, never quoted or bought (PRICEBOOK §4.10). */
export function isAvailable(it) {
  return !!it && it.availability !== "coming_soon";
}

export function itemOf(pb, code) {
  return pb.items.find((i) => i.code === code);
}

function coreFamily(pb, core) {
  const it = itemOf(pb, core);
  return [core, ...((it && it.contains) || [])];
}

export function addonApplies(pb, addon, core) {
  if (addon.applies_to.includes("any")) return true;
  const fam = coreFamily(pb, core);
  return addon.applies_to.some((c) => fam.includes(c));
}

/** An add-on the core already includes would double-charge: ADD-CHAT on BNDL, or any add-on in the core's `contains`. */
export function alreadyIncluded(core, code, pb) {
  if (!core) return false;
  if ((ALREADY_INCLUDED[core] || []).includes(code)) return true;
  const it = pb ? itemOf(pb, core) : undefined;
  return !!(it && it.contains && it.contains.includes(code));
}

const isCents = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Round cents to whole dollars (PRICEBOOK §4.3), half up. */
export const wholeDollars = (cents) => Math.round(cents / 100) * 100;

/**
 * input: [{code, qty?, label?, manual_setup_cents?, manual_monthly_cents?, reason?, source?, systems?}]
 * opts:  {discount_code?, manual_approved?, plan?}   plan: "A" (default, setup + monthly) | "B" (no setup fee, 12 months)
 *
 * Manual-price rules (PRICEBOOK §3–4):
 *  - CUSTOM and "from" lines need Meir's manual setup+monthly prices.
 *  - "later" offers (MAP, AUTO, AGENT, SYS, APP, RET-*) are never auto-quoted: they need manual_approved=true
 *    (and manual prices where the table has none). After that the quote is sendable.
 *  - setup total above rules.manual_price_setup_over_cents needs manual_approved=true.
 * A quote = exactly one core offer (RCP|WEB|BNDL) + add-ons, OR later offers only (e.g. a retainer). Add-ons need a core.
 * "Coming soon" items (needs texting registration: ADD-LEAD, ADD-QUOTE, ADD-REV and the bundles that contain them) are
 * rejected: coming_soon:<code>. Plan B is not sold yet (rules.plan_b_enabled false; quotes are plan A): plan_b_not_available.
 */
export function priceQuote(pb, input, opts = {}) {
  const errors = [];
  const manual = [];
  const lines = [];
  const cores = input.filter((l) => pb.rules.core_codes.includes(l.code));
  const laterOnly = cores.length === 0 && input.some((l) => itemOf(pb, l.code)?.group === "later");
  if (cores.length > 1) errors.push("more_than_one_core_offer");
  else if (cores.length === 0 && !laterOnly) errors.push("no_core_offer");
  const core = cores.length === 1 ? cores[0].code : null;
  const plan = opts.plan == null ? "A" : opts.plan;
  // Plan B prices live in the server copy of the price book only; the engine prices plan A until B is switched on
  // and built (card on file, 12-month term), so a B request is refused either way.
  if (plan === "B") errors.push("plan_b_not_available");
  else if (plan !== "A") errors.push(`unknown_plan:${plan}`);

  const seen = new Set();
  for (const l of input) {
    const qty = l.qty == null ? 1 : l.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) { errors.push(`bad_qty:${l.code}`); continue; }
    if (l.code === CUSTOM_CODE) {
      const label = String(l.label || "").trim().slice(0, 160);
      if (!label) { errors.push("custom_without_label"); continue; }
      const ms = l.manual_setup_cents, mm = l.manual_monthly_cents;
      const priced = isCents(ms) && isCents(mm);
      if (!priced) manual.push(`custom:${label}`);
      lines.push({ code: CUSTOM_CODE, qty, name: label, kind: "custom", group: "custom",
        unit_setup_cents: priced ? ms : null, unit_monthly_cents: priced ? mm : null,
        setup_cents: priced ? ms * qty : null, monthly_cents: priced ? mm * qty : null, priced,
        reason: l.reason, source: l.source });
      continue;
    }
    const it = itemOf(pb, l.code);
    if (!it) { errors.push(`unknown_code:${l.code}`); continue; }
    if (!isAvailable(it)) { errors.push(`coming_soon:${l.code}`); continue; }
    if (seen.has(l.code)) { errors.push(`duplicate_code:${l.code}`); continue; }
    seen.add(l.code);
    if (it.group === "core" && qty !== 1) { errors.push(`core_qty:${l.code}`); continue; }
    if (it.group === "addon" && !it.applies_to.includes("any") && !core) { errors.push(`addon_requires_core:${l.code}`); continue; }
    if (it.group === "addon" && core && !addonApplies(pb, it, core)) { errors.push(`addon_not_applicable:${l.code}:${core}`); continue; }
    if (alreadyIncluded(core, l.code, pb)) { errors.push(`already_included:${l.code}:${core}`); continue; }

    if (it.kind === "percent") {
      if (qty !== 1) { errors.push(`percent_qty:${l.code}`); continue; }
      lines.push({ code: it.code, qty: 1, name: it.name, kind: "percent", group: it.group, unit_setup_cents: null,
        unit_monthly_cents: 0, setup_cents: null, monthly_cents: 0, priced: true, reason: l.reason, source: l.source });
      continue;
    }
    let us = it.setup_cents, um = it.monthly_cents;
    // manual prices win for from/later lines (Meir's number); table price otherwise
    const manualOk = isCents(l.manual_setup_cents) && isCents(l.manual_monthly_cents);
    if ((it.kind === "from" || it.group === "later") && manualOk) { us = l.manual_setup_cents; um = l.manual_monthly_cents; }
    const priced = isCents(us) && isCents(um) && (it.kind === "fixed" || manualOk);
    if (!priced) { manual.push(`${it.kind}:${it.code}`); us = null; um = null; }
    if (it.group === "later" && !opts.manual_approved) manual.push(`later_offer:${it.code}`);
    lines.push({ code: it.code, qty, name: it.name, kind: it.kind, group: it.group,
      unit_setup_cents: us, unit_monthly_cents: um, setup_cents: priced ? us * qty : null,
      monthly_cents: priced ? um * qty : null, priced, reason: l.reason, source: l.source, systems: l.systems });
  }

  const sum = (f) => lines.reduce((a, l) => a + (f(l) || 0), 0);
  const setupSubtotal = sum((l) => (l.kind === "percent" ? 0 : l.setup_cents));
  const monthly = sum((l) => l.monthly_cents);
  let rush = 0;
  for (const l of lines) {
    if (l.kind !== "percent") continue;
    const it = itemOf(pb, l.code);
    const pct = (it && it.setup_pct) || pb.rules.rush_pct;
    rush = wholeDollars(Math.round((setupSubtotal * pct) / 100));
    l.setup_cents = rush;
    l.unit_setup_cents = rush;
  }
  const beforeDiscount = setupSubtotal + rush;

  let discount = 0;
  if (opts.discount_code) {
    const d = pb.rules.discounts[opts.discount_code];
    if (!d) errors.push(`unknown_discount:${opts.discount_code}`);
    else {
      discount = wholeDollars(Math.round((beforeDiscount * d.setup_pct) / 100));
      if (d.monthly_pct && !pb.rules.monthly_discounts_allowed) errors.push("monthly_discount_not_allowed");
    }
  }
  const setup = beforeDiscount - discount;
  if (beforeDiscount > pb.rules.manual_price_setup_over_cents && !opts.manual_approved) manual.push("setup_over_threshold");
  const deposit = wholeDollars(Math.round((setup * pb.rules.deposit_pct) / 100));

  return {
    ok: errors.length === 0,
    errors,
    lines,
    core,
    setup_subtotal_cents: setupSubtotal,
    rush_cents: rush,
    discount_cents: discount,
    setup_cents: setup,
    monthly_cents: monthly,
    deposit_cents: deposit,
    final_cents: setup - deposit,
    needs_manual_price: manual.length > 0,
    manual_reasons: [...new Set(manual)],
  };
}

/** Stored shape of quotes.items (client-readable via RLS once sent: no Claude free text here; reasons live in quote_reviews). */
export function storedItems(r) {
  return r.lines.map((l) => ({
    code: l.code, qty: l.qty, name: l.name, kind: l.kind,
    setup_cents: l.setup_cents, monthly_cents: l.monthly_cents,
    unit_setup_cents: l.unit_setup_cents, unit_monthly_cents: l.unit_monthly_cents,
    ...(l.source ? { source: l.source } : {}),
    ...(l.systems ? { systems: l.systems } : {}),
  }));
}

/** Rebuild pricing inputs from stored items. Manual prices are kept on custom / from / later lines. */
export function inputsFromStored(items, pb) {
  return items.map((i) => {
    const group = pb ? itemOf(pb, String(i.code))?.group : undefined;
    const manualLine = i.kind === "custom" || i.kind === "from" || group === "later";
    return {
      code: String(i.code), qty: Number(i.qty == null ? 1 : i.qty),
      label: i.code === CUSTOM_CODE ? String(i.name || "") : undefined,
      manual_setup_cents: manualLine ? i.unit_setup_cents : undefined,
      manual_monthly_cents: manualLine ? i.unit_monthly_cents : undefined,
      source: i.source, systems: i.systems,
    };
  });
}

/**
 * What the admin runs before "אשר ושלח" — the same verdict quote-send gives (except the server-side FOUNDING cap,
 * which needs a DB count: pass founding_used to check it here too).
 * items: stored-shape lines (or LineInput); opts: {discount_code?, manual_approved?, founding_used?}
 * -> {ok, errors[], blockers[], needs_manual_price, manual_reasons[], totals{...}, lines}
 */
export function validateItems(pb, items, opts = {}) {
  const input = items.map((i) => ("unit_setup_cents" in i || "kind" in i) ? inputsFromStored([i], pb)[0] : i);
  const r = priceQuote(pb, input, opts);
  const blockers = [...r.errors];
  if (r.needs_manual_price) blockers.push("needs_manual_price");
  const cap = opts.discount_code && pb.rules.discounts[opts.discount_code] && pb.rules.discounts[opts.discount_code].max_clients;
  if (cap && typeof opts.founding_used === "number" && opts.founding_used >= cap) blockers.push("founding_limit_reached");
  return {
    ok: blockers.length === 0, errors: r.errors, blockers, needs_manual_price: r.needs_manual_price, manual_reasons: r.manual_reasons,
    totals: { setup_subtotal_cents: r.setup_subtotal_cents, rush_cents: r.rush_cents, discount_cents: r.discount_cents,
      setup_cents: r.setup_cents, monthly_cents: r.monthly_cents, deposit_cents: r.deposit_cents, final_cents: r.final_cents },
    lines: r.lines,
  };
}

/** The send gate used by quote-send and mirrored by the DB guard (quotes_guard). */
export function sendBlockers(pb, quote, manualApproved = false) {
  const out = [];
  if (quote.status !== "approved" && quote.status !== "draft") out.push(`status:${quote.status}`);
  const r = priceQuote(pb, inputsFromStored(quote.items, pb), { discount_code: quote.discount_code, manual_approved: manualApproved });
  out.push(...r.errors);
  if (r.needs_manual_price) out.push("needs_manual_price");
  if (r.ok && (r.setup_cents !== quote.setup_cents || r.monthly_cents !== quote.monthly_cents || r.deposit_cents !== quote.deposit_cents)) {
    out.push("stored_totals_mismatch");
  }
  return out;
}

/** Delivery time in business days for the quote's core offer; rush halves it (rounded up). */
export function deliveryDays(pb, r) {
  const core = r.core ? itemOf(pb, r.core) : undefined;
  if (!core || !core.delivery_business_days) return null;
  return r.lines.some((l) => l.kind === "percent") ? Math.ceil(core.delivery_business_days / 2) : core.delivery_business_days;
}
