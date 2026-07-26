-- =============================================================================
-- Financial Manager Phase 1A — Canonical DDL Dry Run (C81–C116 applied)
-- Execute against an isolated, disposable PostgreSQL database.
-- ON_ERROR_STOP=1 is required: any failure aborts immediately.
-- ROLLBACK at end leaves no permanent changes.
-- 15-point verification per governing instruction C84.
-- =============================================================================
-- Usage:
--   psql -X -v ON_ERROR_STOP=1 "$ISOLATED_DATABASE_URL" \
--     -L /tmp/fm_phase1a_dry_run.log \
--     -f docs/consolidated/phase1a-dry-run.sql
--
-- Optional interruption-recovery drill (expected non-zero exit):
--   psql -X -v ON_ERROR_STOP=1 -v PHASE1A_FAIL_AFTER_DDL=1 \
--     "$ISOLATED_DATABASE_URL" \
--     -L /tmp/fm_phase1a_interruption.log \
--     -f docs/consolidated/phase1a-dry-run.sql
-- A subsequent normal run must pass VP1 before applying DDL, proving that connection-close
-- rollback removed the interrupted transaction.

-- =============================================================================
-- C99: Capture baseline counts in a session-local TEMP TABLE before BEGIN.
-- ON COMMIT PRESERVE ROWS keeps the table and its data across the ROLLBACK.
-- =============================================================================
\echo '--- Baseline capture (pre-transaction) ---'
CREATE TEMP TABLE phase1a_dryrun_baseline (
  user_count    BIGINT NOT NULL,
  account_count BIGINT NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO phase1a_dryrun_baseline (user_count, account_count)
SELECT
  (SELECT COUNT(*) FROM "User"    WHERE id NOT LIKE 'dryrun-%'),
  (SELECT COUNT(*) FROM "Account" WHERE id NOT LIKE 'dryrun-%');

BEGIN;

\if :{?PHASE1A_VALIDATE_MIGRATED}
\echo '--- Migrated-schema mode: preserving installed DDL; validating it in place ---'
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
BEGIN
  SELECT array_agg(migration_name ORDER BY migration_name)
    INTO actual_migrations
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  IF actual_migrations IS DISTINCT FROM expected_migrations THEN
    RAISE EXCEPTION
      'FAIL migrated fingerprint: actual %, expected %',
      actual_migrations,
      expected_migrations;
  END IF;

  RAISE NOTICE 'PASS migrated fingerprint: exact 18-migration history';
END;
$$;
\else

-- =============================================================================
-- VP1: Baseline User and Account schema validation
-- =============================================================================
\echo '--- VP1: Baseline User and Account schema ---'

-- Assert required User columns exist
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(required_col, ', ')
  INTO missing
  FROM (VALUES ('id'),('email'),('createdAt')) AS t(required_col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = t.required_col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP1: User table missing required columns: %', missing;
  END IF;
  RAISE NOTICE 'PASS VP1: User required columns present';
END; $$;

-- Assert required Account columns exist
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(required_col, ', ')
  INTO missing
  FROM (VALUES ('id'),('userId'),('type'),('provider'),('providerAccountId')) AS t(required_col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Account' AND column_name = t.required_col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP1: Account table missing required columns: %', missing;
  END IF;
  RAISE NOTICE 'PASS VP1: Account required columns present';
END; $$;

-- C112: Exact pre-Phase-1A baseline fingerprint. A database with extra/missing User or
-- Account columns, an incomplete migration chain, or an unexpected later migration must fail.
DO $$
DECLARE
  actual_user_cols    TEXT[];
  actual_account_cols TEXT[];
  expected_user_cols  TEXT[] := ARRAY[
    'createdAt','email','emailVerified','gmailSyncedAt','id',
    'image','lastMessageId','name','syncFromDate'
  ];
  expected_account_cols TEXT[] := ARRAY[
    'access_token','expires_at','id','id_token','provider','providerAccountId',
    'refresh_token','scope','session_state','token_type','type','userId'
  ];
BEGIN
  SELECT array_agg(column_name ORDER BY column_name)
  INTO actual_user_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'User';

  SELECT array_agg(column_name ORDER BY column_name)
  INTO actual_account_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'Account';

  IF actual_user_cols IS DISTINCT FROM expected_user_cols THEN
    RAISE EXCEPTION
      'FAIL VP1: User column fingerprint mismatch. Actual: %, expected: %',
      actual_user_cols, expected_user_cols;
  END IF;
  IF actual_account_cols IS DISTINCT FROM expected_account_cols THEN
    RAISE EXCEPTION
      'FAIL VP1: Account column fingerprint mismatch. Actual: %, expected: %',
      actual_account_cols, expected_account_cols;
  END IF;

  RAISE NOTICE 'PASS VP1: Exact User and Account column fingerprints match';
END; $$;

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
    '20260714150000_finalize_parse_template_replay'
  ];
BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'FAIL VP1: _prisma_migrations table is missing';
  END IF;

  SELECT array_agg(migration_name ORDER BY migration_name)
  INTO actual_migrations
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;

  IF actual_migrations IS DISTINCT FROM expected_migrations THEN
    RAISE EXCEPTION
      'FAIL VP1: Applied migration fingerprint mismatch. Actual: %, expected: %',
      actual_migrations, expected_migrations;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL VP1: Unfinished, non-rolled-back Prisma migration exists';
  END IF;

  RAISE NOTICE 'PASS VP1: Exact 16-migration pre-Stage-1 baseline fingerprint matches';
END; $$;

-- Assert Phase 1A tables do not yet exist
DO $$
DECLARE
  existing_tables TEXT;
BEGIN
  SELECT string_agg(tablename, ', ')
  INTO existing_tables
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'email_filter','email_filter_version',
      'email_source','email_scan_run',
      'email_scan_item','email_manual_classification'
    );
  IF existing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP1: Phase 1A tables already exist in this database: %. Use a clean isolated database.', existing_tables;
  END IF;
  RAISE NOTICE 'PASS VP1: No pre-existing Phase 1A tables';
END; $$;

-- Assert account_user_id_id_unique does not yet exist (will be added in VP2)
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'u'
    AND conname = 'account_user_id_id_unique';
  IF cnt > 0 THEN
    RAISE EXCEPTION 'FAIL VP1: account_user_id_id_unique already exists before additive migration';
  END IF;
  RAISE NOTICE 'PASS VP1: account_user_id_id_unique not yet present';
END; $$;

-- Assert account_disconnected_idx does not yet exist
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'Account'
    AND indexname = 'account_disconnected_idx';
  IF cnt > 0 THEN
    RAISE EXCEPTION 'FAIL VP1: account_disconnected_idx already exists before additive migration';
  END IF;
  RAISE NOTICE 'PASS VP1: account_disconnected_idx not yet present';
END; $$;

-- Assert Account disconnection CHECK does not yet exist
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'c'
    AND conname = 'chk_account_disconnection_coherence';
  IF cnt > 0 THEN
    RAISE EXCEPTION
      'FAIL VP1: chk_account_disconnection_coherence already exists before additive migration';
  END IF;
  RAISE NOTICE 'PASS VP1: chk_account_disconnection_coherence not yet present';
END; $$;

-- C99: Assert no dryrun-% rows exist in User or Account before the dry run
DO $$
DECLARE
  leaked_users    BIGINT;
  leaked_accounts BIGINT;
BEGIN
  SELECT COUNT(*) INTO leaked_users    FROM "User"    WHERE id LIKE 'dryrun-%';
  SELECT COUNT(*) INTO leaked_accounts FROM "Account" WHERE id LIKE 'dryrun-%';
  IF leaked_users > 0 OR leaked_accounts > 0 THEN
    RAISE EXCEPTION
      'FAIL VP1: dryrun- rows already present before dry run — User: %, Account: %. Use a clean isolated database.',
      leaked_users, leaked_accounts;
  END IF;
  RAISE NOTICE 'PASS VP1: No pre-existing dryrun- rows in User or Account';
END; $$;

-- =============================================================================
-- VP2 (prep): Account additive changes
-- =============================================================================
\echo '--- VP2: Account additive changes ---'
ALTER TABLE "Account" ADD COLUMN disconnected_at TIMESTAMPTZ;
ALTER TABLE "Account" ADD COLUMN disconnection_reason TEXT;
ALTER TABLE "Account" ADD CONSTRAINT account_user_id_id_unique UNIQUE ("userId", id);
ALTER TABLE "Account"
  ADD CONSTRAINT chk_account_disconnection_coherence CHECK (
    (disconnected_at IS NULL AND disconnection_reason IS NULL)
    OR
    (disconnected_at IS NOT NULL
     AND disconnection_reason IN ('user_request','token_revoked','invalid_grant'))
  );
CREATE INDEX account_disconnected_idx
  ON "Account"(id)
  WHERE disconnected_at IS NOT NULL;

-- Assert both columns now exist
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(required_col, ', ')
  INTO missing
  FROM (VALUES ('disconnected_at'),('disconnection_reason')) AS t(required_col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Account' AND column_name = t.required_col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP2: Account additive columns missing after migration: %', missing;
  END IF;
  RAISE NOTICE 'PASS VP2: Account additive columns present';
END; $$;

-- Assert account_user_id_id_unique exists exactly once
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'u'
    AND conname = 'account_user_id_id_unique';
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL VP2: account_user_id_id_unique count = % (expected 1)', cnt;
  END IF;
  RAISE NOTICE 'PASS VP2: account_user_id_id_unique exists exactly once';
END; $$;

-- Assert account_disconnected_idx exists exactly once
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'Account'
    AND indexname = 'account_disconnected_idx';
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL VP2: account_disconnected_idx count = % (expected 1)', cnt;
  END IF;
  RAISE NOTICE 'PASS VP2: account_disconnected_idx exists exactly once';
END; $$;

-- =============================================================================
-- VP2: Six-table DDL
-- =============================================================================
\echo '--- VP2: Six-table DDL ---'

-- ---------------------------------------------------------------------------
-- Table 1: email_filter
-- ---------------------------------------------------------------------------
CREATE TABLE email_filter (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id             TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  gmail_account_id    TEXT        NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT,
  name                TEXT        NOT NULL,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  current_version_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, gmail_account_id, id),
  CONSTRAINT chk_email_filter_timestamps CHECK (updated_at >= created_at)
);
CREATE INDEX email_filter_user_idx ON email_filter(user_id);
CREATE INDEX email_filter_user_account_idx ON email_filter(user_id, gmail_account_id);

-- ---------------------------------------------------------------------------
-- Table 2: email_filter_version
-- ---------------------------------------------------------------------------
CREATE TABLE email_filter_version (
  id                       TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email_filter_id          TEXT        NOT NULL REFERENCES email_filter(id) ON DELETE CASCADE,
  version                  INTEGER     NOT NULL,
  gmail_query              TEXT        NOT NULL,
  include_rules_json       JSONB       NOT NULL DEFAULT '[]',
  exclude_rules_json       JSONB       NOT NULL DEFAULT '[]',
  rule_schema_version      INTEGER     NOT NULL DEFAULT 1,
  filter_evaluator_version INTEGER     NOT NULL DEFAULT 1,
  supersedes_version_id    TEXT        REFERENCES email_filter_version(id),
  created_by               TEXT        NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_filter_id, version),
  UNIQUE(email_filter_id, id),
  CONSTRAINT chk_email_filter_version_numbers CHECK (
    version > 0
    AND rule_schema_version > 0
    AND filter_evaluator_version > 0
  ),
  CONSTRAINT chk_email_filter_version_rule_arrays CHECK (
    jsonb_typeof(include_rules_json) = 'array'
    AND jsonb_typeof(exclude_rules_json) = 'array'
  )
);

