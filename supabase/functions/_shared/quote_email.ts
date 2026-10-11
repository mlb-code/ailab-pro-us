// HTML + plain-text email for `quote_sent` (SPEC §2.4/§5): the same content as the quote page, condensed, with one
// button to the page. Table layout, inline CSS, ≤ 600 px, light-on-dark-safe (explicit bgcolor on every cell, a
// prefers-color-scheme block for clients that support it, no text baked into images). A8's notify function imports this.
import { BRAND, type Brand } from "./config.ts";
import type { PublicQuote } from "./quote_engine.ts";

export const usd = (cents: number | null | undefined) =>
  cents == null ? "" : "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const fmtDate = (iso: string | null) => {
  if (!iso) return "";
  try { return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
};

/** Plain paragraphs from Claude's approved markdown (only **bold** survives; everything else is text). */
function paragraphs(md: string): string[] {
  return md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}
const inlineMd = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

export function quoteEmailSubject(v: PublicQuote, brand: Brand = BRAND): string {
  return `Your fixed quote from ${brand.name}: ${usd(v.totals.setup_cents)} + ${usd(v.totals.monthly_cents)}/mo`;
}

export function quoteUrl(token: string, brand: Brand = BRAND): string {
  // fragment, not query: never sent to the static host or in Referer headers
  return `${brand.site_url.replace(/\/$/, "")}/quote/#t=${encodeURIComponent(token)}`;
}

const C = { bg: "#EFE7D8", card: "#FFFFFF", ink: "#0F1A26", ink2: "#3A4656", line: "#D9CFBD", amber: "#E8A64A", navy: "#0F1A26" };

