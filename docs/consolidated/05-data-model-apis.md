# 05 — Data Model, APIs & Integrations

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Frozen:** 2026-07-14 — baseline commit frozen; document text updated through Pass 6
> against the same commit anchor. No modifications to the baseline commit itself.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Phase 0 revision 2026-07-19:** §1.9 fully rewritten per Q1–Q4 schema decisions and C1–C8
> corrections: `email_filter` replaces `email_filter_rule`; `email_filter_version` redesigned
> with `include_rules_json`/`exclude_rules_json`; `email_source` field set aligned (no body
> storage in Phase 1A, `normalized_subject`, `has_attachment`, observational fetch fields C4,
> materialized `current_manual_classification`/`classification_version` C5); scan-run filter FKs
> NOT NULL (C2), `current_stage`/`resume_stage` added (C3), `filter_snapshot_json` NOT NULL (C2);
> item `status` values corrected (remove `SKIPPED_BY_FILTER` C1), `filter_decision` values
> corrected (remove `NO_FILTER`, add `PENDING` C1); `email_manual_classification` current
> classification updated to reference materialized field (C5).
> C2: `gmail_account_id` FK on `email_filter`, `email_source`, `email_scan_run` corrected to
> ON DELETE RESTRICT — historical metadata survives Gmail account disconnection.
> C3: `total_skipped` renamed `total_filter_excluded`.
> C5: `max_item_retries` added to `email_scan_run`; scan-level `retry_count`/`max_retries` added.
> C6: `to_date` made NOT NULL; `previous_classification` made NOT NULL; `classification_version`
> + UNIQUE added to `email_manual_classification`; scan-run date/lifecycle fields added.
> C7: Filter evaluation semantics documented (exclude wins, empty include = all included).
> C8: QStash deterministic dedup IDs and redelivery recovery documented in §2/§3.
> Constraint trigger requirement (C1) noted for cross-table referential integrity.
> Migration table updated: `email_filter` (not `email_filter_rule`).
> **Phase 0 revision 2026-07-19 pass 4 (C9–C13):**
> C9: QStash authentication updated — `@upstash/qstash` `Receiver` class (not manual HMAC);
>   JWT claims (`iss:"Upstash"`, `sub:<destination URL>`, `exp`, `nbf`, `body` integrity claim);
>   dedup window 10 minutes; free-plan default retries 3.
> C10: All 7 cross-tenant constraint trigger function bodies now documented in `14-phase0-assessment.md`;
>   note added here that `UNIQUE(userId, id)` is required on `Account` as FK prerequisite.
> C11: Gmail disconnection model — `Account` extended with `disconnected_at` / `disconnection_reason`;
>   OAuth tokens cleared on disconnect; `connected_at` stored; `classified_by` on
>   `email_manual_classification` corrected to `ON DELETE SET NULL` (nullable FK).
> C12: `email_scan_run.last_error` renamed `last_error_message_sanitized`; `started_at` corrected
>   to nullable (set on first CREATED→DISCOVERING transition only); `email_scan_item` status
>   `CANCELLED` added; filter version DB immutability trigger (raises on UPDATE) + SECURITY
>   DEFINER erasure bypass documented.
> C13: Worker invocation protocol rewritten as 10-step sequence in `14-phase0-assessment.md §7.3`.
> **Phase 0 revision 2026-07-19 pass 5 (C14–C23):**
> C14: Progress formula corrected; `filter_excluded_count` is subset of `fetch_success_count`
>   (FETCHED items); CANCELLED items excluded from COMPLETED/COMPLETED_WITH_ERRORS counts;
>   completion guard extended with third condition (any CANCELLED item blocks terminal state).
> C15: Classification versioning corrected: `newVersion = N+1`; history row and
>   `email_source.classification_version` both updated to `newVersion` in same transaction.
> C16: Rule-draft CRUD removed (no draft persistence in six-table schema); filter API renamed
>   to `/api/email-filters` and `/api/email-filters/{id}/versions`; rule-draft endpoints
>   `POST/PATCH/DELETE /api/email-filter-rules` removed from Phase 1A route list.
> C17: HTTP 489 + `Upstash-NonRetryable-Error: true` for non-retryable; `Upstash-Retries`
>   header (not `Upstash-Retry-Count`); `Receiver.verify()` requires `url` parameter;
>   failure callback uses `Receiver` JWT (no separate HMAC secret).
> C18: `Upstash-Message-Id` must not gate processing; idempotency via DB state only.
> C19: SECURITY DEFINER erasure function removed; preferred erasure via parent `email_filter`
>   cascade to `email_filter_version` (no SECURITY DEFINER needed for DELETE).
> C20: `UNIQUE(email_filter_id, id)` added to `email_filter_version`; `UNIQUE(user_id, id)`
>   added to `email_source`; `UNIQUE("userId", id)` added to `Account`; 4 of 7 ownership
>   triggers replaced by declarative composite FKs; 4 triggers remain (C24 restores trg_email_scan_item_source_ownership).
> C21: Account `ON DELETE RESTRICT` requires explicit child-deletion ordering in erasure
>   transaction; Account additive migration (`UNIQUE("userId",id)`, `disconnected_at`,
>   `disconnection_reason`) requires D-1 approval; token fields corrected to `access_token`,
>   `refresh_token` (actual Prisma field names).
> C22: No automatic QStash quota recovery; manual resume approved for Phase 1A; optional
>   Vercel cron sweeper.
> C23: `rule_schema_version` and `filter_evaluator_version` added to `email_filter_version`
>   and `email_scan_run` snapshot fields; incompatible version → fail safely with
>   `IncompatibleFilterVersionError` (not silent non-match).
> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C28: `Upstash-Signature HMAC` auth wording replaced with `QStash JWT verification via Receiver class`
>   in API auth-column notes; `upstash-body-hash` claim name corrected to `body` in C9 header.
> C29: `GET /api/gmail/scan/list` removed from Phase 1A canonical API route set.
> C31: Constraint 7 wording corrected (no reference in this document — confirmed absent).
> C32: Filter version incompatibility → scan FAILED (noted in C23 header; no body change needed here).
> C33: D-1 status references unchanged in this document (no "C1–C8" references present).
> **Phase 0 revision 2026-07-19 pass 8 (C40–C45):**
> C45: §1.9 cross-table referential integrity description rewritten — "7 constraint triggers" replaced
>   with declarative FK model; only `trg_email_scan_item_source_ownership` and
>   `trg_email_filter_version_immutable` remain; claims that current-version, supersedes-version, or
>   scan-filter integrity require triggers removed.
> **Phase 0 revision 2026-07-19 pass 9 (C48, C50):**
> C48: `email_scan_run` table rows updated — `total_fetched/total_fetch_failed/total_filter_excluded`
>   replaced with `fetch_success_count/fetch_failed_count/filter_included_count/filter_excluded_count`;
>   `next_page_token` → `discovery_page_token`; `batch_sequence INTEGER` → `batch_sequence BIGINT NOT NULL`.
> C50: Ownership taxonomy corrected — `email_filter_version` and `email_scan_item` are PARENT_SCOPED
>   (no direct `user_id`); `email_filter`, `email_source`, `email_scan_run`, `email_manual_classification`
>   are TENANT_SCOPED_ENFORCED.
> **Phase 0 revision 2026-07-23 (C82–C83):**
> C82: FAILED is terminal and unrecoverable; "retryable FAILED" removed; RETRY_WAIT retry response
>   corrected to return actual committed status from `resume_stage` (not literal `"RETRY_WAIT"`).
> C83: API route heading corrected from "18 planned" to "20 planned"; verified total 36 + 20 = 56.
> **Phase 0 revision 2026-07-23 (C85–C88):**
> C86: `email_scan_run` field table corrected — `gmail_account_id` FK RESTRICT noted; `status` DEFAULT
>   'CREATED' added; `state_version`, `total_discovered`, `retry_count`, `max_retries`, `max_item_retries`
>   all marked NOT NULL; `created_at`/`updated_at` marked NOT NULL DEFAULT now().
> C87: `/api/gmail/scan/{id}/retry` route description corrected — FAILED removed as retryable option;
>   stalled active-scan recovery (expired lease) added.
> C88: Earlier C77–C80 dry-run claim superseded; final isolated C84 dry run pending Stage 1 approval.
> **Phase 0 revision 2026-07-23 (C89–C91):**
> C89: Constraint name confirmed `account_user_id_id_unique`; `account_disconnected_idx` added to SQL;
>   SQL header updated to C81–C89; psql usage updated to `docs/consolidated/phase1a-dry-run.sql`.
>   All verification SELECT queries converted to DO/RAISE EXCEPTION assertions (C92 in SQL).
> C90: VP13 rewritten — canonical erasure order: manual_classification → scan_item → scan_run →
>   source → filter (CASCADE removes versions, no direct version delete) → Account → User;
>   all 8 tables asserted zero.
> C91: Retry decision table in 14 updated — CREATED+published → 409 scan_active; PAUSED → 409
>   scan_paused; all 10 statuses now covered; ACs updated.
> **Pass 7 corrections:** 2026-07-15 — Frozen metadata standardized. J-01.
> **Pass 3 corrections:** 2026-07-14 — 6-tier ownership taxonomy, API method corrections,
> SyncJobMessage cascade correction. Source: reviewer pass verified against code.
> **Pass 4 corrections:** 2026-07-15 — SyncJobLock reclassified PARENT_SCOPED→OPERATIONAL_GLOBAL
> (string-keyed `@id`, no `@relation` to SyncJob); LlmCallLog reclassified
> TENANT_SCOPED_ENFORCED→OPERATIONAL_GLOBAL (nullable `userId String?`, no FK, not enforced).
> G-05, G-06.
> **Pass 5 corrections:** 2026-07-15 — 7-tier ownership taxonomy: TENANT_ROOT tier added
> (identity anchor, no `userId` FK); `User` reclassified TENANT_SCOPED_ENFORCED→TENANT_ROOT;
> OPERATIONAL_GLOBAL redefined to allow optional user reference. H-01.
> **Pass 6 corrections:** 2026-07-15 — Frozen metadata corrected; route-count formula
> corrected (33 routes call auth(), 3 do not = 36 total). I-01, I-05.

