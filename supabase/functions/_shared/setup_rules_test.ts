// Setup assistant rules (design step 0b): the full-item invariant on the onboarding parity cases, parity of the ported
// readers with onboarding-config.js, converters + completeness, provenance, redaction, wording, topic order.
// deno-lint-ignore-file no-explicit-any
import {
  cardFor, currentTopic, fromConfig, hoursText, ITEM_PATHS, parseArea, parsePrices, pathValues, priceLine, provenance, addProv, emptyProv, redact,
  settingsErr, type Snapshot, testState, toE164, topicToData, topicsFor, fullItemData,
} from "./setup_rules.ts";
import { isAffirmative } from "./setup_engine.ts";
import { assert, eq } from "./test_util.ts";
import { days, defaultConfig, onboardingConfig } from "./setup_fixtures_test.ts";

const OC = onboardingConfig();
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ niche: "home_services", timezone: "America/Chicago", cfg: defaultConfig(), items:
  ["hours", "faq", "alerts", "calendar", "tools", "forward_calls"].map((k, i) => ({ id: "i" + i, key: k, status: "todo", data: {} })),
  tenant: { id: "t", twilio_number: "+13465550199" }, owner_name: "Maria Lopez", business_name: "Lopez Plumbing", plan_code: "FR_PRO", texting_on: false, ...over });

// the parity runner's cases (supabase/tests/offline/onboarding_parity_run.ts), applied to the base config
const base = { business: { name: "Cool Breeze HVAC", niche: "home_services", timezone: "America/Chicago", main_phone: "+17135550100" },
  hours: { mon: ["08:00", "17:00"] }, booking: { provider: "calendly", windows: [["08:00", "12:00"]], job_types: ["Service call"] },
  notify: { sms: [], email: ["a@example.com"] } };
const re = { ...base, business: { ...base.business, niche: "real_estate" } };
const CASES: Array<[string, any, any?]> = [
  ["hours", { timezone: "America/New_York", hours: { mon: ["07:00", "18:00"], sat: null }, after_hours: { mode: "message_only" } }],
  ["faq", { services: ["AC repair", " Furnace "], faq: [{ q: "Trane?", a: "Yes." }], service_area: "77005, 77006; Bellaire, harris county, Harris County\nWest U 77005",
    price_on_phone: "fixed", fixed_prices: ["Service call: $89", "Drain cleaning - 150", "AC tune-up $79.99 (per unit)", "Tune-up – 60", "call us", "Big $200000"] }],
  ["faq", { price_on_phone: "fixed", fixed_prices: ["ask"] }], ["faq", { price_on_phone: "no" }],
  ["faq", { re_lead_types: ["renters"], re_qualify: ["budget", "timeline"] }, re], ["faq", { re_lead_types: ["buyers"], re_qualify: [] }, re],
  ["alerts", { notify: { sms: ["+17135550111"], email: ["x@example.com"], daily_summary: null }, on_call_number: "+17135550188", emergency: { keywords: [" gas smell ", "flooding"] } }],
  ["alerts", { on_call_number: null }], ["calendar", { booking_mode: "messages_only" }], ["calendar", { provider: "calendly", booking_link: "https://calendly.com/coolbreeze/visit" }],
  ["tools", { zapier_webhook_url: "https://hooks.zapier.com/hooks/catch/1/abc/" }], ["tools", { zapier_webhook_url: null }], ["forward_calls", { business_phone: "+17135550199" }],
];

