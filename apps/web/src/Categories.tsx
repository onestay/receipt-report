import { useCallback, useEffect, useState } from "react";
import {
  apiErrorSchema,
  categoryListSchema,
  type Category,
} from "@receipt-report/contracts";

export async function loadCategories(
  includeArchived = true,
): Promise<Category[]> {
  const response = await fetch(
    `/api/v1/categories${includeArchived ? "?includeArchived=true" : ""}`,
  );
  if (!response.ok) throw new Error("load");
  return categoryListSchema.parse(await response.json()).categories;
}

export function categoryLabel(
  category: Category,
  categories: Category[],
): string {
  const parent = categories.find(({ id }) => id === category.parentId);
  return parent ? `${parent.name} → ${category.name}` : category.name;
}

export function CategoryOptions({
  categories,
  value,
}: {
  categories: Category[];
  value: string | null;
}) {
  const current = categories.find(({ id }) => id === value);
  const roots = categories.filter(({ parentId }) => parentId === null);
  return (
    <>
      <option value="">Uncategorized</option>
      {current && !current.isAssignable && (
        <option value={current.id} disabled>
          {categoryLabel(current, categories)} — archived or no longer a leaf
        </option>
      )}
      {roots.map((root) => {
        const children = categories.filter(
          ({ parentId, isAssignable }) => parentId === root.id && isAssignable,
        );
        if (children.length) {
          return (
            <optgroup label={root.name} key={root.id}>
              {children.map((child) => (
                <option key={child.id} value={child.id}>
                  {root.name} → {child.name}
                </option>
              ))}
            </optgroup>
          );
        }
        return root.isAssignable ? (
          <option key={root.id} value={root.id}>
            {root.name}
          </option>
        ) : null;
      })}
    </>
  );
}

function errorMessage(responseBody: unknown, fallback: string) {
  const parsed = apiErrorSchema.safeParse(responseBody);
  if (!parsed.success) return fallback;
  if (parsed.data.error.code === "conflict")
    return `${fallback} It is still in use or has children; archive it instead.`;
  if (parsed.data.error.code === "validation_error")
    return `${fallback} Check the name or selected parent.`;
  return fallback;
}

