import { describe, expect, it } from "vitest";
import { createFakeReceiptExtractor } from "./index.js";

describe("fake receipt extractor", () => {
  it("returns deterministic validated output", async () => {
    const extractor = createFakeReceiptExtractor({
      documentId: "doc-1",
      provider: "test",
      rawText: "synthetic",
    });
    await expect(
      extractor.extract({
        documentId: "doc-1",
        pageImagePaths: ["page-1.png"],
      }),
    ).resolves.toMatchObject({
      rawText: "synthetic",
    });
  });

  it("rejects a mismatched document", async () => {
    const extractor = createFakeReceiptExtractor({
      documentId: "doc-1",
      provider: "test",
      rawText: "",
    });
    await expect(
      extractor.extract({ documentId: "doc-2", pageImagePaths: ["page.png"] }),
    ).rejects.toThrow("does not match");
  });
});
