# 04 — Architecture

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — document text updated through Pass 6 against the
> same commit anchor. No modifications to the baseline commit itself.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C29: §8 route tree — `DELETE /api/gmail/scan/{id}` and `GET /api/gmail/scan/list` removed;
>   replaced with `POST /api/gmail/scan/{id}/pause|resume|cancel|retry` sub-routes.
> **Phase 0 revision 2026-07-19 pass 9 (C48):**
> C48: Progress response fields updated to canonical names — `fetch_success_count`,
>   `fetch_failed_count`, `filter_included_count`, `filter_excluded_count`,
>   `last_error_message_sanitized`; obsolete `total_fetched`, `total_fetch_failed`,
>   `total_skipped`, `items_included`, `items_excluded`, `items_no_filter`, `error_message`
>   removed.
> **Phase 0 revision 2026-07-19:** §8 scan-start flow corrected: initial status `CREATED`
> (not `PENDING`); progress API field `filter_version_id` → `email_filter_id` + `email_filter_version_id`.
> **Phase 0 revision 2026-07-18:** §8 (target-state, migration, QStash, live-progress
> architecture) added per Correction #1 from Phase 0 decision message.
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Pass 3 corrections:** 2026-07-14 — resolvedBy=NULL for static tier-0 (not "static");
> cron diagram corrected to GET; TENANT_KEYED_NOT_ENFORCED note added.
> **Pass 4 corrections:** 2026-07-15 — diagram "txn CRUD/export" corrected to "txn
> list/search/edit/export (no DELETE on [id])" (G-03).
> **Pass 6 corrections:** 2026-07-15 — §2.3 parse-audit-trail claim narrowed: missing Gmail
> batch responses are silently skipped with no ParseLog. I-03.

> §1–§7: As-built current state. Components cite their source files. State machines and the
> parse chain are reconstructed from the actual routes/libs, not from prior docs.
> §8: Proposed Phase 1A target architecture — all items tagged `[Planned — pending approval]`.
> Tags per `00-index.md`.

---

## 1. High-level shape

Single **Next.js 16 (App Router)** application, deployed on **Vercel (Hobby)**, backed by
**Neon serverless PostgreSQL** via Prisma 7. No microservices; all server logic lives in
API routes (`src/app/api/**/route.ts`) and shared libs (`src/lib/**`). **[Confirmed]** —
`package.json`, `vercel.json`, `prisma.config.ts`.

```
Browser (React 19 UI, Tailwind v4)
        │  HTTPS
        ▼
Next.js App Router  ──────────────────────────────┐
  ├─ (app) pages: dashboard, transactions, assets, │
  │        settings, onboarding, login             │
  ├─ /api/auth/*            → NextAuth v5 (Google)  │
  ├─ /api/gmail/sync/*      → sync state machine    │  Prisma 7
  ├─ /api/gmail/reconcile   → reconciliation        │ ────────► Neon PostgreSQL
  ├─ /api/transactions/*    → txn list/search/edit/export (no DELETE on [id])       │
  ├─ /api/analytics/*       → dashboard aggregates  │
  ├─ /api/assets/*          → net worth             │
  ├─ /api/categories, /api/subcategories, /api/vpa  │
  └─ /api/settings/*        → filters, keywords,    │
                              exclusions, passwords, │
                              parse-logs             │
        │                                            │
        ├── src/lib/gmail.ts  ───► Gmail API (readonly)
        ├── src/lib/staticParser.ts / exactResultCache.ts / parseTemplateCache.ts
        ├── src/lib/llm/*     ───► Gemini API (primary) / OpenAI API (fallback)
        ├── src/lib/vpaLookup.ts, merchantMaster.ts
        └── src/lib/crypto.ts (AES-256-GCM for statement passwords)

Vercel Cron (0 2 * * *) ──► GET /api/gmail/sync/advance (bearer auth)
```

---

## 2. Components & responsibilities

### 2.1 Auth (split config)
- `src/lib/auth.config.ts` — **edge-safe** config: Google provider (`gmail.readonly`,
  offline+consent), `authorized` callback listing public routes (`/login`, `/api/auth`,
  `/api/gmail/sync/advance`, `/api/test/auth-seed`, `/api/health`). **[Confirmed]**
- `src/lib/auth.ts` — **Node-only** config: PrismaAdapter + `session: "database"`. **[Confirmed]**
- Split exists because the Prisma adapter can't run on the edge middleware runtime. See `06`.

