import { describe, expect, it } from "vitest";
import {
  requestId,
  safeError,
  safeProviderOrigin,
  sensitiveBody,
} from "./index.js";

describe("privacy-safe logging helpers", () => {
  it.each(["", "has space", "slash/value", "ü", "x".repeat(65)])(
    "replaces invalid request ID %j",
    (value) => expect(requestId(value)).toMatch(/^[a-f0-9-]{36}$/),
  );

  it("preserves a valid bounded request ID", () => {
    expect(requestId("request_1.safe-id")).toBe("request_1.safe-id");
  });

  it("selects safe errors and provider origins", () => {
    const error = Object.assign(new Error("SECRET_MARKER"), { code: "EACCES" });
    expect(safeError(error)).toEqual({
      error_class: "Error",
      error_code: "EACCES",
    });
    expect(JSON.stringify(safeError(error))).not.toContain("SECRET_MARKER");
    expect(safeProviderOrigin("https://provider.example/v1?secret=x")).toBe(
      "https://provider.example",
    );
    expect(safeProviderOrigin("file:///secret")).toBeUndefined();
  });

  it("caps and marks explicitly sensitive provider text", () => {
    expect(sensitiveBody("abcdef", 3)).toEqual({
      sensitive_provider_error_body: "abc",
      sensitive_provider_error_bytes: 6,
      sensitive_provider_error_truncated: true,
    });
  });
});
