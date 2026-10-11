// A8 email events, fully offline: every template renders (subjects per SPEC §5, no leftovers, escaping, links, dark mode,
// RTL for Meir, CAN-SPAM footer on reminders), sender selection, and the dispatcher against an in-memory outbox with a
// mocked Resend (idempotency, retry/backoff, gating, quiet hours, never twice), the quote-draft task, storage purge,
// and both HTTP handlers. Global fetch is replaced by a thrower: any real network call fails the test.
import { BRAND } from "../config.ts";
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
import { BOUNDARY, T_ACCEPTED, T_ADMIN_ACCEPTED, TEMPLATES } from "./templates.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const B = BRAND as EmailBrand;
const SITE = B.site_url.replace(/\/$/, "");
const NOON_IL = new Date("2026-10-12T09:00:00Z"); // 12:00 owner time (inside Meir's 08–23 window)
const NIGHT_IL = new Date("2026-10-12T00:30:00Z"); // 03:30 owner time
const brandWith = (patch: Record<string, unknown>) => ({ ...structuredClone(B), ...patch }) as EmailBrand;
const HEBREW = /[֐-׿]/;

// ------------------------------------------------------------------ templates
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
  eq(subj("admin_new_quote"), `הצעה חדשה לאישור: Cool Breeze HVAC · RCP · ⁦${usd(q.setup_cents)}⁩`);
  eq(subj("quote_sent"), `Your fixed quote from ${B.name}: ${usd(q.setup_cents)} + ${usd(q.monthly_cents)}/mo`);
  eq(subj("quote_reminder"), "Any questions about your quote?");
  eq(subj(T_ADMIN_ACCEPTED), "✅ Cool Breeze HVAC אישר הצעה, ממתין לתשלום");
  eq(subj("deposit_received"), "Welcome aboard — your setup checklist is ready");
  eq(subj("onboarding_nudge"), "2 steps left to get your receptionist live");
  eq(subj("need_help"), "Cool Breeze HVAC צריך עזרה ב: Connect your calendar");
  eq(subj("ready_to_test"), "Your AI receptionist is ready to test");
  eq(subj("final_payment_due"), "Final payment before go-live");
  eq(subj("went_live"), "You're live 🎉 — what happens now");
  eq(subj("request_update"), 'Request "Add a question about filter size" is now waiting on you');
  eq(subj("monthly_invoice"), `Your ${B.name} monthly invoice`);
  assert(/^Your fixed quote expires on \w+ \d{1,2}, \d{4}$/.test(subj("quote_expiring")), subj("quote_expiring"));
  eq(subj(T_ACCEPTED), "Quote accepted — next step: the deposit");
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
      assert(r.html.includes('lang="he" dir="rtl"') && HEBREW.test(r.subject), `${k}: Hebrew RTL for Meir`);
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
