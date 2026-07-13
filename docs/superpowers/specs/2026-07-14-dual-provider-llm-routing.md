# Dual-Provider LLM Routing — Design Spec

**Date:** 2026-07-14  
**Status:** Awaiting user approval  
**Scope:** Replace direct Gemini calls with a provider-routing layer that uses OpenAI (`gpt-5-nano`) as primary or fallback depending on LLM candidate count, with circuit breaker, quota tracking, structured logging, and idempotency guarantees.

---

## 1. Motivation

- `gemini-2.0-flash-lite` was shut down on 2026-06-01. The app is currently broken in production for any email that escapes static/template parsing.
- `reconcile/route.ts` calls `gemini-flash-latest` — also an alias that may be deprecated.
- A single provider with no fallback is a single point of failure.
- Free-tier Gemini has 1000–1500 RPD, 15 RPM, 250K TPM — limits that vary by account and are not safe to hardcode.
- No visibility into which provider handled each parse, at what latency, and at what estimated cost.

---

## 2. Goals

1. Fix the production outage: replace `gemini-2.0-flash-lite` with `gemini-3.1-flash-lite`.
2. Add OpenAI `gpt-5-nano` as a second provider.
3. Route to the cheapest available provider based on LLM candidate count and remaining quota.
4. Fallback automatically on 429, 5xx, timeout, and network errors. Fail fast on 400/401/403.
5. Track per-provider quota (RPM, TPM, RPD) across all users and Vercel instances in the DB.
6. Emit rich structured logs per LLM call: provider, model, wasFallback, fallbackReason, latencyMs, inputTokens, outputTokens, estimatedCostUsd.
7. Circuit breaker per provider — stop routing to a degraded provider after N consecutive failures.
8. Prevent duplicate transactions when a primary provider succeeds but the response times out before reaching the caller.
9. Cap concurrent `/advance` executions at the DB level to prevent quota bursts across Vercel instances.
10. All limits, thresholds, model names, and timeouts configurable via environment variables — no hardcoded values.

---

## 3. Out of Scope

- Changing the static parser, template cache, or exact result cache logic.
- Per-user bring-your-own-key support.
- Golden-dataset parity tests (deferred to post-rollout).
- Sub-batching a single chunk (25 emails into smaller groups) — keep one batch call per tick unless response-quality tests justify splitting.

---

## 4. New Files

```
src/lib/llm/
  index.ts          — public entry point: parseEmailBatchLLM(), parseStatementLLM()
  router.ts         — provider selection logic
  providers/
    gemini.ts       — Gemini adapter
    openai.ts       — OpenAI adapter
    types.ts        — shared types: EmailParseResult, LLMProvider, ProviderError subtypes
  prompts.ts        — shared system prompt, user prompt builder, JSON schema
  quota.ts          — DB-backed quota tracking (RPM, TPM, RPD windows)
  circuitBreaker.ts — per-provider circuit breaker state in DB
  idempotency.ts    — batch idempotency key helpers
```

Existing files changed:
- `src/lib/gemini.ts` — internal only, no longer imported by routes
- `src/app/api/gmail/sync/advance/route.ts` — call `parseEmailBatchLLM()` instead of `parseEmailBatch()`
- `src/app/api/gmail/reconcile/route.ts` — call `parseStatementLLM()` instead of `callGeminiForStatement()`
- `src/app/api/settings/parse-logs/[id]/reprocess/route.ts` — call `parseEmailBatchLLM()` instead of `parseEmailBatch()`
- `prisma/schema.prisma` — new models: `LlmCallLog`, `LlmQuotaWindow`, `LlmCircuitBreaker`, `LlmBatchIdempotency`

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

// Typed errors — callers can instanceof-check
export class ProviderAuthError extends Error { provider: LLMProvider; statusCode: number; }
export class ProviderRateLimitError extends Error { provider: LLMProvider; retryAfterMs?: number; }
export class ProviderServerError extends Error { provider: LLMProvider; statusCode: number; }
export class ProviderTimeoutError extends Error { provider: LLMProvider; }
export class ProviderParseError extends Error { provider: LLMProvider; }

export type LLMCallMeta = {
  provider: LLMProvider;
  model: string;
  wasFallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};
