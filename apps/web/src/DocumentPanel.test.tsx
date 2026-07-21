// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentFileField,
  DocumentPanel,
  DocumentUploadError,
  failureMessage,
  uploadReceiptDocument,
} from "./DocumentPanel.js";
import type { ReceiptDocumentResponse } from "@receipt-report/contracts";

const receiptId = "cm12345678901234567890123";
const documentId = "cm22345678901234567890123";
const now = "2026-07-21T00:00:00.000Z";
const configuration = {
  maxBytes: 1024 * 1024,
  acceptedMediaTypes: ["image/jpeg", "image/png", "application/pdf"],
};

function response(value: unknown, status = 200) {
  return new Response(
    value === null ? null : JSON.stringify(value),
    value === null
      ? { status }
      : { status, headers: { "content-type": "application/json" } },
  );
}

function page(number: number, total = 2) {
  return {
    id: `cm${number}23456789012345678901234`,
    documentId,
    pageNumber: number,
    totalPages: total,
    mediaType: "image/jpeg" as const,
    byteSize: 2048,
    width: 1200,
    height: 1800,
    sha256: String(number).repeat(64),
    profileVersion: "receipt-page-v1",
    renderer: "sharp-1",
    createdAt: now,
    imageUrl: `/api/v1/receipts/${receiptId}/document/pages/${number}`,
  };
}

function makeDocument(
  status: ReceiptDocumentResponse["normalizationStatus"] = "complete",
  pages = status === "complete" ? [page(2), page(1)] : [],
): ReceiptDocumentResponse {
  return {
    id: documentId,
    receiptId,
    originalFilename: "markt.pdf",
    mediaType: "application/pdf",
    byteSize: 4096,
    sha256: "a".repeat(64),
    createdAt: now,
    updatedAt: now,
    normalizationStatus: status,
    normalizationError: status === "failed" ? "renderer failed" : null,
    normalizationProfileVersion:
      status === "complete" ? "receipt-page-v1" : null,
    normalizationRenderer: status === "complete" ? "pdftoppm-1" : null,
    normalizationRequestedAt: now,
    normalizationStartedAt: status === "pending" ? null : now,
    normalizationCompletedAt: status === "complete" ? now : null,
    originalUrl: `/api/v1/receipts/${receiptId}/document/original`,
    pages,
  };
}

