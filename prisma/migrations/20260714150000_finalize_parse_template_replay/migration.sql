-- Migration-history reconciliation, step 3 of 3.
--
-- Normalize the final ParseTemplate state after the historical migration has run. This is
-- idempotent on an already-migrated database and removes the transient repair marker.

BEGIN;

DO $$
DECLARE
  source_index REGCLASS;
  target_index REGCLASS;
BEGIN
  IF to_regclass('public."_fm_parse_template_replay_repair_20260726"') IS NULL THEN
    RAISE EXCEPTION
      'ParseTemplate replay-repair marker is missing; refusing reconciliation finalization';
  END IF;

  IF to_regclass('public."ParseTemplate"') IS NULL THEN
    RAISE EXCEPTION
      'historical ParseTemplate migration did not create ParseTemplate';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ParseLog'
      AND column_name = 'resolvedBy'
  ) THEN
    RAISE EXCEPTION
      'historical ParseTemplate migration did not create ParseLog.resolvedBy';
  END IF;

  ALTER TABLE "ParseTemplate" ALTER COLUMN "updatedAt" DROP DEFAULT;

  source_index :=
    to_regclass('public."ParseTemplate_userId_senderDomain_templateHash_parserVersion_ke"');
  target_index :=
    to_regclass('public."ParseTemplate_userId_senderDomain_templateHash_parserVersio_key"');

  IF source_index IS NOT NULL AND target_index IS NOT NULL THEN
    RAISE EXCEPTION
      'both legacy and normalized ParseTemplate unique indexes exist; refusing ambiguous reconciliation';
  END IF;

  IF target_index IS NULL THEN
    IF source_index IS NULL THEN
      RAISE EXCEPTION
        'ParseTemplate unique index is missing; refusing reconciliation finalization';
    END IF;

    ALTER INDEX
      "ParseTemplate_userId_senderDomain_templateHash_parserVersion_ke"
      RENAME TO
      "ParseTemplate_userId_senderDomain_templateHash_parserVersio_key";
  END IF;
END;
$$;

DROP TABLE "_fm_parse_template_replay_repair_20260726";

COMMIT;
