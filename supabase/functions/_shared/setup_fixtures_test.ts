// Test fixtures for the setup assistant (no tests here): an in-memory Supabase "world" whose settings writes run the
// browser copy of private.onboarding_patch (site/start/assets/onboarding-config.js; supabase/tests/offline/onboarding_parity_run.ts
// proves it equals the SQL), a plan client per call of world(), and helpers to read the scripted model's requests.
// deno-lint-ignore-file no-explicit-any
import { MemorySetupStore, MemoryUserDb, MemoryWorld } from "./setup_store.ts";
import { validate } from "./setup_schema.ts";
import CONTRACT from "./setup_contract.json" with { type: "json" };

let OC: any = null;
export function onboardingConfig(): any {
  if (!OC) {
    const g = globalThis as any;
    (0, eval)(Deno.readTextFileSync(new URL("../../../site/start/assets/onboarding-config.js", import.meta.url)));
    OC = g.OnboardingConfig;
  }
  return OC;
}

export function defaultConfig(niche = "home_services") {
  return {
    business: { name: niche === "real_estate" ? "Rivera Realty" : "Lopez Plumbing", niche, trade: "", timezone: "America/Chicago",
      service_area_zips: [], main_phone: "+17135550100" },
    voice: { greeting: "" },
    hours: { mon: ["08:00", "17:00"], tue: ["08:00", "17:00"], wed: ["08:00", "17:00"], thu: ["08:00", "17:00"], fri: ["08:00", "17:00"], sat: null, sun: null },
    booking: { provider: "calendly", enabled: true, windows: [["08:00", "12:00"], ["12:00", "16:00"]],
      job_types: niche === "real_estate" ? ["Buyer consultation", "Listing consultation", "Home showing"] : ["Service call", "Estimate"] },
    notify: { sms: [], email: ["maria@lopezplumbing.com"], daily_summary: "19:00" },
    paused: false,
    plan: { code: "FR_PRO", status: "trialing", service: "full" },
  };
}
const KEYS: Array<[string, string]> = [["hours", "Business hours"], ["faq", "Services & FAQ"], ["alerts", "Emergencies & alerts"],
  ["calendar", "Connect your calendar"], ["tools", "Connect other tools"], ["forward_calls", "Forward your missed calls"], ["sms", "Texting registration (optional, later)"]];

/** One plan client in a (possibly shared) world. */
export function addClient(w: MemoryWorld, opts: { niche?: string; twilio?: string | null; billing?: string; name?: string } = {}) {
  const uid = crypto.randomUUID(), jwt = "jwt-" + uid.slice(0, 8), clientId = crypto.randomUUID(), tenantId = crypto.randomUUID();
  w.users.set(jwt, uid);
  w.clients.set(clientId, { id: clientId, user_id: uid, billing_mode: opts.billing ?? "subscription", status: "onboarding", business_name: "Lopez Plumbing" });
  w.tenants.set(tenantId, { id: tenantId, client_id: clientId, config: defaultConfig(opts.niche), twilio_number: opts.twilio === undefined ? "+13465550199" : opts.twilio });
  w.profiles.set(uid, { full_name: opts.name ?? "Maria Lopez", company: "Lopez Plumbing", email: "maria@lopezplumbing.com", contact_email: null });
  const items: Record<string, string> = {};
  KEYS.forEach(([key, title], i) => {
    const id = crypto.randomUUID(); items[key] = id;
    w.items.set(id, { id, client_id: clientId, key, title, sort: i + 1, status: "todo", data: {} });
  });
  return { uid, jwt, clientId, tenantId, items, db: new MemoryUserDb(w, jwt) };
}
export function world(opts: { niche?: string; twilio?: string | null } = {}) {
  const w = new MemoryWorld((k, d, c) => onboardingConfig().patch(k, d, c));
  const a = addClient(w, opts);
  const store = new MemorySetupStore(w);
  return { w, store, ...a, cfg: () => w.tenants.get(a.tenantId)!.config, item: (k: string) => w.items.get(a.items[k])! };
}

export const stateMsg = (req: any): string => String(req.messages[req.messages.length - 1].content);
/** The proposal id the server told the model about (state message "latest card: proposal_id <id>"). */
export const latestCard = (req: any): string => (/latest card: proposal_id ([0-9a-f-]{36})/.exec(stateMsg(req)) ?? [])[1] ?? "none";
export const turn = (reply: string, ops: any[] = []) => ({ reply, ops });
export const propose = (topic: string, data: any) => ({ op: "propose", topic, data });
export const confirmLatest = (reply = "Saved.") => (req: any) => turn(reply, [{ op: "confirm", proposal_id: latestCard(req) }]);
export const days = (spec: Record<string, [string, string] | null>) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => {
  const v = spec[d] ?? null;
  return [d, v ? { closed: false, open: v[0], close: v[1] } : { closed: true, open: "", close: "" }];
}));

/** Every response body must match the contract (setup_contract.json Response / Error). */
export function contractErrors(body: unknown, def: "Response" | "Error" = "Response"): string[] {
  return validate({ $ref: `#/$defs/${def}` }, body, CONTRACT as any);
}
const bodyOf = (x: any) => (x && x.body && x.status ? x.body : x);   // a runTurn result or its body
export function cards(x: any) { return bodyOf(x).messages.flatMap((m: any) => m.blocks).filter((b: any) => b.type === "summary_card"); }
export function blocks(x: any, type: string) { return bodyOf(x).messages.flatMap((m: any) => m.blocks).filter((b: any) => b.type === type); }
export const lastText = (x: any) => bodyOf(x).messages.filter((m: any) => m.role === "assistant").map((m: any) => m.text).pop() ?? "";