function routeDocument(initial: ReceiptDocumentResponse | null) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/v1/document-upload-configuration")
      return Promise.resolve(response(configuration));
    if (url.endsWith("/document"))
      return Promise.resolve(initial ? response(initial) : response(null, 404));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("document upload helpers", () => {
  it.each([
    ["unsupported_document", "JPEG, PNG, or PDF"],
    ["document_too_large", "configured upload limit"],
    ["malformed_document", "malformed"],
    ["duplicate_document", "another receipt"],
    ["multipart_error", "could not be read"],
    ["conflict", "changed while"],
    ["network_error", "could not be reached"],
    ["cancelled", "cancelled"],
    ["server_error", "could not store"],
  ] as const)("presents a bounded %s message", (code, copy) => {
    expect(failureMessage(new DocumentUploadError(code))).toContain(copy);
  });

  it("uploads with the bounded method and maps duplicate details", async () => {
    const uploaded = makeDocument("pending", []);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(uploaded, 201))
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "duplicate_document",
              message: "duplicate",
              details: { receiptId, documentId },
            },
          },
          409,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["pdf"], "receipt.pdf", {
      type: "application/pdf",
    });

    await expect(
      uploadReceiptDocument(
        receiptId,
        file,
        false,
        new AbortController().signal,
      ),
    ).resolves.toEqual(uploaded);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });

    const duplicate = await uploadReceiptDocument(
      receiptId,
      file,
      true,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(DocumentUploadError);
    expect(duplicate).toMatchObject({
      code: "duplicate_document",
      duplicateReceiptId: receiptId,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
  });

  it("distinguishes server, network, and cancelled failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("bad", 500)));
    await expect(
      uploadReceiptDocument(
        receiptId,
        new File(["x"], "x.png", { type: "image/png" }),
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "server_error" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(
      uploadReceiptDocument(
        receiptId,
        new File(["x"], "x.png", { type: "image/png" }),
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "network_error" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadReceiptDocument(
        receiptId,
        new File(["x"], "x.png", { type: "image/png" }),
        false,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(
      failureMessage(new DocumentUploadError("malformed_document")),
    ).toContain("malformed");
    expect(failureMessage(new Error("hidden"))).not.toContain("hidden");
  });
});

describe("document file field", () => {
  it("shows the configured limit and validates type, size, drop, and clear", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(configuration)));
    const onFile = vi.fn();
    const onError = vi.fn();
    render(
      <DocumentFileField
        id="document"
        file={null}
        onFile={onFile}
        onError={onError}
      />,
    );
    await screen.findByText(/up to 1 MB/);
    const input = screen.getByLabelText(/Choose or drop/);
    fireEvent.change(input, {
      target: {
        files: [new File(["x"], "bad.txt", { type: "text/plain" })],
      },
    });
    expect(onError).toHaveBeenLastCalledWith(
      "Choose a JPEG, PNG, or PDF file.",
    );
    expect(onFile).toHaveBeenLastCalledWith(null);

    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array(configuration.maxBytes + 1)], "large.png", {
            type: "image/png",
          }),
        ],
      },
    });
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("1 MB"));

    const valid = new File(["png"], "receipt.png", { type: "image/png" });
    const dropTarget = screen.getByText(/Choose or drop/).closest("label");
    if (!dropTarget) throw new Error("Drop target missing");
    fireEvent.drop(dropTarget, {
      dataTransfer: { files: [valid] },
    });
    expect(onError).toHaveBeenLastCalledWith("");
    expect(onFile).toHaveBeenLastCalledWith(valid);

    cleanup();
    render(
      <DocumentFileField
        id="selected"
        file={valid}
        onFile={onFile}
        onError={onError}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear selected file" }),
    );
    expect(onFile).toHaveBeenLastCalledWith(null);
  });
});

