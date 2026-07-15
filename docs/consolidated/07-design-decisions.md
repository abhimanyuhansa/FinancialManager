# 07 — Design Decisions

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Pass 3 corrections:** 2026-07-14 — ADR-07 resolvedBy=NULL (not "static");
> ADR-12 rationale/intent tagged [Unverified — PM/Architect Decision Required].
> **Pass 4 corrections:** 2026-07-15 — ADR-04 settings advance button noted as dev-only (G-04
> adjacent); ADR-04 Vercel cron syntax restriction re-tagged [Unverified — External Platform
> Configuration] (G-08).
> **Pass 6 corrections:** 2026-07-15 — ADR-06 Decision/Rationale corrected to match actual
> error-handling behavior (rows are acknowledged processed on failure, not retried). I-02.

> ADR-style record of the key architectural choices made during this project. Each entry
> documents context → decision → rationale → alternatives considered → current status.
> Sources: original spec (`docs/superpowers/specs/2026-07-09-financial-manager-design.md`),
> design plans (`docs/superpowers/plans/`), and code at baseline commit.

---

## ADR-01 — Framework: Next.js App Router monolith

**Context:** A personal-finance POC for 2–10 users needs a full-stack framework that can
deploy to a zero-cost host and avoid the operational overhead of separate frontend and backend
services.

**Decision:** Next.js 16 (App Router), deployed as a single monolith on Vercel Hobby.
All server logic lives in API routes (`src/app/api/**/route.ts`) and shared libs
(`src/lib/**`). No microservices. **[Confirmed]** — `package.json` (`next: 16.2.10`),
`vercel.json`.

**Rationale:** Single repo, single deploy, zero inter-service networking, Vercel's
first-class Next.js support, and the App Router's co-located server components.

**Alternatives considered:** Separate Next.js frontend + Express API; Remix; SvelteKit.
All rejected: extra operational complexity or unfamiliarity.

**Status:** Confirmed active. *(Spec said "Next.js 14"; running `16.2.10` — **[Stale]** in
`08`.)*

---

## ADR-02 — Database: Neon serverless PostgreSQL + Prisma

**Context:** Cost target is ≈ $0/month (NFR-COST-1). The app needs type-safe relational
queries with support for migrations as the schema evolves rapidly during a POC.

**Decision:** Neon serverless PostgreSQL (free tier, auto-suspend), accessed via Prisma 7
(`@prisma/adapter-neon`). Config: `prisma.config.ts` (loads `.env.local` via `dotenv`).
**[Confirmed]** — `prisma.config.ts`, `package.json`.

**Rationale:** Neon's free tier has no idle-compute cost (unlike RDS/AlloyDB). Prisma's
type-safe client + migration tooling (`prisma migrate deploy`) fits a rapid-iteration POC.

**Alternatives considered:** PlanetScale (MySQL); Turso (SQLite at edge); Supabase. Neon
chosen for Postgres compatibility, free tier limits, and official Prisma adapter.

**Status:** Confirmed active.

---

## ADR-03 — Auth: NextAuth v5 split config (edge vs Node)

**Context:** Next.js middleware runs on the Vercel Edge Runtime, which cannot load Node.js
native modules. The PrismaAdapter requires Node.js. All routes need a consistent session
check.

**Decision:** Split NextAuth into two configs:
- `src/lib/auth.config.ts` — edge-safe: Google provider + `authorized` callback (public
  route list only, no Prisma).
- `src/lib/auth.ts` — Node-only: `PrismaAdapter` + `session: "database"`.

**[Confirmed]** — `auth.config.ts`, `auth.ts`; see `06-security-authentication.md §1.2`.

**Rationale:** The Prisma adapter cannot load in the edge runtime. The split lets the
middleware gate routes cheaply on the edge while the session is persisted in the DB by the
Node handler. Database-backed sessions mean sessions survive server restarts.

**Alternatives considered:** JWT sessions (stateless, no Prisma needed on edge) — rejected
because DB-backed sessions are easier to revoke and the DB is already required.

