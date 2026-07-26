# 11 — Operations & Deployment

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Phase 0 revision 2026-07-19:** §9.3 migration comment corrected: `email_filter` (not
> `email_filter_rule`) as the logical filter table name per Q3 decision.
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Pass 3 corrections:** 2026-07-14 — §1 Vercel single-instance tagged [Unverified];
> §5 E2E startup instructions corrected (webServer auto-starts); advance button dev-only
> caveat added (F-10, F-11).
> **Pass 4 corrections:** 2026-07-15 — §5 `npm run build` restored as E2E prerequisite;
> webServer comment clarified (runs `next start`, not `next build`) (G-04).
> **Pass 5 corrections:** 2026-07-15 — §8 constraints table `E2E tests auto-start server` row
> corrected to remove internal contradiction with §5 (npm run build IS required). H-06.

> Operational runbook for the Financial Manager application. Sources: `vercel.json`,
> `next.config.ts`, `prisma.config.ts`, `package.json`, `.env.local` (not tracked),
> and code inspection at baseline commit.

---

## 1. Deploy target

| Property | Value |
|----------|-------|
| Platform | **Vercel Hobby** |
| Runtime | Node.js (Next.js 16.2.12 App Router) |
| Region | Vercel default (single region) **[Unverified — External Platform Configuration]** |
| Instance count | **1** (Hobby plan; no horizontal scaling) **[Unverified — External Platform Configuration]** — Vercel Hobby is documented by Vercel as single-instance and single-region, but this is a platform-level constraint not specified in `vercel.json`. |
| Build command | `npx prisma generate && next build` |
| Output | Standard Next.js `.next/` build |

**`vercel.json` excerpt:**
```json
{
  "buildCommand": "npx prisma generate && next build",
  "functions": {
    "src/app/api/gmail/sync/advance/route.ts": { "maxDuration": 60 }
  }
}
```

`npx prisma generate` runs first because the Prisma Client must be generated from
`prisma/schema.prisma` before the Next.js build can compile routes that import it.
**[Confirmed]** — `vercel.json`.

---

## 2. Cron configuration

| Property | Value |
|----------|-------|
| Schedule | `0 2 * * *` (daily at 02:00 UTC) |
| Target | GET `/api/gmail/sync/advance` |
| Auth | `Authorization: Bearer <CRON_SECRET>` |
| Max duration | 60s (hard-enforced by Vercel) |
| Purpose | **Advances pending sync jobs** — does NOT start new jobs |

**Important:** The daily cron is a keep-alive / recovery mechanism. It advances any job
that was left pending (e.g., user closed browser mid-sync). Users must manually trigger new
syncs via the UI. Client-side polling in the sync UI is the primary advance driver during
an active session. **[Confirmed]** — `vercel.json`; `advance/route.ts` (GET handler, no
job-creation logic).

**Security note:** The advance route also accepts `?secret=<CRON_SECRET>` as a query
parameter (FINDING-2 in `06`). This is a security risk; the header-only path should be
used exclusively.

---

## 3. Environment variables

23 environment variables. Required ones must be set in Vercel's Environment Variables UI
(or locally in `.env.local`). `.env.local` is gitignored and must never be committed.

### Auth

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NEXTAUTH_URL` | **Required** | — | Full public URL of the app (e.g., `https://your-app.vercel.app`) |
| `NEXTAUTH_SECRET` | **Required** | — | JWT signing secret for NextAuth; generate with `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID` | **Required** | — | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | **Required** | — | OAuth 2.0 client secret |

### Database

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | **Required** | — | Neon PostgreSQL connection string (pooled or direct) |

