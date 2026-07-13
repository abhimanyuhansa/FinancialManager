# Dual-Provider LLM Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken single-provider Gemini integration with a dual-provider routing layer (OpenAI primary, Gemini fallback) backed by DB-level quota tracking, circuit breakers, idempotency, and advisory locking.

**Architecture:** A new `src/lib/llm/` module owns all LLM interactions. Routes call `parseEmailBatchLLM()` / `parseStatementLLM()` from the module's public index. The module selects a provider via quota checks + circuit breaker state, executes with fallback, and writes one `LlmCallLog` row per attempt. DB-backed `LlmQuotaWindow` and `LlmCircuitBreaker` tables are shared across all Vercel instances. `LlmBatchIdempotency` prevents re-running batches already in-flight. `SyncJobLock` ensures a single advance-route instance holds the sync job at a time.

**Tech Stack:** Next.js 16 (App Router), Prisma 7, PostgreSQL, OpenAI gpt-5-nano-2025-08-07, Gemini gemini-3.1-flash-lite (v1beta REST), TypeScript strict

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/llm/providers/types.ts` | All shared types and error classes |
| Create | `src/lib/llm/prompts.ts` | SCHEMA_VERSION, prompts, EMAIL_JSON_SCHEMA, STATEMENT_SYSTEM_PROMPT, token estimates |
| Create | `src/lib/llm/validate.ts` | `validateProviderResults()` |
| Create | `src/lib/llm/providers/gemini.ts` | Gemini HTTP adapter |
| Create | `src/lib/llm/providers/openai.ts` | OpenAI HTTP adapter |
| Create | `src/lib/llm/quota.ts` | `checkQuota()`, `reserveQuota()`, `releaseQuota()` |
| Create | `src/lib/llm/circuitBreaker.ts` | Circuit breaker state machine |
| Create | `src/lib/llm/lock.ts` | `acquireLock()`, `releaseLock()` |
| Create | `src/lib/llm/idempotency.ts` | `acquireIdempotencyKey()`, `completeIdempotencyKey()` |
| Create | `src/lib/llm/router.ts` | `selectProvider()` |
| Create | `src/lib/llm/index.ts` | `parseEmailBatchLLM()`, `parseStatementLLM()` |
| Modify | `prisma/schema.prisma` | Add 5 new models |
| Modify | `src/app/api/gmail/sync/advance/route.ts` | Replace Gemini calls, add lock |
| Modify | `src/app/api/gmail/reconcile/route.ts` | Replace `callGeminiForStatement` |
| Modify | `src/app/api/settings/parse-logs/[id]/reprocess/route.ts` | Replace `parseEmailBatch` |
| Keep | `src/lib/gemini.ts` | Internal — no longer imported by routes; kept for internal use |
| Keep | `src/lib/geminiRateLimit.ts` | Superseded by `quota.ts`; routes stop importing it |

---

### Task 1: Prisma — Add 5 new models

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add models to schema**

Append to `prisma/schema.prisma` after the last model:

```prisma
model LlmCallLog {
  id               String   @id @default(cuid())
  syncJobId        String?
  userId           String?
  batchKey         String?
  provider         String
  model            String
  candidateCount   Int
  attemptNumber    Int
  wasFallback      Boolean  @default(false)
  fallbackReason   String?
  outcome          String
  errorDetail      String?
  latencyMs        Int
  inputTokens      Int
  outputTokens     Int
  estimatedCostUsd Decimal
  createdAt        DateTime @default(now())

  @@index([provider, createdAt])
  @@index([syncJobId])
  @@index([batchKey])
}

model LlmQuotaWindow {
  id         String   @id @default(cuid())
  provider   String
  windowType String
  windowKey  String
  count      Int      @default(0)
  updatedAt  DateTime @updatedAt

  @@unique([provider, windowType, windowKey])
  @@index([provider, windowType, windowKey])
}

model LlmCircuitBreaker {
  provider            String    @id
  state               String    @default("CLOSED")
  consecutiveFailures Int       @default(0)
  lastFailureAt       DateTime?
  openedAt            DateTime?
  updatedAt           DateTime  @updatedAt
}

model LlmBatchIdempotency {
  id        String   @id @default(cuid())
  batchKey  String   @unique
  status    String
  result    Json?
  createdAt DateTime @default(now())
  expiresAt DateTime

  @@index([expiresAt])
}

model SyncJobLock {
  jobId      String   @id
  ownerToken String
  lockedAt   DateTime @default(now())
  expiresAt  DateTime

  @@index([expiresAt])
}
```

- [ ] **Step 2: Generate migration**

```bash
npx prisma migrate dev --name add-llm-routing-tables
```

Expected: migration file created in `prisma/migrations/`, Prisma client regenerated.

- [ ] **Step 3: Verify client regenerated**

```bash
npx prisma generate
```

Expected: `✔ Generated Prisma Client` with no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add LLM routing DB models (LlmCallLog, LlmQuotaWindow, LlmCircuitBreaker, LlmBatchIdempotency, SyncJobLock)"
```

---

### Task 2: Types and error classes

**Files:**
- Create: `src/lib/llm/providers/types.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/types.test.ts`:

```typescript
import {
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
  ProviderExhaustedError,
} from "../providers/types";

describe("LLM error classes", () => {
  it("ProviderBadRequestError has correct name and provider", () => {
    const err = new ProviderBadRequestError("openai", "bad request");
    expect(err.name).toBe("ProviderBadRequestError");
    expect(err.provider).toBe("openai");
    expect(err instanceof Error).toBe(true);
  });

  it("ProviderAuthError has correct name", () => {
    const err = new ProviderAuthError("gemini", "unauthorized");
    expect(err.name).toBe("ProviderAuthError");
    expect(err.provider).toBe("gemini");
  });

  it("ProviderRateLimitError has correct name", () => {
    const err = new ProviderRateLimitError("openai", "rate limited");
    expect(err.name).toBe("ProviderRateLimitError");
  });

  it("ProviderServerError has correct name", () => {
    const err = new ProviderServerError("gemini", "server error");
    expect(err.name).toBe("ProviderServerError");
  });

  it("ProviderTimeoutError has correct name", () => {
    const err = new ProviderTimeoutError("openai", "timeout");
    expect(err.name).toBe("ProviderTimeoutError");
  });

  it("ProviderParseError has correct name and raw field", () => {
    const err = new ProviderParseError("gemini", "bad json", "raw response here");
    expect(err.name).toBe("ProviderParseError");
    expect(err.raw).toBe("raw response here");
  });

  it("ProviderExhaustedError carries both providers", () => {
    const err = new ProviderExhaustedError("openai", "gemini");
    expect(err.name).toBe("ProviderExhaustedError");
    expect(err.primary).toBe("openai");
    expect(err.fallback).toBe("gemini");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/types.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/providers/types.ts`**

```typescript
export type LLMProvider = "openai" | "gemini";

export type ParsedEmailItem = {
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
    lineItems: Array<{ name: string; amount: number; subCategory?: string }> | null;
  }>;
  outcome: "parsed" | "not_transaction" | "parse_failed" | "insufficient_data";
  subjectTemplate?: string;
  bodyTemplate?: string;
};

export type StatementItem = {
  date: string;
  merchant: string;
  amount: number;
  type: "expense" | "debit" | "credit" | "income";
};

export type ProviderCallResult = {
  items: ParsedEmailItem[];
  inputTokens: number;
  outputTokens: number;
};

export type StatementCallResult = {
  items: StatementItem[];
  inputTokens: number;
  outputTokens: number;
};

abstract class LLMError extends Error {
  abstract readonly name: string;
  readonly provider: LLMProvider;
  constructor(provider: LLMProvider, message: string) {
    super(message);
    this.provider = provider;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProviderBadRequestError extends LLMError {
  readonly name = "ProviderBadRequestError" as const;
}
export class ProviderAuthError extends LLMError {
  readonly name = "ProviderAuthError" as const;
}
export class ProviderRateLimitError extends LLMError {
  readonly name = "ProviderRateLimitError" as const;
}
export class ProviderServerError extends LLMError {
  readonly name = "ProviderServerError" as const;
}
export class ProviderTimeoutError extends LLMError {
  readonly name = "ProviderTimeoutError" as const;
}
export class ProviderParseError extends LLMError {
  readonly name = "ProviderParseError" as const;
  readonly raw: string;
  constructor(provider: LLMProvider, message: string, raw: string) {
    super(message);
    this.provider = provider;
    this.raw = raw;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ProviderExhaustedError extends Error {
  readonly name = "ProviderExhaustedError" as const;
  readonly primary: LLMProvider;
  readonly fallback: LLMProvider;
  constructor(primary: LLMProvider, fallback: LLMProvider) {
    super(`Both providers exhausted: primary=${primary} fallback=${fallback}`);
    this.primary = primary;
    this.fallback = fallback;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type LlmCallContext = {
  userId: string;
  syncJobId?: string;
  operationType: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/types.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/providers/types.ts src/lib/llm/__tests__/types.test.ts
git commit -m "feat: add LLM provider types and error classes"
```

