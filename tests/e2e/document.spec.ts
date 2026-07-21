import { expect, test, type APIRequestContext } from "@playwright/test";

function syntheticPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 80] /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 120] /Contents 6 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function createReceipt(request: APIRequestContext) {
  const response = await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: `Synthetic document ${crypto.randomUUID().slice(0, 8)}`,
      purchaseDate: "2026-07-21",
      totalCents: 100,
      lineItems: [],
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string };
}

test("uploads, reviews, replaces, and removes a multi-page document", async ({
  page,
}) => {
  await page.goto("/receipts/new");
  await page.getByLabel("Merchant").fill("Synthetic Document Browser");
  await page.getByLabel("Purchase date").fill("2026-07-21");
  await page.getByLabel("Total").fill("1,00");
  await page.getByLabel(/Choose or drop/).setInputFiles({
    name: "two-pages.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPdf(),
  });
  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit receipt" }),
  ).toBeVisible();
  await expect(page.getByText("2 pages ready for review.")).toBeVisible({
    timeout: 20_000,
  });
  const figures = page.getByRole("figure");
  await expect(figures).toHaveCount(2);
  await expect(figures.nth(0)).toHaveAccessibleName("Page 1 of 2");
  await expect(figures.nth(1)).toHaveAccessibleName("Page 2 of 2");
  await figures.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(figures.nth(1)).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Open original" }),
  ).toHaveAttribute("href", /\/documents\/[^/]+\/original$/);

  await page.setViewportSize({ width: 320, height: 720 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.getByLabel(/Choose or drop/).setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "Replace document" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "current page images will be cleared",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("two-pages.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Replace document" }).click();
  await page.getByRole("button", { name: "Confirm replace" }).click();
  await expect(page.getByText("replacement.png")).toBeVisible();
  await expect(page.getByText("1 page ready for review.")).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Remove document" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "prepared pages will be removed",
  );
  await page.getByRole("button", { name: "Confirm remove" }).click();
  await expect(page.getByText("No document attached yet.")).toBeVisible();
});

test("shows failed normalization and retries it accessibly", async ({
  page,
  request,
}) => {
  const receipt = await createReceipt(request);
  const now = "2026-07-21T00:00:00.000Z";
  let status: "failed" | "pending" = "failed";
  const document = () => ({
    id: "cm22345678901234567890123",
    receiptId: receipt.id,
    originalFilename: "recover.pdf",
    mediaType: "application/pdf",
    byteSize: 1024,
    sha256: "a".repeat(64),
    createdAt: now,
    updatedAt: now,
    normalizationStatus: status,
    normalizationError: status === "failed" ? "renderer failed" : null,
    normalizationProfileVersion: null,
    normalizationRenderer: null,
    normalizationRequestedAt: now,
    normalizationStartedAt: status === "failed" ? now : null,
    normalizationCompletedAt: status === "failed" ? now : null,
    originalUrl: `/api/v1/receipts/${receipt.id}/document/original`,
    pages: [],
  });
  await page.route(
    `**/api/v1/receipts/${receipt.id}/document**`,
    async (route) => {
      if (route.request().url().endsWith("/normalization")) {
        status = "pending";
        await route.fulfill({ status: 202, json: document() });
        return;
      }
      await route.fulfill({ status: 200, json: document() });
    },
  );
  await page.goto(`/receipts/${receipt.id}`);
  const retry = page.getByRole("button", { name: "Retry page preparation" });
  await expect(retry).toBeVisible();
  await expect(
    page.getByText(/original is safe and can be retried/),
  ).toBeVisible();
  await retry.click();
  await expect(page.getByText(/Queued for page preparation/)).toBeVisible();
  await expect(retry).toHaveCount(0);
});
