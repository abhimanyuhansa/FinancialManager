-- AlterTable: add slug, drop color, add createdAt to Category
ALTER TABLE "Category" ADD COLUMN "slug" TEXT;
ALTER TABLE "Category" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Category" DROP COLUMN IF EXISTS "color";

-- Backfill slug from name for any existing rows (table was empty in practice)
UPDATE "Category" SET "slug" = LOWER(REGEXP_REPLACE(TRIM("name"), '[^a-zA-Z0-9]+', '-', 'g')) WHERE "slug" IS NULL;

-- Make slug NOT NULL and unique
ALTER TABLE "Category" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- Set default for icon column if it doesn't have one
ALTER TABLE "Category" ALTER COLUMN "icon" SET DEFAULT '';
