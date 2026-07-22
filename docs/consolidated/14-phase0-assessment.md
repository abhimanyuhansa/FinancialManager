# 14 — Phase 0: Architecture Audit & Redesign Assessment (Revised)

> **Assessment date:** 2026-07-16 (initial) / **Revised:** 2026-07-18, 2026-07-19
> **Assessed by:** Senior Software Architect (incoming), per master prompt
> `/Downloads/FinancialManager-Claude-Code-Master-Prompt-Reviewed.md`
> **Baseline commit inspected:** `260dd90a792ae0fb2d13f952ef26a93d28c1cec8`
> **Status:** Schema decisions Q1–Q4 applied 2026-07-19; final corrections C1–C89 applied 2026-07-23.
> D-1: Pending final consolidation approval. D-2: Approved. D-3: Approved. D-4: Conditionally approved. D-5: Approved. D-6: Approved.
> Awaiting explicit Phase 1A implementation approval before any code changes begin.
> **Revision reason (2026-07-18):** D-1 schema rejected and respecified; D-2 changed to
> QStash; D-3 corrected; D-4 expanded with `LEGACY_TRANSACTION_INGESTION_ENABLED`; D-5/D-6
> approved. Eight required Phase 0 corrections applied.
> **Revision reason (2026-07-19, pass 1):** Schema decisions applied per PM approval:
> Q1 — Scan-run initial status `CREATED` (not `PENDING`); `RETRY_WAIT` and `CANCELLING` retained.
> Q2 — Item status `SKIPPED_BY_FILTER` removed; `filter_decision` field added (`PENDING`/`INCLUDED`/`EXCLUDED`).
> Item statuses: `DISCOVERED`,`FETCHING`,`FETCHED`,`RETRY_WAIT`,`PERMANENTLY_FAILED` only.
> Q3 — Filter schema: two-table design `email_filter` + `email_filter_version`; `email_filter_rule` removed.
> Q4 — Manual classification: `email_manual_classification` with `email_source_id` FK;
> `previous_classification`/`new_classification` fields.
> Naming decisions: `email_source_id`, `normalized_subject`, `content_fingerprint_hmac`/`_version`/`_key_id`.
> **Revision reason (2026-07-19, pass 2):** Final corrections per conditional approval:
> C1 — `filter_decision` PENDING/INCLUDED/EXCLUDED separates fetch from filter outcome.
> C2 — `email_filter_version_id` NOT NULL; filter+version+pointer creation transactional.
> C3 — `current_stage`/`resume_stage` fields (DISCOVERY/FETCH); RETRY_WAIT claim gated on `next_retry_at <= now()`.
> C4 — `email_source` fetch fields renamed observational (`last_fetch_status`, `last_fetch_error_message_sanitized`).
> C5 — `current_manual_classification`/`classification_version` materialized on `email_source`; optimistic concurrency on classification updates.
> C6 — Terminal-state definitions and completion guard documented.
> **Revision reason (2026-07-19, pass 3 — final Phase 0 corrections):**
> C1(new) — Composite FK/trigger enforcement: `gmail_account_id` belongs to `user_id`;
>   `supersedes_version_id` belongs to same filter (trigger); `current_version_id` belongs to
>   same filter (deferred trigger); `email_scan_run.email_filter_version_id` belongs to
>   `email_filter_id` (trigger).
> C2(new) — `gmail_account_id` FK changed from CASCADE to RESTRICT on `email_filter`,
>   `email_source`, `email_scan_run`. Gmail disconnection preserves historical metadata.
> C3(new) — Completion guard extended: blocks on `FETCHED + filter_decision=PENDING` in
>   addition to `status IN (DISCOVERED,FETCHING,RETRY_WAIT)`. AC-39 updated.
> C4(new) — Cancellation two-path: no-lease → CANCELLED (Path A); active-lease → CANCELLING
>   then worker confirms CANCELLED (Path B). Late QStash deliveries to CANCELLING/CANCELLED are
>   no-ops. CANCELLED cannot re-enter active states.
> C5(new) — Three-layer retry model documented (§7.6a). `max_item_retries` added to
>   `email_scan_run`. Scan RETRY_WAIT gate: scan enters only when no claimable work AND ≥1
>   retryable item. Per-item RETRY_WAIT does not block other claimable items.
> C6(new) — `gmail_message_id` removed from `email_scan_item` (derive via FK join).
>   `to_date` made NOT NULL. `previous_classification` made NOT NULL.
>   `classification_version` and UNIQUE(email_source_id, classification_version) added to
>   `email_manual_classification`. Retention/erasure carve-out documented.
> C7(new) — Filter evaluation semantics documented: exclude wins; empty include = all included;
>   non-empty include = at least one must match. JSON schema, rule_id uniqueness, unsupported
>   rule handling, matched_rule_id persistence. ACs AC-26a–h added.
> C8(new) — QStash continuation design: deterministic message ID = sha256(scanRunId:stage:nextBatchSequence).
>   DB-then-publish order; non-2xx on publish failure forces QStash redelivery. Original 5-step
>   redelivery recovery sequence (superseded by C13 10-step protocol). DLQ handling, failure
>   callback, deduplication window expiry, manual recovery documented. ACs AC-33a–b added.
> **Revision reason (2026-07-19, pass 4 — final schema and protocol corrections):**
> C9 — QStash integration contract corrected: `@upstash/qstash` `Receiver` class replaces
>   manual HMAC language; JWT claims documented (`iss:"Upstash"`, `sub:<destination URL>`,
>   `exp`, `nbf`, `body` integrity claim — verified by SDK); dedup window corrected to **10 minutes** (not 7 days
>   — 7-day DLQ retention was confused with dedup window); free-plan default retries corrected
>   to **3**; `Upstash-Retries` header (publish-time retry config — C17 corrects prior `Upstash-Retry-Count` name), `Upstash-Retry-Delay`
>   header (backoff control), and `Retry-After` destination response header documented.
> C10 — Cross-tenant SQL invariants completed: all 7 constraint trigger function bodies
>   provided; `UNIQUE(userId, id)` on `Account` prerequisite documented for composite FK;
>   five new trigger functions added for gmail-account ownership, scan filter ownership,
>   scan filter-account match, scan item source ownership, and classification user match.
> C11 — Gmail account disconnection model added (§6.7): RESTRICT requires explicit
>   soft-disconnect; OAuth tokens cleared (`access_token = NULL`, `refresh_token
>   = NULL`); `disconnected_at` timestamp added; future Gmail calls blocked by API-layer check;
>   reconnection via re-OAuth replaces tokens on same Account row; user erasure removes
>   retained Account history. `classified_by` FK corrected to ON DELETE SET NULL (nullable)
>   so user deletion cannot block or cascade-delete classification history.
> C12 — Execution and state semantics: `last_error` renamed `last_error_message_sanitized`
>   on `email_scan_run`; lease duration derived from configurable
>   `WORKER_LEASE_DURATION_SECONDS ?? '55'`; item-claim SQL added with
>   `SELECT … FOR UPDATE SKIP LOCKED`; active→FAILED transitions added to state machine;
>   item `CANCELLED` terminal status added; `started_at` corrected to nullable (set on first
>   CREATED→DISCOVERING transition); `classification_version` INSERT semantics documented;
>   filter version immutability enforced by DB trigger (raises exception on UPDATE);
>   retention/erasure bypass path (SECURITY DEFINER function) documented.
> C13 — Worker invocation protocol corrected to 10-step sequence; step 1 uses `Receiver.verify`;
>   step 5 uses `FOR UPDATE SKIP LOCKED` item claim; 10-minute dedup window noted; step 9
>   returns retryable non-2xx on publish failure; step 10 returns non-retryable only for
>   conclusively invalid or unrecoverable messages. ACs AC-57/AC-58 updated; new ACs
>   AC-74a–e (disconnection), AC-75a–c (immutability), AC-76a–b (item CANCELLED) added.
> **Revision reason (2026-07-19, pass 5 — correctness review corrections):**
> C14 — Progress formula corrected: `filter_excluded_count` is a subset of `FETCHED` items and
>   must not be double-counted. Processed = `PERMANENTLY_FAILED` + `FETCHED` items where
>   `filter_decision IN (INCLUDED, EXCLUDED)`. `CANCELLED` items excluded from all completion
>   counts. A scan with `CANCELLED` items must itself be in `CANCELLED` status.
>   Completion guard, reconciliation query, and ACs updated.
> C15 — Classification versioning corrected: `newVersion = N + 1`; history row inserted with
>   `classification_version = newVersion`; `email_source.classification_version` updated to
>   `newVersion` in the same transaction. History row and materialized source version always
>   match after commit.
> C16 — Draft-rule API removed: six-table schema has no draft-rule persistence. Rule-draft CRUD
>   (`POST/PATCH/DELETE /api/email-filter-rules`) removed from Phase 1A API surface.
>   API renamed around filters and versions only.
> C17 — QStash HTTP behavior corrected: non-retryable = HTTP 489 +
>   `Upstash-NonRetryable-Error: true`; transient = HTTP 500. Publish header corrected to
>   `Upstash-Retries` (not `Upstash-Retry-Count`). `Receiver.verify()` must receive exact
>   worker URL for JWT subject validation. Failure callback uses `Receiver` JWT (not custom
>   HMAC). Body integrity claim is `body`; rely on official SDK.
> C18 — Message-ID replay rejection removed: `Upstash-Message-Id` is for diagnostics only.
>   Idempotency enforced by DB state, leases, optimistic locking, uniqueness constraints.
> C19 — SECURITY DEFINER erasure function corrected: SECURITY DEFINER bypasses RLS/ownership,
>   NOT triggers. Immutability trigger blocks UPDATE; erasure performs DELETE — so SECURITY
>   DEFINER is unnecessary for erasure. Function removed; prefer cascade DELETE via parent
>   `email_filter`. Any remaining SECURITY DEFINER function requires: fixed `search_path`,
>   fully qualified objects, REVOKE PUBLIC, validated user, security tests.
> C20 — Declarative composite FKs added where UNIQUE constraints exist, replacing 4 of 7
>   triggers. `email_filter → Account`, `email_source → Account`, `email_scan_run → Account`,
>   `email_scan_run → email_filter_version`, `email_filter_version(supersedes)`,
>   `email_manual_classification → email_source` now use composite declarative FKs.
>   Remaining triggers: cross-tenant ownership (3) and current_version_id deferred circularity.
> C21 — Account deletion ordering corrected: User CASCADE does not overcome Account RESTRICT.
>   Exact erasure transaction defined with explicit child-deletion ordering. Account additive
>   changes (`UNIQUE("userId", id)`, `disconnected_at`, `disconnection_reason`) are proposed
>   under D-1 and stated as additive non-destructive. Actual NextAuth field names used.
> C22 — QStash quota recovery corrected: no automatic midnight recovery unless a separate
>   scheduler performs it. Phase 1A: mark paused + manual resume + optional Vercel daily cron
>   sweeper. Approved behavior documented.
> C23 — Filter evaluation versioning added: `rule_schema_version` and `filter_evaluator_version`
>   immutable fields added to `email_filter_version`; scan snapshot records both; worker fails
>   with incompatible-filter-version error on unsupported version (not silent non-match).
> **Revision reason (2026-07-19, pass 6 — final consolidation corrections C24–C33):**
> C24 — `trg_email_scan_item_source_ownership` restored: C20 incorrectly listed it as replaced
>   by `fk_classification_source`. That FK only covers `email_manual_classification → email_source`.
>   No declarative FK can express "scan item source must belong to same user and gmail_account_id
>   as its scan run" — cross-row join required. Trigger restored in trigger table and final
>   reduced constraint table; C20 removal claim corrected in body text.
> C25 — Scan lease acquisition corrected: `AND state_version = $expectedVersion` removed from
>   the lease query. QStash messages do not carry `expectedVersion`; after a checkpoint commit,
>   the DB version has advanced, causing redeliveries to return 0 rows and permanently stall the
>   scan. On 0 rows from lease acquisition: re-read authoritative DB state; if work remains,
>   publish continuation recovery. `state_version` retained for post-lease state transitions only.
> C26 — Item-claim query corrected: added `RETRY_WAIT` eligible arm (`next_retry_at <= now()
>   AND fetch_attempt_count < $maxItemRetries`); added separate `PERMANENTLY_FAILED` transition
>   for exhausted items (`fetch_attempt_count >= max_item_retries`). Previously, RETRY_WAIT items
>   were never reclaimed and exhausted items would be reclaimed indefinitely.
> C27 — DDL canonicalized: superseded trigger definitions removed from active schema sections;
>   historical removal notes remain in revision header only.
> C28 — Stale QStash references removed: `upstash-body-hash` JWT claim name removed from
>   worker code comments; HTTP 401 for non-retryable replaced with HTTP 489 +
>   `Upstash-NonRetryable-Error: true`; `~7 days` deduplication window corrected to 10 minutes
>   in all body text; HMAC authentication wording removed from worker integration notes;
>   AC-57 updated to require HTTP 489 (not HTTP 401).
> C29 — Phase 1A API aligned to canonical 7 routes: `GET /api/gmail/scan/list` removed from
>   Phase 1A scope (not in the approved route set). `DELETE /api/gmail/scan/{id}` not present
>   (confirmed absent). Canonical routes: POST /api/gmail/scan, GET /api/gmail/scan/{id},
>   POST pause/resume/cancel/retry, POST /api/gmail/scan/worker.
> C30 — Phase 1A testing acceptance criteria rewritten: DATABASE_URL must point to dedicated
>   isolated test database; transaction-count check is a delta (not absolute zero); email_scan_item
>   count = Gmail-discovered ID count; existing email_source reuse required; fetch failures
>   visible through email_scan_item only; complete AC-01–AC-76 matrix required.
> C31 — Constraint 7 wording corrected: "no existing tables altered" replaced with "No
>   destructive or incompatible changes to existing tables. Only the explicitly approved additive
>   Account changes are permitted."
> C32 — Filter version compatibility moved to scan level: incompatible `rule_schema_version`
>   or `filter_evaluator_version` → scan transitions to FAILED before fetching begins (not item
>   PERMANENTLY_FAILED). AC-26i corrected; AC-26j (scan snapshot) unchanged.
> C33 — Status metadata updated: "pending after C1–C8" replaced with "pending after C1–C23
>   final consolidation" across all affected status lines.
> **Phase 0 revision 2026-07-19 pass 7 (C34–C39):**
> C34 — DDL canonicalized: `check_scan_run_filter_version_belongs_to_filter` function and
>   `trg_email_scan_run_filter_integrity` trigger removed — superseded by `fk_scan_run_filter_version`
>   (already present). `trg_email_scan_run_filter_user` + `trg_email_scan_run_filter_account`
>   removed — replaced by composite FK `fk_scan_run_filter_ownership`
>   (`email_scan_run(user_id,gmail_account_id,email_filter_id) → email_filter(user_id,gmail_account_id,id)`).
>   `trg_email_filter_current_version` + `check_current_version_same_filter` removed — replaced
>   by composite FK `fk_email_filter_current_version`
>   (`email_filter(id,current_version_id) → email_filter_version(email_filter_id,id)`).
>   Full SQL for `trg_email_scan_item_source_ownership` added inline after `email_scan_item` DDL.
>   Three final triggers: `trg_email_filter_version_immutable`, `trg_email_scan_item_source_ownership`,
>   `trg_email_scan_item_parent_immutable` (C67 — blocks structural reparenting of scan items).
> C35 — Stale `state_version = $expected` predicate confirmed absent from lease acquisition
>   queries. `state_version` used only for post-lease state transitions.
> C36 — Retry-exhaustion corrected: PERMANENTLY_FAILED transition only when `status = RETRY_WAIT`
>   OR (`status = FETCHING` AND `item_lease_expires_at < now()`). Never terminalize an item with
>   an unexpired active lease. Exhaustion update clears lease fields, sets `last_error_code`,
>   increments `state_version`.
> C37 — Zero-row lease decision table corrected: five branches; no blind continuation publish.
>   Continuation recovery only after proving no active worker, scan is eligible, work remains.
> C38 — Document propagation: POST /api/gmail/scan (not /scan/start); /api/email-filters hierarchy
>   (not /api/email-filter-rules); Receiver JWT (not HMAC); /scan/worker (not /scan/tick);
>   no email_source.body_text; correct decision status.
> C39 — Status metadata updated: C1–C33 applied (not C1–C23); D-1 through D-6 statuses corrected.
> **Pass 8 (C40–C45) — 2026-07-19:**
> C40 — `state_version = $expected` removed from RETRY_WAIT claim gate query (same rationale as C25).
> C41 — Checkpoint-and-lease-release transaction defined: item results + counters + batch_sequence
>   + lease release committed atomically; next QStash continuation published using returned batch_sequence.
> C42 — `batch_sequence BIGINT NOT NULL DEFAULT 0`, `created_at`, `updated_at` added to email_scan_run DDL.
> C43 — Step 4 of worker protocol corrected: RETRY_WAIT with next_retry_at > now() is skipped (not
>   permanently excluded); RETRY_WAIT with next_retry_at <= now() + below limit is claimed;
>   exhausted RETRY_WAIT transitions to PERMANENTLY_FAILED.
> C44 — Branch E of zero-row decision table corrected: scan is complete only when
>   discovery_complete=true AND item-level completion guard passes; sub-branches added for
>   discovery_page_token handling.
> C45 — Stale content removed: obsolete lease query; stale scan-filter trigger comments; AC-74b
>   corrected to access_token/refresh_token (not provider_token/provider_refresh_token).
> **Pass 9 (C46–C56) — 2026-07-19:**
> C46 — Durable pending-continuation state added to email_scan_run DDL: `pending_continuation_sequence`,
>   `pending_continuation_stage`, `pending_continuation_not_before`, `pending_continuation_published_at`.
>   Checkpoint transaction updated to persist these fields atomically. Step 7 updated to mark
>   `pending_continuation_published_at` after QStash accepts. Zero-row Branch B and E3 updated to
>   verify `pending_continuation_published_at` and republish if NULL.
> C47 — Zero-row checkpoint behavior corrected: if `WHERE worker_lease_owner = $leaseOwner` matches
>   0 rows, the entire transaction is rolled back. No item results, counters, or batch_sequence changes
>   committed. Return HTTP 200 only if another worker demonstrably committed the same work; otherwise
>   HTTP 500. Ambiguous "log and return HTTP 200" instruction removed.
> C48 — Canonical email_scan_run field names established: `fetch_success_count`, `fetch_failed_count`,
>   `filter_included_count`, `filter_excluded_count`, `discovery_page_token`, `batch_sequence BIGINT`.
>   Obsolete names `total_fetched`, `total_fetch_failed`, `total_filter_excluded`, `next_page_token`,
>   `batch_sequence INTEGER` removed from all docs.
> C49 — Item-claim query updated: `item_lease_expires_at` uses `$itemLeaseDurationSecs` (not
>   hardcoded 50s); added `state_version = state_version + 1`, `fetch_started_at = now()`,
>   `next_retry_at = NULL`; RETURNING extended with `fetch_attempt_count` and `state_version`.
> C50 — 06: `error_message` replaced with `last_error_message_sanitized` in §8.4. Failure callback
>   (`POST /api/gmail/scan/worker-failure`) marked deferred — not part of Phase 1A. 05: ownership
>   taxonomy corrected — `email_filter_version` and `email_scan_item` are PARENT_SCOPED; the four
>   tables with direct `user_id` are TENANT_SCOPED_ENFORCED.
> C51 — Propagated all four `pending_continuation_*` fields to 04 and 05. Added CHECK constraint
>   `chk_pending_continuation_coherence` to `email_scan_run` DDL requiring all four fields NULL (no
>   continuation) or sequence/stage/not_before non-null (continuation pending); published_at may
>   remain NULL until publication confirmed. API progress response updated.
> C52 — `POST /api/gmail/scan` creation transaction now persists initial pending continuation
>   atomically before any QStash call: `pending_continuation_sequence=0`, stage=DISCOVERY,
>   not_before=now(), published_at=NULL. Publication compare-and-set applied after commit. On publish
>   failure, scan row is durable and recoverable. Three test specs added (AC-77a–c).
> C53 — Compare-and-set publication acknowledgment: `pending_continuation_published_at` update
>   uses four-predicate WHERE (id, sequence, stage, published_at IS NULL). Stale publisher cannot
>   overwrite newer continuation. Sequence validation table added: stale (seq<batch_sequence)→HTTP 200;
>   current (seq=pending_sequence AND stage matches)→process; future/inconsistent→HTTP 489. ACs AC-78a–c added.
> C54 — `enqueueNextBatch(scanRunId, delaySeconds?)` replaced with `ScanContinuation` interface +
>   `enqueueContinuation(continuation: ScanContinuation)` throughout 04 and 14. Canonical worker flow
>   order updated: (1) process work, (2) commit results+counters+batch_sequence+pending continuation+
>   lease release, (3) publish persisted continuation, (4) CAS published_at, (5) return HTTP 200.
>   Stale statements removed: enqueue-before-lease-release, state-version-conflict→200, hardcoded 55s/50s
>   lease intervals. Discovery unit = ≤500 IDs per page; fetch batch = ≤25 items. AC-79 added.
> C55 — Single-column FK `email_source_id REFERENCES email_source(id) ON DELETE CASCADE` removed from
>   `email_manual_classification.email_source_id`. Only the composite FK
>   `FOREIGN KEY (user_id, email_source_id) REFERENCES email_source(user_id, id) ON DELETE CASCADE`
>   is used (`fk_classification_source`). FK table and erasure prose updated.
> C56 — Item-result transition SQL added for FETCHING→FETCHED, FETCHING→RETRY_WAIT, and
>   FETCHING→PERMANENTLY_FAILED. Each verifies `item_lease_owner = $uuid`; 0 rows = roll back.
>   FETCHED: clears error fields, sets fetch_completed_at. RETRY_WAIT: sets next_retry_at + sanitized
>   error. PERMANENTLY_FAILED: sets fetch_completed_at, clears next_retry_at, stores terminal error.
>   Unknown rule type now fails the scan before discovery (INVALID_FILTER_SCHEMA, HTTP 200 after
>   lease acquisition) — not per-item PERMANENTLY_FAILED. ACs AC-80a–c and AC-81 added.
> **Pass 10 (C57–C63) — 2026-07-19:**
> C57 — Worker protocol reordered: lease acquisition moved to step 5 (after JWT verify, message
>   parse, DB state read, and sequence/stage validation). New step 2 parses `WorkerMessage` and
>   validates structural types. New step 4 validates sequence: stale→HTTP 200; current→proceed;
>   future/inconsistent→HTTP 489. Lease acquisition query now requires `pending_continuation_sequence
>   = $messageSequence AND pending_continuation_stage = $messageStage`; a continuation that does not
>   match the current pending state must never acquire the lease.
> C58 — Item-result optimistic concurrency strengthened: all three FETCHING→terminal transitions now
>   require `status='FETCHING' AND item_lease_owner=$uuid AND item_lease_expires_at>now() AND
>   state_version=$claimedStateVersion`. 0 rows → roll back result write. Exhaustion query adds
>   `fetch_completed_at=now()`.
> C59 — `trg_email_scan_item_source_ownership` trigger corrected: `AFTER INSERT OR UPDATE OF
>   email_source_id, scan_run_id` (scan_run_id added). Immutability of both fields documented.
> C60 — Unknown-rule-type contradiction resolved: unknown rule type now consistently transitions the
>   **scan** to FAILED (`last_error_code='INVALID_FILTER_SCHEMA'`) before discovery begins — never
>   marks individual items PERMANENTLY_FAILED. AC-26g updated. `last_error_code TEXT` added to
>   `email_scan_run` DDL and propagated to 04 and 05.
> C61 — Scan creation made idempotent and recoverable: `client_request_id TEXT NOT NULL` +
>   `UNIQUE(user_id, client_request_id)` added to `email_scan_run`. POST /api/gmail/scan accepts
>   `Idempotency-Key` header; duplicate requests return the original scan. Publish failure returns
>   `schedulingStatus: 'PENDING_RETRY'` with `scanRunId`; retry endpoint republishes same dedup ID.
>   Test specs added for timeout, duplicate POST, publish failure, and retry.
> C62 — Cancellation Path A made atomic: single transaction transitions all DISCOVERED/FETCHING/
>   RETRY_WAIT items to CANCELLED (clearing lease fields + incrementing state_version) AND sets scan
>   status=CANCELLED + clears worker lease + clears all four pending_continuation_* fields. Path B
>   worker performs same terminal cleanup after completing its current batch.
> C63 — Continuation serialization corrected: `ScanContinuation.sequence` changed from `bigint` to
>   `string` (decimal representation) throughout. Worker converts `BigInt(message.sequence)` after
>   parse. JSON.stringify(bigint) is explicitly prohibited. Dedup ID formula updated (no .toString()).
> **Pass 11 (C65–C71) — 2026-07-19:**
> C65 — Stale-message recovery corrected: stale delivery (sequence < batch_sequence) must attempt
>   republication of the persisted pending continuation when `pending_continuation_published_at IS NULL`
>   rather than returning HTTP 200 immediately. Recovery reads authoritative pending_continuation_*
>   fields, publishes with the same deterministic dedup ID, and CAS-sets `published_at`. Returns HTTP 500
>   if publication fails (so QStash retries). Does not re-process the stale batch.
> C66 — CANCELLING made recoverable: CANCELLING with unexpired lease → active worker handles cleanup.
>   CANCELLING with no/expired lease → next worker delivery or cancel request performs terminal cleanup
>   (transition items to CANCELLED, set scan CANCELLED, clear lease and pending continuation). First
>   worker acquisition of a CREATED scan now atomically initializes status=DISCOVERING,
>   current_stage=DISCOVERY, started_at=COALESCE(started_at,now()) — no window where CREATED holds
>   an active worker lease without entering DISCOVERING.
> C67 — `trg_email_scan_item_parent_immutable` added: BEFORE UPDATE trigger rejects any change to
>   `scan_run_id` or `email_source_id` on an existing scan item. Three final triggers:
>   `trg_email_filter_version_immutable`, `trg_email_scan_item_source_ownership`,
>   `trg_email_scan_item_parent_immutable`. 05-data-model-apis.md §1.9 updated accordingly.
> C68 — Continuation contract canonicalized: `ScanContinuation.sequence` is `string` everywhere
>   (C63 completed this; C68 confirms QStash payload format `"sequence":"0"`, not `"sequence":0`).
>   `batchSequence` completely removed from message format and dedup formula. Initial scan-start
>   publication failure returns HTTP 202 with `{ scanRunId, status:"CREATED", schedulingStatus:"PENDING_RETRY" }`
>   — not an opaque error. 04-architecture.md updated.
> C69 — Filter compatibility validation moved from step 3 to step 6 (after lease acquisition).
>   Worker protocol extended to 11 steps. Incompatible filter → transition scan to FAILED under held
>   lease, clear pending continuation, release lease, return HTTP 200. HTTP 489 restricted to steps 1
>   (invalid JWT), 2 (malformed payload), and 4 (structurally impossible continuation). AC-26g, AC-26i,
>   AC-81 updated.
> C70 — email_scan_run field list in 05-data-model-apis.md canonicalized: 9 missing fields added
>   (scan_limit, discovery_complete, fetch_pending_count, fetch_in_progress_count, manual_review_count,
>   next_retry_at, last_batch_started_at, last_batch_completed_at, paused_at).
>   email_scan_item timing fields corrected: created_at replaced with discovered_at; fetch_started_at
>   and fetch_completed_at added. chk_pending_continuation_coherence CHECK constraint documented.
>   UNIQUE(user_id, client_request_id) noted. worker_last_active_at and estimated_completion_at marked
>   as derived API fields (not persisted DB columns).
> C71 — Retry-route decision table added (§7.8): supports CREATED+unpublished, RETRY_WAIT, and
>   retryable FAILED; rejects COMPLETED, COMPLETED_WITH_ERRORS, CANCELLED, and unrecoverable FAILED
>   states (INVALID_FILTER_SCHEMA, INCOMPATIBLE_FILTER_VERSION). Route republishes authoritative
>   persisted continuation; never constructs a new sequence independently.
> **Revision reason (2026-07-19, final corrections C72–C76 — execution-contract corrections):**
> C72 — Complete pause and resume semantics: PAUSED branch added to step 3 (worker returns HTTP 200
>   no-op without acquiring lease; resume_stage and pending_continuation_* fields preserved intact).
>   Resume transaction documented: locks row, verifies PAUSED, restores status from resume_stage,
>   advances batch_sequence, persists new pending_continuation_* fields, commits, publishes fresh
>   continuation, CAS published_at. batch_sequence clarified as monotonic continuation generation
>   counter (advances on checkpoint, resume, and manual retry scheduling). Required test cases added:
>   pause before scheduled delivery, scheduled delivery while PAUSED, resume within 10-minute dedup
>   window, repeated pause/resume, resume publication failure.
> C73 — Worker steps 7–8 rewritten: execution branches by message stage after lease acquisition and
>   filter validation. DISCOVERY path: call one Gmail List API page (≤500 IDs), upsert email_source
>   rows, insert email_scan_item memberships with ON CONFLICT DO NOTHING, persist discovery_page_token
>   and discovery_complete, transition to FETCH when complete. FETCH path: execute FOR UPDATE SKIP
>   LOCKED item-claim query, claim ≤25 DISCOVERED or eligible RETRY_WAIT items, fetch metadata.
>   Item claiming is explicitly FETCH-only; DISCOVERY path does not execute item-claim query.
> C74 — cancelPending(scanRunId) removed from SchedulerService interface: QStash message IDs are not
>   persisted; claiming cancellation of a pending message is a false contract. Phase 1A relies on DB
>   state: PAUSED/CANCELLING/CANCELLED deliveries handled as no-ops or terminal cleanup in step 3.
>   Path B cancellation text updated to remove cancelPending reference.
> C75 — chk_pending_sequence_matches_scan_sequence CHECK constraint added to email_scan_run DDL:
>   pending_continuation_sequence IS NULL OR pending_continuation_sequence = batch_sequence.
>   All checkpoint, resume, and retry transactions preserve this invariant. Worker must fail safely
>   on any row that violates continuation-state coherence.
> C76 — Final canonical cleanup: "exactly these 10 steps" corrected to "exactly these 11 steps";
>   AC-77a updated to expect HTTP 202 with PENDING_RETRY; AC-78a updated to include C65 stale-message
>   continuation recovery procedure; AC-79 step references corrected (step 9 commits/releases lease,
>   step 5 acquires lease); DISCOVERY and FETCH execution separated explicitly in worker steps 7–8.
> **Revision reason (2026-07-23, corrections C77–C83 — schema/retry/document alignment):**
> C77–C80 — Earlier dry-run attempt superseded. Final canonical isolated C84 dry run pending
>   Stage 1 approval. Do not treat any prior dry-run output as final migration validation.
> C81 — Executable DDL aligned to canonical schema: `gmail_query_snapshot` renamed `effective_gmail_query`;
>   `total_fetched`, `total_filter_included`, `total_filter_excluded` removed; `retry_count INTEGER NOT NULL DEFAULT 0`
>   and `max_retries INTEGER NOT NULL DEFAULT 5` added; `filter_snapshot_json` changed to `JSONB NOT NULL`;
>   `filter_rule_schema_version` and `filter_evaluator_version` documented as explicit snapshot fields.
> C82 — FAILED is terminal and unrecoverable: "retryable FAILED" concept removed; recoverable errors
>   must transition to `RETRY_WAIT` or `PAUSED` instead of `FAILED`; `RETRY_WAIT` manual retry response
>   corrected to return actual committed status (`DISCOVERING` or `FETCHING`) from `resume_stage`, not
>   the literal string `"RETRY_WAIT"`; Case 3 removed from §7.8; summary table updated accordingly;
>   AC-7.8-3 updated to expect 422 rejection for `FAILED` status.
> C83 — Document cleanup: step 8 rollback-note references updated to step 9; trigger count corrected
>   to "Remaining triggers: 3" (was "2 of the original 7"); C77–C83 recorded in status metadata.
> **Revision reason (2026-07-23, corrections C85–C88 — executable SQL, field parity, retry semantics, dry-run status):**
> C85 — Complete executable SQL committed to `docs/consolidated/` as `phase1a-dry-run.sql`; temporary
>   path and excerpt are insufficient for approval.
> C86 — `email_scan_run` field table in 05-data-model-apis.md corrected: `gmail_account_id` FK RESTRICT,
>   `status` CHECK, `state_version` NOT NULL, `total_discovered` NOT NULL, `retry_count` NOT NULL,
>   `max_retries` NOT NULL, `max_item_retries` NOT NULL, `created_at`/`updated_at` NOT NULL with defaults;
>   route description for `/retry` corrected (FAILED removed as retryable option).
> C87 — Stalled active-scan recovery defined: DISCOVERING or FETCHING with expired lease → lock, verify
>   no active worker, verify unfinished work, increment batch_sequence, persist fresh continuation using
>   current_stage, commit + publish + CAS, return current status. Unexpired lease → 409 scan_active.
>   §7.8 table, Phase 1A route tables, DLQ/failure-callback text, and ACs updated. Active phrases
>   "retryable FAILED", "retry a failed/error scan", "all active scans reject retry" removed.
> C88 — C77–C80 dry-run claim corrected: earlier attempt superseded; final canonical isolated C84 dry
>   run pending Stage 1 approval. No migration validation claimed before C84 executes.
> C89 — Constraint name standardized to `account_user_id_id_unique` everywhere (was `Account_userId_id_unique`
>   in phase1a-dry-run.sql). Missing `account_disconnected_idx` added to SQL. SQL header updated to
>   C81–C89; psql usage updated to `docs/consolidated/phase1a-dry-run.sql`. Filter FKs confirmed RESTRICT.
>   All verification SELECT queries converted to DO/RAISE EXCEPTION assertions (C92). VP13 rewritten
>   to canonical C90 erasure order: manual_classification → scan_item → scan_run → source →
>   filter (CASCADE removes versions) → Account → User; all 8 tables asserted zero.
>   §7.8 table updated: CREATED+published → 409 scan_active; PAUSED → 409 scan_paused (C91); ACs updated.
>

