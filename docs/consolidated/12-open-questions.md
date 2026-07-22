# 12 — Open Questions

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Phase 0 revision 2026-07-19:** D-5 updated: `email_filter_rule` replaced by `email_filter`/
> `email_filter_version` two-table design (Q1–Q4 + C1–C8). Decision outcomes recorded:
> D-1: **Pending** — final consolidation approval after C1–C33 corrections applied. D-2: **Approved** — QStash
> for background scan progression. D-3: **Approved** — no body storage in Phase 1A; Gmail
> re-fetch only. D-4: **Conditionally approved** — feature flags (`LLM_PARSING_ENABLED`,
> `LEGACY_TRANSACTION_INGESTION_ENABLED`) and legacy-path shutdown. D-5: **Approved** — defer
> remaining SYSTEM_GLOBAL migration. D-6: **Approved** — remove `?secret=` query param; QStash
> signature verification only for scan worker endpoint.
> **Phase 0 revision 2026-07-19 pass 4 (C9–C13):** D-6 text corrected: QStash authentication
> for scan worker uses `@upstash/qstash` `Receiver` class JWT verification (C9; not manual HMAC).
> **Phase 0 revision 2026-07-19 pass 5 (C14–C23):**
> D-1: Status unchanged — **PENDING**; awaiting final consolidation approval after C1–C33 corrections.
> D-6: Text corrected further — non-retryable response is HTTP 489 + `Upstash-NonRetryable-Error: true`
>   (C17); `Receiver.verify()` requires `url` parameter (C17); `Upstash-Retries` publish header
>   (C17, replaces `Upstash-Retry-Count`); failure callback uses `Receiver` JWT (C17).
> C16: Rule-draft CRUD not in Phase 1A — filter API renamed to `/api/email-filters` hierarchy
>   (no open question; resolved by schema design).
> C22: Quota recovery — no automatic midnight recovery; manual resume is approved; optional Vercel
>   cron sweeper (approved as optional). Phase 1A behavior documented in D-2.
> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C33: D-1 status updated from "pending after C1–C8" to "pending after C1–C23 final consolidation".
> **Phase 0 revision 2026-07-19 pass 7 (C34–C39):**
> C39: D-1 status updated to "pending final consolidation approval"; C1–C33 applied (not C1–C23);
>   D-1–D-6 statuses: D-1 Pending, D-2 Approved, D-3 Approved, D-4 Conditionally approved,
>   D-5 Approved, D-6 Approved.
> **Pass 3 corrections:** 2026-07-14 — OQ-11 added (`User.syncFromDate` never written).

> Items that cannot be resolved by reading the code — they require a PM or owner decision.
> Each entry: question, context, why it matters, and suggested owner.

---

## OQ-1 — Is `NEXT_PUBLIC_CRON_SECRET` intentionally separate from `CRON_SECRET` in production?

**Context:** `src/app/(app)/settings/page.tsx:1405` reads `process.env.NEXT_PUBLIC_CRON_SECRET`.
Any `NEXT_PUBLIC_*` variable is inlined into the browser bundle at build time. If this
variable is set to the same value as `CRON_SECRET` in the Vercel deployment config, the
cron secret ships to every browser client (FINDING-3 in `06`).

**Why it matters:** If equal to `CRON_SECRET`, any user with devtools can extract the secret
and trigger sync advance calls arbitrarily. If set to a different / empty value, the
settings UI button that relies on it may silently not work.

**Decision needed:** Define the intended prod value of `NEXT_PUBLIC_CRON_SECRET`. Is it a
separate low-privilege client token, empty, or the same as `CRON_SECRET`? If the settings
UI "advance" button should work in prod, a different client-safe mechanism (server action
behind session auth) should replace the current pattern.

**Owner:** PM / deploy configuration owner.

---

## OQ-2 — OpenRouter key rotation

