ALTER TABLE "Receipt" ADD COLUMN "netCents" INTEGER;
ALTER TABLE "Receipt" ADD COLUMN "taxCents" INTEGER;
ALTER TABLE "LineItem" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'item';

CREATE TABLE "ExtractionProposal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "receiptId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "normalizationRevision" TEXT NOT NULL,
  "extractionProfileVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "snapshot" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExtractionProposal_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExtractionProposal_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExtractionProposal_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExtractionAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ExtractionProposal_attemptId_key" ON "ExtractionProposal"("attemptId");
CREATE INDEX "ExtractionProposal_receiptId_createdAt_idx" ON "ExtractionProposal"("receiptId", "createdAt");
CREATE INDEX "ExtractionProposal_documentId_normalizationRevision_status_idx" ON "ExtractionProposal"("documentId", "normalizationRevision", "status");

CREATE TABLE "ExtractionFinding" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "proposalId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "fieldPath" TEXT,
  "message" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExtractionFinding_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ExtractionProposal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ExtractionFinding_proposalId_severity_code_idx" ON "ExtractionFinding"("proposalId", "severity", "code");

CREATE TABLE "ExtractionDecision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "proposalId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "proposalSnapshot" TEXT NOT NULL,
  "acceptedSnapshot" TEXT,
  "differences" TEXT,
  "acknowledgedWarnings" TEXT,
  "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExtractionDecision_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ExtractionProposal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ExtractionDecision_proposalId_decidedAt_idx" ON "ExtractionDecision"("proposalId", "decidedAt");
