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
  App,
  formatDate,
  lineTotalSum,
  parseMoney,
  parseQuantity,
} from "./App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState({}, "", "/");
});

describe("application shell", () => {
  it("parses supported money forms without floating point", () => {
    expect(parseMoney("12")).toBe(1200);
    expect(parseMoney("12.3")).toBe(1230);
    expect(parseMoney("12,34")).toBe(1234);
    expect(parseMoney("1,234")).toBeNull();
    expect(parseMoney("999999999999999")).toBeNull();
  });
  it("renders an empty ledger and German presentation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ receipts: [], nextCursor: null }), {
          status: 200,
        }),
      ),
    );
    render(<App />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "A fresh page" }),
    ).toBeInTheDocument();
    expect(formatDate("2026-07-19")).toBe("19.07.2026");
  });

  it("distinguishes an unavailable API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "The local API is unavailable",
      }),
    ).toBeInTheDocument();
  });

  it("renders populated receipts and retries recoverable errors", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            receipts: [
              {
                id: "cm12345678901234567890123",
                merchant: "Synthetic Markt",
                purchaseDate: "2026-07-19",
                purchaseTime: null,
                currency: "EUR",
                notes: null,
                totalCents: 1234,
                createdAt: "2026-07-19T00:00:00.000Z",
                updatedAt: "2026-07-19T00:00:00.000Z",
                lineItemCount: 2,
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Synthetic Markt")).toBeInTheDocument();
    expect(screen.getByText(/12,34/)).toBeInTheDocument();
  });

  it("loads another page without duplicate receipts", async () => {
    const first = {
      id: "cm12345678901234567890123",
      merchant: "First",
      purchaseDate: "2026-07-19",
      purchaseTime: "12:00",
      currency: "EUR",
      notes: null,
      totalCents: 100,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      lineItemCount: 0,
    };
    const second = {
      ...first,
      id: "cm22345678901234567890123",
      merchant: "Second",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ receipts: [first], nextCursor: "next" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ receipts: [first, second], nextCursor: null }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getAllByText("First")).toHaveLength(1);
  });

  it("validates and creates a receipt without duplicate submission", async () => {
    history.replaceState({}, "", "/receipts/new");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cm12345678901234567890123",
          merchant: "Synthetic",
          purchaseDate: "2026-07-19",
          purchaseTime: null,
          currency: "EUR",
          notes: null,
          totalCents: 1234,
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
          lineItems: [],
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Save receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("review");
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Synthetic" },
    });
    fireEvent.change(screen.getByLabelText("Purchase date"), {
      target: { value: "2026-07-19" },
    });
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "12,34" },
    });
    fireEvent.change(screen.getByLabelText(/Time/), {
      target: { value: "12:30" },
    });
    fireEvent.change(screen.getByLabelText(/Notes/), {
      target: { value: "Synthetic note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save receipt" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("heading", { name: "Could not open receipt" }),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "server",
      new Response(
        JSON.stringify({
          error: { code: "internal_error", message: "hidden" },
        }),
        { status: 500 },
      ),
      "may not have been saved",
    ],
    [
      "invalid confirmation",
      new Response(JSON.stringify({ id: "bad" }), { status: 201 }),
      "confirmation was incomplete",
    ],
  ])("preserves input after a %s failure", async (_name, response, message) => {
    history.replaceState({}, "", "/receipts/new");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Synthetic" },
    });
    fireEvent.change(screen.getByLabelText("Purchase date"), {
      target: { value: "2026-07-19" },
    });
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "12,34" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("Merchant")).toHaveValue("Synthetic");
  });

  it("uses an ambiguity-safe message for a network failure", async () => {
    history.replaceState({}, "", "/receipts/new");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("raw failure")),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Synthetic" },
    });
    fireEvent.change(screen.getByLabelText("Purchase date"), {
      target: { value: "2026-07-19" },
    });
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "12,34" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save receipt" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("may not have been saved");
    expect(alert).not.toHaveTextContent("raw failure");
  });

  it("renders a direct detail route", () => {
    history.replaceState({}, "", "/receipts/cm12345678901234567890123");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading receipt");
  });

  it("moves focus to the heading after persistent navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ receipts: [], nextCursor: null }), {
          status: 200,
        }),
      ),
    );
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "New receipt" }));
    expect(screen.getByLabelText("Merchant")).toHaveFocus();
    fireEvent.click(screen.getByRole("link", { name: "Ledger" }));
    expect(
      screen.getByRole("heading", { name: "Purchases, clearly kept." }),
    ).toHaveFocus();
  });
});

