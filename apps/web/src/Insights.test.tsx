// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Insights } from "./Insights.js";

const emptyWorkflow = {
  preparing: 0,
  queued: 0,
  processing: 0,
  needsReview: 0,
  failed: 0,
};
const baseReport = {
  timezone: "Europe/Berlin",
  range: { from: "2026-01-01", to: "2026-12-31" },
  filters: { categorySubtree: false },
  totals: {
    grossCents: 12345,
    receiptCount: 2,
    averageReceiptCents: 6173,
    netCents: null,
    taxCents: 0,
    coverage: { receipts: 2, net: 0, tax: 1 },
  },
  monthly: [
    {
      key: "2026-01",
      label: "2026-01",
      grossCents: 12345,
      receiptCount: 2,
      drillDownUrl:
        "/api/v1/receipts?from=2026-01-01&to=2026-12-31&month=2026-01",
    },
  ],
  categories: [
    {
      key: "uncategorized",
      label: "Uncategorized",
      grossCents: 12345,
      receiptCount: 2,
      drillDownUrl:
        "/api/v1/receipts?from=2026-01-01&to=2026-12-31&category=uncategorized",
    },
  ],
  merchantBrands: [
    {
      key: "unassigned",
      label: "Unassigned brand",
      grossCents: 12345,
      receiptCount: 2,
      drillDownUrl:
        "/api/v1/receipts?from=2026-01-01&to=2026-12-31&merchantBrand=unassigned",
    },
  ],
  merchantStores: [],
  rawMerchants: [],
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function supportingFetch(url: string) {
  if (url === "/api/v1/categories?includeArchived=true")
    return response({ categories: [] });
  if (url === "/api/v1/merchant-brands?limit=100")
    return response({ brands: [], nextCursor: null });
  if (url === "/api/v1/reports/workflow") return response(emptyWorkflow);
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState({}, "", "/");
});

describe("spending insights", () => {
  it("restores URL filters, distinguishes missing from zero, and renders drill-downs", async () => {
    history.replaceState(
      {},
      "",
      "/insights?from=2026-01-01&to=2026-12-31&merchantQuery=Markt&provenance=manual",
    );
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(supportingFetch(url) ?? response(baseReport));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Insights />);
    expect((await screen.findAllByText(/123,45/))[0]).toBeVisible();
    expect(screen.getByLabelText("Raw merchant")).toHaveValue("Markt");
    expect(screen.getByLabelText("Source")).toHaveValue("manual");
    expect(screen.getByText("Not available")).toBeVisible();
    expect(screen.getByText(/0,00/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Uncategorized" })).toHaveAttribute(
      "href",
      "/receipts?from=2026-01-01&to=2026-12-31&category=uncategorized",
    );
    expect(screen.getByRole("link", { name: /Needs review/ })).toHaveAttribute(
      "href",
      "/receipts?workflow=needs-review",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("merchantQuery=Markt"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("serializes composed filters into a reloadable URL", async () => {
    history.replaceState({}, "", "/insights?from=2026-01-01&to=2026-12-31");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(supportingFetch(String(input)) ?? response(baseReport)),
      ),
    );
    render(<Insights />);
    await screen.findAllByText(/123,45/);
    fireEvent.change(screen.getByLabelText("Raw merchant"), {
      target: { value: "Bio Markt" },
    });
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "ai_approved" },
    });
    fireEvent.click(screen.getByLabelText("Include subcategories"));
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(location.search).toContain("merchantQuery=Bio+Markt"),
    );
    expect(location.search).toContain("provenance=ai_approved");
    expect(location.search).toContain("categorySubtree=true");
  });

  it("keeps invalid and reversed date edits visible without changing the URL", async () => {
    history.replaceState({}, "", "/insights?from=2026-01-01&to=2026-12-31");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(supportingFetch(String(input)) ?? response(baseReport)),
      ),
    );
    render(<Insights />);
    await screen.findAllByText(/123,45/);
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "31.02.2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByLabelText("From")).toHaveValue("31.02.2026");
    expect(screen.getByText(/Enter a valid date/)).toBeVisible();
    expect(location.search).toContain("from=2026-01-01");

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "31.12.2026" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "01.01.2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByText(/must be on or before/)).toBeVisible();
    expect(location.search).toContain("to=2026-12-31");
  });

  it("recovers invalid URLs and handles empty and API-error states", async () => {
    history.replaceState({}, "", "/insights?from=bad&to=worse");
    let spendingCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const support = supportingFetch(url);
        if (support) return Promise.resolve(support);
        spendingCalls++;
        return Promise.resolve(
          spendingCalls === 1
            ? response({
                ...baseReport,
                totals: {
                  ...baseReport.totals,
                  grossCents: 0,
                  receiptCount: 0,
                  averageReceiptCents: null,
                },
                monthly: [],
                categories: [],
                merchantBrands: [],
              })
            : response({}, 503),
        );
      }),
    );
    const { unmount } = render(<Insights />);
    expect(await screen.findByText(/safe year-to-date view/i)).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "No spending in this view" }),
    ).toBeVisible();
    unmount();
    cleanup();
    history.replaceState({}, "", "/insights?from=2026-01-01&to=2026-12-31");
    render(<Insights />);
    expect(
      await screen.findByRole("heading", { name: "Insights unavailable" }),
    ).toBeVisible();
    expect(screen.queryByText(/123,45/)).not.toBeInTheDocument();
  });

  it("does not let a superseded response restore stale totals", async () => {
    history.replaceState({}, "", "/insights?from=2026-01-01&to=2026-01-31");
    let releaseOld: ((value: Response) => void) | undefined;
    const old = new Promise<Response>((resolve) => (releaseOld = resolve));
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const support = supportingFetch(url);
      if (support) return Promise.resolve(support);
      if (url.includes("to=2026-01-31")) return old;
      return Promise.resolve(
        response({
          ...baseReport,
          range: { from: "2026-02-01", to: "2026-02-28" },
          totals: { ...baseReport.totals, grossCents: 999 },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Insights />);
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-02-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-02-28" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect((await screen.findAllByText(/9,99/))[0]).toBeVisible();
    releaseOld?.(response(baseReport));
    await Promise.resolve();
    const grossMetric = screen.getByText("Gross spend").parentElement;
    if (!grossMetric) throw new Error("gross metric missing");
    expect(within(grossMetric).getByText(/9,99/)).toBeVisible();
  });

  it("keeps current spending visible when only workflow counts fail", async () => {
    history.replaceState({}, "", "/insights?from=2026-01-01&to=2026-12-31");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/categories?includeArchived=true")
          return Promise.resolve(response({ categories: [] }));
        if (url === "/api/v1/merchant-brands?limit=100")
          return Promise.resolve(response({ brands: [], nextCursor: null }));
        if (url === "/api/v1/reports/workflow")
          return Promise.resolve(response({}, 503));
        return Promise.resolve(response(baseReport));
      }),
    );
    render(<Insights />);
    expect((await screen.findAllByText(/123,45/))[0]).toBeVisible();
    expect(
      screen.getByText(/workflow counts are temporarily unavailable/i),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Insights unavailable" }),
    ).not.toBeInTheDocument();
  });
});
