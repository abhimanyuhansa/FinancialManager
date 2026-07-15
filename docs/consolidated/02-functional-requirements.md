# 02 — Functional Requirements & User Flows

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Baseline anchor date:** 2026-07-14 — validated pass-1 as-built baseline.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Pass 7 corrections:** 2026-07-15 — FR-C9 narrowed: "every parse attempt" → "every
> successfully fetched candidate email" (REL-8 exception). Freeze metadata standardized. J-01, J-02.
> **Pass 3 corrections:** 2026-07-14 — FR-A2 syncFromDate never-written note; FR-B8 partial
> recovery scope; FR-C1 resolvedBy=NULL; FR-D3 PATCH-only; FR-D6 DELETE method.

> Requirements are stated as-built and tagged per `00-index.md`. Each references the code that
> implements it and, where present, the E2E test that exercises it (`e2e/*.spec.ts`).

---

## A. Authentication & onboarding

### FR-A1 — Google sign-in (Gmail read access)
User signs in with Google; the app requests `openid email profile gmail.readonly` with
`access_type=offline` + `prompt=consent` to obtain a refresh token. **[Confirmed]**
`src/lib/auth.config.ts`. E2E: `e2e/01-auth.spec.ts`.

### FR-A2 — Onboarding: choose sync-from period
After first sign-in the user picks how far back to sync (a period picker; single selection).
`User.syncFromDate` exists in the schema and is **read** by `sync/start/route.ts:47` as a
fallback default (`fromDate = user?.syncFromDate ?? sixMonthsAgo`). However, **no route
ever writes `User.syncFromDate`** — the field is schema debt. The period chosen during
onboarding affects the current job's `fromDate` but is not persisted back to the user record.
**[Partial — schema field exists; no write path]** — `prisma/schema.prisma`;
`sync/start/route.ts:32,47`; E2E `e2e/02-onboarding.spec.ts` (T2.2 period picker, T2.3 single-select).
See `12-open-questions.md` OQ-11.

### FR-A3 — Session persistence
Sessions are database-backed (NextAuth `session: "database"` with PrismaAdapter). **[Confirmed]**
— `src/lib/auth.ts`, `Session` model.

---

## B. Gmail sync pipeline

### FR-B1 — Start a sync
User (or system) can start a sync job. Starting returns a `jobId` **immediately** and does the
work asynchronously (never blocks the UI). **[Confirmed]** — `src/app/api/gmail/sync/start`;
E2E T3.2 "starting sync returns jobId fast". Design rule reinforced by memory `feedback-sync-ux.md`.

### FR-B2 — One active job per user
Starting a sync while one is already running returns **HTTP 409**. **[Confirmed]** — E2E T3.3.

### FR-B3 — Incremental daily sync via cron
A Vercel cron (`0 2 * * *`) calls `/api/gmail/sync/advance` once daily to **progress** any
pending jobs in bounded chunks (respecting the 60s function limit). **[Partial]** — the cron
keeps long-running syncs moving forward; it does **not** create a new sync job. A user must
manually trigger sync via `start`. `vercel.json` cron + `functions.maxDuration=60`;
route `src/app/api/gmail/sync/advance/route.ts`.

### FR-B4 — Chunked, resumable processing
Scanning and processing are chunked and resumable: `SyncJob` tracks `scanPageToken`,
`totalEmails`, `processedEmails`; per-message progress is tracked in `SyncJobMessage`
(`@@unique([syncJobId, gmailMsgId])`, indexed by `[syncJobId, processed]`). **[Confirmed]** —
`prisma/schema.prisma`.

### FR-B5 — Distributed lock on job advance
Concurrent cron/manual advances are serialized by a `SyncJobLock` with an owner token and
expiry (heartbeat renewal). **[Undocumented → Confirmed]** — `SyncJobLock` model + `src/lib/llm/lock.ts`.

### FR-B6 — Sync controls: status, active, pause, cancel, retro
- Status/active endpoints report progress. **[Confirmed]** `sync/status`, `sync/active`.
- Pause a running job. **[Undocumented → Confirmed]** `sync/pause`.
- Cancel a job. **[Confirmed]** `sync/cancel`.
- Retro / re-trigger sync. **[Confirmed]** `sync/retro`; `SyncJob.isRetrigger`.

### FR-B7 — Watermark = job start time
Incremental syncs use the job's `startedAt` as the watermark to avoid re-processing. **[Confirmed]**
(advance route logic; `SyncJob.startedAt`).