-- Composite FK: supersedes_version_id must belong to same filter (deferred)
ALTER TABLE email_filter_version
  ADD CONSTRAINT fk_version_supersedes
  FOREIGN KEY (email_filter_id, supersedes_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Circular back-reference: current_version_id must belong to this filter (deferred)
ALTER TABLE email_filter
  ADD CONSTRAINT fk_email_filter_current_version
  FOREIGN KEY (id, current_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX email_filter_version_filter_idx ON email_filter_version(email_filter_id);

-- Immutability trigger
CREATE OR REPLACE FUNCTION prevent_email_filter_version_update()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'email_filter_version rows are immutable; create a new version row instead';
END;
$$;

CREATE TRIGGER trg_email_filter_version_immutable
  BEFORE UPDATE ON email_filter_version
  FOR EACH ROW EXECUTE FUNCTION prevent_email_filter_version_update();

-- ---------------------------------------------------------------------------
-- Table 3: email_source
-- ---------------------------------------------------------------------------
CREATE TABLE email_source (
  id                            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                       TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  gmail_account_id              TEXT        NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT,
  gmail_message_id              TEXT        NOT NULL,
  subject                       TEXT,
  normalized_subject            TEXT,
  sender_email                  TEXT,
  sender_name                   TEXT,
  sender_domain                 TEXT,
  received_at                   TIMESTAMPTZ,
  snippet_redacted              TEXT,
  gmail_thread_id               TEXT,
  gmail_labels                  TEXT[],
  has_attachment                BOOLEAN     NOT NULL DEFAULT false,
  attachment_metadata           JSONB,
  source_url                    TEXT,
  last_fetch_status             TEXT        NOT NULL DEFAULT 'DISCOVERED',
  last_fetch_attempt_at         TIMESTAMPTZ,
  last_fetch_error_code         TEXT,
  last_fetch_error_message_sanitized TEXT,
  current_manual_classification TEXT        NOT NULL DEFAULT 'UNREVIEWED',
  classification_version        INTEGER     NOT NULL DEFAULT 0,
  first_discovered_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at               TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retained_until                TIMESTAMPTZ,
  deleted_at                    TIMESTAMPTZ,
  UNIQUE(user_id, gmail_account_id, gmail_message_id),
  UNIQUE(user_id, id),
  CONSTRAINT chk_email_source_last_fetch_status CHECK (
    last_fetch_status IN ('DISCOVERED','FETCHING','FETCHED','PERMANENTLY_FAILED')
  ),
  CONSTRAINT chk_email_source_manual_classification CHECK (
    current_manual_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')
  ),
  CONSTRAINT chk_email_source_classification_version CHECK (classification_version >= 0),
  CONSTRAINT chk_email_source_fetch_timestamps CHECK (
    last_fetch_attempt_at IS NULL OR last_fetch_attempt_at >= first_discovered_at
  ),
  CONSTRAINT chk_email_source_fetched_timestamp CHECK (
    last_fetched_at IS NULL OR last_fetched_at >= first_discovered_at
  ),
  CONSTRAINT chk_email_source_timestamps CHECK (
    updated_at >= created_at
    AND (deleted_at IS NULL OR deleted_at >= created_at)
  )
);
CREATE INDEX email_source_user_account_fetch_idx
  ON email_source(user_id, gmail_account_id, last_fetch_status)
  WHERE deleted_at IS NULL;
CREATE INDEX email_source_user_account_discovered_idx
  ON email_source(user_id, gmail_account_id, first_discovered_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX email_source_manual_review_idx
  ON email_source(user_id, gmail_account_id, current_manual_classification)
  WHERE deleted_at IS NULL
    AND current_manual_classification IN ('UNREVIEWED','UNCERTAIN');

-- ---------------------------------------------------------------------------
-- Table 4: email_scan_run  (canonical field list — C81)
-- ---------------------------------------------------------------------------
CREATE TABLE email_scan_run (
  id                        TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                   TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  client_request_id         TEXT        NOT NULL,
  gmail_account_id          TEXT        NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT,
  email_filter_id           TEXT        NOT NULL REFERENCES email_filter(id) ON DELETE RESTRICT,
  email_filter_version_id   TEXT        NOT NULL REFERENCES email_filter_version(id) ON DELETE RESTRICT,
  -- C81: canonical field name (was gmail_query_snapshot)
  effective_gmail_query     TEXT        NOT NULL,
  from_date                 DATE        NOT NULL,
  to_date                   DATE        NOT NULL,
  scan_limit                INTEGER,
  discovery_page_token      TEXT,
  discovery_complete        BOOLEAN     NOT NULL DEFAULT false,
  status                    TEXT        NOT NULL DEFAULT 'CREATED',
  current_stage             TEXT,
  resume_stage              TEXT,
  state_version             INTEGER     NOT NULL DEFAULT 0,
  worker_lease_owner        TEXT,
  worker_lease_expires_at   TIMESTAMPTZ,
  next_retry_at             TIMESTAMPTZ,
  -- C81: scan-level retry fields
  retry_count               INTEGER     NOT NULL DEFAULT 0,
  max_retries               INTEGER     NOT NULL DEFAULT 5,
  max_item_retries          INTEGER     NOT NULL DEFAULT 3,
  -- C81: explicit snapshot fields (not relying on defaults)
  filter_rule_schema_version    INTEGER NOT NULL,
  filter_evaluator_version      INTEGER NOT NULL,
  -- C81: NOT NULL
  filter_snapshot_json          JSONB   NOT NULL,
  -- C81: counters (total_fetched/total_filter_included/total_filter_excluded removed)
  total_discovered          INTEGER     NOT NULL DEFAULT 0,
  fetch_pending_count       INTEGER     NOT NULL DEFAULT 0,
  fetch_in_progress_count   INTEGER     NOT NULL DEFAULT 0,
  fetch_success_count       INTEGER     NOT NULL DEFAULT 0,
  fetch_failed_count        INTEGER     NOT NULL DEFAULT 0,
  filter_included_count     INTEGER     NOT NULL DEFAULT 0,
  filter_excluded_count     INTEGER     NOT NULL DEFAULT 0,
  manual_review_count       INTEGER     NOT NULL DEFAULT 0,
  last_error_code           TEXT,
  last_error_message_sanitized TEXT,
  started_at                TIMESTAMPTZ,
  last_checkpoint_at        TIMESTAMPTZ,
  last_batch_started_at     TIMESTAMPTZ,
  last_batch_completed_at   TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  paused_at                 TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  batch_sequence            BIGINT      NOT NULL DEFAULT 0,
  pending_continuation_sequence     BIGINT,
  pending_continuation_stage        TEXT,
  pending_continuation_not_before   TIMESTAMPTZ,
  pending_continuation_published_at TIMESTAMPTZ,
  CONSTRAINT chk_pending_continuation_coherence CHECK (
    (pending_continuation_sequence IS NULL
     AND pending_continuation_stage IS NULL
     AND pending_continuation_not_before IS NULL
     AND pending_continuation_published_at IS NULL)
    OR
    (pending_continuation_sequence IS NOT NULL
     AND pending_continuation_stage IS NOT NULL
     AND pending_continuation_not_before IS NOT NULL)
  ),
  CONSTRAINT chk_pending_sequence_matches_scan_sequence CHECK (
    pending_continuation_sequence IS NULL
    OR pending_continuation_sequence = batch_sequence
  ),
  CONSTRAINT chk_scan_run_status CHECK (
    status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT','PAUSED',
               'COMPLETED','COMPLETED_WITH_ERRORS','FAILED','CANCELLING','CANCELLED')
  ),
  CONSTRAINT chk_scan_run_current_stage CHECK (
    current_stage IS NULL OR current_stage IN ('DISCOVERY','FETCH')
  ),
  CONSTRAINT chk_scan_run_resume_stage CHECK (
    resume_stage IS NULL OR resume_stage IN ('DISCOVERY','FETCH')
  ),
  CONSTRAINT chk_scan_run_pending_stage CHECK (
    pending_continuation_stage IS NULL
    OR pending_continuation_stage IN ('DISCOVERY','FETCH')
  ),
  CONSTRAINT chk_scan_run_date_range CHECK (from_date <= to_date),
  CONSTRAINT chk_scan_run_nonnegative_values CHECK (
    (scan_limit IS NULL OR scan_limit > 0)
    AND state_version >= 0
    AND retry_count >= 0
    AND max_retries >= 0
    AND max_item_retries >= 0
    AND total_discovered >= 0
    AND fetch_pending_count >= 0
    AND fetch_in_progress_count >= 0
    AND fetch_success_count >= 0
    AND fetch_failed_count >= 0
    AND filter_included_count >= 0
    AND filter_excluded_count >= 0
    AND manual_review_count >= 0
    AND batch_sequence >= 0
  ),
  CONSTRAINT chk_scan_run_counter_bounds CHECK (
    fetch_pending_count
      + fetch_in_progress_count
      + fetch_success_count
      + fetch_failed_count <= total_discovered
    AND fetch_pending_count <= total_discovered
    AND fetch_in_progress_count <= total_discovered
    AND fetch_success_count <= total_discovered
    AND fetch_failed_count <= total_discovered
    AND filter_included_count <= fetch_success_count
    AND filter_excluded_count <= fetch_success_count
    AND filter_included_count + filter_excluded_count <= fetch_success_count
    AND manual_review_count <= fetch_success_count
  ),
  CONSTRAINT chk_scan_run_stage_coherence CHECK (
    (
      status = 'CREATED'
      AND current_stage IS NULL
      AND resume_stage IS NULL
      AND started_at IS NULL
    )
    OR (
      status = 'DISCOVERING'
      AND current_stage = 'DISCOVERY'
      AND resume_stage IS NULL
      AND started_at IS NOT NULL
    )
    OR (
      status = 'FETCHING'
      AND current_stage = 'FETCH'
      AND resume_stage IS NULL
      AND started_at IS NOT NULL
    )
    OR (
      status IN ('RETRY_WAIT','PAUSED')
      AND current_stage IS NULL
      AND resume_stage IS NOT NULL
      AND started_at IS NOT NULL
    )
    OR (
      status = 'CANCELLING'
      AND started_at IS NOT NULL
      AND (
        (current_stage IS NOT NULL AND resume_stage IS NULL)
        OR (current_stage IS NULL AND resume_stage IS NOT NULL)
      )
    )
    OR (
      status IN ('CANCELLED','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
      AND current_stage IS NULL
      AND resume_stage IS NULL
      AND (
        status = 'CANCELLED'
        OR started_at IS NOT NULL
      )
    )
  ),
  CONSTRAINT chk_scan_run_lease_coherence CHECK (
    (worker_lease_owner IS NULL AND worker_lease_expires_at IS NULL)
    OR (
      worker_lease_owner IS NOT NULL
      AND worker_lease_expires_at IS NOT NULL
      AND status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT','CANCELLING')
    )
  ),
  CONSTRAINT chk_scan_run_retry_coherence CHECK (
    status <> 'RETRY_WAIT' OR next_retry_at IS NOT NULL
  ),
  CONSTRAINT chk_scan_run_pending_status CHECK (
    pending_continuation_sequence IS NULL
    OR status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT','PAUSED','CANCELLING')
  ),
  CONSTRAINT chk_scan_run_terminal_coherence CHECK (
    (
      status NOT IN ('CANCELLED','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
    )
    OR (
      worker_lease_owner IS NULL
      AND worker_lease_expires_at IS NULL
      AND next_retry_at IS NULL
      AND pending_continuation_sequence IS NULL
      AND pending_continuation_stage IS NULL
      AND pending_continuation_not_before IS NULL
      AND pending_continuation_published_at IS NULL
    )
  ),
  CONSTRAINT chk_scan_run_terminal_timestamps CHECK (
    (status NOT IN ('COMPLETED','COMPLETED_WITH_ERRORS') OR completed_at IS NOT NULL)
    AND (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
    AND (status <> 'PAUSED' OR paused_at IS NOT NULL)
  ),
  CONSTRAINT chk_scan_run_timestamps CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (last_checkpoint_at IS NULL OR started_at IS NULL OR last_checkpoint_at >= started_at)
    AND (last_batch_started_at IS NULL OR started_at IS NULL OR last_batch_started_at >= started_at)
    AND (
      last_batch_completed_at IS NULL
      OR (
        last_batch_started_at IS NOT NULL
        AND last_batch_completed_at >= last_batch_started_at
      )
    )
    AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    AND (paused_at IS NULL OR started_at IS NULL OR paused_at >= started_at)
    AND (cancelled_at IS NULL OR started_at IS NULL OR cancelled_at >= started_at)
  ),
  UNIQUE(user_id, client_request_id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_scan_run_filter_ownership
  FOREIGN KEY (user_id, gmail_account_id, email_filter_id)
  REFERENCES email_filter (user_id, gmail_account_id, id);

ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_scan_run_filter_version
  FOREIGN KEY (email_filter_id, email_filter_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  ON DELETE RESTRICT;

CREATE INDEX email_scan_run_user_status_idx ON email_scan_run(user_id, status);
CREATE INDEX email_scan_run_user_account_idx ON email_scan_run(user_id, gmail_account_id);
CREATE INDEX email_scan_run_retry_idx ON email_scan_run(next_retry_at)
  WHERE status = 'RETRY_WAIT';
CREATE INDEX email_scan_run_lease_idx ON email_scan_run(worker_lease_expires_at)
  WHERE worker_lease_owner IS NOT NULL;
CREATE INDEX email_scan_run_continuation_recovery_idx
  ON email_scan_run(pending_continuation_not_before)
  WHERE pending_continuation_sequence IS NOT NULL
    AND pending_continuation_published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Table 5: email_scan_item
-- ---------------------------------------------------------------------------
CREATE TABLE email_scan_item (
  id                            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scan_run_id                   TEXT        NOT NULL REFERENCES email_scan_run(id) ON DELETE CASCADE,
  email_source_id               TEXT        NOT NULL REFERENCES email_source(id) ON DELETE RESTRICT,
  status                        TEXT        NOT NULL DEFAULT 'DISCOVERED',
  state_version                 INTEGER     NOT NULL DEFAULT 0,
  fetch_attempt_count           INTEGER     NOT NULL DEFAULT 0,
  next_retry_at                 TIMESTAMPTZ,
  last_error_code               TEXT,
  last_error_message_sanitized  TEXT,
  item_lease_owner              TEXT,
  item_lease_expires_at         TIMESTAMPTZ,
  filter_decision               TEXT        NOT NULL DEFAULT 'PENDING',
  matched_include_rule_ids      TEXT[],
  matched_exclude_rule_ids      TEXT[],
  filter_decision_reason_sanitized TEXT,
  discovered_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_started_at              TIMESTAMPTZ,
  fetch_completed_at            TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scan_run_id, email_source_id),
  CONSTRAINT chk_scan_item_status CHECK (
    status IN ('DISCOVERED','FETCHING','FETCHED','RETRY_WAIT','PERMANENTLY_FAILED','CANCELLED')
  ),
  CONSTRAINT chk_scan_item_filter_decision CHECK (
    filter_decision IN ('PENDING','INCLUDED','EXCLUDED')
  ),
  CONSTRAINT chk_scan_item_nonnegative_values CHECK (
    state_version >= 0 AND fetch_attempt_count >= 0
  ),
  CONSTRAINT chk_scan_item_lease_coherence CHECK (
    (status = 'FETCHING'
     AND item_lease_owner IS NOT NULL
     AND item_lease_expires_at IS NOT NULL)
    OR
    (status <> 'FETCHING'
     AND item_lease_owner IS NULL
     AND item_lease_expires_at IS NULL)
  ),
  CONSTRAINT chk_scan_item_retry_coherence CHECK (
    (status = 'RETRY_WAIT' AND next_retry_at IS NOT NULL)
    OR
    (status <> 'RETRY_WAIT' AND next_retry_at IS NULL)
  ),
  CONSTRAINT chk_scan_item_filter_coherence CHECK (
    (status = 'FETCHED')
    OR (filter_decision = 'PENDING')
  ),
  CONSTRAINT chk_scan_item_terminal_timestamps CHECK (
    (
      status NOT IN ('FETCHED','PERMANENTLY_FAILED')
      OR fetch_completed_at IS NOT NULL
    )
    AND (status <> 'FETCHING' OR fetch_started_at IS NOT NULL)
  ),
  CONSTRAINT chk_scan_item_timestamps CHECK (
    updated_at >= discovered_at
    AND (fetch_started_at IS NULL OR fetch_started_at >= discovered_at)
    AND (
      fetch_completed_at IS NULL
      OR (
        fetch_started_at IS NOT NULL
        AND fetch_completed_at >= fetch_started_at
      )
    )
  )
);
CREATE INDEX email_scan_item_run_status_idx ON email_scan_item(scan_run_id, status);
CREATE INDEX email_scan_item_source_idx ON email_scan_item(email_source_id);
CREATE INDEX email_scan_item_retry_idx ON email_scan_item(next_retry_at)
  WHERE status = 'RETRY_WAIT';
CREATE INDEX email_scan_item_lease_idx ON email_scan_item(item_lease_expires_at)
  WHERE item_lease_owner IS NOT NULL;
CREATE INDEX email_scan_item_filter_decision_idx
  ON email_scan_item(scan_run_id, filter_decision)
  WHERE status = 'FETCHED';

-- Cross-table ownership trigger
CREATE OR REPLACE FUNCTION check_scan_item_source_ownership()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.email_source_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM email_source es
      JOIN email_scan_run esr ON esr.id = NEW.scan_run_id
      WHERE es.id = NEW.email_source_id
        AND es.user_id = esr.user_id
        AND es.gmail_account_id = esr.gmail_account_id
    ) THEN
      RAISE EXCEPTION
        'email_scan_item.email_source_id does not belong to same user/gmail_account_id as scan run';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_email_scan_item_source_ownership
  AFTER INSERT OR UPDATE OF email_source_id, scan_run_id ON email_scan_item
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION check_scan_item_source_ownership();

-- Parent-field immutability trigger
CREATE OR REPLACE FUNCTION prevent_scan_item_parent_change()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.scan_run_id IS DISTINCT FROM OLD.scan_run_id THEN
    RAISE EXCEPTION 'email_scan_item.scan_run_id is immutable after creation';
  END IF;
  IF NEW.email_source_id IS DISTINCT FROM OLD.email_source_id THEN
    RAISE EXCEPTION 'email_scan_item.email_source_id is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_email_scan_item_parent_immutable
  BEFORE UPDATE ON email_scan_item
  FOR EACH ROW EXECUTE FUNCTION prevent_scan_item_parent_change();

-- ---------------------------------------------------------------------------
-- Table 6: email_manual_classification
-- ---------------------------------------------------------------------------
CREATE TABLE email_manual_classification (
  id                        TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                   TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  email_source_id           TEXT        NOT NULL,
  previous_classification   TEXT        NOT NULL,
  new_classification        TEXT        NOT NULL,
  reason                    TEXT,
  classified_by             TEXT        REFERENCES "User"(id) ON DELETE SET NULL,
  classified_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  classification_version    INTEGER     NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_source_id, classification_version),
  CONSTRAINT chk_manual_previous_classification CHECK (
    previous_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')
  ),
  CONSTRAINT chk_manual_new_classification CHECK (
    new_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')
  ),
  CONSTRAINT chk_manual_classification_version CHECK (classification_version > 0),
  CONSTRAINT chk_manual_classification_change CHECK (
    previous_classification <> new_classification
  ),
  CONSTRAINT chk_manual_classification_timestamps CHECK (
    created_at >= classified_at
  )
);
CREATE INDEX email_manual_classification_source_idx
  ON email_manual_classification(email_source_id, classified_at DESC);
CREATE INDEX email_manual_classification_user_idx
  ON email_manual_classification(user_id, classified_at DESC);

ALTER TABLE email_manual_classification
  ADD CONSTRAINT fk_classification_source
  FOREIGN KEY (user_id, email_source_id)
  REFERENCES email_source (user_id, id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-table composite FKs: user+account ownership
-- ---------------------------------------------------------------------------
ALTER TABLE email_filter
  ADD CONSTRAINT fk_email_filter_account
  FOREIGN KEY (user_id, gmail_account_id)
  REFERENCES "Account" ("userId", id)
  ON DELETE RESTRICT;

ALTER TABLE email_source
  ADD CONSTRAINT fk_email_source_account
  FOREIGN KEY (user_id, gmail_account_id)
  REFERENCES "Account" ("userId", id)
  ON DELETE RESTRICT;

ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_email_scan_run_account
  FOREIGN KEY (user_id, gmail_account_id)
  REFERENCES "Account" ("userId", id)
  ON DELETE RESTRICT;

\endif

-- =============================================================================
-- VP2b: Exact six-table column fingerprints (C112)
-- =============================================================================
\echo '--- VP2b: Exact Phase 1A column fingerprints ---'
DO $$
DECLARE
  rec RECORD;
  actual_cols TEXT[];
BEGIN
  FOR rec IN
    SELECT *
    FROM (VALUES
      ('email_filter', ARRAY[
        'id','user_id','gmail_account_id','name','is_active','current_version_id',
        'created_at','updated_at'
      ]::TEXT[]),
      ('email_filter_version', ARRAY[
        'id','email_filter_id','version','gmail_query','include_rules_json',
        'exclude_rules_json','rule_schema_version','filter_evaluator_version',
        'supersedes_version_id','created_by','created_at'
      ]::TEXT[]),
      ('email_source', ARRAY[
        'id','user_id','gmail_account_id','gmail_message_id','subject',
        'normalized_subject','sender_email','sender_name','sender_domain','received_at',
        'snippet_redacted','gmail_thread_id','gmail_labels','has_attachment',
        'attachment_metadata','source_url','last_fetch_status','last_fetch_attempt_at',
        'last_fetch_error_code','last_fetch_error_message_sanitized',
        'current_manual_classification','classification_version','first_discovered_at',
        'last_fetched_at','created_at','updated_at','retained_until','deleted_at'
      ]::TEXT[]),
      ('email_scan_run', ARRAY[
        'id','user_id','client_request_id','gmail_account_id','email_filter_id',
        'email_filter_version_id','effective_gmail_query','from_date','to_date',
        'scan_limit','discovery_page_token','discovery_complete','status','current_stage',
        'resume_stage','state_version','worker_lease_owner','worker_lease_expires_at',
        'next_retry_at','retry_count','max_retries','max_item_retries',
        'filter_rule_schema_version','filter_evaluator_version','filter_snapshot_json',
        'total_discovered','fetch_pending_count','fetch_in_progress_count',
        'fetch_success_count','fetch_failed_count','filter_included_count',
        'filter_excluded_count','manual_review_count','last_error_code',
        'last_error_message_sanitized','started_at','last_checkpoint_at',
        'last_batch_started_at','last_batch_completed_at','completed_at','paused_at',
        'cancelled_at','batch_sequence','pending_continuation_sequence',
        'pending_continuation_stage','pending_continuation_not_before',
        'pending_continuation_published_at','created_at','updated_at'
      ]::TEXT[]),
      ('email_scan_item', ARRAY[
        'id','scan_run_id','email_source_id','status','state_version',
        'fetch_attempt_count','next_retry_at','last_error_code',
        'last_error_message_sanitized','item_lease_owner','item_lease_expires_at',
        'filter_decision','matched_include_rule_ids','matched_exclude_rule_ids',
        'filter_decision_reason_sanitized','discovered_at','fetch_started_at',
        'fetch_completed_at','updated_at'
      ]::TEXT[]),
      ('email_manual_classification', ARRAY[
        'id','user_id','email_source_id','previous_classification','new_classification',
        'reason','classified_by','classified_at','classification_version','created_at'
      ]::TEXT[])
    ) AS expected(table_name, columns)
  LOOP
    SELECT array_agg(column_name ORDER BY ordinal_position)
    INTO actual_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = rec.table_name;

    IF actual_cols IS DISTINCT FROM rec.columns THEN
      RAISE EXCEPTION
        'FAIL VP2b: % column fingerprint mismatch. Actual: %, expected: %',
        rec.table_name, actual_cols, rec.columns;
    END IF;
  END LOOP;

  RAISE NOTICE 'PASS VP2b: Exact column fingerprints match for all six tables';
END; $$;

-- =============================================================================
-- VP3: Account additive changes confirmed (assertions)
-- =============================================================================
\echo '--- VP3: Account additive changes confirmed ---'

DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(required_col, ', ')
  INTO missing
  FROM (VALUES ('disconnected_at'),('disconnection_reason')) AS t(required_col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Account' AND column_name = t.required_col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP3: Account additive columns missing: %', missing;
  END IF;
  RAISE NOTICE 'PASS VP3: Account additive columns confirmed present';
END; $$;

DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'u'
    AND conname = 'account_user_id_id_unique';
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL VP3: account_user_id_id_unique count = % (expected 1)', cnt;
  END IF;
  RAISE NOTICE 'PASS VP3: account_user_id_id_unique present exactly once';
END; $$;

DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'Account'
    AND indexname = 'account_disconnected_idx';
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL VP3: account_disconnected_idx count = % (expected 1)', cnt;
  END IF;
  RAISE NOTICE 'PASS VP3: account_disconnected_idx present exactly once';
END; $$;

DO $$
DECLARE
  definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid, TRUE)
  INTO definition
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'c'
    AND conname = 'chk_account_disconnection_coherence';

  IF definition IS NULL
     OR definition NOT LIKE '%disconnected_at IS NULL%'
     OR definition NOT LIKE '%disconnection_reason%'
     OR definition NOT LIKE '%user_request%'
     OR definition NOT LIKE '%token_revoked%'
     OR definition NOT LIKE '%invalid_grant%' THEN
    RAISE EXCEPTION
      'FAIL VP3: chk_account_disconnection_coherence missing or structurally incorrect: %',
      definition;
  END IF;

  RAISE NOTICE 'PASS VP3: Account disconnection CHECK present with approved reasons';
END; $$;

-- =============================================================================
-- VP4: FK structural inventory — bidirectional 22-FK set comparison (C105)
-- =============================================================================
\echo '--- VP4: FK structural inventory (22-FK EXCEPT comparison) ---'

-- C105: Bidirectional structural set comparison — no dependency on PostgreSQL-generated FK names
-- Action codes: 'a'=NO ACTION, 'r'=RESTRICT, 'c'=CASCADE, 'n'=SET NULL
-- ON UPDATE is NO ACTION ('a') for all 22 FKs.
DO $$
DECLARE
  rec           RECORD;
  actual_count  INT;
  missing_count INT;
  extra_count   INT;
  dup_count     INT;
BEGIN
  -- 1. Count check
  SELECT COUNT(*) INTO actual_count
  FROM pg_constraint c
  JOIN pg_class     rc ON rc.oid = c.conrelid
  WHERE c.contype = 'f'
    AND rc.relname IN (
      'email_filter','email_filter_version',
      'email_source','email_scan_run',
      'email_scan_item','email_manual_classification'
    );

  IF actual_count <> 22 THEN
    RAISE EXCEPTION 'FAIL VP4: FK count = % (expected exactly 22)', actual_count;
  END IF;

  -- 2. Duplicate structural definition check.
  -- Build one row per FK first. Joining conkey/confkey unnests directly would create an
  -- N×N Cartesian product for composite keys and falsely report every composite FK as a
  -- duplicate (C111).
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT
      fk.src_tbl,
      fk.src_cols,
      fk.ref_tbl,
      fk.ref_cols,
      fk.confdeltype,
      fk.condeferrable,
      fk.condeferred
    FROM (
      SELECT
        c.oid,
        rc.relname AS src_tbl,
        (
          SELECT string_agg(sa.attname, ',' ORDER BY u.pos)
          FROM unnest(c.conkey) WITH ORDINALITY u(attnum, pos)
          JOIN pg_attribute sa
            ON sa.attrelid = c.conrelid AND sa.attnum = u.attnum
        ) AS src_cols,
        rr.relname AS ref_tbl,
        (
          SELECT string_agg(ra.attname, ',' ORDER BY v.pos)
          FROM unnest(c.confkey) WITH ORDINALITY v(attnum, pos)
          JOIN pg_attribute ra
            ON ra.attrelid = c.confrelid AND ra.attnum = v.attnum
        ) AS ref_cols,
        c.confdeltype,
        c.condeferrable,
        c.condeferred
      FROM pg_constraint c
      JOIN pg_class rc ON rc.oid = c.conrelid
      JOIN pg_class rr ON rr.oid = c.confrelid
      WHERE c.contype = 'f'
        AND rc.relname IN (
          'email_filter','email_filter_version',
          'email_source','email_scan_run',
          'email_scan_item','email_manual_classification'
        )
    ) fk
    GROUP BY
      fk.src_tbl,
      fk.src_cols,
      fk.ref_tbl,
      fk.ref_cols,
      fk.confdeltype,
      fk.condeferrable,
      fk.condeferred
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'FAIL VP4: % duplicate structural FK definition(s) detected', dup_count;
  END IF;

  -- 3. expected MINUS actual: every expected FK must exist in the catalog
  SELECT COUNT(*) INTO missing_count FROM (
    SELECT src_tbl, src_cols, ref_tbl, ref_cols, confdeltype, condeferrable, condeferred
    FROM (VALUES
      -- email_filter (4)
      ('email_filter',  'user_id',                                   'User',                 'id',                         'c', FALSE, FALSE),
      ('email_filter',  'gmail_account_id',                          'Account',              'id',                         'r', FALSE, FALSE),
      ('email_filter',  'id,current_version_id',                     'email_filter_version', 'email_filter_id,id',         'a', TRUE,  TRUE ),
      ('email_filter',  'user_id,gmail_account_id',                  'Account',              'userId,id',                  'r', FALSE, FALSE),
      -- email_filter_version (3)
      ('email_filter_version', 'email_filter_id',                    'email_filter',         'id',                         'c', FALSE, FALSE),
      ('email_filter_version', 'supersedes_version_id',              'email_filter_version', 'id',                         'a', FALSE, FALSE),
      ('email_filter_version', 'email_filter_id,supersedes_version_id','email_filter_version','email_filter_id,id',        'a', TRUE,  TRUE ),
      -- email_source (3)
      ('email_source',  'user_id',                                   'User',                 'id',                         'c', FALSE, FALSE),
      ('email_source',  'gmail_account_id',                          'Account',              'id',                         'r', FALSE, FALSE),
      ('email_source',  'user_id,gmail_account_id',                  'Account',              'userId,id',                  'r', FALSE, FALSE),
      -- email_scan_run (7)
      ('email_scan_run','user_id',                                   'User',                 'id',                         'c', FALSE, FALSE),
      ('email_scan_run','gmail_account_id',                          'Account',              'id',                         'r', FALSE, FALSE),
      ('email_scan_run','email_filter_id',                           'email_filter',         'id',                         'r', FALSE, FALSE),
      ('email_scan_run','email_filter_version_id',                   'email_filter_version', 'id',                         'r', FALSE, FALSE),
      ('email_scan_run','user_id,gmail_account_id,email_filter_id',  'email_filter',         'user_id,gmail_account_id,id','a', FALSE, FALSE),
      ('email_scan_run','email_filter_id,email_filter_version_id',   'email_filter_version', 'email_filter_id,id',         'r', FALSE, FALSE),
      ('email_scan_run','user_id,gmail_account_id',                  'Account',              'userId,id',                  'r', FALSE, FALSE),
      -- email_scan_item (2)
      ('email_scan_item','scan_run_id',                              'email_scan_run',       'id',                         'c', FALSE, FALSE),
      ('email_scan_item','email_source_id',                          'email_source',         'id',                         'r', FALSE, FALSE),
      -- email_manual_classification (3)
      ('email_manual_classification','user_id',                      'User',                 'id',                         'c', FALSE, FALSE),
      ('email_manual_classification','classified_by',                'User',                 'id',                         'n', FALSE, FALSE),
      ('email_manual_classification','user_id,email_source_id',      'email_source',         'user_id,id',                 'c', FALSE, FALSE)
    ) AS exp(src_tbl, src_cols, ref_tbl, ref_cols, confdeltype, condeferrable, condeferred)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class rc ON rc.oid = c.conrelid
      JOIN pg_class rr ON rr.oid = c.confrelid
      WHERE c.contype = 'f'
        AND rc.relname = exp.src_tbl
        AND rr.relname = exp.ref_tbl
        AND c.confdeltype = exp.confdeltype
        AND c.condeferrable = exp.condeferrable
        AND c.condeferred   = exp.condeferred
        AND (
          SELECT string_agg(sa.attname, ',' ORDER BY u.pos)
          FROM unnest(c.conkey) WITH ORDINALITY u(attnum, pos)
          JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = u.attnum
        ) = exp.src_cols
        AND (
          SELECT string_agg(ra.attname, ',' ORDER BY v.pos)
          FROM unnest(c.confkey) WITH ORDINALITY v(attnum, pos)
          JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = v.attnum
        ) = exp.ref_cols
    )
  ) missing;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'FAIL VP4: % expected FK(s) not found in catalog (expected MINUS actual is non-empty)', missing_count;
  END IF;

  -- 4. actual MINUS expected: no unexpected FKs may exist on these tables
  SELECT COUNT(*) INTO extra_count FROM (
    SELECT c.oid
    FROM pg_constraint c
    JOIN pg_class rc ON rc.oid = c.conrelid
    JOIN pg_class rr ON rr.oid = c.confrelid
    WHERE c.contype = 'f'
      AND rc.relname IN (
        'email_filter','email_filter_version',
        'email_source','email_scan_run',
        'email_scan_item','email_manual_classification'
      )
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES
        ('email_filter',  'user_id',                                   'User',                 'id',                         'c', FALSE, FALSE),
        ('email_filter',  'gmail_account_id',                          'Account',              'id',                         'r', FALSE, FALSE),
        ('email_filter',  'id,current_version_id',                     'email_filter_version', 'email_filter_id,id',         'a', TRUE,  TRUE ),
        ('email_filter',  'user_id,gmail_account_id',                  'Account',              'userId,id',                  'r', FALSE, FALSE),
        ('email_filter_version', 'email_filter_id',                    'email_filter',         'id',                         'c', FALSE, FALSE),
        ('email_filter_version', 'supersedes_version_id',              'email_filter_version', 'id',                         'a', FALSE, FALSE),
        ('email_filter_version', 'email_filter_id,supersedes_version_id','email_filter_version','email_filter_id,id',        'a', TRUE,  TRUE ),
        ('email_source',  'user_id',                                   'User',                 'id',                         'c', FALSE, FALSE),
        ('email_source',  'gmail_account_id',                          'Account',              'id',                         'r', FALSE, FALSE),
        ('email_source',  'user_id,gmail_account_id',                  'Account',              'userId,id',                  'r', FALSE, FALSE),
        ('email_scan_run','user_id',                                   'User',                 'id',                         'c', FALSE, FALSE),
        ('email_scan_run','gmail_account_id',                          'Account',              'id',                         'r', FALSE, FALSE),
        ('email_scan_run','email_filter_id',                           'email_filter',         'id',                         'r', FALSE, FALSE),
        ('email_scan_run','email_filter_version_id',                   'email_filter_version', 'id',                         'r', FALSE, FALSE),
        ('email_scan_run','user_id,gmail_account_id,email_filter_id',  'email_filter',         'user_id,gmail_account_id,id','a', FALSE, FALSE),
        ('email_scan_run','email_filter_id,email_filter_version_id',   'email_filter_version', 'email_filter_id,id',         'r', FALSE, FALSE),
        ('email_scan_run','user_id,gmail_account_id',                  'Account',              'userId,id',                  'r', FALSE, FALSE),
        ('email_scan_item','scan_run_id',                              'email_scan_run',       'id',                         'c', FALSE, FALSE),
        ('email_scan_item','email_source_id',                          'email_source',         'id',                         'r', FALSE, FALSE),
        ('email_manual_classification','user_id',                      'User',                 'id',                         'c', FALSE, FALSE),
        ('email_manual_classification','classified_by',                'User',                 'id',                         'n', FALSE, FALSE),
        ('email_manual_classification','user_id,email_source_id',      'email_source',         'user_id,id',                 'c', FALSE, FALSE)
      ) AS exp(src_tbl, src_cols, ref_tbl, ref_cols, confdeltype, condeferrable, condeferred)
      WHERE exp.src_tbl = rc.relname
        AND exp.ref_tbl = rr.relname
        AND exp.confdeltype  = c.confdeltype
        AND exp.condeferrable = c.condeferrable
        AND exp.condeferred   = c.condeferred
        AND exp.src_cols = (
          SELECT string_agg(sa.attname, ',' ORDER BY u.pos)
          FROM unnest(c.conkey) WITH ORDINALITY u(attnum, pos)
          JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = u.attnum
        )
        AND exp.ref_cols = (
          SELECT string_agg(ra.attname, ',' ORDER BY v.pos)
          FROM unnest(c.confkey) WITH ORDINALITY v(attnum, pos)
          JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = v.attnum
        )
    )
  ) extra;

  IF extra_count > 0 THEN
    RAISE EXCEPTION 'FAIL VP4: % unexpected FK(s) found on Phase 1A tables (actual MINUS expected is non-empty)', extra_count;
  END IF;

  RAISE NOTICE 'PASS VP4: All 22 FKs present with exact structural definitions; no missing, extra, or duplicate FKs';
END; $$;

-- =============================================================================
-- VP5: Trigger inventory — exact table, function, timing, level, event, deferrable
-- =============================================================================
\echo '--- VP5: Trigger inventory (exact definitions) ---'

-- C103: Assert exact count first — wrong-table or misnamed triggers must fail even when count matches
DO $$
DECLARE
  trigger_count INT;
BEGIN
  SELECT COUNT(*) INTO trigger_count
  FROM pg_trigger
  WHERE tgrelid::regclass::text IN ('email_filter_version','email_scan_item')
    AND tgname NOT LIKE 'RI_%';
  IF trigger_count <> 3 THEN
    RAISE EXCEPTION 'FAIL VP5: Trigger count on schema tables = % (expected exactly 3)', trigger_count;
  END IF;
  RAISE NOTICE 'PASS VP5: Trigger count = 3 on expected tables';
END; $$;

-- C103/C106: Exact definition assertions for each trigger — exact tgtype values, tgenabled, tgattr
DO $$
DECLARE
  tg    pg_trigger%ROWTYPE;
  fnam  TEXT;
  cond     BOOLEAN;
  cdeferred BOOLEAN;
  src_attnums  INT2VECTOR;
  exp_attnums  INT2VECTOR;
BEGIN
  -- ──────────────────────────────────────────────────────────────────────────
  -- 1. trg_email_filter_version_immutable
  --    tgtype=19 (BEFORE UPDATE ROW, non-constraint)
  --    function: prevent_email_filter_version_update | tgattr empty | tgenabled='O'
  -- ──────────────────────────────────────────────────────────────────────────
  SELECT t.* INTO tg
  FROM pg_trigger t
  WHERE t.tgname = 'trg_email_filter_version_immutable';
  IF tg IS NULL THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable not found';
  END IF;
  IF tg.tgrelid <> 'email_filter_version'::regclass THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable is on table % (expected email_filter_version)',
      tg.tgrelid::regclass;
  END IF;
  IF tg.tgtype <> 19 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable tgtype = % (expected 19 = BEFORE UPDATE ROW)', tg.tgtype;
  END IF;
  IF tg.tgconstraint <> 0 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable should not be a constraint trigger';
  END IF;
  IF tg.tgenabled <> 'O' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable tgenabled = % (expected O)', tg.tgenabled;
  END IF;
  IF tg.tgattr <> '' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable tgattr should be empty (no column filter)';
  END IF;
  SELECT p.proname INTO fnam FROM pg_proc p WHERE p.oid = tg.tgfoid;
  IF fnam <> 'prevent_email_filter_version_update' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_filter_version_immutable function = % (expected prevent_email_filter_version_update)', fnam;
  END IF;
  RAISE NOTICE 'PASS VP5: trg_email_filter_version_immutable — tgtype=19, tgenabled=O, tgattr empty, function correct';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 2. trg_email_scan_item_source_ownership
  --    tgtype=21 (AFTER INSERT OR UPDATE ROW, constraint)
  --    DEFERRABLE INITIALLY IMMEDIATE | tgenabled='O'
  --    tgattr contains exactly attnums for email_source_id and scan_run_id
  --    function: check_scan_item_source_ownership
  -- ──────────────────────────────────────────────────────────────────────────
  SELECT t.* INTO tg
  FROM pg_trigger t
  WHERE t.tgname = 'trg_email_scan_item_source_ownership';
  IF tg IS NULL THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership not found';
  END IF;
  IF tg.tgrelid <> 'email_scan_item'::regclass THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership is on table % (expected email_scan_item)',
      tg.tgrelid::regclass;
  END IF;
  IF tg.tgtype <> 21 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership tgtype = % (expected 21 = AFTER INSERT OR UPDATE ROW)', tg.tgtype;
  END IF;
  IF tg.tgconstraint = 0 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership must be a constraint trigger';
  END IF;
  IF tg.tgenabled <> 'O' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership tgenabled = % (expected O)', tg.tgenabled;
  END IF;
  -- tgattr must contain exactly the attnums for email_source_id and scan_run_id
  SELECT string_agg(a.attnum::TEXT, ',' ORDER BY a.attname)
  INTO fnam  -- reusing fnam as scratch text
  FROM pg_attribute a
  WHERE a.attrelid = 'email_scan_item'::regclass
    AND a.attname IN ('email_source_id', 'scan_run_id');
  IF (
    SELECT COUNT(*) FROM unnest(tg.tgattr) col_attnum
    JOIN pg_attribute a ON a.attrelid = 'email_scan_item'::regclass AND a.attnum = col_attnum
    WHERE a.attname NOT IN ('email_source_id', 'scan_run_id')
  ) > 0 OR (
    SELECT COUNT(*) FROM unnest(tg.tgattr) col_attnum
  ) <> 2 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership tgattr must contain exactly email_source_id and scan_run_id';
  END IF;
  -- DEFERRABLE INITIALLY IMMEDIATE
  SELECT c.condeferrable, c.condeferred
  INTO cond, cdeferred
  FROM pg_constraint c
  WHERE c.oid = tg.tgconstraint;
  IF NOT cond THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership constraint is not DEFERRABLE';
  END IF;
  IF cdeferred THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership constraint should be INITIALLY IMMEDIATE (not deferred)';
  END IF;
  SELECT p.proname INTO fnam FROM pg_proc p WHERE p.oid = tg.tgfoid;
  IF fnam <> 'check_scan_item_source_ownership' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_source_ownership function = % (expected check_scan_item_source_ownership)', fnam;
  END IF;
  RAISE NOTICE 'PASS VP5: trg_email_scan_item_source_ownership — tgtype=21, tgenabled=O, tgattr exact, deferrable, function correct';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 3. trg_email_scan_item_parent_immutable
  --    tgtype=19 (BEFORE UPDATE ROW, non-constraint)
  --    function: prevent_scan_item_parent_change | tgattr empty | tgenabled='O'
  -- ──────────────────────────────────────────────────────────────────────────
  SELECT t.* INTO tg
  FROM pg_trigger t
  WHERE t.tgname = 'trg_email_scan_item_parent_immutable';
  IF tg IS NULL THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable not found';
  END IF;
  IF tg.tgrelid <> 'email_scan_item'::regclass THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable is on table % (expected email_scan_item)',
      tg.tgrelid::regclass;
  END IF;
  IF tg.tgtype <> 19 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable tgtype = % (expected 19 = BEFORE UPDATE ROW)', tg.tgtype;
  END IF;
  IF tg.tgconstraint <> 0 THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable should not be a constraint trigger';
  END IF;
  IF tg.tgenabled <> 'O' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable tgenabled = % (expected O)', tg.tgenabled;
  END IF;
  IF tg.tgattr <> '' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable tgattr should be empty (no column filter)';
  END IF;
  SELECT p.proname INTO fnam FROM pg_proc p WHERE p.oid = tg.tgfoid;
  IF fnam <> 'prevent_scan_item_parent_change' THEN
    RAISE EXCEPTION 'FAIL VP5: trg_email_scan_item_parent_immutable function = % (expected prevent_scan_item_parent_change)', fnam;
  END IF;
  RAISE NOTICE 'PASS VP5: trg_email_scan_item_parent_immutable — tgtype=19, tgenabled=O, tgattr empty, function correct';
END; $$;

-- Report trigger details for inspection
SELECT tgname AS trigger_name, tgrelid::regclass AS table_name,
       tgenabled,
       CASE tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       CASE tgtype & 1 WHEN 1 THEN 'ROW' ELSE 'STMT' END AS level
FROM pg_trigger
WHERE tgrelid::regclass::text IN ('email_filter_version','email_scan_item')
  AND tgname NOT LIKE 'RI_%'
ORDER BY tgrelid::regclass::text, tgname;

-- =============================================================================
-- VP5b: Exact CHECK-constraint and supporting-index inventories (C109/C112/C115)
-- =============================================================================
\echo '--- VP5b: Exact CHECK and supporting-index inventories ---'

DO $$
DECLARE
  actual_checks   TEXT[];
  expected_checks TEXT[] := ARRAY[
    'chk_email_filter_timestamps',
    'chk_email_filter_version_numbers',
    'chk_email_filter_version_rule_arrays',
    'chk_email_source_classification_version',
    'chk_email_source_fetch_timestamps',
    'chk_email_source_fetched_timestamp',
    'chk_email_source_last_fetch_status',
    'chk_email_source_manual_classification',
    'chk_email_source_timestamps',
    'chk_manual_classification_change',
    'chk_manual_classification_timestamps',
    'chk_manual_classification_version',
    'chk_manual_new_classification',
    'chk_manual_previous_classification',
    'chk_pending_continuation_coherence',
    'chk_pending_sequence_matches_scan_sequence',
    'chk_scan_item_filter_coherence',
    'chk_scan_item_filter_decision',
    'chk_scan_item_lease_coherence',
    'chk_scan_item_nonnegative_values',
    'chk_scan_item_retry_coherence',
    'chk_scan_item_status',
    'chk_scan_item_terminal_timestamps',
    'chk_scan_item_timestamps',
    'chk_scan_run_counter_bounds',
    'chk_scan_run_current_stage',
    'chk_scan_run_date_range',
    'chk_scan_run_lease_coherence',
    'chk_scan_run_nonnegative_values',
    'chk_scan_run_pending_stage',
    'chk_scan_run_pending_status',
    'chk_scan_run_resume_stage',
    'chk_scan_run_retry_coherence',
    'chk_scan_run_stage_coherence',
    'chk_scan_run_status',
    'chk_scan_run_terminal_coherence',
    'chk_scan_run_terminal_timestamps',
    'chk_scan_run_timestamps'
  ];
BEGIN
  SELECT array_agg(c.conname ORDER BY c.conname)
  INTO actual_checks
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.contype = 'c'
    AND r.relname IN (
      'email_filter','email_filter_version',
      'email_source','email_scan_run',
      'email_scan_item','email_manual_classification'
    );

  IF actual_checks IS DISTINCT FROM expected_checks THEN
    RAISE EXCEPTION
      'FAIL VP5b: Phase 1A CHECK inventory mismatch. Actual: %, expected: %',
      actual_checks, expected_checks;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"Account"'::regclass
      AND contype = 'c'
      AND conname = 'chk_account_disconnection_coherence'
  ) THEN
    RAISE EXCEPTION 'FAIL VP5b: chk_account_disconnection_coherence missing';
  END IF;

  RAISE NOTICE 'PASS VP5b: Exact 38-table CHECK inventory plus Account disconnection CHECK present';
END; $$;

DO $$
DECLARE
  actual_indexes   TEXT[];
  expected_indexes TEXT[] := ARRAY[
    'account_disconnected_idx',
    'email_filter_user_account_idx',
    'email_filter_user_idx',
    'email_filter_version_filter_idx',
    'email_manual_classification_source_idx',
    'email_manual_classification_user_idx',
    'email_scan_item_filter_decision_idx',
    'email_scan_item_lease_idx',
    'email_scan_item_retry_idx',
    'email_scan_item_run_status_idx',
    'email_scan_item_source_idx',
    'email_scan_run_continuation_recovery_idx',
    'email_scan_run_lease_idx',
    'email_scan_run_retry_idx',
    'email_scan_run_user_account_idx',
    'email_scan_run_user_status_idx',
    'email_source_manual_review_idx',
    'email_source_user_account_discovered_idx',
    'email_source_user_account_fetch_idx'
  ];
BEGIN
  SELECT array_agg(idx.relname ORDER BY idx.relname)
  INTO actual_indexes
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_class tbl ON tbl.oid = i.indrelid
  JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
  LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
  WHERE ns.nspname = 'public'
    AND con.oid IS NULL
    AND (
      (tbl.relname = 'Account' AND idx.relname = 'account_disconnected_idx')
      OR tbl.relname IN (
        'email_filter','email_filter_version',
        'email_source','email_scan_run',
        'email_scan_item','email_manual_classification'
      )
    );

  IF actual_indexes IS DISTINCT FROM expected_indexes THEN
    RAISE EXCEPTION
      'FAIL VP5b: Supporting-index inventory mismatch. Actual: %, expected: %',
      actual_indexes, expected_indexes;
  END IF;

  RAISE NOTICE 'PASS VP5b: All 19 named supporting indexes present';
END; $$;

-- C116: Optional deterministic interruption drill. With ON_ERROR_STOP=1, psql exits and closes
-- the connection; PostgreSQL must roll back this open transaction. The next normal invocation
-- proves recovery by passing the exact VP1 baseline fingerprint before reapplying the DDL.
\if :{?PHASE1A_FAIL_AFTER_DDL}
DO $$
BEGIN
  RAISE EXCEPTION
    'EXPECTED INTERRUPTION DRILL: close connection and verify rollback with a normal rerun';
END; $$;
\endif

-- =============================================================================
-- TEST DATA SETUP (synthetic rows; no production data)
-- =============================================================================
\echo '--- Test data setup ---'
INSERT INTO "User" (id, email, "createdAt")
  VALUES
    ('dryrun-u1', 'dryrun-u1@test.invalid', now()),
    ('dryrun-u2', 'dryrun-u2@test.invalid', now());

INSERT INTO "Account" (id, "userId", type, provider, "providerAccountId")
  VALUES
    ('dryrun-a1', 'dryrun-u1', 'oauth', 'google', 'ga-dryrun-1'),
    ('dryrun-a2', 'dryrun-u1', 'oauth', 'google', 'ga-dryrun-2'),
    ('dryrun-a3', 'dryrun-u2', 'oauth', 'google', 'ga-dryrun-3');

INSERT INTO email_filter (id, user_id, gmail_account_id, name)
  VALUES ('dryrun-f1','dryrun-u1','dryrun-a1','Test Filter');

INSERT INTO email_filter_version (id, email_filter_id, version, gmail_query, created_by)
  VALUES ('dryrun-fv1','dryrun-f1',1,'from:bank@example.com','dryrun-u1');

UPDATE email_filter SET current_version_id = 'dryrun-fv1' WHERE id = 'dryrun-f1';

INSERT INTO email_source (id, user_id, gmail_account_id, gmail_message_id, subject)
  VALUES ('dryrun-es1','dryrun-u1','dryrun-a1','msg1','Bank Statement');

-- C81: use effective_gmail_query; include explicit filter_rule_schema_version,
--      filter_evaluator_version, filter_snapshot_json (NOT NULL)
INSERT INTO email_scan_run (
  id, user_id, client_request_id, gmail_account_id,
  email_filter_id, email_filter_version_id,
  effective_gmail_query, from_date, to_date,
  filter_rule_schema_version, filter_evaluator_version,
  filter_snapshot_json,
  batch_sequence,
  pending_continuation_sequence, pending_continuation_stage, pending_continuation_not_before
) VALUES (
  'dryrun-sr1','dryrun-u1','req1','dryrun-a1',
  'dryrun-f1','dryrun-fv1',
  'from:bank@example.com', '2026-01-01', '2026-07-01',
  1, 1,
  '{"include_rules":[],"exclude_rules":[]}',
  0, 0, 'DISCOVERY', now()
);

INSERT INTO email_scan_item (id, scan_run_id, email_source_id)
  VALUES ('dryrun-si1','dryrun-sr1','dryrun-es1');

INSERT INTO email_manual_classification (
  id, user_id, email_source_id,
  previous_classification, new_classification,
  classification_version
) VALUES ('dryrun-mc1','dryrun-u1','dryrun-es1','UNREVIEWED','FINANCIAL',1);
UPDATE email_source
SET current_manual_classification = 'FINANCIAL',
    classification_version = 1,
    updated_at = now()
WHERE id = 'dryrun-es1' AND classification_version = 0;

DO $$
DECLARE
  src_classification TEXT;
  src_version        INTEGER;
  history_version    INTEGER;
BEGIN
  SELECT current_manual_classification, classification_version
  INTO src_classification, src_version
  FROM email_source
  WHERE id = 'dryrun-es1';

  SELECT classification_version
  INTO history_version
  FROM email_manual_classification
  WHERE id = 'dryrun-mc1';

  IF src_classification <> 'FINANCIAL'
     OR src_version <> 1
     OR history_version <> src_version THEN
    RAISE EXCEPTION
      'FAIL classification fixture: source/history mismatch class %, source version %, history version %',
      src_classification, src_version, history_version;
  END IF;
  RAISE NOTICE 'PASS classification fixture: source materialization and history version agree at 1';
END; $$;

-- =============================================================================
-- VP6: Deferred circular-FK operational test (C96)
-- =============================================================================
\echo '--- VP6: Deferred circular FK operational test ---'

-- C96 positive test: insert filter + two versions (v2 supersedes v1), set current_version_id,
-- then force both deferred FKs IMMEDIATE to prove constraints actually evaluate correctly.
DO $$
BEGIN
  -- Bootstrap: second version that supersedes dryrun-fv1 (same filter dryrun-f1)
  INSERT INTO email_filter_version (id, email_filter_id, version, gmail_query, created_by, supersedes_version_id)
    VALUES ('dryrun-fv2', 'dryrun-f1', 2, 'from:bank@example.com v2', 'dryrun-u1', 'dryrun-fv1');

  -- Advance current_version_id to the new version
  UPDATE email_filter SET current_version_id = 'dryrun-fv2' WHERE id = 'dryrun-f1';

  -- Force both deferred FKs to immediate evaluation; must not raise an exception
  SET CONSTRAINTS fk_email_filter_current_version, fk_version_supersedes IMMEDIATE;

  RAISE NOTICE 'PASS VP6 positive: SET CONSTRAINTS IMMEDIATE succeeded — both deferred FKs evaluate correctly';

  -- Restore to DEFERRED so the rest of the transaction can proceed freely
  SET CONSTRAINTS fk_email_filter_current_version, fk_version_supersedes DEFERRED;
END; $$;

-- C96 negative test: a supersedes_version_id from a DIFFERENT filter must be rejected
-- when fk_version_supersedes is forced IMMEDIATE.
DO $$
BEGIN
  -- Create a second filter and a version belonging to it
  INSERT INTO email_filter (id, user_id, gmail_account_id, name)
    VALUES ('dryrun-f2', 'dryrun-u1', 'dryrun-a1', 'Other Filter');
  INSERT INTO email_filter_version (id, email_filter_id, version, gmail_query, created_by)
    VALUES ('dryrun-fv-other', 'dryrun-f2', 1, 'from:other@example.com', 'dryrun-u1');
  UPDATE email_filter SET current_version_id = 'dryrun-fv-other' WHERE id = 'dryrun-f2';

  BEGIN
    -- Attempt: version for f1 that references a version belonging to f2
    INSERT INTO email_filter_version (id, email_filter_id, version, gmail_query, created_by, supersedes_version_id)
      VALUES ('dryrun-fv-bad', 'dryrun-f1', 3, 'q', 'dryrun-u1', 'dryrun-fv-other');

    SET CONSTRAINTS fk_version_supersedes IMMEDIATE;

    -- Should never reach here
    RAISE EXCEPTION 'FAIL VP6 negative: cross-filter supersedes_version_id was NOT rejected';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'PASS VP6 negative: cross-filter supersedes_version_id correctly rejected by fk_version_supersedes';
    WHEN OTHERS THEN
      RAISE EXCEPTION 'FAIL VP6 negative: unexpected error %: %', SQLSTATE, SQLERRM;
  END;

  -- Restore deferred for subsequent steps
  SET CONSTRAINTS fk_email_filter_current_version, fk_version_supersedes DEFERRED;
END; $$;

-- =============================================================================
-- VP7: Cross-user negative tests
-- =============================================================================
\echo '--- VP7: Cross-user scan rejected ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO email_scan_run (
      id, user_id, client_request_id, gmail_account_id,
      email_filter_id, email_filter_version_id,
      effective_gmail_query, from_date, to_date,
      filter_rule_schema_version, filter_evaluator_version,
      filter_snapshot_json
    ) VALUES (
      'dryrun-sr-bad','dryrun-u2','req-bad','dryrun-a3',
      'dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',
      1,1,'{}' );
    RAISE EXCEPTION 'FAIL VP7: cross-user scan was not rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS VP7: cross-user/cross-account scan FK violation raised';
  END;