> Authoritative sources: `prisma/schema.prisma` (27 models), `src/app/api/**/route.ts`
> (36 routes), `prisma/migrations/` (13 migrations). Tags per `00-index.md`.

---

## 1. Data model — 27 Prisma models

Grouped by concern. **Ownership classification (7-tier):**

- **TENANT_ROOT**: the identity anchor itself; no `userId` FK (it *is* the user). All other tenant-scoped models reference it via FK. (`User` only.)
- **TENANT_SCOPED_ENFORCED**: has `userId` FK AND APIs filter by it. Data is per-user isolated end-to-end.
- **TENANT_KEYED_NOT_ENFORCED**: has `userId` FK but APIs do **not** enforce per-user scoping — rows for one user are accessible to another via direct API calls. **Security note:** `Category` and `SubCategory` fall here; `GET /api/categories` uses `findMany()` with no `userId` filter; `PATCH/DELETE /api/categories/[id]` uses `findUnique({where:{id}})` with no ownership check. **[Confirmed]** — `src/app/api/categories/route.ts`, `src/app/api/categories/[id]/route.ts`.
- **PARENT_SCOPED**: no direct `userId` field; scoped to user-owned data via cascade from a `TENANT_SCOPED_ENFORCED` parent.
- **SYSTEM_GLOBAL**: no `userId`; shared state that affects all users. Mutations via any authenticated session affect all users.
- **AUTH_INFRASTRUCTURE**: NextAuth internal models; no application-level `userId`.
- **OPERATIONAL_GLOBAL**: no enforced User FK; may carry an optional user reference or tag. Global metering, locking, and idempotency state.

### 1.1 Identity & auth (NextAuth)
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `User` | TENANT_ROOT | Account root | `email` unique, `syncFromDate` (read as fallback; **never written by any route** — schema debt), `gmailSyncedAt`, `lastMessageId`, `emailVerified`; relations to all user data |
| `Account` | TENANT_SCOPED_ENFORCED | OAuth account link | `provider`+`providerAccountId` unique, `refresh_token`, `access_token`, `scope` |
| `Session` | TENANT_SCOPED_ENFORCED | DB-backed session | `sessionToken` unique, `expires` |
| `VerificationToken` | AUTH_INFRASTRUCTURE | Email verification (NextAuth internal) | `identifier`+`token` unique; **no `userId` field** |

