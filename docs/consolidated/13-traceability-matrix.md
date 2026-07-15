# 13 — Traceability Matrix

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 8
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 8 corrections:** 2026-07-15 — NFR-DATA-2 row fixed: [Partial] qualifier moved into
> Requirement cell (was an extra 8th column in a 7-column table). Freeze metadata updated. K-01, K-02.
> **Pass 3 corrections:** 2026-07-14 — FR-A2 (syncFromDate read-only; no write route);
> FR-B8 [Partial]; FR-C1 resolvedBy=NULL; API methods corrected (gmail-query, exclusion-rules,
> subcategories, demo, transactions/[id]); FR-D3 PATCH only; FR-D6 DELETE; FR-J2 SyncJobMessage;
> E2E spec filename corrections.
> **Pass 4 corrections:** 2026-07-15 — FR-E2 subcategory API methods corrected; FR-E1/FR-H5
> E2E coverage descriptions corrected; NFR-LAT-1/NFR-REL-6 E2E mappings corrected;
> NFR-SCALE-1/2 terminology updated; spec filename corrected (G-09).
> **Pass 5 corrections:** 2026-07-15 — FR-E1 E2E cell clarified (no CRUD E2E coverage);
> FR-K2 E2E cell corrected (setup project, not globalSetup); §3 gap table updated (FR-E1
> category CRUD no E2E; NFR-LAT-1 60s limit no E2E). H-04, H-05.
> **Pass 6 corrections:** 2026-07-15 — NFR-LAT-1 E2E cell set to `none` (page-load tests
> do not cover 60s advance limit); FR-E1 E2E cell set to `none` for CRUD with dropdown note;
> route-count formula corrected. I-04, I-05.
> **Pass 7 corrections:** 2026-07-15 — FR-C4 unit-test cell corrected (11 files in
> `tests/lib/llm/` + 2 legacy in `tests/lib/`; was "13 files"); FR-C9 E2E cell qualified
> (T9.1 tab load only; reprocess has no E2E coverage); FR-D3 E2E cell set to `none`
> (transaction editing not covered by `05-transactions.spec.ts`); NFR-DATA-2 changed to
> [Partial] with REL-8 reference; FR-C9 reprocessing and FR-D3 editing added to §3 gap table;
> freeze metadata standardized. J-01, J-02, J-03.

> Maps every FR (from `02`) and NFR (from `03`) to: implementing component/lib, API route,
> DB model(s), unit test, and E2E test. "—" means not applicable or not present.
> "**none**" in the unit or E2E column means a coverage gap. Status tags as in `00-index.md`.

---

## 1. Functional requirements

### A. Authentication & onboarding

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-A1 | Google sign-in (gmail.readonly) | `auth.config.ts`, `auth.ts` | `/api/auth/[...nextauth]` | `User`, `Account`, `Session` | `tests/lib/auth.test.ts` | `e2e/01-auth.spec.ts` |
| FR-A2 | Onboarding: sync-from period picker | `settings/page.tsx` (onboarding view) | (no write route — `User.syncFromDate` is read as fallback by `sync/start/route.ts:47` but never written by any route; `PATCH /api/user/info` does not exist — **[Partial — schema field exists; no write path]**) | `User.syncFromDate` (read-only fallback) | `tests/lib/onboarding.test.ts` | `e2e/02-onboarding.spec.ts` T2.2, T2.3 |
| FR-A3 | Session persistence (DB-backed) | `auth.ts` (PrismaAdapter, `session:"database"`) | `/api/auth/[...nextauth]` | `Session` | `tests/lib/auth.test.ts` | `e2e/01-auth.spec.ts` |

