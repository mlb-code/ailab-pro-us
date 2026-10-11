// A8 dispatcher core (pure logic; I/O behind EmailDb + Mailer + fetch so tests run offline).
//   runDispatch     claim due outbox rows -> render -> Resend (Idempotency-Key = idem_key) -> complete
//                   (sent | retry with backoff | defer for Meir's quiet hours | failed | skipped)
//   runStoragePurge delete files queued in private.storage_purge_queue through the Storage API
// "Never twice": the outbox key is unique in the DB, a row is completed only while it is 'sending', and Resend
// de-duplicates the same Idempotency-Key, so even a worker that dies after sending cannot cause a second email.
import type { EmailBrand } from "./layout.ts";
import { type Mailer, type OutMail, pickSender } from "./mailer.ts";
import { type EmailCtx, TEMPLATES } from "./templates.ts";

export interface OutboxJob {
  id: number;
  idem_key: string;
  template: string;
  audience: "client" | "admin" | "system";
  entity: string;
  entity_id: string | null;
  attempts: number;
  payload: Record<string, unknown>;
  created_at: string;
  ctx: EmailCtx;
}
export interface EmailSettings { admin_email: string; client_emails_enabled: boolean; admin_emails_enabled: boolean }
export type Outcome =
  | { result: "sent"; provider_id: string }
  | { result: "retry" | "defer"; error?: string; retry_at: Date }
  | { result: "failed" | "skipped"; error: string };

export interface EmailDb {
  claim(kind: "email" | "task", limit: number): Promise<OutboxJob[]>;
  complete(id: number, o: Outcome): Promise<void>;
  settings(): Promise<EmailSettings>;
  recipient(email: string): Promise<{ token: string; unsubscribed: boolean }>;
  unsubscribe(token: string): Promise<boolean>;
  purgeClaim(limit: number): Promise<Array<{ bucket_id: string; name: string }>>;
  purgeDone(bucket: string, names: string[]): Promise<number>;
}

export interface DispatchDeps {
  db: EmailDb;
  mailer: Mailer | null;
  brand: EmailBrand;
  /** https://<ref>.supabase.co (no trailing slash) */
  supabaseUrl: string;
  serviceKey: string;
  now?: () => Date;
  fetchFn?: typeof fetch;
  limit?: number;
}

export const MAX_ATTEMPTS = 6;
/** minutes to wait after attempt n (1-based) failed with a retryable error */
export const BACKOFF_MIN = [1, 5, 30, 120, 720];
const EMAIL_RX = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;

/** Meir gets alerts only 08:00–23:00 owner time (SPEC §10.8). Returns when to send, or null = now is fine. */
export function quietDeferral(now: Date, tz: string, startH = 8, endH = 23): Date | null {
  let h = 12, m = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    h = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
    m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  } catch { return null; }
  const mins = h * 60 + m;
  if (mins >= startH * 60 && mins < endH * 60) return null;
  const wait = (startH * 60 - mins + 1440) % 1440;
  return new Date(now.getTime() + wait * 60_000);
}

const retryOrFail = (job: OutboxJob, now: Date, error: string): Outcome =>
  job.attempts >= MAX_ATTEMPTS
    ? { result: "failed", error: `${error} (gave up after ${job.attempts} attempts)` }
    : { result: "retry", error, retry_at: new Date(now.getTime() + BACKOFF_MIN[Math.min(job.attempts, BACKOFF_MIN.length) - 1] * 60_000) };

export function functionsUrl(supabaseUrl: string) { return `${supabaseUrl.replace(/\/$/, "")}/functions/v1`; }

