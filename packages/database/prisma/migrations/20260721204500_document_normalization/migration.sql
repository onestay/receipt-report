ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationError" TEXT;
ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationProfileVersion" TEXT;
ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationRenderer" TEXT;
ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationRequestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationStartedAt" DATETIME;
ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationCompletedAt" DATETIME;

ALTER TABLE "ReceiptPage" ADD COLUMN "profileVersion" TEXT NOT NULL DEFAULT 'receipt-page-v1';
ALTER TABLE "ReceiptPage" ADD COLUMN "renderer" TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE "NormalizationJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "profileVersion" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "NormalizationJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "NormalizationJob_documentId_key" ON "NormalizationJob"("documentId");
CREATE INDEX "NormalizationJob_status_availableAt_id_idx" ON "NormalizationJob"("status", "availableAt", "id");

INSERT INTO "NormalizationJob" (
  "id", "documentId", "status", "profileVersion", "attempts", "availableAt", "createdAt", "updatedAt"
)
SELECT
  'normalize_' || "id", "id", 'pending', 'receipt-page-v1', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ReceiptDocument";
