-- Synthetic pre-migration data for the Phase 1A Stage 1 migration drill.
-- No values in this fixture come from a real user, account, message, or transaction.

INSERT INTO "User" (
  "id", "email", "name", "createdAt", "emailVerified"
) VALUES
  (
    'phase1a-representative-user-a',
    'phase1a-user-a@example.invalid',
    'Synthetic User A',
    TIMESTAMP '2026-01-01 00:00:00',
    TIMESTAMP '2026-01-01 00:00:00'
  ),
  (
    'phase1a-representative-user-b',
    'phase1a-user-b@example.invalid',
    'Synthetic User B',
    TIMESTAMP '2026-01-02 00:00:00',
    NULL
  );

INSERT INTO "Account" (
  "id", "userId", "type", "provider", "providerAccountId"
) VALUES
  (
    'phase1a-representative-account-a1',
    'phase1a-representative-user-a',
    'oauth',
    'google',
    'synthetic-provider-account-a1'
  ),
  (
    'phase1a-representative-account-a2',
    'phase1a-representative-user-a',
    'oauth',
    'google',
    'synthetic-provider-account-a2'
  ),
  (
    'phase1a-representative-account-b1',
    'phase1a-representative-user-b',
    'oauth',
    'google',
    'synthetic-provider-account-b1'
  );

INSERT INTO "SyncJob" (
  "id", "userId", "status", "totalEmails", "processedEmails",
  "newTransactions", "skippedEmails", "encryptedBlockedCount",
  "isRetrigger", "startedAt", "completedAt"
) VALUES (
  'phase1a-representative-sync-job',
  'phase1a-representative-user-a',
  'completed',
  2,
  2,
  1,
  1,
  0,
  false,
  TIMESTAMP '2026-01-03 00:00:00',
  TIMESTAMP '2026-01-03 00:01:00'
);

INSERT INTO "SyncJobMessage" (
  "id", "syncJobId", "gmailMsgId", "processed"
) VALUES
  (
    'phase1a-representative-sync-message-1',
    'phase1a-representative-sync-job',
    'synthetic-message-1',
    true
  ),
  (
    'phase1a-representative-sync-message-2',
    'phase1a-representative-sync-job',
    'synthetic-message-2',
    true
  );

INSERT INTO "Transaction" (
  "id", "userId", "gmailMsgId", "fingerprint", "date", "merchant",
  "amount", "type", "currency", "category", "source", "sourceRank",
  "reviewed", "needsReview", "createdAt"
) VALUES (
  'phase1a-representative-transaction',
  'phase1a-representative-user-a',
  'synthetic-message-1',
  'synthetic-fingerprint-1',
  TIMESTAMP '2026-01-03 00:00:30',
  'Synthetic Merchant',
  123.45,
  'debit',
  'INR',
  'Synthetic Category',
  'fixture',
  3,
  true,
  false,
  TIMESTAMP '2026-01-03 00:00:31'
);