### LLM providers

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GEMINI_API_KEY` | **Required** | — | Google Gemini API key (primary LLM provider) |
| `OPENAI_API_KEY` | Optional | — | OpenAI API key (fallback LLM provider; omit to disable fallback) |
| `LLM_PRIMARY_PROVIDER` | Optional | `"gemini"` | Override primary provider (`"gemini"` or `"openai"`) |
| `GEMINI_MODEL` | Optional | `"gemini-3.1-flash-lite"` | Override Gemini model name |
| `OPENAI_MODEL` | Optional | `"gpt-4o-mini"` | Override OpenAI model name |
| `GEMINI_TIMEOUT_MS` | Optional | `30000` | Gemini request timeout in ms |
| `OPENAI_TIMEOUT_MS` | Optional | `30000` | OpenAI request timeout in ms |
| `GEMINI_RPM_LIMIT` | Optional | `12` | Gemini requests-per-minute quota |
| `GEMINI_TPM_LIMIT` | Optional | `32000` | Gemini tokens-per-minute quota |
| `GEMINI_RPD_LIMIT` | Optional | `1120` | Gemini requests-per-day quota |
| `OPENAI_RPM_LIMIT` | Optional | `480` | OpenAI requests-per-minute quota |
| `OPENAI_TPM_LIMIT` | Optional | `160000` | OpenAI tokens-per-minute quota |
| `OPENAI_RPD_LIMIT` | Optional | `9000` | OpenAI requests-per-day quota |

### Crypto

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `STATEMENT_ENCRYPTION_KEY` | **Required** | — | AES-256-GCM key for statement PDF passwords; 32-byte hex; generate with `openssl rand -hex 32` |

### Cron / sync

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CRON_SECRET` | **Required** | — | Bearer token for `/api/gmail/sync/advance`; used by Vercel Cron and settings UI |
| `NEXT_PUBLIC_CRON_SECRET` | **REMOVE in Phase 1A** | — | **CLIENT-SIDE** cron secret. FINDING-3 in `06`. **`[Planned — pending approval]`:** Remove this var and the `settings/page.tsx:1405` reference that reads it. Do NOT use in production — ships secret to all browser clients. |

### Phase 1A feature flags `[Planned — pending approval]`

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LLM_PARSING_ENABLED` | Optional | `false` (safe default) | Set to `"true"` to enable LLM (Gemini/OpenAI) calls. Missing, empty, or any value other than `"true"` = disabled. |
| `LEGACY_TRANSACTION_INGESTION_ENABLED` | Optional | `false` (safe default) | Set to `"true"` to enable the existing `advance/route.ts` parse path (static parser, template cache, exact result cache, LLM extraction, Transaction upsert, ParseLog). Missing or non-`"true"` = returns 503. |

### Phase 1A: Upstash QStash credentials `[Planned — pending approval]`

| Variable | Required | Notes |
|----------|----------|-------|
| `QSTASH_TOKEN` | **Required for Phase 1A** | Upstash REST API token for enqueuing messages. Server-only. **Must NOT be `NEXT_PUBLIC_*`**. Never logged. Never stored in DB. |
| `QSTASH_CURRENT_SIGNING_KEY` | **Required for Phase 1A** | HMAC signing key for verifying incoming QStash requests at `/api/gmail/scan/worker`. Server-only. |
| `QSTASH_NEXT_SIGNING_KEY` | **Required for Phase 1A** | Next signing key (rotation). Server-only. Same constraints as current key. |

> **Security constraint (D-6):** All three QStash vars are server-only (`process.env` in Node
> runtime, never `NEXT_PUBLIC_*`). They must never appear in logs, DB records, error messages,
> API responses, or browser bundles.

### Test / non-prod

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ENABLE_TEST_AUTH_SEED` | Optional | unset | Set to `1` in non-prod only; enables `/api/test/auth-seed` for E2E tests. **Never set in production.** |
| `NODE_ENV` | Set by Vercel | `"production"` | Controls secure-cookie behavior and test-seed guard |

---

## 4. Database

| Property | Value |
|----------|-------|
| Provider | Neon serverless PostgreSQL (free tier) |
| ORM | Prisma 7.9 |
| Adapter | `@prisma/adapter-neon` (serverless connection pooling) |
| Config | `prisma.config.ts` — loads `.env.local` via `dotenv`, then `defineConfig` |
| Migrations | `prisma/migrations/` — 18 migrations including reconciliation and Stage 1 |
| Schema | `prisma/schema.prisma` — 33 models |

**Run migrations (deploy):**
```bash
npx prisma migrate deploy
```

**Generate client (after schema change):**
```bash
npx prisma generate
```

