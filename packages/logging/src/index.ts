import { randomUUID } from "node:crypto";
import pino, { type Logger as PinoLogger } from "pino";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogContext = Record<string, unknown>;
export type Logger = Pick<PinoLogger, LogLevel | "child">;

export function createLogger(options: {
  service: string;
  level: LogLevel;
}): Logger {
  return pino({
    level: options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "message",
    formatters: { level: (label) => ({ level: label }) },
  });
}

export function requestId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value)
    ? value
    : randomUUID();
}

export function safeError(error: unknown): LogContext {
  if (!(error instanceof Error)) return { error_class: "UnknownError" };
  const code = (error as NodeJS.ErrnoException).code;
  return {
    error_class: error.name || "Error",
    ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
      ? { error_code: code }
      : {}),
  };
}

export function safeUnexpectedError(error: unknown): LogContext {
  return safeError(error);
}

export function safeProviderOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function sensitiveBody(value: string, capBytes = 16 * 1024) {
  const bytes = new TextEncoder().encode(value);
  const truncated = bytes.byteLength > capBytes;
  const body = new TextDecoder().decode(bytes.slice(0, capBytes));
  return {
    sensitive_provider_error_body: body,
    sensitive_provider_error_bytes: bytes.byteLength,
    sensitive_provider_error_truncated: truncated,
  };
}

export const silentLogger: Logger = pino({ level: "silent" });
