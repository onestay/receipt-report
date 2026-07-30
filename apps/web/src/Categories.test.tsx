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

  it("renames, moves, reorders, archives, restores, and deletes categories", async () => {
    const secondRoot = category(
      "cm00000000000000000000005",
      "Household",
      null,
      { position: 1 },
    );
    const archived = category(
      "cm00000000000000000000006",
      "Old bakery",
      parent.id,
      {
        position: 1,
        archivedAt: timestamp,
        isEffectivelyActive: false,
        isAssignable: false,
      },
    );
    const rows = [parent, secondRoot, child, archived];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method
          ? new Response(
              init.method === "DELETE" ? null : JSON.stringify(child),
              { status: init.method === "DELETE" ? 204 : 200 },
            )
          : new Response(JSON.stringify({ categories: rows })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CategoryManager />);
    await screen.findByText("Food → Bakery");

    const bakeryRow = screen.getByText("Food → Bakery").closest("article");
    if (!bakeryRow) throw new Error("Bakery row missing");
    const bakeryName = bakeryRow.querySelector("input");
    const bakeryParent = bakeryRow.querySelector("select");
    if (!bakeryName || !bakeryParent)
      throw new Error("Bakery controls missing");
    fireEvent.change(bakeryName, { target: { value: "Bread" } });
    fireEvent.blur(bakeryName);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/categories/${child.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "Bread" }),
        }),
      ),
    );
    fireEvent.change(bakeryParent, { target: { value: secondRoot.id } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/categories/${child.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ parentId: secondRoot.id, position: 0 }),
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Move ${child.name} down` }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/categories/reorder",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    fireEvent.click(
      bakeryRow.querySelector("button:not([aria-label])") as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/categories/${child.id}/archive`,
        expect.objectContaining({ method: "POST" }),
      ),
    );

    const archivedRow = screen
      .getByText("Food → Old bakery")
      .closest("article");
    if (!archivedRow) throw new Error("Archived row missing");
    fireEvent.click(
      Array.from(archivedRow.querySelectorAll("button")).find(
        (button) => button.textContent === "Restore",
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/categories/${archived.id}/restore`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fireEvent.click(
      Array.from(archivedRow.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete",
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/categories/${archived.id}`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("keeps actionable errors when loading or mutations fail", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ categories: [standalone] })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "conflict", message: "in use" },
          }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<CategoryManager />);
    expect(
      await screen.findByText(/Categories could not be loaded/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Eating out", { selector: "strong" });
    const row = screen
      .getByText("Eating out", { selector: "strong" })
      .closest("article");
    const archive = Array.from(row?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Archive",
    );
    if (!archive) throw new Error("Archive action missing");
    fireEvent.click(archive);
    expect(
      await screen.findByText(/It is still in use or has children/),
    ).toBeInTheDocument();
  });

  it("distinguishes empty, validation, unknown, and offline create failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ categories: [standalone] })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "validation_error", message: "invalid" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "internal", message: "failed" } }),
          { status: 500 },
        ),
      )
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<CategoryManager />);
    await screen.findByText("Eating out", { selector: "strong" });
    const create = screen.getByRole("button", { name: "Create" });
    fireEvent.click(create);
    expect(screen.getByText("Enter a category name.")).toBeInTheDocument();

    const name = screen.getByLabelText("Name", {
      selector: "#category-name",
    });
    fireEvent.change(name, { target: { value: "New" } });
    fireEvent.click(create);
    expect(await screen.findByText(/Check the name/)).toBeInTheDocument();
    fireEvent.click(create);
    expect(
      await screen.findByText("The category could not be changed."),
    ).toBeInTheDocument();
    fireEvent.click(create);
    expect(
      await screen.findByText(/category service is unavailable/),
    ).toBeInTheDocument();
  });
});
