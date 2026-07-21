import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("worker process", () => {
  it("reports readiness and exits cleanly on SIGTERM", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-worker-${process.pid}-`),
    );
    const readyFile = join(directory, "worker.ready");
    const databaseUrl = `file:${join(directory, "worker.db")}`;
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    const child = spawn(
      process.execPath,
      [resolve("apps/worker/dist/index.js")],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: databaseUrl,
          STORAGE_PATH: join(directory, "storage"),
          WORKER_READY_FILE: readyFile,
          NORMALIZATION_VERIFY_RENDERER: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const ready = await new Promise<string>((resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Worker readiness timed out")),
        8_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        const output = chunk.toString();
        if (output.includes("receipt-report-worker ready")) {
          clearTimeout(timeout);
          resolveReady(output);
        }
      });
      child.once("error", reject);
      child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    });

    expect(ready).toContain("ready");
    expect(await readFile(readyFile, "utf8")).toMatch(/^\d+\n$/);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolveExit) =>
      child.once("exit", resolveExit),
    );
    expect(exitCode).toBe(0);
    await expect(access(readyFile)).rejects.toThrow();
  });
});
