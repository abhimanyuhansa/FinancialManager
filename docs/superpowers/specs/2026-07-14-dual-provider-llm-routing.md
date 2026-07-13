# Dual-Provider LLM Routing — Design Spec

**Date:** 2026-07-14  
**Status:** Awaiting user approval  
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
5. Track per-provider quota (RPM, TPM, RPD) atomically across all users and Vercel instances in the DB. Separate quota check from quota reservation.
6. Emit one `LlmCallLog` row per provider attempt (not per batch resolution) — capturing provider, model, attemptNumber, wasFallback, fallbackReason, latencyMs, inputTokens, outputTokens, estimatedCostUsd.
7. Circuit breaker per provider — stop routing to a degraded provider after N consecutive failures. Only one Vercel instance may issue a HALF_OPEN probe at a time.
8. Prevent duplicate LLM calls on retry: write idempotency key with status `"in_flight"` before calling the LLM; update to `"complete"` with results after. Retries find the in-flight key and wait rather than re-call.
9. Per-job advisory lock with `ownerToken` and heartbeat renewal — prevents duplicate processing across Vercel instances even when primary + fallback exceed the initial lease.
10. All limits, thresholds, model names, and timeouts configurable via environment variables.

---

## 3. Out of Scope

- Changing the static parser, template cache, or exact result cache logic.
- Per-user bring-your-own-key support.
- Golden-dataset parity tests (deferred to post-rollout).
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
    types.ts        — EmailParseResult, LLMProvider, ProviderError subtypes, LLMCallMeta
  prompts.ts        — shared system prompts, user prompt builders, JSON schema, token estimates
  quota.ts          — DB-backed quota tracking: checkQuota(), reserveQuota()
  circuitBreaker.ts — per-provider circuit breaker with atomic HALF_OPEN probe
  idempotency.ts    — in-flight / complete idempotency key management
  lock.ts           — SyncJobLock acquire, renew, release with ownerToken
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

// Metadata for one provider attempt — one LlmCallLog row per instance
export type LLMAttemptMeta = {
  provider: LLMProvider;
  model: string;
  attemptNumber: number;       // 1 = primary, 2 = fallback
  wasFallback: boolean;
  fallbackReason?: string;     // "rate_limit" | "server_error" | "timeout" | "parse_error"
  outcome: "success" | "error";
  errorDetail?: string;
  latencyMs: number;
  inputTokens: number;         // from provider response if available, else estimated
  outputTokens: number;
  estimatedCostUsd: number;    // Decimal-compatible — stored as Prisma Decimal in DB
};
```

---

## 6. Shared Prompts, Schema & Token Estimates (`prompts.ts`)

Single source of truth — both adapters import from here, no prompt duplication.

- `BATCH_SYSTEM_PROMPT` — existing text, unchanged
- `STATEMENT_SYSTEM_PROMPT` — existing text, unchanged
- `buildBatchUserPrompt(items)` — existing builder, unchanged
- `EMAIL_JSON_SCHEMA` — JSON Schema object for OpenAI Structured Outputs (`response_format: json_schema`)

### Token estimation

Used by `router.ts` before selecting a provider. Estimates include system prompt, schema, all email bodies, expected output, and a safety margin:

```typescript
export const TOKEN_ESTIMATE = {
  SYSTEM_PROMPT:  350,   // batch system prompt
  SCHEMA:         150,   // JSON schema in user prompt
  PER_EMAIL_BODY: 375,   // avg tokens per 1500-char body
  PER_EMAIL_OUT:  200,   // avg output tokens per email result
  SAFETY_MARGIN:  1.2,
} as const;

export function estimateBatchTokens(candidateCount: number): {
  inputTokens: number;
  outputTokens: number;
} {
  const input = Math.ceil(
    (TOKEN_ESTIMATE.SYSTEM_PROMPT + TOKEN_ESTIMATE.SCHEMA +
      candidateCount * TOKEN_ESTIMATE.PER_EMAIL_BODY) * TOKEN_ESTIMATE.SAFETY_MARGIN
  );
  const output = Math.ceil(
    candidateCount * TOKEN_ESTIMATE.PER_EMAIL_OUT * TOKEN_ESTIMATE.SAFETY_MARGIN
  );
  return { inputTokens: input, outputTokens: output };
}

