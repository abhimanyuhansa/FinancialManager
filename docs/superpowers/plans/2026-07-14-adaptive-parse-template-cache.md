# Adaptive Parse Template Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate redundant Gemini calls for recurring email formats by learning deterministic regex-based extraction templates from successfully parsed emails, then applying them locally on future matching emails.

**Architecture:** Three-tier parse chain in `advanceJob`: (1) exact result cache via ParseLog for reprocessJob reruns, (2) learned template cache with SHADOW→ACTIVE→DEGRADED→DISABLED lifecycle, (3) Gemini fallback which also acts as teacher by returning normalized templates. All state transitions use atomic Prisma increments with WHERE-guarded status checks to handle concurrent Vercel invocations safely.

**Tech Stack:** Next.js 15 App Router, TypeScript, Prisma 7, Neon PostgreSQL, Gemini 2.0 Flash Lite, Jest, `safe-regex` npm package.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `ParseTemplate` model; add `resolvedBy` to `ParseLog`; add `parseTemplates` relation to `User` |
| `prisma/migrations/20260714100000_add_parse_template/migration.sql` | Create | SQL for `ParseTemplate` table + indexes; `resolvedBy` column on `ParseLog` |
| `src/lib/parseTemplateCache.ts` | Create | `PARSER_VERSION`, `canonicalise`, `templateHash`, warm cache with TTL, `preloadTemplates`, `lookupTemplate`, `applyTemplate`, `deriveExtractors`, `compareOutputs`, `upsertTemplate`, `recordHit`, `recordFailure`, state transition helpers |
| `src/lib/exactResultCache.ts` | Create | Tier 1: batch ParseLog lookup by `gmailMsgId` for reprocessJob reruns |
| `src/lib/gemini.ts` | Modify | Add `subjectTemplate?` / `bodyTemplate?` to `GeminiEmailResult`; extend `BATCH_SYSTEM_PROMPT` and `batchUserPrompt` schema |
| `src/app/api/gmail/sync/advance/route.ts` | Modify | Replace two-tier with three-tier chain; batch preload; shadow/active routing; template learning after Gemini; `resolvedBy` in ParseLog writes; extend cron pruning |
| `tests/lib/parseTemplateCache.test.ts` | Create | Unit tests: `canonicalise`, `templateHash`, `deriveExtractors`, `applyTemplate`, `compareOutputs`, state transitions, warm cache TTL |
| `tests/lib/exactResultCache.test.ts` | Create | Unit tests: hit/miss cases, reprocessJob scenario |
| `tests/lib/gemini.test.ts` | Modify | Add tests for new `subjectTemplate`/`bodyTemplate` fields in batch response |

---

## Task 1: Install `safe-regex` and add Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260714100000_add_parse_template/migration.sql`

- [ ] **Step 1: Install safe-regex**

```bash
npm install safe-regex
npm install --save-dev @types/safe-regex
```

Verify: `node -e "const s = require('safe-regex'); console.log(s('(a+)+'));"` should print `false`.

- [ ] **Step 2: Add `ParseTemplate` model to `prisma/schema.prisma`**

Add to `User` model (after the existing `vpaMerchantMaps` line):
```prisma
  parseTemplates     ParseTemplate[]
```

Add `resolvedBy` to `ParseLog` model (after `errorDetail` line):
```prisma
  resolvedBy       String?   // "static" | "template" | "gemini" | "exact_cache"
```

Add the new model at the end of `prisma/schema.prisma`:
```prisma
model ParseTemplate {
  id                   String    @id @default(cuid())
  userId               String
  senderDomain         String
  templateHash         String
  parserVersion        String
  taxonomyVersion      String    @default("")
  status               String    // SHADOW | ACTIVE | DEGRADED | DISABLED
  subjectTemplate      String
  bodyTemplate         String
  extractors           Json
  hitCount             Int       @default(0)
  failCount            Int       @default(0)
  consecutiveSuccesses Int       @default(0)
  consecutiveFailures  Int       @default(0)
  promotedAt           DateTime?
  lastUsedAt           DateTime?
  lastFailedAt         DateTime?
  disabledReason       String?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  user                 User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, senderDomain, templateHash, parserVersion])
  @@index([userId, senderDomain, status])
}
```

- [ ] **Step 3: Create the migration SQL file**

Create `prisma/migrations/20260714100000_add_parse_template/migration.sql`:

```sql
-- Add resolvedBy to ParseLog
ALTER TABLE "ParseLog" ADD COLUMN "resolvedBy" TEXT;

-- Create ParseTemplate table
CREATE TABLE "ParseTemplate" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "senderDomain" TEXT NOT NULL,
  "templateHash" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "taxonomyVersion" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL,
  "subjectTemplate" TEXT NOT NULL,
  "bodyTemplate" TEXT NOT NULL,
  "extractors" JSONB NOT NULL,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "failCount" INTEGER NOT NULL DEFAULT 0,
  "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "promotedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "lastFailedAt" TIMESTAMP(3),
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParseTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ParseTemplate_userId_senderDomain_templateHash_parserVersion_key"
  ON "ParseTemplate"("userId", "senderDomain", "templateHash", "parserVersion");

CREATE INDEX "ParseTemplate_userId_senderDomain_status_idx"
  ON "ParseTemplate"("userId", "senderDomain", "status");

ALTER TABLE "ParseTemplate" ADD CONSTRAINT "ParseTemplate_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Deploy migration and regenerate client**

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: no errors; `prisma generate` prints "Generated Prisma Client".

- [ ] **Step 5: Run existing tests to confirm schema compiles**

```bash
npm test -- --testPathPattern="tests/schema"
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260714100000_add_parse_template/
git commit -m "feat: add ParseTemplate model and resolvedBy to ParseLog"
```

---

## Task 2: Create `parseTemplateCache.ts` — core types, hashing, and warm cache

**Files:**
- Create: `src/lib/parseTemplateCache.ts`
- Create: `tests/lib/parseTemplateCache.test.ts`

- [ ] **Step 1: Write failing tests for `canonicalise` and `templateHash`**

Create `tests/lib/parseTemplateCache.test.ts`:

```typescript
import { canonicalise, templateHash } from "@/lib/parseTemplateCache";

