# 12 — Open Questions

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
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
