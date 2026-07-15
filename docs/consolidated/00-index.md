# Financial Manager — Consolidated Knowledge Base (Index)

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 8
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Status:** Pass 1 through Pass 8 complete — all 14 documents written and verified.
> **Pass 8:** 2026-07-15 — 2 further inaccuracies (K-01, K-02) corrected: freeze metadata
> standardized across 04, 07, 09, 10, 11, 12, 13 (Pass-7 freeze declaration added); index
> status updated to Pass 8; two malformed table rows fixed (NFR-SCALE-4 in 03 merged to
> 3 columns; NFR-DATA-2 in 13 moved [Partial] qualifier into Requirement cell to stay at
> 7 columns). K-01, K-02.
> **Pass 7:** 2026-07-15 — 4 further inaccuracies (J-01 through J-04) corrected: freeze
> metadata standardized across all documents (Pass 6 status and date reflected); parse-audit
> guarantee narrowed (FR-C9, NFR-DATA-2 changed to [Partial] with REL-8 reference); three
> traceability-matrix test cells corrected (FR-C4 file count, FR-C9 E2E qualifier, FR-D3 no
> E2E); OPS-2 likelihood qualifier corrected ("by design" removed — design intent unverified
> per ADR-12). J-01, J-02, J-03, J-04.
> **Pass 6:** 2026-07-15 — 7 further inaccuracies (I-01 through I-07) corrected across 10
> documents: Frozen metadata updated to reflect corrections through Pass 5; ADR-06 corrected
> to match actual error-handling behavior (rows acknowledged processed, not retried); parse
> audit-trail claim narrowed (missing batch responses silently skipped — new REL-8 risk added);
> NFR-LAT-1 and FR-E1 E2E cells set to none (misleading test references removed); route-count
> formula corrected; non-LLM per-file block estimates removed (101 ≠ 81 contradiction);
> NFR-SCALE-1 self-contradiction fixed (TENANT_ROOT has no userId FK).
> **Consolidation date:** 2026-07-14
> **Compiled by:** Senior Software Architect (incoming), reviewed by Product Manager.
> **Reviewer pass:** All 8 pass-1 documents corrected against commit SHA above (SEV-1
> isolation boundary, SEV-2 advance method / exact-cache semantics / resolvedBy values /
> user-data DELETE scope / PDF password status, SEV-3 latency classification / scaling
> statement). Pass-2 added 6 new documents (07, 09–13).
> **Pass 3:** 2026-07-14 — Reviewer pass applied. 11 findings corrected across 12 documents
> (6-tier ownership taxonomy, resolvedBy=NULL for static outcomes, syncFromDate never written,
> SyncJobMessage cascade, API method corrections, ADR-12 intent unverified, Playwright
> webServer auto-start, E2E total 50, spec filenames, Vercel single-instance unverified,
> advance button dev-only; REL-6/REL-7 risks added; OQ-11 added).
> **Pass 4:** 2026-07-15 — 9 further inaccuracies (G-01 through G-09) corrected across 10
> documents: REL-7 risk removed (validateProviderResults throws on mismatch — risk is invalid);
> REL-6 recovery path corrected; transaction no-DELETE corrected; SyncJobLock and LlmCallLog
> reclassified to OPERATIONAL_GLOBAL; gap modules removed from unit-test inventory table;
> E2E build prerequisite (npm run build) restored; E2E coverage descriptions corrected;
> NFR-SCALE-1/2 terminology updated to 6-tier taxonomy; NFR-QUOTA-2 "defers work" corrected
> to ProviderExhaustedError; ADR-04 settings advance button dev-only caveat added; spec
> filename 13-nonfunctional.spec.ts corrected throughout.
> **Pass 5:** 2026-07-15 — 7 further inaccuracies (H-01 through H-07) corrected across 10
> documents: TENANT_ROOT tier added to 7-tier ownership taxonomy (User reclassified; resolves
> self-contradiction in TENANT_SCOPED_ENFORCED definition); OPERATIONAL_GLOBAL redefined to
> allow optional user reference (resolves LlmCallLog nullable userId contradiction);
> NFR-QUOTA-2 corrected to reflect unconditional processed=true (chunk is acknowledged
> regardless of LLM success); NFR-REL-4 changed [Confirmed]→[Partial] (recovery is
> narrow — exactly-1-error condition only); §1.1 "transactions CRUD" corrected to PATCH-only;
> unit-test sub-totals corrected (tests/lib/llm/ 11 files/65 blocks; LLM-adjacent legacy 2/17;
> non-LLM 9/81); FR-E1/FR-K2/NFR-LAT-1 traceability corrected and gap table updated;
> E2E constraints table contradiction fixed; REL-6/"permanent" removed; OPS-2 "by design"
> replaced with ADR-12 [Unverified] reference.

---

## Purpose

This folder is the **validated, auditable source of truth** for the Financial Manager
project. Every material claim here was verified and corrected against commit
`31a607738f19ee3920a961e5cf347a6cf99a28f5` — not merged blindly from prior notes.