The Prisma CLI is a development dependency; deployment/build environments that execute
`prisma migrate deploy` or `prisma generate` must install development dependencies for that
step. The runtime continues to use `@prisma/client` and `@prisma/adapter-neon` as production
dependencies. Do not remove or loosen the reviewed `package.json` overrides for PostCSS, sharp,
find-my-way, or Valibot without rerunning production audit, lint, tests, build, Prisma validation,
both drift modes, and migration verification.

**Seed demo data:**
```bash
npx prisma db seed
# or via API: DELETE /api/transactions/demo  (removes demo transactions)
```

**View DB (local):**
```bash
npx prisma studio
```

Neon free tier provides automatic backups (point-in-time restore). No explicit backup
policy is documented for this project.

---

## 5. Local development

```bash
# 1. Install dependencies
npm install

# 2. Create local env file (not tracked in git)
cp .env.local.example .env.local   # if example exists; otherwise create manually
# Fill in: NEXTAUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#          DATABASE_URL, GEMINI_API_KEY, CRON_SECRET, STATEMENT_ENCRYPTION_KEY

# 3. Apply DB migrations
npx prisma migrate dev

# 4. Run dev server
npm run dev           # Next.js dev server at http://localhost:3000

# 5. Run unit tests
npm test

# 6. Run E2E tests
cp e2e/.env.example e2e/.env   # fill in CRON_SECRET, NEXTAUTH_URL, ENABLE_TEST_AUTH_SEED=1
npm run build                  # required — webServer runs `next start`, not `next build`
npx playwright test
# Playwright's webServer config auto-starts the production server via
# "node node_modules/next/dist/bin/next start -p 3000" after `npm run build` completes.
# If a server is already running on port 3000, it is reused (reuseExistingServer: true).
# Manual `npm start` is not needed, but `npm run build` must be run beforehand. [Confirmed — F-08, G-04]
```

**Notes:**
- `.env.local` is loaded by `prisma.config.ts` (via `dotenv`) and by Next.js automatically.
- `ENABLE_TEST_AUTH_SEED=true` is acceptable in `.env.local` for local E2E.
- `pdf-parse` is declared as `serverExternalPackage` in `next.config.ts`; it requires Node.js
  runtime and cannot run at the edge.
- The **"Advance Sync" button** in the Settings page is **dev-only**: it is wrapped in
  `{process.env.NODE_ENV === "development" && ...}` at `settings/page.tsx:1400`. It is not
  rendered in production builds. **[Confirmed — F-11]**

---

## 6. Logging

All logging is **console-based** (`console.log`, `console.error`). Vercel captures stdout/
stderr from serverless functions and makes it searchable in the Vercel dashboard.

**Log prefix conventions:**

| Prefix | Origin |
|--------|--------|
| `[auth]` | `src/lib/auth.ts` |
| `[gmail]` | `src/lib/gmail.ts` |
| `[gemini]` | `src/lib/llm/providers/gemini.ts` |
| `[dedup]` | `src/lib/dedup.ts` |
| `[reconcile]` | `src/lib/reconcile.ts` / `reconcile/route.ts` |
| `[analytics]` | `src/lib/analytics.ts` |

No structured logging sink (Sentry, OTel, Datadog) is configured. This is the primary
observability gap — see §7.

---

## 7. Monitoring gaps

| Gap | Impact | Recommended action |
|-----|--------|-------------------|
| **No error aggregation** (Sentry/Bugsnag) | Production errors visible only in Vercel logs; no alerting | Add Sentry (free tier available); 1–2 hour integration |
| **No distributed tracing** (OTel/Datadog) | No latency visibility across parse chain tiers | Defer unless performance issues arise |
| **No alerting** | Silent failures (cron timeout, LLM quota exhaustion) go unnoticed until a user reports | Vercel log alerts or Sentry notification rules |
| **Cost tracking in DB only** | `LlmCallLog.estimatedCostUsd` + `GeminiUsageLog.callCount` are queryable but not surfaced in a dashboard | Acceptable for POC; add a monitoring dashboard endpoint if costs become a concern |

---

## 8. Known operational constraints

