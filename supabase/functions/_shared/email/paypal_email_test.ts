// E-mails of PayPal checkout (phase 1): receipt, owner notice, owner alerts, the Upwork switch, and the PayPal wording of
// quote_accepted / admin_quote_accepted / final_payment_due when brand.json turns PayPal on. With PayPal off, every mail
// reads exactly as before. Also the pay_method context fix: client-level mails follow the client's real payment rail.
import { BRAND, PRICEBOOK } from "../config.ts";
import { usd } from "../quote_email.ts";
import { assert, eq } from "../test_util.ts";
import type { EmailBrand } from "./layout.ts";
import { samples } from "./samples.ts";
import { DISPUTE_REASONS, type EmailCtx, PAYPAL_ALERTS, T_ACCEPTED, T_ADMIN_ACCEPTED, TEMPLATES, UPWORK_MILESTONES } from "./templates.ts";

const OFF = BRAND as EmailBrand;
const ON = { ...structuredClone(BRAND), payments: { paypal: { enabled: true, env: "live", client_id: "AbCdEfGhIjKlMnOpQrStUvWx" } } } as EmailBrand;
const NOW = new Date("2026-10-12T09:00:00Z");
const SITE = BRAND.site_url.replace(/\/$/, "");
const NOTE = "Secure checkout by PayPal. No PayPal account needed. Receipt by email within a minute.";
const render = (k: string, ctx: EmailCtx, brand = ON, payload?: Record<string, unknown>) => TEMPLATES[k].render(ctx, { brand, now: NOW, payload });
const has = (r: { text: string }, parts: string[], what: string) => { for (const t of parts) assert(r.text.includes(t), `${what}: missing "${t}"\n${r.text}`); };
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

Deno.test("PayPal on: the accepted-quote mail sends the client to the payment step of the quote page; off = unchanged", async () => {
  const s = await samples();
  const ctx = s[T_ACCEPTED].ctx, q = ctx.quote!;
  const pp = { ...ctx, quote: { ...q, pay_method: "paypal_checkout", pay_link: null } } as EmailCtx;
  const dep = usd(q.deposit_cents);
  const r = render(T_ACCEPTED, pp);
  has(r, [`Next step: pay your ${dep} deposit by card or PayPal on your quote page.`, NOTE, `Pay your ${dep} deposit: ${SITE}/quote/#t=${q.public_token}&pay=1`,
    "Once the deposit is in, your setup checklist opens in your portal."], "accepted, PayPal");
  assert(!/Upwork|payment link/.test(r.text), "no Upwork, no 'we'll email a link'");
  assert(r.html.includes(`Deposit to start: ${dep}, by card or PayPal on your quote page.`), "preheader");
  assert(hrefs(r.html).includes(`${SITE}/quote/#t=${q.public_token}&pay=1`), "button -> quote page payment step");
  // the same quote while PayPal is switched off: the honest fallback (Meir sends a link), never a dead PayPal button
  const off = render(T_ACCEPTED, pp, OFF);
  assert(off.text.includes(`We'll email your secure payment link for the deposit ${BRAND.quote_sla_text}.`) && !off.text.includes("&pay=1"), "PayPal off");
  // Upwork stays Upwork with PayPal on
  assert(render(T_ACCEPTED, { ...ctx, quote: { ...q, pay_method: "upwork", pay_link: null } }).text.includes("paid securely through Upwork"), "upwork");
});

Deno.test("PayPal on: Meir's accepted mail says no link is needed and what happens on payment", async () => {
  const s = await samples();
  const ctx = s[T_ADMIN_ACCEPTED].ctx, q = ctx.quote!;
  const m = render(T_ADMIN_ACCEPTED, { ...ctx, quote: { ...q, pay_method: "paypal_checkout", pay_link: null } });
  has(m, ["Payment method: PayPal – button on the quote page", "No need to send a link: the client pays by card or PayPal on the quote page.",
    "the client card opens, the checklist is sent", "Payment received via PayPal", "If the client prefers Upwork"], "admin accepted, PayPal");
  assert(!m.text.includes("Send the client a payment link") && !m.text.includes("Find work"), "no manual link, no Upwork contract");
});