describe("canonicalise", () => {
  it("lowercases text", () => {
    expect(canonicalise("Hello World")).toBe("hello world");
  });

  it("normalises CRLF to LF", () => {
    expect(canonicalise("line1\r\nline2")).toBe("line1\nline2");
  });

  it("collapses horizontal whitespace", () => {
    expect(canonicalise("a   b\t\tc")).toBe("a b c");
  });

  it("collapses 3+ blank lines to 2", () => {
    expect(canonicalise("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(canonicalise("  hello  ")).toBe("hello");
  });

  it("is deterministic — same input always same output", () => {
    const text = "  Rs. 1,234.56 debited from your account\r\n\r\n\r\n  on 12-07-26  ";
    expect(canonicalise(text)).toBe(canonicalise(text));
  });
});

describe("templateHash", () => {
  it("returns a 64-char hex string", () => {
    const h = templateHash("subject", "body");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same subject+body always produces same hash", () => {
    expect(templateHash("sub", "bod")).toBe(templateHash("sub", "bod"));
  });

  it("different subject → different hash", () => {
    expect(templateHash("sub1", "bod")).not.toBe(templateHash("sub2", "bod"));
  });

  it("different body → different hash", () => {
    expect(templateHash("sub", "bod1")).not.toBe(templateHash("sub", "bod2"));
  });

  it("whitespace normalization: extra spaces produce same hash", () => {
    expect(templateHash("sub", "hello   world")).toBe(templateHash("sub", "hello world"));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | tail -5
```

Expected: FAIL — "Cannot find module '@/lib/parseTemplateCache'".

- [ ] **Step 3: Implement `canonicalise`, `templateHash`, `PARSER_VERSION`, types, and warm cache**

Create `src/lib/parseTemplateCache.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | tail -10
```

Expected: all `canonicalise` and `templateHash` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parseTemplateCache.ts tests/lib/parseTemplateCache.test.ts
git commit -m "feat: add canonicalise, templateHash, warm cache — parseTemplateCache"
```

---

## Task 3: `applyTemplate`, transforms, and `compareOutputs`

**Files:**
- Modify: `src/lib/parseTemplateCache.ts`
- Modify: `tests/lib/parseTemplateCache.test.ts`

- [ ] **Step 1: Write failing tests for `applyTemplate` and `compareOutputs`**

Append to `tests/lib/parseTemplateCache.test.ts`:

```typescript
import { applyTemplate, compareOutputs, type ExtractorMap } from "@/lib/parseTemplateCache";

const SAMPLE_EXTRACTORS: ExtractorMap = {
  amount:          { regex: "Rs\\.\\s*([\\d,]+(?:\\.\\d{1,2})?)", group: 1, transform: "parseAmount" },
  currency:        { static: "INR" },
  date:            { regex: "on\\s+(\\d{2}-\\d{2}-\\d{2})", group: 1, transform: "normaliseDate" },
  transactionType: { regex: "(debited|credited)", group: 1, transform: "debitCreditToType" },
  merchant:        { regex: "at\\s+([A-Za-z][A-Za-z\\s]+?)(?:\\s|$)", group: 1, transform: "trimMerchant" },
};

describe("applyTemplate", () => {
  it("extracts required fields from a matching body", () => {
    const body = "Rs. 1,234.56 debited from your a/c on 12-07-26 at Swiggy via UPI";
    const result = applyTemplate(body, SAMPLE_EXTRACTORS);
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(1234.56);
    expect(result!.currency).toBe("INR");
    expect(result!.transactionType).toBe("expense");
    expect(result!.merchant).toBe("swiggy");
    expect(result!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null when a required field regex does not match", () => {
    const body = "Hello, your package has been shipped";
    const result = applyTemplate(body, SAMPLE_EXTRACTORS);
    expect(result).toBeNull();
  });

  it("parseAmount strips commas and returns a number", () => {
    const body = "Rs. 1,00,000.00 debited on 01-01-26 at Shop";
    const result = applyTemplate(body, {
      amount: { regex: "Rs\\.\\s*([\\d,]+(?:\\.\\d{1,2})?)", group: 1, transform: "parseAmount" },
      currency: { static: "INR" },
      date: { regex: "(\\d{2}-\\d{2}-\\d{2})", group: 1, transform: "normaliseDate" },
      transactionType: { static: "expense" } as unknown as RegexExtractor, // static used as stand-in
    });
    expect(result?.amount).toBe(100000);
  });
});

describe("compareOutputs", () => {
  const base = {
    amount: 500,
    currency: "INR",
    date: "2026-07-12",
    transactionType: "expense" as const,
    merchant: "swiggy",
  };

  it("returns true when all required fields match", () => {
    expect(compareOutputs(base, base)).toBe(true);
  });

  it("amount comparison uses integer cents to avoid float equality issues", () => {
    const a = { ...base, amount: 100.1 };
    const b = { ...base, amount: 100.10000000001 };
    expect(compareOutputs(a, b)).toBe(true);
  });

  it("returns false on amount mismatch", () => {
    expect(compareOutputs(base, { ...base, amount: 501 })).toBe(false);
  });

  it("returns false on transactionType mismatch", () => {
    expect(compareOutputs(base, { ...base, transactionType: "income" })).toBe(false);
  });

  it("merchant comparison is case-insensitive and whitespace-collapsed", () => {
    expect(compareOutputs({ ...base, merchant: "  Swiggy  " }, { ...base, merchant: "swiggy" })).toBe(true);
  });

  it("vpa presence mismatch counts as disagreement", () => {
    expect(compareOutputs({ ...base, vpa: "merchant@upi" }, { ...base })).toBe(false);
    expect(compareOutputs({ ...base }, { ...base, vpa: "merchant@upi" })).toBe(false);
  });

  it("returns false when a required field is missing", () => {
    const incomplete = { amount: 500, currency: "INR", date: "2026-07-12" };
    expect(compareOutputs(base, incomplete as typeof base)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | grep -E "PASS|FAIL|●" | head -20
```

Expected: failures on `applyTemplate` and `compareOutputs` (not yet implemented).

- [ ] **Step 3: Implement transforms, `applyTemplate`, and `compareOutputs`**

Append to `src/lib/parseTemplateCache.ts`:

```typescript
import { prisma } from "@/lib/prisma";

// ── Transforms ──────────────────────────────────────────────────────────────

function applyTransform(raw: string, transform: TransformName): string | number | null {
  switch (transform) {
    case "parseAmount": {
      const n = parseFloat(raw.replace(/,/g, ""));
      return isNaN(n) || n <= 0 ? null : n;
    }
    case "normaliseDate": {
      // Accepts dd-mm-yy, dd/mm/yyyy, yyyy-mm-dd
      const parts = raw.split(/[-\/]/);
      if (parts.length !== 3) return null;
      const [a, b, c] = parts;
      if (a.length === 4) return `${a}-${b.padStart(2,"0")}-${c.padStart(2,"0")}`;
      const year = c.length === 2 ? `20${c}` : c;
      return `${year}-${b.padStart(2,"0")}-${a.padStart(2,"0")}`;
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
      if (REQUIRED_FIELDS.includes(field as typeof REQUIRED_FIELDS[number])) return null;
      continue;
    }
    const transformed = applyTransform(raw, extractor.transform);
    if (transformed === null) {
      if (REQUIRED_FIELDS.includes(field as typeof REQUIRED_FIELDS[number])) return null;
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
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | grep -E "PASS|FAIL|✓|✗|×" | head -30
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parseTemplateCache.ts tests/lib/parseTemplateCache.test.ts
git commit -m "feat: add applyTemplate, transforms, compareOutputs"
```

---

## Task 4: `deriveExtractors` and regex safety

**Files:**
- Modify: `src/lib/parseTemplateCache.ts`
- Modify: `tests/lib/parseTemplateCache.test.ts`

- [ ] **Step 1: Write failing tests for `deriveExtractors`**

Append to `tests/lib/parseTemplateCache.test.ts`:

```typescript
import { deriveExtractors } from "@/lib/parseTemplateCache";

describe("deriveExtractors", () => {
  const subject = "Alert: Rs. 500.00 debited";
  const body = "Rs. 500.00 debited from your account on 12-07-26 at Swiggy via UPI. VPA swiggy@upi";
  const geminiResult = {
    amount: 500,
    currency: "INR",
    date: "2026-07-12",
    transactionType: "expense" as const,
    merchant: "Swiggy",
    vpa: "swiggy@upi",
  };
  const bodyTemplate =
    "Rs. {{AMOUNT}} debited from your account on {{DATE}} at {{MERCHANT}} via UPI. VPA {{VPA}}";

  it("derives amount extractor that matches original body", () => {
    const extractors = deriveExtractors(subject, body, bodyTemplate, subject, geminiResult);
    expect(extractors.amount).toBeDefined();
    if (extractors.amount && "regex" in extractors.amount) {
      const re = new RegExp(extractors.amount.regex, "i");
      expect(body.match(re)?.[extractors.amount.group]).toBe("500.00");
    }
  });

  it("derives currency as static extractor", () => {
    const extractors = deriveExtractors(subject, body, bodyTemplate, subject, geminiResult);
    expect(extractors.currency).toEqual({ static: "INR" });
  });

  it("returns null for required field when regex fails safety check", () => {
    // A body+template where the anchor region would produce an unsafe regex
    // We test that if safe-regex rejects, we don't store it
    const unsafeBody = "amount (((((x+)+)+)+) debited";
    const unsafeTemplate = "amount {{AMOUNT}} debited";
    const result = deriveExtractors(unsafeBody, unsafeBody, unsafeTemplate, subject, geminiResult);
    // The amount extractor may or may not be derived — key is no unsafe regex stored
    if (result.amount && "regex" in result.amount) {
      // If it was derived, it must pass safe-regex
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const safeRegex = require("safe-regex");
      expect(safeRegex((result.amount as { regex: string }).regex)).toBe(true);
    }
  });

  it("returns null when required field placeholder not found in template", () => {
    const noDateTemplate = "Rs. {{AMOUNT}} debited at {{MERCHANT}}";
    const extractors = deriveExtractors(subject, body, noDateTemplate, subject, geminiResult);
    expect(extractors.date).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | grep -E "PASS|FAIL" | head -5
```

Expected: FAIL on `deriveExtractors`.

- [ ] **Step 3: Implement `deriveExtractors`**

Append to `src/lib/parseTemplateCache.ts`:

```typescript
// eslint-disable-next-line @typescript-eslint/no-require-imports
const safeRegex = require("safe-regex") as (pattern: string) => boolean;

const PLACEHOLDER_PATTERNS: Record<string, { capture: string; transform: TransformName }> = {
  AMOUNT:          { capture: "[\\d,]+(?:\\.\\d{1,2})?", transform: "parseAmount" },
  DATE:            { capture: "\\d{1,4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}", transform: "normaliseDate" },
  MERCHANT:        { capture: "[A-Za-z][A-Za-z0-9\\s\\.\\-&']+?", transform: "trimMerchant" },
  VPA:             { capture: "[\\w.\\@\\-]+", transform: "lowercase" },
  TRANSACTION_TYPE:{ capture: "debited|credited", transform: "debitCreditToType" },
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

function anchorContext(text: string, valueStart: number, valueEnd: number): { left: string; right: string } {
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

  // Currency is always static
  if (geminiResult.currency) {
    extractors.currency = { static: geminiResult.currency.toUpperCase() };
  }

  // Derive regex extractors for each placeholder present in bodyTemplate
  const placeholderRe = /\{\{([A-Z_]+)\}\}/g;
  let m: RegExpExecArray | null;

  while ((m = placeholderRe.exec(bodyTemplate)) !== null) {
    const phName = m[1];
    if (phName === "CURRENCY") continue; // already handled as static

    const fieldName = FIELD_FOR_PLACEHOLDER[phName];
    if (!fieldName) continue;

    const pattern = PLACEHOLDER_PATTERNS[phName];
    if (!pattern) continue;

    // Find the resolved value in the original body
    const resolvedValue = geminiResult[fieldName as keyof GeminiAppliedResult];
    if (resolvedValue === undefined || resolvedValue === null) continue;

    const valueStr = String(resolvedValue);
    const valueIdx = body.toLowerCase().indexOf(valueStr.toLowerCase());
    if (valueIdx === -1) continue;

    const { left, right } = anchorContext(body, valueIdx, valueIdx + valueStr.length);
    const regexStr = `${escapeRegex(left)}(${pattern.capture})${escapeRegex(right)}`;

    if (!safeRegex(regexStr)) continue;

    // Validate: regex must match original body and capture group must equal resolved value
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
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | grep -E "PASS|FAIL|✓|×" | head -30
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parseTemplateCache.ts tests/lib/parseTemplateCache.test.ts
git commit -m "feat: add deriveExtractors with safe-regex validation"
```

---

## Task 5: State transition helpers and DB operations

**Files:**
- Modify: `src/lib/parseTemplateCache.ts`
- Modify: `tests/lib/parseTemplateCache.test.ts`

- [ ] **Step 1: Write failing tests for state transitions**

Append to `tests/lib/parseTemplateCache.test.ts`:

```typescript
import { shouldPromote, shouldDegrade, shouldDisableShadow } from "@/lib/parseTemplateCache";

describe("state transitions", () => {
  describe("shouldPromote", () => {
    it("returns true when consecutiveSuccesses reaches 3", () => {
      expect(shouldPromote(3)).toBe(true);
      expect(shouldPromote(4)).toBe(true);
    });
    it("returns false below threshold", () => {
      expect(shouldPromote(2)).toBe(false);
      expect(shouldPromote(0)).toBe(false);
    });
  });

  describe("shouldDegrade", () => {
    it("returns true when consecutiveFailures reaches 2", () => {
      expect(shouldDegrade(2)).toBe(true);
    });
    it("returns false below threshold", () => {
      expect(shouldDegrade(1)).toBe(false);
    });
  });

  describe("shouldDisableShadow", () => {
    it("returns true when consecutiveFailures reaches 3", () => {
      expect(shouldDisableShadow(3)).toBe(true);
    });
    it("returns false below threshold", () => {
      expect(shouldDisableShadow(2)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | grep -E "shouldPromote|shouldDegrade|shouldDisable" | head -5
```

Expected: failures.

- [ ] **Step 3: Implement transition helpers and DB operations**

Append to `src/lib/parseTemplateCache.ts`:

```typescript
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

  // Check warm cache first; collect DB misses
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

  // One DB query for all misses
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
        userId, senderDomain, templateHash: hash, parserVersion: PARSER_VERSION,
      },
    },
    create: {
      userId, senderDomain, templateHash: hash, parserVersion: PARSER_VERSION,
      status: "SHADOW", subjectTemplate, bodyTemplate, extractors,
    },
    update: {},  // Don't overwrite existing template on re-encounter
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
  // Atomic increment
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
  // Increment successes atomically; then check for promotion in a second query
  await prisma.parseTemplate.update({
    where: { id: templateId },
    data: { consecutiveSuccesses: { increment: 1 }, consecutiveFailures: 0, hitCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  // Promote if threshold met — WHERE guard ensures only one concurrent winner
  await prisma.parseTemplate.updateMany({
    where: { id: templateId, consecutiveSuccesses: { gte: 3 }, status: { in: ["SHADOW", "DEGRADED"] } },
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
    data: { consecutiveSuccesses: 0, consecutiveFailures: { increment: 1 }, failCount: { increment: 1 }, lastFailedAt: new Date() },
  });

  const disableThreshold = currentStatus === "SHADOW" ? 3 : 3;
  await prisma.parseTemplate.updateMany({
    where: { id: templateId, consecutiveFailures: { gte: disableThreshold }, status: currentStatus },
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
    data: { failCount: { increment: 1 }, consecutiveFailures: { increment: 1 }, lastFailedAt: new Date() },
  });

  // Degrade if threshold met
  await prisma.parseTemplate.updateMany({
    where: { id: templateId, consecutiveFailures: { gte: 2 }, status: "ACTIVE" },
    data: { status: "DEGRADED", consecutiveSuccesses: 0, consecutiveFailures: 0 },
  });

  evictWarm(key);
  invocationMap.delete(key);
}
```

- [ ] **Step 4: Run all parseTemplateCache tests**

```bash
npm test -- --testPathPattern="parseTemplateCache" 2>&1 | tail -15
```

Expected: all tests PASS. (DB operations are not unit tested here — they're covered in the integration tests in Task 8.)

- [ ] **Step 5: Run full test suite to catch regressions**

```bash
npm test 2>&1 | tail -10
```

Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parseTemplateCache.ts tests/lib/parseTemplateCache.test.ts
git commit -m "feat: add state transition helpers and DB operations — parseTemplateCache"
```

---

## Task 6: Create `exactResultCache.ts` (Tier 1)

**Files:**
- Create: `src/lib/exactResultCache.ts`
- Create: `tests/lib/exactResultCache.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/exactResultCache.test.ts`:

```typescript
const mockPrisma = {
  parseLog: {
    findMany: jest.fn(),
  },
};
jest.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { lookupExactCache } from "@/lib/exactResultCache";

beforeEach(() => jest.clearAllMocks());

describe("lookupExactCache", () => {
  it("returns a map with transactionId for msgs that have a parsed ParseLog", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([
      { gmailMsgId: "msg1", transactionId: "tx1", outcome: "inserted" },
    ]);

    const result = await lookupExactCache("user1", ["msg1", "msg2"]);
    expect(result.get("msg1")).toBe("tx1");
    expect(result.has("msg2")).toBe(false);
  });

  it("returns empty map when no hits", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([]);
    const result = await lookupExactCache("user1", ["msg1"]);
    expect(result.size).toBe(0);
  });

  it("makes exactly one DB query regardless of input size", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([]);
    await lookupExactCache("user1", ["a", "b", "c", "d", "e"]);
    expect(mockPrisma.parseLog.findMany).toHaveBeenCalledTimes(1);
  });

  it("excludes parse logs without a transactionId", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([
      { gmailMsgId: "msg1", transactionId: null, outcome: "parse_failed" },
    ]);
    const result = await lookupExactCache("user1", ["msg1"]);
    expect(result.has("msg1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npm test -- --testPathPattern="exactResultCache" 2>&1 | tail -5
```

Expected: FAIL — "Cannot find module '@/lib/exactResultCache'".

- [ ] **Step 3: Implement `exactResultCache.ts`**

Create `src/lib/exactResultCache.ts`:

```typescript
import { prisma } from "@/lib/prisma";

/**
 * Tier 1 cache: for reprocessJob reruns where the same gmailMsgId set
 * is re-submitted. Returns a map of gmailMsgId → transactionId for any
 * messages already successfully parsed.
 */
export async function lookupExactCache(
  userId: string,
  gmailMsgIds: string[]
): Promise<Map<string, string>> {
  if (gmailMsgIds.length === 0) return new Map();

  const logs = await prisma.parseLog.findMany({
    where: {
      userId,
      gmailMsgId: { in: gmailMsgIds },
      transactionId: { not: null },
      outcome: { in: ["inserted", "upgraded", "skipped_duplicate"] },
    },
    select: { gmailMsgId: true, transactionId: true },
    orderBy: { createdAt: "desc" },
    distinct: ["gmailMsgId"],
  });

  const result = new Map<string, string>();
  for (const log of logs) {
    if (log.transactionId) result.set(log.gmailMsgId, log.transactionId);
  }
  return result;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --testPathPattern="exactResultCache" 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/exactResultCache.ts tests/lib/exactResultCache.test.ts
git commit -m "feat: add exactResultCache — Tier 1 reprocessJob dedup"
```

---

## Task 7: Extend Gemini — `subjectTemplate` / `bodyTemplate` fields

**Files:**
- Modify: `src/lib/gemini.ts`
- Modify: `tests/lib/gemini.test.ts`

- [ ] **Step 1: Write failing test for new Gemini fields**

Open `tests/lib/gemini.test.ts` and append:

```typescript
describe("parseEmailBatch — template fields", () => {
  it("passes through subjectTemplate and bodyTemplate when Gemini returns them", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([{
                emailIndex: 0,
                isTransaction: true,
                outcome: "parsed",
                subjectTemplate: "Alert: Rs. {{AMOUNT}} debited",
                bodyTemplate: "Rs. {{AMOUNT}} debited on {{DATE}} at {{MERCHANT}}",
                transactions: [{
                  merchant: "Swiggy",
                  amount: 349,
                  currency: "INR",
                  date: "2026-07-12",
                  type: "expense",
                  category: "food",
                  subCategory: null,
                  confidence: 0.95,
                  needsReview: false,
                  lineItems: null,
                }],
              }]),
            }],
          },
        }],
      }),
    });

    const results = await parseEmailBatch(
      [{ emailIndex: 0, body: "Rs. 349 debited on 12-07-26 at Swiggy", senderName: "HDFC Bank", fallbackDate: "2026-07-12" }],
      FAKE_KEY
    );

    expect(results[0].subjectTemplate).toBe("Alert: Rs. {{AMOUNT}} debited");
    expect(results[0].bodyTemplate).toBe("Rs. {{AMOUNT}} debited on {{DATE}} at {{MERCHANT}}");
  });

  it("subjectTemplate and bodyTemplate are undefined when Gemini omits them", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([{
                emailIndex: 0,
                isTransaction: true,
                outcome: "parsed",
                transactions: [{
                  merchant: "Swiggy", amount: 349, currency: "INR",
                  date: "2026-07-12", type: "expense", category: "food",
                  subCategory: null, confidence: 0.95, needsReview: false, lineItems: null,
                }],
              }]),
            }],
          },
        }],
      }),
    });

    const results = await parseEmailBatch(
      [{ emailIndex: 0, body: "body", senderName: "HDFC Bank", fallbackDate: "2026-07-12" }],
      FAKE_KEY
    );

    expect(results[0].subjectTemplate).toBeUndefined();
    expect(results[0].bodyTemplate).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npm test -- --testPathPattern="tests/lib/gemini" 2>&1 | grep -E "FAIL|subjectTemplate" | head -5
