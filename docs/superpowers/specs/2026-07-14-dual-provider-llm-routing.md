# Dual-Provider LLM Routing — Design Spec

**Date:** 2026-07-14  
**Status:** Approved — implementation plan pending  
**Scope:** Replace direct Gemini calls with a provider-routing layer that uses OpenAI (`gpt-5-nano`) as primary or fallback depending on LLM candidate count and estimated token usage, with circuit breaker, quota tracking, structured per-attempt logging, and idempotency guarantees.

---

## 1. Motivation

- `gemini-2.0-flash-lite` was shut down on 2026-06-01. The app is currently broken in production for any email that escapes static/template parsing.
- `reconcile/route.ts` calls `gemini-flash-latest` — also a deprecated alias.
- A single provider with no fallback is a single point of failure.
- Free-tier Gemini limits (RPM, TPM, RPD) vary by account tier and are not safe to hardcode.
- No visibility into which provider handled each parse, at what latency, cost, or whether a fallback occurred.

---

## 2. Goals

1. Fix the production outage: replace `gemini-2.0-flash-lite` with `gemini-3.1-flash-lite`.
2. Add OpenAI `gpt-5-nano` as a second provider.
3. Route to the cheapest available provider using LLM candidate count plus estimated token usage.
4. Fallback automatically on 429, 5xx, timeout, and network/parse errors. Fail fast on 400, 401, and 403 (no fallback — these require operator action).
5. Track per-provider quota (RPM, TPM, RPD) atomically across all users and Vercel instances in the DB. Quota check and quota reservation are separate operations — reservation only after final provider selection.
6. Emit one `LlmCallLog` row per provider attempt, written inside the LLM orchestration layer on every exit path including thrown failures.
7. Circuit breaker per provider — stop routing to a degraded provider after N consecutive failures. HALF_OPEN probe acquired only after quota reservation, not during read-only check.
8. Prevent duplicate LLM calls on retry: write idempotency key `"in_flight"` before calling; update to `"complete"` after. In-flight expiry covers primary + fallback duration.
9. Per-job advisory lock with `ownerToken`, heartbeat renewal, atomic stale-lock replacement, and abort on renewal failure.
10. All limits, thresholds, model names, and timeouts configurable via environment variables.

---

## 3. Out of Scope

- Changing the static parser, template cache, or exact result cache logic.
- Per-user bring-your-own-key support.
- Sub-batching a single chunk (25 emails into smaller groups) — keep one LLM call per tick unless response-quality tests justify splitting.

---

## 4. New Files

```
src/lib/llm/
  index.ts          — public entry point: parseEmailBatchLLM(), parseStatementLLM()
  router.ts         — provider selection, quota check, fallback orchestration
  providers/
    gemini.ts       — Gemini HTTP adapter
    openai.ts       — OpenAI HTTP adapter
    types.ts        — EmailParseResult, LLMProvider, ProviderError subtypes, LLMAttemptMeta
  prompts.ts        — shared system prompts, user prompt builders, JSON schema, token estimates, SCHEMA_VERSION
  quota.ts          — DB-backed quota tracking: checkQuota(), reserveQuota()
  circuitBreaker.ts — per-provider circuit breaker with atomic HALF_OPEN probe
  idempotency.ts    — in-flight / complete idempotency key management
  lock.ts           — SyncJobLock acquire, renew, release with ownerToken
  validate.ts       — runtime result validation for both providers
```

Existing files changed:
- `src/lib/gemini.ts` — internal only, no longer imported by routes
- `src/app/api/gmail/sync/advance/route.ts` — use `parseEmailBatchLLM()`, acquire `SyncJobLock`
- `src/app/api/gmail/reconcile/route.ts` — use `parseStatementLLM()`
- `src/app/api/settings/parse-logs/[id]/reprocess/route.ts` — use `parseEmailBatchLLM()`
- `prisma/schema.prisma` — new models below

---

## 5. Shared Types (`providers/types.ts`)