### 2.2 Sync subsystem (`/api/gmail/sync/*`, `src/lib/gmail.ts`)
Drives the email→transaction pipeline. Endpoints: `start`, `advance` (cron — GET only;
does **not** start new jobs, only progresses existing ones), `status`, `active`, `pause`,
`cancel`, `retro`. Persists progress in `SyncJob` + `SyncJobMessage`; serialized by
`SyncJobLock`. **[Confirmed]**

### 2.3 Parse chain (tier 0→3)
Deterministic-first, LLM-last (see §4). Libs: `staticParser.ts`, `exactResultCache.ts`,
`parseTemplateCache.ts`, `llm/`. All successfully fetched candidate emails are logged to
`ParseLog`. **[Confirmed]** — note: emails omitted from a Gmail batch response are silently
skipped with no ParseLog entry (see REL-8 in `10-risks-tech-debt.md`).

### 2.4 LLM subsystem (`src/lib/llm/`)
Provider-agnostic façade with routing, quota, circuit breaker, idempotency, lock, prompts,
validation (see §5). **[Confirmed]**

### 2.5 Learning stores
`MerchantMaster` (normalized merchant → category), `VpaMerchantMap` (UPI handle → merchant),
`SubCategoryMaster`. Feed future parses to avoid LLM calls. **[Confirmed]**

### 2.6 Domain APIs
Transactions, analytics, assets, categories, sub-categories, reconciliation, VPA, user data.
**[Confirmed]** (see `05` for the full route table).

### 2.7 Settings & config stores
`EmailFilter` (legacy), `GmailQueryKeyword`, `ExclusionRule`, `StatementPassword`, parse-logs.
**[Confirmed]**

### 2.8 Crypto (`src/lib/crypto.ts`)
AES-256-GCM encrypt/decrypt for statement PDF passwords. **[Confirmed]**

---

## 3. Sync state machine

Statuses observed in code (`sync/start`, `sync/advance`):

```
        start (POST /api/gmail/sync/start)
                │  (409 if a job already in {scanning, running})
                ▼
          ┌───────────┐  scan pages remain (nextPageToken)
          │ scanning  │◄──────────────┐
          └───────────┘               │
                │ scan complete        │ (more pages)
                ▼                       │
          ┌───────────┐  chunk of 25 ──┘
          │  running  │  processed per advance tick
          └───────────┘
             │      │ pause         │ cancel
   isDone    │      ▼               ▼
      │      │  ┌────────┐     ┌───────────┐
      ▼      │  │ paused │     │ cancelled │
 ┌──────────┐│  └────────┘     └───────────┘
 │ complete ││
 └──────────┘│  on unhandled error
             └────────────► ┌────────┐
                            │ failed │
                            └────────┘
```

- Entry: `start` sets `status = "scanning"` (`start/route.ts:56`); rejects with **409** if a
  `{scanning|running}` job exists (`start/route.ts:15–21`). **[Confirmed]**
- `advance` moves `scanning → running` when no `nextPageToken` remains (`advance:645,651`), then
  processes a `CHUNK_SIZE=25` batch per tick; sets `complete` + `completedAt` when done
  (`advance:126,582`); sets `failed` on error (`advance:137,631`). **[Confirmed]**
- `paused` / `cancelled` set by `pause` / `cancel` routes. **[Confirmed]**
- Terminal states: `complete`, `cancelled`, `failed`. **[Confirmed]**

---

## 4. Parse chain (tier 0 → tier 3)

Per candidate email, the first tier that yields a confident result wins; the outcome and which
tier resolved it are written to `ParseLog.resolvedBy`.

```
email ─► [Tier 0] staticParser.ts ── parsed / not_transaction ─► return (resolvedBy=**NULL** — field omitted)
           │ miss
           ▼
        [Tier 1] exactResultCache.ts ── prior-parse hit by gmailMsgId ─► return (resolvedBy="exact_cache")
           │ miss
           ▼
        [Tier 2] parseTemplateCache.ts (ParseTemplate ACTIVE) ─► return (resolvedBy="template")
           │ miss / SHADOW|DEGRADED shadow-run
           ▼
        [Tier 3] llm/ (Gemini→OpenAI) ── extract fields ───────► return (resolvedBy="llm")
```

- **Tier 0 static parser** runs first and early-returns; keeps most emails off the LLM. **[Undocumented → Confirmed]**
  **Note:** Static tier outcomes set **`resolvedBy = NULL`** — the field is not populated, not set to `"static"`.
  Only tiers 1–3 write explicit `resolvedBy` values. **[Confirmed]** — `advance/route.ts:242–313`.
