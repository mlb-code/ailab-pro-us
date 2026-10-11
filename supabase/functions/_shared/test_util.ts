// Tiny assertion helpers (no network imports, so `deno test` runs fully offline).
import { canonical } from "./quote_engine.ts";
import type { MemoryStore } from "./store.ts";

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
export function eq(actual: unknown, expected: unknown, msg = "") {
  const a = canonical(actual), e = canonical(expected);
  if (a !== e) throw new Error(`${msg ? msg + ": " : ""}expected ${e}\n   got ${a}`);
}
export async function rejects(fn: () => Promise<unknown>, code: string) {
  try { await fn(); } catch (e) {
    const c = (e as { code?: string }).code ?? (e as Error).message;
    if (!String(c).includes(code)) throw new Error(`expected error "${code}", got "${c}"`);
    return;
  }
  throw new Error(`expected error "${code}", but it resolved`);
}

/** Load fixtures/<name>.json into a MemoryStore as a submitted questionnaire + profile. */
export function seed(store: MemoryStore, name: string) {
  const fx = JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
  const uid = crypto.randomUUID(), qid = crypto.randomUUID();
  store.profiles.set(uid, { id: uid, email: `${name}@example.com`, is_admin: false, ...fx.profile });
  store.questionnaires.set(qid, { id: qid, user_id: uid, submitted_at: new Date().toISOString(), ...fx.questionnaire });
  return { uid, qid };
}