// ------------------------------------------------------------------ one email
export async function handleEmail(job: OutboxJob, settings: EmailSettings, deps: DispatchDeps): Promise<Outcome> {
  const now = deps.now ? deps.now() : new Date();
  const { brand } = deps;
  const tpl = TEMPLATES[job.template];
  if (!tpl) return { result: "failed", error: "unknown_template" };
  if (job.ctx?.skip) return { result: "skipped", error: job.ctx.skip };

  if (tpl.audience === "admin") {
    if (!settings.admin_emails_enabled) return { result: "skipped", error: "admin_emails_disabled" };
    const later = quietDeferral(now, brand.owner?.timezone || "UTC");
    if (later) return { result: "defer", error: "admin_quiet_hours", retry_at: later };
  }
  const to = String(job.ctx?.to || (tpl.audience === "admin" ? settings.admin_email || brand.owner?.admin_email || "" : "")).trim();
  if (!EMAIL_RX.test(to)) return { result: "skipped", error: "no_recipient" };

  let unsubUrl: string | undefined;
  const headers: Record<string, string> = {};
  if (!tpl.transactional) {
    if (!settings.client_emails_enabled) return { result: "skipped", error: "client_emails_disabled" };
    if (!(brand.physical_address || "").trim()) return { result: "skipped", error: "no_physical_address" };
    const rec = await deps.db.recipient(to);
    if (rec.unsubscribed) return { result: "skipped", error: "unsubscribed" };
    unsubUrl = `${functionsUrl(deps.supabaseUrl)}/email-unsubscribe?u=${encodeURIComponent(rec.token)}`;
    headers["List-Unsubscribe"] = `<${unsubUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  let out;
  try {
    out = tpl.render(job.ctx, { brand, now, unsubUrl, payload: job.payload });
  } catch (e) {
    return { result: "failed", error: `render_error: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` };
  }
  if (!out.subject.trim() || /\{\{|\}\}/.test(out.subject + out.html + out.text) || /\bundefined\b|\bNaN\b/.test(out.subject + out.text)) {
    return { result: "failed", error: "render_incomplete" };
  }
  if (!deps.mailer) return retryOrFail(job, now, "resend_not_configured");

  const mail: OutMail = {
    from: pickSender(brand, tpl.sender), to, subject: out.subject, html: out.html, text: out.text, headers, tag: job.template,
    reply_to: tpl.audience === "admin" ? (job.ctx.profile?.email || brand.senders.reply_to) : brand.senders.reply_to,
  };
  let res = await deps.mailer.send(mail, job.idem_key);
  const fb = (brand.senders.fallback || "").trim();
  if (!res.ok && res.domain && fb && fb !== mail.from) {
    // sending domain not verified yet: same mail from the verified fallback address (own idempotency key)
    res = await deps.mailer.send({ ...mail, from: fb }, `${job.idem_key}:fallback`);
  }
  if (res.ok) return { result: "sent", provider_id: res.id };
  return res.retry ? retryOrFail(job, now, res.error) : { result: "failed", error: res.error };
}

// ------------------------------------------------------------------ system task: draft the quote (A6 quote-draft)
export async function handleTask(job: OutboxJob, deps: DispatchDeps): Promise<Outcome> {
  const now = deps.now ? deps.now() : new Date();
  if (job.template !== "task:draft_quote") return { result: "failed", error: "unknown_task" };
  if (job.ctx?.skip) return { result: "skipped", error: job.ctx.skip };
  if (job.ctx?.has_quote) return { result: "skipped", error: "quote_exists" };
  const qid = job.ctx?.questionnaire?.id ?? job.entity_id;
  const f = deps.fetchFn ?? fetch;
  let r: Response;
  try {
    r = await f(`${functionsUrl(deps.supabaseUrl)}/quote-draft`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ questionnaire_id: qid }),
      signal: AbortSignal.timeout(140_000),
    });
  } catch (e) {
    return retryOrFail(job, now, `quote_draft network: ${e instanceof Error ? e.name : "error"}`);
  }
  let j: Record<string, unknown> = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (r.ok) return { result: "sent", provider_id: String(j.quote_id ?? "") };
  const err = `quote_draft ${r.status}: ${String(j.error ?? "").slice(0, 80)}`;
  return r.status >= 500 || r.status === 429 || r.status === 408 ? retryOrFail(job, now, err) : { result: "failed", error: err };
}

// ------------------------------------------------------------------ batch
export interface DispatchReport { claimed: number; sent: number; retry: number; defer: number; failed: number; skipped: number; tasks: number }

export async function runDispatch(deps: DispatchDeps): Promise<DispatchReport> {
  const rep: DispatchReport = { claimed: 0, sent: 0, retry: 0, defer: 0, failed: 0, skipped: 0, tasks: 0 };
  const settings = await deps.db.settings();
  const tally = (o: Outcome) => { rep[o.result]++; };
  // no RESEND_API_KEY yet: leave emails pending (nothing claimed, no attempt burned); tasks still run
  for (const job of deps.mailer ? await deps.db.claim("email", deps.limit ?? 25) : []) {
    rep.claimed++;
    let o: Outcome;
    try { o = await handleEmail(job, settings, deps); } catch (e) {
      o = retryOrFail(job, deps.now ? deps.now() : new Date(), `dispatch_error: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    }
    await deps.db.complete(job.id, o);
    tally(o);
  }
  // at most one Claude draft per run (each can take a minute); cron runs every minute
  for (const job of await deps.db.claim("task", 1)) {
    rep.claimed++; rep.tasks++;
    let o: Outcome;
    try { o = await handleTask(job, deps); } catch (e) {
      o = retryOrFail(job, deps.now ? deps.now() : new Date(), `task_error: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    }
    await deps.db.complete(job.id, o);
    tally(o);
  }
  return rep;
}

// ------------------------------------------------------------------ storage purge (A1 queue)
export async function runStoragePurge(deps: Pick<DispatchDeps, "db" | "supabaseUrl" | "serviceKey" | "fetchFn">, limit = 500) {
  const f = deps.fetchFn ?? fetch;
  const items = await deps.db.purgeClaim(limit);
  const byBucket = new Map<string, string[]>();
  for (const it of items) byBucket.set(it.bucket_id, [...(byBucket.get(it.bucket_id) ?? []), it.name]);
  let deleted = 0, errors = 0;
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100);
      try {
        const r = await f(`${deps.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}`, {
          method: "DELETE",
          headers: { apikey: deps.serviceKey, Authorization: `Bearer ${deps.serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: chunk }),
          signal: AbortSignal.timeout(30_000),
        });
        await r.body?.cancel();
        // 2xx: deleted (objects that were already gone are simply not listed) -> mark the whole chunk done
        if (r.ok) deleted += await deps.db.purgeDone(bucket, chunk); else errors++;
      } catch { errors++; }
    }
  }
  return { queued: items.length, deleted, errors };
}
