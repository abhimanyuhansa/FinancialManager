-- =============================================================================
-- Financial Manager Phase 1A — Canonical DDL Dry Run (C81–C98 applied)
-- Execute against an isolated, disposable PostgreSQL database.
-- ON_ERROR_STOP=1 is required: any failure aborts immediately.
-- ROLLBACK at end leaves no permanent changes.
-- 15-point verification per governing instruction C84.
-- =============================================================================
-- Usage:
--   psql -X -v ON_ERROR_STOP=1 "$ISOLATED_DATABASE_URL" \
--     -f docs/consolidated/phase1a-dry-run.sql \
--     2>&1 | tee /tmp/fm_phase1a_dry_run.log

-- =============================================================================
-- C97: Capture baseline counts BEFORE BEGIN so they survive ROLLBACK.
-- psql \gset assigns result columns as client-side variables.
-- =============================================================================
\echo '--- Baseline capture (pre-transaction) ---'
SELECT COUNT(*) AS baseline_user_count    FROM "User"    WHERE id NOT LIKE 'dryrun-%';
\gset
SELECT COUNT(*) AS baseline_account_count FROM "Account" WHERE id NOT LIKE 'dryrun-%';
\gset

BEGIN;

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

-- =============================================================================
-- VP2 (prep): Account additive changes
-- =============================================================================
\echo '--- VP2: Account additive changes ---'
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS disconnection_reason TEXT;
ALTER TABLE "Account" ADD CONSTRAINT account_user_id_id_unique UNIQUE ("userId", id);
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
  UNIQUE(user_id, gmail_account_id, id)
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
  UNIQUE(email_filter_id, id)
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
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
  last_fetch_status             TEXT        NOT NULL DEFAULT 'DISCOVERED'
                                  CHECK (last_fetch_status IN ('DISCOVERED','FETCHING','FETCHED','PERMANENTLY_FAILED')),
  last_fetch_attempt_at         TIMESTAMPTZ,
  last_fetch_error_code         TEXT,
  last_fetch_error_message_sanitized TEXT,
  current_manual_classification TEXT        NOT NULL DEFAULT 'UNREVIEWED'
                                  CHECK (current_manual_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')),
  classification_version        INTEGER     NOT NULL DEFAULT 0,
  first_discovered_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at               TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retained_until                TIMESTAMPTZ,
  deleted_at                    TIMESTAMPTZ,
  UNIQUE(user_id, gmail_account_id, gmail_message_id),
  UNIQUE(user_id, id)
);
CREATE INDEX email_source_user_account_fetch_idx
  ON email_source(user_id, gmail_account_id, last_fetch_status)
  WHERE deleted_at IS NULL;
CREATE INDEX email_source_user_account_discovered_idx
  ON email_source(user_id, gmail_account_id, first_discovered_at DESC)
  WHERE deleted_at IS NULL;

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
  status                    TEXT        NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT','PAUSED',
                      'COMPLETED','COMPLETED_WITH_ERRORS','FAILED','CANCELLING','CANCELLED')),
  current_stage             TEXT        CHECK (current_stage IN ('DISCOVERY','FETCH')),
  resume_stage              TEXT        CHECK (resume_stage IN ('DISCOVERY','FETCH')),
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
  pending_continuation_stage        TEXT  CHECK (pending_continuation_stage IN ('DISCOVERY','FETCH')),
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

-- ---------------------------------------------------------------------------
-- Table 5: email_scan_item
-- ---------------------------------------------------------------------------
CREATE TABLE email_scan_item (
  id                            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scan_run_id                   TEXT        NOT NULL REFERENCES email_scan_run(id) ON DELETE CASCADE,
  email_source_id               TEXT        NOT NULL REFERENCES email_source(id) ON DELETE RESTRICT,
  status                        TEXT        NOT NULL DEFAULT 'DISCOVERED'
    CHECK (status IN ('DISCOVERED','FETCHING','FETCHED','RETRY_WAIT','PERMANENTLY_FAILED','CANCELLED')),
  state_version                 INTEGER     NOT NULL DEFAULT 0,
  fetch_attempt_count           INTEGER     NOT NULL DEFAULT 0,
  next_retry_at                 TIMESTAMPTZ,
  last_error_code               TEXT,
  last_error_message_sanitized  TEXT,
  item_lease_owner              TEXT,
  item_lease_expires_at         TIMESTAMPTZ,
  filter_decision               TEXT        NOT NULL DEFAULT 'PENDING'
    CHECK (filter_decision IN ('PENDING','INCLUDED','EXCLUDED')),
  matched_include_rule_ids      TEXT[],
  matched_exclude_rule_ids      TEXT[],
  filter_decision_reason_sanitized TEXT,
  discovered_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_started_at              TIMESTAMPTZ,
  fetch_completed_at            TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scan_run_id, email_source_id)
);
CREATE INDEX email_scan_item_run_status_idx ON email_scan_item(scan_run_id, status);
CREATE INDEX email_scan_item_source_idx ON email_scan_item(email_source_id);
CREATE INDEX email_scan_item_retry_idx ON email_scan_item(next_retry_at)
  WHERE status = 'RETRY_WAIT';