```typescript
// Replaces GeminiEmailResult everywhere
export type EmailParseResult = {
  emailIndex: number;
  isTransaction: boolean;
  transactions: ParsedTransaction[];
  outcome: "parsed" | "not_transaction" | "parse_failed" | "insufficient_data";
  bodyLengthRaw: number;
  bodyLengthSent: number;
  wasTruncated: boolean;
  errorDetail?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
};

export type LLMProvider = "gemini" | "openai";

// Typed errors — callers instanceof-check to decide fallback vs fail-fast
export class ProviderBadRequestError extends Error {
  // HTTP 400 — malformed payload or schema violation (our bug, not auth)
  constructor(public provider: LLMProvider, public statusCode: 400) { super(); }
}
export class ProviderAuthError extends Error {
  // HTTP 401 | 403 — invalid or missing API key (operator config problem)
  constructor(public provider: LLMProvider, public statusCode: 401 | 403) { super(); }
}
export class ProviderRateLimitError extends Error {
  constructor(public provider: LLMProvider, public retryAfterMs?: number) { super(); }
}
export class ProviderServerError extends Error {
  constructor(public provider: LLMProvider, public statusCode: number) { super(); }
}
export class ProviderTimeoutError extends Error {
  constructor(public provider: LLMProvider) { super(); }
}
export class ProviderParseError extends Error {
  constructor(public provider: LLMProvider) { super(); }
}
export class LockLostError extends Error {
  constructor(public jobId: string) { super(`Lock lost for job ${jobId}`); }
}

// Metadata for one provider attempt — one LlmCallLog row per attempt
export type LLMAttemptMeta = {
  provider: LLMProvider;
  model: string;
  attemptNumber: number;       // 1 = primary, 2 = fallback
  wasFallback: boolean;
  fallbackReason?: string;
  outcome: "success" | "error";
  errorDetail?: string;
  latencyMs: number;
  inputTokens: number;         // from provider response when available, else estimated
  outputTokens: number;
  estimatedCostUsd: number;    // Decimal-compatible — stored as Prisma Decimal in DB
};
```

---

## 6. Shared Prompts, Schema, Validation & Token Estimates (`prompts.ts`, `validate.ts`)

### `prompts.ts`

Single source of truth — both adapters import from here, no prompt duplication.

- `SCHEMA_VERSION = "v1"` — bump when prompts or schema change; included in `batchKey` so cached results from old schema versions are never reused
- `BATCH_SYSTEM_PROMPT` — existing text, unchanged
- `STATEMENT_SYSTEM_PROMPT` — existing text, unchanged
- `buildBatchUserPrompt(items)` — existing builder, unchanged
- `EMAIL_JSON_SCHEMA` — JSON Schema object used by both providers for schema-constrained output

### Token estimation

```typescript
export const TOKEN_ESTIMATE = {
  SYSTEM_PROMPT:  350,
  SCHEMA:         150,
  PER_EMAIL_BODY: 375,   // avg tokens per 1500-char body
  PER_EMAIL_OUT:  200,
  SAFETY_MARGIN:  1.2,
} as const;

export function estimateBatchTokens(candidateCount: number): {
  inputTokens: number; outputTokens: number;
} {
  const input = Math.ceil(
    (TOKEN_ESTIMATE.SYSTEM_PROMPT + TOKEN_ESTIMATE.SCHEMA +
      candidateCount * TOKEN_ESTIMATE.PER_EMAIL_BODY) * TOKEN_ESTIMATE.SAFETY_MARGIN
  );
  const output = Math.ceil(candidateCount * TOKEN_ESTIMATE.PER_EMAIL_OUT * TOKEN_ESTIMATE.SAFETY_MARGIN);
  return { inputTokens: input, outputTokens: output };
}

// Statement routing uses actual body length, not candidateCount
export function estimateStatementTokens(bodyLength: number): {
  inputTokens: number; outputTokens: number;
} {
  const bodyTokens = Math.ceil(bodyLength / 4);
  const input = Math.ceil((TOKEN_ESTIMATE.SYSTEM_PROMPT + bodyTokens) * TOKEN_ESTIMATE.SAFETY_MARGIN);
  const output = Math.ceil(500 * TOKEN_ESTIMATE.SAFETY_MARGIN);
  return { inputTokens: input, outputTokens: output };
}
```

### `validate.ts` — runtime result validation

Both adapters call `validateProviderResults(raw, candidateCount, provider)` before returning. This prevents silent data corruption from LLM output that passes JSON parse but violates the contract.

```typescript
export function validateProviderResults(
  raw: unknown,
  candidateCount: number,
  provider: LLMProvider
): EmailParseResult[]
```

