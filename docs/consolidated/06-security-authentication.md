# 06 — Security & Authentication

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Frozen:** 2026-07-14 — baseline commit frozen; document text updated through Pass 6
> against the same commit anchor. No modifications to the baseline commit itself.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 7 corrections:** 2026-07-15 — Frozen metadata standardized. J-01.
> **Pass 3 corrections:** 2026-07-14 — 6-tier ownership taxonomy applied to §1.5 and §6;
> TENANT_KEYED_NOT_ENFORCED category/subcategory API gap documented.
> **Pass 4 corrections:** 2026-07-15 — §1.5 OPERATIONAL_GLOBAL expanded to include
> SyncJobLock and LlmCallLog (both misclassified in Pass-3); PARENT_SCOPED corrected to
> SyncJobMessage only. G-05, G-06.
> **Pass 5 corrections:** 2026-07-15 — §1.5 taxonomy updated to 7-tier: TENANT_ROOT added;
> OPERATIONAL_GLOBAL redefined to allow optional user reference; "6-tier" → "7-tier". H-01.
> **Pass 6 corrections:** 2026-07-15 — Frozen metadata corrected. I-01.
> **Phase 0 revision 2026-07-19 pass 6 (C24–C33):**
> C28: §8.2 QStash worker authentication — HMAC-SHA256 wording replaced with `Receiver` class JWT
>   verification; HTTP 401 → HTTP 489 + `Upstash-NonRetryable-Error: true`; verification flow
>   updated to `receiver.verify({ signature, body, url, clockTolerance })` with `url` required.
> **Phase 0 revision 2026-07-19 pass 8 (C40–C45):**
> C45: §8.2 credential table — "Security comes from HMAC verification" replaced with
>   "Security comes from Receiver JWT signature and claim verification"; non-retryable response
>   wording corrected to HTTP 489 + `Upstash-NonRetryable-Error: true`; test expectations updated
>   from HTTP 401 to HTTP 489.
> **Phase 0 revision 2026-07-19 pass 9 (C50):**
> C50: §8.4 `error_message` field references replaced with `last_error_message_sanitized` (two
>   occurrences — both in prose and in implementation note).

> Per PM decision: **document + verify git state; no code or secret changes this pass.** All
> git/secret claims below were re-verified read-only at consolidation time (2026-07-14). Tags
> per `00-index.md`. Findings carry a severity.

---

## 1. Authentication model

### 1.1 Provider & scope
Sign-in is **Google OAuth only**, via NextAuth v5. Requested scope:
`openid email profile https://www.googleapis.com/auth/gmail.readonly`, with
`access_type=offline` + `prompt=consent` (to obtain and refresh a Gmail token). **[Confirmed]** —
`src/lib/auth.config.ts`.

**Gmail access is read-only** (`gmail.readonly`); the app cannot modify or send mail. **[Confirmed]**

### 1.2 Split config (edge vs Node)
- `src/lib/auth.config.ts` — edge-safe: provider + `authorized` callback only, **no Prisma**.
- `src/lib/auth.ts` — Node runtime: `PrismaAdapter` + `session: "database"`.

Rationale: the Prisma adapter cannot run in the edge middleware runtime, so the public-route
gate lives in the edge-safe config and DB-backed session handling lives in the Node config.
**[Confirmed]**

### 1.3 Session
Sessions are **database-backed** (`Session` model, `sessionToken` unique). Cookie is `secure`
in production (`auth-seed` route confirms `secure: NODE_ENV==="production"`). **[Confirmed]**

### 1.4 Route protection
`authorized({ auth, request })` returns `true` for public routes and otherwise requires
`auth?.user`. Public routes: `/login`, `/api/auth/*`, `/api/gmail/sync/advance`,
`/api/test/auth-seed`, `/api/health`. All other routes require a session. **[Confirmed]** —
`auth.config.ts:23–36`. 33 of 36 API routes resolve identity via `auth()`. **[Confirmed]**

### 1.5 Data isolation boundary

Per-user data isolation uses a **7-tier ownership model** (see `05-data-model-apis.md §1` for
the full taxonomy). The tiers with security-relevant properties:

- **TENANT_ROOT** — the identity anchor itself (`User`); no `userId` FK (it *is* the user).
- **TENANT_SCOPED_ENFORCED** — has `userId` FK and APIs filter by it. These models are
  properly isolated per user.