export function CategoryManager() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");

  const reload = useCallback(async () => {
    setState("loading");
    try {
      setCategories(await loadCategories());
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  async function mutate(
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body: unknown | undefined,
    success: string,
  ) {
    setMessage("");
    const init: RequestInit =
      body === undefined
        ? { method }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    const response = await fetch(path, init).catch(() => null);
    if (!response) {
      setMessage("The category service is unavailable. Nothing was changed.");
      return false;
    }
    if (!response.ok) {
      const responseBody = await response.json().catch(() => undefined);
      setMessage(
        errorMessage(responseBody, "The category could not be changed."),
      );
      return false;
    }
    setMessage(success);
    await reload();
    return true;
  }

  async function create() {
    if (!newName.trim()) return setMessage("Enter a category name.");
    if (
      await mutate(
        "/api/v1/categories",
        "POST",
        { name: newName, parentId: newParentId || null },
        "Category created.",
      )
    ) {
      setNewName("");
      setNewParentId("");
    }
  }

  function siblings(category: Category) {
    return categories.filter(({ parentId }) => parentId === category.parentId);
  }

  async function movePosition(category: Category, direction: -1 | 1) {
    const ordered = siblings(category);
    const index = ordered.findIndex(({ id }) => id === category.id);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const ids = ordered.map(({ id }) => id);
    const currentId = ids[index];
    const targetId = ids[target];
    if (!currentId || !targetId) return;
    ids[index] = targetId;
    ids[target] = currentId;
    await mutate(
      "/api/v1/categories/reorder",
      "PUT",
      { parentId: category.parentId, categoryIds: ids },
      "Category order updated.",
    );
  }

  const roots = categories.filter(({ parentId }) => parentId === null);
  return (
    <section className="category-page">
      <p className="eyebrow">Personal taxonomy</p>
      <h1>Categories</h1>
      <p className="intro">
        Keep a simple two-level spending structure. Parent and child names are
        always shown explicitly.
      </p>
      {message && (
        <div className="banner" role="status">
          {message}
        </div>
      )}
      {state === "error" && (
        <div className="panel state" role="alert">
          Categories could not be loaded.{" "}
          <button onClick={() => void reload()}>Try again</button>
        </div>
      )}
      <section
        className="panel category-create"
        aria-labelledby="create-category"
      >
        <h2 id="create-category">Create category</h2>
        <div className="field">
          <label htmlFor="category-name">Name</label>
          <input
            id="category-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="category-parent">Parent</label>
          <select
            id="category-parent"
            value={newParentId}
            onChange={(event) => setNewParentId(event.target.value)}
          >
            <option value="">Top level</option>
            {roots
              .filter(({ archivedAt }) => !archivedAt)
              .map((root) => (
                <option key={root.id} value={root.id}>
                  {root.name}
                </option>
              ))}
          </select>
        </div>
        <button className="button" onClick={() => void create()}>
          Create
        </button>
      </section>
      {state === "loading" && (
        <div className="panel state" role="status">
          Loading categories…
        </div>
      )}
      {state === "ready" && (
        <div className="category-list">
          {categories.map((category) => {
            const parent = roots.find(({ id }) => id === category.parentId);
            const children = categories.filter(
              ({ parentId }) => parentId === category.id,
            );
            const ordered = siblings(category);
            const index = ordered.findIndex(({ id }) => id === category.id);
            const parentArchived = parent?.archivedAt != null;
            return (
              <article className="panel category-row" key={category.id}>
                <div>
                  <strong>
                    {parent
                      ? `${parent.name} → ${category.name}`
                      : category.name}
                  </strong>
                  <small>
                    {category.archivedAt
                      ? "Archived"
                      : parentArchived
                        ? "Disabled because its parent is archived"
                        : category.isAssignable
                          ? "Available for line items"
                          : `${children.length} child categories`}
                  </small>
                </div>
                <div className="category-row__fields">
                  <label>
                    <span>Name</span>
                    <input
                      defaultValue={category.name}
                      onBlur={(event) => {
                        const name = event.target.value.trim();
                        if (name && name !== category.name)
                          void mutate(
                            `/api/v1/categories/${category.id}`,
                            "PATCH",
                            { name },
                            "Category renamed.",
                          );
                      }}
                    />
                  </label>
                  <label>
                    <span>Parent</span>
                    <select
                      value={category.parentId ?? ""}
                      disabled={children.length > 0}
                      title={
                        children.length
                          ? "Move or remove its children first."
                          : undefined
                      }
                      onChange={(event) =>
                        void mutate(
                          `/api/v1/categories/${category.id}`,
                          "PATCH",
                          { parentId: event.target.value || null, position: 0 },
                          "Category moved.",
                        )
                      }
                    >
                      <option value="">Top level</option>
                      {roots
                        .filter(
                          (root) => root.id !== category.id && !root.archivedAt,
                        )
                        .map((root) => (
                          <option key={root.id} value={root.id}>
                            {root.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <div className="category-actions">
                  <button
                    aria-label={`Move ${category.name} up`}
                    disabled={index === 0}
                    onClick={() => void movePosition(category, -1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${category.name} down`}
                    disabled={index === ordered.length - 1}
                    onClick={() => void movePosition(category, 1)}
                  >
                    ↓
                  </button>
                  {category.archivedAt ? (
                    <button
                      disabled={parentArchived}
                      title={
                        parentArchived ? "Restore the parent first." : undefined
                      }
                      onClick={() =>
                        void mutate(
                          `/api/v1/categories/${category.id}/restore`,
                          "POST",
                          undefined,
                          "Category restored.",
                        )
                      }
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        void mutate(
                          `/api/v1/categories/${category.id}/archive`,
                          "POST",
                          undefined,
                          "Category archived.",
                        )
                      }
                    >
                      Archive
                    </button>
                  )}
                  <button
                    className="danger-text"
                    disabled={children.length > 0}
                    title={
                      children.length
                        ? "Delete or move its children first; you can archive it now."
                        : undefined
                    }
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${categoryLabel(category, categories)} permanently?`,
                        )
                      )
                        void mutate(
                          `/api/v1/categories/${category.id}`,
                          "DELETE",
                          undefined,
                          "Category deleted.",
                        );
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
