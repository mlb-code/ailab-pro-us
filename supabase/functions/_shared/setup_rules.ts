// Setup assistant rules (design 2026-11-27, sections 2.5, 3.3-3.6): pure functions, no I/O.
//   topics          order per niche, which checklist item each topic writes, what "done" means
//   converters      topic data (what the model proposes) -> item data keys, the same keys and shapes the forms save
//   fromConfig      the other keys of an item rebuilt from the live tenant config (full-item writes, section 2.5)
//   completeness    the forms' rules (portal-b.js collect()), with the reason the customer is told
//   provenance      every number, time, phone, e-mail and link must come from the customer, the config or a product default
//   cards           summary_card fields with a ready text for any client
//   misc            toE164, price lines, area text, redaction, settingsErr wording (ports of portal-b.js / onboarding-config.js)
// deno-lint-ignore-file no-explicit-any
import { canonical } from "./quote_engine.ts";

export type Json = any;
export type Niche = "home_services" | "real_estate";
export type ItemKey = "hours" | "faq" | "alerts" | "calendar" | "tools" | "forward_calls";
export interface Item { id: string; key: string; status: "todo" | "done" | "need_help"; title?: string; sort?: number; data: Record<string, Json> }
/** What the server knows on every turn, read with the customer's own JWT (items, tenant) plus the sign-up facts. */
export interface Snapshot {
  niche: Niche;
  timezone: string;
  cfg: Record<string, Json>;
  items: Item[];
  tenant: { id: string; twilio_number: string | null } | null;
  owner_name: string;
  business_name: string;
  plan_code: string | null;
  texting_on: boolean;
}

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const AFTER_HOURS: Array<[string, string]> = [["book_next_day", "Book the next open slot"], ["message_only", "Take a message"],
  ["emergency_dial", "Take a message, and call my on-call number for emergencies"]];
export const RE_LEAD_TYPES: Array<[string, string]> = [["buyers", "Buyers"], ["sellers", "Sellers"], ["renters", "Renters"], ["investors", "Investors"]];
export const RE_QUALIFY: Array<[string, string]> = [["timeline", "When they plan to buy, sell or move"], ["preapproval", "Mortgage pre-approval status"],
  ["budget", "Budget or price range"], ["areas", "Neighborhoods they want"], ["property", "Address of the property to sell"]];
// CARRIERS keys and labels of portal-b.js:39-70 (the instructions themselves stay in the portal: phase 2 moves them to config)
export const CARRIERS: Array<[string, string]> = [["verizon", "Verizon"], ["att", "AT&T"], ["tmobile", "T-Mobile"], ["comcast", "Comcast Business"],
  ["ringcentral", "RingCentral"], ["googlevoice", "Google Voice"], ["nextiva", "Nextiva"], ["grasshopper", "Grasshopper"], ["ooma", "Ooma Office"],
  ["dialpad", "Dialpad"], ["zoom", "Zoom Phone"], ["vonage", "Vonage Business"], ["other", "Other / not sure"]];
export const CARRIER_KEYS = CARRIERS.map((c) => c[0]);
/** Same sentence as portal-b.js FAIR_HOUSING (the receptionist tab). */
export const FAIR_HOUSING = "We never ask about race or color, religion, national origin, sex, family status, disability or source of income, or why someone is moving, and the assistant never steers callers toward or away from an area (fair housing).";
export const DEFAULT_DAILY_SUMMARY = "19:00";
const DEFAULT_TIMES = ["08:00", "17:00", DEFAULT_DAILY_SUMMARY];   // default_tenant_config hours + the daily summary
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CALENDLY_RX = /^https:\/\/calendly\.com\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\/?$/;
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ------------------------------------------------------------------ topics
export type Topic = "services" | "area" | "prices" | "re_leads" | "re_screening" | "faq" | "hours" | "after_hours" | "alerts" | "on_call"
  | "emergency" | "calendar" | "tools" | "business_phone" | "carrier" | "test_call";
export const DATA_TOPICS: Topic[] = ["services", "area", "prices", "re_leads", "re_screening", "faq", "hours", "after_hours", "alerts", "on_call",
  "emergency", "calendar", "tools", "business_phone"];
export const ALL_TOPICS: Topic[] = [...DATA_TOPICS, "carrier", "test_call"];
export const SKIPPABLE: Topic[] = ["area", "on_call", "tools"];
export const TOPIC_ITEM: Record<Topic, ItemKey> = {
  services: "faq", area: "faq", prices: "faq", re_leads: "faq", re_screening: "faq", faq: "faq", hours: "hours", after_hours: "hours",
  alerts: "alerts", on_call: "alerts", emergency: "alerts", calendar: "calendar", tools: "tools", business_phone: "forward_calls",
  carrier: "forward_calls", test_call: "forward_calls",
};
/** The item data keys each topic owns (what a confirm of that topic changes). */
export const TOPIC_KEYS: Record<Topic, string[]> = {
  services: ["services"], area: ["service_area"], prices: ["price_on_phone", "fixed_prices"], re_leads: ["re_lead_types"], re_screening: ["re_qualify"],
  faq: ["faq"], hours: ["hours", "timezone"], after_hours: ["after_hours"], alerts: ["notify"], on_call: ["on_call_number"], emergency: ["emergency"],
  calendar: ["booking_mode", "provider", "booking_link"], tools: ["zapier_webhook_url", "skipped"], business_phone: ["business_phone"], carrier: ["carrier"],
  test_call: [],
};
export const TITLES: Record<Topic, string> = {
  services: "Services you book", area: "Where you work", prices: "Prices it may say", re_leads: "Leads that call you", re_screening: "Questions for every caller",
  faq: "Questions & answers", hours: "Business hours", after_hours: "After hours", alerts: "Lead alerts", on_call: "On-call number", emergency: "Emergency words",
  calendar: "Your calendar", tools: "Other tools", business_phone: "Your business number", carrier: "Your phone provider", test_call: "Test call",
};
const ORDER: Record<Niche, Topic[]> = {
  home_services: ["services", "area", "hours", "after_hours", "prices", "faq", "alerts", "on_call", "emergency", "calendar", "tools",
    "business_phone", "carrier", "test_call"],
  real_estate: ["services", "re_leads", "area", "re_screening", "hours", "after_hours", "faq", "alerts", "on_call", "emergency", "calendar", "tools",
    "business_phone", "carrier", "test_call"],
};
export const topicsFor = (niche: Niche): Topic[] => ORDER[niche] ?? ORDER.home_services;
export const isTopic = (t: unknown): t is Topic => typeof t === "string" && (ALL_TOPICS as string[]).includes(t);
export const OPTIONAL_ITEMS = ["tools", "sms"];   // go-live never waits for these (subscriptions.sql try_go_live)