---

## 0. Purpose and Constraints

This document records the complete Phase 0 findings and revised Phase 1A plan. It supersedes
the initial Phase 0 assessment written 2026-07-16.

**Non-negotiable constraints — all still unimplemented:**

1. `LLM_PARSING_ENABLED=false` + `LEGACY_TRANSACTION_INGESTION_ENABLED=false` must be
   enforced in Phase 1A. Tests must prove no AI provider, static parser, template cache,
   exact result cache, `ParseLog` creation, or `upsertTransactionV2` can execute while
   these flags are disabled.
2. Fetching emails must NEVER create financial transactions.
3. Fetching and parsing must be completely separate operations.
4. Process emails in small, bounded, resumable units.
5. Every email must succeed or fail independently.
6. All processing must be idempotent.
7. No destructive or incompatible changes to existing tables. Only the explicitly approved additive Account changes are permitted.
8. Do not deploy, alter production data, provision external resources, or change Vercel
   environment variables without explicit approval.

---

## 1. Current-State Architecture Summary

The application is a **Next.js 16 App Router monolith** deployed on **Vercel Hobby** (60-second
function limit, daily cron `0 2 * * *`). All server logic lives in `src/app/api/**/route.ts`
and `src/lib/`.

### Sync State Machine (confirmed at `260dd90`)

```
User click → POST /api/gmail/sync/start  → SyncJob {status="scanning"}
                                                       ↓
                              Client polls GET /api/gmail/sync/advance (every ~2s)
                                          ↓
                                 advance/route.ts GET handler
                                     ├─ Scanning phase: fetchMessageIdPage → SyncJobMessage.createMany
                                     └─ Running phase: advanceJobLocked()
                                          → fetchFullMessageBatch (Gmail Batch API)
                                          → Exclusion rule check (SYSTEM_GLOBAL ExclusionRule)
                                          → Tier-0: parseEmailStatic()
                                             └─ if "parsed": upsertTransactionV2() + ParseLog
                                             └─ if "not_transaction": ParseLog
                                             └─ if "insufficient_data": queue for Tier 1+
                                          → Tier-1: lookupExactCache() — exact ParseLog lookup by gmailMsgId
                                          → Tier-2: preloadTemplates() / applyTemplate()
                                             └─ ACTIVE: upsertTransactionV2() + ParseLog
                                             └─ SHADOW/DEGRADED: shadow run, queue for LLM
                                          → Tier-3: parseEmailBatchLLM() via router
                                             └─ selectProvider(): Gemini primary → OpenAI fallback
                                             └─ if all providers fail: llmFailedRowIds (not marked processed)
                                          → SyncJobMessage.updateMany({processed:true})
                                            excluding llmFailedRowIds and missingRowIds
```

### Critical observations

1. **Scanning and running are in the same GET handler.** There is no architectural boundary
   between "discover what emails exist" and "create financial transactions."
2. **Transaction creation is implicit** — `upsertTransactionV2()` fires in the same HTTP
   request that received email content from Gmail.
3. **Progress requires an open browser** — `SyncJob` advances only when the client polls.
   The daily cron advances once at 02:00 UTC, then stops.
4. **No `LLM_PARSING_ENABLED` flag exists** — confirmed by `grep -rn "LLM_PARSING_ENABLED" src`
   returning empty output.

---

## 2. LLM Routing Correction (Required Correction #2)

The initial Phase 0 assessment described "Gemini primary → OpenAI fallback" without clarifying
whether this fallback occurs within the same tick or on a subsequent tick. ADR-06 states "one
provider per tick with no within-tick fallback." These appeared contradictory. Code inspection
at `260dd90` resolves this:

### Actual behavior (confirmed in `src/lib/llm/router.ts`)

`selectProvider()` tries the primary provider (Gemini, unless `LLM_PRIMARY_PROVIDER` overrides)
first. If Gemini's circuit breaker is `OPEN`, its quota is exhausted, or its effective timeout
falls below 5000ms, `selectProvider()` immediately tries OpenAI within the same function call.
The caller (`parseEmailBatchLLM`) receives whichever provider was selected.

**This means:**
- Gemini→OpenAI fallback CAN occur within the same invocation at the `selectProvider` level.
- ADR-06's "one provider per tick" refers to the fact that a single batch goes to a single
  provider — there is no split where some emails go to Gemini and others to OpenAI in the same
  batch. The batch as a whole is processed by whichever provider `selectProvider` returns.
- If `selectProvider` returns OpenAI (because Gemini was unavailable), OpenAI processes the
  entire batch for that tick.
- If both providers are unavailable (`ProviderExhaustedError`), the entire batch fails and all
  candidate row IDs are added to `llmFailedRowIds` — they remain `processed=false` for the
  next tick.

### What "failed rows remain retryable" means

After a total LLM failure (`advance/route.ts:440–460`):
- An `error` ParseLog is written for each candidate.
- The row ID is added to `llmFailedRowIds`.
- The `updateMany({processed:true})` excludes these IDs.
- On the next advance tick, these messages reappear in `findMany({processed:false})` and
  re-enter the parse chain.
- If the same LLM failure recurs, the row gets another `error` ParseLog but remains retryable.
- There is **no maximum retry count** — rows can cycle indefinitely until the LLM recovers.

### How circuit breakers affect provider selection

`getCircuitBreakerState(provider)` returns `CLOSED | HALF_OPEN | OPEN`. If `OPEN`, `tryReserve`
returns null immediately. If `HALF_OPEN`, `tryAcquireHalfOpenProbe` allows at most one probe
request through. A provider's circuit opens after repeated failures and allows probe requests
at a configured interval. This means: after a sustained Gemini outage, Gemini's circuit will
be `OPEN` and OpenAI will be selected as primary for subsequent ticks without user action.

### Correction to ADR-06

ADR-06 must be corrected. The actual behavior is: the LLM batch for a given tick is processed
by exactly one provider, but that provider is selected by `selectProvider()` which can fall
through from Gemini to OpenAI within the same tick if Gemini's circuit/quota gates block it.
This is not "no within-tick fallback" — it is "within-tick provider selection with fallback,
but the selected batch is atomic." See `07-design-decisions.md` ADR-06 update.

---

## 3. Root-Cause Validation (unchanged from initial assessment)

| # | Root Cause | Evidence |
|---|-----------|----------|
| RC-1 | **No `LLM_PARSING_ENABLED` flag** | `grep -rn "LLM_PARSING_ENABLED" src` → empty |
| RC-2 | **Fetch and parse in same function** | `advance/route.ts:advanceJobLocked()` — 706 lines, does both |
| RC-3 | **Transaction creation is implicit** | `upsertTransactionV2()` in same HTTP request as email fetch |
| RC-4 | **Progress is browser-dependent** | `SyncJob` advances only when client polls |
| RC-5 | **No email inventory model** | `SyncJobMessage` is job-scoped and single-pass; no persistent inventory |
| RC-6 | **No worker design** | `CHUNK_SIZE=25` magic constant; no claim/lease/timeout concept |
| RC-7 | **No feature-flag infrastructure** | No `featureFlags.ts`; all `src/lib/llm/` is unconditionally active |
| RC-8 | **60-second hard ceiling** | Large inbox scans may exhaust Vercel budget before any parsing |
| RC-9 | **PDF password decryption never called** | `gmail.ts:27` calls `pdfParse(buffer)` with no password |
| RC-10 | **No retry limit on failed rows** | `llmFailedRowIds` rows re-enter indefinitely; no max-retry count |

---

## 4. End-to-End Data Flow Trace (as-built — unchanged)

```
1. User: POST /api/gmail/sync/start → SyncJob{status="scanning"}
2. Client polls GET /api/gmail/sync/advance every 2s
3. Scanning: fetchMessageIdPage → SyncJobMessage.createMany → SyncJob.status="running"
4. Running (per tick): fetchFullMessageBatch → [exclusion → tier-0 → tier-1 → tier-2 → tier-3 → upsertTransactionV2] → SyncJobMessage.updateMany({processed:true})
5. Client sees {phase:"complete"} → shows summary
```

The problem: between receiving a gmailMsgId and creating a Transaction row, there is no stop
point, no gate, and no flag.

---

## 5. Decision Outcomes

### D-1 — New scan tables alongside `SyncJob` (pending final consolidation approval)

**Approved direction:** New tables. Do not extend `SyncJob` or `SyncJobMessage`.

**Schema revision required.** See §6 (Normalized Schema) for the full revised design.

### D-2 — QStash for server-side scan progression (approved with corrections)

Upstash QStash free tier (verified 2026-07-18):
- 1,000 messages/day
- 1 MB max message size
- 7-day max delay
- 15-minute max HTTP response duration
- 3-day DLQ retention
- 3-day log retention
- 10-minute deduplication window
- 10 active schedules, 10 queues, max parallelism 10

**Estimated messages for a 6-month scan:**
- Gmail List API: ~500 IDs/page → a 3,000-email inbox = ~6 discovery messages
- Fetch batches: 25 emails/batch → 3,000 emails = ~120 fetch messages
- Plus retries: assume 5% retry rate → ~7 retries
- Total per scan: ~133 messages for a 3,000-email 6-month inbox
- At 1,000/day free tier: a single scan completes in < 1 day; adequate for personal POC use.
- **Risk:** Power users with 10,000+ email inboxes approach the daily limit. Document this.

**Design decisions from D-2:**
- QStash is used for background progression only. PostgreSQL is the authoritative state store.
- The browser polls a read-only status endpoint for display; closing the browser does not stop the scan.
- Each worker invocation must verify the QStash request using the official `@upstash/qstash`
  `Receiver` class before any DB access. Manual HMAC computation is NOT used.
- A `SchedulerService` interface abstracts QStash; the domain service is not coupled to QStash request objects.

### D-3 — Body hash / no body storage (approved with corrections)

**Approved:** Do not persist raw or normalized email bodies.

**Fingerprint:** An HMAC-SHA-256 content fingerprint may be stored only if a concrete Phase 1A
requirement justifies it. The fingerprint is NOT the source identity or deduplication key.

Source idempotency uses: `user_id + gmail_account_id + gmail_message_id`

**Option comparison (required by D-3):**

| | Option A: Gmail re-fetch only | Option B: Encrypted normalized snapshot |
|---|---|---|
| Advantages | Lower retained-data risk; no stored body | Reproducible parsing; offline regression |
| Disadvantages | Email may be deleted; Gmail revocation breaks re-parse | PII retained at rest; encryption + key-management obligations |
| Phase 1A decision | **Use this** | Deferred — evaluate if Phase 1C regression testing requires it |

**Phase 1A stores:** metadata only (subject, sender, received date, has_attachment, filter_decision). No body, no body hash by default.

**Reproducibility limitation:** If a source email is deleted from Gmail, Gmail authorization is revoked, or the connected account is removed, deterministic re-parsing is not possible. This is a known, accepted limitation documented here.

### D-4 — Feature flags (conditionally approved — feature flags and legacy-path shutdown)

**Two flags required:**

`LLM_PARSING_ENABLED=false`
- Prevents AI provider calls only.
- Does NOT stop: static parsing, template cache, exact result cache, parse logging, transaction creation.

`LEGACY_TRANSACTION_INGESTION_ENABLED=false`
- Disables the complete legacy transaction-ingestion path.
- When false: legacy sync-start must not create a `SyncJob`; legacy advance must not discover, fetch, parse, or process email; legacy sync UI must be hidden or clearly disabled; legacy endpoints return a deliberate feature-disabled response.
- Static parsing must not execute.
- Exact-result cache resolution must not execute.
- Template-cache parsing must not execute.
- Gemini must not execute.
- OpenAI must not execute.
- `upsertTransactionV2` must not execute.
- `ParseLog` must not be created.
- No transaction may be inserted, updated, or deleted.

**Both flags must be server-only.** Never `NEXT_PUBLIC_*`. Safe default for any missing or malformed value: disabled.

**Vercel env change:** Do not make this change during Phase 0 revision. The change is documented here as a required pre-deployment step for Phase 1A.

### D-5 — SYSTEM_GLOBAL models unchanged (approved)

Leave `GmailQueryKeyword`, `ExclusionRule`, `MerchantMaster`, `SubCategoryMaster` unchanged.
New `email_filter` and `email_filter_version` tables are per-user. Mark legacy `EmailFilter` settings UI as deprecated.
Do not claim the new system has replaced the legacy model until migration, cutover, legacy UI
removal, and legacy API removal are all complete and tested.

### D-6 — Remove `?secret=` query param (approved)

Phase 1A must remove `querySecret` path from `advance/route.ts`. Authentication model:
- User-triggered routes: session authentication only
- QStash worker endpoint: QStash JWT signature verification via `@upstash/qstash` `Receiver` class (C9)
- Internal non-QStash callers: server-only Bearer token (explicitly approved callers only)
- No secrets in URLs, browser bundles, application logs, proxy logs, access logs, or DB error records

Do not modify the existing route during this Phase 0 revision.

---

## 6. Revised Normalized Schema [Planned — pending approval]

The revised schema separates six concerns clearly:

1. Logical user-owned filter definition (`email_filter`)
2. Immutable published filter configuration snapshots (`email_filter_version`)
3. A persistent Gmail source email (`email_source`)
4. Scan session + worker execution state (`email_scan_run`)
5. Membership of a source email in a particular scan (`email_scan_item`)
6. Manual classification audit history (`email_manual_classification`)

**Total: 6 tables.** There is no individual-rule row table. All rule content lives inside
`email_filter_version.include_rules_json` and `email_filter_version.exclude_rules_json`.
Each rule embedded in the JSON must carry a stable `rule_id` field.

---

### Table: `email_filter`

The logical, user-owned filter entity. One row per named filter per user. Multiple versions
can be published against the same `email_filter`.

```sql
CREATE TABLE email_filter (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id             TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: disconnecting Gmail must not silently destroy filter history.
  -- Deletion of a Gmail account is blocked while any email_filter references it.
  -- Historical filter metadata must be removed through the approved retention workflow
  -- before the Account row can be deleted.
  gmail_account_id    TEXT        NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT,
  name                TEXT        NOT NULL,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  current_version_id  TEXT,       -- FK to email_filter_version.id; NULL until first version published
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cross-user isolation: (user_id, gmail_account_id) must be a valid pair owned by the same user.
  -- Enforced by composite FK fk_email_filter_account (C20): FOREIGN KEY (user_id, gmail_account_id)
  -- REFERENCES Account("userId", id). Requires UNIQUE("userId", id) on Account (additive — C10).
  -- DB-layer backup: UNIQUE(user_id, gmail_account_id) index below prevents one user
  -- from referencing another user's gmail_account_id by accident.
  UNIQUE(user_id, gmail_account_id, id)  -- enables composite FK references from child tables
);
-- FK back to email_filter_version is deferred (circular reference); added after version table.
CREATE INDEX email_filter_user_idx ON email_filter(user_id);
CREATE INDEX email_filter_user_account_idx ON email_filter(user_id, gmail_account_id);
```

---

### Table: `email_filter_version`

One immutable configuration snapshot per version. Once created, rows are never updated.
Each scan run stores the exact version it was run against, so filter decisions are reproducible
even if the filter is later revised.

```sql
CREATE TABLE email_filter_version (
  id                      TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email_filter_id         TEXT        NOT NULL REFERENCES email_filter(id) ON DELETE CASCADE,
  version                 INTEGER     NOT NULL,
  -- Effective Gmail query string for this version
  gmail_query             TEXT        NOT NULL,
  -- Immutable JSON arrays of rules. Each rule object MUST include a stable "rule_id" field.
  -- Example include rule: {"rule_id":"r-001","type":"sender_domain","pattern":"alerts.bank.com","action":"include"}
  -- Example exclude rule: {"rule_id":"r-002","type":"subject_keyword","pattern":"OTP","action":"exclude"}
  include_rules_json      JSONB       NOT NULL DEFAULT '[]',
  exclude_rules_json      JSONB       NOT NULL DEFAULT '[]',
  -- Evaluation versioning (C23): workers check these before evaluating.
  -- rule_schema_version: schema version of the rule objects in include/exclude_rules_json.
  --   Increment when the rule object shape changes (e.g., new required field added).
  -- filter_evaluator_version: version of the evaluation engine required to evaluate these rules.
  --   Increment when evaluation semantics change in a backward-incompatible way.
  rule_schema_version     INTEGER     NOT NULL DEFAULT 1,
  filter_evaluator_version INTEGER    NOT NULL DEFAULT 1,
  -- Traceability: which version this supersedes (must belong to the same email_filter).
  -- Enforced by composite FK fk_version_supersedes (C20): FOREIGN KEY (email_filter_id, supersedes_version_id)
  -- REFERENCES email_filter_version(email_filter_id, id). Requires UNIQUE(email_filter_id, id).
  supersedes_version_id   TEXT        REFERENCES email_filter_version(id),
  created_by              TEXT        NOT NULL,  -- user_id of publishing user
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_filter_id, version),
  UNIQUE(email_filter_id, id)   -- enables composite FK references from child tables (C20)
);
-- supersedes_version_id → email_filter_version(email_filter_id, id): declarative composite FK (C20)
-- Requires UNIQUE(email_filter_id, id) added above. trg_email_filter_version_supersedes removed.
ALTER TABLE email_filter_version
  ADD CONSTRAINT fk_version_supersedes
  FOREIGN KEY (email_filter_id, supersedes_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  DEFERRABLE INITIALLY DEFERRED;  -- deferred: first-version insert has NULL supersedes_version_id
-- Add back-reference FK from email_filter to its current version (deferred circular reference)
-- Composite FK: current_version_id must belong to this filter.
-- email_filter(id, current_version_id) → email_filter_version(email_filter_id, id)
-- UNIQUE(email_filter_id, id) on email_filter_version (defined above) makes this valid.
-- DEFERRABLE: email_filter.current_version_id starts NULL; set after first version insert.
ALTER TABLE email_filter
  ADD CONSTRAINT fk_email_filter_current_version
  FOREIGN KEY (id, current_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  DEFERRABLE INITIALLY DEFERRED;
-- trg_email_filter_current_version is removed — replaced by fk_email_filter_current_version (C34).
CREATE INDEX email_filter_version_filter_idx ON email_filter_version(email_filter_id);
```

**Immutability:** once `created_at` is set, no column on `email_filter_version` is ever
updated. Editing a filter creates a new version row; the `email_filter.current_version_id`
pointer is advanced atomically.

**DB-level immutability enforcement (C12):** A BEFORE UPDATE trigger raises an exception on any
attempt to UPDATE an `email_filter_version` row. Editing a filter creates a new version row.

```sql
-- Raises exception on any UPDATE; immutability is enforced at DB level.
CREATE OR REPLACE FUNCTION prevent_email_filter_version_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'email_filter_version rows are immutable; create a new version row instead';
END;
$$;

CREATE TRIGGER trg_email_filter_version_immutable
  BEFORE UPDATE ON email_filter_version
  FOR EACH ROW EXECUTE FUNCTION prevent_email_filter_version_update();
```

**Erasure / retention (C19):** SECURITY DEFINER bypasses RLS and ownership checks — it does
NOT bypass triggers. The immutability trigger blocks UPDATE; it does not block DELETE. A
separate `delete_email_filter_versions_for_user` SECURITY DEFINER function was planned but is
unnecessary: DELETE is not blocked by the UPDATE trigger. The preferred erasure approach is
to `DELETE` the parent `email_filter` row; the `ON DELETE CASCADE` constraint on
`email_filter_version.email_filter_id` then propagates the deletion to all version rows
automatically. No SECURITY DEFINER function is required for this operation.

Any future SECURITY DEFINER function added to this schema must satisfy all of the following:
- Set a fixed trusted `search_path` (e.g., `SET search_path = public`)
- Fully qualify all database objects
- `REVOKE EXECUTE … FROM PUBLIC`
- `GRANT EXECUTE` only to the specific erasure role
- Validate the requested user before operating
- Include security tests covering privilege escalation scenarios