| Constraint | Detail |
|-----------|--------|
| **Single instance** | Vercel Hobby runs one instance per platform documentation; `SyncJobLock` is designed for multi-instance correctness but not exercised in this deployment. **[Unverified — External Platform Configuration]** |
| **60s advance limit** | Hard-enforced by `maxDuration: 60` in `vercel.json`; CHUNK_SIZE=25 is calibrated to fit within this budget |
| **`pdf-parse` requires Node runtime** | Cannot run at edge; only usable in API routes. Encrypted PDF parsing is not implemented (`gmail.ts:27` — `pdfParse(buffer)` with no password) |
| **E2E tests auto-start server** | `playwright.config.ts` `webServer` config starts the server automatically; `npm run build` is required before first run (produces `.next/`); Playwright's `webServer` then starts `next start` automatically — manual `npm start` is not needed. **[Confirmed — F-08]** |
| **`*/N` cron syntax rejected on Hobby** | Vercel Hobby only accepts standard cron expressions (`H H H H H`). Sub-hourly polling must be driven by the client, not the cron. |
| **Neon connection limits** | Free tier connection limit applies; Prisma's `@prisma/adapter-neon` uses HTTP-based pooling to mitigate this |

---

*Cross-references:* environment variable security → `06-security-authentication.md §2–§3`;
cron advance behavior → `04-architecture.md §3`; operational risks → `10-risks-tech-debt.md §4`.

---

## 9. Phase 1A operational changes `[Stage 1 database implemented; deployment pending]`

> The bounded Stage 1 Prisma schema, migration, rollback, fixture, and verifier exist and passed
> isolated execution on 2026-07-26. Runtime code, external resources, and production deployment
> described here do not exist yet.
> Full rationale in `14-phase0-assessment.md §18` (config changes) and §19 (external resources).

### 9.1 Vercel configuration changes

| Change | File | Detail |
|--------|------|--------|
| Add worker route max duration | `vercel.json` | Add `"src/app/api/gmail/scan/worker/route.ts": { "maxDuration": 60 }` alongside existing advance route entry |
| Env vars | Vercel dashboard | Add `LLM_PARSING_ENABLED`, `LEGACY_TRANSACTION_INGESTION_ENABLED`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` |
| Remove var | Vercel dashboard | Remove `NEXT_PUBLIC_CRON_SECRET` from all environments |

**Build command remains unchanged:** `npx prisma generate && next build`

### 9.2 Upstash QStash provisioning

| Action | Detail |
|--------|--------|
| Create Upstash account | Free tier at upstash.com |
| Create QStash queue | 1 queue; free tier = 10 queues max |
| Configure worker URL | `https://<your-app>.vercel.app/api/gmail/scan/worker` |
| Obtain credentials | Copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` into Vercel env vars |
| Verify connectivity | Use QStash dashboard to confirm message delivery to worker URL |

**QStash free-tier quotas** (verified 2026-07-16):

| Limit | Value | Phase 1A headroom |
|-------|-------|-------------------|
| Messages/day | 1,000 | ~133 per 3,000-email scan (well under limit) |
| Max queues | 10 | 1 required |
| Max message size | 1 MB | ~100 bytes per message (well under) |
| Max HTTP response time | 15 min | Each worker tick completes in <60s |
| DLQ retention | 3 days | Monitor DLQ for failed scans |
| Max parallelism | 10 | Single-user POC; no contention expected |

> **Action required:** Monitor the QStash DLQ (Dead Letter Queue) for failed messages.
> A message enters DLQ if the worker returns 5xx three times. This indicates a scan stuck
> in a failed state — inspect the sanitized `email_scan_run.last_error_code` and
> `last_error_message_sanitized` for the scan run ID. Never place Gmail IDs or PII in those fields.

### 9.3 Database migration prerequisites

Before deploying Phase 1A:

```bash
# 1. Take and record an approved snapshot, then apply all pending migrations.
# This includes the checksum-preserving replay bridge, Stage 1, and nullable LLM drift columns.
npx prisma migrate deploy
# This adds 6 new tables: email_filter, email_filter_version, email_source,
# email_scan_run, email_scan_item, email_manual_classification; and adds approved
# Account uniqueness, disconnection columns, coherence CHECK, and recovery index.

