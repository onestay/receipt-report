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
import { App, formatDate, parseMoney } from "./App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
      await screen.findByRole("heading", { name: "Ready for detail." }),
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
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Ready for detail." }),
    ).toBeInTheDocument();
  });
});