---

### Task 3: Prompts, schema, and token estimates

**Files:**
- Create: `src/lib/llm/prompts.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/prompts.test.ts`:

```typescript
import {
  SCHEMA_VERSION,
  EMAIL_JSON_SCHEMA,
  BATCH_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  STATEMENT_SYSTEM_PROMPT,
  buildStatementUserPrompt,
  estimateInputTokens,
} from "../prompts";

describe("prompts", () => {
  it("SCHEMA_VERSION is a non-empty string", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it("EMAIL_JSON_SCHEMA is an object with type=array", () => {
    expect(EMAIL_JSON_SCHEMA.type).toBe("array");
  });

  it("BATCH_SYSTEM_PROMPT contains transaction parsing instructions", () => {
    expect(BATCH_SYSTEM_PROMPT).toContain("transaction");
  });

  it("buildBatchUserPrompt includes emailIndex in output", () => {
    const prompt = buildBatchUserPrompt([
      { emailIndex: 0, body: "hello", senderName: "HDFC", fallbackDate: "2026-07-14" },
    ]);
    expect(prompt).toContain("emailIndex");
    expect(prompt).toContain("0");
  });

  it("STATEMENT_SYSTEM_PROMPT mentions JSON array", () => {
    expect(STATEMENT_SYSTEM_PROMPT).toContain("JSON array");
  });

  it("buildStatementUserPrompt wraps the body", () => {
    const prompt = buildStatementUserPrompt("some statement body");
    expect(prompt).toContain("some statement body");
  });

  it("estimateInputTokens returns a positive number", () => {
    const tokens = estimateInputTokens([
      { emailIndex: 0, body: "debit Rs.500 from HDFC", senderName: "HDFC", fallbackDate: "2026-07-14" },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/prompts.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/prompts.ts`**

```typescript
export const SCHEMA_VERSION = "v1";

const CHARS_PER_TOKEN = 4;

export const EMAIL_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      emailIndex: { type: "integer" },
      isTransaction: { type: "boolean" },
      transactions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            merchant: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string" },
            date: { type: "string" },
            type: { type: "string", enum: ["expense", "income"] },
            category: { type: "string" },
            subCategory: { type: ["string", "null"] },
            confidence: { type: "number" },
            needsReview: { type: "boolean" },
            lineItems: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  amount: { type: "number" },
                  subCategory: { type: "string" },
                },
              },
            },
          },
          required: ["merchant", "amount", "currency", "date", "type", "category", "subCategory", "confidence", "needsReview", "lineItems"],
        },
      },
      outcome: { type: "string", enum: ["parsed", "not_transaction", "parse_failed", "insufficient_data"] },
      subjectTemplate: { type: "string" },
      bodyTemplate: { type: "string" },
    },
    required: ["emailIndex", "isTransaction", "transactions", "outcome"],
  },
} as const;

export const BATCH_SYSTEM_PROMPT =
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
  "For each successfully parsed transaction email, also return subjectTemplate and bodyTemplate: copies of the subject and body with ALL dynamic values replaced by typed placeholders. Use: {{AMOUNT}}, {{DATE}}, {{MERCHANT}}, {{VPA}}, {{ACCOUNT}}, {{ORDER_ID}}, {{TRANSACTION_ID}}, {{CURRENCY}}. Replace every occurrence of each dynamic value. Static text (bank name, fixed labels) stays unchanged.\n\n" +
  "Return a JSON array — one object per input email. Never include explanations — only JSON.";

type EmailInput = { emailIndex: number; body: string; senderName: string; fallbackDate: string };

export function buildBatchUserPrompt(items: EmailInput[]): string {
  const emailsJson = JSON.stringify(
    items.map((i) => ({ emailIndex: i.emailIndex, senderName: i.senderName, fallbackDate: i.fallbackDate, body: i.body }))
  );
  return `Parse these emails. Return a JSON array — one object per email matching this schema exactly:
[
  {
    "emailIndex": number,
    "isTransaction": boolean,
    "transactions": [
      {
        "merchant": string,
        "amount": number,
        "currency": string,
        "date": string,
        "type": "expense" | "income",
        "category": string,
        "subCategory": string | null,
        "confidence": number,
        "needsReview": boolean,
        "lineItems": [{ "name": string, "amount": number, "subCategory": string }] | null
      }
    ],
    "outcome": "parsed" | "not_transaction" | "parse_failed" | "insufficient_data"
  }
]

If isTransaction is false, set transactions to [] and outcome to "not_transaction".

Emails:
${emailsJson}`;
}

export const STATEMENT_SYSTEM_PROMPT =
  "This is a bank or credit card statement. Extract every transaction listed. " +
  "Return a JSON array where each item has: " +
  '{"date": string, "merchant": string, "amount": number, "type": "expense"|"debit"|"credit"|"income"}. ' +
  "Return only the array. No explanations.";

export function buildStatementUserPrompt(body: string): string {
  return `Statement:\n${body}`;
}

export function estimateInputTokens(items: EmailInput[]): number {
  const promptText = BATCH_SYSTEM_PROMPT + buildBatchUserPrompt(items);
  return Math.ceil(promptText.length / CHARS_PER_TOKEN);
}

export function estimateOutputTokens(candidateCount: number): number {
  // ~150 tokens per email for typical parsed output
  return candidateCount * 150;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/prompts.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/prompts.ts src/lib/llm/__tests__/prompts.test.ts
git commit -m "feat: add LLM prompts, EMAIL_JSON_SCHEMA, and token estimators"
```

---

### Task 4: Result validation

**Files:**
- Create: `src/lib/llm/validate.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/validate.test.ts`:

```typescript
import { validateProviderResults } from "../validate";
import { ProviderParseError } from "../providers/types";

const makeItem = (emailIndex: number) => ({
  emailIndex,
  isTransaction: true,
  transactions: [{ merchant: "M", amount: 100, currency: "INR", date: "2026-07-14", type: "expense" as const, category: "other", subCategory: null, confidence: 0.9, needsReview: false, lineItems: null }],
  outcome: "parsed" as const,
});

describe("validateProviderResults", () => {
  it("passes for valid single result", () => {
    const out = validateProviderResults([makeItem(0)], 1, "gemini");
    expect(out).toHaveLength(1);
    expect(out[0].emailIndex).toBe(0);
  });

  it("passes for valid multi result", () => {
    const out = validateProviderResults([makeItem(0), makeItem(1), makeItem(2)], 3, "openai");
    expect(out).toHaveLength(3);
  });

  it("throws ProviderParseError for wrong count", () => {
    expect(() => validateProviderResults([makeItem(0)], 2, "gemini")).toThrow(ProviderParseError);
  });

  it("throws ProviderParseError for duplicate emailIndex", () => {
    expect(() => validateProviderResults([makeItem(0), makeItem(0)], 2, "gemini")).toThrow(ProviderParseError);
  });

  it("throws ProviderParseError for gap in emailIndex", () => {
    expect(() => validateProviderResults([makeItem(0), makeItem(2)], 2, "gemini")).toThrow(ProviderParseError);
  });

  it("throws ProviderParseError for out-of-range emailIndex", () => {
    expect(() => validateProviderResults([makeItem(5)], 1, "openai")).toThrow(ProviderParseError);
  });

  it("returns parse_failed outcome for invalid transaction field (not a throw)", () => {
    const bad = {
      emailIndex: 0,
      isTransaction: true,
      transactions: [{ merchant: "M", amount: -1, currency: "INR", date: "2026-07-14", type: "expense" as const, category: "other", subCategory: null, confidence: 0.9, needsReview: false, lineItems: null }],
      outcome: "parsed" as const,
    };
    const out = validateProviderResults([bad], 1, "gemini");
    expect(out[0].outcome).toBe("insufficient_data");
    expect(out[0].transactions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/validate.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/validate.ts`**

