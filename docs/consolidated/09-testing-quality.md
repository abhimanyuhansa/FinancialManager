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
| `DATABASE_URL` | Points to test DB (may be same as dev) |

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