export function renderQuoteEmail(v: PublicQuote, token: string, brand: Brand = BRAND): { subject: string; html: string; text: string } {
  const subject = quoteEmailSubject(v, brand);
  const url = quoteUrl(token, brand);
  const first = (v.client.name || "").split(" ")[0];
  const greet = first ? `Hi ${esc(first)},` : "Hi,";
  const t = v.totals;
  const row = (label: string, value: string, strong = false) =>
    `<tr><td class="c m" style="padding:8px 0;border-bottom:1px solid ${C.line};background:${C.card};font:15px/1.4 Arial,Helvetica,sans-serif;color:${C.ink2}" bgcolor="${C.card}">${label}</td>` +
    `<td class="c" align="right" style="padding:8px 0;border-bottom:1px solid ${C.line};background:${C.card};font:${strong ? "bold " : ""}15px/1.4 Arial,Helvetica,sans-serif;color:${C.ink};white-space:nowrap" bgcolor="${C.card}">${value}</td></tr>`;
  const items = v.items.map((i) => row(esc(i.name) + (i.qty > 1 ? ` &times; ${i.qty}` : ""),
    [i.setup_cents != null && i.setup_cents > 0 ? usd(i.setup_cents) : "", i.monthly_cents ? `${usd(i.monthly_cents)}/mo` : ""].filter(Boolean).join(" + ") || "Included")).join("");
  const totals = [
    t.discount_cents ? row(esc(t.discount_label ?? "Discount"), "&minus;" + usd(t.discount_cents)) : "",
    row("Setup total", usd(t.setup_cents), true),
    row(`Deposit to start (${t.deposit_pct}%)`, usd(t.deposit_cents), true),
    row("Before go-live", usd(t.final_cents)),
    row("Monthly, from go-live", `${usd(t.monthly_cents)}/mo`, true),
  ].join("");
  const scope = paragraphs(v.scope_md).slice(0, 2).map((p) =>
    `<p class="m" style="margin:0 0 12px;font:15px/1.6 Arial,Helvetica,sans-serif;color:${C.ink2}">${inlineMd(p)}</p>`).join("");
  const valid = v.valid_until ? `This quote is valid until ${esc(fmtDate(v.valid_until))}.` : "";
  const footer = [brand.name, brand.physical_address, brand.disclaimers?.footer].filter(Boolean).map(esc).join(" &middot; ");

  const html = `<!doctype html>
<html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    body, .bg, .bgc { background:#0F1A26 !important; }
    .card, .c { background:#17253A !important; color:#EFE7D8 !important; border-color:#2B3B52 !important; }
    .c h1, .c strong, .c a { color:#EFE7D8 !important; }
    .m, .c .m { color:#C9C1B3 !important; }
    .btn-td { background:#E8A64A !important; } .btn-a { color:#0F1A26 !important; }
    .hd { background:#0B141E !important; color:#EFE7D8 !important; }
  }
  [data-ogsc] .card, [data-ogsc] .c { background:#17253A !important; color:#EFE7D8 !important; }
  [data-ogsc] .m { color:#C9C1B3 !important; } [data-ogsb] .bgc { background:#0F1A26 !important; }
  @media (max-width:620px) { .card { width:100% !important; } .pad { padding:20px !important; } }
</style></head>
<body style="margin:0;padding:0;background:${C.bg}" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(`${usd(t.setup_cents)} setup + ${usd(t.monthly_cents)}/mo. ${valid}`)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}">
<tr><td class="bgc" align="center" bgcolor="${C.bg}" style="padding:24px 12px;background:${C.bg}">
  <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:600px;max-width:600px;background:${C.card};border-radius:12px">
    <tr><td class="hd" bgcolor="${C.navy}" style="background:${C.navy};padding:18px 28px;border-radius:12px 12px 0 0;font:bold 18px/1.2 Georgia,'Times New Roman',serif;color:#EFE7D8">${esc(brand.name)}</td></tr>
    <tr><td class="pad c" style="padding:28px;background:${C.card};color:${C.ink}" bgcolor="${C.card}">
      <h1 class="c" style="margin:0 0 6px;background:${C.card};font:bold 24px/1.25 Georgia,'Times New Roman',serif;color:${C.ink}">Your fixed quote${v.client.company ? " for " + esc(v.client.company) : ""}</h1>
      <p class="m" style="margin:0 0 18px;font:14px/1.5 Arial,Helvetica,sans-serif;color:${C.ink2}">${greet} here is your written quote. No call needed: review it, accept it online, and pay the deposit to start.</p>
      ${scope}
      <table role="presentation" class="c" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="margin:8px 0 18px;background:${C.card}">${items}${totals}</table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr>
        <td class="btn-td" bgcolor="${C.amber}" style="background:${C.amber};border-radius:999px">
          <a class="btn-a" href="${esc(url)}" style="display:inline-block;padding:14px 26px;font:bold 16px/1 Arial,Helvetica,sans-serif;color:${C.navy};text-decoration:none">Review &amp; accept your quote</a>
        </td></tr></table>
      <p class="m" style="margin:0 0 8px;font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.ink2}">${esc(valid)} ${esc(v.refund.deposit)}</p>
      <p class="m" style="margin:0;font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.ink2}">Questions? Just reply to this email${brand.calendly_url ? ` or <a href="${esc(brand.calendly_url)}" style="color:${C.ink}">book a 15-minute video call</a>` : ""}.</p>
    </td></tr>
    <tr><td class="c m" style="padding:16px 28px;border-top:1px solid ${C.line};background:${C.card};border-radius:0 0 12px 12px;font:12px/1.5 Arial,Helvetica,sans-serif;color:${C.ink2}" bgcolor="${C.card}">${footer}</td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `${first ? `Hi ${first},` : "Hi,"}`, "",
    `Your fixed quote${v.client.company ? " for " + v.client.company : ""} from ${brand.name}:`, "",
    ...v.items.map((i) => `- ${i.name}${i.qty > 1 ? ` x ${i.qty}` : ""}: ${[i.setup_cents ? usd(i.setup_cents) : "", i.monthly_cents ? `${usd(i.monthly_cents)}/mo` : ""].filter(Boolean).join(" + ") || "included"}`),
    ...(t.discount_cents ? [`- ${t.discount_label ?? "Discount"}: -${usd(t.discount_cents)}`] : []),
    "", `Setup total: ${usd(t.setup_cents)}`, `Deposit to start (${t.deposit_pct}%): ${usd(t.deposit_cents)}`,
    `Before go-live: ${usd(t.final_cents)}`, `Monthly from go-live: ${usd(t.monthly_cents)}/mo`, "",
    `Review and accept: ${url}`, valid, v.refund.deposit, "", [brand.name, brand.physical_address].filter(Boolean).join(" - "),
  ].join("\n");
  return { subject, html, text };
}
