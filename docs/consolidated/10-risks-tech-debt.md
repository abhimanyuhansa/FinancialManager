# 10 — Risks & Tech Debt

> **Baseline commit:** `31a607738f19ee3920a961e5cf347a6cf99a28f5`
> **Code baseline frozen:** 2026-07-14 — Pass 2 written; same commit anchor throughout.
> **Baseline anchor date:** 2026-07-14
> **Documentation finalized and frozen:** 2026-07-15 after Pass 7
> **Documentation commit:** `732056b82517355842dcf3ac1858ee56b2f0a5da`
> **Pass 7 corrections:** 2026-07-15 — Freeze metadata standardized. K-01.
> **Pass 3 corrections:** 2026-07-14 — REL-6 and REL-7 added (final-chunk silent data loss;
> LLM result array length mismatch).
> **Pass 4 corrections:** 2026-07-15 — REL-7 removed (invalid — `validateProviderResults()`
> in `validate.ts` throws on length mismatch; risk does not exist); REL-6 recovery text
> corrected (manual reprocessing available; auto-retry is not).
> **Pass 5 corrections:** 2026-07-15 — REL-6 title and severity summary row: "permanent"
> removed (manual reprocessing exists); OPS-2 "by design" replaced with [Unverified] reference
> to ADR-12. H-07.
> **Pass 6 corrections:** 2026-07-15 — REL-8 added (missing Gmail batch response silently
> skips email with no ParseLog or recovery path). I-03.
> **Pass 7 corrections:** 2026-07-15 — OPS-2 severity summary likelihood corrected:
> "High (by design)" removed (design intent unverified per ADR-12); replaced with
> "High (current global schema)". Freeze metadata standardized. J-01, J-04.

> Risk register and tech-debt catalog as of the baseline commit. Sources: security findings
> from `06`, implementation gaps from `08`, and code inspection during consolidation.
> Severity uses HIGH / MEDIUM / LOW. No code changes are recommended here — this is a
> read-only audit.

---

## 1. Security risks

Reproduced from `06-security-authentication.md §5`. See that document for full evidence and
source-line citations.

| # | Finding | Severity | Remediation |
|---|---------|----------|-------------|
| SEC-1 | `/api/test/auth-seed` — mints sessions if `ENABLE_TEST_AUTH_SEED` is set in prod | **HIGH** | Never set this env var in production; consider excluding route from prod builds |
| SEC-2 | `advance` route accepts `?secret=<CRON_SECRET>` query param — leaks into logs | **HIGH** | Accept secret via `Authorization: Bearer` header only; drop query-param path |
| SEC-3 | `NEXT_PUBLIC_CRON_SECRET` inlined into client bundle if set | **MEDIUM** | Don't expose cron secret to browser; move client-triggered advance behind session-authed server action |
| SEC-4 | OAuth `access_token`/`refresh_token` stored unencrypted in DB | **LOW/INFO** | Consider column-level encryption if threat model warrants |
| SEC-5 | Compromised OpenRouter key (historical) — operational follow-up required | follow-up | Rotate/revoke on OpenRouter account; see `12-open-questions.md` OQ-2 |
| SEC-6 | PII in LLM prompts (card numbers, account numbers, personal names sent to Gemini/OpenAI) | **MEDIUM** | `sanitize.ts` tokenizes high-risk fields; VPAs and amounts preserved for extraction. Residual: body truncation may still include sensitive narrative text. | [MITIGATED — 260dd90] |

---

## 2. Functional risks / partial implementations

| # | Risk | Details | Status |
|---|------|---------|--------|
| FUNC-1 | **Reconciliation UX unverified** | `ReconciliationLog` + `/api/gmail/reconcile` + `reconcile.ts` exist; end-to-end UI wiring unconfirmed | [Partial] — `08 §1.3` |
| FUNC-2 | **Review workflow UI unverified** | `Transaction.reviewed`/`needsReview` fields exist; no E2E covers the "needs review" surface in the transactions UI | [Partial] — `08 §1.3` |
| FUNC-3 | **EmailFilter legacy confusion** | `EmailFilter` model/API/UI (`/api/settings/filters`) still active; removed from parse pipeline. Operators may assume it pre-screens emails; it does not. | [Partial / misleading] — `08 §1.3` |
| FUNC-4 | **PDF password parsing not implemented** | Statement passwords stored (AES-256-GCM); `decrypt()` never called in parse path (`gmail.ts:27`). Password-protected PDFs are parsed without a password — will silently fail to extract data. | [Partial] — `08 §1.3`, `06 §3` |
| FUNC-5 | **`/api/user/data` DELETE is partial** | Only deletes Transaction/SyncJob/ParseLog/Asset + resets watermark. Account, Session, VpaMerchantMap, StatementPassword, LlmCallLog etc. are NOT deleted. | [Partial] — `08 §1.2`, `05 §2.7` |