```

---

## 6. Shared Prompts & Schema (`prompts.ts`)

Single source of truth. Both adapters import from here — no prompt duplication.

- `BATCH_SYSTEM_PROMPT` — existing prompt text, unchanged
- `STATEMENT_SYSTEM_PROMPT` — existing prompt text, unchanged
- `buildBatchUserPrompt(items)` — existing builder, unchanged
- `EMAIL_JSON_SCHEMA` — JSON Schema object used by OpenAI Structured Outputs
- `TOKEN_ESTIMATE` — constants: `SYSTEM_PROMPT_TOKENS = 350`, `SCHEMA_TOKENS = 150`, `PER_EMAIL_BODY_TOKENS = 375`, `PER_EMAIL_OUTPUT_TOKENS = 200`, `SAFETY_MARGIN = 1.2`

Token estimate per batch:
```
inputTokens  = (SYSTEM_PROMPT_TOKENS + SCHEMA_TOKENS + candidateCount × PER_EMAIL_BODY_TOKENS) × SAFETY_MARGIN
outputTokens = candidateCount × PER_EMAIL_OUTPUT_TOKENS × SAFETY_MARGIN
```

---

## 7. Provider Adapters

### Gemini (`providers/gemini.ts`)

- Model: `process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite"` (fixes the outage)
- JSON mode: `responseMimeType: "application/json"`, `temperature: 0`
- Response path: `candidates[0].content.parts[0].text`
- Timeout: `process.env.LLM_TIMEOUT_MS ?? 30000`
- On HTTP 400/401/403 → throw `ProviderAuthError` (no fallback)
- On HTTP 429 → throw `ProviderRateLimitError`
- On HTTP 5xx → throw `ProviderServerError`
- On fetch timeout → throw `ProviderTimeoutError`
- On JSON parse failure → throw `ProviderParseError`

### OpenAI (`providers/openai.ts`)

- Model: `process.env.OPENAI_MODEL ?? "gpt-5-nano"`
- JSON mode: `response_format: { type: "json_schema", json_schema: { name: "email_parse", schema: EMAIL_JSON_SCHEMA, strict: true } }`, `temperature: 0`
- Response path: `choices[0].message.content`
- Same timeout and error classification as Gemini adapter
- Returns `inputTokens` and `outputTokens` from `usage` field in response (exact, not estimated)

---

## 8. Quota Tracking (`quota.ts`)

Tracks RPM, TPM, and RPD per provider in the DB using sliding windows. Shared across all Vercel instances — no in-memory state.

### DB model: `LlmQuotaWindow`

```prisma
model LlmQuotaWindow {
  id           String   @id @default(cuid())
  provider     String   // "gemini" | "openai"
  windowType   String   // "rpm" | "tpm" | "rpd"
  windowKey    String   // minute bucket "2026-07-14T10:23" | day "2026-07-14"
  count        Int      @default(0)
  updatedAt    DateTime @updatedAt

  @@unique([provider, windowType, windowKey])
  @@index([provider, windowType, windowKey])
}
```

### Quota check + increment (atomic upsert):

```typescript
async function checkAndReserveQuota(
  provider: LLMProvider,
  candidateCount: number
): Promise<{ allowed: boolean; reason?: string }>
```

Reads all three windows (RPM, TPM, RPD) for the provider and compares against configured limits. Uses `$transaction` for atomic read-then-increment to prevent races across concurrent Vercel instances.

### Environment variables for limits (all configurable, no hardcoded defaults assumed correct):

```
GEMINI_RPM_LIMIT        default: 15
GEMINI_TPM_LIMIT        default: 250000
GEMINI_RPD_LIMIT        default: 1000
OPENAI_RPM_LIMIT        default: 500
OPENAI_TPM_LIMIT        default: 200000
OPENAI_RPD_LIMIT        default: 10000000  (effectively unlimited on paid tier)
```

**Note:** Gemini limits vary by account tier. The defaults are conservative free-tier values. Operators must set these to their actual limits from AI Studio.

---

## 9. Circuit Breaker (`circuitBreaker.ts`)

Per-provider circuit breaker with three states: `CLOSED` (healthy), `OPEN` (suspended), `HALF_OPEN` (testing recovery).

### DB model: `LlmCircuitBreaker`

```prisma
model LlmCircuitBreaker {
  provider            String   @id  // "gemini" | "openai"
  state               String   @default("CLOSED")  // CLOSED | OPEN | HALF_OPEN
  consecutiveFailures Int      @default(0)
  lastFailureAt       DateTime?
  openedAt            DateTime?
  updatedAt           DateTime @updatedAt
}
```

### Behavior:

- `CLOSED → OPEN`: after `LLM_CB_FAILURE_THRESHOLD` (default: 3) consecutive 429/5xx/timeout failures
- `OPEN → HALF_OPEN`: after `LLM_CB_COOLDOWN_MS` (default: 60000ms) elapses since `openedAt`
- `HALF_OPEN → CLOSED`: on next successful call
- `HALF_OPEN → OPEN`: on next failure, reset cooldown

Auth errors (400/401/403) do NOT increment the failure counter — they are config problems, not provider instability.

