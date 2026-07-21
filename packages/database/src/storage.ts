import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid storage path segment");
  return value;
}

export function originalDocumentPath(
  documentId: string,
  extension: string,
): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (!/^(jpe?g|png|pdf)$/.test(normalized))
    throw new Error("Unsupported document extension");
  return `originals/${safeSegment(documentId)}/original.${normalized}`;
}

export function replacementOriginalDocumentPath(
  documentId: string,
  extension: string,
  revision: string = randomUUID(),
): string {
  const base = originalDocumentPath(documentId, extension);
  const dot = base.lastIndexOf(".");
  return `${base.slice(0, dot)}-${safeSegment(revision)}${base.slice(dot)}`;
}

export function normalizedPagePath(
  documentId: string,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1)
    throw new Error("Invalid page number");
  return `pages/${safeSegment(documentId)}/page-${String(pageNumber).padStart(4, "0")}.png`;
}

export function normalizedPageRevisionPath(
  documentId: string,
  revision: string,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1)
    throw new Error("Invalid page number");
  return `pages/${safeSegment(documentId)}/${safeSegment(revision)}/page-${String(pageNumber).padStart(4, "0")}.png`;
}

export class FilesystemDocumentStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(relativePath: string): string {
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.includes("\\")
    )
      throw new Error("Invalid relative storage path");
    const absolute = resolve(this.root, relativePath);
    if (!absolute.startsWith(`${this.root}${sep}`))
      throw new Error("Storage path escapes root");
    return absolute;
  }

  async initialize(): Promise<void> {
    await Promise.all(
      ["api", "worker"].map((namespace) =>
        mkdir(this.path(`staging/${namespace}`), {
          recursive: true,
          mode: 0o700,
        }),
      ),
    );
  }

  async cleanupStaging(namespace = "api"): Promise<void> {
    await rm(this.path(`staging/${safeSegment(namespace)}`), {
      recursive: true,
      force: true,
    });
    await this.initialize();
  }

  async stage(bytes: Uint8Array, namespace = "api"): Promise<string> {
    await this.initialize();
    const relativePath = `staging/${safeSegment(namespace)}/${randomUUID()}.tmp`;
    await writeFile(this.path(relativePath), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return relativePath;
  }

  async stageStream(
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
    onCleanupFailure?: (relativePath: string) => Promise<void>,
  ): Promise<{ relativePath: string; byteSize: number; sha256: string }> {
    await this.initialize();
    const relativePath = `staging/api/${randomUUID()}.tmp`;
    const handle = await open(this.path(relativePath), "wx", 0o600);
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const chunk of source) {
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) throw new DocumentStorageLimitError();
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (byteSize === 0) throw new EmptyDocumentError();
      await handle.sync();
      return { relativePath, byteSize, sha256: hash.digest("hex") };
    } catch (error) {
      await handle.close();
      try {
        await this.cleanup(relativePath);
      } catch (cleanupError) {
        if (!onCleanupFailure) throw cleanupError;
        await onCleanupFailure(relativePath);
      }
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async promote(
    stagedRelativePath: string,
    targetRelativePath: string,
  ): Promise<void> {
    if (!stagedRelativePath.startsWith("staging/"))
      throw new Error("Only staged files can be promoted");
    const target = this.path(targetRelativePath);
    if (await this.exists(targetRelativePath))
      throw new Error("Storage target already exists");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(this.path(stagedRelativePath), target);
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.path(relativePath));
  }

  async readHead(relativePath: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(this.path(relativePath), "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async readAt(
    relativePath: string,
    position: number,
    length: number,
  ): Promise<Buffer> {
    const handle = await open(this.path(relativePath), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  createReadStream(
    relativePath: string,
    options?: { highWaterMark?: number },
  ): ReadStream {
    return createReadStream(this.path(relativePath), options);
  }

  absolutePath(relativePath: string): string {
    return this.path(relativePath);
  }

  async cleanup(relativePath: string): Promise<void> {
    await rm(this.path(relativePath), { force: true });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const handle = await open(this.path(relativePath), "r");
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

export async function retryDocumentFileCleanup(
  database: PrismaClient,
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

export class DocumentStorageLimitError extends Error {}

export class EmptyDocumentError extends Error {}

export type PersistOriginalInput = {
  receiptId: string;
  stagedRelativePath: string;
  originalFilename: string | null;
  mediaType: "image/jpeg" | "image/png" | "application/pdf";
  byteSize: number;
  sha256: string;
};

export async function persistOriginalDocument(
  database: PrismaClient,
  storage: FilesystemDocumentStorage,
  input: PersistOriginalInput,
  hooks: {
    afterPromote?: (() => Promise<void>) | undefined;
    onCleanupFailure?: ((relativePath: string) => Promise<void>) | undefined;
    insideTransaction?:
      | ((
          transaction: Prisma.TransactionClient,
          documentId: string,
        ) => Promise<void>)
      | undefined;
  } = {},
): Promise<{ id: string }> {
  const extension =
    input.mediaType === "application/pdf"
      ? "pdf"
      : input.mediaType === "image/png"
        ? "png"
        : "jpg";
  const promotedPath = originalDocumentPath(randomUUID(), extension);
  await database.documentFileCleanup.create({
    data: { relativePath: promotedPath },
  });
  try {
    await storage.promote(input.stagedRelativePath, promotedPath);
    await hooks.afterPromote?.();
    return await database.$transaction(async (transaction) => {
      const document = await transaction.receiptDocument.create({
        data: {
          receiptId: input.receiptId,
          relativePath: promotedPath,
          originalFilename: input.originalFilename,
          mediaType: input.mediaType,
          byteSize: input.byteSize,
          sha256: input.sha256,
        },
        select: { id: true },
      });
      await hooks.insideTransaction?.(transaction, document.id);
      await transaction.documentFileCleanup.delete({
        where: { relativePath: promotedPath },
      });
      return document;
    });
  } catch (error) {
    try {
      await storage.cleanup(promotedPath);
      await database.documentFileCleanup.deleteMany({
        where: { relativePath: promotedPath },
      });
    } catch (cleanupError) {
      if (!hooks.onCleanupFailure) throw cleanupError;
      await hooks.onCleanupFailure(promotedPath);
    }
    throw error;
  }
}