END; $$;

-- =============================================================================
-- VP8: Cross-Gmail-account negative tests
-- =============================================================================
\echo '--- VP8: Cross-account source in scan item rejected ---'
INSERT INTO email_source (id, user_id, gmail_account_id, gmail_message_id)
  VALUES ('dryrun-es-a2','dryrun-u1','dryrun-a2','msg-a2');
DO $$
BEGIN
  BEGIN
    INSERT INTO email_scan_item (id, scan_run_id, email_source_id)
      VALUES ('dryrun-si-bad','dryrun-sr1','dryrun-es-a2');
    RAISE EXCEPTION 'FAIL VP8: cross-account source membership was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%same user/gmail_account_id%' THEN
      RAISE NOTICE 'PASS VP8: trg_email_scan_item_source_ownership rejected cross-account source: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL VP8 unexpected: %', SQLERRM;
    END IF;
  END;
END; $$;

-- =============================================================================
-- VP9: Filter-version immutability test
-- =============================================================================
\echo '--- VP9: trg_email_filter_version_immutable ---'
DO $$
BEGIN
  BEGIN
    UPDATE email_filter_version SET gmail_query = 'changed' WHERE id = 'dryrun-fv1';
    RAISE EXCEPTION 'FAIL VP9: trigger did not block UPDATE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' THEN
      RAISE NOTICE 'PASS VP9: trg_email_filter_version_immutable fired: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL VP9 unexpected: %', SQLERRM;
    END IF;
  END;
