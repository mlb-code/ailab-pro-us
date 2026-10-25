// Deterministic mapping questionnaire answers -> add-ons / custom reasons.
// TypeScript port of quoteHints() in site/start/assets/questions.js (the form's documented contract);
// hints_test.ts runs both on every fixture and fails on any drift.
import type { Pricebook } from "./pricing.ts";
import { isAvailable } from "./pricing.ts";

export type Answers = Record<string, unknown>;
export interface Hints {
  core: string | null;
  add: Array<{ code: string; qty: number; systems?: string[] }>;
  custom: string[];
  notes: string[];
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function quoteHints(a: Answers, pb: Pricebook): Hints {
  const ints = pb.integrations || {};
  const add: Hints["add"] = [], custom: string[] = [], notes: string[] = [];
  if (a.locations === "2") add.push({ code: "ADD-LOC", qty: 1 });
  if (a.locations === "3") add.push({ code: "ADD-LOC", qty: 2 });
  if (a.locations === "4plus") custom.push("locations_over_3");
  if (a.calls_week === "400plus") custom.push("call_volume");
  if (a.spanish === "many" || a.spanish === "some") add.push({ code: "ADD-ES", qty: 1 });
  if (a.dispatch === "yes" && a.niche !== "real_estate") {
    if (isAvailable(pb.items.find((i) => i.code === "ADD-DISPATCH"))) add.push({ code: "ADD-DISPATCH", qty: 1 });
    else notes.push("wants ADD-DISPATCH (not available yet)");
  }
  const crm: string[] = [];
  arr(a.tools).forEach((t) => {
    const m = ints[t] || "custom";
    if (m.indexOf("addon:") === 0) crm.push(t);
    else if (m === "custom") custom.push("tool:" + t);
  });
  if (crm.length && (a.offer === "RCP" || a.offer === "BNDL")) add.push({ code: "ADD-CRM", qty: crm.length, systems: crm });
  const W: Record<string, string> = { extra_pages: "ADD-PAGE", spanish: "ADD-WEB-ES", logo: "ADD-LOGO", blog: "ADD-BLOG" };
  arr(a.web_extras).forEach((x) => { if (W[x]) add.push({ code: W[x], qty: 1 }); });
  const re = a.niche === "real_estate";
  if (re && a.re_crm && a.re_crm !== "none") {
    const k = String(a.re_crm);
    const m = ints[k] || "zapier";
    if (m === "custom" && k !== "other") custom.push("crm:" + k);
    else notes.push("real-estate CRM " + k + " via " + (k === "other" ? "zapier" : m));
  }
  if (a.timeline === "asap") notes.push("consider ADD-RUSH");
  return { core: (a.offer as string) || null, add, custom, notes };
}

/** Human label for a custom reason ("tool:servicetitan" -> "ServiceTitan integration"). */
export function customLabel(reason: string, pb: Pricebook): string {
  const [kind, key] = reason.split(":");
  const label = key ? (pb.integration_meta[key]?.label ?? key) : "";
  if (kind === "tool" || kind === "crm") return `${label} integration (custom scope)`;
  if (reason === "locations_over_3") return "More than 3 locations (custom scope)";
  if (reason === "call_volume") return "High call volume plan (custom scope)";
  return reason;
}
