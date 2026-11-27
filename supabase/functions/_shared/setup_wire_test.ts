// Wire formats (setup_wire.ts): both read back into exactly the internal ops the engine consumes; what the model may write
// is valid against the schema sent; the schemas are small and use only keywords structured outputs accepts; bad input in
// either format is refused by the same strict internal validation.
// deno-lint-ignore-file no-explicit-any
import { parseTurn, systemFor } from "./setup_prompt.ts";
import { buildParams, schemaFor } from "./setup_model.ts";
import { validate } from "./setup_schema.ts";
import { COMPACT_WIRE_SCHEMA, fromWire, JSON_WIRE_SCHEMA, toWire, wireFormat } from "./setup_wire.ts";
import { assert, eq } from "./test_util.ts";
import { days } from "./setup_fixtures_test.ts";

const P = (topic: string, data: any) => ({ op: "propose", topic, data });
// one turn per op type and per topic, in the internal shape the engine consumes
const CORPUS: any[] = [
  { reply: "Here's what I understood.", ops: [P("services", { items: ["Drain cleaning", "Water heater repair"] })] },
  { reply: "a", ops: [P("area", { text: "Houston, Bellaire, 77005" }), { op: "note", topic: "on_call", facts: "on-call 713 555 0177" }] },
  { reply: "b", ops: [P("prices", { mention: true, items: [{ name: "Service call", price_usd: 89, note: "" }, { name: "Tune-up", price_usd: 79.99, note: "per unit" }] })] },
  { reply: "c", ops: [P("prices", { mention: false, items: [] })] },
  { reply: "d", ops: [P("re_leads", { types: ["buyers", "renters"] }), P("re_screening", { ask: ["timeline", "budget"] })] },
  { reply: "e", ops: [P("faq", { items: [{ q: "Licensed?", a: "Yes, TX license M-12345." }] })] },
  { reply: "f", ops: [P("hours", { days: days({ mon: ["07:00", "18:00"], fri: ["07:00", "16:00"], sat: ["08:00", "12:00"] }) })] },
  { reply: "g", ops: [P("after_hours", { mode: "emergency_dial" }), P("on_call", { number: null }), P("on_call", { number: "713 555 0177" })] },
  { reply: "h", ops: [P("alerts", { emails: ["maria@lopezplumbing.com"], mobiles: ["713 555 0111"], daily_summary: "19:00" }),
    P("alerts", { emails: [], mobiles: ["7135550111"], daily_summary: null }), P("emergency", { keywords: ["flooding", "no hot water"] })] },
  { reply: "i", ops: [P("calendar", { choice: "calendly", calendly_link: "https://calendly.com/lopez/visit" }), P("calendar", { choice: "messages_only", calendly_link: null })] },
  { reply: "j", ops: [P("tools", { zapier_webhook_url: "https://hooks.zapier.com/hooks/catch/1/abc/" }), P("business_phone", { number: "(713) 555-0100" })] },
  { reply: "k", ops: [{ op: "confirm", proposal_id: "8d4e2f9c-1111-4222-8333-944455556666" }, { op: "switch_topic", topic: "hours" }, { op: "skip", topic: "area" }] },
  { reply: "l", ops: [{ op: "set_carrier", carrier: "verizon" }, { op: "show_action", action: "connect_calendar", provider: "google" },
    { op: "show_action", action: "open_form", provider: null }, { op: "request_help", message: "Can a person call me?" }] },
  { reply: "m", ops: [] },
];

for (const wire of ["compact", "json"] as const) {
  Deno.test(`[${wire}] every op and topic: internal -> wire -> internal is exact, and the wire form is valid against the schema sent`, () => {
    for (const t of CORPUS) {
      const w = toWire(wire, t);
      eq(validate(schemaFor(wire), w), [], `wire form of "${t.reply}"`);
      const back = fromWire(wire, w);
      assert(back.ok, JSON.stringify(back));
      eq((back as any).turn, t, `round trip "${t.reply}"`);
      const p = parseTurn(w, wire);
      assert(p.ok, `${t.reply}: ${JSON.stringify(p)}`);
      eq((p as any).ops, t.ops, "the engine gets the same ops in both formats");
    }
  });
  Deno.test(`[${wire}] the strict internal rules still apply: foreign keys, bad values, unknown ops, too many ops`, () => {
    const bad = [
      { reply: "x", ops: [P("hours", { days: days({}), tenant_id: "t" })] },
      { reply: "x", ops: [{ op: "propose", topic: "hours", data: { days: days({}) }, client_id: "c" }] },
      { reply: "x", ops: [P("prices", { mention: true, items: [{ name: "a", price_usd: 200001, note: "" }] })] },
      { reply: "x", ops: [{ op: "set_carrier", carrier: "evilcorp" }] },
      { reply: "x", ops: [{ op: "write_setting" }] },
      { reply: "x", ops: [P("billing", { plan: "FR_BUSINESS" })] },
      { reply: "x", ops: Array(5).fill({ op: "skip", topic: "area" }) },
      { reply: "x", ops: [], extra: 1 },
    ];
    for (const t of bad) assert(!parseTurn(toWire(wire, t), wire).ok, JSON.stringify(t).slice(0, 80));
  });
}