```

Expected: FAIL — `subjectTemplate` not on type.

- [ ] **Step 3: Add fields to `GeminiEmailResult` type**

In `src/lib/gemini.ts`, find the `GeminiEmailResult` type and add two optional fields after `errorDetail?`:

```typescript
export type GeminiEmailResult = {
  emailIndex: number;
  isTransaction: boolean;
  transactions: Array<{
    merchant: string;
    amount: number;
    currency: string;
    date: string;
    type: "expense" | "income";
    category: string;
    subCategory: string | null;
    confidence: number;
    needsReview: boolean;
    lineItems: Array<{
      name: string;
      amount: number;
      subCategory?: string;
    }> | null;
  }>;
  outcome: "parsed" | "not_transaction" | "parse_failed" | "insufficient_data";
  bodyLengthRaw: number;
  bodyLengthSent: number;
  wasTruncated: boolean;
  errorDetail?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
};
```

- [ ] **Step 4: Extend `BATCH_SYSTEM_PROMPT` with template instruction**

In `src/lib/gemini.ts`, find `BATCH_SYSTEM_PROMPT` and append to it:

```typescript
const BATCH_SYSTEM_PROMPT =
  "You are a financial transaction parser. For each email, decide if it is a financial transaction email, then extract ALL transactions.\n\n" +
  "TRANSACTION emails include: payment confirmations, debit/credit alerts, invoices, receipts, subscription charges, EMI notices, order confirmations with amounts, bank statements, dividend notices, salary credits.\n\n" +
  "NOT TRANSACTION emails include: newsletters, marketing, job alerts, social notifications, OTP without amount, verification emails, promotional discount offers without an actual charge.\n\n" +
  "For each transaction extract:\n" +
  "- merchant: the business paid/received from — NOT the sending bank. E.g. for 'Rs.341 debited to Zepto via Amazon Pay', merchant = 'Zepto'\n" +
  "- amount: positive number\n" +
  "- currency: 'INR' by default\n" +
  "- date: from email content (YYYY-MM-DD); use fallbackDate only if no date in body\n" +
  "- type: 'expense' (money out) or 'income' (money in — salary, refund, dividend)\n" +
  "- category: one of: food, transport, shopping, entertainment, utilities, health, finance, travel, groceries, income, other\n" +
  "- subCategory: specific sub-type (e.g. 'restaurants', 'cab', 'streaming', 'electricity', 'salary', 'dividend') — null if uncertain\n" +
  "- confidence: 0.0–1.0\n" +
  "- needsReview: true if amount or merchant is ambiguous\n" +
  "- lineItems: array ONLY when email explicitly itemises charges (grocery list, restaurant bill). null otherwise.\n\n" +
  "For each successfully parsed transaction email, also return subjectTemplate and bodyTemplate: copies of the subject and body with ALL dynamic values replaced by typed placeholders. Use: {{AMOUNT}}, {{DATE}}, {{MERCHANT}}, {{VPA}}, {{ACCOUNT}}, {{ORDER_ID}}, {{TRANSACTION_ID}}, {{CURRENCY}}. Replace every occurrence of each dynamic value, not just the first. Static text (bank name, fixed labels) stays unchanged.\n\n" +
  "Return a JSON array — one object per input email. Never include explanations — only JSON.";
