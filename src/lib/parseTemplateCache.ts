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
