# Decisions

## 2026-07-26 — Interim Gmail MVP

- The authoritative owner decisions supplied on 2026-07-26 supersede the earlier Phase 1A-first delivery order.
- `LLM_PARSING_ENABLED` is fail-closed: only the exact string `"true"` enables an LLM.
- Legacy ingestion remains enabled when its flag is unset during the interim MVP. Explicit `"false"` performs the later cutover; malformed values disable it.
- A deterministic parser miss is a completed processing outcome named `unparsed_llm_disabled`. It is stored in `ParseLog`, creates no transaction, and is not retried.
- Existing `ParseLog` storage is reused for the interim processing-review surface; no schema change is needed.
- Only ACTIVE deterministic templates may create transactions while LLM parsing is disabled. SHADOW and DEGRADED templates remain non-authoritative.
- Cron authentication is Bearer-header only. Secrets in URLs and browser bundles are prohibited.
- The test-auth seed route always returns 404 in production, regardless of environment flags.
- The legacy EmailFilter UI remains temporarily available but is explicitly labelled as non-operative for parsing.

## 2026-07-26 — Production smoke-test compatibility

- The live Neon database is not reset, cleaned, seeded, rolled back, or migrated during the smoke test.
- Until the pending Phase 1A account migration is approved, Prisma globally omits the two unused nullable Account fields that do not exist in live Neon.
- A returning Google OAuth sign-in persists newly issued access-token metadata and preserves the existing refresh token when Google does not return another one.
- Auth logging records only safe error classifications. OAuth account objects, tokens, email addresses, and stack dumps are prohibited.
- Parser misses are unique operationally by user, outcome, and Gmail message ID. New writes filter existing misses, and Processing Review returns one row per Gmail message even where historical duplicates exist.
- The successful sync job `startedAt` is the Gmail watermark. Incremental scans retain the existing one-day overlap and rely on transaction and review deduplication.
