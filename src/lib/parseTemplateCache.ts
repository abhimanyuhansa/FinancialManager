import crypto from "crypto";

export const PARSER_VERSION = "1";

// ── Types ───────────────────────────────────────────────────────────────────

export type TransformName =
  | "parseAmount"
  | "normaliseDate"
  | "debitCreditToType"
  | "trimMerchant"
  | "lowercase";

export type RegexExtractor = {
  regex: string;
  group: number;
  transform: TransformName;
};

export type StaticExtractor = {
  static: string;
};

export type ExtractorMap = Record<string, RegexExtractor | StaticExtractor>;

export type ParseTemplateRow = {
  id: string;
  userId: string;
  senderDomain: string;
  templateHash: string;
  parserVersion: string;
  status: string;
  subjectTemplate: string;
  bodyTemplate: string;
  extractors: ExtractorMap;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
};

// ── Canonicalise + hash ─────────────────────────────────────────────────────

export function canonicalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function templateHash(subject: string, body: string): string {
  const canonical = canonicalise(subject) + "\n---\n" + canonicalise(body);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── Warm cache (module-level, 5-min TTL) ───────────────────────────────────

type WarmEntry = { template: ParseTemplateRow; cachedAt: number };
const warmCache = new Map<string, WarmEntry>();
const WARM_TTL_MS = 5 * 60 * 1000;

export function warmCacheKey(
  userId: string,
  senderDomain: string,
  hash: string
): string {
  return `${userId}:${senderDomain}:${hash}:${PARSER_VERSION}`;
}

export function getWarm(key: string): ParseTemplateRow | null {
  const entry = warmCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > WARM_TTL_MS) {
    warmCache.delete(key);
    return null;
  }
  return entry.template;
}

export function setWarm(key: string, template: ParseTemplateRow): void {
  warmCache.set(key, { template, cachedAt: Date.now() });
}

export function evictWarm(key: string): void {
  warmCache.delete(key);
}

// ── Transforms ──────────────────────────────────────────────────────────────

function applyTransform(raw: string, transform: TransformName): string | number | null {
  switch (transform) {
    case "parseAmount": {
      const n = parseFloat(raw.replace(/,/g, ""));
      return isNaN(n) || n <= 0 ? null : n;
    }
    case "normaliseDate": {
      const parts = raw.split(/[-/]/);
      if (parts.length !== 3) return null;
      const [a, b, c] = parts;
      if (a.length === 4) return `${a}-${b.padStart(2, "0")}-${c.padStart(2, "0")}`;
      const year = c.length === 2 ? `20${c}` : c;
      return `${year}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`;
    }
    case "debitCreditToType":
      return raw.toLowerCase() === "credited" ? "income" : "expense";
    case "trimMerchant":
      return raw.trim().replace(/\s+/g, " ").toLowerCase();
    case "lowercase":
      return raw.toLowerCase();
    default:
      return raw;
  }
}

// ── ApplyTemplate ───────────────────────────────────────────────────────────

export type AppliedResult = {
  amount: number;
  currency: string;
  date: string;
  transactionType: "expense" | "income";
  merchant?: string;
  vpa?: string;
};

const REQUIRED_FIELDS = ["amount", "currency", "date", "transactionType"] as const;

export function applyTemplate(body: string, extractors: ExtractorMap): AppliedResult | null {
  const out: Record<string, string | number> = {};

  for (const [field, extractor] of Object.entries(extractors)) {
    if ("static" in extractor) {
      out[field] = extractor.static;
      continue;
    }
    const re = new RegExp(extractor.regex, "i");
    const match = body.match(re);
    const raw = match?.[extractor.group];
    if (!raw) {
      if (REQUIRED_FIELDS.includes(field as (typeof REQUIRED_FIELDS)[number])) return null;
      continue;
    }
    const transformed = applyTransform(raw, extractor.transform);
    if (transformed === null) {
      if (REQUIRED_FIELDS.includes(field as (typeof REQUIRED_FIELDS)[number])) return null;
      continue;
    }
    out[field] = transformed;
  }

  for (const f of REQUIRED_FIELDS) {
    if (out[f] === undefined) return null;
  }

  return {
    amount: out.amount as number,
    currency: out.currency as string,
    date: out.date as string,
    transactionType: (out.transactionType === "income" ? "income" : "expense") as "expense" | "income",
    ...(out.merchant !== undefined ? { merchant: out.merchant as string } : {}),
    ...(out.vpa !== undefined ? { vpa: out.vpa as string } : {}),
  };
}

// ── CompareOutputs ──────────────────────────────────────────────────────────

function normMerchant(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function compareOutputs(
  a: AppliedResult & { vpa?: string },
  b: AppliedResult & { vpa?: string }
): boolean {
  if (!a.transactionType || !b.transactionType) return false;
  if (Math.round(a.amount * 100) !== Math.round(b.amount * 100)) return false;
  if (a.currency.toUpperCase() !== b.currency.toUpperCase()) return false;
  const dateA = a.date.slice(0, 10);
  const dateB = b.date.slice(0, 10);
  if (dateA !== dateB) return false;
  if (a.transactionType !== b.transactionType) return false;
  if (a.merchant !== undefined && b.merchant !== undefined) {
    if (normMerchant(a.merchant) !== normMerchant(b.merchant)) return false;
  }
  const aVpa = a.vpa !== undefined;
  const bVpa = b.vpa !== undefined;
  if (aVpa !== bVpa) return false;
  if (aVpa && bVpa && a.vpa!.toLowerCase() !== b.vpa!.toLowerCase()) return false;
  return true;
}
