import type { ReadStream } from "node:fs";
import {
  NORMALIZATION_PROFILE_VERSION,
  receiptDocumentResponseSchema,
  type ReceiptDocumentResponse,
} from "@receipt-report/contracts";
import {
  type Database,
  type FilesystemDocumentStorage,
  persistOriginalDocument,
  replacementOriginalDocumentPath,
} from "@receipt-report/database";
import {
  DocumentValidationTimeoutError,
  MalformedDocumentError,
  sanitizeOriginalFilename,
  UnsupportedDocumentError,
  validateStagedDocument,
  type DocumentValidationLimits,
} from "./document-validation.js";
import {
  ConflictError,
  DocumentRequestError,
  DuplicateDocumentError,
  NotFoundError,
  prismaErrorCode,
} from "./errors.js";
import type { StagedMultipartDocument } from "./multipart.js";

type StoredDocument = {
  id: string;
  receiptId: string;
  relativePath: string;
  originalFilename: string | null;
  mediaType: string;
  byteSize: number;
  sha256: string;
  createdAt: Date;
  updatedAt: Date;
  normalizationStatus: string;
  normalizationError: string | null;
  normalizationProfileVersion: string | null;
  normalizationRenderer: string | null;
  normalizationRequestedAt: Date;
  normalizationStartedAt: Date | null;
  normalizationCompletedAt: Date | null;
  pages: StoredPage[];
};

type StoredPage = {
  id: string;
  documentId: string;
  pageNumber: number;
  totalPages: number;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  profileVersion: string;
  renderer: string;
  createdAt: Date;
};

function documentExtension(mediaType: string): string {
  return mediaType === "application/pdf"
    ? "pdf"
    : mediaType === "image/png"
      ? "png"
      : "jpg";
}

function publicDocument(document: StoredDocument): ReceiptDocumentResponse {
  return receiptDocumentResponseSchema.parse({
    id: document.id,
    receiptId: document.receiptId,
    originalFilename: document.originalFilename,
    mediaType: document.mediaType,
    byteSize: document.byteSize,
    sha256: document.sha256,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    normalizationStatus: document.normalizationStatus,
    normalizationError: document.normalizationError,
    normalizationProfileVersion: document.normalizationProfileVersion,
    normalizationRenderer: document.normalizationRenderer,
    normalizationRequestedAt: document.normalizationRequestedAt.toISOString(),
    normalizationStartedAt:
      document.normalizationStartedAt?.toISOString() ?? null,
    normalizationCompletedAt:
      document.normalizationCompletedAt?.toISOString() ?? null,
    originalUrl: `/api/v1/receipts/${document.receiptId}/documents/${document.id}/original`,
    pages: document.pages.map((page) => ({
      ...page,
      createdAt: page.createdAt.toISOString(),
      imageUrl: `/api/v1/receipts/${document.receiptId}/documents/${document.id}/pages/${page.id}`,
    })),
  });
}