/** Conversation memory the rules read (setup_conversations.state). */
export interface ConvState {
  skipped?: string[];           // optional topics the customer skipped
  answered?: string[];          // topics answered without a write (business number confirmed as is)
  revisit?: string | null;      // a done topic the customer asked to change
  [k: string]: Json;
}

const itemOf = (s: Snapshot, key: string) => s.items.find((i) => i.key === key);
const confirmedAt = (it: Item | undefined, t: Topic) => !!(it?.data?.setup_confirmed && it.data.setup_confirmed[t]);

/** Done from the item status and confirmed keys, not from chat memory (section 2.7). An item done in the forms is done here. */
export function topicDone(t: Topic, s: Snapshot, st: ConvState): boolean {
  const it = itemOf(s, TOPIC_ITEM[t]);
  if (!it) return true;   // no such checklist step for this client: nothing to ask
  if (it.status === "done" && t !== "test_call") return true;
  switch (t) {
    case "calendar": return false;                                                  // done only by OAuth / messages only
    case "tools": return !!(it.data.skipped || it.data.zapier_webhook_url || confirmedAt(it, t));
    case "carrier": return typeof it.data.carrier === "string" && CARRIER_KEYS.includes(it.data.carrier);
    case "business_phone": return confirmedAt(it, t) || (st.answered ?? []).includes(t);
    case "test_call": return it.status === "done";
    default: return confirmedAt(it, t) || ((SKIPPABLE as string[]).includes(t) && (st.skipped ?? []).includes(t));
  }
}
/** The topic to work on: an explicit revisit first, else the first topic not done in the niche order. null = all done. */
export function currentTopic(s: Snapshot, st: ConvState): Topic | null {
  if (st.revisit && isTopic(st.revisit) && topicsFor(s.niche).includes(st.revisit)) return st.revisit;
  return topicsFor(s.niche).find((t) => !topicDone(t, s, st)) ?? null;
}
/** Status to send with a confirmed topic: done once every topic of the item is done, never down from done. */
export function itemStatusAfter(item: Item, topic: Topic, s: Snapshot, st: ConvState): "todo" | "done" {
  if (item.status === "done") return "done";
  if (item.key === "calendar" || item.key === "forward_calls") return "todo";     // OAuth / test triggers only
  if (item.key === "tools") return "done";
  const mine = topicsFor(s.niche).filter((t) => TOPIC_ITEM[t] === item.key);
  const marked: Item = { ...item, data: { ...item.data, setup_confirmed: { ...(item.data.setup_confirmed ?? {}), [topic]: "now" } } };
  const s2: Snapshot = { ...s, items: s.items.map((i) => (i.key === item.key ? marked : i)) };
  return mine.every((t) => topicDone(t, s2, st)) ? "done" : "todo";
}

// ------------------------------------------------------------------ small helpers (ports)
/** portal-b.js toE164: US numbers only (+1 and 10 digits, area code not 0/1). null = empty, "invalid" = not a US number. */
export function toE164(s: unknown): string | null | "invalid" {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  const e = t.startsWith("+") ? "+" + digits : digits.length === 10 ? "+1" + digits : digits.length === 11 && digits[0] === "1" ? "+" + digits : "";
  return /^\+1[2-9][0-9]{9}$/.test(e) ? e : "invalid";
}
export const fmtPhone = (e: string | null | undefined) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e ?? "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e ?? "");
};
const trimSet = (s: string, chars: string) => {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};
/** onboarding-config.js parsePrices == private.parse_price_lines (parity-tested). */
export function parsePrices(lines: unknown): Array<{ name: string; price_usd: number; note: string }> {
  const out: Array<{ name: string; price_usd: number; note: string }> = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw).trim();
    let m = /\$\s?([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(.*)$/.exec(line), name: string;
    if (m) name = line.replace(/\s*[:–—-]?\s*\$\s?[0-9].*$/, "");
    else {
      m = /[:–—-]\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(.*)$/.exec(line);
      if (!m) continue;
      name = line.replace(/\s*[:–—-]\s*[0-9]{1,6}(?:\.[0-9]{1,2})?\s*.*$/, "");
    }
    name = trimSet(name, " :–—-").slice(0, 80);
    const note = trimSet(m[2] || "", " ()").slice(0, 160);
    const price = Number(m[1]);
    if (!name || price > 100000) continue;
    out.push({ name, price_usd: price, note });
    if (out.length >= 30) break;
  }
  return out;
}
/** onboarding-config.js parseArea == private.parse_service_area. */
export function parseArea(text: unknown): { zips: string[]; places: string[] } {
  const s = String(text ?? ""), zips: string[] = [], places: string[] = [], seen: Record<string, 1> = {};
  (s.match(/\b[0-9]{5}\b/g) || []).forEach((z) => { if (!zips.includes(z) && zips.length < 500) zips.push(z); });
  s.split(/[,;\n]+/).forEach((x) => {
    const t = trimSet(x.replace(/\b[0-9]{5}\b/g, "").trim(), " .").slice(0, 80);
    if (!t || !/[A-Za-z]/.test(t) || seen[t.toLowerCase()] || places.length >= 50) return;
    seen[t.toLowerCase()] = 1; places.push(t);
  });
  return { zips, places };
}
export const priceLine = (p: { name: string; price_usd: number; note?: string }) =>
  `${p.name.trim()}: $${Number(p.price_usd)}${p.note && p.note.trim() ? ` (${p.note.trim()})` : ""}`;
