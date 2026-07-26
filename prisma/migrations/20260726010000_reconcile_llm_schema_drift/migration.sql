-- Reconcile three nullable LLM columns that exist in schema.prisma but were never migrated.
-- ADD COLUMN IF NOT EXISTS supports production databases where a column may already have been
-- created manually; the following fingerprint checks fail closed if any existing type differs.

BEGIN;

ALTER TABLE "LlmCallLog"
  ADD COLUMN IF NOT EXISTS "effectiveTimeoutMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "finishReason" TEXT;

ALTER TABLE "LlmCircuitBreaker"
  ADD COLUMN IF NOT EXISTS "probeLeaseExpiresAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LlmCallLog'
      AND column_name = 'effectiveTimeoutMs'
      AND data_type = 'integer'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'LlmCallLog.effectiveTimeoutMs fingerprint mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LlmCallLog'
      AND column_name = 'finishReason'
      AND data_type = 'text'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'LlmCallLog.finishReason fingerprint mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LlmCircuitBreaker'
      AND column_name = 'probeLeaseExpiresAt'
      AND data_type = 'timestamp without time zone'
      AND datetime_precision = 3
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'LlmCircuitBreaker.probeLeaseExpiresAt fingerprint mismatch';
  END IF;
END;
$$;

COMMIT;
