import { createHash, randomUUID } from "node:crypto";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import type { WorkerConfig } from "@receipt-report/config";
import {
  FilesystemDocumentStorage,
  DocumentStorageLimitError,
  persistOriginalDocument,
  type Database,
} from "@receipt-report/database";
import {
  NORMALIZATION_PROFILE_VERSION,
  UPLOAD_PLACEHOLDER_RECEIPT,
} from "@receipt-report/contracts";
import {
  sanitizeOriginalFilename,
  validateStagedDocument,
  UnsupportedDocumentError,
  MalformedDocumentError,
  DocumentValidationTimeoutError,
} from "@receipt-report/api/document-validation";
import type { Logger } from "@receipt-report/logging";

const TERMINAL = new Set(["imported", "duplicate", "failed"]);

export type EligiblePart = {
  partId: string;
  ordinal: number;
  filename: string | null;
  declaredSize: number;
};

function comparePartIds(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

/**
 * An explicit attachment that carries the part id and declared size the rest of
 * the import needs. Narrowing here keeps those two fields non-optional
 * downstream instead of repeating fallbacks that the filter already excludes.
 */
type BoundedAttachment = MessageStructureObject & {
  part: string;
  size: number;
};

function isBoundedAttachment(
  node: MessageStructureObject,
  maxBytes: number,
): node is BoundedAttachment {
  const size = node.size ?? 0;
  return (
    node.disposition?.toLowerCase() === "attachment" &&
    !!node.part &&
    node.type.toLowerCase() !== "message/rfc822" &&
    size > 0 &&
    size <= maxBytes
  );
}

export function selectAttachmentParts(
  structure: MessageStructureObject,
  maxBytes: number,
): EligiblePart[] {
  const nodes: MessageStructureObject[] = [];
  const visit = (node: MessageStructureObject) => {
    if (node.childNodes) for (const child of node.childNodes) visit(child);
    else nodes.push(node);
  };
  visit(structure);
  return nodes
    .filter((node): node is BoundedAttachment =>
      isBoundedAttachment(node, maxBytes),
    )
    .sort((left, right) => comparePartIds(left.part, right.part))
    .map((node, ordinal) => ({
      partId: node.part,
      ordinal,
      filename: sanitizeOriginalFilename(
        node.dispositionParameters?.filename ?? node.parameters?.name,
      ),
      declaredSize: node.size,
    }));
}

export function opaqueMailboxIdentity(values: string[]): string {
  return createHash("sha256").update(values.join("\0")).digest("hex");
}

export function retryDelay(
  attempt: number,
  base: number,
  maximum: number,
): number {
  return Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
}

export class EmailImporter {
  private lastPollAt = 0;

  constructor(
    private readonly database: Database,
    private readonly storage: FilesystemDocumentStorage,
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
  ) {}

  due(now = Date.now()): boolean {
    return (
      this.config.EMAIL_IMPORT_ENABLED &&
      now - this.lastPollAt >= this.config.EMAIL_IMPORT_POLL_MS
    );
  }

  private async recordFailedCleanup(relativePath: string): Promise<void> {
    await this.database.documentFileCleanup.upsert({
      where: { relativePath },
      create: { relativePath, attempts: 1, lastError: "cleanup_failed" },
      update: { attempts: { increment: 1 }, lastError: "cleanup_failed" },
    });
  }

  async poll(): Promise<boolean> {
    if (!this.config.EMAIL_IMPORT_ENABLED) return false;
    const host = this.config.EMAIL_IMPORT_HOST;
    const username = this.config.EMAIL_IMPORT_USERNAME;
    const password = this.config.EMAIL_IMPORT_PASSWORD;
    if (!host || !username || !password) {
      throw new Error("Email import configuration was not validated");
    }
    this.lastPollAt = Date.now();
    const client = new ImapFlow({
      host,
      port: this.config.EMAIL_IMPORT_PORT,
      secure: true,
      doSTARTTLS: true,
      tls: { rejectUnauthorized: true },
      auth: {
        user: username,
        pass: password,
      },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: this.config.EMAIL_IMPORT_COMMAND_TIMEOUT_MS,
      greetingTimeout: this.config.EMAIL_IMPORT_COMMAND_TIMEOUT_MS,
      socketTimeout: this.config.EMAIL_IMPORT_COMMAND_TIMEOUT_MS,
    });
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen(
        this.config.EMAIL_IMPORT_FOLDER,
        { readOnly: true },
      );
      const accountKey = opaqueMailboxIdentity([
        host,
        String(this.config.EMAIL_IMPORT_PORT),
        username,
      ]);
      const mailboxKey = opaqueMailboxIdentity([
        this.config.EMAIL_IMPORT_FOLDER,
      ]);
      const cursor = await this.database.emailImportCursor.upsert({
        where: {
          accountKey_mailboxKey_uidValidity: {
            accountKey,
            mailboxKey,
            uidValidity: mailbox.uidValidity.toString(),
          },
        },
        create: {
          accountKey,
          mailboxKey,
          uidValidity: mailbox.uidValidity.toString(),
        },
        update: {},
      });
      const uids =
        (await client.search(
          { uid: `${cursor.lastUid + 1}:*` },
          { uid: true },
        )) || [];
      let attachmentBudget = this.config.EMAIL_IMPORT_MAX_ATTACHMENTS;
      for (const uid of uids.slice(0, this.config.EMAIL_IMPORT_MAX_MESSAGES)) {
        const message = await this.database.emailMessageImport.upsert({
          where: { cursorId_uid: { cursorId: cursor.id, uid } },
          create: { cursorId: cursor.id, uid },
          update: {},
        });
        const fetched = await client.fetchOne(
          uid,
          { bodyStructure: true },
          { uid: true },
        );
        if (!fetched || !fetched.bodyStructure) {
          await this.database.emailMessageImport.update({
            where: { id: message.id },
            data: { status: "failed", failureCode: "message_missing" },
          });
          await this.advance(cursor.id, uid);
          continue;
        }
        const parts = selectAttachmentParts(
          fetched.bodyStructure,
          this.config.DOCUMENT_MAX_BYTES,
        );
        let completedAllParts = true;
        for (const part of parts) {
          const outcome = await this.processPart(
            client,
            uid,
            message.id,
            part,
            attachmentBudget > 0,
          );
          if (outcome === "processed") attachmentBudget -= 1;
          if (outcome === "deferred") {
            completedAllParts = false;
            break;
          }
        }
        if (!completedAllParts) break;
        await this.database.emailMessageImport.update({
          where: { id: message.id },
          data: { status: "complete" },
        });
        await this.advance(cursor.id, uid);
        if (attachmentBudget === 0) break;
      }
      await this.database.emailImportCursor.update({
        where: { id: cursor.id },
        data: { lastSuccessfulPollAt: new Date() },
      });
      await this.database.emailImporterHealth.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          enabled: true,
          lastSuccessfulPollAt: new Date(),
        },
        update: { enabled: true, lastSuccessfulPollAt: new Date() },
      });
      this.logger.info(
        { event: "email_import.poll.succeeded" },
        "Email import poll succeeded",
      );
      return true;
    } catch {
      this.logger.warn(
        { event: "email_import.poll.failed", failure_code: "imap_unavailable" },
        "Email import poll failed",
      );
      return false;
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private async advance(cursorId: string, uid: number): Promise<void> {
    await this.database.emailImportCursor.updateMany({
      where: { id: cursorId, lastUid: { lt: uid } },
      data: { lastUid: uid },
    });
  }

  private async processPart(
    client: ImapFlow,
    uid: number,
    messageId: string,
    part: EligiblePart,
    allowClaim: boolean,
  ): Promise<"already_terminal" | "deferred" | "processed"> {
    const row = await this.database.emailAttachmentImport.upsert({
      where: { messageId_partId: { messageId, partId: part.partId } },
      create: {
        messageId,
        partId: part.partId,
        ordinal: part.ordinal,
        originalFilename: part.filename,
      },
      update: {},
    });
    if (TERMINAL.has(row.status)) return "already_terminal";
    if (!allowClaim) return "deferred";
    const now = new Date();
    const token = randomUUID();
    const claimed = await this.database.emailAttachmentImport.updateMany({
      where: {
        id: row.id,
        OR: [
          {
            status: { in: ["pending", "retry_wait"] },
            availableAt: { lte: now },
          },
          { status: "running", leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: "running",
        claimToken: token,
        claimedAt: now,
        leaseExpiresAt: new Date(
          now.getTime() + this.config.EMAIL_IMPORT_LEASE_MS,
        ),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return "deferred";
    let stagedPath: string | undefined;
    try {
      const download = await client.download(String(uid), part.partId, {
        uid: true,
      });
      const staged = await this.storage.stageStream(
        download.content,
        this.config.DOCUMENT_MAX_BYTES,
        (relativePath) => this.recordFailedCleanup(relativePath),
        "worker",
      );
      stagedPath = staged.relativePath;
      const mediaType = await validateStagedDocument(
        this.storage,
        staged.relativePath,
        staged.byteSize,
        {
          maxPdfPages: this.config.DOCUMENT_MAX_PDF_PAGES,
          maxImageWidth: this.config.DOCUMENT_MAX_IMAGE_WIDTH,
          maxImageHeight: this.config.DOCUMENT_MAX_IMAGE_HEIGHT,
          maxDecodedPixels: this.config.DOCUMENT_MAX_DECODED_PIXELS,
          timeoutMs: this.config.DOCUMENT_VALIDATION_TIMEOUT_MS,
        },
      );
      const duplicate = await this.database.receiptDocument.findUnique({
        where: {
          sha256_byteSize: { sha256: staged.sha256, byteSize: staged.byteSize },
        },
        select: { id: true, receiptId: true },
      });
      if (duplicate) {
        await this.storage.cleanup(staged.relativePath);
        stagedPath = undefined;
        await this.database.emailAttachmentImport.updateMany({
          where: { id: row.id, claimToken: token },
          data: {
            status: "duplicate",
            claimToken: null,
            leaseExpiresAt: null,
            sha256: staged.sha256,
            byteSize: staged.byteSize,
            receiptId: duplicate.receiptId,
            documentId: duplicate.id,
          },
        });
        return "processed";
      }
      const today = new Date().toISOString().slice(0, 10);
      await persistOriginalDocument(
        this.database,
        this.storage,
        {
          stagedRelativePath: staged.relativePath,
          originalFilename: part.filename,
          mediaType,
          byteSize: staged.byteSize,
          sha256: staged.sha256,
        },
        {
          onCleanupFailure: (relativePath) =>
            this.recordFailedCleanup(relativePath),
          beforeDocument: async (transaction) => {
            const receipt = await transaction.receipt.create({
              data: {
                merchantRaw: UPLOAD_PLACEHOLDER_RECEIPT.merchantRaw,
                purchaseDate: today,
                currency: UPLOAD_PLACEHOLDER_RECEIPT.currency,
                totalCents: UPLOAD_PLACEHOLDER_RECEIPT.totalCents,
              },
              select: { id: true },
            });
            return receipt.id;
          },
          insideTransaction: async (transaction, documentId) => {
            const document =
              await transaction.receiptDocument.findUniqueOrThrow({
                where: { id: documentId },
                select: { receiptId: true },
              });
            await transaction.normalizationJob.create({
              data: {
                documentId,
                profileVersion: NORMALIZATION_PROFILE_VERSION,
              },
            });
            const updated = await transaction.emailAttachmentImport.updateMany({
              where: { id: row.id, claimToken: token },
              data: {
                status: "imported",
                claimToken: null,
                leaseExpiresAt: null,
                sha256: staged.sha256,
                byteSize: staged.byteSize,
                receiptId: document.receiptId,
                documentId,
              },
            });
            if (updated.count !== 1)
              throw new Error("Email import claim expired");
          },
        },
      );
      stagedPath = undefined;
    } catch (error) {
      if (stagedPath) {
        try {
          await this.storage.cleanup(stagedPath);
        } catch {
          await this.recordFailedCleanup(stagedPath);
        }
      }
      const terminal =
        error instanceof DocumentStorageLimitError ||
        error instanceof UnsupportedDocumentError ||
        error instanceof MalformedDocumentError ||
        error instanceof DocumentValidationTimeoutError;
      const current = await this.database.emailAttachmentImport.findUnique({
        where: { id: row.id },
      });
      if (current?.status === "imported") return "processed";
      const attempts = current?.attempts ?? 1;
      const exhausted = attempts >= this.config.EMAIL_IMPORT_MAX_ATTEMPTS;
      await this.database.emailAttachmentImport.updateMany({
        where: { id: row.id, claimToken: token },
        data:
          terminal || exhausted
            ? {
                status: "failed",
                failureCode: terminal ? "invalid_document" : "download_failed",
                claimToken: null,
                leaseExpiresAt: null,
              }
            : {
                status: "retry_wait",
                failureCode: "download_failed",
                claimToken: null,
                leaseExpiresAt: null,
                availableAt: new Date(
                  Date.now() +
                    retryDelay(
                      attempts,
                      this.config.EMAIL_IMPORT_RETRY_BASE_MS,
                      this.config.EMAIL_IMPORT_RETRY_MAX_MS,
                    ),
                ),
              },
      });
    }
    return "processed";
  }
}
