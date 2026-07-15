# 04 — Architecture

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — document text updated through Pass 6 against the
> same commit anchor. No modifications to the baseline commit itself.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Pass 3 corrections:** 2026-07-14 — resolvedBy=NULL for static tier-0 (not "static");
> cron diagram corrected to GET; TENANT_KEYED_NOT_ENFORCED note added.
> **Pass 4 corrections:** 2026-07-15 — diagram "txn CRUD/export" corrected to "txn
> list/search/edit/export (no DELETE on [id])" (G-03).
> **Pass 6 corrections:** 2026-07-15 — §2.3 parse-audit-trail claim narrowed: missing Gmail
> batch responses are silently skipped with no ParseLog. I-03.

> As-built. Components cite their source files. State machines and the parse chain are
> reconstructed from the actual routes/libs, not from prior docs. Tags per `00-index.md`.

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
