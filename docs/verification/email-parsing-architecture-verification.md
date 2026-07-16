# Email Parsing Architecture — Verification Report

**Baseline commit:** `8b36c99acf033879bf31f284d620764530660b32`
**Final commit:** `260dd90a792ae0fb2d13f952ef26a93d28c1cec8`
**Date:** 2026-07-16
**Environment:** Local macOS + Neon Postgres (test DB)

## Pre-existing test state

244 tests, 29 suites, all passing before Task 6 changes (248 after Task 6 adds 4 MIME tests).

## Changes by task

| Task | Commit | Change |
|------|--------|--------|
| 0 | 8b36c99 | Commit in-progress `llmFailedRowIds` guard |
| 1 | (unstaged in 0) | REL-8: `missingRowIds` guard + error ParseLog for missing Gmail subresponses |
| 2 | (included) | Static parser: 5 parsers `NONE→INSUF` for unknown formats of known senders |
| 3 | (included) | Template hash: `normalizeToSkeleton()` before hashing |
| 4 | (included) | Subject in LLM input; `MAX_BATCH_SIZE=5` micro-batching |
| 5 | 03444e0 | PII minimization (`sanitize.ts`), prompt-injection guard in system prompt |
| 6 | 260dd90 | Recursive MIME part traversal (`extractBodyFromParts`) |
| 7 | (this commit) | Consolidated docs + verification report |

## Test results after all changes

```
Test Suites: 29 passed, 29 total
Tests:       248 passed, 248 total
Snapshots:   0 total
Time:        ~3s
```

## Finding verification

| Finding | Test location | Result |
|---------|--------------|--------|
| REL-6 — processed guard | `tests/lib/llm/index.test.ts` | PASS |
| REL-8 — missing subresponse | `tests/lib/advance.test.ts` | PASS |
| 3.1 — skeleton hash | `tests/lib/parseTemplateCache.test.ts` | PASS |
| 3.2 — static parser false negatives | `tests/lib/staticParser.test.ts` | PASS |
| 3.3 — micro-batch limit | `tests/lib/llm/index.test.ts` | PASS |
| 3.6 — PII minimization | `tests/lib/llm/sanitize.test.ts` | PASS |
| 3.8 — subject in prompt | `tests/lib/llm/prompts.test.ts` | PASS |
| 3.10 — recursive MIME | `tests/lib/gmail.test.ts` | PASS |

## Remaining limitations

1. **Dry-run with real Gmail data not performed** — Integration with live Gmail requires a test account and out-of-scope fixture corpus.
2. **Serverless budget dry-run** — Micro-batch slicing has not been timing-verified against real provider latency; `MAX_BATCH_SIZE=5` is conservative.
3. **PII minimization is best-effort** — Regex-based; novel PII formats not covered by `sanitize.ts` patterns may pass through.
4. **Statement password decrypt not implemented** — FUNC-4 remains open.
5. **LLM provider dry-run** — Provider calls were not exercised against live APIs; mock-based coverage only.
