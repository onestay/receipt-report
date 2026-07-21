import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";
import {
  apiErrorSchema,
  documentUploadConfigurationSchema,
  duplicateDocumentDetailsSchema,
  receiptDocumentResponseSchema,
  type DocumentUploadConfiguration,
  type ReceiptDocumentResponse,
} from "@receipt-report/contracts";

const acceptedTypes = ["image/jpeg", "image/png", "application/pdf"];

export class DocumentUploadError extends Error {
  constructor(
    readonly code:
      | "unsupported_document"
      | "document_too_large"
      | "malformed_document"
      | "duplicate_document"
      | "multipart_error"
      | "conflict"
      | "network_error"
      | "server_error"
      | "remove_error"
      | "cancelled",
    readonly duplicateReceiptId?: string,
  ) {
    super(code);
  }
}

function failureMessage(error: unknown): string {
  if (!(error instanceof DocumentUploadError))
    return "The document could not be uploaded. The receipt is unchanged; try again.";
  switch (error.code) {
    case "unsupported_document":
      return "Choose a JPEG, PNG, or PDF file.";
    case "document_too_large":
      return "This file is larger than the configured upload limit. Choose a smaller file.";
    case "malformed_document":
      return "This file is malformed or unsafe to process. Export a fresh copy and try again.";
    case "duplicate_document":
      return "This exact document is already attached to another receipt.";
    case "multipart_error":
      return "The upload could not be read. Choose the file again and retry.";
    case "conflict":
      return "The receipt document changed while this request was running. Reload and try again.";
    case "network_error":
      return "The local API could not be reached. Your receipt edits and selected file are still here.";
    case "cancelled":
      return "Upload cancelled. The selected file is still ready to retry.";
    case "remove_error":
      return "The document could not be removed. It is still attached; try again.";
    default:
      return "The server could not store the document. Nothing was attached; try again.";
  }
}

async function parseFailure(response: Response): Promise<DocumentUploadError> {
  const parsed = apiErrorSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return new DocumentUploadError("server_error");
  const code = parsed.data.error.code;
  if (code === "duplicate_document") {
    const details = duplicateDocumentDetailsSchema.safeParse(
      parsed.data.error.details,
    );
    return new DocumentUploadError(
      "duplicate_document",
      details.success ? details.data.receiptId : undefined,
    );
  }
  if (
    code === "unsupported_document" ||
    code === "document_too_large" ||
    code === "malformed_document" ||
    code === "multipart_error" ||
    code === "conflict"
  )
    return new DocumentUploadError(code);
  return new DocumentUploadError("server_error");
}

export async function uploadReceiptDocument(
  receiptId: string,
  file: File,
  replace: boolean,
  signal: AbortSignal,
): Promise<ReceiptDocumentResponse> {
  const form = new FormData();
  form.append("document", file, file.name);
  let response: Response;
  try {
    response = await fetch(`/api/v1/receipts/${receiptId}/document`, {
      method: replace ? "PUT" : "POST",
      body: form,
      signal,
    });
  } catch {
    if (signal.aborted) throw new DocumentUploadError("cancelled");
    throw new DocumentUploadError("network_error");
  }
  if (!response.ok) throw await parseFailure(response);
  return receiptDocumentResponseSchema.parse(await response.json());
}

