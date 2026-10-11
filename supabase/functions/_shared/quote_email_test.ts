// Quote email: subject per SPEC §5, totals present, brand from config, no template leftovers, ≤ 600 px, escaped input.
import { BRAND, PRICEBOOK } from "./config.ts";
import { replayModel } from "./claude.ts";
import { draftQuote, sendQuote, viewQuote } from "./quote_engine.ts";
import { renderQuoteEmail, usd } from "./quote_email.ts";
import { MemoryStore } from "./store.ts";
import { assert, eq, seed } from "./test_util.ts";

Deno.test("quote_sent email renders html + text from the public view", async () => {
  const store = new MemoryStore();
  const { qid, uid } = seed(store, "bndl");
  store.profiles.get(uid)!.company = "All <Seasons> & Co";
  const d = await draftQuote(qid, { store, model: replayModel(), replayKey: "bndl" });
  const q = await sendQuote({ quote_id: d.id, discount_code: "FOUNDING" }, store);
  const v = await viewQuote(q.public_token, store);
  const m = renderQuoteEmail(v, q.public_token);
  eq(m.subject, `Your fixed quote from ${BRAND.name}: ${usd(q.setup_cents)} + ${usd(q.monthly_cents)}/mo`);
  for (const s of [usd(q.setup_cents), usd(q.deposit_cents), usd(q.monthly_cents) + "/mo", PRICEBOOK.rules.discounts.FOUNDING.label!]) {
    assert(m.html.includes(s) && m.text.includes(s.replace("&minus;", "")), "missing " + s);
  }
  // BNDL carries the satisfaction guarantee (refund_rules.rcp_guarantee), and the deposit rule after it
  eq(v.refund.guarantee, PRICEBOOK.refund_rules.rcp_guarantee.text);
  assert(m.text.includes(PRICEBOOK.refund_rules.rcp_guarantee.text) && m.text.includes(PRICEBOOK.refund_rules.deposit.text), "guarantee + deposit rule in text");
  assert(m.html.includes(`${PRICEBOOK.refund_rules.rcp_guarantee_days}-day satisfaction guarantee`), "guarantee in html");
  assert(m.html.includes(`/quote/#t=${q.public_token}`) && m.text.includes(q.public_token));
  assert(!/\{\{|\}\}|undefined|null|NaN/.test(m.html + m.text), "no template leftovers");
  assert(m.html.includes("All &lt;Seasons&gt; &amp; Co") && !m.html.includes("<Seasons>"), "escaped");
  assert(!/width="(6[1-9]\d|[7-9]\d\d)"/.test(m.html) && m.html.includes('width="600"'), "≤ 600 px");
  assert(m.html.includes('name="color-scheme"') && m.html.includes("prefers-color-scheme: dark"), "dark-mode aware");
  assert(m.html.includes(BRAND.disclaimers.footer));
  await Deno.mkdir(new URL("../../../qa-shots/email/", import.meta.url), { recursive: true });
  await Deno.writeTextFile(new URL("../../../qa-shots/email/quote_sent.html", import.meta.url), m.html);
});
