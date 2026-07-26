# Current Status

Updated: 2026-07-26

## What works

- The existing Gmail ingestion path is enabled for the interim single-user MVP.
- LLM parsing is disabled unless `LLM_PARSING_ENABLED` is exactly `"true"`.
- Email and statement LLM entry points fail before router, quota, idempotency, provider, or network work when disabled.
- Legacy Gmail ingestion still uses exclusion rules, static parsers, exact-result cache, active deterministic templates, and transaction deduplication.
- Deterministic misses finish as `unparsed_llm_disabled`, create no transaction, record zero body characters sent externally, and appear in Settings → Processing Review with a Gmail source link.
- The first onboarding scan defaults to six months. A selected onboarding period is persisted in `User.syncFromDate`; later scans use the successful watermark with a one-day overlap.
- Cron advancement accepts a server-side Bearer secret only. URL query secrets and `NEXT_PUBLIC_CRON_SECRET` application usage are removed.
- `/api/test/auth-seed` is structurally unavailable in production.
- The legacy EmailFilter screen is clearly labelled as legacy and not part of Gmail parsing.

## How to run

Required interim flags:

```text
LLM_PARSING_ENABLED=false
LEGACY_TRANSACTION_INGESTION_ENABLED=true
```

Then configure the existing database, Auth.js, Google OAuth/Gmail, cron, and statement-encryption variables and run:

```bash
npm install
npx prisma migrate deploy
npm run dev
```

## Verification

- `npm run lint` — passed.
- `npm test -- --runInBand` — 32 suites, 267 tests passed.
- `npx prisma validate` and `npx prisma generate` — passed.
- All 18 migrations applied and reported up to date on an isolated PostgreSQL 17 database.
- `npm run build` — passed.
- Production application startup — passed.
- `/api/health` — HTTP 200.
- Production `/api/test/auth-seed` with its enable flag set — HTTP 404.
- `/api/gmail/sync/advance?secret=...` — HTTP 401.
- Focused static-only API and domain tests — passed.

## Next task

Complete the current Gmail slice with the owner-approved production smoke test using the existing live Neon database and Google OAuth configuration. Confirm:

1. Static-parser transactions are created and deduplicated.
2. Provider call count remains zero.
3. Deterministic misses complete once and appear in Processing Review.
4. The successful watermark drives the next incremental scan.

Do not start the broader review/classification slice until this real flow passes.