### FR-B8 — Auto-recovery of stuck / 1-error rows
Emails that produced exactly **one error ParseLog and no non-error ParseLog** are auto-reset
and retried on a later advance tick. **[Partial]** — recovery SQL at `advance/route.ts:80–107`
only qualifies rows matching this narrow condition (1 error ParseLog, 0 non-error ParseLogs).
Rows with multiple errors or a mix of error and non-error ParseLogs are not recovered.
Commit `57d29dc "recover stuck emails…"` introduced this recovery.

---

## C. Parsing & categorization (per email)

The pipeline runs a layered chain; the first layer that yields a confident result wins.

### FR-C1 — Tier 0: static parser (fast path)
A deterministic static parser attempts to extract a transaction (or classify as
`not_transaction`) **before** any cache or LLM call, and early-returns on success. **[Undocumented → Confirmed]**
— `src/lib/staticParser.ts`. **Note:** Static tier outcomes set **`ParseLog.resolvedBy = NULL`** —
the field is omitted, not set to `"static"`. Only tiers 1–3 write explicit values (`exact_cache`,
`template`, `llm`). **[Confirmed]** — `advance/route.ts:242–313`.

### FR-C2 — Tier 1: prior-parse-result cache (exact cache)
If this exact Gmail message was already parsed successfully, the prior result (`transactionId`)
is returned from `ParseLog` without re-parsing. Cache key: `gmailMsgId` (not email content hash).
**[Confirmed]** — `src/lib/exactResultCache.ts:4–24` queries `ParseLog` by `[userId, gmailMsgId]`;
`ParseLog.resolvedBy = "exact_cache"`.

### FR-C3 — Tier 2: template cache (learned per sender)
Per-sender templates (`ParseTemplate`) extract fields without an LLM once promoted. Lifecycle:
`SHADOW → ACTIVE → DEGRADED → DISABLED`, tracked via hit/fail/consecutive counters. SHADOW/DEGRADED
templates **shadow-run** alongside the LLM to validate before promotion. **[Undocumented → Confirmed]**
— `src/lib/parseTemplateCache.ts`; `ParseTemplate` model; `ParseLog.resolvedBy = "template"`.

### FR-C4 — Tier 3: LLM extraction (fallback)
When earlier tiers miss, an LLM extracts structured fields. Provider selection, quotas, and
resilience are handled by the LLM subsystem (see FR-C7 and `04-architecture.md`). **[Confirmed]**
— `src/lib/llm/`; `ParseLog.resolvedBy = "llm"`. *(Earlier docs said `"gemini"` — **[Stale]**;
the actual value written at `advance/route.ts:455,484,513` is `"llm"`.)*

### FR-C5 — VPA (UPI) merchant auto-learn
For UPI transactions, the app learns a `VPA → merchant/category` mapping and reuses it. Maps can
be user-confirmed (`confirmedByUser`). **[Undocumented → Confirmed]** — `src/lib/vpaLookup.ts`;
`VpaMerchantMap` model; API `src/app/api/vpa`.

### FR-C6 — Merchant master + category learning
A `MerchantMaster` records normalized merchant → category/subCategory with a confidence and
source (`llm` | `user`). **[Confirmed]** — `src/lib/merchantMaster.ts`; `MerchantMaster` model.

### FR-C7 — LLM resilience (quota, breaker, idempotency)
- **Provider routing:** Gemini (`gemini-3.1-flash-lite`) is **always primary**; OpenAI
  (`gpt-4o-mini`) is fallback. Overridable via `LLM_PRIMARY_PROVIDER`. **[Confirmed]** —
  `src/lib/llm/router.ts`, providers. *(Historically documented as size-based ≤10→Gemini/>10→OpenAI
  — now **[Stale]**; see `08`.)*
- **One provider per tick:** within-tick fallback was removed; a single provider is used per
  advance tick. **[Confirmed]** — commit `31a6077`.
- **Quota windows** per provider/window. **[Confirmed]** `quota.ts`, `LlmQuotaWindow`.
- **Circuit breaker** CLOSED/OPEN/HALF_OPEN with half-open probe. **[Confirmed]** `circuitBreaker.ts`, `LlmCircuitBreaker`.
- **Idempotency** on batch keys. **[Confirmed]** `idempotency.ts`, `LlmBatchIdempotency`.
- **Timeouts** default **30s** per provider (`GEMINI_TIMEOUT_MS`/`OPENAI_TIMEOUT_MS ?? 30_000`).
  **[Confirmed]** *(memory claimed 50s — **[Stale]**).*