**Rule IDs:** every rule object embedded in `include_rules_json` and `exclude_rules_json` must
carry a stable `rule_id` (e.g., a UUID or a short stable key). This enables `email_scan_item`
to record `matched_include_rule_ids` and `matched_exclude_rule_ids` as arrays of rule IDs
traceable back to this version snapshot.

**Rule ID uniqueness:** within a single filter version, no two rules in `include_rules_json`
or `exclude_rules_json` may share the same `rule_id`. Validated at version creation time;
the API must reject a publish request containing duplicate `rule_id` values with HTTP 422.

**Filter evaluation semantics (C7):**

Filter evaluation runs against fetched email metadata (sender domain, subject keywords,
Gmail labels, etc.) using the rules from `email_filter_version`.

**Evaluation algorithm:**
1. Evaluate all `exclude_rules_json` against the email. If any exclude rule matches, the
   result is `EXCLUDED` — no include rules are evaluated. Exclude match wins.
2. If no exclude rule matched:
   a. If `include_rules_json` is empty (`[]`), the result is `INCLUDED` (no include rules =
      included by default, unless excluded).
   b. If `include_rules_json` is non-empty, evaluate all include rules. If at least one include
      rule matches, the result is `INCLUDED`. If no include rule matches, the result is `EXCLUDED`.
3. Record the matching rule IDs in `email_scan_item.matched_exclude_rule_ids` (for exclude
   matches) or `email_scan_item.matched_include_rule_ids` (for include matches).
4. Record a sanitized, human-readable reason in `email_scan_item.filter_decision_reason_sanitized`.

**Default behaviour summary:**
> Exclude match wins. No include rules means included unless excluded. When include rules
> exist, at least one must match.

**Rule JSON schema validation:** Each rule object in `include_rules_json` and `exclude_rules_json`
must conform to the following minimal schema:
```typescript
interface FilterRule {
  rule_id: string;          // stable, unique within the version
  type: string;             // e.g. "sender_domain" | "subject_keyword" | "label"
  pattern: string;          // value to match against (interpreted per `type`)
  action: "include" | "exclude";
}
```
The API must validate all rules at version creation time. A publish request containing a rule
with a missing `rule_id`, missing `type`, missing `pattern`, unsupported `type`, or
unsupported `action` must be rejected with HTTP 422.

**Filter evaluation version check (C23, corrected by C32):** Before discovery begins, the
worker checks the scan run's snapshot `filter_rule_schema_version` and `filter_evaluator_version`
against its compiled-in `SUPPORTED_RULE_SCHEMA_VERSION` and `SUPPORTED_FILTER_EVALUATOR_VERSION`
constants. If either stored value exceeds the worker's supported version, this is a scan-level
configuration problem — the worker must transition the **scan** to `FAILED` before any fetching
begins (step 3 of the worker protocol). Log the version mismatch at ERROR level with
`rule_schema_version`, `filter_evaluator_version`, and `filter_id`. Do NOT transition individual
items to `PERMANENTLY_FAILED` for a scan-level configuration problem — marking every item as
permanently failed is misleading when the issue is a deployment mismatch, not a per-item fetch
error. Do NOT silently treat rules as non-matching — that would produce incorrect
INCLUDED/EXCLUDED decisions with no visible error. An incompatible-version failure surfaces
immediately and requires a worker deployment update.

**Unsupported rule types within a compatible schema version (C60):** If a rule's `type` value is
not recognised by the evaluation engine but the schema and evaluator version numbers are both
supported, this is still a scan-level configuration error — it indicates an invalid or
partially-deployed filter snapshot. Under the held worker lease (step 6 of the 11-step
protocol), the worker must transition `email_scan_run` to `FAILED` with
`last_error_code = 'INVALID_FILTER_SCHEMA'`, clear all pending continuation fields, release
the lease, and **return HTTP 200**. Do NOT mark individual items `PERMANENTLY_FAILED` — that
would be misleading when the issue is a filter schema problem, not a per-item fetch error.
HTTP 489 must NOT be returned for this case; the message is valid and the incompatibility
is a domain configuration error, not a structural message problem.

**Matched rule ID persistence:** `matched_include_rule_ids` and `matched_exclude_rule_ids` on
`email_scan_item` store the `rule_id` values of all rules that matched, as TEXT arrays. If no
rules matched (e.g., empty include rules, result = INCLUDED), these arrays are empty (`{}`).
The arrays are immutable once set.

---

### Table: `email_source`

One row per unique Gmail message per user per Gmail account. Persistent; survives across
multiple scan runs. Idempotent — re-scanning the same inbox does not create duplicate rows.

`gmail_account_id` is the internal application ID of the connected Google account record
(FK to `Account.id`, which is the NextAuth Account table). This is NOT the Gmail address,
NOT an OAuth token.

```sql
CREATE TABLE email_source (
  id                            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                       TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: disconnecting Gmail must not silently destroy email source inventory.
  -- Historical traceability is preserved; deletion must go through the approved retention workflow.
  gmail_account_id              TEXT        NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT,
  gmail_message_id              TEXT        NOT NULL,
  -- Metadata populated during fetch (NULL until fetched)
  subject                       TEXT,
  normalized_subject            TEXT,       -- variable tokens replaced; e.g. "<AMOUNT> spent on HDFC <LAST4>"
  sender_email                  TEXT,
  sender_name                   TEXT,
  sender_domain                 TEXT,
  received_at                   TIMESTAMPTZ,
  snippet_redacted              TEXT,       -- short preview; must not contain PII
  gmail_thread_id               TEXT,
  gmail_labels                  TEXT[],
  has_attachment                BOOLEAN     NOT NULL DEFAULT false,
  attachment_metadata           JSONB,      -- non-sensitive: type, count; no filenames with PAN etc.
  -- Content fingerprint (HMAC-SHA-256). Not a uniqueness key. Not stored by default in Phase 1A.
  -- Activated in Phase 1B or later when regression reproducibility justifies it.
  -- content_fingerprint_hmac     TEXT,    -- HMAC-SHA-256 of normalized body content
  -- content_fingerprint_version  TEXT,    -- algorithm version tag, e.g. 'hmac-sha256-v1'
  -- content_fingerprint_key_id   TEXT,    -- identifies the server-side HMAC key version used
  -- Source URL for opening in Gmail
  source_url                    TEXT,       -- https://mail.google.com/mail/u/0/#inbox/<gmail_message_id>
  -- Discovery and fetch state (observational — authoritative retry/terminal state is on email_scan_item)
  -- last_fetch_status reflects the outcome of the most recent fetch attempt across all scans.
  -- It does NOT permanently prevent future scans from retrying this source.
  last_fetch_status             TEXT        NOT NULL DEFAULT 'DISCOVERED'
                                  CHECK (last_fetch_status IN ('DISCOVERED','FETCHING','FETCHED','PERMANENTLY_FAILED')),
  last_fetch_attempt_at         TIMESTAMPTZ,
  last_fetch_error_code         TEXT,       -- sanitized error code; no PII
  last_fetch_error_message_sanitized TEXT,  -- sanitized; must not contain PII
  -- Classification denormalization (see §6 email_manual_classification for append-only audit history)
  current_manual_classification TEXT        NOT NULL DEFAULT 'UNREVIEWED'
                                  CHECK (current_manual_classification IN ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')),
  classification_version        INTEGER     NOT NULL DEFAULT 0,  -- optimistic concurrency for classification updates
  first_discovered_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at               TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Retention
  retained_until                TIMESTAMPTZ, -- NULL = retain indefinitely
  deleted_at                    TIMESTAMPTZ, -- soft-delete timestamp
  UNIQUE(user_id, gmail_account_id, gmail_message_id),
  UNIQUE(user_id, id)   -- enables composite FK references from child tables (C20)
);
CREATE INDEX email_source_user_account_fetch_idx
  ON email_source(user_id, gmail_account_id, last_fetch_status)
  WHERE deleted_at IS NULL;
CREATE INDEX email_source_user_account_discovered_idx
  ON email_source(user_id, gmail_account_id, first_discovered_at DESC)
  WHERE deleted_at IS NULL;
```

**Uniqueness:** `(user_id, gmail_account_id, gmail_message_id)` — enforces idempotency.

**Observational vs authoritative fetch state:** `last_fetch_status`, `last_fetch_error_code`,
`last_fetch_error_message_sanitized`, and `last_fetch_attempt_at` are observational convenience
fields reflecting the most recent fetch outcome across any scan. They do NOT determine whether
a future scan may retry this source. The authoritative retry and terminal status belongs to
`email_scan_item` — each scan run tracks its own per-item state independently. A source with
`last_fetch_status = 'PERMANENTLY_FAILED'` may still be included in a future scan run if the
failure was scan-specific or transient; the new scan's `email_scan_item` row starts as `DISCOVERED`.

**Content fingerprint fields** (`content_fingerprint_hmac`, `content_fingerprint_version`,
`content_fingerprint_key_id`) are defined but commented out in Phase 1A. They are activated
in Phase 1B when template fingerprinting requires reproducible content hashing. The HMAC key
is server-only; never exposed to clients or stored in DB records.

**Current manual classification:** `current_manual_classification` is a denormalized read
convenience column. The append-only `email_manual_classification` table is the authoritative
source. See §6 for the transactional update procedure.

**Retention and deletion:** `retained_until` enables scheduled cleanup. `deleted_at` enables
soft-delete. Hard deletion requires ensuring no `email_scan_item` rows from other scans
reference this source (FK RESTRICT on `email_scan_item.email_source_id`).

---

### Table: `email_scan_run`

One row per scan session. Records the parameters used (query snapshot, filter version, date
range) and tracks background execution state including worker lease.

```sql
CREATE TABLE email_scan_run (
  id                        TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                   TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  -- Idempotency key supplied by the client (C61); prevents duplicate scans on POST retry.
  client_request_id         TEXT        NOT NULL,
  -- ON DELETE RESTRICT: disconnecting Gmail must not silently destroy scan history.
  -- Historical scan metadata is preserved; deletion must go through the approved retention workflow.
  gmail_account_id          TEXT        NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT,
  -- Filter traceability: every scan must reference an immutable filter version.
  -- email_filter_id is derived from email_filter_version_id; retained for query convenience.
  -- Constraint: email_filter_id must equal email_filter_version.email_filter_id.
  -- Enforced by declarative composite FK fk_scan_run_filter_version:
  -- email_scan_run(email_filter_id, email_filter_version_id) → email_filter_version(email_filter_id, id)
  -- This requires UNIQUE(email_filter_id, id) on email_filter_version (added by C20).
  -- No trigger required for this invariant (C34, C45).
  email_filter_id           TEXT        NOT NULL REFERENCES email_filter(id),
  email_filter_version_id   TEXT        NOT NULL REFERENCES email_filter_version(id),
  -- Snapshots taken at scan start; immutable thereafter
  effective_gmail_query         TEXT        NOT NULL,   -- exact query string used; copy of email_filter_version.gmail_query
  filter_snapshot_json          JSONB       NOT NULL,   -- copy of email_filter_version include/exclude rules at scan start
  filter_rule_schema_version    INTEGER     NOT NULL,   -- snapshot of email_filter_version.rule_schema_version (C23)
  filter_evaluator_version      INTEGER     NOT NULL,   -- snapshot of email_filter_version.filter_evaluator_version (C23)
  from_date                 DATE        NOT NULL,
  to_date                   DATE        NOT NULL,   -- NOT NULL: Phase 1A scans are always bounded
  scan_limit                INTEGER,                -- max messages to discover (NULL = unlimited)
  -- Status and state machine
  status                    TEXT        NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT','PAUSED',
                      'CANCELLING','CANCELLED','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')),
  -- Stage tracking: preserves which processing stage a paused or retry-wait scan should resume to.
  -- current_stage is set when a worker begins active processing (DISCOVERING or FETCHING).
  -- resume_stage is set when the scan enters RETRY_WAIT or PAUSED; must equal the last current_stage.
  current_stage             TEXT        CHECK (current_stage IN ('DISCOVERY','FETCH')),
  resume_stage              TEXT        CHECK (resume_stage IN ('DISCOVERY','FETCH')),
  state_version             INTEGER     NOT NULL DEFAULT 0,  -- optimistic concurrency
  -- Progress counters (denormalized for fast display; reconcilable from email_scan_item)
  total_discovered          INTEGER     NOT NULL DEFAULT 0,
  discovery_complete        BOOLEAN     NOT NULL DEFAULT false,
  fetch_pending_count       INTEGER     NOT NULL DEFAULT 0,
  fetch_in_progress_count   INTEGER     NOT NULL DEFAULT 0,
  fetch_success_count       INTEGER     NOT NULL DEFAULT 0,
  fetch_failed_count        INTEGER     NOT NULL DEFAULT 0,
  filter_included_count     INTEGER     NOT NULL DEFAULT 0,
  filter_excluded_count     INTEGER     NOT NULL DEFAULT 0,
  manual_review_count       INTEGER     NOT NULL DEFAULT 0,
  -- Discovery pagination
  discovery_page_token      TEXT,
  -- Worker lease (scan-level)
  worker_lease_owner        TEXT,       -- cryptographically random UUID per invocation; server-generated
  worker_lease_expires_at   TIMESTAMPTZ,
  -- Retry state — three distinct retry layers (see §7.6 for per-layer semantics):
  --   Layer 1: QStash delivery retries (AT-LEAST-ONCE; controlled by QStash, not this table)
  --   Layer 2: Scan-level Gmail retries (retry_count / max_retries below)
  --   Layer 3: Per-item Gmail fetch retries (fetch_attempt_count / max_item_retries below)
  retry_count               INTEGER     NOT NULL DEFAULT 0,
  max_retries               INTEGER     NOT NULL DEFAULT 5,  -- scan-level; immutable after scan creation
  max_item_retries          INTEGER     NOT NULL DEFAULT 3,  -- per-item; immutable after scan creation
  next_retry_at             TIMESTAMPTZ,
  last_error_code           TEXT,                     -- machine-readable error code (e.g. 'INVALID_FILTER_SCHEMA')
  last_error_message_sanitized TEXT,              -- sanitized; must not contain PII
  -- Timing
  -- started_at: NULL until the first worker transitions CREATED → DISCOVERING.
  -- Set atomically in the CREATED → DISCOVERING transition; never updated thereafter.
  started_at                TIMESTAMPTZ,
  last_checkpoint_at        TIMESTAMPTZ,
  last_batch_started_at     TIMESTAMPTZ,
  last_batch_completed_at   TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  paused_at                 TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  -- Batch sequencing: monotonically incremented on every checkpoint commit (C41/C42)
  batch_sequence            BIGINT      NOT NULL DEFAULT 0,
  -- Pending continuation state (C46): durable record of the next scheduled QStash message.
  -- Written in the same transaction as item results, batch_sequence increment, and lease release.
  -- Allows redeliveries to republish the same deterministic continuation without guessing.
  -- pending_continuation_sequence: the batch_sequence value of the continuation message.
  -- pending_continuation_stage: 'DISCOVERY' or 'FETCH' — determines dedup ID and payload.
  -- pending_continuation_not_before: scheduled delivery time; now() for immediate, future for delayed.
  -- pending_continuation_published_at: set after QStash accepts publication; NULL = not yet published.
  pending_continuation_sequence     BIGINT,
  pending_continuation_stage        TEXT        CHECK (pending_continuation_stage IN ('DISCOVERY','FETCH')),
  pending_continuation_not_before   TIMESTAMPTZ,
  pending_continuation_published_at TIMESTAMPTZ,
  -- C51: all four pending fields must be collectively NULL or collectively non-null (except published_at
  -- which may remain NULL until publication is confirmed).
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
  -- C75: pending_continuation_sequence must equal batch_sequence when non-NULL.
  -- Checkpoint, resume, and retry transactions all advance batch_sequence before
  -- writing pending_continuation_sequence, so these two values are always in sync.
  -- The worker must fail safely on any row that violates this invariant.
  CONSTRAINT chk_pending_sequence_matches_scan_sequence CHECK (
    pending_continuation_sequence IS NULL
    OR pending_continuation_sequence = batch_sequence
  ),
  -- Idempotency: one scan per (user, client request) — prevents duplicate scans on POST retry (C61)
  UNIQUE(user_id, client_request_id),
  -- Standard audit timestamps
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Composite FK: scan filter must belong to the same user and gmail_account as the scan.
-- email_filter has UNIQUE(user_id, gmail_account_id, id) — makes this valid.
-- Replaces trg_email_scan_run_filter_user + trg_email_scan_run_filter_account (C34).
ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_scan_run_filter_ownership
  FOREIGN KEY (user_id, gmail_account_id, email_filter_id)
  REFERENCES email_filter (user_id, gmail_account_id, id);

-- Composite FK: filter version must belong to the referenced filter.
-- Replaces trg_email_scan_run_filter_integrity / check_scan_run_filter_version_belongs_to_filter (C34).
ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_scan_run_filter_version
  FOREIGN KEY (email_filter_id, email_filter_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  ON DELETE RESTRICT;
CREATE INDEX email_scan_run_user_status_idx
  ON email_scan_run(user_id, status);
CREATE INDEX email_scan_run_user_account_idx
  ON email_scan_run(user_id, gmail_account_id);
CREATE INDEX email_scan_run_retry_idx
  ON email_scan_run(next_retry_at)
  WHERE status = 'RETRY_WAIT';
```

**Lease:** `worker_lease_owner` is a `crypto.randomUUID()` generated server-side per
invocation. Never derived from `VERCEL_REGION + Date.now()` or any user-supplied value.
Lease duration is configurable: `process.env.WORKER_LEASE_DURATION_SECONDS ?? '55'`. The
default of 55s is derived from the Vercel 60-second execution limit minus a 5-second safety
margin. If the execution limit changes, update `WORKER_LEASE_DURATION_SECONDS` in Vercel env.
In application code: `const leaseSecs = parseInt(process.env.WORKER_LEASE_DURATION_SECONDS ?? '55', 10);`

**Filter version requirement:** Every scan must reference a versioned filter. `email_filter_version_id`
is NOT NULL. An ad hoc query without a pre-existing filter must still have an immutable version
record created before the scan starts — either the user creates a named filter and publishes a
version, or the system creates a filter+version atomically for ad hoc use.

**Filter referential integrity (declarative FK enforced):** `email_filter_id` and
`email_filter_version_id` are jointly constrained by `fk_scan_run_filter_version`
(`email_scan_run(email_filter_id, email_filter_version_id) → email_filter_version(email_filter_id, id)`)
— PostgreSQL enforces this at the DB layer on every insert and update. The scan filter's user
and Gmail account ownership is enforced by `fk_scan_run_filter_ownership`
(`email_scan_run(user_id, gmail_account_id, email_filter_id) → email_filter(user_id, gmail_account_id, id)`).
Application code in `ScanDomainService.createScanRun()` also validates this before inserting,
as a defence-in-depth guard.

**Transactional filter creation:** When a user creates a new named filter, the following
operations must complete in a single database transaction:
1. `INSERT INTO email_filter (user_id, gmail_account_id, name)` — creates the logical entity.
2. `INSERT INTO email_filter_version (email_filter_id, version=1, gmail_query, include_rules_json, exclude_rules_json, created_by)` — creates the first immutable snapshot.
3. `UPDATE email_filter SET current_version_id = $versionId WHERE id = $filterId` — advances the pointer.

If any step fails, the entire transaction rolls back. This guarantees that
`email_filter.current_version_id` always refers to a version belonging to the same filter.

**State machine:**

```
CREATED → DISCOVERING → FETCHING → COMPLETED
(stage=DISCOVERY)  (stage=FETCH)      ↓
      ↓           ↓             COMPLETED_WITH_ERRORS
   PAUSED      PAUSED
(resume_stage=DISCOVERY) (resume_stage=FETCH)
      ↓           ↓
   (resume)    (resume)
 DISCOVERING   FETCHING

DISCOVERING ↔ RETRY_WAIT ↔ DISCOVERING   (stage preserved via resume_stage=DISCOVERY)
FETCHING    ↔ RETRY_WAIT ↔ FETCHING      (stage preserved via resume_stage=FETCH)

DISCOVERING → FAILED  (unrecoverable: invalid token, corrupt state, max_retries exceeded)
FETCHING    → FAILED  (unrecoverable: invalid token, corrupt state, max_retries exceeded)
RETRY_WAIT  → FAILED  (max_retries exceeded)
CANCELLING  → CANCELLED  (from DISCOVERING, FETCHING, RETRY_WAIT, PAUSED)
```

**Allowed transitions (central validation — must be enforced in `ScanDomainService`):**

| From | To | Side effects on stage fields | Trigger |
|------|----|------------------------------|---------|
| `CREATED` | `DISCOVERING` | `current_stage = 'DISCOVERY'`, `started_at = now()` | First worker tick acquired lease |
| `DISCOVERING` | `FETCHING` | `current_stage = 'FETCH'` | Discovery phase complete |
| `DISCOVERING` | `PAUSED` | `resume_stage = 'DISCOVERY'` | User pause request |
| `DISCOVERING` | `RETRY_WAIT` | `resume_stage = 'DISCOVERY'` | Retryable Gmail error during discovery |
| `DISCOVERING` | `CANCELLING` | — | User cancel request |
| `FETCHING` | `COMPLETED` | `current_stage = NULL`, `resume_stage = NULL` | All items terminal, none `PERMANENTLY_FAILED` |
| `FETCHING` | `COMPLETED_WITH_ERRORS` | `current_stage = NULL`, `resume_stage = NULL` | All items terminal, ≥1 `PERMANENTLY_FAILED` |
| `FETCHING` | `PAUSED` | `resume_stage = 'FETCH'` | User pause request |
| `FETCHING` | `RETRY_WAIT` | `resume_stage = 'FETCH'` | Retryable Gmail error during fetch |
| `FETCHING` | `CANCELLING` | — | User cancel request |
| `RETRY_WAIT` | `DISCOVERING` | `current_stage = 'DISCOVERY'`, `resume_stage = NULL` | `next_retry_at <= now()`, `resume_stage = 'DISCOVERY'` |
| `RETRY_WAIT` | `FETCHING` | `current_stage = 'FETCH'`, `resume_stage = NULL` | `next_retry_at <= now()`, `resume_stage = 'FETCH'` |
| `RETRY_WAIT` | `FAILED` | — | `max_retries` exceeded at scan level |
| `DISCOVERING` | `FAILED` | — | Unrecoverable scan-level error (invalid token, corrupt state, max_retries exceeded) |
| `FETCHING` | `FAILED` | — | Unrecoverable scan-level error (invalid token, corrupt state, max_retries exceeded) |
| `PAUSED` | `DISCOVERING` | `current_stage = 'DISCOVERY'`, `resume_stage = NULL` | User resume, `resume_stage = 'DISCOVERY'` |
| `PAUSED` | `FETCHING` | `current_stage = 'FETCH'`, `resume_stage = NULL` | User resume, `resume_stage = 'FETCH'` |
| `PAUSED` | `CANCELLING` | — | User cancel while paused |
| `CANCELLING` | `CANCELLED` | — | In-flight batch completed; worker confirms cancellation |

**Terminal-state definitions (C6):**

| Status | Entry condition | Re-entry allowed |
|--------|----------------|-----------------|
| `COMPLETED` | All items in terminal status (`FETCHED` or `PERMANENTLY_FAILED`) AND count of `PERMANENTLY_FAILED` = 0 AND count of `CANCELLED` = 0 | No |
| `COMPLETED_WITH_ERRORS` | All items in terminal status (`FETCHED` or `PERMANENTLY_FAILED`) AND count of `PERMANENTLY_FAILED` ≥ 1 AND count of `CANCELLED` = 0 | No |
| `FAILED` | Unrecoverable scan-level error: `max_retries` exceeded; invalid/revoked OAuth token; corrupt scan state; or any error that makes further progress impossible | No |
| `CANCELLED` | Cancellation procedure complete (all items terminalized to `CANCELLED`, `FETCHED`, or `PERMANENTLY_FAILED`); no worker may continue processing | No |

**Completion guard:** A scan MUST NOT enter `COMPLETED` or `COMPLETED_WITH_ERRORS` while
any of the following conditions is true:

1. Any `email_scan_item` for that scan has `status IN ('DISCOVERED', 'FETCHING', 'RETRY_WAIT')`
   (items with unfinished fetch work).
2. Any `email_scan_item` for that scan has `status = 'FETCHED' AND filter_decision = 'PENDING'`
   (items fetched but not yet filter-evaluated).
3. Any `email_scan_item` for that scan has `status = 'CANCELLED'`
   (a scan containing cancelled items must itself be `CANCELLED`, not `COMPLETED` or `COMPLETED_WITH_ERRORS`).

Before executing the `FETCHING → COMPLETED` or `FETCHING → COMPLETED_WITH_ERRORS` transition,
the worker must verify all three conditions simultaneously:
```sql
SELECT COUNT(*) FROM email_scan_item
WHERE scan_run_id = $scanRunId
  AND (
    status IN ('DISCOVERED', 'FETCHING', 'RETRY_WAIT')
    OR (status = 'FETCHED' AND filter_decision = 'PENDING')
    OR status = 'CANCELLED'
  )
```
If this count > 0, the scan has unfinished work or cancelled items and must not be marked
complete. The worker should continue fetching or filter evaluation, or re-enter `RETRY_WAIT`.
A non-zero count due to `CANCELLED` items means the scan must transition to `CANCELLED` rather
than `COMPLETED`/`COMPLETED_WITH_ERRORS`. This same guard applies to progress reporting: the
progress API must never return 100% completion while this count > 0 (AC-39).

**`RETRY_WAIT` claim gate:** A worker may only claim a `RETRY_WAIT` scan when `next_retry_at <= now()`.
The worker-claim query must include this predicate explicitly (lease duration supplied as bound parameter):
```sql
UPDATE email_scan_run
SET worker_lease_owner      = $uuid,
    worker_lease_expires_at = now() + ($leaseDurationSecs || ' seconds')::interval,
    state_version           = state_version + 1
WHERE id = $id
  AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now() OR worker_lease_owner = $uuid)
  AND status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT')
  AND (status != 'RETRY_WAIT' OR next_retry_at <= now())
```
`state_version = $expected` is omitted — identical rationale as the main lease-acquisition
query (C40): QStash messages do not carry an expected version, and a stale predicate would
permanently stall redeliveries. `state_version` is used only for post-lease state transitions.
A scan in `RETRY_WAIT` whose `next_retry_at` is still in the future must not be claimed.
A scan in `CANCELLING` or any terminal state must not be claimed — such statuses are excluded
from the `status IN (...)` predicate above.

**Cancellation semantics:**

Two paths exist depending on whether an active worker lease is held at cancel time:

**Path A — no active lease (lease expired or was never acquired) (C62):**
The cancel request executes one atomic transaction that fully terminates the scan:
```sql
BEGIN;

-- 1. Transition all active items to CANCELLED in the same transaction.
UPDATE email_scan_item
SET status                = 'CANCELLED',
    item_lease_owner      = NULL,
    item_lease_expires_at = NULL,
    next_retry_at         = NULL,
    state_version         = state_version + 1,
    updated_at            = now()
WHERE scan_run_id = $id
  AND status IN ('DISCOVERED', 'FETCHING', 'RETRY_WAIT');

-- 2. Transition the scan run to CANCELLED, clear all lease and continuation fields.
UPDATE email_scan_run
SET status                            = 'CANCELLED',
    cancelled_at                      = now(),
    state_version                     = state_version + 1,
    worker_lease_owner                = NULL,
    worker_lease_expires_at           = NULL,
    pending_continuation_sequence     = NULL,
    pending_continuation_stage        = NULL,
    pending_continuation_not_before   = NULL,
    pending_continuation_published_at = NULL,
    updated_at                        = now()
WHERE id = $id
  AND state_version = $expected
  AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now())
  AND status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT','PAUSED');
-- If 0 rows updated (lease was just acquired concurrently), ROLLBACK and fall through to Path B.

COMMIT;
```
After Path A commits: the scan contains no items in `DISCOVERED`, `FETCHING`, or `RETRY_WAIT`.
If 0 rows updated on the scan run UPDATE, rollback and fall through to Path B.

**Path B — active lease held by a worker:**
The cancel request transitions to `CANCELLING`:
```sql
UPDATE email_scan_run
SET status = 'CANCELLING', state_version = state_version + 1
WHERE id = $id
  AND state_version = $expected
  AND worker_lease_expires_at >= now()
  AND status IN ('DISCOVERING','FETCHING','RETRY_WAIT')
```
The active worker must observe `CANCELLING` at the end of its current atomic unit of work.
A worker that finds `status = 'CANCELLING'` after completing its current batch MUST:
1. Persist all changes for the current atomic operation (do not abandon in-flight fetch results).
2. Publish no further QStash continuation messages. The QStash message already in
   flight will be handled as a no-op by step 3 (CANCELLING → terminal cleanup) when
   it arrives. QStash message IDs are not persisted; cancellation relies on DB state.
3. Perform the same terminal cleanup as Path A in one transaction:
   - Transition all remaining `DISCOVERED`, `FETCHING`, and `RETRY_WAIT` items to `CANCELLED`;
     clear `item_lease_owner`, `item_lease_expires_at`, `next_retry_at`; increment `state_version`.
   - Set scan `status = 'CANCELLED'`, `cancelled_at = now()`; clear `worker_lease_owner`,
     `worker_lease_expires_at`, and all four `pending_continuation_*` fields.
4. Release the scan-level lease (or let it expire).

**CANCELLING recovery when the active worker crashes (C66):** If the active worker crashes after
Path B sets `status = 'CANCELLING'` but before completing terminal cleanup, the scan remains in
`CANCELLING` with an expired (or absent) lease. The next QStash delivery or an idempotent cancel
request detects `CANCELLING` with no active lease and performs the same terminal cleanup:

```sql
BEGIN;

-- Transition all remaining active items to CANCELLED.
UPDATE email_scan_item
SET status                = 'CANCELLED',
    item_lease_owner      = NULL,
    item_lease_expires_at = NULL,
    next_retry_at         = NULL,
    state_version         = state_version + 1,
    updated_at            = now()
WHERE scan_run_id = $id
  AND status IN ('DISCOVERED', 'FETCHING', 'RETRY_WAIT');

-- Transition scan to CANCELLED, clear all lease and continuation fields.
UPDATE email_scan_run
SET status                            = 'CANCELLED',
    cancelled_at                      = COALESCE(cancelled_at, now()),
    state_version                     = state_version + 1,
    worker_lease_owner                = NULL,
    worker_lease_expires_at           = NULL,
    pending_continuation_sequence     = NULL,
    pending_continuation_stage        = NULL,
    pending_continuation_not_before   = NULL,
    pending_continuation_published_at = NULL,
    updated_at                        = now()
WHERE id = $id
  AND status = 'CANCELLING'
  AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now());

COMMIT;
```
This transaction is idempotent: if `status` is already `CANCELLED`, the scan UPDATE matches 0
rows and no state is disturbed. The worker step 3 initiates this recovery path when it observes
`CANCELLING` with an expired lease (see step 3 above).

**Post-cancellation guarantees:**
- A `CANCELLED` scan cannot transition to any active status (`DISCOVERING`, `FETCHING`,
  `RETRY_WAIT`, `PAUSED`). Re-entry is blocked.
- Late QStash deliveries to `CANCELLING` with **unexpired lease**: handled by step 3 — return
  HTTP 200 (active worker is responsible).
- Late QStash deliveries to `CANCELLING` with **expired lease**: handled by step 3 — perform
  recovery cleanup, return HTTP 200.
- Late QStash deliveries to `CANCELLED`: step 3 returns HTTP 200 — no-op.
- `PAUSED` scans can also be cancelled (Path A: no active worker; transition PAUSED → CANCELLED directly).

**Tests required (C66):**
- Cancel request followed by worker crash: verify scan transitions CANCELLING → CANCELLED on
  the next worker delivery or idempotent cancel request.
- CANCELLING scan with expired lease: verify the recovery cleanup transaction transitions the
  scan to CANCELLED and all active items to CANCELLED.
- Duplicate cancel requests: verify the second cancel request is idempotent when the scan is
  already in CANCELLING or CANCELLED.
- Cancel racing with the first worker lease acquisition: verify Path A correctly fails over to
  Path B when the lease is acquired concurrently, and that CREATED→DISCOVERING atomic initialization
  in the lease query prevents a window where CREATED + active lease coexist.

**Optimistic concurrency:** All state transitions use
`UPDATE WHERE id = $id AND state_version = $expected` and increment `state_version`. A
worker that loses a race (0 rows updated) aborts and allows the winning worker to proceed.

---

### Table: `email_scan_item`

One row per (scan_run, email_source). Records per-email execution status, item-level lease,
filter decision, and matched rule IDs.

```sql
CREATE TABLE email_scan_item (
  id                            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scan_run_id                   TEXT        NOT NULL REFERENCES email_scan_run(id) ON DELETE CASCADE,
  email_source_id               TEXT        NOT NULL REFERENCES email_source(id) ON DELETE RESTRICT,
  -- email_source_id is NOT NULL: a scan item is always associated with a source record.
  -- The source record is created (or found) during discovery before the item is inserted.
  -- gmail_message_id is intentionally NOT stored here; derive via email_source.gmail_message_id
  -- through the email_source_id FK. Denormalizing it here would risk divergence.
  -- Item execution state
  status                        TEXT        NOT NULL DEFAULT 'DISCOVERED'
    CHECK (status IN ('DISCOVERED','FETCHING','FETCHED','RETRY_WAIT','PERMANENTLY_FAILED','CANCELLED')),
  state_version                 INTEGER     NOT NULL DEFAULT 0,
  fetch_attempt_count           INTEGER     NOT NULL DEFAULT 0,
  next_retry_at                 TIMESTAMPTZ,
  last_error_code               TEXT,       -- sanitized error code; no PII
  last_error_message_sanitized  TEXT,       -- sanitized; must not contain PII
  -- Item-level lease (prevents double-fetching)
  item_lease_owner              TEXT,       -- cryptographically random UUID; server-generated
  item_lease_expires_at         TIMESTAMPTZ,
  -- Filter decision (separate from fetch status; populated after filter evaluation)
  -- filter_decision is PENDING until filter rules are evaluated after fetch.
  filter_decision               TEXT        NOT NULL DEFAULT 'PENDING'
    CHECK (filter_decision IN ('PENDING','INCLUDED','EXCLUDED')),
  -- Matched rule IDs (stable rule_id values from email_filter_version JSON).
  -- Arrays of rule_id strings, not patterns.
  matched_include_rule_ids      TEXT[],
  matched_exclude_rule_ids      TEXT[],
  -- Human-readable, sanitized inclusion or exclusion reason (no PII, no Gmail message IDs)
  filter_decision_reason_sanitized  TEXT,
  -- Timing
  discovered_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_started_at              TIMESTAMPTZ,
  fetch_completed_at            TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scan_run_id, email_source_id)
);
CREATE INDEX email_scan_item_run_status_idx
  ON email_scan_item(scan_run_id, status);
CREATE INDEX email_scan_item_source_idx
  ON email_scan_item(email_source_id);
CREATE INDEX email_scan_item_retry_idx
  ON email_scan_item(next_retry_at)
  WHERE status = 'RETRY_WAIT';
CREATE INDEX email_scan_item_lease_idx
  ON email_scan_item(item_lease_expires_at)
  WHERE item_lease_owner IS NOT NULL;

-- Cross-table integrity: scan item source must belong to same user and gmail_account_id as scan run.
-- No declarative FK can express this — it requires a three-table join across email_scan_item,
-- email_source, and email_scan_run. fk_classification_source only protects
-- email_manual_classification → email_source and does NOT cover this invariant.
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

-- Parent-field immutability: scan_run_id and email_source_id must not change after creation.
-- This is separate from cross-tenant validation — it enforces structural immutability.
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
```

**Immutability (C59, C67):** `scan_run_id` and `email_source_id` on `email_scan_item` are immutable
after creation. The `trg_email_scan_item_source_ownership` trigger validates cross-tenant ownership
on INSERT and on UPDATE OF these columns. The separate `trg_email_scan_item_parent_immutable`
BEFORE UPDATE trigger enforces structural immutability — it rejects any attempt to change either
column regardless of tenant ownership. Moving an item to another valid same-user scan run is
explicitly rejected by this trigger.

**Database test required (C67):** Verify that an UPDATE on `email_scan_item` that changes
`scan_run_id` to another valid scan run owned by the same user raises an exception (the parent
immutability trigger must fire and reject the change even when cross-tenant ownership would pass).

**Item state machine:**

Fetch status and filter decision are tracked independently. An email may be successfully
fetched (`FETCHED`) and subsequently excluded (`filter_decision = 'EXCLUDED'`). A failed
item (`PERMANENTLY_FAILED`) retains `filter_decision = 'PENDING'` since evaluation never ran.
A `CANCELLED` item reached a terminal state due to scan cancellation; filter evaluation never ran.

```
Fetch status:
  DISCOVERED → FETCHING → FETCHED (terminal — fetch succeeded)
                       ↓
                RETRY_WAIT → FETCHING (after next_retry_at elapsed)
                       ↓
             PERMANENTLY_FAILED (terminal — max retries exceeded or permanent failure)

  DISCOVERED → CANCELLED (terminal — scan cancelled while item was waiting; Path A)
  FETCHING   → [lease released] → DISCOVERED → CANCELLED (terminal — scan cancelled; Path B)
  RETRY_WAIT → CANCELLED (terminal — scan cancelled while item was in retry-wait)

Filter decision (evaluated after FETCHED; separate from fetch status):
  PENDING → INCLUDED  (item passes filter evaluation)
  PENDING → EXCLUDED  (item rejected by filter evaluation)
  (PERMANENTLY_FAILED and CANCELLED items remain PENDING — evaluation never reached)
```

**Allowed item transitions (central validation — must be enforced in `ScanDomainService`):**

| From (status) | To (status) | Trigger |
|---------------|-------------|---------|
| `DISCOVERED` | `FETCHING` | Worker claims item lease |
| `DISCOVERED` | `CANCELLED` | Scan cancellation (Path A — no active lease) |
| `FETCHING` | `FETCHED` | Gmail fetch succeeded |
| `FETCHING` | `RETRY_WAIT` | Retryable Gmail failure (429, 503, timeout) |
| `FETCHING` | `PERMANENTLY_FAILED` | Permanent Gmail failure (403, 404, malformed) |
| `RETRY_WAIT` | `FETCHING` | `next_retry_at` elapsed; item lease re-acquired |
| `RETRY_WAIT` | `PERMANENTLY_FAILED` | `fetch_attempt_count >= max_item_retries` |
| `RETRY_WAIT` | `CANCELLED` | Scan cancellation |

**Cancellation of in-flight items (Path B):**
When a scan is cancelled while a worker holds the scan lease and items are in `FETCHING`:
1. The worker completes its current atomic batch (does not abandon in-flight results).
2. At the end of the batch, the worker observes `status = 'CANCELLING'` on the scan.
3. The worker releases all item leases for items still in `FETCHING` (setting
   `item_lease_expires_at = now()` so they appear expired immediately).
4. The worker then transitions those items: `FETCHING → DISCOVERED → CANCELLED` in a single
   operation:
   ```sql
   UPDATE email_scan_item
   SET status = 'CANCELLED', updated_at = now()
   WHERE scan_run_id = $scanRunId
     AND status IN ('DISCOVERED', 'FETCHING', 'RETRY_WAIT')
   ```
5. The worker confirms the scan `CANCELLING → CANCELLED`.

After cancellation, no `email_scan_item` for the cancelled scan remains in `DISCOVERED`,
`FETCHING`, or `RETRY_WAIT`. All non-terminal items become `CANCELLED`.

**Filter decision transitions:**

| From (filter_decision) | To (filter_decision) | Trigger |
|------------------------|----------------------|---------|
| `PENDING` | `INCLUDED` | Filter evaluation passes |
| `PENDING` | `EXCLUDED` | Filter evaluation rejects |

Filter evaluation runs only when `status = 'FETCHED'`. Items in `PERMANENTLY_FAILED` or
non-`FETCHED` states retain `filter_decision = 'PENDING'` indefinitely.

**Items in `PERMANENTLY_FAILED` contribute to scan's `fetch_failed_count` counter and trigger
`COMPLETED_WITH_ERRORS` scan status at completion.**

**Source reference:** `email_source_id` is NOT NULL. During discovery, before inserting an
`email_scan_item`, the worker upserts an `email_source` row (using the UNIQUE constraint on
`user_id + gmail_account_id + gmail_message_id`) and uses the returned ID. This ensures
complete source-to-scan traceability.

**Uniqueness:** `(scan_run_id, email_source_id)` — ensures an email source is not inserted
twice into one scan run.

**Gmail message ID derivation:** `gmail_message_id` is not stored on `email_scan_item`.
Callers needing the Gmail message ID join to `email_source` via `email_source_id`. This
prevents the denormalization divergence risk that would arise if `email_scan_item.gmail_message_id`
were ever updated independently of `email_source.gmail_message_id`.

---

### Table: `email_manual_classification`

Append-only audit history for manual email classifications. Each classification event
inserts a new row; no rows are ever updated or deleted. The current classification for a
source is the most recent row by `classified_at`.

```sql
CREATE TABLE email_manual_classification (
  id                        TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                   TEXT        NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  email_source_id           TEXT        NOT NULL,
  -- No single-column FK on email_source_id (C55). Only the composite FK below is used:
  -- FOREIGN KEY (user_id, email_source_id) REFERENCES email_source(user_id, id) ON DELETE CASCADE
  -- previous_classification is NOT NULL: every change must record its predecessor.
  -- For the first classification of an UNREVIEWED source, use 'UNREVIEWED'.
  previous_classification   TEXT        NOT NULL
                              CHECK (previous_classification IN
                              ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')),
  new_classification        TEXT        NOT NULL
                              CHECK (new_classification IN
                              ('UNREVIEWED','FINANCIAL','NON_FINANCIAL','UNCERTAIN')),
  reason                    TEXT,       -- optional free-text note; must not contain sensitive data
  -- classified_by: nullable; FK ON DELETE SET NULL ensures user deletion cannot block erasure
  -- or cascade-delete classification history. When the classifying user is deleted, classified_by
  -- is set to NULL; the classification record and its audit value are preserved.
  classified_by             TEXT        REFERENCES "User"(id) ON DELETE SET NULL,
  classified_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- classification_version is an optimistic-concurrency sequence number matching
  -- email_source.classification_version at the time this row was inserted.
  -- Combined with email_source_id, it uniquely identifies one classification event.
  -- UNIQUE(email_source_id, classification_version) prevents two concurrent events from
  -- producing duplicate rows at the same version.
  classification_version    INTEGER     NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_source_id, classification_version)
);
CREATE INDEX email_manual_classification_source_idx
  ON email_manual_classification(email_source_id, classified_at DESC);
CREATE INDEX email_manual_classification_user_idx
  ON email_manual_classification(user_id, classified_at DESC);
```

**Audit semantics:** Never update or delete rows during normal operation. To change a
classification, insert a new row with `previous_classification = <current>` and
`new_classification = <new>`. The UI shows the latest row per source. Historical rows provide
a full audit trail.

**Retention and user-erasure carve-out:** Although rows are append-only under normal operation,
immutable classification records and their parent `email_source` rows MAY be deleted through
an approved user-data erasure or retention workflow (e.g., GDPR erasure request, scheduled
data cleanup). Deletion through the erasure workflow is an exception to the append-only rule
and must be authorized at the workflow level, not the API level. The standard
`/api/gmail/email/{sourceId}/classify` endpoint must never issue `DELETE` statements.

**Allowed classifications:**

| Value | Meaning |
|-------|---------|
| `UNREVIEWED` | Default; email has not been manually reviewed |
| `FINANCIAL` | User confirmed this email contains a financial transaction |
| `NON_FINANCIAL` | User confirmed this email is not a financial transaction |
| `UNCERTAIN` | User reviewed but could not determine; needs further inspection |

**Current classification (C5 — materialized):** `email_source.current_manual_classification`
holds the current classification as a denormalized field for read performance.
`email_source.classification_version` is an optimistic-concurrency counter that increments
on every classification change. The `email_manual_classification` table is the authoritative
audit history; `current_manual_classification` is always consistent with the most recent
history row because every classification update is performed as a single transaction:

```
1. Validate: SELECT classification_version FROM email_source WHERE id = $sourceId
   → must equal $expectedVersion (optimistic lock check; this is version N)
2. Compute: newVersion = $expectedVersion + 1   (N + 1)
3. Insert: INSERT INTO email_manual_classification
     (user_id, email_source_id, previous_classification, new_classification,
      reason, classified_by, classification_version)
     VALUES ($userId, $sourceId, $currentClassification, $newClassification,
             $reason, $classifiedBy, $newVersion)
   → history row carries newVersion (N + 1)
4. Update: UPDATE email_source
     SET current_manual_classification = $newClassification,
         classification_version = $newVersion,
         updated_at = now()
     WHERE id = $sourceId AND classification_version = $expectedVersion
   → if 0 rows updated, a concurrent update occurred: abort and retry
5. Commit transaction
```

**Versioning invariant:** After commit, `email_source.classification_version` and the
`classification_version` on the most recent `email_manual_classification` row for that source
must always equal the same value (`newVersion`). Both the history insert and the source update
use `newVersion = N + 1`; they are committed atomically and can never diverge.

**Concurrency rule:** If step 4 updates 0 rows, the `classification_version` was changed by a
concurrent writer. The caller must abort and re-read the current version before retrying.
The history row inserted in step 3 is rolled back with the transaction.

**Divergence prevention:** `current_manual_classification` must never be updated outside this
5-step sequence. Direct `UPDATE email_source SET current_manual_classification = ...` is
prohibited; all classification changes must go through this procedure.

---

### Schema summary

| Table | Purpose | Rows grow when |
|-------|---------|----------------|
| `email_filter` | Logical user-owned filter entity | User creates a named filter |
| `email_filter_version` | Immutable published filter configuration snapshots | User publishes a new filter version |
| `email_source` | Persistent Gmail message inventory | New gmail_message_id discovered (once per user+account) |
| `email_scan_run` | Scan session + worker state | User starts a scan |
| `email_scan_item` | Per-email scan membership + filter decisions | Each discovered message per scan |
| `email_manual_classification` | Append-only classification audit history | User classifies an email |

---

### Cross-tenant constraint triggers (C20 — declarative FKs replace 4 of 7 triggers)

Now that `UNIQUE("userId", id)` is planned on `Account` and two new UNIQUE constraints are
added (`UNIQUE(email_filter_id, id)` on `email_filter_version` and `UNIQUE(user_id, id)` on
`email_source`), four of the seven invariants previously enforced by triggers can be expressed
as declarative composite foreign keys. The remaining three require triggers because they enforce
invariants that span multiple columns in ways PostgreSQL declarative FKs cannot express.

**Required additive UNIQUE constraints:** Both of these are already declared inline in the
`CREATE TABLE` statements above and require no separate `ALTER TABLE` statement.

- `UNIQUE(email_filter_id, id)` on `email_filter_version` — inline in `email_filter_version` DDL
- `UNIQUE(user_id, id)` on `email_source` — inline in `email_source` DDL

Both are additive index-only changes; no data modification required.

**Invariants 1a–1c (Gmail account belongs to user) → replaced by declarative composite FKs**

These three triggers (`trg_email_filter_account_ownership`, `trg_email_source_account_ownership`,
`trg_email_scan_run_account_ownership`) are replaced by:

```sql
-- 1a: email_filter(user_id, gmail_account_id) → Account("userId", id)
ALTER TABLE email_filter
  ADD CONSTRAINT fk_email_filter_account
  FOREIGN KEY (user_id, gmail_account_id)
  REFERENCES "Account" ("userId", id)
  ON DELETE RESTRICT;

-- 1b: email_source(user_id, gmail_account_id) → Account("userId", id)
ALTER TABLE email_source
  ADD CONSTRAINT fk_email_source_account
  FOREIGN KEY (user_id, gmail_account_id)
  REFERENCES "Account" ("userId", id)
  ON DELETE RESTRICT;

-- 1c: email_scan_run(user_id, gmail_account_id) → Account("userId", id)
ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_email_scan_run_account
  FOREIGN KEY (user_id, gmail_account_id)
  REFERENCES "Account" ("userId", id)
  ON DELETE RESTRICT;
```

The trigger functions `check_email_filter_account_belongs_to_user` and
`check_gmail_account_belongs_to_user` are removed; the FK constraints are authoritative.

**Invariant 4 (scan item source ownership) — trigger retained (C24 correction)**

`trg_email_scan_item_source_ownership` is retained. The C20 claim that it was replaced by
declarative FKs was incorrect. `fk_classification_source` only enforces that
`email_manual_classification.user_id` matches `email_source.user_id` — it does NOT enforce
that an `email_scan_item`'s source belongs to the same user and `gmail_account_id` as its
scan run. That invariant requires a three-table cross-join check not expressible as a
declarative FK. See the revised trigger table above.

The `fk_classification_source` FK added by C20 is retained, with `ON DELETE CASCADE` (C55):

```sql
-- email_manual_classification(user_id, email_source_id) → email_source(user_id, id)
-- ON DELETE CASCADE: deleting an email_source deletes its classification history.
-- The single-column FK on email_source_id is NOT defined — only this composite FK is used.
ALTER TABLE email_manual_classification
  ADD CONSTRAINT fk_classification_source
  FOREIGN KEY (user_id, email_source_id)
  REFERENCES email_source (user_id, id)
  ON DELETE CASCADE;
```

This FK enforces Invariant 5 (classification user matches source owner), replacing
`trg_email_manual_classification_user_match`. The trigger function
`check_classification_user_matches_source` is removed.

**`email_scan_run` → `email_filter_version` → declarative composite FKs**

```sql
-- email_scan_run(email_filter_id, email_filter_version_id) → email_filter_version(email_filter_id, id)
ALTER TABLE email_scan_run
  ADD CONSTRAINT fk_scan_run_filter_version
  FOREIGN KEY (email_filter_id, email_filter_version_id)
  REFERENCES email_filter_version (email_filter_id, id)
  ON DELETE RESTRICT;
```

This replaces the need for a trigger to verify filter-version ownership: if the composite FK is
satisfied, the filter version necessarily belongs to the referenced filter.

**`email_filter_version.supersedes_version_id` → declarative composite FK (C20, now canonical in DDL above)**

`fk_version_supersedes` is defined in the canonical DDL section above. This replaces
`trg_email_filter_version_supersedes` (Invariant 7). The trigger function
`check_supersedes_same_filter` is removed.

**Remaining triggers: 3**

| # | Invariant | Trigger name | Why declarative FK cannot express it |
|---|-----------|-------------|--------------------------------------|
| 4 | Scan item source belongs to same user and Gmail account as its scan run | `trg_email_scan_item_source_ownership` | `email_scan_item.email_source_id → email_source(id)` is a simple FK; but "the source's `user_id` and `gmail_account_id` must match the scan run's `user_id` and `gmail_account_id`" requires a three-table join check across `email_scan_item`, `email_source`, and `email_scan_run`. No declarative FK expresses this. **Keep trigger.** |
| 8 | `email_filter_version` rows are immutable | `trg_email_filter_version_immutable` | UPDATE prevention requires procedural logic — no declarative constraint blocks all UPDATE operations on a table. **Keep trigger.** |
| 9 | `email_scan_item.scan_run_id` and `email_source_id` are structurally immutable | `trg_email_scan_item_parent_immutable` | BEFORE UPDATE trigger rejects any change to either parent field regardless of tenant ownership — separate from cross-tenant validation. **Keep trigger.** |

**Final reduced constraint table:**

| # | Mechanism | Enforces |
|---|-----------|---------|
| FK `fk_email_filter_account` | Declarative composite FK | `email_filter(user_id, gmail_account_id) → Account("userId", id)` |
| FK `fk_email_source_account` | Declarative composite FK | `email_source(user_id, gmail_account_id) → Account("userId", id)` |
| FK `fk_email_scan_run_account` | Declarative composite FK | `email_scan_run(user_id, gmail_account_id) → Account("userId", id)` |
| FK `fk_scan_run_filter_ownership` | Declarative composite FK | `email_scan_run(user_id, gmail_account_id, email_filter_id) → email_filter(user_id, gmail_account_id, id)` — scan filter belongs to same user + account (C34) |
| FK `fk_scan_run_filter_version` | Declarative composite FK | `email_scan_run(email_filter_id, email_filter_version_id) → email_filter_version(email_filter_id, id)` — filter version belongs to referenced filter (C34) |
| FK `fk_version_supersedes` | Declarative composite FK (deferrable) | `email_filter_version(email_filter_id, supersedes_version_id) → email_filter_version(email_filter_id, id)` |
| FK `fk_email_filter_current_version` | Declarative composite FK (deferrable) | `email_filter(id, current_version_id) → email_filter_version(email_filter_id, id)` — current version belongs to same filter (C34) |
| FK `fk_classification_source` | Declarative composite FK ON DELETE CASCADE | `email_manual_classification(user_id, email_source_id) → email_source(user_id, id)` — no single-column FK on `email_source_id` (C55) |
| Trigger `trg_email_scan_item_source_ownership` | Constraint trigger (AFTER INSERT OR UPDATE OF email_source_id, scan_run_id) | Scan item source belongs to same user and `gmail_account_id` as its scan run |
| Trigger `trg_email_filter_version_immutable` | BEFORE UPDATE trigger | `email_filter_version` rows are immutable |
| Trigger `trg_email_scan_item_parent_immutable` | BEFORE UPDATE trigger | `email_scan_item.scan_run_id` and `email_source_id` are structurally immutable after creation |

