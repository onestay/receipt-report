/** Errors that map to a stable public API error code in the app error handler. */

export class InvalidCursorError extends Error {}

export class NotFoundError extends Error {}

/** Normalized-name collision or referentially blocked deletion. */
export class ConflictError extends Error {}

/**
 * A syntactically valid request that references a missing brand/store or an
 * inconsistent brand/store pair. Rejected at the external boundary as a
 * validation failure rather than a server fault.
 */
export class InvalidReferenceError extends Error {}

export class DocumentRequestError extends Error {
  constructor(
    readonly code:
      | "document_too_large"
      | "unsupported_document"
      | "malformed_document"
      | "multipart_error",
    message: string,
  ) {
    super(message);
  }
}

export class DuplicateDocumentError extends Error {
  constructor(
    readonly receiptId: string,
    readonly documentId: string,
  ) {
    super("Document is already attached");
  }
}

/**
 * Reads a Prisma known-request error code structurally. `instanceof` against
 * `PrismaClientKnownRequestError` is unreliable because the generated client
 * and the importing module can resolve separate copies of the runtime library.
 */
export function prismaErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PrismaClientKnownRequestError" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
