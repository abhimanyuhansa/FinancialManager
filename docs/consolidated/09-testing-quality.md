# 09 — Testing & Quality

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Pass 3 corrections:** 2026-07-14 — Playwright webServer auto-start (F-08); E2E total
> corrected to 50, spec filenames corrected (F-09).
> **Pass 4 corrections:** 2026-07-15 — `npm run build` restored as E2E prerequisite (Pass-3
> over-corrected; G-04); non-LLM test inventory corrected to 9 real files (gap modules removed
> from table, kept in §5 only; G-07); E2E coverage descriptions corrected for 05, 06, 09,
> 13 specs (G-09).
> **Pass 5 corrections:** 2026-07-15 — unit-test area sub-totals corrected: LLM subsystem
> split into `tests/lib/llm/` (11 files, 65 blocks) + LLM-adjacent legacy in `tests/lib/`
> (2 files, 17 blocks); non-LLM row corrected to 81 blocks. H-04.
> **Pass 6 corrections:** 2026-07-15 — §2.2 per-file block-count column removed (estimates
> summed to ~101 while section claimed 81 — not auditable); only total 81 retained. I-06.
> **Phase 0 revision 2026-07-19:** §4 Phase 1A acceptance criteria: `email_source.fetch_status`
> corrected to `email_source.last_fetch_status` (C4 field rename); `email_manual_review`
> reference corrected to `email_manual_classification` (Q1–Q4 rename). C1–C8 corrections
> incorporated in `14-phase0-assessment.md §12`; new ACs: AC-08a–d (cancellation), AC-26a–h
> (filter evaluation), AC-33a–b (QStash dedup), AC-39 (completion guard — updated to three conditions in pass 5 C14). Phase
> 1A test plan for `featureFlags.ts` and scan worker updated to cover constraint trigger
> validation, CANCELLING path, and QStash signature verification as required test targets.
> **Phase 0 revision 2026-07-19 pass 4 (C9–C13):** New ACs added to `14-phase0-assessment.md §12`:
> AC-74a–e (Gmail disconnection model: `getGmailToken()` blocks, soft-disconnect atomicity,
>   reconnection, `email_source` RESTRICT, `classified_by` ON DELETE SET NULL);
> AC-75a–c (filter version immutability: UPDATE trigger raises, SECURITY DEFINER bypass works,
>   `started_at` NULL after create and set on CREATED→DISCOVERING);
> AC-76a–b (item CANCELLED: all non-terminal items transition on cancel, worker returns 200 on
>   CANCELLED scan). QStash authentication ACs (AC-57/AC-58) updated — use `Receiver` SDK, not
> manual HMAC. Worker protocol ACs (AC-32) updated — 10-step sequence.
> **Phase 0 revision 2026-07-19 pass 5 (C14–C23):**
> C14: AC-39 updated — completion guard has three conditions: unfinished items, PENDING filter
>   decisions, AND CANCELLED items; progress formula corrected (filter_excluded_count is subset
>   of fetch_success_count).
> C16: Filter API test file paths updated to `/api/email-filters` hierarchy; rule-draft CRUD test
>   targets removed (no draft persistence in six-table schema).
> C17: AC-57/AC-58 updated — `Receiver.verify()` requires `url` parameter; non-retryable =
>   HTTP 489 + `Upstash-NonRetryable-Error: true`; `Upstash-Retries` header; failure callback
>   uses `Receiver` JWT.
> C18: AC-33a–b updated — `Upstash-Message-Id` must not gate processing; dedup via DB state only.
> C19: AC-75b updated — SECURITY DEFINER does not bypass UPDATE trigger; erasure function removed.
> C20: New AC target: UNIQUE(email_filter_id,id) on email_filter_version; UNIQUE(user_id,id) on
>   email_source; 4 declarative composite FK constraints validated.
> C21: Explicit erasure transaction added as required test target; Account RESTRICT ordering verified.
> C23: AC-26g updated — unsupported rule type → PERMANENTLY_FAILED; AC-26i added —
>   incompatible `rule_schema_version`/`filter_evaluator_version` → PERMANENTLY_FAILED with
>   IncompatibleFilterVersionError; AC-26j added — scan snapshot records both version fields.

> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C30: Phase 1A acceptance criteria rewritten: DATABASE_URL must point to a dedicated isolated
>   test database; transaction-count check is a delta (Δ = 0) not an absolute count; correct
>   count target is email_scan_item count = Gmail-discovered ID count (not email_source count);
>   existing email_source reuse required; fetch failures visible through email_scan_item only
>   (not email_manual_classification); complete AC-01–AC-76 matrix required.
> C32: AC-26i reference updated: filter version incompatibility → scan FAILED (not item
>   PERMANENTLY_FAILED).
> **Phase 0 revision 2026-07-19 pass 7 (C34–C39):**
> C38: Phase 1A unit test targets — `/api/gmail/scan/tick` renamed to `POST /api/gmail/scan/worker`;
>   `/api/gmail/scan/start` renamed to `POST /api/gmail/scan`; DATABASE_URL note corrected to
>   "must point to dedicated isolated test database, never the development database".
> **Stage 1 blocker resolution 2026-07-26 (C108–C116):** D-1 approved for the bounded
> schema/migration stage. `phase1a-dry-run.sql` now verifies exact baseline migration/column
> inventories, the exact six-table column fingerprint, named CHECK/index inventories, correct
> composite-FK duplicate detection, row-local negative cases, duplicate prevention,
> source/history classification coherence, erasure, rollback, and Account restoration.
> The corrected script has not yet been executed because this workspace has no `psql` and no
> isolated empty/representative PostgreSQL URLs; executable evidence remains required.

> Authoritative sources: `jest.config.ts`, `playwright.config.ts`, `tests/` (26 files),
> `e2e/` (15 specs). Counts verified at baseline commit.

---

## 1. Strategy overview

Two test layers:

| Layer | Framework | Runner | Environment |
|-------|-----------|--------|-------------|
| Unit / integration | **Jest** (`ts-jest`) | `npm test` | Node.js (`testEnvironment: "node"`) |
| End-to-end | **Playwright** | `npx playwright test` | Chromium only |

**Jest config** (`jest.config.ts`):
- `ts-jest` transform; `moduleNameMapper` maps `@/` → `src/`.
- `--passWithNoTests` — a missing test file is not a failure.
- No coverage threshold configured (gap — see §6).

**Playwright config** (`playwright.config.ts`):
- Single browser: Chromium.
- `workers: 1` (serial; avoids DB contention).
- `retries: 1` (one automatic retry on failure).
- `timeout: 120_000` ms per test.
- **Server startup:** `webServer` config auto-starts the server using
  `node node_modules/next/dist/bin/next start -p 3000`; `reuseExistingServer: true`
  means a pre-running server is used if one is already listening on port 3000.
  **Important:** `next start` requires a pre-built `.next/` directory — run `npm run build`
  manually before the first `npx playwright test` run. The `webServer` config handles server
  startup (`npm start`) automatically, but does **not** run the build.
  **[Confirmed]** — `playwright.config.ts:webServer` block. *(Earlier docs said "Requires a
  built, running server" — **[Stale / F-08]**; the `webServer` config handles startup.
  Pass-3 over-corrected by removing `npm run build` entirely — restored in Pass-4 / G-04.)*
- Auth state cached in `e2e/.auth/` via a **setup project** (`e2e/setup/auth.setup.ts`).
  The `chromium` project declares `dependencies: ["setup"]`; Playwright runs the setup
  project first automatically. **[Confirmed]** — `playwright.config.ts`.
  *(Earlier docs described this as `globalSetup` — **[Stale / F-08]**; it is a setup project,
  not a `globalSetup` function.)*

---

## 2. Unit test inventory

