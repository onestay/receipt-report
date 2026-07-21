import type { ReadStream } from "node:fs";
import {
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
    originalUrl: `/api/v1/receipts/${document.receiptId}/documents/${document.id}/original`,
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
    return this.database.receiptDocument.findUnique({ where: { receiptId } });
  }

  private async requireReceipt(receiptId: string): Promise<void> {
    if (!(await this.database.receipt.findUnique({ where: { id: receiptId } })))
      throw new NotFoundError("Receipt not found");
  }

  private async duplicate(
    sha256: string,
    byteSize: number,
  ): Promise<StoredDocument | null> {
    return this.database.receiptDocument.findUnique({
      where: { sha256_byteSize: { sha256, byteSize } },
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
        },
      );
      const document = await this.database.receiptDocument.findUniqueOrThrow({
        where: { id: created.id },
      });
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
    await this.storage.promote(staged.relativePath, target);
    try {
      const updated = await this.database.$transaction(async (transaction) => {
        const result = await transaction.receiptDocument.updateMany({
          where: { id: current.id, updatedAt: current.updatedAt },
          data: {
            relativePath: target,
            originalFilename,
            mediaType,
            byteSize: staged.byteSize,
            sha256: staged.sha256,
          },
        });
        if (result.count !== 1)
          throw new ConflictError(
            "Receipt document changed during replacement",
          );
        await transaction.documentFileCleanup.create({
          data: { relativePath: current.relativePath },
        });
        return transaction.receiptDocument.findUniqueOrThrow({
          where: { id: current.id },
        });
      });
      await this.cleanupRecordedPath(current.relativePath);
      return publicDocument(updated);
    } catch (error) {
      try {
        await this.storage.cleanup(target);
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
      await transaction.receiptDocument.delete({ where: { id: document.id } });
    });
    await Promise.all(paths.map((path) => this.cleanupRecordedPath(path)));
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
