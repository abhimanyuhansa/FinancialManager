# 08 — Implementation Status

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Frozen:** 2026-07-14 — baseline commit frozen; document text updated through Pass 6
> against the same commit anchor. No modifications to the baseline commit itself.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Architecture Remediation update:** 2026-07-16 — Tasks 0–7 complete; final commit `260dd90a792ae0fb2d13f952ef26a93d28c1cec8`

## Architecture Remediation — 2026-07-16

Baseline commit: `8b36c99` | Final commit: `260dd90a792ae0fb2d13f952ef26a93d28c1cec8`

| Item | Finding | Status |
|------|---------|--------|
| REL-6 | Unconditional processed=true after LLM failure | RESOLVED |
| REL-8 | Missing Gmail batch response silently dropped | RESOLVED |
| 3.1 | Template hash uses raw content (not skeleton) | RESOLVED |
| 3.2 | Known-sender static parser returns not_transaction | RESOLVED |
| 3.3 | All emails in one LLM call | RESOLVED (MAX_BATCH_SIZE=5) |
| 3.6 | PII in LLM prompts | MITIGATED |
| 3.7 | Single LLM call for all tasks | ACCEPTED (POC scope) |
| 3.8 | Subject not in LLM input | RESOLVED |
| 3.10 | Flat MIME part traversal | RESOLVED |
| 3.11 | LLM deadline/fallback | RESOLVED (prior session) |
| 3.12 | Doc/code mismatch | RESOLVED (this task) |

---

> The reconciliation of **what prior docs/memory claim** against **what the code actually does**.
> Per PM decision, **code is truth**; older claims are preserved here as history. Tags per
> `00-index.md`.

---

## 1. Status classification

### 1.1 Implemented & documented — [Confirmed]
Auth (Google, gmail.readonly, DB sessions), Gmail sync state machine, transaction list,
search, edit category, and export (no DELETE on `/api/transactions/[id]`), analytics dashboard,
assets/net-worth, categories & sub-categories, statement password encryption (storage), settings
(filters/keywords/parse-logs), 3-layer dedup, LLM router + quota + breaker + idempotency + lock,
migrations. Evidence throughout `02`–`06`.

### 1.2 Implemented but under/undocumented — [Undocumented → Confirmed]
| Feature | Evidence |
|---------|----------|
| **Static parser as tier-0** (runs before cache/LLM, early-returns) | `src/lib/staticParser.ts`; `ParseLog.resolvedBy = NULL` (field omitted for static outcomes — **not** `"static"`) |
| **VPA (UPI) auto-learn** pipeline | `src/lib/vpaLookup.ts`; `VpaMerchantMap`; `/api/vpa` |
| **SHADOW/DEGRADED template shadow-runs** alongside LLM | `src/lib/parseTemplateCache.ts`; `ParseTemplate` counters |
| **ExclusionRule** skip path (`skipped_exclusion`) | `/api/settings/exclusion-rules`; `ExclusionRule` |
| **SyncJobLock** distributed lock w/ heartbeat | `src/lib/llm/lock.ts`; `SyncJobLock` |
| `/api/gmail/sync/pause` | route present |
| `/api/user/data` (DELETE financial data — partial) | route present; deletes Transaction/SyncJob/ParseLog/Asset + resets watermark. Does **not** delete Account/Session/VpaMerchantMap/StatementPassword/LlmCallLog etc. Prior description "cascade FKs" was misleading. |
| `/api/transactions/demo` (removes demo data — **DELETE**, not POST/seed) | route present |
| `MerchantMaster` learned merchant→category | `src/lib/merchantMaster.ts`; `MerchantMaster` |

### 1.3 Partial — [Partial]
| Feature | Note |
|---------|------|
| **Reconciliation** | `ReconciliationLog` + `/api/gmail/reconcile` + `reconcile.ts` exist; end-to-end UX depth unverified — Pass 2. |
| **Review workflow** | `Transaction.reviewed`/`needsReview` fields exist; UI surfacing depth unverified — Pass 2. |
| **Legacy `EmailFilter`** | Model + `/api/settings/filters` + Settings UI tab active, **but no longer drives the parse pipeline** as older docs describe. Misleading if read as "pre-screen". |
| **Statement PDF passwords** | Storage encrypted (AES-256-GCM) [Confirmed]. **Decryption not called in parse path** — `pdfParse()` invoked without password option (`gmail.ts:27`). Password-protected PDF parsing [Not Implemented]. |