END; $$;

-- =============================================================================
-- VP10: Scan-item parent immutability test
-- =============================================================================
\echo '--- VP10a: trg_email_scan_item_parent_immutable (scan_run_id) ---'
INSERT INTO email_scan_run (
  id, user_id, client_request_id, gmail_account_id,
  email_filter_id, email_filter_version_id,
  effective_gmail_query, from_date, to_date,
  filter_rule_schema_version, filter_evaluator_version,
  filter_snapshot_json
) VALUES (
  'dryrun-sr2','dryrun-u1','req2','dryrun-a1',
  'dryrun-f1','dryrun-fv1',
  'from:bank@example.com','2026-01-01','2026-07-01',
  1,1,'{}'
);
DO $$
BEGIN
  BEGIN
    UPDATE email_scan_item SET scan_run_id = 'dryrun-sr2' WHERE id = 'dryrun-si1';
    RAISE EXCEPTION 'FAIL VP10a: trigger did not block scan_run_id change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' THEN
      RAISE NOTICE 'PASS VP10a: trg_email_scan_item_parent_immutable (scan_run_id) fired: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL VP10a unexpected: %', SQLERRM;
    END IF;
  END;
END; $$;

\echo '--- VP10b: trg_email_scan_item_parent_immutable (email_source_id) ---'
INSERT INTO email_source (id, user_id, gmail_account_id, gmail_message_id)
  VALUES ('dryrun-es2','dryrun-u1','dryrun-a1','msg2');