Validation rules:
1. `raw` is an array with length === `candidateCount` — if not, throw `ProviderParseError`
2. Each item has `emailIndex: number`; the set of all `emailIndex` values must be exactly `{0, 1, …, candidateCount-1}` — no duplicates, no gaps, no out-of-range values. If violated, throw `ProviderParseError`.
3. Each item has `isTransaction: boolean`, `outcome: string` (one of valid values), `transactions: array`
4. Each transaction has `amount: number > 0`, `merchant: string`, `date: string`, `type: "expense"|"income"`
5. Items that fail field validation get `outcome: "parse_failed"` and empty `transactions` — they do not throw; only structural failures (wrong count, bad `emailIndex` set) throw `ProviderParseError`

---

## 7. Provider Adapters

### Gemini (`providers/gemini.ts`)

- Model: `process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite"` — fixes the outage
- JSON mode: `generationConfig.responseMimeType: "application/json"` AND `generationConfig.responseSchema: EMAIL_JSON_SCHEMA` (camelCase field, v1beta REST API). MIME type alone does not enforce schema shape. The SDK uses a different surface (`responseFormat.text.mimeType/schema`) — since the codebase uses raw `fetch`, use the REST API field names directly.
- `temperature: 0`
- Response path: `candidates[0].content.parts[0].text`
- Timeout: `Number(process.env.LLM_TIMEOUT_MS ?? 30000)`
- Token usage: `usageMetadata.promptTokenCount` and `candidatesTokenCount` — use when present, fall back to estimates
- After JSON parse: call `validateProviderResults(parsed, candidateCount, "gemini")`
- Error mapping:
  - HTTP 400 → `ProviderBadRequestError` (fail fast)
  - HTTP 401 | 403 → `ProviderAuthError` (fail fast)
  - HTTP 429 → `ProviderRateLimitError` (fallback eligible)
  - HTTP 5xx → `ProviderServerError` (fallback eligible)
  - fetch timeout → `ProviderTimeoutError` (fallback eligible)
  - JSON parse or validation failure → `ProviderParseError` (fallback eligible)

### OpenAI (`providers/openai.ts`)

- Model: `process.env.OPENAI_MODEL ?? "gpt-5-nano"`
- JSON mode: `response_format: { type: "json_schema", json_schema: { name: "email_parse", schema: EMAIL_JSON_SCHEMA, strict: true } }`, `temperature: 0`
- Response path: `choices[0].message.content`
- Token usage: exact from `usage.prompt_tokens` and `usage.completion_tokens`
- After JSON parse: call `validateProviderResults(parsed, candidateCount, "openai")`
- Same error mapping as Gemini adapter

---

## 8. Quota Tracking (`quota.ts`)

Tracks RPM, TPM, and RPD per provider using DB fixed time buckets shared across all Vercel instances.

> **Note:** This implementation uses fixed minute/day buckets, not true sliding windows. A burst at :59 and :00 can momentarily double the effective RPM. This is an accepted tradeoff — true sliding windows require per-request timestamps and are expensive. The configured limits should be set conservatively (e.g. 80% of the actual provider limit) to absorb boundary bursts.

**Provider-specific token accounting:**
- Gemini TPM: counts `inputTokens` only (free tier measures prompt tokens)
- OpenAI TPM: counts `inputTokens + outputTokens`
- RPM: counts requests (1 per call) for both providers
- RPD: counts requests (1 per call) for both providers

### DB model

```prisma
model LlmQuotaWindow {
  id          String   @id @default(cuid())
  provider    String   // "gemini" | "openai"
  windowType  String   // "rpm" | "tpm" | "rpd"
  windowKey   String   // "2026-07-14T10:23" (minute bucket) | "2026-07-14" (day bucket)
  count       Int      @default(0)
  updatedAt   DateTime @updatedAt

  @@unique([provider, windowType, windowKey])
  @@index([provider, windowType, windowKey])
}
```

### Separate check and reservation

**`checkQuota`** (read-only, no writes — safe to call for both providers):
```typescript
async function checkQuota(
  provider: LLMProvider,
  inputTokens: number,
  outputTokens: number
): Promise<{ allowed: boolean; reason?: string }>
```
Computes the correct TPM delta per provider (Gemini: `inputTokens`; OpenAI: `inputTokens + outputTokens`). Reads current window counts and returns `allowed: false` if any limit would be exceeded.

**`reserveQuota`** (atomic write — called only after final provider selection and HALF_OPEN probe win):
```typescript
async function reserveQuota(
  provider: LLMProvider,
  inputTokens: number,
  outputTokens: number
): Promise<void>
```
Uses serializable `$transaction` with CAS conditional updates:
```sql
UPDATE LlmQuotaWindow
SET count = count + $delta
WHERE provider = $p AND windowType = $type AND windowKey = $key
  AND count + $delta <= $limit
```
If any CAS guard fails (concurrent instance pushed over limit), throws `ProviderRateLimitError`.