**Total: ~178 `it()/test()` blocks across 26 test files.** (Gap modules — `staticParser.ts`,
`vpaLookup.ts`, `merchantMaster.ts`, `gmailQuery.ts` — have no test files; see §5.) Grouped by area:

| Area | Files | Approx. blocks |
|------|-------|----------------|
| `tests/lib/llm/` (new LLM subsystem) | 11 | 65 |
| `tests/lib/` LLM-adjacent legacy (`gemini.test.ts`, `geminiRateLimit.test.ts`) | 2 | 17 |
| `tests/lib/` (non-LLM) | 9 | 81 |
| `tests/api/` | 3 | 12 |
| `tests/schema/` | 1 | 3 |

### 2.1 LLM subsystem tests (`tests/lib/llm/` — 11 files, 65 blocks)

| File | Focus |
|------|-------|
| `router.test.ts` | Provider selection, fallback paths |
| `circuitBreaker.test.ts` | CLOSED/OPEN/HALF_OPEN/PROBING state transitions |
| `quota.test.ts` | RPM/TPM/RPD window reserve/release |
| `idempotency.test.ts` | Batch dedup by `batchKey` |
| `lock.test.ts` | SyncJobLock acquire/release/heartbeat |
| `openai.test.ts` | OpenAI provider |
| `prompts.test.ts` | Prompt construction |
| `validate.test.ts` | Output validation/normalization |
| `index.test.ts` | Public façade |
| `types.test.ts` | Type guards |
| `providers/` (1 file) | Provider-level unit tests |

> **Note:** `tests/lib/gemini.test.ts` (13 blocks) and `tests/lib/geminiRateLimit.test.ts`
> (4 blocks) are located in `tests/lib/` (not `tests/lib/llm/`) — they test the legacy
> `src/lib/gemini.ts` and `src/lib/geminiRateLimit.ts` modules, separate from the new
> `src/lib/llm/providers/gemini.ts`. They are counted in the LLM-adjacent row above.

### 2.2 Non-LLM lib tests (`tests/lib/` — 9 files, 81 blocks)

| File | Focus |
|------|-------|
| `parseTemplateCache.test.ts` | Template lifecycle, shadow-run, prune |
| `analytics.test.ts` | Dashboard aggregate calculations |
| `reconcile.test.ts` | Statement vs transaction matching |
| `dedup.test.ts` | 3-layer dedup logic |
| `exactResultCache.test.ts` | msgId cache lookup |
| `gmail.test.ts` | Gmail API wrapper |
| `crypto.test.ts` | AES-256-GCM encrypt/decrypt |
| `onboarding.test.ts` | Onboarding flow |
| `auth.test.ts` | Auth helpers |

**Coverage gaps** (no test file exists for these modules): `staticParser.ts`, `vpaLookup.ts`,
`merchantMaster.ts`, `gmailQuery.ts` — see §5.

### 2.3 API tests (`tests/api/` — 3 files)

| File | Focus |
|------|-------|
| `categories.test.ts` | Category CRUD |
| `token.test.ts` | Token/session handling |
| `transactions-category.test.ts` | Transaction category update + learning |

### 2.4 Schema tests (`tests/schema/` — 1 file)

Validates Prisma model shape / field types.

---

## 3. E2E test inventory

**Total: 50 blocks across 15 specs.** All in `e2e/`. Requires
`e2e/.env` (with `ENABLE_TEST_AUTH_SEED=1`, `CRON_SECRET`, `NEXTAUTH_URL`), and the
`/api/test/auth-seed` backdoor (non-prod only). Run `npm run build` first; the
`webServer` config then auto-starts the server (`next start`) — no manual `npm start` needed.
**[Confirmed — F-09]**

