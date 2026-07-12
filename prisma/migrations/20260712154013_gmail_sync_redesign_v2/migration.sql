-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "lineItems" JSONB,
ADD COLUMN     "subCategory" TEXT;

-- CreateTable
CREATE TABLE "GmailQueryKeyword" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailQueryKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExclusionRule" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExclusionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantMaster" (
    "id" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subCategory" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantMaster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubCategoryMaster" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subCategory" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "addedBy" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "SubCategoryMaster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailQueryKeyword_type_value_key" ON "GmailQueryKeyword"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ExclusionRule_type_value_key" ON "ExclusionRule"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantMaster_merchantName_key" ON "MerchantMaster"("merchantName");

-- CreateIndex
CREATE UNIQUE INDEX "SubCategoryMaster_category_subCategory_key" ON "SubCategoryMaster"("category", "subCategory");
