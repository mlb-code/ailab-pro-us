// A8 email events, fully offline: every template renders (subjects per SPEC §5, no leftovers, escaping, links, dark mode,
// RTL for Meir, CAN-SPAM footer on reminders), sender selection, and the dispatcher against an in-memory outbox with a
// mocked Resend (idempotency, retry/backoff, gating, quiet hours, never twice), the quote-draft task, storage purge,
// and both HTTP handlers. Global fetch is replaced by a thrower: any real network call fails the test.
import { BRAND, PRICEBOOK } from "../config.ts";
import { usd } from "../quote_email.ts";
import { assert, eq } from "../test_util.ts";
import { makeHandler as dispatchHandler } from "../../events-dispatch/index.ts";
import { makeHandler as unsubHandler } from "../../email-unsubscribe/index.ts";
import {
  BACKOFF_MIN, type EmailDb, type EmailSettings, handleEmail, MAX_ATTEMPTS, type OutboxJob, type Outcome, quietDeferral,
  runDispatch, runStoragePurge,
} from "./dispatch.ts";
import type { EmailBrand } from "./layout.ts";
import { type Mailer, type OutMail, pickSender, ResendMailer, type SendResult } from "./mailer.ts";
import { samples } from "./samples.ts";
import { BOUNDARY, type EmailCtx, T_ACCEPTED, T_ADMIN_ACCEPTED, TEMPLATES, UPWORK_MILESTONES } from "./templates.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const B = BRAND as EmailBrand;
const SITE = B.site_url.replace(/\/$/, "");
const NOON_IL = new Date("2026-10-12T09:00:00Z"); // 12:00 owner time (inside Meir's 08–23 window)
const NIGHT_IL = new Date("2026-10-12T00:30:00Z"); // 03:30 owner time
const brandWith = (patch: Record<string, unknown>) => ({ ...structuredClone(B), ...patch }) as EmailBrand;
const HEBREW = /[\u0590-\u05FF]/;

// ------------------------------------------------------------------ templates
Deno.test("went_live: satisfaction guarantee (from pricebook) for RCP/BNDL only, with its end date", async () => {
  const s = await samples();
  const G = PRICEBOOK.refund_rules.rcp_guarantee;
  const base = s.went_live.ctx.client!;
  const render = (products: string[], go_live_at: string | null) =>
    TEMPLATES.went_live.render({ ...s.went_live.ctx, client: { ...base, products, go_live_at } }, { brand: B, now: NOON_IL }).text;
  for (const p of G.codes) assert(render([p], "2026-10-12T15:00:00Z").includes(G.text), `guarantee for ${p}`);
  const until = new Date(Date.parse("2026-10-12T15:00:00Z") + PRICEBOOK.refund_rules.rcp_guarantee_days * 864e5);
  const fmt = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(until);
  assert(render(["RCP"], "2026-10-12T15:00:00Z").includes(`runs until ${fmt}`), "guarantee end date");
  assert(render(["RCP"], null).includes(G.text) && !render(["RCP"], null).includes("runs until"), "no date without go_live_at");
  assert(!render(["WEB"], "2026-10-12T15:00:00Z").includes(G.label), "WEB has no guarantee (deposit rule only)");
});

// ------------------------------------------------------------------ Upwork Direct Contracts (pay_method 'upwork', the default)
const UP_LINK = "https://www.upwork.com/#EMAIL-TEST";
const ESCROW = "releases it to us only when you approve the milestone, or automatically if you don't respond within 14 days after we submit it.";
const render = (k: string, ctx: EmailCtx, payload?: Record<string, unknown>) => TEMPLATES[k].render(ctx, { brand: B, now: NOON_IL, payload });
const has = (r: { text: string }, parts: string[], what: string) => { for (const t of parts) assert(r.text.includes(t), `${what}: missing "${t}"`); };

Deno.test("Upwork: the client's accepted-quote mail without / with the contract link; no method = Upwork; PayPal unchanged", async () => {
  const s = await samples();
  const ctx = s[T_ACCEPTED].ctx, q = ctx.quote!; // sample: paypal_link + PayPal link
  const dep = usd(q.deposit_cents);
  const withQ = (patch: Record<string, unknown>) => ({ ...ctx, quote: { ...q, ...patch } }) as EmailCtx;
  const a = render(T_ACCEPTED, withQ({ pay_method: "upwork", pay_link: null }));
  has(a, [`Next step: your ${dep} deposit, paid securely through Upwork.`, `email from Upwork with your contract ${B.quote_sla_text}.`,
    "Create a free Upwork client account from that email and accept the contract.", `Fund the first milestone (${dep}) by card, PayPal or US bank transfer.`,
    `Upwork holds the money in escrow and ${ESCROW}`, "Upwork adds its own small client fees at checkout.",
    "Already have an Upwork account? Reply to this email with your Upwork email and we'll set it up there.",
    "Once the first milestone is funded, your setup checklist opens in your portal."], "accepted mail, upwork");
  assert(!/Pay deposit|payment link/.test(a.text) && !a.html.includes("paypal.com"), "upwork: no PayPal button or wording");
  eq(a.subject, "Quote accepted — next step: the deposit");
  assert(a.html.includes(`Deposit to start: ${dep}, paid securely through Upwork.`), "preheader");
  eq(render(T_ACCEPTED, withQ({ pay_method: null, pay_link: null })).text, a.text, "no pay method chosen = Upwork (default)");
  const l = render(T_ACCEPTED, withQ({ pay_method: "upwork", pay_link: UP_LINK }));
  assert(l.html.includes(`href="${UP_LINK}"`) && l.html.includes(">Open your Upwork contract</a>"), "upwork + link: button to the contract");
  has(l, [`Open your Upwork contract: ${UP_LINK}`, `Fund the ${dep} deposit there by card, PayPal or bank transfer.`, ESCROW], "accepted mail, upwork + link");
  assert(!l.text.includes("Already have an Upwork account"), "the contract exists: no account question");
  const p = render(T_ACCEPTED, ctx);
  assert(p.text.includes(`Pay deposit ${dep}`) && !/Upwork/.test(p.subject + p.html + p.text), "paypal_link: unchanged");
  const p2 = render(T_ACCEPTED, withQ({ pay_link: null }));
  assert(p2.text.includes(`We'll email your secure payment link for the deposit ${B.quote_sla_text}.`) && !p2.text.includes("Upwork"), "paypal_link, no link: unchanged");
});

