# Open Defects

## Schema and data follow-up

### DEF-1 — Five migrations are pending on live Neon

- Severity: High
- Status: Open
- Impact: The generated Prisma model is ahead of the live schema. The application currently needs a compatibility omit for two unused Account fields.
- Cause: The three parse-template bridge migrations contain guarded `DROP` operations for an empty clean-replay bootstrap. The SQL audit indicates they are no-ops on a valid already-migrated database, but this has not yet been proven against an isolated clone of the current live schema and data.
- Workaround: Replay and fingerprint the exact five-migration chain on an isolated production-like Neon branch. Do not run `migrate deploy` against live Neon until the result is reviewed and explicitly approved.

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

## Environment limitation

### DEF-4 — Local runtime cannot use the temporary Unix-socket PostgreSQL database

- Severity: Medium
- Status: Open
- Impact: Prisma migration CLI verification passes locally, but the runtime uses `@prisma/adapter-neon`, which expects a Neon-compatible connection and cannot exercise database-backed HTTP routes against the temporary socket database.
- Workaround: Use a dedicated Neon test branch/project for runtime and browser E2E.
