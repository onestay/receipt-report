import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
export * from "./storage.js";

export type Database = PrismaClient;

export function sqlitePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a SQLite file URL");
  }
  const value = databaseUrl.slice("file:".length);
  if (value.length === 0) {
    throw new Error("DATABASE_URL must include a database path");
  }
  return resolve(value);
}

export async function createDatabase(databaseUrl: string): Promise<Database> {
  const databasePath = sqlitePathFromUrl(databaseUrl);
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new PrismaClient({
    datasources: { db: { url: `file:${databasePath}` } },
  });
  await database.$connect();
  return database;
}

export async function enableWal(database: Database): Promise<string> {
  const rows = await database.$queryRawUnsafe<{ journal_mode: string }[]>(
    "PRAGMA journal_mode=WAL",
  );
  const mode = rows[0]?.journal_mode;
  if (!mode) {
    throw new Error("SQLite did not return a journal mode");
  }
  return mode.toLowerCase();
}

export function reportJournalMode(
  journalMode: string,
  warn: (message: string) => void = console.warn,
): void {
  if (journalMode !== "wal") {
    warn(`SQLite WAL unavailable; continuing with journal_mode=${journalMode}`);
  }
}

export async function checkDatabase(database: Database): Promise<boolean> {
  const rows =
    await database.$queryRawUnsafe<{ value: bigint }[]>("SELECT 1 AS value");
  return rows[0]?.value === 1n || Number(rows[0]?.value) === 1;
}

export const prismaSchemaPath = fileURLToPath(
  new URL("../prisma/schema.prisma", import.meta.url),
);