Deno.test("Upwork: Meir's mail lists the Direct Contract to create (menu path, email, fixed-price, milestones, description)", async () => {
  const s = await samples();
  const ctx = s[T_ADMIN_ACCEPTED].ctx, q = ctx.quote!;
  const dep = usd(q.deposit_cents), fin = usd((q.setup_cents ?? 0) - (q.deposit_cents ?? 0));
  const rcp = PRICEBOOK.items.find((i) => i.code === "RCP")!.name;
  const m = render(T_ADMIN_ACCEPTED, { ...ctx, quote: { ...q, pay_method: "upwork", pay_link: null } });
  has(m, ["Create in Upwork:", "Find work → Direct Contracts → Create a contract", `Client email: ${ctx.profile!.email!}`, "Contract type: Fixed-price",
    `Contract name: ${B.name} – ${rcp} setup`, `Milestone 1 (deposit): name: ${UPWORK_MILESTONES.setup_line}`, `Milestone 1: amount: ${dep}`,
    `Milestone 2 (before go-live): name: ${UPWORK_MILESTONES.golive}`, `Milestone 2: amount: ${fin}`,
    `Description (one line): Setup of the ${rcp} as described in your accepted fixed quote`, `Monthly plan from go-live: ${usd(q.monthly_cents)}/mo, one milestone per month.`,
    "If the client already has an Upwork account: ask them to hire you through your profile", "Payment method: Upwork (Direct Contract)", "Create the Upwork contract with the details above.",
    "Mark paid"], "admin upwork");
  assert(!m.text.includes("Send the client a payment link"), "upwork: no 'send a payment link' task");
  assert(m.html.includes('lang="en" dir="ltr"') && m.html.includes("Find work → Direct Contracts → Create a contract") && !m.html.includes("\u2066"), "LTR English, no RTL isolates");
  const p = render(T_ADMIN_ACCEPTED, ctx); // PayPal with a link: unchanged
  assert(!p.text.includes("Upwork") && p.text.includes("Payment link: Yes, the client sees a pay button"), "paypal_link: unchanged");
  assert(render(T_ADMIN_ACCEPTED, { ...ctx, quote: { ...q, pay_link: null } }).text.includes("Send the client a payment link for the deposit."), "paypal_link, no link: unchanged");
  // WEB quote: the website milestone name; no quote on the WEB self-serve path -> amounts left to Meir
  const web = render(T_ADMIN_ACCEPTED, { ...ctx, quote: { ...q, pay_method: "upwork", items: [{ code: "WEB", qty: 1 }] } });
  has(web, [`Milestone 1 (deposit): name: ${UPWORK_MILESTONES.setup_web}`, `Milestone 1: amount: ${dep}`], "WEB quote: website milestone");
  const wl = render("web_deposit_link_requested", s.web_deposit_link_requested.ctx);
  has(wl, ["Find work → Direct Contracts → Create a contract", `Contract name: ${B.name} – ${PRICEBOOK.items.find((i) => i.code === "WEB")!.name} setup`,
    `Milestone 1 (deposit): name: ${UPWORK_MILESTONES.setup_web}`, "as chosen in your questionnaire", `the deposit is ${PRICEBOOK.rules.deposit_pct}% of the setup price`],
    "web_deposit_link_requested upwork");
  assert(!wl.text.includes("amount:"), "WEB self-serve: no quote, so no amounts printed");
  assert(wl.html.includes("Create an Upwork contract for the deposit"), "preheader: create the Upwork contract");
});

Deno.test("Upwork: final payment, monthly invoice, deposit received, WEB deposit ack; other methods unchanged", async () => {
  const s = await samples();
  const pay = (method: string, kind = "final", amount_cents = 1) => ({ id: "p1", kind, amount_cents, method, status: "due" });
  // final_payment_due: no payment row (amount from the quote) -> the default; the final row's method decides otherwise
  const fctx = s.final_payment_due.ctx, amt = usd(fctx.final_cents);
  has(render("final_payment_due", fctx), [`Next: fund the Go-live milestone (${amt}) in your Upwork contract, by card, PayPal or US bank transfer.`, ESCROW,
    "Once it's funded, we set your go-live date"], "final_payment_due upwork");
  has(render("final_payment_due", { ...fctx, payment: pay("upwork", "final", fctx.final_cents!) }), ["Go-live milestone"], "final row on upwork");
  const f0 = render("final_payment_due", { ...fctx, payment: pay("paypal_link", "final", fctx.final_cents!) });
  assert(f0.text.includes(`We'll email your secure payment link ${B.quote_sla_text}.`) && !f0.text.includes("Upwork"), "final, paypal_link: unchanged");
  // monthly_invoice: one milestone per month
  const mctx = s.monthly_invoice.ctx, mon = usd(mctx.client!.monthly_cents);
  has(render("monthly_invoice", mctx, s.monthly_invoice.payload), [`We add this month's milestone (${mon}) to your Upwork contract ${B.quote_sla_text}.`,
    "Fund it there by card, PayPal or US bank transfer.", ESCROW], "monthly_invoice upwork");
  const m0 = render("monthly_invoice", { ...mctx, payment: pay("wire", "monthly") }, s.monthly_invoice.payload);
  assert(m0.text.includes("All payments are listed in the Billing tab") && !m0.text.includes("Upwork"), "monthly, wire: unchanged");
  // deposit_received: funded in Upwork escrow; milestone 1 submitted when ready for the client's own test
  const dctx = s.deposit_received.ctx;
  has(render("deposit_received", dctx), ["your deposit is funded in Upwork — thank you.", "Upwork holds your deposit in escrow.",
    "We submit this milestone when your line is ready for your test call; approve it in Upwork once you've tried it."], "deposit_received upwork");
  has(render("deposit_received", { ...dctx, client: { ...dctx.client!, products: ["WEB"] } }), ["website is ready for your review"], "deposit_received WEB");
  const d0 = render("deposit_received", { ...dctx, payment: pay("paypal", "deposit") });
  assert(d0.text.includes("we received your deposit — thank you.") && !d0.text.includes("Upwork"), "deposit, paypal: unchanged");
  // web_deposit_ack (WEB has no quote): Upwork contract email, free account, escrow, existing account
  const wctx = s.web_deposit_ack.ctx;
  const w = render("web_deposit_ack", wctx);
  has(w, [`You'll get an email from Upwork with your contract ${B.quote_sla_text}`, "create a free Upwork client account",
    "fund the first milestone by card, PayPal or US bank transfer.", ESCROW, "Already have an Upwork account?",
    "Once the deposit is funded, your setup checklist opens"], "web_deposit_ack upwork");
  eq(w.subject, "Your deposit link is on its way");
  const w0 = render("web_deposit_ack", { ...wctx, payment: pay("paypal_link", "deposit") });
  assert(w0.text.includes(`We'll email your secure deposit link ${B.quote_sla_text}.`) && !w0.text.includes("Upwork"), "web ack, paypal_link: unchanged");
});

Deno.test("SPEC §5: every event is either rendered here or documented as sent elsewhere", () => {
  const spec = ["auth_code", "lead_capture", "q_received", "admin_new_quote", "quote_sent", "quote_reminder", T_ADMIN_ACCEPTED,
    "deposit_received", "onboarding_nudge", "need_help", "ready_to_test", "final_payment_due", "went_live", "lead_alert",
    "daily_summary", "request_update", "monthly_invoice", "admin_daily"];
  eq(spec.length, 18);
  for (const k of spec) assert(TEMPLATES[k] || BOUNDARY[k], `SPEC event ${k} has no owner`);
  for (const k of Object.keys(BOUNDARY)) assert(!TEMPLATES[k], `${k} must not be sent twice (runtime/auth own it)`);
  // the two extra quote mails A6 emits are rendered too
  assert(TEMPLATES[T_ACCEPTED] && TEMPLATES.quote_expiring);
});