### 1.2 Core finance
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `Transaction` | TENANT_SCOPED_ENFORCED | Parsed transaction | `gmailMsgId`, `fingerprint`, `merchant`, `amount`, `type`, `currency` (INR), `category`, `subCategory`, `tag`, `source`, `sourceRank`, `reviewed`, `needsReview`, `lineItems` (Json). **Unique:** `[userId, gmailMsgId]`, `[userId, fingerprint]` |
| `Asset` | TENANT_SCOPED_ENFORCED | Net-worth item (manual) | `name`, `type`, `value`, `currency`, `asOf` |

### 1.3 Taxonomy
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `Category` | TENANT_KEYED_NOT_ENFORCED | Top-level category | `slug` unique, `icon`, `isDefault`. **Note:** `GET /api/categories` returns all rows with no userId filter; `PATCH/DELETE /api/categories/[id]` has no ownership check. |
| `SubCategory` | TENANT_KEYED_NOT_ENFORCED | Child of category | `slug` unique, `parentSlug` → `Category.slug` (cascade). Same API enforcement gap as `Category`. |
| `SubCategoryMaster` | SYSTEM_GLOBAL | Global subcat catalog | `[category, subCategory]` unique, `addedBy` (system/user/llm) |
| `MerchantMaster` | SYSTEM_GLOBAL | Learned merchant → category | `merchantName` unique (normalized), `confidence`, `source` (llm/user) |
| `MerchantRule` | TENANT_SCOPED_ENFORCED | User merchant → category rule | `[userId, merchantName]` unique |

### 1.4 Sync
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `SyncJob` | TENANT_SCOPED_ENFORCED | A sync run | `status`, `totalEmails`, `processedEmails`, `newTransactions`, `skippedEmails`, `encryptedBlockedCount`, `isRetrigger`, `scanPageToken`, `gmailQuery`, `startedAt`, `completedAt` |
| `SyncJobMessage` | PARENT_SCOPED | Per-message progress | `[syncJobId, gmailMsgId]` unique; index `[syncJobId, processed]`. **Deleted via cascade** when parent `SyncJob` is deleted (`onDelete: Cascade`). **[Confirmed]** — `prisma/schema.prisma`. |
| `SyncJobLock` | OPERATIONAL_GLOBAL | Distributed advance lock | `jobId String @id` (string-keyed, **no `@relation` or FK cascade to SyncJob**), `ownerToken`, `expiresAt`; index on `expiresAt`. **[Confirmed]** — `prisma/schema.prisma`. |

### 1.5 Parsing / learning
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `ParseLog` | TENANT_SCOPED_ENFORCED | Per-email parse audit | `outcome`, `geminiConfidence`, `parsedMerchant/Amount`, `resolvedBy` (NULL for static tier-0 / `exact_cache` / `template` / `llm`), `wasTruncated`, `errorDetail`; indexes on `[userId,syncJobId]`, `[userId,gmailMsgId]`, `createdAt` |
| `ParseTemplate` | TENANT_SCOPED_ENFORCED | Per-sender extraction template | `senderDomain`, `templateHash`, `parserVersion`, `taxonomyVersion`, `status` (SHADOW/ACTIVE/DEGRADED/DISABLED), `extractors` (Json), hit/fail/consecutive counters. **Unique:** `[userId, senderDomain, templateHash, parserVersion]` |
| `VpaMerchantMap` | TENANT_SCOPED_ENFORCED | UPI VPA → merchant | `[userId, vpa]` unique, `category`, `subCategory`, `confirmedByUser` |

### 1.6 Config / filters
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `EmailFilter` | SYSTEM_GLOBAL | Legacy filter (settings-only; **not in parse pipeline**) | `[type, value]` unique, `sourceRank`, `isActive` |
| `GmailQueryKeyword` | SYSTEM_GLOBAL | Shapes Gmail query | `type` (from/subject), `isActive`, `isDefault`, `[type,value]` unique |
| `ExclusionRule` | SYSTEM_GLOBAL | Skip senders | `type` (sender_domain/sender_email), `[type,value]` unique |
| `StatementPassword` | TENANT_SCOPED_ENFORCED | Encrypted PDF password (storage only; decryption not used in parse path) | `[userId, senderDomain]` unique, `encryptedPassword` |

> **Ownership note:** `User` is **TENANT_ROOT** — the identity anchor; it has no `userId` FK
> because it *is* the user. `EmailFilter`, `GmailQueryKeyword`, `ExclusionRule`, `MerchantMaster`,
> and `SubCategoryMaster` are **SYSTEM_GLOBAL** — no `userId` field; mutations affect all users.
> `Category` and `SubCategory` have `userId` fields but their APIs do **not** enforce per-user
> scoping — they are **TENANT_KEYED_NOT_ENFORCED** (see §1.3).
> `SyncJobMessage` is **PARENT_SCOPED** (no direct `userId`; cascade from parent `SyncJob`).
> `SyncJobLock` is **OPERATIONAL_GLOBAL** — string-keyed by `jobId String @id` with no
> `@relation` or FK cascade to `SyncJob`. **[Confirmed]** — `prisma/schema.prisma`.
> `VerificationToken` is **AUTH_INFRASTRUCTURE** (no app `userId`).
> `LlmCircuitBreaker`, `LlmQuotaWindow`, `LlmBatchIdempotency`, `GeminiUsageLog`, and
> `LlmCallLog` are **OPERATIONAL_GLOBAL** (no enforced User FK; global state or optional tag only).
> Note: `LlmCallLog.userId` is `String?` nullable with no FK to `User` — an optional
> operational tag, not enforced per-user isolation.

### 1.7 Reconciliation
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `ReconciliationLog` | TENANT_SCOPED_ENFORCED | Statement vs txn match | `statementGmailMsgId`, `statementAmount`, `matchedTransactionId`, `status`, `mismatchDetails`, `resolvedAt` |

### 1.8 LLM operations
| Model | Ownership | Purpose | Notable fields |
|-------|-----------|---------|----------------|
| `LlmCallLog` | OPERATIONAL_GLOBAL | Per-call accounting | `provider`, `model`, `candidateCount`, `attemptNumber`, `wasFallback`, `fallbackReason`, `outcome`, `latencyMs`, in/out tokens, `estimatedCostUsd` (Decimal). **Note:** `userId String?` is nullable with **no `@relation` to User and no FK constraint** — optional operational tag, not enforced. **[Confirmed]** — `prisma/schema.prisma`. |
| `LlmQuotaWindow` | OPERATIONAL_GLOBAL | RPM/TPM/RPD counters | `[provider, windowType, windowKey]` unique; **no `userId` field** |
| `LlmCircuitBreaker` | OPERATIONAL_GLOBAL | Breaker state | `provider` PK, `state`, `consecutiveFailures`, `openedAt`; **no `userId` field** |
| `LlmBatchIdempotency` | OPERATIONAL_GLOBAL | Batch dedup | `batchKey` unique, `result` (Json), `expiresAt`; **no `userId` field** |
| `GeminiUsageLog` | OPERATIONAL_GLOBAL | Per-day Gemini counter | `date` (YYYY-MM-DD) unique, `callCount`; **no `userId` field** |

