# 13 — Traceability Matrix

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 8
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Phase 0 revision 2026-07-19:** §4 FR-N requirements updated: `email_filter_rule` replaced
> with two-table design (`email_filter` + `email_filter_version`); FR-N5/N6 route paths updated
> to `/api/email-filter-versions`; FR-M5/FR-O3 `source_id` → `email_source_id`; NFR-DATA-4
> `source_id` → `email_source_id` FK field name. C1–C8 corrections: NFR-DATA-6 (constraint
> triggers for cross-table FK invariants), NFR-REL-11 (two-condition completion guard), NFR-REL-12
> (QStash deterministic dedup IDs), NFR-DATA-7 (filter evaluation semantics — exclude wins) added
> to Phase 1A NFR additions table. FR-L9 updated: CANCELLING two-path documented.
> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C29: FR-L9 route updated from `DELETE /api/gmail/scan/{id}` to
>   `POST /api/gmail/scan/{id}/cancel`; FR-L10 `GET /api/gmail/scan/list` removed — scan
>   status accessible via `GET /api/gmail/scan/{id}`.
> **Phase 0 revision 2026-07-19 pass 7 (C34–C39):**
> C38: FR-L1 route corrected to `POST /api/gmail/scan`; FR-L3 body_text reference removed —
>   Phase 1A stores no body (metadata only); FR-L11 Transaction count corrected to delta (Δ=0);
>   FR-N1–N6 routes updated to `/api/email-filters` hierarchy with `/{id}/versions` for versions;
>   FR-N4 filter-preview removed (not approved for Phase 1A); NFR-SEC-6 authentication updated
>   from HMAC-SHA256 to Receiver JWT verification via `@upstash/qstash` `Receiver` class.
>   C39: D-1 pending; D-2–D-3 Approved; D-4 Conditionally approved; D-5–D-6 Approved.
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

---

## 4. Phase 1A requirements traceability `[Stage 1 database implemented; runtime pending]`

> The Stage 1 database models, migration, rollback, and executable verifier are implemented.
> Planned components, routes, and application tests listed below still do not exist. Full
> acceptance criteria are in `14-phase0-assessment.md §15`; test design is in §16.

### FR-L. Gmail scan lifecycle (email inventory collection)

| ID | Requirement | Component / lib `[Planned]` | API route `[Planned]` | DB model(s) `[Planned]` | Unit test `[Planned]` | E2E test `[Planned]` |
|----|-------------|------------------------------|----------------------|------------------------|----------------------|---------------------|
| FR-L1 | Start scan: create EmailScanRun, enqueue QStash batch | `src/lib/scan/scanner.ts`, `src/lib/scan/scheduler.ts` | `POST /api/gmail/scan` | `email_scan_run`, `email_filter_version` | `tests/api/scan-start.test.ts` | `e2e/15-email-scan.spec.ts` |
| FR-L2 | Worker discovery unit: process one Gmail List API page of ≤500 message IDs and create duplicate-safe `email_scan_item` memberships (DISCOVERING phase) | `src/lib/scan/scanner.ts` | `POST /api/gmail/scan/worker` | `email_scan_item`, `email_source` | `tests/api/scan-worker.test.ts` | `e2e/15-email-scan.spec.ts` |
| FR-L3 | Worker tick: fetch ≤25 full messages via Gmail Batch API, upsert email_source metadata — Phase 1A stores no body (FETCHING phase) | `src/lib/scan/fetcher.ts` | `POST /api/gmail/scan/worker` | `email_source` | `tests/api/scan-worker.test.ts` | — |
| FR-L4 | Worker re-enqueues next batch when work remains | `src/lib/scan/scheduler.ts`, `QStashSchedulerService` | `POST /api/gmail/scan/worker` → enqueue | `email_scan_run.batch_sequence` | `tests/lib/scan/scheduler.test.ts` | — |
| FR-L5 | Scan idempotency: re-scan produces no duplicate email_source rows (UNIQUE constraint) | `src/lib/scan/scanner.ts` (INSERT ON CONFLICT DO NOTHING) | — | `email_source` UNIQUE | `tests/api/scan-worker.test.ts` | `e2e/15-email-scan.spec.ts` |
| FR-L6 | Missing Gmail batch response: write PERMANENTLY_FAILED item + error record (no silent drop) | `src/lib/scan/fetcher.ts` | — | `email_scan_item` | `tests/api/scan-worker.test.ts` | — |
| FR-L7 | Scan status and progress: read-only polling endpoint, 30+ fields, no PII in response | `src/lib/scan/progress.ts` | `GET /api/gmail/scan/{id}` | `email_scan_run`, `email_scan_item` | — | `e2e/15-email-scan.spec.ts` |
| FR-L8 | Counter reconciliation: recompute counters from item states on every status read | `src/lib/scan/progress.ts` | `GET /api/gmail/scan/{id}` | `email_scan_item` | `tests/lib/scan/progress.test.ts` | — |
| FR-L9 | Cancel scan: two-path (no active lease → direct CANCELLED; active lease → CANCELLING, worker confirms CANCELLED) | `src/app/api/gmail/scan/[id]/cancel/route.ts` | `POST /api/gmail/scan/{id}/cancel` | `email_scan_run` | — | — |
| FR-L10 | List scan runs (paginated) — removed from Phase 1A API; scan status accessible via `GET /api/gmail/scan/{id}` | `src/lib/scan/progress.ts` | `GET /api/gmail/scan/{id}` | `email_scan_run` | — | — |
| FR-L11 | LLM_PARSING_ENABLED=false: zero Transaction rows created after complete scan (Δ=0 — no new rows, not absolute count zero) | `src/lib/featureFlags.ts` gate in router | — | `Transaction` (delta=0) | `tests/lib/featureFlags.test.ts` | `e2e/15-email-scan.spec.ts` |
| FR-L12 | Worker lease prevents double-processing under at-least-once delivery | `src/lib/scan/scanner.ts` (atomic UPDATE WHERE) | — | `email_scan_run.worker_lease_owner` | `tests/api/scan-worker.test.ts` | — |