- **TENANT_KEYED_NOT_ENFORCED** — has `userId` FK but **APIs do not enforce per-user scoping**.
  `Category` and `SubCategory` fall here: `GET /api/categories` returns all rows with no
  `userId` filter; `PATCH/DELETE /api/categories/[id]` uses `findUnique({where:{id}})` with no
  ownership check. Any authenticated user can modify another user's categories. **[Confirmed]** —
  `src/app/api/categories/route.ts`, `src/app/api/categories/[id]/route.ts`.
- **SYSTEM_GLOBAL** — no `userId`; shared across all users. Mutations by any authenticated
  session affect all users:

| Model | Notes |
|-------|-------|
| `GmailQueryKeyword` | Shapes Gmail search query for all users |
| `ExclusionRule` | Skips senders for all users |
| `EmailFilter` | Legacy settings-only; not in parse pipeline |
| `MerchantMaster` | Learned merchant→category, shared |
| `SubCategoryMaster` | Global subcategory catalog |

- **OPERATIONAL_GLOBAL** — no enforced User FK; may carry an optional user reference or tag. Global metering/locking shared by all users
  (`LlmCircuitBreaker`, `LlmQuotaWindow`, `LlmBatchIdempotency`, `GeminiUsageLog`,
  `SyncJobLock`, `LlmCallLog`). Note: `SyncJobLock` is string-keyed by `jobId String @id`
  with no `@relation` to `SyncJob` — it is not relational-child of any user-scoped model.
  `LlmCallLog.userId` is `String?` nullable with no FK to `User` — an optional operational
  tag only, not enforced isolation. **[Confirmed]** — `prisma/schema.prisma`.
- **PARENT_SCOPED** — no direct `userId`; scoped via cascade from a TENANT_SCOPED_ENFORCED
  parent (`SyncJobMessage` only).
- **AUTH_INFRASTRUCTURE** — NextAuth internal; no app `userId` (`VerificationToken`).

**[Confirmed]** — verified field presence in `prisma/schema.prisma`.
SYSTEM_GLOBAL mutations (via `/api/settings/filters`, `/api/settings/gmail-query`,
`/api/settings/exclusion-rules`, category/subcategory endpoints) affect **all users**.
TENANT_KEYED_NOT_ENFORCED is an additional security concern: cross-user category mutations
are possible with a valid session.

---

## 2. Cron / machine authentication

`/api/gmail/sync/advance` accepts **either** a valid session **or** a `CRON_SECRET`:
- Bearer header `Authorization: Bearer <token>` (`advance/route.ts:603–604`).
- **also** a `?secret=` query parameter (`advance/route.ts:605`).
- `isCron = !!CRON_SECRET && providedToken === CRON_SECRET` (`advance/route.ts:607`). **[Confirmed]**

---

## 3. Secret handling at rest

- **Statement PDF passwords** are encrypted with **AES-256-GCM** using a random IV per record
  (`createCipheriv`), stored as `StatementPassword.encryptedPassword`; never returned in
  plaintext (E2E T8.3 asserts this). **[Confirmed]** — `src/lib/crypto.ts:1–31`.
- OAuth tokens (`Account.access_token`, `refresh_token`) are stored **unencrypted** in the DB
  (standard NextAuth adapter behavior). **[Confirmed]** — noted as a residual risk (see §5).

---

## 4. Verified git / secrets state

Re-verified read-only on 2026-07-14:

| Check | Command | Result |
|-------|---------|--------|
| Is `.env.local` tracked? | `git ls-files --error-unmatch .env.local` | **Not tracked** ("did not match any file(s)") |
| Any env file tracked? | `git ls-files \| grep -iE '\.env'` | **None** |
| Gitignore coverage | `.gitignore` | `.env*` ignored |

**Conclusion:** No secrets are committed to git. `.env.local` exists only in the working tree /
dev disk. **[Confirmed]**

> **History / correction:** an automated exploration earlier flagged
> *"CRITICAL: .env.local committed with plaintext secrets."* This was a **FALSE POSITIVE** — the
> tool read the working-tree file, not git history. Verification (above) shows it was never
> tracked. Recorded here per the "don't trust, verify" mandate. **[Stale finding — corrected.]**

---

## 5. Security findings (with severity)

