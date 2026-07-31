ALTER TABLE "ReceiptDocument" ADD COLUMN "normalizationRevision" TEXT;

UPDATE "ReceiptDocument"
SET "normalizationRevision" = 'legacy-' || "id"
WHERE "normalizationStatus" = 'complete';

CREATE TABLE "ExtractionJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentId" TEXT NOT NULL,
  "normalizationRevision" TEXT NOT NULL,
  "normalizationProfileVersion" TEXT NOT NULL,
  "extractionProfileVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL,
  "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" DATETIME,
  "leaseExpiresAt" DATETIME,
  "claimToken" TEXT,
  "lastErrorKind" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExtractionJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ExtractionAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jobId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "extractionProfileVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "failureKind" TEXT,
  "retryable" BOOLEAN,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  "durationMs" INTEGER,
  "rawProviderOutput" TEXT,
  "rawPurgedAt" DATETIME,
  "validatedOutput" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExtractionAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ExtractionJob_documentId_normalizationRevision_key" ON "ExtractionJob"("documentId", "normalizationRevision");
CREATE INDEX "ExtractionJob_status_availableAt_id_idx" ON "ExtractionJob"("status", "availableAt", "id");
CREATE INDEX "ExtractionJob_documentId_createdAt_idx" ON "ExtractionJob"("documentId", "createdAt");
CREATE UNIQUE INDEX "ExtractionAttempt_jobId_attemptNumber_key" ON "ExtractionAttempt"("jobId", "attemptNumber");
CREATE INDEX "ExtractionAttempt_completedAt_rawPurgedAt_idx" ON "ExtractionAttempt"("completedAt", "rawPurgedAt");