### FR-M. Email inventory management

| ID | Requirement | Component / lib `[Planned]` | API route `[Planned]` | DB model(s) `[Planned]` | Unit test `[Planned]` | E2E test `[Planned]` |
|----|-------------|------------------------------|----------------------|------------------------|----------------------|---------------------|
| FR-M1 | List email inventory (paginated, filterable by domain/status/filter_decision) | `src/app/api/gmail/email/list/route.ts` | `GET /api/gmail/email/list` | `email_source`, `email_scan_item` | — | `e2e/15-email-scan.spec.ts` |
| FR-M2 | Email source metadata (no body_text or OAuth details in response) | `src/app/api/gmail/email/[sourceId]/route.ts` | `GET /api/gmail/email/{sourceId}` | `email_source` | — | — |
| FR-M3 | Email aggregate stats (total, fetched, failed, by filter_decision) | `src/app/api/gmail/email/stats/route.ts` | `GET /api/gmail/email/stats` | `email_scan_item` | — | — |
| FR-M4 | Manual classification: transactionally append history and update the source materialized classification/version; normal APIs expose no history update/delete | `src/app/api/gmail/email/[sourceId]/classify/route.ts` | `POST /api/gmail/email/{sourceId}/classify` | `email_source`, `email_manual_classification` | — | — |
| FR-M5 | Manual classification: audit history (all rows for email_source_id) | `src/app/api/gmail/email/[sourceId]/classifications/route.ts` | `GET /api/gmail/email/{sourceId}/classifications` | `email_manual_classification` | — | — |

### FR-N. Per-user filter management (replaces SYSTEM_GLOBAL EmailFilter)

| ID | Requirement | Component / lib `[Planned]` | API route `[Planned]` | DB model(s) `[Planned]` | Unit test `[Planned]` | E2E test `[Planned]` |
|----|-------------|------------------------------|----------------------|------------------------|----------------------|---------------------|
| FR-N1 | Create named per-user filter | `src/app/api/email-filters/route.ts` | `POST /api/email-filters` | `email_filter` | — | — |
| FR-N2 | List filters for user | `src/app/api/email-filters/route.ts` | `GET /api/email-filters` | `email_filter` | — | — |
| FR-N3 | Update or deactivate a filter | `src/app/api/email-filters/[id]/route.ts` | `PATCH/DELETE /api/email-filters/{id}` | `email_filter` | — | — |
| FR-N4 | Dry-run filter preview — **deferred; not in Phase 1A scope** | — | — | — | — | — |
| FR-N5 | Publish filter config as immutable version snapshot | `src/app/api/email-filters/[id]/versions/route.ts` | `POST /api/email-filters/{id}/versions` | `email_filter_version` | — | — |
| FR-N6 | List / view filter version history | `src/app/api/email-filters/[id]/versions/route.ts` | `GET /api/email-filters/{id}/versions` | `email_filter_version` | — | — |

### FR-O. Manual classification

| ID | Requirement | Component / lib `[Planned]` | API route `[Planned]` | DB model(s) `[Planned]` | Unit test `[Planned]` | E2E test `[Planned]` |
|----|-------------|------------------------------|----------------------|------------------------|----------------------|---------------------|
| FR-O1 | Classify email as FINANCIAL / NON_FINANCIAL / UNCERTAIN / UNREVIEWED | `src/app/api/gmail/email/[sourceId]/classify/route.ts` | `POST /api/gmail/email/{sourceId}/classify` | `email_manual_classification` | — | — |
| FR-O2 | Classification history is append-only in normal operation; UPDATE is never exposed and DELETE is reserved for the approved user-erasure transaction | (authorization and transaction boundary enforce contract) | — | `email_manual_classification` | — | — |
| FR-O3 | Current classification and version are materialized on `email_source` and updated atomically with the N+1 history row | (single service transaction) | `GET /api/gmail/email/{sourceId}` includes current classification | `email_source`, `email_manual_classification` | — | — |

