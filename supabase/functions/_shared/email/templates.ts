// A8 email templates: one entry per SPEC §5 event the dispatcher sends (+ two quote mails A6 emits).
// Client mails and mails to Meir: US English, LTR (the whole project is English-only since 2026-11-29). Brand/links from brand.json, product names and the deposit
// share from pricebook.json, amounts from the database row (never typed here). Copy: concrete, no promised outcomes.
// Subjects follow SPEC §5; `q_received` uses brand.quote_sla_text (A5 decision) instead of the literal "1 business day".
import { PRICEBOOK } from "../config.ts";
import { defaultPayMethod, PAYPAL_METHOD, toPublicView } from "../quote_engine.ts";
import { paypalOn } from "../quote_view.mjs";
import { quoteUrl, renderQuoteEmail, usd } from "../quote_email.ts";
import type { QuoteRow } from "../store.ts";
import { type Block, type EmailBrand, type EmailSpec, type Rendered, renderEmail, siteUrl } from "./layout.ts";

/** names containing the analytics event `quote_accept` are joined from parts (tools/check_hardcoded.py) */
export const T_ACCEPTED = ["quote", "accepted"].join("_");
export const T_ADMIN_ACCEPTED = ["admin", T_ACCEPTED].join("_");

export interface EmailCtx {
  to?: string | null;
  skip?: string;
  profile?: { full_name?: string | null; company?: string | null; email?: string | null; phone?: string | null; city?: string | null; state?: string | null };
  quote?: QuoteRow;
  offer?: string | null;
  niche?: string | null;
  review?: { risk_flags?: string[]; manual_reasons?: string[]; questions?: string[] } | null;
  questionnaire?: { id: string; offer: string | null; niche: string | null; status: string; summary?: Array<{ q: string; a: string }> | null };
  has_quote?: boolean;
  client?: { id: string; status: string; products: string[]; monthly_cents: number | null; business_name: string | null; go_live_at: string | null; next_bill_on: string | null;
    billing_mode?: string };
  /** FirstRing monthly plan (public.subscriptions), only for subscription clients */
  subscription?: { plan_code: string; status: string; trial_ends_at?: string | null; current_period_end?: string | null;
    cancel_at_period_end?: boolean; ends_at?: string | null; provider?: string; service?: string; service_reason?: string; reason?: string;
    /** sign-up / cancellation mails (20261128100000_us_subscription_emails.sql): the subscription row the mail is about */
    id?: string; current_period_start?: string | null; trial_duplicate?: boolean; created_at?: string | null;
    /** admin mails only: the business phone given at sign-up; true = this client had an earlier subscription */
    business_phone?: string | null; returning?: boolean };
  tenant_number?: string | null;
  onboarding?: { total: number; done: number; left: number; left_titles: string[] };
  payment?: { id: string; kind: string; amount_cents: number; method: string | null; status: string; provider?: string | null;
    provider_capture_id?: string | null; paid_at?: string | null; payer_email?: string | null };
  /** payment rail from the DB (quote, else payment row, else the client's quote); null = none yet -> brand.json default */
  pay_method?: string | null;
  final_cents?: number;
  request?: { id: string; title: string; status: string; admin_reply: string | null };
  item?: { id: string; key: string; title: string; status: string; message: string };
  lead?: { niche: string | null; source_page: string | null };
}

export interface RenderEnv {
  brand: EmailBrand;
  now: Date;
  /** set by the dispatcher for non-transactional mails */
  unsubUrl?: string;
  payload?: Record<string, unknown>;
}

export type Audience = "client" | "admin";
export type SenderKind = "transactional" | "quotes" | "alerts";
export interface TemplateDef {
  audience: Audience;
  /** false = reminder: gated by client_emails_enabled, needs unsubscribe + physical address (CAN-SPAM) */
  transactional: boolean;
  sender: SenderKind;
  render(ctx: EmailCtx, env: RenderEnv): Rendered;
}

// ------------------------------------------------------------------ helpers
const first = (ctx: EmailCtx) => (ctx.profile?.full_name ?? "").trim().split(/\s+/)[0] ?? "";
const hi = (ctx: EmailCtx) => (first(ctx) ? `Hi ${first(ctx)},` : "Hi,");
const company = (ctx: EmailCtx) => (ctx.profile?.company ?? ctx.client?.business_name ?? "").trim();
/** business label for Meir: company, else name, else e-mail */
const biz = (ctx: EmailCtx) => company(ctx) || (ctx.profile?.full_name ?? "").trim() || (ctx.profile?.email ?? "").trim() || "Client";
const portal = (b: EmailBrand, tab = "") => `${siteUrl(b)}/start/${tab ? "#" + tab : ""}`;
const admin = (b: EmailBrand, route: string) => `${siteUrl(b)}/start/admin/#${route}`;
const itemName = (code: string) => PRICEBOOK.items.find((i) => i.code === code)?.name ?? code;
const depositPct = () => Number((PRICEBOOK.rules as Record<string, unknown>).deposit_pct ?? 50);
const isReceptionist = (ctx: EmailCtx) => (ctx.client?.products ?? ["RCP"]).some((p) => p === "RCP" || p === "BNDL");
/** FirstRing monthly plan client (no quote, no final payment; go-live is automatic) */
const isPlan = (ctx: EmailCtx) => ctx.client?.billing_mode === "subscription";
type PlanRow = { code: string; name: string; product?: string; monthly_cents: number; trial_minutes?: number; included_usage?: { voice_minutes?: number } };
const planOf = (code?: string | null): PlanRow | undefined =>
  ((PRICEBOOK as unknown as { plans?: PlanRow[] }).plans ?? []).find((p) => p.code === code);
const planName = (code?: string | null) => planOf(code)?.name ?? code ?? "";
/** price-book rules.subscription (trial minutes, the approved cancel sentence) */
const SUB_RULES = () => ((PRICEBOOK.rules as unknown as Record<string, unknown>).subscription ?? {}) as
  { trial_minutes?: number; texts?: Record<string, string> };
/** "FirstRing Pro" (product + plan name from the price book) */
const planLabel = (code?: string | null) => { const p = planOf(code); return p ? `${p.product ?? ""} ${p.name}`.trim() : code ?? ""; };
const trialMinutes = (p?: PlanRow) => Number(p?.trial_minutes ?? SUB_RULES().trial_minutes ?? 0);
const minutesOf = (n?: number | null) => (n ? `${Number(n).toLocaleString("en-US")} minutes` : "");
/** what message mode does, in the words of the terms (owner decision 2026-11-25) */
const MESSAGE_MODE = "Your line still answers every call, in message mode: it takes the caller's name, number and reason and e-mails them to you. It does not book visits or answer other questions.";
/** sign-up mails: the one next step (the checklist; go-live is automatic), or nothing to do when the line is already live */
const setupStep = (ctx: EmailCtx): Block[] => ctx.client?.status === "live"
  ? [{ p: "Your receptionist is already live. Nothing to do." }]
  : [{ p: "**Next step:** finish the setup checklist in your portal. After your test call, our automatic checks run and your receptionist goes live on its own." }];
const startedCta = (ctx: EmailCtx, b: EmailBrand) =>
  ctx.client?.status === "live" ? { label: "Open my portal", url: portal(b) } : { label: "Finish my setup", url: portal(b, "onboarding") };
/** Paddle is the merchant of record: card statements and receipts carry its name */
const paddleNote = (ctx: EmailCtx): Block[] =>
  ctx.subscription?.provider === "paddle" ? [{ small: "Billing is handled by Paddle, our payment provider. Your receipts come from them." }] : [];
const FORWARD_OFF = "Don't want calls to reach it at all? Turn off call forwarding on your business phone (the setup checklist in your portal shows how for your phone provider).";
/** satisfaction guarantee (pricebook refund_rules.rcp_guarantee): [text, "Month D, YYYY" end date] for RCP/BNDL clients, else null */
function guaranteeOf(ctx: EmailCtx): { text: string; until: string } | null {
  const rr = PRICEBOOK.refund_rules;
  const g = rr.rcp_guarantee;
  if (!g || !(ctx.client?.products ?? []).some((p) => g.codes.includes(p))) return null;
  const start = ctx.client?.go_live_at ? new Date(ctx.client.go_live_at) : null;
  const until = start && !isNaN(+start) ? fmtDate(new Date(+start + rr.rcp_guarantee_days * 86_400_000).toISOString()) : "";
  return { text: g.text, until };
}

