import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTRACTION_SCHEMA_VERSION,
  GERMAN_RECEIPT_PROFILE_VERSION,
  ReceiptExtractionError,
  createConfiguredReceiptExtractor,
  createFakeReceiptExtractor,
  createOpenAiCompatibleReceiptExtractor,
  decimalEurosToCents,
  extractionRequestSchema,
  germanReceiptProfile,
  reconcileExtractionTotals,
  receiptExtractionSchema,
  type ExtractionRequest,
  type ReceiptExtraction,
} from "./index.js";

const missing = { value: null, confidence: null } as const;
const present = <T>(value: T, confidence = 1) => ({ value, confidence });

function validExtraction(): ReceiptExtraction {
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    profileVersion: GERMAN_RECEIPT_PROFILE_VERSION,
    merchantText: present("Synthetischer Markt"),
    purchaseDate: present("2026-07-31"),
    purchaseTime: present("12:34"),
    currency: present("EUR"),
    grossTotalCents: present(350),
    netTotalCents: missing,
    taxTotalCents: missing,
    taxBreakdowns: [],
    lineItems: [
      {
        position: 0,
        description: present("Joghurt"),
        quantityMilli: present(1000),
        unit: present("piece"),
        unitPriceCents: present(400),
        lineTotalCents: present(400),
      },
      {
        position: 1,
        description: present("Pfandrückgabe"),
        quantityMilli: present(1000),
        unit: present("piece"),
        unitPriceCents: present(-50),
        lineTotalCents: present(-50),
      },
    ],
    warnings: [],
  };
}

function lineAt(extraction: ReceiptExtraction, index: number) {
  const line = extraction.lineItems[index];
  if (!line) throw new Error(`Missing fixture line ${index}`);
  return line;
}

const request: ExtractionRequest = {
  documentId: "doc-1",
  pages: [
    {
      position: 0,
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    },
  ],
};

function result(extraction = validExtraction()) {
  return {
    documentId: "doc-1",
    provider: "test",
    model: "fixture-v1",
    rawProviderOutput: "synthetic raw output",
    structured: extraction,
  };
}