Note: `trg_email_filter_version_supersedes`, `trg_email_scan_run_filter_integrity`,
`trg_email_scan_run_filter_user`, `trg_email_scan_run_filter_account`,
`trg_email_filter_current_version`, `trg_email_filter_account_ownership`,
`trg_email_source_account_ownership`, `trg_email_scan_run_account_ownership`, and
`trg_email_manual_classification_user_match` are all removed — replaced by declarative FKs (C20, C34).
`trg_email_scan_item_source_ownership` is retained — no declarative FK can express the
cross-table invariant that the source's `user_id` and `gmail_account_id` match the scan run.
`trg_email_scan_item_parent_immutable` is added (C67) — enforces structural immutability of
parent references independent of cross-tenant validation.

---

**Invariant 6** — `current_version_id` belongs to same filter — enforced by declarative
composite FK `fk_email_filter_current_version`:
`email_filter(id, current_version_id) → email_filter_version(email_filter_id, id)` (C34).
`trg_email_filter_current_version` and `check_current_version_same_filter()` are removed.

---

### §6.7 Gmail account disconnection model

#### Why RESTRICT requires an explicit disconnection model

`email_filter`, `email_source`, and `email_scan_run` all use `ON DELETE RESTRICT` on
`gmail_account_id → Account(id)`. This means deleting an `Account` row while any of these
tables reference it will fail. RESTRICT preserves historical traceability — it prevents silent
destruction of scan history and filter definitions when a user disconnects Gmail.

RESTRICT does NOT mean a user can never disconnect Gmail. It means disconnection requires an
explicit workflow that handles the referenced data first. The approved workflow is:

#### Approved disconnection workflow

**Step 1 — Revoke OAuth tokens (immediate):**

```typescript
await prisma.account.update({
  where: { id: gmailAccountId },
  data: {
    access_token:         null,  // clear access_token (actual Prisma field name)
    refresh_token:        null,  // clear refresh_token (actual Prisma field name)
    disconnected_at:      new Date(),
    disconnection_reason: reason,  // 'user_request' | 'token_revoked' | 'invalid_grant'
  },
});
```

Future Gmail API calls are blocked at the application layer: `getGmailToken()` checks
`disconnected_at IS NOT NULL` and throws `AccountDisconnectedError` before returning any token.
The Account row is retained for historical FK reference.

**Step 2 — Block future scans:** Any attempt to start a new scan referencing a disconnected
`gmail_account_id` is rejected by `ScanDomainService.validateAccountConnected()` with HTTP 422.
In-progress scans that observe `AccountDisconnectedError` on a Gmail call transition their scan
to `FAILED` with `last_error_message_sanitized = 'Gmail account disconnected during scan'`.