Deno.test("PayPal on: final payment due points to the portal button; Upwork and the off-state are unchanged", async () => {
  const s = await samples();
  const f = s.final_payment_due.ctx, amt = usd(f.final_cents);
  const r = render("final_payment_due", { ...f, pay_method: "paypal_checkout" });
  has(r, [`Next: pay the final ${amt} by card or PayPal in your portal (the Billing tab).`, NOTE, `Pay the final ${amt}: ${SITE}/start/#billing`], "final, PayPal");
  assert(!/Upwork|payment link/.test(r.text), "final, PayPal: nothing about Upwork or links");
  has(render("final_payment_due", { ...f, pay_method: "upwork" }), [`fund the ${UPWORK_MILESTONES.golive} milestone`], "final, Upwork");
  has(render("final_payment_due", { ...f, pay_method: "paypal_checkout" }, OFF), [`We'll email your secure payment link ${BRAND.quote_sla_text}.`], "final, PayPal off");
});

Deno.test("pay_method from the DB context: client-level mails follow the client's rail (was: always Upwork)", async () => {
  const s = await samples();
  const d = s.deposit_received.ctx, m = s.monthly_invoice.ctx;
  // deposit_received / monthly_invoice carry no quote: the DB context's pay_method decides
  assert(render("deposit_received", { ...d, pay_method: "paypal_checkout" }, OFF).text.includes("we received your deposit — thank you."), "deposit, PayPal");
  assert(render("deposit_received", { ...d, pay_method: "upwork" }, ON).text.includes("your deposit is funded in Upwork"), "deposit, Upwork even with PayPal on");
  const mp = render("monthly_invoice", { ...m, pay_method: "paypal_checkout" }, OFF, s.monthly_invoice.payload);
  assert(mp.text.includes("All payments are listed in the Billing tab") && !mp.text.includes("Upwork"), "monthly, PayPal client: the manual link (phase 1)");
  assert(render("monthly_invoice", { ...m, pay_method: "upwork" }, ON, s.monthly_invoice.payload).text.includes("milestone"), "monthly, Upwork client");
  // no method anywhere (web_deposit_ack right after a WEB questionnaire): the brand.json default
  const w = s.web_deposit_ack.ctx;
  assert(render("web_deposit_ack", w, OFF).text.includes("email from Upwork"), "WEB ack, PayPal off: Upwork (today's default)");
  const wo = render("web_deposit_ack", w, ON);
  assert(wo.text.includes(`We'll email your secure deposit link ${BRAND.quote_sla_text}.`) && !wo.text.includes("Upwork"), "WEB ack, PayPal on");
  const wl = render("web_deposit_link_requested", s.web_deposit_link_requested.ctx, ON);
  has(wl, ["Send a quote:", "Create quote draft", "PayPal – button on the quote page"], "WEB owner mail, PayPal on");
  assert(!wl.text.includes("Find work"), "no Upwork contract table with PayPal on");
  assert(render("web_deposit_link_requested", s.web_deposit_link_requested.ctx, OFF).text.includes("Find work"), "PayPal off: Upwork as before");
});

Deno.test("payment_receipt: amount, what it was for, last step, next step, refund rule, PayPal reference; final + WEB variants", async () => {
  const s = await samples();
  const { ctx, payload } = s.payment_receipt, pay = ctx.payment!;
  const amt = usd(pay.amount_cents);
  const r = render("payment_receipt", ctx, OFF, payload);
  eq(r.subject, `Payment received: ${amt} deposit`);
  has(r, [`we received your deposit of ${amt} for Cool Breeze HVAC.`, `Amount: ${amt}`, `For: Deposit (${PRICEBOOK.rules.deposit_pct}% of setup)`,
    `Service: ${PRICEBOOK.items.find((i) => i.code === "RCP")!.name}`, "Date: October 12, 2026", "Paid with: Visa ending in 4242, through PayPal",
    `PayPal reference: ${pay.provider_capture_id}`, "This was the last step before we start.", PRICEBOOK.refund_rules.deposit.text,
    "PayPal also emails you its own receipt.", `Open my setup checklist: ${SITE}/start/#onboarding`], "receipt, deposit");
  const fin = render("payment_receipt", { ...ctx, payment: { ...pay, kind: "final" } }, OFF, {});
  eq(fin.subject, `Payment received: ${amt} final payment`);
  has(fin, [`Final setup payment (${100 - PRICEBOOK.rules.deposit_pct}% of setup)`, "Paid with: PayPal checkout", "This was your last setup payment.",
    PRICEBOOK.refund_rules.rcp_guarantee.text, `View billing: ${SITE}/start/#billing`], "receipt, final (RCP: guarantee)");
  assert(!fin.text.includes(PRICEBOOK.refund_rules.deposit.text), "final: not the deposit rule");
  const web = render("payment_receipt", { ...ctx, client: { ...ctx.client!, products: ["WEB"] }, payment: { ...pay, kind: "final" } }, OFF, {});
  assert(!web.text.includes(PRICEBOOK.refund_rules.rcp_guarantee.label), "WEB final: no satisfaction guarantee");
});

