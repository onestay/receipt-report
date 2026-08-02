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
  AIReviewPanel,
  formatSignedMoney,
  parseSignedMoney,
  proposalFieldId,
  ReceiptLifecycleBadge,
} from "./AIReviewPanel.js";

const receiptId = "cm12345678901234567890123";
const documentId = "cm22345678901234567890123";
const proposalId = "cm32345678901234567890123";
const categoryId = "cm42345678901234567890123";
const ruleId = "cm52345678901234567890123";
const now = "2026-07-31T12:00:00.000Z";
const documentResponse = {
  id: documentId,
  receiptId,
  originalFilename: "synthetic.png",
  mediaType: "image/png",
  byteSize: 100,
  sha256: "a".repeat(64),
  createdAt: now,
  updatedAt: now,
  normalizationStatus: "complete",
  normalizationRevision: "revision-1",
  normalizationError: null,
  normalizationProfileVersion: "receipt-page-v1",
  normalizationRenderer: "sharp/test",
  normalizationRequestedAt: now,
  normalizationStartedAt: now,
  normalizationCompletedAt: now,
  originalUrl: `/api/v1/receipts/${receiptId}/document/original`,
  pages: [],
};
const statusResponse = {
  documentId,
  normalizationRevision: "revision-1",
  status: "succeeded",
  attempts: 1,
  maxAttempts: 3,
  availableAt: now,
  lastErrorKind: null,
  currentAttempt: null,
};
const proposal = {
  id: proposalId,
  receiptId,
  documentId,
  attemptId: "cm62345678901234567890123",
  normalizationRevision: "revision-1",
  extractionProfileVersion: "de-receipt-v2",
  status: "pending",
  snapshot: {
    merchantRaw: "Synthetic Markt",
    merchantConfidence: 0.42,
    merchantBrandId: null,
    merchantStoreId: null,
    purchaseDate: "2026-07-31",
    purchaseDateConfidence: 0.95,
    purchaseTime: null,
    purchaseTimeConfidence: null,
    currency: "EUR",
    totalCents: 100,
    totalConfidence: 0.8,
    netCents: null,
    taxCents: null,
    lineItems: [
      {
        sourcePosition: 0,
        description: "Apfel",
        descriptionConfidence: 0.6,
        quantityMilli: 1000,
        unitPriceCents: 100,
        lineTotalCents: 90,
        categoryId: null,
        categorySuggestion: { categoryId, ruleId, scopeKind: "store" },
        categoryProvenance: "exact_rule",
        kind: "unknown",
      },
    ],
  },
  findings: [
    {
      code: "line_sum_mismatch",
      severity: "warning",
      fieldPath: "totalCents",
      message: "Line sum differs from receipt total",
    },
    {
      code: "low_confidence",
      severity: "info",
      fieldPath: "merchantRaw",
      message: "Provider confidence is low",
    },
  ],
  createdAt: now,
  updatedAt: now,
};
const categories = [
  {
    id: categoryId,
    name: "Groceries",
    normalizedName: "groceries",
    parentId: null,
    position: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    isLeaf: true,
    isEffectivelyActive: true,
    isAssignable: true,
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

describe("AI review panel", () => {
  it("formats signed cents and maps finding paths without floating point", () => {
    expect(formatSignedMoney(null)).toBe("");
    expect(formatSignedMoney(123)).toBe("1,23");
    expect(formatSignedMoney(-50)).toBe("-0,50");
    expect(parseSignedMoney("12")).toBe(1200);
    expect(parseSignedMoney("-1,2")).toBe(-120);
    expect(parseSignedMoney("1.234")).toBeNull();
    expect(parseSignedMoney("999999999999999")).toBeNull();
    expect(proposalFieldId(null)).toBeUndefined();
    expect(proposalFieldId("merchantRaw")).toBe("proposal-merchantRaw");
    expect(proposalFieldId("lineItems.2.description")).toBe(
      "proposal-line-2-description",
    );
  });

  it.each([
    ["normalization pending", { documentStatus: "pending" }, "Preparing"],
    ["normalization running", { documentStatus: "running" }, "Preparing"],
    ["normalization failed", { documentStatus: "failed" }, "Extraction failed"],
    ["job missing", { extractionStatus: 404 }, "Queued"],
    ["job pending", { extractionStatus: "pending" }, "Queued"],
    ["job retry wait", { extractionStatus: "retry_wait" }, "Queued"],
    ["job running", { extractionStatus: "running" }, "Processing"],
    ["job cancelled", { extractionStatus: "cancelled" }, "Queued"],
    ["job failed", { extractionStatus: "failed" }, "Extraction failed"],
    ["no accepted history", { extractionStatus: "succeeded" }, "Queued"],
  ])("renders the %s lifecycle", async (_name, scenario, expected) => {
    const documentStatus =
      "documentStatus" in scenario ? scenario.documentStatus : "complete";
    const extractionStatus =
      "extractionStatus" in scenario ? scenario.extractionStatus : undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/document"))
        return response({
          ...documentResponse,
          normalizationStatus: documentStatus,
          normalizationRevision:
            documentStatus !== "complete" ? null : "revision-1",
          normalizationError:
            documentStatus === "failed" ? "renderer_failed" : null,
        });
      if (url.endsWith("/document/extraction")) {
        if (extractionStatus === 404) return response({}, 404);
        return response({
          ...statusResponse,
          status: extractionStatus,
          lastErrorKind: extractionStatus === "failed" ? "timeout" : null,
        });
      }
      if (url.endsWith("/extraction-proposal")) return response({}, 404);
      if (url.endsWith("/extraction-proposals"))
        return response({ proposals: [], decisions: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReceiptLifecycleBadge receiptId={receiptId} />);
    expect(await screen.findByLabelText(`AI: ${expected}`)).toBeVisible();
  });

  it("hides the lifecycle badge when no document is attached", async () => {
    const fetchMock = vi.fn(async () => response({}, 404));
    vi.stubGlobal("fetch", fetchMock);

    render(<ReceiptLifecycleBadge receiptId={receiptId} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText(/^AI:/)).not.toBeInTheDocument();
  });

  it("does not poll while the page is hidden", () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ReceiptLifecycleBadge receiptId={receiptId} />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["document status", 1],
    ["extraction status", 2],
    ["proposal history", 4],
  ])("recovers from a transient %s failure", async (failure, calls) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/document"))
        return failure === "document status"
          ? response({}, 503)
          : response(documentResponse);
      if (url.endsWith("/document/extraction"))
        return failure === "extraction status"
          ? response({}, 503)
          : response(statusResponse);
      if (url.endsWith("/extraction-proposal")) return response({}, 404);
      if (url.endsWith("/extraction-proposals"))
        return failure === "proposal history"
          ? response({}, 503)
          : response({ proposals: [], decisions: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReceiptLifecycleBadge receiptId={receiptId} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    expect(screen.queryByLabelText(/^AI:/)).not.toBeInTheDocument();
  });

  it("preserves edits, navigates findings, adopts advice, and approves warnings explicitly", async () => {
    let approvalAttempts = 0;
    let approvalBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/document")) return response(documentResponse);
        if (url.endsWith("/document/extraction"))
          return response(statusResponse);
        if (url.endsWith("/extraction-proposal")) return response(proposal);
        if (url.endsWith("/approve") && init?.method === "POST") {
          approvalAttempts += 1;
          approvalBody = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          if (approvalAttempts === 1)
            return response(
              {
                error: {
                  code: "conflict",
                  message: "Proposal contains blocking findings",
                },
              },
              409,
            );
          return approvalAttempts === 2
            ? response({ error: { code: "conflict", message: "stale" } }, 409)
            : response({ status: "approved" });
        }
        if (
          url.endsWith("/api/v1/category-suggestion-rules") &&
          init?.method === "POST"
        )
          return response({ id: ruleId }, 201);
        if (url.endsWith("/extraction-proposals"))
          return response({
            proposals: [{ ...proposal, status: "approved" }],
            decisions: [],
          });
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onApproved = vi.fn().mockResolvedValue(undefined);
    render(
      <AIReviewPanel
        receiptId={receiptId}
        receiptUpdatedAt={now}
        categories={categories}
        canonicalDirty={false}
        onApproved={onApproved}
      />,
    );

    expect(await screen.findByText("Needs review")).toBeVisible();
    expect(await screen.findByText("42% confidence")).toHaveClass(
      "confidence--low",
    );
    fireEvent.click(screen.getByRole("button", { name: /Line sum differs/ }));
    expect(document.getElementById("proposal-totalCents")).toHaveFocus();
    const merchant = document.getElementById("proposal-merchantRaw");
    if (!merchant) throw new Error("Missing merchant proposal field");
    fireEvent.change(merchant, {
      target: { value: "Human Markt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Adopt suggestion" }));
    expect(document.getElementById("proposal-line-0-categoryId")).toHaveValue(
      categoryId,
    );
    expect(screen.getByText("Source: exact local rule")).toBeVisible();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("global");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Remember for future" }),
    );
    expect(
      await screen.findByText(
        "Category rule remembered locally for future extractions.",
      ),
    ).toBeVisible();
    prompt.mockReturnValueOnce(null);
    fireEvent.click(
      screen.getByRole("button", { name: "Remember for future" }),
    );
    fireEvent.change(screen.getByLabelText("Quantity (thousandths)"), {
      target: { value: "1500" },
    });
    fireEvent.change(screen.getByLabelText("Unit price"), {
      target: { value: "1,25" },
    });
    fireEvent.change(screen.getByLabelText("Line total"), {
      target: { value: "1,88" },
    });
    fireEvent.change(screen.getByLabelText("Kind"), {
      target: { value: "item" },
    });
    const approve = screen.getByRole("button", {
      name: "Approve reviewed values",
    });
    expect(approve).toBeDisabled();
    const warning = screen.getByLabelText(/I reviewed line sum mismatch/);
    fireEvent.click(warning);
    expect(approve).toBeEnabled();
    fireEvent.click(warning);
    expect(approve).toBeDisabled();
    fireEvent.click(warning);
    fireEvent.click(approve);
    expect(
      await screen.findByText(
        "Resolve the blocking findings before approval. Your review edits are still here.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/receipt, document, or proposal changed/i),
    ).not.toBeInTheDocument();
    fireEvent.click(approve);
    expect(
      await screen.findByText(
        "Approval did not complete. Your review edits are still here; refresh stale data or try again.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/receipt, document, or proposal changed/i),
    ).toBeVisible();
    expect(merchant).toHaveValue("Human Markt");
    fireEvent.click(approve);
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
    expect(approvalBody).toMatchObject({
      receiptUpdatedAt: now,
      normalizationRevision: "revision-1",
      acknowledgedWarningCodes: ["line_sum_mismatch"],
      snapshot: {
        merchantRaw: "Human Markt",
        lineItems: [
          {
            categoryId,
            categoryProvenance: "exact_rule",
            kind: "item",
            quantityMilli: 1500,
            unitPriceCents: 125,
            lineTotalCents: 188,
          },
        ],
      },
    });
  });

  it("confirms discarding edited proposals before rejection", async () => {
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    let rejected = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/document")) return response(documentResponse);
        if (url.endsWith("/document/extraction"))
          return response(statusResponse);
        if (url.endsWith("/extraction-proposal")) return response(proposal);
        if (url.endsWith("/reject") && init?.method === "POST") {
          rejected = true;
          return response({ status: "rejected" });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AIReviewPanel
        receiptId={receiptId}
        receiptUpdatedAt={now}
        categories={categories}
        canonicalDirty={false}
        onApproved={vi.fn()}
      />,
    );
    await screen.findByText("42% confidence");
    const merchantInput = document.getElementById("proposal-merchantRaw");
    if (!merchantInput) throw new Error("Missing merchant field");
    fireEvent.change(merchantInput, { target: { value: "Edited" } });
    const reject = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(reject);
    expect(rejected).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(rejected).toBe(true));
    expect(confirm).toHaveBeenCalledWith(
      "Discard your proposal edits and reject it?",
    );
  });

  it("shows an actionable failure and queues retry", async () => {
    let failed = true;
    let retryStatusChecks = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/document")) return response(documentResponse);
        if (
          url.endsWith("/document/extraction/retry") &&
          init?.method === "POST"
        ) {
          failed = false;
          return response({ status: "pending" }, 202);
        }
        if (url.endsWith("/document/extraction")) {
          if (!failed) retryStatusChecks += 1;
          return response({
            ...statusResponse,
            status: failed
              ? "failed"
              : retryStatusChecks === 1
                ? "pending"
                : "succeeded",
            lastErrorKind: failed ? "timeout" : null,
          });
        }
        if (url.endsWith("/extraction-proposal")) return response(proposal);
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AIReviewPanel
        receiptId={receiptId}
        receiptUpdatedAt={now}
        categories={[]}
        canonicalDirty={false}
        onApproved={vi.fn()}
      />,
    );
    expect(await screen.findByText("Extraction needs attention")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry extraction" }));
    expect(await screen.findByText("Retry queued.")).toBeVisible();
    expect(
      await screen.findByText("Needs review", {}, { timeout: 3_000 }),
    ).toBeVisible();
  });

  it("keeps approved data authoritative and confirms reprocessing", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/document")) return response(documentResponse);
        if (url.endsWith("/document/extraction"))
          return response(statusResponse);
        if (url.endsWith("/extraction-proposal")) return response({}, 404);
        if (url.endsWith("/extraction-proposals"))
          return response({
            proposals: [{ ...proposal, status: "approved" }],
            decisions: [],
          });
        if (url.endsWith("/extraction/reprocess") && init?.method === "POST")
          return response({ status: "pending" }, 202);
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AIReviewPanel
        receiptId={receiptId}
        receiptUpdatedAt={now}
        categories={[]}
        canonicalDirty={false}
        onApproved={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Human-reviewed data is authoritative."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reprocess receipt" }));
    expect(confirm).toHaveBeenCalledWith(
      "Reprocess this approved receipt? Approved values will remain authoritative.",
    );
    expect(
      await screen.findByText(
        "Reprocessing queued. Approved values are unchanged.",
      ),
    ).toBeVisible();
  });
});
