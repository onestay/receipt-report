import { expect, test } from "@playwright/test";

test("creates a receipt through the real stack and supports direct routes", async ({
  page,
}) => {
  await page.goto("/receipts");
  await expect(
    page.getByRole("heading", { name: "Purchases, clearly kept." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Add a receipt" }).click();
  await page.getByLabel("Merchant").fill("Synthetic Browser Markt");
  await page.getByLabel("Purchase date").fill("2026-07-19");
  await page.getByLabel("Total").fill("12,34");
  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(page).toHaveURL(/\/receipts\/[a-z0-9]+$/);
  await expect(
    page.getByRole("heading", { name: "Ready for detail." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ready for detail." }),
  ).toBeVisible();
});

test("mobile navigation has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/receipts/new");
  await expect(page.getByRole("link", { name: "New receipt" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
