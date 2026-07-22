# 07 — Design Decisions

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Phase 0 revision 2026-07-19:** ADR-14 corrected: 6 tables (not 7); filter schema changed
> from `email_filter_rule` individual-row table to two-table design (`email_filter` +
> `email_filter_version`); scan-run initial status `CREATED` (not `PENDING`); item status
> corrected (was `SKIPPED_BY_FILTER`; removed by C1 — `filter_decision` field now handles filter
> outcome separately from fetch `status`); filter FKs on scan-run now NOT NULL (C2); stage fields
> `current_stage`/`resume_stage` added to scan-run (C3); field names aligned (`email_source_id`,
> `normalized_subject`, `effective_gmail_query`, `filter_snapshot_json`, `fetch_attempt_count`, etc.).
> C1: cross-table referential integrity enforced via PostgreSQL constraint triggers (composite FK
> invariants cannot be expressed as declarative FKs). C2: `gmail_account_id` FK corrected to
> ON DELETE RESTRICT on all three tables referencing Account. C3: `total_filter_excluded` replaces
> `total_skipped`. C5: `max_item_retries` + `retry_count`/`max_retries` added. C6: `to_date` NOT NULL;
> `previous_classification` NOT NULL; `classification_version` + UNIQUE on `email_manual_classification`.
> C7: filter evaluation semantics — exclude wins, empty include = all included. C8: deterministic
> QStash dedup IDs (`sha256(scanRunId:stage:sequence)`) (C8, C68); DB-commit-then-publish ordering.
> **Phase 0 revision 2026-07-19 pass 4 (C9–C13):**
> C9: ADR-15 corrected — QStash authentication uses `@upstash/qstash` `Receiver` class (not manual
>   HMAC); JWT claims documented; dedup window is **10 minutes** (not 7 days, which is DLQ retention);
>   free-plan default retries = 3; retry headers: `Upstash-Retries` (publish, C17), `Upstash-Retry-Delay`
>   (backoff), `Retry-After` (destination response).
> C11: ADR-15 updated — Account disconnection model (soft-disconnect, `disconnected_at`, OAuth tokens
>   cleared); `classified_by` corrected to ON DELETE SET NULL.
> C12: ADR-15 updated — item `CANCELLED` terminal status; `started_at` nullable; `last_error`
>   renamed `last_error_message_sanitized`; filter version DB immutability trigger; SECURITY DEFINER
>   erasure bypass; item-claim uses `SELECT … FOR UPDATE SKIP LOCKED`.
> C13: ADR-15 updated — worker invocation protocol is now an 11-step sequence (see §7.3 of
>   `14-phase0-assessment.md`); retryable vs non-retryable response codes clearly specified.
> **Phase 0 revision 2026-07-19 pass 5 (C14–C23):**
> C14: ADR-15 updated — progress formula corrected; `filter_excluded_count` is subset of
>   `fetch_success_count`; CANCELLED items excluded from completion counts; completion guard
>   has third condition.
> C16: ADR-15 updated — filter API renamed to `/api/email-filters` hierarchy; rule-draft CRUD
>   removed (no draft persistence in six-table schema).
> C17: ADR-15 corrected — non-retryable response is HTTP 489 + `Upstash-NonRetryable-Error: true`
>   (not HTTP 401); retry publish header is `Upstash-Retries` (not `Upstash-Retry-Count`);
>   `Receiver.verify()` requires `url` parameter for JWT `sub` validation; failure callback
>   uses `Receiver` JWT (no separate HMAC secret).
> C18: ADR-15 updated — `Upstash-Message-Id` must not gate processing; idempotency via DB state.
> C19: ADR-15 updated — SECURITY DEFINER erasure function removed; preferred erasure is parent
>   `email_filter` deletion (CASCADE to versions); SECURITY DEFINER bypasses RLS only, not triggers.
> C20: ADR-14/ADR-15 updated — 4 of 7 ownership triggers replaced by declarative composite FKs;
>   2 new UNIQUE constraints added (`UNIQUE(email_filter_id,id)` on email_filter_version;
>   `UNIQUE(user_id,id)` on email_source); 4 triggers remain (C24 restores trg_email_scan_item_source_ownership).
> C21: ADR-15 updated — Account `ON DELETE RESTRICT` requires explicit child-deletion ordering;
>   erasure transaction defined; Account additive migration D-1 gated; token fields corrected to
>   `access_token`, `refresh_token`.
> C22: ADR-15 updated — no automatic QStash quota recovery; manual resume approved; optional
>   Vercel cron sweeper.
> C23: ADR-15 updated — `rule_schema_version` and `filter_evaluator_version` added to
>   `email_filter_version`; incompatible version → fail safely with error (not silent non-match).
> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C24: ADR-15 updated — `trg_email_scan_item_source_ownership` restored; C20 removal claim
>   corrected: `fk_classification_source` only protects classifications, not scan item ownership.
> C25: ADR-14 updated — scan lease acquisition `state_version = $expectedVersion` predicate
>   removed; continuation recovery on 0-row lease result documented.
> C26: ADR-14 updated — item-claim query corrected: RETRY_WAIT eligible arm added;
>   PERMANENTLY_FAILED exhaustion transition added.
> C28: `upstash-body-hash` claim name corrected to `body` in QStash JWT claims list.
> C29: ADR-14 updated — `GET /api/gmail/scan/list` removed from Phase 1A canonical API.
> C32: ADR-14 updated — filter version compatibility check at scan level (not item level);
>   incompatible version → scan FAILED before fetching begins.
> **Phase 0 final corrections 2026-07-19 (C72–C76):**
> C72: ADR-15 updated — PAUSED branch added to step 3 (worker returns HTTP 200 no-op; non-terminal);
>   full resume transaction documented; batch_sequence clarified as monotonic continuation generation
>   counter (advances on checkpoint, resume, and manual retry scheduling).
> C73: ADR-15 updated — worker steps 7–8 rewritten; execution branches by message stage after lease
>   acquisition. DISCOVERY: one Gmail List API page, upsert sources, insert memberships ON CONFLICT DO
>   NOTHING, persist pagination state. FETCH: FOR UPDATE SKIP LOCKED, ≤25 items. Item claiming is
>   FETCH-only.
> C74: ADR-15 updated — cancelPending(scanRunId) removed from SchedulerService interface; QStash
>   message IDs are not persisted; cancellation relies on DB state.
> C75: ADR-15 updated — chk_pending_sequence_matches_scan_sequence constraint documented; worker
>   must fail safely on coherence violation.
> C76: ADR-15 updated — "10-step sequence" replaced with "11-step sequence"; fixed 50-second item
>   lease wording replaced with configurable TTL wording; blanket "every OCC conflict returns HTTP 200"
>   statement removed; cancelPending reference in cancellation text removed.
> **Phase 0 revision 2026-07-18:** ADR-06 corrected (within-tick provider fallback behavior);
> ADR-14 corrected (7 tables, not 5; renamed email_manual_review → email_manual_classification);
> ADR-15 corrected (crypto.randomUUID() replaces VERCEL_REGION+Date.now() as lease owner).
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

