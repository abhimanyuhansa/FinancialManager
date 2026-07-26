# Open Defects

## Schema and data follow-up

### DEF-1 — Five migrations are pending on live Neon

- Severity: High
- Status: Open
- Impact: Production cannot run the Phase 1A runtime schema yet.
- Evidence: The exact five-migration chain passed on the production-derived `phase1a-test` Neon branch. All 18 migrations are up to date, Prisma reports no schema drift, and the existing 649 transactions, 402 LLM call logs, and 3,463 parse logs were preserved.
- Workaround: Keep the deployed legacy path enabled. Apply to live only after the real QStash/Gmail branch flow passes and the production migration is explicitly approved.

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

## Phase 1A external blockers

### DEF-4 — QStash runtime credentials are unavailable

- Severity: High
- Status: Open
- Impact: The signed background worker cannot be scheduled or deployed end to end. `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY` are absent locally.
- Workaround: Provision QStash and configure those server-only values for the branch-backed deployment. Never expose them through `NEXT_PUBLIC_*`, URLs, logs, or browser code.

### DEF-5 — Copied Google grants cannot complete the branch Gmail scan

- Severity: High
- Status: Open
- Impact: The real Phase 1A scan cannot pass Gmail discovery. One copied account fails refresh with HTTP 400; the other reaches Gmail but message listing returns HTTP 403.
- Workaround: Complete the pending localhost Google OAuth consent flow with `gmail.readonly`, then rerun the opt-in branch smoke. No secret values were inspected or printed.

### DEF-6 — Phase 1A production cutover is not yet proven

- Severity: High
- Status: Open
- Impact: Production must continue using `LEGACY_TRANSACTION_INGESTION_ENABLED=true`; the new runtime is not deployed and the real Gmail/QStash/UI flow is incomplete.
- Workaround: Resolve DEF-4 and DEF-5, pass the branch smoke and preview UI demonstration, then apply the proven live migration and explicitly cut over.
