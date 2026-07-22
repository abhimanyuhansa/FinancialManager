-- =============================================================================
-- Financial Manager Phase 1A — Canonical DDL Dry Run (C81–C83 applied)
-- Execute against an isolated, disposable PostgreSQL database.
-- ON_ERROR_STOP=1 is required: any failure aborts immediately.
-- ROLLBACK at end leaves no permanent changes.
-- 15-point verification per governing instruction C84.
-- =============================================================================
-- Usage:
--   psql -X -v ON_ERROR_STOP=1 "$ISOLATED_DATABASE_URL" \
--     -f /tmp/fm_phase1a_dry_run.sql 2>&1 | tee /tmp/fm_phase1a_dry_run.log

BEGIN;

-- =============================================================================
-- VP1: Baseline User and Account schema validation
-- =============================================================================
\echo '--- VP1: Baseline User and Account schema ---'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'User'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'Account'
ORDER BY ordinal_position;

-- Confirm UNIQUE("userId", id) does not yet exist (additive change below will add it)
SELECT COUNT(*) AS account_unique_userId_id_already_exists
FROM pg_constraint
WHERE conrelid = '"Account"'::regclass AND contype = 'u' AND conname = 'Account_userId_id_unique';

-- =============================================================================
-- VP2 (prep): Account additive changes
-- =============================================================================
\echo '--- VP2: Account additive changes ---'
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS disconnection_reason TEXT;
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_id_unique" UNIQUE ("userId", id);

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Account'
  AND column_name IN ('disconnected_at', 'disconnection_reason')
ORDER BY column_name;

SELECT conname FROM pg_constraint
WHERE conrelid = '"Account"'::regclass AND contype = 'u' AND conname = 'Account_userId_id_unique';

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
-- VP3: Account additive changes confirmed
-- =============================================================================
\echo '--- VP3: Account additive columns present ---'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Account'
  AND column_name IN ('disconnected_at','disconnection_reason')
ORDER BY column_name;

\echo '--- VP3: Account UNIQUE(userId,id) constraint ---'
SELECT conname FROM pg_constraint
WHERE conrelid = '"Account"'::regclass AND contype = 'u' AND conname = 'Account_userId_id_unique';

-- =============================================================================
-- VP4: FK inventory checks
-- =============================================================================
\echo '--- VP4: FK inventory ---'
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
-- VP5: Trigger inventory checks
-- =============================================================================
\echo '--- VP5: Trigger inventory (expect 3: immutable, source_ownership, parent_immutable) ---'
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
-- VP6: Deferred circular-FK test
-- =============================================================================
\echo '--- VP6: Deferred circular FK bootstrap (fk_email_filter_current_version) ---'
SELECT ef.id AS filter_id, ef.current_version_id, efv.id AS version_id,
       'deferred FK resolved' AS result
FROM email_filter ef
JOIN email_filter_version efv ON efv.id = ef.current_version_id
WHERE ef.id = 'dryrun-f1';

\echo '--- VP6: fk_version_supersedes (deferrable) listed in FK inventory ---'
SELECT conname, condeferrable, condeferred
FROM pg_constraint
WHERE conname IN ('fk_email_filter_current_version','fk_version_supersedes')
ORDER BY conname;

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
    RAISE EXCEPTION 'FAIL: cross-user scan was not rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: cross-user/cross-account scan FK violation raised';
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
    RAISE EXCEPTION 'FAIL: cross-account source membership was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%same user/gmail_account_id%' THEN
      RAISE NOTICE 'PASS: trg_email_scan_item_source_ownership rejected cross-account source: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL unexpected: %', SQLERRM;
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
    RAISE EXCEPTION 'FAIL: trigger did not block UPDATE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' THEN
      RAISE NOTICE 'PASS: trg_email_filter_version_immutable fired: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL unexpected: %', SQLERRM;
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
    RAISE EXCEPTION 'FAIL: trigger did not block scan_run_id change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' THEN
      RAISE NOTICE 'PASS: trg_email_scan_item_parent_immutable (scan_run_id) fired: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL unexpected: %', SQLERRM;
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
    RAISE EXCEPTION 'FAIL: trigger did not block email_source_id change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' THEN
      RAISE NOTICE 'PASS: trg_email_scan_item_parent_immutable (email_source_id) fired: %', SQLERRM;
    ELSE RAISE EXCEPTION 'FAIL unexpected: %', SQLERRM;
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
    RAISE EXCEPTION 'FAIL: cross-user classification was not rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: cross-user classification FK violation raised';
  END;
