-- Migration-history reconciliation, step 2 of 3.
--
-- During clean replay only, remove the transient bootstrap after the historical LLM migration
-- has consumed it and before the historical ParseTemplate migration recreates the real objects.
-- On an already-migrated database the marker records a no-op and no domain object is changed.

BEGIN;

DO $$
DECLARE
  v_clean_replay_bootstrap BOOLEAN;
  v_template_migration_applied BOOLEAN := false;
  v_expected_llm_checksum TEXT;
  v_expected_template_checksum TEXT;
  v_parse_template_rows    BIGINT;
BEGIN
  IF to_regclass('public."_fm_parse_template_replay_repair_20260726"') IS NULL THEN
    RAISE EXCEPTION
      'ParseTemplate replay-repair marker is missing; refusing reconciliation reset';
  END IF;

  SELECT
    repair."clean_replay_bootstrap",
    repair."expected_llm_checksum",
    repair."expected_template_checksum"
    INTO
      v_clean_replay_bootstrap,
      v_expected_llm_checksum,
      v_expected_template_checksum
  FROM "_fm_parse_template_replay_repair_20260726" AS repair
  WHERE repair."singleton" = true;

  IF v_clean_replay_bootstrap IS NULL THEN
    RAISE EXCEPTION
      'ParseTemplate replay-repair marker is invalid; refusing reconciliation reset';
  END IF;

  IF v_expected_llm_checksum IS DISTINCT FROM
       'f471552d4b6f8f71a59b84a016de6ab7103c86982e91641975243eaa1bd8f09a'
     OR v_expected_template_checksum IS DISTINCT FROM
       'd772055061a29a4c8a2f24af3ed04632e98115b3f960d8b14a9eb025064c4a0f'
  THEN
    RAISE EXCEPTION
      'ParseTemplate replay-repair marker checksum metadata is invalid';
  END IF;

  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE migration_name = $1
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      )
    $query$
    INTO v_template_migration_applied
    USING '20260714100000_add_parse_template';
  END IF;

  IF v_clean_replay_bootstrap IS DISTINCT FROM
       (NOT v_template_migration_applied)
  THEN
    RAISE EXCEPTION
      'ParseTemplate replay-repair marker mode conflicts with migration history';
  END IF;

  IF NOT v_clean_replay_bootstrap THEN
    RETURN;
  END IF;

  IF to_regclass('public."ParseTemplate"') IS NULL THEN
    RAISE EXCEPTION
      'clean-replay ParseTemplate bootstrap is unexpectedly missing';
  END IF;

  EXECUTE 'SELECT count(*) FROM public."ParseTemplate"'
    INTO v_parse_template_rows;

  IF v_parse_template_rows <> 0 THEN
    RAISE EXCEPTION
      'clean-replay ParseTemplate bootstrap contains % row(s); refusing data loss',
      v_parse_template_rows;
  END IF;

  DROP TABLE "ParseTemplate";
  ALTER TABLE "ParseLog" DROP COLUMN "resolvedBy";
END;
$$;

COMMIT;
