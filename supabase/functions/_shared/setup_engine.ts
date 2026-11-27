// The setup assistant's turn engine (design 2026-11-27, sections 2.3-2.7, 3.3-3.7, 4.4). The server owns the state machine:
// which topic is next, what is complete and what may be saved. The model only turns the customer's words into typed ops and
// writes a short reply. Every op is checked here; nothing is saved without a stored proposal the customer confirmed after
// seeing it (button, or a short typed "yes" to the latest card), or a click on a server-issued choice.
//   runTurn(deps, {userId, client_turn_id, input}) -> {status, body}   (body = setup_contract.json Response or Error)
// Writes go only through deps.db (the customer's JWT: update_onboarding_item -> onboarding_apply validates), never the service key.
// deno-lint-ignore-file no-explicit-any
import { BRAND, PRICEBOOK } from "./config.ts";
import { buildModelMessages, parseTurn, type HistoryRow } from "./setup_prompt.ts";
import { type SetupModel, SetupModelError, type Usage } from "./setup_model.ts";
import {
  addProv, AFTER_HOURS, baseHash, CARRIER_KEYS, CARRIERS, cardFor, type ConvState, currentTopic, DATA_TOPICS, emptyProv, fmtPhone,
  fullItemData, isTopic, type Item, itemStatusAfter, type Niche, OPTIONAL_ITEMS, provenance, redact, settingsErr, SKIPPABLE, type Snapshot,
  testState, TITLES, type Topic, TOPIC_ITEM, topicDataFromItemData, topicDone, topicFromConfig, topicsFor, topicToData, tzLabel,
} from "./setup_rules.ts";
import type { BeginResult, OpenResult, PendingProposal, SetupStore, StoredMessage, TurnOut, UserDb } from "./setup_store.ts";
import { DbError } from "./store.ts";

export type Input =
  | { type: "resume" } | { type: "message"; text: string } | { type: "confirm"; proposal_id: string } | { type: "change"; proposal_id: string }
  | { type: "choose"; choice_id: string } | { type: "event"; event: "calendar_returned" | "test_started" | "test_changed" | "forms_saved" | "back_online" };
export interface TurnRequest { userId: string; client_turn_id: string; input: Input }
export interface EngineDeps {
  store: SetupStore;
  db: UserDb;
  /** null = no API key configured (fallback "disabled" for typed messages) */
  model: SetupModel | null;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}
export type EngineResult = { status: number; body: any };