Deno.test("full-item invariant: patch(key, fromConfig(key, cfg), cfg) == cfg on every path the item touches (parity cases + defaults)", () => {
  const configs: Array<[string, any, any]> = [["default HS", defaultConfig(), {}], ["default RE", defaultConfig("real_estate"), {}]];
  for (const [key, data, cfg = base] of CASES) configs.push([`${key} ${JSON.stringify(data).slice(0, 40)}`, OC.patch(key, data, cfg), data]);
  let checked = 0;
  for (const [name, cfg, itemData] of configs) {
    const niche = cfg.business?.niche === "real_estate" ? "real_estate" : "home_services";
    for (const key of Object.keys(ITEM_PATHS)) {
      if (key === "calendar") continue;   // calendar keys are always written whole by the calendar topic
      const d = fromConfig(key, cfg, itemData, niche as any);
      const after = OC.patch(key, d, cfg);
      eq(pathValues(key, after), pathValues(key, cfg), `${name} / ${key}`);
      checked++;
    }
  }
  assert(checked >= 60, "enough combinations");
});
Deno.test("a chat write over a stale item never brings old values back (the receptionist tab changed the config)", () => {
  const s = snap();
  const live = OC.patch("faq", { faq: [{ q: "New Q?", a: "New answer." }], services: ["Live service"] }, defaultConfig());
  s.cfg = live;
  const item = { id: "f", key: "faq", status: "todo" as const, data: { faq: [{ q: "Old?", a: "Old." }], services: ["Old service"] } };
  const conv = topicToData("prices", { mention: false, items: [] }, s);
  assert(conv.ok);
  const data = fullItemData("prices", (conv as any).patch, item, s);
  eq([data.faq, data.services], [[{ q: "New Q?", a: "New answer." }], ["Live service"]], "other keys come from the live config");
  const after = OC.patch("faq", { ...item.data, ...data }, live);
  eq([after.faq, after.booking.job_types, after.pricing.mode], [[{ q: "New Q?", a: "New answer." }], ["Live service"], "none"]);
});
Deno.test("ported readers equal onboarding-config.js (= SQL parse_price_lines / parse_service_area)", () => {
  const lines = ["Service call: $89", "Drain cleaning - 150", "AC tune-up $79.99 (per unit)", "Tune-up – 60", "call us", "Big $200000", " $5 ", "Name: $1,000"];
  eq(parsePrices(lines), OC.parsePrices(lines));
  for (const a of ["77005, 77006; Bellaire, harris county, Harris County\nWest U 77005", "", "Houston", "zip 77001.", "a;b;c 12345"]) eq(parseArea(a), OC.parseArea(a), a);
});
Deno.test("price lines round-trip through the server's reader; area text round-trips", () => {
  for (const p of [{ name: "Service call", price_usd: 89, note: "" }, { name: "AC tune-up", price_usd: 79.99, note: "per unit" }, { name: "Drain cleaning - basic", price_usd: 150, note: "" }]) {
    eq(OC.parsePrices([priceLine(p)]), [p], priceLine(p));
  }
  const s = snap();
  for (const text of ["Houston, Bellaire, West University, 77005, 77401", "Katy; Sugar Land 77479"]) {
    const conv: any = topicToData("area", { text }, s);
    const cfg = OC.patch("faq", conv.patch, defaultConfig());
    const back = fromConfig("faq", cfg, {}).service_area;
    eq(OC.parseArea(back), OC.parseArea(text), "config -> text -> config is stable");
  }
});
Deno.test("converters: the forms' completeness rules, with the reason", () => {
  const s = snap();
  const reason = (t: any, d: any) => { const r: any = topicToData(t, d, s); return r.ok ? "ok" : r.reason; };
  eq(reason("services", { items: [] }), "The receptionist needs at least one service to book.");
  eq(reason("services", { items: ["x".repeat(81)] }).startsWith("invalid_setting:booking.job_types"), true);
  eq(reason("faq", { items: [] }), "Add at least one question and answer.");
  const many: any = topicToData("faq", { items: Array.from({ length: 30 }, (_, i) => ({ q: `Q${i}?`, a: "A." })) }, s);
  eq([many.patch.faq.length, many.note], [25, "I kept the first 25 (the limit). Tell me which to swap."]);
  eq(reason("faq", { items: [{ q: "Q", a: "y".repeat(601) }] }).startsWith("invalid_setting:faq[0].a"), true);
  eq(reason("hours", { days: days({ mon: ["18:00", "07:00"] }) }).startsWith("invalid_setting:hours.mon"), true);
  eq(reason("hours", { days: days({}) }), "Hours: at least one open day.");
  eq(reason("alerts", { emails: [], mobiles: [], daily_summary: null }), "Alerts: at least one email or mobile number.");
  eq(reason("alerts", { emails: [], mobiles: ["+44 7700 900123"], daily_summary: null }).startsWith("invalid_setting:notify.sms[0]"), true);
  eq(reason("calendar", { choice: "google", calendly_link: null }).startsWith("Google Calendar is connected with the Connect button"), true);
  eq(reason("calendar", { choice: "calendly", calendly_link: "http://calendly.com/x" }).startsWith("invalid_setting:booking.booking_link"), true);
  eq(reason("tools", { zapier_webhook_url: "http://hooks.zapier.com" }).startsWith("invalid_setting:zapier.webhook_url"), true);
  eq(reason("prices", { mention: true, items: [{ name: "Fee: $5 extra", price_usd: 5, note: "" }] }).includes("cannot be saved as a price line"), true);
  eq(reason("area", { text: "!!!" }), "No city, county, neighborhood or 5-digit ZIP code found in the area.");
  eq((topicToData("on_call", { number: "713 555 0177" }, s) as any).patch, { on_call_number: "+17135550177" });
  eq((topicToData("hours", { days: days({ mon: ["07:00", "18:00"] }) }, s) as any).patch.timezone, "America/Chicago", "time zone from sign-up, shown, not asked");
  // whatever passes the converter also passes the database rule set (onboarding-config.js == onboarding_patch)
  for (const [t, d] of [["services", { items: ["A", "B"] }], ["hours", { days: days({ sat: ["08:00", "12:00"] }) }], ["alerts", { emails: ["a@b.co"], mobiles: ["7135550111"], daily_summary: "19:00" }],
    ["emergency", { keywords: ["flood"] }], ["prices", { mention: true, items: [{ name: "Call", price_usd: 89, note: "" }] }], ["tools", { zapier_webhook_url: "https://hooks.zapier.com/x" }]] as const) {
    const r: any = topicToData(t as any, d, s);
    OC.patch(t === "hours" ? "hours" : t === "tools" ? "tools" : t === "alerts" || t === "emergency" ? "alerts" : "faq", r.patch, defaultConfig());
  }
});
Deno.test("toE164: the portal's rules (US numbers only)", () => {
  eq([toE164("(713) 555-0100"), toE164("713.555.0100"), toE164("1 713 555 0100"), toE164("+17135550100"), toE164(""), toE164("+447700900123"), toE164("555-0100"), toE164("011 555 0100")],
    ["+17135550100", "+17135550100", "+17135550100", "+17135550100", null, "invalid", "invalid", "invalid"]);
});
Deno.test("provenance: numbers, times, phones, emails and links must come from the customer, the config or a default", () => {
  const s = snap();
  const said = (t: string) => addProv(emptyProv(), t);
  eq(provenance("hours", { days: days({ mon: ["07:00", "18:00"], sat: ["08:00", "12:00"] }) }, said("mon-fri 7 to 6, saturday 8-12"), s), []);
  eq(provenance("hours", { days: days({ mon: ["09:00", "12:00"] }) }, said("9 till noon"), s), []);
  eq(provenance("hours", { days: days({ mon: ["07:30", "16:00"] }) }, said("7:30 to 4"), s), []);
  eq(provenance("hours", { days: days({ mon: ["08:00", "17:00"] }) }, said("the usual"), s), [], "default hours are known");
  eq(provenance("hours", { days: days({ mon: ["06:00", "17:00"] }) }, said("early till 5"), s), ["Mon opening 06:00 was not said by the customer (ask, do not guess)"]);
  eq(provenance("prices", { items: [{ name: "Service call", price_usd: 89, note: "" }] }, said("service call 89 bucks"), s), []);
  eq(provenance("prices", { items: [{ name: "Service call", price_usd: 1200, note: "" }] }, said("it's 1,200"), s), []);
  eq(provenance("prices", { items: [{ name: "Service call", price_usd: 99, note: "" }] }, said("service call 89"), s).length, 1);
  eq(provenance("area", { text: "Houston, 77005, 77099" }, said("houston 77005"), s), ["ZIP 77099 was not said by the customer"]);
  eq(provenance("faq", { items: [{ q: "Licensed?", a: "Yes, license M-12345." }] }, said("licensed - yes M-12345"), s), []);
  eq(provenance("faq", { items: [{ q: "Licensed?", a: "Yes, license M-99999, 15 years in business." }] }, said("yes we are licensed"), s).length, 2);
  eq(provenance("on_call", { number: "713-555-0177" }, said("call 713 555 0177"), s), []);
  eq(provenance("on_call", { number: "713-555-0188" }, said("call 713 555 0177"), s).length, 1);
  eq(provenance("business_phone", { number: "+17135550100" }, said("yes"), s), [], "the sign-up number is known");
  eq(provenance("alerts", { emails: ["maria@lopezplumbing.com"], mobiles: [], daily_summary: "19:00" }, said("just email"), s), [], "sign-up email + default summary");
  eq(provenance("alerts", { emails: ["boss@other.com"], mobiles: [], daily_summary: null }, said("just email"), s), ["email boss@other.com was not given by the customer"]);
  eq(provenance("calendar", { choice: "calendly", calendly_link: "https://calendly.com/lopez/visit" }, said("https://calendly.com/lopez/visit"), s), []);
  eq(provenance("calendar", { choice: "calendly", calendly_link: "https://calendly.com/other/visit" }, said("calendly.com/lopez/visit"), s).length, 1);
  eq(provenance("tools", { zapier_webhook_url: "https://hooks.zapier.com/hooks/catch/1/abc/" }, said("here: https://hooks.zapier.com/hooks/catch/1/abc/"), s), []);
});
Deno.test("redaction: Luhn card numbers, SSNs, passwords; phone numbers and prices stay", () => {
  eq(redact("card 4111-1111-1111-1111 ok").text, "card [card number removed] ok");
  eq(redact("4242424242424242").redacted, true);
  eq(redact("call 713 555 0100 or 713 555 0177, service call $89").redacted, false);
  eq(redact("1234 5678 9012 3456").redacted, false, "not a valid card number (Luhn)");
  eq(redact("ssn 123-45-6789").text, "ssn [removed]");
  eq(redact("my password is hunter2 and pin: 1234").text, "my [removed] and [removed]");
});
Deno.test("settingsErr: the forms' wording", () => {
  eq(settingsErr("invalid_setting:faq[2].a"), "FAQ #3 answer (max 600 characters) wasn’t accepted. Please check it and save again.");
  eq(settingsErr("invalid_setting:booking.booking_link"), "That Calendly link wasn’t accepted (https://calendly.com/your-name/event).");
  eq(settingsErr("calendar_not_connected"), "Connect your calendar account first, or choose “No calendar: take messages only”.");
  eq(settingsErr("not_your_item"), "You can only change your own settings.");
});
Deno.test("cards: hours grouped with the time zone; prices; alerts note while texting is off", () => {
  eq(hoursText({ mon: ["07:00", "18:00"], tue: ["07:00", "18:00"], wed: ["07:00", "18:00"], thu: ["07:00", "18:00"], fri: ["07:00", "16:00"], sat: ["08:00", "12:00"], sun: null }),
    "Mon–Thu 7:00 AM–6:00 PM · Fri 7:00 AM–4:00 PM · Sat 8:00 AM–12:00 PM · Sun closed");
  const s = snap();
  eq(cardFor("hours", { hours: { mon: ["09:00", "17:00"] } }, s).title, "Business hours, Central time");
  const a = cardFor("alerts", { notify: { email: ["a@b.co"], sms: ["+17135550111"], daily_summary: "19:00" } }, s);
  eq([a.fields[1].text, a.fields[2].text, a.note], ["(713) 555-0111", "7:00 PM", "Texts start once business texting is approved; until then alerts come by email."]);
});
Deno.test("typed confirmation: only a short, complete yes", () => {
  for (const y of ["yes", "Yes!", "yep", "ok", "OK thanks", "looks good", "Looks right.", "correct", "👍", "✅", "yes, that's right", "sure"]) assert(isAffirmative(y), y);
  for (const n of ["yes but change friday to 4", "no", "yes, and add Sunday 10-2", "ok so actually", "yesterday", "y".repeat(41), "okay please also add leaks"]) assert(!isAffirmative(n), n);
});
Deno.test("topics: order per niche, optional skips, revisit first; test-call states", () => {
  eq(topicsFor("home_services").slice(0, 6), ["services", "area", "hours", "after_hours", "prices", "faq"]);
  eq(topicsFor("real_estate").slice(0, 4), ["services", "re_leads", "area", "re_screening"]);
  const s = snap();
  eq(currentTopic(s, {}), "services");
  s.items[1].data.setup_confirmed = { services: "x" };
  eq(currentTopic(s, {}), "area"); eq(currentTopic(s, { skipped: ["area"] }), "hours"); eq(currentTopic(s, { skipped: ["area"], revisit: "services" }), "services");
  s.items[0].status = "done"; eq(currentTopic(s, { skipped: ["area"] }), "prices", "a step done in the forms is done for the chat");
  const fc = s.items[5];
  eq(testState(s), "ready");
  fc.data.test_started_at = new Date().toISOString(); eq(testState(s), "waiting");
  fc.data.test_unverified_at = new Date().toISOString(); eq(testState(s), "unverified");
  fc.data.test_direct = true; eq(testState(s), "direct");
  fc.data.test_mismatch_from = "+12815550100"; fc.data.test_mismatch_at = new Date(Date.now() + 1000).toISOString(); eq(testState(s), "mismatch");
  fc.status = "done"; eq(testState(s), "passed");
  eq(testState(snap({ tenant: { id: "t", twilio_number: null } })), "no_number");
});
