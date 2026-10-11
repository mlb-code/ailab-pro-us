// Typed facade over pricing.mjs — the single pricing implementation shared with the browser admin
// (site/assets/pricing.mjs is a byte-identical copy; tools/sync_config.py --check reports drift).
// Types live here; logic lives only in pricing.mjs.
import * as P from "./pricing.mjs";

export type Kind = "fixed" | "from" | "custom" | "percent";

export interface PricebookItem {
  code: string;
  name: string;
  group: "core" | "addon" | "later";
  kind: Kind;
  setup_cents: number | null;
  monthly_cents: number | null;
  applies_to: string[];
  setup_pct?: number;
  contains?: string[];
  includes: string[];
  excludes: string[];
  delivery_business_days?: number;
  delivery_starts?: string;
  per?: string;
}

export interface Pricebook {
  version: string;
  currency: string;
  rules: {
    core_codes: string[];
    deposit_pct: number;
    rush_pct: number;
    manual_price_setup_over_cents: number;
    quote_valid_days: number;
    discounts: Record<string, { setup_pct: number; monthly_pct: number; max_clients?: number; applied_by: string }>;
    monthly_discounts_allowed: boolean;
    [k: string]: unknown;
  };
  refund_rules: { deposit: { text: string }; retainer: { text: string; codes: string[] }; status?: string };
  items: PricebookItem[];
  integrations: Record<string, string>;
  integration_meta: Record<string, { label: string; category: string; niches: string[]; note?: string }>;
}

export const CUSTOM_CODE: string = P.CUSTOM_CODE as unknown as never;
export const APPROVAL_ONLY: string[] = P.APPROVAL_ONLY as unknown as never;
export const MAX_QTY: number = P.MAX_QTY as unknown as never;

export interface LineInput {
  code: string;
  qty?: number;
  /** CUSTOM only: what the custom work is (shown on the quote). */
  label?: string;
  /** Set by Meir in admin for custom / "from" items. */
  manual_setup_cents?: number | null;
  manual_monthly_cents?: number | null;
  reason?: string;
  source?: "answers" | "claude" | "admin";
  systems?: string[];
}

export interface PriceOptions {
  /** Only "FOUNDING" exists; applied by admin, never by Claude (quote-draft never passes it). */
  discount_code?: string | null;
  /** Meir confirmed a quote above the manual-price threshold, or with "later" offers. */
  manual_approved?: boolean;
  /** FOUNDING quotes already sent/accepted (server counts in the DB). */
  founding_used?: number;
}

export interface Line {
  code: string;
  qty: number;
  name: string;
  kind: Kind;
  group: string;
  unit_setup_cents: number | null;
  unit_monthly_cents: number | null;
  setup_cents: number | null;
  monthly_cents: number | null;
  priced: boolean;
  reason?: string;
  source?: string;
  systems?: string[];
}

export interface PriceResult {
  ok: boolean;
  errors: string[];
  lines: Line[];
  core: string | null;
  setup_subtotal_cents: number;
  rush_cents: number;
  discount_cents: number;
  setup_cents: number;
  monthly_cents: number;
  deposit_cents: number;
  final_cents: number;
  needs_manual_price: boolean;
  manual_reasons: string[];
}


type StoredItem = Record<string, unknown>;
interface QuoteLike { items: StoredItem[]; discount_code?: string | null; setup_cents: number | null; monthly_cents: number | null;
  deposit_cents: number | null; status: string }
export interface ValidateResult {
  ok: boolean; errors: string[]; blockers: string[]; needs_manual_price: boolean; manual_reasons: string[];
  totals: { setup_subtotal_cents: number; rush_cents: number; discount_cents: number; setup_cents: number; monthly_cents: number;
    deposit_cents: number; final_cents: number };
  lines: Line[];
}

export const itemOf: (pb: Pricebook, code: string) => PricebookItem | undefined = P.itemOf as unknown as never;
export const addonApplies: (pb: Pricebook, addon: PricebookItem, core: string) => boolean = P.addonApplies as unknown as never;
export const alreadyIncluded: (core: string | null, code: string) => boolean = P.alreadyIncluded as unknown as never;
export const wholeDollars: (cents: number) => number = P.wholeDollars as unknown as never;
export const priceQuote: (pb: Pricebook, input: LineInput[], opts?: PriceOptions) => PriceResult = P.priceQuote as unknown as never;
export const storedItems: (r: PriceResult) => StoredItem[] = P.storedItems as unknown as never;
export const inputsFromStored: (items: StoredItem[], pb?: Pricebook) => LineInput[] = P.inputsFromStored as unknown as never;
export const validateItems: (pb: Pricebook, items: Array<StoredItem | LineInput>, opts?: PriceOptions) => ValidateResult = P.validateItems as unknown as never;
export const sendBlockers: (pb: Pricebook, quote: QuoteLike, manualApproved?: boolean) => string[] = P.sendBlockers as unknown as never;
export const deliveryDays: (pb: Pricebook, r: PriceResult) => number | null = P.deliveryDays as unknown as never;
