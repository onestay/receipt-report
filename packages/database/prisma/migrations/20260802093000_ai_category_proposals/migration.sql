ALTER TABLE "ExtractionAttempt" ADD COLUMN "categoryOptionSnapshot" TEXT;
ALTER TABLE "ExtractionAttempt" ADD COLUMN "categoryOptionFingerprint" TEXT;
ALTER TABLE "CorrectionEvent" ADD COLUMN "originalCategoryProvenance" TEXT;

UPDATE "ExtractionJob"
SET "extractionProfileVersion" = 'de-receipt-v2'
WHERE "extractionProfileVersion" = 'de-receipt-v1'
  AND "status" IN ('pending', 'retry_wait');