> **Model count = 27** (current). After Phase 1A migration: **33 models** (27 + 6 new). See §1.9.
> Verified `grep -c "^model " prisma/schema.prisma`. *(Memory said 25 — **[Stale]**; the two extra
> are additions from later migrations.)*

---

## 1.9 Phase 1A models — 6 new tables `[Planned — pending approval]`

> All items in this section are **`[Planned — pending approval]`**. None exist in the current schema.
> Full SQL DDL and rationale in `14-phase0-assessment.md §6`. After this migration: **33 Prisma models**.
> Migration strategy: additive only — no FKs into `SyncJob`, `ParseLog`, or `Transaction`.

**Cross-table referential integrity (C1, C10, C20, C34):** Most invariants across these tables are
enforced by declarative PostgreSQL composite foreign keys (C20, C34) — not triggers. Four composite
FKs cover the bulk of cross-tenant correctness: `fk_scan_run_filter_ownership` (3-column:
`email_scan_run(user_id, gmail_account_id, email_filter_id) → email_filter(user_id, gmail_account_id, id)`),
`fk_scan_run_filter_version` (2-column: `email_scan_run(email_filter_id, email_filter_version_id) →
email_filter_version(email_filter_id, id)`), `fk_email_filter_current_version` (deferrable: verifies
current version belongs to the same filter), and `fk_version_supersedes` (deferrable: verifies
`supersedes_version_id` references the same filter). Account-scoping for `email_filter`, `email_source`,
and `email_scan_run` is enforced by `fk_email_filter_account`, `fk_email_source_account`, and
`fk_email_scan_run_account` (composite FKs to `Account("userId", id)`). Three triggers remain (C67):
`trg_email_scan_item_source_ownership` (scan item source must belong to the same user and `gmail_account_id`
as its scan run — no declarative FK can express this three-table join check),
`trg_email_filter_version_immutable` (blocks all UPDATEs on immutable version rows), and
`trg_email_scan_item_parent_immutable` (BEFORE UPDATE trigger — rejects any change to `scan_run_id` or
`email_source_id` on an existing scan item; prevents structural reparenting even to a valid same-user scan).
Full DDL and FK definitions in `14-phase0-assessment.md §6`.

**UNIQUE(userId, id) on Account (C10, C20):** The `Account` table must have `UNIQUE("userId", id)` to enable
composite FKs from `email_filter`, `email_source`, and `email_scan_run` to `Account("userId", id)`.
This replaces ownership triggers for Account-scoped cross-tenant enforcement (C20). Add via
`ALTER TABLE "Account" ADD CONSTRAINT account_user_id_id_unique UNIQUE ("userId", id)` in the Phase 1A
migration — requires D-1 approval (additive, non-destructive).

**Gmail account disconnection model (C11, C21):** The `Account` table must be extended with `disconnected_at TIMESTAMPTZ`
and `disconnection_reason TEXT` to support soft-disconnection. Disconnection clears OAuth tokens
(`access_token`, `refresh_token` set to NULL — actual Prisma field names; C21) without deleting
the Account row. Future Gmail calls are blocked in `getGmailToken()` by checking `disconnected_at IS NOT NULL`.
Reconnection re-OAuths the same Account row and clears `disconnected_at`. This additive migration
requires D-1 approval. See `14-phase0-assessment.md §6.7`.

**email_filter_version DB-level immutability (C12, C19):** A `BEFORE UPDATE` trigger on `email_filter_version`
raises an exception on any UPDATE. SECURITY DEFINER does **not** bypass this trigger (it bypasses RLS/ownership,
not triggers — C19). Erasure workflows delete the parent `email_filter` row; ON DELETE CASCADE propagates
to versions. No SECURITY DEFINER erasure function is used. See `14-phase0-assessment.md §6`.

**Ownership classification for the 6 new models:**

- `email_filter`, `email_source`, `email_scan_run`, `email_manual_classification`: **TENANT_SCOPED_ENFORCED** — each has a direct `user_id` FK to `User`; Phase 1A APIs enforce per-user scoping on all reads and writes.
- `email_filter_version`, `email_scan_item`: **PARENT_SCOPED** — no direct `user_id` field; ownership is enforced via database-level cascade from a TENANT_SCOPED_ENFORCED parent (`email_filter` and `email_scan_run` respectively). APIs reach these records only through their parent's `user_id`-filtered context.

### New models overview

| Model | Purpose | Key uniqueness constraint |
|-------|---------|--------------------------|
| `email_filter` | Per-user logical filter entity (named, user-owned) | `id` (UUID PK) |
| `email_filter_version` | Immutable snapshot of filter config at publish time | `UNIQUE(email_filter_id, version)`, `UNIQUE(email_filter_id, id)` (C20) |
| `email_source` | Canonical email record keyed by Gmail message ID | `UNIQUE(user_id, gmail_account_id, gmail_message_id)`, `UNIQUE(user_id, id)` (C20) |
| `email_scan_run` | One scan invocation lifecycle record | `id` (UUID PK) |
| `email_scan_item` | Per-message item within a scan run | `UNIQUE(scan_run_id, email_source_id)` |
| `email_manual_classification` | Append-only manual classification audit history | `id` (UUID PK); current classification materialized on `email_source.current_manual_classification` |

### email_filter

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `user_id` | FK → User CASCADE | |
| `gmail_account_id` | FK → Account **RESTRICT** | Internal app account ID; **not** Gmail address; RESTRICT preserves filter history if account disconnected |
| `name` | TEXT NOT NULL | User-assigned filter name |
| `is_active` | BOOLEAN DEFAULT true | |
| `current_version_id` | TEXT NULLABLE FK → email_filter_version DEFERRED | NULL until first version published |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