**`releaseQuota`** (negating write — called only when HALF_OPEN probe CAS loses after quota was already reserved):
```typescript
async function releaseQuota(
  provider: LLMProvider,
  inputTokens: number,
  outputTokens: number
): Promise<void>
```
Decrements the same windows that `reserveQuota` incremented. Best-effort (no CAS guard — the count can only go down). Called synchronously inside `selectProvider` before routing to the other provider.

### Environment variables

```
GEMINI_RPM_LIMIT    default: 15        (verify in AI Studio — varies by account)
GEMINI_TPM_LIMIT    default: 250000    (input tokens only for Gemini)
GEMINI_RPD_LIMIT    default: 1000
OPENAI_RPM_LIMIT    default: 500
OPENAI_TPM_LIMIT    default: 200000    (input + output tokens for OpenAI)
OPENAI_RPD_LIMIT    default: 10000000
```

---

## 9. Circuit Breaker (`circuitBreaker.ts`)

Per-provider, three states: `CLOSED` (healthy) → `OPEN` (suspended) → `HALF_OPEN` (probing recovery).

### DB model

```prisma
model LlmCircuitBreaker {
  provider            String    @id
  state               String    @default("CLOSED")
  consecutiveFailures Int       @default(0)
  lastFailureAt       DateTime?
  openedAt            DateTime?
  updatedAt           DateTime  @updatedAt
}
```

### State transitions

- `CLOSED → OPEN`: `LLM_CB_FAILURE_THRESHOLD` (default: 3) consecutive retriable failures. Auth and bad-request errors do NOT count.
- `OPEN → HALF_OPEN` probe: the CAS fires **only after quota reservation succeeds**, not during the read-only check phase. This ensures the probe slot is consumed only by the instance that will actually make the call:
  ```sql
  UPDATE LlmCircuitBreaker
  SET state = 'HALF_OPEN', updatedAt = now()
  WHERE provider = $p AND state = 'OPEN'
    AND openedAt < now() - interval '$cooldownMs milliseconds'
  ```
  Only the instance that updates 1 row may proceed. Others see 0 rows and treat provider as still OPEN.
- `HALF_OPEN → CLOSED`: successful call → reset `consecutiveFailures = 0`.
- `HALF_OPEN → OPEN`: failed call → re-open, `openedAt = now()`.

---

## 10. Routing Logic (`router.ts`)

```typescript
async function selectProvider(
  candidateCount: number,
  inputTokens: number,
  outputTokens: number
): Promise<LLMProvider | null>
```

Decision tree — all reads first, then single atomic reserve+probe:

```
1. Read both circuit breaker states (one DB query)
2. Read quota windows for both providers (one DB query)

3. Evaluate Gemini eligibility (no writes):
   - state == CLOSED, OR state == OPEN with cooldown elapsed (candidate for HALF_OPEN)
   - checkQuota("gemini", inputTokens, outputTokens).allowed
   - candidateCount ≤ LLM_CANDIDATE_THRESHOLD
   → geminiEligible = true | false

4. Evaluate OpenAI eligibility (no writes):
   - state == CLOSED, OR state == OPEN with cooldown elapsed
   - checkQuota("openai", inputTokens, outputTokens).allowed
   → openaiEligible = true | false

5. Select preferred provider: geminiEligible → "gemini", else openaiEligible → "openai", else null

6. If null → return null (rate_limited)

7. For selected provider:
   a. reserveQuota(selected, inputTokens, outputTokens)  — atomic CAS
      → if throws ProviderRateLimitError: flip to the other provider, reserveQuota again
      → if both fail: return null
   b. If provider was OPEN-with-cooldown: attempt HALF_OPEN CAS
      → 0 rows updated: another instance won the probe → **release the quota just reserved** (reserveQuota negates the delta), treat as OPEN → try other provider (reserve other provider quota)
      → 1 row updated: this instance holds the probe slot → proceed

8. return selected provider
```

`LLM_CANDIDATE_THRESHOLD` (default: 10) — above this always prefer OpenAI regardless of Gemini quota.

---

## 11. Fallback Orchestration & Logging (`index.ts`)

`LlmCallLog` rows are written **inside `parseEmailBatchLLM`**, on every exit path including thrown errors. The calling route never writes call logs directly.

