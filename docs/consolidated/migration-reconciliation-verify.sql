-- =============================================================================
-- Historical migration replay and LLM schema-drift reconciliation verifier.
-- Run only against an isolated database after `prisma migrate deploy`.
--
-- Clean replay:
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" \
--     -f docs/consolidated/migration-reconciliation-verify.sql
--
-- Synthetic representative reconciliation:
--   psql -X -v ON_ERROR_STOP=1 -v RECONCILIATION_VALIDATE_REPRESENTATIVE=1 \
--     "$DATABASE_URL" -f docs/consolidated/migration-reconciliation-verify.sql
-- =============================================================================

\echo '--- RV1: exact successful migration history and immutable historical checksums ---'
DO $$
DECLARE
  actual_migrations   TEXT[];
  expected_migrations TEXT[] := ARRAY[
    '20260708235932_init',
    '20260709083711_add_syncjob_messageids',
    '20260709112945_add_user_email_verified',
    '20260709194629_plan9a_schema',
    '20260711150726_add_syncjob_scan_pagination',
    '20260711160000_add_syncjobmessage_table',
    '20260711220743_add_gemini_usage_log',
    '20260712154013_gmail_sync_redesign_v2',
    '20260712203815_add_vpa_merchant_map',
    '20260713000000_add_category_slug',
    '20260713150000_prepare_parse_template_replay',
    '20260713222953_add_llm_routing_tables',
    '20260714000000_add_subcategory',
    '20260714050000_reset_parse_template_replay',
    '20260714100000_add_parse_template',
    '20260714150000_finalize_parse_template_replay',
    '20260726000000_phase1a_stage1_scan_schema',
    '20260726010000_reconcile_llm_schema_drift'
  ];
  llm_checksum      TEXT;
  template_checksum TEXT;
BEGIN
  SELECT array_agg(migration_name ORDER BY migration_name)
    INTO actual_migrations
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  IF actual_migrations IS DISTINCT FROM expected_migrations THEN
    RAISE EXCEPTION
      'RV1 migration fingerprint mismatch: actual %, expected %',
      actual_migrations,
      expected_migrations;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL
      AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'RV1 unfinished migration record exists';
  END IF;

  SELECT checksum
    INTO llm_checksum
  FROM "_prisma_migrations"
  WHERE migration_name = '20260713222953_add_llm_routing_tables'
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  SELECT checksum
    INTO template_checksum
  FROM "_prisma_migrations"
  WHERE migration_name = '20260714100000_add_parse_template'
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  IF llm_checksum IS DISTINCT FROM
     'f471552d4b6f8f71a59b84a016de6ab7103c86982e91641975243eaa1bd8f09a'
  THEN
    RAISE EXCEPTION 'RV1 historical LLM checksum mismatch';
  END IF;

  IF template_checksum IS DISTINCT FROM
     'd772055061a29a4c8a2f24af3ed04632e98115b3f960d8b14a9eb025064c4a0f'
  THEN
    RAISE EXCEPTION 'RV1 historical ParseTemplate checksum mismatch';
  END IF;

  RAISE NOTICE 'PASS RV1: exact 18-migration history and historical checksums';
END;
$$;

\echo '--- RV2: repair marker removed and ParseTemplate normalized ---'
DO $$
DECLARE
  updated_at_default TEXT;
BEGIN
  IF to_regclass('public."_fm_parse_template_replay_repair_20260726"') IS NOT NULL THEN
    RAISE EXCEPTION 'RV2 transient replay-repair marker still exists';
  END IF;

  SELECT column_default
    INTO updated_at_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'ParseTemplate'
    AND column_name = 'updatedAt';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RV2 ParseTemplate.updatedAt is missing';
  END IF;

  IF updated_at_default IS NOT NULL THEN
    RAISE EXCEPTION
      'RV2 ParseTemplate.updatedAt default is %, expected NULL',
      updated_at_default;
  END IF;

  IF to_regclass(
       'public."ParseTemplate_userId_senderDomain_templateHash_parserVersio_key"'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'RV2 normalized ParseTemplate unique index is missing';
  END IF;

  IF to_regclass(
       'public."ParseTemplate_userId_senderDomain_templateHash_parserVersion_ke"'
     ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'RV2 truncated legacy ParseTemplate unique index remains';
  END IF;

  RAISE NOTICE 'PASS RV2: transient marker removed and ParseTemplate normalized';
END;
$$;

\echo '--- RV3: exact nullable LLM drift-column fingerprints ---'
DO $$
DECLARE
  actual_columns TEXT[];
  expected_columns TEXT[] := ARRAY[
    'LlmCallLog.effectiveTimeoutMs:integer:YES:',
    'LlmCallLog.finishReason:text:YES:',
    'LlmCircuitBreaker.probeLeaseExpiresAt:timestamp without time zone:YES:3'
  ];
BEGIN
  SELECT array_agg(
    table_name || '.' || column_name || ':' || data_type || ':' ||
    is_nullable || ':' || COALESCE(datetime_precision::text, '')
    ORDER BY table_name, column_name
  )
    INTO actual_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'LlmCallLog'
       AND column_name IN ('effectiveTimeoutMs', 'finishReason'))
      OR
      (table_name = 'LlmCircuitBreaker'
       AND column_name = 'probeLeaseExpiresAt')
    );

  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION
      'RV3 LLM drift-column fingerprint mismatch: actual %, expected %',
      actual_columns,
      expected_columns;
  END IF;

  RAISE NOTICE 'PASS RV3: exact nullable LLM drift-column fingerprints';
END;
$$;

\if :{?RECONCILIATION_VALIDATE_REPRESENTATIVE}
\echo '--- RV4: synthetic representative rows preserved ---'
DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM "ParseTemplate"
    WHERE id = 'migration-reconciliation-template'
      AND "hitCount" = 7
      AND "failCount" = 1
      AND "updatedAt" = TIMESTAMP '2026-01-05 00:00:00'
  ) <> 1 THEN
    RAISE EXCEPTION 'RV4 synthetic ParseTemplate row changed or is missing';
  END IF;

  IF (
    SELECT count(*)
    FROM "LlmCallLog"
    WHERE id = 'migration-reconciliation-llm-log'
      AND "effectiveTimeoutMs" IS NULL
      AND "finishReason" IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'RV4 synthetic LlmCallLog row changed or is missing';
  END IF;

  IF (
    SELECT count(*)
    FROM "LlmCircuitBreaker"
    WHERE provider = 'synthetic-provider'
      AND "probeLeaseExpiresAt" IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'RV4 synthetic LlmCircuitBreaker row changed or is missing';
  END IF;

  IF (SELECT count(*) FROM "User") <> 2
     OR (SELECT count(*) FROM "Account") <> 3
     OR (SELECT count(*) FROM "Transaction") <> 1
  THEN
    RAISE EXCEPTION 'RV4 representative baseline counts changed';
  END IF;

  RAISE NOTICE 'PASS RV4: synthetic representative rows and counts preserved';
END;
$$;
\else
\echo '--- RV4: representative fixture assertions skipped in clean-replay mode ---'
\endif

\echo '--- MIGRATION RECONCILIATION VERIFICATION COMPLETE ---'
