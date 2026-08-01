CREATE TABLE "CorrectionEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "decisionId" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "extractionProfileVersion" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "fieldPath" TEXT NOT NULL,
  "fieldKind" TEXT NOT NULL,
  "sourcePosition" INTEGER,
  "correctionKind" TEXT NOT NULL,
  "proposedValue" TEXT NOT NULL,
  "acceptedValue" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CorrectionEvent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ExtractionDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionEvent_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ExtractionProposal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExtractionAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionEvent_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CorrectionEvent_decisionId_fieldPath_key" ON "CorrectionEvent"("decisionId", "fieldPath");
CREATE INDEX "CorrectionEvent_createdAt_fieldKind_id_idx" ON "CorrectionEvent"("createdAt", "fieldKind", "id");
CREATE INDEX "CorrectionEvent_extractionProfileVersion_provider_model_createdAt_idx" ON "CorrectionEvent"("extractionProfileVersion", "provider", "model", "createdAt");
CREATE INDEX "CorrectionEvent_proposalId_idx" ON "CorrectionEvent"("proposalId");
CREATE INDEX "CorrectionEvent_receiptId_idx" ON "CorrectionEvent"("receiptId");
