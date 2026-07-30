import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./index.js";

let directory: string | undefined;
let database: Database | undefined;

afterEach(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  database = undefined;
  directory = undefined;
});

function deploy(databaseUrl: string, schemaPath?: string): void {
  execFileSync(
    "pnpm",
    schemaPath
      ? [
          "--filter",
          "@receipt-report/database",
          "exec",
          "prisma",
          "migrate",
          "deploy",
          "--schema",
          schemaPath,
        ]
      : ["--filter", "@receipt-report/database", "db:migrate:deploy"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
}

describe("category migration", () => {
  it("preserves existing receipts and line items while adding nullable assignments", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-category-upgrade-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "upgrade.db")}`;
    const sourcePrismaDirectory = resolve("packages/database/prisma");
    const sourceMigrationsDirectory = join(sourcePrismaDirectory, "migrations");
    const testPrismaDirectory = join(directory, "prisma");
    const testMigrationsDirectory = join(testPrismaDirectory, "migrations");
    await mkdir(testMigrationsDirectory, { recursive: true });
    await copyFile(
      join(sourcePrismaDirectory, "schema.prisma"),
      join(testPrismaDirectory, "schema.prisma"),
    );
    await copyFile(
      join(sourceMigrationsDirectory, "migration_lock.toml"),
      join(testMigrationsDirectory, "migration_lock.toml"),
    );
    const migrationNames = (await readdir(sourceMigrationsDirectory))
      .filter((name) => name < "20260730120000_category_taxonomy")
      .sort();
    for (const migrationName of migrationNames) {
      await cp(
        join(sourceMigrationsDirectory, migrationName),
        join(testMigrationsDirectory, migrationName),
        { recursive: true },
      );
    }
    const testSchemaPath = join(testPrismaDirectory, "schema.prisma");
    deploy(databaseUrl, testSchemaPath);
    database = await createDatabase(databaseUrl);
    await database.$executeRawUnsafe(
      `INSERT INTO "Receipt" ("id", "merchantRaw", "purchaseDate", "currency", "totalCents", "createdAt", "updatedAt")
       VALUES ('cm11111111111111111111111', 'Synthetic migration receipt', '2026-07-30', 'EUR', 123, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await database.$executeRawUnsafe(
      `INSERT INTO "LineItem" ("id", "receiptId", "description", "lineTotalCents", "position")
       VALUES ('cm22222222222222222222222', 'cm11111111111111111111111', 'Synthetic preserved line', 123, 0)`,
    );
    await database.$disconnect();
    database = undefined;

    await cp(
      join(sourceMigrationsDirectory, "20260730120000_category_taxonomy"),
      join(testMigrationsDirectory, "20260730120000_category_taxonomy"),
      { recursive: true },
    );
    deploy(databaseUrl, testSchemaPath);
    database = await createDatabase(databaseUrl);
    const lines = await database.$queryRawUnsafe<
      { id: string; description: string; categoryId: string | null }[]
    >(
      `SELECT "id", "description", "categoryId" FROM "LineItem" WHERE "id" = 'cm22222222222222222222222'`,
    );
    expect(lines).toEqual([
      {
        id: "cm22222222222222222222222",
        description: "Synthetic preserved line",
        categoryId: null,
      },
    ]);
    const categories = await database.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) AS "count" FROM "Category"`,
    );
    expect(Number(categories[0]?.count)).toBe(24);
    const foreignKeyFailures = await database.$queryRawUnsafe<unknown[]>(
      "PRAGMA foreign_key_check",
    );
    expect(foreignKeyFailures).toEqual([]);
  });

  it("uses the migration ledger once so edited starter rows never reappear", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-category-seed-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "seed.db")}`;
    deploy(databaseUrl);
    database = await createDatabase(databaseUrl);
    await database.category.update({
      where: { id: "cm00000000000000000000001" },
      data: { name: "Renamed Food", normalizedName: "renamed food" },
    });
    await database.category.delete({
      where: { id: "cm00000000000000000000010" },
    });
    await database.$disconnect();
    database = undefined;

    deploy(databaseUrl);
    database = await createDatabase(databaseUrl);
    expect(await database.category.count()).toBe(23);
    expect(
      await database.category.findUnique({
        where: { id: "cm00000000000000000000001" },
        select: { name: true },
      }),
    ).toEqual({ name: "Renamed Food" });
    expect(
      await database.category.findUnique({
        where: { id: "cm00000000000000000000010" },
      }),
    ).toBeNull();
  });
});