export function fmtDate(iso: string | null | undefined, tz = "America/New_York", lang: "en" | "he" = "en"): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-US", { month: "long", day: "numeric", year: "numeric", timeZone: tz })
      .format(new Date(iso));
  } catch { return iso.slice(0, 10); }
}
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
}
/** +17135550100 -> +1 (713) 555-0100; anything else unchanged */
export function fmtPhone(e164: string | null | undefined): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? "");
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? "");
}
const callOffer = (b: EmailBrand): Block[] =>
  b.calendly_url ? [{ small: `Prefer to talk it through? You can book a 15-minute video call: ${b.calendly_url}` }] : [];

// ------------------------------------------------------------------ Upwork Direct Contracts (pay_method 'upwork')
/** Payment rail of a mail: the quote's pay_method, else the DB context's pay_method (payment row / the client's quote,
 *  so deposit_received, monthly_invoice, web_deposit_ack follow the client's real rail), else the payment row's method,
 *  else the brand.json default (PayPal checkout when it is on, else Upwork). */
const payMethod = (ctx: EmailCtx, brand: EmailBrand) => ctx.quote?.pay_method || ctx.pay_method || ctx.payment?.method || defaultPayMethod(brand);
const isUpwork = (ctx: EmailCtx, brand: EmailBrand) => payMethod(ctx, brand) === "upwork";
/** card / PayPal checkout: the quote page and the portal show the PayPal buttons (only while brand.json turns it on) */
const isPaypal = (ctx: EmailCtx, brand: EmailBrand) => payMethod(ctx, brand) === PAYPAL_METHOD && paypalOn(brand);
const PAYPAL_NOTE = "Secure checkout by PayPal. No PayPal account needed. Receipt by email within a minute.";
const PAYPAL_LABEL = "PayPal – button on the quote page";
/** dates in mails to Meir: en-US in the owner timezone (brand.json owner.timezone), labeled with the zone's generic
 *  English name from Intl ("November 26, 2026 (… time)"); an unknown zone falls back to its id */
const ownerTz = (b: EmailBrand) => b.owner?.timezone || "UTC";
const tzLabel = (tz: string) => {
  try {
    const n = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" }).formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return n ? n.replace(/ Time$/, " time") : tz;
  } catch { return tz; }
};
const ownerDate = (iso: string | null | undefined, b: EmailBrand) => { const d = fmtDate(iso, ownerTz(b)); return d ? `${d} (${tzLabel(ownerTz(b))})` : ""; };
// Client copy: the same facts as the quote page (site/quote/assets/quote.js upworkSlot). Upwork shows its own client fees at
// checkout, so no fee amount is ever written here.
const UPWORK_WAYS = "card, PayPal or US bank transfer";
const UPWORK_ESCROW = "Upwork holds the money in escrow and releases it to us only when you approve the milestone, or automatically if you don't respond within 14 days after we submit it.";
const UPWORK_FEES = "Upwork adds its own small client fees at checkout.";
const UPWORK_ACCOUNT = "Already have an Upwork account? Reply to this email with your Upwork email and we'll set it up there.";
/** Milestone names exactly as Meir types them into Upwork (client-visible there). */
export const UPWORK_MILESTONES = {
  setup_line: "Setup: build your AI line until your test call",
  setup_web: "Setup: build your website until your review",
  golive: "Go-live",
};
const hasLine = (codes: string[]) => codes.some((c) => c === "RCP" || c === "BNDL");
const coreOf = (codes: string[]) => codes.find((c) => PRICEBOOK.rules.core_codes.includes(c)) ?? codes[0] ?? "";

/** Meir's Direct Contract checklist. One value per row = what he copies into Upwork (English, the client sees it
 *  there); amounts from the quote row. Without a quote (WEB self-serve) the amounts are left to Meir. */
function upworkContract(ctx: EmailCtx, brand: EmailBrand, o: { codes: string[]; basis: string; deposit?: number | null; final?: number | null;
  monthly?: number | null }): Block[] {
  const product = itemName(coreOf(o.codes));
  const desc = `Setup of the ${product} ${o.basis}.` + (o.monthly ? ` Monthly plan from go-live: ${usd(o.monthly)}/mo, one milestone per month.` : "");
  return [
    { p: "**Create in Upwork:** Find work → Direct Contracts → Create a contract" },
    { facts: [
      ["Client email", ctx.profile?.email ?? ""],
      ["Contract type", "Fixed-price"],
      ["Contract name", `${brand.name} – ${product} setup`],
      ["Milestone 1 (deposit): name", hasLine(o.codes) ? UPWORK_MILESTONES.setup_line : UPWORK_MILESTONES.setup_web],
      ["Milestone 1: amount", usd(o.deposit)],
      ["Milestone 2 (before go-live): name", UPWORK_MILESTONES.golive],
      ["Milestone 2: amount", usd(o.final)],
      ["Description (one line)", desc],
    ] },
    { small: "If the client already has an Upwork account: ask them to hire you through your profile." },
  ];
}

function quoteFacts(q: QuoteRow): Array<[string, string]> {
  return [
    ["Setup", usd(q.setup_cents)],
    [`Deposit to start (${depositPct()}%)`, usd(q.deposit_cents)],
    ["Monthly, from go-live", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : ""],
  ];
}

const client = (sender: SenderKind, transactional: boolean, spec: (ctx: EmailCtx, env: RenderEnv) => Omit<EmailSpec, "lang" | "footer" | "unsubUrl">): TemplateDef => ({
  audience: "client", transactional, sender,
  render: (ctx, env) => renderEmail({ lang: "en", footer: transactional ? "transactional" : "marketing", unsubUrl: env.unsubUrl, ...spec(ctx, env) }, env.brand),
});
const toMeir = (spec: (ctx: EmailCtx, env: RenderEnv) => Omit<EmailSpec, "lang" | "footer" | "unsubUrl">): TemplateDef => ({
  audience: "admin", transactional: true, sender: "alerts",
  render: (ctx, env) => renderEmail({ lang: "en", footer: "admin", ...spec(ctx, env) }, env.brand),
});

const REQUEST_LABEL: Record<string, string> = {
  queued: "queued", active: "in progress", waiting_on_you: "waiting on you", done: "done", declined: "declined",
};
const OFFER_LABEL: Record<string, string> = { UNSURE: "Not sure" };
export const DARK_PATCH = `<style>@media (prefers-color-scheme: dark) { .card td[bgcolor="#FFFFFF"] { background:#17253A !important; } }</style>`;

