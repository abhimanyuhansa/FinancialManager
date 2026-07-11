-- CreateTable: SyncJobMessage
CREATE TABLE IF NOT EXISTS "SyncJobMessage" (
    "id" TEXT NOT NULL,
    "syncJobId" TEXT NOT NULL,
    "gmailMsgId" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SyncJobMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SyncJobMessage_syncJobId_gmailMsgId_key" ON "SyncJobMessage"("syncJobId", "gmailMsgId");
CREATE INDEX IF NOT EXISTS "SyncJobMessage_syncJobId_processed_idx" ON "SyncJobMessage"("syncJobId", "processed");

-- AddForeignKey
ALTER TABLE "SyncJobMessage" ADD CONSTRAINT "SyncJobMessage_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "SyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing messageIds JSON blobs to SyncJobMessage rows before dropping the column
INSERT INTO "SyncJobMessage" ("id", "syncJobId", "gmailMsgId", "processed")
SELECT
  gen_random_uuid()::text,
  "id",
  jsonb_array_elements_text("messageIds"::jsonb),
  false
FROM "SyncJob"
WHERE "messageIds" IS NOT NULL AND "status" IN ('scanning', 'running')
ON CONFLICT ("syncJobId", "gmailMsgId") DO NOTHING;

-- AlterTable: drop messageIds column from SyncJob
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "messageIds";