### B. Gmail sync pipeline

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-B1 | Start sync (returns jobId fast, async work) | `sync/start/route.ts` | `POST /api/gmail/sync/start` | `SyncJob` | — | `e2e/03-sync.spec.ts` T3.2 |
| FR-B2 | One active job per user (409 on conflict) | `sync/start/route.ts` | `POST /api/gmail/sync/start` | `SyncJob` | — | `e2e/03-sync.spec.ts` T3.3 |
| FR-B3 | Daily cron advances pending jobs [Partial] | `advance/route.ts`, `vercel.json` | `GET /api/gmail/sync/advance` | `SyncJob`, `SyncJobMessage` | — | — |
| FR-B4 | Chunked, resumable processing | `advance/route.ts` | `GET /api/gmail/sync/advance` | `SyncJob`, `SyncJobMessage` | — | `e2e/03-sync.spec.ts` T3.4 |
| FR-B5 | Distributed lock on job advance | `src/lib/llm/lock.ts` | `GET /api/gmail/sync/advance` | `SyncJobLock` | `tests/lib/llm/lock.test.ts` | — |
| FR-B6 | Sync controls: status, active, pause, cancel, retro | `sync/status`, `sync/active`, `sync/pause`, `sync/cancel`, `sync/retro` routes | `/api/gmail/sync/{status,active,pause,cancel,retro}` | `SyncJob` | — | `e2e/03-sync.spec.ts` |
| FR-B7 | Watermark = job start time | `advance/route.ts` | `GET /api/gmail/sync/advance` | `SyncJob.startedAt` | — | — |
| FR-B8 | Auto-recovery of stuck / 1-error rows **[Partial]** | `advance/route.ts` (SQL recovery at lines 80–107) | `GET /api/gmail/sync/advance` | `SyncJobMessage` | — | — |

### C. Parsing & categorization

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-C1 | Tier-0 static parser (fast path; `resolvedBy=NULL` — field omitted for static outcomes) | `src/lib/staticParser.ts` | (via advance) | `ParseLog` | **none** ← gap | — |
| FR-C2 | Tier-1 exact cache (prior-parse by msgId) | `src/lib/exactResultCache.ts` | (via advance) | `ParseLog` | `tests/lib/exactResultCache.test.ts` | — |
| FR-C3 | Tier-2 template cache (SHADOW→ACTIVE→DEGRADED→DISABLED) | `src/lib/parseTemplateCache.ts` | (via advance) | `ParseTemplate`, `ParseLog` | `tests/lib/parseTemplateCache.test.ts` (31 blocks) | — |
| FR-C4 | Tier-3 LLM extraction (`resolvedBy="llm"`) | `src/lib/llm/` | (via advance) | `LlmCallLog`, `ParseLog` | 11 files in `tests/lib/llm/*.test.ts` + 2 legacy LLM tests in `tests/lib/` (`gemini.test.ts`, `geminiRateLimit.test.ts`) | — |
| FR-C5 | VPA / UPI merchant auto-learn | `src/lib/vpaLookup.ts` | `GET/POST /api/vpa` | `VpaMerchantMap` | **none** ← gap | — |
| FR-C6 | Merchant master & category learning | `src/lib/merchantMaster.ts` | (via advance + category PATCH) | `MerchantMaster`, `MerchantRule` | **none** ← gap | — |
| FR-C7 | LLM resilience (quota, breaker, idempotency, one-provider-per-tick) | `src/lib/llm/router.ts`, `quota.ts`, `circuitBreaker.ts`, `idempotency.ts` | — | `LlmQuotaWindow`, `LlmCircuitBreaker`, `LlmBatchIdempotency` | `tests/lib/llm/{router,quota,circuitBreaker,idempotency}.test.ts` | — |
| FR-C8 | Deduplication (3-layer: gmailMsgId + fingerprint + sourceRank) | `src/lib/dedup.ts` | (via advance) | `Transaction` (2× `@@unique`) | `tests/lib/dedup.test.ts` | — |
| FR-C9 | Parse logging + reprocess | `advance/route.ts`, `src/app/api/settings/parse-logs` | `GET /api/settings/parse-logs`, `POST /api/settings/parse-logs/[id]/reprocess` | `ParseLog` | — | `e2e/09-parselogs.spec.ts` T9.1 (tab load only — reprocess has **no E2E coverage**) |

