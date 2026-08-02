# Open Defects

## Schema and data follow-up

### DEF-1 — Five migrations are pending on live Neon

- Severity: High
- Status: Resolved
- Resolved: Proven on `phase1a-test` Neon branch (all 5 applied cleanly — parse-template bridge migrations were no-ops on the already-migrated database; phase1a + LLM drift migrations were additive). Applied to live Neon on 2026-08-02. Live schema is fully up to date with 23 migrations applied.

### DEF-2 — Seven historical duplicate parser-miss rows remain

- Severity: Medium
- Status: Open
- Impact: `ParseLog` has 1,523 raw `unparsed_llm_disabled` rows for 1,516 Gmail messages.
- Workaround: Processing Review returns each Gmail message once and new syncs prevent further duplicates. No live cleanup was performed; remove the seven rows only through a separately approved, targeted migration.

### DEF-3 — Historical paused sync job remains visible

- Severity: Low
- Status: Open
- Impact: A pre-smoke-test paused job at 20/3,386 can still appear in the global sync banner even though later jobs completed successfully.
- Workaround: Dismiss the banner. Resolve or archive the specific job only through a separately approved, non-destructive operational action.

## Phase 1A scan-creation defects (from engineering lead review, 2026-08-02)

### DEF-5 — Non-atomic DB writes in createScanRun — partial-write corruption

- Severity: Critical
- Status: Resolved
- Resolved: Wrapped all 4 DB writes in `prisma.$transaction` in `scanCreateService.ts`. Partial writes are now impossible — any failure rolls back the entire operation atomically.

### DEF-6 — Race condition on idempotency check returns 500 instead of 200

- Severity: Critical
- Status: Resolved
- Resolved: Added `Prisma.PrismaClientKnownRequestError` P2002 catch in `createScanRun`. On a concurrent duplicate, the transaction rolls back cleanly and the handler re-fetches and returns the winning scan run as `created: false`.

### DEF-7 — Invalid date strings accepted — Prisma runtime crash and silent inverted-range scans

- Severity: High
- Status: Resolved
- Resolved: Added `isNaN(date.getTime())` guard and `parsedFrom >= parsedTo` ordering check in `route.ts` before calling `createScanRun`. Both return HTTP 400 with a descriptive error.

### DEF-8 — Gmail token validity not checked at scan creation — stuck scan runs

- Severity: High
- Status: Resolved
- Resolved: `getGmailToken(userId)` is now called in `POST /api/gmail/scan` before creating the scan run. Returns HTTP 422 if the token is unavailable.

### DEF-9 — `gmailQuery` stored and executed verbatim — scope escalation

- Severity: High
- Status: Resolved
- Resolved: Added `gmailQuery.trim()` check to the required-fields validation block in `route.ts`. Blank-after-trim queries return HTTP 400. Full operator-allowlist hardening remains a future production-hardening task (acceptable for single-user MVP).

### DEF-10 — `scanLimit` accepts 0, negative numbers, floats, and NaN

- Severity: Medium
- Status: Resolved
- Resolved: Added `Number.isInteger(scanLimit) && scanLimit > 0` guard in `route.ts`. Invalid values return HTTP 400 with "scanLimit must be a positive integer".

### DEF-11 — `filterName` has no length limit — unbounded text stored and returned

- Severity: Medium
- Status: Resolved
- Resolved: Added `filterName.length > 255` guard in `route.ts`. Values exceeding 255 characters return HTTP 400 with "filterName must be 255 characters or fewer".

## Environment limitation

### DEF-4 — Local runtime cannot use the temporary Unix-socket PostgreSQL database

- Severity: Medium
- Status: Open
- Impact: Prisma migration CLI verification passes locally, but the runtime uses `@prisma/adapter-neon`, which expects a Neon-compatible connection and cannot exercise database-backed HTTP routes against the temporary socket database.
- Workaround: Use a dedicated Neon test branch/project for runtime and browser E2E.

## Phase 1A second-review findings (2026-08-02)

### DEF-12 — Token-unavailable returns 422 not 401 — re-auth interceptors may miss it

- Severity: Medium
- Status: Resolved (by documentation)
- Resolved: Intentional — 422 is semantically correct for an authenticated session with a missing OAuth token. Documented in DECISIONS.md under "Token-unavailable returns 422, not 401". Callers must handle 422 bodies containing `"Gmail token"` to trigger re-authentication.

### DEF-13 — UserEmailFilter grows unboundedly (one row per scan, no deduplication)

- Severity: Low
- Status: Open (accepted for MVP)
- Impact: Each `POST /api/gmail/scan` creates a new `UserEmailFilter` + `EmailFilterVersion` even when `filterName` and `gmailQuery` are identical to prior scans. No unique constraint on `(userId, gmailAccountId, name)`. Rows accumulate indefinitely with no cleanup path.
- Workaround: Acceptable for single-user MVP. See DECISIONS.md — "UserEmailFilter created per-scan". Address before adding a second user or building filter-management UI.
