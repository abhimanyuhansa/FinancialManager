# 01 — Business Goals & Scope

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Frozen:** 2026-07-14 — baseline commit frozen; document text updated through Pass 6
> against the same commit anchor. No modifications to the baseline commit itself.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Pass 7 corrections:** 2026-07-15 — Frozen metadata standardized. J-01.
> **Pass 4 corrections:** 2026-07-15 — §4 transaction feature description corrected (no DELETE
> on `/api/transactions/[id]` — PATCH only; G-03).
> **Pass 5 corrections:** 2026-07-15 — §2 taxonomy reference updated to 7-tier (TENANT_ROOT
> added). H-01.
> **Pass 6 corrections:** 2026-07-15 — Frozen metadata corrected. I-01.

> Source of intent: `docs/superpowers/specs/2026-07-09-financial-manager-design.md` (approved
> design spec) and memory `project-overview.md`, validated against current code. Tags per
> `00-index.md` legend.

---

## 1. What the product is

**Financial Manager** is a personal finance web app that automatically builds a picture of a
user's spending by reading **transaction notification emails from Gmail**, parsing them into
structured transactions, categorizing them, and presenting dashboards, transaction lists, and
a net-worth / assets view. **[Confirmed]** — Gmail sync pipeline, transactions, analytics
dashboard, and assets are all implemented (`src/lib/gmail.ts`, `src/app/api/analytics/dashboard`,
`src/app/api/transactions`, `src/app/api/assets`).

It is currently a **proof-of-concept (POC)** running as a single Next.js app on Vercel, backed
by Neon PostgreSQL. **[Confirmed]** — `vercel.json`, `prisma.config.ts` (Neon adapter).

---

## 2. Target user

- Individuals (initially the developer + a small circle) who want spending tracked **without
  manual entry**, by mining the bank/card/UPI notification emails they already receive.
  **[Confirmed]** intent from spec §1; per-user data isolation via `userId` FK applies to
  all TENANT_SCOPED_ENFORCED models (`prisma/schema.prisma`). Note: `GmailQueryKeyword`,
  `ExclusionRule`, and `MerchantMaster` are **global** (no `userId`) — they are shared across
  all users; see `05-data-model-apis.md §1` for the full 7-tier ownership classification.
- Designed for **2–10 users** at POC stage (a free-tier scale target, not mass consumer).
  **[Confirmed]** as an NFR — see `03-non-functional-requirements.md`.

---

## 3. Primary goals

1. **Zero-manual-entry expense tracking** — ingest Gmail transaction alerts and turn them into
   categorized transactions automatically. **[Confirmed]**
2. **Accurate categorization** with minimal user effort — a multi-tier parse/categorize chain
   (static parser → template cache → LLM) plus learned merchant/VPA maps. **[Confirmed]**
   (`src/lib/staticParser.ts`, `src/lib/parseTemplateCache.ts`, `src/lib/llm/`, `src/lib/vpaLookup.ts`).
3. **Actionable overview** — dashboards, spend-by-category, transactions list, net worth via
   manually-entered assets. **[Confirmed]**
4. **Run at ~$0/month** — rely on free tiers (Vercel Hobby, Neon free, Gemini free tier) with
   OpenAI as a bounded fallback. **[Confirmed]** as intent; enforced by quota/circuit-breaker
   subsystem (`src/lib/llm/quota.ts`, `circuitBreaker.ts`).

---

## 4. Scope — IN (V1, implemented)

| Capability | Status | Evidence |
|-----------|--------|----------|
| Google OAuth sign-in (gmail.readonly) | [Confirmed] | `src/lib/auth.config.ts` |
| Gmail scan + incremental daily sync (cron) | [Partial] | `src/app/api/gmail/sync/*`, `vercel.json` cron. Note: the Vercel cron **advances** an existing job once daily at 02:00 UTC; it does not create a new sync job. Users must trigger sync manually. See FR-B3 in `02`. |
| Email → transaction parsing (multi-tier) | [Confirmed] | `src/lib/staticParser.ts`, `parseTemplateCache.ts`, `llm/` |
| Automatic categorization + sub-categories | [Confirmed] | `Category`, `SubCategory`, `MerchantMaster` models |
| Transactions list (view, search, edit category, export — no DELETE on `/api/transactions/[id]`) | [Confirmed] | `src/app/api/transactions/**` |
| Analytics dashboard (spend by category, trends) | [Confirmed] | `src/app/api/analytics/dashboard` |
| Assets / net worth (manual entry) | [Confirmed] | `src/app/api/assets/**`, `Asset` model |
| Encrypted statement PDF passwords | [Partial] | `StatementPassword` model, `src/lib/crypto.ts`. Storage and encryption confirmed. **Decryption is not called in the parse path** — `pdfParse()` is called without a password option (`src/lib/gmail.ts:27`). Password-protected PDF parsing is [Not Implemented]. |
| Reconciliation (statement vs transactions) | [Partial] | `ReconciliationLog` model + `src/app/api/gmail/reconcile`; verify end-to-end depth in 02. |
| Settings: filters, gmail-query keywords, exclusion rules, parse-logs | [Confirmed] | `src/app/api/settings/**` |
| VPA (UPI handle) → merchant auto-learn | [Undocumented → now Confirmed] | `src/lib/vpaLookup.ts`, `VpaMerchantMap` |

---

## 5. Scope — OUT (V1) / deferred

- **No payment aggregation via bank APIs / account aggregators.** Email-only ingestion. **[Confirmed]** — no such integration in code.
- **No mobile app.** Web only. **[Confirmed]**
- **No budgeting/goals engine** in V1. **[Planned]** — mentioned as future in spec §14; not in code.
- **No multi-currency conversion** — currency stored per-transaction (`currency` default `INR`)
  but no FX conversion logic. **[Confirmed]** default INR; conversion **[Planned]**.
- **Monetization / paid tiers** — spec §14 sketches a V2+ path; **not implemented**. **[Planned]**

---

## 6. Monetization path (historical, from spec §14)

The original spec describes a possible V2+ freemium direction (free tier + paid tier for
higher sync frequency / more history / advanced insights). This is **[Planned]** only — no
billing, plan, or entitlement code exists. Recorded here to preserve intent; see
`08-implementation-status.md` for the not-implemented list.

---

## 7. Guiding constraints (business-level)

- **Cost target ≈ $0/month.** Drives the free-tier stack and the LLM quota/circuit-breaker design. **[Confirmed]**
- **Privacy:** the app reads a user's email; it uses **read-only** Gmail scope and stores only
  parsed transaction data + message IDs, not full email bodies long-term. **[Confirmed]** scope is
  `gmail.readonly` (`auth.config.ts`); parsed data model has no raw-body column. See `06` for detail.
- **Single-repo, single-deploy POC** — no microservices; all logic in one Next.js app. **[Confirmed]**

---

*Cross-references:* feature detail → `02-functional-requirements.md`; how goals map to
components → `04-architecture.md`; scale/cost/quota → `03-non-functional-requirements.md`.
