import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
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

async function executeMigrationSql(
  client: PrismaClient,
  migrationPath: string,
): Promise<void> {
  const sql = await readFile(migrationPath, "utf8");
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await client.$executeRawUnsafe(statement);
  }
}

describe("category migration", () => {
  it("preserves existing receipts and line items while adding nullable assignments", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-category-upgrade-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "upgrade.db")}`;
    const client = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    await client.$connect();
    const migrationsDirectory = resolve("packages/database/prisma/migrations");
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => name < "20260730120000_category_taxonomy")
      .sort();
    for (const migrationName of migrationNames) {
      await executeMigrationSql(
        client,
        join(migrationsDirectory, migrationName, "migration.sql"),
      );
    }
    await client.$executeRawUnsafe(
      `INSERT INTO "Receipt" ("id", "merchantRaw", "purchaseDate", "currency", "totalCents", "createdAt", "updatedAt")
       VALUES ('cm11111111111111111111111', 'Synthetic migration receipt', '2026-07-30', 'EUR', 123, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "LineItem" ("id", "receiptId", "description", "lineTotalCents", "position")
       VALUES ('cm22222222222222222222222', 'cm11111111111111111111111', 'Synthetic preserved line', 123, 0)`,
    );

    await executeMigrationSql(
      client,
      join(
        migrationsDirectory,
        "20260730120000_category_taxonomy",
        "migration.sql",
      ),
    );
    const lines = await client.$queryRawUnsafe<
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
    const categories = await client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) AS "count" FROM "Category"`,
    );
    expect(Number(categories[0]?.count)).toBe(24);
    const foreignKeyFailures = await client.$queryRawUnsafe<unknown[]>(
      "PRAGMA foreign_key_check",
    );
    expect(foreignKeyFailures).toEqual([]);
    await client.$disconnect();
  });

  it("uses the migration ledger once so edited starter rows never reappear", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-category-seed-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "seed.db")}`;
    const deploy = () =>
      execFileSync(
        "pnpm",
        ["--filter", "@receipt-report/database", "db:migrate:deploy"],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdio: "pipe",
        },
      );
    deploy();
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

    deploy();
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
