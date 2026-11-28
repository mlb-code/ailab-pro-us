// What the model is asked to write (the "wire" format), and the way back to the engine's internal ops.
// The full internal schema (setup_prompt.ts SETUP_TURN_SCHEMA, 21 anyOf branches) is too large for the structured-output
// grammar compiler ("The compiled grammar is too large"), so the API gets one of two small formats instead, chosen per
// deploy by the env SETUP_WIRE (default "compact", 2026-11-28: its typed topic fields are constrained by the grammar, so the
// model cannot hand back malformed topic data the way a free JSON string can; both passed the live trial):
//   compact  one flat op object: op enum, topic enum|null, proposal_id, text, value, data|null; data = the union of the leaf
//            fields of every topic, none nullable, no nested anyOf (hours = 7 strings "mon 07:00-18:00" / "sun closed")
//   json     the smallest grammar: every op field a string|null; the topic data travels as JSON text in data_json
// Both are normalized into the SAME internal op objects and then validated by the unchanged strict SETUP_TURN_SCHEMA, so the
// engine, the security checks and the provenance check do not depend on the wire format.
// deno-lint-ignore-file no-explicit-any
import { ALL_TOPICS, CARRIER_KEYS, DAYS } from "./setup_rules.ts";
import type { Schema } from "./setup_schema.ts";

export type Wire = "compact" | "json" | "internal";   // "internal" = the engine's own shape (tests only; never from the env)
export const WIRE_ENV = "SETUP_WIRE";
export const DEFAULT_WIRE: "compact" | "json" = "compact";
export const OP_NAMES = ["propose", "note", "confirm", "switch_topic", "skip", "set_carrier", "show_action", "request_help"] as const;

/** SETUP_WIRE=compact|json; anything else (or unset) = the default. */
export function wireFormat(get: (k: string) => string | undefined = envGet): "compact" | "json" {
  const v = (get(WIRE_ENV) ?? "").trim().toLowerCase();
  return v === "compact" || v === "json" ? v : DEFAULT_WIRE;
}
function envGet(k: string) { try { return Deno.env.get(k); } catch { return undefined; } }

// ------------------------------------------------------------------ the two schemas as sent
const S = { type: "string" }, NS = { type: ["string", "null"] }, SA = { type: "array", items: { type: "string" } };
const closed = (properties: Record<string, Schema>): Schema =>
  ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const COMPACT_WIRE_SCHEMA: Schema = {
  ...closed({ reply: S, ops: { type: "array", items: { $ref: "#/$defs/op" } } }),
  $defs: {
    op: closed({ op: { enum: [...OP_NAMES] }, topic: { enum: [...ALL_TOPICS, null] }, proposal_id: NS, text: NS, value: NS,
      data: { anyOf: [{ $ref: "#/$defs/data" }, { type: "null" }] } }),
    data: closed({ list: SA, text: S, mention: { type: "boolean" }, prices: { type: "array", items: closed({ name: S, price_usd: { type: "number" }, note: S }) },
      faq: { type: "array", items: closed({ q: S, a: S }) }, hours: SA, choice: S, emails: SA, mobiles: SA, time: S, number: S, link: S }),
  },
};
export const JSON_WIRE_SCHEMA: Schema = closed({ reply: S, ops: { type: "array",
  items: closed({ op: S, topic: NS, proposal_id: NS, text: NS, value: NS, data_json: NS }) } });

