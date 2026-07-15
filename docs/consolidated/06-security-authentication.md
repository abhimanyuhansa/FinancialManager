# 06 — Security & Authentication

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Frozen:** 2026-07-14 — baseline commit frozen; document text updated through Pass 6
> against the same commit anchor. No modifications to the baseline commit itself.
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Pass 7 corrections:** 2026-07-15 — Frozen metadata standardized. J-01.
> **Pass 3 corrections:** 2026-07-14 — 6-tier ownership taxonomy applied to §1.5 and §6;
> TENANT_KEYED_NOT_ENFORCED category/subcategory API gap documented.
> **Pass 4 corrections:** 2026-07-15 — §1.5 OPERATIONAL_GLOBAL expanded to include
> SyncJobLock and LlmCallLog (both misclassified in Pass-3); PARENT_SCOPED corrected to
> SyncJobMessage only. G-05, G-06.
> **Pass 5 corrections:** 2026-07-15 — §1.5 taxonomy updated to 7-tier: TENANT_ROOT added;
> OPERATIONAL_GLOBAL redefined to allow optional user reference; "6-tier" → "7-tier". H-01.
> **Pass 6 corrections:** 2026-07-15 — Frozen metadata corrected. I-01.

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