const areaText = (places: string[], zips: string[]) => [...places, ...zips].join(", ");
const get = (o: Json, path: string) => path.split(".").reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o);
const SCREEN_BACK: Record<string, string> = { timeline: "timeline", price_range: "budget", pre_approval: "preapproval", area: "areas", property_address: "property" };

// ------------------------------------------------------------------ full-item writes (section 2.5)
/** Every data key of an item rebuilt from the live config (falling back to the item's own value when the config has
 *  nothing for it), so a write never brings back a stale value. Invariant (tested): patch(key, fromConfig(key, cfg), cfg) == cfg
 *  on every path the item touches. */
export function fromConfig(itemKey: string, cfg: Json, data: Record<string, Json> = {}, niche: Niche = "home_services"): Record<string, Json> {
  const out: Record<string, Json> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(data, k);
  if (itemKey === "hours") {
    if (cfg?.hours && typeof cfg.hours === "object") out.hours = structuredClone(cfg.hours); else if (has("hours")) out.hours = data.hours;
    if (get(cfg, "business.timezone")) out.timezone = get(cfg, "business.timezone"); else if (has("timezone")) out.timezone = data.timezone;
    if (get(cfg, "after_hours.mode")) out.after_hours = { mode: get(cfg, "after_hours.mode") }; else if (has("after_hours")) out.after_hours = data.after_hours;
  } else if (itemKey === "faq") {
    const jt = get(cfg, "booking.job_types");
    if (Array.isArray(jt)) out.services = [...jt]; else if (has("services")) out.services = data.services;
    if (Array.isArray(cfg?.faq)) out.faq = cfg.faq.map((x: Json) => ({ q: x.q, a: x.a })); else if (has("faq")) out.faq = data.faq;
    const zips = get(cfg, "business.service_area_zips"), places = get(cfg, "business.service_area_places");
    if ((Array.isArray(zips) && zips.length) || (Array.isArray(places) && places.length) || has("service_area")) {
      out.service_area = areaText(Array.isArray(places) ? places : [], Array.isArray(zips) ? zips : []) || null;
    }
    const pr = cfg?.pricing;
    if (pr && pr.mode === "listed" && Array.isArray(pr.items)) {
      out.price_on_phone = "fixed"; out.fixed_prices = pr.items.map(priceLine);
    } else if (pr && pr.mode === "none") {
      out.price_on_phone = "no"; out.fixed_prices = [];
    } else {
      if (has("price_on_phone")) out.price_on_phone = data.price_on_phone;
      if (has("fixed_prices")) out.fixed_prices = data.fixed_prices;
    }
    if (niche === "real_estate") {
      const renters = get(cfg, "real_estate.renters");
      if (Array.isArray(data.re_lead_types)) {
        const t = data.re_lead_types.filter((x: string) => x !== "renters");
        out.re_lead_types = renters === true || (renters === undefined && data.re_lead_types.includes("renters")) ? [...t, "renters"] : t;
      }
      const scr = get(cfg, "real_estate.screening");
      if (Array.isArray(scr)) out.re_qualify = scr.map((k: string) => SCREEN_BACK[k]).filter(Boolean);
      else if (has("re_qualify")) out.re_qualify = data.re_qualify;
    }
  } else if (itemKey === "alerts") {
    const n = cfg?.notify;
    if (n && typeof n === "object" && ((n.sms?.length ?? 0) + (n.email?.length ?? 0) > 0 || has("notify"))) {
      out.notify = {} as Json;
      for (const k of ["sms", "email", "daily_summary"]) if (k in n) out.notify[k] = structuredClone(n[k]);
    } else if (has("notify")) out.notify = data.notify;
    if (cfg?.handoff && typeof cfg.handoff === "object") out.on_call_number = cfg.handoff.mode === "dial" ? (cfg.handoff.number ?? null) : null;
    else if (has("on_call_number")) out.on_call_number = data.on_call_number;
    const kw = get(cfg, "emergency.keywords");
    if (Array.isArray(kw)) out.emergency = { keywords: [...kw], dial: out.on_call_number ?? null };
    else if (has("emergency")) out.emergency = data.emergency;
  } else if (itemKey === "tools") {
    const z = get(cfg, "zapier.webhook_url");
    if (z !== undefined) out.zapier_webhook_url = z; else if (has("zapier_webhook_url")) out.zapier_webhook_url = data.zapier_webhook_url;
  } else if (itemKey === "forward_calls") {
    if (has("business_phone")) out.business_phone = get(cfg, "business.main_phone") ?? data.business_phone;
  }
  return out;
}

/** The config paths an item touches (base_hash input; the invariant test compares these). */
export const ITEM_PATHS: Record<string, string[]> = {
  hours: ["hours", "business.timezone", "after_hours"],
  faq: ["booking.job_types", "faq", "business.service_area_zips", "business.service_area_places", "pricing", "real_estate"],
  alerts: ["notify", "handoff", "emergency"],
  calendar: ["booking.enabled", "booking.provider", "booking.booking_link"],
  tools: ["zapier"],
  forward_calls: ["business.main_phone"],
};
export const pathValues = (itemKey: string, cfg: Json) => Object.fromEntries((ITEM_PATHS[itemKey] ?? []).map((p) => [p, get(cfg, p) ?? null]));