`parseEmailBatchLLM` accepts full context for complete logging:

```typescript
export async function parseEmailBatchLLM(
  inputs: BatchInput[],
  provider: LLMProvider,
  batchKey: string,
  context: {
    userId: string;
    syncJobId?: string;
    operationType: "sync" | "reprocess" | "reconcile";
  }
): Promise<{ results: EmailParseResult[]; attempts: LLMAttemptMeta[] }>
```

Every `LlmCallLog` row written inside this function includes `userId`, `syncJobId`, and `batchKey` from the `context` argument — callers must pass this; they may not post-fill it.

```
attempt 1 (primary, attemptNumber=1, wasFallback=false):
  start = Date.now()
  try:
    results = adapter.call(inputs)
    write LlmCallLog(attempt=1, outcome="success", latency=elapsed, tokens=...)
    return { results, attempts: [meta1] }
  catch ProviderBadRequestError | ProviderAuthError:
    write LlmCallLog(attempt=1, outcome="error", errorDetail=...)
    throw   ← no fallback; caller surfaces error
  catch ProviderRateLimitError | ProviderServerError | ProviderTimeoutError | ProviderParseError:
    write LlmCallLog(attempt=1, outcome="error", fallbackReason=..., latency=elapsed)
    increment circuit breaker failure for primary

    attempt 2 (fallback, attemptNumber=2, wasFallback=true):
      select + reserve fallback provider quota
      start2 = Date.now()
      try:
        results = fallbackAdapter.call(inputs)
        write LlmCallLog(attempt=2, outcome="success", wasFallback=true, latency=elapsed2)
        return { results, attempts: [meta1, meta2] }
      catch any:
        write LlmCallLog(attempt=2, outcome="error", wasFallback=true, latency=elapsed2)
        throw ProviderExhaustedError  ← caller returns rate_limited
```

Both rows share the same `batchKey`. The calling route reads `attempts[-1].provider` to set `ParseLog.resolvedBy`.

---

## 12. Idempotency (`idempotency.ts`)

### The race this fixes

LLM call succeeds → Vercel times out before results are stored → next tick re-calls LLM → duplicate transactions.

### Guarantee boundary

Writing `"in_flight"` before the LLM call closes the common race. True exactly-once across all crash scenarios would require a distributed transaction between the LLM HTTP call and the DB write — not feasible here. This design prevents the re-call in the timeout case; a hard crash mid-write may still require manual dedup.

### `batchKey` composition

```typescript
batchKey = sha256(
  userId + ":" +
  operationType + ":" +    // "sync" | "reprocess" | "reconcile"
  SCHEMA_VERSION + ":" +   // from prompts.ts — bumped on prompt/schema changes
  sortedMsgIds.join(",")
)
```

`syncJobId` is excluded — reprocess and reconcile have no `syncJobId`. Including `userId` prevents cross-user collisions. Including `SCHEMA_VERSION` prevents stale cached results being reused after a schema update.

### In-flight expiry and complete expiry

Two separate TTLs:
- `"in_flight"` expiry: `now + (2 × LLM_TIMEOUT_MS) + 30_000` — covers primary timeout + fallback timeout + overhead. Default `LLM_TIMEOUT_MS = 30000` → expires in 90s.
- `"complete"` expiry: `now + 86_400_000` (24 hours) — keeps result available for dedup across polling ticks within the same day.

```
expiresAt (in_flight) = now + (2 × LLM_TIMEOUT_MS) + 30_000
expiresAt (complete)  = now + 86_400_000
```

### DB model

```prisma
model LlmBatchIdempotency {
  id        String   @id @default(cuid())
  batchKey  String   @unique
  status    String             // "in_flight" | "complete"
  result    Json?              // EmailParseResult[] — Prisma Json, null while in_flight
  createdAt DateTime @default(now())
  expiresAt DateTime           // now + (2 × LLM_TIMEOUT_MS) + 30s

  @@index([expiresAt])
}
```

### Flow

The idempotency check runs **before** provider selection and quota reservation. Serving a cached result must never consume quota.