// For statement reconcile — body-length-based, not candidate-count-based
export function estimateStatementTokens(bodyLength: number): {
  inputTokens: number;
  outputTokens: number;
} {
  const bodyTokens = Math.ceil(bodyLength / 4);
  const input = Math.ceil(
    (TOKEN_ESTIMATE.SYSTEM_PROMPT + bodyTokens) * TOKEN_ESTIMATE.SAFETY_MARGIN
  );
  const output = Math.ceil(500 * TOKEN_ESTIMATE.SAFETY_MARGIN); // statement output est.
  return { inputTokens: input, outputTokens: output };
}
```

---

## 7. Provider Adapters

### Gemini (`providers/gemini.ts`)

- Model: `process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite"` — fixes the outage
- JSON mode: `responseMimeType: "application/json"`, `temperature: 0`
- Response path: `candidates[0].content.parts[0].text`
- Timeout: `Number(process.env.LLM_TIMEOUT_MS ?? 30000)`
- Token usage: Gemini API returns `usageMetadata.promptTokenCount` and `candidatesTokenCount` — use these when present, fall back to estimates
- Error mapping:
  - HTTP 400 → `ProviderBadRequestError` (fail fast — malformed request)
  - HTTP 401 | 403 → `ProviderAuthError` (fail fast — bad key)
  - HTTP 429 → `ProviderRateLimitError` (fallback eligible)
  - HTTP 5xx → `ProviderServerError` (fallback eligible)
  - fetch timeout → `ProviderTimeoutError` (fallback eligible)
  - JSON parse failure → `ProviderParseError` (fallback eligible)

### OpenAI (`providers/openai.ts`)

- Model: `process.env.OPENAI_MODEL ?? "gpt-5-nano"`
- JSON mode: `response_format: { type: "json_schema", json_schema: { name: "email_parse", schema: EMAIL_JSON_SCHEMA, strict: true } }`, `temperature: 0`
- Response path: `choices[0].message.content`
- Token usage: read exact values from `usage.prompt_tokens` and `usage.completion_tokens`
- Same error mapping as Gemini adapter

---

## 8. Quota Tracking (`quota.ts`)

Tracks RPM, TPM, and RPD per provider using DB sliding windows shared across all Vercel instances.

### DB model

```prisma
model LlmQuotaWindow {
  id          String   @id @default(cuid())
  provider    String   // "gemini" | "openai"
  windowType  String   // "rpm" | "tpm" | "rpd"
  windowKey   String   // "2026-07-14T10:23" (minute) | "2026-07-14" (day)
  count       Int      @default(0)
  updatedAt   DateTime @updatedAt

  @@unique([provider, windowType, windowKey])
  @@index([provider, windowType, windowKey])
}
```

### Separate check and reservation

**Check** (read-only, no writes):
```typescript
async function checkQuota(
  provider: LLMProvider,
  inputTokens: number,
  outputTokens: number
): Promise<{ allowed: boolean; reason?: string }>
```
Reads current RPM, TPM, RPD window counts. Returns `allowed: false` with reason if any window would be exceeded. Makes no writes — safe to call for both providers before deciding.

**Reserve** (atomic write, called only after routing decision is final):
```typescript
async function reserveQuota(
  provider: LLMProvider,
  inputTokens: number,
  outputTokens: number
): Promise<void>
```
Atomically increments all three windows using a serializable `$transaction` with conditional updates:
```sql
UPDATE LlmQuotaWindow
SET count = count + $delta
WHERE provider = $provider AND windowType = $type AND windowKey = $key
  AND count + $delta <= $limit   -- CAS guard
```
If any CAS fails (another instance just pushed over the limit), throws `ProviderRateLimitError` so the router can try the other provider.

