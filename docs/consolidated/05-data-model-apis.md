# 05 — Data Model, APIs & Integrations

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Frozen:** 2026-07-14 — baseline commit frozen; document text updated through Pass 6
> against the same commit anchor. No modifications to the baseline commit itself.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
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

> **Model count = 27.** Verified `grep -c "^model " prisma/schema.prisma`. *(Memory said 25 —
> **[Stale]**; the two extra are additions from later migrations.)*

---

## 2. API routes — 36 endpoints

Verified `find src/app/api -name route.ts | wc -l` = 36. **Auth column:** `session` = requires
NextAuth session (via `auth()`; 33 routes use it); `public` = listed in `auth.config.ts` public
routes; `cron/bearer` = `CRON_SECRET`. Methods are indicative (per route handler exports).

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
| `/api/gmail/scan` | POST | session | Scan (enumerate) matching messages |
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

> Route total = **36**. Breakdown: 33 routes resolve `auth()` (including `/api/gmail/sync/advance`
> which accepts session OR cron-bearer); 3 routes do not resolve `auth()`:
> `/api/auth/[...nextauth]` (public), `/api/health` (public), `/api/test/auth-seed`
> (cron-secret + flag). **[Confirmed]** — `find src/app/api -name route.ts | wc -l` = 36.

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

---

*Cross-references:* how these models are used → `04-architecture.md`; auth/security detail →
`06-security-authentication.md`; documented-vs-real deltas → `08-implementation-status.md`.