Deno.test("subjects match SPEC §5 (with live data)", async () => {
  const s = await samples();
  const q = s.quote_sent.ctx.quote!;
  const subj = (k: string) => TEMPLATES[k].render(s[k].ctx, { brand: B, now: NOON_IL, payload: s[k].payload, unsubUrl: "https://x.test/u" }).subject;
  eq(subj("lead_capture"), "Your fixed-quote link");
  eq(subj("q_received"), `Got it — your fixed quote arrives ${B.quote_sla_text}`);
  eq(subj("admin_new_quote"), `New quote to approve: Cool Breeze HVAC · RCP · ${usd(q.setup_cents)}`);
  eq(subj("quote_sent"), `Your fixed quote from ${B.name}: ${usd(q.setup_cents)} + ${usd(q.monthly_cents)}/mo`);
  eq(subj("quote_reminder"), "Any questions about your quote?");
  eq(subj(T_ADMIN_ACCEPTED), "✅ Cool Breeze HVAC accepted a quote, payment pending");
  eq(subj("deposit_received"), "Welcome aboard — your setup checklist is ready");
  eq(subj("onboarding_nudge"), "2 steps left to get your receptionist live");
  eq(subj("need_help"), "Cool Breeze HVAC needs help with: Connect your calendar");
  eq(subj("ready_to_test"), "Your AI receptionist is ready to test");
  eq(subj("final_payment_due"), "Final payment before go-live");
  eq(subj("went_live"), "You're live 🎉 — what happens now");
  eq(subj("request_update"), 'Request "Add a question about filter size" is now waiting on you');
  eq(subj("monthly_invoice"), `Your ${B.name} monthly invoice`);
  assert(/^Your fixed quote expires on \w+ \d{1,2}, \d{4}$/.test(subj("quote_expiring")), subj("quote_expiring"));
  eq(subj(T_ACCEPTED), "Quote accepted — next step: the deposit");
  eq(subj("web_deposit_ack"), "Your deposit link is on its way");
  eq(subj("web_deposit_link_requested"), "Website (WEB): Cool Breeze HVAC is waiting for a deposit link");
  eq(subj("request_cancelled"), 'Request "Change the greeting" was cancelled');
  eq(subj("admin_request_cancelled"), "Cool Breeze HVAC canceled a request: Change the greeting");
  eq([TEMPLATES.web_deposit_link_requested.audience, TEMPLATES.admin_request_cancelled.audience, TEMPLATES.web_deposit_ack.audience,
    TEMPLATES.request_cancelled.audience], ["admin", "admin", "client", "client"]);
  const ack = TEMPLATES.web_deposit_ack.render(s.web_deposit_ack.ctx, { brand: B, now: NOON_IL });
  assert(ack.text.includes(B.quote_sla_text), "deposit ack uses quote_sla_text");
  const wl = TEMPLATES.web_deposit_link_requested.render(s.web_deposit_link_requested.ctx, { brand: B, now: NOON_IL });
  assert(wl.html.includes(`${SITE}/start/admin/#questionnaires/`) && wl.html.includes("dani@example.com") && !wl.html.includes("Spanish:"),
    "admin WEB mail: client details, admin link, empty answers dropped");
});

Deno.test("every template: html+text, no leftovers, ≤ 600 px, dark-mode, language/direction, footer rules, links", async () => {
  const s = await samples();
  for (const [k, tpl] of Object.entries(TEMPLATES)) {
    const unsub = "https://ref.supabase.co/functions/v1/email-unsubscribe?u=" + "a".repeat(64);
    const r = tpl.render(s[k].ctx, { brand: B, now: NOON_IL, payload: s[k].payload, unsubUrl: tpl.transactional ? undefined : unsub });
    const all = r.subject + r.html + r.text;
    assert(!/\{\{|\}\}|\bundefined\b|\bNaN\b|\[object Object\]/.test(all), `${k}: template leftovers`);
    assert(!/>null<|: null\b/.test(r.html + r.text), `${k}: null rendered`);
    assert(r.text.trim().length > 60, `${k}: plain-text part`);
    assert(r.html.includes('width="600"') && !/width="(6[1-9]\d|[7-9]\d\d)"/.test(r.html), `${k}: ≤ 600 px`);
    assert(r.html.includes('name="color-scheme"') && r.html.includes("prefers-color-scheme: dark"), `${k}: dark mode`);
    assert(/<table role="presentation"/.test(r.html) && !/<link |<script/i.test(r.html), `${k}: table layout, no external css/js`);
    if (tpl.audience === "client") {
      assert(r.html.includes('lang="en" dir="ltr"'), `${k}: en/ltr`);
      assert(!HEBREW.test(all), `${k}: no Hebrew in client mail`);
      assert(r.html.includes(B.disclaimers.footer), `${k}: footer disclaimer`);
    } else {
      assert(r.html.includes('lang="en" dir="ltr"') && !HEBREW.test(all), `${k}: English LTR for Meir (no Hebrew)`);
      assert(r.text.includes(`Sent automatically by ${B.name}.`), `${k}: admin footer`);
    }
    if (!tpl.transactional) {
      assert(r.html.includes(unsub) && r.text.includes(unsub) && /Unsubscribe/.test(r.html), `${k}: unsubscribe link`);
    } else {
      assert(!/Unsubscribe/i.test(r.html), `${k}: no unsubscribe on transactional/admin mail`);
    }
    // every link is the brand site, the quote page (#t=), the unsubscribe endpoint, the pay link or Calendly
    for (const [, href] of r.html.matchAll(/href="([^"]+)"/g)) {
      const u = href.replace(/&amp;/g, "&");
      assert(u.startsWith(SITE + "/") || u === unsub || u.startsWith("https://www.paypal.com/") || (B.calendly_url && u === B.calendly_url),
        `${k}: foreign link ${u}`);
      if (u.includes("/quote/")) assert(u.startsWith(`${SITE}/quote/#t=`), `${k}: quote link must use #t=`);
    }
  }
});

Deno.test("escaping: customer-typed values never become HTML", async () => {
  const s = await samples();
  const evil = '<img src=x onerror=alert(1)> & "Co"';
  for (const k of ["q_received", "need_help", "request_update", "admin_new_quote"]) {
    const ctx = structuredClone(s[k].ctx);
    ctx.profile = { ...ctx.profile, company: evil, full_name: evil };
    if (ctx.item) ctx.item.message = evil;
    if (ctx.request) { ctx.request.title = evil; ctx.request.admin_reply = evil; }
    const r = TEMPLATES[k].render(ctx, { brand: B, now: NOON_IL });
    assert(!r.html.includes("<img src=x") && r.html.includes("&lt;img src=x"), `${k}: escaped`);
  }
});

Deno.test("brand comes from config: renaming the brand changes every client mail", async () => {
  const s = await samples();
  const b2 = brandWith({ name: "Zeta Test Brand", site_url: "https://zeta.example" });
  for (const k of ["q_received", "deposit_received", "monthly_invoice"]) {
    const r = TEMPLATES[k].render(s[k].ctx, { brand: b2, now: NOON_IL, payload: s[k].payload });
    assert(r.html.includes("Zeta Test Brand") && r.html.includes("https://zeta.example/start/") && !r.html.includes(B.name), k);
  }
});

