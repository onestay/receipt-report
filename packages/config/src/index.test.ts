import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseApiConfig, parseWorkerConfig } from "./index.js";

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
});