```typescript
import { ParsedEmailItem, LLMProvider, ProviderParseError } from "./providers/types";

const VALID_CATEGORIES = ["food", "transport", "shopping", "entertainment", "utilities", "health", "finance", "travel", "groceries", "income", "other"];

export function validateProviderResults(
  raw: ParsedEmailItem[],
  candidateCount: number,
  provider: LLMProvider
): ParsedEmailItem[] {
  if (raw.length !== candidateCount) {
    throw new ProviderParseError(
      provider,
      `Expected ${candidateCount} results, got ${raw.length}`,
      JSON.stringify(raw).slice(0, 200)
    );
  }

  const indices = new Set<number>();
  for (const item of raw) {
    if (item.emailIndex < 0 || item.emailIndex >= candidateCount) {
      throw new ProviderParseError(
        provider,
        `emailIndex ${item.emailIndex} out of range [0,${candidateCount})`,
        JSON.stringify(item).slice(0, 200)
      );
    }
    if (indices.has(item.emailIndex)) {
      throw new ProviderParseError(
        provider,
        `Duplicate emailIndex ${item.emailIndex}`,
        JSON.stringify(item).slice(0, 200)
      );
    }
    indices.add(item.emailIndex);
  }

  // Verify no gaps
  for (let i = 0; i < candidateCount; i++) {
    if (!indices.has(i)) {
      throw new ProviderParseError(
        provider,
        `Missing emailIndex ${i}`,
        JSON.stringify(raw).slice(0, 200)
      );
    }
  }

  return raw.map((item) => {
    if (!item.isTransaction || !item.transactions?.length) {
      return { ...item, isTransaction: false, transactions: [], outcome: "not_transaction" as const };
    }

    const validTxs = item.transactions.filter((t) => typeof t.amount === "number" && t.amount > 0);

    if (validTxs.length === 0) {
      return { ...item, isTransaction: false, transactions: [], outcome: "insufficient_data" as const };
    }

    const sanitised = validTxs.map((t) => ({
      ...t,
      category: VALID_CATEGORIES.includes(t.category) ? t.category : "other",
      currency: t.currency ?? "INR",
      subCategory: t.subCategory ?? null,
      lineItems: t.lineItems ?? null,
    }));

    return { ...item, transactions: sanitised };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/validate.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/validate.ts src/lib/llm/__tests__/validate.test.ts
git commit -m "feat: add validateProviderResults with strict emailIndex set check"
```

---

### Task 5: Gemini provider adapter

**Files:**
- Create: `src/lib/llm/providers/gemini.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/gemini.test.ts`:

```typescript
import { callGeminiEmailBatch, callGeminiStatement } from "../providers/gemini";
import { ProviderRateLimitError, ProviderServerError, ProviderAuthError, ProviderBadRequestError } from "../providers/types";

// Polyfill fetch globally
global.fetch = jest.fn();

const mockFetch = global.fetch as jest.Mock;

const makeGeminiResponse = (items: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  }),
});

const makeErrorResponse = (status: number) => ({
  ok: false,
  status,
  text: async () => "error body",
});

describe("callGeminiEmailBatch", () => {
  afterEach(() => mockFetch.mockReset());

  it("returns parsed items and token counts on success", async () => {
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockFetch.mockResolvedValueOnce(makeGeminiResponse([item]));

    const result = await callGeminiEmailBatch(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "apikey123"
    );

    expect(result.items).toHaveLength(1);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it("throws ProviderRateLimitError on 429", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429));
    await expect(callGeminiEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderRateLimitError);
  });

  it("throws ProviderServerError on 500", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    await expect(callGeminiEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderServerError);
  });

  it("throws ProviderAuthError on 401", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    await expect(callGeminiEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderAuthError);
  });

  it("throws ProviderBadRequestError on 400", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));
    await expect(callGeminiEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderBadRequestError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/gemini.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/providers/gemini.ts`**

```typescript
import {
  LLMProvider,
  ParsedEmailItem,
  StatementItem,
  ProviderCallResult,
  StatementCallResult,
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
} from "./types";
import {
  BATCH_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  STATEMENT_SYSTEM_PROMPT,
  buildStatementUserPrompt,
  EMAIL_JSON_SCHEMA,
} from "../prompts";

const PROVIDER: LLMProvider = "gemini";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const GEMINI_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);

type EmailInput = { emailIndex: number; body: string; senderName: string; fallbackDate: string };

function throwForStatus(status: number, body: string): never {
  if (status === 400) throw new ProviderBadRequestError(PROVIDER, `400: ${body.slice(0, 100)}`);
  if (status === 401 || status === 403) throw new ProviderAuthError(PROVIDER, `${status}: ${body.slice(0, 100)}`);
  if (status === 429) throw new ProviderRateLimitError(PROVIDER, `429: ${body.slice(0, 100)}`);
  throw new ProviderServerError(PROVIDER, `${status}: ${body.slice(0, 100)}`);
}

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  responseSchema?: unknown
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res: Response;
  try {
    const generationConfig: Record<string, unknown> = { temperature: 0, responseMimeType: "application/json" };
    if (responseSchema) generationConfig.responseSchema = responseSchema;

    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig,
        }),
        signal: controller.signal,
      }
    );
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderTimeoutError(PROVIDER, `Timed out after ${GEMINI_TIMEOUT_MS}ms`);
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throwForStatus(res.status, errBody);
  }

  const data = await res.json() as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, inputTokens, outputTokens };
}

function parseJsonText<T>(text: string, provider: LLMProvider): T {
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(clean) as T;
  } catch {
    throw new ProviderParseError(provider, "Failed to parse JSON response", text.slice(0, 300));
  }
}

export async function callGeminiEmailBatch(
  inputs: EmailInput[],
  apiKey: string
): Promise<ProviderCallResult> {
  const { text, inputTokens, outputTokens } = await callGemini(
    BATCH_SYSTEM_PROMPT,
    buildBatchUserPrompt(inputs),
    apiKey,
    EMAIL_JSON_SCHEMA
  );

  const raw = parseJsonText<ParsedEmailItem[]>(text, PROVIDER);
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response is not an array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}

export async function callGeminiStatement(
  body: string,
  apiKey: string
): Promise<StatementCallResult> {
  const { text, inputTokens, outputTokens } = await callGemini(
    STATEMENT_SYSTEM_PROMPT,
    buildStatementUserPrompt(body),
    apiKey
  );

  const raw = parseJsonText<StatementItem[]>(text, PROVIDER);
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response is not an array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/gemini.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/providers/gemini.ts src/lib/llm/__tests__/gemini.test.ts
git commit -m "feat: add Gemini HTTP adapter with responseSchema and error mapping"
```

---

### Task 6: OpenAI provider adapter

**Files:**
- Create: `src/lib/llm/providers/openai.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/openai.test.ts`:

```typescript
import { callOpenAIEmailBatch, callOpenAIStatement } from "../providers/openai";
import { ProviderRateLimitError, ProviderServerError, ProviderAuthError, ProviderBadRequestError, ProviderParseError } from "../providers/types";

global.fetch = jest.fn();
const mockFetch = global.fetch as jest.Mock;

const makeOpenAIResponse = (items: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(items) } }],
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  }),
});

const makeErrorResponse = (status: number) => ({
  ok: false,
  status,
  json: async () => ({ error: { message: "err" } }),
});

describe("callOpenAIEmailBatch", () => {
  afterEach(() => mockFetch.mockReset());

  it("returns parsed items and token counts on success", async () => {
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse([item]));

    const result = await callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "sk-test"
    );

    expect(result.items).toHaveLength(1);
    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
  });

  it("throws ProviderRateLimitError on 429", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429));
    await expect(callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderRateLimitError);
  });

  it("throws ProviderAuthError on 401", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    await expect(callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderAuthError);
  });

  it("throws ProviderBadRequestError on 400", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));
    await expect(callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderBadRequestError);
  });

  it("throws ProviderParseError if response is not array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"not":"array"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    await expect(callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key"
    )).rejects.toThrow(ProviderParseError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/openai.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/providers/openai.ts`**

```typescript
import {
  LLMProvider,
  ParsedEmailItem,
  StatementItem,
  ProviderCallResult,
  StatementCallResult,
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
} from "./types";
import {
  BATCH_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  STATEMENT_SYSTEM_PROMPT,
  buildStatementUserPrompt,
  EMAIL_JSON_SCHEMA,
} from "../prompts";

const PROVIDER: LLMProvider = "openai";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-nano-2025-08-07";
const OPENAI_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const OPENAI_API_BASE = "https://api.openai.com/v1";

type EmailInput = { emailIndex: number; body: string; senderName: string; fallbackDate: string };

function throwForStatus(status: number, detail: string): never {
  if (status === 400) throw new ProviderBadRequestError(PROVIDER, `400: ${detail.slice(0, 100)}`);
  if (status === 401 || status === 403) throw new ProviderAuthError(PROVIDER, `${status}: ${detail.slice(0, 100)}`);
  if (status === 429) throw new ProviderRateLimitError(PROVIDER, `429: ${detail.slice(0, 100)}`);
  throw new ProviderServerError(PROVIDER, `${status}: ${detail.slice(0, 100)}`);
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  jsonSchema?: unknown
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
    };
    if (jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "email_parse", schema: jsonSchema, strict: true },
      };
    }

    res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderTimeoutError(PROVIDER, `Timed out after ${OPENAI_TIMEOUT_MS}ms`);
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: { message: "unknown" } })) as { error?: { message?: string } };
    throwForStatus(res.status, errData.error?.message ?? "");
  }

  const data = await res.json() as {
    choices?: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  return { text, inputTokens, outputTokens };
}

function parseJsonText<T>(text: string): T {
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(clean) as T;
  } catch {
    throw new ProviderParseError(PROVIDER, "Failed to parse JSON response", text.slice(0, 300));
  }
}

export async function callOpenAIEmailBatch(
  inputs: EmailInput[],
  apiKey: string
): Promise<ProviderCallResult> {
  const { text, inputTokens, outputTokens } = await callOpenAI(
    BATCH_SYSTEM_PROMPT,
    buildBatchUserPrompt(inputs),
    apiKey,
    EMAIL_JSON_SCHEMA
  );

  const raw = parseJsonText<ParsedEmailItem[]>(text);
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response is not an array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}

export async function callOpenAIStatement(
  body: string,
  apiKey: string
): Promise<StatementCallResult> {
  const { text, inputTokens, outputTokens } = await callOpenAI(
    STATEMENT_SYSTEM_PROMPT,
    buildStatementUserPrompt(body),
    apiKey
  );

  const raw = parseJsonText<StatementItem[]>(text);
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response is not an array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/openai.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/providers/openai.ts src/lib/llm/__tests__/openai.test.ts
git commit -m "feat: add OpenAI HTTP adapter with strict JSON schema and error mapping"
```