DO $$
BEGIN
  BEGIN
    UPDATE email_scan_item SET email_source_id = 'dryrun-es2' WHERE id = 'dryrun-si1';
    RAISE EXCEPTION 'FAIL VP10b: trigger did not block email_source_id change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' THEN
      RAISE NOTICE 'PASS VP10b: trg_email_scan_item_parent_immutable (email_source_id) fired: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL VP10b unexpected: %', SQLERRM;
    END IF;
  END;
END; $$;

-- =============================================================================
-- VP11: Classification ownership and cascade test
-- =============================================================================
\echo '--- VP11a: Cross-user classification rejected ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO email_manual_classification (
      id, user_id, email_source_id,
      previous_classification, new_classification, classification_version
    ) VALUES ('dryrun-mc-bad','dryrun-u2','dryrun-es1','UNREVIEWED','FINANCIAL',99);
    RAISE EXCEPTION 'FAIL VP11a: cross-user classification was not rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS VP11a: cross-user classification FK violation raised';
  END;
END; $$;

\echo '--- VP11b: Classification cascade on source delete ---'
INSERT INTO email_source (id, user_id, gmail_account_id, gmail_message_id)
  VALUES ('dryrun-es-casc','dryrun-u1','dryrun-a1','msg-casc');
INSERT INTO email_manual_classification (
  id, user_id, email_source_id,
  previous_classification, new_classification, classification_version
) VALUES ('dryrun-mc-casc','dryrun-u1','dryrun-es-casc','UNREVIEWED','FINANCIAL',1);
UPDATE email_source
SET current_manual_classification = 'FINANCIAL',
    classification_version = 1,
    updated_at = now()