| Spec file | Tests | Coverage area |
|-----------|-------|---------------|
| `01-auth.spec.ts` | 3 | Sign-in, session persistence, sign-out |
| `02-onboarding.spec.ts` | 2 | First-run flow, date selection |
| `03-sync.spec.ts` | 6 | Start sync, progress polling, complete state |
| `04-dashboard.spec.ts` | 5 | KPIs, spend-by-category, recent transactions |
| `05-transactions.spec.ts` | 5 | List, search, filter, export CSV, empty state |
| `06-categories.spec.ts` | 2 | Category dropdown on transaction row (T6.1 options, T6.6 success feedback) — **not** category CRUD |
| `07-filters.spec.ts` | 3 | Filter CRUD, Gmail query keywords |
| `08-passwords.spec.ts` | 2 | Save, delete statement password |
| `09-parselogs.spec.ts` | 1 | Parse logs tab loads (T9.1 tab load only — **not** reprocess) |
| `10-assets.spec.ts` | 3 | Create, edit, delete asset |
| `11-analytics.spec.ts` | 2 | Date range filter, category breakdown |
| `12-api.spec.ts` | 4 | Direct API contract tests (health, auth-seed) |
| `13-nonfunctional.spec.ts` | 4 | Page load latency (T13.1, T13.3), no console errors (T13.2), keyboard nav (T13.4) — **not** 60s advance limit or empty states |
| `14-errors.spec.ts` | 3 | 404, 400, unauthorized |
| `golden-path.spec.ts` | 5 | Full happy path: sign-in → sync → view txns |

> **Note on filenames:** `07-filters.spec.ts` (not `07-settings`), `09-parselogs.spec.ts`
> (not `09-parse-logs`), `13-nonfunctional.spec.ts` (not `13-non-functional`), and
> `golden-path.spec.ts` (not `15-golden-path`) — corrected from pass-2 inventory **[F-09]**.
> Per-spec counts above are reconciled at baseline commit. Authoritative check:
> `grep -c "^\s*test\|^\s*it(" e2e/*.spec.ts`. Total: 3+2+6+5+5+2+3+2+1+3+2+4+4+3+5 = **50**.
> *(Pass-2 stated ~45 — **[Stale / F-09]**.)*

---

## 4. How to run

### Unit tests
```bash
npm test                    # run all Jest tests
npm test -- --watch         # watch mode
npm test -- tests/lib/llm   # specific directory
```

### E2E tests
```bash
# Prerequisites
cp e2e/.env.example e2e/.env    # fill in CRON_SECRET, NEXTAUTH_URL, etc.

# Build the app first (required — webServer runs `next start`, not `next build`)
npm run build

# Run all E2E — Playwright webServer config auto-starts the server (`next start`).
# A pre-running server on port 3000 is reused if present (reuseExistingServer: true).
npx playwright test

# Run specific spec
npx playwright test e2e/03-sync.spec.ts

# Debug / headed mode
npx playwright test --headed
npx playwright test --debug
```

**Required env for E2E:**

| Var | Purpose |
|-----|---------|
| `ENABLE_TEST_AUTH_SEED` | Must be `1`; enables `/api/test/auth-seed` |
| `CRON_SECRET` | Used by auth-seed + advance route in tests |
| `NEXTAUTH_URL` | Must point to the running test server |
| `DATABASE_URL` | Must point to dedicated isolated test database; must never point to the development database |

---

## 5. Coverage gaps

Modules with **no dedicated test file** at baseline commit:

| Module | Path | Gap risk | Why it matters |
|--------|------|----------|----------------|
| `staticParser` | `src/lib/staticParser.ts` | **HIGH** | Tier-0 parser — first-line extraction for all emails; errors silently mis-categorize or drop transactions |
| `vpaLookup` | `src/lib/vpaLookup.ts` | **HIGH** | UPI/VPA merchant learning; affects categorization accuracy for UPI transactions |
| `merchantMaster` | `src/lib/merchantMaster.ts` | **MEDIUM** | Learned merchant→category store; incorrect normalization causes wrong categories |
| `gmailQuery` | `src/lib/gmailQuery.ts` | **MEDIUM** | Builds the Gmail search query; a bug here controls what emails are ever ingested |
| `categoryIcons` | `src/lib/categoryIcons.ts` | **LOW** | Presentation only; icon mapping errors are visible but non-critical |