describe("document panel", () => {
  it("renders ordered pages, image states, metadata, and keyboard navigation", async () => {
    routeDocument(makeDocument());
    render(<DocumentPanel receiptId={receiptId} />);
    expect(await screen.findByText("markt.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute(
      "target",
      "_blank",
    );
    const figures = screen.getAllByRole("figure");
    expect(figures[0]).toHaveAccessibleName("Page 1 of 2");
    expect(figures[1]).toHaveAccessibleName("Page 2 of 2");
    const firstFigure = figures[0];
    const secondFigure = figures[1];
    if (!firstFigure || !secondFigure) throw new Error("Page figures missing");
    firstFigure.focus();
    fireEvent.keyDown(firstFigure, { key: "ArrowRight" });
    expect(figures[1]).toHaveFocus();
    fireEvent.keyDown(secondFigure, { key: "ArrowUp" });
    expect(figures[0]).toHaveFocus();

    const images = screen.getAllByRole("img");
    const firstImage = images[0];
    const secondImage = images[1];
    if (!firstImage || !secondImage) throw new Error("Page images missing");
    fireEvent.load(firstImage);
    fireEvent.error(secondImage);
    expect(screen.getByText("Page image could not be loaded.")).toBeVisible();
    expect(screen.queryAllByText("Loading page…")).toHaveLength(0);
  });

  it("polls pending preparation to completion", async () => {
    let documentReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/document-upload-configuration")
        return Promise.resolve(response(configuration));
      if (url.endsWith("/document")) {
        documentReads += 1;
        return Promise.resolve(
          response(
            documentReads === 1 ? makeDocument("pending", []) : makeDocument(),
          ),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentPanel receiptId={receiptId} />);
    expect(
      await screen.findByText(/Queued for page preparation/),
    ).toBeVisible();
    expect(await screen.findByText("2 pages ready for review.")).toBeVisible();
    expect(documentReads).toBe(2);
  });

  it.each([
    ["running", "Preparing ordered page images…"],
    ["complete", "1 page ready for review."],
  ] as const)("presents the %s normalization state", async (status, copy) => {
    routeDocument(
      status === "running"
        ? makeDocument("running", [])
        : makeDocument("complete", [page(1, 1)]),
    );
    render(<DocumentPanel receiptId={receiptId} />);
    expect(await screen.findByText(copy)).toBeVisible();
  });

  it("retries failed preparation and preserves actionable errors", async () => {
    const failed = makeDocument("failed", []);
    const pending = makeDocument("pending", []);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/document-upload-configuration")
        return Promise.resolve(response(configuration));
      if (url.endsWith("/normalization") && init?.method === "POST")
        return Promise.resolve(response(pending));
      if (url.endsWith("/document")) return Promise.resolve(response(failed));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentPanel receiptId={receiptId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry page preparation" }),
    );
    expect(
      await screen.findByText(/Queued for page preparation/),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/normalization$/),
      {
        method: "POST",
      },
    );
  });

  it("requires confirmation to replace and remove without losing the current document", async () => {
    const original = makeDocument();
    const replacement = { ...makeDocument(), originalFilename: "new.png" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/document-upload-configuration")
        return Promise.resolve(response(configuration));
      if (url.endsWith("/document") && init?.method === "PUT")
        return Promise.resolve(response(replacement));
      if (url.endsWith("/document") && init?.method === "DELETE")
        return Promise.resolve(response(null, 204));
      if (url.endsWith("/document")) return Promise.resolve(response(original));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentPanel receiptId={receiptId} />);
    await screen.findByText("markt.pdf");
    fireEvent.change(screen.getByLabelText(/Choose or drop/), {
      target: {
        files: [new File(["png"], "new.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace document" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "current page images will be cleared",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("markt.pdf")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Replace document" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm replace" }));
    expect(await screen.findByText("new.png")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Remove document" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "prepared pages will be removed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    expect(await screen.findByText("No document attached yet.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText(/Choose or drop/)).toHaveFocus(),
    );
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/document$/), {
      method: "DELETE",
    });
  });

  it("cancels an in-flight upload while retaining the selected file", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/document-upload-configuration")
        return Promise.resolve(response(configuration));
      if (url.endsWith("/document") && !init?.method)
        return Promise.resolve(response(null, 404));
      if (url.endsWith("/document") && init?.method === "POST")
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        );
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentPanel receiptId={receiptId} />);
    const input = await screen.findByLabelText(/Choose or drop/);
    fireEvent.change(input, {
      target: {
        files: [new File(["png"], "keep.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Attach document" }));
    expect(screen.getByLabelText("Uploading document")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("selected file is still ready");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByText("keep.png")).toBeVisible();
  });

  it("keeps the document and confirmation available after removal fails", async () => {
    const original = makeDocument();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/document-upload-configuration")
        return Promise.resolve(response(configuration));
      if (url.endsWith("/document") && init?.method === "DELETE")
        return Promise.resolve(response(null, 500));
      if (url.endsWith("/document")) return Promise.resolve(response(original));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentPanel receiptId={receiptId} />);
    await screen.findByText("markt.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Remove document" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not store");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByText("markt.pdf")).toBeVisible();
    expect(screen.getByRole("alertdialog")).toBeVisible();
  });

  it("shows an empty state and a recoverable load error", async () => {
    routeDocument(null);
    const { unmount } = render(<DocumentPanel receiptId={receiptId} />);
    expect(await screen.findByText("No document attached yet.")).toBeVisible();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<DocumentPanel receiptId={receiptId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document details could not be loaded",
    );
  });
});