WHERE id = 'dryrun-es-casc' AND classification_version = 0;

DELETE FROM email_source WHERE id = 'dryrun-es-casc';

DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM email_manual_classification WHERE id = 'dryrun-mc-casc';
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL VP11b: Classification cascade left % orphan row(s) after source delete', cnt;
  END IF;
  RAISE NOTICE 'PASS VP11b: Classification cascade on source delete — 0 rows remain';
END; $$;

-- =============================================================================
-- VP12: Both continuation CHECK negative tests
-- =============================================================================
\echo '--- VP12a: chk_pending_continuation_coherence (partial) ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO email_scan_run (
      id, user_id, client_request_id, gmail_account_id,
      email_filter_id, email_filter_version_id,
      effective_gmail_query, from_date, to_date,
      filter_rule_schema_version, filter_evaluator_version,
      filter_snapshot_json,
      batch_sequence, pending_continuation_sequence
      -- stage and not_before intentionally omitted
    ) VALUES (
      'dryrun-sr-chk1','dryrun-u1','req-chk1','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01', 1,1,'{}', 5, 5
    );
    RAISE EXCEPTION 'FAIL VP12a: coherence constraint did not reject partial state';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12a: chk_pending_continuation_coherence rejected partial pending state';
  END;
END; $$;

\echo '--- VP12b: chk_pending_sequence_matches_scan_sequence (mismatch) ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO email_scan_run (
      id, user_id, client_request_id, gmail_account_id,
      email_filter_id, email_filter_version_id,
      effective_gmail_query, from_date, to_date,
      filter_rule_schema_version, filter_evaluator_version,
      filter_snapshot_json,
      batch_sequence,
      pending_continuation_sequence, pending_continuation_stage, pending_continuation_not_before
    ) VALUES (
      'dryrun-sr-chk2','dryrun-u1','req-chk2','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',
      1,1,'{}',
      3,    -- batch_sequence
      7,    -- pending_continuation_sequence (mismatch)
      'DISCOVERY', now()
    );
    RAISE EXCEPTION 'FAIL VP12b: sequence-match constraint did not reject mismatch';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12b: chk_pending_sequence_matches_scan_sequence rejected mismatch';
  END;