function formatLimit(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function useUploadConfiguration() {
  const [configuration, setConfiguration] =
    useState<DocumentUploadConfiguration>();
  useEffect(() => {
    let active = true;
    void Promise.resolve(fetch("/api/v1/document-upload-configuration"))
      .then(async (response) => {
        if (!response.ok) throw new Error("configuration");
        return documentUploadConfigurationSchema.parse(await response.json());
      })
      .then((value) => {
        if (active) setConfiguration(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return configuration;
}

export function DocumentFileField({
  id,
  file,
  disabled = false,
  inputRef,
  onFile,
  onError,
}: {
  id: string;
  file: File | null;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onFile: (file: File | null) => void;
  onError: (message: string) => void;
}) {
  const configuration = useUploadConfiguration();
  const [dragging, setDragging] = useState(false);
  const choose = (next: File | undefined) => {
    if (!next) return;
    if (!acceptedTypes.includes(next.type)) {
      onError("Choose a JPEG, PNG, or PDF file.");
      onFile(null);
      return;
    }
    if (configuration && next.size > configuration.maxBytes) {
      onError(
        `This file exceeds the configured ${formatLimit(configuration.maxBytes)} limit.`,
      );
      onFile(null);
      return;
    }
    onError("");
    onFile(next);
  };
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) choose(event.dataTransfer.files[0]);
  };
  return (
    <div className="document-picker">
      <label
        className={`document-drop ${dragging ? "document-drop--active" : ""}`}
        htmlFor={id}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <strong>
          {file ? file.name : "Choose or drop a receipt document"}
        </strong>
        <span>
          JPEG, PNG, or PDF
          {configuration
            ? ` · up to ${formatLimit(configuration.maxBytes)}`
            : ""}
        </span>
        {file && <small>{formatSize(file.size)}</small>}
      </label>
      <input
        ref={inputRef}
        className="visually-hidden"
        id={id}
        type="file"
        accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf"
        disabled={disabled}
        onChange={(event) => choose(event.target.files?.[0])}
      />
      {file && !disabled && (
        <button
          type="button"
          className="document-clear"
          onClick={() => onFile(null)}
        >
          Clear selected file
        </button>
      )}
    </div>
  );
}

function normalizationCopy(document: ReceiptDocumentResponse): string {
  switch (document.normalizationStatus) {
    case "pending":
      return "Queued for page preparation.";
    case "running":
      return "Preparing ordered page images…";
    case "complete":
      return `${document.pages.length} ${document.pages.length === 1 ? "page" : "pages"} ready for review.`;
    case "failed":
      return "Page preparation failed. The original is safe and can be retried.";
  }
}

export function DocumentPanel({ receiptId }: { receiptId: string }) {
  const [document, setDocument] = useState<ReceiptDocumentResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"upload" | "retry" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [duplicateReceiptId, setDuplicateReceiptId] = useState<string>();
  const [confirming, setConfirming] = useState<"replace" | "remove" | null>(
    null,
  );
  const [imageStates, setImageStates] = useState<
    Record<string, "loaded" | "error">
  >({});
  const [pollAttempt, setPollAttempt] = useState(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<(HTMLElement | null)[]>([]);
  const errorRef = useRef<HTMLDivElement>(null);

  const reportActionError = (message: string) => {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  };

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const response = await fetch(`/api/v1/receipts/${receiptId}/document`);
        if (response.status === 404) {
          setDocument(null);
          return;
        }
        if (!response.ok) throw new Error("document");
        setDocument(receiptDocumentResponseSchema.parse(await response.json()));
      } catch {
        if (!quiet)
          setError("Document details could not be loaded. Try again.");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [receiptId],
  );

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (
      !document ||
      (document.normalizationStatus !== "pending" &&
        document.normalizationStatus !== "running")
    )
      return;
    let active = true;
    const timer = window.setTimeout(
      () =>
        void load(true).finally(() => {
          if (active) setPollAttempt((attempt) => attempt + 1);
        }),
      600,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [document, load, pollAttempt]);

  const upload = async (replace: boolean) => {
    if (!file || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("upload");
    setError("");
    setDuplicateReceiptId(undefined);
    try {
      setDocument(
        await uploadReceiptDocument(
          receiptId,
          file,
          replace,
          controller.signal,
        ),
      );
      setFile(null);
      setConfirming(null);
    } catch (caught) {
      reportActionError(failureMessage(caught));
      if (caught instanceof DocumentUploadError)
        setDuplicateReceiptId(caught.duplicateReceiptId);
    } finally {
      abortRef.current = undefined;
      setBusy(null);
    }
  };

  const retry = async () => {
    if (busy) return;
    setBusy("retry");
    setError("");
    setDuplicateReceiptId(undefined);
    try {
      const response = await fetch(
        `/api/v1/receipts/${receiptId}/document/normalization`,
        { method: "POST" },
      );
      if (!response.ok) throw await parseFailure(response);
      setDocument(receiptDocumentResponseSchema.parse(await response.json()));
    } catch (caught) {
      reportActionError(failureMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove");
    setError("");
    setDuplicateReceiptId(undefined);
    try {
      const response = await fetch(`/api/v1/receipts/${receiptId}/document`, {
        method: "DELETE",
      });
      if (!response.ok) throw new DocumentUploadError("remove_error");
      setDocument(null);
      setConfirming(null);
      setFile(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (caught) {
      reportActionError(failureMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const orderedPages = [...(document?.pages ?? [])].sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );
  return (
    <section className="document-panel" aria-labelledby="document-heading">
      <div className="section-heading">
        <h2 id="document-heading">Receipt document</h2>
        {document && <span>{formatSize(document.byteSize)}</span>}
      </div>
      {error && (
        <div
          ref={errorRef}
          className="banner banner--error"
          role="alert"
          tabIndex={-1}
        >
          {error}{" "}
          {duplicateReceiptId && (
            <a href={`/receipts/${duplicateReceiptId}`}>
              Open the existing receipt
            </a>
          )}
        </div>
      )}
      {loading ? (
        <div className="panel state" role="status">
          Loading document…
        </div>
      ) : (
        <>
          <div className="panel document-controls">
            {document && (
              <div className="document-metadata">
                <div>
                  <strong>
                    {document.originalFilename ?? "Receipt document"}
                  </strong>
                  <span>
                    {document.mediaType} · {formatSize(document.byteSize)}
                  </span>
                </div>
                <div className="document-links">
                  <a
                    className="button button--small button--quiet"
                    href={document.originalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open original
                  </a>
                  <a
                    className="button button--small button--quiet"
                    href={document.originalUrl}
                    download={document.originalFilename ?? "receipt-document"}
                  >
                    Download
                  </a>
                </div>
              </div>
            )}
            <DocumentFileField
              id={`document-file-${receiptId}`}
              file={file}
              disabled={busy !== null}
              inputRef={inputRef}
              onFile={setFile}
              onError={setError}
            />
            <div className="document-actions">
              {file && !document && (
                <button
                  className="button"
                  disabled={!!busy}
                  aria-busy={busy === "upload"}
                  onClick={() => void upload(false)}
                >
                  {busy === "upload" ? "Uploading…" : "Attach document"}
                </button>
              )}
              {file && document && (
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() => setConfirming("replace")}
                >
                  Replace document
                </button>
              )}
              {document && (
                <button
                  className="button button--quiet danger"
                  disabled={!!busy}
                  onClick={() => setConfirming("remove")}
                >
                  Remove document
                </button>
              )}
              {busy === "upload" && (
                <button
                  className="button button--quiet"
                  onClick={() => abortRef.current?.abort()}
                >
                  Cancel upload
                </button>
              )}
            </div>
            {busy === "upload" && <progress aria-label="Uploading document" />}
            {confirming && (
              <div
                className="inline-confirmation"
                role="alertdialog"
                aria-labelledby="document-confirm-title"
              >
                <strong id="document-confirm-title">
                  {confirming === "replace"
                    ? "Replace this document?"
                    : "Remove this document?"}
                </strong>
                <p>
                  {confirming === "replace"
                    ? "The current page images will be cleared and rebuilt from the new original."
                    : "The retained original and all prepared pages will be removed."}
                </p>
                <button
                  className="button button--small"
                  disabled={!!busy}
                  onClick={() =>
                    void (confirming === "replace" ? upload(true) : remove())
                  }
                >
                  Confirm {confirming}
                </button>
                <button
                  className="button button--small button--quiet"
                  disabled={!!busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {!document && (
            <div className="document-empty">
              <p>No document attached yet.</p>
            </div>
          )}
          {document && (
            <div
              className={`normalization normalization--${document.normalizationStatus}`}
              role="status"
              aria-live="polite"
            >
              <strong>Page preparation: {document.normalizationStatus}</strong>
              <span>{normalizationCopy(document)}</span>
              {document.normalizationStatus === "failed" && (
                <button
                  className="button button--small"
                  disabled={!!busy}
                  aria-busy={busy === "retry"}
                  onClick={() => void retry()}
                >
                  {busy === "retry" ? "Retrying…" : "Retry page preparation"}
                </button>
              )}
            </div>
          )}
          {document?.normalizationStatus === "complete" &&
            orderedPages.length === 0 && (
              <div className="panel state" role="status">
                No prepared pages were returned.
              </div>
            )}
          {orderedPages.length > 0 && (
            <div className="page-gallery" aria-label="Prepared receipt pages">
              {orderedPages.map((page, index) => (
                <figure
                  key={page.id}
                  ref={(node) => {
                    pageRefs.current[index] = node;
                  }}
                  tabIndex={0}
                  aria-label={`Page ${page.pageNumber} of ${page.totalPages}`}
                  onKeyDown={(event) => {
                    const target =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? index + 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? index - 1
                          : index;
                    if (target !== index && pageRefs.current[target]) {
                      event.preventDefault();
                      pageRefs.current[target]?.focus();
                    }
                  }}
                >
                  <figcaption>
                    Page {page.pageNumber} of {page.totalPages}
                  </figcaption>
                  {!imageStates[page.id] && (
                    <span className="page-loading" role="status">
                      Loading page…
                    </span>
                  )}
                  {imageStates[page.id] === "error" ? (
                    <div className="page-error" role="alert">
                      Page image could not be loaded.
                    </div>
                  ) : (
                    <img
                      src={page.imageUrl}
                      alt={`Normalized receipt page ${page.pageNumber} of ${page.totalPages}`}
                      onLoad={() =>
                        setImageStates((current) => ({
                          ...current,
                          [page.id]: "loaded",
                        }))
                      }
                      onError={() =>
                        setImageStates((current) => ({
                          ...current,
                          [page.id]: "error",
                        }))
                      }
                    />
                  )}
                </figure>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export { failureMessage };