/** SHA-256 of the item's data + the config subset it touches; a confirm on a changed base re-proposes. */
export async function baseHash(item: Item, cfg: Json): Promise<string> {
  const data = { ...item.data };
  for (const k of ["saved_at", "confirmed_at", "via"]) delete data[k];   // our own stamps do not make a proposal stale
  const bytes = new TextEncoder().encode(canonical({ status: item.status, data, cfg: pathValues(item.key, cfg) }));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ topic data -> item data (+ completeness)
export type Converted = { ok: true; patch: Record<string, Json>; note?: string } | { ok: false; reason: string };
const fail = (reason: string): Converted => ({ ok: false, reason });
const strList = (v: Json, max: number, each: number) =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, max).map((x) => x.slice(0, each)) : [];

export function topicToData(topic: Topic, td: Json, s: Snapshot): Converted {
  td = td && typeof td === "object" ? td : {};
  switch (topic) {
    case "services": {
      const items = strList(td.items, 31, 81);
      if (!items.length) return fail("The receptionist needs at least one service to book.");
      if (items.length > 30 || items.some((x) => x.length > 80)) return fail("invalid_setting:booking.job_types (1 to 30 services, each up to 80 characters)");
      return { ok: true, patch: { services: items } };
    }
    case "area": {
      const text = String(td.text ?? "").trim();
      if (!text) return fail("No area given. Ask once, or skip this optional topic.");
      if (text.length > 500) return fail("invalid_setting:service_area (up to 500 characters)");
      const a = parseArea(text);
      if (!a.zips.length && !a.places.length) return fail("No city, county, neighborhood or 5-digit ZIP code found in the area.");
      return { ok: true, patch: { service_area: text } };
    }
    case "prices": {
      if (td.mention === false) return { ok: true, patch: { price_on_phone: "no", fixed_prices: [] } };
      const items = Array.isArray(td.items) ? td.items : [];
      if (!items.length) return fail("Prices: add at least one price, or mention=false.");
      if (items.length > 30) return fail("Prices: up to 30 prices.");
      const lines: string[] = [];
      for (const p of items) {
        const name = String(p?.name ?? "").trim(), price = Number(p?.price_usd), note = String(p?.note ?? "").trim();
        if (!name || name.length > 80 || !Number.isFinite(price) || price < 0 || price > 100000 || note.length > 160) {
          return fail(`Prices: "${name.slice(0, 40)}" needs a name (up to 80 characters) and a price from $0 to $100,000.`);
        }
        const line = priceLine({ name, price_usd: Math.round(price * 100) / 100, note });
        const back = parsePrices([line]);   // must read back exactly like the server's parse_price_lines
        if (back.length !== 1 || back[0].name !== name || back[0].price_usd !== Math.round(price * 100) / 100 || back[0].note !== note) {
          return fail(`Prices: "${name.slice(0, 40)}" cannot be saved as a price line (avoid $, : and brackets in the name).`);
        }
        lines.push(line);
      }
      return { ok: true, patch: { price_on_phone: "fixed", fixed_prices: lines } };
    }
    case "re_leads": {
      const t = (Array.isArray(td.types) ? td.types : []).filter((x: string) => RE_LEAD_TYPES.some((r) => r[0] === x));
      if (!t.length) return fail("Pick at least one kind of lead (buyers, sellers, renters, investors).");
      return { ok: true, patch: { re_lead_types: [...new Set(t)] } };
    }
    case "re_screening": {
      const t = (Array.isArray(td.ask) ? td.ask : []).filter((x: string) => RE_QUALIFY.some((r) => r[0] === x));
      return { ok: true, patch: { re_qualify: [...new Set(t)] } };
    }
    case "faq": {
      const all = (Array.isArray(td.items) ? td.items : []).map((x: Json) => ({ q: String(x?.q ?? "").trim(), a: String(x?.a ?? "").trim() }))
        .filter((x: Json) => x.q || x.a);
      if (!all.length) return fail("Add at least one question and answer.");
      const items = all.slice(0, 25);
      const i = items.findIndex((x: Json) => !x.q || x.q.length > 300 || !x.a || x.a.length > 600);
      if (i !== -1) return fail(`invalid_setting:faq[${i}].${!items[i].q || items[i].q.length > 300 ? "q" : "a"} (question up to 300, answer up to 600 characters)`);
      return { ok: true, patch: { faq: items }, note: all.length > 25 ? "I kept the first 25 (the limit). Tell me which to swap." : undefined };
    }
    case "hours": {
      const days = td.days && typeof td.days === "object" ? td.days : null;
      if (!days) return fail("Hours: every day needs open and close times, or closed.");
      const hours: Record<string, Json> = {};
      for (const d of DAYS) {
        const v = days[d];
        if (!v || v.closed === true || v === "closed") { hours[d] = null; continue; }
        if (!HHMM.test(String(v.open)) || !HHMM.test(String(v.close)) || !(v.open < v.close)) {
          return fail(`invalid_setting:hours.${d} (opening must be before closing, HH:MM; ask about am/pm if unclear)`);
        }
        hours[d] = [v.open, v.close];
      }
      if (!DAYS.some((d) => Array.isArray(hours[d]))) return fail("Hours: at least one open day.");
      return { ok: true, patch: { hours, timezone: s.timezone } };
    }
    case "after_hours": {
      if (!AFTER_HOURS.some((a) => a[0] === td.mode)) return fail("invalid_setting:after_hours.mode");
      return { ok: true, patch: { after_hours: { mode: td.mode } } };
    }
    case "alerts": {
      const emails = strList(td.emails, 6, 321).map((e) => e.toLowerCase());
      const mobiles = strList(td.mobiles, 6, 40).map(toE164);
      if (emails.length > 5 || mobiles.length > 5) return fail("Alerts: up to 5 emails and 5 mobile numbers.");
      const be = emails.findIndex((e) => !EMAIL_RX.test(e) || e.length > 320);
      if (be !== -1) return fail(`invalid_setting:notify.email[${be}]`);
      const bm = mobiles.findIndex((m) => !m || m === "invalid");
      if (bm !== -1) return fail(`invalid_setting:notify.sms[${bm}] (a US mobile number)`);
      if (!emails.length && !mobiles.length) return fail("Alerts: at least one email or mobile number.");
      const ds = td.daily_summary === null || td.daily_summary === undefined || td.daily_summary === "" ? null : String(td.daily_summary);
      if (ds !== null && !HHMM.test(ds)) return fail("invalid_setting:notify.daily_summary");
      return { ok: true, patch: { notify: { sms: mobiles as string[], email: emails, daily_summary: ds } } };
    }
    case "on_call": {
      const n = td.number === null || td.number === undefined || td.number === "" ? null : toE164(td.number);
      if (n === "invalid") return fail("invalid_setting:on_call_number (a US phone number)");
      return { ok: true, patch: { on_call_number: n } };
    }
    case "emergency": {
      const kw = strList(td.keywords, 41, 61);
      if (!kw.length) return fail("Add at least one emergency word.");
      if (kw.length > 40 || kw.some((k) => k.length > 60)) return fail("invalid_setting:emergency.keywords (up to 40 words, each up to 60 characters)");
      return { ok: true, patch: { emergency: { keywords: kw } } };
    }
    case "calendar": {
      if (td.choice === "messages_only") return { ok: true, patch: { booking_mode: "messages_only", provider: null } };
      if (td.choice === "calendly") {
        const link = String(td.calendly_link ?? "").trim();
        if (!CALENDLY_RX.test(link)) return fail("invalid_setting:booking.booking_link (https://calendly.com/your-name/event)");
        return { ok: true, patch: { provider: "calendly", booking_link: link, booking_mode: null } };
      }
      return fail("Google Calendar is connected with the Connect button (show_action connect_calendar), not saved from a card.");
    }
    case "tools": {
      const u = String(td.zapier_webhook_url ?? "").trim();
      if (!/^https:\/\//.test(u) || u.length > 500) return fail("invalid_setting:zapier.webhook_url (starts with https://)");
      return { ok: true, patch: { zapier_webhook_url: u, skipped: false } };
    }
    case "business_phone": {
      const n = toE164(td.number);
      if (!n || n === "invalid") return fail("invalid_setting:business.main_phone (a US phone number)");
      return { ok: true, patch: { business_phone: n } };
    }
    default:
      return fail(`${topic} is not saved from a card.`);
  }
}

/** The full item data a proposal writes: fresh values for every other key + this topic's value + our stamps. */
export function fullItemData(topic: Topic, patch: Record<string, Json>, item: Item, s: Snapshot): Record<string, Json> {
  const base = fromConfig(item.key, s.cfg, item.data, s.niche);
  const out: Record<string, Json> = { ...base, ...patch };
  if (item.key === "alerts" && out.emergency) out.emergency = { keywords: out.emergency.keywords ?? [], dial: out.on_call_number ?? null };
  out.via = "setup_assistant";
  out.setup_confirmed = { ...(item.data.setup_confirmed ?? {}), [topic]: "pending" };
  return out;
}

/** The topic's current value as topic data (revisit: "change my hours" shows today's settings first). */
export function topicFromConfig(topic: Topic, s: Snapshot): Json | null {
  const it = itemOf(s, TOPIC_ITEM[topic]);
  const d = fromConfig(TOPIC_ITEM[topic], s.cfg, it?.data ?? {}, s.niche);
  switch (topic) {
    case "services": return Array.isArray(d.services) && d.services.length ? { items: d.services } : null;
    case "area": return d.service_area ? { text: d.service_area } : null;
    case "prices": return d.price_on_phone === "no" ? { mention: false, items: [] }
      : d.price_on_phone === "fixed" ? { mention: true, items: parsePrices(d.fixed_prices) } : null;
    case "re_leads": return Array.isArray(d.re_lead_types) ? { types: d.re_lead_types } : null;
    case "re_screening": return Array.isArray(d.re_qualify) ? { ask: d.re_qualify } : null;
    case "faq": return Array.isArray(d.faq) && d.faq.length ? { items: d.faq } : null;
    case "hours": return d.hours ? { days: Object.fromEntries(DAYS.map((x) => [x, Array.isArray(d.hours[x])
      ? { closed: false, open: d.hours[x][0], close: d.hours[x][1] } : { closed: true, open: "", close: "" }])) } : null;
    case "after_hours": return d.after_hours ? { mode: d.after_hours.mode } : null;
    case "alerts": return d.notify ? { emails: d.notify.email ?? [], mobiles: d.notify.sms ?? [], daily_summary: d.notify.daily_summary ?? null } : null;
    case "on_call": return "on_call_number" in d ? { number: d.on_call_number } : null;
    case "emergency": return d.emergency?.keywords?.length ? { keywords: d.emergency.keywords } : null;
    case "tools": return d.zapier_webhook_url ? { zapier_webhook_url: d.zapier_webhook_url } : null;
    case "business_phone": { const p = d.business_phone ?? get(s.cfg, "business.main_phone"); return p ? { number: p } : null; }
    default: return null;
  }
}
/** Topic data rebuilt from a stored proposal's item data (a confirm on a changed base re-proposes the same answer). */
export function topicDataFromItemData(topic: Topic, data: Json, s: Snapshot): Json | null {
  // an empty config makes fromConfig fall back to the given item data
  const fake: Snapshot = { ...s, items: s.items.map((i) => i.key === TOPIC_ITEM[topic] ? { ...i, data } : i), cfg: {} };
  return topicFromConfig(topic, fake);
}

// ------------------------------------------------------------------ provenance (section 3.6)
/** What the customer said, as tokens (kept in conversation state, bounded): numbers, phone numbers, e-mails, links. */
export interface Prov { n: string[]; z: string[]; p: string[]; e: string[]; u: string[]; w: string[] }
export const emptyProv = (): Prov => ({ n: [], z: [], p: [], e: [], u: [], w: [] });
const normNum = (t: string) => String(Number(t));
const normUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[).,;!?]+$/, "").replace(/\/$/, "");
export function addProv(prov: Prov, text: string): Prov {
  const t = String(text ?? "");
  const push = (arr: string[], v: string, max: number) => { if (v && !arr.includes(v)) { arr.push(v); if (arr.length > max) arr.shift(); } };
  const plain = t.replace(/(\d),(\d{3})\b/g, "$1$2");
  for (const m of plain.match(/\d+(?:\.\d+)?/g) ?? []) { push(prov.n, normNum(m), 400); if (/^\d{5}$/.test(m)) push(prov.z, m, 200); }
  for (const m of t.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? []) {
    const d = m.replace(/\D/g, "").slice(-10); push(prov.p, d, 40);
  }
  for (const m of t.match(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[A-Za-z]{2,}/g) ?? []) push(prov.e, m.toLowerCase(), 20);
  for (const m of t.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi) ?? []) if (m.includes("/") || /^https?:/i.test(m)) push(prov.u, normUrl(m), 20);
  for (const w of ["noon", "midnight"]) if (new RegExp(`\\b${w}\\b`, "i").test(t)) push(prov.w, w, 4);
  return prov;
}
/** A time is justified when the customer said its hour (12- or 24-hour form) and, unless :00, its minutes. */
function timeOk(hhmm: string, prov: Prov): boolean {
  const [h, m] = hhmm.split(":").map(Number);
  const hours = new Set([String(h)]);
  if (h > 12) hours.add(String(h - 12));
  if (h === 12) { hours.add("12"); if (prov.w.includes("noon")) return m === 0 || prov.n.includes(String(m)); }
  if (h === 0) { hours.add("12"); if (prov.w.includes("midnight")) return m === 0; }
  const hourSaid = [...hours].some((x) => prov.n.includes(x));
  return hourSaid && (m === 0 || prov.n.includes(String(m)));
}
const digitRuns = (s: string, min = 2) => (String(s ?? "").replace(/(\d),(\d{3})\b/g, "$1$2").match(/\d+(?:\.\d+)?/g) ?? []).filter((d) => d.replace(".", "").length >= min);
/** Facts the server knows anyway: the config, the sign-up details, product defaults. */
function knownFacts(s: Snapshot): Prov {
  const p = emptyProv();
  addProv(p, JSON.stringify(s.cfg ?? {}));
  for (const it of s.items) addProv(p, JSON.stringify(it.data ?? {}));
  return p;
}
/** Problems with numbers / contacts that the customer never said. Empty = OK. */
export function provenance(topic: Topic, td: Json, said: Prov, s: Snapshot): string[] {
  const known = knownFacts(s), errs: string[] = [];
  const num = (t: string, what: string) => { if (!said.n.includes(normNum(t)) && !known.n.includes(normNum(t))) errs.push(`${what} "${t}" was not said by the customer`); };
  const free = (text: string, what: string) => digitRuns(text).forEach((d) => num(d, what));
  const phone = (e: string | null, what: string) => {
    if (!e) return;
    const d = e.replace(/\D/g, "").slice(-10);
    if (!said.p.includes(d) && !known.p.includes(d)) errs.push(`${what} ${fmtPhone(e)} was not given by the customer`);
  };
  const cfgTimes = new Set<string>(DEFAULT_TIMES);
  for (const d of DAYS) { const v = get(s.cfg, `hours.${d}`); if (Array.isArray(v)) v.forEach((x: string) => cfgTimes.add(x)); }
  const ds = get(s.cfg, "notify.daily_summary"); if (typeof ds === "string") cfgTimes.add(ds);
  const time = (t: string, what: string) => { if (!cfgTimes.has(t) && !timeOk(t, said)) errs.push(`${what} ${t} was not said by the customer (ask, do not guess)`); };
  td = td ?? {};
  switch (topic) {
    case "services": (td.items ?? []).forEach((x: string) => free(x, "number in a service")); break;
    case "area": {
      const a = parseArea(td.text);
      a.zips.forEach((z) => { if (!said.z.includes(z) && !known.z.includes(z)) errs.push(`ZIP ${z} was not said by the customer`); });
      free(String(td.text ?? "").replace(/\b\d{5}\b/g, ""), "number in the area");
      break;
    }
    case "prices": for (const p of td.items ?? []) { num(String(p.price_usd), `price for "${p.name}"`); free(`${p.name} ${p.note ?? ""}`, "number in a price line"); } break;
    case "faq": for (const x of td.items ?? []) { free(x.q, "number in a question"); free(x.a, "number in an answer"); } break;
    case "hours": for (const d of DAYS) { const v = td.days?.[d]; if (v && !v.closed) { time(v.open, `${DAY_LABEL[d]} opening`); time(v.close, `${DAY_LABEL[d]} closing`); } } break;
    case "alerts": {
      (td.mobiles ?? []).forEach((m: string) => { const e = toE164(m); if (e && e !== "invalid") phone(e, "mobile"); });
      const knownEmails = new Set([...known.e, ...said.e]);
      (td.emails ?? []).forEach((e: string) => { if (!knownEmails.has(String(e).toLowerCase())) errs.push(`email ${e} was not given by the customer`); });
      if (td.daily_summary) time(td.daily_summary, "daily summary time");
      break;
    }
    case "on_call": { const e = toE164(td.number); if (e && e !== "invalid") phone(e, "on-call number"); break; }
    case "business_phone": { const e = toE164(td.number); if (e && e !== "invalid") phone(e, "business number"); break; }
    case "emergency": (td.keywords ?? []).forEach((k: string) => free(k, "number in an emergency word")); break;
    case "calendar": if (td.choice === "calendly" && !said.u.includes(normUrl(String(td.calendly_link ?? "")))) errs.push("the Calendly link was not given by the customer"); break;
    case "tools": if (!said.u.includes(normUrl(String(td.zapier_webhook_url ?? "")))) errs.push("the webhook URL was not given by the customer"); break;
  }
  return errs;
}