Deno.test("sender: smtp_from -> senders.<kind> -> senders.fallback", () => {
  eq(pickSender(B, "quotes"), B.smtp_from || B.senders.quotes);
  eq(pickSender(brandWith({ smtp_from: "Ops <ops@x.test>" }), "alerts"), "Ops <ops@x.test>");
  const noKind = brandWith({ smtp_from: "", senders: { ...B.senders, alerts: "" } });
  eq(pickSender(noKind, "alerts"), B.senders.fallback);
});

// ------------------------------------------------------------------ dispatcher (in-memory outbox)
interface Row extends OutboxJob { status: string; next_attempt_at: number; done?: Outcome }
class MemDb implements EmailDb {
  rows: Row[] = [];
  settingsV: EmailSettings = { admin_email: "owner@example.com", client_emails_enabled: true, admin_emails_enabled: true };
  recipients = new Map<string, { token: string; unsubscribed: boolean }>();
  purge: Array<{ bucket_id: string; name: string; done?: boolean }> = [];
  clock = () => NOON_IL.getTime();
  add(template: string, ctx: OutboxJob["ctx"], extra: Partial<Row> = {}) {
    const id = this.rows.length + 1;
    const r: Row = { id, idem_key: `${template}:${id}`, template, audience: template.startsWith("task:") ? "system" : TEMPLATES[template]?.audience ?? "client",
      entity: "x", entity_id: null, attempts: 0, payload: {}, created_at: "", ctx, status: "pending", next_attempt_at: 0, ...extra };
    this.rows.push(r);
    return r;
  }
  claim(kind: "email" | "task", limit: number) {
    const due = this.rows.filter((r) => ["pending"].includes(r.status) && r.next_attempt_at <= this.clock() &&
      (kind === "task") === (r.audience === "system")).slice(0, limit);
    for (const r of due) { r.status = "sending"; r.attempts++; }
    return Promise.resolve(structuredClone(due) as OutboxJob[]);
  }
  complete(id: number, o: Outcome) {
    const r = this.rows.find((x) => x.id === id)!;
    if (r.status !== "sending") return Promise.resolve();
    r.done = o;
    if (o.result === "retry" || o.result === "defer") {
      r.status = "pending"; r.next_attempt_at = o.retry_at.getTime();
      if (o.result === "defer") r.attempts--;
    } else r.status = o.result;
    return Promise.resolve();
  }
  settings() { return Promise.resolve({ ...this.settingsV }); }
  recipient(email: string) {
    if (!this.recipients.has(email)) this.recipients.set(email, { token: "f".repeat(64), unsubscribed: false });
    return Promise.resolve({ ...this.recipients.get(email)! });
  }
  unsubscribe(token: string) {
    for (const v of this.recipients.values()) if (v.token === token) { v.unsubscribed = true; return Promise.resolve(true); }
    return Promise.resolve(false);
  }
  purgeClaim(limit: number) { return Promise.resolve(this.purge.filter((p) => !p.done).slice(0, limit).map(({ bucket_id, name }) => ({ bucket_id, name }))); }
  purgeDone(bucket: string, names: string[]) {
    let n = 0;
    for (const p of this.purge) if (p.bucket_id === bucket && names.includes(p.name) && !p.done) { p.done = true; n++; }
    return Promise.resolve(n);
  }
}

class FakeMailer implements Mailer {
  sent: Array<{ mail: OutMail; key: string }> = [];
  script: SendResult[] = [];
  send(mail: OutMail, key: string) {
    this.sent.push({ mail, key });
    return Promise.resolve(this.script.shift() ?? { ok: true, id: `re_${this.sent.length}` } as SendResult);
  }
}

const deps = (db: MemDb, mailer: Mailer | null, extra: Record<string, unknown> = {}) => ({
  db, mailer, brand: brandWith({ physical_address: "1 Test St, Tel Aviv" }), supabaseUrl: "https://ref.supabase.co",
  serviceKey: "svc-key", now: () => new Date(db.clock()), ...extra,
});

Deno.test("dispatch: sends once with the outbox key as Idempotency-Key; a second run sends nothing", async () => {
  const s = await samples();
  const db = new MemDb(), m = new FakeMailer();
  const row = db.add("q_received", s.q_received.ctx);
  const rep = await runDispatch(deps(db, m));
  eq([rep.sent, m.sent.length, row.status], [1, 1, "sent"]);
  eq(m.sent[0].key, row.idem_key);
  eq(m.sent[0].mail.to, "dani@example.com");
  eq(m.sent[0].mail.from, pickSender(B, "transactional"));
  eq(m.sent[0].mail.reply_to, B.senders.reply_to);
  eq(m.sent[0].mail.tag, "q_received");
  await runDispatch(deps(db, m));
  eq(m.sent.length, 1, "never twice");
});

Deno.test("dispatch: retry with backoff on 5xx/429/network, give up after MAX_ATTEMPTS; 4xx fails at once", async () => {
  const s = await samples();
  const db = new MemDb(), m = new FakeMailer();
  const row = db.add("deposit_received", s.deposit_received.ctx);
  m.script = Array.from({ length: MAX_ATTEMPTS }, () => ({ ok: false, retry: true, error: "resend 503" }) as SendResult);
  const waits: number[] = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const before = db.clock();
    await runDispatch(deps(db, m));
    if (row.status === "pending") { waits.push((row.next_attempt_at - before) / 60_000); db.clock = () => row.next_attempt_at; }
  }
  eq(waits, BACKOFF_MIN, "backoff minutes");
  eq([row.status, m.sent.length], ["failed", MAX_ATTEMPTS]);
  assert(m.sent.every((x) => x.key === row.idem_key), "same idempotency key on every retry");

  const db2 = new MemDb(), m2 = new FakeMailer();
  const r2 = db2.add("went_live", s.went_live.ctx);
  m2.script = [{ ok: false, retry: false, error: "resend 422: invalid to" }];
  await runDispatch(deps(db2, m2));
  eq([r2.status, m2.sent.length], ["failed", 1]);
});

Deno.test("dispatch: unverified domain -> one resend from senders.fallback", async () => {
  const s = await samples();
  const db = new MemDb(), m = new FakeMailer();
  const row = db.add("went_live", s.went_live.ctx);
  m.script = [{ ok: false, retry: false, domain: true, error: "resend 403: domain is not verified" }];
  await runDispatch(deps(db, m));
  eq([row.status, m.sent.length, m.sent[1].mail.from, m.sent[1].key], ["sent", 2, B.senders.fallback, `${row.idem_key}:fallback`]);
});