- **Tier 1 exact cache** is a **prior-parse-result cache** keyed by `gmailMsgId` — it queries
  `ParseLog` to return a previously computed `transactionId` without re-parsing. It is **not** a
  content-hash cache. **[Confirmed]** — `src/lib/exactResultCache.ts:4–24`. *(Earlier docs described
  it as "identical email content" — **[Stale]**.)*
- **Tier 2 templates** have lifecycle `SHADOW → ACTIVE → DEGRADED → DISABLED`
  (`parseTemplateCache.ts`; statuses confirmed in code). SHADOW/DEGRADED templates **shadow-run**
  next to the LLM to gather hit/fail stats before promotion (`ParseTemplate.consecutiveSuccesses/…`).
  DISABLED templates older than a cutoff are pruned (`advance:671`). **[Undocumented → Confirmed]**
- **Tier 3 LLM** writes `resolvedBy = "llm"` (not `"gemini"`) — confirmed `advance/route.ts:455,484,513`.
- **Exclusion rules** short-circuit the chain (logged `skipped_exclusion`). **[Confirmed]**
- Outputs feed learning stores (`MerchantMaster`, `VpaMerchantMap`). **[Confirmed]**

*(Historical note: older docs describe a plain "3-tier" chain and a size-based LLM route. The
static tier-0 and Gemini-always-primary are the current reality — **[Stale]** on the size-based
claim; see `08`.)*

---

## 5. LLM subsystem detail (`src/lib/llm/`)

| Module | Responsibility | Backing model |
|--------|----------------|---------------|
| `router.ts` | Choose provider; **Gemini always primary**, OpenAI fallback (override `LLM_PRIMARY_PROVIDER`). Read-only breaker+quota checks in parallel, then a single atomic reserve+probe. | — |
| `providers/gemini.ts` | Call Gemini (`gemini-3.1-flash-lite` default), 30s timeout. | — |
| `providers/openai.ts` | Call OpenAI (`gpt-4o-mini` default), 30s timeout. | — |
| `quota.ts` | RPM/TPM/RPD windows, atomic SQL reserve/release. | `LlmQuotaWindow` |
| `circuitBreaker.ts` | CLOSED/OPEN/HALF_OPEN + half-open probe acquire/release. | `LlmCircuitBreaker` |
| `idempotency.ts` | Dedup batch calls by `batchKey`; in-flight TTL = timeout·2+30s. | `LlmBatchIdempotency` |
| `lock.ts` | Distributed lock (owner token + expiry) for job advance. | `SyncJobLock` |
| `prompts.ts` | Prompt construction for extraction. | — |
| `validate.ts` | Validate/normalize LLM output. | — |
| `index.ts` | Public façade tying the above together. | — |

Call accounting: `LlmCallLog` (provider, model, tokens, latency, cost, fallback reason),
`GeminiUsageLog` (per-day counter). **[Confirmed]**

Provider selection flow (`router.ts` `selectProvider`):
1. Read breaker state for primary + fallback in parallel.
2. Check quota for each (skip if breaker OPEN).
3. Try atomic reserve+probe on primary; if it fails, try fallback; else raise `ProviderExhaustedError`.
**[Confirmed]**

---

## 6. Middleware / runtime boundaries

- Edge middleware uses only `auth.config.ts` (no Prisma). **[Confirmed]**
- API routes run on the Node runtime with full Prisma access. **[Confirmed]**
- The `advance` route is bounded to 60s (`vercel.json` `functions.maxDuration`). **[Confirmed]**

---

## 7. Data & external integrations (pointers)

- **Gmail API** (readonly) via `src/lib/gmail.ts`. **[Confirmed]**
- **Gemini / OpenAI** via `src/lib/llm/providers/*`. **[Confirmed]**
- **Neon PostgreSQL** via Prisma adapter (`prisma.config.ts`). **[Confirmed]**

Full data model and route inventory → `05-data-model-apis.md`. Auth/security cross-cut → `06`.

---

*Cross-references:* the requirements these components satisfy → `02-functional-requirements.md`;
NFR budgets (60s, CHUNK_SIZE=25, quotas) → `03`; models/routes → `05`; what's stale → `08`.

---

## 8. Phase 1A target architecture `[Planned — pending approval]`

> All items in this section are **`[Planned — pending approval]`**. None are implemented.
> Source of truth: `14-phase0-assessment.md`. Full acceptance criteria in §15 of that document.