// ------------------------------------------------------------------ redaction (section 4.5)
function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}
/** Card numbers (13-19 digits passing Luhn), SSNs and "password: ..." are removed before storing or sending to the model. */
export function redact(text: string): { text: string; redacted: boolean } {
  let out = String(text ?? ""), hit = false;
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) { hit = true; return "[card number removed]"; }
    return m;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => { hit = true; return "[removed]"; });
  out = out.replace(/\b(pass(?:word|code)?|pwd|pin)\s*(?:is|[:=])\s*\S+/gi, () => { hit = true; return "[removed]"; });
  return { text: out, redacted: hit };
}

// ------------------------------------------------------------------ the forms' error wording (portal-b.js settingsErr)
export function settingsErr(code: string): string {
  const m = String(code ?? "");
  if (/not_your/.test(m)) return "You can only change your own settings.";
  const inv2 = /invalid_setting:(business\.timezone|booking\.job_types|emergency\.keywords|booking\.booking_link|booking\.provider|zapier\.webhook_url|business\.main_phone)/.exec(m);
  if (inv2) {
    return ({ "business.timezone": "Time zone wasn’t accepted. Pick one from the list.", "booking.job_types": "Services weren’t accepted (1 to 30 services, each up to 80 characters).",
      "emergency.keywords": "Emergency words weren’t accepted (up to 40 words, each up to 60 characters).", "booking.booking_link": "That Calendly link wasn’t accepted (https://calendly.com/your-name/event).",
      "booking.provider": "Choose Calendly or Google Calendar.", "zapier.webhook_url": "The Zapier webhook URL must start with https://",
      "business.main_phone": "Your business number should be a US phone number, like (713) 555-0100." } as Record<string, string>)[inv2[1]];
  }
  const inv = /invalid_setting:([\w.[\]]+)/.exec(m);
  if (inv) {
    const p = inv[1], n = /\[(\d+)\]/.exec(p), num = n ? " #" + (+n[1] + 1) : "";
    const what = /^faq/.test(p) ? "FAQ" + num + (/\.a$/.test(p) ? " answer (max 600 characters)" : /\.q$/.test(p) ? " question (max 300 characters)" : " (up to 25 questions)")
      : /^hours/.test(p) ? "Hours for " + (p.split(".")[1] || "a day") + " (opening must be before closing, HH:MM)"
      : /^notify\.sms/.test(p) ? "Text-alert number" + num + " (a US mobile number, up to 5)"
      : /^notify\.email/.test(p) ? "Alert email" + num + " (up to 5)"
      : /^notify\.daily/.test(p) ? "Daily summary time" : /^notify/.test(p) ? "Alerts (add at least one mobile number or email)"
      : /^after_hours/.test(p) ? "After-hours choice" : /^on_call/.test(p) ? "On-call number (a US phone number)" : p;
    return what + " wasn’t accepted. Please check it and save again.";
  }
  if (/data_too_large/.test(m)) return "This is too long to save. Please shorten some answers.";
  if (/calendar_not_connected/.test(m)) return "Connect your calendar account first, or choose “No calendar: take messages only”.";
  if (/called_directly/.test(m)) return "That call came straight from your business phone, so it doesn’t test forwarding. Call your business number from another phone.";
  if (/no_test_call/.test(m)) return "We haven’t seen a test call yet. Press “Test call” and call your business number.";
  if (/no_forwarding_number/.test(m)) return "Your forwarding number isn’t ready yet. We’ll email you when it is.";
  return "That didn’t save. Please try again, or use the form.";
}