### FINDING-1 — Test auth-seed backdoor — **HIGH**
`/api/test/auth-seed` mints a valid session. Guard:
`if (NODE_ENV === "production" && !ENABLE_TEST_AUTH_SEED) return <blocked>` **and** requires
`body.secret === CRON_SECRET` (`auth-seed/route.ts:8,13`).
- **Risk:** if `ENABLE_TEST_AUTH_SEED` is set in a production environment (and `CRON_SECRET` is
  known/leaked), this endpoint mints sessions for arbitrary users — a full auth bypass. Local
  `.env.local` sets `ENABLE_TEST_AUTH_SEED=true` (dev only, acceptable there).
- **Recommendation (Pass 2, not changed now):** never set `ENABLE_TEST_AUTH_SEED` in prod;
  consider removing the route from prod builds entirely. **[Confirmed present]**

### FINDING-2 — Cron secret accepted as query param — **HIGH**
`/api/gmail/sync/advance` accepts `?secret=<CRON_SECRET>` in the URL (`advance/route.ts:605`).
- **Risk:** query strings leak into access logs, proxy logs, browser history, and Referer
  headers — exposing the cron secret.
- **Recommendation (Pass 2):** accept the secret **only** via the `Authorization: Bearer`
  header; drop the query-param path. **[Confirmed present]**

### FINDING-3 — `NEXT_PUBLIC_CRON_SECRET` in client bundle — **MEDIUM**
`src/app/(app)/settings/page.tsx:1405` reads `process.env.NEXT_PUBLIC_CRON_SECRET`. Any
`NEXT_PUBLIC_*` var is **inlined into the browser bundle**.
- **Risk:** if the deploy sets `NEXT_PUBLIC_CRON_SECRET` equal to `CRON_SECRET`, the cron secret
  ships to every client. If it's set to a different/empty value, the settings feature that
  relies on it may not work as intended.
- **Recommendation (Pass 2):** do not expose the cron secret to the client; move any
  client-triggered advance behind a session-authenticated server action instead of a public
  bearer secret. **[Confirmed present]** (Whether prod actually sets this var is deploy-config
  dependent — **[Unverified]** here.)

### FINDING-4 — OAuth tokens stored unencrypted — **LOW/INFO**
`Account.access_token` / `refresh_token` are plaintext in the DB (default NextAuth adapter).
- **Risk:** DB compromise exposes Gmail-readonly tokens. Mitigated by read-only scope and
  Neon's managed access controls.
- **Recommendation (Pass 2):** consider column-level encryption if threat model warrants. **[Confirmed]**

### FINDING-5 — Compromised OpenRouter key (history) — **follow-up**
Memory notes a previously compromised OpenRouter key. Current code uses Gemini + OpenAI
providers directly (no OpenRouter in `src/lib/llm/providers/`). Key rotation is an operational
follow-up, out of scope for this doc pass. **[Unverified in code / historical]**

---

## 6. Positive controls (defenses that ARE in place)

- Read-only Gmail scope. **[Confirmed]**
- DB-backed sessions with secure cookies in prod. **[Confirmed]**
- Per-user data isolation via `userId` FK + `onDelete: Cascade` for **TENANT_SCOPED_ENFORCED models**. **[Confirmed]**
  Note: `Category` and `SubCategory` have `userId` fields but APIs do not enforce per-user scoping — they are **TENANT_KEYED_NOT_ENFORCED** (see §1.5).
  `GmailQueryKeyword`, `ExclusionRule`, `MerchantMaster`, `SubCategoryMaster`, and `EmailFilter` are **SYSTEM_GLOBAL** (no `userId`) — mutations affect all users. See §1.5.
- Statement passwords encrypted (AES-256-GCM, per-record IV). **[Confirmed]**
- No secrets committed to git (verified). **[Confirmed]**
- Route gate defaults to **deny** (any non-public route requires a session). **[Confirmed]**
- LLM idempotency + quota + breaker limit blast radius of runaway/abusive calls. **[Confirmed]**

---

## 7. Severity summary

| # | Finding | Severity |
|---|---------|----------|
| 1 | Test auth-seed backdoor if enabled in prod | HIGH |
| 2 | Cron secret accepted via query param (log leakage) | HIGH |
| 3 | `NEXT_PUBLIC_CRON_SECRET` inlined into client bundle | MEDIUM |
| 4 | OAuth tokens unencrypted at rest | LOW/INFO |
| 5 | Compromised OpenRouter key (historical) | follow-up |
| — | `.env.local` committed (earlier claim) | **FALSE POSITIVE — corrected** |