---

## 3. Reliability risks

| # | Risk | Evidence | Severity |
|---|------|---------|---------|
| REL-1 | **Silent error swallowing in `reconcile.ts`** | Bare `catch {}` blocks suppress reconciliation errors without logging. Reconciliation failures are invisible. | MEDIUM |
| REL-2 | **Silent error swallowing in `parseTemplateCache.ts`** | Two `catch {}` blocks (template shadow-run failures). Template promotion/demotion errors may silently leave templates in wrong states. | MEDIUM |
| REL-3 | **No structured observability** | No Sentry, OpenTelemetry, or Datadog configured. All logging is `console.log` with `[prefix]` conventions (`[auth]`, `[gmail]`, `[gemini]`, `[dedup]`, `[reconcile]`, `[analytics]`). Vercel captures stdout but no alerting, no error aggregation, no distributed tracing. | MEDIUM |
| REL-4 | **No retry on Gmail token refresh failure** | If `refreshAccessToken` fails, the sync job will fail with an auth error. No retry or graceful degradation is implemented. | LOW |
| REL-5 | **`pdfParse()` called without password** | Even if a statement password is saved, `gmail.ts:27` calls `pdfParse(buffer)` with no password option. Encrypted PDFs will silently produce no transactions. No error is surfaced to the user. | MEDIUM (silent data loss) |
| REL-6 | **[RESOLVED 260dd90] Final-chunk LLM failure causes silent data loss requiring manual parse-log reprocessing** | `advance/route.ts:568–572` runs `updateMany({processed:true})` **unconditionally** on all pending rows in the chunk after LLM processing — even when the LLM call errors. On the final chunk, a failing LLM batch permanently marks those rows as `processed=true`; subsequent cron ticks skip them entirely because the advance query excludes already-processed rows. Manual parse-log reprocessing is available via `/api/settings/parse-logs/[id]/reprocess`; automatic job-level retry is not. **[Confirmed]** — `advance/route.ts:568–572`. | **HIGH** (silent data loss; manual recovery only) |
| REL-8 | **[RESOLVED 260dd90] Missing Gmail batch response silently drops an email** | `advance/route.ts:190` iterates `pending` and looks up each `gmailMsgId` in the batch response map (`fetchedMap.get(gmailMsgId)`). If the Gmail Batch API omits a requested message (transient error, rate-limit, deleted message), the `if (!msg) continue` skips it silently — no `ParseLog` is written and no error is recorded. The row is subsequently included in the unconditional `processed=true` update. The email permanently disappears from the pipeline with no transaction, no audit log, and no recovery path. **[Confirmed]** — `advance/route.ts:190, 568–572`. | **HIGH** (silent, unrecoverable data loss) |

---

## 4. Operational risks

| # | Risk | Details | Severity |
|---|------|---------|---------|
| OPS-1 | **No test coverage threshold** | Jest is configured with `--passWithNoTests`; no coverage floor. CI (if any) will pass even at 0% line coverage. | MEDIUM |
| OPS-2 | **SYSTEM_GLOBAL model mutations affect all users** | `GmailQueryKeyword`, `ExclusionRule`, `MerchantMaster`, `SubCategoryMaster` have no `userId`. Any authenticated user can add/modify/delete shared config. | MEDIUM — current implementation; design intent as single-operator POC is [Unverified — PM/Architect Decision Required] (see ADR-12 in `07`); escalates if user count grows |
| OPS-3 | **`buildGmailQuery()` legacy fallback** | `gmailQuery.ts` retains a static `buildGmailQuery()` fallback alongside the active `buildGmailQueryFromDB()`. Migration comment present. If the legacy path is accidentally invoked, it ignores DB-configured keywords. | LOW |
| OPS-4 | **No automated DB backup** | Neon free tier provides point-in-time restore; no explicit backup policy documented. | LOW (covered by Neon managed backups; not verified) |

---

## 5. Tech debt

