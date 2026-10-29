// A8 email templates: one entry per SPEC §5 event the dispatcher sends (+ two quote mails A6 emits).
// Client mails: US English, LTR. Mails to Meir: Hebrew, RTL. Brand/links from brand.json, product names and the deposit
// share from pricebook.json, amounts from the database row (never typed here). Copy: concrete, no promised outcomes.
// Subjects follow SPEC §5; `q_received` uses brand.quote_sla_text (A5 decision) instead of the literal "1 business day".
import { PRICEBOOK } from "../config.ts";
import { defaultPayMethod, PAYPAL_METHOD, toPublicView } from "../quote_engine.ts";
import { paypalOn } from "../quote_view.mjs";
import { quoteUrl, renderQuoteEmail, usd } from "../quote_email.ts";
import type { QuoteRow } from "../store.ts";
import { type Block, type EmailBrand, type EmailSpec, ltr, type Rendered, renderEmail, siteUrl } from "./layout.ts";

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
  client?: { id: string; status: string; products: string[]; monthly_cents: number | null; business_name: string | null; go_live_at: string | null; next_bill_on: string | null };
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
const biz = (ctx: EmailCtx) => company(ctx) || (ctx.profile?.full_name ?? "").trim() || (ctx.profile?.email ?? "").trim() || "לקוח";
const portal = (b: EmailBrand, tab = "") => `${siteUrl(b)}/start/${tab ? "#" + tab : ""}`;
const admin = (b: EmailBrand, route: string) => `${siteUrl(b)}/start/admin/#${route}`;
const itemName = (code: string) => PRICEBOOK.items.find((i) => i.code === code)?.name ?? code;
const depositPct = () => Number((PRICEBOOK.rules as Record<string, unknown>).deposit_pct ?? 50);
const isReceptionist = (ctx: EmailCtx) => (ctx.client?.products ?? ["RCP"]).some((p) => p === "RCP" || p === "BNDL");
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
const PAYPAL_LABEL_HE = "PayPal – כפתור בדף ההצעה";
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

/** Meir's Direct Contract checklist (Hebrew). One value per row = what he copies into Upwork (English, the client sees it
 *  there); amounts from the quote row. Without a quote (WEB self-serve) the amounts are left to Meir. */
function upworkContract(ctx: EmailCtx, brand: EmailBrand, o: { codes: string[]; basis: string; deposit?: number | null; final?: number | null;
  monthly?: number | null }): Block[] {
  const product = itemName(coreOf(o.codes));
  const desc = `Setup of the ${product} ${o.basis}.` + (o.monthly ? ` Monthly plan from go-live: ${usd(o.monthly)}/mo, one milestone per month.` : "");
  return [
    { p: `**ליצור ב-Upwork:** ${ltr("Find work → Direct Contracts → Create a contract")}` },
    { facts: [
      ["מייל הלקוח", ctx.profile?.email ?? ""],
      ["סוג חוזה", "Fixed-price"],
      ["שם החוזה", `${brand.name} – ${product} setup`],
      ["אבן דרך 1 (המקדמה): שם", hasLine(o.codes) ? UPWORK_MILESTONES.setup_line : UPWORK_MILESTONES.setup_web],
      ["אבן דרך 1: סכום", usd(o.deposit)],
      ["אבן דרך 2 (לפני עלייה לאוויר): שם", UPWORK_MILESTONES.golive],
      ["אבן דרך 2: סכום", usd(o.final)],
      ["תיאור (שורה אחת)", desc],
    ] },
    { small: "אם הלקוח כבר רשום ב-Upwork: לבקש ממנו לשכור אותך דרך הפרופיל." },
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
  render: (ctx, env) => renderEmail({ lang: "he", footer: "admin", ...spec(ctx, env) }, env.brand),
});

