// Builds the public-view JSON the quote page renders in mock/fixture mode (site/quote/assets/fixtures/*.json)
// by running the REAL engine (replay Claude -> price -> send -> quote-view shape). Never hand-edit those files.
//   deno run -A --node-modules-dir=none tools/build_quote_fixtures.ts           write
//   deno run -A --node-modules-dir=none tools/build_quote_fixtures.ts --check   exit 1 if the files are stale
import { replayModel } from "../supabase/functions/_shared/claude.ts";
import { BRAND, PRICEBOOK } from "../supabase/functions/_shared/config.ts";
import { acceptQuote, draftQuote, sendQuote, toPublicView } from "../supabase/functions/_shared/quote_engine.ts";
import { MemoryStore, type PayRow } from "../supabase/functions/_shared/store.ts";
import { seed } from "../supabase/functions/_shared/test_util.ts";

const OUT = new URL("../site/quote/assets/fixtures/", import.meta.url);
const SENT = new Date("2026-10-12T15:00:00Z"), NOW = new Date("2026-10-13T15:00:00Z");
// PayPal checkout fixtures: built as if brand.json payments.paypal were on (the repo config keeps it off)
const BRAND_PAYPAL = { ...BRAND, payments: { paypal: { enabled: true, env: "sandbox", client_id: "FIXTURE-ONLY-client-id" } } } as typeof BRAND;

async function build(name: string, opts: { discount?: string; payLink?: string; payMethod?: string; accept?: boolean; expired?: boolean; rush?: boolean;
  depositPaid?: boolean }) {
  const store = new MemoryStore();
  store.clock = () => SENT;
  const { qid } = seed(store, name);
  const d = await draftQuote(qid, { store, model: replayModel(), replayKey: name });
  // admin adds rush and edits the timeline text accordingly (what A7's editor does)
  if (opts.rush) await store.updateQuote(d.id, { items: [...d.items, { code: "ADD-RUSH", qty: 1, kind: "percent" }],
    timeline_text: "Rush delivery: everything is ready about 7 business days after access and content are complete." });
  let q = await sendQuote({ quote_id: d.id, discount_code: opts.discount ?? null, pay_method: opts.payMethod ?? (opts.payLink ? "paypal_link" : "wire"),
    pay_link: opts.payLink ?? null }, store, PRICEBOOK, BRAND_PAYPAL);
  if (opts.accept) await acceptQuote({ token: q.public_token, name: "Mark Ortiz", agree: true, agreement_version: BRAND.agreement_version, ip: "", ua: "" }, store, NOW);
  q = store.quotes.get(q.id)!;
  // the rows pay_record_capture leaves after a PayPal deposit (only their client-safe state reaches the view)
  const pays: PayRow[] = opts.depositPaid ? [
    { kind: "deposit", status: "paid", provider_capture_id: "FIXTURE-CAPTURE", paid_at: NOW.toISOString(), amount_cents: q.deposit_cents ?? 0 },
    { kind: "final", status: "due", provider_capture_id: null, paid_at: null, amount_cents: (q.setup_cents ?? 0) - (q.deposit_cents ?? 0) },
  ] : [];
  const v = toPublicView({ ...q, created_at: SENT.toISOString(), updated_at: SENT.toISOString() }, store.profiles.get(q.user_id!)!,
    opts.expired ? new Date(SENT.getTime() + 20 * 864e5) : NOW, PRICEBOOK, pays);
  return JSON.stringify(v, null, 2) + "\n";
}

const files: Record<string, Promise<string>> = {
  "fixture.json": build("plumber_jobber", { payLink: "https://www.paypal.com/invoice/p/#DEMO-ONLY" }),
  "fixture-bundle.json": build("bndl", { discount: "FOUNDING", rush: true }),
  "fixture-dispatch.json": build("locksmith_after_hours", {}),   // price book v1.1: RCP + ADD-DISPATCH
  "fixture-web.json": build("web_only", {}),
  "fixture-accepted.json": build("plumber_jobber", { accept: true, payLink: "https://www.paypal.com/invoice/p/#DEMO-ONLY" }),
  "fixture-expired.json": build("hvac_basic", { expired: true }),
  // paid through Upwork Direct Contracts (the default rail): accepted, without / with the contract link
  "fixture-upwork.json": build("hvac_basic", { accept: true, payMethod: "upwork" }),
  "fixture-upworklink.json": build("plumber_jobber", { accept: true, payMethod: "upwork", payLink: "https://www.upwork.com/#DEMO-ONLY" }),
  // card / PayPal checkout (shown only while brand.json payments.paypal is on): open, and accepted with the deposit paid
  "fixture-paypal.json": build("hvac_basic", { payMethod: "paypal_checkout" }),
  "fixture-paypalpaid.json": build("plumber_jobber", { accept: true, payMethod: "paypal_checkout", depositPaid: true }),
};
let stale = 0;
for (const [f, p] of Object.entries(files)) {
  const text = await p; // deterministic: fixed clock, no random fields in the public view
  const url = new URL(f, OUT);
  if (Deno.args.includes("--check")) {
    let cur = ""; try { cur = await Deno.readTextFile(url); } catch { /* missing */ }
    if (cur !== text) { console.log(`❌ stale: site/quote/assets/fixtures/${f}`); stale++; }
  } else {
    await Deno.writeTextFile(url, text);
    console.log(`✅ wrote site/quote/assets/fixtures/${f}`);
  }
}
if (Deno.args.includes("--check")) console.log(stale ? `${stale} stale fixture(s)` : "✅ quote fixtures up to date");
Deno.exit(stale ? 1 : 0);