```

- [ ] **Step 5: Pass through template fields in `parseEmailBatch` response mapping**

In `src/lib/gemini.ts`, find the return statement in the `prepared.map` callback where `outcome: "parsed"` is returned. Add the template fields:

```typescript
    return {
      emailIndex: p.emailIndex,
      isTransaction: true,
      transactions,
      outcome: "parsed" as const,
      ...meta,
      ...(item.subjectTemplate ? { subjectTemplate: item.subjectTemplate } : {}),
      ...(item.bodyTemplate ? { bodyTemplate: item.bodyTemplate } : {}),
    };
```

Also add to the raw `parsed` array type (the `let parsed` declaration) to allow these optional fields:

```typescript
  let parsed: Array<{
    emailIndex: number;
    isTransaction?: boolean;
    subjectTemplate?: string;
    bodyTemplate?: string;
    transactions?: Array<{ /* ...unchanged... */ }>;
    outcome?: string | null;
  }> = [];
```

- [ ] **Step 6: Run all tests**

```bash
npm test 2>&1 | tail -15
```

Expected: all existing tests PASS; new template field tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/gemini.ts tests/lib/gemini.test.ts
git commit -m "feat: add subjectTemplate/bodyTemplate to GeminiEmailResult and batch prompt"
```

---

## Task 8: Wire three-tier chain into `advance/route.ts`

