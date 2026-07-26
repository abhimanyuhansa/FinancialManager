# Current Status

Updated: 2026-07-26

## What works

- Production is deployed at `https://financial-manager-ebon.vercel.app`.
- The existing Gmail ingestion path is enabled for the interim single-user MVP.
- LLM parsing is disabled unless `LLM_PARSING_ENABLED` is exactly `"true"`.
- Email and statement LLM entry points fail before router, quota, idempotency, provider, or network work when disabled.
- Legacy Gmail ingestion still uses exclusion rules, static parsers, exact-result cache, active deterministic templates, and transaction deduplication.
- Deterministic misses finish as `unparsed_llm_disabled`, create no transaction, record zero body characters sent externally, and appear in Settings → Processing Review with a Gmail source link.
- The first onboarding scan defaults to six months. A selected onboarding period is persisted in `User.syncFromDate`; later scans use the successful watermark with a one-day overlap.
- Cron advancement accepts a server-side Bearer secret only. URL query secrets and `NEXT_PUBLIC_CRON_SECRET` application usage are removed.
- `/api/test/auth-seed` is structurally unavailable in production.
- The legacy EmailFilter screen is clearly labelled as legacy and not part of Gmail parsing.
- Returning Google sign-ins refresh the stored Gmail account tokens without erasing an existing refresh token when Google omits a replacement.
- Processing Review and new parser-miss writes are deduplicated by Gmail message ID.
- Authenticated users can sign out from the desktop sidebar or Settings. Auth.js deletes the database session and redirects to `/login` without revoking Gmail access or deleting user, account, token, transaction, or Gmail data.
- Phase 1A has started with typed scan states and an authoritative progress/completion calculator. It prevents filter-excluded emails from being counted twice, prevents premature 100% display, and treats cancellation as a terminal display without a percentage.
- Phase 1A `GET /api/gmail/scan/{id}` is implemented as a read-only, database-session-protected status endpoint. It scopes the scan lookup by user, reconciles counters from scan items, detects cached-counter drift, and returns 404 for another tenant or an unknown scan.
- Phase 1A provider-independent runtime is implemented on `codex/phase1a-runtime`: idempotent first/incremental scan creation, immutable per-user filters, QStash scheduling and signed worker verification, durable leases/checkpoints/retries, pause/resume/retry/cancel, metadata-only inventory/statistics, manual classification audit history, and tenant-scoped APIs.
- Settings → Email Inventory provides six-month/incremental scan controls, reconciled progress and failures, a versioned filter editor, inventory statistics, and manual financial/non-financial/uncertain classification. Phase 1A does not invoke the parser, create transactions, or call an LLM.
- The isolated Neon branch `phase1a-test` (`br-noisy-tree-at1qvlx6`) is migrated to all 18 migrations. Migration replay preserved 649 transactions, 402 LLM call logs, and 3,463 parse logs, with no schema drift.
- Phase 1A cutover is not active. Production remains on the proven static legacy path until the real QStash/Gmail flow passes.

## How to run

Required interim flags:

```text
LLM_PARSING_ENABLED=false
LEGACY_TRANSACTION_INGESTION_ENABLED=true
```

Then configure the existing database, Auth.js, Google OAuth/Gmail, cron, and statement-encryption variables and run:

```bash
npm install
npx prisma migrate status
npm run dev
```

Do not run the five pending migrations against live Neon or disable legacy ingestion until the Phase 1A external-runtime blockers are resolved and the real flow passes.

## Verification

- `npm run lint` — passed.
- `npm test -- --runInBand` — 40 suites, 288 tests passed; the opt-in real branch smoke is skipped by the normal suite.
- `npx prisma validate` and `npx prisma generate` — passed.
- All 18 migrations applied and reported up to date on an isolated PostgreSQL 17 database.
- Read-only live `npx prisma migrate status` — 18 known migrations, 5 pending. No live migration was applied because the pending chain contains destructive replay operations.
- `npm run build` — passed.
- Production application startup — passed.
- `/api/health` — HTTP 200.
- Production `/api/test/auth-seed` with its enable flag set — HTTP 404.
- `/api/gmail/sync/advance?secret=...` — HTTP 401.
- Focused static-only API and domain tests — passed.
- Production flags were explicitly set to `LLM_PARSING_ENABLED=false` and `LEGACY_TRANSACTION_INGESTION_ENABLED=true`.
- Six-month Gmail smoke test — 3,369/3,369 messages processed, 642 new transactions, 0 skipped, 0 encrypted-blocked.
- Transactions increased from 7 to 649; all 649 Gmail source IDs are distinct.
- `LlmCallLog` remained at 402 before and after every scan: zero new LLM calls.
- Processing Review contains 1,516 distinct deterministic misses. Seven historical duplicate rows were created by the first incremental run before the deduplication fix; the deployed API displays each message once.
- Two post-baseline incremental scans each processed 20/20 messages, created 0 transactions, and left the transaction and LLM counts unchanged.
- The final incremental scan added no parser-miss rows and advanced `gmailSyncedAt` exactly to its `startedAt` (`2026-07-26T15:10:51.282Z`).
- Sign-out interaction test — passed; concurrent clicks produce one Auth.js request with redirect target `/login`.
- Production sign-out — owner verified: redirect to `/login` and protected pages require authentication again.
- Phase 1A progress tests — passed for evaluated/excluded overlap, incomplete-item completion guard, and cancellation display.
- Phase 1A status-service/API tests — passed for tenant scoping, item reconciliation, cache matching, unauthenticated rejection, tenant-safe 404, and successful status response.
- Phase 1A tests — passed for filter precedence/schema validation, deterministic QStash deduplication keys, incremental watermark overlap, worker rejection before database access when unsigned, and tenant-scoped inventory reads.
- `npm audit --omit=dev --audit-level=critical` — zero vulnerabilities.
- Isolated Neon `npx prisma migrate status` — all 18 migrations applied and schema up to date.
- Application startup on the isolated Neon branch — passed at `http://localhost:3000`.
- Real branch smoke reached the actual OAuth/Gmail boundary. One copied grant could not refresh (HTTP 400); the other token could authenticate but Gmail message listing returned HTTP 403. No email metadata, classification, transaction, or LLM rows were created by the blocked run. Branch counts remain 649 transactions and 402 LLM calls.

## Next task

Complete Google consent in the open localhost OAuth flow and provision the three QStash runtime credentials. Then rerun `tests/integration/phase1a-branch.test.ts`, deploy a branch-backed preview, demonstrate the complete UI flow, and only after that approve the live migration and set `LEGACY_TRANSACTION_INGESTION_ENABLED=false`.