**Well-covered areas:** all 11 LLM subsystem modules (`tests/lib/llm/`) plus 2 legacy LLM files (`tests/lib/gemini.test.ts`, `tests/lib/geminiRateLimit.test.ts`) have tests; `crypto`, `dedup`,
`analytics`, `reconcile`, `gmail`, `onboarding`, `exactResultCache`, `parseTemplateCache`,
schema — all have dedicated test files.

---

## 6. Quality gates

| Gate | Configuration | Status |
|------|---------------|--------|
| Unit tests must pass | Jest exits non-zero on failure | [Confirmed] |
| Missing test files OK | `--passWithNoTests` | [Confirmed] — allows gap modules to exist without blocking CI |
| E2E retries | `retries: 1` in `playwright.config.ts` | [Confirmed] |
| E2E parallelism | `workers: 1` (serial) | [Confirmed] — prevents DB race conditions |
| **Coverage threshold** | **None configured** | **[Gap]** — Jest will pass even at 0% coverage |
| **CI integration** | **Unverified** | E2E spec requires running server; unclear if CI runs it |

---

## 7. Phase 1A required tests (added 2026-07-16)

Per Phase 0 assessment `14-phase0-assessment.md §9`. These tests are **[Not Implemented]**
pending Phase 1A approval and must be written before Phase 1A ships.

### LLM=0 regression test (blocking gate — must pass before Phase 1A ships)

```
tests/lib/featureFlags.test.ts
```

This test must prove that when `LLM_PARSING_ENABLED=false`, no AI provider can be invoked
under any code path. Specifically:
- `isLlmParsingEnabled()` returns false
- `router.callLlm()` throws `LlmDisabledError` without calling Gemini or OpenAI
- Gemini provider mock is not called
- OpenAI provider mock is not called

### Phase 1A unit test targets

| Module | Tests |
|--------|-------|
| `src/lib/featureFlags.ts` | Flag true/false/missing env var |
| `POST /api/gmail/scan/worker` route | Scanning phase, fetching phase, lease acquisition, Gmail 429 error |
| `POST /api/gmail/scan` route | Creates scan run, validates params, auth gate |
| `email_source` upsert logic | Idempotency on re-run (no duplicates on second scan) |

### Phase 1A E2E test

```
e2e/15-email-scan.spec.ts
```
- Start scan → progress updates → completion
- Email inventory table loads, is filterable by domain
- Verify zero `Transaction` rows created during scan (critical acceptance criterion)

### Acceptance criteria for Phase 1A (non-negotiable)

- `DATABASE_URL` must point to a **dedicated isolated test database** — not the development database.
  Tests must not run against shared state that could be polluted by previous runs.
- `LLM_PARSING_ENABLED=false` is set in test environment
- After complete scan tick loop: transaction-count **delta = 0** — the number of `Transaction` rows
  after the scan must equal the number before the scan started. (Absolute count may be non-zero
  if the test database has pre-existing transactions from earlier test setup.)
- `email_scan_item` count = exactly the number of Gmail message IDs returned by the Gmail
  List API mock. (Not email_source count — email_source may differ if sources are reused
  across scans.)
- **Existing `email_source` reuse**: a second scan for the same user and Gmail account must
  not create duplicate `email_source` rows. The `ON CONFLICT DO NOTHING` upsert must be
  verified — row count does not increase for previously seen message IDs.
- Fetch failures must be visible **through `email_scan_item` only** — `email_scan_item.status`
  = `PERMANENTLY_FAILED` for missing or unresolvable batch responses. No `email_manual_classification`
  row is created by a fetch failure.
- **Idempotent re-scan**: two complete scans of the same inbox produce no duplicate `email_source`
  rows (UNIQUE constraint on `(user_id, gmail_account_id, gmail_message_id)`).