```
1. Compute batchKey
2. SELECT WHERE batchKey = ? AND expiresAt > now()
   - "complete" → return result.Json, skip LLM entirely (no quota consumed)
   - "in_flight" → poll up to (2 × LLM_TIMEOUT_MS); if still in_flight after expiry → fall through to step 3
   - not found (or found but expired) → continue
3. INSERT or take over expired row (atomic upsert):
   INSERT INTO LlmBatchIdempotency (batchKey, status, expiresAt)
   VALUES ($key, 'in_flight', $inFlightExpiry)
   ON CONFLICT (batchKey) DO UPDATE
     SET status = 'in_flight', expiresAt = $inFlightExpiry
     WHERE LlmBatchIdempotency.expiresAt < now()
   - 0 rows affected: another instance holds a live in_flight → return to step 2
   - 1 row affected: this instance owns the key → continue
4. [Now] run provider selection + quota reservation
5. Call LLM (primary + fallback via orchestration layer)
6. UPDATE SET status = 'complete', result = $results, expiresAt = $completeExpiry
     WHERE batchKey = ? AND status = 'in_flight'
7. Return results for transaction processing
8. Cron prunes: DELETE WHERE expiresAt < now()
```

Using `ON CONFLICT DO UPDATE WHERE expiresAt < now()` instead of `ON CONFLICT DO NOTHING` ensures that a row stuck at an expired `"in_flight"` state is atomically taken over rather than silently skipped, which would block all future requests for that key forever.

---

## 13. Structured LLM Call Logging

One row per provider attempt written inside `index.ts`. Primary-fail-then-fallback produces two rows, both linked by `batchKey`.

### DB model

```prisma
model LlmCallLog {
  id               String   @id @default(cuid())
  syncJobId        String?
  userId           String?
  batchKey         String?
  provider         String           // "gemini" | "openai"
  model            String
  candidateCount   Int
  attemptNumber    Int              // 1 = primary, 2 = fallback
  wasFallback      Boolean  @default(false)
  fallbackReason   String?          // "rate_limit" | "server_error" | "timeout" | "parse_error" | "bad_request" | "auth_error"
  outcome          String           // "success" | "error"
  errorDetail      String?
  latencyMs        Int
  inputTokens      Int
  outputTokens     Int
  estimatedCostUsd Decimal          // PostgreSQL NUMERIC — avoids Float precision loss at sub-cent amounts
  createdAt        DateTime @default(now())

  @@index([provider, createdAt])
  @@index([syncJobId])
  @@index([batchKey])
}
```

`ParseLog.resolvedBy` keeps values `"static" | "template" | "exact_cache" | "gemini" | "openai"`. `wasFallback` detail lives in `LlmCallLog` only.

---

## 14. Advisory Lock with Heartbeat (`lock.ts`)

### DB model

```prisma
model SyncJobLock {
  jobId      String   @id
  ownerToken String
  lockedAt   DateTime @default(now())
  expiresAt  DateTime

  @@index([expiresAt])
}
```

### Acquire — atomic stale-lock replacement

Uses `INSERT ... ON CONFLICT DO UPDATE` with an expiry guard so a stale crashed-instance lock is atomically replaced without waiting for cron cleanup:

```typescript
async function acquireLock(
  jobId: string
): Promise<{ ownerToken: string; intervalHandle: NodeJS.Timeout; lockLost: { value: boolean } } | null> {
  const ownerToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + LOCK_LEASE_MS);
  const rows = await prisma.$executeRaw`
    INSERT INTO "SyncJobLock" ("jobId", "ownerToken", "lockedAt", "expiresAt")
    VALUES (${jobId}, ${ownerToken}, now(), ${expiresAt})
    ON CONFLICT ("jobId") DO UPDATE
      SET "ownerToken" = ${ownerToken}, "lockedAt" = now(), "expiresAt" = ${expiresAt}
      WHERE "SyncJobLock"."expiresAt" < now()
  `;
  if (rows === 0) return null;  // live lock held by another instance

  // Shared mutable flag — the interval callback sets it; advanceJob checks it
  const lockLost = { value: false };
  const intervalHandle = setInterval(async () => {
    const renewed = await prisma.syncJobLock.updateMany({
      where: { jobId, ownerToken },
      data: { expiresAt: new Date(Date.now() + LOCK_LEASE_MS) },
    });
    if (renewed.count === 0) {
      // Lock was lost — set the shared flag; advanceJob will notice on the next await
      clearInterval(intervalHandle);
      lockLost.value = true;
    }
  }, LOCK_RENEWAL_INTERVAL_MS);

  return { ownerToken, intervalHandle, lockLost };
}
```