// ------------------------------------------------------------------ cards
const TZ_NAME: Record<string, string> = { "America/New_York": "Eastern", "America/Detroit": "Eastern", "America/Chicago": "Central",
  "America/Denver": "Mountain", "America/Phoenix": "Arizona", "America/Los_Angeles": "Pacific", "America/Anchorage": "Alaska", "Pacific/Honolulu": "Hawaii" };
export const tzLabel = (tz: string) => (TZ_NAME[tz] ? `${TZ_NAME[tz]} time` : tz.replace(/_/g, " "));
export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
/** "Mon–Thu 7:00 AM–6:00 PM · Fri 7:00 AM–4:00 PM · Sat 8:00 AM–12:00 PM · Sun closed" */
export function hoursText(hours: Record<string, Json>): string {
  const parts: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    const v = hours[DAYS[i]] ?? null, key = JSON.stringify(v);
    let j = i;
    while (j + 1 < DAYS.length && JSON.stringify(hours[DAYS[j + 1]] ?? null) === key) j++;
    const days = i === j ? DAY_LABEL[DAYS[i]] : `${DAY_LABEL[DAYS[i]]}–${DAY_LABEL[DAYS[j]]}`;
    parts.push(Array.isArray(v) ? `${days} ${fmtTime(v[0])}–${fmtTime(v[1])}` : `${days} closed`);
    i = j + 1;
  }
  return parts.join(" · ");
}
export interface Field { key: string; label: string; kind: string; value: Json; text: string }
const label = (opts: Array<[string, string]>, k: string) => (opts.find((o) => o[0] === k) ?? [k, k])[1];

