import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  parseApiConfig,
  parseReceiptAiConfig,
  parseWorkerConfig,
} from "./index.js";

const shared = {
  DATABASE_URL: "file:/tmp/receipt-report/test.db",
  STORAGE_PATH: "/tmp/receipt-report/documents",
};

describe("configuration", () => {
  it("applies API defaults", () => {
    expect(parseApiConfig(shared)).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 3000,
      ...shared,
    });
  });

  it("coerces a valid API port", () => {
    expect(parseApiConfig({ ...shared, PORT: "4321" }).PORT).toBe(4321);
  });

  it("rejects an invalid external database URL", () => {
    expect(() =>
      parseApiConfig({ ...shared, DATABASE_URL: "postgres://example" }),
    ).toThrow();
  });

  it("requires a worker readiness file", () => {
    expect(() => parseWorkerConfig(shared)).toThrow();
    expect(
      parseWorkerConfig({ ...shared, WORKER_READY_FILE: "./ready" })
        .WORKER_READY_FILE,
    ).toBe("./ready");
  });

  it("applies bounded extraction worker defaults", () => {
    expect(
      parseWorkerConfig({ ...shared, WORKER_READY_FILE: "./ready" }),
    ).toMatchObject({
      EXTRACTION_MAX_ATTEMPTS: 5,
      EXTRACTION_POLL_MS: 500,
      EXTRACTION_LEASE_MS: 120_000,
      EXTRACTION_RETRY_BASE_MS: 1_000,
      EXTRACTION_RETRY_MAX_MS: 60_000,
      EXTRACTION_RETRY_AFTER_MAX_MS: 300_000,
      EXTRACTION_RETRY_JITTER_PERCENT: 20,
      EXTRACTION_RAW_RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it("rejects an extraction retry cap below its base delay", () => {
    expect(() =>
      parseWorkerConfig({
        ...shared,
        WORKER_READY_FILE: "./ready",
        EXTRACTION_RETRY_BASE_MS: "2000",
        EXTRACTION_RETRY_MAX_MS: "1000",
      }),
    ).toThrow();
  });

  it.each(["", "relative", "/"])(
    "rejects unsafe storage root %j",
    (STORAGE_PATH) => {
      expect(() => parseApiConfig({ ...shared, STORAGE_PATH })).toThrow();
    },
  );

  it("rejects the database directory and invalid limits", () => {
    expect(() =>
      parseApiConfig({ ...shared, STORAGE_PATH: "/tmp/receipt-report" }),
    ).toThrow();
    expect(() =>
      parseApiConfig({ ...shared, DOCUMENT_MAX_BYTES: "0" }),
    ).toThrow();
    expect(() =>
      parseApiConfig({
        ...shared,
        DOCUMENT_MAX_BYTES: "1024",
        DOCUMENT_MAX_REQUEST_BYTES: "1024",
      }),
    ).toThrow();
    expect(() =>
      parseApiConfig({
        ...shared,
        NORMALIZATION_MAX_PAGE_PIXELS: "101",
        NORMALIZATION_MAX_TOTAL_PIXELS: "100",
      }),
    ).toThrow();
  });

  it("parses renderer verification explicitly", () => {
    expect(
      parseWorkerConfig({ ...shared, WORKER_READY_FILE: "ready" })
        .NORMALIZATION_VERIFY_RENDERER,
    ).toBe(true);
    expect(
      parseWorkerConfig({
        ...shared,
        WORKER_READY_FILE: "ready",
        NORMALIZATION_VERIFY_RENDERER: "false",
      }).NORMALIZATION_VERIFY_RENDERER,
    ).toBe(false);
    expect(() =>
      parseWorkerConfig({
        ...shared,
        WORKER_READY_FILE: "ready",
        NORMALIZATION_VERIFY_RENDERER: "yes",
      }),
    ).toThrow();
  });

  it("rejects overlap with a relative SQLite URL", () => {
    expect(() =>
      parseApiConfig({
        ...shared,
        DATABASE_URL: "file:.runtime/relative.db",
        STORAGE_PATH: resolve(".runtime"),
      }),
    ).toThrow();
  });

  it("defaults receipt AI to the local deterministic provider", () => {
    expect(parseReceiptAiConfig({})).toEqual({
      EXTRACTION_PROVIDER: "fake",
      EXTRACTION_PROFILE_VERSION: "de-receipt-v1",
      EXTRACTION_TIMEOUT_MS: 60_000,
      EXTRACTION_MAX_PAGES: 10,
      EXTRACTION_MAX_IMAGE_BYTES: 20 * 1024 * 1024,
      EXTRACTION_MAX_RESPONSE_BYTES: 1024 * 1024,
    });
  });

  it("validates OpenAI-compatible extraction configuration", () => {
    expect(() =>
      parseReceiptAiConfig({ EXTRACTION_PROVIDER: "openai-compatible" }),
    ).toThrow();
    expect(
      parseReceiptAiConfig({
        EXTRACTION_PROVIDER: "openai-compatible",
        EXTRACTION_BASE_URL: "https://provider.example/v1/",
        EXTRACTION_MODEL: "vision-model",
        EXTRACTION_API_KEY: "secret",
        EXTRACTION_MAX_PAGES: "2",
      }),
    ).toMatchObject({
      EXTRACTION_PROVIDER: "openai-compatible",
      EXTRACTION_BASE_URL: "https://provider.example/v1/",
      EXTRACTION_MODEL: "vision-model",
      EXTRACTION_API_KEY: "secret",
      EXTRACTION_MAX_PAGES: 2,
    });
  });

  it.each([
    ["EXTRACTION_TIMEOUT_MS", "0"],
    ["EXTRACTION_MAX_PAGES", "1.5"],
    ["EXTRACTION_MAX_IMAGE_BYTES", "-1"],
    ["EXTRACTION_MAX_RESPONSE_BYTES", "0"],
    ["EXTRACTION_PROFILE_VERSION", "future-profile"],
  ])("rejects invalid %s", (key, value) => {
    expect(() => parseReceiptAiConfig({ [key]: value })).toThrow();
  });

  it("rejects a non-HTTP provider base URL", () => {
    expect(() =>
      parseReceiptAiConfig({
        EXTRACTION_PROVIDER: "openai-compatible",
        EXTRACTION_BASE_URL: "file:///tmp/provider",
        EXTRACTION_MODEL: "vision-model",
        EXTRACTION_API_KEY: "secret",
      }),
    ).toThrow();
  });
});
