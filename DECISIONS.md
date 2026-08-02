# Decisions

## 2026-07-26 — Interim Gmail MVP

- The authoritative owner decisions supplied on 2026-07-26 supersede the earlier Phase 1A-first delivery order.
- `LLM_PARSING_ENABLED` is fail-closed: only the exact string `"true"` enables an LLM.
- Legacy ingestion remains enabled when its flag is unset during the interim MVP. Explicit `"false"` performs the later cutover; malformed values disable it.
- A deterministic parser miss is a completed processing outcome named `unparsed_llm_disabled`. It is stored in `ParseLog`, creates no transaction, and is not retried.
- Existing `ParseLog` storage is reused for the interim processing-review surface; no schema change is needed.
- Only ACTIVE deterministic templates may create transactions while LLM parsing is disabled. SHADOW and DEGRADED templates remain non-authoritative.
- Cron authentication is Bearer-header only. Secrets in URLs and browser bundles are prohibited.
- The test-auth seed route always returns 404 in production, regardless of environment flags.
- The legacy EmailFilter UI remains temporarily available but is explicitly labelled as non-operative for parsing.

## 2026-07-26 — Production smoke-test compatibility

- The live Neon database is not reset, cleaned, seeded, rolled back, or migrated during the smoke test.
- Until the pending Phase 1A account migration is approved, Prisma globally omits the two unused nullable Account fields that do not exist in live Neon.
- A returning Google OAuth sign-in persists newly issued access-token metadata and preserves the existing refresh token when Google does not return another one.
- Auth logging records only safe error classifications. OAuth account objects, tokens, email addresses, and stack dumps are prohibited.
- Parser misses are unique operationally by user, outcome, and Gmail message ID. New writes filter existing misses, and Processing Review returns one row per Gmail message even where historical duplicates exist.
- The successful sync job `startedAt` is the Gmail watermark. Incremental scans retain the existing one-day overlap and rely on transaction and review deduplication.

## 2026-08-02 — Phase 1A scan-creation API contracts

### Token-unavailable returns 422, not 401

`POST /api/gmail/scan` returns HTTP 422 (not 401) when `getGmailToken` returns null.

**Rationale:** The session is already authenticated (the Auth.js session check returned a valid session). The failure is that the Gmail OAuth token for that authenticated session is absent or revoked. 401 means "you are not authenticated"; 422 means "your request is structurally valid but the server cannot process it in its current state." 422 is semantically correct here.

**Impact on callers:** Any client that intercepts 401 to trigger a re-auth redirect must also handle 422 responses whose body contains `"Gmail token"` to trigger the same flow. The `/api/gmail/sync/start` route uses the same 422 pattern.

### UserEmailFilter created per-scan (Phase 1A MVP)

Each call to `createScanRun` creates a new `UserEmailFilter` + `EmailFilterVersion` row, even when the caller supplies the same `filterName` and `gmailQuery` as a previous scan.

**Rationale:** Phase 1A is a single-user MVP. Filter management (edit, list, deactivate, version) is a post-MVP concern. Creating a per-scan filter keeps the creation path simple and atomic. The schema supports reusable filters (versioned chain, `isActive`, `currentVersionId`); this design defers that behaviour rather than preventing it.

**Constraint:** `version: 1` is hardcoded in `EmailFilterVersion`. If filters are ever made reusable, a migration will be needed to populate `supersedesVersionId` and the create path must query `MAX(version)` before inserting.

**Cleanup:** A future migration may consolidate duplicate filter rows (same `userId` + `gmailQuery`) once filter management is implemented. Tracked as DEF-13.
