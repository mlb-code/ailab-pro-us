// Public quote view + acceptance rules — ONE implementation for quote-view / quote-accept (Deno, via quote_engine.ts)
// and the quote page's mock mode (site/assets/quote_view.mjs, byte-identical copy by tools/sync_config.py).
// Pure ES module: only imports the shared pricing module; no I/O.
import { deliveryDays, inputsFromStored, itemOf, priceQuote } from "./pricing.mjs";

export const TOKEN_RX = /^[A-Za-z0-9]{32,128}$/;
/** statuses a client may open by link (drafts / needs_manual_price / approved / void are never public) */
export const VISIBLE = ["sent", "viewed", "accepted", "expired"];

export const isPublic = (q) => !!q && !q.anonymized && VISIBLE.includes(q.status);
export const isExpired = (q, now) => q.status === "expired" || (q.status !== "accepted" && !!q.valid_until && new Date(q.valid_until) < now);

/** Whitelisted public JSON for the quote page and email. Never includes internal reasons, ids, IP/UA or Claude raw output. */
export function toPublicView(q, profile, now, pb, defaultAgreementVersion) {
  const r = priceQuote(pb, inputsFromStored(q.items, pb), { discount_code: q.discount_code, manual_approved: true });
  const codes = q.items.map((i) => String(i.code));
  const includes = codes.map((c) => itemOf(pb, c)).filter((it) => it && it.includes.length)
    .map((it) => ({ code: it.code, name: it.name, list: it.includes }));
  const coreIt = r.core ? itemOf(pb, r.core) : undefined;
  // exclusions from the price book; drop the ones the quote already buys (e.g. "add-on ADD-ES" when ADD-ES is a line)
  const excludes = ((coreIt && coreIt.excludes) || []).filter((e) => !codes.some((c) => e.includes(`add-on ${c})`)));
  const retainer = codes.some((c) => pb.refund_rules.retainer.codes.includes(c)) ? pb.refund_rules.retainer.text : null;
  const disc = q.discount_code ? pb.rules.discounts[q.discount_code] : null;
  const rcp = itemOf(pb, "RCP");
  const asyncCeiling = (rcp && rcp.setup_cents) || 0;
  const setup = q.setup_cents == null ? r.setup_cents : q.setup_cents;
  const deposit = q.deposit_cents == null ? r.deposit_cents : q.deposit_cents;
  return {
    status: q.status === "accepted" ? "accepted" : isExpired(q, now) ? "expired" : "open",
    client: { name: (profile && profile.full_name) || "", company: (profile && profile.company) || "" },
    created_at: q.created_at, sent_at: q.sent_at, valid_until: q.valid_until,
    scope_md: q.scope_md || "", assumptions: q.assumptions || [], timeline_text: q.timeline_text || "",
    delivery_business_days: deliveryDays(pb, r),
    items: q.items.map((i) => ({ code: String(i.code), name: String(i.name), qty: Number(i.qty == null ? 1 : i.qty), kind: String(i.kind),
      setup_cents: i.setup_cents == null ? null : i.setup_cents, monthly_cents: i.monthly_cents == null ? null : i.monthly_cents })),
    includes, excludes, not_included_extra: q.not_included_extra || [],
    totals: {
      setup_subtotal_cents: r.setup_subtotal_cents, rush_cents: r.rush_cents, discount_cents: r.discount_cents,
      discount_label: disc ? `Founding client (${disc.setup_pct}% off setup)` : null,
      // stored totals are the contract; pricing is recomputed only for the breakdown
      setup_cents: setup, monthly_cents: q.monthly_cents == null ? r.monthly_cents : q.monthly_cents,
      deposit_cents: deposit, final_cents: setup - deposit, deposit_pct: pb.rules.deposit_pct,
    },
    refund: { deposit: pb.refund_rules.deposit.text, retainer, status: pb.refund_rules.status || null },
    payment: { method: q.pay_method || null, link: q.pay_link || null },
    agreement_version: q.agreement_version || defaultAgreementVersion,
    accepted: q.status === "accepted" && q.accepted_at ? { name: q.accepted_name || "", at: q.accepted_at } : null,
    call_offer_prominent: setup > asyncCeiling,
    currency: pb.currency,
    cancel_notice_days: Number(pb.rules.cancel_notice_days == null ? 30 : pb.rules.cancel_notice_days),
  };
}

export const normName = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/**
 * Acceptance rules (e-signature-lite). Returns null when the accept may proceed, "idempotent" for a repeated accept
 * by the same signer, or an error code (with its HTTP status).
 */
export function acceptCheck(q, input, now, defaultAgreementVersion) {
  const name = normName(input.name);
  if (q.status === "accepted") return q.accepted_name === name ? { ok: "idempotent" } : { code: "quote_already_accepted", status: 409 };
  if (isExpired(q, now)) return { code: "quote_expired", status: 410 };
  if (input.agree !== true) return { code: "agreement_required", status: 400 };
  if (name.length < 2 || name.length > 200 || !/\p{L}/u.test(name)) return { code: "name_required", status: 400 };
  if (input.agreement_version !== (q.agreement_version || defaultAgreementVersion)) return { code: "agreement_version_mismatch", status: 409 };
  return null;
}