- **Cost/usage logging:** `LlmCallLog`, `GeminiUsageLog`. **[Confirmed]**

### FR-C8 — Deduplication (3-layer)
1. `Transaction @@unique([userId, gmailMsgId])`. 2. `Transaction @@unique([userId, fingerprint])`.
3. `sourceRank` precedence for competing sources. **[Confirmed]** — `prisma/schema.prisma`,
`src/lib/dedup.ts`. *(Note: `EmailFilter` is **not** a dedup layer — it is a legacy settings-only
feature no longer in the parse pipeline. Prior docs calling this "4-layer" are **[Stale]**.)*

### FR-C9 — Parse logging & reprocess
Every successfully fetched candidate email is logged to `ParseLog` (outcome, confidence,
truncation, `resolvedBy`, error detail). **Note:** emails absent from the Gmail batch response
are silently skipped with no `ParseLog` entry — see REL-8 in `10-risks-tech-debt.md`.
Users can view parse logs and **reprocess** a single log entry. **[Confirmed]** —
`src/app/api/settings/parse-logs`, `.../[id]/reprocess`; E2E `e2e/09-parselogs.spec.ts`.

---

## D. Transactions

### FR-D1 — List & search
Transactions list shows date, merchant, amount; searchable. **[Confirmed]** — `src/app/api/transactions`;
E2E T5.1–T5.3.

### FR-D2 — Edit category / sub-category
User can change a transaction's category (with success feedback), which can feed learning. **[Confirmed]**
— `src/app/api/transactions/[id]/category`; E2E T6.1, T6.6.

### FR-D3 — Edit a transaction
**[Confirmed]** — `src/app/api/transactions/[id]` exports **PATCH only**. There is no DELETE
handler on this route. **[Confirmed]** — `src/app/api/transactions/[id]/route.ts`.

### FR-D4 — Export CSV
Export produces a downloadable CSV. **[Confirmed]** — `src/app/api/transactions/export`; E2E T5.12, GP.5.

### FR-D5 — Review flags
`Transaction.reviewed` / `needsReview` support a review workflow. **[Partial]** — fields exist;
verify UI surfacing depth in Pass 2.

### FR-D6 — Demo/seed transactions (remove)
A demo endpoint **removes** sample transactions. **[Undocumented → Confirmed]**
— `src/app/api/transactions/demo` exports **DELETE**. **[Confirmed]** — `src/app/api/transactions/demo/route.ts`.

### FR-D7 — Empty state
Transactions page shows an empty state when there are none. **[Confirmed]** — E2E T5.14.

---

## E. Categories & sub-categories

### FR-E1 — Manage categories
CRUD for categories (slug-keyed, icon, `isDefault`). **[Confirmed]** — `src/app/api/categories`,
`.../[id]`; `Category` model. Icon pack exists (`src/lib/categoryIcons.ts`).

### FR-E2 — Manage sub-categories
CRUD for sub-categories under a parent category slug. **[Confirmed]** — `src/app/api/subcategories`,
`.../[id]`, `src/app/api/settings/subcategories`; `SubCategory` + `SubCategoryMaster` models.

---

## F. Analytics dashboard

### FR-F1 — KPI cards & spend breakdown
Dashboard renders KPI cards (currency values), spend-by-category breakdown, and recent
transactions; degrades to an empty state with no data. **[Confirmed]** —
`src/app/api/analytics/dashboard`, `src/lib/analytics.ts`; E2E T4.1–T4.3, T11.1–T11.2.

### FR-F2 — Transaction detail from dashboard
Clicking a recent-transaction row opens a detail panel. **[Confirmed]** — E2E T4.6.

---

## G. Assets / net worth

### FR-G1 — Manage assets
CRUD for manually-entered assets (name, type, value, currency, `asOf`). Assets page shows a
balance or empty state and survives reload. **[Confirmed]** — `src/app/api/assets`, `.../[id]`;
`Asset` model; E2E T10.1, T10.2, T10.5.

---

## H. Settings

### FR-H1 — Email filters (legacy)
Add/list/delete `EmailFilter` entries (by type/value, with sourceRank). **[Partial]** — model,
API (`src/app/api/settings/filters`, `.../[id]`) and UI tab are active, **but the filter no
longer participates in the parse pipeline** the way older docs describe. E2E T7.2, T7.5. See `08`.

### FR-H2 — Gmail query keywords
Manage `GmailQueryKeyword` (from/subject) that shape the Gmail search query. **[Confirmed]** —
`src/app/api/settings/gmail-query`; `GmailQueryKeyword` model; `src/lib/gmailQuery.ts`.