**Context:** Memory files note a previously compromised OpenRouter API key. The current
codebase at baseline commit does not use OpenRouter — both LLM providers (`gemini.ts`,
`openai.ts`) call their APIs directly. However, the compromised key may still be active on
the OpenRouter account.

**Why it matters:** An active compromised key could be used for unauthorized API calls,
potentially incurring costs on the account.

**Decision needed:** Confirm whether the OpenRouter key has been revoked on the OpenRouter
account. If not, revoke it. This is an operational action (not a code change).

**Owner:** Account owner.

---

## OQ-3 — `EmailFilter` retirement

**Context:** The `EmailFilter` model, `/api/settings/filters` API, and the "Filters" tab in
the Settings UI are all active. However, `EmailFilter` was removed from the parse pipeline
— it no longer pre-screens emails before they reach the parser. The UI implies it does
something in the parse flow; it does not. It is a legacy settings-only feature.

**Why it matters:** Future developers and operators reading the Settings UI will assume the
filter actively affects which emails get parsed. This is misleading (documented as
[Partial / misleading] in `08 §1.3`). Removing the code entirely would eliminate the
confusion.

**Decision needed:** Keep `EmailFilter` as a legacy settings feature indefinitely (documented
as inert), or remove the model, API, and UI tab entirely?

**Owner:** PM / feature owner.

---

## OQ-4 — Reconciliation UX wiring

**Context:** `ReconciliationLog`, `/api/gmail/reconcile`, and `src/lib/reconcile.ts` are all
implemented (per `08 §1.3`). However, no E2E test covers reconciliation results surfacing to
the user, and the UI wiring depth has not been verified in Pass 1 or Pass 2.

**Why it matters:** If reconciliation results are not surfaced anywhere in the UI, the
backend implementation is invisible to users. It's also unclear how a user is supposed to
trigger reconciliation or view mismatches.

**Decision needed:** Where should reconciliation results surface in the UI? Is there a
reconciliation view, or does it surface inline in the transactions view? Is this a V1
feature or deferred?

**Owner:** PM / UX owner.

---

## OQ-5 — Review workflow UI surface

**Context:** `Transaction.reviewed` and `Transaction.needsReview` fields exist in the
schema. No E2E test covers a "needs review" transaction surface, and the UI handling of
these fields is unverified.

**Why it matters:** If transactions flagged `needsReview=true` are not surfaced in the UI,
users have no way to act on them. The LLM may flag low-confidence extractions as needing
review, but users would never see them.

**Decision needed:** Where in the transactions UI should `needsReview` transactions appear?
Filter, badge, separate tab? Is this a V1 feature or deferred?

**Owner:** PM / UX owner.

---

## OQ-6 — PDF password use in parsing: V1 goal or deferred?

**Context:** Statement password storage is implemented (AES-256-GCM encryption, per-record
IV). However, `decrypt()` is never called in the parse path — `gmail.ts:27` calls
`pdfParse(buffer)` with no password option. Password-protected PDFs will silently fail to
extract any transactions (REL-5 in `10`).

**Why it matters:** Users who save statement passwords in the Settings UI expect them to be
used when parsing password-protected bank statement PDFs. Currently they are not, with no
error surfaced.

**Decision needed:** Is parsing password-protected PDFs a V1 goal? If yes, the `decrypt()`
call needs to be wired into `gmail.ts`. If deferred, the Settings UI should indicate that
password-protected PDF parsing is coming in a future version, not silently failing.

**Owner:** PM / feature owner.

---

## OQ-7 — `buildGmailQuery()` legacy fallback removal

**Context:** `src/lib/gmailQuery.ts` contains both:
- `buildGmailQueryFromDB()` — the active implementation that reads `GmailQueryKeyword` from
  the database.
- `buildGmailQuery()` — a static legacy fallback with a migration comment marking it for
  eventual removal.

The legacy function is still present in the codebase at baseline commit.

**Why it matters:** Dead code increases maintenance surface. If the DB-based query builder
has been stable and correct, the legacy fallback can be safely removed.

