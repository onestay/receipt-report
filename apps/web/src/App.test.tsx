// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the shell and reports a healthy API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            service: "receipt-report-api",
            version: "v1",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Receipt Report" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Local API connected",
    );
  });

  it("reports an unavailable API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Local API unavailable",
      ),
    );
  });

  it("treats a non-success health response as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Local API unavailable",
      ),
    );
  });
});