const REQUEST_LABEL: Record<string, string> = {
  queued: "queued", active: "in progress", waiting_on_you: "waiting on you", done: "done", declined: "declined",
};
const OFFER_LABEL: Record<string, string> = { UNSURE: "לא בטוח" };
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
      subject: `אתר (WEB): ${biz(ctx)} מחכה לקישור מקדמה`,
      preheader: upwork ? "לקוח בחר חבילת אתר. צריך ליצור לו חוזה ב-Upwork למקדמה."
        : paypal ? "לקוח בחר חבילת אתר. ליצור לו הצעה מהשאלון ולשלוח: הוא ישלם את המקדמה בכרטיס בדף ההצעה."
        : "לקוח בחר חבילת אתר. צריך לשלוח לו קישור תשלום למקדמה.",
      heading: "לקוח בחר חבילת אתר",
      blocks: [
        { facts: [["עסק", biz(ctx)], ["שם", ctx.profile?.full_name ?? ""], ["מייל", ctx.profile?.email ?? ""],
          ["טלפון", ctx.profile?.phone ?? ""], ["עיר", [ctx.profile?.city, ctx.profile?.state].filter(Boolean).join(", ")],
          ["נישה", qn?.niche ?? ""]] },
        // no quote on the WEB path: the amounts depend on the extras the client picked (answers below), so Meir sets them
        ...(upwork ? [...upworkContract(ctx, brand, { codes: ["WEB"], basis: "as chosen in your questionnaire" }),
          { small: `הסכומים: המקדמה היא ${depositPct()}% מההקמה לפי המחירון, כולל התוספות שהלקוח בחר; השאר לפני העלייה לאוויר.` } as Block] : []),
        ...(paypal ? [{ p: `**לשלוח הצעה:** באדמין, בשאלון ← "צור טיוטת הצעה" ← "אשר ושלח". אמצעי התשלום "${PAYPAL_LABEL_HE}" כבר נבחר, והלקוח ישלם את המקדמה בכרטיס או ב-PayPal בדף ההצעה.` } as Block] : []),
        ...(answers.length ? [{ title: "מהשאלון", list: answers } as Block] : []),
        { small: upwork ? `הלקוח קיבל מייל שהחוזה יגיע מ-Upwork ${brand.quote_sla_text}.` : `הלקוח קיבל מייל שהקישור יגיע ${brand.quote_sla_text}.` },
      ],
      cta: { label: "פתח את השאלון באדמין", url: admin(brand, `questionnaires/${qn?.id ?? ""}`) },
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
    subject: `${biz(ctx)} ביטל בקשה: ${ctx.request?.title ?? ""}`,
    preheader: "הבקשה הוסרה מהתור. אין צורך בפעולה.",
    heading: "בקשה בוטלה",
    blocks: [
      { facts: [["עסק", biz(ctx)], ["בקשה", ctx.request?.title ?? ""], ["מייל", ctx.profile?.email ?? ""]] },
      { small: "הלקוח ביטל בקשה שחיכתה בתור. אין צורך בפעולה." },
    ],
    cta: { label: "תור ריטיינר באדמין", url: admin(brand, "requests") },
  })),

  admin_new_quote: toMeir((ctx, { brand }) => {
    const q = ctx.quote!;
    const manual = q.status === "needs_manual_price";
    const amount = q.setup_cents != null && !manual ? usd(q.setup_cents) : "תמחור ידני";
    const offer = ctx.offer ? (OFFER_LABEL[ctx.offer] ?? ctx.offer) : String(q.items[0]?.code ?? "");
    const flags = [...(ctx.review?.manual_reasons ?? []), ...(ctx.review?.risk_flags ?? [])];
    return {
      subject: `הצעה חדשה לאישור: ${biz(ctx)} · ${offer} · ${ltr(amount)}`,
      preheader: manual ? "הטיוטה דורשת מחיר ידני לפני שליחה." : "טיוטה מוכנה. שום דבר לא נשלח ללקוח לפני שתאשר.",
      heading: manual ? "טיוטת הצעה: צריך מחיר ידני" : "טיוטת הצעה מוכנה לאישור",
      blocks: [
        { facts: [
          ["עסק", biz(ctx)], ["שם", ctx.profile?.full_name ?? ""], ["מייל", ctx.profile?.email ?? ""],
          ["הצעה", offer], ["נישה", ctx.niche ?? ""],
          ["הקמה", q.setup_cents != null ? usd(q.setup_cents) : "—"],
          ["חודשי", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : "—"],
          ["מקדמה", q.deposit_cents != null ? usd(q.deposit_cents) : "—"],
        ] },
        { title: "שורות", list: q.items.map((i) => `${i.code} · ${i.name ?? itemName(String(i.code))}${Number(i.qty ?? 1) > 1 ? ` × ${i.qty}` : ""}`) },
        ...(flags.length ? [{ title: "לבדיקה לפני שליחה", list: flags.map(String) } as Block] : []),
        { small: "שום דבר לא נשלח ללקוח עד שתלחץ \"אשר ושלח\" באדמין." },
      ],
      cta: { label: "פתח את ההצעה באדמין", url: admin(brand, `quotes/${q.id}`) },
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
      subject: `✅ ${biz(ctx)} אישר הצעה, ממתין לתשלום`,
      preheader: upwork ? `מקדמה: ${usd(q.deposit_cents)}. ליצור חוזה ב-Upwork.`
        : paypal ? `מקדמה: ${usd(q.deposit_cents)}. הלקוח משלם בכרטיס או ב-PayPal בדף ההצעה.` : `מקדמה: ${usd(q.deposit_cents)}`,
      heading: "הלקוח אישר את ההצעה",
      blocks: [
        { facts: [
          ["עסק", biz(ctx)], ["חתם", q.accepted_name ?? ""], ["מתי", fmtDate(q.accepted_at, brand.owner?.timezone || "UTC", "he")],
          ["הקמה", usd(q.setup_cents)], ["מקדמה", usd(q.deposit_cents)], ["חודשי", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : ""],
          ...(upwork
            ? [["אמצעי תשלום", "Upwork (Direct Contract)"], ["קישור לחוזה", q.pay_link ? "יש, הלקוח רואה כפתור לחוזה" : "אין, הלקוח מחכה למייל מ-Upwork"]]
            : paypal ? [["אמצעי תשלום", PAYPAL_LABEL_HE], ["תשלום", "הלקוח משלם בכרטיס או ב-PayPal בדף ההצעה"]]
            : [["אמצעי תשלום", payMethod(ctx, brand)], ["קישור תשלום", q.pay_link ? "יש, הלקוח רואה כפתור תשלום" : "אין, צריך לשלוח ללקוח"]]) as Array<[string, string]>,
        ] },
        ...(upwork ? upworkContract(ctx, brand, { codes: q.items.map((i) => String(i.code)), deposit: q.deposit_cents, final,
          monthly: q.monthly_cents, basis: `as described in your accepted fixed quote${q.accepted_at ? ` (${fmtDate(q.accepted_at)})` : ""}` }) : []),
        { title: "מה עכשיו", list: paypal
          ? ["אין צורך לשלוח קישור: הלקוח משלם בכרטיס או ב-PayPal בדף ההצעה.",
            "כשהתשלום עובר, הוא מסומן \"שולם\" לבד: כרטיס הלקוח נפתח, הצ'ק-ליסט נשלח, ויגיע אליך מייל \"תשלום התקבל ב-PayPal\".",
            "אם הלקוח יעדיף Upwork, יגיע אליך מייל נפרד עם פרטי החוזה."]
          : [
            ...(upwork ? ["ליצור את החוזה ב-Upwork לפי הפרטים למעלה."] : q.pay_link ? [] : ["לשלוח ללקוח קישור תשלום למקדמה."]),
            "לפתוח כרטיס לקוח מההצעה באדמין.",
            upwork ? "כשהלקוח מימן ב-Upwork את אבן הדרך הראשונה: \"סמן כשולם\" על המקדמה (באסמכתה: מספר החוזה ב-Upwork). הלקוח יקבל אוטומטית את הצ'ק-ליסט."
              : "כשהכסף מגיע: \"סמן כשולם\" על המקדמה. הלקוח יקבל אוטומטית את הצ'ק-ליסט.",
          ] },
      ],
      cta: { label: "פתח באדמין", url: admin(brand, `quotes/${q.id}`) },
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
    subject: `${biz(ctx)} צריך עזרה ב: ${ctx.item?.title ?? ""}`,
    preheader: (ctx.item?.message ?? "").slice(0, 120) || "לקוח לחץ Need help בצ'ק-ליסט.",
    heading: "בקשת עזרה בצ'ק-ליסט",
    blocks: [
      { facts: [["עסק", biz(ctx)], ["סעיף", ctx.item?.title ?? ""], ["מייל", ctx.profile?.email ?? ""], ["טלפון", ctx.profile?.phone ?? ""]] },
      ...(ctx.item?.message ? [{ title: "מה הלקוח כתב", quote: ctx.item.message } as Block] : [{ small: "הלקוח לא הוסיף הסבר." } as Block]),
      { small: "התשובה נכתבת ללקוח, לא בשיחה." },
    ],
    cta: { label: "פתח את הלקוח באדמין", url: admin(brand, `clients/${ctx.client?.id ?? ""}`) },
  })),

  ready_to_test: client("transactional", true, (ctx, { brand }) => {
    const rcp = isReceptionist(ctx);
    const num = fmtPhone(ctx.tenant_number);
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
          ["Monthly", ctx.client?.monthly_cents ? `${usd(ctx.client.monthly_cents)}/mo` : ""]].filter(([k]) => k) as Array<[string, string]> },
        ...(rcp ? [{ small: "You can pause the AI any time from your portal." } as Block] : []),
        ...guaranteeBlocks(ctx),
      ],
      cta: { label: "Open my portal", url: portal(brand, rcp ? "receptionist" : "") },
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
      subject: `💳 תשלום התקבל ב-PayPal: ${biz(ctx)} · ${ltr(usd(pay.amount_cents))}`,
      preheader: deposit ? "המקדמה שולמה. הצ'ק-ליסט נפתח ללקוח לבד." : "התשלום לפני עלייה לאוויר שולם. אפשר לקבוע עלייה לאוויר.",
      heading: "תשלום התקבל ב-PayPal",
      blocks: [
        { facts: [
          ["עסק", biz(ctx)], ["שם", ctx.profile?.full_name ?? ""], ["מייל", ctx.profile?.email ?? ""],
          ["סוג", deposit ? "מקדמה" : "תשלום לפני עלייה לאוויר"], ["סכום", usd(pay.amount_cents)],
          ["הצעה", ctx.quote ? `${productsOf(ctx) || ctx.quote.items.map((i) => String(i.code)).join(" + ")} · הקמה ${usd(ctx.quote.setup_cents)}` +
            (ctx.quote.accepted_at ? ` · אושרה ${fmtDate(ctx.quote.accepted_at, brand.owner?.timezone || "UTC", "he")}` : "") : ""],
          ["מזהה חיוב ב-PayPal", pay.provider_capture_id ?? ""], ["מייל המשלם ב-PayPal", pay.payer_email ?? ""],
        ] },
        { title: "מה עכשיו", list: deposit
          ? ["לא צריך לסמן \"שולם\": זה כבר מסומן. כרטיס הלקוח נפתח, הצ'ק-ליסט נשלח, והלקוח קיבל קבלה ומייל Welcome.",
            "אם PayPal מחזיק את הכסף (On hold, נפוץ בחודשים הראשונים): אחרי שהעבודה התחילה, בפעילות של PayPal לסמן את העסקה כ-Completed, והכסף משתחרר מהר יותר."]
          : ["לא צריך לסמן \"שולם\": זה כבר מסומן והלקוח קיבל קבלה.",
            "לקבוע עלייה לאוויר: בכרטיס הלקוח באדמין, סטטוס \"באוויר\" ← \"שמירת סטטוס\"."] },
        ...(deposit ? [{ small: `החזר מקדמה תוך ${days} ימים מהתשלום: כפתור "החזר" בשורת התשלום בכרטיס הלקוח.` } as Block] : []),
      ],
      cta: { label: "פתח את הלקוח באדמין", url: admin(brand, `clients/${ctx.client?.id ?? ""}`) },
    };
  }),

  // From the paypal-webhook: dispute, reversal, partial refund, a capture that doesn't match our row, a capture we don't know.
  admin_paypal_alert: toMeir((ctx, { brand, payload }) => {
    const kind = String(payload?.kind ?? "");
    const a = PAYPAL_ALERTS[kind] ?? PAYPAL_ALERTS.mismatch;
    const reason = String(payload?.reason ?? "");
    const who = ctx.client || ctx.profile?.email ? biz(ctx) : "";
    return {
      subject: `${a.subject}${who ? `: ${who}` : ""}${ctx.payment ? ` · ${ltr(usd(ctx.payment.amount_cents))}` : ""}`,
      preheader: a.what[0],
      heading: a.heading,
      blocks: [
        { facts: [
          ["עסק", who], ["מייל", ctx.profile?.email ?? ""],
          ["תשלום אצלנו", ctx.payment ? `${ctx.payment.kind === "deposit" ? "מקדמה" : ctx.payment.kind === "final" ? "תשלום לפני עלייה לאוויר" : ctx.payment.kind} · ${usd(ctx.payment.amount_cents)}` : "לא נמצא"],
          ["סכום לפי PayPal", String(payload?.paypal_amount ?? payload?.refund_amount ?? "")],
          ["סיבה", reason ? `${DISPUTE_REASONS[reason] ?? reason} (${reason})` : ""],
          ["מה לא תאם", String(payload?.problems ?? "")],
          ["מזהה ב-PayPal", String(payload?.ref ?? "")],
          ["מזהה חיוב", String(payload?.capture_id ?? ctx.payment?.provider_capture_id ?? "")],
          ["לענות עד", String(payload?.response_due ?? "")],
        ] },
        { title: "מה עכשיו", list: a.what },
      ],
      cta: ctx.client?.id ? { label: "פתח את הלקוח באדמין", url: admin(brand, `clients/${ctx.client.id}`) } : { label: "פתח את הלקוחות באדמין", url: admin(brand, "clients") },
    };
  }),

  // The client pressed "Pay through Upwork instead" on the quote page (pay-upwork): the same contract checklist as when
  // a quote is accepted on Upwork.
  admin_upwork_requested: toMeir((ctx, { brand }) => {
    const q = ctx.quote!;
    const final = (q.setup_cents ?? 0) - (q.deposit_cents ?? 0);
    return {
      subject: `🔁 ${biz(ctx)} ביקש לשלם דרך Upwork`,
      preheader: `מקדמה: ${usd(q.deposit_cents)}. ליצור חוזה ב-Upwork (Direct Contract).`,
      heading: "הלקוח בחר לשלם דרך Upwork",
      blocks: [
        { p: "בדף ההצעה הלקוח לחץ \"Pay through Upwork instead\" במקום לשלם בכרטיס. ההצעה עברה ל-Upwork, והלקוח רואה שהחוזה יגיע אליו במייל מ-Upwork." },
        { facts: [
          ["עסק", biz(ctx)], ["חתם", q.accepted_name ?? ""], ["הקמה", usd(q.setup_cents)], ["מקדמה", usd(q.deposit_cents)],
          ["חודשי", q.monthly_cents != null ? `${usd(q.monthly_cents)}/mo` : ""], ["אמצעי תשלום", "Upwork (Direct Contract)"],
        ] },
        ...upworkContract(ctx, brand, { codes: q.items.map((i) => String(i.code)), deposit: q.deposit_cents, final, monthly: q.monthly_cents,
          basis: `as described in your accepted fixed quote${q.accepted_at ? ` (${fmtDate(q.accepted_at)})` : ""}` }),
        { title: "מה עכשיו", list: ["ליצור את החוזה ב-Upwork לפי הפרטים למעלה.",
          "כשהלקוח מימן ב-Upwork את אבן הדרך הראשונה: \"סמן כשולם\" על המקדמה (באסמכתה: מספר החוזה ב-Upwork). הלקוח יקבל אוטומטית את הצ'ק-ליסט."] },
      ],
      cta: { label: "פתח באדמין", url: admin(brand, `quotes/${q.id}`) },
    };
  }),
};

