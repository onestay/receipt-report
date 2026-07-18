import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDatabase,
  createDatabase,
  enableWal,
  reportJournalMode,
  sqlitePathFromUrl,
  type Database,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function isolatedDatabase(): Promise<{
  database: Database;
  directory: string;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), `receipt-report-${process.pid}-`),
  );
  temporaryDirectories.push(directory);
  const database = await createDatabase(`file:${join(directory, "test.db")}`);
  return { database, directory };
}

describe("database boundary", () => {
  it("rejects non-SQLite and empty URLs", () => {
    expect(() => sqlitePathFromUrl("postgres://invalid")).toThrow("SQLite");
    expect(() => sqlitePathFromUrl("file:")).toThrow("database path");
  });

  it("executes a real query in an isolated database", async () => {
    const { database } = await isolatedDatabase();
    await expect(checkDatabase(database)).resolves.toBe(true);
    await database.$disconnect();
  });

  it("enables WAL where the filesystem supports it", async () => {
    const { database } = await isolatedDatabase();
    await expect(enableWal(database)).resolves.toBe("wal");
    await database.$disconnect();
  });

  it("reports only a non-WAL fallback", () => {
    const warnings: string[] = [];
    reportJournalMode("wal", (message) => warnings.push(message));
    reportJournalMode("delete", (message) => warnings.push(message));
    expect(warnings).toEqual([
      "SQLite WAL unavailable; continuing with journal_mode=delete",
    ]);
  });

  it("handles empty query results defensively", async () => {
    const fakeDatabase = {
      $queryRawUnsafe: async () => [],
    } as unknown as Database;
    await expect(enableWal(fakeDatabase)).rejects.toThrow("journal mode");
    await expect(checkDatabase(fakeDatabase)).resolves.toBe(false);
  });
});