### 8.1 Current-state limitations

Three architectural gaps drive Phase 1A:

1. **Scanning and ingestion are fused in a single handler.** `advance/route.ts` (706 lines) performs
   Gmail ID discovery, full message fetch, static parse, LLM extraction, and `Transaction` upsert in
   one 60s Vercel function. A fetch timeout aborts all downstream processing with no partial save.
2. **Progress depends on an open browser connection.** The user must keep the sync page open; there
   is no durable progress record that survives navigation or page reload.
3. **No feature flags exist.** `LLM_PARSING_ENABLED` and `LEGACY_TRANSACTION_INGESTION_ENABLED` are
   absent from the codebase. The LLM cannot be disabled without a code deploy.

### 8.2 Target-state architecture diagram `[Planned — pending approval]`

```
Browser (React 19 UI, Tailwind v4)
        │  HTTPS
        ▼
Next.js App Router
  ├─ (existing) pages: dashboard, transactions, assets, settings, onboarding, login
  ├─ /api/auth/*                     → NextAuth v5 (Google)
  ├─ /api/gmail/sync/*               → existing sync state machine (unchanged)
  ├─ /api/gmail/reconcile            → reconciliation (unchanged)
  ├─ /api/transactions/*             → txn list/search/edit/export (unchanged)
  ├─ /api/analytics/*                → dashboard aggregates (unchanged)
  ├─ /api/assets/*                   → net worth (unchanged)
  ├─ /api/categories, /api/vpa       → (unchanged)
  ├─ /api/settings/*                 → filters, keywords, exclusions, passwords (unchanged)
  │
  ├─ NEW: /api/gmail/scan             POST — create EmailScanRun, enqueue first QStash msg
  ├─ NEW: /api/gmail/scan/worker     POST — QStash-authenticated tick (replaces advance role)
  ├─ NEW: /api/gmail/scan/{id}       GET — read status
  ├─ NEW: /api/gmail/scan/{id}/pause|resume|cancel|retry  POST — scan management
  ├─ NEW: /api/gmail/email/{id}      GET — email source metadata
  ├─ NEW: /api/gmail/email/list      GET — paginated email inventory
  ├─ NEW: /api/gmail/email/stats     GET — aggregate counts
  ├─ NEW: /api/email-filters         GET/POST — per-user filters
  └─ NEW: /api/email-filters/{id}/versions  POST/GET — publish/list filter versions
        │                                                    │
        │ Prisma 7                                           │ Prisma 7
        ▼                                                    ▼
Neon PostgreSQL (27 existing + 6 new tables = 33 total)      │
                                                             │
        │                                                    │
        ├── src/lib/gmail.ts ──► Gmail API (readonly, unchanged)
        ├── src/lib/staticParser.ts / exactResultCache.ts / parseTemplateCache.ts
        │   (legacy path — gated behind LEGACY_TRANSACTION_INGESTION_ENABLED)
        ├── src/lib/llm/* ──► Gemini API (primary) / OpenAI API (fallback)
        │   (gated behind LLM_PARSING_ENABLED)
        ├── src/lib/featureFlags.ts  NEW — isLlmParsingEnabled(), isLegacyTransactionIngestionEnabled()
        ├── src/lib/scan/            NEW — scan domain service (scheduler-agnostic)
        │     ├── scanner.ts         — scanning phase: Gmail ID discovery → email_scan_item rows
        │     ├── fetcher.ts         — fetching phase: Gmail Batch API → email_source metadata (Phase 1A stores no body)
        │     ├── scheduler.ts       — SchedulerService interface (QStash impl + no-op for tests)
        │     └── progress.ts        — counter reconciliation, live-progress reads
        └── src/lib/scan/qstash.ts  NEW — QStashSchedulerService implements SchedulerService

Upstash QStash (free tier: 1,000 msg/day, at-least-once delivery)
  enqueue ──► /api/gmail/scan/worker  ──► QStashSchedulerService.enqueueContinuation()
```

**Feature flag gates** `[Planned — pending approval]`:
- `LLM_PARSING_ENABLED=true` (default: false) — allows Tier-3 LLM calls in `llm/router.ts`
- `LEGACY_TRANSACTION_INGESTION_ENABLED=true` (default: false) — allows existing `advance/route.ts`
  parse path including static parser, template cache, exact result cache, `upsertTransactionV2`,
  and `ParseLog` creation