Deno.test("dispatch gating: client_emails_enabled only blocks reminders; unsubscribe; no address; no recipient; ctx.skip", async () => {
  const s = await samples();
  const db = new MemDb(), m = new FakeMailer();
  db.settingsV.client_emails_enabled = false;
  const tx = db.add("quote_sent", s.quote_sent.ctx);
  const rem = db.add("quote_reminder", s.quote_reminder.ctx);
  const nud = db.add("onboarding_nudge", s.onboarding_nudge.ctx);
  const nob = db.add("q_received", { ...s.q_received.ctx, to: null });
  const skp = db.add("went_live", { skip: "status_moved" });
  await runDispatch(deps(db, m));
  eq([tx.status, rem.status, nud.status, nob.status, skp.status], ["sent", "skipped", "skipped", "skipped", "skipped"]);
  eq((rem.done as { error: string }).error, "client_emails_disabled");
  eq((nob.done as { error: string }).error, "no_recipient");
  eq(m.sent.length, 1);

  // reminders on: unsubscribe header + link, then the unsubscribed address is skipped
  const db2 = new MemDb(), m2 = new FakeMailer();
  const r1 = db2.add("quote_reminder", s.quote_reminder.ctx);
  await runDispatch(deps(db2, m2));
  eq(r1.status, "sent");
  const h = m2.sent[0].mail.headers!;
  assert(h["List-Unsubscribe"].includes("/functions/v1/email-unsubscribe?u=") && h["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
  assert(m2.sent[0].mail.html.includes("1 Test St"), "physical address on reminders");
  await db2.unsubscribe("f".repeat(64));
  const r2 = db2.add("quote_expiring", s.quote_expiring.ctx);
  await runDispatch(deps(db2, m2));
  eq([r2.status, (r2.done as { error: string }).error], ["skipped", "unsubscribed"]);

  // CAN-SPAM: no physical address configured -> reminders are not sent at all
  const db3 = new MemDb(), m3 = new FakeMailer();
  const r3 = db3.add("quote_reminder", s.quote_reminder.ctx);
  await runDispatch({ ...deps(db3, m3), brand: brandWith({ physical_address: "" }) });
  eq([r3.status, (r3.done as { error: string }).error, m3.sent.length], ["skipped", "no_physical_address", 0]);
});

Deno.test("dispatch: Meir's mails wait for 08:00 owner time, honour admin_emails_enabled, reply-to = the client", async () => {
  const s = await samples();
  const db = new MemDb(), m = new FakeMailer();
  db.clock = () => NIGHT_IL.getTime();
  const row = db.add("need_help", s.need_help.ctx);
  await runDispatch(deps(db, m));
  eq([row.status, row.attempts, m.sent.length], ["pending", 0, 0], "deferred without burning an attempt");
  eq(new Date(row.next_attempt_at).toISOString(), "2026-10-12T05:00:00.000Z", "08:00 Asia/Jerusalem (IDT)");
  db.clock = () => row.next_attempt_at;
  await runDispatch(deps(db, m));
  eq([row.status, m.sent[0].mail.to, m.sent[0].mail.reply_to, m.sent[0].mail.from], ["sent", "owner@example.com", "dani@example.com", pickSender(B, "alerts")]);

  const db2 = new MemDb();
  db2.settingsV.admin_emails_enabled = false;
  const r2 = db2.add(T_ADMIN_ACCEPTED, s[T_ADMIN_ACCEPTED].ctx);
  await runDispatch(deps(db2, new FakeMailer()));
  eq(r2.status, "skipped");
  eq(quietDeferral(new Date("2026-10-12T19:59:00Z"), "Asia/Jerusalem"), null, "22:59 is still inside the window");
});

Deno.test("dispatch: no RESEND_API_KEY -> emails stay pending (no attempt burned); unknown template fails", async () => {
  const s = await samples();
  const db = new MemDb();
  const row = db.add("q_received", s.q_received.ctx);
  await runDispatch(deps(db, null));
  eq([row.status, row.attempts], ["pending", 0]);
  const bad = new MemDb();
  const r = bad.add("q_received", s.q_received.ctx, { template: "nope" });
  eq((await handleEmail({ ...r, attempts: 1 }, bad.settingsV, deps(bad, new FakeMailer()))).result, "failed");
});

Deno.test("task draft_quote: calls quote-draft with the service key; skips when a quote exists; retries on 5xx", async () => {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  let status = 200;
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) });
    return Promise.resolve(new Response(JSON.stringify(status === 200 ? { quote_id: "q-1", status: "draft" } : { error: "x" }), { status }));
  }) as unknown as typeof fetch;
  const db = new MemDb();
  const t1 = db.add("task:draft_quote", { questionnaire: { id: "qn-1", offer: "RCP", niche: "home_services", status: "submitted" }, has_quote: false });
  const t2 = db.add("task:draft_quote", { questionnaire: { id: "qn-2", offer: "RCP", niche: "home_services", status: "submitted" }, has_quote: true });
  await runDispatch(deps(db, null, { fetchFn }));
  await runDispatch(deps(db, null, { fetchFn }));
  eq([t1.status, t2.status, calls.length], ["sent", "skipped", 1]);
  eq(calls[0], { url: "https://ref.supabase.co/functions/v1/quote-draft", auth: "Bearer svc-key", body: '{"questionnaire_id":"qn-1"}' });
  status = 503;
  const t3 = db.add("task:draft_quote", { questionnaire: { id: "qn-3", offer: "WEB", niche: "home_services", status: "submitted" }, has_quote: false });
  await runDispatch(deps(db, null, { fetchFn }));
  eq([t3.status, t3.attempts], ["pending", 1]);
});

Deno.test("storage purge: deletes queued files via the Storage API and marks them done; errors leave them queued", async () => {
  const db = new MemDb();
  db.purge = [{ bucket_id: "client-files", name: "u1/q1/abc123-a.pdf" }, { bucket_id: "client-files", name: "u1/q1/def456-b.png" }];
  const seen: Array<{ url: string; method: string; body: string }> = [];
  let ok = false;
  const fetchFn = ((url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), body: String(init.body) });
    return Promise.resolve(new Response("[]", { status: ok ? 200 : 500 }));
  }) as unknown as typeof fetch;
  const d = { db, supabaseUrl: "https://ref.supabase.co", serviceKey: "svc-key", fetchFn };
  eq(await runStoragePurge(d), { queued: 2, deleted: 0, errors: 1 });
  ok = true;
  eq(await runStoragePurge(d), { queued: 2, deleted: 2, errors: 0 });
  eq(await runStoragePurge(d), { queued: 0, deleted: 0, errors: 0 });
  eq([seen[1].url, seen[1].method, JSON.parse(seen[1].body).prefixes.length], ["https://ref.supabase.co/storage/v1/object/client-files", "DELETE", 2]);
});

Deno.test("ResendMailer: request shape + error classification (mocked fetch)", async () => {
  const reqs: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const queue = [new Response('{"id":"re_1"}', { status: 200 }), new Response('{"message":"rate"}', { status: 429 }),
    new Response('{"message":"The ailabpro domain is not verified"}', { status: 403 }), new Response('{"message":"bad"}', { status: 422 })];
  const fetchFn = ((_u: string, init: RequestInit) => {
    reqs.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return Promise.resolve(queue.shift()!);
  }) as unknown as typeof fetch;
  const mailer = new ResendMailer("re_test_key", fetchFn);
  const mail: OutMail = { from: "A <a@x.test>", to: "b@x.test", subject: "S", html: "<p>h</p>", text: "t", reply_to: "r@x.test",
    headers: { "List-Unsubscribe": "<https://u>" }, tag: "task:x" };
  eq(await mailer.send(mail, "k1"), { ok: true, id: "re_1" });
  eq(reqs[0].headers["Idempotency-Key"], "k1");
  eq([reqs[0].body.to, reqs[0].body.reply_to, (reqs[0].body.tags as Array<{ value: string }>)[0].value], [["b@x.test"], "r@x.test", "task_x"]);
  eq((await mailer.send(mail, "k2")) as unknown, { ok: false, retry: true, domain: false, error: "resend 429: rate" });
  const d = await mailer.send(mail, "k3");
  assert(!d.ok && d.domain && !d.retry);
  const e = await mailer.send(mail, "k4");
  assert(!e.ok && !e.retry && !e.domain);
  const net = new ResendMailer("k", (() => Promise.reject(new TypeError("down"))) as unknown as typeof fetch);
  const n = await net.send(mail, "k5");
  assert(!n.ok && n.retry);
});

