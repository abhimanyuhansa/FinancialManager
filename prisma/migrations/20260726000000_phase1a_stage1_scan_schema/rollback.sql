-- DESTRUCTIVE: use only after stopping Phase 1A writers and taking an approved backup/snapshot.
-- Prisma does not execute rollback.sql automatically. This file is for reviewed restore drills.

BEGIN;

DROP TABLE IF EXISTS "email_manual_classification" CASCADE;
DROP TABLE IF EXISTS "email_scan_item" CASCADE;
DROP TABLE IF EXISTS "email_scan_run" CASCADE;
DROP TABLE IF EXISTS "email_source" CASCADE;
DROP TABLE IF EXISTS "email_filter_version" CASCADE;
DROP TABLE IF EXISTS "email_filter" CASCADE;

DROP FUNCTION IF EXISTS "prevent_scan_item_parent_change"();
DROP FUNCTION IF EXISTS "check_scan_item_source_ownership"();
DROP FUNCTION IF EXISTS "prevent_email_filter_version_update"();

DROP INDEX IF EXISTS "account_disconnected_idx";
ALTER TABLE "Account"
  DROP CONSTRAINT IF EXISTS "chk_account_disconnection_coherence",
  DROP CONSTRAINT IF EXISTS "account_user_id_id_unique",
  DROP COLUMN IF EXISTS "disconnected_at",
  DROP COLUMN IF EXISTS "disconnection_reason";

COMMIT;
