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
import type { Category } from "@receipt-report/contracts";
import {
  CategoryManager,
  CategoryOptions,
  categoryLabel,
} from "./Categories.js";

const timestamp = "2026-07-30T00:00:00.000Z";
function category(
  id: string,
  name: string,
  parentId: string | null,
  overrides: Partial<Category> = {},
): Category {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    parentId,
    position: 0,
    archivedAt: null,
    isLeaf: true,
    isEffectivelyActive: true,
    isAssignable: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

const parent = category("cm00000000000000000000001", "Food", null, {
  isLeaf: false,
  isAssignable: false,
});
const child = category("cm00000000000000000000002", "Bakery", parent.id);
const standalone = category("cm00000000000000000000003", "Eating out", null);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("category controls", () => {
  it("groups assignable children, shows standalone leaves, and explains historical assignments", () => {
    const archived = category("cm00000000000000000000004", "Old", parent.id, {
      archivedAt: timestamp,
      isEffectivelyActive: false,
      isAssignable: false,
    });
    render(
      <select value={archived.id} onChange={() => undefined}>
        <CategoryOptions
          categories={[parent, child, standalone, archived]}
          value={archived.id}
        />
      </select>,
    );
    expect(screen.getByRole("group", { name: "Food" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Food → Bakery" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "Eating out" })).toBeEnabled();
    expect(
      screen.getByRole("option", {
        name: "Food → Old — archived or no longer a leaf",
      }),
    ).toBeDisabled();
    expect(categoryLabel(child, [parent, child])).toBe("Food → Bakery");
  });

  it("creates a child and reloads without losing the management state", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST")
          return new Response(JSON.stringify(child), { status: 201 });
        return new Response(JSON.stringify({ categories: [parent, child] }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CategoryManager />);
    await screen.findByText("Food → Bakery");
    fireEvent.change(
      screen.getByLabelText("Name", { selector: "#category-name" }),
      {
        target: { value: "Produce" },
      },
    );
    fireEvent.change(
      screen.getByLabelText("Parent", { selector: "#category-parent" }),
      {
        target: { value: parent.id },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/categories",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Produce", parentId: parent.id }),
        }),
      ),
    );
    expect(await screen.findByText("Category created.")).toBeInTheDocument();
  });
});
