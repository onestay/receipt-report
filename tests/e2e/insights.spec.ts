import { expect, test } from "@playwright/test";

test("filters spending insights, drills down, and captures responsive states", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const categoryResponse = await request.post("/api/v1/categories", {
    data: { name: `Synthetic groceries ${suffix}`, parentId: null },
  });
  const category = (await categoryResponse.json()) as { id: string };
  const brandResponse = await request.post("/api/v1/merchant-brands", {
    data: { name: `Synthetic Insight Brand ${suffix}` },
  });
  const brand = (await brandResponse.json()) as { id: string; name: string };
  const storeResponse = await request.post("/api/v1/merchant-stores", {
    data: { brandId: brand.id, name: `Synthetic Insight Store ${suffix}` },
  });
  const store = (await storeResponse.json()) as { id: string; name: string };
  await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: `Synthetic Sorted Markt ${suffix}`,
      merchantBrandId: brand.id,
      merchantStoreId: store.id,
      purchaseDate: "2026-08-01",
      totalCents: 1250,
      netCents: 1050,
      taxCents: 200,
      lineItems: [
        {
          description: "Synthetic groceries",
          lineTotalCents: 1250,
          categoryId: category.id,
        },
      ],
    },
  });
  await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: `Synthetic Unsorted Markt ${suffix}`,
      purchaseDate: "2026-08-01",
      totalCents: 700,
      lineItems: [{ description: "Synthetic unknown", lineTotalCents: 700 }],
    },
  });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/insights?from=2026-08-01&to=2026-08-01");
  await expect(
    page.locator(".metric--primary").getByText("19,50 €", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Uncategorized" })).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/issue-41/desktop-populated.png",
    fullPage: true,
  });

  await page.getByLabel("Brand", { exact: true }).selectOption(brand.id);
  await expect(page.getByLabel("Store", { exact: true })).toContainText(
    store.name,
  );
  await page.getByLabel("Store", { exact: true }).selectOption(store.id);
  await page.getByLabel("Source").selectOption("manual");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/merchantBrandId=/);
  await expect(page).toHaveURL(/merchantStoreId=/);
  await expect(page).toHaveURL(/provenance=manual/);
  await expect(
    page.locator(".metric--primary").getByText("12,50 €", { exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.locator(".metric-grid")).toHaveCSS(
    "grid-template-columns",
    "288px",
  );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/screenshots/issue-41/mobile-populated.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/insights?from=2026-08-01&to=2026-08-01&merchantQuery=${encodeURIComponent(`Synthetic Unsorted Markt ${suffix}`)}`,
  );
  await expect(
    page.locator(".metric--primary").getByText("7,00 €", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Uncategorized" }),
  ).toHaveAttribute("href", /category=uncategorized/);
  await page.screenshot({
    path: "docs/screenshots/issue-41/desktop-uncategorized.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Uncategorized" }).click();
  await expect(page).toHaveURL(/\/receipts\?.*category=uncategorized/);
  await expect(
    page.getByRole("heading", { name: "Matching receipts" }),
  ).toBeVisible();
  await expect(
    page.getByText(`Synthetic Unsorted Markt ${suffix}`),
  ).toBeVisible();

  await page.goto("/insights?from=2025-01-01&to=2025-01-31");
  await expect(
    page.getByRole("heading", { name: "No spending in this view" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/issue-41/desktop-empty.png",
    fullPage: true,
  });

  await page.route("**/api/v1/reports/spending?**", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.goto("/insights?from=2026-08-01&to=2026-08-01");
  await expect(
    page.getByRole("heading", { name: "Insights unavailable" }),
  ).toBeVisible();
  await expect(page.locator(".metric-grid")).toHaveCount(0);
  await page.screenshot({
    path: "docs/screenshots/issue-41/desktop-error.png",
    fullPage: true,
  });
});