### FR-H3 — Exclusion rules
Manage `ExclusionRule` (sender_domain / sender_email) to skip emails; skips are logged as
`skipped_exclusion`. **[Undocumented → Confirmed]** — `src/app/api/settings/exclusion-rules`;
`ExclusionRule` model.

### FR-H4 — Statement PDF passwords (encrypted storage)
Save/list/delete per-sender-domain statement passwords, stored encrypted (AES-256-GCM); never
shown in plaintext. **[Confirmed]** storage — `src/app/api/settings/statement-passwords`,
`.../[domain]`; `StatementPassword` model; `src/lib/crypto.ts`; E2E T8.1, T8.3.
**[Not Implemented]** use in parsing — `decrypt()` is not called in the Gmail parse path;
`pdfParse(buffer)` is called without a password option (`src/lib/gmail.ts:27`). Unlocking
password-protected PDF statements is unimplemented.

### FR-H5 — Parse logs (view + reprocess)
See FR-C9. Settings page exposes a Parse Logs tab. **[Confirmed]** — E2E T7.1 ("4 tabs"), T9.1.

---

## I. Reconciliation

### FR-I1 — Statement ↔ transaction reconciliation
Statement emails are reconciled against transactions; results recorded in `ReconciliationLog`
(status, mismatchDetails, matchedTransactionId, resolvedAt). **[Partial]** — model + endpoint
`src/app/api/gmail/reconcile` + `src/lib/reconcile.ts` exist; end-to-end UX depth to be confirmed in Pass 2.

---

## J. User data & privacy controls

### FR-J1 — User info
Return current user info/profile. **[Confirmed]** — `src/app/api/user/info`.

### FR-J2 — Delete my data
User can delete their financial data (DELETE). **[Confirmed — partial scope]** —
`src/app/api/user/data` (DELETE). The route explicitly deletes: `Transaction`, `SyncJob`,
`ParseLog`, `Asset`, and resets the watermark (`User.gmailSyncedAt = null`).
`SyncJobMessage` is **also deleted** via cascade from `SyncJob` (`onDelete: Cascade` in
`prisma/schema.prisma`). The route does **not** delete `Account`, `Session`, `VpaMerchantMap`,
`MerchantRule`, `StatementPassword`, `LlmCallLog`, or other models. Auth/session data
persists so the user can sign in again. Prior description claiming "cascade FKs" was
misleading — the route uses explicit `deleteMany` calls, not schema-level cascade (except
`SyncJobMessage` which is cascade-deleted automatically).

---

## K. Operational endpoints

### FR-K1 — Health check
`/api/health` public endpoint. **[Confirmed]**.

### FR-K2 — Test auth seed (non-prod)
`/api/test/auth-seed` mints a session for tests, guarded by `CRON_SECRET` + `ENABLE_TEST_AUTH_SEED`.
**[Confirmed]** — see **security note** in `06-security-authentication.md` (HIGH: backdoor if enabled in prod).

---

## L. End-to-end user flows

### Flow 1 — New user golden path *(E2E `golden-path.spec.ts`)*
1. Sign in with Google → 2. Onboarding: pick sync-from period → 3. Start sync (returns jobId
fast) → 4. Cron/advance processes emails in chunks → 5. Transactions appear → 6. Dashboard shows
KPIs + breakdown → 7. User searches/edits categories → 8. Export CSV. **[Confirmed]** end-to-end
via GP.1–GP.5 + supporting specs.

### Flow 2 — Daily cron keep-alive *(unattended)*
Vercel cron at 02:00 → `/api/gmail/sync/advance` (GET, bearer auth) → acquires `SyncJobLock`
→ advances any pending job by one chunk (scan or parse) → releases lock. If no active job
exists, the advance is a no-op. The cron does **not** start new jobs. **[Partial]** — cron
advances confirmed; auto-start [Not Implemented].

### Flow 3 — Categorization learning loop
LLM/static parse → `MerchantMaster` / `VpaMerchantMap` learn mapping → user correction updates
mapping (`source="user"`, `confirmedByUser=true`) → future emails resolved without LLM. **[Confirmed]**.

### Flow 4 — Error handling *(E2E `14-errors.spec.ts`)*
404 renders gracefully; invalid transaction id → expected response; malformed JSON body → 400.
**[Confirmed]** — T14.1–T14.3.

---

*Cross-references:* components behind these flows → `04-architecture.md`; the models/endpoints →
`05-data-model-apis.md`; what's stale vs real → `08-implementation-status.md`.
