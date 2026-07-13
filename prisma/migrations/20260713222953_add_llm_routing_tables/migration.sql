-- AlterTable
ALTER TABLE "ParseTemplate" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "syncJobId" TEXT,
    "userId" TEXT,
    "batchKey" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "wasFallback" BOOLEAN NOT NULL DEFAULT false,
    "fallbackReason" TEXT,
    "outcome" TEXT NOT NULL,
    "errorDetail" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmQuotaWindow" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "windowType" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmQuotaWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCircuitBreaker" (
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmCircuitBreaker_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "LlmBatchIdempotency" (
    "id" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmBatchIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJobLock" (
    "jobId" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncJobLock_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "LlmCallLog_provider_createdAt_idx" ON "LlmCallLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "LlmCallLog_syncJobId_idx" ON "LlmCallLog"("syncJobId");

-- CreateIndex
CREATE INDEX "LlmCallLog_batchKey_idx" ON "LlmCallLog"("batchKey");

-- CreateIndex
CREATE INDEX "LlmQuotaWindow_provider_windowType_windowKey_idx" ON "LlmQuotaWindow"("provider", "windowType", "windowKey");

-- CreateIndex
CREATE UNIQUE INDEX "LlmQuotaWindow_provider_windowType_windowKey_key" ON "LlmQuotaWindow"("provider", "windowType", "windowKey");

-- CreateIndex
CREATE UNIQUE INDEX "LlmBatchIdempotency_batchKey_key" ON "LlmBatchIdempotency"("batchKey");

-- CreateIndex
CREATE INDEX "LlmBatchIdempotency_expiresAt_idx" ON "LlmBatchIdempotency"("expiresAt");

-- CreateIndex
CREATE INDEX "SyncJobLock_expiresAt_idx" ON "SyncJobLock"("expiresAt");

-- RenameIndex
ALTER INDEX "ParseTemplate_userId_senderDomain_templateHash_parserVersion_ke" RENAME TO "ParseTemplate_userId_senderDomain_templateHash_parserVersio_key";