describe("receipt extraction schema", () => {
  it.each([
    ["12", 1200],
    ["12,3", 1230],
    ["12.34", 1234],
    ["-0,50", -50],
  ])("converts decimal euros %s to integer cents", (input, expected) => {
    expect(decimalEurosToCents(input)).toBe(expected);
  });

  it.each(["1.234", "NaN", "1e3", "9007199254740991.00"])(
    "rejects unsafe or ambiguous decimal money %s",
    (input) => {
      expect(() => decimalEurosToCents(input)).toThrowError(
        "Receipt extraction failed: malformed_response",
      );
    },
  );

  it("accepts signed German receipt lines and weighted quantities", () => {
    const extraction = validExtraction();
    extraction.lineItems[0] = {
      ...lineAt(extraction, 0),
      description: present("Käse 1,235 kg"),
      quantityMilli: present(1235),
      unit: present("kg"),
    };
    expect(receiptExtractionSchema.parse(extraction)).toEqual(extraction);
    expect(extraction.lineItems[1]?.lineTotalCents.value).toBe(-50);
    expect(reconcileExtractionTotals(extraction)).toEqual({
      complete: true,
      lineTotalCents: 350,
      grossDeltaCents: 0,
    });
  });

  it("reports incomplete line reconciliation without treating missing as zero", () => {
    const extraction = validExtraction();
    lineAt(extraction, 0).lineTotalCents = missing;
    expect(reconcileExtractionTotals(extraction)).toEqual({
      complete: false,
      lineTotalCents: null,
      grossDeltaCents: null,
    });
  });

  it.each([
    [
      "invalid date",
      (value: ReceiptExtraction) =>
        (value.purchaseDate = present("2026-02-30")),
    ],
    [
      "non-EUR currency",
      (value: ReceiptExtraction) => (value.currency = present("USD" as "EUR")),
    ],
    [
      "fractional cents",
      (value: ReceiptExtraction) => (value.grossTotalCents = present(1.5)),
    ],
    [
      "negative receipt total",
      (value: ReceiptExtraction) => (value.grossTotalCents = present(-1)),
    ],
    [
      "zero quantity",
      (value: ReceiptExtraction) =>
        (lineAt(value, 0).quantityMilli = present(0)),
    ],
    [
      "unsafe quantity",
      (value: ReceiptExtraction) =>
        (lineAt(value, 0).quantityMilli = present(Number.MAX_SAFE_INTEGER + 1)),
    ],
    [
      "unsupported unit",
      (value: ReceiptExtraction) =>
        (lineAt(value, 0).unit = present("box" as "piece")),
    ],
    [
      "negative confidence",
      (value: ReceiptExtraction) =>
        (value.merchantText = present("Markt", -0.1)),
    ],
    [
      "infinite confidence",
      (value: ReceiptExtraction) =>
        (value.merchantText = present("Markt", Number.POSITIVE_INFINITY)),
    ],
    [
      "non-contiguous line position",
      (value: ReceiptExtraction) => (lineAt(value, 1).position = 2),
    ],
  ])("rejects %s", (_name, mutate) => {
    const extraction = validExtraction();
    mutate(extraction);
    expect(receiptExtractionSchema.safeParse(extraction).success).toBe(false);
  });

  it("distinguishes missing fields from low-confidence fields", () => {
    const extraction = validExtraction();
    extraction.merchantText = missing;
    extraction.purchaseDate = present("2026-07-31", 0);
    expect(receiptExtractionSchema.parse(extraction)).toMatchObject({
      merchantText: missing,
      purchaseDate: { confidence: 0 },
    });

    extraction.merchantText = { value: null, confidence: 0 };
    expect(receiptExtractionSchema.safeParse(extraction).success).toBe(false);
    extraction.merchantText = { value: "Markt", confidence: null };
    expect(receiptExtractionSchema.safeParse(extraction).success).toBe(false);
  });

  it("validates ordered normalized pages", () => {
    expect(extractionRequestSchema.parse(request)).toEqual(request);
    expect(
      extractionRequestSchema.safeParse({
        ...request,
        pages: [{ ...request.pages[0], position: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("fake receipt extractor", () => {
  it("returns a defensive deterministic copy", async () => {
    const extractor = createFakeReceiptExtractor(result());
    const first = await extractor.extract(request);
    first.structured.warnings.push("mutated");
    await expect(extractor.extract(request)).resolves.toMatchObject({
      rawProviderOutput: "synthetic raw output",
      structured: { warnings: [] },
    });
  });

  it("rejects a mismatched document", async () => {
    const extractor = createFakeReceiptExtractor(result());
    await expect(
      extractor.extract({ ...request, documentId: "doc-2" }),
    ).rejects.toThrow("does not match");
  });
});

type CapturedRequest = { url: string; headers: Headers; body: string };
let server: Server | undefined;

afterEach(async () => {
  vi.useRealTimers();
  const runningServer = server;
  if (runningServer)
    await new Promise<void>((resolve) => runningServer.close(() => resolve()));
  server = undefined;
});

async function fakeProvider(
  handler: (captured: CapturedRequest) => { status?: number; body: string },
) {
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const captured = {
        url: incoming.url ?? "",
        headers: new Headers(incoming.headers as Record<string, string>),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const output = handler(captured);
      response.statusCode = output.status ?? 200;
      response.setHeader("content-type", "application/json");
      response.end(output.body);
    });
  });
  const runningServer = server;
  await new Promise<void>((resolve) =>
    runningServer.listen(0, "127.0.0.1", resolve),
  );
  const address = runningServer.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}/v1/`;
}

function providerEnvelope(extraction: unknown): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(extraction) } }],
  });
}

function adapter(baseUrl: string, overrides = {}) {
  return createOpenAiCompatibleReceiptExtractor({
    baseUrl,
    model: "synthetic-vision",
    apiKey: "top-secret-test-key",
    timeoutMs: 1000,
    maxPages: 2,
    maxImageBytes: 100,
    maxResponseBytes: 100_000,
    profileVersion: GERMAN_RECEIPT_PROFILE_VERSION,
    ...overrides,
  });
}

describe("OpenAI-compatible adapter", () => {
  it("selects an adapter from validated configuration", () => {
    const configured = createConfiguredReceiptExtractor(
      {
        EXTRACTION_PROVIDER: "fake",
        EXTRACTION_PROFILE_VERSION: GERMAN_RECEIPT_PROFILE_VERSION,
        EXTRACTION_TIMEOUT_MS: 1000,
        EXTRACTION_MAX_PAGES: 2,
        EXTRACTION_MAX_IMAGE_BYTES: 100,
        EXTRACTION_MAX_RESPONSE_BYTES: 1000,
      },
      { fakeResult: result() },
    );
    expect(configured.name).toBe("fake");
    expect(() =>
      createConfiguredReceiptExtractor({
        EXTRACTION_PROVIDER: "fake",
        EXTRACTION_PROFILE_VERSION: GERMAN_RECEIPT_PROFILE_VERSION,
        EXTRACTION_TIMEOUT_MS: 1000,
        EXTRACTION_MAX_PAGES: 2,
        EXTRACTION_MAX_IMAGE_BYTES: 100,
        EXTRACTION_MAX_RESPONSE_BYTES: 1000,
      }),
    ).toThrowError("Receipt extraction failed: configuration");

    const remote = createConfiguredReceiptExtractor(
      {
        EXTRACTION_PROVIDER: "openai-compatible",
        EXTRACTION_BASE_URL: "https://provider.invalid/v1/",
        EXTRACTION_MODEL: "vision-model",
        EXTRACTION_API_KEY: "secret",
        EXTRACTION_PROFILE_VERSION: GERMAN_RECEIPT_PROFILE_VERSION,
        EXTRACTION_TIMEOUT_MS: 1000,
        EXTRACTION_MAX_PAGES: 2,
        EXTRACTION_MAX_IMAGE_BYTES: 100,
        EXTRACTION_MAX_RESPONSE_BYTES: 1000,
      },
      { fetch: vi.fn<typeof fetch>() },
    );
    expect(remote.name).toBe("openai-compatible");
  });

  it("maps normalized images to a pinned structured-output request", async () => {
    let captured: CapturedRequest | undefined;
    const baseUrl = await fakeProvider((incoming) => {
      captured = incoming;
      return { body: providerEnvelope(validExtraction()) };
    });
    const firstPage = request.pages[0];
    if (!firstPage) throw new Error("Missing fixture page");
    const multiPageRequest: ExtractionRequest = {
      ...request,
      pages: [
        firstPage,
        {
          position: 1,
          mediaType: "image/jpeg",
          bytes: new Uint8Array([4, 5, 6]),
        },
      ],
    };
    const output = await adapter(baseUrl).extract(multiPageRequest);
    expect(output.structured.lineItems[1]?.lineTotalCents.value).toBe(-50);
    expect(output.rawProviderOutput).toContain("choices");
    expect(captured?.url).toBe("/v1/chat/completions");
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer top-secret-test-key",
    );
    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "synthetic-vision",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "german_receipt_extraction",
          strict: true,
        },
      },
    });
    expect(captured?.body).toContain("data:image/png;base64,AQID");
    expect(captured?.body).toContain("data:image/jpeg;base64,BAUG");
    expect(captured?.body).toContain(GERMAN_RECEIPT_PROFILE_VERSION);
    expect(germanReceiptProfile.systemPrompt).toContain("Erfinde keine");
  });

  it("rejects page and byte limits before calling the provider", async () => {
    const transport = vi.fn<typeof fetch>();
    const extractor = adapter("https://provider.invalid/v1/", {
      fetch: transport,
      maxPages: 1,
      maxImageBytes: 2,
    });
    await expect(extractor.extract(request)).rejects.toMatchObject({
      kind: "payload_too_large",
      retryable: false,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication", false],
    [403, "authentication", false],
    [429, "rate_limit", true],
    [503, "provider_unavailable", true],
    [400, "provider_unavailable", false],
  ])("classifies HTTP %i", async (status, kind, retryable) => {
    const baseUrl = await fakeProvider(() => ({ status, body: "secret body" }));
    await expect(adapter(baseUrl).extract(request)).rejects.toMatchObject({
      kind,
      retryable,
      message: `Receipt extraction failed: ${kind}`,
    });
  });

  it.each([
    ["invalid envelope", JSON.stringify({ choices: [] })],
    ["invalid JSON", "not-json"],
    ["invalid structured output", providerEnvelope({ invented: true })],
  ])("classifies %s without leaking provider output", async (_name, body) => {
    const baseUrl = await fakeProvider(() => ({ body }));
    const error = await adapter(baseUrl)
      .extract(request)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ReceiptExtractionError);
    expect(error).toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
    expect(String(error)).not.toContain(body);
    expect(String(error)).not.toContain("top-secret-test-key");
  });

  it("enforces the response byte limit", async () => {
    const baseUrl = await fakeProvider(() => ({ body: "x".repeat(100) }));
    await expect(
      adapter(baseUrl, { maxResponseBytes: 10 }).extract(request),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("stops an undeclared streaming response at the byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(11));
        controller.enqueue(new Uint8Array(11));
      },
    });
    const extractor = adapter("https://provider.invalid/v1/", {
      maxResponseBytes: 10,
      fetch: async () => new Response(stream, { status: 200 }),
    });
    await expect(extractor.extract(request)).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
  });

  it("classifies timeout and transport failures without leaking causes", async () => {
    const timeoutExtractor = adapter("https://provider.invalid/v1/", {
      timeoutMs: 1,
      fetch: (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("secret")),
          );
        }),
    });
    await expect(timeoutExtractor.extract(request)).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });

    const bodyTimeout = adapter("https://provider.invalid/v1/", {
      timeoutMs: 1,
      fetch: async (_input: URL | RequestInfo, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new Error("secret body error")),
            );
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    await expect(bodyTimeout.extract(request)).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
      message: "Receipt extraction failed: timeout",
    });

    const unavailable = adapter("https://provider.invalid/v1/", {
      fetch: async () => {
        throw new Error("provider secret");
      },
    });
    await expect(unavailable.extract(request)).rejects.toMatchObject({
      kind: "provider_unavailable",
      retryable: true,
      message: "Receipt extraction failed: provider_unavailable",
    });
  });

  it("rejects invalid configuration without exposing values", () => {
    expect(() => adapter("not-a-url")).toThrowError(
      "Receipt extraction failed: configuration",
    );
    expect(() => adapter("not-a-url")).not.toThrow("top-secret-test-key");
    expect(() => adapter("file:///tmp/provider")).toThrowError(
      "Receipt extraction failed: configuration",
    );
  });
});