> No code, secrets, or config were modified while producing this document. Remediations are
> recommendations for Pass 2 / owner action.

---

*Cross-references:* auth components → `04-architecture.md §2.1`; route auth column →
`05-data-model-apis.md §2`; these findings feed the risk register in Pass-2 `10-risks-tech-debt.md`.

---

## 8. Phase 1A security controls `[Planned — pending approval]`

> All items in this section are **`[Planned — pending approval]`**. None are implemented.
> Full context and rationale: `14-phase0-assessment.md §9, §12`.

### 8.1 SEC-2 fix: remove `?secret=` query parameter from `advance` route

FINDING-2 (§5) is resolved in Phase 1A as part of the `advance/route.ts` modification to add the
`LEGACY_TRANSACTION_INGESTION_ENABLED` gate. The fix:

- Remove lines `advance/route.ts:605` (`?secret=` path) and the associated `querySecret` extraction.
- Accept `CRON_SECRET` **only** via `Authorization: Bearer <token>` header.
- `isCron` logic becomes: `!!CRON_SECRET && authHeader === \`Bearer ${CRON_SECRET}\``
- This fix is applied regardless of whether `LEGACY_TRANSACTION_INGESTION_ENABLED` is true or false.

**Residual risk (FINDING-3):** `NEXT_PUBLIC_CRON_SECRET` is a client-side env var in the settings
page. Phase 1A removes the need for clients to call `advance` directly (QStash worker takes over
for the new scan path). However, the legacy `advance` path remains while
`LEGACY_TRANSACTION_INGESTION_ENABLED=true`. The `NEXT_PUBLIC_CRON_SECRET` var should be removed
from the settings page client code in Phase 1A. **[Planned — pending approval]**

### 8.2 QStash worker authentication

`/api/gmail/scan/worker` is invoked exclusively by Upstash QStash, never by browser sessions.
It uses **QStash JWT signature verification via the `Receiver` class** (not NextAuth sessions, not manual HMAC-SHA256):