**Status:** Confirmed active.

---

## ADR-04 — Cron: daily `0 2 * * *` instead of `*/15 * * * *`

**Context:** The advance route must be called repeatedly to progress sync jobs. Frequent
polling (`*/15`) would keep jobs moving without user interaction.

**Decision:** Cron expression `0 2 * * *` (once daily at 02:00 UTC). **[Confirmed]** —
`vercel.json`.

**Rationale:** Vercel Hobby plan does **not support** `*/N` cron syntax — only standard
`H H H H H` expressions. **[Unverified — External Platform Configuration]** (Vercel
platform constraint; not specified in `vercel.json`.) The daily cron is a keep-alive /
recovery mechanism; the primary advance driver is client-side polling initiated by the user
during an active sync session. The advance route can also be triggered manually via the
settings UI (`?secret=` or Bearer). **Note:** the Settings page "Advance Sync" button is
**dev-only** — it is wrapped in `{process.env.NODE_ENV === "development" && ...}` at
`src/app/(app)/settings/page.tsx:1400` and is **not rendered in production builds**.
**[Confirmed]**

**Alternatives considered:** Higher-frequency cron — blocked by Hobby plan restrictions.
Moving to a paid Vercel plan or using an external scheduler (GitHub Actions, Railway) —
deferred as out-of-scope for POC.

**Status:** Confirmed active. (Prior memory described this as "daily automated sync" — that
is **[Stale]**: the cron advances pending jobs, it does not start new ones — see `08` row 20.)

---

## ADR-05 — LLM: Gemini always primary, OpenAI always fallback

**Context:** The LLM router needs two providers for resilience. Early designs considered
routing by batch size (≤10 → Gemini, >10 → OpenAI). Gemini-2.0-flash-lite was deprecated;
the new `gemini-3.1-flash-lite` was validated as faster at our batch sizes.

**Decision:** Gemini is **always** primary regardless of batch size; OpenAI is always
fallback. Default models: `gemini-3.1-flash-lite` (2–10s), `gpt-4o-mini` (5–35s).
Overridable via `LLM_PRIMARY_PROVIDER` env var. **[Confirmed]** — `src/lib/llm/router.ts`
(`getPrimaryProvider` ignores `_candidateCount`); commits `e4adbfa` (Gemini always primary),
`e41d2ed` (replace gpt-5-nano with gpt-4o-mini).

**Rationale:** Gemini free tier has lower latency at the batch sizes we use (25 emails/tick).
OpenAI provides resilience when Gemini quota is exhausted or its circuit breaker opens.
Size-based routing was removed because it added complexity without measurable benefit at POC
scale.

**Alternatives considered:** OpenAI primary (higher cost); per-tick size-based routing
(removed — see `08` conflict row 1); OpenRouter aggregator (removed after key compromise —
see `12-open-questions.md` OQ-2).

**Status:** Confirmed active. *(Earlier docs and memory described size-based routing —
**[Stale]** — `08` row 1.)*

---

## ADR-06 — One-provider-per-tick (no within-tick fallback)

**Context:** Earlier design allowed within-tick fallback: if Gemini failed mid-batch, the
same tick would retry with OpenAI. This created complex partial-success state.

**Decision:** Remove within-tick fallback. Each tick picks exactly one provider. If provider
execution fails, the failure is caught per-chunk: the advance route writes an `error` outcome
to `ParseLog` for each affected candidate and marks the chunk `processed = true` — the
affected rows are acknowledged as processed, not retried on the next tick. Automatic retry
occurs only under the narrow single-error recovery condition (see NFR-REL-4). **[Confirmed]** —
commit `31a6077`; `src/lib/llm/router.ts`; `advance/route.ts:443–460, 568–571`.

**Rationale:** Eliminates partial-write state where some messages in a batch were processed
by Gemini and some by OpenAI in the same tick. Simplifies idempotency bookkeeping. The
circuit breaker and quota windows ensure the next tick won't pick a failed provider again
immediately. Predictability > throughput at POC scale.