### email_filter_version

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `email_filter_id` | FK → email_filter CASCADE | |
| `version` | INTEGER | Auto-incremented per filter |
| `gmail_query` | TEXT NOT NULL | Gmail search query string for this version |
| `include_rules_json` | JSONB DEFAULT '[]' | Array of include rules; each rule carries a stable `rule_id` |
| `exclude_rules_json` | JSONB DEFAULT '[]' | Array of exclude rules; each rule carries a stable `rule_id` |
| `supersedes_version_id` | TEXT NULLABLE FK → email_filter_version | The version this one replaces |
| `rule_schema_version` | INTEGER NOT NULL DEFAULT 1 | Version of the rule-object schema (C23) |
| `filter_evaluator_version` | INTEGER NOT NULL DEFAULT 1 | Version of the filter evaluation logic (C23) |
| `created_by` | TEXT NOT NULL | User/system identifier |
| `created_at` | TIMESTAMPTZ | Set on creation; never updated |
| **Unique** | `(email_filter_id, version)` | |
| **Unique** | `(email_filter_id, id)` | Enables composite FK references from child tables (C20) |

Each `email_scan_run` stores `email_filter_id` + `email_filter_version_id` to record exactly which filter and version were active, enabling audit and replay. Versions are never mutated after creation.

### email_source

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `user_id` | FK → User CASCADE | |
| `gmail_account_id` | TEXT FK → Account **RESTRICT** | Internal app account ID — **not** Gmail address, **not** OAuth token; RESTRICT preserves email history if account disconnected |
| `gmail_message_id` | TEXT NOT NULL | Gmail-assigned message ID |
| `subject` | TEXT | |
| `normalized_subject` | TEXT | Variable tokens replaced (e.g., `<AMOUNT> spent on HDFC <LAST4>`) |
| `sender_email` | TEXT | |
| `sender_name` | TEXT | |
| `sender_domain` | TEXT | |
| `received_at` | TIMESTAMPTZ | |
| `snippet_redacted` | TEXT | Short preview; must not contain PII |
| `gmail_thread_id` | TEXT | |
| `gmail_labels` | TEXT[] | |
| `has_attachment` | BOOLEAN DEFAULT false | |
| `attachment_metadata` | JSONB | Non-sensitive: type, count |
| `source_url` | TEXT | Gmail deep link |
| `last_fetch_status` | TEXT CHECK NOT NULL DEFAULT 'DISCOVERED' | `DISCOVERED`, `FETCHING`, `FETCHED`, `PERMANENTLY_FAILED` — **observational** (authoritative retry/terminal state is on `email_scan_item`) |
| `last_fetch_attempt_at` | TIMESTAMPTZ NULLABLE | Timestamp of most recent fetch attempt |
| `last_fetch_error_code` | TEXT | Sanitized error code; no PII |
| `last_fetch_error_message_sanitized` | TEXT | Sanitized; no PII |
| `current_manual_classification` | TEXT CHECK NOT NULL DEFAULT 'UNREVIEWED' | `UNREVIEWED`, `FINANCIAL`, `NON_FINANCIAL`, `UNCERTAIN` — **materialized** from `email_manual_classification` via transactional update (C5) |
| `classification_version` | INTEGER NOT NULL DEFAULT 0 | Optimistic concurrency counter; incremented on every classification change |
| `first_discovered_at` | TIMESTAMPTZ | |
| `last_fetched_at` | TIMESTAMPTZ NULLABLE | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `retained_until` | TIMESTAMPTZ NULLABLE | NULL = retain indefinitely |
| `deleted_at` | TIMESTAMPTZ NULLABLE | Soft-delete timestamp |
| **Unique** | `(user_id, gmail_account_id, gmail_message_id)` | Idempotency — second scan produces no duplicates |
| **Unique** | `(user_id, id)` | Enables composite FK references from child tables (C20) |