### D. Transactions

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-D1 | List & search transactions | `src/app/api/transactions/route.ts` | `GET /api/transactions` | `Transaction` | — | `e2e/05-transactions.spec.ts` T5.1–T5.3 |
| FR-D2 | Edit category / sub-category | `src/app/api/transactions/[id]/category/route.ts` | `PATCH /api/transactions/[id]/category` | `Transaction`, `MerchantMaster` | `tests/api/transactions-category.test.ts` | `e2e/06-categories.spec.ts` T6.1, T6.6 |
| FR-D3 | Edit transaction | `src/app/api/transactions/[id]/route.ts` | `PATCH /api/transactions/[id]` (PATCH only — no DELETE handler) | `Transaction` | — | **none** — transaction editing not covered by E2E |
| FR-D4 | Export CSV | `src/app/api/transactions/export/route.ts` | `GET /api/transactions/export` | `Transaction` | — | `e2e/05-transactions.spec.ts` T5.12 |
| FR-D5 | Review flags (`reviewed`, `needsReview`) [Partial] | `advance/route.ts` (sets fields) | — | `Transaction.reviewed`, `Transaction.needsReview` | — | **none** — no E2E coverage |
| FR-D6 | Demo / seed transactions — removes demo data | `src/app/api/transactions/demo/route.ts` | `DELETE /api/transactions/demo` | `Transaction` | — | — |
| FR-D7 | Empty state | (UI component) | — | — | — | `e2e/05-transactions.spec.ts` T5.14 |

### E. Categories & sub-categories

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-E1 | Manage categories (CRUD) | `src/app/api/categories/` | `GET/POST /api/categories`, `PATCH/DELETE /api/categories/[id]` | `Category` | `tests/api/categories.test.ts` | **none** (CRUD: no E2E coverage; dropdown behaviour at T6.1/T6.6 tests `e2e/06-categories.spec.ts` separately) |
| FR-E2 | Manage sub-categories (CRUD) | `src/app/api/subcategories/`, `src/app/api/settings/subcategories/` | `GET/POST /api/subcategories`, `PATCH/DELETE /api/subcategories/[id]`, `GET/POST/DELETE /api/settings/subcategories` | `SubCategory`, `SubCategoryMaster` | — | — |

### F. Analytics dashboard

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-F1 | KPI cards & spend breakdown | `src/lib/analytics.ts`, `src/app/api/analytics/dashboard` | `GET /api/analytics/dashboard` | `Transaction` | `tests/lib/analytics.test.ts` (15 blocks) | `e2e/04-dashboard.spec.ts` T4.1–T4.3; `e2e/11-analytics.spec.ts` |
| FR-F2 | Transaction detail from dashboard | (UI component) | — | `Transaction` | — | `e2e/04-dashboard.spec.ts` T4.6 |

### G. Assets / net worth

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-G1 | Manage assets (CRUD) | `src/app/api/assets/` | `GET/POST /api/assets`, `PATCH/DELETE /api/assets/[id]` | `Asset` | — | `e2e/10-assets.spec.ts` T10.1, T10.2, T10.5 |

### H. Settings

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-H1 | Email filters — legacy, settings-only [Partial] | `src/app/api/settings/filters/` | `GET/POST /api/settings/filters`, `DELETE .../[id]` | `EmailFilter` (SYSTEM_GLOBAL) | — | `e2e/07-filters.spec.ts` T7.2, T7.5 |
| FR-H2 | Gmail query keywords | `src/lib/gmailQuery.ts`, `/api/settings/gmail-query` | `GET/POST/DELETE/PATCH /api/settings/gmail-query` | `GmailQueryKeyword` (SYSTEM_GLOBAL) | **none** ← gap | `e2e/07-filters.spec.ts` |
| FR-H3 | Exclusion rules | `src/app/api/settings/exclusion-rules/` | `GET/POST/DELETE/PATCH /api/settings/exclusion-rules` | `ExclusionRule` (SYSTEM_GLOBAL) | — | — |
| FR-H4 | Statement passwords (storage AES-256-GCM) [Confirmed storage / Not Implemented parsing] | `src/lib/crypto.ts`, `/api/settings/statement-passwords` | `GET/POST /api/settings/statement-passwords`, `DELETE .../[domain]` | `StatementPassword` | `tests/lib/crypto.test.ts` | `e2e/08-passwords.spec.ts` T8.1, T8.3 |
| FR-H5 | Parse logs (view + reprocess) | `src/app/api/settings/parse-logs/` | `GET /api/settings/parse-logs`, `POST .../[id]/reprocess` | `ParseLog` | — | `e2e/09-parselogs.spec.ts` T9.1 (tab load only — not reprocess) |

### I. Reconciliation

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-I1 | Statement ↔ transaction reconciliation [Partial] | `src/lib/reconcile.ts` | `POST /api/gmail/reconcile` | `ReconciliationLog` | `tests/lib/reconcile.test.ts` (12 blocks) | **none** — no E2E coverage |

