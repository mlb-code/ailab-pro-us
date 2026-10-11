// Sample render contexts for every A8 template: used by the tests and by the preview script. The quote rows come
// from the real A6 engine (replayed Claude output of fixtures/hvac_basic.json + the price book), not typed by hand.
import { replayModel } from "../claude.ts";
import { BRAND } from "../config.ts";
import { acceptQuote, draftQuote, sendQuote } from "../quote_engine.ts";
import { MemoryStore, type QuoteRow } from "../store.ts";
import { seed } from "../test_util.ts";
import { type EmailCtx, T_ACCEPTED, T_ADMIN_ACCEPTED } from "./templates.ts";

export interface Sample { ctx: EmailCtx; payload?: Record<string, unknown> }

export async function sampleQuote(opts: { payLink?: boolean; accepted?: boolean } = {}): Promise<QuoteRow> {
  const store = new MemoryStore();
  const { qid } = seed(store, "hvac_basic");
  const d = await draftQuote(qid, { store, model: replayModel(), replayKey: "hvac_basic" });
  const s = await sendQuote({ quote_id: d.id, pay_method: "paypal_link", pay_link: opts.payLink ? "https://www.paypal.com/invoice/p/#SAMPLE" : null }, store);
  if (opts.accepted) {
    await acceptQuote({ token: s.public_token, name: "Dani Levin", agree: true, agreement_version: s.agreement_version ?? BRAND.agreement_version,
      ip: "203.0.113.5", ua: "test" }, store);
  }
  return (await store.quoteById(s.id))!;
}

export async function samples(): Promise<Record<string, Sample>> {
  const profile = { full_name: "Dani Levin", company: "Cool Breeze HVAC", email: "dani@example.com", phone: "+17135550100", city: "Houston", state: "TX" };
  const sent = await sampleQuote();
  const draft: QuoteRow = { ...sent, status: "draft", sent_at: null, valid_until: null };
  const accepted = await sampleQuote({ payLink: true, accepted: true });
  const client = { id: "6f1c2a0e-1b7d-4d55-9a51-3c2b9a0e7d11", status: "onboarding", products: ["RCP"], monthly_cents: sent.monthly_cents,
    business_name: "Cool Breeze HVAC", go_live_at: null, next_bill_on: null };
  const left = ["Connect your calendar", "Text messaging registration", "Forward your missed calls"];
  const onboarding = { total: 8, done: 5, left: 3, left_titles: left };
  return {
    lead_capture: { ctx: { to: "dani@example.com", lead: { niche: "home_services", source_page: "/home-services/" } } },
    q_received: { ctx: { to: profile.email, profile, questionnaire: { id: sent.questionnaire_id!, offer: "RCP", niche: "home_services", status: "submitted" } } },
    admin_new_quote: { ctx: { to: "owner@example.com", profile, quote: draft, offer: "RCP", niche: "home_services",
      review: { risk_flags: ["Asks for after-hours emergency dispatch: confirm on-call number"], manual_reasons: [], questions: [] } } },
    quote_sent: { ctx: { to: profile.email, profile, quote: sent, offer: "RCP" } },
    quote_reminder: { ctx: { to: profile.email, profile, quote: sent } },
    quote_expiring: { ctx: { to: profile.email, profile, quote: sent } },
    [T_ACCEPTED]: { ctx: { to: profile.email, profile, quote: accepted } },
    [T_ADMIN_ACCEPTED]: { ctx: { to: "owner@example.com", profile, quote: accepted } },
    deposit_received: { ctx: { to: profile.email, profile, client, onboarding: { total: 8, done: 0, left: 8, left_titles: ["Business hours & time zone", "Services & FAQ", "Who gets lead alerts", "Connect your calendar", "Forward your missed calls"] } } },
    onboarding_nudge: { ctx: { to: profile.email, profile, client, onboarding: { ...onboarding, left: 2, left_titles: left.slice(0, 2) } } },
    need_help: { ctx: { to: "owner@example.com", profile, client, item: { id: "a1", key: "calendar", title: "Connect your calendar", status: "need_help",
      message: "We use Jobber for scheduling, not Google Calendar. Which one should I connect?" } } },
    ready_to_test: { ctx: { to: profile.email, profile, client: { ...client, status: "testing" }, tenant_number: "+17135550142" } },
    final_payment_due: { ctx: { to: profile.email, profile, client: { ...client, status: "testing" },
      final_cents: (sent.setup_cents ?? 0) - (sent.deposit_cents ?? 0) } },
    went_live: { ctx: { to: profile.email, profile, client: { ...client, status: "live" }, tenant_number: "+17135550142" } },
    request_update: { ctx: { to: profile.email, profile, client: { ...client, status: "live" },
      request: { id: "r1", title: "Add a question about filter size", status: "waiting_on_you", admin_reply: "Happy to. Which filter sizes do you stock? Reply with the list and we'll add it." } } },
    monthly_invoice: { ctx: { to: profile.email, profile, client: { ...client, status: "live" } }, payload: { month: "2026-11" } },
  };
}