describe("receipt editor", () => {
  const receipt = {
    id: "cm12345678901234567890123",
    merchant: "Synthetic Markt",
    purchaseDate: "2026-07-19",
    purchaseTime: null,
    currency: "EUR",
    notes: "",
    totalCents: 300,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lineItems: [
      {
        id: "cm22345678901234567890123",
        position: 0,
        description: "Apfel",
        quantityMilli: 1000,
        unitPriceCents: 100,
        lineTotalCents: 100,
      },
      {
        id: "cm32345678901234567890123",
        position: 1,
        description: "Brot",
        quantityMilli: null,
        unitPriceCents: null,
        lineTotalCents: 200,
      },
    ],
  };
  it("parses quantities and totals deterministically", () => {
    expect(parseQuantity("0,485")).toBe(485);
    expect(parseQuantity("1.5")).toBe(1500);
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("1,2345")).toBeNull();
    expect(
      lineTotalSum({
        merchant: "",
        purchaseDate: "",
        purchaseTime: "",
        total: "",
        notes: "",
        items: [
          {
            key: "a",
            description: "",
            quantity: "",
            unitPrice: "",
            lineTotal: "1,00",
          },
          {
            key: "b",
            description: "",
            quantity: "",
            unitPrice: "",
            lineTotal: "2,00",
          },
        ],
      }),
    ).toBe(300);
  });
  it("loads, edits, reorders, validates, and saves atomically", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Edit receipt" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Changed Markt" },
    });
    fireEvent.change(screen.getByLabelText("Purchase date"), {
      target: { value: "2026-07-18" },
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "12:30" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Changed note" },
    });
    const quantity = screen.getAllByLabelText("Quantity")[0];
    const unitPrice = screen.getAllByLabelText("Unit price")[0];
    if (!quantity || !unitPrice) throw new Error("Item fields missing");
    fireEvent.change(quantity, {
      target: { value: "0,485" },
    });
    fireEvent.change(unitPrice, {
      target: { value: "2,00" },
    });
    fireEvent.change(screen.getByLabelText("Receipt total"), {
      target: { value: "4,00" },
    });
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Difference",
    );
    fireEvent.click(screen.getByRole("button", { name: "Move item 2 up" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Description")[0]).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove item 2" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Description")[0]).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Add item/ }));
    const descriptions = screen.getAllByLabelText("Description");
    const description = descriptions.at(-1);
    const totals = screen.getAllByLabelText("Line total");
    const itemTotal = totals.at(-1);
    if (!description || !itemTotal) throw new Error("New item fields missing");
    await waitFor(() => expect(description).toHaveFocus());
    fireEvent.change(description, { target: { value: "Milch" } });
    fireEvent.change(itemTotal, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Enter a valid amount."),
    ).toBeInTheDocument();
    fireEvent.change(itemTotal, { target: { value: "1,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Receipt saved.")).toBeInTheDocument();
  });
  it("distinguishes unchanged, saving, and saved button states", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    let finishSave: ((response: Response) => void) | undefined;
    const saveResponse = new Promise<Response>((resolve) => {
      finishSave = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { status: 200 }),
      )
      .mockReturnValueOnce(saveResponse);
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Save changes",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");

    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Changed Markt" },
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();

    finishSave?.(new Response(JSON.stringify(receipt), { status: 200 }));
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "false"));
    expect(button).toBeDisabled();
  });
  it("clears the busy state and re-enables saving after failure", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Save changes",
    });
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Changed Markt" },
    });
    fireEvent.click(button);
    expect(
      await screen.findByText(
        "Could not save. Your changes are still here; try again.",
      ),
    ).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "false");
  });
  it("shows not-found and retryable load states", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Receipt not found" }),
    ).toBeInTheDocument();
  });
  it("retries a failed load", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Edit receipt" }),
    ).toBeInTheDocument();
  });
  it("deletes only after confirmation", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(receipt), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(location.pathname).toBe("/receipts"));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
  it("keeps a receipt when deletion is declined", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(receipt), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      screen.getByRole("heading", { name: "Edit receipt" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("guards dirty navigation and browser unload", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(receipt), { status: 200 }),
        ),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    await screen.findByRole("heading", { name: "Edit receipt" });
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Dirty Markt" },
    });
    fireEvent.click(screen.getByRole("link", { name: "← Ledger" }));
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved changes?");
    expect(location.pathname).toBe(`/receipts/${receipt.id}`);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "← Ledger" }));
    expect(location.pathname).toBe("/receipts");
  });
  it("does not guard unload while clean", async () => {
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(receipt), { status: 200 }),
        ),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Edit receipt" });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });
  it("restores the receipt after a cancelled browser back navigation", async () => {
    history.replaceState({}, "", "/receipts");
    history.pushState({}, "", `/receipts/${receipt.id}`);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(receipt), { status: 200 }),
        ),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    await screen.findByRole("heading", { name: "Edit receipt" });
    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Dirty Markt" },
    });
    history.back();
    await waitFor(() =>
      expect(window.confirm).toHaveBeenCalledWith(
        "Discard your unsaved changes?",
      ),
    );
    await waitFor(() =>
      expect(location.pathname).toBe(`/receipts/${receipt.id}`),
    );
  });
  it("focuses Add item after removing the final line item", async () => {
    const oneItem = { ...receipt, lineItems: receipt.lineItems.slice(0, 1) };
    history.replaceState({}, "", `/receipts/${receipt.id}`);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(oneItem), { status: 200 }),
        ),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Edit receipt" });
    fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add item/ })).toHaveFocus(),
    );
  });
});