const productsOf = (ctx: EmailCtx) => (ctx.client?.products ?? []).map(itemName).join(" + ");

/** Hebrew copy of the owner alerts (admin_paypal_alert), by kind. */
export const PAYPAL_ALERTS: Record<string, { subject: string; heading: string; what: string[] }> = {
  dispute: { subject: "⚠️ מחלוקת חדשה ב-PayPal", heading: "לקוח פתח מחלוקת ב-PayPal", what: [
    "להיכנס ל-PayPal ← Resolution Center ולפתוח את המחלוקת.",
    "לענות תוך יומיים, בכתב, עם הוכחות: ההצעה שאושרה, יומן הפורטל, המיילים ותאריך העלייה לאוויר.",
    "לא להחזיר כסף מחוץ למחלוקת, אחרת הלקוח עלול לקבל אותו פעמיים."] },
  reversed: { subject: "⚠️ PayPal החזיר תשלום ללקוח", heading: "תשלום בוטל (Reversal)", what: [
    "PayPal החזיר את הכסף ללקוח (בדרך כלל אחרי מחלוקת או ביטול חיוב בבנק). התשלום סומן \"הוחזר\" במערכת.",
    "לבדוק ב-PayPal ← Activity מה הסיבה, ולהחליט אם לעצור את העבודה ללקוח."] },
  partial_refund: { subject: "החזר חלקי ב-PayPal", heading: "בוצע החזר חלקי", what: [
    "ב-PayPal בוצע החזר חלקי של התשלום. במערכת התשלום נשאר \"שולם\".",
    "אם הכוונה הייתה להחזיר הכל, להשלים את ההחזר ב-PayPal. ההחזר המלא יסומן במערכת לבד."] },
  mismatch: { subject: "⚠️ תשלום PayPal לא תואם", heading: "תשלום שלא תואם להצעה", what: [
    "PayPal דיווח על תשלום שלא תואם לשורת התשלום אצלנו (סכום, מטבע או הזמנה), או על תשלום כפול. הוא לא סומן \"שולם\".",
    "לבדוק ב-PayPal ← Activity. אם נגבה כסף בטעות, להחזיר אותו שם.",
    "להעביר לקלוד את מזהה החיוב מהמייל הזה."] },
  declined: { subject: "תשלום PayPal לא עבר", heading: "PayPal דחה תשלום שהיה בבדיקה", what: [
    "PayPal בדק את התשלום (הוא היה \"בעיבוד\") ובסוף דחה אותו. לא התקבל כסף.",
    "הלקוח יכול לשלם שוב: כפתורי התשלום חזרו לדף ההצעה (או לפורטל, בתשלום שלפני העלייה לאוויר).",
    "כדאי לכתוב ללקוח שינסה שוב, בכרטיס אחר או דרך Upwork."] },
  unknown_capture: { subject: "תשלום PayPal שלא דרך כפתור ההצעה", heading: "תשלום שלא מזוהה במערכת", what: [
    "התקבל ב-PayPal תשלום שלא שייך לאף תשלום במערכת (למשל חשבונית PayPal ששלחת ידנית).",
    "אם זה תשלום של לקוח: בכרטיס הלקוח באדמין, \"סמן כשולם\" עם מזהה החיוב באסמכתה."] },
};
/** PayPal dispute reasons (CUSTOMER.DISPUTE.CREATED resource.reason) in Hebrew. */
export const DISPUTE_REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "הלקוח טוען שלא קיבל את השירות",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "הלקוח טוען שהשירות לא כמו שתואר",
  UNAUTHORISED: "הלקוח טוען שלא הוא ביצע את התשלום",
  CREDIT_NOT_PROCESSED: "הלקוח טוען שהחזר לא בוצע",
  DUPLICATE_TRANSACTION: "חיוב כפול",
  INCORRECT_AMOUNT: "סכום שגוי",
  PAYMENT_BY_OTHER_MEANS: "הלקוח טוען ששילם בדרך אחרת",
  CANCELED_RECURRING_BILLING: "חיוב חוזר שבוטל",
  PROBLEM_WITH_REMITTANCE: "בעיה בהעברה",
  OTHER: "אחר",
};

/** SPEC §5 events NOT rendered here (boundary): who sends them instead. */
export const BOUNDARY: Record<string, string> = {
  auth_code: "Supabase Auth (supabase/auth-templates/sign_in.html, SMTP set by tools/us_setup.py)",
  lead_alert: "runtime B6 (runtime/app/notify/core.py -> Resend + owner SMS)",
  daily_summary: "runtime B6 (runtime/app/reports.py, tenant timezone)",
  admin_daily: "runtime B6 (runtime/app/reports.py, 08:00 owner timezone)",
};