### J. User data & privacy

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-J1 | User info | `src/app/api/user/info/route.ts` | `GET /api/user/info` | `User` | — | — |
| FR-J2 | Delete my data (partial scope) | `src/app/api/user/data/route.ts` | `DELETE /api/user/data` | `Transaction`, `SyncJob`, `ParseLog`, `Asset`; `SyncJobMessage` (deleted via `SyncJob` cascade — `onDelete: Cascade`); resets `User.gmailSyncedAt` | — | — |

### K. Operational

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| FR-K1 | Health check | `src/app/api/health/route.ts` | `GET /api/health` | — | — | `e2e/12-api.spec.ts` |
| FR-K2 | Test auth seed (non-prod) | `src/app/api/test/auth-seed/route.ts` | `POST /api/test/auth-seed` | `Session`, `User` | — | `e2e/12-api.spec.ts` (Playwright setup project — `e2e/setup/auth.setup.ts`; not a `globalSetup` function) |

---

## 2. Non-functional requirements

### Cost

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-COST-1 | ≈ $0/month via free-tier stack + LLM caps | `quota.ts`, `circuitBreaker.ts`, Neon free tier | — | `LlmQuotaWindow`, `LlmCircuitBreaker` | `tests/lib/llm/{quota,circuitBreaker}.test.ts` | — |
| NFR-COST-2 | Prefer Gemini free tier; OpenAI as bounded fallback | `src/lib/llm/router.ts` | — | `LlmCallLog` | `tests/lib/llm/router.test.ts` | — |
| NFR-COST-3 | Track spend per LLM call | `src/lib/llm/index.ts` | — | `LlmCallLog.estimatedCostUsd`, `GeminiUsageLog` | — | — |

### Latency & serverless budget

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-LAT-1 | Advance within 60s Vercel limit | `advance/route.ts`, `vercel.json` (`maxDuration: 60`) | `GET /api/gmail/sync/advance` | — | — | **none** |
| NFR-LAT-2 | ≤ 25 emails per advance tick (`CHUNK_SIZE`) | `advance/route.ts` (line 22) | `GET /api/gmail/sync/advance` | `SyncJobMessage` | — | — |
| NFR-LAT-3 | LLM timeout 30s per provider | `providers/gemini.ts`, `providers/openai.ts` | — | — | `tests/lib/llm/{gemini,openai}.test.ts` | — |
| NFR-LAT-4 | UI never blocks on slow sync (job created immediately) | `sync/start/route.ts` | `POST /api/gmail/sync/start` | `SyncJob` | — | `e2e/03-sync.spec.ts` T3.2 |
| NFR-LAT-5 | Gemini preferred for lower latency | `src/lib/llm/router.ts` (Gemini primary) | — | — | `tests/lib/llm/router.test.ts` | — |

### Scalability

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-SCALE-1 | Support 2–10 users at POC stage | Per-user isolation (`userId` FK) | — | All TENANT_SCOPED_ENFORCED models | — | — |
| NFR-SCALE-2 | Per-user data isolation | `prisma/schema.prisma` (`userId` + `onDelete: Cascade`) | — | All TENANT_SCOPED_ENFORCED models | — | — |
| NFR-SCALE-3 | Resumable sync for large mailboxes | `advance/route.ts`, `SyncJobMessage` | `GET /api/gmail/sync/advance` | `SyncJob.scanPageToken`, `SyncJobMessage` | — | — |
| NFR-SCALE-4 | Single-instance Hobby deploy (SyncJobLock supports multi-instance) [Partial] | `src/lib/llm/lock.ts` | — | `SyncJobLock` | `tests/lib/llm/lock.test.ts` | — |

### Reliability & resilience

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-REL-1 | Circuit breaker per LLM provider | `src/lib/llm/circuitBreaker.ts` | — | `LlmCircuitBreaker` | `tests/lib/llm/circuitBreaker.test.ts` | — |
| NFR-REL-2 | Idempotent LLM batches | `src/lib/llm/idempotency.ts` | — | `LlmBatchIdempotency` | `tests/lib/llm/idempotency.test.ts` | — |
| NFR-REL-3 | Distributed lock prevents concurrent advance | `src/lib/llm/lock.ts` | — | `SyncJobLock` | `tests/lib/llm/lock.test.ts` | — |
| NFR-REL-4 | Auto-recovery of stuck messages | `advance/route.ts` (SQL recovery) | `GET /api/gmail/sync/advance` | `SyncJobMessage` | — | — |
| NFR-REL-5 | One provider per tick (no within-tick fallback) | `src/lib/llm/router.ts` (commit `31a6077`) | — | — | `tests/lib/llm/router.test.ts` | — |
| NFR-REL-6 | Graceful degradation to empty states | (UI components) | — | — | — | `e2e/05-transactions.spec.ts` T5.14; `e2e/10-assets.spec.ts` T10.2 (not `13-nonfunctional.spec.ts`) |
| NFR-REL-7 | Graceful error responses (404, 400) | (API route handlers) | Multiple | — | — | `e2e/14-errors.spec.ts` T14.1–T14.3 |