### 1.4 Documented but not implemented — [Planned]
| Claim | Reality |
|-------|---------|
| Budgeting / goals engine (spec §14 future) | No code |
| Monetization / paid tiers (spec §14 V2+) | No billing/plan/entitlement code |
| Multi-currency FX conversion | `currency` stored; no conversion logic |

### 1.5 Conflicting / stale — [Stale]
See the conflict table in §2.

---

## 2. Conflict table (docs/memory vs. code)

| # | Prior claim (docs/memory) | Reality (code) | Class |
|---|---------------------------|----------------|-------|
| 1 | LLM routing size-based: ≤10→Gemini primary, >10→OpenAI primary | `router.ts` — **Gemini always primary**, OpenAI always fallback; `getPrimaryProvider` ignores candidate count | **Stale** |
| 2 | OpenAI model `gpt-5-nano-2025-08-07` | `openai.ts` default **`gpt-4o-mini`** | **Stale** |
| 3 | Gemini model `gemini-2.5-flash` (spec) | `gemini.ts` default **`gemini-3.1-flash-lite`** | **Stale** |
| 4 | LLM timeouts raised to **50s** | Both default **30s** (`GEMINI/OPENAI_TIMEOUT_MS ?? 30_000`) | **Stale** |
| 5 | `isRetryableError()` excludes ProviderTimeoutError | **No such function**; within-tick fallback removed (one provider per tick, commit `31a6077`) | **Stale** |
| 6 | "113 unit tests, all passing" | **~178** `it()/test()` blocks across 26 files in `tests/` (excluding worktree copies) | **Stale** |
| 7 | `emailFilter.ts` "fully removed" | File/entity gone from **pipeline**, but `EmailFilter` model + `/api/settings/filters` + Settings UI still active | **Partial / misleading** |
| 8 | 25 Prisma models | **27** models (`grep -c "^model "`) | **Stale** |
| 9 | Plain "3-tier" parse chain | 3-tier **plus static tier-0** + VPA auto-learn | **Under-documented** |
| 10 | Next.js 14 (spec) | **Next.js 16.2.10** (`package.json`) | **Stale** |
| 11 | CHUNK_SIZE / chunked advance | Confirmed **25** (`advance/route.ts:22`) | **Confirmed** |
| 12 | Watermark = `job.startedAt` | Confirmed | **Confirmed** |
| 13 | Auto-retry of 1-error rows | Confirmed (advance route; commit `57d29dc`) | **Confirmed** |
| 14 | 4-layer dedup (including EmailFilter as layer 1) | **3-layer** — `@@unique` gmailMsgId + fingerprint + sourceRank. `EmailFilter` is not a dedup layer; it is legacy settings-only. | **Stale** |
| 15 | `advance` route accepts POST/GET | Route exports **GET only** (`advance/route.ts:601` — `export async function GET`) | **Stale** |
| 16 | Tier-1 exact cache keyed on "identical email content" | Cache is a **prior-parse-result lookup by `gmailMsgId`** — queries `ParseLog`; not a content-hash cache | **Stale / misleading** |
| 17 | `ParseLog.resolvedBy = "gemini"` | Actual value written is **`"llm"`** (`advance/route.ts:455,484,513`) | **Stale** |
| 18 | `/api/user/data DELETE` cascades all user data | Route **explicitly deletes** Transaction/SyncJob/ParseLog/Asset + resets watermark. Does NOT delete Account/Session/VpaMerchantMap/StatementPassword/LlmCallLog etc. | **Stale / overstated** |
| 19 | Statement PDF passwords used in parsing | `decrypt()` **not called** in parse path; `pdfParse(buffer)` called without password (`gmail.ts:27`). Storage confirmed; parsing of encrypted PDFs [Not Implemented]. | **Stale** |
| 20 | Daily cron = daily automated sync [Confirmed] | Cron **advances** pending jobs; does not **start** new jobs. Auto-start [Not Implemented]. | **Stale / overstated** |
| 21 | "No horizontal scaling design" (NFR-SCALE-4) | `SyncJobLock` IS a distributed lock designed for multi-instance correctness. Statement should be "single-instance Hobby deploy, not no-design." | **Stale / understated** |
| 22 | All models have `userId` + `onDelete: Cascade` | `GmailQueryKeyword`, `ExclusionRule`, `EmailFilter`, `MerchantMaster`, `SubCategoryMaster` have **no `userId` field** — they are SYSTEM_GLOBAL | **Stale / false** |
| 23 | `ParseLog.resolvedBy = "static"` for tier-0 outcomes | Static tier sets **no `resolvedBy`** — the field is NULL. `advance/route.ts:242–313` omits the field for static outcomes. Only tiers 1–3 write explicit values. | **Stale** |
| 24 | `SyncJobMessage` retained when SyncJob deleted | `SyncJobMessage` relation has `onDelete: Cascade` in `prisma/schema.prisma` — it IS deleted when parent `SyncJob` is deleted. | **Stale / false** |
| 25 | `User.syncFromDate` written by onboarding / sync start | The field exists in schema and is **read** as a fallback (`sync/start/route.ts:47`) but **never written** by any route. Schema debt — no write path. | **Stale** |
| 26 | `/api/transactions/demo` is POST (seed) | Route exports **DELETE** (`src/app/api/transactions/demo/route.ts`). | **Stale / inverted** |
| 27 | `Category`/`SubCategory` are USER_OWNED (per-user isolated) | These models have `userId` fields but **APIs do not enforce per-user scoping**: `GET /api/categories` has no userId filter; `PATCH/DELETE /api/categories/[id]` has no ownership check. Classification corrected to TENANT_KEYED_NOT_ENFORCED. | **Stale / understated** |
| 28 | Advance route auto-recovery resets any stuck rows | Recovery SQL at `advance/route.ts:80–107` only qualifies rows with **exactly 1 error ParseLog and 0 non-error ParseLogs**. Rows with multiple errors or mixed outcomes are not recovered. | **Stale / overstated** |

