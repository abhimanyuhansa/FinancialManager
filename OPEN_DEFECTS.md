# Open Defects

## Release blockers

### DEF-1 — Real Gmail static-only flow not yet demonstrated

- Severity: High
- Status: Open
- Impact: The implementation and focused tests pass, but the required six-month Gmail-to-transactions run has not been executed against real Gmail and Neon.
- Cause: The updated commit has not yet been deployed and exercised through the owner-approved live smoke test.
- Workaround: Deploy only after local gates and migration status pass, then run the bounded manual flow without cleanup or synthetic data operations.

### DEF-2 — Required production feature flags are not confirmed

- Severity: High
- Status: Open
- Impact: Repository behavior is safe for LLM calls, but the deployed environment has not been inspected or changed.
- Workaround: Before deployment, set `LLM_PARSING_ENABLED=false`, set `LEGACY_TRANSACTION_INGESTION_ENABLED=true`, and unset `NEXT_PUBLIC_CRON_SECRET`.

## Security follow-up

### DEF-3 — Historical OpenRouter key revocation is external

- Severity: High
- Status: Owner action required
- Impact: A previously exposed key may remain usable even though OpenRouter is not used by this code.
- Workaround: Revoke the key in the OpenRouter account and do not add a replacement to this application.

## Environment limitation

### DEF-4 — Local runtime cannot use the temporary Unix-socket PostgreSQL database

- Severity: Medium
- Status: Open
- Impact: Prisma migration CLI verification passes locally, but the runtime uses `@prisma/adapter-neon`, which expects a Neon-compatible connection and cannot exercise database-backed HTTP routes against the temporary socket database.
- Workaround: Use a dedicated Neon test branch/project for runtime and browser E2E.
