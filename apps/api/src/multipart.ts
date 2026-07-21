import { Transform } from "node:stream";
import Busboy from "busboy";
import type { Request } from "express";
import {
  DocumentStorageLimitError,
  EmptyDocumentError,
  type FilesystemDocumentStorage,
} from "@receipt-report/database";
import { DocumentRequestError } from "./errors.js";

export type StagedMultipartDocument = {
  relativePath: string;
  byteSize: number;
  sha256: string;
  filename: string | undefined;
};

class RequestSizeLimitError extends Error {}

export async function stageMultipartDocument(
  request: Request,
  storage: FilesystemDocumentStorage,
  limits: { requestBytes: number; fileBytes: number },
  onCleanupFailure?: (relativePath: string) => Promise<void>,
): Promise<StagedMultipartDocument> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limits.requestBytes)
    throw new DocumentRequestError(
      "document_too_large",
      "Document upload is too large",
    );

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fileSize: limits.fileBytes,
        files: 2,
        fields: 1,
        parts: 3,
        headerPairs: 100,
      },
    });
  } catch {
    throw new DocumentRequestError(
      "multipart_error",
      "A multipart document upload is required",
    );
  }

  let bytes = 0;
  let fileCount = 0;
  let invalidPart = false;
  let fileTooLarge = false;
  let filename: string | undefined;
  const staged: Promise<{
    relativePath: string;
    byteSize: number;
    sha256: string;
  }>[] = [];
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(
        bytes > limits.requestBytes ? new RequestSizeLimitError() : undefined,
        bytes > limits.requestBytes ? undefined : chunk,
      );
    },
  });

  parser.on("file", (fieldName, stream, info) => {
    fileCount += 1;
    if (fieldName !== "document" || fileCount > 1) {
      invalidPart = true;
      stream.resume();
      return;
    }
    filename = info.filename || undefined;
    stream.once("limit", () => {
      fileTooLarge = true;
    });
    staged.push(
      storage.stageStream(stream, limits.fileBytes, onCleanupFailure),
    );
  });
  parser.on("field", () => {
    invalidPart = true;
  });
  parser.on("filesLimit", () => {
    invalidPart = true;
  });
  parser.on("fieldsLimit", () => {
    invalidPart = true;
  });
  parser.on("partsLimit", () => {
    invalidPart = true;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      limiter.once("error", fail);
      parser.once("error", fail);
      parser.once("finish", resolve);
      request.pipe(limiter).pipe(parser);
    });
    const [result] = await Promise.all(staged);
    if (fileTooLarge) {
      if (result) await storage.cleanup(result.relativePath);
      throw new DocumentRequestError(
        "document_too_large",
        "Document upload is too large",
      );
    }
    if (fileCount !== 1 || invalidPart || !result) {
      if (result) await storage.cleanup(result.relativePath);
      throw new DocumentRequestError(
        "multipart_error",
        "Upload exactly one document file",
      );
    }
    return { ...result, filename };
  } catch (error) {
    request.unpipe(limiter);
    request.resume();
    parser.destroy();
    const results = await Promise.allSettled(staged);
    await Promise.all(
      results.flatMap((result) =>
        result.status === "fulfilled"
          ? [storage.cleanup(result.value.relativePath)]
          : [],
      ),
    );
    if (
      error instanceof RequestSizeLimitError ||
      error instanceof DocumentStorageLimitError
    )
      throw new DocumentRequestError(
        "document_too_large",
        "Document upload is too large",
      );
    if (error instanceof EmptyDocumentError)
      throw new DocumentRequestError(
        "malformed_document",
        "Document file is empty",
      );
    if (error instanceof DocumentRequestError) throw error;
    throw new DocumentRequestError(
      "multipart_error",
      "Malformed multipart document upload",
    );
  }
}