END; $$;

-- =============================================================================
-- VP12c: Row-local lifecycle, lease, retry, counter, timestamp, and Account CHECKs
-- =============================================================================
\echo '--- VP12c: Row-local integrity CHECK negative tests ---'
DO $$
BEGIN
  BEGIN
    UPDATE "Account"
    SET disconnection_reason = 'user_request'
    WHERE id = 'dryrun-a1';
    RAISE EXCEPTION 'FAIL VP12c: Account reason without disconnected_at was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: Account disconnection coherence rejected partial state';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json
    ) VALUES (
      'dryrun-sr-date','dryrun-u1','req-date','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-07-02','2026-07-01',1,1,'{}'
    );
    RAISE EXCEPTION 'FAIL VP12c: reversed scan date range was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: scan date-range CHECK rejected from_date > to_date';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json,total_discovered
    ) VALUES (
      'dryrun-sr-negative','dryrun-u1','req-negative','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}',-1
    );
    RAISE EXCEPTION 'FAIL VP12c: negative scan counter was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: nonnegative-value CHECK rejected negative counter';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json,total_discovered,
      fetch_pending_count,fetch_success_count
    ) VALUES (
      'dryrun-sr-overcount','dryrun-u1','req-overcount','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}',1,1,1
    );
    RAISE EXCEPTION 'FAIL VP12c: over-partitioned scan counters were accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: counter-bound CHECK rejected state counts above total';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json,current_stage
    ) VALUES (
      'dryrun-sr-stage','dryrun-u1','req-stage','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}','DISCOVERY'
    );
    RAISE EXCEPTION 'FAIL VP12c: CREATED scan with active stage was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: stage-coherence CHECK rejected CREATED + current_stage';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json,worker_lease_owner
    ) VALUES (
      'dryrun-sr-lease','dryrun-u1','req-lease','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}','owner-only'
    );
    RAISE EXCEPTION 'FAIL VP12c: half-populated scan lease was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: lease-coherence CHECK rejected half-populated lease';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json,status,resume_stage,started_at
    ) VALUES (
      'dryrun-sr-retry','dryrun-u1','req-retry','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}','RETRY_WAIT','DISCOVERY',now()
    );
    RAISE EXCEPTION 'FAIL VP12c: RETRY_WAIT scan without next_retry_at was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: retry-coherence CHECK rejected missing retry timestamp';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json,status,started_at,completed_at,
      batch_sequence,pending_continuation_sequence,pending_continuation_stage,
      pending_continuation_not_before
    ) VALUES (
      'dryrun-sr-terminal','dryrun-u1','req-terminal','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}','COMPLETED',now(),now(),
      0,0,'FETCH',now()
    );
    RAISE EXCEPTION 'FAIL VP12c: terminal scan with pending continuation was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: terminal-state CHECK rejected pending continuation';
  END;

  BEGIN
    INSERT INTO email_scan_item (
      id,scan_run_id,email_source_id,status,fetch_started_at
    ) VALUES (
      'dryrun-si-lease','dryrun-sr1','dryrun-es2','FETCHING',now()
    );
    RAISE EXCEPTION 'FAIL VP12c: FETCHING item without lease was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: item lease-coherence CHECK rejected FETCHING without lease';
  END;

  BEGIN
    INSERT INTO email_scan_item (
      id,scan_run_id,email_source_id,status
    ) VALUES (
      'dryrun-si-retry','dryrun-sr1','dryrun-es2','RETRY_WAIT'
    );
    RAISE EXCEPTION 'FAIL VP12c: RETRY_WAIT item without next_retry_at was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: item retry-coherence CHECK rejected missing retry timestamp';
  END;

  BEGIN
    INSERT INTO email_scan_item (
      id,scan_run_id,email_source_id,filter_decision
    ) VALUES (
      'dryrun-si-filter','dryrun-sr1','dryrun-es2','INCLUDED'
    );
    RAISE EXCEPTION 'FAIL VP12c: non-FETCHED item with final filter decision was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: filter-coherence CHECK rejected premature filter decision';
  END;

  BEGIN
    INSERT INTO email_manual_classification (
      id,user_id,email_source_id,previous_classification,new_classification,
      classification_version
    ) VALUES (
      'dryrun-mc-noop','dryrun-u1','dryrun-es2','UNREVIEWED','UNREVIEWED',1
    );
    RAISE EXCEPTION 'FAIL VP12c: no-op classification was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS VP12c: classification-change CHECK rejected no-op event';
  END;
END; $$;

