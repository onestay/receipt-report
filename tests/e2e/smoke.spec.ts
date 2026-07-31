import { expect, test } from "@playwright/test";

test("creates, edits, reorders, saves, reloads, and deletes a receipt", async ({
  page,
}) => {
  await page.goto("/receipts/new");
  await page.getByLabel("Merchant").fill("Synthetic Browser Markt");
  await page.getByLabel("Purchase date").fill("2026-07-19");
  await page.getByLabel("Total").fill("3,00");
  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit receipt" }),
  ).toBeVisible();
  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).toHaveCSS("cursor", "not-allowed");
  await page.getByRole("button", { name: /Add item/ }).click();
  await page.getByLabel("Description").fill("Synthetic apples");
  await page.getByLabel("Line total").fill("1,00");
  await page.getByRole("button", { name: /Add item/ }).click();
  await page.getByLabel("Description").nth(1).fill("Synthetic bread");
  await page.getByLabel("Line total").nth(1).fill("1,50");
  await expect(
    page.getByRole("status").filter({ hasText: "Difference" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Move item 2 up" }).click();
  let releaseSave: (() => void) | undefined;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/v1/receipts/*", async (route) => {
    if (route.request().method() === "PATCH") await saveGate;
    await route.continue();
  });
  await saveButton.click();
  await expect(page.getByRole("button", { name: "Saving…" })).toHaveCSS(
    "cursor",
    "wait",
  );
  releaseSave?.();
  await expect(page.getByText("Receipt saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Description").first()).toHaveValue(
    "Synthetic bread",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/receipts$/);
});

test("mobile editor has no horizontal overflow", async ({ page, request }) => {
  const response = await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: "Synthetic Mobile Markt",
      purchaseDate: "2026-07-19",
      totalCents: 100,
      lineItems: [],
    },
  });
  const receipt = (await response.json()) as { id: string };
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`/receipts/${receipt.id}`);
  await expect(
    page.getByRole("heading", { name: "Edit receipt" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("assigns a receipt to one of two stores and restores it", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const brandResponse = await request.post("/api/v1/merchant-brands", {
    data: { name: `Synthetic Browser Brand ${suffix}` },
  });
  expect(brandResponse.ok()).toBe(true);
  const brand = (await brandResponse.json()) as { id: string; name: string };
  const firstStoreResponse = await request.post("/api/v1/merchant-stores", {
    data: { brandId: brand.id, name: `Synthetic Store North ${suffix}` },
  });
  const secondStoreResponse = await request.post("/api/v1/merchant-stores", {
    data: { brandId: brand.id, name: `Synthetic Store South ${suffix}` },
  });
  expect(firstStoreResponse.ok()).toBe(true);
  expect(secondStoreResponse.ok()).toBe(true);
  const secondStore = (await secondStoreResponse.json()) as {
    id: string;
    name: string;
  };
  const receiptResponse = await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: "Synthetic printed merchant label",
      purchaseDate: "2026-07-20",
      totalCents: 250,
      lineItems: [],
    },
  });
  const receipt = (await receiptResponse.json()) as { id: string };

  await page.goto(`/receipts/${receipt.id}`);
  await page.getByLabel("Brand").focus();
  await page.getByLabel("Brand").selectOption(brand.id);
  await page.getByLabel("Store").selectOption(secondStore.id);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Receipt saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Merchant")).toHaveValue(
    "Synthetic printed merchant label",
  );
  await expect(page.getByLabel("Brand")).toHaveValue(brand.id);
  await expect(page.getByLabel("Store")).toHaveValue(secondStore.id);
});

test("creates a category hierarchy and bulk assigns receipt lines", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const parentName = `Synthetic Food ${suffix}`;
  const childName = `Synthetic Bakery ${suffix}`;

  await page.goto("/categories");
  await page.locator("#category-name").fill(parentName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Category created.")).toBeVisible();
  await page.locator("#category-name").fill(childName);
  await page.locator("#category-parent").selectOption({ label: parentName });
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(`${parentName} → ${childName}`)).toBeVisible();

  const receiptResponse = await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: "Synthetic Category Markt",
      purchaseDate: "2026-07-30",
      totalCents: 300,
      lineItems: [
        { description: "Synthetic first", lineTotalCents: 100 },
        { description: "Synthetic second", lineTotalCents: 200 },
      ],
    },
  });
  const receipt = (await receiptResponse.json()) as { id: string };
  await page.goto(`/receipts/${receipt.id}`);
  await page.getByRole("checkbox", { name: "Item 1" }).check();
  await page.getByRole("checkbox", { name: "Item 2" }).check();
  await page
    .getByLabel("Category for selected items")
    .selectOption({ label: `${parentName} → ${childName}` });
  await page.getByRole("button", { name: "Apply to 2" }).click();
  await expect(
    page.getByLabel("Category", { exact: true }).first(),
  ).not.toHaveValue("");
  await expect(
    page.getByLabel("Category", { exact: true }).nth(1),
  ).not.toHaveValue("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Receipt saved.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Category", { exact: true }).first(),
  ).not.toHaveValue("");
  await expect(
    page.getByLabel("Category", { exact: true }).nth(1),
  ).not.toHaveValue("");
});

test("remembers, suggests, replaces, and repairs an exact category rule", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const description = `Synthetic exact item ${suffix}`;
  const firstCategoryResponse = await request.post("/api/v1/categories", {
    data: { name: `Synthetic rule A ${suffix}`, parentId: null },
  });
  const secondCategoryResponse = await request.post("/api/v1/categories", {
    data: { name: `Synthetic rule B ${suffix}`, parentId: null },
  });
  const firstCategory = (await firstCategoryResponse.json()) as {
    id: string;
    name: string;
  };
  const secondCategory = (await secondCategoryResponse.json()) as {
    id: string;
    name: string;
  };
  const makeReceipt = async () => {
    const response = await request.post("/api/v1/receipts", {
      data: {
        merchantRaw: "Synthetic Rule Markt",
        purchaseDate: "2026-07-31",
        totalCents: 100,
        lineItems: [{ description, lineTotalCents: 100 }],
      },
    });
    return (await response.json()) as { id: string };
  };

  const corrected = await makeReceipt();
  await page.goto(`/receipts/${corrected.id}`);
  await page
    .getByLabel("Category", { exact: true })
    .selectOption(firstCategory.id);
  await page.getByRole("button", { name: "Remember", exact: true }).click();
  await expect(
    page.getByText("Rule remembered for future receipts."),
  ).toBeVisible();

  const future = await makeReceipt();
  await page.goto(`/receipts/${future.id}`);
  await expect(
    page.getByText(`Suggested: ${firstCategory.name} · global`),
  ).toBeVisible();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Adopt suggestion" }).click();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue(
    firstCategory.id,
  );

  await page
    .getByLabel("Category", { exact: true })
    .selectOption(secondCategory.id);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remember", exact: true }).click();
  await expect(
    page.getByText("Existing rule replaced after confirmation."),
  ).toBeVisible();

  await request.post(`/api/v1/categories/${secondCategory.id}/archive`);
  await page.goto("/category-rules");
  await page.getByLabel("Validity").selectOption("invalid");
  await expect(
    page.getByText(/Needs repair: Target category is archived/),
  ).toBeVisible();
  await page.getByLabel("Repair target").selectOption(firstCategory.id);
  await expect(page.getByText("Rule updated.")).toBeVisible();
});