- **Complete acceptance-criteria matrix**: every acceptance criterion listed in
  `14-phase0-assessment.md §15` must have a mapped test. No AC may be left untested.

### Stage 1 schema dry-run evidence gate

Before a migration can be marked verified, execute `docs/consolidated/phase1a-dry-run.sql`
with `ON_ERROR_STOP=1` against both a freshly migrated empty baseline database and a sanitized
representative pre-migration database. Preserve the script output and prove forward migration,
negative and duplicate cases, erasure, rollback, exact baseline restoration, and forward
reapplication. A static review of the SQL is not a substitute for this evidence.

Exact sequence (the first command is an intentional non-zero interruption drill):

```bash
psql -X -v ON_ERROR_STOP=1 -v PHASE1A_FAIL_AFTER_DDL=1 "$EMPTY_DATABASE_URL" -L /tmp/fm_phase1a_empty_interruption.log -f docs/consolidated/phase1a-dry-run.sql
psql -X -v ON_ERROR_STOP=1 "$EMPTY_DATABASE_URL" -L /tmp/fm_phase1a_empty_forward_rollback.log -f docs/consolidated/phase1a-dry-run.sql
psql -X -v ON_ERROR_STOP=1 "$EMPTY_DATABASE_URL" -L /tmp/fm_phase1a_empty_reapply.log -f docs/consolidated/phase1a-dry-run.sql
psql -X -v ON_ERROR_STOP=1 "$REPRESENTATIVE_DATABASE_URL" -L /tmp/fm_phase1a_representative_forward_rollback.log -f docs/consolidated/phase1a-dry-run.sql
psql -X -v ON_ERROR_STOP=1 "$REPRESENTATIVE_DATABASE_URL" -L /tmp/fm_phase1a_representative_reapply.log -f docs/consolidated/phase1a-dry-run.sql
```

The representative database must be isolated and sanitized. The logs may contain only schema
metadata, aggregate counts, synthetic `dryrun-*` identifiers, and sanitized error messages;
review them before retention or attachment to an audit record.

**Executed evidence (2026-07-26, PostgreSQL 17.10, isolated local cluster):**

- Empty baseline design-mode interruption exited 3 at the injected checkpoint; the immediate
  normal rerun passed VP1–VP15 and proved connection-close rollback.
- `prisma migrate deploy` applied `20260726000000_phase1a_stage1_scan_schema`; migrated-mode
  interruption exited 3 and the immediate full rerun passed.
- Reviewed `rollback.sql` restored 0 Phase 1A tables, 0 Stage 1 trigger functions, 0 Account
  additions, and unchanged baseline counts; Prisma reapply then passed.
- The synthetic representative fixture retained 2 users, 3 accounts, 1 sync job, 2 sync messages,
  and 1 transaction through deploy and full migrated-mode verification; all new Account fields
  remained NULL for existing rows.
- Full verifier evidence: exact six-table columns, 22 FKs, 3 triggers, 38 new-table CHECKs plus
  the Account CHECK, 19 supporting indexes, negative tenant/account cases, duplicate rejection,
  immutable parents/versions, canonical erasure, and fixture rollback all passed.
- `npx prisma validate`, `npx prisma generate`, 29 Jest suites / 248 tests, and production build
  passed. The then-existing 17-error/6-warning lint blocker was resolved later on 2026-07-26;
  current dependency-upgrade evidence follows.
- The then-existing ParseTemplate/LLM clean-replay blocker was resolved later on 2026-07-26;
  evidence follows.

**Migration-history and schema-drift reconciliation evidence (2026-07-26):**

- Fresh empty `prisma migrate deploy` applied all 18 migrations in lexical order.
- `prisma migrate diff --exit-code --from-migrations ... --to-schema ...` and live
  database-to-schema diff both returned `No difference detected`.
- An already-migrated 14-migration production-like database accepted the four pending
  reconciliation migrations even though three bridge names sort before previously applied rows.
