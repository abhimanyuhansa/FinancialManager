# Open Defects

## Security follow-up

### DEF-1 — Revoke and re-authorize the production Google OAuth grant

- Severity: High
- Status: Owner action required
- Impact: Before the Auth.js logger was hardened, production diagnostic output included OAuth token material. The application no longer logs that data, but previously issued credentials must be treated as exposed.
- Workaround: Revoke the application's Google account access, re-authorize it, and verify that historical deployment-log retention meets the owner's security policy.

### DEF-2 — Historical OpenRouter key revocation is external

- Severity: High
- Status: Owner action required
- Impact: A previously exposed key may remain usable even though OpenRouter is not used by this code.
- Workaround: Revoke the key in the OpenRouter account and do not add a replacement to this application.

## Schema and data follow-up

### DEF-3 — Five migrations are pending on live Neon

- Severity: High
- Status: Open
- Impact: The generated Prisma model is ahead of the live schema. The application currently needs a compatibility omit for two unused Account fields.
- Cause: The pending chain includes parse-template replay migrations with destructive operations, so automated production deployment was rejected.
- Workaround: Review and split the pending chain into an explicitly approved non-destructive production migration. Do not run `migrate deploy` against live Neon as-is.

### DEF-4 — Seven historical duplicate parser-miss rows remain

- Severity: Medium
- Status: Open
- Impact: `ParseLog` has 1,523 raw `unparsed_llm_disabled` rows for 1,516 Gmail messages.
- Workaround: Processing Review returns each Gmail message once and new syncs prevent further duplicates. No live cleanup was performed; remove the seven rows only through a separately approved, targeted migration.

### DEF-5 — Historical paused sync job remains visible

- Severity: Low
- Status: Open
- Impact: A pre-smoke-test paused job at 20/3,386 can still appear in the global sync banner even though later jobs completed successfully.
- Workaround: Dismiss the banner. Resolve or archive the specific job only through a separately approved, non-destructive operational action.

## Environment limitation

### DEF-6 — Local runtime cannot use the temporary Unix-socket PostgreSQL database

- Severity: Medium
- Status: Open
- Impact: Prisma migration CLI verification passes locally, but the runtime uses `@prisma/adapter-neon`, which expects a Neon-compatible connection and cannot exercise database-backed HTTP routes against the temporary socket database.
- Workaround: Use a dedicated Neon test branch/project for runtime and browser E2E.