### Environment variables (configurable, no hardcoded assumptions):

```
GEMINI_RPM_LIMIT    default: 15        (varies by account — check AI Studio)
GEMINI_TPM_LIMIT    default: 250000
GEMINI_RPD_LIMIT    default: 1000
OPENAI_RPM_LIMIT    default: 500
OPENAI_TPM_LIMIT    default: 200000
OPENAI_RPD_LIMIT    default: 10000000
```

---

## 9. Circuit Breaker (`circuitBreaker.ts`)

Per-provider, three states: `CLOSED` (healthy) → `OPEN` (suspended) → `HALF_OPEN` (probing recovery).

### DB model

```prisma
model LlmCircuitBreaker {
  provider            String    @id   // "gemini" | "openai"
  state               String    @default("CLOSED")
  consecutiveFailures Int       @default(0)
  lastFailureAt       DateTime?
  openedAt            DateTime?
  updatedAt           DateTime  @updatedAt
}
```

### State transitions

- `CLOSED → OPEN`: `LLM_CB_FAILURE_THRESHOLD` (default: 3) consecutive retriable failures (429/5xx/timeout/parse). Auth errors and bad-request errors do NOT count.
- `OPEN → HALF_OPEN` probe (atomic): only one Vercel instance may probe at a time. Uses a conditional update:
  ```sql
  UPDATE LlmCircuitBreaker
  SET state = 'HALF_OPEN', updatedAt = now()
  WHERE provider = $p AND state = 'OPEN'
    AND openedAt < now() - $cooldownMs
  ```
  Only the instance that updates 1 row proceeds. All others see 0 rows updated and treat the provider as still OPEN.
- `HALF_OPEN → CLOSED`: probe call succeeds → reset `consecutiveFailures = 0`.
- `HALF_OPEN → OPEN`: probe call fails → re-open, reset `openedAt = now()`, clear HALF_OPEN.

---

## 10. Routing Logic (`router.ts`)

```typescript
async function selectProvider(
  candidateCount: number,
  estimatedInputTokens: number,
  estimatedOutputTokens: number
): Promise<{ provider: LLMProvider; reservedFor: LLMProvider } | null>
```

Decision tree (read-only checks first, reservation only after selection):

```
1. Compute estimates via estimateBatchTokens(candidateCount) — already done by caller

2. Check Gemini (read-only):
   - circuitBreaker.gemini state is CLOSED or won HALF_OPEN CAS?
   - checkQuota("gemini", inputTokens, outputTokens).allowed?
   - candidateCount ≤ LLM_CANDIDATE_THRESHOLD?
   → if all yes: select = "gemini"

3. Else check OpenAI (read-only):
   - circuitBreaker.openai state is CLOSED or won HALF_OPEN CAS?
   - checkQuota("openai", inputTokens, outputTokens).allowed?
   → if all yes: select = "openai"

4. If select is null → return null (phase: "rate_limited")

5. reserveQuota(select, inputTokens, outputTokens)  ← only now
   — if reserveQuota throws RateLimitError (CAS lost): try the other provider's check+reserve
   — if both fail: return null

6. return { provider: select }
```

`LLM_CANDIDATE_THRESHOLD` (default: 10): candidates above this always prefer OpenAI — large batches deplete Gemini's free RPD quota disproportionately fast.

### Fallback orchestration (in `index.ts`)

```
attempt 1 (primary):
  call provider adapter
  on success → write LlmCallLog (attempt 1), return results
  on ProviderBadRequestError | ProviderAuthError → write LlmCallLog (attempt 1, error), throw — NO fallback
  on ProviderRateLimitError | ProviderServerError | ProviderTimeoutError | ProviderParseError:
    → increment circuit breaker failure for primary
    → write LlmCallLog (attempt 1, error, fallbackReason=...)
    → attempt 2 (fallback):
        checkQuota + reserveQuota for the other provider
        call other provider adapter
        on success → write LlmCallLog (attempt 2, wasFallback=true), return results
        on any error → write LlmCallLog (attempt 2, error), return rate_limited
```