Where prior documentation or memory conflicted with the code, **the code is treated as
truth**; the older claim is preserved as *history* (see `08-implementation-status.md`).

Original design docs and plans are **retained unchanged** under:
- `docs/superpowers/specs/` — original approved design spec (2026-07-09)
- `docs/superpowers/plans/` — historical implementation plans
- `docs/plans/` — earlier plan notes

Do not edit those originals. This `docs/consolidated/` set supersedes them for
day-to-day reference but does not delete them.

---

## Document status legend

Each material claim in these documents is tagged with one of:

| Tag | Meaning |
|-----|---------|
| **[Confirmed]** | Verified present in code / schema / config / test at consolidation time. |
| **[Partial]** | Implemented but incomplete, or only partially matching prior docs. |
| **[Planned]** | Documented as intended but **not** found in code. |
| **[Undocumented]** | Present in code but not described in prior docs/memory. |
| **[Stale]** | Prior docs/memory claim that the code contradicts. Recorded as history. |
| **[Unverified]** | Could not be confirmed from the repo; needs PM/owner clarification. |

Every claim cites its source file where practical (e.g., `prisma/schema.prisma`,
`src/lib/llm/router.ts`).

---

## Reading order

| # | Document | Audience | Contents |
|---|----------|----------|----------|
| 00 | **00-index.md** (this file) | All | Navigation, legend, cross-references. |
| 01 | [01-business-goals-scope.md](01-business-goals-scope.md) | PM, Architect, Auditor | What the product is, who it's for, scope in/out, monetization path. |
| 02 | [02-functional-requirements.md](02-functional-requirements.md) | PM, QA, Architect | Feature-by-feature functional requirements + end-to-end user flows. |
| 03 | [03-non-functional-requirements.md](03-non-functional-requirements.md) | Architect, Auditor, Ops | Cost, quota, latency, scale, reliability, privacy constraints. |
| 04 | [04-architecture.md](04-architecture.md) | Architect, Security, QA | Components + responsibilities, sync state machine, parse chain, LLM subsystem. |
| 05 | [05-data-model-apis.md](05-data-model-apis.md) | Architect, Auditor, QA | 27 Prisma models, 36 API routes (method/auth/purpose), integrations, migrations. |
| 06 | [06-security-authentication.md](06-security-authentication.md) | Security Reviewer, Auditor | Auth model, session, cron auth, verified git state, security findings + severity. |
| 07 | [07-design-decisions.md](07-design-decisions.md) | Architect, PM | ADR-style rationale for 12 key architectural decisions. |
| 08 | [08-implementation-status.md](08-implementation-status.md) | All | Implemented / Partial / Planned / Undocumented / Stale classification + conflict table. |
| 09 | [09-testing-quality.md](09-testing-quality.md) | QA, Architect | Test strategy, unit inventory (26 files/178 blocks), E2E inventory (15 specs/50 blocks), gaps. |
| 10 | [10-risks-tech-debt.md](10-risks-tech-debt.md) | PM, Architect, Security | Risk register: security findings, partial impls, reliability risks, tech debt. |
| 11 | [11-operations-deployment.md](11-operations-deployment.md) | Ops, Architect | Vercel deploy, cron, env vars (23), database, local dev, logging, monitoring gaps. |
| 12 | [12-open-questions.md](12-open-questions.md) | PM, Architect | 11 unresolved items requiring PM/owner decision. |
| 13 | [13-traceability-matrix.md](13-traceability-matrix.md) | QA, Auditor | FR/NFR → component → route → model → unit test → E2E test mapping. |

---

## Cross-reference map

- **Business goal → feature:** 01 → 02
- **Feature → component:** 02 → 04
- **Component → data/API:** 04 → 05
- **Auth/security cross-cut:** 04 (§Auth), 05 (§API auth column), 06 (full)
- **What's real vs. documented:** everything → 08
- **Why each decision was made:** 07
- **Test coverage and gaps:** 09
- **Risks and tech debt:** 10
- **How to deploy and operate:** 11
- **Open decisions for PM:** 12
- **Req → code → test traceability:** 13

---

## Source inventory (what was reviewed)

- `prisma/schema.prisma` — 27 models (authoritative data model).
- `prisma/migrations/` — 13 migrations, `20260708…init` through `20260714…add_parse_template`.
- `src/app/api/**/route.ts` — 36 API routes.
- `src/lib/` — 17 library modules + `src/lib/llm/` subsystem (router, breaker, quota, lock, idempotency, providers, prompts, validate).
- `tests/` — 26 unit-test files, ~178 `it()/test()` blocks.
- `e2e/` — 15 Playwright spec files.
- `vercel.json`, `next.config.ts`, `prisma.config.ts`, `package.json` — build/deploy config.
- Memory files under `.claude/.../memory/` and prior docs under `docs/` — treated as history, validated against code.
