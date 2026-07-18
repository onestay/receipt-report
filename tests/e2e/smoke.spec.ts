import { expect, test } from "@playwright/test";

test("renders the real web and API stack", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Receipt Report" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Local API connected");
});
