// Shared email shell for A8 (same look as A6's quote email: navy header, amber button, cream page).
// Table layout, inline CSS, 600 px, explicit bgcolor on every cell + a prefers-color-scheme block (dark-mode safe),
// no text in images, plain-text alternative built from the same blocks. EN = LTR (clients), HE = RTL (Meir).
import type { Brand } from "../config.ts";

export type EmailBrand = Brand & {
  smtp_from?: string;
  senders: Brand["senders"] & { fallback?: string };
  owner?: { admin_email?: string; timezone?: string };
};

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1");

export type Block =
  | { p: string }
  | { small: string }
  | { facts: Array<[string, string]> }
  | { list: string[]; title?: string }
  | { quote: string; title?: string }
  | { button: { label: string; url: string } };

export interface EmailSpec {
  lang: "en" | "he";
  subject: string;
  preheader: string;
  heading: string;
  blocks: Block[];
  cta?: { label: string; url: string };
  /** transactional = account/quote/billing mail; marketing = reminder (CAN-SPAM: unsubscribe + address); admin = Meir */
  footer: "transactional" | "marketing" | "admin";
  unsubUrl?: string;
}
export interface Rendered { subject: string; html: string; text: string }

const C = { bg: "#EFE7D8", card: "#FFFFFF", ink: "#0F1A26", ink2: "#3A4656", line: "#D9CFBD", amber: "#E8A64A", navy: "#0F1A26", soft: "#F7F2E8" };
const SANS = "Arial,Helvetica,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

export const siteUrl = (b: EmailBrand) => (b.site_url || "").replace(/\/$/, "");

/** wraps LTR fragments (amounts, phone numbers, e-mail addresses, codes) inside Hebrew text so they don't flip */
export const ltr = (s: string) => `⁦${s}⁩`;

function blockHtml(b: Block, he: boolean): string {
  const align = he ? "right" : "left";
  const p = (txt: string, size = 15, color = C.ink2) =>
    `<p style="margin:0 0 14px;font:${size}px/1.6 ${SANS};color:${color};text-align:${align}">${txt}</p>`;
  if ("p" in b) return p(inline(b.p));
  if ("small" in b) return `<p class="muted" style="margin:0 0 10px;font:13px/1.5 ${SANS};color:${C.ink2};text-align:${align}">${inline(b.small)}</p>`;
  if ("facts" in b) {
    const rows = b.facts.filter(([, v]) => v !== "").map(([k, v]) =>
      `<tr><td bgcolor="${C.card}" style="padding:8px 0;border-bottom:1px solid ${C.line};font:14px/1.4 ${SANS};color:${C.ink2};text-align:${align};vertical-align:top">${esc(k)}</td>` +
      `<td bgcolor="${C.card}" style="padding:8px 0;border-bottom:1px solid ${C.line};font:bold 14px/1.4 ${SANS};color:${C.ink};text-align:${he ? "left" : "right"};vertical-align:top"${he ? ' dir="auto"' : ""}>${esc(v)}</td></tr>`).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px">${rows}</table>`;
  }
  if ("list" in b) {
    const items = b.list.map((x) =>
      `<tr><td bgcolor="${C.card}" width="18" style="padding:4px 0;font:bold 15px/1.5 ${SANS};color:${C.amber};vertical-align:top;text-align:${align}">&bull;</td>` +
      `<td bgcolor="${C.card}" style="padding:4px 0;font:15px/1.5 ${SANS};color:${C.ink2};text-align:${align}"${he ? ' dir="auto"' : ""}>${inline(x)}</td></tr>`).join("");
    return (b.title ? `<p style="margin:6px 0 4px;font:bold 15px/1.4 ${SANS};color:${C.ink};text-align:${align}">${esc(b.title)}</p>` : "") +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px">${items}</table>`;
  }
  if ("quote" in b) {
    return (b.title ? `<p style="margin:6px 0 4px;font:bold 15px/1.4 ${SANS};color:${C.ink};text-align:${align}">${esc(b.title)}</p>` : "") +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>` +
      `<td class="soft" bgcolor="${C.soft}" style="background:${C.soft};border-${he ? "right" : "left"}:3px solid ${C.amber};padding:12px 14px;font:15px/1.6 ${SANS};color:${C.ink};text-align:${align};white-space:pre-wrap" dir="auto">${esc(b.quote)}</td>` +
      `</tr></table>`;
  }
  return button(b.button.label, b.button.url);
}

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px"><tr>` +
    `<td class="btn" bgcolor="${C.amber}" style="background:${C.amber};border-radius:999px">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font:bold 16px/1 ${SANS};color:${C.navy};text-decoration:none">${esc(label)}</a>` +
    `</td></tr></table>`;
}

function blockText(b: Block): string {
  if ("p" in b) return plain(b.p);
  if ("small" in b) return plain(b.small);
  if ("facts" in b) return b.facts.filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`).join("\n");
  if ("list" in b) return (b.title ? b.title + "\n" : "") + b.list.map((x) => `- ${plain(x)}`).join("\n");
  if ("quote" in b) return (b.title ? b.title + "\n" : "") + b.quote.split("\n").map((l) => `> ${l}`).join("\n");
  return `${b.button.label}: ${b.button.url}`;
}

function footerParts(spec: EmailSpec, brand: EmailBrand): { html: string; text: string } {
  const addr = brand.physical_address || "";
  if (spec.footer === "admin") {
    const t = `נשלח אוטומטית מ-${ltr(brand.name)}.`;
    return { html: esc(t), text: t };
  }
  const line1 = [brand.name, addr, brand.disclaimers?.footer].filter(Boolean).join(" · ");
  if (spec.footer === "marketing") {
    const why = `You're getting this reminder because you asked ${brand.name} for a quote or service.`;
    const unsub = spec.unsubUrl
      ? ` <a class="lnk" href="${esc(spec.unsubUrl)}" style="color:${C.ink2};text-decoration:underline">Unsubscribe from reminders</a>.`
      : "";
    return {
      html: `${esc(line1)}<br>${esc(why)}${unsub}`,
      text: `${line1}\n${why}${spec.unsubUrl ? `\nUnsubscribe from reminders: ${spec.unsubUrl}` : ""}`,
    };
  }
  const why = `You're receiving this email about your ${brand.name} account.`;
  return { html: `${esc(line1)}<br>${esc(why)}`, text: `${line1}\n${why}` };
}