**Step 3 — Reconnection:** The user re-authorizes via the OAuth flow. The OAuth callback
updates the same `Account` row (matched by `providerAccountId` = the Gmail user's Google sub):
```typescript
await prisma.account.update({
  where: { id: existingAccountId },
  data: {
    access_token:         newAccessToken,   // actual Prisma field name
    refresh_token:        newRefreshToken,  // actual Prisma field name
    disconnected_at:      null,
    disconnection_reason: null,
  },
});
```
The Account row identity is preserved, so all historical `email_source`, `email_scan_run`, and
`email_filter` rows remain valid and traceable.

**`Account` schema additions required (additive migration — requires D-1 approval):**

Phase 1A proposes the following additive, non-destructive changes to the existing `Account`
table. These changes add new columns and constraints only; they do not remove, rename, or
alter existing columns or data. Because Account is an existing production table, these changes
are subject to D-1 (final schema approval) and must not be migrated until D-1 is approved.

```sql
-- Additive: composite uniqueness (enables composite FK from Phase 1A tables)
ALTER TABLE "Account"
  ADD CONSTRAINT account_user_id_id_unique UNIQUE ("userId", id);

-- Additive: Gmail disconnection tracking columns (nullable; no data change)
ALTER TABLE "Account"
  ADD COLUMN disconnected_at        TIMESTAMPTZ,
  ADD COLUMN disconnection_reason   TEXT;

CREATE INDEX account_disconnected_idx
  ON "Account"(id)
  WHERE disconnected_at IS NOT NULL;
```

#### User erasure and retained Account history

**Account RESTRICT references block automatic cascade (C21):** `email_filter`,
`email_source`, and `email_scan_run` hold `ON DELETE RESTRICT` FKs to `Account(id)` (via
`gmail_account_id`). When a `User` row is deleted and NextAuth's Account table cascades,
PostgreSQL will refuse to delete the `Account` row while any of these RESTRICT-holding rows
remain. **Do not assume that User CASCADE ordering automatically resolves the RESTRICT
references.** PostgreSQL evaluates RESTRICT at the end of each statement, not at the end of
the transaction; the ordering of cascade-triggered deletes across separate FK chains is not
guaranteed to clear the RESTRICT holders before the Account delete fires.

**Approved erasure transaction** — explicit child-deletion ordering before User/Account delete:

```sql
BEGIN;

-- Step 1: Delete all Phase 1A rows owned by this user.
-- These rows hold the RESTRICT references to Account; they must be deleted first.
-- Delete order: leaves before roots, respecting ON DELETE CASCADE within the group.
DELETE FROM email_manual_classification WHERE user_id = $userId;
DELETE FROM email_scan_item
  WHERE scan_run_id IN (SELECT id FROM email_scan_run WHERE user_id = $userId);
DELETE FROM email_scan_run WHERE user_id = $userId;
DELETE FROM email_source WHERE user_id = $userId;
DELETE FROM email_filter WHERE user_id = $userId;  -- cascades email_filter_version

-- Step 2: All RESTRICT holders on Account are now gone.
-- Delete Account rows for this user (NextAuth Account; gmail_account_id references cleared).
DELETE FROM "Account" WHERE "userId" = $userId;

-- Step 3: Delete the User row itself.
-- Any remaining NextAuth child tables (Session, VerificationToken) cascade from User.
DELETE FROM "User" WHERE id = $userId;

COMMIT;
```

This explicit ordering guarantees RESTRICT constraints are satisfied before Account and User
are deleted. It is the required approach for Phase 1A. Alternatives (deferrable NO ACTION FKs
or a separate persistent Gmail-connection identity) are deferred.

**Actual NextAuth Account token field names:** The Account model in `prisma/schema.prisma`
uses the NextAuth standard fields `access_token`, `refresh_token`, `expires_at`, and
`token_type`. Do not use invented names such as `provider_token` or `provider_refresh_token`
in any documentation, pseudocode, or migration logic. Refer to the Prisma schema for the
authoritative list.

**`classified_by` erasure safety:** The `classified_by` column on `email_manual_classification`
uses `ON DELETE SET NULL` (nullable). If the classifying user is deleted before the source
owner, `classified_by` is set to NULL. The classification record and its audit value (previous/
new classification, timestamp, reason) are preserved. The composite FK `fk_classification_source`
ON DELETE CASCADE on `(user_id, email_source_id)` ensures the record is deleted when the source
is deleted (step 1 handles this explicitly for the user-deletion path).

---

## 7. QStash Scheduler Design [Planned — pending approval]

### 7.1 Scheduler interface (domain isolation)

The scan domain service must NOT depend directly on QStash. A `SchedulerService` interface
allows the same domain code to be called from the QStash worker, integration tests, local
tooling, and a future Cloud Run worker.

```typescript
// src/lib/scan/scheduler.ts
export interface ScanContinuation {
  scanRunId: string;
  stage: 'DISCOVERY' | 'FETCH';
  sequence: string;   // decimal string — do NOT pass JavaScript bigint to JSON.stringify() (C63)
  notBefore: Date;
}

export interface SchedulerService {
  enqueueContinuation(continuation: ScanContinuation): Promise<void>;
  // cancelPending removed (C74): QStash message IDs are not persisted.
  // Cancellation relies on DB state: PAUSED/CANCELLING/CANCELLED deliveries
  // are handled as no-ops or terminal cleanup in step 3 of the worker protocol.
}
```

The QStash implementation derives the deterministic deduplication ID from the `ScanContinuation`
object: `sha256(continuation.scanRunId + ':' + continuation.stage + ':' + continuation.sequence)`.
The `sequence` field is already a decimal string; no `.toString()` call is needed here (C63).
The QStash implementation lives in `src/lib/scan/schedulers/qstash.ts`. Tests inject a mock
or no-op implementation. Inside the worker, `BigInt(message.sequence)` converts the string
to the appropriate type for database comparisons.

### 7.1a Durable initial enqueue — `POST /api/gmail/scan` (C52, C61)

`POST /api/gmail/scan` must not commit a CREATED scan and then perform an untracked enqueue.
The initial continuation state is durable before any QStash call is made.

**Idempotency (C61):** The client must supply an `Idempotency-Key` header (or equivalent
`client_request_id` body field). If a scan already exists for `(user_id, client_request_id)`,
the endpoint returns the original scan without creating a new one (HTTP 200 with original
`scanRunId`). This prevents duplicate scans from POST retries caused by network timeouts.

**When initial QStash publication fails (C61):** Instead of returning an opaque error, the
endpoint must:
- Preserve the scan row and its durable pending continuation state.
- Return `scanRunId` to the client.
- Return a recoverable scheduling status (`"schedulingStatus": "PENDING_RETRY"`).
- Allow `POST /api/gmail/scan/{id}/retry` to republish the same initial continuation using
  the same deterministic dedup ID `sha256(scanRunId:DISCOVERY:0)`.

**Creation transaction** (all in one DB commit):
1. Insert `email_scan_run` with `status = 'CREATED'`, `batch_sequence = 0`.
2. Set initial pending continuation:
   - `pending_continuation_sequence = 0`
   - `pending_continuation_stage = 'DISCOVERY'`
   - `pending_continuation_not_before = now()`
   - `pending_continuation_published_at = NULL`
3. Commit.

**After commit:**
4. Publish the first QStash message using dedup ID `sha256(scanRunId:DISCOVERY:0)`.
5. Compare-and-set `pending_continuation_published_at`:
   ```sql
   UPDATE email_scan_run
   SET pending_continuation_published_at = now(), updated_at = now()
   WHERE id = $scanRunId
     AND pending_continuation_sequence = 0
     AND pending_continuation_stage = 'DISCOVERY'
     AND pending_continuation_published_at IS NULL;
   ```
6. If publication fails: return HTTP 202 with `{ scanRunId, schedulingStatus: 'PENDING_RETRY' }`.
   The scan row and its durable pending state remain. The client may retry
   `POST /api/gmail/scan/{id}/retry` to republish.

**Tests required (C52, C61):**
- Scan commit succeeds but initial QStash publish fails: scan row exists with
  `pending_continuation_published_at IS NULL`; endpoint returns `PENDING_RETRY`; scan is
  recoverable via retry.
- Initial publish succeeds but `published_at` update fails: next delivery sees
  `published_at IS NULL` and republishes the same deterministic dedup ID (QStash drops
  the duplicate silently).
- Retry after failure publishes the same `sha256(scanRunId:DISCOVERY:0)` dedup ID.
- Duplicate POST with same `Idempotency-Key` returns original scan (no second row created).
- POST with same `(user_id, client_request_id)` after scan is COMPLETED returns original scan.
- Request timeout followed by retry with same `Idempotency-Key` is idempotent.

### 7.2 Worker endpoint

`POST /api/gmail/scan/worker` — internal, not callable from the browser.

**Authentication:** QStash JWT signature verification is the ONLY accepted authentication
mechanism. Browser session authentication is not accepted as a substitute.

The `@upstash/qstash` SDK's `Receiver` class is used to validate the request before any
handler logic runs. Instantiation:

```typescript
import { Receiver } from "@upstash/qstash";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey:    process.env.QSTASH_NEXT_SIGNING_KEY!,
});
```

Verification call (per invocation, using the raw request body):

```typescript
await receiver.verify({
  signature: req.headers.get("Upstash-Signature")!,
  body: rawBodyString,   // raw bytes as string — do NOT parse JSON before verify
  url: process.env.QSTASH_WORKER_URL!,  // exact expected URL; validates JWT `sub` claim
  clockTolerance: 5,     // seconds; guards against stale replays
});
```

The `sub` claim in the QStash JWT is the exact URL the message was published to. Passing
`url` to `receiver.verify()` ensures QStash delivered this message to the expected endpoint,
preventing message routing attacks. `QSTASH_WORKER_URL` must be set in Vercel env (e.g.,
`https://your-app.vercel.app/api/gmail/scan/worker`).

The `Receiver` attempts `QSTASH_CURRENT_SIGNING_KEY` first, then `QSTASH_NEXT_SIGNING_KEY`,
to support zero-downtime key rotation. If both fail, the library throws and the endpoint
returns HTTP 489 + `Upstash-NonRetryable-Error: true` without executing any handler logic.

**QStash JWT claims validated by `Receiver`:**
- `iss`: must equal `"Upstash"` — identifies the issuer
- `sub`: the destination URL this message was published to — validated against the `url` parameter passed to `receiver.verify()`; verifies the message was published to THIS endpoint (prevents routing attacks)
- `exp`: expiry timestamp — rejects stale deliveries
- `nbf`: not-before timestamp — rejects premature deliveries
- `body`: base64url-encoded SHA-256 of the raw request body — verifies body integrity (SDK verifies this internally via the `body` parameter passed to `receiver.verify()`)
- Standard JWT `iat` (issued-at) also present but not the primary validation gate

If signature verification fails, the endpoint returns HTTP 489 + `Upstash-NonRetryable-Error: true`
immediately (message goes to DLQ, no retry).

**Message format:**

```json
{
  "scanRunId": "<uuid>",
  "stage": "DISCOVERY" | "FETCH",
  "sequence": "0"
}
```

The `stage` field allows the worker to skip re-detecting the current stage from DB state on
every invocation and instead validate that the message matches the expected stage.

**Deterministic next-message identity:** the Upstash message deduplication ID for each
continuation message is:

```
dedup_id = sha256(scanRunId + ":" + stage + ":" + sequence)
```

This ID is passed as the `Upstash-Deduplication-Id` header when publishing via
`SchedulerService.enqueueContinuation()`. Within the QStash deduplication window (10 minutes),
duplicate publish calls for the same `(scanRunId, stage, sequence)` tuple are
silently dropped by QStash. DB idempotency remains authoritative for correctness beyond
the deduplication window.

### 7.3 Worker invocation protocol (C13 — 11-step sequence, reordered C57, C69)

Each worker invocation executes exactly these 11 steps in order:

1. **Verify QStash JWT** — Use the official `@upstash/qstash` `Receiver` class (see §7.2).
   Read the raw request body as a string before any JSON parsing. Call
   `receiver.verify({ signature, body, url, clockTolerance: 5 })`. If verification fails,
   return HTTP 489 with `Upstash-NonRetryable-Error: true` immediately — QStash routes to DLQ
   without retrying. Do not access the database.

2. **Parse and structurally validate the message** — After JWT verification, parse the raw
   body as JSON and validate its structure:
   ```typescript
   interface WorkerMessage {
     scanRunId: string;         // non-empty UUID string
     stage: 'DISCOVERY' | 'FETCH';
     sequence: string;          // decimal string representing BigInt (C63)
   }
   ```
   Convert `sequence` from the decimal string representation to `BigInt` immediately after
   parsing. If the JSON is malformed, a required field is missing, `stage` is not one of the
   two allowed values, or `sequence` is not a valid decimal integer string, return HTTP 489
   + `Upstash-NonRetryable-Error: true`. Do not access the database.

3. **Read authoritative database state** — Read `email_scan_run` for `$scanRunId`:
   `status`, `current_stage`, `resume_stage`, `batch_sequence`, `pending_continuation_sequence`,
   `pending_continuation_stage`, `pending_continuation_published_at`,
   `filter_rule_schema_version`, `filter_evaluator_version`, counters, and any required scan
   metadata. Also validate `user_id` matches the scan owner using the server-derived DB value —
   not the message body. Branch on status:

   - Terminal (`COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`, `CANCELLED`): return HTTP 200 — no-op.
   - `PAUSED`: return HTTP 200 — no-op. Do not acquire a lease. Preserve `resume_stage`
     and all `pending_continuation_*` fields intact. The continuation published before
     pause remains the authoritative next delivery; it must not be re-published here.
     PAUSED is non-terminal: the scan resumes when `POST /api/gmail/scan/{id}/resume` is
     called, which advances `batch_sequence` and publishes a fresh continuation.
   - `CANCELLING` with **unexpired lease** (`worker_lease_expires_at >= now()`):
     return HTTP 200 — the active worker will perform terminal cleanup.
   - `CANCELLING` with **no lease or expired lease** (`worker_lease_expires_at IS NULL OR
     worker_lease_expires_at < now()`): the active worker crashed before completing terminal
     cleanup. This worker delivery must perform the same terminal cleanup as Path B cancellation:
     transition all remaining `DISCOVERED`, `FETCHING`, and `RETRY_WAIT` items to `CANCELLED`;
     set scan `status = 'CANCELLED'`, `cancelled_at = now()`; clear `worker_lease_owner`,
     `worker_lease_expires_at`, and all four `pending_continuation_*` fields. Return HTTP 200
     after cleanup commits. Do not publish a continuation.
   - All other active states: continue to step 4.

4. **Validate incoming sequence and stage** — Compare the parsed message `sequence` and `stage`
   against the authoritative DB state read in step 3:

   | Case | Condition | Action |
   |------|-----------|--------|
   | Stale duplicate | `sequence` < `batch_sequence` (checkpoint already advanced past it) | See stale-recovery procedure below |
   | Current | `sequence` = `pending_continuation_sequence` AND `stage` = `pending_continuation_stage` | Proceed to step 5 |
   | Future / inconsistent | `sequence` > `batch_sequence` + 1, OR no matching pending state | HTTP 489 + `Upstash-NonRetryable-Error: true` — structurally inconsistent; do not process |

   **Stale-message recovery procedure (C65):** A stale delivery (`sequence` < `batch_sequence`)
   indicates the batch checkpoint already committed. However, committing the checkpoint does not
   guarantee the subsequent QStash publication succeeded — the publication step may have failed
   after the DB commit. To recover a stale delivery:

   1. Read the authoritative `pending_continuation_*` fields from the DB (already read in step 3).
   2. If the scan is in a terminal state (`COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`,
      `CANCELLED`) or has no pending continuation (`pending_continuation_sequence IS NULL`):
      return HTTP 200 — no recovery needed.
   3. If `pending_continuation_published_at IS NOT NULL`: a continuation is already scheduled —
      return HTTP 200.
   4. If `pending_continuation_published_at IS NULL`: the continuation was persisted but never
      confirmed published. Publish it now using the persisted values:
      - `pending_continuation_sequence`
      - `pending_continuation_stage`
      - `pending_continuation_not_before`
      Use the same deterministic deduplication ID: `sha256(scanRunId:stage:pending_continuation_sequence)`.
      After QStash accepts publication, apply the compare-and-set:
      ```sql
      UPDATE email_scan_run
      SET pending_continuation_published_at = now(), updated_at = now()
      WHERE id = $scanRunId
        AND pending_continuation_sequence = $publishedSequence
        AND pending_continuation_stage    = $publishedStage
        AND pending_continuation_published_at IS NULL;
      ```
      Return HTTP 200 after QStash accepts. Return HTTP 500 if publication fails (QStash retries
      the stale message, which will retry recovery).

   This recovery does not re-process the stale batch and does not require the stale message
   to acquire the scan-processing lease. An inconsistent future message returns
   HTTP 489 + `Upstash-NonRetryable-Error: true`. Only a message that matches the exact
   current continuation proceeds to step 5.

5. **Acquire scan lease** — Execute the atomic lease-acquisition query. The lease query must
   include `pending_continuation_sequence` and `pending_continuation_stage` predicates to ensure
   only the exact current continuation can acquire the lease. When the scan is in `CREATED`
   status, the lease acquisition also atomically initializes it to `DISCOVERING` — there must
   be no window where a `CREATED` scan holds an active worker lease without entering `DISCOVERING`:
   ```sql
   UPDATE email_scan_run
   SET worker_lease_owner = $uuid,
       worker_lease_expires_at = now() + ($leaseSecs || ' seconds')::interval,
       state_version = state_version + 1,
       -- Atomic CREATED→DISCOVERING initialization (C66):
       status      = CASE WHEN status = 'CREATED' THEN 'DISCOVERING' ELSE status END,
       current_stage = CASE WHEN status = 'CREATED' THEN 'DISCOVERY' ELSE current_stage END,
       started_at  = COALESCE(started_at, CASE WHEN status = 'CREATED' THEN now() END)
   WHERE id = $scanRunId
     AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now()
          OR worker_lease_owner = $uuid)
     AND status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT')
     AND (status != 'RETRY_WAIT' OR next_retry_at <= now())
     AND pending_continuation_sequence = $messageSequence
     AND pending_continuation_stage = $messageStage
   ```
   (`$leaseSecs` = `process.env.WORKER_LEASE_DURATION_SECONDS ?? '55'`; `$messageSequence` and
   `$messageStage` are the validated values from step 2.)
   The `state_version = $expectedVersion` predicate is intentionally absent — QStash messages
   do not carry `expectedVersion`, and after a checkpoint commit the DB version has advanced.
   Using a stale expected version would cause redeliveries to return 0 rows and permanently
   stall the scan.

   **Zero-row decision table (C37, updated C44, C46, C57, C66):** If 0 rows updated, read authoritative scan state and branch:

   | Branch | Condition | Action |
   |--------|-----------|--------|
   | A | `status` is terminal (`COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`, `CANCELLED`) | Return HTTP 200; do no work |
   | B | `status = 'RETRY_WAIT'` and `next_retry_at > now()` (not yet eligible) | Verify durable pending-continuation state: if `pending_continuation_published_at IS NOT NULL`, a continuation is already scheduled — return HTTP 200. If `pending_continuation_published_at IS NULL`, republish the delayed continuation using `pending_continuation_sequence`, `pending_continuation_stage`, and `pending_continuation_not_before` — return HTTP 200 after QStash accepts it; return HTTP 500 if publication fails. Never assume a continuation was published without DB confirmation. |
   | C | Active scan (`CREATED`, `DISCOVERING`, `FETCHING`, `RETRY_WAIT` eligible) and another worker holds a valid unexpired lease (`worker_lease_expires_at >= now()` and `worker_lease_owner ≠ $uuid`) | Return HTTP 200; do not publish another continuation — the current worker will publish one when done |
   | D | Active scan, no valid lease, and eligible work exists: confirm previous batch checkpoint committed **and** no active worker **and** scan is eligible **and** unclaimed items exist | Retry lease acquisition once; if still 0 rows, return retryable HTTP 500 (QStash will redeliver) |
   | E | Active scan, no valid lease, no eligible fetch work — evaluate discovery state first (C44): (E1) `discovery_complete = false`: discovery work remains; do not complete the scan. If `discovery_page_token` is present, continue from that page; if absent but `discovery_complete = false`, continue or restart discovery idempotently. (E2) `discovery_complete = true`: all items terminal — verify the three completion guards; if all pass, transition to `COMPLETED`/`COMPLETED_WITH_ERRORS`; return HTTP 200. (E3) `discovery_complete = true` but RETRY_WAIT items exist with `next_retry_at > now()`: verify durable pending-continuation state — if `pending_continuation_published_at IS NOT NULL`, return HTTP 200; if `pending_continuation_published_at IS NULL`, republish using the persisted `pending_continuation_*` fields; return HTTP 200 after QStash accepts; return HTTP 500 if publication fails. |

   A scan is complete only when `discovery_complete = true` AND the item-level completion guard passes (no items with status in `DISCOVERED`, `FETCHING`, `RETRY_WAIT`, no `FETCHED+PENDING`, no `CANCELLED`).

   Do not publish continuation messages merely because the lease UPDATE returned zero rows.
   Continuation recovery requires proving: (a) the previous batch checkpoint committed,
   (b) no active worker owns the scan, (c) the scan is eligible now, (d) work remains,
   and (e) the expected continuation is not already represented by authoritative DB state.
   `state_version` is used only for post-lease state transitions (optimistic locking on status
   changes after the lease is held).

6. **Validate filter schema, evaluator version, and rule types** — Under the held lease,
   compare the scan snapshot's `filter_rule_schema_version` and `filter_evaluator_version`
   against the worker's compiled-in `SUPPORTED_RULE_SCHEMA_VERSION` and
   `SUPPORTED_FILTER_EVALUATOR_VERSION`. Also validate that every rule `type` in
   `filter_rule_schema.include_rules_json` and `exclude_rules_json` is recognised by the
   runtime rule evaluator. If any validation fails (unsupported schema version, unsupported
   evaluator version, or unrecognised rule type), the scan cannot proceed:
   - Transition `email_scan_run` to `FAILED` under the held lease: set
     `status = 'FAILED'`, `last_error_code = 'INVALID_FILTER_SCHEMA'` or
     `'INCOMPATIBLE_FILTER_VERSION'` as appropriate, `updated_at = now()`.
   - Clear all four `pending_continuation_*` fields to `NULL`.
   - Release the worker lease: `worker_lease_owner = NULL`, `worker_lease_expires_at = NULL`.
   - Commit in a single transaction.
   - **Return HTTP 200** after the transaction commits — the message is handled permanently;
     no continuation will be published. HTTP 489 must NOT be used here; this is a valid
     signed worker message whose domain configuration is incompatible. HTTP 489 remains
     limited to step 1 (invalid JWT), step 2 (malformed payload or structurally impossible
     continuation), and step 4 (future / inconsistent sequence).
   If filter validation passes, continue to step 7.

7. **Branch by message stage (C73) — DISCOVERY or FETCH:**

   After filter validation (step 6), branch on the message's `stage` field:

   **DISCOVERY path:**
   - Do **not** execute the `email_scan_item` item-claim query.
   - Call exactly one Gmail List API page (up to 500 message IDs) using the stored
     `discovery_page_token` (or `null` for the first page).
   - Upsert `email_source` rows for discovered message IDs (insert new rows; update existing
     rows with latest observed metadata only if relevant fields changed).
   - Insert `email_scan_item` membership rows with `ON CONFLICT DO NOTHING` — prior
     membership for redelivered pages is silently skipped.
   - Persist `discovery_page_token` (the next-page token from the Gmail response) and
     `discovery_complete = true` if Gmail signals the last page.
   - When `discovery_complete` becomes `true`, transition `current_stage` to `'FETCH'` and
     set the next continuation stage to `'FETCH'`.
   - Proceed to step 9 (checkpoint + lease release) with the discovery outcomes.

   **FETCH path:**
   - Execute the `FOR UPDATE SKIP LOCKED` item-claim query (see §11 item-level lease section).
   - Claim at most **25** items with `status = 'DISCOVERED'` or eligible
     `status = 'RETRY_WAIT'` (`next_retry_at <= now()` AND
     `fetch_attempt_count < $maxItemRetries`).
   - Fetch Gmail metadata for claimed items and persist item/source outcomes.
   - Items not yet claimable or in terminal states are left untouched.
   - If 0 items are claimable, apply the following ordered decision before proceeding to
     step 9:
     1. **Discovery incomplete** (`discovery_complete = false`): schedule a DISCOVERY
        continuation — the scan must complete discovery before any terminal transition.
     2. **Immediately claimable fetch work exists** (items in `DISCOVERED` or
        `RETRY_WAIT` with `next_retry_at <= now()` and `fetch_attempt_count < $maxItemRetries`):
        schedule a FETCH continuation — work is available now.
     3. **Future RETRY_WAIT work exists** (items in `RETRY_WAIT` with `next_retry_at > now()`):
        schedule a delayed FETCH continuation with `$notBefore = min(next_retry_at)`.
     4. **All completion guards pass** (no pending, in-progress, or retrying items; all
        `FETCHED`/`PERMANENTLY_FAILED`; `discovery_complete = true`): transition the scan to
        a terminal status and persist no continuation (`pending_continuation_*` = NULL).
     5. **Inconsistent state** (none of the above applies): fail safely — transition to
        `FAILED` with `last_error_code = 'INCONSISTENT_STATE'`, clear pending continuation,
        release the lease, and return HTTP 200.
     Only after this decision should step 9 persist either the exact next continuation
     (cases 1–3) or NULL for terminal state (case 4).

   Item claiming is **FETCH-only**. The DISCOVERY path never acquires item leases.

8. **Atomically claim eligible items (FETCH path only)** — Already performed in step 7 FETCH
   path via `SELECT … FOR UPDATE SKIP LOCKED`. After claiming, classify previously committed
   items (C43):
   - `FETCHED` or `PERMANENTLY_FAILED`: terminal — skip, no action.
   - `RETRY_WAIT` with `next_retry_at > now()`: committed but not currently eligible — skip;
     the previously scheduled delayed continuation will wake the scan when eligible.
   - `RETRY_WAIT` with `next_retry_at <= now()` and `fetch_attempt_count < $maxItemRetries`:
     eligible for retry — already claimed in step 7.
   - `RETRY_WAIT` with `fetch_attempt_count >= $maxItemRetries`: exhausted — transition to
     `PERMANENTLY_FAILED` (exhaustion query).
   All upserts use `ON CONFLICT DO NOTHING`; rows committed in a prior invocation are
   silently skipped. Do not re-fetch items in `FETCHED` or `PERMANENTLY_FAILED`.

9. **Commit item results, counters, checkpoint, batch_sequence, and lease release atomically** —
   Execute all item-state writes, counter reconciliation, and lease release in a single DB
   transaction (C41). The lease release must occur in the same commit as the item writes to
   ensure the next worker can immediately acquire the lease after publication — no expired-lease
   wait required. In the same atomic transaction: write all item-state results, reconcile
   counters, increment `batch_sequence`, persist the pending continuation identity, and release
   the lease. Use:
   ```sql
   UPDATE email_scan_run
   SET batch_sequence                      = batch_sequence + 1,
       last_checkpoint_at                  = now(),
       last_batch_completed_at             = now(),
       worker_lease_owner                  = NULL,
       worker_lease_expires_at             = NULL,
       state_version                       = state_version + 1,
       -- Persist durable pending continuation state (C46):
       pending_continuation_sequence       = batch_sequence + 1,
       pending_continuation_stage          = $nextStage,
       pending_continuation_not_before     = $notBefore,
       pending_continuation_published_at   = NULL,
       updated_at                          = now()
   WHERE id = $scanRunId
     AND worker_lease_owner = $leaseOwner
   RETURNING batch_sequence;
   ```
   `$notBefore` is `now()` for an immediate continuation, or a future timestamp for delayed
   RETRY_WAIT continuations. If the scan is terminal or `CANCELLING`, do not set
   `pending_continuation_*` fields — set them to `NULL` instead.

   **If 0 rows are returned (lease ownership lost):** The entire transaction must be rolled back
   (see C47 in step 9 rollback note). Do not commit item results, counters, or
   `batch_sequence`. Do not publish a continuation. After rollback, read authoritative state:
   if another worker demonstrably committed the same logical work (their checkpoint is visible
   in `last_checkpoint_at` and item states confirm it), return HTTP 200; otherwise return
   retryable HTTP 500.

   If the DB transaction fails for any other reason, return HTTP 500 (retryable) — do not
   proceed to step 10.

10. **Publish next continuation using persisted pending continuation identity** — After the
   transaction in step 9 commits, read the `RETURNING batch_sequence` value. Construct the
   deterministic dedup ID: `sha256(scanRunId:stage:sequence)` using the `pending_continuation_sequence`
   value persisted in step 9.
   Call `SchedulerService.enqueueContinuation` using the `ScanContinuation` built from
   `pending_continuation_sequence`, `pending_continuation_stage`, and
   `pending_continuation_not_before` persisted in step 9.
   The same dedup ID is safe to republish on redelivery — QStash drops duplicates within the
   10-minute deduplication window; DB idempotency enforces correctness beyond that window.
   After QStash accepts publication, apply a compare-and-set update:
   ```sql
   UPDATE email_scan_run
   SET pending_continuation_published_at = now(), updated_at = now()
   WHERE id = $scanRunId
     AND pending_continuation_sequence = $publishedSequence
     AND pending_continuation_stage = $publishedStage
     AND pending_continuation_published_at IS NULL;
   ```
   A stale publisher that executes this update after the scan has advanced to a newer
   continuation will match 0 rows (because `pending_continuation_sequence` no longer matches)
   and will not overwrite the newer state. If this update fails or matches 0 rows, do not
   treat it as fatal — the next redelivery will detect `pending_continuation_published_at IS NULL`
   and republish. Duplicate publication is safe (QStash deduplication drops it).
   If the scan has become terminal or `CANCELLING` after step 9, do NOT publish; instead
   confirm the terminal state and proceed to step 11.

11. **Return HTTP 200 only after publication succeeds (or scan is terminal)** — A 200
    response signals to QStash that this delivery is fully handled and no redelivery is
    needed. Never return 200 before step 10 completes, except in the terminal/no-op cases
    in steps 3, 4, 6, and the terminal branch of step 10.

    **Return retryable non-2xx if continuation publication fails** — If QStash
    `enqueueContinuation` throws or returns a non-2xx after the DB commit in step 9 succeeded,
    return HTTP 500 (or any retryable non-2xx). QStash redelivers the same message. On
    redelivery, steps 1–8 replay safely (idempotent upserts skip committed work; the lease
    may be re-acquired if expired). Step 10 reads the persisted `pending_continuation_*` fields
    and republishes the same deterministic dedup ID — if the previous publish actually succeeded
    before the failure, QStash drops the duplicate silently.

    **Return non-retryable only for conclusively invalid or unrecoverable messages** —
    For conclusively invalid requests (failed JWT verification in step 1, structurally invalid
    message body in step 2, structurally impossible continuation in step 4), return:
    ```
    HTTP 489
    Upstash-NonRetryable-Error: true
    ```
    QStash interprets HTTP 489 + this header as a permanent failure and routes the message
    directly to the DLQ without consuming retry attempts. For transient failures (DB
    unavailable, Gmail 429, QStash publish failure), return HTTP 500 — QStash retries
    according to the `Upstash-Retries` configuration. Do not return 4xx for transient
    errors — those would be treated as non-retryable.

### 7.3a Pause and resume semantics (C72)

**`batch_sequence` as monotonic continuation generation counter:** `batch_sequence` advances
on every checkpoint commit (step 9), on every resume, and on every manual retry scheduling.
It is not limited to item-batch completions. Each advance creates a new continuation identity,
allowing the deduplication-ID computation `sha256(scanRunId:stage:sequence)` to produce a
fresh ID that is outside the QStash 10-minute deduplication window.

**Worker behavior when `status = PAUSED`:** Already covered by step 3 of §7.3. The worker
returns HTTP 200 immediately without acquiring a lease. `resume_stage` and all
`pending_continuation_*` fields are preserved intact. PAUSED is non-terminal.

**Resume transaction (`POST /api/gmail/scan/{id}/resume`):**

1. `SELECT … FOR UPDATE` on `email_scan_run` for `$scanRunId` to lock the row.
2. Verify `status = 'PAUSED'`; if not, return HTTP 409.
3. Restore `status` from `resume_stage`:
   - `resume_stage = 'DISCOVERY'` → set `status = 'DISCOVERING'`, `current_stage = 'DISCOVERY'`
   - `resume_stage = 'FETCH'` → set `status = 'FETCHING'`, `current_stage = 'FETCH'`
4. Advance `batch_sequence = batch_sequence + 1` to create a new continuation identity.
5. Persist new pending-continuation state in the same transaction:
   ```sql
   UPDATE email_scan_run
   SET status                            = $restoredStatus,
       current_stage                     = $restoredStage,
       resume_stage                      = NULL,
       batch_sequence                    = batch_sequence + 1,
       pending_continuation_sequence     = batch_sequence + 1,
       pending_continuation_stage        = $restoredStage,
       pending_continuation_not_before   = now(),
       pending_continuation_published_at = NULL,
       paused_at                         = NULL,
       state_version                     = state_version + 1,
       updated_at                        = now()
   WHERE id = $scanRunId
     AND status = 'PAUSED';
   ```
   (`RETURNING batch_sequence` yields the new `batch_sequence` value for QStash publication.)
6. Commit.
7. Publish the new continuation using `SchedulerService.enqueueContinuation`:
   ```typescript
   await scheduler.enqueueContinuation({
     scanRunId,
     stage: restoredStage,
     sequence: newBatchSequence.toString(),
     notBefore: new Date(),
   });
   ```
   Deduplication ID: `sha256(scanRunId:restoredStage:newBatchSequence)`. This is guaranteed
   outside the 10-minute QStash deduplication window because `newBatchSequence` was not used
   before the pause.
8. Apply the compare-and-set `pending_continuation_published_at` update (same pattern as §7.3
   step 10). If 0 rows match, the continuation identity changed — treat as non-fatal; the next
   redelivery will detect `pending_continuation_published_at IS NULL` and republish.

**Do not republish a previously delivered continuation** with the same `batch_sequence` value.
The pre-pause continuation may still be inside the QStash 10-minute deduplication window;
republishing it would be silently dropped by QStash anyway, but the intent of a resume is to
create a new, independently schedulable continuation identity.

**Pause transaction (`POST /api/gmail/scan/{id}/pause`):**

Only valid for `status IN ('DISCOVERING', 'FETCHING', 'RETRY_WAIT')`:
```sql
UPDATE email_scan_run
SET status        = 'PAUSED',
    resume_stage  = current_stage,
    paused_at     = now(),
    state_version = state_version + 1,
    updated_at    = now()
WHERE id = $scanRunId
  AND status IN ('DISCOVERING','FETCHING','RETRY_WAIT');
```
The `pending_continuation_*` fields are **not** cleared on pause. The in-flight QStash
delivery will arrive at step 3 and return HTTP 200 without processing. If `RETRY_WAIT`,
the pending delayed continuation is also preserved — it too will no-op at step 3.

**Required test cases (C72):**

| Test | Description | Type |
|------|-------------|------|
| Pause before scheduled delivery | Pause a DISCOVERING scan; next QStash delivery returns HTTP 200 no-op; scan remains PAUSED; no lease acquired | Integration |
| Scheduled delivery while PAUSED | Deliver QStash message to a PAUSED scan; verify step 3 returns HTTP 200 without DB writes beyond the status read | Unit |
| Resume within 10-minute dedup window | Resume a scan paused within the last 10 minutes; verify new `batch_sequence` differs from the pre-pause value; verify new dedup ID `sha256(id:stage:newSeq)` is distinct | Unit |
| Repeated pause/resume | Pause → resume → pause → resume cycle; verify `batch_sequence` increments on each resume; verify each resume publishes a continuation with a distinct dedup ID | Integration |
| Resume publication failure | Commit succeeds (step 6), `enqueueContinuation` throws (step 7); verify `pending_continuation_published_at IS NULL`; verify next delivery or retry republishes using persisted `pending_continuation_sequence` | Integration |

### 7.4 Idempotency and duplicate delivery

QStash provides at-least-once delivery. Every operation must be idempotent:

- `email_source` upsert: `INSERT … ON CONFLICT (user_id, gmail_account_id, gmail_message_id) DO NOTHING`.
- `email_scan_item` upsert: `INSERT … ON CONFLICT (scan_run_id, email_source_id) DO NOTHING`.
- Counter updates: derived from authoritative `email_scan_item` states, not incremented blindly.
  Use a reconciliation query for counter updates: `SELECT status, COUNT(*) FROM email_scan_item WHERE scan_run_id=$id GROUP BY status`.
- Duplicate delivery of the same `(scanRunId, stage, sequence)` must produce no duplicate source records,
  no duplicate scan memberships, no duplicate fetch attempts, no duplicate counters, no
  duplicate manual-review records, no duplicate follow-up jobs, no duplicate downstream work.
- The `Upstash-Deduplication-Id` (`sha256(scanRunId:stage:sequence)`) suppresses duplicates
  within QStash's deduplication window (**10 minutes**). DB idempotency enforces correctness beyond
  the deduplication window.

**Behaviour after deduplication-window expiry:** If QStash redelivers a message for the same
`(scanRunId, stage, sequence)` after the 10-minute deduplication window expires, the
deduplication ID will no longer suppress it. The worker must still be fully idempotent at the
DB level — all upserts use `ON CONFLICT DO NOTHING`, and the lease acquisition query ensures
only one concurrent worker runs at a time.

### 7.5 Failure handling

#### Case 1 (corrected, C65): DB checkpoint succeeds → QStash next-message publication fails

The scan's `last_checkpoint_at` is updated and item states are persisted (step 9 completed).
The pending continuation fields (`pending_continuation_sequence`, `pending_continuation_stage`,
`pending_continuation_not_before`) are persisted in the same atomic transaction, but
`pending_continuation_published_at` remains `NULL` because the QStash publish did not succeed.
**The worker MUST return a retryable non-success response (step 9 — HTTP 500).**

QStash redelivers the same message (sequence `N`). On redelivery:

1. **Steps 1–2** verify the JWT and parse the message.
2. **Step 3** reads authoritative state: `batch_sequence` is now `N+1` (checkpoint committed);
   `pending_continuation_published_at IS NULL`.
3. **Step 4** detects a stale message: `sequence N` < `batch_sequence N+1`.
   Stale-recovery procedure (C65) executes:
   - `pending_continuation_published_at IS NULL` → publish the persisted continuation using
     `pending_continuation_sequence`, `pending_continuation_stage`, `pending_continuation_not_before`.
   - Deterministic dedup ID: `sha256(scanRunId:stage:pending_continuation_sequence)` — the same
     ID that would have been used had the original publication succeeded.
   - If the previous publish actually succeeded before the failure (network error after acceptance),
     QStash drops the duplicate silently within the 10-minute deduplication window.
   - Apply compare-and-set to mark `pending_continuation_published_at = now()`.
4. Return HTTP 200 after QStash accepts. Return HTTP 500 if publication fails again.

No items are double-fetched. No duplicate source rows are created. The recovery does not
re-acquire the scan-processing lease and does not re-process any batch work.

**Integration test required (C65):** Verify: (1) DB checkpoint commits with
`pending_continuation_published_at IS NULL`; (2) a stale redelivery (sequence < batch_sequence)
triggers the recovery path; (3) continuation is published with the correct dedup ID; (4) a
second stale redelivery after `published_at IS NOT NULL` returns HTTP 200 without republishing.

#### Case 2: Next QStash message published → worker invocation times out

The next QStash delivery fires a new worker instance. The previous worker's lease has expired
(55-second timeout), so the new instance acquires the lease normally. Idempotent upserts
prevent double-processing.

#### Case 3: Worker acquires lease → process crashes

The lease expires at `worker_lease_expires_at`. The next worker delivery acquires the lease
and resumes from the last checkpoint.

#### Case 4: Gmail temporary failure or rate limit (429)

The worker catches the error, updates the affected `email_scan_item` rows to `RETRY_WAIT`
with `next_retry_at = now() + backoff(attempt)`. If no claimable `DISCOVERED` items remain,
updates `email_scan_run.status = RETRY_WAIT` and `email_scan_run.next_retry_at` (minimum across
retryable items). Publishes a delayed QStash message using the QStash `delay` parameter matching
`next_retry_at - now()`. Item-level and scan-level retry counts are incremented. If
`fetch_attempt_count >= max_item_retries`, the item transitions to `PERMANENTLY_FAILED`.

#### Case 5: Gmail permanent message-level failure

The specific `email_scan_item` transitions to `PERMANENTLY_FAILED`. The scan continues
processing other items. At completion, if any items are `PERMANENTLY_FAILED`, the scan
status becomes `COMPLETED_WITH_ERRORS`.

#### Case 6: QStash DLQ (dead-letter queue)

If QStash exhausts its own delivery retries (typically after the configured retry count), the
message moves to the DLQ. The scan will stall in its current active state with no further
progress. Operators must:
1. Navigate to Upstash console → QStash → DLQ.
2. Identify the message by `scanRunId` in the message body.
3. Re-enqueue the message manually (Upstash provides a "Resend" action).
4. Alternatively, use `POST /api/gmail/scan/{id}/retry` to create a new continuation message.

**Failure callback:** QStash supports an optional `Upstash-Failure-Callback` URL that could call a session-less webhook to mark the scan as `PAUSED` when QStash delivery is exhausted. **Deferred — not part of Phase 1A.** Do not configure `Upstash-Failure-Callback` in Phase 1A. Until this is implemented, a stalled scan is detected via the progress endpoint's `worker_lease_expires_at` becoming stale; the UI can surface this and the operator can use `POST /api/gmail/scan/{id}/retry` to recover — this triggers Case 3 (§7.8): if the lease is expired, a fresh continuation is published using the current stage.

**Manual recovery from DLQ:** After re-enqueuing from DLQ, the worker processes the message
normally. The idempotency guarantees ensure no duplicate processing occurs.

#### Case 7: Cancel request arrives while worker is processing

See Cancellation semantics section in `email_scan_run` table above. The worker observes
`CANCELLING` after completing its current atomic operation and transitions to `CANCELLED`.

### 7.6 Backoff policy

| Attempt | Delay |
|---------|-------|
| 1 | 30 seconds |
| 2 | 2 minutes |
| 3 | 10 minutes |
| 4 | 30 minutes |
| 5 (max) | 2 hours |

After `max_retries` exceeded: transition to `PERMANENTLY_FAILED`; do not publish further
messages for the affected item. Scan-level `max_retries` default: 5.

### 7.6a Three-layer retry model

The system has three distinct retry layers. Each is separately configured and has different
granularity.

**Layer 1 — QStash delivery retries (AT-LEAST-ONCE)**
- Controlled by QStash; not configurable via `email_scan_run`.
- QStash retries the HTTP request to the worker endpoint if the worker returns a non-2xx
  response, or if the request times out.
- Use case: transient Vercel cold-start, DB connection spike, worker crash before response.
- Worker must return a retryable non-success response if a DB checkpoint succeeded but
  QStash next-message publication failed (see §7.5 Case 1 revised below).

**Layer 2 — Scan-level Gmail retries (`retry_count` / `max_retries` on `email_scan_run`)**
- Applies when a Gmail API error affects the entire scan (e.g., quota exhaustion, invalid token).
- `retry_count` increments each time the scan re-enters `RETRY_WAIT` at the scan level.
- `max_retries` (default: 5; immutable after scan creation) caps the total scan-level retry attempts.
- When `retry_count >= max_retries`, the scan transitions to `FAILED` (unrecoverable).
- `next_retry_at` on `email_scan_run` is set to the earliest eligible retry time across all
  retryable conditions (scan-level error OR the minimum `next_retry_at` across all retryable items).

**Layer 3 — Per-item Gmail fetch retries (`fetch_attempt_count` / `max_item_retries` on `email_scan_item`)**
- Applies when an individual Gmail message fetch fails with a retryable error (429, 503, timeout).
- `fetch_attempt_count` increments on each fetch attempt (initial + retries).
- `max_item_retries` (default: 3; immutable after scan creation, stored on `email_scan_run`) caps
  per-item retry attempts. When `fetch_attempt_count >= max_item_retries`, the item transitions
  to `PERMANENTLY_FAILED` and is excluded from future fetch batches.
- Item entering `RETRY_WAIT` does NOT block other claimable items in the same scan. The scan
  continues processing all other items in `DISCOVERED` status. Only when no immediately
  claimable work remains does the scan enter `RETRY_WAIT`.

**Scan RETRY_WAIT gate (applies to both Layer 2 and Layer 3 retries):**

The scan enters `RETRY_WAIT` only when ALL of the following are true:
1. No `email_scan_item` with `status = 'DISCOVERED'` exists (no immediately claimable work).
2. At least one `email_scan_item` with `status = 'RETRY_WAIT'` exists (retryable work remains).
3. `next_retry_at` is set to the minimum `next_retry_at` across all retryable items.

```sql
-- Check if scan should enter RETRY_WAIT
SELECT
  COUNT(*) FILTER (WHERE status = 'DISCOVERED')   AS claimable_count,
  COUNT(*) FILTER (WHERE status = 'RETRY_WAIT')   AS retryable_count,
  MIN(next_retry_at)                               AS earliest_retry
FROM email_scan_item
WHERE scan_run_id = $scanRunId;
-- Enter RETRY_WAIT only if claimable_count = 0 AND retryable_count > 0
```

When the scan is in `RETRY_WAIT`, the claim gate (`next_retry_at <= now()`) prevents
premature re-processing. The QStash delayed message for the next retry is published with
a delay matching `next_retry_at - now()`.

### 7.7 QStash credentials and security

- `QSTASH_TOKEN`: server-only. Never `NEXT_PUBLIC_*`. Never logged. Never stored in DB.
- `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`: server-only. Used by the
  `Receiver` class for JWT signature verification. Upstash provides two signing keys to support
  zero-downtime key rotation.
- **Key rotation:** When Upstash rotates the signing key, `QSTASH_CURRENT_SIGNING_KEY` becomes
  the old key and `QSTASH_NEXT_SIGNING_KEY` becomes the new key. The `Receiver` attempts both
  keys during verification. Vercel env vars must be updated at the next rotation.
- **Retry configuration:** The maximum retry count for a message is set at publish time using
  the `Upstash-Retries` header (default: 3 on the free plan). The backoff between retries
  is controlled by the `Upstash-Retry-Delay` header (e.g., `"60s"`, `"5m"`). The destination
  endpoint can request a specific retry delay using the `Retry-After` response header in its
  non-2xx response, which QStash will honor.
- **Deduplication window:** 10 minutes. Within this window, duplicate publish calls sharing
  the same `Upstash-Deduplication-Id` are silently dropped by QStash. After the window expires,
  DB-level idempotency (ON CONFLICT DO NOTHING) remains authoritative.
- **DLQ retention:** 3 days. Messages that exhaust all delivery retries move to the DLQ and
  are available for inspection and re-enqueue for 3 days.
- **Compromised QStash token:** Revoke on the Upstash console immediately. Rotate both the
  token and signing keys. Update Vercel env vars. Audit recent worker invocation logs for
  unauthorized calls.
- **Compromised signing key:** The endpoint will reject all unsigned requests. Update
  `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` in Vercel env.
- **Replay protection and idempotency:** QStash provides at-least-once delivery; redelivery
  of the same `Upstash-Message-Id` is expected and must not be rejected. The message ID may
  be logged at DEBUG level for diagnostics but must never gate processing. Idempotency is
  enforced entirely through database state: item status, scan state, sequence numbers,
  leases, optimistic locking (`state_version`), and `ON CONFLICT DO NOTHING` uniqueness
  constraints. There is no `last_processed_message_id` field and no message-ID dedup check.
- **Rate limiting:** The worker endpoint should be rate-limited to 10 requests/second using
  Vercel Edge middleware or an `upstash/ratelimit` middleware to protect against replay storms.
- **Audit logging:** Worker invocations log (at INFO level): `scanRunId`, `sequence`,
  `itemsProcessed`, `nextStatus`. No PII, no OAuth data, no email content, no QStash credentials.

### 7.8 Retry-route decision table (C77)

`POST /api/gmail/scan/{id}/retry` does NOT always republish the existing sequence. The action
depends on the current scan state:

**Case 1 — Unpublished CREATED scan (`pending_continuation_published_at IS NULL`)**

The initial continuation was persisted but never successfully published (e.g., scan creation
committed but the QStash call failed). Recovery:
- Read `pending_continuation_sequence`, `pending_continuation_stage`, and
  `pending_continuation_not_before` from the DB.
- Do **not** increment `batch_sequence`.
- Republish using the existing deterministic dedup ID (`sha256(scanRunId:DISCOVERY:0)`).
- Apply CAS `published_at` update.
- Return HTTP 202 `{ scanRunId, status: "CREATED", schedulingStatus: "SCHEDULED" }`.

**Case 2 — `RETRY_WAIT` manual retry**

The scan is paused awaiting a scheduled retry. The existing continuation identity may already
have been published or delivered — a fresh identity is required:
- Lock the scan row (`SELECT … FOR UPDATE`).
- Verify the retry is allowed (scan is in `RETRY_WAIT`).
- Increment `batch_sequence`.
- Restore `status` and `current_stage` from `resume_stage`.
- Set `next_retry_at = NULL`.
- Persist a new immediate pending continuation using the incremented sequence
  (`pending_continuation_sequence = batch_sequence`, `pending_continuation_not_before = now()`,
  `pending_continuation_published_at = NULL`).
- Commit, publish the continuation using the new deterministic dedup ID, and apply CAS
  `published_at` update.
- Return HTTP 200 `{ scanRunId, status: "<actual committed status from resume_stage>" }` — return
  the actual committed status (`"DISCOVERING"` or `"FETCHING"`), not the literal `"RETRY_WAIT"`.

**Case 3 — Stalled `DISCOVERING` or `FETCHING` scan (QStash delivery exhausted)**

The scan is in an active state but has no active worker — QStash exhausted its delivery retries
and the message moved to the DLQ. Recovery:
- Lock the scan row (`SELECT … FOR UPDATE`).
- Verify the scan is in `DISCOVERING` or `FETCHING`.
- Verify no active worker owns it: `worker_lease_expires_at IS NULL OR worker_lease_expires_at < now()`.
- Verify unfinished work remains (counters show items not yet terminal, or `discovery_complete = false`).
- Increment `batch_sequence`.
- Persist a fresh pending continuation using `current_stage`:
  (`pending_continuation_sequence = batch_sequence`, `pending_continuation_stage = current_stage`,
  `pending_continuation_not_before = now()`, `pending_continuation_published_at = NULL`).
- Commit, publish the continuation using the new deterministic dedup ID, and apply CAS
  `published_at` update.
- Return HTTP 200 `{ scanRunId, status: "<current committed status>" }`.

If the worker lease is still unexpired, reject with HTTP 409 `{ error: "scan_active" }` — an
active worker may still be processing; do not force-publish a duplicate continuation.

**Case 4 — Automatic stale-message or publication-failure recovery**

The worker detected a stale message (C65) or a publication failure and invokes recovery:
- Republish the existing persisted continuation unchanged.
- Do **not** generate a new sequence or increment `batch_sequence`.
- Use the same deterministic dedup ID already computed from the persisted fields.
- Apply CAS `published_at` update.

**Summary table:**

| Scan status | Condition | Action | HTTP response |
|------------|-----------|--------|---------------|
| `CREATED` | `pending_continuation_published_at IS NULL` | Republish existing initial continuation; no new sequence; CAS `published_at` | 202 `{ scanRunId, status: "CREATED", schedulingStatus: "SCHEDULED" }` |
| `CREATED` | `pending_continuation_published_at IS NOT NULL` | Reject — continuation already published; active delivery in flight | 409 `{ error: "scan_active", status: "CREATED" }` |
| `RETRY_WAIT` | Manual retry requested | Lock; verify; increment `batch_sequence`; restore from `resume_stage`; clear `next_retry_at`; persist new immediate continuation; commit + publish + CAS | 200 `{ scanRunId, status: "<actual committed status>" }` — return the status restored from `resume_stage` (`"DISCOVERING"` or `"FETCHING"`) |
| `DISCOVERING` / `FETCHING` | Unexpired worker lease (`worker_lease_expires_at > now()`) | Reject — active worker may be processing | 409 `{ error: "scan_active", status: "<current>" }` |
| `DISCOVERING` / `FETCHING` | No lease or expired lease (`worker_lease_expires_at IS NULL OR < now()`) | Lock; verify no active lease; verify unfinished work; increment `batch_sequence`; persist fresh continuation using `current_stage`; commit + publish + CAS | 200 `{ scanRunId, status: "<current committed status>" }` |
| `PAUSED` | — | Reject — use `POST /api/gmail/scan/{id}/resume` | 409 `{ error: "scan_paused" }` |
| `FAILED` | Any error code | Reject — `FAILED` is terminal and unrecoverable | 422 `{ error: "unrecoverable_failure", detail: "<last_error_code>" }` |
| `COMPLETED` | — | Reject — scan finished successfully | 409 `{ error: "scan_terminal", status: "COMPLETED" }` |
| `COMPLETED_WITH_ERRORS` | — | Reject — scan finished (partial errors are auditable but not retried at scan level) | 409 `{ error: "scan_terminal", status: "COMPLETED_WITH_ERRORS" }` |
| `CANCELLED` | — | Reject — scan was cancelled; start a new scan | 409 `{ error: "scan_terminal", status: "CANCELLED" }` |
| `CANCELLING` | — | Reject — cancellation in progress; no retry | 409 `{ error: "scan_cancelling" }` |

**Key invariant:** Manual retry (Case 2) and stalled-scan recovery (Case 3) must create a fresh
continuation identity whenever the previous continuation may already have been published or
delivered. Automatic recovery (Case 1 and Case 4) must never generate a new sequence — it
republishes the existing persisted state. If `pending_continuation_sequence` is NULL for a
RETRY_WAIT state (Case 2), that is a data integrity error — return HTTP 500.

**Tests for §7.8:**

| # | Scenario | Expected |
|---|----------|----------|
| AC-7.8-1 | CREATED with `published_at IS NULL` → retry | Republishes using sequence 0; no `batch_sequence` increment; 202 `{ scanRunId, status: "CREATED", schedulingStatus: "SCHEDULED" }` |
| AC-7.8-1b | CREATED with `published_at IS NOT NULL` → retry | Returns 409 `{ error: "scan_active", status: "CREATED" }`; no DB changes |
| AC-7.8-2 | RETRY_WAIT → retry | `batch_sequence` incremented; new dedup ID used; status restored from `resume_stage`; `next_retry_at = NULL`; response returns actual committed status |
| AC-7.8-3 | FAILED (any error code) → retry | Returns 422 `unrecoverable_failure`; no DB changes |
| AC-7.8-4 | DISCOVERING with unexpired lease → retry | Returns 409 `scan_active`; no DB changes |
| AC-7.8-5 | DISCOVERING with expired lease and unfinished work → retry | `batch_sequence` incremented; fresh continuation persisted using `current_stage`; response returns current status |
| AC-7.8-6 | COMPLETED → retry | Returns 409 `scan_terminal` |
| AC-7.8-7 | NULL `pending_continuation_sequence` on RETRY_WAIT | Returns 500 data integrity error |
| AC-7.8-8 | PAUSED → retry | Returns 409 `{ error: "scan_paused" }`; caller must use POST /resume |

### 7.9 QStash quota assumptions and fallback

**Free-tier usage for typical personal inbox (3,000 emails, 6-month scan):**
- Discovery: 6 messages (500 IDs/page)
- Fetch batches: 120 messages
- Retries (5% rate): ~7 messages
- Total: ~133 messages per scan; well within 1,000/day limit

**Risk:** An inbox with 15,000+ emails requires ~330+ messages in a single day. If the user
runs multiple scans, the daily limit could be reached. Document this limitation prominently.

**Behavior if QStash quota is exhausted:** The QStash publish call fails. The worker catches
the error, sanitizes the message (no internal error details, no quota numbers in the
stored message), updates `email_scan_run.status = 'PAUSED'` with
`last_error_message_sanitized = 'QStash daily quota exhausted — scan paused; resume manually'`,
and returns HTTP 200 (the current message is processed; there is no future message to deliver).

**There is no automatic midnight recovery (C22).** QStash cannot schedule its own post-reset
callback — once quota is exhausted, it cannot publish new messages. Automatic recovery requires
a second active scheduler. For Phase 1A, two options are available:
1. **Manual resume only:** The user triggers `POST /api/gmail/scan/{id}/resume` from the UI
   after quota resets at midnight UTC. The UI must display the paused/quota-exhausted state
   clearly, including a message that quota resets at midnight UTC.
2. **Vercel daily cron as sweeper (optional):** The existing daily Vercel cron job
   (`/api/cron/advance`) can be extended to sweep for `status = 'PAUSED'` scans and
   republish their continuation messages. This provides semi-automatic recovery without
   requiring user action.

**Approved behavior for Phase 1A:** Option 1 (manual resume only). Option 2 is available as
an optional enhancement; if implemented, it must be explicitly documented and tested.
Do not document or claim automatic midnight recovery unless Option 2 is implemented.

**Behavior if QStash is temporarily unavailable:** Same as above — scan enters `PAUSED` state.
Manual resume available via `POST /api/gmail/scan/{id}/resume`.

**Fallback scheduler option:** If QStash becomes unsuitable (quota, cost, reliability), the
`SchedulerService` interface is implemented by a Cloud Run task queue, a GitHub Actions
workflow, or a paid Vercel scheduled function. The scan domain service requires no changes.

---

## 8. Live Progress Design [Planned — pending approval]

### 8.1 Progress API

`GET /api/gmail/scan/{scanRunId}` — read-only status endpoint.

This endpoint must NOT advance the scan, publish worker messages, claim leases, or fetch Gmail
messages.

**Authorization:** Session authentication. The endpoint verifies `email_scan_run.user_id` matches
the requesting session user. User isolation is enforced at the query level.

**Response (sanitized — no Gmail message IDs, no OAuth tokens, no QStash credentials):**

```json
{
  "scanId": "uuid",
  "gmailAccountId": "internal-account-uuid",
  "emailFilterVersionId": "uuid-or-null",
  "effectiveGmailQuery": "from:alerts@...",
  "fromDate": "2026-01-01",
  "toDate": "2026-07-18",
  "status": "FETCHING",
  "stage": "FETCHING_BATCH_42",
  "totalDiscovered": 2347,
  "discoveryComplete": true,
  "fetchPendingCount": 503,
  "fetchInProgressCount": 25,
  "fetchSuccessCount": 1625,
  "fetchFailedCount": 2,
  "filterIncludedCount": 1411,
  "filterExcludedCount": 214,
  "manualReviewCount": 3,
  "remainingCount": 503,
  "currentBatchSize": 25,
  "currentBatchSequence": 42,
  "completionPercent": 78.6,
  "completionPercentKnown": true,
  "lastCheckpointAt": "2026-07-18T14:22:01Z",
  "lastBatchStartedAt": "2026-07-18T14:21:58Z",
  "lastBatchCompletedAt": "2026-07-18T14:22:01Z",
  "workerLeaseState": "HELD",
  "workerLeaseExpiresAt": "2026-07-18T14:22:56Z",
  "nextRetryAt": null,
  "retryCount": 0,
  "recentErrorSummary": null,
  "canPause": true,
  "canResume": false,
  "canCancel": true
}
```

**Never expose:** Gmail message IDs, OAuth tokens, QStash credentials, account numbers, card
numbers, raw email bodies, unsanitized errors, PAN, date of birth, OTPs.

### 8.2 UI polling behavior

- Polls `GET /api/gmail/scan/{scanRunId}` every 2–3 seconds while status is active
  (`DISCOVERING`, `FETCHING`, `PAUSED`, `RETRY_WAIT`, `CANCELLING`).
- Stops polling on terminal states: `CANCELLED`, `COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`.
- Closing the browser stops polling; the background scan continues via QStash.
- On browser reopen: UI fetches current scan status immediately and resumes polling if active.
- Browser polling must NEVER invoke the worker, advance scan state, publish QStash messages,
  claim leases, or fetch Gmail messages.

### 8.3 Discovery progress display

During discovery (`discoveryComplete=false`), the final count is unknown. Display:

```
Discovering emails...
1,500 emails found so far
```

Do not display a percentage during discovery. `completionPercentKnown=false` signals this.

### 8.4 Fetch progress display

After discovery completes, processed items are:

```text
processed = PERMANENTLY_FAILED items
          + FETCHED items where filter_decision IN ('INCLUDED', 'EXCLUDED')
```

`filter_excluded_count` is a subset of `fetch_success_count` (FETCHED items) and must NOT
be added again. `CANCELLED` items are not processed — they are not counted toward completion.

```text
Completion % = processed / totalDiscovered
```

Where `totalDiscovered` includes only non-`CANCELLED` items. A scan in `CANCELLED` status
uses `CANCELLED` as its terminal display — do not show a completion percentage.

The UI must not display 100% while any item is in `DISCOVERED`, `FETCHING`, or `RETRY_WAIT`,
or while any `FETCHED` item has `filter_decision = 'PENDING'`. A scan containing any items
in `CANCELLED` status must itself be in `CANCELLED` status — it cannot transition to
`COMPLETED` or `COMPLETED_WITH_ERRORS`.

**Phase 1A progress panel (target display):**

```
Status: FETCHING

Emails discovered:       2,347  ✓ discovery complete
Fetched successfully:    1,625
Filter-excluded:           214  (subset of fetched)
Retry waiting:               3  (next retry in 8 minutes)
Permanent failures:          2  [view]
Remaining:                 503
Progress:                78.6%  (= (2 + 1625) / 2347)

Last checkpoint: 2 seconds ago
[Pause]  [Cancel]
```

### 8.5 Drilldown views

Users must be able to drill into:
- Fetched emails (filter: `status=FETCHED`)
- Filter-excluded emails (filter: `filter_decision=EXCLUDED`)
- Retry-waiting items (filter: `status=RETRY_WAIT`)
- Permanently failed items (filter: `status=PERMANENTLY_FAILED`)
- Items awaiting manual classification (filter: latest classification = `UNREVIEWED`)
- Financial classifications (latest classification = `FINANCIAL`)
- Non-financial classifications (latest classification = `NON_FINANCIAL`)
- Uncertain classifications (latest classification = `UNCERTAIN`)

Each visible item must be traceable to its `email_source` record.

### 8.6 Counter reconciliation

Because QStash is at-least-once, cached counters on `email_scan_run` may drift. The design
defines a reconciliation query (C14):

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'DISCOVERED')                                AS fetch_pending_count,
  COUNT(*) FILTER (WHERE status = 'FETCHING')                                  AS fetch_in_progress_count,
  COUNT(*) FILTER (WHERE status = 'FETCHED')                                   AS fetch_success_count,
  COUNT(*) FILTER (WHERE status = 'PERMANENTLY_FAILED')                        AS fetch_failed_count,
  COUNT(*) FILTER (WHERE status = 'RETRY_WAIT')                                AS retry_wait_count,
  COUNT(*) FILTER (WHERE status = 'CANCELLED')                                 AS cancelled_count,
  COUNT(*) FILTER (WHERE filter_decision = 'INCLUDED')                         AS filter_included_count,
  COUNT(*) FILTER (WHERE filter_decision = 'EXCLUDED')                         AS filter_excluded_count,
  -- Processed = PERMANENTLY_FAILED + FETCHED where filter evaluated (C14)
  COUNT(*) FILTER (WHERE status = 'PERMANENTLY_FAILED'
                      OR (status = 'FETCHED'
                          AND filter_decision IN ('INCLUDED', 'EXCLUDED')))     AS processed_count
