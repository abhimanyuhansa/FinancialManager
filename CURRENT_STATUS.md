# Current Status

Updated: 2026-08-02

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
- All 5 pending migrations (parse-template bridge + Phase 1A scan schema + LLM drift reconciliation) have been applied to live Neon. Live schema is fully up to date.
- Phase 1A `POST /api/gmail/scan` is implemented as a protected idempotent scan-creation endpoint. It creates a `UserEmailFilter` + `EmailFilterVersion` + `EmailScanRun` and returns 201 on creation or 200 on a duplicate `clientRequestId`.
- Phase 1A scan-creation hardened after second engineering lead review: malformed JSON body returns 400, `clientRequestId` capped at 500 chars, unknown persisted status returns 409 instead of 500, `scanLimit` validated before DB calls, `toDate` bounded to 10 years from today, 422/401 token-failure contract documented in DECISIONS.md.

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

## Verification

- `npm run lint` — passed.
- `npm test -- --runInBand` — 39 suites, 314 tests passed.
- `npx prisma validate` and `npx prisma generate` — passed.
- All 23 migrations applied and reported up to date on live Neon.
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
- Processing Review contains 1,516 distinct deterministic misses.
- Sign-out interaction test — passed.
- Phase 1A progress tests — passed.
- Phase 1A status-service/API tests — passed.
- Phase 1A scan-creation service tests — 8 tests passed (transaction, idempotency, P2002 race, filter/version/run creation, date and limit propagation).
- Phase 1A `POST /api/gmail/scan` API tests — 25 tests passed (401, 400 validation ×13, 422 no-account, 422 no-token, 201 create, 200 idempotent, date parsing, 409 unknown status).

## Next task

Implement the scan advance worker: pick up `CREATED` scans, transition to `DISCOVERING`, page through the Gmail API results using `effectiveGmailQuery`, and write `EmailSource` + `EmailScanItem` rows per discovered message.
