import { describe, expect, it } from "vitest";
import {
  GERMAN_RECEIPT_PROFILE_VERSION,
  createOpenAiCompatibleReceiptExtractor,
} from "./index.js";

/**
 * The provider compiles a `strict` schema into a grammar and rejects the
 * request when that grammar is too large. The threshold is provider-side and
 * undocumented, so the unit tests can only assert the structural property that
 * was observed to cross it. This is the check against the real limit.
 *
 * Opt in, because it spends tokens and needs network:
 *   RECEIPT_AI_LIVE_SCHEMA_CHECK=1 EXTRACTION_API_KEY=... pnpm vitest run \
 *     packages/receipt-ai/src/provider-schema.live.test.ts
 *
 * One request, capped at 16 output tokens. The schema itself dominates the
 * input, so a run costs well under a cent. Grammar compilation is what makes
 * it slow (single-digit seconds) rather than what makes it expensive.
 */
const apiKey = process.env.EXTRACTION_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const enabled = process.env.RECEIPT_AI_LIVE_SCHEMA_CHECK === "1" && !!apiKey;

describe.skipIf(!enabled)("provider strict-schema acceptance (live)", () => {
  it("accepts the schema at the maximum category-option count", async () => {
    const baseUrl =
      process.env.EXTRACTION_BASE_URL ?? "https://api.anthropic.com/v1";
    const model = process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6";

    // `categoryContext()` in the worker drops the options entirely past 500, so
    // 500 is the largest enum that ever reaches the provider.
    const categoryOptions = Array.from({ length: 500 }, (_, index) => ({
      token: `c${index}`,
      categoryId: `category-${index}`,
      path: `Lebensmittel > Kategorie ${index}`,
    }));

    let schema: unknown;
    const extractor = createOpenAiCompatibleReceiptExtractor({
      baseUrl,
      model,
      apiKey: apiKey ?? "",
      timeoutMs: 60_000,
      maxPages: 1,
      maxImageBytes: 1_000,
      maxResponseBytes: 100_000,
      profileVersion: GERMAN_RECEIPT_PROFILE_VERSION,
      // Capture the schema the adapter builds, then post it separately so the
      // assertion covers exactly what production sends.
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format: { json_schema: { schema: unknown } };
        };
        schema = body.response_format.json_schema.schema;
        return new Response("{}", { status: 500 });
      },
    });
    await extractor
      .extract({
        documentId: "live-schema-check",
        pages: [
          {
            position: 0,
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
        categoryOptions,
      })
      .catch(() => undefined);
    expect(schema).toBeDefined();

    const response = await fetch(new URL("chat/completions", `${baseUrl}/`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Return an empty receipt." }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "german_receipt_extraction",
            strict: true,
            schema,
          },
        },
      }),
    });

    const text = await response.text();
    expect(
      response.ok,
      `provider rejected the strict schema: ${text.slice(0, 500)}`,
    ).toBe(true);
  }, 120_000);
});