// ------------------------------------------------------------------ templates
export const TEMPLATES: Record<string, TemplateDef> = {
  lead_capture: client("transactional", true, (ctx, { brand }) => {
    const niche = ctx.lead?.niche ? `?niche=${encodeURIComponent(ctx.lead.niche)}` : "";
    return {
      subject: "Your fixed-quote link",
      preheader: "About 3 minutes, no sales call. Your written quote follows.",
      heading: "Your fixed-quote link",
      blocks: [
        { p: "Hi, here's the link you asked for." },
        { p: `Answer a few questions about your business (about 3 minutes, 3 screens) and we'll email you a written, fixed quote ${brand.quote_sla_text}. No sales call needed.` },
      ],
      cta: { label: "Start my questionnaire", url: `${siteUrl(brand)}/start/${niche}` },
    };
  }),

  q_received: client("transactional", true, (ctx, { brand }) => ({
    subject: `Got it — your fixed quote arrives ${brand.quote_sla_text}`,
    preheader: `We're reviewing your answers. Your written quote arrives ${brand.quote_sla_text}.`,
    heading: "We've got your answers",
    blocks: [
      { p: `${hi(ctx)} thanks for completing the questionnaire${company(ctx) ? ` for **${company(ctx)}**` : ""}.` },
      { title: "What happens next", list: [
        "We review your answers and price the work from our published price list.",
        `You get a written, fixed quote by email ${brand.quote_sla_text}: scope, timeline and price.`,
        "You accept online and pay the deposit to start. No call needed.",
      ] },
      { small: "Remembered something? Just reply to this email." },
    ],
    cta: { label: "Open your portal", url: portal(brand) },
  })),

  // WEB is sold without a quote step (SPEC §1): Meir sends the deposit link by hand; the client gets a short confirmation.
  web_deposit_ack: client("transactional", true, (ctx, { brand }) => {
    const upwork = isUpwork(ctx, brand);
    return {
      subject: "Your deposit link is on its way",
      preheader: upwork ? `Your contract arrives from Upwork ${brand.quote_sla_text}.` : `We'll email your secure deposit link ${brand.quote_sla_text}.`,
      heading: "Your deposit link is on its way",
      blocks: [
        { p: `${hi(ctx)} thanks for choosing your website package${company(ctx) ? ` for **${company(ctx)}**` : ""}.` },
        ...(upwork
          ? [
            { p: `You pay the deposit securely through Upwork. You'll get an email from Upwork with your contract ${brand.quote_sla_text}: create a free Upwork client account from that email, then fund the first milestone by ${UPWORK_WAYS}.` },
            { small: `${UPWORK_ESCROW} ${UPWORK_FEES}` },
            { small: UPWORK_ACCOUNT },
            { p: "Once the deposit is funded, your setup checklist opens in your portal (your online account with us)." },
          ] as Block[]
          : [{ p: `We'll email your secure deposit link ${brand.quote_sla_text}. Once the deposit is in, your setup checklist opens in your portal (your online account with us).` }]),
        { small: "Questions? Just reply to this email." },
      ],
      cta: { label: "Open your portal", url: portal(brand) },
    };
  }),

  web_deposit_link_requested: toMeir((ctx, { brand }) => {
    const qn = ctx.questionnaire;
    const answers = (qn?.summary ?? []).filter((x) => x && String(x.a ?? "").trim()).slice(0, 12)
      .map((x) => `${x.q}: ${String(x.a).slice(0, 200)}`);
    const upwork = isUpwork(ctx, brand), paypal = isPaypal(ctx, brand);
    return {
      subject: `Website (WEB): ${biz(ctx)} is waiting for a deposit link`,
      preheader: upwork ? "A client picked a website package. Create an Upwork contract for the deposit."
        : paypal ? "A client picked a website package. Create a quote from the questionnaire and send it: they pay the deposit by card on the quote page."
        : "A client picked a website package. Send them a payment link for the deposit.",
      heading: "A client picked a website package",
      blocks: [
        { facts: [["Business", biz(ctx)], ["Name", ctx.profile?.full_name ?? ""], ["Email", ctx.profile?.email ?? ""],
          ["Phone", ctx.profile?.phone ?? ""], ["City", [ctx.profile?.city, ctx.profile?.state].filter(Boolean).join(", ")],
          ["Niche", qn?.niche ?? ""]] },
        // no quote on the WEB path: the amounts depend on the extras the client picked (answers below), so Meir sets them
        ...(upwork ? [...upworkContract(ctx, brand, { codes: ["WEB"], basis: "as chosen in your questionnaire" }),
          { small: `Amounts: the deposit is ${depositPct()}% of the setup price from the price book, including the extras the client picked; the rest is due before go-live.` } as Block] : []),
        ...(paypal ? [{ p: `**Send a quote:** in the admin, open the questionnaire → "Create quote draft" → "Approve and send". The payment method "${PAYPAL_LABEL}" is already selected, and the client pays the deposit by card or PayPal on the quote page.` } as Block] : []),
        ...(answers.length ? [{ title: "From the questionnaire", list: answers } as Block] : []),
        { small: upwork ? `The client got an email saying the contract will come from Upwork ${brand.quote_sla_text}.` : `The client got an email saying the link will arrive ${brand.quote_sla_text}.` },
      ],
      cta: { label: "Open the questionnaire in admin", url: admin(brand, `questionnaires/${qn?.id ?? ""}`) },
    };
  }),

  request_cancelled: client("transactional", true, (ctx, { brand }) => ({
    subject: `Request "${ctx.request?.title ?? ""}" was cancelled`,
    preheader: "It's removed from your queue. Nothing else changes.",
    heading: "Request cancelled",
    blocks: [
      { p: `${hi(ctx)} your request **${ctx.request?.title ?? ""}** was cancelled and removed from your queue, as you asked.` },
      { small: "Cancelled by mistake? Open it again from your portal." },
    ],
    cta: { label: "Open my requests", url: portal(brand, "requests") },
  })),

  admin_request_cancelled: toMeir((ctx, { brand }) => ({
    subject: `${biz(ctx)} canceled a request: ${ctx.request?.title ?? ""}`,
    preheader: "The request was removed from the queue. No action needed.",
    heading: "Request canceled",
    blocks: [
      { facts: [["Business", biz(ctx)], ["Request", ctx.request?.title ?? ""], ["Email", ctx.profile?.email ?? ""]] },
      { small: "The client canceled a request that was waiting in the queue. No action needed." },
    ],
    cta: { label: "Retainer queue in admin", url: admin(brand, "requests") },
  })),

  admin_new_quote: toMeir((ctx, { brand }) => {
    const q = ctx.quote!;
    const manual = q.status === "needs_manual_price";
    const amount = q.setup_cents != null && !manual ? usd(q.setup_cents) : "Manual pricing";
    const offer = ctx.offer ? (OFFER_LABEL[ctx.offer] ?? ctx.offer) : String(q.items[0]?.code ?? "");
    const flags = [...(ctx.review?.manual_reasons ?? []), ...(ctx.review?.risk_flags ?? [])];
    return {
      subject: `New quote to approve: ${biz(ctx)} · ${offer} · ${amount}`,
      preheader: manual ? "The draft needs a manual price before it can be sent." : "Draft ready. Nothing goes to the client until you approve it.",
      heading: manual ? "Quote draft: needs a manual price" : "Quote draft ready to approve",
      blocks: [
        { facts: [
          ["Business", biz(ctx)], ["Name", ctx.profile?.full_name ?? ""], ["Email", ctx.profile?.email ?? ""],
          ["Offer", offer], ["Niche", ctx.niche ?? ""],
          ["Setup", q.setup_cents != null ? usd(q.setup_cents) : "—"],
          ["Monthly", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : "—"],
          ["Deposit", q.deposit_cents != null ? usd(q.deposit_cents) : "—"],
        ] },
        { title: "Line items", list: q.items.map((i) => `${i.code} · ${i.name ?? itemName(String(i.code))}${Number(i.qty ?? 1) > 1 ? ` × ${i.qty}` : ""}`) },
        ...(flags.length ? [{ title: "Check before sending", list: flags.map(String) } as Block] : []),
        { small: "Nothing goes to the client until you press \"Approve and send\" in the admin." },
      ],
      cta: { label: "Open the quote in admin", url: admin(brand, `quotes/${q.id}`) },
    };
  }),

  quote_sent: {
    audience: "client", transactional: true, sender: "quotes",
    render: (ctx, env) => {
      const r = renderQuoteEmail(toPublicView(ctx.quote!, ctx.profile ? { full_name: ctx.profile.full_name ?? null, company: ctx.profile.company ?? null } : null, env.now),
        ctx.quote!.public_token, env.brand);
      // A6's dark-mode block turns the text light but leaves the white cells white (unreadable in dark-mode clients).
      // Until quote_email.ts is fixed by its owner, darken only the white cells; the amber button and navy header keep theirs.
      return { ...r, html: r.html.replace("</head>", DARK_PATCH + "</head>") };
    },
  },

  quote_reminder: client("quotes", false, (ctx, { brand }) => {
    const q = ctx.quote!;
    return {
      subject: "Any questions about your quote?",
      preheader: "Reply with any question about scope, timeline or setup.",
      heading: "Any questions about your quote?",
      blocks: [
        { p: `${hi(ctx)} just checking in on the fixed quote we sent${q.sent_at ? ` on ${fmtDate(q.sent_at)}` : ""}${company(ctx) ? ` for **${company(ctx)}**` : ""}.` },
        { p: "If anything is unclear (scope, timeline, or how setup works without a call), reply to this email and we'll answer in writing." },
        { facts: [...quoteFacts(q), ["Valid until", fmtDate(q.valid_until)]] },
        ...callOffer(brand),
      ],
      cta: { label: "Review your quote", url: quoteUrl(q.public_token, brand) },
    };
  }),

  quote_expiring: client("quotes", false, (ctx, { brand }) => {
    const q = ctx.quote!;
    const d = fmtDate(q.valid_until);
    return {
      subject: `Your fixed quote expires ${d ? "on " + d : "soon"}`,
      preheader: "After that date we'd need to prepare a new quote.",
      heading: "Your quote expires soon",
      blocks: [
        { p: `${hi(ctx)} a quick note: the fixed quote${company(ctx) ? ` for **${company(ctx)}**` : ""} is valid until **${d}**. After that, we'd need to prepare a new one.` },
        { facts: quoteFacts(q) },
        { small: "Not the right time? No action needed. Questions? Just reply." },
        ...callOffer(brand),
      ],
      cta: { label: "Review & accept", url: quoteUrl(q.public_token, brand) },
    };
  }),

  [T_ACCEPTED]: client("quotes", true, (ctx, { brand }) => {
    const q = ctx.quote!;
    const dep = usd(q.deposit_cents);
    const upwork = isUpwork(ctx, brand), paypal = !upwork && isPaypal(ctx, brand);
    const pay: Block[] = paypal
      ? [{ p: `**Next step: pay your ${dep} deposit by card or PayPal on your quote page.** It takes about a minute.` },
        { small: PAYPAL_NOTE }]
      : upwork
      ? (q.pay_link
        ? [{ button: { label: "Open your Upwork contract", url: q.pay_link } },
          { p: `Fund the ${dep} deposit there by card, PayPal or bank transfer.` },
          { small: `${UPWORK_ESCROW} ${UPWORK_FEES}` }]
        : [{ p: `**Next step: your ${dep} deposit, paid securely through Upwork.** You'll get an email from Upwork with your contract ${brand.quote_sla_text}.` },
          { list: ["Create a free Upwork client account from that email and accept the contract.", `Fund the first milestone (${dep}) by ${UPWORK_WAYS}.`] },
          { small: `${UPWORK_ESCROW} ${UPWORK_FEES}` },
          { small: UPWORK_ACCOUNT }])
      : q.pay_link
      ? [{ button: { label: `Pay deposit ${dep}`, url: q.pay_link } }]
      : [{ p: `We'll email your secure payment link for the deposit ${brand.quote_sla_text}.` }];
    return {
      subject: "Quote accepted — next step: the deposit",
      preheader: upwork ? `Deposit to start: ${dep}, paid securely through Upwork.`
        : paypal ? `Deposit to start: ${dep}, by card or PayPal on your quote page.` : `Deposit to start: ${dep}.`,
      heading: "Thanks — your quote is accepted",
      blocks: [
        { p: `${hi(ctx)} you accepted the fixed quote${company(ctx) ? ` for **${company(ctx)}**` : ""}${q.accepted_at ? ` on ${fmtDate(q.accepted_at)}` : ""}. A copy of exactly what you accepted stays on your quote page.` },
        { facts: [quoteFacts(q)[0], quoteFacts(q)[1], ["Before go-live", usd((q.setup_cents ?? 0) - (q.deposit_cents ?? 0))], quoteFacts(q)[2]] },
        ...pay,
        { p: upwork ? "Once the first milestone is funded, your setup checklist opens in your portal." : "Once the deposit is in, your setup checklist opens in your portal." },
      ],
      // PayPal: the button opens the quote page at its payment step (&pay=1 in the fragment, never sent to a server)
      cta: paypal ? { label: `Pay your ${dep} deposit`, url: quoteUrl(q.public_token, brand) + "&pay=1" }
        : { label: "View your accepted quote", url: quoteUrl(q.public_token, brand) },
    };
  }),

  [T_ADMIN_ACCEPTED]: toMeir((ctx, { brand }) => {
    const q = ctx.quote!;
    const upwork = isUpwork(ctx, brand), paypal = !upwork && isPaypal(ctx, brand);
    const final = (q.setup_cents ?? 0) - (q.deposit_cents ?? 0);
    return {
      subject: `✅ ${biz(ctx)} accepted a quote, payment pending`,
      preheader: upwork ? `Deposit: ${usd(q.deposit_cents)}. Create the Upwork contract.`
        : paypal ? `Deposit: ${usd(q.deposit_cents)}. The client pays by card or PayPal on the quote page.` : `Deposit: ${usd(q.deposit_cents)}`,
      heading: "The client accepted the quote",
      blocks: [
        { facts: [
          ["Business", biz(ctx)], ["Signed by", q.accepted_name ?? ""], ["When", ownerDate(q.accepted_at, brand)],
          ["Setup", usd(q.setup_cents)], ["Deposit", usd(q.deposit_cents)], ["Monthly", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : ""],
          ...(upwork
            ? [["Payment method", "Upwork (Direct Contract)"], ["Contract link", q.pay_link ? "Yes, the client sees a contract button" : "No, the client is waiting for an email from Upwork"]]
            : paypal ? [["Payment method", PAYPAL_LABEL], ["Payment", "The client pays by card or PayPal on the quote page"]]
            : [["Payment method", payMethod(ctx, brand)], ["Payment link", q.pay_link ? "Yes, the client sees a pay button" : "No, you need to send one to the client"]]) as Array<[string, string]>,
        ] },
        ...(upwork ? upworkContract(ctx, brand, { codes: q.items.map((i) => String(i.code)), deposit: q.deposit_cents, final,
          monthly: q.monthly_cents, basis: `as described in your accepted fixed quote${q.accepted_at ? ` (${fmtDate(q.accepted_at)})` : ""}` }) : []),
        { title: "What now", list: paypal
          ? ["No need to send a link: the client pays by card or PayPal on the quote page.",
            "When the payment goes through, it is marked \"paid\" on its own: the client card opens, the checklist is sent, and you get a \"Payment received via PayPal\" email.",
            "If the client prefers Upwork, you get a separate email with the contract details."]
          : [
            ...(upwork ? ["Create the Upwork contract with the details above."] : q.pay_link ? [] : ["Send the client a payment link for the deposit."]),
            "In the admin, open the quote and press \"Open client\".",
            upwork ? "When the client funds the first milestone in Upwork: \"Mark paid\" on the deposit (reference: the Upwork contract number). The client gets the checklist automatically."
              : "When the money arrives: \"Mark paid\" on the deposit. The client gets the checklist automatically.",
          ] },
      ],
      cta: { label: "Open in admin", url: admin(brand, `quotes/${q.id}`) },
    };
  }),

  deposit_received: client("transactional", true, (ctx, { brand }) => {
    const ob = ctx.onboarding;
    const steps: Block[] = ob && ob.left_titles.length ? [{ title: "Your setup steps", list: ob.left_titles }] : [];
    const upwork = isUpwork(ctx, brand), rcp = isReceptionist(ctx);
    return {
      subject: "Welcome aboard — your setup checklist is ready",
      preheader: "Short steps, each with a how-to. No call needed.",
      heading: "Welcome aboard",
      blocks: [
        { p: upwork ? `${hi(ctx)} your deposit is funded in Upwork — thank you.` : `${hi(ctx)} we received your deposit — thank you.` },
        { p: `Your setup checklist is ready in your portal (your online account with us)${ob && ob.total ? `: **${ob.total} short steps**` : ""}, each with a short how-to. Do them in any order; your progress saves as you go.` },
        ...steps,
        // milestone 1 is submitted when the build is ready for the client's own test (ready_to_test)
        ...(upwork ? [{ small: `Upwork holds your deposit in escrow. We submit this milestone when your ${rcp ? "line is ready for your test call" : "website is ready for your review"}; approve it in Upwork once you've ${rcp ? "tried it" : "checked it"}.` } as Block] : []),
        { small: "Stuck on a step? Press \"Need help\" on it and we'll answer in writing." },
      ],
      cta: { label: "Open my setup checklist", url: portal(brand, "onboarding") },
    };
  }),

  onboarding_nudge: client("transactional", false, (ctx, { brand }) => {
    const left = Math.max(1, ctx.onboarding?.left ?? 1);
    const what = isReceptionist(ctx) ? "receptionist" : "website";
    return {
      subject: `${left} step${left === 1 ? "" : "s"} left to get your ${what} live`,
      preheader: "Pick up where you left off. Each step has a short how-to.",
      heading: `${left} step${left === 1 ? "" : "s"} left`,
      blocks: [
        { p: `${hi(ctx)} your setup is waiting on ${left === 1 ? "one step" : `${left} steps`} from you:` },
        { list: ctx.onboarding?.left_titles ?? [] },
        { small: "Stuck? Press \"Need help\" on the step and we'll answer in writing." },
      ],
      cta: { label: "Continue setup", url: portal(brand, "onboarding") },
    };
  }),

  need_help: toMeir((ctx, { brand }) => ({
    subject: `${biz(ctx)} needs help with: ${ctx.item?.title ?? ""}`,
    preheader: (ctx.item?.message ?? "").slice(0, 120) || "A client pressed Need help in the checklist.",
    heading: "Checklist help request",
    blocks: [
      { facts: [["Business", biz(ctx)], ["Step", ctx.item?.title ?? ""], ["Email", ctx.profile?.email ?? ""], ["Phone", ctx.profile?.phone ?? ""]] },
      ...(ctx.item?.message ? [{ title: "What the client wrote", quote: ctx.item.message } as Block] : [{ small: "The client did not add any details." } as Block]),
      { small: "Answer the client in writing, not on a call." },
    ],
    cta: { label: "Open the client in admin", url: admin(brand, `clients/${ctx.client?.id ?? ""}`) },
  })),

  ready_to_test: client("transactional", true, (ctx, { brand }) => {
    const rcp = isReceptionist(ctx);
    const num = fmtPhone(ctx.tenant_number);
    if (isPlan(ctx)) {
      return {
        subject: "Your setup is done: final checks running",
        preheader: "We're testing your receptionist with your settings. You'll get an email the moment it's live.",
        heading: "Setup done",
        blocks: [
          { p: `${hi(ctx)} thanks, your setup checklist is complete and your test call came through.` },
          ...(num ? [{ facts: [["Your receptionist's number", num]] } as Block] : []),
          { p: "We're now running automatic test calls against your exact settings (hours, services, FAQ, alerts, calendar). This usually takes minutes. You don't need to do anything." },
          { p: "As soon as the checks pass, it goes live on its own and we email you." },
        ],
        cta: { label: "Open my portal", url: portal(brand, "onboarding") },
      };
    }
    return {
      subject: rcp ? "Your AI receptionist is ready to test" : "Your website is ready to review",
      preheader: rcp ? "Call the test number and try it like a customer would." : "Take a look and approve it in your portal.",
      heading: rcp ? "Ready to test" : "Ready to review",
      blocks: rcp
        ? [
          { p: `${hi(ctx)} your receptionist is set up and ready for you to try.` },
          ...(num ? [{ facts: [["Test number", num]] } as Block] : [{ p: "Your test number is in your portal." } as Block]),
          { list: ["Call from your phone and act like a customer.", "Ask a question, book a job, ask for a person.", "Check the alert and the booking that come through."] },
          { p: "When you're happy with it, press **Request go-live** in your portal. It starts answering real customers only after that." },
        ]
        : [
          { p: `${hi(ctx)} your website is ready for review.` },
          { p: "Look through every page on your phone and computer. When you're happy with it, press **Request go-live** in your portal. Nothing goes live before that." },
        ],
      cta: { label: "Open my portal", url: portal(brand, "onboarding") },
    };
  }),

  final_payment_due: client("transactional", true, (ctx, { brand }) => {
    const amount = ctx.payment?.amount_cents ?? ctx.final_cents ?? 0;
    const upwork = isUpwork(ctx, brand), paypal = !upwork && isPaypal(ctx, brand);
    return {
      subject: "Final payment before go-live",
      preheader: paypal ? `Amount due: ${usd(amount)}, by card or PayPal in your portal.` : `Amount due: ${usd(amount)}.`,
      heading: "Final payment before go-live",
      blocks: [
        { p: `${hi(ctx)} thanks for requesting go-live. The last step is the final setup payment (the remaining ${100 - depositPct()}%).` },
        { facts: [["Amount due", usd(amount)],
          ["Monthly, from go-live", ctx.client?.monthly_cents ? `${usd(ctx.client.monthly_cents)}/mo` : ""]] },
        ...(upwork
          ? [{ p: `Next: fund the **${UPWORK_MILESTONES.golive}** milestone (${usd(amount)}) in your Upwork contract, by ${UPWORK_WAYS}. Once it's funded, we set your go-live date (the day it starts working for real customers).` },
            { small: `${UPWORK_ESCROW} ${UPWORK_FEES}` }] as Block[]
          : paypal
          ? [{ p: `Next: pay the **final ${usd(amount)}** by card or PayPal in your portal (the Billing tab). It takes about a minute. Once it's paid, we set your go-live date (the day it starts working for real customers).` },
            { small: PAYPAL_NOTE }] as Block[]
          : [{ p: `We'll email your secure payment link ${brand.quote_sla_text}. Once it's received, we set your go-live date (the day it starts working for real customers).` }]),
      ],
      cta: paypal ? { label: `Pay the final ${usd(amount)}`, url: portal(brand, "billing") } : { label: "View billing", url: portal(brand, "billing") },
    };
  }),

  went_live: client("transactional", true, (ctx, { brand }) => {
    const guaranteeBlocks = (c: EmailCtx): Block[] => {
      const g = guaranteeOf(c);
      return g ? [{ small: g.until ? `${g.text} Your guarantee runs until ${g.until}.` : g.text }] : [];
    };
    const rcp = isReceptionist(ctx);
    const num = fmtPhone(ctx.tenant_number);
    return {
      subject: "You're live 🎉 — what happens now",
      preheader: rcp ? "Missed calls are now answered. Here's what to expect." : "Your website is live. Here's what to expect.",
      heading: "You're live",
      blocks: [
        { p: `${hi(ctx)} ${rcp ? "your AI receptionist is live." : "your website is live."}` },
        { title: "What happens now", list: rcp
          ? ["Missed calls forwarded to your receptionist number are answered.", "You get an email for every lead (and a text, once business texting is live).",
            "Each evening you get a short summary of the day.", "Need a change? Open a request in your portal and follow its status there."]
          : ["Your site is online at your domain.", "Need a change? Open a request in your portal and follow its status there."] },
        { facts: [[rcp ? "Receptionist number" : "", num],
          ...(isPlan(ctx) ? [["Plan", planName(ctx.subscription?.plan_code)] as [string, string]]
            : [["Monthly", ctx.client?.monthly_cents ? `${usd(ctx.client.monthly_cents)}/mo` : ""] as [string, string]])].filter(([k]) => k) as Array<[string, string]> },
        ...(rcp ? [{ small: "You can pause the AI any time from your portal." } as Block] : []),
        ...(isPlan(ctx) ? [] : guaranteeBlocks(ctx)),
      ],
      cta: { label: "Open my portal", url: portal(brand, rcp ? "receptionist" : "") },
    };
  }),

  // ---------------------------------------------------------------- FirstRing monthly plans (2026-11-25)
  trial_ending: client("transactional", true, (ctx, { brand }) => {
    const sub = ctx.subscription;
    const p = planOf(sub?.plan_code);
    const ends = fmtDate(sub?.trial_ends_at);
    return {
      subject: `Your free trial ends ${ends || "in 3 days"}`,
      preheader: p ? `Then ${p.name} starts at ${usd(p.monthly_cents)}/mo on the card you gave. Cancel any time before that and you pay nothing.` : "Cancel any time before it ends and you pay nothing.",
      heading: "Your free trial ends soon",
      blocks: [
        { p: `${hi(ctx)} your free trial ends on **${ends}**.` },
        { facts: [["Plan", p?.name ?? sub?.plan_code ?? ""], ["Monthly", p ? `${usd(p.monthly_cents)}/mo` : ""],
          ["First charge", ends ? `${ends}, on the card you gave at sign-up` : "when the trial ends"]] },
        { p: "Nothing to do if you want to keep it: your receptionist keeps answering without a break." },
        { p: "Don't want to keep it? Cancel in your portal (Billing) before the trial ends and you pay nothing." },
      ],
      cta: { label: "Review my plan", url: portal(brand, "billing") },
    };
  }),

  subscription_message_mode: client("transactional", true, (ctx, { brand }) => {
    const r = ctx.subscription?.reason || ctx.subscription?.service_reason || "";
    const why: Record<string, string> = {
      trial_ended: "Your free trial ended and no paid plan has started.",
      canceled: "Your plan has ended (it was cancelled).",
      past_due: "We couldn't collect your monthly payment, and the grace period is over.",
      paused: "Your plan is paused.",
    };
    return {
      subject: "Your receptionist is now in message mode",
      preheader: "Calls are still answered: name, number and reason are emailed to you.",
      heading: "Message mode is on",
      blocks: [
        { p: `${hi(ctx)} ${why[r] ?? "Your plan is not active right now."}` },
        { p: MESSAGE_MODE },
        { p: r === "past_due" ? "To get full answering back, update your payment details in your portal (Billing)."
          : "To get full answering back (booking, answers, alerts), restart your plan in your portal (Billing). Your number and settings are kept." },
        { small: FORWARD_OFF },
      ],
      cta: { label: "Restart my plan", url: portal(brand, "billing") },
    };
  }),

  subscription_restored: client("transactional", true, (ctx, { brand }) => ({
    subject: "Full answering is back on",
    preheader: "Your receptionist answers, books and alerts again.",
    heading: "You're back to full answering",
    blocks: [
      { p: `${hi(ctx)} your plan is active again${ctx.subscription?.plan_code ? ` (${planName(ctx.subscription.plan_code)})` : ""}. Your receptionist answers, books visits and sends alerts as before.` },
      ...(ctx.tenant_number ? [{ facts: [["Receptionist number", fmtPhone(ctx.tenant_number)]] } as Block] : []),
      { small: "If you turned call forwarding off, turn it back on (your setup checklist shows how)." },
    ],
    cta: { label: "Open my portal", url: portal(brand, "receptionist") },
  })),

  admin_provisioning_alert: toMeir((ctx, { brand, payload }) => {
    const step = String(payload?.step ?? "");
    const label: Record<string, string> = { setup: "Automatic setup (client card, tenant, checklist)", duplicate_trial: "Second free trial for the same business phone" };
    return {
      subject: `⚠️ Automatic setup: ${biz(ctx)}`,
      preheader: label[step] ?? step,
      heading: "Check this client's setup",
      blocks: [
        { facts: [["Client", biz(ctx)], ["Step", label[step] ?? step], ["Details", String(payload?.error ?? "")],
          ["Plan", ctx.subscription?.plan_code ?? ""], ["Subscription status", ctx.subscription?.status ?? ""]] },
        { p: step === "duplicate_trial" ? "This business phone already had a free trial. No number was bought. If that's OK: 'Retry: setup' in the Subscriptions tab."
          : "The subscription is saved. After you fix the problem: 'Retry: setup' in the Subscriptions tab in the admin." },
      ],
      cta: { label: "Open the Subscriptions tab", url: admin(brand, "subscriptions") },
    };
  }),

  admin_billing_request: toMeir((ctx, { brand, payload }) => {
    const what: Record<string, string> = { plan_change: "Plan change", cancel: "Cancellation", resume: "Resume subscription" };
    return {
      subject: `Client request: ${what[String(payload?.what)] ?? String(payload?.what ?? "")} · ${biz(ctx)}`,
      preheader: "This button is not connected to the payment provider yet: make the change in the payment provider.",
      heading: "A client asked to change their subscription",
      blocks: [
        { facts: [["Client", biz(ctx)], ["Request", what[String(payload?.what)] ?? String(payload?.what ?? "")],
          ["Current plan", ctx.subscription?.plan_code ?? ""], ["Requested plan", String(payload?.to ?? "")],
          ["Start now", payload?.start_now ? "Yes" : ""]].filter(([, v]) => v) as Array<[string, string]> },
        { p: "Make the change in the payment provider (Paddle). Once the provider confirms, the webhook updates the system on its own." },
      ],
      cta: { label: "Open the Subscriptions tab", url: admin(brand, "subscriptions") },
    };
  }),

  // ---------------------------------------------------------------- sign-up + cancellation (2026-11-26)
  // Queued once per subscription row by private.subscriptions_emails() (20261128100000_us_subscription_emails.sql).
  trial_welcome: client("transactional", true, (ctx, { brand }) => {
    const sub = ctx.subscription;
    const p = planOf(sub?.plan_code);
    const ends = fmtDate(sub?.trial_ends_at);
    const mins = trialMinutes(p);
    return {
      subject: `Your free trial of ${planLabel(sub?.plan_code)} has started`,
      preheader: `${ends ? `Free until ${ends}. ` : ""}Next step: finish your setup checklist.`,
      heading: "Your free trial has started",
      blocks: [
        { p: `${hi(ctx)} thanks for signing up. Your free trial of **${planLabel(sub?.plan_code)}** is on.` },
        { facts: [["Free trial until", ends], ["Included in the trial", mins ? `Up to ${minutesOf(mins)} of calls` : ""],
          ["First charge", p ? `${usd(p.monthly_cents)} on ${ends || "the day the trial ends"}, unless you cancel` : ""]] },
        ...setupStep(ctx),
        { small: `Cancel anytime in your portal (Billing) before ${ends || "the trial ends"} and you pay nothing.` },
        ...paddleNote(ctx),
      ],
      cta: startedCta(ctx, brand),
    };
  }),

  plan_welcome: client("transactional", true, (ctx, { brand }) => {
    const sub = ctx.subscription;
    const p = planOf(sub?.plan_code);
    return {
      subject: `Your ${planLabel(sub?.plan_code)} plan has started`,
      preheader: `${p ? `${usd(p.monthly_cents)}/mo. ` : ""}Next step: finish your setup checklist.`,
      heading: "Your plan has started",
      blocks: [
        { p: `${hi(ctx)} thanks for signing up. Your **${planLabel(sub?.plan_code)}** plan is active.` },
        { facts: [["Monthly", p ? `${usd(p.monthly_cents)}/mo` : ""], ["Included", p?.included_usage?.voice_minutes ? `${minutesOf(p.included_usage.voice_minutes)} of calls a month` : ""],
          ["Next charge", fmtDate(sub?.current_period_end)]] },
        ...setupStep(ctx),
        { small: SUB_RULES().texts?.cancel || "Cancel anytime in your portal (Billing)." },
        ...paddleNote(ctx),
      ],
      cta: startedCta(ctx, brand),
    };
  }),

  admin_new_subscription: toMeir((ctx, { brand }) => {
    const sub = ctx.subscription;
    const p = planOf(sub?.plan_code);
    const trial = sub?.status === "trialing";
    const ends = ownerDate(sub?.trial_ends_at, brand);
    return {
      subject: `🎉 New subscription: ${biz(ctx)} · ${planName(sub?.plan_code)} · ${trial ? "free trial" : "paid"}`,
      preheader: trial ? `Free trial${ends ? ` until ${ends}` : ""}. Setup is automatic, no action needed.` : "Paid subscription. Setup is automatic, no action needed.",
      heading: trial ? "New subscription: free trial" : "New paid subscription",
      blocks: [
        { facts: [["Business", biz(ctx)], ["Name", ctx.profile?.full_name ?? ""],
          ["Plan", `${planLabel(sub?.plan_code)} (${sub?.plan_code ?? ""})`],
          ["Type", trial ? `Free trial${ends ? ` until ${ends}` : ""}` : `Paid from ${ownerDate(sub?.current_period_start ?? sub?.created_at, brand)}`],
          ["Monthly price", p ? `${usd(p.monthly_cents)}/mo` : ""],
          ["First charge", trial ? ends : ""],
          ["Business phone", fmtPhone(sub?.business_phone || ctx.profile?.phone || "")],
          ["Email", ctx.profile?.email ?? ""],
          ["Returning client", sub?.returning ? "Yes, they had an earlier subscription" : ""],
          ["Payment provider", sub?.provider ?? ""]] },
        ...(sub?.trial_duplicate
          ? [{ p: "⚠️ This business phone already had a free trial, so no number was bought and the client got no welcome email. Details are in the separate setup email." } as Block]
          : []),
        { small: "Setup is automatic: client card, tenant, checklist and number. The client goes live on their own after the test call." },
      ],
      cta: { label: "Open the Subscriptions tab", url: admin(brand, "subscriptions") },
    };
  }),

  admin_subscription_canceled: toMeir((ctx, { brand, payload }) => {
    const sub = ctx.subscription;
    const ended = payload?.kind === "ended";
    const wasTrial = String(payload?.from ?? sub?.status ?? "") === "trialing";
    const untilIso = ended ? (sub?.ends_at ?? null) : (wasTrial ? sub?.trial_ends_at : sub?.current_period_end);
    const untilDay = fmtDate(untilIso, ownerTz(brand)), until = ownerDate(untilIso, brand);
    return {
      subject: ended ? `Subscription ended: ${biz(ctx)} · ${planName(sub?.plan_code)}` : `Subscription canceled: ${biz(ctx)} · ${planName(sub?.plan_code)}${untilDay ? ` (active until ${untilDay})` : ""}`,
      preheader: ended ? "The subscription ended. The line now answers in message mode." : "The client canceled. Full service continues until the end of the period, then message mode.",
      heading: ended ? "Subscription ended" : "A client canceled their subscription",
      blocks: [
        { facts: [["Business", biz(ctx)], ["Name", ctx.profile?.full_name ?? ""], ["Plan", `${planLabel(sub?.plan_code)} (${sub?.plan_code ?? ""})`],
          ["Was on", wasTrial ? "Free trial" : "Paid subscription"], [ended ? "Ended" : "Active until", until],
          ["Business phone", fmtPhone(sub?.business_phone || ctx.profile?.phone || "")], ["Email", ctx.profile?.email ?? ""]] },
        ...(wasTrial ? [{ small: "Canceled during the trial: no charge." } as Block] : []),
        { small: "No action needed. When the service ends, the number release is scheduled on its own (Subscriptions tab: postpone or release now)." },
      ],
      cta: { label: "Open the Subscriptions tab", url: admin(brand, "subscriptions") },
    };
  }),

  request_update: client("transactional", true, (ctx, { brand }) => {
    const r = ctx.request!;
    const label = REQUEST_LABEL[r.status] ?? r.status.replace(/_/g, " ");
    const lead: Record<string, string> = {
      active: "We've started working on it.", waiting_on_you: "We need something from you to continue — see the note below.",
      done: "It's done. Take a look and reply if anything needs adjusting.", declined: "We can't take this one on as described — see the note below.",
      queued: "It's in your queue; we work on one request at a time.",
    };
    return {
      subject: `Request "${r.title}" is now ${label}`,
      preheader: lead[r.status] ?? `Status: ${label}.`,
      heading: `Request ${label}`,
      blocks: [
        { p: `${hi(ctx)} your request **${r.title}** is now **${label}**.` },
        { p: lead[r.status] ?? "" },
        ...(r.admin_reply ? [{ title: "Note from our team", quote: r.admin_reply } as Block] : []),
      ].filter((b) => !("p" in b) || b.p),
      cta: { label: "Open my requests", url: portal(brand, "requests") },
    };
  }),

  monthly_invoice: client("transactional", true, (ctx, { brand, payload }) => {
    const month = fmtMonth(String(payload?.month ?? ""));
    const products = (ctx.client?.products ?? []).map(itemName).join(" + ");
    const amount = usd(ctx.client?.monthly_cents ?? 0);
    return {
      subject: `Your ${brand.name} monthly invoice`,
      preheader: `${month}: ${amount}.`,
      heading: "Your monthly invoice",
      blocks: [
        { p: `${hi(ctx)} here's your monthly invoice for **${month}**.` },
        { facts: [["Service", products], ["Period", month], ["Amount", amount]] },
        // monthly fee = one fixed-price milestone per month, funded at the start of the month (PayPal checkout: phase 1 is
        // deposit + final only, so a PayPal client's monthly fee stays a link Meir sends)
        ...(isUpwork(ctx, brand)
          ? [{ p: `We add this month's milestone (${amount}) to your Upwork contract ${brand.quote_sla_text}. Fund it there by ${UPWORK_WAYS}.` },
            { small: `${UPWORK_ESCROW} ${UPWORK_FEES}` }] as Block[]
          : [{ p: `We'll email your secure payment link ${brand.quote_sla_text}. All payments are listed in the Billing tab of your portal.` }]),
      ],
      cta: { label: "View billing", url: portal(brand, "billing") },
    };
  }),

  // ---------------------------------------------------------------- PayPal checkout (phase 1: deposit + final)
  // Sent by pay_record_capture right after a completed PayPal capture (pay-capture or the webhook).
  payment_receipt: client("transactional", true, (ctx, { brand, payload, now }) => {
    const pay = ctx.payment!;
    const deposit = pay.kind === "deposit";
    const amount = usd(pay.amount_cents);
    const funding = String(payload?.funding ?? "").trim();
    const g = !deposit ? guaranteeOf(ctx) : null;
    const rule = deposit ? PRICEBOOK.refund_rules.deposit.text : g ? g.text : "";
    return {
      subject: `Payment received: ${amount} ${deposit ? "deposit" : "final payment"}`,
      preheader: deposit ? "Thank you. Your setup checklist is open in your portal." : "Thank you. Next, we set your go-live date.",
      heading: "Payment received — thank you",
      blocks: [
        { p: `${hi(ctx)} we received your ${deposit ? "deposit" : "final setup payment"} of **${amount}**${company(ctx) ? ` for **${company(ctx)}**` : ""}.` },
        { facts: [
          ["Amount", amount],
          ["For", deposit ? `Deposit (${depositPct()}% of setup)` : `Final setup payment (${100 - depositPct()}% of setup)`],
          ["Service", productsOf(ctx)],
          ["Date", fmtDate(pay.paid_at ?? now.toISOString())],
          ["Paid with", funding ? `${funding}, through PayPal` : "PayPal checkout"],
          ["PayPal reference", pay.provider_capture_id ?? ""],
        ] },
        { p: deposit
          ? "This was the last step before we start. Your setup checklist is now open in your portal (your online account with us), and we've emailed you the steps."
          : "This was your last setup payment. Next, we set your go-live date (the day it starts working for real customers) and email you when it's live." },
        ...(rule ? [{ small: rule } as Block] : []),
        { small: "PayPal also emails you its own receipt. Keep this email for your records." },
      ],
      cta: deposit ? { label: "Open my setup checklist", url: portal(brand, "onboarding") } : { label: "View billing", url: portal(brand, "billing") },
    };
  }),

  admin_payment_received: toMeir((ctx, { brand }) => {
    const pay = ctx.payment!;
    const deposit = pay.kind === "deposit";
    const days = Number((PRICEBOOK.refund_rules.deposit as { window_days?: number }).window_days ?? 7);
    return {
      subject: `💳 Payment received via PayPal: ${biz(ctx)} · ${usd(pay.amount_cents)}`,
      preheader: deposit ? "The deposit is paid. The checklist opened for the client on its own." : "The payment before go-live is paid. You can set the go-live now.",
      heading: "Payment received via PayPal",
      blocks: [
        { facts: [
          ["Business", biz(ctx)], ["Name", ctx.profile?.full_name ?? ""], ["Email", ctx.profile?.email ?? ""],
          ["Type", deposit ? "Deposit" : "Payment before go-live"], ["Amount", usd(pay.amount_cents)],
          ["Quote", ctx.quote ? `${productsOf(ctx) || ctx.quote.items.map((i) => String(i.code)).join(" + ")} · setup ${usd(ctx.quote.setup_cents)}` +
            (ctx.quote.accepted_at ? ` · accepted ${ownerDate(ctx.quote.accepted_at, brand)}` : "") : ""],
          ["PayPal capture ID", pay.provider_capture_id ?? ""], ["Payer's PayPal email", pay.payer_email ?? ""],
        ] },
        { title: "What now", list: deposit
          ? ["No need to mark it \"paid\": it already is. The client card is open, the checklist was sent, and the client got a receipt and a welcome email.",
            "If PayPal holds the money (On hold, common in the first months): once the work has started, mark the transaction as Completed in your PayPal activity and the money is released sooner."]
          : ["No need to mark it \"paid\": it already is, and the client got a receipt.",
            "To set the go-live: in the client card in the admin, status \"Live\" → \"Save status\"."] },
        ...(deposit ? [{ small: `Deposit refund within ${days} days of payment: the "Refund" button on the payment row in the client card.` } as Block] : []),
      ],
      cta: { label: "Open the client in admin", url: admin(brand, `clients/${ctx.client?.id ?? ""}`) },
    };
  }),

  // From the paypal-webhook: dispute, reversal, partial refund, a capture that doesn't match our row, a capture we don't know.
  admin_paypal_alert: toMeir((ctx, { brand, payload }) => {
    const kind = String(payload?.kind ?? "");
    const a = PAYPAL_ALERTS[kind] ?? PAYPAL_ALERTS.mismatch;
    const reason = String(payload?.reason ?? "");
    const who = ctx.client || ctx.profile?.email ? biz(ctx) : "";
    return {
      subject: `${a.subject}${who ? `: ${who}` : ""}${ctx.payment ? ` · ${usd(ctx.payment.amount_cents)}` : ""}`,
      preheader: a.what[0],
      heading: a.heading,
      blocks: [
        { facts: [
          ["Business", who], ["Email", ctx.profile?.email ?? ""],
          ["Our payment row", ctx.payment ? `${ctx.payment.kind === "deposit" ? "Deposit" : ctx.payment.kind === "final" ? "Payment before go-live" : ctx.payment.kind} · ${usd(ctx.payment.amount_cents)}` : "Not found"],
          ["Amount per PayPal", String(payload?.paypal_amount ?? payload?.refund_amount ?? "")],
          ["Reason", reason ? `${DISPUTE_REASONS[reason] ?? reason} (${reason})` : ""],
          ["What didn't match", String(payload?.problems ?? "")],
          ["PayPal ID", String(payload?.ref ?? "")],
          ["Capture ID", String(payload?.capture_id ?? ctx.payment?.provider_capture_id ?? "")],
          ["Respond by", String(payload?.response_due ?? "")],
        ] },
        { title: "What now", list: a.what },
      ],
      cta: ctx.client?.id ? { label: "Open the client in admin", url: admin(brand, `clients/${ctx.client.id}`) } : { label: "Open clients in admin", url: admin(brand, "clients") },
    };
  }),

  // The client pressed "Pay through Upwork instead" on the quote page (pay-upwork): the same contract checklist as when
  // a quote is accepted on Upwork.
  admin_upwork_requested: toMeir((ctx, { brand }) => {
    const q = ctx.quote!;
    const final = (q.setup_cents ?? 0) - (q.deposit_cents ?? 0);
    return {
      subject: `🔁 ${biz(ctx)} asked to pay through Upwork`,
      preheader: `Deposit: ${usd(q.deposit_cents)}. Create an Upwork contract (Direct Contract).`,
      heading: "The client chose to pay through Upwork",
      blocks: [
        { p: "On the quote page the client pressed \"Pay through Upwork instead\" instead of paying by card. The quote moved to Upwork, and the client sees that the contract will come by email from Upwork." },
        { facts: [
          ["Business", biz(ctx)], ["Signed by", q.accepted_name ?? ""], ["Setup", usd(q.setup_cents)], ["Deposit", usd(q.deposit_cents)],
          ["Monthly", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : ""], ["Payment method", "Upwork (Direct Contract)"],
        ] },
        ...upworkContract(ctx, brand, { codes: q.items.map((i) => String(i.code)), deposit: q.deposit_cents, final, monthly: q.monthly_cents,
          basis: `as described in your accepted fixed quote${q.accepted_at ? ` (${fmtDate(q.accepted_at)})` : ""}` }),
        { title: "What now", list: ["Create the Upwork contract with the details above.",
          "When the client funds the first milestone in Upwork: \"Mark paid\" on the deposit (reference: the Upwork contract number). The client gets the checklist automatically."] },
      ],
      cta: { label: "Open in admin", url: admin(brand, `quotes/${q.id}`) },
    };
  }),
};

