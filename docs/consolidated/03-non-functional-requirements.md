# 03 — Non-Functional Requirements

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — document text updated through Pass 6 against the
> same commit anchor. No modifications to the baseline commit itself.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 8
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 8 corrections:** 2026-07-15 — NFR-SCALE-4 table row fixed: merged dangling 4th cell
> into Status cell (3-column table). Freeze metadata standardized. K-01, K-02.
> **Pass 7 corrections:** 2026-07-15 — NFR-DATA-2 changed to [Partial] with REL-8 exception.
> Frozen metadata standardized. J-01, J-02.
> **Pass 4 corrections:** 2026-07-15 — NFR-SCALE-1/2 terminology updated to 6-tier taxonomy
> (TENANT_SCOPED_ENFORCED); NFR-SCALE-4 re-tagged [Partial / Unverified — External Platform
> Configuration]; NFR-QUOTA-2 "defers work" corrected to ProviderExhaustedError (G-08).
> **Pass 5 corrections:** 2026-07-15 — NFR-SCALE-1/2 "TENANT_SCOPED_ENFORCED" expanded to
> "TENANT_SCOPED_ENFORCED and TENANT_ROOT" (7-tier taxonomy); NFR-QUOTA-2 corrected to
> accurately reflect unconditional processed=true; NFR-REL-4 changed [Confirmed]→[Partial]
> with narrow-condition qualifier. H-01, H-02.
> **Pass 6 corrections:** 2026-07-15 — NFR-SCALE-1 corrected: TENANT_ROOT (User) has no
> userId FK; isolation is anchored by TENANT_ROOT, TENANT_SCOPED_ENFORCED models reference
> it via enforced userId FKs. Frozen metadata corrected. I-01, I-07.

> As-built constraints and targets, tagged per `00-index.md`. Numbers cite the code/config
> that enforces them.

---

## 1. Cost

| NFR | Target | Enforcement | Status |
|-----|--------|-------------|--------|
| NFR-COST-1 | Run at **≈ $0/month** | Free-tier stack + LLM quota caps + circuit breaker | [Confirmed] intent; `src/lib/llm/quota.ts`, `circuitBreaker.ts` |
| NFR-COST-2 | Prefer **Gemini free tier** for LLM; use OpenAI only as bounded fallback | Router: Gemini always primary, OpenAI fallback | [Confirmed] `src/lib/llm/router.ts` |
| NFR-COST-3 | Track spend per call | `LlmCallLog.estimatedCostUsd`, `GeminiUsageLog` | [Confirmed] `prisma/schema.prisma` |

---

## 2. Third-party quota limits (as configured)

Defaults in `src/lib/llm/quota.ts` (`LIMITS`), overridable by env:

| Provider | RPM | TPM | RPD | Env overrides |
|----------|-----|-----|-----|---------------|
| **Gemini** | 12 | 32,000 | 1,120 | `GEMINI_RPM_LIMIT`, `GEMINI_TPM_LIMIT`, `GEMINI_RPD_LIMIT` |
| **OpenAI** | 480 | 160,000 | 9,000 | `OPENAI_RPM_LIMIT`, `OPENAI_TPM_LIMIT`, `OPENAI_RPD_LIMIT` |

- **NFR-QUOTA-1:** Requests are pre-checked and atomically reserved against RPM/TPM/RPD windows;
  a reservation only succeeds if `count + delta <= limit` (SQL-guarded). **[Confirmed]** `quota.ts`.
- **NFR-QUOTA-2:** Provider exhaustion is caught per-chunk: the advance route writes an `error`
  outcome to `ParseLog` for each affected candidate and marks the chunk `processed = true`
  (no transaction recorded). The job continues on subsequent ticks; the affected messages are
  not retried unless the auto-recovery condition is met (see NFR-REL-4). **[Confirmed]**
  `advance/route.ts:443–460, 568–571`.

---

## 3. Latency & serverless budget

The `Type` column classifies how each constraint is enforced:
- **Enforced** — a hard constant in code or config that cannot be exceeded.
- **Design** — architectural intent; not mechanically enforced at runtime.
- **Observed** — noted in code comments or router rationale; not measured under load.

| NFR | Constraint | Enforcement | Type | Status |
|-----|-----------|-------------|------|--------|
| NFR-LAT-1 | Sync advance must finish within the **60s** Vercel function limit | `maxDuration = 60` on advance route; chunked processing | Enforced | [Confirmed] `vercel.json`, `advance/route.ts:8` |
| NFR-LAT-2 | Process at most **25 emails per advance tick** (`CHUNK_SIZE`) to stay in budget | `CHUNK_SIZE = 25`, `take: CHUNK_SIZE` | Enforced | [Confirmed] `advance/route.ts:22,111` |
| NFR-LAT-3 | LLM calls time out at **30s** (per provider) | `GEMINI/OPENAI_TIMEOUT_MS ?? 30_000` | Enforced | [Confirmed] `llm/providers/*.ts` *(memory said 50s — **[Stale]**)* |
| NFR-LAT-4 | UI never blocks on slow sync — job created immediately, work async | start route returns jobId fast | Design | [Confirmed] `sync/start`; E2E T3.2; memory `feedback-sync-ux.md` |
| NFR-LAT-5 | Prefer Gemini for **lower latency** (2–10s vs 5–35s) at our batch sizes | router comment + default | Observed | [Confirmed] `router.ts` (comment; not measured under load) |

