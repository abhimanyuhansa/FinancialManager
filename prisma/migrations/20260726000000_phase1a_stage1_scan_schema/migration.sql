-- Phase 1A Stage 1: additive email scan/filter schema.
-- Runtime APIs, Gmail processing, QStash workers, and transaction ingestion are out of scope.
-- This migration is intentionally atomic on PostgreSQL.

BEGIN;

-- Existing Account additions required by tenant/account-scoped composite foreign keys.
ALTER TABLE "Account"
  ADD COLUMN "disconnected_at" TIMESTAMPTZ(6),
  ADD COLUMN "disconnection_reason" TEXT,
  ADD CONSTRAINT "account_user_id_id_unique" UNIQUE ("userId", "id"),
  ADD CONSTRAINT "chk_account_disconnection_coherence" CHECK (
    ("disconnected_at" IS NULL AND "disconnection_reason" IS NULL)
    OR
    (
      "disconnected_at" IS NOT NULL
      AND "disconnection_reason" IN ('user_request', 'token_revoked', 'invalid_grant')
    )
  );

CREATE INDEX "account_disconnected_idx"
  ON "Account"("id")
  WHERE "disconnected_at" IS NOT NULL;

CREATE TABLE "email_filter" (
  "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"            TEXT        NOT NULL,
  "gmail_account_id"   TEXT        NOT NULL,
  "name"               TEXT        NOT NULL,
  "is_active"          BOOLEAN     NOT NULL DEFAULT true,
  "current_version_id" TEXT,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_filter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_filter_user_id_gmail_account_id_id_key"
    UNIQUE ("user_id", "gmail_account_id", "id"),
  CONSTRAINT "chk_email_filter_timestamps"
    CHECK ("updated_at" >= "created_at"),
  CONSTRAINT "email_filter_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "email_filter_gmail_account_id_fkey"
    FOREIGN KEY ("gmail_account_id") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "email_filter_user_idx"
  ON "email_filter"("user_id");
CREATE INDEX "email_filter_user_account_idx"
  ON "email_filter"("user_id", "gmail_account_id");

CREATE TABLE "email_filter_version" (
  "id"                       TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "email_filter_id"          TEXT        NOT NULL,
  "version"                  INTEGER     NOT NULL,
  "gmail_query"              TEXT        NOT NULL,
  "include_rules_json"       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "exclude_rules_json"       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "rule_schema_version"      INTEGER     NOT NULL DEFAULT 1,
  "filter_evaluator_version" INTEGER     NOT NULL DEFAULT 1,
  "supersedes_version_id"    TEXT,
  "created_by"               TEXT        NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_filter_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_filter_version_email_filter_id_version_key"
    UNIQUE ("email_filter_id", "version"),
  CONSTRAINT "email_filter_version_email_filter_id_id_key"
    UNIQUE ("email_filter_id", "id"),
  CONSTRAINT "chk_email_filter_version_numbers" CHECK (
    "version" > 0
    AND "rule_schema_version" > 0
    AND "filter_evaluator_version" > 0
  ),
  CONSTRAINT "chk_email_filter_version_rule_arrays" CHECK (
    jsonb_typeof("include_rules_json") = 'array'
    AND jsonb_typeof("exclude_rules_json") = 'array'
  ),
  CONSTRAINT "email_filter_version_email_filter_id_fkey"
    FOREIGN KEY ("email_filter_id") REFERENCES "email_filter"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "email_filter_version_supersedes_version_id_fkey"
    FOREIGN KEY ("supersedes_version_id") REFERENCES "email_filter_version"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

ALTER TABLE "email_filter_version"
  ADD CONSTRAINT "fk_version_supersedes"
  FOREIGN KEY ("email_filter_id", "supersedes_version_id")
  REFERENCES "email_filter_version"("email_filter_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "email_filter"
  ADD CONSTRAINT "fk_email_filter_current_version"
  FOREIGN KEY ("id", "current_version_id")
  REFERENCES "email_filter_version"("email_filter_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX "email_filter_version_filter_idx"
  ON "email_filter_version"("email_filter_id");

CREATE FUNCTION "prevent_email_filter_version_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'email_filter_version rows are immutable; create a new version row instead';
END;
$$;

CREATE TRIGGER "trg_email_filter_version_immutable"
  BEFORE UPDATE ON "email_filter_version"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_email_filter_version_update"();

CREATE TABLE "email_source" (
  "id"                                      TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"                                 TEXT        NOT NULL,
  "gmail_account_id"                        TEXT        NOT NULL,
  "gmail_message_id"                        TEXT        NOT NULL,
  "subject"                                 TEXT,
  "normalized_subject"                      TEXT,
  "sender_email"                            TEXT,
  "sender_name"                             TEXT,
  "sender_domain"                           TEXT,
  "received_at"                             TIMESTAMPTZ(6),
  "snippet_redacted"                        TEXT,
  "gmail_thread_id"                         TEXT,
  "gmail_labels"                            TEXT[],
  "has_attachment"                          BOOLEAN     NOT NULL DEFAULT false,
  "attachment_metadata"                     JSONB,
  "source_url"                              TEXT,
  "last_fetch_status"                       TEXT        NOT NULL DEFAULT 'DISCOVERED',
  "last_fetch_attempt_at"                   TIMESTAMPTZ(6),
  "last_fetch_error_code"                   TEXT,
  "last_fetch_error_message_sanitized"      TEXT,
  "current_manual_classification"           TEXT        NOT NULL DEFAULT 'UNREVIEWED',
  "classification_version"                  INTEGER     NOT NULL DEFAULT 0,
  "first_discovered_at"                     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_fetched_at"                         TIMESTAMPTZ(6),
  "created_at"                              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retained_until"                          TIMESTAMPTZ(6),
  "deleted_at"                              TIMESTAMPTZ(6),

  CONSTRAINT "email_source_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_source_user_id_gmail_account_id_gmail_message_id_key"
    UNIQUE ("user_id", "gmail_account_id", "gmail_message_id"),
  CONSTRAINT "email_source_user_id_id_key"
    UNIQUE ("user_id", "id"),
  CONSTRAINT "chk_email_source_last_fetch_status" CHECK (
    "last_fetch_status" IN ('DISCOVERED', 'FETCHING', 'FETCHED', 'PERMANENTLY_FAILED')
  ),
  CONSTRAINT "chk_email_source_manual_classification" CHECK (
    "current_manual_classification"
      IN ('UNREVIEWED', 'FINANCIAL', 'NON_FINANCIAL', 'UNCERTAIN')
  ),
  CONSTRAINT "chk_email_source_classification_version"
    CHECK ("classification_version" >= 0),
  CONSTRAINT "chk_email_source_fetch_timestamps" CHECK (
    "last_fetch_attempt_at" IS NULL
    OR "last_fetch_attempt_at" >= "first_discovered_at"
  ),
  CONSTRAINT "chk_email_source_fetched_timestamp" CHECK (
    "last_fetched_at" IS NULL
    OR "last_fetched_at" >= "first_discovered_at"
  ),
  CONSTRAINT "chk_email_source_timestamps" CHECK (
    "updated_at" >= "created_at"
    AND ("deleted_at" IS NULL OR "deleted_at" >= "created_at")
  ),
  CONSTRAINT "email_source_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "email_source_gmail_account_id_fkey"
    FOREIGN KEY ("gmail_account_id") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "email_source_user_account_fetch_idx"
  ON "email_source"("user_id", "gmail_account_id", "last_fetch_status")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "email_source_user_account_discovered_idx"
  ON "email_source"("user_id", "gmail_account_id", "first_discovered_at" DESC)
  WHERE "deleted_at" IS NULL;
CREATE INDEX "email_source_manual_review_idx"
  ON "email_source"("user_id", "gmail_account_id", "current_manual_classification")
  WHERE "deleted_at" IS NULL
    AND "current_manual_classification" IN ('UNREVIEWED', 'UNCERTAIN');

CREATE TABLE "email_scan_run" (
  "id"                                TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"                           TEXT        NOT NULL,
  "client_request_id"                 TEXT        NOT NULL,
  "gmail_account_id"                  TEXT        NOT NULL,
  "email_filter_id"                   TEXT        NOT NULL,
  "email_filter_version_id"           TEXT        NOT NULL,
  "effective_gmail_query"             TEXT        NOT NULL,
  "from_date"                         DATE        NOT NULL,
  "to_date"                           DATE        NOT NULL,
  "scan_limit"                        INTEGER,
  "discovery_page_token"              TEXT,
  "discovery_complete"                BOOLEAN     NOT NULL DEFAULT false,
  "status"                            TEXT        NOT NULL DEFAULT 'CREATED',
  "current_stage"                     TEXT,
  "resume_stage"                      TEXT,
  "state_version"                     INTEGER     NOT NULL DEFAULT 0,
  "worker_lease_owner"                TEXT,
  "worker_lease_expires_at"           TIMESTAMPTZ(6),
  "next_retry_at"                     TIMESTAMPTZ(6),
  "retry_count"                       INTEGER     NOT NULL DEFAULT 0,
  "max_retries"                       INTEGER     NOT NULL DEFAULT 5,
  "max_item_retries"                  INTEGER     NOT NULL DEFAULT 3,
  "filter_rule_schema_version"        INTEGER     NOT NULL,
  "filter_evaluator_version"          INTEGER     NOT NULL,
  "filter_snapshot_json"              JSONB       NOT NULL,
  "total_discovered"                  INTEGER     NOT NULL DEFAULT 0,
  "fetch_pending_count"               INTEGER     NOT NULL DEFAULT 0,
  "fetch_in_progress_count"           INTEGER     NOT NULL DEFAULT 0,
  "fetch_success_count"               INTEGER     NOT NULL DEFAULT 0,
  "fetch_failed_count"                INTEGER     NOT NULL DEFAULT 0,
  "filter_included_count"             INTEGER     NOT NULL DEFAULT 0,
  "filter_excluded_count"             INTEGER     NOT NULL DEFAULT 0,
  "manual_review_count"               INTEGER     NOT NULL DEFAULT 0,
  "last_error_code"                   TEXT,
  "last_error_message_sanitized"      TEXT,
  "started_at"                        TIMESTAMPTZ(6),
  "last_checkpoint_at"                TIMESTAMPTZ(6),
  "last_batch_started_at"             TIMESTAMPTZ(6),
  "last_batch_completed_at"           TIMESTAMPTZ(6),
  "completed_at"                      TIMESTAMPTZ(6),
  "paused_at"                         TIMESTAMPTZ(6),
  "cancelled_at"                      TIMESTAMPTZ(6),
  "batch_sequence"                    BIGINT      NOT NULL DEFAULT 0,
  "pending_continuation_sequence"     BIGINT,
  "pending_continuation_stage"        TEXT,
  "pending_continuation_not_before"   TIMESTAMPTZ(6),
  "pending_continuation_published_at" TIMESTAMPTZ(6),
  "created_at"                        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_scan_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_scan_run_user_id_client_request_id_key"
    UNIQUE ("user_id", "client_request_id"),
  CONSTRAINT "chk_pending_continuation_coherence" CHECK (
    (
      "pending_continuation_sequence" IS NULL
      AND "pending_continuation_stage" IS NULL
      AND "pending_continuation_not_before" IS NULL
      AND "pending_continuation_published_at" IS NULL
    )
    OR
    (
      "pending_continuation_sequence" IS NOT NULL
      AND "pending_continuation_stage" IS NOT NULL
      AND "pending_continuation_not_before" IS NOT NULL
    )
  ),
  CONSTRAINT "chk_pending_sequence_matches_scan_sequence" CHECK (
    "pending_continuation_sequence" IS NULL
    OR "pending_continuation_sequence" = "batch_sequence"
  ),
  CONSTRAINT "chk_scan_run_status" CHECK (
    "status" IN (
      'CREATED', 'DISCOVERING', 'FETCHING', 'RETRY_WAIT', 'PAUSED',
      'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLING', 'CANCELLED'
    )
  ),
  CONSTRAINT "chk_scan_run_current_stage" CHECK (
    "current_stage" IS NULL OR "current_stage" IN ('DISCOVERY', 'FETCH')
  ),
  CONSTRAINT "chk_scan_run_resume_stage" CHECK (
    "resume_stage" IS NULL OR "resume_stage" IN ('DISCOVERY', 'FETCH')
  ),
  CONSTRAINT "chk_scan_run_pending_stage" CHECK (
    "pending_continuation_stage" IS NULL
    OR "pending_continuation_stage" IN ('DISCOVERY', 'FETCH')
  ),
  CONSTRAINT "chk_scan_run_date_range"
    CHECK ("from_date" <= "to_date"),
  CONSTRAINT "chk_scan_run_nonnegative_values" CHECK (
    ("scan_limit" IS NULL OR "scan_limit" > 0)
    AND "state_version" >= 0
    AND "retry_count" >= 0
    AND "max_retries" >= 0
    AND "max_item_retries" >= 0
    AND "total_discovered" >= 0
    AND "fetch_pending_count" >= 0
    AND "fetch_in_progress_count" >= 0
    AND "fetch_success_count" >= 0
    AND "fetch_failed_count" >= 0
    AND "filter_included_count" >= 0
    AND "filter_excluded_count" >= 0
    AND "manual_review_count" >= 0
    AND "batch_sequence" >= 0
  ),
  CONSTRAINT "chk_scan_run_counter_bounds" CHECK (
    "fetch_pending_count"
      + "fetch_in_progress_count"
      + "fetch_success_count"
      + "fetch_failed_count" <= "total_discovered"
    AND "fetch_pending_count" <= "total_discovered"
    AND "fetch_in_progress_count" <= "total_discovered"
    AND "fetch_success_count" <= "total_discovered"
    AND "fetch_failed_count" <= "total_discovered"
    AND "filter_included_count" <= "fetch_success_count"
    AND "filter_excluded_count" <= "fetch_success_count"
    AND "filter_included_count" + "filter_excluded_count" <= "fetch_success_count"
    AND "manual_review_count" <= "fetch_success_count"
  ),
  CONSTRAINT "chk_scan_run_stage_coherence" CHECK (
    (
      "status" = 'CREATED'
      AND "current_stage" IS NULL
      AND "resume_stage" IS NULL
      AND "started_at" IS NULL
    )
    OR (
      "status" = 'DISCOVERING'
      AND "current_stage" = 'DISCOVERY'
      AND "resume_stage" IS NULL
      AND "started_at" IS NOT NULL
    )
    OR (
      "status" = 'FETCHING'
      AND "current_stage" = 'FETCH'
      AND "resume_stage" IS NULL
      AND "started_at" IS NOT NULL
    )
    OR (
      "status" IN ('RETRY_WAIT', 'PAUSED')
      AND "current_stage" IS NULL
      AND "resume_stage" IS NOT NULL
      AND "started_at" IS NOT NULL
    )
    OR (
      "status" = 'CANCELLING'
      AND "started_at" IS NOT NULL
      AND (
        ("current_stage" IS NOT NULL AND "resume_stage" IS NULL)
        OR ("current_stage" IS NULL AND "resume_stage" IS NOT NULL)
      )
    )
    OR (
      "status" IN ('CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')
      AND "current_stage" IS NULL
      AND "resume_stage" IS NULL
      AND ("status" = 'CANCELLED' OR "started_at" IS NOT NULL)
    )
  ),
  CONSTRAINT "chk_scan_run_lease_coherence" CHECK (
    ("worker_lease_owner" IS NULL AND "worker_lease_expires_at" IS NULL)
    OR (
      "worker_lease_owner" IS NOT NULL
      AND "worker_lease_expires_at" IS NOT NULL
      AND "status" IN ('CREATED', 'DISCOVERING', 'FETCHING', 'RETRY_WAIT', 'CANCELLING')
    )
  ),
  CONSTRAINT "chk_scan_run_retry_coherence" CHECK (
    "status" <> 'RETRY_WAIT' OR "next_retry_at" IS NOT NULL
  ),
  CONSTRAINT "chk_scan_run_pending_status" CHECK (
    "pending_continuation_sequence" IS NULL
    OR "status" IN (
      'CREATED', 'DISCOVERING', 'FETCHING', 'RETRY_WAIT', 'PAUSED', 'CANCELLING'
    )
  ),
  CONSTRAINT "chk_scan_run_terminal_coherence" CHECK (
    "status" NOT IN ('CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')
    OR (
      "worker_lease_owner" IS NULL
      AND "worker_lease_expires_at" IS NULL
      AND "next_retry_at" IS NULL
      AND "pending_continuation_sequence" IS NULL
      AND "pending_continuation_stage" IS NULL
      AND "pending_continuation_not_before" IS NULL
      AND "pending_continuation_published_at" IS NULL
    )
  ),
  CONSTRAINT "chk_scan_run_terminal_timestamps" CHECK (
    (
      "status" NOT IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
      OR "completed_at" IS NOT NULL
    )
    AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
    AND ("status" <> 'PAUSED' OR "paused_at" IS NOT NULL)
  ),
  CONSTRAINT "chk_scan_run_timestamps" CHECK (
    "updated_at" >= "created_at"
    AND ("started_at" IS NULL OR "started_at" >= "created_at")
    AND (
      "last_checkpoint_at" IS NULL
      OR "started_at" IS NULL
      OR "last_checkpoint_at" >= "started_at"
    )
    AND (
      "last_batch_started_at" IS NULL
      OR "started_at" IS NULL
      OR "last_batch_started_at" >= "started_at"
    )
    AND (
      "last_batch_completed_at" IS NULL
      OR (
        "last_batch_started_at" IS NOT NULL
        AND "last_batch_completed_at" >= "last_batch_started_at"
      )
    )
    AND (
      "completed_at" IS NULL
      OR "started_at" IS NULL
      OR "completed_at" >= "started_at"
    )
    AND (
      "paused_at" IS NULL
      OR "started_at" IS NULL
      OR "paused_at" >= "started_at"
    )
    AND (
      "cancelled_at" IS NULL
      OR "started_at" IS NULL
      OR "cancelled_at" >= "started_at"
    )
  ),
  CONSTRAINT "email_scan_run_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "email_scan_run_gmail_account_id_fkey"
    FOREIGN KEY ("gmail_account_id") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "email_scan_run_email_filter_id_fkey"
    FOREIGN KEY ("email_filter_id") REFERENCES "email_filter"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "email_scan_run_email_filter_version_id_fkey"
    FOREIGN KEY ("email_filter_version_id") REFERENCES "email_filter_version"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

ALTER TABLE "email_scan_run"
  ADD CONSTRAINT "fk_scan_run_filter_ownership"
  FOREIGN KEY ("user_id", "gmail_account_id", "email_filter_id")
  REFERENCES "email_filter"("user_id", "gmail_account_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "email_scan_run"
  ADD CONSTRAINT "fk_scan_run_filter_version"
  FOREIGN KEY ("email_filter_id", "email_filter_version_id")
  REFERENCES "email_filter_version"("email_filter_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "email_scan_run_user_status_idx"
  ON "email_scan_run"("user_id", "status");
CREATE INDEX "email_scan_run_user_account_idx"
  ON "email_scan_run"("user_id", "gmail_account_id");
CREATE INDEX "email_scan_run_retry_idx"
  ON "email_scan_run"("next_retry_at")
  WHERE "status" = 'RETRY_WAIT';
CREATE INDEX "email_scan_run_lease_idx"
  ON "email_scan_run"("worker_lease_expires_at")
  WHERE "worker_lease_owner" IS NOT NULL;
CREATE INDEX "email_scan_run_continuation_recovery_idx"
  ON "email_scan_run"("pending_continuation_not_before")
  WHERE "pending_continuation_sequence" IS NOT NULL
    AND "pending_continuation_published_at" IS NULL;

CREATE TABLE "email_scan_item" (
  "id"                               TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "scan_run_id"                      TEXT        NOT NULL,
  "email_source_id"                  TEXT        NOT NULL,
  "status"                           TEXT        NOT NULL DEFAULT 'DISCOVERED',
  "state_version"                    INTEGER     NOT NULL DEFAULT 0,
  "fetch_attempt_count"              INTEGER     NOT NULL DEFAULT 0,
  "next_retry_at"                    TIMESTAMPTZ(6),
  "last_error_code"                  TEXT,
  "last_error_message_sanitized"     TEXT,
  "item_lease_owner"                 TEXT,
  "item_lease_expires_at"            TIMESTAMPTZ(6),
  "filter_decision"                  TEXT        NOT NULL DEFAULT 'PENDING',
  "matched_include_rule_ids"         TEXT[],
  "matched_exclude_rule_ids"         TEXT[],
  "filter_decision_reason_sanitized" TEXT,
  "discovered_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fetch_started_at"                 TIMESTAMPTZ(6),
  "fetch_completed_at"               TIMESTAMPTZ(6),
  "updated_at"                       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_scan_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_scan_item_scan_run_id_email_source_id_key"
    UNIQUE ("scan_run_id", "email_source_id"),
  CONSTRAINT "chk_scan_item_status" CHECK (
    "status" IN (
      'DISCOVERED', 'FETCHING', 'FETCHED',
      'RETRY_WAIT', 'PERMANENTLY_FAILED', 'CANCELLED'
    )
  ),
  CONSTRAINT "chk_scan_item_filter_decision" CHECK (
    "filter_decision" IN ('PENDING', 'INCLUDED', 'EXCLUDED')
  ),
  CONSTRAINT "chk_scan_item_nonnegative_values" CHECK (
    "state_version" >= 0 AND "fetch_attempt_count" >= 0
  ),
  CONSTRAINT "chk_scan_item_lease_coherence" CHECK (
    (
      "status" = 'FETCHING'
      AND "item_lease_owner" IS NOT NULL
      AND "item_lease_expires_at" IS NOT NULL
    )
    OR
    (
      "status" <> 'FETCHING'
      AND "item_lease_owner" IS NULL
      AND "item_lease_expires_at" IS NULL
    )
  ),
  CONSTRAINT "chk_scan_item_retry_coherence" CHECK (
    ("status" = 'RETRY_WAIT' AND "next_retry_at" IS NOT NULL)
    OR ("status" <> 'RETRY_WAIT' AND "next_retry_at" IS NULL)
  ),
  CONSTRAINT "chk_scan_item_filter_coherence" CHECK (
    "status" = 'FETCHED' OR "filter_decision" = 'PENDING'
  ),
  CONSTRAINT "chk_scan_item_terminal_timestamps" CHECK (
    (
      "status" NOT IN ('FETCHED', 'PERMANENTLY_FAILED')
      OR "fetch_completed_at" IS NOT NULL
    )
    AND ("status" <> 'FETCHING' OR "fetch_started_at" IS NOT NULL)
  ),
  CONSTRAINT "chk_scan_item_timestamps" CHECK (
    "updated_at" >= "discovered_at"
    AND (
      "fetch_started_at" IS NULL
      OR "fetch_started_at" >= "discovered_at"
    )
    AND (
      "fetch_completed_at" IS NULL
      OR (
        "fetch_started_at" IS NOT NULL
        AND "fetch_completed_at" >= "fetch_started_at"
      )
    )
  ),
  CONSTRAINT "email_scan_item_scan_run_id_fkey"
    FOREIGN KEY ("scan_run_id") REFERENCES "email_scan_run"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "email_scan_item_email_source_id_fkey"
    FOREIGN KEY ("email_source_id") REFERENCES "email_source"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "email_scan_item_run_status_idx"
  ON "email_scan_item"("scan_run_id", "status");
CREATE INDEX "email_scan_item_source_idx"
  ON "email_scan_item"("email_source_id");
CREATE INDEX "email_scan_item_retry_idx"
  ON "email_scan_item"("next_retry_at")
  WHERE "status" = 'RETRY_WAIT';
CREATE INDEX "email_scan_item_lease_idx"
  ON "email_scan_item"("item_lease_expires_at")
  WHERE "item_lease_owner" IS NOT NULL;
CREATE INDEX "email_scan_item_filter_decision_idx"
  ON "email_scan_item"("scan_run_id", "filter_decision")
  WHERE "status" = 'FETCHED';

CREATE FUNCTION "check_scan_item_source_ownership"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.email_source_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.email_source AS source
      JOIN public.email_scan_run AS scan
        ON scan.id = NEW.scan_run_id
      WHERE source.id = NEW.email_source_id
        AND source.user_id = scan.user_id
        AND source.gmail_account_id = scan.gmail_account_id
    ) THEN
      RAISE EXCEPTION
        'email_scan_item.email_source_id does not belong to same user/gmail_account_id as scan run';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "trg_email_scan_item_source_ownership"
  AFTER INSERT OR UPDATE OF "email_source_id", "scan_run_id"
  ON "email_scan_item"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  EXECUTE FUNCTION "check_scan_item_source_ownership"();

CREATE FUNCTION "prevent_scan_item_parent_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
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

CREATE TRIGGER "trg_email_scan_item_parent_immutable"
  BEFORE UPDATE ON "email_scan_item"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_scan_item_parent_change"();

CREATE TABLE "email_manual_classification" (
  "id"                      TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"                 TEXT        NOT NULL,
  "email_source_id"         TEXT        NOT NULL,
  "previous_classification" TEXT        NOT NULL,
  "new_classification"      TEXT        NOT NULL,
  "reason"                  TEXT,
  "classified_by"           TEXT,
  "classified_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "classification_version"  INTEGER     NOT NULL,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_manual_classification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_manual_classification_email_source_id_classification__key"
    UNIQUE ("email_source_id", "classification_version"),
  CONSTRAINT "chk_manual_previous_classification" CHECK (
    "previous_classification"
      IN ('UNREVIEWED', 'FINANCIAL', 'NON_FINANCIAL', 'UNCERTAIN')
  ),
  CONSTRAINT "chk_manual_new_classification" CHECK (
    "new_classification"
      IN ('UNREVIEWED', 'FINANCIAL', 'NON_FINANCIAL', 'UNCERTAIN')
  ),
  CONSTRAINT "chk_manual_classification_version"
    CHECK ("classification_version" > 0),
  CONSTRAINT "chk_manual_classification_change"
    CHECK ("previous_classification" <> "new_classification"),
  CONSTRAINT "chk_manual_classification_timestamps"
    CHECK ("created_at" >= "classified_at"),
  CONSTRAINT "email_manual_classification_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "email_manual_classification_classified_by_fkey"
    FOREIGN KEY ("classified_by") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX "email_manual_classification_source_idx"
  ON "email_manual_classification"("email_source_id", "classified_at" DESC);
CREATE INDEX "email_manual_classification_user_idx"
  ON "email_manual_classification"("user_id", "classified_at" DESC);

ALTER TABLE "email_manual_classification"
  ADD CONSTRAINT "fk_classification_source"
  FOREIGN KEY ("user_id", "email_source_id")
  REFERENCES "email_source"("user_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "email_filter"
  ADD CONSTRAINT "fk_email_filter_account"
  FOREIGN KEY ("user_id", "gmail_account_id")
  REFERENCES "Account"("userId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "email_source"
  ADD CONSTRAINT "fk_email_source_account"
  FOREIGN KEY ("user_id", "gmail_account_id")
  REFERENCES "Account"("userId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "email_scan_run"
  ADD CONSTRAINT "fk_email_scan_run_account"
  FOREIGN KEY ("user_id", "gmail_account_id")
  REFERENCES "Account"("userId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMIT;