// ------------------------------------------------------------------ HTTP handlers
Deno.test("events-dispatch: POST + service key only; routes email / storage_purge", async () => {
  const db = new MemDb();
  const h = dispatchHandler({ db: () => db, mailer: () => new FakeMailer(), supabaseUrl: () => "https://ref.supabase.co", serviceKey: () => "svc-key",
    now: () => NOON_IL, fetchFn: (() => Promise.resolve(new Response("[]"))) as unknown as typeof fetch });
  const post = (body: unknown, auth?: string) => h(new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: auth ? { authorization: auth } : {} }));
  eq((await h(new Request("http://x/"))).status, 405);
  eq((await post({})).status, 403);
  eq((await post({}, "Bearer nope")).status, 403);
  eq((await post({}, "Bearer svc-ke")).status, 403);
  const r = await post({ task: "email" }, "Bearer svc-key");
  eq([r.status, (await r.json()).claimed], [200, 0]);
  eq((await post({ task: "storage_purge" }, "Bearer svc-key")).status, 200);
  eq((await post({ task: "drop" }, "Bearer svc-key")).status, 400);
});

Deno.test("events-dispatch: any configured server key is accepted (named secret key in Vault vs default), apikey header too", async () => {
  const db = new MemDb();
  const h = dispatchHandler({ db: () => db, mailer: () => new FakeMailer(), supabaseUrl: () => "https://ref.supabase.co",
    serviceKey: () => "sb_secret_default", serviceKeys: () => ["sb_secret_default", "sb_secret_runtime", "", "legacy.jwt.x"],
    now: () => NOON_IL, fetchFn: (() => Promise.resolve(new Response("[]"))) as unknown as typeof fetch });
  const post = (headers: Record<string, string>) => h(new Request("http://x/", { method: "POST", body: "{}", headers }));
  eq((await post({ authorization: "Bearer sb_secret_default" })).status, 200);
  eq((await post({ authorization: "Bearer sb_secret_runtime" })).status, 200);
  eq((await post({ authorization: "Bearer legacy.jwt.x" })).status, 200);
  eq((await post({ apikey: "sb_secret_runtime" })).status, 200);
  eq((await post({ authorization: "Bearer sb_secret_other" })).status, 403);
  eq((await post({ apikey: "" })).status, 403);
  eq((await post({ authorization: "Bearer " })).status, 403);
});

Deno.test("email-unsubscribe: valid token opts out; any token gets the same plain-text answer", async () => {
  const db = new MemDb();
  await db.recipient("dani@example.com");
  const h = unsubHandler({ db: () => db });
  const r1 = await h(new Request("http://x/?u=" + "0".repeat(64)));
  const r2 = await h(new Request("http://x/?u=" + "f".repeat(64), { method: "POST" }));
  eq([r1.status, r2.status], [200, 200]);
  eq(await r1.text(), await r2.text());
  eq(r2.headers.get("content-type"), "text/plain; charset=utf-8");
  eq((await db.recipient("dani@example.com")).unsubscribed, true);
  eq((await h(new Request("http://x/?u=1", { method: "DELETE" }))).status, 405);
});

Deno.test("FirstRing plan mails: trial reminder, message mode, restored, no go-live button / final payment wording", async () => {
  const s = await samples();
  const plans = (PRICEBOOK as unknown as { plans?: Array<{ code: string; name: string; monthly_cents: number }> }).plans ?? [];
  const pro = plans.find((p) => p.code === "FR_PRO");
  const t = render("trial_ending", s.trial_ending.ctx);
  has(t, ["December 9, 2026", "Cancel in your portal", "pay nothing"], "trial_ending");
  if (pro) has(t, [pro.name, `${usd(pro.monthly_cents)}/mo`], "trial_ending plan from the price book");
  const mm = render("subscription_message_mode", s.subscription_message_mode.ctx);
  has(mm, ["message mode", "name, number and reason", "does not book visits", "Turn off call forwarding", "Restart my plan"], "message mode");
  for (const [reason, line] of [["trial_ended", "free trial ended"], ["past_due", "update your payment details"], ["paused", "paused"]]) {
    const ctx = { ...s.subscription_message_mode.ctx, subscription: { plan_code: "FR_STARTER", status: "x", reason } };
    assert(render("subscription_message_mode", ctx).text.includes(line), `message mode ${reason}`);
  }
  has(render("subscription_restored", s.subscription_restored.ctx), ["back to full answering", "active again"], "restored");
  const ready = render("ready_to_test", { ...s.ready_to_test.ctx, client: { ...s.ready_to_test.ctx.client!, billing_mode: "subscription" } });
  assert(!ready.text.includes("Request go-live") && ready.text.includes("goes live on its own"), "plan ready_to_test is automatic");
  const live = render("went_live", { ...s.went_live.ctx, client: { ...s.went_live.ctx.client!, billing_mode: "subscription" },
    subscription: { plan_code: "FR_PRO", status: "active" } });
  assert(!/Monthly/.test(live.text) && (!pro || live.text.includes(pro.name)), "plan went_live shows the plan, not a quote fee");
  eq([TEMPLATES.admin_provisioning_alert.audience, TEMPLATES.admin_billing_request.audience, TEMPLATES.trial_ending.transactional], ["admin", "admin", true]);
});

Deno.test("admin_provisioning_alert: each step has a human label; self-confirmed forwarding has no Retry line", async () => {
  const s = await samples();
  const ctx = s.admin_provisioning_alert.ctx;
  const dup = render("admin_provisioning_alert", ctx, { step: "duplicate_trial", error: "x" });
  has(dup, ["Step: Second free trial for the same business phone", "'Retry: setup'"], "duplicate_trial");
  const setup = render("admin_provisioning_alert", ctx, { step: "setup", error: "tenant failed" });
  has(setup, ["Step: Automatic setup (client card, tenant, checklist)", "Details: tenant failed", "'Retry: setup'"], "setup");
  const fwd = render("admin_provisioning_alert", ctx, { step: "forwarding_self_confirmed",
    error: "Call forwarding: UNVERIFIED, self-confirmed by the client." });
  has(fwd, ["Step: Call forwarding confirmed by the client, not verified", "confirmed call forwarding themselves, without a verified test call",
    "Call the business line yourself", "Forwarding unverified (self-confirmed)", "UNVERIFIED, self-confirmed by the client"], "forwarding_self_confirmed");
  assert(!/retry/i.test(fwd.text.replace("Nothing to retry", "")), "forwarding_self_confirmed: no Retry line");
  assert(fwd.subject.startsWith("⚠️ Call forwarding unverified:") && !fwd.text.includes("forwarding_self_confirmed"),
    "forwarding_self_confirmed: human subject, no raw step key");
});