### Phase 1A NFR additions

| ID | Requirement | Component / lib `[Planned]` | Notes |
|----|-------------|------------------------------|-------|
| NFR-REL-8 | QStash at-least-once delivery: all worker operations must be idempotent | `src/lib/scan/{scanner,fetcher}.ts` (INSERT ON CONFLICT DO NOTHING, optimistic concurrency) | Covers FR-L5 |
| NFR-REL-9 | Worker lease TTLs are configurable and bounded below the Vercel function limit (defaults: scan 55s, item 50s) | `email_scan_run.worker_lease_expires_at`, `email_scan_item.worker_lease_expires_at` | Per `14-phase0-assessment.md §11` |
| NFR-REL-10 | Optimistic concurrency: state_version prevents lost updates under concurrent workers | `email_scan_run.state_version`, `email_scan_item.state_version` (UPDATE WHERE state_version=$expected) | |
| NFR-SEC-6 | Worker authentication: QStash Receiver JWT verification via `@upstash/qstash` `Receiver.verify({ signature, body, url, clockTolerance })` — checked before any DB access | `src/app/api/gmail/scan/worker/route.ts` | Per `06-security-authentication.md §8.2` |
| NFR-SEC-7 | QStash credentials are server-only (never NEXT_PUBLIC_*, never logged, never stored in DB) | (env var naming convention + code review gate) | Per D-6 |
| NFR-SEC-8 | Scan error messages sanitized: no Gmail IDs, OAuth tokens, PII, or credentials in stored errors | `src/lib/scan/sanitize.ts` | Per `14-phase0-assessment.md §12` |
| NFR-DATA-4 | `email_source` deletion is restricted while memberships exist; deletion is allowed only after dependent rows are removed by the approved user-erasure workflow | `email_scan_item.email_source_id` FK `REFERENCES email_source ON DELETE RESTRICT` | |
| NFR-DATA-5 | email_manual_classification is append-only: no UPDATE or DELETE allowed at application layer | Route enforces insert-only | Per FR-O2 |
| NFR-DATA-6 | Cross-table ownership/version invariants use four declarative composite FKs plus exactly three triggers: filter-version immutability, scan-item source ownership, and scan-item parent immutability | **Implemented:** Stage 1 DB migration constraints/triggers | Passed migrated verifier VP4–VP10 |
| NFR-DATA-7 | Filter evaluation semantics: exclude wins; empty include means included; non-empty include requires a match; an unsupported rule type fails the scan closed with `INVALID_FILTER_SCHEMA` | `src/lib/scan/filter.ts` | Per `14-phase0-assessment.md §6 email_filter_version` |
| NFR-REL-11 | Completion guard — three conditions: no unfinished item, no FETCHED item with PENDING decision, and no CANCELLED item | `src/lib/scan/progress.ts` | Per `14-phase0-assessment.md §7.4` |
| NFR-DATA-8 | Named row-local CHECK constraints enforce enum domains, nonnegative/bounded counters, state/stage coherence, lease/retry pairing, terminal cleanup, timestamp ordering, and classification version progression | **Implemented:** DB migration; `phase1a-dry-run.sql` VP5b/VP12c | Passed; cross-row aggregate/classification equality remains an application transaction contract |
| NFR-DATA-9 | Historical migration repair must preserve applied checksums, avoid production business-data mutation, fail closed on mismatched state, and support clean lexical replay | Three ParseTemplate replay bridge migrations; `migration-reconciliation-verify.sql` | Passed empty, production-like, representative, and checksum-negative matrices |
| NFR-DATA-10 | Prisma schema and complete migration directory must have zero drift | `20260726010000_reconcile_llm_schema_drift` | Both live and `--from-migrations` Prisma diffs passed |
| NFR-REL-12 | QStash deduplication: deterministic message ID = sha256(scanRunId:stage:sequence) as Upstash-Deduplication-Id; DB commit must precede QStash publish (C8, C68) | `src/lib/scan/scheduler.ts` | Per `14-phase0-assessment.md §7.3` |

### Phase 1A test gaps (not covered)

| ID | Gap |
|----|-----|
| FR-M4, FR-M5, FR-O1–FR-O3 | Manual classification UI: no E2E coverage planned for Phase 1A minimal UI |
| FR-N4 (filter preview) | Deferred from Phase 1A — not approved; no coverage required |
| NFR-REL-8 (idempotency under real at-least-once redelivery) | Integration test with real QStash redelivery is out of scope for Phase 1A |
