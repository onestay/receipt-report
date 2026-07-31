import type { Prisma } from "@prisma/client";
import { extractionStatusResponseSchema } from "@receipt-report/contracts";
import type { Database } from "@receipt-report/database";
import { ConflictError, NotFoundError } from "./errors.js";

type ExtractionApiConfig = {
  maxAttempts: number;
  profileVersion: string;
};

type StoredJob = Prisma.ExtractionJobGetPayload<{
  include: { processingAttempts: true };
}>;
type StoredDocument = Prisma.ReceiptDocumentGetPayload<{
  include: { pages: true };
}>;

export class ExtractionRepository {
  constructor(
    private readonly database: Database,
    private readonly config: ExtractionApiConfig,
  ) {}

  private async document(receiptId: string) {
    const receipt = await this.database.receipt.findUnique({
      where: { id: receiptId },
      select: { id: true },
    });
    if (!receipt) throw new NotFoundError("Receipt not found");
    const document = await this.database.receiptDocument.findUnique({
      where: { receiptId },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });
    if (!document) throw new NotFoundError("Receipt document not found");
    return document;
  }

  private async currentJob(documentId: string, normalizationRevision: string) {
    return this.database.extractionJob.findUnique({
      where: {
        documentId_normalizationRevision: {
          documentId,
          normalizationRevision,
        },
      },
      include: {
        processingAttempts: {
          orderBy: { attemptNumber: "desc" },
          take: 1,
        },
      },
    });
  }

  private publicStatus(job: NonNullable<StoredJob>) {
    const attempt = job.processingAttempts[0];
    return extractionStatusResponseSchema.parse({
      documentId: job.documentId,
      normalizationRevision: job.normalizationRevision,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      availableAt: job.availableAt.toISOString(),
      lastErrorKind: job.lastErrorKind,
      currentAttempt: attempt
        ? {
            attemptNumber: attempt.attemptNumber,
            provider: attempt.provider,
            model: attempt.model,
            profileVersion: attempt.extractionProfileVersion,
            status: attempt.status,
            failureKind: attempt.failureKind,
            retryable: attempt.retryable,
            startedAt: attempt.startedAt.toISOString(),
            completedAt: attempt.completedAt?.toISOString() ?? null,
            durationMs: attempt.durationMs,
            rawPurgedAt: attempt.rawPurgedAt?.toISOString() ?? null,
          }
        : null,
    });
  }

  private requireComplete(document: StoredDocument) {
    if (
      document.normalizationStatus !== "complete" ||
      !document.normalizationRevision ||
      !document.normalizationProfileVersion ||
      document.pages.length < 1 ||
      document.pages.some(
        (page, index) =>
          page.pageNumber !== index + 1 ||
          page.totalPages !== document.pages.length ||
          page.profileVersion !== document.normalizationProfileVersion,
      )
    ) {
      throw new ConflictError("Receipt document is not completely normalized");
    }
    return {
      revision: document.normalizationRevision,
      profileVersion: document.normalizationProfileVersion,
    };
  }

  async status(receiptId: string) {
    const document = await this.document(receiptId);
    const { revision } = this.requireComplete(document);
    const job = await this.currentJob(document.id, revision);
    if (!job) throw new NotFoundError("Extraction job not found");
    return this.publicStatus(job);
  }

  async enqueue(receiptId: string) {
    const document = await this.document(receiptId);
    const { revision, profileVersion } = this.requireComplete(document);
    const existing = await this.currentJob(document.id, revision);
    if (existing) {
      if (existing.status === "running")
        throw new ConflictError("Receipt extraction is currently running");
      return this.publicStatus(existing);
    }
    await this.database.extractionJob.upsert({
      where: {
        documentId_normalizationRevision: {
          documentId: document.id,
          normalizationRevision: revision,
        },
      },
      create: {
        documentId: document.id,
        normalizationRevision: revision,
        normalizationProfileVersion: profileVersion,
        extractionProfileVersion: this.config.profileVersion,
        maxAttempts: this.config.maxAttempts,
      },
      update: {},
    });
    const created = await this.currentJob(document.id, revision);
    if (!created) throw new Error("Created extraction job is missing");
    return this.publicStatus(created);
  }

  async retry(receiptId: string) {
    const document = await this.document(receiptId);
    const { revision } = this.requireComplete(document);
    const job = await this.currentJob(document.id, revision);
    if (!job) throw new NotFoundError("Extraction job not found");
    if (job.status === "running")
      throw new ConflictError("Receipt extraction is currently running");
    if (job.status === "pending" || job.status === "retry_wait")
      return this.publicStatus(job);
    if (job.status !== "failed")
      throw new ConflictError(
        "Only a terminal extraction failure can be retried",
      );
    await this.database.extractionJob.update({
      where: { id: job.id },
      data: {
        status: "pending",
        maxAttempts: job.attempts + this.config.maxAttempts,
        availableAt: new Date(),
        claimedAt: null,
        leaseExpiresAt: null,
        claimToken: null,
        lastErrorKind: null,
      },
    });
    const updated = await this.currentJob(document.id, revision);
    if (!updated) throw new Error("Retried extraction job is missing");
    return this.publicStatus(updated);
  }
}