FROM email_scan_item
WHERE scan_run_id = $scanRunId;
```

`filter_excluded_count` is a subset of `fetch_success_count` — these overlap and must not
be summed together in the progress formula. `CANCELLED` items are counted separately and
excluded from `processed_count`.

This query can be run at any time to recompute authoritative counts. The progress API should
compare cached counters against the reconciliation query on any response that shows 100%
completion before returning the terminal status to the client.

---

## 9. Feature Flag Design [Planned — pending approval]

### 9.1 Implementation

```typescript
// src/lib/featureFlags.ts
export function isLlmParsingEnabled(): boolean {
  return process.env.LLM_PARSING_ENABLED === "true";
}

export function isLegacyTransactionIngestionEnabled(): boolean {
  return process.env.LEGACY_TRANSACTION_INGESTION_ENABLED === "true";
}
```

Both functions are called server-side only. Neither flag uses `NEXT_PUBLIC_*`.
Safe default for missing, empty, or any value other than `"true"`: disabled.

### 9.2 LLM gate placement

`isLlmParsingEnabled()` is called at the entry of `parseEmailBatchLLM()` in `src/lib/llm/index.ts`:

```typescript
if (!isLlmParsingEnabled()) {
  throw new LlmDisabledError("LLM_PARSING_ENABLED is false");
}
```

This prevents Gemini, OpenAI, and the LLM router from executing.

### 9.3 Legacy ingestion gate placement

`isLegacyTransactionIngestionEnabled()` is called at the entry of:
- `POST /api/gmail/sync/start` — returns HTTP 503 `{"error":"legacy_ingestion_disabled"}` if false
- `GET /api/gmail/sync/advance` — returns HTTP 503 `{"error":"legacy_ingestion_disabled"}` if false

This prevents all of: `SyncJob` creation, Gmail fetching, static parsing, template cache, exact result
cache, `upsertTransactionV2`, `ParseLog` creation, and transaction mutations.

The legacy sync UI is hidden using `isLegacyTransactionIngestionEnabled()` evaluated in a server
component, replacing the sync panel with a notice: "Sync is currently managed by the new email
scanning system."

---

## 10. API Design [Planned — pending approval]

HTTP methods follow REST semantics: `GET` for read-only, `POST`/`PATCH`/`DELETE` for mutations.

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/gmail/scan` | POST | Session | Start a new scan run |
| `/api/gmail/scan/{id}` | GET | Session | Read scan status + progress |
| `/api/gmail/scan/{id}/pause` | POST | Session | Pause an active scan |
| `/api/gmail/scan/{id}/resume` | POST | Session | Resume a paused scan |
| `/api/gmail/scan/{id}/cancel` | POST | Session | Cancel a scan |
| `/api/gmail/scan/{id}/retry` | POST | Session | Recover an unpublished CREATED scan, trigger RETRY_WAIT manual retry, or recover a stalled active scan with an expired lease |
| `/api/gmail/scan/worker` | POST | QStash signature | Internal worker tick |
| `/api/gmail/email/{sourceId}` | GET | Session | Get email source metadata |
| `/api/gmail/email/list` | GET | Session | Paginated email inventory |
| `/api/gmail/email/stats` | GET | Session | Aggregate counts |
| `/api/gmail/email/{sourceId}/classify` | POST | Session | Submit manual classification |
| `/api/email-filters` | GET | Session | List per-user email filters (name, active status) |
| `/api/email-filters` | POST | Session | Create a new email filter |
| `/api/email-filters/{id}` | GET | Session | Get a single email filter |
| `/api/email-filters/{id}` | PATCH | Session | Update filter name or active status |
| `/api/email-filters/{id}` | DELETE | Session | Delete filter (cascades to versions) |
| `/api/email-filters/{id}/versions` | GET | Session | List published versions for a filter |
| `/api/email-filters/{id}/versions` | POST | Session | Create a new immutable version (every rule change is a new version) |
| `/api/email-filters/{id}/versions/{versionId}` | GET | Session | Get a specific version snapshot |

**No draft-rule CRUD in Phase 1A.** The six-table schema has no draft-rule persistence model.
`POST /api/email-filter-rules`, `PATCH /api/email-filter-rules/{id}`, and
`DELETE /api/email-filter-rules/{id}` are not exposed. Every rule change creates a new
immutable `email_filter_version` row; there is no intermediate draft state. If a draft
workflow is required in a future phase, it requires an explicit design and approval before
any draft-storage endpoints are added.

`/api/gmail/scan/worker` accepts only QStash JWT-signed requests verified via the `@upstash/qstash`
`Receiver` class (C9). Browser sessions
are rejected even if valid. The same domain service (`ScanDomainService`) is used by the worker
endpoint, integration tests, and local tooling.

---

## 11. Lease Design Corrections [Planned — pending approval]

### Scan-level lease

- `worker_lease_owner`: `crypto.randomUUID()` generated per invocation — cryptographically
  random, not derived from `VERCEL_REGION + Date.now()` or any user-supplied value.
- Lease duration: controlled by `WORKER_LEASE_DURATION_SECONDS` env var (default `'55'`,
  derived from the Vercel 60-second execution limit minus a 5-second safety margin). If the
  execution limit changes, update `WORKER_LEASE_DURATION_SECONDS` in Vercel env.
- Acquisition: atomic `UPDATE email_scan_run SET worker_lease_owner=$uuid, worker_lease_expires_at=now()+($leaseSecs||' seconds')::interval, state_version=state_version+1 WHERE id=$id AND (worker_lease_expires_at < now() OR worker_lease_owner IS NULL OR worker_lease_owner = $uuid) AND status IN ('CREATED','DISCOVERING','FETCHING','RETRY_WAIT') AND (status != 'RETRY_WAIT' OR next_retry_at <= now())`. The `state_version=$expected` predicate is omitted — QStash messages do not carry `expectedVersion`; use `state_version` for post-lease state transitions only.
- Renewal: not supported in Phase 1A (`WORKER_LEASE_DURATION_SECONDS` is sufficient for one bounded batch).
- Checkpoint-and-release: item writes, counter reconciliation, `batch_sequence` increment, pending continuation state, and lease release (`worker_lease_owner = NULL`) commit atomically. If the `WHERE worker_lease_owner = $leaseOwner` predicate matches 0 rows, the entire transaction is rolled back — no item results, no counters, no `batch_sequence` change are committed (C47).
- Expiration recovery: on the next QStash delivery, the new worker finds `worker_lease_expires_at < now()` and acquires the lease.
- After cancellation: if a cancelled scan still has an active lease, the lease expires normally. The next worker delivery reads `status=CANCELLED` and terminates without processing.

### Item-level lease

- `item_lease_owner`: `crypto.randomUUID()` per claim operation.
- `item_lease_expires_at`: `now() + $itemLeaseDurationSecs` (derived from worker execution budget; configured value, not hardcoded).
- Items are claimed atomically using `SELECT … FOR UPDATE SKIP LOCKED` to prevent
  double-claiming under concurrent delivery (C12):

```sql
-- Step 1: Claim eligible items (DISCOVERED, RETRY_WAIT eligible, FETCHING with expired lease)
WITH claimed AS (
  SELECT esi.id, esi.email_source_id
  FROM email_scan_item esi
  WHERE esi.scan_run_id = $scanRunId
    AND (
      esi.status = 'DISCOVERED'
      OR (esi.status = 'RETRY_WAIT'
          AND esi.next_retry_at <= now()
          AND esi.fetch_attempt_count < $maxItemRetries)
      OR (esi.status = 'FETCHING' AND esi.item_lease_expires_at < now()
          AND esi.fetch_attempt_count < $maxItemRetries)
    )
  ORDER BY esi.discovered_at
  LIMIT 25
  FOR UPDATE SKIP LOCKED
)
UPDATE email_scan_item
SET status              = 'FETCHING',
    item_lease_owner    = $uuid,
    item_lease_expires_at = now() + ($itemLeaseDurationSecs || ' seconds')::interval,
    fetch_attempt_count = fetch_attempt_count + 1,
    state_version       = state_version + 1,
    fetch_started_at    = now(),
    next_retry_at       = NULL,
    updated_at          = now()
FROM claimed
WHERE email_scan_item.id = claimed.id
RETURNING
  email_scan_item.id,
  email_scan_item.email_source_id,
  email_scan_item.fetch_attempt_count,
  email_scan_item.state_version;

-- Step 2 (separate query): Transition exhausted items to PERMANENTLY_FAILED.
-- Only terminalize items that are NOT held by an unexpired active lease:
--   RETRY_WAIT (no lease held), or FETCHING with an expired lease.
-- Never terminalize a FETCHING item whose item_lease_expires_at >= now() —
-- an active worker may still be processing it.
UPDATE email_scan_item
SET status                    = 'PERMANENTLY_FAILED',
    item_lease_owner          = NULL,
    item_lease_expires_at     = NULL,
    next_retry_at             = NULL,
    fetch_completed_at        = now(),
    last_error_code           = 'MAX_FETCH_RETRIES_EXCEEDED',
    last_error_message_sanitized = 'Maximum fetch retry attempts exceeded',
    state_version             = state_version + 1,
    updated_at                = now()
WHERE scan_run_id = $scanRunId
  AND fetch_attempt_count >= $maxItemRetries
  AND (
    status = 'RETRY_WAIT'
    OR (status = 'FETCHING' AND item_lease_expires_at < now())
  );
```

- `SKIP LOCKED` rows are held by a concurrent worker; this claim skips them silently
  rather than blocking.
- Expired-lease recovery is included in the same claim: `status='FETCHING' AND
  item_lease_expires_at < now() AND fetch_attempt_count < $maxItemRetries` items are reclaimed,
  resetting the lease and incrementing `fetch_attempt_count`.
- RETRY_WAIT eligible items (`next_retry_at <= now() AND fetch_attempt_count < $maxItemRetries`)
  are claimed in the same query — they were previously never reclaimed.
- Exhausted items are transitioned to `PERMANENTLY_FAILED` in a separate follow-up query.
  Only items in `RETRY_WAIT` or `FETCHING` with an **expired lease** are eligible — an item
  in `FETCHING` with `item_lease_expires_at >= now()` is actively held and must NOT be
  terminalized (C36). The exhaustion update clears lease fields, sets `last_error_code`, and
  increments `state_version`.
- Max items per claim: 25 (matching CHUNK_SIZE).

### Item-result transition queries (C56, C58)

Every `FETCHING → terminal` transition must verify lease ownership, lease validity, and
state version. If the combined predicate updates zero rows, the result write is rolled back —
a lost, expired, or superseded lease must not commit results.

**FETCHING → FETCHED:**
```sql
UPDATE email_scan_item
SET status                    = 'FETCHED',
    item_lease_owner          = NULL,
    item_lease_expires_at     = NULL,
    state_version             = state_version + 1,
    fetch_completed_at        = now(),
    next_retry_at             = NULL,
    last_error_code           = NULL,
    last_error_message_sanitized = NULL,
    updated_at                = now()
WHERE id = $itemId
  AND status                  = 'FETCHING'
  AND item_lease_owner        = $uuid
  AND item_lease_expires_at   > now()
  AND state_version           = $claimedStateVersion;
-- If 0 rows: lease lost, expired, or state_version changed — roll back result write.
```

**FETCHING → RETRY_WAIT:**
```sql
UPDATE email_scan_item
SET status                    = 'RETRY_WAIT',
    item_lease_owner          = NULL,
    item_lease_expires_at     = NULL,
    state_version             = state_version + 1,
    next_retry_at             = $nextRetryAt,
    last_error_code           = $sanitizedErrorCode,
    last_error_message_sanitized = $sanitizedErrorMessage,
    updated_at                = now()
WHERE id = $itemId
  AND status                  = 'FETCHING'
  AND item_lease_owner        = $uuid
  AND item_lease_expires_at   > now()
  AND state_version           = $claimedStateVersion;
-- If 0 rows: lease lost, expired, or state_version changed — roll back result write.
```

**FETCHING → PERMANENTLY_FAILED (by result — not by exhaustion counter):**
```sql
UPDATE email_scan_item
SET status                    = 'PERMANENTLY_FAILED',
    item_lease_owner          = NULL,
    item_lease_expires_at     = NULL,
    state_version             = state_version + 1,
    fetch_completed_at        = now(),
    next_retry_at             = NULL,
    last_error_code           = $sanitizedErrorCode,
    last_error_message_sanitized = $sanitizedErrorMessage,
    updated_at                = now()
WHERE id = $itemId
  AND status                  = 'FETCHING'
  AND item_lease_owner        = $uuid
  AND item_lease_expires_at   > now()
  AND state_version           = $claimedStateVersion;
-- If 0 rows: lease lost, expired, or state_version changed — roll back result write.
```

**Unknown rule-type handling (C56):** An unknown or unrecognized filter rule type in
`email_filter_version.include_rules_json` or `exclude_rules_json` indicates an invalid or
forward-incompatible filter snapshot. This must **fail the scan before discovery or fetching
begins** — not mark every item `PERMANENTLY_FAILED` after the fact. The worker must validate
the filter version's rules under the held lease (step 6 of the 11-step protocol), after
sequence validation and lease acquisition. If validation fails, transition
`email_scan_run` to `FAILED` with `last_error_code = 'INVALID_FILTER_SCHEMA'`, clear all
pending continuation fields, release the lease, and **return HTTP 200** (the message is
handled permanently; HTTP 489 is not used for domain configuration errors).

### Counter-update consistency

Counter updates on `email_scan_run` are performed as a reconciliation-from-items step after
each batch, not as increments, to prevent drift from duplicate delivery.

---

## 12. Security Plan [Planned — pending approval]

### OAuth token encryption (SEC-4)

**Current state:** OAuth `access_token` and `refresh_token` stored unencrypted in the `Account`
table (`06 §5 SEC-4`, `10 §1 SEC-4`).

**Phase 1A plan options:**

Option A — Implement column-level AES-256-GCM encryption for `access_token` and `refresh_token`
using a server-only key (`OAUTH_TOKEN_ENCRYPTION_KEY` env var). Encrypt on write in
`getGmailToken()`; decrypt on read.

Option B — Risk acceptance (private POC, limited user base):
- **Risk owner:** Project PM
- **Approval date:** [Required before Phase 1A ships]
- **Expiry date:** [Required — no more than 6 months from approval]
- **Compensating controls:** Neon database access restricted to application credentials only;
  no direct DB access granted to unprivileged users; Vercel env vars not shared