export function renderEmail(spec: EmailSpec, brand: EmailBrand): Rendered {
  const he = spec.lang === "he";
  const dir = he ? "rtl" : "ltr";
  const align = he ? "right" : "left";
  const foot = footerParts(spec, brand);
  const body = spec.blocks.map((b) => blockHtml(b, he)).join("\n      ");
  const html = `<!doctype html>
<html lang="${spec.lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(spec.subject)}</title>
<style>
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    body, .bg { background:#0F1A26 !important; } .card, .card td { background:#17253A !important; }
    .card td, .card p, .card h1, .card a.lnk { color:#EFE7D8 !important; } .card td { border-color:#2B3B52 !important; }
    .muted { color:#B9B1A3 !important; } .card td.soft { background:#22324A !important; }
    .card td.hdr { background:#0B141E !important; } .card td.btn { background:#E8A64A !important; }
    .card td.btn a { color:#0F1A26 !important; }
  }
  @media (max-width:620px) { .card { width:100% !important; } .pad { padding:20px !important; } }
</style></head>
<body style="margin:0;padding:0;background:${C.bg}" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(spec.preheader)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}" dir="${dir}">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:600px;max-width:600px;background:${C.card};border-radius:12px" dir="${dir}">
    <tr><td class="hdr" bgcolor="${C.navy}" style="background:${C.navy};padding:18px 28px;border-radius:12px 12px 0 0;font:bold 18px/1.2 ${SERIF};color:#EFE7D8;text-align:${align}">${esc(brand.name)}</td></tr>
    <tr><td class="pad" bgcolor="${C.card}" style="padding:28px;text-align:${align}">
      <h1 style="margin:0 0 14px;font:bold 23px/1.3 ${he ? SANS : SERIF};color:${C.ink};text-align:${align}">${esc(spec.heading)}</h1>
      ${body}
      ${spec.cta ? button(spec.cta.label, spec.cta.url) : ""}
    </td></tr>
    <tr><td class="muted" bgcolor="${C.card}" style="padding:16px 28px;border-top:1px solid ${C.line};font:12px/1.6 ${SANS};color:${C.ink2};text-align:${align}">${foot.html}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = [
    spec.heading, "",
    ...spec.blocks.map(blockText).flatMap((t) => [t, ""]),
    ...(spec.cta ? [`${spec.cta.label}: ${spec.cta.url}`, ""] : []),
    "--", foot.text,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return { subject: spec.subject, html, text };
}