// ------------------------------------------------------------------ the format part of the system prompt (static per deploy)
const CARRIERS_LINE = `carrier keys: ${CARRIER_KEYS.join(", ")}.`;
const OP_FIELDS = (dataField: string) => `Each op is one flat object with all of these fields: op, topic, proposal_id, text, value, ${dataField} (null when not used).
- note: topic + text (the facts, in the customer's words). confirm: proposal_id. switch_topic and skip: topic.
- set_carrier: value = the carrier key. show_action: value = connect_calendar | forwarding_instructions | test_call | open_form, and text = google or calendly for connect_calendar. request_help: text = the customer's message.
${CARRIERS_LINE}`;
export const FORMAT_TEXT: Record<"compact" | "json", string> = {
  compact: `FORMAT
${OP_FIELDS("data")}
- propose: topic + data. data always has every field below; fill the ones for the topic and leave the others empty ("" or [] or false).

DATA FIELDS BY TOPIC
services: list = the jobs the receptionist books (real estate: the meeting types). area: text = cities, counties, neighborhoods or ZIP codes. prices: mention (false = no prices may be said) and prices = [{name, price_usd (a number), note}]. faq: faq = [{q, a}], numbered as given. hours: hours = exactly 7 strings, Monday to Sunday, like "mon 07:00-18:00" or "sun closed" (24-hour HH:MM). after_hours: choice = book_next_day | message_only | emergency_dial. alerts: emails, mobiles (as typed), time = the daily summary as HH:MM, or "" for none. on_call: number, or "" for none. emergency: list = the words. re_leads: list from buyers, sellers, renters, investors. re_screening: list from timeline, preapproval, budget, areas, property. calendar: choice = google | calendly | messages_only, link = the Calendly booking link. tools: link = the Zapier webhook URL. business_phone: number.`,
  json: `FORMAT
${OP_FIELDS("data_json")}
- propose: topic + data_json = the topic data as one JSON object written as a string, for example "{\\"items\\": [\\"Drain cleaning\\"]}".

TOPIC DATA (the JSON object inside data_json)
services: {"items": ["..."]} (the jobs; real estate: the meeting types). area: {"text": "cities, counties, neighborhoods or ZIP codes"}. prices: {"mention": false, "items": []} if no prices may be said, else {"mention": true, "items": [{"name": "...", "price_usd": 89, "note": ""}]}. faq: {"items": [{"q": "...", "a": "..."}]}, numbered as given. hours: {"days": {"mon": {"closed": false, "open": "07:00", "close": "18:00"}, ...}} with all 7 days mon..sun; a closed day is {"closed": true, "open": "", "close": ""}; 24-hour HH:MM. after_hours: {"mode": "book_next_day" | "message_only" | "emergency_dial"}. alerts: {"emails": [], "mobiles": [] (as typed), "daily_summary": "19:00" or null}. on_call: {"number": "..." or null}. emergency: {"keywords": []}. re_leads: {"types": [] from buyers, sellers, renters, investors}. re_screening: {"ask": [] from timeline, preapproval, budget, areas, property}. calendar: {"choice": "google" | "calendly" | "messages_only", "calendly_link": "..." or null}. tools: {"zapier_webhook_url": "..."}. business_phone: {"number": "..."}.`,
};

// ------------------------------------------------------------------ wire -> internal
const INTERNAL_KEYS: Record<string, string[]> = { propose: ["op", "topic", "data"], note: ["op", "topic", "facts"], confirm: ["op", "proposal_id"],
  switch_topic: ["op", "topic"], skip: ["op", "topic"], set_carrier: ["op", "carrier"], show_action: ["op", "action", "provider"], request_help: ["op", "message"] };
const WIRE_KEYS = { compact: ["op", "topic", "proposal_id", "text", "value", "data"], json: ["op", "topic", "proposal_id", "text", "value", "data_json"] };
const DATA_KEYS = ["list", "text", "mention", "prices", "faq", "hours", "choice", "emails", "mobiles", "time", "number", "link"];
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const orNull = (v: any) => (v === "" || v === undefined ? null : v);
const HOURS_RX = new RegExp(`^(${DAYS.join("|")})\\s+(?:(closed)|(\\S+?)\\s*-\\s*(\\S+))$`, "i");

/** compact data -> the topic's internal data. Unknown keys are kept so the strict validator refuses them. */
function compactToTopic(topic: string, d: any): any {
  if (!isObj(d)) return d ?? undefined;
  const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !DATA_KEYS.includes(k)));
  const td = ((): any => {
    switch (topic) {
      case "services": return { items: d.list };
      case "area": return { text: d.text };
      case "prices": return { mention: d.mention, items: d.prices };
      case "re_leads": return { types: d.list };
      case "re_screening": return { ask: d.list };
      case "faq": return { items: d.faq };
      case "hours": {
        if (!Array.isArray(d.hours)) return { days: d.hours };
        const days: Record<string, any> = {};
        for (const line of d.hours) {
          const m = HOURS_RX.exec(String(line).trim());
          if (!m) { days[`unreadable_${Object.keys(days).length}`] = line; continue; }   // refused by the validator -> repair
          days[m[1].toLowerCase()] = m[2] ? { closed: true, open: "", close: "" } : { closed: false, open: m[3], close: m[4] };
        }
        return { days };
      }
      case "after_hours": return { mode: d.choice };
      case "alerts": return { emails: d.emails, mobiles: d.mobiles, daily_summary: orNull(d.time) };
      case "on_call": return { number: orNull(d.number) };
      case "emergency": return { keywords: d.list };
      case "calendar": return { choice: d.choice, calendly_link: orNull(d.link) };
      case "tools": return { zapier_webhook_url: d.link };
      case "business_phone": return { number: d.number };
      default: return {};
    }
  })();
  return { ...td, ...extra };
}
/** One wire op -> one internal op. Fields an op does not use are ignored; unknown fields are kept (and then refused). */
function fromWireOp(wire: "compact" | "json", o: any, i: number, errs: string[]): any {
  if (!isObj(o)) return o;
  const extra = Object.fromEntries(Object.entries(o).filter(([k]) => !WIRE_KEYS[wire].includes(k)));
  let data: any;
  if (wire === "json") {
    if (typeof o.data_json === "string" && o.data_json.trim()) {
      try { data = JSON.parse(o.data_json); } catch { errs.push(`$.ops[${i}].data_json: not valid JSON`); }
    } else data = undefined;
  } else data = compactToTopic(String(o.topic ?? ""), o.data);
  const base = ((): any => {
    switch (o.op) {
      case "propose": return { op: o.op, topic: o.topic, data };
      case "note": return { op: o.op, topic: o.topic, facts: o.text };
      case "confirm": return { op: o.op, proposal_id: o.proposal_id };
      case "switch_topic": case "skip": return { op: o.op, topic: o.topic };
      case "set_carrier": return { op: o.op, carrier: o.value };
      case "show_action": return { op: o.op, action: o.value, provider: o.text ?? null };
      case "request_help": return { op: o.op, message: o.text };
      default: return { op: o.op };
    }
  })();
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];   // missing = "required" error later
  return { ...base, ...extra };
}
/** The model's output in a wire format -> the internal turn {reply, ops}, or why it cannot be read at all. */
export function fromWire(wire: Wire, raw: unknown): { ok: true; turn: any } | { ok: false; errors: string[] } {
  if (wire === "internal") return { ok: true, turn: raw };
  if (!isObj(raw)) return { ok: false, errors: ["output is not a JSON object"] };
  const errs: string[] = [];
  const ops = Array.isArray(raw.ops) ? raw.ops.map((o: any, i: number) => fromWireOp(wire, o, i, errs)) : raw.ops;
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, turn: { ...raw, ops } };
}

