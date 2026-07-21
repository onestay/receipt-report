import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig, type WorkerConfig } from "@receipt-report/config";
import { FilesystemDocumentStorage } from "@receipt-report/database";
import {
  LocalDocumentRenderer,
  RendererFailure,
  runLimitedCommand,
} from "./renderer.js";

let directory = "";
let storage: FilesystemDocumentStorage;
let config: WorkerConfig;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "renderer-"));
  const storagePath = join(directory, "storage");
  storage = new FilesystemDocumentStorage(storagePath);
  config = parseWorkerConfig({
    DATABASE_URL: `file:${join(directory, "test.db")}`,
    STORAGE_PATH: storagePath,
    WORKER_READY_FILE: join(directory, "ready"),
    NORMALIZATION_VERIFY_RENDERER: "false",
    DOCUMENT_MAX_PDF_PAGES: "3",
    NORMALIZATION_MAX_PAGE_PIXELS: "100",
    NORMALIZATION_MAX_TOTAL_PIXELS: "150",
  });
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

describe("local renderer", () => {
  it("normalizes a retained raster through sharp", async () => {
    const input = await sharp({
      create: { width: 2, height: 3, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const path = await storage.stage(input);
    const renderer = new LocalDocumentRenderer(storage, config);
    const result = await renderer.render({
      relativePath: path,
      mediaType: "image/jpeg",
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ width: 2, height: 3 });
    expect(result.renderer).toMatch(/^sharp\//);
  });

  it("renders PDF pages in order under the command limits", async () => {
    const renderedPng = await sharp({
      create: { width: 10, height: 5, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const calls: string[][] = [];
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "pdfinfo")
        return {
          stdout: Buffer.from("Encrypted: no\r\nPages:          2\r\n"),
          stderr: Buffer.alloc(0),
        };
      if (args.includes("-v"))
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("pdftoppm version 25.01.0\n"),
        };
      return { stdout: renderedPng, stderr: Buffer.alloc(0) };
    });
    const renderer = new LocalDocumentRenderer(storage, config, run);
    const path = await storage.stage(Buffer.from("synthetic pdf"));
    const result = await renderer.render({
      relativePath: path,
      mediaType: "application/pdf",
    });
    expect(result.pages.map((page) => [page.width, page.height])).toEqual([
      [10, 5],
      [10, 5],
    ]);
    expect(result.renderer).toMatch(/^poppler\/25\.01\.0\+sharp\//);
    expect(
      calls
        .filter((call) => call[0] === "pdftoppm" && call.includes("-f"))
        .map((call) => call[call.indexOf("-f") + 1]),
    ).toEqual(["1", "2"]);
  });

  it("verifies native dependencies and caches the Poppler identity", async () => {
    const run = vi.fn(async (command: string) => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        command === "pdftoppm" ? "pdftoppm version 25.01.0\n" : "pdfinfo",
      ),
    }));
    const renderer = new LocalDocumentRenderer(storage, config, run);
    await renderer.verify();
    await renderer.verify();
    expect(
      run.mock.calls.filter(([command]) => command === "pdftoppm"),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(([command]) => command === "pdfinfo"),
    ).toHaveLength(2);
  });

  it("rejects missing renderer identity and invalid decoded bytes", async () => {
    const noVersion = new LocalDocumentRenderer(storage, config, async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("unknown renderer"),
    }));
    await expect(noVersion.verify()).rejects.toMatchObject({
      code: "renderer_unavailable",
    });

    const invalid = await storage.stage(Buffer.from("not an image"));
    await expect(
      new LocalDocumentRenderer(storage, config).render({
        relativePath: invalid,
        mediaType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "raster_invalid" });

    const invalidPdfPage = new LocalDocumentRenderer(
      storage,
      config,
      async (command) => ({
        stdout:
          command === "pdfinfo"
            ? Buffer.from("Pages: 1\n")
            : Buffer.from("not a rendered image"),
        stderr: Buffer.alloc(0),
      }),
    );
    await expect(
      invalidPdfPage.render({
        relativePath: invalid,
        mediaType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "pdf_page_invalid" });
  });

  it("rejects encrypted PDFs before rendering a page", async () => {
    const path = await storage.stage(Buffer.from("encrypted pdf"));
    const run = vi.fn(async () => ({
      stdout: Buffer.from("Encrypted: yes\nPages: 1\n"),
      stderr: Buffer.alloc(0),
    }));
    await expect(
      new LocalDocumentRenderer(storage, config, run).render({
        relativePath: path,
        mediaType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "encrypted_pdf" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("enforces one wall-clock budget across a PDF job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const path = await storage.stage(Buffer.from("slow pdf"));
      const run = vi.fn(async (command: string) => {
        if (command === "pdfinfo") {
          vi.setSystemTime(config.NORMALIZATION_TIMEOUT_MS + 1);
          return {
            stdout: Buffer.from("Encrypted: no\nPages: 1\n"),
            stderr: Buffer.alloc(0),
          };
        }
        throw new Error("page renderer must not run");
      });
      await expect(
        new LocalDocumentRenderer(storage, config, run).render({
          relativePath: path,
          mediaType: "application/pdf",
        }),
      ).rejects.toMatchObject({ code: "renderer_timeout" });
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported, over-page, and cumulative-pixel inputs", async () => {
    const path = await storage.stage(Buffer.from("input"));
    const unsupported = new LocalDocumentRenderer(storage, config, vi.fn());
    await expect(
      unsupported.render({ relativePath: path, mediaType: "image/gif" }),
    ).rejects.toBeInstanceOf(RendererFailure);

    for (const output of ["missing", "Pages: 0\n", "Pages: 4\n"]) {
      const overPages = new LocalDocumentRenderer(
        storage,
        config,
        async () => ({
          stdout: Buffer.from(output),
          stderr: Buffer.alloc(0),
        }),
      );
      await expect(
        overPages.render({ relativePath: path, mediaType: "application/pdf" }),
      ).rejects.toMatchObject({ code: "pdf_page_limit" });
    }

    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const cumulative = new LocalDocumentRenderer(
      storage,
      config,
      async (command, args) => {
        if (command === "pdfinfo")
          return { stdout: Buffer.from("Pages: 2\n"), stderr: Buffer.alloc(0) };
        if (args.includes("-v"))
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("pdftoppm version 1\n"),
          };
        return { stdout: png, stderr: Buffer.alloc(0) };
      },
    );
    await expect(
      cumulative.render({ relativePath: path, mediaType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "document_pixel_limit" });
  });

  it("sanitizes failed native commands", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        runLimitedCommand("definitely-not-a-command", [], {
          timeoutMs: 1000,
          maxBuffer: 1024,
          memoryMb: 64,
        }),
      ).rejects.toMatchObject({ code: "renderer_failed" });
      expect(consoleError).toHaveBeenCalledWith(
        "Document renderer command failed",
        expect.objectContaining({ command: "definitely-not-a-command" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