## ADR-06 — One-atomic-batch-per-tick (provider selection has within-invocation fallback)

**Context:** Earlier design allowed within-tick fallback: if Gemini failed mid-batch, the
same tick would retry with OpenAI. This created complex partial-success state where some
messages in a batch were processed by Gemini and some by OpenAI.

**Decision:** Each tick processes its entire batch through **one provider only** — the batch
is atomic and provider-exclusive. However, `selectProvider()` in `src/lib/llm/router.ts` does
perform **within-invocation provider selection with fallback**: it checks Gemini first (breaker
state + quota); if Gemini is OPEN or quota-exhausted, it tries OpenAI; if both are unavailable,
it throws `ProviderExhaustedError`. This fallback happens during *provider selection* before any
batch processing begins, not mid-batch.

To be precise: the batch itself is processed by exactly one provider (no mid-batch switching).
The provider choice for that batch may fall back from Gemini to OpenAI within the same tick if
Gemini's circuit/quota blocks. **[Confirmed]** — `src/lib/llm/router.ts selectProvider()`;
commit `31a6077`; `advance/route.ts:443–460, 568–571`.

If provider execution fails after selection, the failure is caught per-chunk: the advance route
writes an `error` outcome to `ParseLog` for each affected candidate and marks the chunk
`processed = true` — the affected rows are acknowledged as processed, not retried on the next
tick. Automatic retry occurs only under the narrow single-error recovery condition (NFR-REL-4).