Both flags default to **false** (safe). The existing sync path (`/api/gmail/sync/*`) is protected
by `LEGACY_TRANSACTION_INGESTION_ENABLED`; Phase 1A does not remove it — both paths coexist.

### 8.3 Migration / coexistence architecture `[Planned — pending approval]`

Phase 1A uses an **additive, non-breaking migration strategy**:

```
Before Phase 1A:                   During Phase 1A (coexistence):
─────────────────                  ──────────────────────────────
/api/gmail/sync/* ──► ParseLog     /api/gmail/sync/* ──► ParseLog
                   ──► Transaction  (gated: LEGACY_TRANSACTION_INGESTION_ENABLED=true)
                                                                   │
                                   NEW /api/gmail/scan/* ──► email_scan_run
                                                          ──► email_scan_item
                                                          ──► email_source
                                   (LLM_PARSING_ENABLED=false during Phase 1A)
```

**Key coexistence invariants:**
- The 6 new Phase 1A tables have **no foreign key references** to `SyncJob`, `SyncJobMessage`,
  `ParseLog`, or `Transaction`. Adding them cannot corrupt existing sync state.
- `advance/route.ts` is modified **only** to add the `LEGACY_TRANSACTION_INGESTION_ENABLED` guard
  at the top (returns 503 if flag is false). No logic changes to the existing path.
- The SEC-2 fix (`querySecret` removal from `advance/route.ts`) is applied regardless of flag state.
- `ParseLog`, `SyncJob`, `SyncJobMessage`, `Transaction` rows are **not touched** by Phase 1A
  schema migration (additive migration only; see `14-phase0-assessment.md §17`).

**Rollback:** Disable `LEGACY_TRANSACTION_INGESTION_ENABLED=false` to stop legacy path.
Drop Phase 1A feature flag `LLM_PARSING_ENABLED=false` to disable AI. New tables can be retained
or dropped; they have no FKs into existing tables so dropping them is non-destructive.

### 8.4 QStash scheduling architecture `[Planned — pending approval]`

QStash replaces the Vercel Cron + browser-session-driven `advance` pattern for the new scan path.

**Message flow:**

```
POST /api/gmail/scan
   │ 1. In one DB transaction:
   │      a. Create email_scan_run (status=CREATED, batch_sequence=0)
   │      b. Persist initial pending continuation:
   │           pending_continuation_sequence = 0
   │           pending_continuation_stage    = 'DISCOVERY'
   │           pending_continuation_not_before = now()
   │           pending_continuation_published_at = NULL
   │      c. Commit.
   │ 2. Publish first QStash message using dedup ID sha256(scanRunId:DISCOVERY:0).
   │ 3. Compare-and-set: mark pending_continuation_published_at = now()
   │      WHERE pending_continuation_sequence = 0 AND published_at IS NULL.
   │ 4. Return HTTP 202 { scanRunId, status: "CREATED", schedulingStatus: "PENDING_RETRY" }
   │      if publication fails — scan stays durable; retry via POST /api/gmail/scan/{id}/retry.
   ▼
Upstash QStash
   │ Delivers POST /api/gmail/scan/worker
   │ Headers: Upstash-Signature (JWT, verified via Receiver class)
   ▼
POST /api/gmail/scan/worker
   │ 1. Verify JWT signature via Receiver.verify({ signature, body, url, clockTolerance })
   │ 2. Parse { scanRunId, stage, sequence } and validate against authoritative DB state
   │ 3. Acquire worker lease (atomic UPDATE WHERE lease expired / NULL)
   │ 4. Execute one bounded unit:
   │      - DISCOVERING phase: fetch one Gmail List API page (≤500 IDs),
   │                            upsert email_scan_item rows
   │      - FETCHING phase: fetch ≤25 full messages (Gmail Batch API),
   │                         upsert email_source metadata
   │ 5. Commit item results, counters, batch_sequence, pending continuation and lease release atomically.
   │ 6. Publish the persisted continuation via SchedulerService.enqueueContinuation().
   │ 7. Compare-and-set pending_continuation_published_at.
   │ 8. Return HTTP 200 (QStash marks delivered; no retry)
   │    OR HTTP 489 + Upstash-NonRetryable-Error: true (permanent failure; QStash does not retry)
   ▼
(Repeat until COMPLETED / COMPLETED_WITH_ERRORS / FAILED)
```

