import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./server.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("API server lifecycle", () => {
  it("initializes storage, WAL, listening, and shutdown", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-server-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "server.db")}`;
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    const started = await startServer({
      DATABASE_URL: databaseUrl,
      STORAGE_PATH: join(directory, "storage"),
      HOST: "127.0.0.1",
      PORT: "43127",
    });
    expect(started.server.listening).toBe(true);
    await started.stop();
    expect(started.server.listening).toBe(false);
  });
});
import { execFileSync } from "node:child_process";