**Verification flow:**
1. Extract `Upstash-Signature` header from incoming POST request.
2. Call `receiver.verify({ signature, body, url, clockTolerance })` — tries `QSTASH_CURRENT_SIGNING_KEY` first, then `QSTASH_NEXT_SIGNING_KEY` (key rotation support per Upstash's signing key rotation spec). The `url` parameter is required for JWT `sub` claim validation (C17).
3. If verification fails → return HTTP 489 + `Upstash-NonRetryable-Error: true` immediately, no DB access.
4. After signature verification, resolve user identity from `scanRunId`:
   `SELECT user_id FROM email_scan_run WHERE id = $scanRunId`
5. Verify the user identity is non-null and the scan run is not in a terminal state.

**Credential security requirements (binding — D-6):**

| Constraint | Requirement |
|-----------|-------------|
| `QSTASH_TOKEN` | Server-only env var. Must NOT be `NEXT_PUBLIC_*`. Never logged. Never stored in DB. |
| `QSTASH_CURRENT_SIGNING_KEY` | Server-only. Never exposed to browser, logs, DB, or error records. |
| `QSTASH_NEXT_SIGNING_KEY` | Server-only. Same constraints as signing key. |
| Worker endpoint path | May be publicly known (no secret in path). Security comes from Receiver JWT signature and claim verification. |
| Worker response body | Must not include QStash credentials, Gmail message IDs, OAuth tokens, or PII. |

**Browser sessions cannot substitute for QStash verification.** The worker accepts ONLY requests
with a valid Upstash-Signature. Requests lacking or presenting an invalid signature return
HTTP 489 + `Upstash-NonRetryable-Error: true` unconditionally (non-retryable — QStash must not
redeliver requests that will never succeed due to a permanent authentication failure).

**User-supplied input:** The `scanRunId` in the QStash message payload is treated as untrusted
input. After signature verification proves the message originated from Upstash, the worker still:
- Looks up `email_scan_run WHERE id = $scanRunId`
- Verifies the scan run exists and belongs to a real user
- Acquires a worker lease atomically (prevents two concurrent workers from processing the same scan)

This means a replayed or forged `scanRunId` in a legitimately signed message cannot access
another user's data — ownership is always checked against the DB.

### 8.3 OAuth token encryption plan

**Current state:** `Account.access_token` and `Account.refresh_token` are stored unencrypted
(FINDING-4). Phase 1A does not add OAuth token encryption — this is out of scope for POC.

**Option A (Phase 1A+):** Column-level AES-256-GCM encryption using the existing `src/lib/crypto.ts`
pattern, applied to `Account.access_token` and `Account.refresh_token` on write/read in the
NextAuth Prisma adapter. Requires a `GMAIL_TOKEN_ENCRYPTION_KEY` env var (separate from statement
password key).

**Option B (long-term):** Google Cloud KMS or Vercel KV-backed encryption with envelope key rotation.
Higher operational complexity; not appropriate for POC scale.

**Decision status:** Both options are `[Planned — post-Phase 1A]`. Phase 1A does not touch the
OAuth token storage path.

### 8.4 Scan error sanitization requirements

All error messages stored in `email_scan_run.last_error_message_sanitized` and `email_scan_item.last_error_message_sanitized`
**must be sanitized before storage** (D-6). Permitted in error messages:

- Generic error type (e.g., "Gmail API error", "fetch timeout", "Gmail quota exceeded")
- HTTP status codes (e.g., "HTTP 429")
- Internal UUIDs (scan run IDs, item IDs — these are app-internal, non-PII)

**Must NOT appear** in any stored error message or API response:

| Prohibited content | Example |
|-------------------|---------|
| Gmail message IDs | `19a3b4c5d6e7f891` |
| OAuth access/refresh tokens | `ya29.a0A...` |
| Gmail email addresses | `user@gmail.com` |
| Account or card identifiers | Last 4 digits, account numbers |
| QStash credentials | Signing keys, QSTASH_TOKEN |
| Statement PDF passwords | Encrypted or plaintext |
| PAN (payment card numbers) | 16-digit card numbers |
| OTPs | 6-digit codes from email body |
| Raw email body content | Email snippets, subject lines |
| Date of birth | DOB values from emails |

Implementation: a `sanitizeErrorMessage(err: unknown): string` function in
`src/lib/scan/sanitize.ts` applies the above rules before any `last_error_message_sanitized` write.
**[Planned — pending approval]**

### 8.5 Feature flag security properties

The two Phase 1A feature flags affect the security surface:

| Flag | When false (safe default) | When true | Threat if flag misconfigured |
|------|--------------------------|-----------|------------------------------|
| `LLM_PARSING_ENABLED` | LLM router throws `LlmDisabledError`; no AI provider calls | Gemini/OpenAI can be invoked | PII sent to AI provider without user's knowledge |
| `LEGACY_TRANSACTION_INGESTION_ENABLED` | `advance/route.ts` returns 503; legacy path disabled | Existing `advance` route active | N/A — legacy path is the known-safe existing behavior |

**Safe-default guarantee:** Both flags default to `false` when the env var is absent or set to any
value other than the string `"true"`. An empty string, `"false"`, `"0"`, or missing var all result
in the disabled (safe) state.

**Vercel configuration requirement:** Both flags must be explicitly set to `"true"` in Vercel
environment variables if the operator wants to enable the associated functionality. Unset = disabled.
This must be documented in `11-operations-deployment.md` and confirmed at deploy time.

### 8.6 Phase 1A security testing requirements

The following tests are required before Phase 1A ships (`[Planned — pending approval]`):

| Test | What it proves |
|------|---------------|
| `tests/lib/featureFlags.test.ts` | `isLlmParsingEnabled()` returns false when env var is absent, empty, or `"false"` |
| `tests/lib/featureFlags.test.ts` | `isLlmParsingEnabled()` returns true ONLY when env var = `"true"` |
| `tests/lib/featureFlags.test.ts` | `router.callLlm()` throws `LlmDisabledError` when flag is false (no provider calls) |
| `tests/api/scan-worker.test.ts` | Worker returns HTTP 489 + `Upstash-NonRetryable-Error: true` on missing Upstash-Signature |
| `tests/api/scan-worker.test.ts` | Worker returns HTTP 489 + `Upstash-NonRetryable-Error: true` on invalid Upstash-Signature |
| `tests/api/scan-worker.test.ts` | Worker accepts valid Upstash-Signature |
| `tests/api/scan-worker.test.ts` | Worker cannot access scan run belonging to different user |
| `tests/lib/scan/sanitize.test.ts` | `sanitizeErrorMessage` strips Gmail IDs, OAuth tokens, PII from error strings |

*Full acceptance criteria for Phase 1A security controls: `14-phase0-assessment.md §15`
(AC-35 through AC-42).*