const productsOf = (ctx: EmailCtx) => (ctx.client?.products ?? []).map(itemName).join(" + ");

/** Copy of the owner alerts (admin_paypal_alert), by kind. */
export const PAYPAL_ALERTS: Record<string, { subject: string; heading: string; what: string[] }> = {
  dispute: { subject: "⚠️ New PayPal dispute", heading: "A client opened a PayPal dispute", what: [
    "Go to PayPal → Resolution Center and open the dispute.",
    "Reply within 2 days, in writing, with proof: the accepted quote, the portal log, the emails and the go-live date.",
    "Don't refund money outside the dispute, or the client may get it twice."] },
  reversed: { subject: "⚠️ PayPal reversed a payment to the client", heading: "Payment reversed", what: [
    "PayPal returned the money to the client (usually after a dispute or a bank chargeback). The payment is marked \"refunded\" in the system.",
    "Check PayPal → Activity for the reason, and decide whether to stop work for this client."] },
  partial_refund: { subject: "Partial refund in PayPal", heading: "A partial refund was made", what: [
    "A partial refund of the payment was made in PayPal. In the system the payment stays \"paid\".",
    "If you meant to refund it all, finish the refund in PayPal. The full refund is marked in the system on its own."] },
  mismatch: { subject: "⚠️ PayPal payment doesn't match", heading: "Payment doesn't match the quote", what: [
    "PayPal reported a payment that doesn't match our payment row (amount, currency or order), or a double payment. It was not marked \"paid\".",
    "Check PayPal → Activity. If money was taken by mistake, refund it there.",
    "Pass the capture ID from this email to Claude."] },
  declined: { subject: "PayPal payment didn't go through", heading: "PayPal declined a payment that was under review", what: [
    "PayPal reviewed the payment (it was \"pending\") and then declined it. No money came in.",
    "The client can pay again: the payment buttons are back on the quote page (or in the portal, for the payment before go-live).",
    "Worth writing to the client to try again, with another card or through Upwork."] },
  unknown_capture: { subject: "PayPal payment not made through the quote button", heading: "Payment not found in the system", what: [
    "A PayPal payment came in that doesn't belong to any payment in the system (for example a PayPal invoice you sent by hand).",
    "If it's a client's payment: in the client card in the admin, \"Mark paid\" with the capture ID as the reference."] },
};
/** PayPal dispute reasons (CUSTOMER.DISPUTE.CREATED resource.reason), in plain words. */
export const DISPUTE_REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "The client says they didn't get the service",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "The client says the service wasn't as described",
  UNAUTHORISED: "The client says they didn't make the payment",
  CREDIT_NOT_PROCESSED: "The client says a refund wasn't processed",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  INCORRECT_AMOUNT: "Wrong amount",
  PAYMENT_BY_OTHER_MEANS: "The client says they paid another way",
  CANCELED_RECURRING_BILLING: "Canceled recurring billing",
  PROBLEM_WITH_REMITTANCE: "Problem with the transfer",
  OTHER: "Other",
};

/** SPEC §5 events NOT rendered here (boundary): who sends them instead. */
export const BOUNDARY: Record<string, string> = {
  auth_code: "Supabase Auth (supabase/auth-templates/sign_in.html, SMTP set by tools/us_setup.py)",
  lead_alert: "runtime B6 (runtime/app/notify/core.py -> Resend + owner SMS)",
  daily_summary: "runtime B6 (runtime/app/reports.py, tenant timezone)",
  admin_daily: "runtime B6 (runtime/app/reports.py, 08:00 owner timezone)",
};