Deno.test("admin_provisioning_alert: the setup assistant's alerts (budget / auth / down) are labelled and say what to check", async () => {
  const s = await samples();
  const ctx = s.admin_provisioning_alert.ctx;
  const auth = render("admin_provisioning_alert", ctx, { step: "setup_agent_auth", error: "Setup assistant: model auth" });
  has(auth, ["Step: Setup assistant: API key refused", "ANTHROPIC_API_KEY_SETUP", "paused for an hour"], "setup_agent_auth");
  eq(auth.subject, "⚠️ Setup assistant: API key refused");
  has(render("admin_provisioning_alert", ctx, { step: "setup_agent_budget", error: "x" }), ["Step: Setup assistant: spend limit or daily budget reached",
    "setup_agent_daily_budget_usd"], "setup_agent_budget");
  const down = render("admin_provisioning_alert", ctx, { step: "setup_agent_down", error: "x" });
  assert(!/Retry: setup/.test(down.text) && !down.text.includes("setup_agent_down"), "no Retry line, no raw step key");
  has(render("admin_provisioning_alert", ctx, { step: "setup_agent_request", error: "model bad_request (HTTP 400): invalid_request_error: grammar too large" }),
    ["Step: Setup assistant: the AI provider refused our request", "grammar too large", "SETUP_WIRE"], "setup_agent_request");
});

Deno.test("FirstRing sign-up mails: trial / paid welcome to the customer, Hebrew alerts to Meir (new + cancelled)", async () => {
  const s = await samples();
  const plans = (PRICEBOOK as unknown as { plans: Array<{ code: string; name: string; product: string; monthly_cents: number; trial_minutes: number;
    included_usage: { voice_minutes: number } }> }).plans;
  const pro = plans.find((p) => p.code === "FR_PRO")!;
  const cancelText = (PRICEBOOK.rules as unknown as { subscription: { texts: { cancel: string } } }).subscription.texts.cancel;
  const t = render("trial_welcome", s.trial_welcome.ctx);
  eq(t.subject, `Your free trial of ${pro.product} ${pro.name} has started`);
  has(t, ["Hi Dani,", "Free trial until: December 10, 2026", `Included in the trial: Up to ${pro.trial_minutes} minutes of calls`,
    `First charge: ${usd(pro.monthly_cents)} on December 10, 2026, unless you cancel`, "Next step:", "finish the setup checklist in your portal",
    "goes live on its own", "Cancel anytime in your portal (Billing) before December 10, 2026 and you pay nothing.", "Paddle"], "trial_welcome");
  assert(t.html.includes(`href="${SITE}/start/#onboarding"`) && t.html.includes(">Finish my setup</a>"), "trial_welcome: one button, the checklist");
  assert(!/SMS|text message|guarantee/i.test(t.text) && t.text.split(/\s+/).length < 170, "trial_welcome: short, no SMS / guarantee claims");
  const p = render("plan_welcome", s.plan_welcome.ctx);
  eq(p.subject, `Your ${pro.product} ${pro.name} plan has started`);
  has(p, [`Monthly: ${usd(pro.monthly_cents)}/mo`, `Included: ${pro.included_usage.voice_minutes} minutes of calls a month`, "Next charge: December 26, 2026",
    "finish the setup checklist", cancelText], "plan_welcome");
  assert(!/free trial/i.test(p.text), "plan_welcome: no trial wording");
  // a customer whose line is already live has nothing left to set up; no provider note outside Paddle
  const live = render("plan_welcome", { ...s.plan_welcome.ctx, client: { ...s.plan_welcome.ctx.client!, status: "live" },
    subscription: { ...s.plan_welcome.ctx.subscription!, provider: "mock" } });
  assert(live.text.includes("already live") && !live.text.includes("Next step") && !live.text.includes("Paddle"), "plan_welcome: live client / mock provider");
  // no trial end date: no "undefined" / empty date
  const nodate = render("trial_welcome", { ...s.trial_welcome.ctx, subscription: { ...s.trial_welcome.ctx.subscription!, trial_ends_at: null } });
  assert(nodate.text.includes("before the trial ends") && !/undefined|Free trial until/.test(nodate.text), "trial_welcome without a date");

  const a = render("admin_new_subscription", s.admin_new_subscription.ctx);
  eq(a.subject, `🎉 New subscription: Cool Breeze HVAC · ${pro.name} · free trial`);
  has(a, ["Business: Cool Breeze HVAC", "Name: Dani Levin", `Plan: ${pro.product} ${pro.name} (FR_PRO)`, "Type: Free trial until", "Business phone: +1 (713) 555-0100",
    "Email: dani@example.com", "Payment provider: paddle"], "admin_new_subscription");
  assert(a.html.includes(`href="${SITE}/start/admin/#subscriptions"`) && a.html.includes('lang="en" dir="ltr"'), "admin_new_subscription: LTR + admin tab");
  // owner dates: en-US in the owner timezone, labeled with the zone name (brand.json owner.timezone)
  assert(/Type: Free trial until [A-Z][a-z]+ \d{1,2}, \d{4} \([A-Za-z ]+ time\)/.test(a.text), "admin_new_subscription: en-US date + timezone label");
  assert(!a.text.includes("Returning client") && !a.text.includes("⚠️"), "admin_new_subscription: no returning / duplicate lines by default");
  const a2 = render("admin_new_subscription", { ...s.admin_new_subscription.ctx, subscription: { ...s.admin_new_subscription.ctx.subscription!,
    status: "active", current_period_start: "2026-11-26T15:00:00Z", returning: true, trial_duplicate: true } });
  assert(a2.subject.endsWith("· paid") && a2.text.includes("Paid from ") && a2.text.includes("Returning client: Yes") && a2.text.includes("already had a free trial"),
    "admin_new_subscription: paid, returning, duplicate trial");
  const c = render("admin_subscription_canceled", s.admin_subscription_canceled.ctx, s.admin_subscription_canceled.payload);
  assert(c.subject.startsWith(`Subscription canceled: Cool Breeze HVAC · ${pro.name} (active until `) && c.text.includes("Was on: Free trial") && c.text.includes("no charge"),
    "admin_subscription_canceled: scheduled during the trial");
  const e = render("admin_subscription_canceled", { ...s.admin_subscription_canceled.ctx, subscription: { ...s.admin_subscription_canceled.ctx.subscription!,
    status: "canceled", ends_at: "2026-12-26T15:00:00Z" } }, { kind: "ended", from: "active" });
  assert(e.subject === `Subscription ended: Cool Breeze HVAC · ${pro.name}` && e.text.includes("Was on: Paid subscription") && !e.text.includes("no charge"), "admin_subscription_canceled: ended, paid");
  eq([TEMPLATES.trial_welcome.audience, TEMPLATES.plan_welcome.audience, TEMPLATES.admin_new_subscription.audience, TEMPLATES.admin_subscription_canceled.audience],
    ["client", "client", "admin", "admin"]);
  eq([TEMPLATES.trial_welcome.transactional, TEMPLATES.plan_welcome.transactional], [true, true], "account / billing confirmations are transactional");
});