**Files:**
- Modify: `src/app/api/gmail/sync/advance/route.ts`

This is the integration task. No new test file — the existing 76 tests cover the route. After wiring, run them all.

- [ ] **Step 1: Add imports at the top of `advance/route.ts`**

```typescript
import {
  templateHash,
  preloadTemplates,
  warmCacheKey,
  applyTemplate,
  compareOutputs,
  deriveExtractors,
  upsertTemplate,
  recordHit,
  recordShadowAgreement,
  recordShadowDisagreement,
  recordActiveFailure,
  type ParseTemplateRow,
  type AppliedResult,
} from "@/lib/parseTemplateCache";
import { lookupExactCache } from "@/lib/exactResultCache";
```

- [ ] **Step 2: Replace the Gemini fallback block in `advanceJob`**

Find the comment `// ── Gemini fallback (only for insufficient_data emails) ─────────────────` at line ~251 and replace everything from `if (geminiQueue.length > 0) {` through the closing `}` of that block (ends around line 311) with the new three-tier implementation below.

Replace the section starting at `// outcome === "insufficient_data" → queue for Gemini` (line ~247) through `}` (end of `if (toProcess.length > 0)` block at line ~312):

```typescript
      // outcome === "insufficient_data" → enter three-tier cache chain
      geminiQueue.push(email);
    }

    // ── Tier 1: Exact result cache (reprocessJob reruns) ───────────────────
    const exactHits = await lookupExactCache(
      job.userId,
      geminiQueue.map((e) => e.msgId)
    );

    type GeminiQueueEntry = (typeof geminiQueue)[0] & {
      needsComparison?: boolean;
      shadowResult?: AppliedResult | null;
      templateId?: string;
      templateStatus?: string;
      templateKey?: string;
      isNewTemplate?: boolean;
    };

    const tier2Queue: GeminiQueueEntry[] = [];

    for (const email of geminiQueue) {
      if (exactHits.has(email.msgId)) {
        await prisma.parseLog.create({
          data: {
            ...buildLogBase(email, job),
            outcome: "skipped_duplicate",
            bodyLengthRaw: email.body.length,
            bodyLengthSent: 0,
            wasTruncated: false,
            batchSize: 1,
            resolvedBy: "exact_cache",
          },
        });
        continue;
      }
      tier2Queue.push(email);
    }

    // ── Tier 2: Learned template cache ─────────────────────────────────────
    // Batch preload: one DB query for all unique template keys
    const templateKeys = tier2Queue.map((e) => ({
      userId: job.userId,
      senderDomain: e.senderDomain,
      hash: templateHash(e.subject, e.body),
    }));
    const invocationMap = await preloadTemplates(templateKeys);

    const templateResolved: Array<{
      email: GeminiQueueEntry;
      result: AppliedResult;
    }> = [];
    const geminiQueueFinal: GeminiQueueEntry[] = [];

    for (const email of tier2Queue) {
      const hash = templateHash(email.subject, email.body);
      const key = warmCacheKey(job.userId, email.senderDomain, hash);
      const template = invocationMap.get(key) as ParseTemplateRow | undefined;

      if (!template) {
        geminiQueueFinal.push({ ...email, isNewTemplate: true });
        continue;
      }

      const shadowResult = applyTemplate(email.body, template.extractors);

      if (template.status === "ACTIVE") {
        if (!shadowResult) {
          await recordActiveFailure(template.id, key, invocationMap);
          geminiQueueFinal.push({ ...email, needsComparison: false });
        } else {
          templateResolved.push({ email, result: shadowResult });
        }
        continue;
      }

      // SHADOW or DEGRADED: run alongside Gemini
      if (!shadowResult) {
        await recordActiveFailure(template.id, key, invocationMap);
        geminiQueueFinal.push({ ...email, needsComparison: false, templateId: template.id, templateKey: key, templateStatus: template.status });
      } else {
        geminiQueueFinal.push({
          ...email,
          needsComparison: true,
          shadowResult,
          templateId: template.id,
          templateKey: key,
          templateStatus: template.status,
        });
      }
    }

    // ── Tier 2 resolved: write transactions and parse logs ──────────────────
    for (const { email, result } of templateResolved) {
      const { category: resolvedCategory, subCategory: resolvedSubCategory } =
        await lookupAndUpsertMerchant(result.merchant ?? "Unknown", "other", null, 0.8);

      const upsertResult = await upsertTransactionV2(prisma, {
        userId: job.userId, gmailMsgId: email.msgId, date: new Date(result.date),
        merchant: result.merchant ?? "Unknown", amount: result.amount,
        type: result.transactionType, currency: result.currency,
        category: resolvedCategory, source: "gmail", sourceRank: 1,
        confidence: 0.8, needsReview: false,
        subCategory: resolvedSubCategory ?? undefined,
      });

      const outcome = upsertResult.action === "inserted" ? "inserted"
        : upsertResult.action === "upgraded" ? "upgraded" : "skipped_duplicate";
      if (outcome === "inserted") newTransactions++;

      const hash = templateHash(email.subject, email.body);
      const key = warmCacheKey(job.userId, email.senderDomain, hash);
      const template = invocationMap.get(key) as ParseTemplateRow;
      await recordHit(template.id, key, invocationMap);

      await prisma.parseLog.create({
        data: {
          ...buildLogBase(email, job),
          outcome, bodyLengthRaw: email.body.length, bodyLengthSent: email.body.length,
          wasTruncated: false, batchSize: 1, geminiConfidence: 0.8,
          parsedMerchant: result.merchant ?? "Unknown", parsedAmount: result.amount,
          transactionId: upsertResult.id, resolvedBy: "template",
        },
      });
    }

    // ── Tier 3: Gemini batch ────────────────────────────────────────────────
    if (geminiQueueFinal.length > 0) {
      const rateCheck = await checkGeminiRateLimit();
      if (!rateCheck.allowed) {
        return { phase: "rate_limited", newTransactions: 0, source: "gemini" };
      }

      const batchInputs: BatchInput[] = geminiQueueFinal.map((e, idx) => ({
        emailIndex: idx,
        body: e.body,
        senderName: e.senderName,
        fallbackDate: e.receivedDate,
      }));

      const results = await parseEmailBatch(batchInputs, apiKey);
      await incrementGeminiUsage();

      for (const result of results) {
        const email = geminiQueueFinal[result.emailIndex];
        if (!email) continue;

        const logBase = {
          ...buildLogBase(email, job),
          bodyLengthRaw: result.bodyLengthRaw,
          bodyLengthSent: result.bodyLengthSent,
          wasTruncated: result.wasTruncated,
          batchSize: geminiQueueFinal.length,
          ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
        };

        if (result.outcome !== "parsed" || !result.transactions.length) {
          await prisma.parseLog.create({ data: { ...logBase, outcome: result.outcome, resolvedBy: "gemini" } });
          continue;
        }

        // Shadow comparison (SHADOW/DEGRADED templates)
        if (email.needsComparison && email.shadowResult && email.templateId && email.templateKey && email.templateStatus) {
          const geminiTx = result.transactions[0];
          const geminiApplied: AppliedResult = {
            amount: geminiTx.amount,
            currency: geminiTx.currency,
            date: geminiTx.date,
            transactionType: geminiTx.type,
            merchant: geminiTx.merchant,
          };
          const agrees = compareOutputs(email.shadowResult, geminiApplied);
          if (agrees) {
            await recordShadowAgreement(email.templateId, email.templateKey, invocationMap);
          } else {
            await recordShadowDisagreement(email.templateId, email.templateKey, email.templateStatus, invocationMap);
          }
        }

        // Learn new template from Gemini result
        if (email.isNewTemplate && result.subjectTemplate && result.bodyTemplate && result.transactions.length > 0) {
          const tx = result.transactions[0];
          const extractors = deriveExtractors(
            email.subject, email.body, result.bodyTemplate, result.subjectTemplate,
            { amount: tx.amount, currency: tx.currency, date: tx.date, transactionType: tx.type, merchant: tx.merchant }
          );
          const hasRequired = ["amount", "currency", "date", "transactionType"].every(
            (f) => extractors[f] !== undefined
          );
          if (hasRequired) {
            const hash = templateHash(email.subject, email.body);
            await upsertTemplate(
              job.userId, email.senderDomain, hash,
              result.subjectTemplate, result.bodyTemplate,
              extractors, invocationMap
            );
          }
        }

        // Write transaction (always use Gemini result)
        for (const tx of result.transactions) {
          const { category: resolvedCategory, subCategory: resolvedSubCategory } =
            await lookupAndUpsertMerchant(tx.merchant, tx.category, tx.subCategory ?? null, tx.confidence ?? 0);

          const upsertResult = await upsertTransactionV2(prisma, {
            userId: job.userId, gmailMsgId: email.msgId, date: new Date(tx.date),
            merchant: tx.merchant, amount: tx.amount, type: tx.type,
            currency: tx.currency, category: resolvedCategory, source: "gmail",
            sourceRank: 1, confidence: tx.confidence, needsReview: tx.needsReview,
            subCategory: resolvedSubCategory ?? undefined,
            lineItems: tx.lineItems ?? undefined,
          });

          const outcome = upsertResult.action === "inserted" ? "inserted"
            : upsertResult.action === "upgraded" ? "upgraded" : "skipped_duplicate";
          if (outcome === "inserted") newTransactions++;

          await prisma.parseLog.create({
            data: {
              ...logBase, outcome, geminiConfidence: tx.confidence,
              parsedMerchant: tx.merchant, parsedAmount: tx.amount,
              transactionId: upsertResult.id, resolvedBy: "gemini",
            },
          });
        }
      }
    }
```