---

## 3. Test coverage gaps (no dedicated unit tests)

Core logic modules **without** a matching `tests/` file at consolidation time:

| Module | Why it matters |
|--------|----------------|
| `src/lib/staticParser.ts` | Tier-0 parser — first line of extraction; high impact if wrong |
| `src/lib/vpaLookup.ts` | UPI merchant learning — affects categorization accuracy |
| `src/lib/merchantMaster.ts` | Learned merchant→category store |
| `src/lib/gmailQuery.ts` | Builds the Gmail search query — affects what gets ingested |
| `src/lib/categoryIcons.ts` | Presentation (lower risk) |

Well-covered areas: `llm/` (router, breaker, quota, idempotency, lock, providers, prompts,
validate, types — 11 test files), `crypto`, `dedup`, `analytics`, `reconcile`, `gmail`,
`onboarding`, `exactResultCache`, `parseTemplateCache`, schema, plus API tests
(`categories`, `token`, `transactions-category`). Full coverage map → Pass-2 `09-testing-quality.md`.

---

## 4. Recommended documentation follow-ups (Pass 2)

1. Update memory files (`technical-decisions.md`, `current-progress.md`) to fix stale LLM
   routing/model/timeout/test-count claims (items 1–6, 8, 10 above).
2. Reclassify `EmailFilter` in all docs as **legacy/settings-only**, not a pipeline pre-screen.
3. Document static tier-0, VPA auto-learn, and template shadow-runs as first-class features.
4. Add unit tests for the five uncovered modules in §3.
5. Rotate the historical OpenRouter key (security follow-up, `06` FINDING-5).

---

*Cross-references:* the features → `02`; the components → `04`; the models/routes → `05`; the
security findings → `06`. This document seeds the Pass-2 risk register (`10`) and traceability
matrix (`13`).