-- =============================================================================
-- VP12d: Idempotency/duplicate-prevention operational tests
-- =============================================================================
\echo '--- VP12d: Idempotency unique-constraint negative tests ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO email_source (id,user_id,gmail_account_id,gmail_message_id)
    VALUES ('dryrun-es-dup','dryrun-u1','dryrun-a1','msg1');
    RAISE EXCEPTION 'FAIL VP12d: duplicate email source identity was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS VP12d: duplicate email source identity rejected';
  END;

  BEGIN
    INSERT INTO email_scan_run (
      id,user_id,client_request_id,gmail_account_id,email_filter_id,email_filter_version_id,
      effective_gmail_query,from_date,to_date,filter_rule_schema_version,
      filter_evaluator_version,filter_snapshot_json
    ) VALUES (
      'dryrun-sr-dup','dryrun-u1','req1','dryrun-a1','dryrun-f1','dryrun-fv1',
      'q','2026-01-01','2026-07-01',1,1,'{}'
    );
    RAISE EXCEPTION 'FAIL VP12d: duplicate client_request_id was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS VP12d: duplicate client_request_id rejected';
  END;

  BEGIN
    INSERT INTO email_filter_version (
      id,email_filter_id,version,gmail_query,created_by
    ) VALUES ('dryrun-fv-dup','dryrun-f1',1,'q','dryrun-u1');
    RAISE EXCEPTION 'FAIL VP12d: duplicate filter version was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS VP12d: duplicate filter version rejected';
  END;

  BEGIN
    INSERT INTO email_manual_classification (
      id,user_id,email_source_id,previous_classification,new_classification,
      classification_version
    ) VALUES (
      'dryrun-mc-dup','dryrun-u1','dryrun-es1','FINANCIAL','UNCERTAIN',1
    );
    RAISE EXCEPTION 'FAIL VP12d: duplicate classification version was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS VP12d: duplicate classification version rejected';
  END;
END; $$;

-- =============================================================================
-- VP13: User-erasure transaction test (canonical 7-step C90 order)
-- =============================================================================
\echo '--- VP13: User erasure in canonical C90 order ---'

INSERT INTO "User" (id, email, "createdAt")
  VALUES ('dryrun-uerase','dryrun-uerase@test.invalid', now());
INSERT INTO "Account" (id, "userId", type, provider, "providerAccountId")
  VALUES ('dryrun-aerase','dryrun-uerase','oauth','google','ga-erase');
INSERT INTO email_filter (id, user_id, gmail_account_id, name)
  VALUES ('dryrun-ferase','dryrun-uerase','dryrun-aerase','Erase Filter');
INSERT INTO email_filter_version (id, email_filter_id, version, gmail_query, created_by)
  VALUES ('dryrun-fverase','dryrun-ferase',1,'q','dryrun-uerase');
INSERT INTO email_source (id, user_id, gmail_account_id, gmail_message_id)
  VALUES ('dryrun-eserase','dryrun-uerase','dryrun-aerase','msg-erase');
INSERT INTO email_scan_run (
  id, user_id, client_request_id, gmail_account_id,
  email_filter_id, email_filter_version_id,
  effective_gmail_query, from_date, to_date,
  filter_rule_schema_version, filter_evaluator_version,
  filter_snapshot_json
) VALUES (
  'dryrun-srerase','dryrun-uerase','req-erase','dryrun-aerase',
  'dryrun-ferase','dryrun-fverase',
  'q','2026-01-01','2026-07-01',
  1,1,'{}'
);
INSERT INTO email_scan_item (id, scan_run_id, email_source_id)
  VALUES ('dryrun-sierase','dryrun-srerase','dryrun-eserase');
INSERT INTO email_manual_classification (
  id, user_id, email_source_id,
  previous_classification, new_classification, classification_version
) VALUES ('dryrun-mcerase','dryrun-uerase','dryrun-eserase','UNREVIEWED','FINANCIAL',1);
UPDATE email_source
SET current_manual_classification = 'FINANCIAL',
    classification_version = 1,
    updated_at = now()
WHERE id = 'dryrun-eserase' AND classification_version = 0;

-- C90 canonical erasure order:
-- Step 1: manual classifications (RESTRICT on email_source_id does not block this)
DELETE FROM email_manual_classification WHERE user_id = 'dryrun-uerase';
-- Step 2: scan items (RESTRICT on email_source_id requires deletion before sources)
DELETE FROM email_scan_item WHERE scan_run_id IN (
  SELECT id FROM email_scan_run WHERE user_id = 'dryrun-uerase'
);
-- Step 3: scan runs
DELETE FROM email_scan_run WHERE user_id = 'dryrun-uerase';
-- Step 4: email sources
DELETE FROM email_source WHERE user_id = 'dryrun-uerase';
-- Step 5: filters — ON DELETE CASCADE removes email_filter_version automatically
--         Do NOT directly delete email_filter_version
DELETE FROM email_filter WHERE user_id = 'dryrun-uerase';
-- Step 6: Account rows for the user (explicit; not relying on User CASCADE for ordering clarity)
DELETE FROM "Account" WHERE "userId" = 'dryrun-uerase';
-- Step 7: User
DELETE FROM "User" WHERE id = 'dryrun-uerase';

-- C97: Assert using stable synthetic IDs captured before deletion.
-- Do NOT derive child checks through parent tables already deleted.
DO $$
DECLARE
  cnt_mc    INT; cnt_si    INT; cnt_sr    INT; cnt_es    INT;
  cnt_fv    INT; cnt_ef    INT; cnt_acc   INT; cnt_usr   INT;
BEGIN
  -- Direct stable-ID assertions — no subquery through already-deleted parents
  SELECT COUNT(*) INTO cnt_mc  FROM email_manual_classification WHERE id = 'dryrun-mcerase';
  SELECT COUNT(*) INTO cnt_si  FROM email_scan_item            WHERE scan_run_id = 'dryrun-srerase';
  SELECT COUNT(*) INTO cnt_sr  FROM email_scan_run             WHERE id = 'dryrun-srerase';
  SELECT COUNT(*) INTO cnt_es  FROM email_source               WHERE id = 'dryrun-eserase';
  SELECT COUNT(*) INTO cnt_fv  FROM email_filter_version       WHERE email_filter_id = 'dryrun-ferase';
  SELECT COUNT(*) INTO cnt_ef  FROM email_filter               WHERE id = 'dryrun-ferase';
  SELECT COUNT(*) INTO cnt_acc FROM "Account"                  WHERE id = 'dryrun-aerase';
  SELECT COUNT(*) INTO cnt_usr FROM "User"                     WHERE id = 'dryrun-uerase';

  IF cnt_mc + cnt_si + cnt_sr + cnt_es + cnt_fv + cnt_ef + cnt_acc + cnt_usr <> 0 THEN
    RAISE EXCEPTION
      'FAIL VP13: Erasure left non-zero rows — mc:% si:% sr:% es:% fv:% ef:% acc:% usr:%',
      cnt_mc, cnt_si, cnt_sr, cnt_es, cnt_fv, cnt_ef, cnt_acc, cnt_usr;
  END IF;
  RAISE NOTICE 'PASS VP13: All 8 stable-ID checks have 0 rows after canonical erasure';
END; $$;

-- =============================================================================
-- VP14: Full rollback
-- =============================================================================
\echo '--- VP14: Rolling back all dry-run changes ---'

ROLLBACK;

-- =============================================================================
-- VP15: Post-rollback baseline-schema verification (outside transaction)
-- =============================================================================
\echo '--- VP15: Post-rollback verification ---'

\if :{?PHASE1A_VALIDATE_MIGRATED}

-- In migrated-schema mode ROLLBACK removes only synthetic fixtures. Installed schema must remain.
DO $$
DECLARE
  table_count INT;
  account_column_count INT;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'email_filter','email_filter_version',
      'email_source','email_scan_run',
      'email_scan_item','email_manual_classification'
    );
  IF table_count <> 6 THEN
    RAISE EXCEPTION
      'FAIL VP15: migrated-schema mode retained % Phase 1A tables (expected 6)',
      table_count;
  END IF;

  SELECT COUNT(*) INTO account_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'Account'
    AND column_name IN ('disconnected_at','disconnection_reason');
  IF account_column_count <> 2 THEN
    RAISE EXCEPTION
      'FAIL VP15: migrated-schema mode retained % Account additions (expected 2)',
      account_column_count;
  END IF;

  RAISE NOTICE
    'PASS VP15: migrated schema remains installed after fixture rollback';
END; $$;

\else

-- Assert Phase 1A tables are gone
DO $$
DECLARE
  surviving_tables TEXT;
BEGIN
  SELECT string_agg(tablename, ', ')
  INTO surviving_tables
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'email_filter','email_filter_version',
      'email_source','email_scan_run',
      'email_scan_item','email_manual_classification'
    );
  IF surviving_tables IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP15: Phase 1A tables survive rollback: %', surviving_tables;
  END IF;
  RAISE NOTICE 'PASS VP15: All 6 Phase 1A tables removed by rollback';
END; $$;

-- Assert Account additive columns are gone
DO $$
DECLARE
  surviving_cols TEXT;
BEGIN
  SELECT string_agg(column_name, ', ')
  INTO surviving_cols
  FROM information_schema.columns
  WHERE table_name = 'Account'
    AND column_name IN ('disconnected_at','disconnection_reason');
  IF surviving_cols IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP15: Account additive columns survive rollback: %', surviving_cols;
  END IF;
  RAISE NOTICE 'PASS VP15: Account additive columns removed by rollback';
END; $$;

-- Assert account_user_id_id_unique constraint is gone
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'u'
    AND conname = 'account_user_id_id_unique';
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL VP15: account_user_id_id_unique survives rollback (count = %)', cnt;
  END IF;
  RAISE NOTICE 'PASS VP15: account_user_id_id_unique removed by rollback';
END; $$;

-- Assert account_disconnected_idx is gone
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'Account'
    AND indexname = 'account_disconnected_idx';
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL VP15: account_disconnected_idx survives rollback (count = %)', cnt;
  END IF;
  RAISE NOTICE 'PASS VP15: account_disconnected_idx removed by rollback';
END; $$;

-- Assert Account disconnection CHECK is gone
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM pg_constraint
  WHERE conrelid = '"Account"'::regclass
    AND contype = 'c'
    AND conname = 'chk_account_disconnection_coherence';
  IF cnt <> 0 THEN
    RAISE EXCEPTION
      'FAIL VP15: chk_account_disconnection_coherence survives rollback (count = %)',
      cnt;
  END IF;
  RAISE NOTICE 'PASS VP15: Account disconnection CHECK removed by rollback';
END; $$;

\endif

-- C99: Assert exact User and Account counts equal the pre-BEGIN baseline
-- from the session-local temp table (survives ROLLBACK).
DO $$
DECLARE
  usr_count     BIGINT;
  acc_count     BIGINT;
  usr_baseline  BIGINT;
  acc_baseline  BIGINT;
BEGIN
  SELECT user_count, account_count
  INTO usr_baseline, acc_baseline
  FROM phase1a_dryrun_baseline;

  SELECT COUNT(*) INTO usr_count FROM "User";
  SELECT COUNT(*) INTO acc_count FROM "Account";

  IF usr_count <> usr_baseline THEN
    RAISE EXCEPTION 'FAIL VP15: User count after ROLLBACK = % (expected baseline %)',
      usr_count, usr_baseline;
  END IF;
  IF acc_count <> acc_baseline THEN
    RAISE EXCEPTION 'FAIL VP15: Account count after ROLLBACK = % (expected baseline %)',
      acc_count, acc_baseline;
  END IF;

  IF EXISTS (SELECT 1 FROM "User" WHERE id LIKE 'dryrun-%') THEN
    RAISE EXCEPTION 'FAIL VP15: dryrun- User rows survive rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM "Account" WHERE id LIKE 'dryrun-%') THEN
    RAISE EXCEPTION 'FAIL VP15: dryrun- Account rows survive rollback';
  END IF;

  RAISE NOTICE 'PASS VP15: User count = % (baseline %), Account count = % (baseline %), no dryrun- rows',
    usr_count, usr_baseline, acc_count, acc_baseline;
END; $$;

DROP TABLE phase1a_dryrun_baseline;

\echo '--- VP15: ROLLBACK COMPLETE — all dry-run objects removed ---'
