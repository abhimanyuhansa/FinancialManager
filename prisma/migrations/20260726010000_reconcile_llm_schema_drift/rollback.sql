-- DESTRUCTIVE: values written to these three columns after deployment will be lost.
-- Stop LLM writers and restore a reviewed snapshot if the values must be retained.

BEGIN;

ALTER TABLE "LlmCircuitBreaker"
  DROP COLUMN IF EXISTS "probeLeaseExpiresAt";

ALTER TABLE "LlmCallLog"
  DROP COLUMN IF EXISTS "finishReason",
  DROP COLUMN IF EXISTS "effectiveTimeoutMs";

COMMIT;