**Alternatives considered:** Keep within-tick fallback with careful transaction management —
rejected as disproportionately complex for a POC.

**Status:** Confirmed active.

---

## ADR-07 — Parse chain: tier-0 static parser first

**Context:** Most financial emails from Indian banks follow predictable templates (SMS
forwards, standard alert formats). Sending all emails to an LLM would exhaust free-tier
quota rapidly and add latency for each message.

**Decision:** `src/lib/staticParser.ts` runs first (tier-0) and early-returns for emails it
can parse deterministically. **Static tier outcomes set `ParseLog.resolvedBy = NULL`** —
the field is not populated. Only tiers 1–3 write explicit `resolvedBy` values (`exact_cache`,
`template`, `llm`). **[Confirmed]** — `src/lib/staticParser.ts`; `advance/route.ts:242–313`.
*(Earlier docs claimed `resolvedBy="static"` — **[Stale]**; actual value is NULL — `08` row 23.)*

**Rationale:** Deterministic extraction is free (no LLM cost), fast (~1ms), and perfectly
accurate for recognized patterns. Keeps the majority of emails off the LLM.

**Alternatives considered:** LLM-first (max flexibility, max cost); template-only (limited
to known senders). Static-first is the standard "deterministic fallback to probabilistic"
pattern.

**Status:** Confirmed active. *(Undocumented in prior docs — **[Undocumented → Confirmed]**
per `08` §1.2.)*

---

## ADR-08 — Tier-1 exact cache = prior-parse-result lookup by `gmailMsgId`

**Context:** During reprocessing or sync retriggers, previously parsed emails would be sent
through the full parse chain again, wasting LLM calls and potentially producing different
results.

**Decision:** `src/lib/exactResultCache.ts` queries `ParseLog` by `[userId, gmailMsgId]`
to find a prior successful parse. If found, it returns the cached `transactionId` without
re-parsing. `resolvedBy="exact_cache"`. **[Confirmed]** — `exactResultCache.ts:4–24`.