**Rationale:** Eliminates partial-write state. The within-invocation provider selection fallback
ensures resilience (an OPEN Gemini circuit doesn't block the batch) without introducing the
complexity of mid-batch switching. Simplifies idempotency bookkeeping.

**Alternatives considered:** Keep within-tick mid-batch fallback — rejected as disproportionately
complex for a POC. No fallback at all (fail if Gemini unavailable) — rejected; reduces resilience.

**Status:** Confirmed active. *(Prior ADR text said "Remove within-tick fallback" — this was
misleading: within-invocation fallback during **provider selection** is confirmed present in
`selectProvider()`. Only mid-batch switching is absent. Corrected 2026-07-18.)*

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

---

## ADR-13 — Feature flag: `LLM_PARSING_ENABLED` (Phase 1A, pending approval)

**Context:** The redesign requires a hard gate that prevents LLM invocation independently of
any code path changes. The gate must be testable (automated tests must prove zero LLM calls
when the flag is disabled) and must have a safe default (if the env var is unset, LLM is
disabled).

**Proposed decision:** Create `src/lib/featureFlags.ts` with:
```typescript
export function isLlmParsingEnabled(): boolean {
  return process.env.LLM_PARSING_ENABLED === "true";
}
```
This function is called at the entry point of `src/lib/llm/router.ts`. If it returns false,
a typed `LlmDisabledError` is thrown before any provider is contacted. The env var
`LLM_PARSING_ENABLED` is **server-only** — never `NEXT_PUBLIC_*`.

**Rationale:** Safe-default (off unless explicitly enabled). Testable (mock the env var in
unit tests). Single source of truth (no duplicated flag checks). Does not require a feature-flag
service (unnecessary for a POC). The LLM gate at the router rather than the caller prevents
accidental bypass through any of the 4 parse tiers.

**Status:** [Planned — pending D-4 approval]. **[Not Implemented]** at assessment date 2026-07-16.

---

## ADR-14 — Additive scan tables alongside existing SyncJob (Phase 1A, pending approval)

**Context:** Phase 1A needs a persistent email inventory (`email_source`) and scan session
tracking (`email_scan_run`, `email_scan_item`). Two options: extend `SyncJob` / `SyncJobMessage`
with new fields, or create new tables.

**Proposed decision:** Create **6 new tables** (revised from initial 5):
`email_filter`, `email_filter_version`, `email_source`, `email_scan_run`,
`email_scan_item`, `email_manual_classification` — bringing total model count from 27 to 33.

The filter design uses a two-table immutable version-snapshot approach: `email_filter` is the
logical, user-owned filter entity; `email_filter_version` stores immutable published snapshots.
There is no individual-rule row table in Phase 1A — all rule content lives inside
`email_filter_version.include_rules_json` and `email_filter_version.exclude_rules_json`. Each rule
in the JSON must carry a stable `rule_id`.

*(Note: earlier ADR-14 text listed 5 tables, named `email_manual_review`, and included an
`email_filter_rule` individual-row table. Corrected 2026-07-18 → 6 tables; 2026-07-19 → filter
schema replaced with two-table design per Q3 decision.)*

No destructive or incompatible changes are made to existing tables. Phase 1A includes the
explicitly approved additive Account changes: UNIQUE(userId,id), `disconnected_at` and
`disconnection_reason`. New tables have no foreign-key references to `SyncJob`,
`SyncJobMessage`, `ParseLog`, or `Transaction` (additive-only migration). FKs reference only
`User`, `Account`, `email_filter`, `email_filter_version`, `email_scan_run`, and `email_source`.

The final schema uses a composite-FK model: four of the seven original trigger-enforced invariants
are replaced by composite declarative foreign keys. Three cross-table invariants that PostgreSQL
cannot express as declarative FKs are still enforced via `CONSTRAINT TRIGGER`:
- `trg_email_filter_version_immutable` — prevents any UPDATE on `email_filter_version` rows
- `trg_email_scan_item_source_ownership` — rejects `email_scan_item` rows whose `email_source_id`
  does not belong to the same `user_id`/`gmail_account_id` as the scan run
- `trg_email_scan_item_parent_immutable` — prevents reparenting of `scan_run_id` or
  `email_source_id` on existing scan items

Deferred circular foreign keys (`fk_email_filter_current_version`, `fk_version_supersedes`)
are DEFERRABLE INITIALLY DEFERRED to permit single-transaction bootstrap.

**Rollback sequencing (not zero-risk):**

1. Stop all writers and workers (set feature flags to `false`; drain QStash).
2. Back up Phase 1A scan/filter/classification data if it must be retained.
3. Drop Phase 1A tables in dependency order:
   ```sql
   DROP TABLE IF EXISTS email_manual_classification CASCADE;
   DROP TABLE IF EXISTS email_scan_item CASCADE;
   DROP TABLE IF EXISTS email_scan_run CASCADE;
   DROP TABLE IF EXISTS email_source CASCADE;
   DROP TABLE IF EXISTS email_filter_version CASCADE;
   DROP TABLE IF EXISTS email_filter CASCADE;
   ```
4. Remove Account additions (`UNIQUE(userId,id)`, `disconnected_at`, `disconnection_reason`)
   only after verifying no remaining dependency references them.
5. Regenerate Prisma client and validate legacy operation (`npx prisma generate`; run legacy
   E2E suite).

**Status:** [Planned — pending D-1 approval]. **[Not Implemented]** at assessment date 2026-07-16.
Full schema: `14-phase0-assessment.md §6`. Model detail: `05-data-model-apis.md §1.9`.

---

## ADR-15 — Worker lease pattern for scan tick concurrency (Phase 1A, pending approval)

**Context:** The scan tick endpoint (`/api/gmail/scan/worker`) is delivered by Upstash QStash
(at-least-once). Under redelivery, two Vercel function invocations could process the same
batch of email IDs concurrently, leading to duplicate DB writes.

**Proposed decision:** `email_scan_run` and `email_scan_item` each carry:
- `worker_lease_owner TEXT` — set to **`crypto.randomUUID()`** per invocation (NOT
  `process.env.VERCEL_REGION + Date.now()`; UUID is collision-free and does not leak
  platform information).
- `worker_lease_expires_at TIMESTAMPTZ` — `now() + 55s` for scan-level leases (configurable
  via `WORKER_LEASE_DURATION_SECONDS ?? '55'`); item-level lease duration is also configurable
  via `$itemLeaseDurationSecs` (both within the 60s Vercel function limit with safety margins).

Scan-level lease acquisition is an atomic SQL UPDATE as in `14-phase0-assessment.md §7.3 step 5`.
Item-level lease acquisition uses `SELECT … FOR UPDATE SKIP LOCKED` to prevent double-claiming
under concurrent delivery (see `14-phase0-assessment.md §11`).

**QStash authentication (C9, C17):** Each worker invocation begins by verifying the QStash JWT using
the official `@upstash/qstash` `Receiver` class (`QSTASH_CURRENT_SIGNING_KEY` +
`QSTASH_NEXT_SIGNING_KEY`). Manual HMAC computation is NOT used. `receiver.verify()` receives
`{ signature, body, url, clockTolerance }` — the `url` parameter must be the exact expected
worker URL so the JWT `sub` claim is validated (C17). JWT claims verified: `iss:"Upstash"`,
`sub:<destination URL>`, `exp`, `nbf`, `body` (base64url SHA-256 of raw body — verified by SDK internally).
Verification failure → HTTP 489 + `Upstash-NonRetryable-Error: true` (non-retryable; C17).
Deduplication window: **10 minutes** (separate from DLQ retention which is 3 days). Free-plan
default retries: 3 (via `Upstash-Retries` publish header; C17). Backoff control:
`Upstash-Retry-Delay` (publish) and `Retry-After` (destination response). Failure callback also
uses `Receiver` JWT verification — no separate custom HMAC secret (C17).

**Worker invocation protocol (C13, C69, C72–C76):** The worker follows an 11-step sequence
(see `14-phase0-assessment.md §7.3`): (1) Receiver verify, (2) parse and structurally validate
message, (3) read authoritative state and branch — **PAUSED returns HTTP 200 no-op without
acquiring a lease** (C72); terminal/CANCELLING branches handled here; (4) validate incoming
sequence and stage (stale→C65 recovery, future/inconsistent→HTTP 489); (5) acquire scan lease
via FOR UPDATE; (6) validate filter schema and evaluator version under held lease; (7) branch by
stage — **DISCOVERY** (one Gmail List API page ≤500 IDs, upsert sources, insert memberships ON
CONFLICT DO NOTHING, persist page token/complete flag) or **FETCH** (FOR UPDATE SKIP LOCKED
item-claim query, claim ≤25 DISCOVERED or eligible RETRY_WAIT items); (8) classify previously
committed items; (9) commit item results, counters, checkpoint, `batch_sequence` advance, and
lease release atomically; (10) publish next continuation using persisted `pending_continuation_*`
fields and CAS `pending_continuation_published_at`; (11) return HTTP 200 only after publication
or terminal confirmation (C76). Item claiming is **FETCH-only** (C73).

Before acquiring a lease (step 5), the worker checks for PAUSED, CANCELLING, and terminal
states (step 3) to avoid wasted work. PAUSED is non-terminal: the scan resumes when
`POST /api/gmail/scan/{id}/resume` is called (C72). Exactly one invocation wins the lease;
others fall through to their own leased items. Expired leases are automatically recoverable on
the next QStash delivery. `state_version` is used for post-lease state transitions (optimistic
locking on status changes after the lease is held); it is NOT used in the lease acquisition
predicate (C25).

**`SchedulerService` interface (C74):** `SchedulerService` exposes only
`enqueueContinuation(continuation: ScanContinuation): Promise<void>`. The `cancelPending`
method has been removed: QStash message IDs are not persisted, so claiming to cancel a pending
message would be a false contract. Cancellation relies entirely on DB state — PAUSED,
CANCELLING, and CANCELLED deliveries are handled as no-ops or terminal cleanup in step 3 of
the worker protocol.

**Continuation sequence coherence (C75):** `email_scan_run` carries a
`CONSTRAINT chk_pending_sequence_matches_scan_sequence CHECK (pending_continuation_sequence IS NULL OR pending_continuation_sequence = batch_sequence)`.
All checkpoint (step 9), resume, and manual retry transactions advance `batch_sequence` before
writing `pending_continuation_sequence`, preserving this invariant. A worker that reads a row
violating this constraint must fail safely (return HTTP 500) rather than proceeding with an
incoherent state.

**`started_at` semantics (C12):** `email_scan_run.started_at` is nullable; it is set only when the
first worker transitions the scan from `CREATED` to `DISCOVERING`. It is never updated thereafter.

**item `CANCELLED` terminal status (C12):** When a scan is cancelled, items in non-terminal states
(`DISCOVERED`, `FETCHING`, `RETRY_WAIT`) are bulk-transitioned to `CANCELLED` via a single UPDATE
in the same transaction as the `CANCELLING → CANCELLED` scan transition. A scan containing any
`CANCELLED` item is itself `CANCELLED` and must not be reported as `COMPLETED` or
`COMPLETED_WITH_ERRORS` (C14).

**`Upstash-Message-Id` and idempotency (C18):** The worker must NOT reject a delivery based on a
previously-seen `Upstash-Message-Id`. Redelivery of the same message is expected at-least-once
semantics. Message IDs may be logged for diagnostics only. All idempotency is enforced via DB state:
item `status`, scan `state_version`, lease tokens, `FOR UPDATE SKIP LOCKED`, and uniqueness
constraints (C18).

**QStash quota recovery (C22):** If QStash publishing fails because the daily quota is exhausted,
QStash cannot schedule its own recovery after quota resets at midnight UTC. The scan is marked
`PAUSED` with a sanitized quota-exhausted message. Manual resume (user action or admin API) is the
approved Phase 1A recovery path. The existing daily Vercel cron may optionally serve as a sweep
that resumes PAUSED scans after quota resets (approved as optional — C22).

**Filter evaluator versioning (C23):** `email_filter_version` carries `rule_schema_version` and
`filter_evaluator_version`. The scan snapshot records both at scan start; they are immutable
after creation. If a worker cannot evaluate the stored versions (e.g., after a future schema
or evaluator upgrade), it must fail safely with `IncompatibleFilterVersionError` rather than
silently treating rules as non-matching (C23).

*(Earlier ADR-15 text used `VERCEL_REGION + Date.now()` as the lease owner. Corrected 2026-07-18:
`crypto.randomUUID()` per `14-phase0-assessment.md §11`.)*

**Rationale:** Extends the existing `SyncJobLock` pattern to the scan layer without a separate
lock table. UUID as owner token is collision-free, not guessable, and carries no platform
metadata. The `state_version` column provides optimistic concurrency for all state transitions.
Configurable TTLs are deliberately below the 60s Vercel limit to ensure lease expiry before the
function itself times out. `FOR UPDATE SKIP LOCKED` prevents contention stalls under concurrent
delivery without a separate lock table or advisory lock.

**Status:** [Planned — pending D-1 approval]. **[Not Implemented]** at assessment date 2026-07-16.

---

*Cross-references:* how these decisions are implemented → `04-architecture.md`; data model
implications → `05-data-model-apis.md`; security consequences → `06-security-authentication.md`;
conflicts with prior docs → `08-implementation-status.md §2`; Phase 0 assessment →
`14-phase0-assessment.md`.
