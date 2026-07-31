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
import type {
  Category,
  CategorySuggestionRule,
} from "@receipt-report/contracts";
import { CategorySuggestionAdvice } from "./App.js";
import {
  CategorySuggestionRuleManager,
  rememberCategoryRule,
} from "./CategorySuggestionRules.js";

const category: Category = {
  id: "cm00000000000000000000010",
  name: "Other",
  normalizedName: "other",
  parentId: null,
  position: 9,
  archivedAt: null,
  isLeaf: true,
  isEffectivelyActive: true,
  isAssignable: true,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
};
const rule: CategorySuggestionRule = {
  id: "cm30000000000000000000001",
  description: "Synthetic milk",
  normalizedDescription: "synthetic milk",
  scopeKind: "global",
  categoryId: category.id,
  category,
  brandId: null,
  storeId: null,
  isValid: true,
  invalidReason: null,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("category suggestion UI", () => {
  it("shows provenance, requires explicit adoption, recomputes, and protects explicit categories", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ suggestion: rule }), { status: 200 }),
      );
    const adopt = vi.fn();
    const view = render(
      <CategorySuggestionAdvice
        description="Synthetic milk"
        categoryId={null}
        brandId={null}
        storeId={null}
        categories={[category]}
        onAdopt={adopt}
        onStatus={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Suggested: Other · global/)).toBeVisible();
    expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Adopt suggestion" }));
    expect(adopt).toHaveBeenCalledWith(category.id);
    view.rerender(
      <CategorySuggestionAdvice
        description="Changed description"
        categoryId={category.id}
        brandId={null}
        storeId={null}
        categories={[category]}
        onAdopt={adopt}
        onStatus={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Adopt suggestion" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Globally" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "For this brand" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("offers only eligible remember scopes and confirms conflicting replacement", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (
          url === "/api/v1/category-suggestion-rules" &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              error: { code: "conflict", message: "Existing rule" },
            }),
            { status: 409 },
          );
        }
        if (url.startsWith("/api/v1/category-suggestion-rules?")) {
          return new Response(
            JSON.stringify({ rules: [rule], nextCursor: null }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(rule), { status: 200 });
      });
    await expect(
      rememberCategoryRule({
        description: "Synthetic milk",
        categoryId: category.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      }),
    ).resolves.toBe("replaced");
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Replace its target?"),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/category-suggestion-rules/${rule.id}`,
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("surfaces invalid rules for repair and recovers from load failures", async () => {
    const invalid = {
      ...rule,
      isValid: false,
      invalidReason: "Target category is archived",
    };
    let ruleLoads = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith("/api/v1/category-suggestion-rules?")) {
          ruleLoads += 1;
          if (ruleLoads === 1) throw new TypeError("offline");
          return new Response(
            JSON.stringify({ rules: [invalid], nextCursor: null }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ categories: [category] }), {
          status: 200,
        });
      });
    render(<CategorySuggestionRuleManager />);
    expect(
      await screen.findByText(/Rules could not be loaded/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/Needs repair: Target category is archived/),
    ).toBeVisible();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));
  });

  it("searches, filters, updates, and deletes managed rules with recoverable errors", async () => {
    const replacement = {
      ...category,
      id: "cm00000000000000000000009",
      name: "Electronics",
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let patchFails = true;
    let deleteFails = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/api/v1/category-suggestion-rules/${rule.id}`) {
        if (init?.method === "PATCH") {
          if (patchFails) {
            patchFails = false;
            return new Response(null, { status: 500 });
          }
          return new Response(JSON.stringify(rule), { status: 200 });
        }
        if (deleteFails) {
          deleteFails = false;
          throw new TypeError("offline");
        }
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("/api/v1/category-suggestion-rules?")) {
        return new Response(
          JSON.stringify({ rules: [rule], nextCursor: null }),
        );
      }
      return new Response(
        JSON.stringify({ categories: [category, replacement] }),
      );
    });
    render(<CategorySuggestionRuleManager />);
    expect(await screen.findByText("Synthetic milk")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search descriptions"), {
      target: { value: "milk" },
    });
    fireEvent.change(screen.getByLabelText("Validity"), {
      target: { value: "valid" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) =>
            String(input).includes("validity=valid"),
          ),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("Target"), {
      target: { value: replacement.id },
    });
    expect(
      await screen.findByText(
        "The rule could not be repaired. Nothing was changed.",
      ),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Target"), {
      target: { value: replacement.id },
    });
    expect(await screen.findByText("Rule updated.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(
        "The rule could not be deleted. Nothing was changed.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Rule deleted.")).toBeVisible();
  });

  it("handles create, cancelled replacement, and non-conflict remember failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(rule), { status: 201 }),
    );
    await expect(
      rememberCategoryRule({
        description: rule.description,
        categoryId: category.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      }),
    ).resolves.toBe("created");

    vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "conflict", message: "exists" } }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rules: [rule], nextCursor: null })),
      );
    await expect(
      rememberCategoryRule({
        description: rule.description,
        categoryId: category.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      }),
    ).resolves.toBe("cancelled");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "validation_error", message: "bad" } }),
        { status: 400 },
      ),
    );
    await expect(
      rememberCategoryRule({
        description: rule.description,
        categoryId: category.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      }),
    ).rejects.toThrow("remember");
  });

  it("offers merchant scopes, remembers from the editor, and recovers from suggestion errors", async () => {
    const status = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(rule), { status: 201 }),
      );
    const view = render(
      <CategorySuggestionAdvice
        description="Synthetic milk"
        categoryId={null}
        brandId="cm40000000000000000000001"
        storeId="cm50000000000000000000001"
        categories={[category]}
        onAdopt={vi.fn()}
        onStatus={status}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Suggested:/)).not.toBeInTheDocument();
    view.rerender(
      <CategorySuggestionAdvice
        description="Synthetic milk"
        categoryId={category.id}
        brandId="cm40000000000000000000001"
        storeId="cm50000000000000000000001"
        categories={[category]}
        onAdopt={vi.fn()}
        onStatus={status}
      />,
    );
    expect(
      screen.getByRole("option", { name: "For this brand" }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "For this store" }),
    ).toBeVisible();
    fireEvent.change(
      screen.getByLabelText("Remember scope for Synthetic milk"),
      { target: { value: "store" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    await waitFor(() =>
      expect(status).toHaveBeenCalledWith(
        "Rule remembered for future receipts.",
      ),
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      scopeKind: "store",
      brandId: "cm40000000000000000000001",
      storeId: "cm50000000000000000000001",
    });
    view.rerender(
      <CategorySuggestionAdvice
        description="Synthetic milk"
        categoryId={category.id}
        brandId="cm40000000000000000000001"
        storeId={null}
        categories={[category]}
        onAdopt={vi.fn()}
        onStatus={status}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "For this store" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("labels brand and store provenance explicitly", async () => {
    const brandRule = {
      ...rule,
      id: "cm30000000000000000000002",
      scopeKind: "brand" as const,
      brandId: "cm40000000000000000000001",
    };
    const storeRule = {
      ...rule,
      id: "cm30000000000000000000003",
      scopeKind: "store" as const,
      brandId: "cm40000000000000000000001",
      storeId: "cm50000000000000000000001",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).startsWith("/api/v1/category-suggestion-rules?")
        ? new Response(
            JSON.stringify({
              rules: [brandRule, storeRule],
              nextCursor: null,
            }),
          )
        : new Response(JSON.stringify({ categories: [category] })),
    );
    render(<CategorySuggestionRuleManager />);
    expect(
      await screen.findByText(/Brand · cm40000000000000000000001/),
    ).toBeVisible();
    expect(screen.getByText(/Store · cm50000000000000000000001/)).toBeVisible();
  });
});