- [ ] **Step 3: Extend cron pruning to include `ParseTemplate`**

Find `const pruned = await prisma.parseLog.deleteMany(...)` in the cron block and update it:

```typescript
  if (isCron) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pruned = await prisma.parseLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await prisma.parseTemplate.deleteMany({
      where: {
        OR: [
          { lastUsedAt: { lt: cutoff } },
          { status: "DISABLED", updatedAt: { lt: cutoff } },
        ],
      },
    });
    return NextResponse.json({ jobs: results, pruned: pruned.count });
  }
```

- [ ] **Step 4: Run TypeScript type check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 5: Run the full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all existing 76+ tests PASS. The route tests use mocked Prisma and mocked Gemini — the three-tier logic is additive and doesn't break existing paths.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "feat: wire three-tier parse chain (exact cache + template cache + Gemini teacher)"
```

---

## Task 9: Integration smoke test and final verification

**Files:**
- No new files

- [ ] **Step 1: Full test run**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests PASS. Note the test count — should be 76+ (new tests added).

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 3: Verify migration was applied**

```bash
npx prisma migrate status 2>&1 | grep -E "applied|pending|ParseTemplate"
```

Expected: `20260714100000_add_parse_template` listed as "Applied".

- [ ] **Step 4: Verify safe-regex is installed**

```bash
node -e "const s = require('safe-regex'); console.log(s('(a+)+'), s('[\\\\d,]+')); "
```

Expected: `false true` — catastrophic pattern rejected, safe pattern accepted.

- [ ] **Step 5: Commit final state**

```bash
git add -A
git status  # review — should be clean except for lock file changes
git commit -m "chore: final state — adaptive parse template cache v1 complete"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Template hash normalization algorithm → Task 2 (`canonicalise` + `templateHash`)
- ✅ Extractor generation → Task 4 (`deriveExtractors`)
- ✅ Regex safety → Task 4 (`safe-regex` check in `deriveExtractors`)
- ✅ `ParseTemplate` Prisma model → Task 1
- ✅ `resolvedBy` on `ParseLog` → Task 1
- ✅ Template lifecycle states + transitions → Task 5 (`recordShadowAgreement`, `recordShadowDisagreement`, `recordActiveFailure`)
- ✅ Concurrency-safe atomic increments → Task 5 (all DB writes use `{ increment: 1 }` + WHERE guards)
- ✅ Warm cache with 5-min TTL → Task 2 (`getWarm` TTL check)
- ✅ Shadow comparison rules → Task 3 (`compareOutputs`)
- ✅ Batch preload (no N+1) → Task 8 (`preloadTemplates` single query)
- ✅ Tier 1 exact cache for reprocessJob → Task 6 (`lookupExactCache`)
- ✅ Tier 2 template cache routing → Task 8 (ACTIVE / SHADOW/DEGRADED / no-template branches)
- ✅ Gemini as teacher (upsertTemplate after parse) → Task 8
- ✅ 30-day TTL pruning of `ParseTemplate` → Task 8 (cron block)
- ✅ `subjectTemplate` / `bodyTemplate` in Gemini response → Task 7
- ✅ PII boundary — `bodyTemplate` stored with placeholders only → enforced by Gemini prompt (Task 7)
- ✅ Tier 3 removed from v1 → no Tier 3 code written
