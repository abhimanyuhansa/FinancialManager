-- Add resolvedBy to ParseLog
ALTER TABLE "ParseLog" ADD COLUMN "resolvedBy" TEXT;

-- Create ParseTemplate table
CREATE TABLE "ParseTemplate" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "senderDomain" TEXT NOT NULL,
  "templateHash" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "taxonomyVersion" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL,
  "subjectTemplate" TEXT NOT NULL,
  "bodyTemplate" TEXT NOT NULL,
  "extractors" JSONB NOT NULL,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "failCount" INTEGER NOT NULL DEFAULT 0,
  "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "promotedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "lastFailedAt" TIMESTAMP(3),
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParseTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ParseTemplate_userId_senderDomain_templateHash_parserVersion_key"
  ON "ParseTemplate"("userId", "senderDomain", "templateHash", "parserVersion");

CREATE INDEX "ParseTemplate_userId_senderDomain_status_idx"
  ON "ParseTemplate"("userId", "senderDomain", "status");

ALTER TABLE "ParseTemplate" ADD CONSTRAINT "ParseTemplate_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
