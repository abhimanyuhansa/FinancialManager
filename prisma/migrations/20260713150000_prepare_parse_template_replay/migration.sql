-- Migration-history reconciliation, step 1 of 3.
--
-- The historical LLM migration sorts before the historical ParseTemplate migration even
-- though it depends on ParseTemplate. This bridge creates a transient bootstrap only during
-- a clean replay. On an already-migrated database it validates the historical state and is
-- intentionally data-preserving.

BEGIN;

CREATE TABLE "_fm_parse_template_replay_repair_20260726" (
  "singleton"                    BOOLEAN NOT NULL PRIMARY KEY DEFAULT true,
  "clean_replay_bootstrap"       BOOLEAN NOT NULL,
  "expected_llm_checksum"        TEXT    NOT NULL,
  "expected_template_checksum"   TEXT    NOT NULL,

  CONSTRAINT "chk_fm_parse_template_replay_singleton"
    CHECK ("singleton")
);

DO $$
DECLARE
  parse_template_migration_applied BOOLEAN;
  stored_llm_checksum              TEXT;
  stored_template_checksum         TEXT;
BEGIN
  -- prisma migrate diff --from-migrations applies SQL without creating its history table.
  -- migrate deploy does create it. Dynamic SQL keeps this bridge compatible with both modes.
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE $query$
      SELECT checksum
      FROM "_prisma_migrations"
      WHERE migration_name = $1
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    $query$
    INTO stored_llm_checksum
    USING '20260713222953_add_llm_routing_tables';

    EXECUTE $query$
      SELECT checksum
      FROM "_prisma_migrations"
      WHERE migration_name = $1
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    $query$
    INTO stored_template_checksum
    USING '20260714100000_add_parse_template';
  END IF;

  IF stored_llm_checksum IS NOT NULL
     AND stored_llm_checksum <> 'f471552d4b6f8f71a59b84a016de6ab7103c86982e91641975243eaa1bd8f09a'
  THEN
    RAISE EXCEPTION
      'historical LLM migration checksum mismatch; refusing replay reconciliation';
  END IF;

  IF stored_template_checksum IS NOT NULL
     AND stored_template_checksum <> 'd772055061a29a4c8a2f24af3ed04632e98115b3f960d8b14a9eb025064c4a0f'
  THEN
    RAISE EXCEPTION
      'historical ParseTemplate migration checksum mismatch; refusing replay reconciliation';
  END IF;

  parse_template_migration_applied := stored_template_checksum IS NOT NULL;

  INSERT INTO "_fm_parse_template_replay_repair_20260726" (
    "singleton",
    "clean_replay_bootstrap",
    "expected_llm_checksum",
    "expected_template_checksum"
  ) VALUES (
    true,
    NOT parse_template_migration_applied,
    'f471552d4b6f8f71a59b84a016de6ab7103c86982e91641975243eaa1bd8f09a',
    'd772055061a29a4c8a2f24af3ed04632e98115b3f960d8b14a9eb025064c4a0f'
  );

  IF parse_template_migration_applied THEN
    IF to_regclass('public."ParseTemplate"') IS NULL THEN
      RAISE EXCEPTION
        'ParseTemplate migration is recorded as applied but table is missing';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ParseLog'
        AND column_name = 'resolvedBy'
    ) THEN
      RAISE EXCEPTION
        'ParseTemplate migration is recorded as applied but ParseLog.resolvedBy is missing';
    END IF;

    RETURN;
  END IF;

  IF to_regclass('public."ParseTemplate"') IS NOT NULL THEN
    RAISE EXCEPTION
      'unmanaged ParseTemplate table exists before historical migration; refusing destructive bootstrap cleanup';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ParseLog'
      AND column_name = 'resolvedBy'
  ) THEN
    RAISE EXCEPTION
      'unmanaged ParseLog.resolvedBy exists before historical migration; refusing destructive bootstrap cleanup';
  END IF;

  ALTER TABLE "ParseLog" ADD COLUMN "resolvedBy" TEXT;

  CREATE TABLE "ParseTemplate" (
    "id"                   TEXT         NOT NULL,
    "userId"               TEXT         NOT NULL,
    "senderDomain"         TEXT         NOT NULL,
    "templateHash"         TEXT         NOT NULL,
    "parserVersion"        TEXT         NOT NULL,
    "taxonomyVersion"      TEXT         NOT NULL DEFAULT '',
    "status"               TEXT         NOT NULL,
    "subjectTemplate"      TEXT         NOT NULL,
    "bodyTemplate"         TEXT         NOT NULL,
    "extractors"           JSONB        NOT NULL,
    "hitCount"             INTEGER      NOT NULL DEFAULT 0,
    "failCount"            INTEGER      NOT NULL DEFAULT 0,
    "consecutiveSuccesses" INTEGER      NOT NULL DEFAULT 0,
    "consecutiveFailures"  INTEGER      NOT NULL DEFAULT 0,
    "promotedAt"           TIMESTAMP(3),
    "lastUsedAt"           TIMESTAMP(3),
    "lastFailedAt"         TIMESTAMP(3),
    "disabledReason"       TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParseTemplate_pkey" PRIMARY KEY ("id")
  );

  CREATE UNIQUE INDEX
    "ParseTemplate_userId_senderDomain_templateHash_parserVersion_key"
    ON "ParseTemplate"("userId", "senderDomain", "templateHash", "parserVersion");

  CREATE INDEX "ParseTemplate_userId_senderDomain_status_idx"
    ON "ParseTemplate"("userId", "senderDomain", "status");

  ALTER TABLE "ParseTemplate"
    ADD CONSTRAINT "ParseTemplate_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
END;
$$;

COMMIT;