Two `LlmCallLog` rows per failed-primary-then-fallback scenario, both sharing the same `batchKey`.

---

## 11. Idempotency (`idempotency.ts`)

### The race this fixes

Without idempotency: LLM call succeeds → Vercel times out before result is stored → next tick calls LLM again → duplicate transactions inserted.

### Corrected guarantee

The idempotency key is written with status `"in_flight"` **before** the LLM call. If the process crashes after the LLM returns but before storing results, the next retry finds an `"in_flight"` key and waits (up to `LLM_TIMEOUT_MS`) rather than issuing a second LLM call. After `expiresAt`, an in-flight key is treated as expired and a fresh call is allowed.

This does not guarantee exactly-once delivery in all crash scenarios — it closes the most common race (timeout-before-store). True exactly-once would require a distributed transaction between the LLM call and the DB write, which is not feasible here.

### DB model

```prisma
model LlmBatchIdempotency {
  id        String   @id @default(cuid())
  batchKey  String   @unique   // sha256(syncJobId + ":" + sortedMsgIds.join(","))
  status    String              // "in_flight" | "complete"
  result    Json?               // EmailParseResult[] — null while in_flight
  createdAt DateTime @default(now())
  expiresAt DateTime            // createdAt + 1h; in_flight keys expire after LLM_TIMEOUT_MS * 2

  @@index([expiresAt])
}
```

### Flow

```
1. batchKey = sha256(syncJobId + ":" + sortedMsgIds.join(","))
2. Check existing: SELECT WHERE batchKey = ? AND expiresAt > now()
   - "complete" found → return result, skip LLM
   - "in_flight" found → wait up to LLM_TIMEOUT_MS, then re-check; if still in_flight → treat as expired
   - not found → continue
3. INSERT { batchKey, status: "in_flight", expiresAt: now + LLM_TIMEOUT_MS * 2 }
   ON CONFLICT DO NOTHING
   - 0 rows inserted → another instance raced ahead → go to step 2
4. Call LLM (primary + fallback if needed)
5. UPDATE SET status = "complete", result = $results WHERE batchKey = ? AND status = "in_flight"
6. Process transactions from results
7. Cron prunes: DELETE WHERE expiresAt < now()
```

---

## 12. Structured LLM Call Logging

One row per provider attempt. A batch that uses primary + fallback produces two rows, both linked by `batchKey`.

### DB model

```prisma
model LlmCallLog {
  id             String   @id @default(cuid())
  syncJobId      String?
  userId         String?
  batchKey       String?
  provider       String           // "gemini" | "openai"
  model          String
  candidateCount Int
  attemptNumber  Int              // 1 = primary, 2 = fallback
  wasFallback    Boolean  @default(false)
  fallbackReason String?          // "rate_limit" | "server_error" | "timeout" | "parse_error" | "bad_request" | "auth_error"
  outcome        String           // "success" | "error"
  errorDetail    String?
  latencyMs      Int
  inputTokens    Int
  outputTokens   Int
  estimatedCostUsd Decimal        // Prisma Decimal → PostgreSQL NUMERIC; avoids Float precision loss
  createdAt      DateTime @default(now())

  @@index([provider, createdAt])
  @@index([syncJobId])
  @@index([batchKey])
}
```

`ParseLog.resolvedBy` keeps values `"static" | "template" | "exact_cache" | "gemini" | "openai"`. The `wasFallback` detail lives in `LlmCallLog`, not in `resolvedBy`.

---

## 13. Advisory Lock with Heartbeat (`lock.ts`)

Prevents two Vercel instances from processing the same job tick simultaneously.

### DB model

```prisma
model SyncJobLock {
  jobId      String   @id
  ownerToken String              // crypto.randomUUID() — release requires matching token
  lockedAt   DateTime @default(now())
  expiresAt  DateTime            // renewed every LOCK_RENEWAL_INTERVAL_MS

  @@index([expiresAt])
}
```

### Acquire

