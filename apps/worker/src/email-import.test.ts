import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig } from "@receipt-report/config";
import {
  createDatabase,
  FilesystemDocumentStorage,
  type Database,
} from "@receipt-report/database";
import { silentLogger } from "@receipt-report/logging";

const imap = vi.hoisted(() => ({
  uids: [1],
  structures: new Map<number, object>(),
  bytes: new Map<string, Buffer>(),
  connected: 0,
  openedReadOnly: false,
  failConnect: false,
  failLogout: false,
  searchUnavailable: false,
  closed: 0,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {
      imap.connected += 1;
      if (imap.failConnect) throw new Error("synthetic connection failure");
    }
    async mailboxOpen(_folder: string, options: { readOnly?: boolean }) {
      imap.openedReadOnly = options.readOnly === true;
      return { uidValidity: 7n };
    }
    async search() {
      // ImapFlow resolves to false when the mailbox cannot be searched.
      return imap.searchUnavailable ? null : imap.uids;
    }
    async fetchOne(uid: number) {
      return { bodyStructure: imap.structures.get(uid) };
    }
    async download(uid: string, partId: string) {
      const bytes = imap.bytes.get(`${uid}:${partId}`);
      if (!bytes) throw new Error("synthetic download failure");
      return { content: Readable.from([bytes]) };
    }
    async logout() {
      if (imap.failLogout) throw new Error("synthetic logout failure");
      return undefined;
    }
    close() {
      imap.closed += 1;
      return undefined;
    }
  },
}));
import {
  opaqueMailboxIdentity,
  retryDelay,
  selectAttachmentParts,
  EmailImporter,
} from "./email-import.js";

let directory: string | undefined;
let database: Database | undefined;

afterEach(async () => {
  await database?.$disconnect();
  database = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  imap.uids = [1];
  imap.structures.clear();
  imap.bytes.clear();
  imap.connected = 0;
  imap.openedReadOnly = false;
  imap.failConnect = false;
  imap.failLogout = false;
  imap.searchUnavailable = false;
  imap.closed = 0;
  vi.restoreAllMocks();
});

