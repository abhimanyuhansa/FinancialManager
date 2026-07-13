CREATE TABLE "SubCategory" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "icon" TEXT NOT NULL DEFAULT '',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "parentSlug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubCategory_slug_key" ON "SubCategory"("slug");
ALTER TABLE "SubCategory" ADD CONSTRAINT "SubCategory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubCategory" ADD CONSTRAINT "SubCategory_parentSlug_fkey"
  FOREIGN KEY ("parentSlug") REFERENCES "Category"("slug") ON DELETE CASCADE ON UPDATE CASCADE;