Deno.test("cancellation confirmation to the customer: trial, paid (period end / now), money-back; number kept; yearly reminder", async () => {
  // legal review 2026-11-27, subscription items 2 and 10
  const s = await samples();
  const plans = (PRICEBOOK as unknown as { plans: Array<{ code: string; name: string; product: string; monthly_cents: number }> }).plans;
  const pro = plans.find((p) => p.code === "FR_PRO")!;
  const base = s.subscription_canceled.ctx, sub = base.subscription!;
  // paid, canceled at the end of the period
  const paid = render("subscription_canceled", base, s.subscription_canceled.payload);
  eq(paid.subject, `Your ${pro.product} plan is canceled: it works until December 26, 2026, and you will not be charged again.`);
  has(paid, ["Hi Dani,", "keeps working as usual until December 26, 2026", "You will not be charged again.", "message mode",
    "Restart your plan in your portal (Billing) before December 26, 2026", `Your ${pro.product} number: +1 (713) 555-0142`,
    "Reserved for you until: January 25, 2027", "e-mail you 7 days before we release it", "move it to another phone provider",
    "turn off call forwarding", "Paddle"], "canceled: paid, scheduled");
  assert(paid.html.includes(`href="${SITE}/start/#billing"`), "canceled: Billing button");
  assert(!/refund/i.test(paid.text) && !/SMS|text message/i.test(paid.text), "canceled: no refund / SMS wording on a plain cancel");
  // canceled during the trial: ends now, message mode, never charged
  const trial = render("subscription_canceled", { ...base, subscription: { ...sub, status: "canceled", cancel_at_period_end: false,
    trial_ends_at: "2026-12-10T15:00:00Z", current_period_end: null, ends_at: "2026-11-27T15:00:00Z", canceled_at: "2026-11-27T15:00:00Z",
    number_kept_until: "2026-12-27T15:00:00Z" } }, { kind: "ended", from: "trialing" });
  eq(trial.subject, `Your ${pro.product} plan is canceled: your free trial has ended, and you will not be charged.`);
  has(trial, ["the trial ended right away", "You have not been charged and you will not be charged.", "in message mode",
    "Reserved for you until: December 27, 2026"], "canceled: trial");
  // paid, canceled now (past due / admin)
  const now = render("subscription_canceled", { ...base, subscription: { ...sub, status: "canceled", cancel_at_period_end: false,
    ends_at: "2026-11-27T15:00:00Z" } }, { kind: "ended", from: "past_due" });
  eq(now.subject, `Your ${pro.product} plan is canceled: it ended on November 27, 2026, and you will not be charged again.`);
  // 30-day money-back
  const refund = render("subscription_canceled", { ...base, subscription: { ...sub, status: "canceled", refunded: true, refund_cents: pro.monthly_cents } },
    { kind: "refunded", from: "active" });
  eq(refund.subject, `Your ${pro.product} plan is canceled: your first monthly payment is refunded in full.`);
  has(refund, [`refunded your first monthly payment of ${usd(pro.monthly_cents)} in full`, "30-day money-back guarantee", "You will not be charged again.",
    "5 to 10 business days", "Paddle.com"], "canceled: refunded");
  // trial scheduled to end (cancel at the trial end), no number yet
  const trialLater = render("subscription_canceled", { ...base, tenant_number: null, subscription: { ...sub, status: "trialing",
    trial_ends_at: "2026-12-10T15:00:00Z", current_period_end: null } }, { kind: "scheduled", from: "trialing" });
  eq(trialLater.subject, `Your ${pro.product} plan is canceled: your free trial runs until December 10, 2026, and you will not be charged.`);
  assert(!trialLater.text.includes("Reserved for you until"), "canceled: no number line without a number");
  // yearly reminder: price, renews every month, how to cancel
  const y = render("plan_yearly_reminder", s.plan_yearly_reminder.ctx, s.plan_yearly_reminder.payload);
  eq(y.subject, `A yearly reminder about your ${pro.product} ${pro.name} plan`);
  has(y, [`Price: ${usd(pro.monthly_cents)}/mo (plus any applicable sales tax)`, "Renews: Automatically every month, on the same day of the month, until you cancel",
    "Next charge: December 10, 2027", "How to cancel:", "in your portal (Billing)", "not charged again"], "plan_yearly_reminder");
  eq([TEMPLATES.subscription_canceled.audience, TEMPLATES.plan_yearly_reminder.audience], ["client", "client"]);
  eq([TEMPLATES.subscription_canceled.transactional, TEMPLATES.plan_yearly_reminder.transactional], [true, true],
    "billing notices are transactional: not gated by client_emails_enabled");
});

Deno.test("dispatch: sign-up mails go out while client reminders are off (client_emails_enabled = false); Meir's alert waits for 08:00", async () => {
  const s = await samples();
  const db = new MemDb(), m = new FakeMailer();
  db.settingsV.client_emails_enabled = false;
  const tr = db.add("trial_welcome", s.trial_welcome.ctx, { idem_key: "trial_welcome:sub-1" });
  const pd = db.add("plan_welcome", s.plan_welcome.ctx, { idem_key: "plan_welcome:sub-2" });
  const ad = db.add("admin_new_subscription", s.admin_new_subscription.ctx, { idem_key: "admin_new_subscription:sub-1" });
  const cn = db.add("admin_subscription_canceled", s.admin_subscription_canceled.ctx,
    { idem_key: "admin_subscription_canceled:sub-1:ended", payload: { kind: "ended", from: "trialing" } });
  const nud = db.add("onboarding_nudge", s.onboarding_nudge.ctx);
  await runDispatch(deps(db, m));
  eq([tr.status, pd.status, ad.status, cn.status, nud.status], ["sent", "sent", "sent", "sent", "skipped"]);
  eq(m.sent.map((x) => x.key), ["trial_welcome:sub-1", "plan_welcome:sub-2", "admin_new_subscription:sub-1", "admin_subscription_canceled:sub-1:ended"],
    "the outbox key is the Idempotency-Key");
  eq([m.sent[0].mail.to, m.sent[2].mail.to, m.sent[2].mail.reply_to], ["dani@example.com", "owner@example.com", "dani@example.com"]);
  assert(!m.sent[0].mail.headers?.["List-Unsubscribe"], "transactional: no unsubscribe header");
  await runDispatch(deps(db, m));
  eq(m.sent.length, 4, "never twice");
  // night in Israel: the client mail goes now, Meir's alert waits for the morning
  const db2 = new MemDb(), m2 = new FakeMailer();
  db2.clock = () => NIGHT_IL.getTime();
  const t2 = db2.add("trial_welcome", s.trial_welcome.ctx), a2 = db2.add("admin_new_subscription", s.admin_new_subscription.ctx);
  await runDispatch(deps(db2, m2));
  eq([t2.status, a2.status, (a2.done as { error?: string }).error], ["sent", "pending", "admin_quiet_hours"]);
});
