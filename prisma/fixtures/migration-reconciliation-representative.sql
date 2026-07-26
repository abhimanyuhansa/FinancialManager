-- Synthetic data used to prove that out-of-order reconciliation and nullable drift additions
-- preserve already-migrated production-like rows. No value comes from a real user or provider.

INSERT INTO "ParseTemplate" (
  "id",
  "userId",
  "senderDomain",
  "templateHash",
  "parserVersion",
  "taxonomyVersion",
  "status",
  "subjectTemplate",
  "bodyTemplate",
  "extractors",
  "hitCount",
  "failCount",
  "consecutiveSuccesses",
  "consecutiveFailures",
  "createdAt",
  "updatedAt"
) VALUES (
  'migration-reconciliation-template',
  'phase1a-representative-user-a',
  'synthetic.example.invalid',
  'synthetic-template-hash',
  'synthetic-parser-v1',
  'synthetic-taxonomy-v1',
  'ACTIVE',
  'Synthetic subject template',
  'Synthetic body template',
  '{}'::jsonb,
  7,
  1,
  3,
  0,
  TIMESTAMP '2026-01-04 00:00:00',
  TIMESTAMP '2026-01-05 00:00:00'
);

INSERT INTO "LlmCallLog" (
  "id",
  "userId",
  "provider",
  "model",
  "candidateCount",
  "attemptNumber",
  "wasFallback",
  "outcome",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "createdAt"
) VALUES (
  'migration-reconciliation-llm-log',
  'phase1a-representative-user-a',
  'synthetic-provider',
  'synthetic-model',
  2,
  1,
  false,
  'success',
  12,
  10,
  5,
  0.000001,
  TIMESTAMP '2026-01-05 00:00:00'
);

INSERT INTO "LlmCircuitBreaker" (
  "provider",
  "state",
  "consecutiveFailures",
  "updatedAt"
) VALUES (
  'synthetic-provider',
  'CLOSED',
  0,
  TIMESTAMP '2026-01-05 00:00:00'
);