function pdf(label: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type /Page /Label (${label})>>endobj\nxref\nstartxref\n0\n%%EOF\n`,
  );
}

const attached = { disposition: "attachment" };

function attachment(part: string, size: number): object {
  return {
    part,
    type: "application/pdf",
    size,
    ...attached,
    dispositionParameters: { filename: `receipt-${part}.pdf` },
  };
}

/**
 * A migrated database, filesystem storage, and an importer over the mocked
 * IMAP client. Reuses the suite-scoped database so `afterEach` disposes it.
 */
async function importerFixture(
  overrides: Record<string, string> = {},
): Promise<{
  storage: FilesystemDocumentStorage;
  importer: EmailImporter;
}> {
  directory ??= await mkdtemp(join(tmpdir(), "email-import-"));
  const databaseUrl = `file:${join(directory, "test.db")}`;
  if (!database) {
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    database = await createDatabase(databaseUrl);
  }
  const storage = new FilesystemDocumentStorage(join(directory, "documents"));
  const config = parseWorkerConfig({
    DATABASE_URL: databaseUrl,
    STORAGE_PATH: join(directory, "documents"),
    WORKER_READY_FILE: join(directory, "ready"),
    EMAIL_IMPORT_ENABLED: "true",
    EMAIL_IMPORT_HOST: "imap.example.test",
    EMAIL_IMPORT_USERNAME: "dedicated@example.test",
    EMAIL_IMPORT_PASSWORD: "app-password",
    EMAIL_IMPORT_POLL_MS: "1",
    ...overrides,
  });
  return {
    storage,
    importer: new EmailImporter(database, storage, config, silentLogger),
  };
}

describe("email attachment discovery", () => {
  it("selects only explicit bounded attachments in canonical part order", () => {
    const selected = selectAttachmentParts(
      {
        type: "multipart/mixed",
        childNodes: [
          { part: "2", type: "image/png", size: 12, disposition: "inline" },
          {
            part: "1.10",
            type: "application/pdf",
            size: 99,
            disposition: "attachment",
            dispositionParameters: { filename: "../receipt.pdf" },
          },
          {
            part: "1.2",
            type: "image/jpeg",
            size: 50,
            disposition: "ATTACHMENT",
            dispositionParameters: { filename: "receipt.jpg" },
          },
          {
            part: "3",
            type: "application/zip",
            size: 101,
            disposition: "attachment",
          },
          {
            part: "4",
            type: "message/rfc822",
            size: 10,
            disposition: "attachment",
          },
        ],
      },
      100,
    );
    expect(selected).toEqual([
      { partId: "1.2", ordinal: 0, filename: "receipt.jpg", declaredSize: 50 },
      { partId: "1.10", ordinal: 1, filename: "receipt.pdf", declaredSize: 99 },
    ]);
  });

  it("constructs stable opaque identities without exposing inputs", () => {
    const identity = opaqueMailboxIdentity([
      "imap.example.test",
      "user@example.test",
    ]);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).not.toContain("example");
    expect(identity).toBe(
      opaqueMailboxIdentity(["imap.example.test", "user@example.test"]),
    );
  });

  it("rejects missing, empty, and oversized part metadata without fetching", () => {
    expect(
      selectAttachmentParts(
        {
          type: "multipart/mixed",
          childNodes: [
            { type: "application/pdf", size: 10, disposition: "attachment" },
            { part: "1", type: "application/pdf", size: 10 },
            {
              part: "2",
              type: "application/pdf",
              size: 0,
              disposition: "attachment",
            },
            {
              part: "3",
              type: "application/pdf",
              size: 101,
              disposition: "attachment",
            },
            {
              part: "4",
              type: "text/plain",
              size: 10,
              disposition: "attachment",
            },
          ],
        },
        100,
      ),
    ).toEqual([{ partId: "4", ordinal: 0, filename: null, declaredSize: 10 }]);
    expect(
      selectAttachmentParts(
        { part: "1", type: "application/pdf", size: 1, disposition: "inline" },
        100,
      ),
    ).toEqual([]);
  });

  it("orders nested parts beneath their shallower siblings", () => {
    expect(
      selectAttachmentParts(
        {
          type: "multipart/mixed",
          childNodes: [
            { part: "1.2", type: "application/pdf", size: 3, ...attached },
            { part: "2", type: "application/pdf", size: 4, ...attached },
            { part: "1", type: "application/pdf", size: 1, ...attached },
            { part: "1.10", type: "application/pdf", size: 2, ...attached },
          ],
        },
        100,
      ).map((part) => part.partId),
    ).toEqual(["1", "1.2", "1.10", "2"]);
  });

  it("caps exponential retry delay", () => {
    expect(
      [1, 2, 3, 10].map((attempt) => retryDelay(attempt, 100, 500)),
    ).toEqual([100, 200, 400, 500]);
    expect(retryDelay(0, 100, 500)).toBe(100);
  });

  it("imports over read-only TLS and deduplicates the same bytes across messages", async () => {
    directory = await mkdtemp(join(tmpdir(), "email-import-"));
    const databaseUrl = `file:${join(directory, "test.db")}`;
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    database = await createDatabase(databaseUrl);
    const storage = new FilesystemDocumentStorage(join(directory, "documents"));
    const bytes = pdf("synthetic");
    imap.structures.set(1, {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "image/png", size: 10, disposition: "inline" },
        {
          part: "2",
          type: "application/octet-stream",
          size: bytes.length,
          disposition: "attachment",
          dispositionParameters: { filename: "../private-receipt.pdf" },
        },
      ],
    });
    imap.bytes.set("1:2", bytes);
    const config = parseWorkerConfig({
      DATABASE_URL: databaseUrl,
      STORAGE_PATH: join(directory, "documents"),
      WORKER_READY_FILE: join(directory, "ready"),
      EMAIL_IMPORT_ENABLED: "true",
      EMAIL_IMPORT_HOST: "imap.example.test",
      EMAIL_IMPORT_USERNAME: "dedicated@example.test",
      EMAIL_IMPORT_PASSWORD: "app-password",
      EMAIL_IMPORT_POLL_MS: "1",
    });
    const importer = new EmailImporter(database, storage, config, silentLogger);

    expect(importer.due(0)).toBe(false);
    expect(importer.due(config.EMAIL_IMPORT_POLL_MS)).toBe(true);
    await expect(importer.poll()).resolves.toBe(true);
    expect(imap.connected).toBe(1);
    expect(imap.openedReadOnly).toBe(true);
    expect(await database.receipt.count()).toBe(1);
    expect(await database.receiptDocument.count()).toBe(1);
    expect(await database.normalizationJob.count()).toBe(1);
    expect(
      await database.emailAttachmentImport.findFirstOrThrow({
        select: { status: true, originalFilename: true },
      }),
    ).toEqual({ status: "imported", originalFilename: "private-receipt.pdf" });

    imap.uids = [2];
    imap.structures.set(2, imap.structures.get(1) ?? {});
    imap.bytes.set("2:2", bytes);
    await expect(importer.poll()).resolves.toBe(true);
    expect(await database.receipt.count()).toBe(1);
    expect(
      await database.emailAttachmentImport.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "imported", _count: { _all: 1 } }),
        expect.objectContaining({ status: "duplicate", _count: { _all: 1 } }),
      ]),
    );

    imap.uids = [3];
    await expect(importer.poll()).resolves.toBe(true);
    expect(
      await database.emailMessageImport.findFirstOrThrow({
        where: { uid: 3 },
        select: { status: true, failureCode: true },
      }),
    ).toEqual({ status: "failed", failureCode: "message_missing" });

    imap.uids = [4];
    imap.structures.set(4, imap.structures.get(1) ?? {});
    await expect(importer.poll()).resolves.toBe(true);
    expect(
      await database.emailAttachmentImport.findFirstOrThrow({
        where: { message: { uid: 4 } },
        select: { status: true, failureCode: true, attempts: true },
      }),
    ).toEqual({
      status: "retry_wait",
      failureCode: "download_failed",
      attempts: 1,
    });

    const oneAttemptConfig = parseWorkerConfig({
      DATABASE_URL: databaseUrl,
      STORAGE_PATH: join(directory, "documents"),
      WORKER_READY_FILE: join(directory, "ready"),
      EMAIL_IMPORT_ENABLED: "true",
      EMAIL_IMPORT_HOST: "imap.example.test",
      EMAIL_IMPORT_USERNAME: "dedicated@example.test",
      EMAIL_IMPORT_PASSWORD: "app-password",
      EMAIL_IMPORT_POLL_MS: "1",
      EMAIL_IMPORT_MAX_ATTEMPTS: "1",
    });
    const oneAttemptImporter = new EmailImporter(
      database,
      storage,
      oneAttemptConfig,
      silentLogger,
    );
    imap.uids = [5];
    imap.structures.set(5, imap.structures.get(1) ?? {});
    await expect(oneAttemptImporter.poll()).resolves.toBe(true);
    expect(
      await database.emailAttachmentImport.findFirstOrThrow({
        where: { message: { uid: 5 } },
        select: { status: true, failureCode: true },
      }),
    ).toEqual({ status: "failed", failureCode: "download_failed" });

    imap.failConnect = true;
    await expect(oneAttemptImporter.poll()).resolves.toBe(false);

    const disabled = parseWorkerConfig({
      DATABASE_URL: databaseUrl,
      STORAGE_PATH: join(directory, "documents"),
      WORKER_READY_FILE: join(directory, "ready"),
    });
    const disabledImporter = new EmailImporter(
      database,
      storage,
      disabled,
      silentLogger,
    );
    expect(disabledImporter.due()).toBe(false);
    await expect(disabledImporter.poll()).resolves.toBe(false);
  });

  it("defers attachments past the per-poll budget and resumes them next poll", async () => {
    const first = pdf("first");
    const second = pdf("second");
    imap.structures.set(1, {
      type: "multipart/mixed",
      childNodes: [
        attachment("1", first.length),
        attachment("2", second.length),
      ],
    });
    imap.bytes.set("1:1", first);
    imap.bytes.set("1:2", second);
    const { importer } = await importerFixture({
      EMAIL_IMPORT_MAX_ATTACHMENTS: "1",
    });

    await expect(importer.poll()).resolves.toBe(true);
    expect(await database?.receiptDocument.count()).toBe(1);
    expect(
      await database?.emailAttachmentImport.findMany({
        orderBy: { ordinal: "asc" },
        select: { partId: true, status: true },
      }),
    ).toEqual([
      { partId: "1", status: "imported" },
      { partId: "2", status: "pending" },
    ]);
    // The message stays incomplete so the deferred attachment is retried.
    expect(
      await database?.emailMessageImport.findFirstOrThrow({
        select: { status: true },
      }),
    ).toEqual({ status: "discovered" });
    expect(
      await database?.emailImportCursor.findFirstOrThrow({
        select: { lastUid: true },
      }),
    ).toEqual({ lastUid: 0 });

    // Second poll: the imported attachment is already terminal and is skipped
    // without spending budget, leaving room for the deferred one.
    await expect(importer.poll()).resolves.toBe(true);
    expect(await database?.receiptDocument.count()).toBe(2);
    expect(
      await database?.emailAttachmentImport.findMany({
        orderBy: { ordinal: "asc" },
        select: { partId: true, status: true },
      }),
    ).toEqual([
      { partId: "1", status: "imported" },
      { partId: "2", status: "imported" },
    ]);
    expect(
      await database?.emailMessageImport.findFirstOrThrow({
        select: { status: true },
      }),
    ).toEqual({ status: "complete" });
  });

  it("leaves an attachment alone while its retry delay has not elapsed", async () => {
    imap.structures.set(1, {
      type: "multipart/mixed",
      childNodes: [attachment("1", 64)],
    });
    const { importer } = await importerFixture();

    // No registered bytes, so the download fails and the row backs off.
    await expect(importer.poll()).resolves.toBe(true);
    expect(
      await database?.emailAttachmentImport.findFirstOrThrow({
        select: { status: true, attempts: true },
      }),
    ).toEqual({ status: "retry_wait", attempts: 1 });

    // The retry base delay is 5s, so an immediate second poll must not claim
    // the row again, and must not burn another attempt.
    await expect(importer.poll()).resolves.toBe(true);
    expect(
      await database?.emailAttachmentImport.findFirstOrThrow({
        select: { status: true, attempts: true },
      }),
    ).toEqual({ status: "retry_wait", attempts: 1 });
  });

  it("records a durable cleanup intent when discarding an invalid attachment", async () => {
    const bytes = Buffer.from("this is not a supported document");
    imap.structures.set(1, {
      type: "multipart/mixed",
      childNodes: [attachment("1", bytes.length)],
    });
    imap.bytes.set("1:1", bytes);
    const { storage, importer } = await importerFixture();
    vi.spyOn(storage, "cleanup").mockRejectedValue(
      new Error("synthetic cleanup failure"),
    );

    await expect(importer.poll()).resolves.toBe(true);
    expect(
      await database?.emailAttachmentImport.findFirstOrThrow({
        select: { status: true, failureCode: true },
      }),
    ).toEqual({ status: "failed", failureCode: "invalid_document" });
    expect(
      await database?.documentFileCleanup.findFirstOrThrow({
        select: { attempts: true, lastError: true },
      }),
    ).toEqual({ attempts: 1, lastError: "cleanup_failed" });
    expect(await database?.receiptDocument.count()).toBe(0);
  });

  it("records a cleanup intent when an attachment outgrows its declared size", async () => {
    // A declared size within the limit that the body then exceeds: selection
    // admits the part, and only streaming discovers the real length.
    imap.structures.set(1, {
      type: "multipart/mixed",
      childNodes: [attachment("1", 16)],
    });
    imap.bytes.set("1:1", pdf("far larger than the configured limit"));
    const { storage, importer } = await importerFixture({
      DOCUMENT_MAX_BYTES: "16",
    });
    vi.spyOn(storage, "cleanup").mockRejectedValue(
      new Error("synthetic cleanup failure"),
    );

    await expect(importer.poll()).resolves.toBe(true);
    expect(
      await database?.emailAttachmentImport.findFirstOrThrow({
        select: { status: true, failureCode: true },
      }),
    ).toEqual({ status: "failed", failureCode: "invalid_document" });
    expect(await database?.documentFileCleanup.count()).toBe(1);
    expect(await database?.receiptDocument.count()).toBe(0);
  });

  it("closes the connection when a clean logout fails", async () => {
    const bytes = pdf("logout");
    imap.structures.set(1, {
      type: "multipart/mixed",
      childNodes: [attachment("1", bytes.length)],
    });
    imap.bytes.set("1:1", bytes);
    imap.failLogout = true;
    const { importer } = await importerFixture();

    await expect(importer.poll()).resolves.toBe(true);
    expect(imap.closed).toBe(1);
    expect(await database?.receiptDocument.count()).toBe(1);
  });

  it("treats an unavailable search as an empty mailbox", async () => {
    imap.searchUnavailable = true;
    const { importer } = await importerFixture();

    await expect(importer.poll()).resolves.toBe(true);
    expect(await database?.emailMessageImport.count()).toBe(0);
    expect(
      await database?.emailImporterHealth.findFirstOrThrow({
        select: { enabled: true },
      }),
    ).toEqual({ enabled: true });
  });
});
