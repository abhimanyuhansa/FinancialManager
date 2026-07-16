// src/lib/llm/sanitize.ts
// Minimizes PII in email bodies before sending to external LLM providers.
// Preserves all fields needed for transaction extraction (amounts, dates,
// merchants, VPAs, transaction types) while tokenizing fields that are not
// required (full card numbers, account numbers, personal salutations).

type TokenReplacer = [RegExp, string | ((match: string, ...args: string[]) => string)];

function shortToken(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-4).toUpperCase().padStart(4, "0");
}

const TOKENIZE_REPLACEMENTS: TokenReplacer[] = [
  // Full card numbers: 16 digits with optional spaces/dashes
  [
    /\b(\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4})\b/g,
    (m: string) => `[CARD-${shortToken(m)}]`,
  ],
  // Masked account numbers: XX1234, ****1234
  [
    /\b(?:XX|x{2,}|\*{4,})\d{4,}\b/gi,
    (m: string) => `[ACCT-${shortToken(m)}]`,
  ],
  // "Account/Acct No. XXXX1234" patterns
  [
    /\b(?:Account|Acct|A\/C)(?:\s+No\.?)?\s+([X*\d]{6,})\b/gi,
    (_m: string, acct: string) => `[ACCT-${shortToken(acct)}]`,
  ],
  // Personal salutations: "Dear John Smith," — replace name, keep "Dear Customer,"
  [
    /\bDear\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2},/g,
    "Dear Customer,",
  ],
];

export function sanitizeEmailForLlm(body: string): string {
  if (!body) return body;
  let result = body;
  for (const [pattern, replacer] of TOKENIZE_REPLACEMENTS) {
    if (typeof replacer === "string") {
      result = result.replace(pattern, replacer);
    } else {
      result = result.replace(pattern, replacer as (...args: unknown[]) => string);
    }
  }
  return result;
}
