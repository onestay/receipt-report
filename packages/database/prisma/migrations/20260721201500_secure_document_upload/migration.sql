DROP INDEX "ReceiptDocument_sha256_byteSize_idx";
CREATE UNIQUE INDEX "ReceiptDocument_sha256_byteSize_key" ON "ReceiptDocument"("sha256", "byteSize");

CREATE TABLE "DocumentFileCleanup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "relativePath" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "DocumentFileCleanup_relativePath_key" ON "DocumentFileCleanup"("relativePath");