**SchedulerService interface** (domain isolation — scan service is not coupled to QStash):
```typescript
// src/lib/scan/scheduler.ts  [Planned — pending approval]
export interface ScanContinuation {
  scanRunId: string;
  stage: 'DISCOVERY' | 'FETCH';
  sequence: string;
  notBefore: Date;
}

export interface SchedulerService {
  enqueueContinuation(continuation: ScanContinuation): Promise<void>;
  cancelPending(scanRunId: string): Promise<void>;
}
```

The QStash implementation derives the deterministic deduplication ID
(`sha256(scanRunId:stage:sequence)`) from the `ScanContinuation` object.
Implementations: `QStashSchedulerService` (production), `NoOpSchedulerService` (tests).

**QStash message format:**
```json
{ "scanRunId": "<uuid>", "stage": "DISCOVERY", "sequence": "0" }
```

**Worker lease design** (prevents double-processing under at-least-once delivery):
- Lease owner: `crypto.randomUUID()` per invocation (NOT `VERCEL_REGION + Date.now()`)
- Scan-level lease: configured via `WORKER_LEASE_DURATION_SECONDS` env var (default: 55s)
- Item-level lease: configured via `ITEM_LEASE_DURATION_SECONDS` env var (derived from worker execution budget)
- Acquisition: atomic `UPDATE email_scan_run SET worker_lease_owner=$1, worker_lease_expires_at=now()+$leaseDuration WHERE id=$scanRunId AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now())`
- `state_version` tracks optimistic concurrency for post-lease state transitions; it is NOT used as a predicate on the lease acquisition query.

**Upstash QStash free-tier constraints** (confirmed 2026-07-16):

| Limit | Value | Phase 1A headroom |
|-------|-------|-------------------|
| Messages/day | 1,000 | ~133 per 3,000-email scan (<<1,000/day) |
| Max message size | 1 MB | <<1 KB per message |
| Max HTTP response time | 15 min | Each tick completes in <60s |
| DLQ retention | 3 days | Monitor DLQ for failed scans |
| Max parallelism | 10 | Single-user POC; no contention |
| Max delay | 7 days | Not used; ticks are near-immediate |

### 8.5 Live-progress architecture `[Planned — pending approval]`

Browser polls a **read-only, durable** progress endpoint. Progress survives navigation and page reloads
because it is persisted in `email_scan_run` counters, not in server memory or SSE streams.

**Polling flow:**

```
Browser                     /api/gmail/scan/{scanRunId}         Neon PostgreSQL
   │                                │                                   │
   ├─ GET (every 3s) ──────────────►│                                   │
   │                                ├─ SELECT email_scan_run ──────────►│
   │                                │   WHERE id=$scanRunId             │
   │                                │   AND user_id=$sessionUserId ◄────┤
   │                                │                                   │
   │                                ├─ counter reconciliation query ───►│
   │                                │   (recomputes from email_scan_item│
   │                                │    states to detect QStash drift) │◄───┤
   │◄── 200 { status, counters } ───┤                                   │
   │    (30+ fields; no Gmail IDs,  │                                   │
   │     no OAuth tokens,           │                                   │
   │     no QStash credentials)     │                                   │
```

**Progress response fields** (partial — full contract in `14-phase0-assessment.md §8`):
```
status, total_discovered, fetch_success_count, fetch_failed_count,
filter_included_count, filter_excluded_count, created_at, updated_at,
worker_last_active_at, estimated_completion_at, last_error_code, last_error_message_sanitized,
email_filter_id, email_filter_version_id, batch_sequence, state_version,
pending_continuation_sequence, pending_continuation_stage,
pending_continuation_not_before, pending_continuation_published_at
```

**Counter reconciliation:** The progress endpoint recomputes `email_scan_run` aggregate counters
from `email_scan_item` state rows on every poll. This detects drift caused by QStash at-least-once
redelivery (a worker tick may execute twice; the second run is idempotent but counters may diverge).
Reconciliation is a single read-only query — no writes on GET.

**Security:** The endpoint enforces `WHERE user_id = $sessionUserId`. A user cannot read another
user's scan progress by guessing a `scanRunId`. No Gmail message IDs, OAuth tokens, account numbers,
or QStash credentials appear in the response. Error messages are sanitized before storage (see §8.4
of `14-phase0-assessment.md` and `06-security-authentication.md §8`).

---

*Cross-references (Phase 1A):* full acceptance criteria → `14-phase0-assessment.md §15`; new data
models → `05-data-model-apis.md §1.9`; security controls → `06-security-authentication.md §8`;
deployment config → `11-operations-deployment.md §9`; requirements traceability →
`13-traceability-matrix.md §4`.
