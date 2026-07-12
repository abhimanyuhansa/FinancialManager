-- CreateTable
CREATE TABLE "VpaMerchantMap" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vpa" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "subCategory" TEXT,
    "confirmedByUser" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VpaMerchantMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VpaMerchantMap_userId_idx" ON "VpaMerchantMap"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VpaMerchantMap_userId_vpa_key" ON "VpaMerchantMap"("userId", "vpa");

-- AddForeignKey
ALTER TABLE "VpaMerchantMap" ADD CONSTRAINT "VpaMerchantMap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
