import crypto from "crypto";
import { prisma } from "@/lib/prisma";

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

// Replacement order matters: more specific patterns first.
const SKELETON_REPLACEMENTS: Array<[RegExp, string]> = [
  // UPI VPA addresses (user@bank)
  [/\b[\w.+\-]+@[\w.]+\b/gi, "{{VPA}}"],
  // Order IDs: Amazon-style (NNN-NNNNNNN-NNNNNNN)
  [/\b\d{3}-\d{7}-\d{7}\b/g, "{{ORDER_ID}}"],
  // Generic ORDER ID labels
  [/\bORDER[_\s-]?(?:ID|NO)?[:\s]*[A-Z0-9]{6,}\b/gi, "{{ORDER_ID}}"],
  // Transaction reference IDs (TXN/REF/UTR/UPI/RRN prefix + alphanumeric)
  [/\b(?:TXN|REF|UTR|UPI|RRN)[_\s-]?[A-Z0-9]{6,}\b/gi, "{{TXN_ID}}"],
  // Masked account numbers (XX1234, ****1234)
  [/\b(?:XX|x{2,}|\*{2,})\d{4,}\b/gi, "{{ACCOUNT}}"],
  // Account/Acct label followed by masked/partial number
  [/\b(?:Account|Acct|A\/C)[^\w][\w*X]{4,}\b/gi, "{{ACCOUNT}}"],
  // Card last-4 references
  [/\b(?:Card|card)\s+(?:ending|no\.?|number)?\s*\d{4}\b/gi, "{{CARD}}"],
  [/\bending\s+\d{4}\b/gi, "{{CARD}}"],
  // Currency amounts: ₹500, Rs.500, Rs. 1,200.50, INR 3,000
  [/(?:₹|Rs\.?\s*|INR\s*)[\d,]+(?:\.\d{1,2})?/gi, "{{AMOUNT}}"],
  // Plain numbers that look like amounts (4+ digit groups)
  [/\b[\d,]{4,}(?:\.\d{1,2})?\b/g, "{{AMOUNT}}"],
  // Dates: DD/MM/YY, DD-MM-YY, YYYY-MM-DD
  [/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, "{{DATE}}"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "{{DATE}}"],
  // DD Mon YYYY or Mon DD YYYY
  [/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+\d{4}\b/gi, "{{DATE}}"],
  [/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi, "{{DATE}}"],
  // Times: HH:MM or HH:MM:SS
  [/\b\d{2}:\d{2}(?::\d{2})?\b/g, "{{TIME}}"],
];

export function normalizeToSkeleton(text: string): string {
  let result = text;
  for (const [pattern, placeholder] of SKELETON_REPLACEMENTS) {
    result = result.replace(pattern, placeholder);
  }
  // Collapse adjacent identical placeholders (e.g., "{{AMOUNT}} {{AMOUNT}}" → "{{AMOUNT}}")
  result = result.replace(/({{[A-Z_]+}})\s*\1/g, "$1");
  return result;
}

