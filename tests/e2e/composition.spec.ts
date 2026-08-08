import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function category(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/categories", {
    data: { name, parentId: null },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function receipt(
  request: APIRequestContext,
  suffix: string,
  totalCents: number,
  taxCents: number | null,
  lineItems: {
    description: string;
    lineTotalCents: number;
    categoryId: string | null;
    kind?: "item" | "discount" | "return";
  }[],
) {
  const response = await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: `Synthetic Composition ${suffix}`,
      purchaseDate: "2026-06-15",
      totalCents,
      taxCents,
      lineItems,
    },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function capture(
  page: Page,
  receiptId: string,
  name: string,
  expectedLegendItems?: number,
) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/receipts/${receiptId}`);
  const composition = page.getByRole("region", { name: "Receipt composition" });
  await expect(composition).toBeVisible();
  if (expectedLegendItems !== undefined)
    await expect(composition.locator(".composition-legend > li")).toHaveCount(
      expectedLegendItems,
    );
  await page.screenshot({
    path: `docs/screenshots/issue-61/desktop-${name}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: `docs/screenshots/issue-61/mobile-${name}.png`,
    fullPage: true,
  });
}

test("renders accessible receipt composition states at desktop and mobile", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const threeIds: string[] = [];
  for (const name of ["Food", "Household", "Health"])
    threeIds.push(await category(request, `${name} ${suffix}`));
  const threeReceipt = await receipt(request, `three ${suffix}`, 1000, 190, [
    {
      description: "Synthetic food",
      lineTotalCents: 500,
      categoryId: threeIds[0] ?? null,
    },
    {
      description: "Synthetic household",
      lineTotalCents: 300,
      categoryId: threeIds[1] ?? null,
    },
    {
      description: "Synthetic health",
      lineTotalCents: 200,
      categoryId: threeIds[2] ?? null,
    },
  ]);
  await capture(page, threeReceipt, "three-categories", 3);

  const manyIds: string[] = [];
  for (let index = 0; index < 12; index += 1)
    manyIds.push(await category(request, `Composition ${index + 1} ${suffix}`));
  const manyReceipt = await receipt(
    request,
    `many ${suffix}`,
    6000,
    null,
    manyIds.map((categoryId, index) => ({
      description: `Synthetic line ${index + 1}`,
      lineTotalCents: index === 11 ? -100 : (11 - index) * 100,
      categoryId,
      kind: index === 11 ? ("return" as const) : ("item" as const),
    })),
  );
  await capture(page, manyReceipt, "many-negative-adjustment", 6);
  const reductions = page.getByRole("heading", {
    name: "Reductions and adjustments",
  });
  await expect(reductions).toBeVisible();
  await expect(page.getByText("Other contains 6 categories")).toBeVisible();

  const emptyReceipt = await receipt(request, `empty ${suffix}`, 0, null, []);
  await capture(page, emptyReceipt, "empty", 0);
  await expect(
    page.getByText("No positive composition to chart."),
  ).toBeVisible();
});