/** summary_card content for a converted proposal (title, fields with ready texts, optional note). */
export function cardFor(topic: Topic, patch: Record<string, Json>, s: Snapshot, note?: string): { title: string; fields: Field[]; note?: string } {
  const f = (key: string, lbl: string, kind: string, value: Json, text: string): Field => ({ key, label: lbl, kind, value, text: text.slice(0, 4000) });
  let fields: Field[] = [], n = note;
  switch (topic) {
    case "services": fields = [f("services", "Services", "list", patch.services, patch.services.join(" · "))]; break;
    case "area": {
      const a = parseArea(patch.service_area);
      fields = [f("service_area", "Area", "text", patch.service_area, [a.places.join(", "), a.zips.length ? "ZIPs " + a.zips.join(", ") : ""].filter(Boolean).join(" · "))];
      n = n ?? "Callers outside these get a polite “we don’t cover that area”.";
      break;
    }
    case "prices":
      fields = [f("fixed_prices", "Prices", "prices", parsePrices(patch.fixed_prices),
        patch.price_on_phone === "no" ? "No prices on the phone: your team gives prices." : parsePrices(patch.fixed_prices).map((p) =>
          `${p.name}: $${p.price_usd}${p.note ? ` (${p.note})` : ""}`).join(" · "))];
      if (patch.price_on_phone === "fixed") n = n ?? "Anything else is handed to you.";
      break;
    case "re_leads": fields = [f("re_lead_types", "Leads", "list", patch.re_lead_types, patch.re_lead_types.map((k: string) => label(RE_LEAD_TYPES, k)).join(" · "))]; break;
    case "re_screening":
      fields = [f("re_qualify", "Every caller is asked", "list", patch.re_qualify,
        patch.re_qualify.length ? patch.re_qualify.map((k: string) => label(RE_QUALIFY, k)).join(" · ") : "Only whether they are buying, selling or renting")];
      n = n ?? FAIR_HOUSING;
      break;
    case "faq": fields = [f("faq", `Questions & answers (${patch.faq.length})`, "faq", patch.faq,
      patch.faq.map((x: Json, i: number) => `${i + 1}. ${x.q} ${x.a}`).join("\n"))]; break;
    case "hours": fields = [f("hours", `Hours (${tzLabel(s.timezone)})`, "hours", patch.hours, hoursText(patch.hours))]; break;
    case "after_hours": fields = [f("after_hours", "After hours", "choice", patch.after_hours.mode, label(AFTER_HOURS, patch.after_hours.mode))]; break;
    case "alerts": {
      const nt = patch.notify;
      fields = [f("email", "Lead alerts by email", "list", nt.email, nt.email.join(", ") || "none"),
        f("sms", "Text alerts", "list", nt.sms, nt.sms.map(fmtPhone).join(", ") || "none"),
        f("daily_summary", "Daily summary", "time", nt.daily_summary, nt.daily_summary ? fmtTime(nt.daily_summary) : "off")];
      if (nt.sms.length && !s.texting_on) n = n ?? "Texts start once business texting is approved; until then alerts come by email.";
      break;
    }
    case "on_call": fields = [f("on_call_number", "On-call number", "phone", patch.on_call_number,
      patch.on_call_number ? fmtPhone(patch.on_call_number) : "None: urgent calls become messages")]; break;
    case "emergency": fields = [f("keywords", "Emergency words", "list", patch.emergency.keywords, patch.emergency.keywords.join(", "))];
      n = n ?? "If a caller says one, you’re alerted right away (and anyone in danger is told to call 911 first).";
      break;
    case "calendar": fields = [patch.booking_mode === "messages_only"
      ? f("booking_mode", "Calendar", "choice", "messages_only", "No calendar: take messages only")
      : f("booking_link", "Calendly link", "url", patch.booking_link, patch.booking_link)]; break;
    case "tools": fields = [f("zapier_webhook_url", "Zapier webhook", "url", patch.zapier_webhook_url, patch.zapier_webhook_url)]; break;
    case "business_phone": fields = [f("business_phone", "Business number", "phone", patch.business_phone, fmtPhone(patch.business_phone))]; break;
  }
  return { title: topic === "hours" ? `Business hours, ${tzLabel(s.timezone)}` : TITLES[topic], fields, ...(n ? { note: n } : {}) };
}

// ------------------------------------------------------------------ forwarding test state (portal-b.js forwardStateHtml)
export function testState(s: Snapshot, now = Date.now()): "ready" | "waiting" | "unverified" | "direct" | "mismatch" | "passed" | "no_number" {
  const it = itemOf(s, "forward_calls");
  if (it?.status === "done") return "passed";
  if (!s.tenant?.twilio_number) return "no_number";
  const d = it?.data ?? {};
  if (d.test_mismatch_from && (!d.test_unverified_at || d.test_mismatch_at >= d.test_unverified_at)) return "mismatch";
  if (d.test_unverified_at) return d.test_direct ? "direct" : "unverified";
  if (d.test_started_at && Date.parse(d.test_started_at) > now - 30 * 60000) return "waiting";
  return "ready";
}