// ------------------------------------------------------------------ internal -> wire (history replay; tests)
function topicToCompact(topic: string, td: any): any {
  const d: any = { list: [], text: "", mention: false, prices: [], faq: [], hours: [], choice: "", emails: [], mobiles: [], time: "", number: "", link: "" };
  if (!isObj(td)) return td;
  const known: Record<string, string[]> = { services: ["items"], area: ["text"], prices: ["mention", "items"], re_leads: ["types"], re_screening: ["ask"],
    faq: ["items"], hours: ["days"], after_hours: ["mode"], alerts: ["emails", "mobiles", "daily_summary"], on_call: ["number"], emergency: ["keywords"],
    calendar: ["choice", "calendly_link"], tools: ["zapier_webhook_url"], business_phone: ["number"] };
  switch (topic) {
    case "services": d.list = td.items; break;
    case "area": d.text = td.text; break;
    case "prices": d.mention = td.mention; d.prices = td.items; break;
    case "re_leads": d.list = td.types; break;
    case "re_screening": d.list = td.ask; break;
    case "faq": d.faq = td.items; break;
    case "hours": d.hours = DAYS.filter((x) => td.days?.[x]).map((x) => td.days[x].closed ? `${x} closed` : `${x} ${td.days[x].open}-${td.days[x].close}`); break;
    case "after_hours": d.choice = td.mode; break;
    case "alerts": d.emails = td.emails; d.mobiles = td.mobiles; d.time = td.daily_summary ?? ""; break;
    case "on_call": d.number = td.number ?? ""; break;
    case "emergency": d.list = td.keywords; break;
    case "calendar": d.choice = td.choice; d.link = td.calendly_link ?? ""; break;
    case "tools": d.link = td.zapier_webhook_url; break;
    case "business_phone": d.number = td.number; break;
  }
  for (const [k, v] of Object.entries(td)) if (!(known[topic] ?? []).includes(k)) d[k] = v;   // foreign keys travel along
  return d;
}
function toWireOp(wire: "compact" | "json", op: any): any {
  if (!isObj(op)) return op;
  const w: any = { op: op.op, topic: null, proposal_id: null, text: null, value: null, [wire === "json" ? "data_json" : "data"]: null };
  switch (op.op) {
    case "propose": w.topic = op.topic;
      if (wire === "json") w.data_json = op.data === undefined ? null : JSON.stringify(op.data); else w.data = topicToCompact(op.topic, op.data);
      break;
    case "note": w.topic = op.topic; w.text = op.facts; break;
    case "confirm": w.proposal_id = op.proposal_id; break;
    case "switch_topic": case "skip": w.topic = op.topic; break;
    case "set_carrier": w.value = op.carrier; break;
    case "show_action": w.value = op.action; w.text = op.provider ?? null; break;
    case "request_help": w.text = op.message; break;
  }
  for (const [k, v] of Object.entries(op)) if (!(INTERNAL_KEYS[op.op] ?? ["op"]).includes(k)) w[k] = v;
  return w;
}
/** The internal turn written the way the model writes it in this format. */
export function toWire(wire: Wire, turn: unknown): unknown {
  if (wire === "internal" || !isObj(turn)) return turn;
  return { ...turn, ops: Array.isArray(turn.ops) ? turn.ops.map((o: any) => toWireOp(wire, o)) : turn.ops };
}