export async function retryDocumentFileCleanup(
  database: Database,
  storage: FilesystemDocumentStorage,
): Promise<void> {
  const pending = await database.documentFileCleanup.findMany({
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const cleanup of pending) {
    try {
      await storage.cleanup(cleanup.relativePath);
      await database.documentFileCleanup.delete({ where: { id: cleanup.id } });
    } catch {
      await database.documentFileCleanup.update({
        where: { id: cleanup.id },
        data: { attempts: { increment: 1 }, lastError: "cleanup_failed" },
      });
    }
  }
}

export class DocumentRepository {
  constructor(
    private readonly database: Database,
    private readonly storage: FilesystemDocumentStorage,
    private readonly validationLimits: DocumentValidationLimits,
  ) {}

  private async stored(receiptId: string): Promise<StoredDocument | null> {
    return this.database.receiptDocument.findUnique({
      where: { receiptId },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });
  }

  private async requireReceipt(receiptId: string): Promise<void> {
    if (!(await this.database.receipt.findUnique({ where: { id: receiptId } })))
      throw new NotFoundError("Receipt not found");
  }

  private async duplicate(
    sha256: string,
    byteSize: number,
  ): Promise<{ id: string; receiptId: string } | null> {
    return this.database.receiptDocument.findUnique({
      where: { sha256_byteSize: { sha256, byteSize } },
      select: { id: true, receiptId: true },
    });
  }

  private async cleanupRecordedPath(relativePath: string): Promise<void> {
    try {
      await this.storage.cleanup(relativePath);
      await this.database.documentFileCleanup.deleteMany({
        where: { relativePath },
      });
    } catch {
      await this.database.documentFileCleanup.upsert({
        where: { relativePath },
        create: { relativePath, attempts: 1, lastError: "cleanup_failed" },
        update: { attempts: { increment: 1 }, lastError: "cleanup_failed" },
      });
    }
  }

  private async recordFailedCleanup(relativePath: string): Promise<void> {
    await this.database.documentFileCleanup.upsert({
      where: { relativePath },
      create: { relativePath, attempts: 1, lastError: "cleanup_failed" },
      update: { attempts: { increment: 1 }, lastError: "cleanup_failed" },
    });
  }

  async discardStaged(relativePath: string): Promise<void> {
    try {
      await this.storage.cleanup(relativePath);
    } catch {
      await this.recordFailedCleanup(relativePath);
    }
  }

  async get(receiptId: string): Promise<ReceiptDocumentResponse> {
    await this.requireReceipt(receiptId);
    const document = await this.stored(receiptId);
    if (!document) throw new NotFoundError("Receipt document not found");
    return publicDocument(document);
  }

  async ingest(
    receiptId: string,
    staged: StagedMultipartDocument,
    replace: boolean,
  ): Promise<ReceiptDocumentResponse> {
    await this.requireReceipt(receiptId);
    let mediaType: "image/jpeg" | "image/png" | "application/pdf";
    try {
      mediaType = await validateStagedDocument(
        this.storage,
        staged.relativePath,
        staged.byteSize,
        this.validationLimits,
      );
    } catch (error) {
      if (error instanceof UnsupportedDocumentError)
        throw new DocumentRequestError(
          "unsupported_document",
          "Only JPEG, PNG, and PDF documents are supported",
        );
      if (
        error instanceof MalformedDocumentError ||
        error instanceof DocumentValidationTimeoutError
      )
        throw new DocumentRequestError(
          "malformed_document",
          "Document failed structural validation",
        );
      throw error;
    }

    const duplicate = await this.duplicate(staged.sha256, staged.byteSize);
    if (duplicate)
      throw new DuplicateDocumentError(duplicate.receiptId, duplicate.id);
    const current = await this.stored(receiptId);
    if (current && !replace)
      throw new ConflictError("Receipt already has a document");
    const originalFilename = sanitizeOriginalFilename(staged.filename);

    if (current) {
      return this.replace(current, staged, originalFilename, mediaType);
    }
    try {
      const created = await persistOriginalDocument(
        this.database,
        this.storage,
        {
          receiptId,
          stagedRelativePath: staged.relativePath,
          originalFilename,
          mediaType,
          byteSize: staged.byteSize,
          sha256: staged.sha256,
        },
        {
          onCleanupFailure: (relativePath) =>
            this.recordFailedCleanup(relativePath),
          insideTransaction: async (transaction, documentId) => {
            await transaction.normalizationJob.create({
              data: {
                documentId,
                profileVersion: NORMALIZATION_PROFILE_VERSION,
              },
            });
          },
        },
      );
      const document = await this.stored(receiptId);
      if (!document || document.id !== created.id)
        throw new Error("Created receipt document is missing");
      return publicDocument(document);
    } catch (error) {
      if (prismaErrorCode(error) === "P2002") {
        const racedDuplicate = await this.duplicate(
          staged.sha256,
          staged.byteSize,
        );
        if (racedDuplicate)
          throw new DuplicateDocumentError(
            racedDuplicate.receiptId,
            racedDuplicate.id,
          );
        throw new ConflictError("Receipt already has a document");
      }
      throw error;
    }
  }

  private async replace(
    current: StoredDocument,
    staged: StagedMultipartDocument,
    originalFilename: string | null,
    mediaType: "image/jpeg" | "image/png" | "application/pdf",
  ): Promise<ReceiptDocumentResponse> {
    const target = replacementOriginalDocumentPath(
      current.id,
      documentExtension(mediaType),
    );
    await this.database.documentFileCleanup.create({
      data: { relativePath: target },
    });
    try {
      await this.storage.promote(staged.relativePath, target);
      const updated = await this.database.$transaction(async (transaction) => {
        const result = await transaction.receiptDocument.updateMany({
          where: { id: current.id, updatedAt: current.updatedAt },
          data: {
            relativePath: target,
            originalFilename,
            mediaType,
            byteSize: staged.byteSize,
            sha256: staged.sha256,
            normalizationStatus: "pending",
            normalizationError: null,
            normalizationProfileVersion: null,
            normalizationRenderer: null,
            normalizationRequestedAt: new Date(),
            normalizationStartedAt: null,
            normalizationCompletedAt: null,
          },
        });
        if (result.count !== 1)
          throw new ConflictError(
            "Receipt document changed during replacement",
          );
        for (const relativePath of [
          current.relativePath,
          ...current.pages.map((page) => page.relativePath),
        ])
          await transaction.documentFileCleanup.upsert({
            where: { relativePath },
            create: { relativePath },
            update: {},
          });
        await transaction.receiptPage.deleteMany({
          where: { documentId: current.id },
        });
        await transaction.normalizationJob.upsert({
          where: { documentId: current.id },
          create: {
            documentId: current.id,
            profileVersion: NORMALIZATION_PROFILE_VERSION,
          },
          update: {
            status: "pending",
            profileVersion: NORMALIZATION_PROFILE_VERSION,
            availableAt: new Date(),
            claimedAt: null,
            lastError: null,
          },
        });
        await transaction.documentFileCleanup.delete({
          where: { relativePath: target },
        });
        return transaction.receiptDocument.findUniqueOrThrow({
          where: { id: current.id },
          include: { pages: { orderBy: { pageNumber: "asc" } } },
        });
      });
      await Promise.all(
        [
          current.relativePath,
          ...current.pages.map((page) => page.relativePath),
        ].map((path) => this.cleanupRecordedPath(path)),
      );
      return publicDocument(updated);
    } catch (error) {
      try {
        await this.storage.cleanup(target);
        await this.database.documentFileCleanup.deleteMany({
          where: { relativePath: target },
        });
      } catch {
        await this.recordFailedCleanup(target);
      }
      if (prismaErrorCode(error) === "P2002") {
        const duplicate = await this.duplicate(staged.sha256, staged.byteSize);
        if (duplicate)
          throw new DuplicateDocumentError(duplicate.receiptId, duplicate.id);
      }
      throw error;
    }
  }

  async remove(receiptId: string): Promise<void> {
    await this.requireReceipt(receiptId);
    const document = await this.database.receiptDocument.findUnique({
      where: { receiptId },
      include: { pages: { select: { relativePath: true } } },
    });
    if (!document) throw new NotFoundError("Receipt document not found");
    const paths = [
      document.relativePath,
      ...document.pages.map((p) => p.relativePath),
    ];
    await this.database.$transaction(async (transaction) => {
      for (const relativePath of paths)
        await transaction.documentFileCleanup.upsert({
          where: { relativePath },
          create: { relativePath },
          update: {},
        });
      await transaction.receiptPage.deleteMany({
        where: { documentId: document.id },
      });
      await transaction.normalizationJob.deleteMany({
        where: { documentId: document.id },
      });
      await transaction.receiptDocument.delete({ where: { id: document.id } });
    });
    await Promise.all(paths.map((path) => this.cleanupRecordedPath(path)));
  }

  async retry(receiptId: string): Promise<ReceiptDocumentResponse> {
    await this.requireReceipt(receiptId);
    const document = await this.stored(receiptId);
    if (!document) throw new NotFoundError("Receipt document not found");
    await this.database.$transaction(async (transaction) => {
      await transaction.normalizationJob.upsert({
        where: { documentId: document.id },
        create: {
          documentId: document.id,
          profileVersion: NORMALIZATION_PROFILE_VERSION,
        },
        update: {
          status: "pending",
          profileVersion: NORMALIZATION_PROFILE_VERSION,
          availableAt: new Date(),
          claimedAt: null,
          lastError: null,
        },
      });
      await transaction.receiptDocument.update({
        where: { id: document.id },
        data: {
          normalizationStatus: "pending",
          normalizationError: null,
          normalizationRequestedAt: new Date(),
          normalizationStartedAt: null,
          normalizationCompletedAt: null,
        },
      });
    });
    return this.get(receiptId);
  }

  async page(
    receiptId: string,
    documentId: string,
    pageId: string,
  ): Promise<{ stream: ReadStream; byteSize: number; mediaType: string }> {
    const page = await this.database.receiptPage.findFirst({
      where: { id: pageId, documentId, document: { receiptId } },
    });
    if (!page) throw new NotFoundError("Receipt page not found");
    if (!(await this.storage.exists(page.relativePath)))
      throw new Error("Stored receipt page is missing");
    return {
      stream: this.storage.createReadStream(page.relativePath),
      byteSize: page.byteSize,
      mediaType: page.mediaType,
    };
  }

  async original(
    receiptId: string,
    documentId: string,
  ): Promise<{
    stream: ReadStream;
    mediaType: string;
    byteSize: number;
    filename: string;
  }> {
    const document = await this.database.receiptDocument.findFirst({
      where: { id: documentId, receiptId },
    });
    if (!document) throw new NotFoundError("Receipt document not found");
    if (!(await this.storage.exists(document.relativePath)))
      throw new Error("Stored receipt document is missing");
    return {
      stream: this.storage.createReadStream(document.relativePath),
      mediaType: document.mediaType,
      byteSize: document.byteSize,
      filename:
        document.originalFilename ??
        `receipt.${documentExtension(document.mediaType)}`,
    };
  }
}