export function templateHash(subject: string, body: string): string {
  const canonical =
    normalizeToSkeleton(canonicalise(subject)) +
    "\n---\n" +
    normalizeToSkeleton(canonicalise(body));
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

// ── deriveExtractors ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const safeRegex = require("safe-regex") as (pattern: string) => boolean;

const PLACEHOLDER_PATTERNS: Record<string, { capture: string; transform: TransformName }> = {
  AMOUNT:           { capture: "[0-9,]+\\.?[0-9]*", transform: "parseAmount" },
  DATE:             { capture: "\\d{1,4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}", transform: "normaliseDate" },
  MERCHANT:         { capture: "[A-Za-z][A-Za-z0-9\\s\\.\\-&']+?", transform: "trimMerchant" },
  VPA:              { capture: "[\\w.@\\-]+", transform: "lowercase" },
  TRANSACTION_TYPE: { capture: "debited|credited", transform: "debitCreditToType" },
};

const FIELD_FOR_PLACEHOLDER: Record<string, string> = {
  AMOUNT: "amount",
  DATE: "date",
  MERCHANT: "merchant",
  VPA: "vpa",
  TRANSACTION_TYPE: "transactionType",
  CURRENCY: "currency",
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anchorContext(
  text: string,
  valueStart: number,
  valueEnd: number
): { left: string; right: string } {
  const left = text.slice(Math.max(0, valueStart - 20), valueStart);
  const right = text.slice(valueEnd, valueEnd + 20);
  return { left, right };
}

export type GeminiAppliedResult = {
  amount: number;
  currency: string;
  date: string;
  transactionType: "expense" | "income";
  merchant?: string;
  vpa?: string;
};

export function deriveExtractors(
  _subject: string,
  body: string,
  bodyTemplate: string,
  _subjectTemplate: string,
  geminiResult: GeminiAppliedResult
): ExtractorMap {
  const extractors: ExtractorMap = {};

  if (geminiResult.currency) {
    extractors.currency = { static: geminiResult.currency.toUpperCase() };
  }

  const placeholderRe = /\{\{([A-Z_]+)\}\}/g;
  let m: RegExpExecArray | null;

  while ((m = placeholderRe.exec(bodyTemplate)) !== null) {
    const phName = m[1];
    if (phName === "CURRENCY") continue;

    const fieldName = FIELD_FOR_PLACEHOLDER[phName];
    if (!fieldName) continue;

    const pattern = PLACEHOLDER_PATTERNS[phName];
    if (!pattern) continue;

    const resolvedValue = geminiResult[fieldName as keyof GeminiAppliedResult];
    if (resolvedValue === undefined || resolvedValue === null) continue;

    // Find where this field's value appears in the body using the capture pattern
    // (so "500" in geminiResult matches "500.00" in body via the amount pattern)
    let valueIdx = -1;
    let matchedLength = 0;
    try {
      const scanRe = new RegExp(pattern.capture, "i");
      const scanMatch = body.match(scanRe);
      if (!scanMatch) continue;
      valueIdx = body.toLowerCase().indexOf(scanMatch[0].toLowerCase());
      matchedLength = scanMatch[0].length;
    } catch {
      continue;
    }
    if (valueIdx === -1) continue;

    const { left, right } = anchorContext(body, valueIdx, valueIdx + matchedLength);
    const regexStr = `${escapeRegex(left)}(${pattern.capture})${escapeRegex(right)}`;

    if (!safeRegex(regexStr)) continue;

    try {
      const re = new RegExp(regexStr, "i");
      const match = body.match(re);
      if (!match?.[1]) continue;
    } catch {
      continue;
    }

    extractors[fieldName] = { regex: regexStr, group: 1, transform: pattern.transform };
  }

  return extractors;
}

// ── Transition helpers ──────────────────────────────────────────────────────

export function shouldPromote(consecutiveSuccesses: number): boolean {
  return consecutiveSuccesses >= 3;
}

export function shouldDegrade(consecutiveFailures: number): boolean {
  return consecutiveFailures >= 2;
}

export function shouldDisableShadow(consecutiveFailures: number): boolean {
  return consecutiveFailures >= 3;
}

// ── DB operations ───────────────────────────────────────────────────────────

export async function preloadTemplates(
  keys: Array<{ userId: string; senderDomain: string; hash: string }>
): Promise<Map<string, ParseTemplateRow>> {
  const map = new Map<string, ParseTemplateRow>();
  if (keys.length === 0) return map;

  const dbMisses: typeof keys = [];
  for (const k of keys) {
    const cacheKey = warmCacheKey(k.userId, k.senderDomain, k.hash);
    const warm = getWarm(cacheKey);
    if (warm) {
      map.set(cacheKey, warm);
    } else {
      dbMisses.push(k);
    }
  }

  if (dbMisses.length === 0) return map;

  const rows = await prisma.parseTemplate.findMany({
    where: {
      OR: dbMisses.map((k) => ({
        userId: k.userId,
        senderDomain: k.senderDomain,
        templateHash: k.hash,
        parserVersion: PARSER_VERSION,
        status: { not: "DISABLED" },
      })),
    },
  });

  for (const row of rows) {
    const cacheKey = warmCacheKey(row.userId, row.senderDomain, row.templateHash);
    const typed: ParseTemplateRow = {
      ...row,
      extractors: row.extractors as ExtractorMap,
    };
    map.set(cacheKey, typed);
    setWarm(cacheKey, typed);
  }

  return map;
}

export async function upsertTemplate(
  userId: string,
  senderDomain: string,
  hash: string,
  subjectTemplate: string,
  bodyTemplate: string,
  extractors: ExtractorMap,
  invocationMap: Map<string, ParseTemplateRow>
): Promise<void> {
  const key = warmCacheKey(userId, senderDomain, hash);
  const row = await prisma.parseTemplate.upsert({
    where: {
      userId_senderDomain_templateHash_parserVersion: {
        userId,
        senderDomain,
        templateHash: hash,
        parserVersion: PARSER_VERSION,
      },
    },
    create: {
      userId,
      senderDomain,
      templateHash: hash,
      parserVersion: PARSER_VERSION,
      status: "SHADOW",
      subjectTemplate,
      bodyTemplate,
      extractors,
    },
    update: {},
  });

  const typed: ParseTemplateRow = { ...row, extractors: row.extractors as ExtractorMap };
  invocationMap.set(key, typed);
  setWarm(key, typed);
}

export async function recordHit(
  templateId: string,
  key: string,
  invocationMap: Map<string, ParseTemplateRow>
): Promise<void> {
  await prisma.parseTemplate.update({
    where: { id: templateId },
    data: { hitCount: { increment: 1 }, consecutiveFailures: 0, lastUsedAt: new Date() },
  });
  evictWarm(key);
  invocationMap.delete(key);
}

export async function recordShadowAgreement(
  templateId: string,
  key: string,
  invocationMap: Map<string, ParseTemplateRow>
): Promise<void> {
  await prisma.parseTemplate.update({
    where: { id: templateId },
    data: {
      consecutiveSuccesses: { increment: 1 },
      consecutiveFailures: 0,
      hitCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });

  await prisma.parseTemplate.updateMany({
    where: {
      id: templateId,
      consecutiveSuccesses: { gte: 3 },
      status: { in: ["SHADOW", "DEGRADED"] },
    },
    data: { status: "ACTIVE", promotedAt: new Date() },
  });

  evictWarm(key);
  invocationMap.delete(key);
}

export async function recordShadowDisagreement(
  templateId: string,
  key: string,
  currentStatus: string,
  invocationMap: Map<string, ParseTemplateRow>
): Promise<void> {
  await prisma.parseTemplate.update({
    where: { id: templateId },
    data: {
      consecutiveSuccesses: 0,
      consecutiveFailures: { increment: 1 },
      failCount: { increment: 1 },
      lastFailedAt: new Date(),
    },
  });

  await prisma.parseTemplate.updateMany({
    where: {
      id: templateId,
      consecutiveFailures: { gte: 3 },
      status: currentStatus,
    },
    data: { status: "DISABLED", disabledReason: "consecutive_shadow_failures" },
  });

  evictWarm(key);
  invocationMap.delete(key);
}

export async function recordActiveFailure(
  templateId: string,
  key: string,
  invocationMap: Map<string, ParseTemplateRow>
): Promise<void> {
  await prisma.parseTemplate.update({
    where: { id: templateId },
    data: {
      failCount: { increment: 1 },
      consecutiveFailures: { increment: 1 },
      lastFailedAt: new Date(),
    },
  });

  await prisma.parseTemplate.updateMany({
    where: { id: templateId, consecutiveFailures: { gte: 2 }, status: "ACTIVE" },
    data: { status: "DEGRADED", consecutiveSuccesses: 0, consecutiveFailures: 0 },
  });

  evictWarm(key);
  invocationMap.delete(key);
}
