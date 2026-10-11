// Renders every A8 template with sample data to docs/reports/email-previews/<template>.html (+ index.html) for
// screenshots and Meir's copy review. Offline: no network, no database.
//   deno run -A --node-modules-dir=none supabase/functions/_shared/email/preview.ts --preview
import { BRAND } from "../config.ts";
import type { EmailBrand } from "./layout.ts";
import { samples } from "./samples.ts";
import { BOUNDARY, TEMPLATES } from "./templates.ts";

// rendered from config, like the landing pages: tools/check_hardcoded.py treats files with this marker as generated
const MARK = "<!-- generated-by: tools/../supabase/functions/_shared/email/preview.ts -->";
const OUT = new URL("../../../../docs/reports/email-previews/", import.meta.url);

export async function writePreviews(out = OUT) {
  const brand = BRAND as EmailBrand;
  const s = await samples();
  await Deno.mkdir(out, { recursive: true });
  const rows: string[] = [];
  for (const [key, tpl] of Object.entries(TEMPLATES)) {
    const smp = s[key];
    if (!smp) throw new Error(`no sample for ${key}`);
    const unsubUrl = tpl.transactional ? undefined : "https://example.supabase.co/functions/v1/email-unsubscribe?u=" + "0".repeat(64);
    const r = tpl.render(smp.ctx, { brand, now: new Date("2026-10-12T15:00:00Z"), unsubUrl, payload: smp.payload });
    await Deno.writeTextFile(new URL(`${key}.html`, out), r.html.replace("<head>", `<head>${MARK}`));
    rows.push(`<tr><td><a href="${key}.html">${key}</a></td><td>${tpl.audience}</td><td>${tpl.transactional ? "transactional" : "reminder"}</td><td dir="auto">${
      r.subject.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td></tr>`);
  }
  const boundary = Object.entries(BOUNDARY).map(([k, v]) => `<tr><td>${k}</td><td colspan="3">not here: ${v}</td></tr>`).join("");
  await Deno.writeTextFile(new URL("index.html", out), `<!doctype html><html lang="en"><head><meta charset="utf-8">
${MARK}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Email previews</title>
<style>html{overflow-x:clip}body{font:14px/1.5 Arial,sans-serif;margin:16px;color:#0F1A26;background:#fff}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top;word-break:break-word}</style>
</head><body><h1>Email previews (A8)</h1><p>Rendered from sample data; regenerate with the --preview script.</p>
<table><tr><th>template</th><th>to</th><th>kind</th><th>subject</th></tr>${rows.join("")}${boundary}</table></body></html>`);
  return Object.keys(TEMPLATES).length;
}

if (import.meta.main) {
  if (!Deno.args.includes("--preview")) {
    console.log("usage: preview.ts --preview");
    Deno.exit(2);
  }
  const n = await writePreviews();
  console.log(`wrote ${n} previews + index.html to docs/reports/email-previews/`);
}
