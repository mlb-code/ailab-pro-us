// Brand + price book, copies of config/*.json made by tools/sync_config.py. Never edit the JSON here.
import pricebookJson from "./pricebook.json" with { type: "json" };
import brandJson from "./brand.json" with { type: "json" };
import type { Pricebook } from "./pricing.ts";

export const PRICEBOOK = pricebookJson as unknown as Pricebook;

export interface Brand {
  name: string;
  domain: string;
  site_url: string;
  support_email: string;
  senders: { transactional: string; quotes: string; alerts: string; reply_to: string };
  calendly_url: string;
  agreement_version: string;
  legal_final: boolean;
  physical_address: string;
  show_founder_price: boolean;
  quote_sla_text: string;
  claude: { model: string; effort: Record<string, string> };
  disclaimers: { footer: string; demo: string };
  legal_entity: { name: string };
  endpoints?: { payment?: string };
  [k: string]: unknown;
}
export const BRAND = brandJson as unknown as Brand;
