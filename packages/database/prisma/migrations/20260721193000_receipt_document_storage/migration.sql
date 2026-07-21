PRAGMA foreign_keys=OFF;

CREATE TABLE "ReceiptDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "receiptId" TEXT NOT NULL,
  "relativePath" TEXT NOT NULL,
  "originalFilename" TEXT,
  "mediaType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReceiptDocument_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReceiptPage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentId" TEXT NOT NULL,
  "pageNumber" INTEGER NOT NULL,
  "totalPages" INTEGER NOT NULL,
  "relativePath" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceiptPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReceiptDocument_receiptId_key" ON "ReceiptDocument"("receiptId");
CREATE UNIQUE INDEX "ReceiptDocument_relativePath_key" ON "ReceiptDocument"("relativePath");
CREATE INDEX "ReceiptDocument_sha256_byteSize_idx" ON "ReceiptDocument"("sha256", "byteSize");
CREATE UNIQUE INDEX "ReceiptPage_relativePath_key" ON "ReceiptPage"("relativePath");
CREATE UNIQUE INDEX "ReceiptPage_documentId_pageNumber_key" ON "ReceiptPage"("documentId", "pageNumber");

PRAGMA foreign_keys=ON;