CREATE INDEX email_scan_item_lease_idx ON email_scan_item(item_lease_expires_at)
  WHERE item_lease_owner IS NOT NULL;

-- Cross-table ownership trigger
CREATE OR REPLACE FUNCTION check_scan_item_source_ownership()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
  previous_classification   TEXT        NOT NULL
                              CHECK (previous_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')),
  new_classification        TEXT        NOT NULL
                              CHECK (new_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')),
  reason                    TEXT,
  classified_by             TEXT        REFERENCES "User"(id) ON DELETE SET NULL,
  classified_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  classification_version    INTEGER     NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_source_id, classification_version)
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

-- =============================================================================
-- VP4: FK inventory (assertion: expected FK count present)
-- =============================================================================
\echo '--- VP4: FK inventory ---'

-- C95: Exact 22-FK assertion (replaces fk_count >= 10)
DO $$
DECLARE
  fk_count INT;
BEGIN
  SELECT COUNT(*) INTO fk_count
  FROM pg_constraint
  WHERE contype = 'f'
    AND conrelid::regclass::text IN (
      'email_filter','email_filter_version',
      'email_source','email_scan_run',
      'email_scan_item','email_manual_classification'
    );
  IF fk_count <> 22 THEN
    RAISE EXCEPTION 'FAIL VP4: FK count = % (expected exactly 22)', fk_count;
  END IF;
  RAISE NOTICE 'PASS VP4: FK count = 22 (exact)';
END; $$;

-- C95: Named FK inventory — exact definition assertion for each required named FK
DO $$
DECLARE
  r RECORD;
  def TEXT;
BEGIN
  -- fk_email_filter_account: email_filter(user_id,gmail_account_id) → Account("userId",id) RESTRICT
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'fk_email_filter_account' AND conrelid = 'email_filter'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_filter_account missing from email_filter';
  END IF;
  IF def NOT ILIKE '%RESTRICT%' THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_filter_account wrong delete action (expected RESTRICT): %', def;
  END IF;

  -- fk_email_source_account: email_source(user_id,gmail_account_id) → Account("userId",id) RESTRICT
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'fk_email_source_account' AND conrelid = 'email_source'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_source_account missing from email_source';
  END IF;
  IF def NOT ILIKE '%RESTRICT%' THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_source_account wrong delete action (expected RESTRICT): %', def;
  END IF;

  -- fk_email_scan_run_account: email_scan_run(user_id,gmail_account_id) → Account("userId",id) RESTRICT
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'fk_email_scan_run_account' AND conrelid = 'email_scan_run'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_scan_run_account missing from email_scan_run';
  END IF;
  IF def NOT ILIKE '%RESTRICT%' THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_scan_run_account wrong delete action (expected RESTRICT): %', def;
  END IF;

  -- fk_scan_run_filter_ownership: email_scan_run(user_id,gmail_account_id,email_filter_id)
  --   → email_filter(user_id,gmail_account_id,id) — no ON DELETE clause (defaults to NO ACTION)
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'fk_scan_run_filter_ownership' AND conrelid = 'email_scan_run'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_scan_run_filter_ownership missing from email_scan_run';
  END IF;
  IF def ILIKE '%CASCADE%' OR def ILIKE '%SET NULL%' OR def ILIKE '%SET DEFAULT%' THEN
    RAISE EXCEPTION 'FAIL VP4: fk_scan_run_filter_ownership unexpected delete action: %', def;
  END IF;

  -- fk_scan_run_filter_version: email_scan_run(email_filter_id,email_filter_version_id)
  --   → email_filter_version(email_filter_id,id) RESTRICT
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'fk_scan_run_filter_version' AND conrelid = 'email_scan_run'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_scan_run_filter_version missing from email_scan_run';
  END IF;
  IF def NOT ILIKE '%RESTRICT%' THEN
    RAISE EXCEPTION 'FAIL VP4: fk_scan_run_filter_version wrong delete action (expected RESTRICT): %', def;
  END IF;

  -- fk_email_filter_current_version: email_filter(id,current_version_id)
  --   → email_filter_version(email_filter_id,id) — DEFERRABLE INITIALLY DEFERRED
  SELECT condeferrable, condeferred INTO r
  FROM pg_constraint
  WHERE conname = 'fk_email_filter_current_version' AND conrelid = 'email_filter'::regclass;
  IF r IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_filter_current_version missing from email_filter';
  END IF;
  IF NOT r.condeferrable THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_filter_current_version is not DEFERRABLE';
  END IF;
  IF NOT r.condeferred THEN
    RAISE EXCEPTION 'FAIL VP4: fk_email_filter_current_version is not INITIALLY DEFERRED';
  END IF;

  -- fk_version_supersedes: email_filter_version(email_filter_id,supersedes_version_id)
  --   → email_filter_version(email_filter_id,id) — DEFERRABLE INITIALLY DEFERRED
  SELECT condeferrable, condeferred INTO r
  FROM pg_constraint
  WHERE conname = 'fk_version_supersedes' AND conrelid = 'email_filter_version'::regclass;
  IF r IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_version_supersedes missing from email_filter_version';
  END IF;
  IF NOT r.condeferrable THEN
    RAISE EXCEPTION 'FAIL VP4: fk_version_supersedes is not DEFERRABLE';
  END IF;
  IF NOT r.condeferred THEN
    RAISE EXCEPTION 'FAIL VP4: fk_version_supersedes is not INITIALLY DEFERRED';
  END IF;

  -- fk_classification_source: email_manual_classification(user_id,email_source_id)
  --   → email_source(user_id,id) CASCADE
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'fk_classification_source' AND conrelid = 'email_manual_classification'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'FAIL VP4: fk_classification_source missing from email_manual_classification';
  END IF;
  IF def NOT ILIKE '%CASCADE%' THEN
    RAISE EXCEPTION 'FAIL VP4: fk_classification_source wrong delete action (expected CASCADE): %', def;
  END IF;

  RAISE NOTICE 'PASS VP4: All 8 required named FKs present with correct definitions';
END; $$;

-- Report full FK inventory for manual inspection
SELECT conname,
       conrelid::regclass AS tbl,
       confrelid::regclass AS ref_tbl,
       condeferrable,
       condeferred,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid::regclass::text IN (
    'email_filter','email_filter_version',
    'email_source','email_scan_run',
    'email_scan_item','email_manual_classification'
  )
ORDER BY conrelid::regclass::text, conname;

-- =============================================================================
-- VP5: Trigger inventory (assertion: exactly 3 application triggers)
-- =============================================================================
\echo '--- VP5: Trigger inventory (expect exactly 3) ---'

DO $$
DECLARE
  trigger_count INT;
  missing TEXT;
BEGIN
  -- Assert exactly the three expected triggers exist
  SELECT string_agg(required_tg, ', ')
  INTO missing
  FROM (VALUES
    ('trg_email_filter_version_immutable'),
    ('trg_email_scan_item_source_ownership'),
    ('trg_email_scan_item_parent_immutable')
  ) AS t(required_tg)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = t.required_tg
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL VP5: Expected trigger(s) missing: %', missing;
  END IF;

  SELECT COUNT(*) INTO trigger_count
  FROM pg_trigger
  WHERE tgrelid::regclass::text IN ('email_filter_version','email_scan_item')
    AND tgname NOT LIKE 'RI_%';
  IF trigger_count <> 3 THEN
    RAISE EXCEPTION 'FAIL VP5: Trigger count = % (expected exactly 3)', trigger_count;
  END IF;

  RAISE NOTICE 'PASS VP5: Exactly 3 application triggers present';
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

  -- Ensure bad version is not present (rollback of inner block not available; delete manually)
  -- Inner BEGIN/EXCEPTION does NOT roll back DML in PostgreSQL; clean up explicitly
  DELETE FROM email_filter_version WHERE id = 'dryrun-fv-bad';

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

-- C97: Assert exact User count equals captured baseline (client variable survives ROLLBACK).
-- Every mismatch terminates the script (ON_ERROR_STOP=1 required).
DO $$
DECLARE
  usr_count     INT;
  acc_count     INT;
  usr_baseline  INT := :baseline_user_count;
  acc_baseline  INT := :baseline_account_count;
BEGIN
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

\echo '--- VP15: ROLLBACK COMPLETE — all dry-run objects removed ---'