**Rationale:** Idempotent reprocessing without LLM cost. A `gmailMsgId` uniquely identifies
an email; if it was already parsed successfully, the result is deterministic (the email
content hasn't changed).

**Alternatives considered:** Content-hash cache (hash the email body, cache by hash) —
rejected as more complex and not needed; msgId is already a stable unique key.

**Status:** Confirmed active. *(Prior docs described this as "identical email content" cache
— **[Stale]** — `08` row 16.)*

---

## ADR-09 — Template cache lifecycle: SHADOW → ACTIVE → DEGRADED → DISABLED

**Context:** Per-sender extraction templates can be learned from LLM outputs to avoid
future LLM calls. But a new template might be wrong; promoting it immediately could cause
silent extraction failures.

**Decision:** Templates follow a four-state lifecycle managed in `src/lib/parseTemplateCache.ts`:
- **SHADOW**: new template; shadow-runs alongside LLM to gather stats without affecting output.
- **ACTIVE**: ≥3 consecutive successes → promoted; becomes the primary extractor.
- **DEGRADED**: ≥3 consecutive failures → demoted; shadow-runs again.
- **DISABLED**: consecutive failures threshold exceeded; pruned on next advance tick.

`resolvedBy="template"`. **[Confirmed]** — `parseTemplateCache.ts`; `ParseTemplate`
model (`status`, `consecutiveSuccesses`, `consecutiveFailures`).

**Rationale:** Gradual promotion prevents bad templates from silently corrupting
categorization. Shadow-running validates accuracy before committing. The DISABLED prune
keeps the `ParseTemplate` table clean.

**Alternatives considered:** Immediate promotion (faster learning, higher error risk);
confidence-threshold-only (no lifecycle states) — rejected as insufficient.

**Status:** Confirmed active. *(Undocumented in prior docs — **[Undocumented → Confirmed]**
per `08` §1.2.)*

---

## ADR-10 — Gmail Batch API for message fetches

**Context:** The sync advance tick must fetch full message content for up to 25 emails
per chunk. Fetching each individually requires 25 sequential HTTP round trips (2.5–10s).

**Decision:** Use Gmail's Batch HTTP API to fetch up to 50 messages in a single HTTP
multipart request (~300–600ms). **[Confirmed]** — `src/lib/gmail.ts`; introduced in the
Gmail sync redesign v2 (`docs/superpowers/plans/2026-07-12-gmail-sync-redesign.md`).

**Rationale:** 8 problems were identified with the original sync design (sequential fetches,
no pagination, lost progress on timeout). The Batch API addresses the latency problem:
O(1) HTTP calls instead of O(n) within the 60s Vercel function budget.

**Alternatives considered:** Sequential individual fetches (simple, too slow); Gmail push
notifications (requires public webhook, overkill for POC).

**Status:** Confirmed active.

---

## ADR-11 — `pdf-parse` as `serverExternalPackage`

**Context:** `pdf-parse` uses native C++ bindings (via `canvas`). Next.js 16 bundles
server code by default; bundling native modules fails at build time.

**Decision:** Add `pdf-parse` to `serverExternalPackages` in `next.config.ts`:
```ts
serverExternalPackages: ["pdf-parse"]
```
**[Confirmed]** — `next.config.ts`.

**Rationale:** Marking it external tells Next.js to `require()` it from `node_modules`
at runtime rather than bundling it. This is the standard pattern for native Node modules
in Next.js.

**Alternatives considered:** Stub the PDF parser in the bundle — rejected; statement
password storage requires it. Use a pure-JS PDF parser — not evaluated at this time.

**Status:** Confirmed active. Note: `decrypt()` is not called in the parse path (`gmail.ts:27`);
PDF parsing with passwords is **[Not Implemented]** even though the module is present.

---

## ADR-12 — SYSTEM_GLOBAL models (no `userId`)

**Context:** Some configuration — Gmail query keywords, sender exclusion rules, merchant
category mappings — is maintained at the application level, not per-user. For a 2–10 user
POC with a single administrator, per-user copies would require coordination to stay consistent.

**Decision:** Five models have no `userId` field and are shared across all users:
`GmailQueryKeyword`, `ExclusionRule`, `EmailFilter`, `MerchantMaster`, `SubCategoryMaster`.
Mutations to these models (via `/api/settings/gmail-query`, `/api/settings/exclusion-rules`,
category/subcategory endpoints) affect all users. **[Confirmed]** — `prisma/schema.prisma`;
`06-security-authentication.md §1.5`.

**Rationale:** Simplicity for a single-operator POC. Merchant→category learning
(`MerchantMaster`) is more accurate when pooled across users. Gmail query keywords and
exclusion rules are application-wide config, not personal preferences.

**Alternatives considered:** Per-user copies of all config (full isolation, more complex
seeding/migration); hybrid (some global, some per-user) — not evaluated.

**Trade-off:** Any authenticated user can modify SYSTEM_GLOBAL settings, affecting all
users. Documented in `06` §1.5 and `10-risks-tech-debt.md §4`.

**Status:** [Unverified — PM/Architect Decision Required]. The **schema fact** (no `userId`
on these models) is **[Confirmed]** — `prisma/schema.prisma`. However, the **rationale and
intent** — that this is a conscious single-operator design choice, not an oversight — is not
documented in the code and has not been confirmed by the PM or architect. The trade-off
analysis (simplicity vs multi-user isolation) above is the auditor's interpretation; the
owner must confirm it reflects the actual design intent.
*(Stale prior claim: "all models have `userId`" — **[Stale]** per `08` row 22.)*

---

*Cross-references:* how these decisions are implemented → `04-architecture.md`; data model
implications → `05-data-model-apis.md`; security consequences → `06-security-authentication.md`;
conflicts with prior docs → `08-implementation-status.md §2`.