---

### Task 7: Quota tracking

**Files:**
- Create: `src/lib/llm/quota.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/quota.test.ts`:

```typescript
import { checkQuota, reserveQuota, releaseQuota } from "../quota";

// Mock prisma
jest.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
const mockQuery = prisma.$queryRaw as jest.Mock;

describe("checkQuota", () => {
  afterEach(() => mockQuery.mockReset());

  it("returns allowed=true when all windows have capacity", async () => {
    mockQuery.mockResolvedValue([
      { window_type: "rpm", count: 5 },
      { window_type: "tpm", count: 100 },
      { window_type: "rpd", count: 50 },
    ]);
    const result = await checkQuota("gemini", 5);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed=false with reason when RPM exceeded", async () => {
    mockQuery.mockResolvedValue([
      { window_type: "rpm", count: 1000 },
      { window_type: "tpm", count: 100 },
      { window_type: "rpd", count: 50 },
    ]);
    const result = await checkQuota("gemini", 5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rpm");
  });
});

describe("reserveQuota", () => {
  afterEach(() => mockQuery.mockReset());

  it("returns true when all atomic upserts succeed", async () => {
    // Each $queryRaw for upsert returns rowsAffected=1
    mockQuery.mockResolvedValue([{ affected: 1 }]);
    const success = await reserveQuota("openai", 1, 200, 100);
    expect(success).toBe(true);
  });
});

describe("releaseQuota", () => {
  afterEach(() => mockQuery.mockReset());

  it("calls $queryRaw to decrement (best-effort, does not throw)", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    await expect(releaseQuota("openai", 1, 200, 100)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/quota.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/quota.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import { LLMProvider } from "./providers/types";
import { Prisma } from "@prisma/client";

const LIMITS: Record<LLMProvider, { rpm: number; tpm: number; rpd: number }> = {
  gemini: {
    rpm: Number(process.env.GEMINI_RPM_LIMIT ?? 12),
    tpm: Number(process.env.GEMINI_TPM_LIMIT ?? 32_000),
    rpd: Number(process.env.GEMINI_RPD_LIMIT ?? 1_120),
  },
  openai: {
    rpm: Number(process.env.OPENAI_RPM_LIMIT ?? 480),
    tpm: Number(process.env.OPENAI_TPM_LIMIT ?? 160_000),
    rpd: Number(process.env.OPENAI_RPD_LIMIT ?? 9_000),
  },
};

function windowKeys(): { rpm: string; tpm: string; rpd: string } {
  const now = new Date();
  const minuteKey = `${now.toISOString().slice(0, 16)}`; // YYYY-MM-DDTHH:MM
  const dayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return { rpm: minuteKey, tpm: minuteKey, rpd: dayKey };
}

type WindowRow = { window_type: string; count: number };

export async function checkQuota(
  provider: LLMProvider,
  requestCount: number
): Promise<{ allowed: boolean; reason?: string }> {
  const keys = windowKeys();
  const limits = LIMITS[provider];

  const rows = await prisma.$queryRaw<WindowRow[]>(
    Prisma.sql`
      SELECT window_type, count FROM "LlmQuotaWindow"
      WHERE provider = ${provider}
        AND (
          (window_type = 'rpm' AND window_key = ${keys.rpm})
          OR (window_type = 'tpm' AND window_key = ${keys.tpm})
          OR (window_type = 'rpd' AND window_key = ${keys.rpd})
        )
    `
  );

  const get = (type: string) => rows.find((r) => r.window_type === type)?.count ?? 0;

  if (get("rpm") + requestCount > limits.rpm) return { allowed: false, reason: `rpm limit ${limits.rpm}` };
  if (get("rpd") + requestCount > limits.rpd) return { allowed: false, reason: `rpd limit ${limits.rpd}` };
  return { allowed: true };
}

export async function reserveQuota(
  provider: LLMProvider,
  requestCount: number,
  inputTokens: number,
  outputTokens: number
): Promise<boolean> {
  const keys = windowKeys();
  const limits = LIMITS[provider];

  const windows = [
    { type: "rpm", key: keys.rpm, delta: requestCount, limit: limits.rpm },
    { type: "tpm", key: keys.tpm, delta: inputTokens + outputTokens, limit: limits.tpm },
    { type: "rpd", key: keys.rpd, delta: requestCount, limit: limits.rpd },
  ];

  for (const w of windows) {
    const result = await prisma.$queryRaw<Array<{ affected: number }>>(
      Prisma.sql`
        INSERT INTO "LlmQuotaWindow" (id, provider, window_type, window_key, count, updated_at)
        VALUES (gen_random_uuid(), ${provider}, ${w.type}, ${w.key}, ${w.delta}, NOW())
        ON CONFLICT (provider, window_type, window_key)
        DO UPDATE SET count = "LlmQuotaWindow".count + ${w.delta}, updated_at = NOW()
        WHERE "LlmQuotaWindow".count + ${w.delta} <= ${w.limit}
        RETURNING 1 AS affected
      `
    );
    if (!result.length) return false;
  }
  return true;
}

export async function releaseQuota(
  provider: LLMProvider,
  requestCount: number,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const keys = windowKeys();

  const windows = [
    { type: "rpm", key: keys.rpm, delta: requestCount },
    { type: "tpm", key: keys.tpm, delta: inputTokens + outputTokens },
    { type: "rpd", key: keys.rpd, delta: requestCount },
  ];

  try {
    for (const w of windows) {
      await prisma.$queryRaw(
        Prisma.sql`
          UPDATE "LlmQuotaWindow"
          SET count = GREATEST(0, count - ${w.delta}), updated_at = NOW()
          WHERE provider = ${provider} AND window_type = ${w.type} AND window_key = ${w.key}
        `
      );
    }
  } catch {
    // Best-effort — quota release failure is not fatal
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/quota.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/quota.ts src/lib/llm/__tests__/quota.test.ts
git commit -m "feat: add quota tracking with fixed-bucket DB windows and atomic upsert"
```

---

### Task 8: Circuit breaker

**Files:**
- Create: `src/lib/llm/circuitBreaker.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/circuitBreaker.test.ts`:

