import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { PrismaClient } from "@prisma/client";

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

export function normalizedPagePath(
  documentId: string,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1)
    throw new Error("Invalid page number");
  return `pages/${safeSegment(documentId)}/page-${String(pageNumber).padStart(4, "0")}.png`;
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
    await mkdir(this.path("staging"), { recursive: true, mode: 0o700 });
  }

  async stage(bytes: Uint8Array): Promise<string> {
    await this.initialize();
    const relativePath = `staging/${randomUUID()}.tmp`;
    await writeFile(this.path(relativePath), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return relativePath;
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
  hooks: { afterPromote?: (() => Promise<void>) | undefined } = {},
): Promise<{ id: string }> {
  let promotedPath: string | undefined;
  const extension =
    input.mediaType === "application/pdf"
      ? "pdf"
      : input.mediaType === "image/png"
        ? "png"
        : "jpg";
  try {
    return await database.$transaction(async (transaction) => {
      const document = await transaction.receiptDocument.create({
        data: {
          receiptId: input.receiptId,
          relativePath: `pending/${randomUUID()}`,
          originalFilename: input.originalFilename,
          mediaType: input.mediaType,
          byteSize: input.byteSize,
          sha256: input.sha256,
        },
        select: { id: true },
      });
      promotedPath = originalDocumentPath(document.id, extension);
      await storage.promote(input.stagedRelativePath, promotedPath);
      await hooks.afterPromote?.();
      return transaction.receiptDocument.update({
        where: { id: document.id },
        data: { relativePath: promotedPath },
        select: { id: true },
      });
    });
  } catch (error) {
    if (promotedPath) await storage.cleanup(promotedPath);
    throw error;
  }
}
