// Claude's narrative is shown to clients only after Meir approves it, but code still strips what the prompt forbids:
// money amounts, percentages, discounts/free periods, outcome promises and compliance claims. A sentence (or list item)
// that contains one is removed and recorded, so the admin sees what was dropped.

const FORBIDDEN: Array<[string, RegExp]> = [
  ["money", /(?:\$|US\$|USD\s?)\s?\d|\b\d[\d,.]*\s?(?:k\s)?(?:usd|dollars?|bucks)\b/i],
  ["percent", /\d\s?%|\bper\s?cent\b|\bpercent(?:age)?\b/i],
  ["discount", new RegExp([
    String.raw`\bdiscount\w*`, String.raw`\bcoupon`, String.raw`\bpromo(?:tion)?\s?code`, String.raw`\brebate`, String.raw`\bcashback`,
    String.raw`\bcheaper\b`, String.raw`\bon\s+sale\b`, String.raw`\bwaiv\w*`,
    // "first month free", "complimentary setup", "free of charge", "for free" (but not "toll-free" / "feel free to")
    String.raw`\b(?:free|complimentary)\s+(?:of\s+charge|months?|weeks?|trial|setup|install\w*|build|period|upgrade|add-?ons?|extras?)\b`,
    String.raw`\b(?:months?|weeks?|setup|build|install\w*|add-?ons?)\s+(?:is\s+|are\s+)?(?:free|complimentary|on\s+us)\b`,
    String.raw`\b(?:for\s+free|complimentary)\b`,
    String.raw`\bhalf[\s-]+(?:off|price)\b`, String.raw`\d\s?%?\s*off\b`, String.raw`\boff\s+(?:the|your|our)\s+(?:price|setup|build|bill|invoice|fee|cost)`,
    String.raw`\bknock\w*\b[^.!?]*\boff\b`, String.raw`\bon\s+the\s+house\b`, String.raw`\bno\s+(?:extra\s+)?(?:charge|cost)\b`,
    String.raw`\bat\s+no\s+(?:extra\s+)?(?:charge|cost)\b`, String.raw`\bspecial\s+(?:price|deal|offer|rate)\b`,
  ].join("|"), "i")],
  ["promise", /\bguarante\w*|\bnever\s+(?:miss|lose)\b|\bmore\s+(?:jobs|leads|customers|revenue|bookings)\b|\bincrease\s+(?:your\s+)?(?:revenue|sales|bookings)\b|\broi\b/i],
  ["compliance", /\b(?:hipaa|tcpa|ccpa|gdpr|pci)[-\s]?(?:compliant|compliance|certified)\b/i],
  ["payment_terms", /\b(?:net\s?\d+|installments?|payment\s+plan)\b/i],
];

export function violation(text: string): string | null {
  for (const [k, rx] of FORBIDDEN) if (rx.test(text)) return k;
  return null;
}

const SENTENCE = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n|$)/g;

/** Remove offending sentences from a paragraph text. */
export function cleanText(text: string, maxLen: number, removed: string[], field: string): string {
  const keep: string[] = [];
  for (const para of String(text ?? "").replace(/\r/g, "").split(/\n{2,}/)) {
    const parts = para.match(SENTENCE) ?? [];
    const kept = parts.filter((s) => {
      const v = violation(s);
      if (v) removed.push(`${field}:${v}:${s.trim().slice(0, 160)}`);
      return !v;
    }).join("").trim();
    if (kept) keep.push(kept);
  }
  return keep.join("\n\n").slice(0, maxLen);
}

export function cleanList(items: unknown, maxItems: number, maxLen: number, removed: string[], field: string): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const raw of items) {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
    if (!s) continue;
    const v = violation(s);
    if (v) { removed.push(`${field}:${v}:${s.slice(0, 160)}`); continue; }
    if (out.length < maxItems) out.push(s);
  }
  return out;
}
