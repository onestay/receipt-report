import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./index.js";

describe("healthResponseSchema", () => {
  it("accepts the public health response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        service: "receipt-report-api",
        version: "v1",
      }),
    ).toEqual({
      status: "ok",
      service: "receipt-report-api",
      version: "v1",
    });
  });

  it("rejects an invalid status", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "down",
        service: "receipt-report-api",
        version: "v1",
      }),
    ).toThrow();
  });
});