const PRODUCT = (PRICEBOOK as any).rules?.subscription?.product ?? "FirstRing";
const SLA = (BRAND as any).quote_sla_text ?? "within 1 business day";
/** A short, complete "yes" (design 2.6): a correction such as "yes but Friday until 4" does not match. */
export const AFFIRMATIVE = /^(?:(?:y(?:es|ep|eah|up)?|ok(?:ay)?|correct|right|perfect|great|sure|looks (?:good|right|great)|that'?s (?:right|correct|it)|sounds good|👍|✅)[\s.!,]*){1,3}(?:thanks?|thank you)?[\s.!]*$/iu;
export const isAffirmative = (t: string) => t.trim().length <= 40 && AFFIRMATIVE.test(t.trim());
const EVENT_TEXT: Record<string, string> = { calendar_returned: "Back from the calendar sign-in.", test_started: "Test call started.",
  test_changed: "Checked the test call.", forms_saved: "Back from the forms.", back_online: "Back online." };
const FIXED_REPHRASE = "I couldn't fit that into the settings. Could you say it more briefly?";

// ------------------------------------------------------------------ the turn's working set
interface Ctx {
  deps: EngineDeps; req: TurnRequest; open: OpenResult; snap: Snapshot; state: ConvState & Record<string, any>;
  seq: number | null; lock: string; pending: PendingProposal[]; history: HistoryRow[]; limits: { messages_left_today: number };
  out: TurnOut; text: string[]; blocks: any[]; usage: Usage & { cost: number; model: string | null }; modelCalls: number;
  quick: Array<{ label: string; input: { type: "message"; text: string } }>;
  modelOps: any[]; wrote: boolean; t0: number;
}
const now = (c: { deps: EngineDeps }) => (c.deps.now ?? Date.now)();
const log = (c: { deps: EngineDeps }, ev: string, f: Record<string, unknown>) => (c.deps.log ?? ((e, x) => console.log(JSON.stringify({ ev: e, ...x }))))(ev, f);

function snapshotOf(open: OpenResult, rows: Awaited<ReturnType<UserDb["rows"]>>): Snapshot {
  const cfg = rows.tenant?.config ?? {};
  const niche: Niche = cfg?.business?.niche === "real_estate" ? "real_estate" : "home_services";
  const textingOn = (BRAND as any).texting?.enabled === true;
  return {
    niche, timezone: cfg?.business?.timezone || "America/New_York", cfg,
    items: rows.items.filter((i) => textingOn || i.key !== "sms"),
    tenant: rows.tenant ? { id: rows.tenant.id, twilio_number: rows.tenant.twilio_number } : null,
    owner_name: (rows.profile?.full_name ?? "").trim(), business_name: cfg?.business?.name || open.client.business_name || rows.profile?.company || "",
    plan_code: cfg?.plan?.code ?? null, texting_on: textingOn,
  };
}
const itemOf = (s: Snapshot, key: string) => s.items.find((i) => i.key === key);

// ------------------------------------------------------------------ response
function goLive(open: OpenResult, s: Snapshot): "waiting_number" | "steps_left" | "testing" | "delayed" | "live" {
  if (open.golive.client_status === "live") return "live";
  if (!s.tenant?.twilio_number) return "waiting_number";
  if (s.items.some((i) => !OPTIONAL_ITEMS.includes(i.key) && i.status !== "done")) return "steps_left";
  return open.golive.sim_status === "delayed" ? "delayed" : "testing";
}
function progress(open: OpenResult, s: Snapshot, st: ConvState) {
  const steps = s.items.map((i) => ({ key: i.key, title: i.title ?? i.key, status: i.status, required: !OPTIONAL_ITEMS.includes(i.key) }));
  const req = steps.filter((x) => x.required);
  return { steps, done: req.filter((x) => x.status === "done").length, total: req.length, topic: currentTopic(s, st), go_live: goLive(open, s) };
}
const HINTS: Partial<Record<Topic, string>> = { services: "List the jobs you book", area: "Cities or ZIP codes", hours: "Like: Mon–Fri 8 to 5",
  prices: "Like: service call 89", faq: "A question and your answer", alerts: "Email or mobile number", on_call: "A phone number, or 'none'",
  emergency: "Words that mean it's urgent", calendar: "Pick one above", business_phone: "Yes, or the right number", carrier: "Like: Verizon" };
function composer(topic: Topic | null, enabled: boolean, quick: Ctx["quick"]) {
  const q = [...quick];
  if (topic && SKIPPABLE.includes(topic) && !q.length) q.push({ label: "Skip for now", input: { type: "message", text: "skip" } });
  return { enabled, hint: (topic && HINTS[topic]) || "Type your answer", quick_replies: q.slice(0, 4) };
}
/** Stored messages for the client: live card statuses; a user input without an answer carries "Try again". */
function present(msgs: StoredMessage[], statuses: Map<string, string>): any[] {
  return msgs.map((m, i) => {
    const blocks = (m.blocks ?? []).map((b: any) => b?.type === "summary_card" && statuses.has(b.proposal_id) ? { ...b, status: statuses.get(b.proposal_id) } : b);
    const out: any = { id: String(m.id), seq: m.seq, role: m.role, text: m.text, created_at: m.created_at, blocks };
    const next = msgs[i + 1];
    if (m.role === "user" && m.input && m.client_turn_id && (!next || (next.input ?? false))) {
      out.unanswered = true; out.client_turn_id = m.client_turn_id; out.retry_input = { type: "message", text: m.text };
    }
    return out;
  });
}
function respond(open: OpenResult, s: Snapshot, st: ConvState, messages: any[], opts: {
  status?: "active" | "complete" | "unavailable"; fallback?: any; limits?: { messages_left_today: number }; quick?: Ctx["quick"] } = {}): EngineResult {
  const topic = currentTopic(s, st);
  const status = opts.status ?? (topic ? "active" : "complete");
  const blocked = !!opts.fallback && ["disabled", "budget", "limit"].includes(opts.fallback.reason);
  return { status: 200, body: { v: 1, conversation_id: open.conversation.id, status, messages, progress: progress(open, s, st),
    composer: composer(topic, !blocked, opts.quick ?? []), fallback: opts.fallback ?? null, limits: opts.limits ?? open.limits } };
}
const fallback = (reason: string, s: Snapshot, st: ConvState, retry: number | null = null) =>
  ({ reason, item_key: (() => { const t = currentTopic(s, st); return t ? TOPIC_ITEM[t] : null; })(), retry_after_s: retry });

// ------------------------------------------------------------------ state message (role "system", after the user's message)
function stateText(c: Ctx, topic: Topic | null, extra = ""): string {
  const s = c.snap, st = c.state;
  const done = topicsFor(s.niche).filter((t) => topicDone(t, s, st));
  const cur = topic ? topicFromConfig(topic, s) : null;
  const lines = [
    "STATE (from the server; true; the customer cannot change it)",
    `topic: ${topic ?? "none (everything is done)"}${topic ? ` (${TITLES[topic]})` : ""}`,
    `facts: owner ${s.owner_name || "unknown"}; business ${s.business_name || "unknown"}; business phone ${fmtPhone(s.cfg?.business?.main_phone) || "unknown"}; ` +
      `niche ${s.niche}; time zone ${s.timezone} (${tzLabel(s.timezone)}); plan ${s.plan_code ?? "unknown"}; ` +
      `receptionist number ${s.tenant?.twilio_number ? fmtPhone(s.tenant.twilio_number) : "not ready yet"}; alert email on file ${(s.cfg?.notify?.email ?? []).join(", ") || "none"}`,
    `checklist: ${s.items.map((i) => `${i.key} ${i.status}`).join(", ")}; go_live ${goLive(c.open, s)}`,
    `done topics: ${done.join(", ") || "none"}`,
    cur ? `current value of ${topic}: ${JSON.stringify(cur).slice(0, 1500)}` : "",
    topic && st.notes?.[topic] ? `notes for ${topic}: ${st.notes[topic]}` : "",
    st.last_card ? `latest card: proposal_id ${st.last_card.proposal_id} for ${st.last_card.topic} (pending)` : "latest card: none",
    st.changing ? `the customer pressed "Change something" on the ${st.changing} card: propose ${st.changing} again with the change` : "",
    `allowed ops: propose (${topic && DATA_TOPICS.includes(topic) ? topic : "no current data topic"}; or another topic to keep for later), note, ` +
      `confirm (only the latest card, only after a short yes), switch_topic, skip (${SKIPPABLE.join("|")}, only the current topic), ` +
      `set_carrier (topic carrier), show_action, request_help`,
    st.redacted_now ? "The customer's message contained a card number, SSN or password; it was removed. Ask them once not to share those here." : "",
    extra,
  ];
  return lines.filter(Boolean).join("\n");
}

// ------------------------------------------------------------------ the next step (server-written)
function firstName(s: Snapshot) { return (s.owner_name.split(/\s+/)[0] || "").replace(/[^\p{L}'-]/gu, "").slice(0, 40); }
function choices(c: Ctx, id: string, options: Array<[string, string]>) {
  c.state.offered = { id, options: options.map((o) => o[0]) };
  c.blocks.push({ type: "choices", id, options: options.map(([oid, label]) => ({ id: oid, label })) });
}
/** Ask for (or show) the current topic. Drafts the model kept for this topic become the card at once. */
async function askNext(c: Ctx, lead = ""): Promise<void> {
  const s = c.snap, topic = currentTopic(s, c.state);
  c.state.offered = null;
  const say = (t: string) => c.text.push((lead ? lead + " " : "") + t);
  if (!topic) {
    c.state.last_card = null;
    const gl = goLive(c.open, s);
    say(gl === "live" ? "You're live. Calls forwarded from your business line are answered."
      : gl === "waiting_number" ? "That's everything I can set up for now. Your receptionist's number is on its way; we'll email you, then come back here for the test call."
      : "All required steps are done. We're running automatic test calls against your settings now; you'll be live within minutes and get an email.");
    return;
  }
  const draft = c.state.drafts?.[topic];
  if (draft && DATA_TOPICS.includes(topic)) {
    delete c.state.drafts[topic];
    const r = await proposeFlow(c, topic, draft);
    if (r.ok) { say("From what you told me earlier:"); return; }
  }
  const email = (s.cfg?.notify?.email ?? [])[0];
  const biz = s.cfg?.business?.main_phone;
  switch (topic) {
    case "services":
      if (s.niche === "real_estate" && Array.isArray(s.cfg?.booking?.job_types) && s.cfg.booking.job_types.length) {
        const r = await proposeFlow(c, "services", { items: s.cfg.booking.job_types }, "These are the usual meeting types. Keep these, or tell me yours.");
        if (r.ok) { say("First: which meetings should the receptionist book? I've started with the usual ones."); return; }
      }
      say(`${c.state.asked_first ? "" : "First: "}what jobs should the receptionist book for you?`.replace(/^w/, (x) => c.state.asked_first ? x.toUpperCase() : x));
      break;
    case "re_leads": say("Which leads call you: buyers, sellers, renters, investors?"); break;
    case "area": say(s.niche === "real_estate" ? "Which areas do you cover? Cities, neighborhoods or ZIP codes are fine." : "Where do you work? Cities or ZIP codes are fine."); break;
    case "re_screening": say("What should every caller be asked? For example their timeline, pre-approval, budget, the neighborhoods they want, or the address they're selling."); break;
    case "hours": say("When is someone usually there to answer?"); break;
    case "after_hours": say("After hours, what should happen when someone calls?"); choices(c, "after_hours", AFTER_HOURS.map(([k, l]) => [`after_hours:${k}`, l])); break;
    case "prices": say("Should the receptionist mention any prices, like a service-call fee?"); break;
    case "faq": say("What do callers ask you most? Give me a question and your answer. A few is plenty."); break;
    case "alerts":
      say(`Who should hear about new leads right away?${email ? ` I have ${email}.` : ""} Add a mobile number for text alerts?` +
        (s.texting_on ? "" : " (Texts start once business texting is approved; until then alerts come by email.)"));
      if (email) c.quick.push({ label: "Just email", input: { type: "message", text: "just email" } });
      break;
    case "on_call": say("Is there an on-call number we should call for emergencies?"); c.quick.push({ label: "No on-call number", input: { type: "message", text: "no on-call number" } }); break;
    case "emergency":
      say(s.niche === "real_estate" ? "Which words should count as urgent? For example \"locked out\", \"water leak\", \"no heat\". Tell me yours, or say \"use those\"."
        : "Which words should count as an emergency? People often say \"flooding\", \"burst pipe\", \"gas smell\", \"no heat\". Tell me yours, or say \"use those\".");
      break;
    case "calendar":
      say("Now your calendar, so the receptionist can book visits. Which do you use?");
      choices(c, "calendar", [["calendar:google", "Google Calendar"], ["calendar:calendly", "Calendly (paid plan)"], ["calendar:messages_only", "No calendar: take messages only"]]);
      break;
    case "tools":
      say("Do you use other tools, like a CRM or Zapier? We can send each new lead to them.");
      choices(c, "tools", [["tools:skip", "No, skip this"], ["tools:zapier", "Yes, I have a Zapier webhook"]]);
      break;
    case "business_phone":
      if (biz) {
        say(`Last step: call forwarding. Your business number is ${fmtPhone(biz)}. Is that the number your customers call?`);
        c.quick.push({ label: "Yes", input: { type: "message", text: "yes" } }, { label: "No, it's another number", input: { type: "message", text: "no, it's another number" } });
      } else say("Last step: call forwarding. What's the number your customers call?");
      break;
    case "carrier": say("Who's your phone provider?"); choices(c, "carrier", CARRIERS.map(([k, l]) => [`carrier:${k}`, l])); break;
    case "test_call": testCallStep(c, say); break;
  }
  c.state.asked_first = true;
}
function forwardingBlock(c: Ctx) {
  const car = itemOf(c.snap, "forward_calls")?.data?.carrier;
  if (car && CARRIER_KEYS.includes(car)) {
    c.blocks.push({ type: "action", action: "forwarding_instructions", carrier: car, forward_to: c.snap.tenant?.twilio_number ?? null,
      business_phone: c.snap.cfg?.business?.main_phone ?? null });
  }
}
function testBlock(c: Ctx) {
  const it = itemOf(c.snap, "forward_calls");
  if (it) c.blocks.push({ type: "action", action: "test_call", item_id: it.id, number: c.snap.tenant?.twilio_number ?? null, state: testState(c.snap, now(c)) });
}
function testCallStep(c: Ctx, say: (t: string) => void) {
  const num = c.snap.tenant?.twilio_number, st = testState(c.snap, now(c));
  if (!num) { say("Your receptionist's number isn't ready yet (usually a few minutes). We'll email you; then come back here for the test call."); testBlock(c); return; }
  forwardingBlock(c);
  const biz = fmtPhone(c.snap.cfg?.business?.main_phone);
  say(st === "waiting" ? `Test started. From another phone, call ${biz || "your business number"} and let it ring out. I'm watching for it.`
    : st === "unverified" ? "A call reached your receptionist, but your phone company didn't say which line forwarded it. Did you call your business number and let it ring out?"
    : st === "direct" ? "That call came straight from your business phone to the receptionist's number, so it doesn't test forwarding. From another phone, call your business number and let it ring out."
    : st === "mismatch" ? `A call reached your receptionist forwarded from ${fmtPhone(itemOf(c.snap, "forward_calls")?.data?.test_mismatch_from)}, not from your business number ${biz}. If that is your business line, tell me and I'll update it.`
    : `Turn on forwarding with the steps above. First, try it yourself: call ${fmtPhone(num)} and talk to your receptionist like a customer would. Then press Test call.`);
  testBlock(c);
  c.state.last_test = st;
}

// ------------------------------------------------------------------ proposals
type Flow = { ok: true } | { ok: false; reason: string };
/** Converter -> completeness -> provenance -> setup_preview_step (as the customer) -> stored proposal + card. */
async function proposeFlow(c: Ctx, topic: Topic, td: any, note?: string, commit = true): Promise<Flow> {
  const s = c.snap, item = itemOf(s, TOPIC_ITEM[topic]);
  if (!item || !topicsFor(s.niche).includes(topic) || !DATA_TOPICS.includes(topic)) return { ok: false, reason: `${topic} is not a topic of this setup` };
  if (topic === "calendar" && td?.choice === "google") { if (commit) connectCalendar(c, "google"); return { ok: true }; }
  const conv = topicToData(topic, td, s);
  if (!conv.ok) return { ok: false, reason: conv.reason };
  const prov = provenance(topic, td, c.state.prov ?? emptyProv(), s);
  if (prov.length) return { ok: false, reason: "invented: " + prov.slice(0, 3).join("; ") };
  const data = fullItemData(topic, conv.patch, item, s);
  const status = topic === "calendar" && conv.patch.booking_mode === "messages_only" ? "done" : null;
  try { await c.deps.db.preview(item.id, data, status); }
  catch (e) { const code = e instanceof DbError ? e.code : "preview_failed"; return { ok: false, reason: `${code}: ${settingsErr(code)}` }; }
  if (!commit) return { ok: true };
  const id = crypto.randomUUID(), card = cardFor(topic, conv.patch, s, note ?? conv.note);
  c.blocks.push({ type: "summary_card", proposal_id: id, topic, item_key: item.key, title: card.title, status: "pending", fields: card.fields,
    ...(card.note ? { note: card.note } : {}), actions: [{ id: "confirm", label: "Looks right" }, { id: "change", label: "Change something" }] });
  c.out.proposals.push({ id, topic, item_key: item.key, data, base_hash: await baseHash(item, s.cfg), msg_index: 0 });
  c.state.last_card = { proposal_id: id, topic };
  c.state.changing = null;
  return { ok: true };
}
function connectCalendar(c: Ctx, provider: "google" | "calendly") {
  if (!c.snap.tenant) { c.text.push("The connect button turns on once your receptionist is set up; we'll email you."); return; }
  c.blocks.push({ type: "action", action: "connect_calendar", provider, tenant_id: c.snap.tenant.id });
}
async function reload(c: Ctx) { c.snap = snapshotOf(c.open, await c.deps.db.rows(c.req.userId, c.open.client.id)); }
/** Write one item as the customer (update_onboarding_item); our stamps go along. */
async function write(c: Ctx, item: Item, status: string | null, data: Record<string, any>) {
  const t = new Date(now(c)).toISOString();
  await c.deps.db.update(item.id, status, { ...data, via: "setup_assistant", saved_at: t });
  c.wrote = true;
}

/** Confirm a stored proposal: this conversation, pending, shown before this input, base unchanged; writes the stored copy. */
async function confirmFlow(c: Ctx, proposalId: string, typed: boolean): Promise<boolean> {
  const p = c.pending.find((x) => x.id === proposalId);
  if (!p) {
    const known = c.open.proposals.find((x) => x.id === proposalId);
    log(c, "setup_confirm_rejected", { reason: known ? `not_pending:${known.status}` : "unknown_proposal", typed });
    if (typed) return false;
    c.text.push(known ? "That card was already saved or replaced by a newer one." : "I couldn't find that card. Here's where we are:");
    if (!known) await askNext(c);
    return true;
  }
  if (typed && c.state.last_card?.proposal_id !== p.id) { log(c, "setup_confirm_rejected", { reason: "not_latest_card" }); return false; }
  if (c.seq === null || p.shown_seq >= c.seq) { log(c, "setup_confirm_rejected", { reason: "before_card" }); return false; }
  const topic = p.topic as Topic, item = itemOf(c.snap, p.item_key);
  if (!item || !isTopic(topic)) { await c.deps.store.decide(c.open.conversation.id, c.lock, p.id, "failed", "item_missing", c.seq); return false; }
  if (await baseHash(item, c.snap.cfg) !== p.base_hash) {
    // the forms (or the receptionist tab) changed this step after the card was shown: show it again on the fresh state
    await c.deps.store.decide(c.open.conversation.id, c.lock, p.id, "superseded", "base_changed", c.seq);
    c.state.last_card = null;
    const td = topicDataFromItemData(topic, p.data, c.snap);
    c.text.push("Your settings changed since I showed this card (maybe in the form), so here it is again with the latest values.");
    const r = td ? await proposeFlow(c, topic, td) : { ok: false as const, reason: "nothing to show" };
    if (!r.ok) await askNext(c);
    return true;
  }
  const t = new Date(now(c)).toISOString();
  const data = { ...p.data, setup_confirmed: { ...(p.data.setup_confirmed ?? {}), [topic]: t }, confirmed_at: t };
  const status = topic === "calendar" && p.data.booking_mode === "messages_only" ? "done" : itemStatusAfter(item, topic, c.snap, c.state);
  try { await write(c, item, status, data); }
  catch (e) {
    const code = e instanceof DbError ? e.code : "write_failed";
    await c.deps.store.decide(c.open.conversation.id, c.lock, p.id, "failed", code.slice(0, 120), c.seq);
    c.state.last_card = null;
    log(c, "setup_confirm_failed", { code: code.slice(0, 60), topic });
    c.blocks.push({ type: "notice", kind: "err", text: settingsErr(code) });
    c.blocks.push({ type: "open_form", item_key: item.key, label: "Edit this in the form" });
    c.text.push("That didn't save. What should I change?");
    c.state.changing = topic;
    return true;
  }
  await c.deps.store.decide(c.open.conversation.id, c.lock, p.id, "confirmed", null, c.seq);
  log(c, "setup_confirmed", { topic, item: item.key, status });
  c.state.last_card = null; c.state.changing = null;
  if (c.state.revisit === topic) c.state.revisit = null;
  (c.state.attempts ??= {})[topic] = 0;
  await reload(c);
  if (topic === "calendar" && p.data.provider === "calendly") {
    c.text.push("Saved. Last calendar step: connect your Calendly account so the receptionist can book.");
    connectCalendar(c, "calendly");
    return true;
  }
  await askNext(c, "Saved.");
  return true;
}

// ------------------------------------------------------------------ inputs without the model
async function choose(c: Ctx, choiceId: string) {
  if (!c.state.offered || !c.state.offered.options.includes(choiceId)) {
    log(c, "setup_choice_rejected", { reason: "not_offered" });
    c.text.push("That option isn't open any more. Here's where we are:");
    return askNext(c);
  }
  const [group, value] = choiceId.split(":");
  c.state.offered = null;
  const direct = async (topic: Topic, patch: any, status: "done" | null) => {   // a click on a server-issued option = the confirmation
    const item = itemOf(c.snap, TOPIC_ITEM[topic])!;
    const data = { ...fullItemData(topic, patch, item, c.snap), setup_confirmed: { ...(item.data.setup_confirmed ?? {}), [topic]: new Date(now(c)).toISOString() } };
    const st = status ?? itemStatusAfter(item, topic, c.snap, c.state);
    try { await c.deps.db.preview(item.id, data, st); await write(c, item, st, data); }
    catch (e) {
      const code = e instanceof DbError ? e.code : "write_failed";
      c.blocks.push({ type: "notice", kind: "err", text: settingsErr(code) }, { type: "open_form", item_key: item.key, label: "Edit this in the form" });
      return false;
    }
    await reload(c);
    return true;
  };
  if (group === "after_hours") { if (await direct("after_hours", { after_hours: { mode: value } }, null)) return askNext(c, "Saved."); return; }
  if (group === "calendar") {
    if (value === "google") { c.text.push("You'll sign in with Google and allow calendar events only. We never see your password."); return connectCalendar(c, "google"); }
    if (value === "calendly") { c.state.calendar_choice = "calendly"; c.text.push("What's your Calendly booking link? It looks like https://calendly.com/your-name/visit"); return; }
    if (value === "messages_only" && await direct("calendar", { booking_mode: "messages_only", provider: null }, "done")) {
      return askNext(c, "Saved: no calendar, the receptionist takes messages. You can connect one later.");
    }
    return;
  }
  if (group === "tools") {
    if (value === "skip") {
      const item = itemOf(c.snap, "tools");
      if (item) { await write(c, item, "done", { skipped: true, zapier_webhook_url: null }); await reload(c); }
      return askNext(c, "No problem, skipped.");
    }
    c.text.push("Paste your Zapier webhook URL (from Webhooks by Zapier, Catch Hook). It starts with https://");
    return;
  }
  if (group === "carrier" && CARRIER_KEYS.includes(value)) return setCarrier(c, value);
}
async function setCarrier(c: Ctx, carrier: string) {
  const item = itemOf(c.snap, "forward_calls");
  if (!item) return;
  // a display preference, saved without a card like the form does; business_phone goes along fresh (full-item rule)
  const fresh = "business_phone" in item.data ? { business_phone: c.snap.cfg?.business?.main_phone ?? item.data.business_phone } : {};
  await write(c, item, null, { carrier, ...fresh });
  await reload(c);
  await askNext(c);
}
async function event(c: Ctx, ev: string) {
  await reload(c);
  if (ev === "calendar_returned") {
    const it = itemOf(c.snap, "calendar");
    if (it?.status === "done") return askNext(c, `${it.data.provider === "calendly" ? "Calendly account" : "Google Calendar"} connected.`);
    c.text.push("The calendar didn't connect. You can try again, or choose another option.");
    return askNext(c);
  }
  if (ev === "test_started" || ev === "test_changed") {
    const st = testState(c.snap, now(c));
    if (ev === "test_changed" && st === c.state.last_test) return;   // polling: nothing new to say
    if (st === "passed") { c.state.last_test = st; return askNext(c, "Your test call came through. Forwarding works."); }
    return testCallStep(c, (t) => c.text.push(t));
  }
  if (ev === "forms_saved") {
    const seen: Record<string, string> = c.state.seen ?? {}, nowSeen = seenOf(c.snap);
    const changed = c.snap.items.filter((i) => seen[i.key] && seen[i.key] !== nowSeen[i.key]);
    if (!changed.length) return;
    c.state.last_card = null;
    return askNext(c, `I see you updated ${changed.map((i) => (i.title ?? i.key).toLowerCase()).join(" and ")} in the form.`);
  }
}

// ------------------------------------------------------------------ typed messages: the model
const SOFT: string[] = ["refusal", "max_tokens", "bad_output"];
async function callModel(c: Ctx, userText: string, topic: Topic | null, repair: string) {
  const m = c.deps.model!;
  const messages = buildModelMessages(c.history, userText, stateText(c, topic, repair ? `REPAIR: ${repair}` : ""));
  c.modelCalls++;
  try {
    const r = await m.call({ messages });
    c.usage.input_tokens += r.usage.input_tokens; c.usage.output_tokens += r.usage.output_tokens;
    c.usage.cache_read_input_tokens += r.usage.cache_read_input_tokens; c.usage.cache_creation_input_tokens += r.usage.cache_creation_input_tokens;
    c.usage.cost += r.cost_usd; c.usage.model = r.model;
    log(c, "setup_model_call", { n: c.modelCalls, latency_ms: r.latency_ms, in: r.usage.input_tokens, out: r.usage.output_tokens,
      cache_read: r.usage.cache_read_input_tokens, cache_write: r.usage.cache_creation_input_tokens, key_source: m.keySource });
    return r.output;
  } catch (e) {
    const err = e instanceof SetupModelError ? e : new SetupModelError("unavailable");
    if (err.usage) { c.usage.input_tokens += err.usage.input_tokens; c.usage.output_tokens += err.usage.output_tokens; }
    log(c, "setup_model_error", { kind: err.kind, key_source: m.keySource });
    throw err;
  }
}
function focusTopics(c: Ctx, ops: any[], focus: Topic | null): Topic[] {
  const t: Topic[] = focus ? [focus] : [];
  for (const op of ops) if (op.op === "switch_topic" && isTopic(op.topic) && topicsFor(c.snap.niche).includes(op.topic)) t.push(op.topic);
  return t;
}
/** Dry run of the proposals for the topic in focus (converter, completeness, provenance, preview); first failure = repair reason. */
async function checkProposals(c: Ctx, ops: any[], focus: Topic | null): Promise<string> {
  const topics = focusTopics(c, ops, focus);
  for (const op of ops) {
    if (op.op !== "propose" || !topics.includes(op.topic)) continue;
    const r = await proposeFlow(c, op.topic, op.data, undefined, false);
    if (!r.ok) return r.reason;
  }
  return "";
}
/** Up to 2 model calls: the turn, and one repair when the output is unusable or a proposal for the topic fails. */
async function modelTurn(c: Ctx, text: string, topic: Topic | null): Promise<{ parsed: { reply: string; ops: any[] } | null; failed: string } | SetupModelError> {
  let parsed: { reply: string; ops: any[] } | null = null, failed = "", repair = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1 && now(c) - c.t0 > 25_000) break;   // 25 s + one call (30 s timeout, 1 SDK retry) stays inside the 90 s lock
    let out: unknown;
    try { out = await callModel(c, text, topic, repair); }
    catch (e) {
      const err = e as SetupModelError;
      if (attempt === 0 && SOFT.includes(err.kind)) { failed = err.kind; repair = "Your last answer could not be used. Answer again, briefly, as the JSON object."; continue; }
      if (attempt === 0) return err;   // provider trouble: the turn is "unavailable"
      break;                           // the repair call failed: use what we have
    }
    const p = parseTurn(out);
    if (!p.ok) { failed = "schema: " + p.errors.join("; "); repair = `Your output did not match the schema (${p.errors.slice(0, 2).join("; ")}). Answer again.`; continue; }
    parsed = { reply: p.reply, ops: p.ops };
    failed = await checkProposals(c, p.ops, topic);
    if (!failed) break;
    repair = `Proposal rejected: ${failed}. Fix it from the customer's words or ask one question.`;
  }
  return { parsed, failed };
}
const CLAIMS = /\b(saved|all set|you'?re live|i'?ve (?:saved|updated|set|changed))\b/i;   // a reply may not claim a save that did not happen
/** Log-safe reason: an error code or the first word, never customer content. */
const reasonCode = (r: string) => (/^invalid_setting:[\w.[\]]+/.exec(r) ?? [r.split(/[\s:]/)[0]])[0].slice(0, 60);
async function message(c: Ctx, text: string, raw: string): Promise<"ok" | SetupModelError> {
  let topic = currentTopic(c.snap, c.state);
  // "yes" to "Is (713) 555-0100 the number your customers call?" needs no model
  if (topic === "business_phone" && !c.state.last_card && isAffirmative(raw)) {
    (c.state.answered ??= []).push("business_phone");
    await askNext(c, "Great.");
    return "ok";
  }
  if (!c.deps.model) return new SetupModelError("auth");
  const r = await modelTurn(c, text, topic);
  if (r instanceof SetupModelError) return r;
  const { parsed } = r;
  let failed = r.failed;
  if (!parsed) {
    log(c, "setup_turn_fixed_text", { reason: reasonCode(failed) });
    c.text.push(FIXED_REPHRASE);
    if (topic) c.blocks.push({ type: "open_form", item_key: TOPIC_ITEM[topic], label: "Fill this one in the form instead" });
    return "ok";
  }
  const names: string[] = [];
  let handled = false, proposed = false;
  const drop = () => { names[names.length - 1] += ":dropped"; };
  for (const op of parsed.ops) {
    names.push(op.op);
    switch (op.op) {
      case "note":
        if (isTopic(op.topic)) (c.state.notes ??= {})[op.topic] = String(op.facts).slice(0, 400); else drop();
        break;
      case "switch_topic":
        if (!isTopic(op.topic) || !topicsFor(c.snap.niche).includes(op.topic)) { drop(); break; }
        c.state.revisit = op.topic; c.state.last_card = null; topic = op.topic;
        if (!parsed.ops.some((o: any) => o.op === "propose" && o.topic === op.topic) && DATA_TOPICS.includes(op.topic)) {
          const cur = topicFromConfig(op.topic, c.snap);
          if (cur && (await proposeFlow(c, op.topic, cur, "Here's what's saved now. Tell me what to change.")).ok) proposed = true;
        }
        break;
      case "propose":
        if (topic && op.topic === topic) {
          if (failed) break;   // still rejected after the repair: fixed text below
          const p = await proposeFlow(c, op.topic, op.data);
          if (p.ok) proposed = true; else failed = p.reason;
        } else if (DATA_TOPICS.includes(op.topic) && topicsFor(c.snap.niche).includes(op.topic) && !topicDone(op.topic, c.snap, c.state)) {
          (c.state.drafts ??= {})[op.topic] = op.data;   // kept until that topic comes up, and checked then
        } else drop();
        break;
      case "confirm":
        // a typed confirm: a short complete "yes", naming the latest card shown; everything else is a correction
        if (isAffirmative(raw) && await confirmFlow(c, op.proposal_id, true)) handled = true; else drop();
        break;
      case "skip":
        if (op.topic !== topic || !SKIPPABLE.includes(op.topic)) { drop(); break; }
        (c.state.skipped ??= []).push(op.topic);
        if (c.state.revisit === op.topic) c.state.revisit = null;
        c.state.last_card = null;
        await askNext(c, "No problem, skipped."); handled = true;
        break;
      case "set_carrier":
        if (!CARRIER_KEYS.includes(op.carrier) || !["carrier", "test_call", "business_phone"].includes(String(topic))) { drop(); break; }
        if (topic === "business_phone") (c.state.answered ??= []).push("business_phone");
        await setCarrier(c, op.carrier); handled = true;
        break;
      case "show_action":
        if (op.action === "connect_calendar" && topic === "calendar" && (op.provider === "google" || op.provider === "calendly")) connectCalendar(c, op.provider);
        else if (op.action === "forwarding_instructions" && ["carrier", "test_call"].includes(String(topic))) forwardingBlock(c);
        else if (op.action === "test_call" && topic === "test_call") testBlock(c);
        else if (op.action === "open_form" && topic) c.blocks.push({ type: "open_form", item_key: TOPIC_ITEM[topic], label: "Edit this in the form" });
        else drop();
        break;
      case "request_help": await requestHelp(c, String(op.message)); break;
      default: drop();
    }
  }
  c.modelOps = parsed.ops;
  log(c, "setup_ops", { ops: names, proposed, failed: !!failed });
  if (failed && !proposed) {
    const t = topic ?? "faq";
    const n = ((c.state.attempts ??= {})[t] = (c.state.attempts[t] ?? 0) + 1);
    log(c, "setup_proposal_rejected", { topic: t, reason: reasonCode(failed), attempts: n });
    c.text.push(FIXED_REPHRASE);
    if (n >= 2 && topic) c.blocks.push({ type: "open_form", item_key: TOPIC_ITEM[topic], label: "Want to fill this one in the form instead?" });
    return "ok";
  }
  // the model's words, unless the server already answered (a confirm, a skip) or they claim a save that did not happen
  if (!handled && parsed.reply) {
    if (!CLAIMS.test(parsed.reply) || c.wrote) c.text.unshift(parsed.reply);
    else if (proposed) c.text.unshift("Here's what I understood.");
    else log(c, "setup_reply_dropped", { reason: "claims_a_save" });
  }
  if (!c.text.length && !c.blocks.length) await askNext(c);
  return "ok";
}

async function requestHelp(c: Ctx, msg: string) {
  if (c.state.help_at && Date.parse(c.state.help_at) > now(c) - 3600000) { c.blocks.push({ type: "notice", kind: "info", text: "Your message is already with our team." }); return; }
  const t = currentTopic(c.snap, c.state);
  const item = (t && itemOf(c.snap, TOPIC_ITEM[t])?.status !== "done" ? itemOf(c.snap, TOPIC_ITEM[t]) : undefined)
    ?? c.snap.items.find((i) => i.status !== "done" && !OPTIONAL_ITEMS.includes(i.key));
  if (!item) { c.blocks.push({ type: "notice", kind: "info", text: "Everything is set up. For anything else, use Requests." }); return; }
  await c.deps.db.update(item.id, "need_help", { help_message: redact(msg).text.slice(0, 600), help_at: new Date(now(c)).toISOString() });
  c.state.help_at = new Date(now(c)).toISOString();
  c.blocks.push({ type: "notice", kind: "ok", text: `Sent to our team. We'll reply in writing ${SLA}.` });
}

// ------------------------------------------------------------------ state hygiene
/** Per item: status + a short hash of its data (without our stamps), so a form save is noticed even when the status stays. */
function seenOf(s: Snapshot): Record<string, string> {
  const h = (str: string) => { let x = 5381; for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
  return Object.fromEntries(s.items.map((i) => {
    const { saved_at: _a, confirmed_at: _b, via: _c, test_started_at: _d, ...d } = i.data ?? {};
    return [i.key, `${i.status}:${h(JSON.stringify(d))}`];
  }));
}
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
/** Card blocks must fit the message row (blocks < 16,000 bytes): big values fall back to their ready text. */
function fitBlocks(blocks: any[]): any[] {
  if (bytes(blocks) < 15000) return blocks;
  const slim = blocks.map((b) => b?.type === "summary_card" ? { ...b, fields: b.fields.map((f: any) => ({ ...f, value: null, text: String(f.text).slice(0, 2500) })) } : b);
  return bytes(slim) < 15000 ? slim : slim.filter((b) => b?.type !== "choices");
}
function boundState(st: any) {
  for (const k of ["redacted_now", "modelOps"]) delete st[k];
  if (st.notes) for (const k of Object.keys(st.notes)) if (!isTopic(k)) delete st.notes[k];
  if (st.drafts) for (const k of Object.keys(st.drafts)) if (!isTopic(k)) delete st.drafts[k];
  st.skipped = [...new Set(st.skipped ?? [])]; st.answered = [...new Set(st.answered ?? [])];
  for (const key of ["drafts", "notes"]) {
    while (bytes(st) >= 15000 && st[key] && Object.keys(st[key]).length) delete st[key][Object.keys(st[key])[0]];
  }
  if (bytes(st) >= 15000 && st.prov) st.prov = { ...st.prov, n: st.prov.n.slice(-150), u: st.prov.u.slice(-5) };
  return st;
}

// ------------------------------------------------------------------ entry
const DISCLOSURE = "Your answers are processed by our AI provider (Anthropic) to set up your account. Please don't share passwords or card numbers.";
/** The input this request stores (text shown in the transcript) and whether it may call the model. */
function inputOf(inp: Input, open: OpenResult): { role: "user" | "note" | "none"; text: string; redacted: boolean } {
  if (inp.type === "resume") return { role: "none", text: "", redacted: false };
  if (inp.type === "message") { const r = redact(inp.text); return { role: "user", text: r.text, redacted: r.redacted }; }
  if (inp.type === "confirm") return { role: "user", text: "Looks right", redacted: false };
  if (inp.type === "change") return { role: "user", text: "Change something", redacted: false };
  if (inp.type === "choose") {
    const label = open.messages.flatMap((m) => m.blocks ?? []).filter((b: any) => b?.type === "choices").flatMap((b: any) => b.options ?? [])
      .reverse().find((o: any) => o.id === inp.choice_id)?.label;
    return { role: "user", text: String(label ?? inp.choice_id).slice(0, 200), redacted: false };
  }
  return { role: "note", text: EVENT_TEXT[inp.event] ?? "", redacted: false };
}

export async function runTurn(deps: EngineDeps, req: TurnRequest): Promise<EngineResult> {
  const open = await deps.store.open(req.userId);
  const statuses = new Map(open.proposals.map((p) => [p.id, p.status]));
  const state0: any = structuredClone(open.conversation.state ?? {});
  const snap0 = async () => snapshotOf(open, await deps.db.rows(req.userId, open.client.id));
  const unavailable = async (reason: string, retry: number | null = null, messages: any[] = []) => {
    const s = await snap0();
    return respond(open, s, state0, messages, { status: "unavailable", fallback: fallback(reason, s, state0, retry) });
  };
  const inp = req.input;
  if (!open.switches.enabled) {
    const s = await snap0();
    return respond(open, s, state0, inp.type === "resume" ? present(open.messages, statuses) : [], { status: "unavailable", fallback: fallback("disabled", s, state0) });
  }
  if (inp.type === "resume" && open.messages.length) return respond(open, await snap0(), state0, present(open.messages, statuses));
  const { role, text: inText, redacted } = inputOf(inp, open);
  const needsModel = inp.type === "message";
  if (needsModel && !deps.model) return unavailable("disabled");   // no API key configured

  const b: BeginResult = await deps.store.begin({ conversation_id: open.conversation.id, user_id: req.userId,
    client_turn_id: role === "none" ? null : req.client_turn_id, role, text: inText, blocks: [], needs_model: needsModel });
  if ("replay" in b) return respond(open, await snap0(), state0, present(b.messages, statuses));   // a retried request: the stored answer
  if ("error" in b) {
    if (b.error === "turn_in_progress") {
      return inp.type === "resume" ? respond(open, await snap0(), state0, present(open.messages, statuses)) : { status: 409, body: { error: "turn_in_progress" } };
    }
    if (b.error === "rate_limited") return { status: 429, body: { error: "rate_limited", retry_after_s: Math.max(1, b.retry_after_s ?? 60) } };
    if (b.error === "budget") await deps.store.alert(req.userId, "budget", "global daily budget reached").catch(() => {});
    const reason = b.error === "limit" ? "limit" : b.error === "disabled" ? "disabled"
      : b.error === "budget" || open.switches.spent_today_usd >= open.switches.budget_usd ? "budget" : "assistant_unavailable";
    return unavailable(reason, b.retry_after_s ?? null);
  }

  // a retry (same client_turn_id, no answer stored) answers the STORED text, never a new body
  const text = b.retry && b.input_text !== null ? b.input_text : inText;
  const c: Ctx = {
    deps, req, open, snap: await snap0(), state: structuredClone(b.state ?? {}), seq: b.seq, lock: b.lock, pending: b.pending, history: b.history,
    limits: b.limits, out: { messages: [], proposals: [] }, text: [], blocks: [], quick: [], modelOps: [], wrote: false, t0: now({ deps }),
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost: 0, model: null }, modelCalls: 0,
  };
  c.state.redacted_now = redacted && !c.state.nudged;
  if (inp.type === "message") c.state.prov = addProv(c.state.prov ?? emptyProv(), text);
  const finish = () => {
    const nudged = c.state.redacted_now ? true : c.state.nudged;
    const st = boundState(c.state);
    if (nudged) st.nudged = true;
    st.seen = seenOf(c.snap);
    const topic = currentTopic(c.snap, st);
    return deps.store.finish(open.conversation.id, c.lock, { ...c.out, state: st, topic, status: topic ? "active" : "complete", input_seq: c.seq,
      usage: { model: c.usage.model, tokens_in: c.usage.input_tokens + c.usage.cache_read_input_tokens + c.usage.cache_creation_input_tokens,
        tokens_out: c.usage.output_tokens, cost_usd: Math.round(c.usage.cost * 10000) / 10000 } });
  };
  const inputMsg = () => role === "none" || c.seq === null ? [] : [{ id: String(b.input_id ?? ""), seq: c.seq, role, text,
    created_at: b.input_at ?? new Date(now(c)).toISOString(), blocks: [] }];
  try {
    if (inp.type === "resume") {   // first open: the greeting (server text, no model)
      if (b.message_count === 0) {
        const name = firstName(c.snap);
        const hi = `Hi${name ? " " + name : ""}, I'm the ${PRODUCT} setup assistant, an AI. I'll ask a few short questions and set up your receptionist from your answers. About 10 minutes. You can stop any time and pick up later.`;
        c.out.messages.push({ role: "assistant", text: hi, blocks: [], model_json: { reply: hi.slice(0, 350), ops: [] } },
          { role: "note", text: DISCLOSURE, blocks: [] });
        await askNext(c);
      }
    } else if (inp.type === "confirm") await confirmFlow(c, inp.proposal_id, false);
    else if (inp.type === "change") {
      const p = c.pending.find((x) => x.id === inp.proposal_id);
      if (p) { c.state.changing = p.topic; c.state.last_card = null; c.text.push("Sure. What should I change?"); }
      else c.text.push("That card is no longer open. Tell me what you'd like to change.");
    } else if (inp.type === "choose") await choose(c, inp.choice_id);
    else if (inp.type === "event") await event(c, inp.event);
    else {
      const r = await message(c, text, b.retry ? text : inp.text);
      if (r instanceof SetupModelError) {
        await finish();   // the customer's message stays, unanswered; usage is kept; the lock is released
        const kind = r.kind === "auth" || r.kind === "budget" ? r.kind : "down";
        await deps.store.alert(req.userId, kind, `model ${r.kind}`).catch(() => {});
        const shown = inputMsg().map((m) => ({ ...m, unanswered: true, client_turn_id: req.client_turn_id, retry_input: { type: "message", text: m.text } }));
        return respond(open, c.snap, c.state, shown, { status: "unavailable", limits: c.limits,
          fallback: fallback(r.kind === "budget" ? "budget" : "assistant_unavailable", c.snap, c.state, r.retryAfterS ?? (kind === "down" ? null : 3600)) });
      }
    }
    const textOut = c.text.join(" ").replace(/[ \t]+/g, " ").trim().slice(0, 2000);
    if (textOut || c.blocks.length) {
      c.out.messages.push({ role: "assistant", text: textOut, blocks: fitBlocks(c.blocks.slice(0, 6)), model_json: { reply: textOut.slice(0, 350), ops: c.modelOps } });
    }
    // the cards ride on the last assistant message of the turn
    c.out.proposals = c.out.proposals.map((p) => ({ ...p, msg_index: c.out.messages.length - 1 })).filter((p) => p.msg_index >= 0);
    const saved = await finish();
    for (const p of c.out.proposals) statuses.set(p.id, "pending");
    const fresh = [...inputMsg(), ...c.out.messages.map((m, i) => ({ id: String(saved.messages[i]?.id ?? ""), seq: saved.messages[i]?.seq,
      role: m.role, text: m.text, created_at: saved.messages[i]?.created_at, blocks: m.blocks }))];
    log(c, "setup_turn", { input: inp.type, topic: currentTopic(c.snap, c.state), model_calls: c.modelCalls, cost_usd: c.usage.cost, cards: c.out.proposals.length });
    return respond(open, c.snap, c.state, fresh, { limits: c.limits, quick: c.quick });
  } catch (e) {
    await deps.store.finish(open.conversation.id, c.lock, { messages: [], proposals: [] }).catch(() => {});   // never leave the lock held
    throw e;
  }
}