END; $$;

\echo '--- VP11b: Classification cascade on source delete ---'
INSERT INTO email_source (id, user_id, gmail_account_id, gmail_message_id)
  VALUES ('dryrun-es-casc','dryrun-u1','dryrun-a1','msg-casc');
INSERT INTO email_manual_classification (
  id, user_id, email_source_id,
  previous_classification, new_classification, classification_version
) VALUES ('dryrun-mc-casc','dryrun-u1','dryrun-es-casc','UNREVIEWED','FINANCIAL',1);
SELECT id, user_id FROM email_manual_classification WHERE id = 'dryrun-mc-casc';
DELETE FROM email_source WHERE id = 'dryrun-es-casc';
SELECT COUNT(*) AS surviving_after_cascade
FROM email_manual_classification WHERE id = 'dryrun-mc-casc';
-- Expected: 0

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
    RAISE EXCEPTION 'FAIL: coherence constraint did not reject partial state';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: chk_pending_continuation_coherence rejected partial pending state';
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
    RAISE EXCEPTION 'FAIL: sequence-match constraint did not reject mismatch';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: chk_pending_sequence_matches_scan_sequence rejected mismatch';
  END;
END; $$;

-- =============================================================================
-- VP13: User-erasure transaction test (7-step documented §13 application order)
-- =============================================================================
\echo '--- VP13: User erasure in documented §13 order ---'
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

-- §13 application erasure order (7 steps):
-- Step 1: scan items (RESTRICT on email_source_id requires deletion before sources)
DELETE FROM email_scan_item WHERE scan_run_id IN (
  SELECT id FROM email_scan_run WHERE user_id = 'dryrun-uerase'
);
-- Step 2: scan runs
DELETE FROM email_scan_run WHERE user_id = 'dryrun-uerase';
-- Step 3: manual classifications
DELETE FROM email_manual_classification WHERE user_id = 'dryrun-uerase';
-- Step 4: email sources
DELETE FROM email_source WHERE user_id = 'dryrun-uerase';
-- Step 5: filter versions (cascade from filter covers this, but explicit for clarity)
DELETE FROM email_filter_version WHERE email_filter_id IN (
  SELECT id FROM email_filter WHERE user_id = 'dryrun-uerase'
);
-- Step 6: filters
DELETE FROM email_filter WHERE user_id = 'dryrun-uerase';
-- Step 7: user (Account cascades from User)
DELETE FROM "User" WHERE id = 'dryrun-uerase';

SELECT
  (SELECT COUNT(*) FROM email_filter            WHERE user_id = 'dryrun-uerase') AS filters,
  (SELECT COUNT(*) FROM email_source            WHERE user_id = 'dryrun-uerase') AS sources,
  (SELECT COUNT(*) FROM email_scan_run          WHERE user_id = 'dryrun-uerase') AS scan_runs,
  (SELECT COUNT(*) FROM email_manual_classification WHERE user_id = 'dryrun-uerase') AS classifications;
-- All expected: 0

-- =============================================================================
-- VP14: Full rollback — pre-rollback baseline counts
-- =============================================================================
\echo '--- VP14: Pre-rollback baseline counts ---'
SELECT COUNT(*) AS user_count_before_rollback FROM "User" WHERE id NOT LIKE 'dryrun-%';
SELECT COUNT(*) AS account_count_before_rollback FROM "Account" WHERE id NOT LIKE 'dryrun-%';

ROLLBACK;

-- =============================================================================
-- VP15: Post-rollback baseline-schema verification (outside transaction)
-- =============================================================================
\echo '--- VP15: Post-rollback — Phase 1A tables must not exist ---'
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'email_filter','email_filter_version',
    'email_source','email_scan_run',
    'email_scan_item','email_manual_classification'
  );
-- Expected: 0 rows

\echo '--- VP15: Post-rollback — Account columns must be gone ---'
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'Account'
  AND column_name IN ('disconnected_at','disconnection_reason');
-- Expected: 0 rows

\echo '--- VP15: Post-rollback — Account_userId_id_unique must be gone ---'
SELECT COUNT(*) AS constraint_still_exists
FROM pg_constraint
WHERE conrelid = '"Account"'::regclass AND contype = 'u' AND conname = 'Account_userId_id_unique';
-- Expected: 0

\echo '--- VP15: Post-rollback — baseline User table intact ---'
SELECT COUNT(*) AS user_count_unchanged FROM "User";

\echo '--- VP15: ROLLBACK COMPLETE — all dry-run objects removed ---'
