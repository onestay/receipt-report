import { execFile } from "node:child_process";
import type { WorkerConfig } from "@receipt-report/config";
import type { FilesystemDocumentStorage } from "@receipt-report/database";
import {
  normalizeRasterBytes,
  sharpRendererIdentity,
  type NormalizedPageBytes,
} from "./profile.js";

export type RenderDocument = {
  relativePath: string;
  mediaType: string;
};

export type RenderedDocument = {
  pages: NormalizedPageBytes[];
  renderer: string;
};

export type DocumentRenderer = {
  render(document: RenderDocument): Promise<RenderedDocument>;
  verify?(): Promise<void>;
};

type CommandResult = { stdout: Buffer; stderr: Buffer };
type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number; memoryMb: number },
) => Promise<CommandResult>;

export class RendererFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function runLimitedCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number; memoryMb: number },
): Promise<CommandResult> {
  const memoryBytes = options.memoryMb * 1024 * 1024;
  const cpuSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  return new Promise((resolve, reject) => {
    execFile(
      "prlimit",
      [`--as=${memoryBytes}`, `--cpu=${cpuSeconds}`, "--", command, ...args],
      {
        encoding: "buffer",
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: options.maxBuffer,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Document renderer command failed", {
            command,
            code: error.code ?? "unknown",
            signal: error.signal ?? null,
            killed: error.killed,
          });
          reject(new RendererFailure("renderer_failed"));
          return;
        }
        resolve({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
      },
    );
  });
}

export class LocalDocumentRenderer implements DocumentRenderer {
  private popplerIdentity: string | undefined;

  constructor(
    private readonly storage: FilesystemDocumentStorage,
    private readonly config: WorkerConfig,
    private readonly runCommand: CommandRunner = runLimitedCommand,
  ) {}

  private commandOptions(
    maxBuffer = 1024 * 1024,
    timeoutMs = this.config.NORMALIZATION_TIMEOUT_MS,
  ) {
    return {
      timeoutMs,
      memoryMb: this.config.NORMALIZATION_MEMORY_MB,
      maxBuffer,
    };
  }

  private async popplerVersion(
    timeoutMs = this.config.NORMALIZATION_TIMEOUT_MS,
  ): Promise<string> {
    if (this.popplerIdentity) return this.popplerIdentity;
    const result = await this.runCommand(
      "pdftoppm",
      ["-v"],
      this.commandOptions(1024 * 1024, timeoutMs),
    );
    const output = `${result.stdout.toString()} ${result.stderr.toString()}`;
    const match = output.match(/pdftoppm version\s+([^\s]+)/i);
    if (!match?.[1]) throw new RendererFailure("renderer_unavailable");
    this.popplerIdentity = `poppler/${match[1]}`;
    return this.popplerIdentity;
  }

  async verify(): Promise<void> {
    await Promise.all([
      this.popplerVersion(),
      this.runCommand("pdfinfo", ["-v"], this.commandOptions()),
    ]);
  }

  async render(document: RenderDocument): Promise<RenderedDocument> {
    if (
      document.mediaType === "image/jpeg" ||
      document.mediaType === "image/png"
    ) {
      const bytes = await this.storage.read(document.relativePath);
      const page = await normalizeRasterBytes(
        bytes,
        this.config.NORMALIZATION_MAX_PAGE_PIXELS,
      ).catch(() => {
        throw new RendererFailure("raster_invalid");
      });
      return { pages: [page], renderer: sharpRendererIdentity() };
    }
    if (document.mediaType !== "application/pdf")
      throw new RendererFailure("unsupported_document");
    return this.renderPdf(document.relativePath);
  }

  private async renderPdf(relativePath: string): Promise<RenderedDocument> {
    const deadline = Date.now() + this.config.NORMALIZATION_TIMEOUT_MS;
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new RendererFailure("renderer_timeout");
      return milliseconds;
    };
    const absolutePath = this.storage.absolutePath(relativePath);
    const info = await this.runCommand(
      "pdfinfo",
      [absolutePath],
      this.commandOptions(1024 * 1024, remaining()),
    );
    const details = info.stdout.toString("utf8");
    if (/^Encrypted:\s+yes\r?$/im.test(details))
      throw new RendererFailure("encrypted_pdf");
    const pageMatch = details.match(/^Pages:\s+(\d+)\r?$/m);
    const pageCount = Number(pageMatch?.[1]);
    if (
      !Number.isInteger(pageCount) ||
      pageCount < 1 ||
      pageCount > this.config.DOCUMENT_MAX_PDF_PAGES
    )
      throw new RendererFailure("pdf_page_limit");

    const pages: NormalizedPageBytes[] = [];
    let totalPixels = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const rendered = await this.runCommand(
        "pdftoppm",
        [
          "-f",
          String(pageNumber),
          "-l",
          String(pageNumber),
          "-singlefile",
          "-scale-to",
          "2048",
          "-png",
          absolutePath,
        ],
        this.commandOptions(
          Math.max(
            1024 * 1024,
            this.config.NORMALIZATION_MAX_PAGE_PIXELS * 4 + 1024 * 1024,
          ),
          remaining(),
        ),
      );
      const page = await normalizeRasterBytes(
        rendered.stdout,
        this.config.NORMALIZATION_MAX_PAGE_PIXELS,
      ).catch(() => {
        throw new RendererFailure("pdf_page_invalid");
      });
      const pixels = page.width * page.height;
      totalPixels += pixels;
      if (totalPixels > this.config.NORMALIZATION_MAX_TOTAL_PIXELS)
        throw new RendererFailure("document_pixel_limit");
      pages.push(page);
    }
    return {
      pages,
      renderer: `${await this.popplerVersion(remaining())}+${sharpRendererIdentity()}`,
    };
  }
}