---

## 10. Routing Logic (`router.ts`)

Called once per tick, after static/template parsing produces `geminiNeeded` (renamed to `llmCandidates`).

```typescript
async function selectProvider(candidateCount: number): Promise<LLMProvider | null>
```

Decision tree:
```
1. Estimate inputTokens + outputTokens for this batch (from prompts.ts TOKEN_ESTIMATE)
2. Check Gemini:
   - circuitBreaker.gemini == CLOSED or HALF_OPEN?
   - checkAndReserveQuota("gemini", candidateCount) allowed?
   → if both yes AND candidateCount ≤ LLM_CANDIDATE_THRESHOLD (default: 10): return "gemini"
3. Check OpenAI:
   - circuitBreaker.openai == CLOSED or HALF_OPEN?
   - checkAndReserveQuota("openai", candidateCount) allowed?
   → if both yes: return "openai"
4. return null  → phase: "rate_limited"
```

`LLM_CANDIDATE_THRESHOLD` (default: 10): if candidates exceed this, prefer OpenAI regardless of Gemini quota — large batches deplete the free-tier RPD too fast.

Fallback path (called when primary throws a retriable error):
```
primary threw ProviderRateLimitError | ProviderServerError | ProviderTimeoutError | ProviderParseError?
  → increment circuit breaker failure count for primary
  → try the other provider if its circuit is CLOSED/HALF_OPEN and quota allows
  → if other provider also fails → throw, let caller return rate_limited
primary threw ProviderAuthError?
  → do NOT fallback — surface immediately, this needs operator attention
```

---

## 11. Idempotency (`idempotency.ts`)

Prevents duplicate transaction inserts when a provider succeeds but the HTTP response times out before reaching the caller, causing a retry.

### DB model: `LlmBatchIdempotency`

```prisma
model LlmBatchIdempotency {
  id         String   @id @default(cuid())
  batchKey   String   @unique  // hash of (syncJobId + sorted msgIds)
  resultJson String   // serialised EmailParseResult[]
  createdAt  DateTime @default(now())
  expiresAt  DateTime // createdAt + 1 hour

  @@index([expiresAt])  // for TTL cleanup
}
```

### Flow:

1. Before calling LLM: compute `batchKey = sha256(syncJobId + sortedMsgIds.join(","))`
2. Check `LlmBatchIdempotency` for existing unexpired result
3. If found: return cached result, skip LLM call
4. If not found: call LLM, store result, then process transactions
5. Cron tick prunes expired rows (`expiresAt < now()`)

---

## 12. Structured LLM Call Logging (`LlmCallLog`)

Replaces the overloaded `resolvedBy` string on `ParseLog`. Each LLM call (primary or fallback) gets one row.

```prisma
model LlmCallLog {
  id             String   @id @default(cuid())
  syncJobId      String?
  userId         String?
  batchKey       String?
  provider       String   // "gemini" | "openai"
  model          String
  candidateCount Int
  wasFallback    Boolean  @default(false)
  fallbackReason String?  // "rate_limit" | "server_error" | "timeout" | "parse_error"
  outcome        String   // "success" | "error"
  errorDetail    String?
  latencyMs      Int
  inputTokens    Int
  outputTokens   Int
  estimatedCostUsd Float
  createdAt      DateTime @default(now())

  @@index([provider, createdAt])
  @@index([syncJobId])
}
```

`ParseLog.resolvedBy` retains values `"static" | "template" | "exact_cache" | "gemini" | "openai"` — simplified, no `_fallback` suffix (that detail is in `LlmCallLog.wasFallback`).

---

## 13. Concurrency Cap

Prevent multiple Vercel instances (cron + client) from running `/advance` simultaneously, causing duplicate processing and quota bursts.

### DB model: `SyncJobLock` (advisory lock)

```prisma
model SyncJobLock {
  jobId     String   @id
  lockedAt  DateTime @default(now())
  expiresAt DateTime // lockedAt + 90s

  @@index([expiresAt])
}
```

### Flow in `advance/route.ts`:

```
1. Attempt INSERT INTO SyncJobLock (jobId, expiresAt = now + 90s)
   — use Prisma $executeRaw with ON CONFLICT DO NOTHING
2. If 0 rows inserted → another instance holds the lock → return { phase: "running" } immediately (no work done)
3. If 1 row inserted → proceed with advanceJob()
4. In finally block: DELETE FROM SyncJobLock WHERE jobId = ?
5. Cron tick prunes stale locks (expiresAt < now) to handle crashed instances
```

Max concurrent `/advance` workers: `MAX_CONCURRENT_ADVANCE` env var (default: 1 per job, enforced by the per-job lock).