---

## 4. Scalability

| NFR | Target | Status |
|-----|--------|--------|
| NFR-SCALE-1 | Support **2–10 users** at POC stage | [Confirmed] intent (memory `project-overview.md`); isolation anchored by TENANT_ROOT (`User`); TENANT_SCOPED_ENFORCED models reference it via enforced `userId` FKs — TENANT_ROOT itself has no `userId` FK (it *is* the user) |
| NFR-SCALE-2 | Per-user data isolation | [Confirmed] every TENANT_SCOPED_ENFORCED model has `userId` + `onDelete: Cascade` (`schema.prisma`) — see 7-tier ownership taxonomy in `05-data-model-apis.md §1` |
| NFR-SCALE-3 | Resumable sync for large mailboxes | [Confirmed] `scanPageToken`, `SyncJobMessage` progress, chunking |
| NFR-SCALE-4 | Single-instance deploy on Vercel Hobby plan (no horizontal scaling in production) | `SyncJobLock` (distributed lock) is designed for multi-instance correctness, but Hobby plan runs one instance. Design supports scale; deployment does not. [Partial / Unverified — External Platform Configuration] `lock.ts`; Hobby plan single-instance constraint is Vercel platform documentation, not specified in `vercel.json` |

---

## 5. Reliability & resilience

| NFR | Mechanism | Status |
|-----|-----------|--------|
| NFR-REL-1 | **Circuit breaker** per LLM provider (CLOSED/OPEN/HALF_OPEN + probe) | [Confirmed] `circuitBreaker.ts`, `LlmCircuitBreaker` |
| NFR-REL-2 | **Idempotent** LLM batches (no double-charge/double-write on retry) | [Confirmed] `idempotency.ts`, `LlmBatchIdempotency` |
| NFR-REL-3 | **Distributed lock** prevents concurrent advance on same job | [Confirmed] `lock.ts`, `SyncJobLock` (owner token + expiry heartbeat) |
| NFR-REL-4 | **Auto-recovery** of stuck / single-error messages on later ticks | [Partial] advance route; commit `57d29dc`. Recovery resets only messages with exactly one error `ParseLog` entry and zero non-error entries (first-attempt failures only). Messages that error twice are not retried automatically. **[Partial — narrow condition]** `advance/route.ts:86–107`. |
| NFR-REL-5 | **One provider per tick** (removed within-tick fallback for predictability) | [Confirmed] commit `31a6077` |
| NFR-REL-6 | Graceful degradation to **empty states** when no data | [Confirmed] E2E T5.14, T10.2, T11.1 |
| NFR-REL-7 | Graceful error responses (404, 400 on malformed JSON, invalid id) | [Confirmed] E2E T14.1–T14.3 |

---

## 6. Data integrity

| NFR | Mechanism | Status |
|-----|-----------|--------|
| NFR-DATA-1 | No duplicate transactions | [Confirmed] `@@unique([userId, gmailMsgId])` + `@@unique([userId, fingerprint])` + `sourceRank` |
| NFR-DATA-2 | Deterministic parse audit trail | [Partial] `ParseLog` (outcome, confidence, `resolvedBy`, errorDetail) — emails missing from the Gmail batch response produce no `ParseLog` entry (REL-8 in `10`); all other outcomes are logged |
| NFR-DATA-3 | Cascade delete of user-owned rows | [Confirmed] `onDelete: Cascade` FKs |

---

## 7. Security & privacy (summary; full detail in `06`)

| NFR | Requirement | Status |
|-----|-------------|--------|
| NFR-SEC-1 | Gmail access is **read-only** | [Confirmed] `gmail.readonly` scope (`auth.config.ts`) |
| NFR-SEC-2 | Do **not** persist full email bodies long-term; store parsed data + message IDs | [Confirmed] no raw-body column in schema |
| NFR-SEC-3 | Statement passwords encrypted at rest (AES-256-GCM) | [Confirmed] `crypto.ts`, `StatementPassword.encryptedPassword` |
| NFR-SEC-4 | Cron endpoint authenticated (bearer) | [Confirmed] advance route; **finding:** also accepts `?secret=` query param — see `06` (HIGH) |
| NFR-SEC-5 | Secrets not committed to git | [Confirmed] `.env*` gitignored; `.env.local` **not** tracked (verified) — see `06` |

---

## 8. Maintainability / quality

| NFR | Target | Status |
|-----|--------|--------|
| NFR-QUAL-1 | Unit tests for core logic | [Partial] ~178 test blocks / 26 files in `tests/`; **gaps** in `staticParser.ts`, `vpaLookup.ts`, `merchantMaster.ts`, `gmailQuery.ts`, `categoryIcons.ts` — see `08` |
| NFR-QUAL-2 | E2E coverage of user flows | [Confirmed] 15 Playwright specs (`e2e/`) |
| NFR-QUAL-3 | Type safety | [Confirmed] TypeScript strict via Next 16 / TS 5.9 |

---

*Cross-references:* how these are realized → `04-architecture.md`; enforcing models/config →
`05-data-model-apis.md`; security detail → `06-security-authentication.md`.