`advanceJob` checks `lockLost.value` at each `await` checkpoint (after each email chunk is processed). When `true`, it throws `LockLostError(jobId)` itself rather than relying on the error to propagate from `setInterval`. This is necessary because errors thrown inside `setInterval` callbacks are swallowed by the event loop and will not abort the caller.

The calling request handler catches `LockLostError` and returns `{ phase: "running" }` (another instance will pick up the job on the next tick).

### Release (ownerToken-guarded)

```typescript
async function releaseLock(
  jobId: string,
  ownerToken: string,
  intervalHandle: NodeJS.Timeout
): Promise<void> {
  clearInterval(intervalHandle);
  await prisma.syncJobLock.deleteMany({ where: { jobId, ownerToken } });
}
```

Called in `finally` block. `lockLost` flag does not need to be passed — release is always safe even if the lock was already lost.

### Environment variables

```
LOCK_LEASE_MS             default: 300000  (5 min — covers primary + fallback timeouts)
LOCK_RENEWAL_INTERVAL_MS  default: 60000
```

---

## 15. Changes to `advance/route.ts`

- Remove `apiKey`, `checkGeminiRateLimit()`, `parseEmailBatch()`, `incrementGeminiUsage()`
- Rename `geminiQueue` → `llmQueue`, `geminiNeeded` → `llmCandidates`
- Acquire lock before `advanceJob()`; release in `finally`; catch `LockLostError` → return `{ phase: "running" }`
- Tier 3 replacement:

```typescript
const { inputTokens, outputTokens } = estimateBatchTokens(llmCandidates.length);
const provider = await selectProvider(llmCandidates.length, inputTokens, outputTokens);
if (!provider) return { phase: "rate_limited", newTransactions: 0, source: "llm" };

const batchKey = buildBatchKey(job.userId, "sync", sortedMsgIds);
// LlmCallLog rows written inside parseEmailBatchLLM — not here
const { results, attempts } = await parseEmailBatchLLM(llmCandidates, provider, batchKey);
const resolvedBy = attempts[attempts.length - 1].provider;
// use resolvedBy when creating ParseLog rows
```

---

## 16. Changes to `reconcile/route.ts`

```typescript
const { inputTokens, outputTokens } = estimateStatementTokens(statement.body.length);
const provider = await selectProvider(1, inputTokens, outputTokens);
if (!provider) return NextResponse.json({ error: "LLM unavailable" }, { status: 503 });
const batchKey = buildBatchKey(userId, "reconcile", [gmailMsgId]);
const { raw, attempts } = await parseStatementLLM(statement.body, provider, batchKey);
```

---

## 17. Changes to `reprocess/route.ts`

```typescript
const { inputTokens, outputTokens } = estimateBatchTokens(1);
const provider = await selectProvider(1, inputTokens, outputTokens);
if (!provider) return NextResponse.json({ error: "LLM unavailable" }, { status: 503 });
const batchKey = buildBatchKey(userId, "reprocess", [log.gmailMsgId]);
const { results, attempts } = await parseEmailBatchLLM([input], provider, batchKey);
```

---

## 18. DB Migration Summary

### New tables (5)

| Model | Purpose |
|-------|---------|
| `LlmCallLog` | One row per provider attempt — structured audit log |
| `LlmQuotaWindow` | Sliding RPM/TPM/RPD windows per provider, shared across instances |
| `LlmCircuitBreaker` | Per-provider circuit breaker state |
| `LlmBatchIdempotency` | In-flight/complete dedup to prevent LLM re-calls on timeout-retry |
| `SyncJobLock` | Per-job advisory lock with ownerToken, heartbeat, atomic stale replacement |

### Changed tables

- `GeminiUsageLog` — no longer written. Existing rows preserved. Drop in a follow-up migration.
- `ParseLog.resolvedBy` — values simplified to `"static" | "template" | "exact_cache" | "gemini" | "openai"`. No schema change needed.

---