```typescript
import { getCircuitBreakerState, recordSuccess, recordFailure, tryAcquireHalfOpenProbe } from "../circuitBreaker";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    llmCircuitBreaker: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
const mockFindUnique = prisma.llmCircuitBreaker.findUnique as jest.Mock;
const mockUpsert = prisma.llmCircuitBreaker.upsert as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;

describe("getCircuitBreakerState", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns CLOSED when no record exists", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const state = await getCircuitBreakerState("openai");
    expect(state).toBe("CLOSED");
  });

  it("returns OPEN when record state is OPEN and not expired", async () => {
    mockFindUnique.mockResolvedValueOnce({
      state: "OPEN",
      openedAt: new Date(Date.now() - 10_000),
    });
    const state = await getCircuitBreakerState("openai");
    expect(state).toBe("OPEN");
  });

  it("returns HALF_OPEN when OPEN duration has elapsed", async () => {
    const halfOpenAfterMs = Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS ?? 60_000);
    mockFindUnique.mockResolvedValueOnce({
      state: "OPEN",
      openedAt: new Date(Date.now() - halfOpenAfterMs - 1000),
    });
    const state = await getCircuitBreakerState("openai");
    expect(state).toBe("HALF_OPEN");
  });
});

describe("tryAcquireHalfOpenProbe", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns true when CAS update affects 1 row", async () => {
    mockQueryRaw.mockResolvedValueOnce([{ affected: 1 }]);
    const got = await tryAcquireHalfOpenProbe("gemini");
    expect(got).toBe(true);
  });

  it("returns false when CAS update affects 0 rows", async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const got = await tryAcquireHalfOpenProbe("gemini");
    expect(got).toBe(false);
  });
});

describe("recordSuccess", () => {
  afterEach(() => jest.resetAllMocks());

  it("calls upsert to reset circuit breaker to CLOSED", async () => {
    mockUpsert.mockResolvedValueOnce({});
    await recordSuccess("openai");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: "openai" } })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/circuitBreaker.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/circuitBreaker.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import { LLMProvider } from "./providers/types";
import { Prisma } from "@prisma/client";

const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 3);
const HALF_OPEN_AFTER_MS = Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS ?? 60_000);

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export async function getCircuitBreakerState(provider: LLMProvider): Promise<CircuitState> {
  const row = await prisma.llmCircuitBreaker.findUnique({ where: { provider } });
  if (!row || row.state === "CLOSED") return "CLOSED";
  if (row.state === "OPEN" && row.openedAt) {
    const elapsed = Date.now() - row.openedAt.getTime();
    if (elapsed >= HALF_OPEN_AFTER_MS) return "HALF_OPEN";
    return "OPEN";
  }
  return row.state as CircuitState;
}

export async function recordSuccess(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.upsert({
    where: { provider },
    create: { provider, state: "CLOSED", consecutiveFailures: 0 },
    update: { state: "CLOSED", consecutiveFailures: 0, openedAt: null, lastFailureAt: null },
  });
}

export async function recordFailure(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.upsert({
    where: { provider },
    create: { provider, state: "CLOSED", consecutiveFailures: 1, lastFailureAt: new Date() },
    update: {
      consecutiveFailures: { increment: 1 },
      lastFailureAt: new Date(),
      state: "CLOSED",
    },
  });

  const row = await prisma.llmCircuitBreaker.findUnique({ where: { provider } });
  if (row && row.consecutiveFailures >= FAILURE_THRESHOLD) {
    await prisma.llmCircuitBreaker.update({
      where: { provider },
      data: { state: "OPEN", openedAt: new Date() },
    });
  }
}

export async function tryAcquireHalfOpenProbe(provider: LLMProvider): Promise<boolean> {
  // Atomic CAS: transition HALF_OPEN -> PROBING only if state is still HALF_OPEN
  // We use $queryRaw to do a conditional update
  const result = await prisma.$queryRaw<Array<{ affected: number }>>(
    Prisma.sql`
      UPDATE "LlmCircuitBreaker"
      SET state = 'PROBING', updated_at = NOW()
      WHERE provider = ${provider} AND state = 'OPEN'
        AND opened_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - opened_at)) * 1000 >= ${HALF_OPEN_AFTER_MS}
      RETURNING 1 AS affected
    `
  );
  return result.length > 0;
}

export async function releaseHalfOpenProbe(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.updateMany({
    where: { provider, state: "PROBING" },
    data: { state: "OPEN" },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/circuitBreaker.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/circuitBreaker.ts src/lib/llm/__tests__/circuitBreaker.test.ts
git commit -m "feat: add circuit breaker with atomic HALF_OPEN probe CAS"
```

---

### Task 9: Advisory lock

**Files:**
- Create: `src/lib/llm/lock.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/lock.test.ts`:

```typescript
import { acquireLock, releaseLock } from "../lock";

jest.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: jest.fn() },
}));

import { prisma } from "@/lib/prisma";
const mockQuery = prisma.$queryRaw as jest.Mock;

describe("acquireLock", () => {
  afterEach(() => {
    mockQuery.mockReset();
    jest.useRealTimers();
  });

  it("returns lock context with ownerToken when insert succeeds", async () => {
    mockQuery.mockResolvedValue([{ acquired: true }]);
    const lock = await acquireLock("job123");
    expect(lock.ownerToken).toBeTruthy();
    lock.release();
  });

  it("throws when insert does not return acquired=true within retries", async () => {
    mockQuery.mockResolvedValue([]);
    await expect(acquireLock("job123", { maxRetries: 1, retryDelayMs: 0 })).rejects.toThrow("Could not acquire lock");
  });
});

describe("releaseLock", () => {
  afterEach(() => mockQuery.mockReset());

  it("calls $queryRaw to delete lock row (best-effort)", async () => {
    mockQuery.mockResolvedValue([]);
    await expect(releaseLock("job123", "token123")).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/lock.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/lock.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

const LOCK_DURATION_MS = Number(process.env.SYNC_LOCK_DURATION_MS ?? 30_000);
const HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_DURATION_MS * 0.4);

export class LockLostError extends Error {
  readonly name = "LockLostError" as const;
  constructor(jobId: string) {
    super(`Lock lost for jobId=${jobId}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type LockContext = {
  ownerToken: string;
  lockLost: { value: boolean };
  release: () => void;
};

type AcquireOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
};

export async function acquireLock(
  jobId: string,
  opts: AcquireOptions = {}
): Promise<LockContext> {
  const { maxRetries = 5, retryDelayMs = 2_000 } = opts;
  const ownerToken = randomUUID();
  const lockLost = { value: false };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await prisma.$queryRaw<Array<{ acquired: boolean }>>(
      Prisma.sql`
        INSERT INTO "SyncJobLock" (job_id, owner_token, locked_at, expires_at)
        VALUES (${jobId}, ${ownerToken}, NOW(), NOW() + INTERVAL '${Prisma.raw(String(LOCK_DURATION_MS))} milliseconds')
        ON CONFLICT (job_id)
        DO UPDATE SET
          owner_token = ${ownerToken},
          locked_at = NOW(),
          expires_at = NOW() + INTERVAL '${Prisma.raw(String(LOCK_DURATION_MS))} milliseconds'
        WHERE "SyncJobLock".expires_at < NOW()
        RETURNING TRUE AS acquired
      `
    );

    if (result.length > 0) {
      const heartbeat = setInterval(async () => {
        try {
          const renewed = await prisma.$queryRaw<Array<{ renewed: boolean }>>(
            Prisma.sql`
              UPDATE "SyncJobLock"
              SET expires_at = NOW() + INTERVAL '${Prisma.raw(String(LOCK_DURATION_MS))} milliseconds'
              WHERE job_id = ${jobId} AND owner_token = ${ownerToken}
              RETURNING TRUE AS renewed
            `
          );
          if (!renewed.length) {
            lockLost.value = true;
            clearInterval(heartbeat);
          }
        } catch {
          lockLost.value = true;
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_INTERVAL_MS);

      const release = () => {
        clearInterval(heartbeat);
        releaseLock(jobId, ownerToken).catch(() => {});
      };

      return { ownerToken, lockLost, release };
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error(`Could not acquire lock for jobId=${jobId} after ${maxRetries} retries`);
}

export async function releaseLock(jobId: string, ownerToken: string): Promise<void> {
  try {
    await prisma.$queryRaw(
      Prisma.sql`
        DELETE FROM "SyncJobLock"
        WHERE job_id = ${jobId} AND owner_token = ${ownerToken}
      `
    );
  } catch {
    // Best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/lock.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/lock.ts src/lib/llm/__tests__/lock.test.ts
git commit -m "feat: add advisory lock with heartbeat renewal and shared lockLost flag"
```

---

### Task 10: Idempotency gate

**Files:**
- Create: `src/lib/llm/idempotency.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/idempotency.test.ts`:

```typescript
import { acquireIdempotencyKey, completeIdempotencyKey } from "../idempotency";
import { ParsedEmailItem } from "../providers/types";

jest.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: jest.fn() },
}));

import { prisma } from "@/lib/prisma";
const mockQuery = prisma.$queryRaw as jest.Mock;

const cachedItems: ParsedEmailItem[] = [
  { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" },
];

describe("acquireIdempotencyKey", () => {
  afterEach(() => mockQuery.mockReset());

  it("returns {status:'claimed'} when new key is inserted", async () => {
    mockQuery.mockResolvedValueOnce([{ status: "in_flight", result: null }]);
    const result = await acquireIdempotencyKey("key1");
    expect(result.status).toBe("claimed");
  });

  it("returns {status:'complete', result} when completed row found", async () => {
    mockQuery.mockResolvedValueOnce([{ status: "complete", result: cachedItems }]);
    const result = await acquireIdempotencyKey("key1");
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.result).toEqual(cachedItems);
    }
  });
});