# 2. Verify migration completed
npx prisma migrate status

# 3. Generate Prisma client
npx prisma generate
```

**Do not deploy directly from the design SQL.** First run the canonical dry run against an empty
baseline and a sanitized representative pre-migration database, take an approved snapshot, inspect
existing Account rows for compatibility, and review lock duration for the Account constraint/index
creation. The migration is additive but modifies an existing table and is therefore not zero-risk.
Use the exact interruption, forward/rollback, and reapply commands in
`09-testing-quality.md §7 Stage 1 schema dry-run evidence gate`.

**Reconciliation behavior:** On an already-migrated database, the bridge validates the stored
checksums of both historical migrations and confirms ParseTemplate/ParseLog state. It does not
drop or recreate production ParseTemplate data. On clean replay only, it creates an empty
transient bootstrap, removes it before the historical ParseTemplate migration, normalizes the
final index/default, and removes the marker. A checksum or state mismatch aborts the transaction.

After deploy, run:

```bash
npx prisma migrate status
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" \
  -f docs/consolidated/migration-reconciliation-verify.sql
npx prisma migrate diff --exit-code \
  --from-config-datasource --to-schema prisma/schema.prisma
```

Do not edit either historical migration, manually update its checksum, or delete individual
bridge history rows. Restore the snapshot and prior application commit together if reconciliation
must be reversed.

### 9.4 Cron behavior during Phase 1A

The existing Vercel Cron at `0 2 * * *` (targeting `advance/route.ts`) continues to run during
Phase 1A. Its behavior depends on `LEGACY_TRANSACTION_INGESTION_ENABLED`:

- **Flag = false:** `advance` returns 503. Cron trigger is a no-op (logged, not alarming).
- **Flag = true:** `advance` runs normally, processing any pending `SyncJob` records.

The new scan path (`/api/gmail/scan/worker`) is **not** triggered by Vercel Cron. It is triggered
exclusively by Upstash QStash messages initiated by `POST /api/gmail/scan`.

### 9.5 Deployment sequence for Phase 1A

**Recommended order** (minimizes risk of partially-deployed state):

1. Complete the empty and representative database dry runs and record snapshot/restore evidence.
2. Run `npx prisma migrate deploy` in the approved maintenance window (adds 6 tables and the
   approved Account additions)
3. Set `LLM_PARSING_ENABLED=false`, `LEGACY_TRANSACTION_INGESTION_ENABLED=false` in Vercel
4. Set `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` in Vercel
5. Remove `NEXT_PUBLIC_CRON_SECRET` from Vercel environment variables
6. Deploy Phase 1A code (`git push` → Vercel CI)
7. Verify `/api/health` returns 200; verify `POST /api/gmail/scan` returns the expected response
8. Record the `Transaction` count, run one end-to-end scan with both flags false, then prove the
   post-scan count is unchanged (delta = 0)
9. (Optional) Enable `LEGACY_TRANSACTION_INGESTION_ENABLED=true` to restore legacy sync path

### 9.6 Rollback procedure

If Phase 1A must be rolled back:

1. Set both ingestion flags false; stop publication and drain or clear QStash in the operator console.
2. Revert to the previous deployed commit and wait for in-flight functions to finish.
3. Restore from the approved database snapshot if retained Phase 1A data is required. Otherwise,
   execute the reviewed Stage 1 `rollback.sql`, which drops the six tables in dependency order
   and removes the three trigger functions.
4. Drop `account_disconnected_idx`, `chk_account_disconnection_coherence`,
   `account_user_id_id_unique`, `disconnected_at`, and `disconnection_reason`, after proving
   no dependent FK remains.
5. Reconcile Prisma migration history through the approved restore procedure, verify the exact
   baseline schema and row counts, then reapply forward in an isolated validation database.
6. Regenerate Prisma Client and run legacy regression checks.
7. To restore full legacy functionality, re-enable `LEGACY_TRANSACTION_INGESTION_ENABLED=true`.

Exact SQL and interruption-recovery cases are authoritative in
`14-phase0-assessment.md §14`; this summary must not be used independently.
