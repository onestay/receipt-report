import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { createDatabase } from "../../packages/database/src/index.js";

function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function syntheticPng(seed: string) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const color = seed
    .split("")
    .reduce((sum, value) => sum + value.charCodeAt(0), 0);
  const pixels = Buffer.from([
    0,
    color % 256,
    (color * 3) % 256,
    (color * 7) % 256,
    255,
  ]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createWithDocument(request: APIRequestContext, suffix: string) {
  const created = await request.post("/api/v1/receipts", {
    data: {
      merchantRaw: `Canonical ${suffix}`,
      purchaseDate: "2026-07-31",
      totalCents: 100,
      lineItems: [],
    },
  });
  expect(created.ok()).toBe(true);
  const receipt = (await created.json()) as { id: string };
  const uploaded = await request.post(
    `/api/v1/receipts/${receipt.id}/document`,
    {
      multipart: {
        document: {
          name: `${suffix}.png`,
          mimeType: "image/png",
          buffer: syntheticPng(suffix),
        },
      },
    },
  );
  if (!uploaded.ok()) throw new Error(await uploaded.text());
  const document = (await uploaded.json()) as { id: string };
  return { receiptId: receipt.id, documentId: document.id };
}

async function waitForStatus(
  request: APIRequestContext,
  receiptId: string,
  expected: string,
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/v1/receipts/${receiptId}/document/extraction`,
        );
        return response.ok()
          ? ((await response.json()) as { status: string }).status
          : "missing";
      },
      { timeout: 20_000 },
    )
    .toBe(expected);
}

async function evidence(page: Page, name: string) {
  if (!process.env.CAPTURE_UI_EVIDENCE) return;
  await page.screenshot({
    path: resolve(`docs/screenshots/issue-39/${name}.png`),
    fullPage: true,
  });
}

async function modelCategoryEvidence(page: Page) {
  if (!process.env.CAPTURE_UI_EVIDENCE) return;
  await page.screenshot({
    path: resolve("docs/screenshots/issue-56/model-category-review.png"),
    fullPage: true,
  });
}

test("reviews automatic extraction, approves edits, and preserves later human edits", async ({
  page,
  request,
}) => {
  const { receiptId } = await createWithDocument(request, "review");
  await waitForStatus(request, receiptId, "succeeded");
  const database = await createDatabase(`file:${resolve(".runtime/e2e.db")}`);
  const rememberedCategory = await database.category.create({
    data: {
      name: "Remembered groceries",
      normalizedName: `remembered groceries ${receiptId}`,
      position: 900,
    },
  });
  const rememberedCategoryId = rememberedCategory.id;
  try {
    const proposal = await database.extractionProposal.findFirstOrThrow({
      where: { receiptId, status: "pending" },
    });
    await database.$transaction([
      database.extractionFinding.deleteMany({
        where: { proposalId: proposal.id },
      }),
      database.extractionProposal.update({
        where: { id: proposal.id },
        data: {
          snapshot: JSON.stringify({
            merchantRaw: "",
            merchantConfidence: null,
            merchantBrandId: null,
            merchantStoreId: null,
            purchaseDate: "",
            purchaseDateConfidence: null,
            purchaseTime: null,
            purchaseTimeConfidence: null,
            currency: "EUR",
            totalCents: 100,
            totalConfidence: 0.91,
            netCents: null,
            taxCents: null,
            lineItems: [
              {
                sourcePosition: 0,
                description: "Synthetic apple",
                descriptionConfidence: 0.48,
                quantityMilli: 1000,
                unitPriceCents: 90,
                lineTotalCents: 90,
                categoryId: rememberedCategoryId,
                categoryConfidence: 0.65,
                categorySuggestion: null,
                categoryProvenance: "model",
                kind: "unknown",
              },
            ],
          }),
        },
      }),
      database.extractionFinding.createMany({
        data: [
          {
            proposalId: proposal.id,
            code: "required_merchant",
            severity: "blocking",
            fieldPath: "merchantRaw",
            message: "Merchant is required",
          },
          {
            proposalId: proposal.id,
            code: "invalid_purchase_date",
            severity: "blocking",
            fieldPath: "purchaseDate",
            message: "Purchase date is invalid",
          },
          {
            proposalId: proposal.id,
            code: "line_sum_mismatch",
            severity: "warning",
            fieldPath: "totalCents",
            message: "Line sum differs from receipt total",
          },
          {
            proposalId: proposal.id,
            code: "low_confidence",
            severity: "info",
            fieldPath: "lineItems.0.description",
            message: "Provider confidence is low",
          },
          {
            proposalId: proposal.id,
            code: "low_category_confidence",
            severity: "info",
            fieldPath: "lineItems.0.categoryId",
            message: "Provider category confidence is low",
          },
        ],
      }),
    ]);
  } finally {
    await database.$disconnect();
  }
  await page.goto(`/receipts/${receiptId}`);
  const review = page.getByRole("region", { name: "AI review" });
  await expect(review.getByText("Needs review")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    review.getByRole("button", { name: /Merchant is required/ }),
  ).toBeVisible();
  await expect(review.getByText("Source: model")).toBeVisible();
  await expect(review.getByText("65% confidence")).toBeVisible();
  await modelCategoryEvidence(page);
  await evidence(page, "desktop-needs-review-findings");

  await review.getByLabel("Merchant").fill("Reviewed Markt");
  await review.getByLabel("Purchase date").fill("2026-07-31");
  await review.getByLabel("Gross total").fill("1,00");
  await review.getByLabel("Line total").fill("1,00");
  await review.getByLabel("Kind").selectOption("item");
  await review.getByLabel("Category").selectOption(rememberedCategoryId);
  await expect(review.getByText("Source: manual edit")).toBeVisible();
  page.on("dialog", (dialog) =>
    dialog.type() === "prompt" ? dialog.accept("global") : dialog.accept(),
  );
  await review.getByRole("button", { name: "Remember for future" }).click();
  await expect(
    review.getByText(
      "Category rule remembered locally for future extractions.",
    ),
  ).toBeVisible();
  await review.getByLabel(/I reviewed line sum mismatch/).check();
  await review.getByRole("button", { name: "Approve reviewed values" }).click();
  await expect(
    review.getByText("Human-reviewed data is authoritative."),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("Merchant").first()).toHaveValue(
    "Reviewed Markt",
  );
  await evidence(page, "desktop-approved");

  const feedbackDatabase = await createDatabase(
    `file:${resolve(".runtime/e2e.db")}`,
  );
  try {
    await expect(
      feedbackDatabase.categorySuggestionRule.count({
        where: {
          normalizedDescription: "synthetic apple",
          categoryId: rememberedCategoryId,
          scopeKind: "global",
        },
      }),
    ).resolves.toBe(1);
  } finally {
    await feedbackDatabase.$disconnect();
  }

  await page.getByRole("link", { name: "AI quality" }).click();
  await expect(page.getByRole("heading", { name: "AI quality" })).toBeVisible();
  await expect(page.getByText(/proposed fields/)).toBeVisible();
  await evidence(page, "desktop-quality-feedback");
  await page.goto(`/receipts/${receiptId}`);

  await page.getByLabel("Merchant").first().fill("Unsaved human correction");
  await review.getByRole("button", { name: "Reprocess receipt" }).click();
  await expect(page.getByLabel("Merchant").first()).toHaveValue(
    "Unsaved human correction",
  );
  await expect(review.getByText(/Approved values are unchanged/)).toBeVisible();
});

test("shows processing and provider failure, then retries", async ({
  page,
  request,
}) => {
  const { receiptId, documentId } = await createWithDocument(
    request,
    "failure",
  );
  await waitForStatus(request, receiptId, "succeeded");
  await page.route(
    `**/api/v1/receipts/${receiptId}/document/extraction`,
    async (route) =>
      route.fulfill({
        json: {
          documentId,
          normalizationRevision: "synthetic-revision",
          status: "running",
          attempts: 1,
          maxAttempts: 3,
          availableAt: "2026-07-31T12:00:00.000Z",
          lastErrorKind: null,
          currentAttempt: null,
        },
      }),
  );
  await page.goto(`/receipts/${receiptId}`);
  const review = page.getByRole("region", { name: "AI review" });
  await expect(review.locator(".ai-badge")).toHaveText("Processing");
  await evidence(page, "desktop-processing");
  await page.unroute(`**/api/v1/receipts/${receiptId}/document/extraction`);

  const database = await createDatabase(`file:${resolve(".runtime/e2e.db")}`);
  try {
    await database.extractionJob.updateMany({
      where: { documentId },
      data: { status: "failed", lastErrorKind: "provider_unavailable" },
    });
  } finally {
    await database.$disconnect();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(review.getByText("Extraction needs attention")).toBeVisible();
  await evidence(page, "mobile-failure");
  await review.getByRole("button", { name: "Retry extraction" }).click();
  await expect(review.getByText("Needs review")).toBeVisible({
    timeout: 20_000,
  });
  await evidence(page, "mobile-needs-review");
});