describe("completeIdempotencyKey", () => {
  afterEach(() => mockQuery.mockReset());

  it("calls $queryRaw to mark key as complete with result", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(completeIdempotencyKey("key1", cachedItems)).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/idempotency.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/idempotency.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ParsedEmailItem } from "./providers/types";
import { randomUUID } from "crypto";

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const IN_FLIGHT_TTL_MS = LLM_TIMEOUT_MS * 2 + 30_000;
const COMPLETE_TTL_MS = 86_400_000; // 24h
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_WAIT_MS = IN_FLIGHT_TTL_MS + 5_000;

type IdempotencyResult =
  | { status: "claimed" }
  | { status: "complete"; result: ParsedEmailItem[] };

export async function acquireIdempotencyKey(batchKey: string): Promise<IdempotencyResult> {
  const inFlightExpiry = new Date(Date.now() + IN_FLIGHT_TTL_MS).toISOString();
  const id = randomUUID();

  // Atomic upsert: insert new row as in_flight, or take over expired row,
  // or read existing complete row. Returns the winning row's status+result.
  const rows = await prisma.$queryRaw<Array<{ status: string; result: unknown }>>(
    Prisma.sql`
      INSERT INTO "LlmBatchIdempotency" (id, batch_key, status, result, created_at, expires_at)
      VALUES (${id}, ${batchKey}, 'in_flight', NULL, NOW(), ${inFlightExpiry}::timestamptz)
      ON CONFLICT (batch_key)
      DO UPDATE SET
        id = ${id},
        status = 'in_flight',
        result = NULL,
        expires_at = ${inFlightExpiry}::timestamptz
      WHERE "LlmBatchIdempotency".expires_at < NOW()
      RETURNING status, result
    `
  );

  if (!rows.length) {
    // Conflict row exists and is NOT expired — poll for completion
    return pollForCompletion(batchKey);
  }

  const row = rows[0];
  if (row.status === "complete") {
    return { status: "complete", result: row.result as ParsedEmailItem[] };
  }
  return { status: "claimed" };
}

async function pollForCompletion(batchKey: string): Promise<IdempotencyResult> {
  const deadline = Date.now() + POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const rows = await prisma.$queryRaw<Array<{ status: string; result: unknown }>>(
      Prisma.sql`
        SELECT status, result FROM "LlmBatchIdempotency"
        WHERE batch_key = ${batchKey}
      `
    );
    if (!rows.length) {
      // Row expired/deleted — claim it fresh
      return acquireIdempotencyKey(batchKey);
    }
    const row = rows[0];
    if (row.status === "complete") {
      return { status: "complete", result: row.result as ParsedEmailItem[] };
    }
    // Still in_flight — keep polling
  }
  // Timed out waiting — claim it (expired row takeover)
  return acquireIdempotencyKey(batchKey);
}

export async function completeIdempotencyKey(
  batchKey: string,
  result: ParsedEmailItem[]
): Promise<void> {
  const completeExpiry = new Date(Date.now() + COMPLETE_TTL_MS).toISOString();
  await prisma.$queryRaw(
    Prisma.sql`
      UPDATE "LlmBatchIdempotency"
      SET status = 'complete', result = ${JSON.stringify(result)}::jsonb, expires_at = ${completeExpiry}::timestamptz
      WHERE batch_key = ${batchKey} AND status = 'in_flight'
    `
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/idempotency.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/idempotency.ts src/lib/llm/__tests__/idempotency.test.ts
git commit -m "feat: add idempotency gate with atomic upsert, poll, and 24h complete TTL"
```

---

### Task 11: Provider router

**Files:**
- Create: `src/lib/llm/router.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/router.test.ts`:

```typescript
import { selectProvider } from "../router";

jest.mock("../quota");
jest.mock("../circuitBreaker");

import * as quota from "../quota";
import * as cb from "../circuitBreaker";

const mockCheckQuota = quota.checkQuota as jest.Mock;
const mockReserveQuota = quota.reserveQuota as jest.Mock;
const mockGetState = cb.getCircuitBreakerState as jest.Mock;
const mockTryProbe = cb.tryAcquireHalfOpenProbe as jest.Mock;

describe("selectProvider", () => {
  beforeEach(() => {
    mockCheckQuota.mockResolvedValue({ allowed: true });
    mockReserveQuota.mockResolvedValue(true);
    mockGetState.mockResolvedValue("CLOSED");
    mockTryProbe.mockResolvedValue(true);
  });
  afterEach(() => jest.resetAllMocks());

  it("selects gemini when candidateCount <= threshold", async () => {
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("gemini");
  });

  it("selects openai when candidateCount > threshold", async () => {
    const result = await selectProvider(15, 200, 100);
    expect(result.provider).toBe("openai");
  });

  it("falls back to secondary when primary quota denied", async () => {
    mockCheckQuota
      .mockResolvedValueOnce({ allowed: false, reason: "rpm" })
      .mockResolvedValueOnce({ allowed: true });
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });

  it("throws when both providers fail quota", async () => {
    mockCheckQuota.mockResolvedValue({ allowed: false, reason: "rpd" });
    await expect(selectProvider(5, 50, 50)).rejects.toThrow();
  });

  it("skips OPEN circuit and uses fallback", async () => {
    mockGetState
      .mockResolvedValueOnce("OPEN")
      .mockResolvedValueOnce("CLOSED");
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/router.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/router.ts`**

```typescript
import { LLMProvider, ProviderExhaustedError } from "./providers/types";
import { checkQuota, reserveQuota, releaseQuota } from "./quota";
import { getCircuitBreakerState, tryAcquireHalfOpenProbe, releaseHalfOpenProbe } from "./circuitBreaker";

const CANDIDATE_THRESHOLD = Number(process.env.LLM_CANDIDATE_THRESHOLD ?? 10);

export type SelectedProvider = {
  provider: LLMProvider;
  isHalfOpenProbe: boolean;
  reservedInputTokens: number;
  reservedOutputTokens: number;
};

function getPrimaryProvider(candidateCount: number): LLMProvider {
  return candidateCount <= CANDIDATE_THRESHOLD ? "gemini" : "openai";
}

function getFallbackProvider(primary: LLMProvider): LLMProvider {
  return primary === "gemini" ? "openai" : "gemini";
}

export async function selectProvider(
  candidateCount: number,
  estimatedInputTokens: number,
  estimatedOutputTokens: number
): Promise<SelectedProvider> {
  const primary = getPrimaryProvider(candidateCount);
  const fallback = getFallbackProvider(primary);

  // Phase 1: Read-only checks for both providers
  const [primaryState, fallbackState] = await Promise.all([
    getCircuitBreakerState(primary),
    getCircuitBreakerState(fallback),
  ]);

  const [primaryQuota, fallbackQuota] = await Promise.all([
    primaryState !== "OPEN"
      ? checkQuota(primary, 1)
      : Promise.resolve({ allowed: false, reason: "circuit open" }),
    fallbackState !== "OPEN"
      ? checkQuota(fallback, 1)
      : Promise.resolve({ allowed: false, reason: "circuit open" }),
  ]);

  // Phase 2: Single atomic reserve+probe for chosen provider
  const tryProvider = async (
    provider: LLMProvider,
    state: "CLOSED" | "OPEN" | "HALF_OPEN",
    quotaAllowed: boolean
  ): Promise<SelectedProvider | null> => {
    if (!quotaAllowed) return null;
    if (state === "OPEN") return null;

    let isHalfOpenProbe = false;
    if (state === "HALF_OPEN") {
      const acquired = await tryAcquireHalfOpenProbe(provider);
      if (!acquired) return null;
      isHalfOpenProbe = true;
    }

    const reserved = await reserveQuota(provider, 1, estimatedInputTokens, estimatedOutputTokens);
    if (!reserved) {
      if (isHalfOpenProbe) await releaseHalfOpenProbe(provider);
      return null;
    }

    return { provider, isHalfOpenProbe, reservedInputTokens: estimatedInputTokens, reservedOutputTokens: estimatedOutputTokens };
  };

  const primaryResult = await tryProvider(primary, primaryState, primaryQuota.allowed);
  if (primaryResult) return primaryResult;

  const fallbackResult = await tryProvider(fallback, fallbackState, fallbackQuota.allowed);
  if (fallbackResult) return fallbackResult;

  throw new ProviderExhaustedError(primary, fallback);
}

export { releaseQuota };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/router.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/router.ts src/lib/llm/__tests__/router.test.ts
git commit -m "feat: add provider router — read-phase checks then single atomic reserve+probe"
```

---

### Task 12: Orchestration layer (index.ts)

**Files:**
- Create: `src/lib/llm/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/index.test.ts`:

```typescript
import { parseEmailBatchLLM } from "../index";
import { LlmCallContext } from "../providers/types";

jest.mock("../router");
jest.mock("../providers/gemini");
jest.mock("../providers/openai");
jest.mock("../validate");
jest.mock("../circuitBreaker");
jest.mock("@/lib/prisma", () => ({
  prisma: { llmCallLog: { create: jest.fn() } },
}));

import * as router from "../router";
import * as gemini from "../providers/gemini";
import * as validate from "../validate";
import * as cb from "../circuitBreaker";
import { prisma } from "@/lib/prisma";

const mockSelectProvider = router.selectProvider as jest.Mock;
const mockCallGemini = gemini.callGeminiEmailBatch as jest.Mock;
const mockValidate = validate.validateProviderResults as jest.Mock;
const mockRecordSuccess = cb.recordSuccess as jest.Mock;
const mockLogCreate = prisma.llmCallLog.create as jest.Mock;

const ctx: LlmCallContext = { userId: "u1", syncJobId: "s1", operationType: "sync" };

describe("parseEmailBatchLLM", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns validated results on success and writes LlmCallLog", async () => {
    const selected = { provider: "gemini", isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50 };
    mockSelectProvider.mockResolvedValue(selected);
    const rawItem = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockCallGemini.mockResolvedValue({ items: [rawItem], inputTokens: 100, outputTokens: 50 });
    mockValidate.mockReturnValue([rawItem]);
    mockRecordSuccess.mockResolvedValue(undefined);
    mockLogCreate.mockResolvedValue({});

    const result = await parseEmailBatchLLM(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "batchkey1",
      ctx
    );

    expect(result).toHaveLength(1);
    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "gemini", outcome: "success" }),
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/llm/__tests__/index.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/llm/index.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import {
  LLMProvider,
  ParsedEmailItem,
  StatementItem,
  LlmCallContext,
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
  ProviderExhaustedError,
} from "./providers/types";
import { selectProvider, releaseQuota, SelectedProvider } from "./router";
import { callGeminiEmailBatch, callGeminiStatement } from "./providers/gemini";
import { callOpenAIEmailBatch, callOpenAIStatement } from "./providers/openai";
import { validateProviderResults } from "./validate";
import { recordSuccess, recordFailure, releaseHalfOpenProbe } from "./circuitBreaker";
import { estimateInputTokens, estimateOutputTokens } from "./prompts";
import { acquireIdempotencyKey, completeIdempotencyKey } from "./idempotency";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

type EmailInput = { emailIndex: number; body: string; senderName: string; fallbackDate: string };

function isRetryableError(err: unknown): boolean {
  return (
    err instanceof ProviderRateLimitError ||
    err instanceof ProviderServerError ||
    err instanceof ProviderTimeoutError ||
    err instanceof ProviderParseError
  );
}

async function logAttempt(
  ctx: LlmCallContext,
  batchKey: string | null,
  selected: SelectedProvider,
  attemptNumber: number,
  wasFallback: boolean,
  fallbackReason: string | null,
  outcome: string,
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
  errorDetail: string | null
): Promise<void> {
  try {
    await prisma.llmCallLog.create({
      data: {
        syncJobId: ctx.syncJobId ?? null,
        userId: ctx.userId,
        batchKey,
        provider: selected.provider,
        model: selected.provider === "gemini"
          ? (process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite")
          : (process.env.OPENAI_MODEL ?? "gpt-5-nano-2025-08-07"),
        candidateCount: 0,
        attemptNumber,
        wasFallback,
        fallbackReason,
        outcome,
        errorDetail,
        latencyMs,
        inputTokens,
        outputTokens,
        estimatedCostUsd: 0,
      },
    });
  } catch {
    // Logging failure is non-fatal
  }
}

async function callProvider(
  provider: LLMProvider,
  inputs: EmailInput[]
) {
  if (provider === "gemini") {
    return callGeminiEmailBatch(inputs, GEMINI_API_KEY);
  }
  return callOpenAIEmailBatch(inputs, OPENAI_API_KEY);
}

export async function parseEmailBatchLLM(
  inputs: EmailInput[],
  batchKey: string,
  ctx: LlmCallContext
): Promise<ParsedEmailItem[]> {
  // Idempotency check first — atomic claim or cached result
  const idempResult = await acquireIdempotencyKey(batchKey);
  if (idempResult.status === "complete") {
    return idempResult.result;
  }

  const estimatedInput = estimateInputTokens(inputs);
  const estimatedOutput = estimateOutputTokens(inputs.length);

  let selected: SelectedProvider;
  try {
    selected = await selectProvider(inputs.length, estimatedInput, estimatedOutput);
  } catch (err) {
    if (err instanceof ProviderExhaustedError) {
      throw err;
    }
    throw err;
  }

  const primaryProvider = selected.provider;
  const fallbackProvider: LLMProvider = primaryProvider === "gemini" ? "openai" : "gemini";
  let attemptNumber = 1;
  let fallbackReason: string | null = null;
  let currentSelected = selected;

  const attempt = async (): Promise<ParsedEmailItem[]> => {
    const start = Date.now();
    try {
      const callResult = await callProvider(currentSelected.provider, inputs);
      const validated = validateProviderResults(callResult.items, inputs.length, currentSelected.provider);
      const latencyMs = Date.now() - start;

      await logAttempt(
        ctx, batchKey, currentSelected, attemptNumber, attemptNumber > 1,
        fallbackReason, "success", latencyMs,
        callResult.inputTokens, callResult.outputTokens, null
      );
      await recordSuccess(currentSelected.provider);
      if (currentSelected.isHalfOpenProbe) {
        // Probe succeeded — circuit already reset by recordSuccess
      }

      await completeIdempotencyKey(batchKey, validated);
      return validated;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errDetail = err instanceof Error ? err.message : String(err);

      await logAttempt(
        ctx, batchKey, currentSelected, attemptNumber, attemptNumber > 1,
        fallbackReason, "error", latencyMs, 0, 0, errDetail
      );

      if (!isRetryableError(err)) throw err;

      await recordFailure(currentSelected.provider);
      if (currentSelected.isHalfOpenProbe) {
        await releaseHalfOpenProbe(currentSelected.provider);
      }

      if (attemptNumber === 1) {
        // Try fallback
        attemptNumber = 2;
        fallbackReason = errDetail;

        const fallbackEstInput = estimateInputTokens(inputs);
        const fallbackEstOutput = estimateOutputTokens(inputs.length);
        const fallbackSelected = await selectProvider(
          inputs.length, fallbackEstInput, fallbackEstOutput
        ).catch(() => null);

        if (!fallbackSelected || fallbackSelected.provider !== fallbackProvider) {
          throw new ProviderExhaustedError(primaryProvider, fallbackProvider);
        }

        if (currentSelected.isHalfOpenProbe) {
          await releaseQuota(
            currentSelected.provider, 1,
            currentSelected.reservedInputTokens,
            currentSelected.reservedOutputTokens
          );
        }

        currentSelected = fallbackSelected;
        return attempt();
      }

      throw new ProviderExhaustedError(primaryProvider, fallbackProvider);
    }
  };

  return attempt();
}

export async function parseStatementLLM(
  body: string,
  ctx: LlmCallContext
): Promise<StatementItem[]> {
  const estimatedInput = Math.ceil(body.length / 4);
  const estimatedOutput = 200;

  const selected = await selectProvider(1, estimatedInput, estimatedOutput);
  const start = Date.now();

  try {
    let result;
    if (selected.provider === "gemini") {
      result = await callGeminiStatement(body, GEMINI_API_KEY);
    } else {
      result = await callOpenAIStatement(body, OPENAI_API_KEY);
    }
    const latencyMs = Date.now() - start;

    await logAttempt(ctx, null, selected, 1, false, null, "success", latencyMs,
      result.inputTokens, result.outputTokens, null);
    await recordSuccess(selected.provider);

    return result.items;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errDetail = err instanceof Error ? err.message : String(err);
    await logAttempt(ctx, null, selected, 1, false, null, "error", latencyMs, 0, 0, errDetail);
    await recordFailure(selected.provider);
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/lib/llm/__tests__/index.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Run all LLM tests together**

```bash
npx jest src/lib/llm/__tests__/ --no-coverage 2>&1 | tail -20
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/index.ts src/lib/llm/__tests__/index.test.ts
git commit -m "feat: add LLM orchestration layer — idempotency gate, provider selection, fallback, per-attempt logging"
```

---

### Task 13: Wire advance/route.ts

**Files:**
- Modify: `src/app/api/gmail/sync/advance/route.ts`

- [ ] **Step 1: Read current file and understand existing Gemini call site**

The Gemini call is at lines 366-379 (approximately). Key changes needed:
1. Replace import `parseEmailBatch` from `@/lib/gemini` with `parseEmailBatchLLM` from `@/lib/llm`
2. Remove imports of `checkGeminiRateLimit`, `incrementGeminiUsage` from `@/lib/geminiRateLimit`
3. Remove `const apiKey = process.env.GEMINI_API_KEY` (line 44)
4. Add lock acquisition at job start using `acquireLock` from `@/lib/llm/lock`
5. Check `lockLost.value` before each `upsertTransactionV2`/`ParseLog` write
6. Replace the Gemini rate-check + `parseEmailBatch` call block with `acquireIdempotencyKey` → idempotency check before route, then `parseEmailBatchLLM`
7. Rename `geminiQueue` → `llmQueue`, `geminiNeeded` → `llmCandidates` for clarity

- [ ] **Step 2: Update imports (top of file)**

Replace:
```typescript
import { parseEmailBatch, type BatchInput } from "@/lib/gemini";
```
With:
```typescript
import { parseEmailBatchLLM } from "@/lib/llm";
import type { BatchInput } from "@/lib/gemini";
```

Remove this entire import line:
```typescript
import { checkGeminiRateLimit, incrementGeminiUsage } from "@/lib/geminiRateLimit";
```

Add after the existing imports:
```typescript
import { acquireLock, LockLostError } from "@/lib/llm/lock";
import { createHash } from "crypto";
```

- [ ] **Step 3: Remove apiKey variable**

Remove the line (around line 44):
```typescript
const apiKey = process.env.GEMINI_API_KEY ?? "";
```

- [ ] **Step 4: Add lock acquisition around the main job processing block**

In the `POST` handler, find where the sync job processing begins (after the sync job is fetched/created). Wrap the main processing block with lock acquisition:

```typescript
// After syncJob is created/fetched, before processing loop:
const lock = await acquireLock(syncJob.id).catch(() => null);
if (!lock) {
  return NextResponse.json({ error: "Another instance is processing this job" }, { status: 409 });
}

try {
  // ... existing processing logic ...
} finally {
  lock.release();
}
```

- [ ] **Step 5: Add lockLost checks before each DB write**

Find every call to `upsertTransactionV2` and `prisma.parseLog.create/update` inside the processing loop. Before each one, add:

```typescript
if (lock.lockLost.value) throw new LockLostError(syncJob.id);
```

- [ ] **Step 6: Replace Gemini rate-limit check + parseEmailBatch call**

Find the block (lines ~366-379) that looks like:

```typescript
const rateCheck = await checkGeminiRateLimit();
if (!rateCheck.allowed) { ... }
const geminiResults = await parseEmailBatch(geminiQueue.map(...), apiKey);
await incrementGeminiUsage();
```

Replace with:

```typescript
const batchKey = createHash("sha256")
  .update(`${userId}:sync:v1:${llmQueue.map((e) => e.gmailMsgId).sort().join(",")}`)
  .digest("hex");

const llmContext = { userId, syncJobId: syncJob.id, operationType: "sync" };
const llmResults = await parseEmailBatchLLM(
  llmQueue.map((e, i) => ({
    emailIndex: i,
    body: e.body,
    senderName: e.senderName,
    fallbackDate: e.fallbackDate,
  })),
  batchKey,
  llmContext
);
```

- [ ] **Step 7: Update all references from geminiQueue/geminiResults to llmQueue/llmResults**

```bash
grep -n "geminiQueue\|geminiResults\|geminiNeeded\|gemini_" src/app/api/gmail/sync/advance/route.ts
```

Rename throughout:
- `geminiQueue` → `llmQueue`
- `geminiNeeded` → `llmCandidates`
- `geminiResults` → `llmResults`

- [ ] **Step 8: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "advance/route"
```

Expected: no errors for advance/route.ts

- [ ] **Step 9: Commit**

```bash
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "feat: wire advance/route.ts to LLM routing layer with lock and idempotency"
```

---

### Task 14: Wire reconcile/route.ts

**Files:**
- Modify: `src/app/api/gmail/reconcile/route.ts`

- [ ] **Step 1: Update imports**

At the top of the file, add:
```typescript
import { parseStatementLLM } from "@/lib/llm";
```

Remove:
```typescript
// The local STATEMENT_SYSTEM_PROMPT constant and callGeminiForStatement function
// will be deleted (prompts moved to src/lib/llm/prompts.ts)
```

- [ ] **Step 2: Remove local prompt constant and callGeminiForStatement function**

Delete lines 12-76 (the `STATEMENT_SYSTEM_PROMPT` const and `callGeminiForStatement` function).

- [ ] **Step 3: Replace the callGeminiForStatement call**

Find (around line 104-106):
```typescript
const apiKey = process.env.GEMINI_API_KEY ?? "";
const geminiRaw = await callGeminiForStatement(statement.body, apiKey);
const rawItems = parseStatementItems(geminiRaw);
```

Replace with:
```typescript
const llmContext = { userId, operationType: "reconcile" };
const statementItems = await parseStatementLLM(statement.body, llmContext);
const items = statementItems
  .map((raw) => normaliseStatementItem(raw))
  .filter((item): item is NonNullable<typeof item> => item !== null);
```

Also remove the `rawItems` → `items` pipeline that follows (since we now get `items` directly).

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "reconcile/route"
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/app/api/gmail/reconcile/route.ts
git commit -m "feat: wire reconcile/route.ts to parseStatementLLM"
```

---

### Task 15: Wire reprocess/route.ts

**Files:**
- Modify: `src/app/api/settings/parse-logs/[id]/reprocess/route.ts`

- [ ] **Step 1: Update imports**

Replace:
```typescript
import { parseEmailBatch } from "@/lib/gemini";
```
With:
```typescript
import { parseEmailBatchLLM } from "@/lib/llm";
import { createHash } from "crypto";
```

Remove:
```typescript
// apiKey is no longer needed locally
```

- [ ] **Step 2: Remove apiKey variable**

Remove (around line 60):
```typescript
const apiKey = process.env.GEMINI_API_KEY ?? "";
```

- [ ] **Step 3: Replace parseEmailBatch call**

Find (lines 82-85):
```typescript
const results = await parseEmailBatch(
  [{ emailIndex: 0, body: msg.body, senderName: msg.senderName, fallbackDate: msg.receivedDate }],
  apiKey
);
```

Replace with:
```typescript
const batchKey = createHash("sha256")
  .update(`${userId}:reprocess:v1:${log.gmailMsgId}`)
  .digest("hex");

const llmContext = { userId, syncJobId: log.syncJobId, operationType: "reprocess" };
const results = await parseEmailBatchLLM(
  [{ emailIndex: 0, body: msg.body, senderName: msg.senderName, fallbackDate: msg.receivedDate }],
  batchKey,
  llmContext
);
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "reprocess/route"
```

Expected: no errors

- [ ] **Step 5: Full TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to LLM routing)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/parse-logs/[id]/reprocess/route.ts
git commit -m "feat: wire reprocess/route.ts to parseEmailBatchLLM with idempotency"
```

---

### Task 16: Parity smoke test and env vars

**Files:**
- No new files

- [ ] **Step 1: Add required env vars to .env.local**

Add to `.env.local` (do NOT commit this file):

```
OPENAI_API_KEY=sk-...your-key...
OPENAI_MODEL=gpt-5-nano-2025-08-07
GEMINI_MODEL=gemini-3.1-flash-lite
LLM_CANDIDATE_THRESHOLD=10
LLM_TIMEOUT_MS=30000
GEMINI_RPM_LIMIT=12
GEMINI_TPM_LIMIT=32000
GEMINI_RPD_LIMIT=1120
OPENAI_RPM_LIMIT=480
OPENAI_TPM_LIMIT=160000
OPENAI_RPD_LIMIT=9000
CIRCUIT_BREAKER_FAILURE_THRESHOLD=3
CIRCUIT_BREAKER_HALF_OPEN_MS=60000
SYNC_LOCK_DURATION_MS=30000
```

Also add to Vercel dashboard environment variables (Settings → Environment Variables) for production.

- [ ] **Step 2: Run full test suite**

```bash
npx jest src/lib/llm/ --no-coverage 2>&1 | tail -30
```

Expected: All tests PASS

- [ ] **Step 3: Start dev server and verify app loads**

```bash
npm run dev
```

Navigate to `http://localhost:3000`. Confirm:
- Dashboard loads without errors
- Transactions page loads
- No console errors about broken Gemini model

- [ ] **Step 4: Trigger a sync and verify LlmCallLog rows appear**

In the app, trigger a Gmail sync. Then verify:

```bash
npx prisma studio
```

Open `LlmCallLog` table — should see rows with provider, outcome, latency.

- [ ] **Step 5: Verify GeminiUsageLog is no longer being written**

Trigger another sync. Check that `GeminiUsageLog` is not receiving new rows (it's now superseded by `LlmQuotaWindow`).

- [ ] **Step 6: Final commit**

```bash
git add .env.example  # If you maintain an example env file
git commit -m "feat: dual-provider LLM routing complete — OpenAI primary, Gemini fallback, quota/circuit/idempotency/lock"
```

---

## Post-Implementation Checklist

- [ ] All 16 tasks above completed
- [ ] `npx tsc --noEmit` passes clean
- [ ] `npx jest src/lib/llm/` passes all tests
- [ ] `LlmCallLog` rows appear after a sync
- [ ] `LlmQuotaWindow` rows are created/incremented
- [ ] `LlmCircuitBreaker` rows exist for both providers in CLOSED state
- [ ] Reprocess endpoint works for a known-transaction email
- [ ] Reconcile endpoint no longer calls the broken `gemini-flash-latest` model
- [ ] No `GEMINI_API_KEY` reads outside `src/lib/llm/`
- [ ] No `OPENAI_API_KEY` reads outside `src/lib/llm/`