---

## 14. Changes to `advance/route.ts`

- Rename `apiKey` → removed (each adapter reads its own key)
- Rename `geminiQueue` → `llmQueue`, `geminiNeeded` → `llmCandidates`
- Replace `checkGeminiRateLimit()` + `parseEmailBatch()` + `incrementGeminiUsage()` block with:
  ```typescript
  const provider = await selectProvider(llmCandidates.length);
  if (!provider) return { phase: "rate_limited", newTransactions: 0, source: "llm" };
  const { results, meta } = await parseEmailBatchLLM(llmCandidates, provider);
  await writeLlmCallLog(meta, job.id, job.userId);
  ```
- `resolvedBy` on `ParseLog` uses `meta.provider` (`"gemini"` or `"openai"`)
- Acquire `SyncJobLock` before `advanceJob()`, release in finally

---

## 15. Changes to `reconcile/route.ts`

- Replace `callGeminiForStatement()` with `parseStatementLLM(body)` from `src/lib/llm/index.ts`
- `parseStatementLLM(body: string): Promise<{ raw: string; meta: LLMCallMeta }>` — returns the raw LLM text output (parsed by existing `parseStatementItems`) plus call metadata for logging. Uses same router; statement calls are candidateCount = 1 → always routes to Gemini first.

---

## 16. Changes to `reprocess/route.ts`

- Replace `parseEmailBatch([...], apiKey)` with `parseEmailBatchLLM([...])` from `src/lib/llm/index.ts`
- candidateCount = 1 → routes to Gemini first
- Logs to `LlmCallLog` with `syncJobId = null`

---

## 17. DB Migration Summary

New models (4 new tables):
1. `LlmCallLog` — structured LLM call audit log
2. `LlmQuotaWindow` — sliding RPM/TPM/RPD windows per provider
3. `LlmCircuitBreaker` — per-provider circuit breaker state
4. `LlmBatchIdempotency` — batch dedup for timeout-retry scenarios
5. `SyncJobLock` — per-job advisory lock

Changed models:
- `GeminiUsageLog` — no longer written by new code. Existing rows kept for backwards compatibility with any admin UI queries. Drop in a follow-up migration once admin UI is updated to read from `LlmQuotaWindow`.
- `ParseLog.resolvedBy` — values simplified (no schema change needed, String field)

---

## 18. Environment Variables (complete list)

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Gemini API key (existing) |
| `OPENAI_API_KEY` | — | OpenAI API key (new) |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Gemini model ID |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI model ID |
| `GEMINI_RPM_LIMIT` | `15` | Gemini requests per minute |
| `GEMINI_TPM_LIMIT` | `250000` | Gemini tokens per minute |
| `GEMINI_RPD_LIMIT` | `1000` | Gemini requests per day |
| `OPENAI_RPM_LIMIT` | `500` | OpenAI requests per minute |
| `OPENAI_TPM_LIMIT` | `200000` | OpenAI tokens per minute |
| `OPENAI_RPD_LIMIT` | `10000000` | OpenAI requests per day |
| `LLM_CANDIDATE_THRESHOLD` | `10` | Candidates above this → prefer OpenAI |
| `LLM_TIMEOUT_MS` | `30000` | Per-provider request timeout |
| `LLM_CB_FAILURE_THRESHOLD` | `3` | Failures before circuit opens |
| `LLM_CB_COOLDOWN_MS` | `60000` | Circuit breaker cooldown |
| `CHUNK_SIZE` | `25` | Emails fetched per tick |
| `LLM_BATCH_SIZE` | `25` | Max candidates per LLM call — if `llmCandidates.length > LLM_BATCH_SIZE`, return `rate_limited` rather than sub-batch |
| `MAX_CONCURRENT_ADVANCE` | n/a | Removed — concurrency is controlled per-job by `SyncJobLock`; multiple distinct jobs may run in parallel |

---

## 19. Testing Plan

- Unit tests for `router.ts`: all routing decision branches
- Unit tests for `quota.ts`: RPM/TPM/RPD window logic, atomic increment races
- Unit tests for `circuitBreaker.ts`: state transitions
- Unit tests for `idempotency.ts`: cache hit, cache miss, expiry
- Integration tests: mock Gemini returning 429 → verify OpenAI is called; mock OpenAI 401 → verify no fallback attempted
- Manual: trigger retro sync with `>500 emails`, verify `LlmCallLog` shows `openai` as provider
- Manual: trigger daily sync with `<50 emails`, verify `LlmCallLog` shows `gemini` as provider
- Manual: set `GEMINI_RPD_LIMIT=0`, verify routing falls through to OpenAI