- **Planned remediation:** Phase 2 prior to any non-private deployment

**Recommendation:** Document Option B risk acceptance formally before Phase 1A ships.

### `/api/test/auth-seed` structural unavailability (SEC-1)

**Current state:** Route exists and can mint sessions when `ENABLE_TEST_AUTH_SEED` is set.

**Phase 1A plan:** The route file must be moved to a build-time excluded path. Proposed:
rename to `src/app/api/test/auth-seed/route.ts.disabled` (Next.js will not register it as a
route). Alternatively, wrap the entire module in:

```typescript
if (process.env.NODE_ENV === "production") {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
```

This provides structural rather than configuration-based protection. Document the chosen
approach.

### Scan error sanitization

Worker error logging must sanitize all messages before persisting to `last_error_message_sanitized` columns:
- Remove Gmail message IDs
- Remove OAuth tokens
- Remove Gmail addresses
- Remove account/card identifiers
- Remove QStash credentials
- Remove statement credentials, PAN, date of birth, OTPs
- Remove raw email body content

A sanitization function `sanitizeErrorMessage(msg: string): string` in `src/lib/scan/sanitize.ts`
handles this.

### Worker input authorization

Worker endpoints must NOT allow user-supplied `scanRunId` to access another user's scan.
The `scanRunId` from the QStash message must be validated against `email_scan_run.user_id` using
the internal server-derived identity, not a user-supplied `userId` in the message body. QStash
worker messages never contain user identifiers — only `scanRunId`.

### All scan and source queries enforce `user_id + gmail_account_id`

Every API query against `email_source` and `email_scan_run` must include both `user_id` and
`gmail_account_id` in the WHERE clause. The `gmail_account_id` is derived from the session
and validated as belonging to the authenticated user — never accepted from request parameters.

---

## 13. Retention and Deletion Model [Planned — pending approval]

### email_source retention

- `retained_until = NULL`: retained indefinitely (default for active sources).
- `retained_until = date`: scheduled for deletion after that date.
- `deleted_at`: soft-delete; source is excluded from all active queries but the row remains
  for FK integrity.

**Protection of sources referenced by multiple scans:** Before hard-deleting an `email_source`
row, check that no `email_scan_item` rows reference it with `ON DELETE RESTRICT`. If referenced,
soft-delete only. Hard delete requires removing all referencing scan items first.

### email_scan_run and email_scan_item retention

- Completed scan runs are retained indefinitely by default in Phase 1A.
- Future: add a `retained_until` column and a scheduled cleanup job.

### email_manual_classification retention

- Classification history rows are never deleted (audit trail).
- If the parent `email_source` is hard-deleted, classification rows cascade-delete.

### User account deletion

When a `User` row is deleted, `ON DELETE CASCADE` propagates to all owned rows in:
`email_source`, `email_scan_run`, `email_filter`, `email_filter_version`,
`email_manual_classification`. All scan items cascade from `email_scan_run`.

**Cascade ordering constraint (DDL dry-run finding):** A direct `DELETE FROM "User"` may fail
if `email_scan_item` rows exist, because `email_scan_item.email_source_id` is `ON DELETE RESTRICT`.
PostgreSQL may attempt the `User → email_source` cascade before the `User → email_scan_run → email_scan_item`
cascade completes. The application erasure path must therefore delete in this explicit order:

1. Delete `email_scan_item` rows (via scan run IDs owned by the user).
2. Delete `email_scan_run` rows owned by the user.
3. Delete `email_source` rows owned by the user.
4. Delete `email_manual_classification` rows owned by the user.
5. Delete `email_filter_version` rows (via filter IDs owned by the user).
6. Delete `email_filter` rows owned by the user.
7. Delete `"User"` row (no Phase 1A RESTRICT FK remains at this point).

---

## 14. Revised Rollback Plan

Phase 1A rollback is NOT zero-risk. The following steps must be completed in order.

**Prerequisites before Phase 1A deploys:**

1. Create a Neon database snapshot (Neon console → Branch → Create snapshot).
2. Record the snapshot ID and the current commit SHA.
3. Confirm no active `SyncJob` rows exist in `status='scanning'` or `status='running'`.

**Rollback sequence (in order):**

1. Set `LEGACY_TRANSACTION_INGESTION_ENABLED=false` and `LLM_PARSING_ENABLED=false` in Vercel
   (already set as part of Phase 1A deploy). If reverting to legacy behavior, set to `true`.
2. Drain QStash messages: navigate to Upstash console → QStash → DLQ → clear pending messages.
   Cancel any scheduled messages for `scanRunId`s via the QStash API.
3. Deploy the previous application commit (Vercel → Deployments → Instant Rollback).
4. Wait for all in-flight Vercel functions to complete (up to 60 seconds).
5. Drop new tables from the database (no existing data is touched):
   ```sql
   DROP TABLE IF EXISTS email_manual_classification CASCADE;
   DROP TABLE IF EXISTS email_scan_item CASCADE;
   DROP TABLE IF EXISTS email_scan_run CASCADE;
   DROP TABLE IF EXISTS email_source CASCADE;
   DROP TABLE IF EXISTS email_filter_version CASCADE;
   DROP TABLE IF EXISTS email_filter CASCADE;
   ```
   **Effects:** All scan metadata, filter definitions, manual classifications, and email inventory
   are permanently lost. This is acceptable because no transactions or parse logs are in the new
   tables.
6. Run Prisma migrate deploy on the rolled-back code to ensure migration history is consistent.
7. Post-rollback validation: confirm `SyncJob` state machine is intact; run existing E2E suite.

**QStash messages arriving after rollback:**

The worker endpoint (`/api/gmail/scan/worker`) no longer exists after code rollback. QStash
will retry delivery, fail with 404, and eventually move messages to the DLQ. Manually clear
the DLQ after rollback.

**Recovery if rollback stops after only some steps:**

If the application code is rolled back but the new tables are not dropped: the tables are inert
(no code references them). This is safe. Drop them at the next maintenance window.

If the tables are dropped but the application code still has Phase 1A routes active: routes will
fail with DB errors. Set `LEGACY_TRANSACTION_INGESTION_ENABLED=true` immediately to restore
the legacy sync path while the code rollback is completed.

---

## 15. Acceptance Criteria Matrix [Planned — pending approval]

All criteria must be demonstrated before Phase 1A is approved as complete.

### 15.1 Scan lifecycle

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-01 | 6-month scan initiates successfully | Integration |
| AC-02 | Discovery is bounded (≤500 IDs per tick) and resumable | Unit |
| AC-03 | Fetching is bounded (≤25 emails per tick) and resumable | Unit |
| AC-04 | Closing the browser does not stop the scan (QStash continues) | E2E |
| AC-05 | Reopening browser shows current progress and resumes polling | E2E |
| AC-06 | Scan can be paused | Integration |
| AC-07 | Scan can be resumed after pause | Integration |
| AC-08 | Scan can be cancelled | Integration |
| AC-08a | Cancel with no active lease transitions directly to `CANCELLED` (Path A) | Unit |
| AC-08b | Cancel with active lease transitions to `CANCELLING`; worker confirms `CANCELLED` (Path B) | Integration |
| AC-08c | `CANCELLED` scan cannot return to any active status | Unit |
| AC-08d | Late QStash delivery to `CANCELLING`/`CANCELLED` scan is a no-op returning HTTP 200 | Unit |
| AC-09 | Cancelled scan stops publishing QStash messages | Integration |
| AC-10 | Worker restart (lease expiry) does not lose or duplicate work | Integration |
| AC-11 | Expired scan lease is recovered by next worker invocation | Integration |

### 15.2 Idempotency and deduplication

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-12 | Duplicate QStash delivery produces no duplicate `email_source` rows | Unit |
| AC-13 | Duplicate QStash delivery produces no duplicate `email_scan_item` rows | Unit |
| AC-14 | Duplicate QStash delivery produces no duplicate fetch attempts counted as success | Unit |
| AC-15 | Duplicate QStash delivery does not double-increment counters | Unit |
| AC-16 | Duplicate QStash delivery produces no duplicate manual-review records | Unit |
| AC-17 | Concurrent worker delivery is safe (one wins, one is a no-op) | Integration |
| AC-18 | Re-scanning the same inbox reuses existing `email_source` rows | Integration |
| AC-19 | Idempotent retry does not create new `email_source` rows | Integration |

### 15.3 Inventory correctness

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-20 | `email_scan_item` count equals Gmail-discovered message ID count | Integration |
| AC-21 | All discovered Gmail message IDs are represented in `email_scan_item` | Integration |
| AC-22 | No `email_scan_item` rows exist without a corresponding `email_source` | Integration |
| AC-23 | `email_source.last_fetch_status` is `FETCHED` for all non-missing, non-failed messages | Integration |

### 15.4 Filter decisions

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-24 | Every fetched item has a `filter_decision` of `INCLUDED` or `EXCLUDED` (not `PENDING`) after filter evaluation | Integration |
| AC-25 | Excluded items show matched rule IDs traceable to `email_filter_version.include_rules_json`/`exclude_rules_json` | Integration |
| AC-26 | Filter decision is traceable to the `email_filter_version_id` used for the scan | Integration |
| AC-26a | Exclude rule match produces `EXCLUDED` regardless of include rules | Unit |
| AC-26b | Empty include rules with no exclude match produces `INCLUDED` | Unit |
| AC-26c | Non-empty include rules with no match and no exclude match produces `EXCLUDED` | Unit |
| AC-26d | Non-empty include rules with at least one match and no exclude match produces `INCLUDED` | Unit |
| AC-26e | Duplicate `rule_id` within a version is rejected at publish time with HTTP 422 | Unit |
| AC-26f | Missing `rule_id`, `type`, or `pattern` in a rule object is rejected at publish with HTTP 422 | Unit |
| AC-26g | Unsupported rule `type` within a compatible schema version transitions the **scan** to `FAILED` with `last_error_code = 'INVALID_FILTER_SCHEMA'` under the held worker lease (step 6), clears pending continuation, releases the lease, and returns HTTP 200 — no items are transitioned to `PERMANENTLY_FAILED` (C60, C69) | Unit |
| AC-26h | `matched_include_rule_ids` and `matched_exclude_rule_ids` are correctly populated after evaluation | Integration |
| AC-26i | Worker checks scan-level `filter_rule_schema_version` and `filter_evaluator_version` against compiled-in supported versions under the held worker lease (step 6 of the 11-step protocol); if incompatible, transitions the **scan** to `FAILED` with `IncompatibleFilterVersionError`, clears pending continuation, releases the lease, and returns HTTP 200 — no fetching begins, no items are transitioned (C69) | Unit |
| AC-26j | Scan snapshot (`email_scan_run`) records `filter_rule_schema_version` and `filter_evaluator_version` at scan start; values are immutable after scan creation | Integration |

### 15.5 Error and retry handling

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-27 | Gmail 429 causes scan to enter `RETRY_WAIT` with `next_retry_at` set | Integration |
| AC-28 | `RETRY_WAIT` state is visible in the progress API | E2E |
| AC-29 | Gmail permanent message-level failure marks item `PERMANENTLY_FAILED` | Integration |
| AC-30 | `PERMANENTLY_FAILED` items remain visible in the UI | E2E |
| AC-31 | Scan completes as `COMPLETED_WITH_ERRORS` when permanent failures exist | Integration |
| AC-32 | Checkpoint success followed by QStash publish failure: worker returns non-2xx (step 10); redelivery re-executes 11-step protocol; committed items are skipped (idempotent); continuation is republished with same dedup ID | Integration |
| AC-33 | Next-message published then worker timeout recovers via idempotent re-delivery | Integration |
| AC-33a | Deterministic deduplication ID prevents duplicate QStash continuation within dedup window | Unit |
| AC-33b | DLQ message can be manually re-enqueued; scan resumes without duplicates | Integration |

### 15.6 Manual classification

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-34 | User can classify an email as `FINANCIAL`, `NON_FINANCIAL`, `UNCERTAIN`, or `UNREVIEWED` | E2E |
| AC-35 | Each classification event appends to `email_manual_classification` (audit history) | Integration |
| AC-36 | Re-classifying creates a new row; prior rows are unchanged | Integration |

### 15.7 Counter correctness

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-37 | Counter reconciliation query matches cached counters on `email_scan_run` | Integration |
| AC-38 | Worker crash does not leave permanently inflated counters | Integration |
| AC-39 | Progress API never shows 100% while any item is in `DISCOVERED`, `FETCHING`, or `RETRY_WAIT`; while any `FETCHED` item has `filter_decision = 'PENDING'`; or while any item is in `CANCELLED` status | Unit + E2E |
| AC-40 | Completion percentage is derived from item states, not only cached counters | Unit |

### 15.8 No transaction creation (critical)

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-41 | Transaction count delta is zero after a complete scan (before count == after count) | E2E |
| AC-42 | `ParseLog` count is unchanged after a complete scan | Integration |
| AC-43 | `upsertTransactionV2` is never called during Phase 1A scan processing | Unit (spy) |
| AC-44 | `parseEmailStatic` (static parser) is never called by Phase 1A scan processing | Unit (spy) |
| AC-45 | `parseEmailBatchLLM` (LLM) is never called | Unit (spy) |
| AC-46 | Gemini provider is never called | Unit (spy) |
| AC-47 | OpenAI provider is never called | Unit (spy) |
| AC-48 | Exact result cache is never called by Phase 1A | Unit (spy) |
| AC-49 | Template cache is never called by Phase 1A | Unit (spy) |

### 15.9 Feature flags

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-50 | `LEGACY_TRANSACTION_INGESTION_ENABLED=false` causes legacy sync-start to return 503 | Unit |
| AC-51 | `LEGACY_TRANSACTION_INGESTION_ENABLED=false` causes legacy advance to return 503 | Unit |
| AC-52 | Legacy sync UI is hidden when the flag is false | E2E |
| AC-53 | Missing flag value defaults to disabled | Unit |
| AC-54 | Malformed flag value defaults to disabled | Unit |
| AC-55 | `LLM_PARSING_ENABLED=false` causes `parseEmailBatchLLM` to throw `LlmDisabledError` | Unit |
| AC-56 | No AI provider is called when `LLM_PARSING_ENABLED=false` | Unit (spy) |

### 15.10 Security

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-57 | QStash signature verification rejects unsigned/invalid requests with HTTP 489 + `Upstash-NonRetryable-Error: true` | Unit |
| AC-58 | QStash signature verification accepts correctly signed requests | Unit |
| AC-59 | Worker endpoint rejects browser session authentication | Unit |
| AC-60 | Worker cannot be used to access another user's scan (user isolation) | Integration |
| AC-61 | Gmail-account isolation: user A cannot see user B's scan items | Integration |
| AC-62 | Progress API sanitizes error messages (no PII in response) | Unit |
| AC-63 | Worker logs do not contain PII, OAuth tokens, or QStash credentials | Unit |

### 15.11 Progress and polling

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-64 | Progress API returns all required fields from §8.1 | Unit |
| AC-65 | UI polling stops when scan reaches terminal state | E2E |
| AC-66 | UI polling does not invoke worker processing | E2E + Unit |
| AC-67 | Browser-independent scan completion: scan completes after browser is closed | E2E |
| AC-68 | Progress restores correctly when browser is reopened mid-scan | E2E |

### 15.12 Retention and deletion

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-69 | Deleting a `User` cascades to all owned scan/source/filter/classification rows | Integration |
| AC-70 | An `email_source` referenced by multiple scans cannot be hard-deleted (RESTRICT) | Integration |

### 15.13 Quality gates

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-71 | All unit tests pass with `LLM_PARSING_ENABLED=false` and `LEGACY_TRANSACTION_INGESTION_ENABLED=false` | CI |
| AC-72 | All E2E tests use an isolated test database, not dev or production | CI config |
| AC-73 | Rollback procedure completed and verified (new tables dropped, legacy sync restored) | Manual |

**C11 — Gmail disconnection model (AC-74a–e):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-74a | After disconnection, `getGmailToken()` throws before making any Gmail API call | Unit |
| AC-74b | Disconnection sets `disconnected_at`, clears `access_token` and `refresh_token` atomically | Integration |
| AC-74c | Reconnection (re-OAuth) clears `disconnected_at` on the same Account row | Integration |
| AC-74d | `email_source` rows for a disconnected account are NOT deleted when the account is disconnected | Integration |
| AC-74e | Deleting `classified_by` user sets `email_manual_classification.classified_by` to NULL without deleting the classification record | Integration |

**C12 — Filter version immutability (AC-75a–c):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-75a | Any direct UPDATE on an `email_filter_version` row raises an exception | Unit (DB trigger) |
| AC-75b | Deleting parent `email_filter` cascades DELETE to all `email_filter_version` rows for that filter; no version rows orphaned | Integration |
| AC-75c | `started_at` is NULL immediately after scan creation; is set to a non-NULL timestamp after the first CREATED→DISCOVERING transition; is not updated on subsequent transitions | Integration |

**C12 — item CANCELLED status (AC-76a–b):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-76a | After a scan is cancelled, all items previously in `DISCOVERED`, `FETCHING`, or `RETRY_WAIT` transition to `CANCELLED` | Integration |
| AC-76b | A worker invocation that observes scan status `CANCELLED` returns HTTP 200 without processing any items | Unit |

**C52/C53 — Durable initial enqueue and publication acknowledgment (AC-77a–c):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-77a | When scan creation commits but initial QStash publish fails, the scan row exists with `pending_continuation_published_at IS NULL`; the endpoint returns HTTP 202 with `"schedulingStatus": "PENDING_RETRY"`; the scan is recoverable via `POST /api/gmail/scan/{id}/retry` | Integration |
| AC-77b | When initial publish succeeds but `pending_continuation_published_at` update fails, the next delivery detects `published_at IS NULL`, republishes using the same `sha256(scanRunId:DISCOVERY:0)` dedup ID, and QStash drops the duplicate silently | Integration |
| AC-77c | A stale publication-acknowledgment attempt (where `pending_continuation_sequence` no longer matches the DB) updates 0 rows and does not overwrite the newer continuation state | Unit |

**C53 — Sequence validation (AC-78a–c):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-78a | An incoming QStash message whose `sequence` < current `batch_sequence` (already checkpointed) triggers the C65 stale-message continuation recovery procedure: if `pending_continuation_published_at IS NULL`, publishes the persisted pending continuation and returns HTTP 200; if already published, returns HTTP 200 without republishing | Unit |
| AC-78b | An incoming message whose `sequence` matches `pending_continuation_sequence` and `stage` matches `pending_continuation_stage` is processed normally | Unit |
| AC-78c | An incoming message with a future or structurally inconsistent sequence returns HTTP 489 + `Upstash-NonRetryable-Error: true` | Unit |

**C54 — Immediate next-worker delivery (AC-79):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-79 | When step 9 commits and releases the lease, and QStash immediately delivers the next message before the previous invocation returns HTTP 200, the second invocation acquires the lease at step 5 and processes the next batch; both invocations complete without error and no items are double-processed | Integration |

**C56 — Item-result transitions and lease enforcement (AC-80a–c):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-80a | A successful item fetch transitions `FETCHING → FETCHED`, clears the lease, clears `next_retry_at`, and increments `state_version` | Unit |
| AC-80b | A retryable fetch failure transitions `FETCHING → RETRY_WAIT`, clears the lease, and sets `next_retry_at` | Unit |
| AC-80c | If the `item_lease_owner = $uuid` predicate matches 0 rows on any result transition, the result write is rolled back and the item state is not modified | Unit |

**C56 — Unknown rule type (AC-81):**

| # | Criterion | Test type |
|---|-----------|-----------|
| AC-81 | A worker invocation that encounters an unrecognized filter rule type transitions the scan to `FAILED` with `last_error_code = 'INVALID_FILTER_SCHEMA'` under the held lease (step 6), clears pending continuation, releases the lease, and returns HTTP 200 — before any items are claimed or processed; HTTP 489 is NOT returned for domain configuration errors (C69) | Unit |

---

## 16. Test Design Corrections

### Corrected transaction count assertion (Correction #4)

Do NOT assert `SELECT COUNT(*) FROM "Transaction" = 0`.  
DO assert `transaction count after scan = transaction count before scan` (delta = 0).
This allows existing transactions to be present without affecting the assertion.

### Corrected source count assertion

Do NOT assert `newly created email_source count = discovered count`.
DO assert `email_scan_item count = Gmail-discovered ID count`.
Allow existing `email_source` rows to be reused on re-scan.

### Isolated test database

E2E tests must use a dedicated isolated test database. Never use the development or production
database. The test database URL must be configured separately (`DATABASE_URL_TEST` or a
separate Neon branch).

### Gmail error handling

Treat Gmail 429 and equivalent temporary errors (503, 500 with retry-after) as retryable.
Persist `RETRY_WAIT`. Persist `next_retry_at`. Tests must simulate Gmail 429 and verify the
scan enters `RETRY_WAIT` rather than `FAILED`.

---

## 17. Proposed Phase 1A Code Changes (exact list)

**New files:**
- `src/lib/featureFlags.ts` — `isLlmParsingEnabled()`, `isLegacyTransactionIngestionEnabled()`
- `src/lib/scan/types.ts` — domain types: `ScanRunStatus`, `ScanItemStatus`, `FilterDecision`, `ManualClassification`
- `src/lib/scan/scanDomainService.ts` — core domain service; no QStash imports
- `src/lib/scan/scheduler.ts` — `SchedulerService` interface
- `src/lib/scan/schedulers/qstash.ts` — QStash implementation of `SchedulerService`
- `src/lib/scan/schedulers/noop.ts` — No-op implementation for tests
- `src/lib/scan/sanitize.ts` — `sanitizeErrorMessage()` for error PII removal
- `src/lib/scan/leases.ts` — `acquireScanLease()`, `acquireItemLeases()`, `releaseItemLeases()`
- `src/lib/scan/progress.ts` — counter reconciliation query, progress computation
- `src/app/api/gmail/scan/route.ts` — POST start scan
- `src/app/api/gmail/scan/[id]/route.ts` — GET status
- `src/app/api/gmail/scan/[id]/pause/route.ts` — POST pause
- `src/app/api/gmail/scan/[id]/resume/route.ts` — POST resume
- `src/app/api/gmail/scan/[id]/cancel/route.ts` — POST cancel
- `src/app/api/gmail/scan/[id]/retry/route.ts` — POST retry
- `src/app/api/gmail/scan/worker/route.ts` — POST QStash worker endpoint
- `src/app/api/gmail/email/[sourceId]/route.ts` — GET source metadata
- `src/app/api/gmail/email/list/route.ts` — GET inventory
- `src/app/api/gmail/email/stats/route.ts` — GET stats
- `src/app/api/gmail/email/[sourceId]/classify/route.ts` — POST manual classification
- `src/app/api/email-filters/route.ts` — GET list + POST create
- `src/app/api/email-filters/[id]/route.ts` — GET + PATCH + DELETE
- `src/app/api/email-filters/[id]/versions/route.ts` — GET list + POST new version
- `src/app/api/email-filters/[id]/versions/[versionId]/route.ts` — GET version snapshot
- `prisma/migrations/20260718000001_add_email_scan_tables/migration.sql` — 6 new tables
- `tests/lib/featureFlags.test.ts` — AC-50 through AC-56
- `tests/lib/scan/scanDomainService.test.ts`
- `tests/lib/scan/leases.test.ts`
- `tests/lib/scan/progress.test.ts`
- `tests/api/scan-worker.test.ts` — includes early-redelivery test: next QStash message
  arrives immediately after publication, before the previous invocation returns HTTP 200.
  The scan must continue without waiting for lease expiry or losing the continuation.
  Scenario: Step 6 commits + releases lease; QStash delivers the next message; second
  invocation acquires the lease and processes the next batch; first invocation returns HTTP 200.
  Both invocations complete without error; no items are double-processed.
- `e2e/15-email-scan.spec.ts`

**Modified files:**
- `src/app/api/gmail/sync/start/route.ts` — gate with `isLegacyTransactionIngestionEnabled()`
- `src/app/api/gmail/sync/advance/route.ts` — gate with `isLegacyTransactionIngestionEnabled()`; remove `querySecret` path (D-6)
- `src/lib/llm/index.ts` — gate with `isLlmParsingEnabled()`
- `src/app/(app)/settings/page.tsx` — hide legacy sync UI when flag disabled; add `EmailFilter` deprecation notice
- `src/app/(app)/layout.tsx` or navigation — hide legacy sync entry point when flag disabled
- `07-design-decisions.md` — correct ADR-06; add ADR-13/14/15

---

## 18. Proposed Phase 1A Configuration Changes (exact list)

**Vercel environment variables (do not set during Phase 0 revision):**

| Variable | Value | Notes |
|----------|-------|-------|
| `LLM_PARSING_ENABLED` | `false` | Set before Phase 1A code deploys |
| `LEGACY_TRANSACTION_INGESTION_ENABLED` | `false` | Set before Phase 1A code deploys |
| `QSTASH_TOKEN` | `<from Upstash console>` | Server-only; never `NEXT_PUBLIC_*` |
| `QSTASH_CURRENT_SIGNING_KEY` | `<from Upstash console>` | Server-only |
| `QSTASH_NEXT_SIGNING_KEY` | `<from Upstash console>` | Server-only |

**Vercel environment variables to REMOVE:**
| Variable | Reason |
|----------|--------|
| `NEXT_PUBLIC_CRON_SECRET` | Removed per D-6; never expose cron secret to browser |

---

## 19. Proposed External Resources (exact list)

**To be provisioned before Phase 1A deploys (not during Phase 0 revision):**
- Upstash QStash account (free tier; verify terms support personal-use workload)
- QStash queue for scan worker messages
- QStash signing keys (exported to Vercel env vars)

---

## 20. Remaining Open Decisions

| # | Decision | Owner |
|---|----------|-------|
| OD-1 | OAuth token encryption: implement column-level AES-256-GCM (Option A) or formal risk acceptance (Option B)? | PM |
| OD-2 | `/api/test/auth-seed` structural protection: rename-to-disabled file vs. production guard in code? | Engineering |
| OD-3 | QStash terms verification: confirm current free-tier ToS permits personal-POC automated messaging at 1,000 msg/day | PM / Engineering |
| OD-4 | Test database: create a dedicated Neon branch for E2E tests, or use a separate Neon project? | Engineering |
| OD-5 | `email_source` content fingerprint: confirm no Phase 1A requirement justifies storing the HMAC fingerprint field (leave commented-out in schema unless confirmed needed) | Engineering |

---

*Cross-references:* baseline architecture → `04-architecture.md`; data model → `05-data-model-apis.md`;
security findings → `06-security-authentication.md §5`; ADRs → `07-design-decisions.md`;
implementation status → `08-implementation-status.md`; test strategy → `09-testing-quality.md §7`;
risks → `10-risks-tech-debt.md §8`; operations → `11-operations-deployment.md`;
open questions → `12-open-questions.md`.