### email_scan_run

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `user_id` | FK → User CASCADE | |
| `client_request_id` | TEXT NOT NULL | Client-supplied idempotency key; `UNIQUE(user_id, client_request_id)` prevents duplicate scans on POST retry (C61) |
| `gmail_account_id` | TEXT NOT NULL FK → Account RESTRICT | RESTRICT: historical scan metadata survives account disconnection |
| `email_filter_id` | TEXT NOT NULL FK → email_filter | Derived from `email_filter_version_id`; both must belong to the same filter (C2) |
| `email_filter_version_id` | TEXT NOT NULL FK → email_filter_version | NOT NULL — every scan requires an immutable filter version (C2) |
| `effective_gmail_query` | TEXT NOT NULL | Exact query string used; immutable after scan start |
| `from_date` | DATE NOT NULL | Scan window start date (inclusive) |
| `to_date` | DATE NOT NULL | Scan window end date (inclusive); NOT NULL — Phase 1A scans always bounded |
| `filter_snapshot_json` | JSONB NOT NULL | Copy of filter version rules at scan start; NOT NULL (C2) |
| `status` | TEXT NOT NULL DEFAULT 'CREATED' CHECK | `CREATED`, `DISCOVERING`, `FETCHING`, `PAUSED`, `RETRY_WAIT`, `CANCELLING`, `CANCELLED`, `COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED` |
| `current_stage` | TEXT CHECK NULLABLE | `DISCOVERY`, `FETCH` — active processing stage; NULL in terminal states (C3) |
| `resume_stage` | TEXT CHECK NULLABLE | `DISCOVERY`, `FETCH` — stage to resume from `PAUSED` or `RETRY_WAIT`; set on pause/retry entry (C3) |
| `state_version` | INTEGER NOT NULL DEFAULT 0 | Optimistic concurrency; incremented on every state change |
| `worker_lease_owner` | TEXT NULLABLE | `crypto.randomUUID()` per invocation |
| `worker_lease_expires_at` | TIMESTAMPTZ NULLABLE | `now() + WORKER_LEASE_DURATION_SECONDS` |
| `total_discovered` | INTEGER NOT NULL DEFAULT 0 | |
| `fetch_success_count` | INTEGER NOT NULL DEFAULT 0 | Count of items in FETCHED status |
| `fetch_failed_count` | INTEGER NOT NULL DEFAULT 0 | Count of items in PERMANENTLY_FAILED status |
| `filter_included_count` | INTEGER NOT NULL DEFAULT 0 | Count of INCLUDED filter_decision items |
| `filter_excluded_count` | INTEGER NOT NULL DEFAULT 0 | Count of EXCLUDED filter_decision items |
| `retry_count` | INTEGER NOT NULL DEFAULT 0 | Scan-level retry counter; incremented on each RETRY_WAIT re-entry |
| `max_retries` | INTEGER NOT NULL DEFAULT 5 | Scan-level retry cap; immutable after scan creation |
| `max_item_retries` | INTEGER NOT NULL DEFAULT 3 | Per-item retry cap; immutable after scan creation |
| `batch_sequence` | BIGINT NOT NULL DEFAULT 0 | Monotone; used as QStash deduplication ID component |
| `pending_continuation_sequence` | BIGINT NULLABLE | Sequence number of the next scheduled QStash message; written in the checkpoint transaction |
| `pending_continuation_stage` | TEXT CHECK IN ('DISCOVERY','FETCH') NULLABLE | Stage that the pending continuation will execute |
| `pending_continuation_not_before` | TIMESTAMPTZ NULLABLE | When QStash should deliver the continuation (immediate or delayed) |
| `pending_continuation_published_at` | TIMESTAMPTZ NULLABLE | Set to now() after QStash accepts publication; NULL until confirmed |
| `discovery_page_token` | TEXT NULLABLE | Gmail pagination cursor (DISCOVERING phase) |
| `last_error_code` | TEXT NULLABLE | Machine-readable error code (e.g. `INVALID_FILTER_SCHEMA`) |
| `last_error_message_sanitized` | TEXT NULLABLE | Sanitized error (no Gmail IDs, no OAuth tokens, no PII); renamed from `error_message` (C12) |
| `started_at` | TIMESTAMPTZ NULLABLE | NULL until first worker transitions CREATED→DISCOVERING; set atomically at that transition (C12) |
| `last_checkpoint_at` | TIMESTAMPTZ NULLABLE | |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `completed_at` | TIMESTAMPTZ NULLABLE | |
| `cancelled_at` | TIMESTAMPTZ NULLABLE | Set when status transitions to CANCELLED |
| `filter_rule_schema_version` | INTEGER NOT NULL | Snapshot of `email_filter_version.rule_schema_version` at scan start; immutable (C23) |
| `filter_evaluator_version` | INTEGER NOT NULL | Snapshot of `email_filter_version.filter_evaluator_version` at scan start; immutable (C23) |
| `scan_limit` | INTEGER NULLABLE | Maximum messages to discover; `NULL` = unlimited |
| `discovery_complete` | BOOLEAN NOT NULL DEFAULT false | Set to true once all Gmail List API pages have been consumed |
| `fetch_pending_count` | INTEGER NOT NULL DEFAULT 0 | Items in `DISCOVERED` status (awaiting fetch) |
| `fetch_in_progress_count` | INTEGER NOT NULL DEFAULT 0 | Items in `FETCHING` status (lease held) |
| `manual_review_count` | INTEGER NOT NULL DEFAULT 0 | Items flagged for manual review |
| `next_retry_at` | TIMESTAMPTZ NULLABLE | Earliest eligible retry time across all `RETRY_WAIT` items |
| `last_batch_started_at` | TIMESTAMPTZ NULLABLE | Timestamp when the most recent batch began |
| `last_batch_completed_at` | TIMESTAMPTZ NULLABLE | Timestamp when the most recent batch completed |
| `paused_at` | TIMESTAMPTZ NULLABLE | Set when status transitions to `PAUSED` |
| **CHECK** | `CONSTRAINT chk_pending_continuation_coherence` | All four `pending_continuation_*` fields must be collectively NULL or collectively non-null (except `pending_continuation_published_at` which may be NULL until confirmed) |
| **CHECK** | `CONSTRAINT chk_pending_sequence_matches_scan_sequence` | `pending_continuation_sequence` must equal `batch_sequence` when non-NULL; enforces sequence coherence across checkpoint, resume, and retry transactions (C75) |
| **Derived (API only)** | `worker_last_active_at` | Not a persisted DB column; computed from `worker_lease_expires_at` for API responses |
| **Derived (API only)** | `estimated_completion_at` | Not a persisted DB column; estimated from counters and average item fetch time for API responses |

### email_scan_item

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `scan_run_id` | FK → email_scan_run CASCADE DELETE | |
| `email_source_id` | TEXT NOT NULL FK → email_source RESTRICT | NOT NULL — item is always linked to a source record |
| `filter_decision` | TEXT CHECK NOT NULL DEFAULT 'PENDING' | `PENDING`, `INCLUDED`, `EXCLUDED` — evaluated after fetch; `PENDING` until filter is applied (C1) |
| `matched_include_rule_ids` | TEXT[] | Rule IDs from `email_filter_version.include_rules_json` that matched |
| `matched_exclude_rule_ids` | TEXT[] | Rule IDs from `email_filter_version.exclude_rules_json` that matched |
| `status` | TEXT CHECK | `DISCOVERED`, `FETCHING`, `FETCHED`, `RETRY_WAIT`, `PERMANENTLY_FAILED`, `CANCELLED` — fetch execution status only; filter outcome is `filter_decision` (C1, C12) |
| `state_version` | INTEGER DEFAULT 0 | Optimistic concurrency |
| `item_lease_owner` | TEXT NULLABLE | `crypto.randomUUID()` per invocation (item-level lease) |
| `item_lease_expires_at` | TIMESTAMPTZ NULLABLE | `now() + ITEM_LEASE_DURATION_SECONDS` |
| `fetch_attempt_count` | INTEGER DEFAULT 0 | |
| `next_retry_at` | TIMESTAMPTZ NULLABLE | Non-null when status = `RETRY_WAIT` |
| `last_error_code` | TEXT NULLABLE | Sanitized error code |
| `last_error_message_sanitized` | TEXT NULLABLE | Sanitized; no PII |
| `filter_decision_reason_sanitized` | TEXT NULLABLE | Why the filter decision was made; no raw email content |
| `discovered_at` | TIMESTAMPTZ NOT NULL | Set when the item is first upserted (DISCOVERED status) |
| `fetch_started_at` | TIMESTAMPTZ NULLABLE | Set when item lease acquired for fetch |
| `fetch_completed_at` | TIMESTAMPTZ NULLABLE | Set on terminal fetch transition (FETCHED or PERMANENTLY_FAILED) |
| `updated_at` | TIMESTAMPTZ NOT NULL | Updated on every state transition |
| **Unique** | `(scan_run_id, email_source_id)` | One item per message per scan run |