- Historical migration SQL files remained byte-identical at SHA-256
  `f471552d...f09a` and `d7720550...c4a0f`; database history retained those checksums.
- Synthetic representative counts and rows remained unchanged: 2 users, 3 accounts,
  1 transaction, 1 ParseTemplate, 1 LlmCallLog, and 1 LlmCircuitBreaker.
- New LLM fields were NULL for existing rows. Drift rollback removed exactly three columns while
  preserving all rows; forward reapply restored the columns and the verifier passed.
- A separate production-like case began with all three compatible columns and synthetic non-NULL
  values already present; `ADD COLUMN IF NOT EXISTS` preserved values `321`,
  `synthetic-finish`, and `2026-01-05 00:05:00`, and Prisma still reported zero drift.
- A deliberately corrupted historical checksum caused the bridge to fail closed before creating
  its marker or columns; baseline counts remained unchanged.
- A between-migration interruption was simulated after the production-like preflight committed
  with `clean_replay_bootstrap=false`; the next `migrate deploy` resumed at reset/finalize/drift,
  removed the marker, preserved all representative rows, and passed the verifier.
- `migration-reconciliation-verify.sql` passed exact 18-migration history, checksum, marker,
  ParseTemplate normalization, LLM column, and representative-row assertions.
- The updated Phase 1A verifier passed both the exact 16-migration pre-Stage-1 baseline and exact
  18-migration migrated modes.

**Quality and dependency blocker evidence (2026-07-26):**

- `npm run lint` passes with zero errors and zero warnings. Effect-triggered fetches are deferred
  to cancellable timer callbacks, hook dependencies are stable, unsafe test function typing is
  replaced with an explicit callback signature, and unused declarations were removed.
- Production dependencies upgraded to Next.js 16.2.12, next-auth 5.0.0-beta.32,
  @auth/core 0.41.3, @auth/prisma-adapter 2.11.3, and Prisma 7.9.0. Patched transitive overrides
  are locked for PostCSS 8.5.23, sharp 0.35.3, find-my-way 9.7.0, and Valibot 1.4.2.
- `npm audit --omit=dev --audit-level=critical` reports zero vulnerabilities. The full
  development-tree audit still reports 27 high findings through brace-expansion in ESLint/Jest
  tooling; npm's proposed forced fix would downgrade Next ESLint configuration and Jest to
  incompatible versions, so it was rejected. This path is absent from the production tree.
- Four focused Auth/LLM suites passed 33 tests; the complete 29-suite test run passed 248 tests.
  Prisma 7.9 validation/generation, Next.js production build, clean/representative 18-migration
  status, both drift modes, and both reconciliation-verifier modes passed.
- Browser E2E was not executed: `e2e/.env` and cached test-auth state are absent. No production
  or development database was substituted.

---

## 7. Recommended additions

Priority order:

1. **Add `staticParser.test.ts`** — test each bank/format pattern; assert `parsed`/`not_transaction` output for representative email bodies. **HIGH.**
2. **Add `vpaLookup.test.ts`** — test VPA normalization, merchant lookup, new-entry learning. **HIGH.**
3. **Add `merchantMaster.test.ts`** — test normalization, upsert confidence logic. **MEDIUM.**
4. **Add `gmailQuery.test.ts`** — test `buildGmailQueryFromDB()` with various keyword/exclusion combinations; assert query string format. **MEDIUM.**
5. **Configure a Jest coverage threshold** — e.g., `coverageThreshold: { global: { lines: 70 } }` in `jest.config.ts`. Even a modest floor prevents regressions. **[Recommended]**
6. **Add `categoryIcons.test.ts`** — low effort, completes coverage of all `src/lib/` modules. **LOW.**

---

*Cross-references:* gap modules also listed in `08-implementation-status.md §3`; risk
register entry → `10-risks-tech-debt.md §4`; traceability of tests to requirements →
`13-traceability-matrix.md`.