## 19. Environment Variables (complete list)

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Gemini API key (existing) |
| `OPENAI_API_KEY` | — | OpenAI API key (new, required) |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Gemini model ID |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI model ID |
| `GEMINI_RPM_LIMIT` | `15` | Verify against AI Studio for your account |
| `GEMINI_TPM_LIMIT` | `250000` | Input tokens only — verify against AI Studio |
| `GEMINI_RPD_LIMIT` | `1000` | Verify against AI Studio |
| `OPENAI_RPM_LIMIT` | `500` | Verify against OpenAI limits page |
| `OPENAI_TPM_LIMIT` | `200000` | Input + output tokens — verify against OpenAI |
| `OPENAI_RPD_LIMIT` | `10000000` | Effectively unlimited on paid tier |
| `LLM_CANDIDATE_THRESHOLD` | `10` | Candidates above this prefer OpenAI |
| `LLM_TIMEOUT_MS` | `30000` | Per-provider HTTP request timeout |
| `LLM_CB_FAILURE_THRESHOLD` | `3` | Consecutive retriable failures before circuit opens |
| `LLM_CB_COOLDOWN_MS` | `60000` | Cooldown before HALF_OPEN probe eligible |
| `CHUNK_SIZE` | `25` | Emails fetched from DB per tick |
| `LLM_BATCH_SIZE` | `25` | Max LLM candidates per call; exceeding returns rate_limited |
| `LOCK_LEASE_MS` | `300000` | Initial and renewed lock lease (5 min) |
| `LOCK_RENEWAL_INTERVAL_MS` | `60000` | How often to renew the lock while held |

---

## 20. Testing Plan

### Unit tests
- `router.ts`: Gemini selected, OpenAI selected, both unavailable, CAS quota race, HALF_OPEN probe ordering (fires after reserve, not before), HALF_OPEN probe loss → `releaseQuota` called + routes to other provider
- `quota.ts`: RPM/TPM/RPD window math; Gemini TPM uses inputTokens only; OpenAI TPM uses input+output; serializable CAS guard; concurrent reservation race; `releaseQuota` decrements correct windows; boundary-burst note: configure limits at 80% of provider limit
- `circuitBreaker.ts`: CLOSED→OPEN, OPEN→HALF_OPEN atomic probe (only one winner across concurrent calls), HALF_OPEN→CLOSED, HALF_OPEN→OPEN
- `idempotency.ts`: complete hit skips quota/LLM entirely, in_flight wait, separate TTLs (in_flight=90s, complete=24h), concurrent INSERT on expired row → atomic takeover not silent skip, idempotency check runs before `selectProvider`
- `lock.ts`: acquire success, acquire when held (live lock), atomic stale-lock replacement, ownerToken-guarded release, renewal success, renewal failure → sets `lockLost.value = true` (not throws from setInterval), `advanceJob` checks flag at each checkpoint → throws `LockLostError`
- `validate.ts`: correct result passes, wrong array length throws, emailIndex set not `{0..n-1}` throws (duplicates, gaps, out-of-range), invalid field type → parse_failed outcome on that item

### Integration tests (mock HTTP)
- Gemini 429 → OpenAI called → two `LlmCallLog` rows, `wasFallback=true` on row 2, both rows have `userId` + `syncJobId`
- OpenAI 401 → no fallback, `ProviderAuthError` thrown, one error `LlmCallLog` row
- Gemini 400 → no fallback, `ProviderBadRequestError`, one error `LlmCallLog` row
- `reserveQuota` CAS race mid-selection → flips to other provider
- Circuit breaker: 3 consecutive Gemini 5xx → OPEN → next tick routes to OpenAI
- HALF_OPEN probe: two concurrent instances, only one proceeds, loser calls `releaseQuota` and routes to other provider
- Lock renewal failure mid-job → `lockLost.value = true` → `advanceJob` detects on next checkpoint → throws `LockLostError` → job returns `{ phase: "running" }`
- Idempotency check returns "complete" → provider never selected, quota never reserved, LLM never called

### Pre-rollout parity smoke test (gates production routing enable)
Run 10–20 representative real emails (a fixed golden set covering transaction types, non-transactions, and ambiguous cases) through both Gemini and OpenAI independently. Compare outcomes:
- `isTransaction` must agree on all items
- `amount` and `type` must match on parsed items
- `category` may differ — flag for review, not a hard failure

If disagreement rate > 10% on `isTransaction` or > 5% on `amount`/`type`, investigate before enabling automatic routing. Results committed to `tests/golden/parity-results.json`.

### Manual verification
- Deploy `GEMINI_MODEL=gemini-3.1-flash-lite` → confirm production outage resolved
- Retro sync (>500 emails, many novel senders) → `LlmCallLog` shows `openai` for large candidate batches
- Daily sync (~50 emails) → `LlmCallLog` shows `gemini` for small batches
- Set `GEMINI_RPD_LIMIT=0` → all traffic routes to OpenAI
- Set `LLM_TIMEOUT_MS=1` → confirm in-flight idempotency key prevents duplicate LLM call on retry