### email_manual_classification

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `user_id` | FK → User | |
| `email_source_id` | TEXT NOT NULL (composite FK → email_source via `fk_classification_source`) | No single-column FK; ownership enforced by composite FK `(user_id, email_source_id) → email_source(user_id, id)` ON DELETE CASCADE (C55) |
| `previous_classification` | TEXT CHECK **NOT NULL** | `UNREVIEWED`, `FINANCIAL`, `NON_FINANCIAL`, `UNCERTAIN`; NOT NULL — captures state transition |
| `new_classification` | TEXT CHECK | `UNREVIEWED`, `FINANCIAL`, `NON_FINANCIAL`, `UNCERTAIN` |
| `reason` | TEXT NULLABLE | Free-text reviewer notes |
| `classified_by` | TEXT NULLABLE FK → User **ON DELETE SET NULL** | User who made the classification; nullable so user deletion cannot block erasure (C11) |
| `classified_at` | TIMESTAMPTZ NOT NULL | |
| `classification_version` | INTEGER NOT NULL | Value of `email_source.classification_version` at time of this entry; optimistic concurrency |
| `created_at` | TIMESTAMPTZ | Append-only — rows are never updated or deleted |
| **Unique** | `(email_source_id, classification_version)` | One classification entry per version |

**Current classification** is materialized on `email_source.current_manual_classification` and
kept consistent via a transactional 4-step update (validate `classification_version` → insert
history row → update `current_manual_classification` → increment `classification_version`). The
`email_manual_classification` table is the authoritative audit history; no `UPDATE` or `DELETE`
operations are ever performed on it.

---

## 2. API routes — 36 endpoints (current) + 20 planned (Phase 1A)

> Route count post-Phase 1A: **56 total** `[Planned — pending approval]`. Existing 36 routes are unchanged
> except `/api/gmail/sync/advance` receives the SEC-2 fix (Bearer-only auth, query param removed).

**Auth column:** `session` = requires NextAuth session (via `auth()`); `public` = listed in
`auth.config.ts` public routes; `cron/bearer` = `CRON_SECRET`; `qstash` = QStash JWT verification via `Receiver` class.
Methods are indicative (per route handler exports).

### 2.1 Auth
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/auth/[...nextauth]` | GET/POST | public | NextAuth handler (sign-in/out, callback) |

### 2.2 Gmail sync
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/gmail/sync/start` | POST | session | Create job (returns jobId fast); 409 if active |
| `/api/gmail/sync/advance` | GET | **session OR cron/bearer** | Cron/manual: progress a job by one chunk. Does **not** start new jobs. |
| `/api/gmail/sync/status` | GET | session | Job status/progress |
| `/api/gmail/sync/active` | GET | session | Currently active job (if any) |
| `/api/gmail/sync/pause` | POST | session | Pause a running job |
| `/api/gmail/sync/cancel` | POST | session | Cancel a job |
| `/api/gmail/sync/retro` | POST | session | Retro / re-trigger sync |
| `/api/gmail/reconcile` | POST | session | Reconcile statement vs transactions |

### 2.3 Transactions
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/transactions` | GET | session | List/search transactions |
| `/api/transactions/[id]` | PATCH | session | Edit a transaction |
| `/api/transactions/[id]/category` | PATCH | session | Change category (feeds learning) |
| `/api/transactions/export` | GET | session | Export CSV |
| `/api/transactions/demo` | DELETE | session | Remove demo transactions |

### 2.4 Analytics & assets
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/analytics/dashboard` | GET | session | KPIs, spend-by-category, recent txns |
| `/api/assets` | GET/POST | session | List / create assets |
| `/api/assets/[id]` | PATCH/DELETE | session | Edit / delete asset |

### 2.5 Taxonomy
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/categories` | GET/POST | session | List / create categories |
| `/api/categories/[id]` | PATCH/DELETE | session | Edit / delete category |
| `/api/subcategories` | GET/POST | session | List / create sub-categories |
| `/api/subcategories/[id]` | PATCH/DELETE | session | Edit / delete sub-category |
| `/api/vpa` | GET/POST | session | VPA → merchant maps |

### 2.6 Settings
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/settings/filters` | GET/POST | session | Legacy email filters (list/create) |
| `/api/settings/filters/[id]` | DELETE | session | Delete a filter |
| `/api/settings/gmail-query` | GET/POST/DELETE/PATCH | session | Gmail query keywords |
| `/api/settings/exclusion-rules` | GET/POST/DELETE/PATCH | session | Exclusion rules |
| `/api/settings/subcategories` | GET/POST/DELETE | session | Manage subcat master |
| `/api/settings/statement-passwords` | GET/POST | session | List / save encrypted passwords |
| `/api/settings/statement-passwords/[domain]` | DELETE | session | Delete a password |
| `/api/settings/parse-logs` | GET | session | View parse logs |
| `/api/settings/parse-logs/[id]/reprocess` | POST | session | Reprocess a parse log entry |

### 2.7 User & ops
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/user/info` | GET | session | Current user info |
| `/api/user/data` | DELETE | session | Delete financial data (partial). Explicitly deletes: `Transaction`, `SyncJob`, `ParseLog`, `Asset`; resets `User.gmailSyncedAt`. `SyncJobMessage` is **also deleted** via cascade from `SyncJob` (`onDelete: Cascade` — **[Confirmed]** `prisma/schema.prisma`). Does **not** delete `Account`, `Session`, `VpaMerchantMap`, `MerchantRule`, `StatementPassword`, `LlmCallLog`, etc. |
| `/api/health` | GET | public | Health check |
| `/api/test/auth-seed` | POST | cron-secret + flag | **Non-prod** session minting for tests (see `06`) |

### 2.8 Phase 1A routes — 20 new endpoints `[Planned — pending approval]`

> All items in this section are **`[Planned — pending approval]`**. Auth column:
> `session` = NextAuth session; `qstash` = QStash JWT verification via `Receiver` class (no session).

#### Gmail scan management
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/gmail/scan` | POST | session | Create `email_scan_run`, snapshot filter version, enqueue first QStash batch |
| `/api/gmail/scan/worker` | POST | **qstash** | DISCOVERY: one Gmail List page, up to 500 IDs; FETCH: up to 25 claimed items; **not session-authed** |
| `/api/gmail/scan/{id}` | GET | session | Read scan run status and progress counters (30+ fields) |
| `/api/gmail/scan/{id}/pause` | POST | session | Pause a scan run |
| `/api/gmail/scan/{id}/resume` | POST | session | Resume a paused scan run |
| `/api/gmail/scan/{id}/cancel` | POST | session | Cancel a scan run (sets `status=CANCELLING`) |
| `/api/gmail/scan/{id}/retry` | POST | session | Recover an unpublished CREATED scan, trigger RETRY_WAIT manual retry, or recover a stalled active scan with an expired lease |

