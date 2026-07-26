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