### Data integrity

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-DATA-1 | No duplicate transactions | `src/lib/dedup.ts` | (via advance) | `Transaction` (`@@unique` ×2) | `tests/lib/dedup.test.ts` | — |
| NFR-DATA-2 | Deterministic parse audit trail **[Partial]** — emails missing from Gmail batch response produce no `ParseLog` (REL-8 in `10`) | `advance/route.ts` | — | `ParseLog` | — | — |
| NFR-DATA-3 | Cascade delete of user-owned rows | `prisma/schema.prisma` (`onDelete: Cascade`) | — | All TENANT_SCOPED_ENFORCED models | — | — |

### Security & privacy

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-SEC-1 | Gmail read-only scope | `src/lib/auth.config.ts` | `/api/auth/*` | `Account` | `tests/lib/auth.test.ts` | `e2e/01-auth.spec.ts` |
| NFR-SEC-2 | No raw email bodies stored | `advance/route.ts` (stores `gmailMsgId` only) | — | `Transaction`, `ParseLog` (no body column) | — | — |
| NFR-SEC-3 | Statement passwords encrypted (AES-256-GCM) | `src/lib/crypto.ts` | `/api/settings/statement-passwords` | `StatementPassword.encryptedPassword` | `tests/lib/crypto.test.ts` | `e2e/08-passwords.spec.ts` T8.3 |
| NFR-SEC-4 | Cron endpoint authenticated (bearer) | `advance/route.ts` (lines 603–607) | `GET /api/gmail/sync/advance` | — | — | — |
| NFR-SEC-5 | Secrets not committed to git | `.gitignore` (`.env*`), verified 2026-07-14 | — | — | — | — |

### Maintainability / quality

| ID | Requirement | Component / lib | API route | DB model(s) | Unit test | E2E test |
|----|-------------|-----------------|-----------|-------------|-----------|----------|
| NFR-QUAL-1 | Unit tests for core logic [Partial] | `tests/` (26 files, ~178 blocks) | — | — | All `tests/` files | — |
| NFR-QUAL-2 | E2E coverage of user flows | `e2e/` (15 specs, **50** blocks — see `09-testing-quality.md §3`) | — | — | — | All `e2e/` specs |
| NFR-QUAL-3 | Type safety (TypeScript strict) | `tsconfig.json` (Next.js 16 / TS 5.9) | — | — | — | — |

---

## 3. Coverage gap summary

Requirements with **no** unit or E2E test coverage (gaps from `09-testing-quality.md §5`):

| ID | Requirement | Gap type |
|----|-------------|----------|
| FR-C1 | Tier-0 static parser | No unit test (`staticParser.ts`) |
| FR-C5 | VPA / UPI merchant auto-learn | No unit test (`vpaLookup.ts`) |
| FR-C6 | Merchant master learning | No unit test (`merchantMaster.ts`) |
| FR-C9 | Parse log reprocessing | No E2E coverage for the reprocess action (T9.1 covers tab load only) |
| FR-D3 | Edit transaction | No E2E coverage for transaction editing |
| FR-D5 | Review flags (`needsReview`) | No E2E coverage |
| FR-E1 | Manage categories (CRUD) | No E2E coverage for create/rename/delete category |
| FR-H2 | Gmail query keywords | No unit test (`gmailQuery.ts`) |
| FR-I1 | Reconciliation | No E2E coverage |
| NFR-LAT-1 | 60s advance limit | No E2E test verifies the advance route completes within 60s |

---

*Cross-references:* requirements source → `02-functional-requirements.md`, `03-non-functional-requirements.md`;
test inventory → `09-testing-quality.md`; risk of gaps → `10-risks-tech-debt.md §4`.
