CREATE TABLE "EmailImportCursor" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountKey" TEXT NOT NULL,
  "mailboxKey" TEXT NOT NULL,
  "uidValidity" TEXT NOT NULL,
  "lastUid" INTEGER NOT NULL DEFAULT 0,
  "lastSuccessfulPollAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "EmailImportCursor_accountKey_mailboxKey_uidValidity_key" ON "EmailImportCursor"("accountKey", "mailboxKey", "uidValidity");
CREATE INDEX "EmailImportCursor_accountKey_mailboxKey_updatedAt_idx" ON "EmailImportCursor"("accountKey", "mailboxKey", "updatedAt");

CREATE TABLE "EmailImporterHealth" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "lastSuccessfulPollAt" DATETIME,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "EmailMessageImport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cursorId" TEXT NOT NULL,
  "uid" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'discovered',
  "failureCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "EmailMessageImport_cursorId_fkey" FOREIGN KEY ("cursorId") REFERENCES "EmailImportCursor"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailMessageImport_cursorId_uid_key" ON "EmailMessageImport"("cursorId", "uid");
CREATE INDEX "EmailMessageImport_status_updatedAt_idx" ON "EmailMessageImport"("status", "updatedAt");

CREATE TABLE "EmailAttachmentImport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "partId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "originalFilename" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" DATETIME,
  "leaseExpiresAt" DATETIME,
  "claimToken" TEXT,
  "failureCode" TEXT,
  "sha256" TEXT,
  "byteSize" INTEGER,
  "receiptId" TEXT,
  "documentId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "EmailAttachmentImport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessageImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmailAttachmentImport_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmailAttachmentImport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailAttachmentImport_claimToken_key" ON "EmailAttachmentImport"("claimToken");
CREATE UNIQUE INDEX "EmailAttachmentImport_messageId_partId_key" ON "EmailAttachmentImport"("messageId", "partId");
CREATE INDEX "EmailAttachmentImport_status_availableAt_id_idx" ON "EmailAttachmentImport"("status", "availableAt", "id");