**Decision needed:** Has the DB-based query builder been sufficiently validated? If yes,
remove `buildGmailQuery()`. If the legacy path is still a safety net, document why.

**Owner:** Engineering.

---

## OQ-8 — `reconcile/route.ts` Gemini model alias

**Context:** `src/app/api/gmail/reconcile/route.ts` calls Gemini directly using the
deprecated `gemini-flash-latest` model alias (per `10-risks-tech-debt.md` TD-3). The rest
of the LLM stack uses the dual-provider router (`src/lib/llm/router.ts`) with
`gemini-3.1-flash-lite`.

**Why it matters:** Google deprecated `gemini-flash-latest`; API calls to this alias may
fail or be silently routed to an unexpected model version. Reconciliation is already
[Partial] per `08 §1.3`.

**Decision needed:** Should the reconcile route be updated to use the LLM subsystem router
(which would give it circuit-breaker, quota, and idempotency protection), or should it
continue with a direct Gemini call (simpler, but outside the reliability infrastructure)?
Either way, the deprecated model alias must be replaced with `gemini-3.1-flash-lite`.

**Owner:** Engineering.

---

## OQ-9 — Test coverage threshold enforcement

**Context:** `jest.config.ts` uses `--passWithNoTests`; no `coverageThreshold` is
configured. CI (if any is running) will pass even if the codebase has 0% unit test
coverage. The 5 gap modules (`staticParser`, `vpaLookup`, `merchantMaster`, `gmailQuery`,
`categoryIcons`) have no tests.

**Why it matters:** Without a floor, test coverage can regress silently as the codebase
grows. The gap modules include tier-0 parse logic (HIGH risk per `09 §5`).

**Decision needed:** Should a minimum coverage threshold be enforced in Jest config and/or
CI? If yes, what floor is appropriate given the current ~70% estimate?

**Owner:** Engineering / QA.

---

## OQ-10 — SYSTEM_GLOBAL model isolation: intentional for POC?

**Context:** Five models — `GmailQueryKeyword`, `ExclusionRule`, `MerchantMaster`,
`SubCategoryMaster`, and `EmailFilter` — have no `userId` field. Any authenticated user
can add, modify, or delete these shared records, affecting all users (documented in
`06 §1.5`, `08` row 22).

**Why it matters:** At 2–10 users with a single admin, this is acceptable. If user count
grows or if non-admin users are added, one user's exclusion rules, Gmail query keywords,
or merchant mappings will silently affect all other users' syncs and categorizations.

**Decision needed:** Is the SYSTEM_GLOBAL design intentional for the POC scope? If this
product is ever opened to untrusted multi-user access, these models need `userId` fields or
a separate admin-only mutation path.

**Owner:** PM / architect.

---

*Cross-references:* security findings → `06-security-authentication.md §5`; partial
implementations → `08-implementation-status.md §1.3`; risk register → `10-risks-tech-debt.md`;
test gaps → `09-testing-quality.md §5`.

---

## OQ-11 — `User.syncFromDate`: intentionally unwritten, or missing write path?

**Context:** `User.syncFromDate` exists in `prisma/schema.prisma` and is **read** by
`sync/start/route.ts:47` as a fallback default (`fromDate = user?.syncFromDate ?? sixMonthsAgo`).
However, **no route ever writes this field** — it is never set by the onboarding flow,
the sync start API, or any settings API. The `PATCH /api/user/info` route described in
earlier docs does not exist. The period a user picks during onboarding affects the current
job's `fromDate` but is not persisted back to `User.syncFromDate`. **[Confirmed — F-02]**
— `sync/start/route.ts:32,47`; no write route found at baseline commit.