| # | Item | File | Impact |
|---|------|------|--------|
| TD-1 | **`EmailFilter` model/API/UI still active post-removal from pipeline** | `prisma/schema.prisma`, `/api/settings/filters`, `settings/page.tsx` | Operator confusion: settings tab implies the filter actively pre-screens emails; it does not. Safe to retire or clearly label "legacy". |
| TD-2 | **`buildGmailQuery()` legacy fallback** | `src/lib/gmailQuery.ts` | When the DB-based query builder has been stable, the legacy fallback should be removed to avoid confusion and dead code. Migration comment marks it for removal. |
| TD-3 | **`reconcile/route.ts` uses deprecated `gemini-flash-latest` alias** | `src/app/api/gmail/reconcile/route.ts` | Google deprecated this alias. Reconciliation calls may fail or route to an unexpected model version. Should use `gemini-3.1-flash-lite` or the LLM subsystem router. |
| TD-4 | **Memory files have stale LLM model / test-count claims** | `memory/technical-decisions.md`, `memory/current-progress.md` | Low operational impact (memory is advisory); but stale claims can mislead future development sessions. Tracked in `08` §4 as recommended follow-up. |
| TD-5 | **`/api/user/data` DELETE described as full cascade in some contexts** | `src/app/api/user/data/route.ts` | Code explicitly deletes a subset; calling it a "cascade" is misleading. Documentation corrected in `05`, `08`. No code change needed; operator awareness required. |

---

## 6. Planned features not started

Per `08-implementation-status.md §1.4`:

| Feature | Status |
|---------|--------|
| Budgeting / goals engine | No code exists |
| Paid tiers / monetization | No billing, plan, or entitlement code |
| Multi-currency FX conversion | `currency` field stored; no conversion logic |
| Password-protected PDF parsing | Storage implemented; decryption not called in parse path |

---

## 7. Risk severity summary

| # | Risk | Severity | Likelihood | Impact | Recommended action |
|---|------|----------|-----------|--------|-------------------|
| SEC-1 | Auth-seed backdoor if enabled in prod | HIGH | Low (config error) | Critical (full auth bypass) | Document; enforce in deploy checklist |
| SEC-2 | Cron secret in query param | HIGH | Medium (logs often captured) | High (secret exposure) | Remove `?secret=` path; header only |
| REL-6 | Final-chunk LLM failure → silent data loss (manual reprocessing required) | **HIGH** | Medium (any LLM error on final chunk) | High (transactions permanently skipped) | **[RESOLVED 260dd90]** `llmFailedRowIds` guard prevents marking failed rows as processed |
| REL-8 | Missing Gmail batch response → silent unrecoverable drop | **HIGH** | Low-Medium (transient Gmail errors) | High (email permanently lost from pipeline) | **[RESOLVED 260dd90]** Error ParseLog written; missing rows excluded from processed=true |
| SEC-3 | Cron secret in client bundle | MEDIUM | Low (if var set correctly) | High (secret exposure) | Don't use `NEXT_PUBLIC_CRON_SECRET` = `CRON_SECRET` |
| REL-1 | Silent reconcile errors | MEDIUM | Medium | Medium (invisible failures) | Replace bare `catch` with error logging |
| REL-2 | Silent template cache errors | MEDIUM | Medium | Medium (wrong template state) | Replace bare `catch` with error logging |
| REL-3 | No structured observability | MEDIUM | High (permanent state) | Medium (hard to debug prod issues) | Add Sentry or OTel; low effort for POC |
| REL-5 | Encrypted PDFs silently fail | MEDIUM | Medium (any PDF statement user) | Medium (silent data loss) | Implement decrypt() call or surface error |
| FUNC-1 | Reconciliation UX unverified | MEDIUM | — | Medium (feature may not work) | Verify or document as not-yet-wired |
| OPS-2 | SYSTEM_GLOBAL shared mutations | MEDIUM | High (current global schema) | Medium (any user can corrupt config) | Current implementation; design intent [Unverified — PM/Architect Decision Required] (ADR-12); re-evaluate at scale |
| OPS-1 | No coverage threshold | MEDIUM | High (permanent state) | Low-Medium (regression risk) | Add Jest coverage floor |
| TD-3 | Deprecated Gemini alias in reconcile | MEDIUM | High (API deprecation) | Medium (reconcile calls fail) | Update model name |
| TD-1 | EmailFilter confusion | LOW | High (any developer reading settings) | Low (confusion, not failure) | Label legacy or retire |
| SEC-4 | OAuth tokens unencrypted | LOW/INFO | Low (DB compromise required) | Medium (read-only token exposure) | Consider column encryption |
| REL-4 | No Gmail token refresh retry | LOW | Low | Low (sync fails, recoverable) | Add one retry |

---

*Cross-references:* security findings detail → `06-security-authentication.md §5`; partial
implementations → `08-implementation-status.md §1.3`; test gaps → `09-testing-quality.md §5`;
open questions for PM decisions → `12-open-questions.md`.
