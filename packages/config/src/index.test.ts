import { describe, expect, it } from "vitest";
import { parseApiConfig, parseWorkerConfig } from "./index.js";

const shared = { DATABASE_URL: "file:./test.db", STORAGE_PATH: "./storage" };

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
});