**Why it matters:** If `syncFromDate` is intended to be user-configurable (e.g., "always
sync from this date forward"), the field is currently schema debt — present but inert. If a
future onboarding flow or settings UI is supposed to set it, the write path is missing.
Documented in `02 FR-A2` as [Partial — schema field exists; no write path] and `08` row 25.

**Decision needed:** Is `User.syncFromDate` intended to be user-settable (in which case a
write path is needed via onboarding or settings)? Or is it intended as a manual DB override
only (in which case the field should be documented as admin-only)? Or should the field be
removed since `sixMonthsAgo` is the effective default in all cases?

**Owner:** PM / Engineering.

---

## Phase 1A Blocking Decisions (D-1 through D-6) — added 2026-07-16

These 6 decisions were identified during the Phase 0 architecture audit (see `14-phase0-assessment.md §12`).
Decision outcomes recorded 2026-07-19: D-1 pending final consolidation approval; D-2 Approved; D-3 Approved; D-4 Conditionally approved; D-5 Approved; D-6 Approved
(see `14-phase0-assessment.md §5` for full decision text and rationale). C1–C33 applied.
**Phase 1A implementation remains blocked on D-1 final consolidation approval.**

---

## D-1 — New `email_scan_run` table vs. extending `SyncJob`

**Status: PENDING — awaiting final consolidation approval. C1–C33 applied.**

**Context:** Phase 1A needs a scan session record. Option A: create a new `email_scan_run`
table. Option B: add new columns to the existing `SyncJob` table.

**Why it matters:** Option B requires altering an existing production table and risks
migrating in-flight sync jobs. Option A is purely additive with no rollback risk.

**Recommendation:** New table alongside (Option A). See ADR-14 in `07`.

**Owner:** Architect / PM.

---

## D-2 — Client polling vs. external cron for scan tick progression

**Status: APPROVED — QStash (Upstash) for background scan progression; browser polling retained for status display only.**

**Context:** The scan tick (`/api/gmail/scan/worker`) must be called repeatedly to progress a
scan. On Vercel Hobby, the daily cron fires once and stops. QStash provides at-least-once
delivery with configurable retry, enabling background scan completion without an open browser.

**Why it matters:** Without repeated advancement, large inbox scans (10k+ emails) may take
days to complete if the user only opens the app occasionally.

**Decision:** QStash for Phase 1A. Browser polls a read-only status endpoint for display;
closing the browser does not stop the scan. External cron via GitHub Actions / cron-job.org
is a Phase 2 upgrade path if QStash free tier proves insufficient.

**QStash quota recovery (C22):** If daily quota is exhausted, the scan is marked `PAUSED` with
a sanitized quota-exhausted message. QStash cannot schedule its own recovery after midnight UTC
reset — there is no automatic recovery. Manual resume (user action or admin API) is the approved
Phase 1A recovery path. The existing daily Vercel cron may optionally be used as a sweep that
resumes PAUSED scans after quota resets — this is approved as optional.

**Owner:** PM (UX expectation) / Architect (implementation).

---

## D-3 — `body_hash` only vs. encrypted body snapshot in `email_source`

**Status: APPROVED — no body storage in Phase 1A. Gmail re-fetch for any reprocessing.**

**Context:** `email_source` could store: (a) nothing — bodies are always fetched transiently;
(b) a SHA-256 hash of the body — enables dedup without storage; (c) an AES-256-GCM encrypted
body — enables offline reprocessing without Gmail re-fetch.

**Why it matters:** Option (c) stores PII at rest. Option (a) requires re-fetching from Gmail
for every parse attempt. Option (b) is a data-minimization middle ground.

**Decision:** Phase 1A stores metadata only (subject, sender, received date, has_attachment,
filter_decision). No body and no body hash by default. Source idempotency key:
`(user_id, gmail_account_id, gmail_message_id)`. Reproducibility limitation: if an email is
deleted from Gmail or authorization is revoked, deterministic re-parsing is not possible —
accepted limitation for Phase 1A. Encrypted body snapshot deferred to Phase 1C if regression
testing requires it.

**Owner:** PM (data policy) / Architect.

---

## D-4 — Set `LLM_PARSING_ENABLED=false` in Vercel environment

**Status: CONDITIONALLY APPROVED — feature flags and legacy-path shutdown required before Phase 1A ships.**

**Context:** Two flags are required: `LLM_PARSING_ENABLED=false` (prevents AI provider calls
only) and `LEGACY_TRANSACTION_INGESTION_ENABLED=false` (disables the complete legacy
transaction-ingestion path — no SyncJob creation, no fetching, no parsing, no ParseLog, no
transaction insert). Both must be server-only (`NEXT_PUBLIC_*` is prohibited). Safe default
for any missing or malformed value: disabled.

**Why it matters:** The transition window between old route and new route needs both flags
explicitly set. The Vercel environment change must be made **before** Phase 1A code deploys.

**Decision:** Create both flags as the absolute first code change in Phase 1A. LLM=0
regression test must pass before any Phase 1A code ships. Confirm string `"false"`, not
empty/unset. Do not make the Vercel env change during Phase 0 revision.

**Owner:** Deploy configuration owner / PM approval.

---

## D-5 — Scope of SYSTEM_GLOBAL migration in Phase 1A

**Status: APPROVED — defer remaining SYSTEM_GLOBAL migration. EmailFilter deprecated in Phase 1A.**

**Context:** OQ-10 above asks whether the 5 SYSTEM_GLOBAL models (`GmailQueryKeyword`,
`ExclusionRule`, `MerchantMaster`, `SubCategoryMaster`, `EmailFilter`) should remain shared
or be migrated to per-user isolation. Phase 1A introduces `email_filter`/`email_filter_version`
as the per-user filter design replacing `EmailFilter`. Should the other 4 SYSTEM_GLOBAL models
be migrated in Phase 1A, Phase 2, or never?

**Why it matters:** Migrating SYSTEM_GLOBAL models requires altering existing tables and
migrating existing data — not additive-only. This is a higher-risk migration than the new
Phase 1A tables.

**Decision:** Leave `GmailQueryKeyword`, `ExclusionRule`, `MerchantMaster`, `SubCategoryMaster`
unchanged. Mark legacy `EmailFilter` settings UI as deprecated in Phase 1A — do not claim
replacement is complete until migration, cutover, legacy UI removal, and legacy API removal
are done. SYSTEM_GLOBAL migration for the other 4 is a separate scoped decision for a future
phase.

**Owner:** PM / Architect.

---

## D-6 — Remove `?secret=` query param from `advance/route.ts` (SEC-2)

**Status: APPROVED — remove query-param secret path; enforce QStash signature verification for scan worker endpoint.**

**Context:** `advance/route.ts` currently accepts the cron secret as both a query parameter
(`?secret=<CRON_SECRET>`) and a Bearer header. The query parameter path leaks the secret to
server access logs. This is a HIGH severity security finding (SEC-2 in `06` and `10`).

**Why it matters:** Server logs on Vercel are visible to anyone with dashboard access. A
leaked `CRON_SECRET` allows arbitrary cron advance calls. The fix is 2 lines of code.

**Decision:** Remove `querySecret` path from `advance/route.ts`. Accept `Authorization: Bearer`
only for legacy advance. New `/api/gmail/scan/worker` endpoint uses QStash JWT signature
verification via the official `@upstash/qstash` `Receiver` class only (not session auth, not Bearer;
C9 — manual HMAC is NOT used). `receiver.verify({ signature, body, url, clockTolerance })` —
the `url` parameter is required for JWT `sub` claim validation (C17). Non-retryable responses
return HTTP 489 + `Upstash-NonRetryable-Error: true` (C17); publish retry config uses
`Upstash-Retries` header (C17, not `Upstash-Retry-Count`). Failure callback also uses
`Receiver` JWT — no separate HMAC secret (C17). No secrets in URLs, browser bundles,
application logs, proxy logs, access logs, or DB error records. Do not modify the existing
route during Phase 0 revision; implement in Phase 1A as a companion change to the feature flag work.

**Owner:** Engineering (low effort) / PM approval for any deploy.
