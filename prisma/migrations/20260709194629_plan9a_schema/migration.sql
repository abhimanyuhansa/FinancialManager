-- AlterTable
ALTER TABLE "SyncJob" ADD COLUMN     "encryptedBlockedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MerchantRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementPassword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementPassword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParseLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "syncJobId" TEXT NOT NULL,
    "gmailMsgId" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "emailDate" TIMESTAMP(3),
    "bodyLengthRaw" INTEGER NOT NULL,
    "bodyLengthSent" INTEGER NOT NULL,
    "wasTruncated" BOOLEAN NOT NULL DEFAULT false,
    "batchSize" INTEGER NOT NULL DEFAULT 1,
    "outcome" TEXT NOT NULL,
    "geminiConfidence" DOUBLE PRECISION,
    "parsedMerchant" TEXT,
    "parsedAmount" DOUBLE PRECISION,
    "transactionId" TEXT,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParseLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRule_userId_merchantName_key" ON "MerchantRule"("userId", "merchantName");

-- CreateIndex
CREATE UNIQUE INDEX "StatementPassword_userId_senderDomain_key" ON "StatementPassword"("userId", "senderDomain");

-- CreateIndex
CREATE INDEX "ParseLog_userId_syncJobId_idx" ON "ParseLog"("userId", "syncJobId");

-- CreateIndex
CREATE INDEX "ParseLog_userId_gmailMsgId_idx" ON "ParseLog"("userId", "gmailMsgId");

-- CreateIndex
CREATE INDEX "ParseLog_createdAt_idx" ON "ParseLog"("createdAt");

-- AddForeignKey
ALTER TABLE "MerchantRule" ADD CONSTRAINT "MerchantRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementPassword" ADD CONSTRAINT "StatementPassword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParseLog" ADD CONSTRAINT "ParseLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