Deno.test("[compact] what a model writes: 7 day strings, empty fields for other topics, unreadable hours refused", () => {
  const empty = { list: [], text: "", mention: false, prices: [], faq: [], hours: [], choice: "", emails: [], mobiles: [], time: "", number: "", link: "" };
  const op = (data: any) => ({ reply: "ok", ops: [{ op: "propose", topic: "hours", proposal_id: null, text: null, value: null, data }] });
  const hours = ["mon 07:00-18:00", "tue 07:00-18:00", "wed 07:00-18:00", "thu 07:00-18:00", "fri 07:00-16:00", "sat 08:00-12:00", "sun closed"];
  const p: any = parseTurn(op({ ...empty, hours }), "compact");
  assert(p.ok);
  eq(p.ops[0].data.days.fri, { closed: false, open: "07:00", close: "16:00" }); eq(p.ops[0].data.days.sun, { closed: true, open: "", close: "" });
  assert(!parseTurn(op({ ...empty, hours: hours.slice(0, 6) }), "compact").ok, "a missing day is refused (no silent 'closed')");
  assert(!parseTurn(op({ ...empty, hours: ["monday 7-6", ...hours.slice(1)] }), "compact").ok, "unreadable day strings are refused");
  assert(!parseTurn(op({ ...empty, hours, secret: 1 }), "compact").ok, "unknown data fields are refused");
});
Deno.test("[json] what a model writes: data_json parsed; malformed or non-object JSON refused", () => {
  const op = (data_json: any) => ({ reply: "ok", ops: [{ op: "propose", topic: "services", proposal_id: null, text: null, value: null, data_json }] });
  const p: any = parseTurn(op('{"items": ["Drain cleaning"]}'), "json");
  assert(p.ok); eq(p.ops[0].data, { items: ["Drain cleaning"] });
  const broken = parseTurn(op('{"items": ["Drain'), "json");
  assert(!broken.ok && (broken as any).errors[0].includes("data_json: not valid JSON"));
  assert(!parseTurn(op('["Drain cleaning"]'), "json").ok);
  assert(!parseTurn(op(null), "json").ok, "propose without data");
});
Deno.test("wire schemas: small, closed, only keywords structured outputs accepts; the switch and the prompts", () => {
  const sizes = { compact: JSON.stringify(COMPACT_WIRE_SCHEMA).length, json: JSON.stringify(JSON_WIRE_SCHEMA).length };
  console.log(`wire schema bytes: compact ${sizes.compact}, json ${sizes.json} (the full schema that failed: 7836)`);
  assert(sizes.compact < 1800 && sizes.json < 500, JSON.stringify(sizes));
  const banned = ["maxLength", "minLength", "pattern", "minimum", "maximum", "maxItems", "minItems", "anyOf"];
  for (const [w, sch] of Object.entries({ compact: COMPACT_WIRE_SCHEMA, json: JSON_WIRE_SCHEMA })) {
    const text = JSON.stringify(sch);
    for (const k of banned) if (!(w === "compact" && k === "anyOf")) assert(!text.includes(`"${k}"`), `${w} uses ${k}`);
    if (w === "compact") eq(text.split('"anyOf"').length - 1, 1, "compact: a single anyOf (data or null)");
  }
  eq([wireFormat(() => undefined), wireFormat(() => "compact"), wireFormat(() => " JSON "), wireFormat(() => "full")], ["json", "compact", "json", "json"]);
  const pc: any = buildParams({ messages: [] }, "compact"), pj: any = buildParams({ messages: [] }, "json");
  eq([pc.output_config.format.schema, pj.output_config.format.schema], [COMPACT_WIRE_SCHEMA, JSON_WIRE_SCHEMA]);
  eq([pc.system[0].text, pj.system[0].text], [systemFor("compact"), systemFor("json")]);
  assert(systemFor("compact").includes("DATA FIELDS BY TOPIC") && !systemFor("compact").includes("data_json"));
  assert(systemFor("json").includes("data_json") && !systemFor("json").includes("DATA FIELDS BY TOPIC"));
  for (const w of ["compact", "json"] as const) {
    assert(systemFor(w).includes("carrier keys: verizon, att, tmobile"), "the carrier keys are in the prompt (no enum in the schema)");
    eq(systemFor(w), systemFor(w), "static per format (cache-friendly)");
    assert(systemFor(w).startsWith("You are the FirstRing setup assistant, an AI."));
  }
});