```typescript
async function acquireLock(jobId: string): Promise<string | null> {
  const ownerToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + LOCK_LEASE_MS);  // default 300s
  const rows = await prisma.$executeRaw`
    INSERT INTO "SyncJobLock" ("jobId", "ownerToken", "lockedAt", "expiresAt")
    VALUES (${jobId}, ${ownerToken}, now(), ${expiresAt})
    ON CONFLICT ("jobId") DO NOTHING
  `;
  // Also clear stale expired locks before trying (handled by cron prune)
  return rows === 1 ? ownerToken : null;  // null = lock held by another instance
}
```

### Heartbeat renewal (runs inside `advanceJob`)

```typescript
const renewalInterval = setInterval(async () => {
  await prisma.syncJobLock.updateMany({
    where: { jobId, ownerToken },
    data: { expiresAt: new Date(Date.now() + LOCK_LEASE_MS) },
  });
}, LOCK_RENEWAL_INTERVAL_MS);  // default 60s
```

### Release (ownerToken-guarded)

`acquireLock` returns both the `ownerToken` and the renewal `intervalHandle`. Both must be passed to `releaseLock`:

```typescript
async function releaseLock(jobId: string, ownerToken: string, intervalHandle: NodeJS.Timeout): Promise<void> {
  clearInterval(intervalHandle);
  await prisma.syncJobLock.deleteMany({ where: { jobId, ownerToken } });
}
```

Called in `finally` block. If the instance crashes, the lease expires naturally and cron cleans it up.

### Environment variables

```
LOCK_LEASE_MS             default: 300000  (5 min — covers primary + fallback timeouts)
LOCK_RENEWAL_INTERVAL_MS  default: 60000   (renew every 60s)
```

---

## 14. Changes to `advance/route.ts`

- Remove `apiKey`, `checkGeminiRateLimit()`, `parseEmailBatch()`, `incrementGeminiUsage()`
- Rename `geminiQueue` → `llmQueue`, `geminiNeeded` → `llmCandidates`
- Acquire lock at top of request handler; release in `finally`
- Tier 3 replacement:

```typescript
const { inputTokens, outputTokens } = estimateBatchTokens(llmCandidates.length);
const selected = await selectProvider(llmCandidates.length, inputTokens, outputTokens);
if (!selected) return { phase: "rate_limited", newTransactions: 0, source: "llm" };

const { results, attempts } = await parseEmailBatchLLM(llmCandidates, selected.provider, batchKey);
// attempts: LLMAttemptMeta[] — one per provider attempt
for (const attempt of attempts) {
  await prisma.llmCallLog.create({ data: { ...attempt, syncJobId: job.id, userId: job.userId, batchKey } });
}
// resolvedBy on ParseLog = attempts[attempts.length - 1].provider  (the one that succeeded)
```

---

## 15. Changes to `reconcile/route.ts`

- Replace `callGeminiForStatement(body, apiKey)` with:

```typescript
const { inputTokens, outputTokens } = estimateStatementTokens(statement.body.length);
const selected = await selectProvider(1, inputTokens, outputTokens);
if (!selected) return NextResponse.json({ error: "LLM unavailable" }, { status: 503 });
const { raw, attempts } = await parseStatementLLM(statement.body, selected.provider);
```

Token-based routing (not `candidateCount = 1`) ensures a 6000-char statement body correctly accounts for ~1500 body tokens when checking quota.

---

## 16. Changes to `reprocess/route.ts`

- Replace `parseEmailBatch([...], apiKey)` with `parseEmailBatchLLM([...])` from `src/lib/llm/index.ts`
- Single-email reprocess: `candidateCount = 1`, token estimate uses `estimateBatchTokens(1)`
- Logs to `LlmCallLog` with `syncJobId = null`

---

## 17. DB Migration Summary

### New tables (5)

| Model | Purpose |
|-------|---------|
| `LlmCallLog` | One row per provider attempt — structured audit log |
| `LlmQuotaWindow` | Sliding RPM/TPM/RPD windows per provider, shared across instances |
| `LlmCircuitBreaker` | Per-provider circuit breaker state |
| `LlmBatchIdempotency` | In-flight/complete dedup to prevent LLM re-calls on timeout-retry |
| `SyncJobLock` | Per-job advisory lock with ownerToken and renewable lease |