Deno.test("admin_payment_received: English notice with amount, PayPal ids, payer e-mail, what's next and the refund button", async () => {
  const s = await samples();
  const { ctx } = s.admin_payment_received, pay = ctx.payment!;
  const r = render("admin_payment_received", ctx, OFF);
  assert(r.subject.startsWith("💳 Payment received via PayPal: Cool Breeze HVAC") && r.subject.includes(usd(pay.amount_cents)), r.subject);
  assert(r.html.includes('lang="en" dir="ltr"'), "LTR");
  const days = (PRICEBOOK.refund_rules.deposit as { window_days?: number }).window_days;
  has(r, ["Type: Deposit", `Amount: ${usd(pay.amount_cents)}`, `Quote: ${PRICEBOOK.items.find((i) => i.code === "RCP")!.name} · setup ${usd(ctx.quote!.setup_cents)}`,
    `PayPal capture ID: ${pay.provider_capture_id}`, "Payer's PayPal email: dani.payer@example.com",
    "No need to mark it \"paid\"", "On hold", `Deposit refund within ${days} days of payment: the "Refund" button`], "owner notice");
  assert(hrefs(r.html).includes(`${SITE}/start/admin/#clients/${ctx.client!.id}`), "button -> the client card");
  const fin = render("admin_payment_received", { ...ctx, payment: { ...pay, kind: "final" } }, OFF);
  has(fin, ["Type: Payment before go-live", "status \"Live\""], "owner notice, final");
  assert(!fin.text.includes("\"Refund\" button"), "final: no deposit refund line");
});

Deno.test("admin_paypal_alert: copy per kind (dispute reason translated), our amount vs PayPal's, works without a payment", async () => {
  const s = await samples();
  const { ctx, payload } = s.admin_paypal_alert;
  const d = render("admin_paypal_alert", ctx, OFF, payload);
  assert(d.subject.startsWith(PAYPAL_ALERTS.dispute.subject + ": Cool Breeze HVAC"), d.subject);
  has(d, [`Reason: ${DISPUTE_REASONS.MERCHANDISE_OR_SERVICE_NOT_RECEIVED} (MERCHANDISE_OR_SERVICE_NOT_RECEIVED)`, `PayPal ID: ${payload!.ref}`,
    `Amount per PayPal: ${payload!.paypal_amount}`, `Our payment row: Deposit · ${usd(ctx.payment!.amount_cents)}`, ...PAYPAL_ALERTS.dispute.what], "dispute");
  for (const kind of Object.keys(PAYPAL_ALERTS)) {
    const r = render("admin_paypal_alert", ctx, OFF, { kind, ref: "X1" });
    assert(r.subject.startsWith(PAYPAL_ALERTS[kind].subject) && r.text.includes(PAYPAL_ALERTS[kind].what[0]), kind);
  }
  const none = render("admin_paypal_alert", { to: "owner@example.com" }, OFF, { kind: "unknown_capture", ref: "CAP0000001", paypal_amount: "42.00 USD" });
  has(none, ["Our payment row: Not found", "Amount per PayPal: 42.00 USD", PAYPAL_ALERTS.unknown_capture.what[1]], "no payment row");
  assert(hrefs(none.html).includes(`${SITE}/start/admin/#clients`), "button -> clients");
  assert(render("admin_paypal_alert", ctx, OFF, { kind: "weird" }).subject.startsWith(PAYPAL_ALERTS.mismatch.subject), "unknown kind -> mismatch copy");
});

Deno.test("admin_upwork_requested: the same Direct Contract checklist as an Upwork acceptance", async () => {
  const s = await samples();
  const { ctx } = s.admin_upwork_requested, q = ctx.quote!;
  const r = render("admin_upwork_requested", ctx, ON);
  eq(r.subject, "🔁 Cool Breeze HVAC asked to pay through Upwork");
  has(r, ["Pay through Upwork instead", "Find work → Direct Contracts → Create a contract", `Milestone 1 (deposit): name: ${UPWORK_MILESTONES.setup_line}`,
    `Milestone 1: amount: ${usd(q.deposit_cents)}`, `Milestone 2: amount: ${usd((q.setup_cents ?? 0) - (q.deposit_cents ?? 0))}`, "Mark paid"], "Upwork request");
  assert(hrefs(r.html).includes(`${SITE}/start/admin/#quotes/${q.id}`), "button -> the quote");
});