#### Email source / inventory
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/gmail/email/{sourceId}` | GET | session | Email source metadata (no body stored in Phase 1A) |
| `/api/gmail/email/list` | GET | session | Paginated email inventory with filter/status params |
| `/api/gmail/email/stats` | GET | session | Aggregate counts: total, fetched, failed, by filter_decision |
| `/api/gmail/email/{sourceId}/classify` | POST | session | Submit manual classification (appends to `email_manual_classification`) |
| `/api/gmail/email/{sourceId}/classifications` | GET | session | Classification history for a source (audit trail) |

#### Filters and versions (C16)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/email-filters` | GET | session | List all filters for user |
| `/api/email-filters` | POST | session | Create a new filter (logical entity) |
| `/api/email-filters/{id}` | GET | session | Get filter with current version |
| `/api/email-filters/{id}` | PATCH | session | Update filter name/active status |
| `/api/email-filters/{id}` | DELETE | session | Delete filter (cascades to versions) |
| `/api/email-filters/{id}/versions` | GET | session | List published versions for filter (audit) |
| `/api/email-filters/{id}/versions` | POST | session | Publish new immutable version snapshot |
| `/api/email-filters/{id}/versions/{versionId}` | GET | session | Get a specific version snapshot |

> **Note:** Rule-draft CRUD (`POST/PATCH/DELETE /api/email-filter-rules`) is **not implemented**
> in Phase 1A — the six-table schema has no draft-rule persistence (C16). Every rule change
> creates a new immutable version row.

> **Note on `/api/gmail/scan/worker` auth (C9, C17):** This endpoint verifies the QStash JWT
> using the `@upstash/qstash` `Receiver` class (`receiver.verify({ signature, body, url })`).
> The `url` parameter must be set to the exact expected worker URL so the JWT `sub` claim is
> validated. `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` are used by the Receiver
> SDK. The endpoint does **not** accept NextAuth sessions. User identity is resolved from
> `scanRunId` → `email_scan_run.user_id` (must match the owner). A user-supplied `scanRunId`
> cannot access another user's scan because the worker verifies ownership before acquiring any
> lease. Non-retryable errors return HTTP 489 + `Upstash-NonRetryable-Error: true` (C17).

> **Total Phase 1A routes: 20** (scan management: 7; email inventory/classification: 5; filters/versions: 8). **Running total after Phase 1A: 56 routes** (baseline 36 + 20 new).

---

## 3. Integrations

| Integration | Direction | Via | Auth | Status |
|-------------|-----------|-----|------|--------|
| **Gmail API** | outbound (read) | `src/lib/gmail.ts` | OAuth token (readonly scope) | [Confirmed] |
| **Google OAuth** | inbound (sign-in) | NextAuth Google provider | client id/secret | [Confirmed] |
| **Gemini API** | outbound | `llm/providers/gemini.ts` | API key | [Confirmed] |
| **OpenAI API** | outbound (fallback) | `llm/providers/openai.ts` | API key | [Confirmed] |
| **Neon PostgreSQL** | outbound (data) | Prisma + Neon adapter | connection string | [Confirmed] |
| **Vercel Cron** | inbound (schedule) | `vercel.json` → advance route | `CRON_SECRET` bearer | [Confirmed] |
| **Upstash QStash** | inbound (schedule) | `/api/gmail/scan/worker` | QStash JWT via `Receiver` class (`Receiver.verify({ signature, body, url, clockTolerance })`) | `[Planned — pending approval]` |

---

## 4. Migration timeline (13 migrations)

| Date-ordered migration | Introduces |
|------------------------|-----------|
| `20260708235932_init` | Initial schema |
| `20260709083711_add_syncjob_messageids` | SyncJob message tracking |
| `20260709112945_add_user_email_verified` | `User.emailVerified` |
| `20260709194629_plan9a_schema` | Plan-9a schema changes |
| `20260711150726_add_syncjob_scan_pagination` | `SyncJob.scanPageToken` |
| `20260711160000_add_syncjobmessage_table` | `SyncJobMessage` model |
| `20260711220743_add_gemini_usage_log` | `GeminiUsageLog` |
| `20260712154013_gmail_sync_redesign_v2` | Sync redesign v2 |
| `20260712203815_add_vpa_merchant_map` | `VpaMerchantMap` |
| `20260713000000_add_category_slug` | `Category.slug` |
| `20260713222953_add_llm_routing_tables` | `LlmCallLog`, `LlmQuotaWindow`, `LlmCircuitBreaker`, `LlmBatchIdempotency`, `SyncJobLock` |
| `20260714000000_add_subcategory` | `SubCategory`, `SubCategoryMaster` |
| `20260714100000_add_parse_template` | `ParseTemplate` |

**[Confirmed]** — `ls prisma/migrations/`.

### Phase 1A migration `[Planned — pending approval]`

One additional migration will be added during Phase 1A:

| Migration | Introduces |
|-----------|-----------|
| `20260718000000_phase1a_scan_schema` | `email_filter`, `email_filter_version`, `email_source`, `email_scan_run`, `email_scan_item`, `email_manual_classification` (6 tables; 27→33 models) |

**Strategy:** Additive only. No FKs into `SyncJob`, `ParseLog`, `Transaction`, or `SyncJobMessage`.
The migration creates six new tables and also performs the explicitly approved additive Account
changes: adding `UNIQUE(userId,id)`, `disconnected_at`, and `disconnection_reason` to the
existing `Account` table. It is not accurate to state that no existing columns are added.
Rollback is not only DROP TABLE and is not risk-free — see `07-design-decisions.md` ADR-14
rollback sequencing. **[Planned — pending approval]**

---

*Cross-references:* how these models are used → `04-architecture.md`; auth/security detail →
`06-security-authentication.md`; documented-vs-real deltas → `08-implementation-status.md`;
Phase 1A acceptance criteria → `14-phase0-assessment.md §15`.