### Changed tables

- `GeminiUsageLog` — no longer written by new code. Existing rows preserved for backwards compatibility. Drop in a follow-up migration once any admin UI reading it is updated to query `LlmQuotaWindow`.
- `ParseLog.resolvedBy` — values simplified to `"static" | "template" | "exact_cache" | "gemini" | "openai"`. No schema change needed (already `String?`).

---

## 18. Environment Variables (complete list)

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Gemini API key (existing) |
| `OPENAI_API_KEY` | — | OpenAI API key (new, required) |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Gemini model ID |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI model ID |
| `GEMINI_RPM_LIMIT` | `15` | Verify against AI Studio for your account |
| `GEMINI_TPM_LIMIT` | `250000` | Verify against AI Studio |
| `GEMINI_RPD_LIMIT` | `1000` | Verify against AI Studio |
| `OPENAI_RPM_LIMIT` | `500` | Verify against OpenAI limits page |
| `OPENAI_TPM_LIMIT` | `200000` | Verify against OpenAI limits page |
| `OPENAI_RPD_LIMIT` | `10000000` | Effectively unlimited on paid tier |
| `LLM_CANDIDATE_THRESHOLD` | `10` | Candidates above this prefer OpenAI |
| `LLM_TIMEOUT_MS` | `30000` | Per-provider HTTP request timeout |
| `LLM_CB_FAILURE_THRESHOLD` | `3` | Consecutive retriable failures before circuit opens |
| `LLM_CB_COOLDOWN_MS` | `60000` | Cooldown before HALF_OPEN probe |
| `CHUNK_SIZE` | `25` | Emails fetched from DB per tick |
| `LLM_BATCH_SIZE` | `25` | Max LLM candidates per call; exceeding returns rate_limited |
| `LOCK_LEASE_MS` | `300000` | Initial and renewed lock lease (5 min) |
| `LOCK_RENEWAL_INTERVAL_MS` | `60000` | How often to renew the lock while held |

---

## 19. Testing Plan

**Unit tests:**
- `router.ts`: all routing branches — Gemini selected, OpenAI selected, both unavailable, CAS quota race
- `quota.ts`: RPM/TPM/RPD window math, serializable CAS guard, concurrent reservation
- `circuitBreaker.ts`: CLOSED→OPEN, OPEN→HALF_OPEN atomic probe (only one winner), HALF_OPEN→CLOSED, HALF_OPEN→OPEN
- `idempotency.ts`: cache hit (complete), in-flight wait, expiry, concurrent INSERT race
- `lock.ts`: acquire success, acquire when held, ownerToken-guarded release, renewal

**Integration tests (mock HTTP):**
- Gemini returns 429 → OpenAI called → two `LlmCallLog` rows, `wasFallback=true` on row 2
- OpenAI returns 401 → no fallback, `ProviderAuthError` surfaced
- Gemini returns 400 → no fallback, `ProviderBadRequestError` surfaced
- Primary succeeds but `reserveQuota` CAS fails mid-race → retry selects other provider
- Circuit breaker: 3 consecutive Gemini 5xx → state becomes OPEN → next tick routes to OpenAI

**Manual verification:**
- Deploy with `GEMINI_MODEL=gemini-3.1-flash-lite` → confirm production no longer 429s on Gemini model calls
- Trigger retro sync (>500 emails, many novel senders) → `LlmCallLog` shows `openai` as provider for large candidate batches
- Trigger daily sync (~50 emails) → `LlmCallLog` shows `gemini` for small candidate batches
- Set `GEMINI_RPD_LIMIT=0` → all traffic routes to OpenAI, verify `LlmCallLog`
- Simulate timeout: set `LLM_TIMEOUT_MS=1` → confirm idempotency in-flight key prevents duplicate LLM call on retry
