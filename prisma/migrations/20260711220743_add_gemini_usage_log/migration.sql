-- CreateTable
CREATE TABLE "GeminiUsageLog" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "callCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GeminiUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GeminiUsageLog_date_key" ON "GeminiUsageLog"("date");
