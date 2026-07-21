import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemDocumentStorage } from "@receipt-report/database";
import {
  DocumentValidationTimeoutError,
  MalformedDocumentError,
  sanitizeOriginalFilename,
  UnsupportedDocumentError,
  validateStagedDocument,
} from "./document-validation.js";

let directory = "";
let storage: FilesystemDocumentStorage;

const limits = {
  maxPdfPages: 2,
  maxImageWidth: 100,
  maxImageHeight: 100,
  maxDecodedPixels: 5_000,
  timeoutMs: 2_000,
};

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from(type, "ascii"), data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, data, checksum]);
}

function png(
  options: {
    width?: number;
    height?: number;
    bitDepth?: number;
    colorType?: number;
    compression?: number;
    filter?: number;
    interlace?: number;
    chunks?: Buffer[];
  } = {},
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width ?? 1, 0);
  header.writeUInt32BE(options.height ?? 1, 4);
  header[8] = options.bitDepth ?? 8;
  header[9] = options.colorType ?? 6;
  header[10] = options.compression ?? 0;
  header[11] = options.filter ?? 0;
  header[12] = options.interlace ?? 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    ...(options.chunks ?? [
      chunk("IHDR", header),
      chunk("IDAT"),
      chunk("IEND"),
    ]),
  ]);
}

function jpeg(
  options: {
    width?: number;
    height?: number;
    prefix?: Buffer;
    includeFrame?: boolean;
    includeScan?: boolean;
    end?: Buffer;
  } = {},
): Buffer {
  const frame = Buffer.from([
    0xff,
    0xc0,
    0,
    11,
    8,
    ((options.height ?? 1) >> 8) & 0xff,
    (options.height ?? 1) & 0xff,
    ((options.width ?? 1) >> 8) & 0xff,
    (options.width ?? 1) & 0xff,
    1,
    1,
    0x11,
    0,
  ]);
  const scan = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    options.prefix ?? Buffer.alloc(0),
    options.includeFrame === false ? Buffer.alloc(0) : frame,
    options.includeScan === false ? Buffer.alloc(0) : scan,
    options.end ?? Buffer.from([0xff, 0xd9]),
  ]);
}

function pdf(
  parts: {
    pages?: number;
    encrypt?: boolean;
    xref?: boolean;
    startxref?: boolean;
    eof?: boolean;
  } = {},
): Buffer {
  return Buffer.from(
    `%PDF-1.4\n${"1 0 obj<</Type /Page>>endobj\n".repeat(parts.pages ?? 1)}` +
      `${parts.encrypt ? "trailer<</Encrypt 9 0 R>>\n" : ""}` +
      `${parts.xref === false ? "" : "xref\n"}` +
      `${parts.startxref === false ? "" : "startxref\n0\n"}` +
      `${parts.eof === false ? "" : "%%EOF\n"}`,
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "document-validation-"));
  storage = new FilesystemDocumentStorage(directory);
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

async function validate(bytes: Buffer, customLimits = limits) {
  const path = await storage.stage(bytes);
  return validateStagedDocument(storage, path, bytes.length, customLimits);
}

describe("document structural validation", () => {
  it("detects each supported type independently of names and MIME headers", async () => {
    await expect(validate(png())).resolves.toBe("image/png");
    await expect(validate(jpeg())).resolves.toBe("image/jpeg");
    await expect(validate(pdf())).resolves.toBe("application/pdf");
    await expect(validate(Buffer.from("plain text"))).rejects.toBeInstanceOf(
      UnsupportedDocumentError,
    );
  });

  it.each([
    ["zero width", png({ width: 0 })],
    ["zero height", png({ height: 0 })],
    ["wide", png({ width: 101 })],
    ["tall", png({ height: 101 })],
    ["too many pixels", png({ width: 100, height: 100 })],
    ["invalid depth", png({ bitDepth: 4, colorType: 6 })],
    ["invalid color", png({ colorType: 5 })],
    ["compression", png({ compression: 1 })],
    ["filter", png({ filter: 1 })],
    ["interlace", png({ interlace: 1 })],
  ])("rejects PNG %s", async (_name, bytes) => {
    await expect(validate(bytes)).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
  });

  it("rejects malformed PNG chunk structure", async () => {
    const ihdr = png().subarray(8, 33);
    await expect(
      validate(
        Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IDAT")]),
      ),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      validate(png({ chunks: [ihdr, ihdr, chunk("IEND")] })),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      validate(png({ chunks: [ihdr, chunk("IEND")] })),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      validate(Buffer.concat([png(), Buffer.from([0])])),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(validate(png().subarray(0, 38))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
    const badCrc = Buffer.from(png());
    badCrc[32] = (badCrc[32] ?? 0) ^ 1;
    await expect(validate(badCrc)).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
  });

  it("bounds and structurally validates JPEG marker data", async () => {
    await expect(validate(jpeg({ width: 101 }))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
    await expect(validate(jpeg({ height: 101 }))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
    await expect(
      validate(jpeg({ includeFrame: false })),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(validate(jpeg({ includeScan: false }))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
    await expect(
      validate(jpeg({ end: Buffer.from([0, 0]) })),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      validate(
        Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 30, 1, 2, 3, 4, 0xff, 0xd9]),
      ),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      validate(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      validate(jpeg({ prefix: Buffer.from([0xff, 0xff, 0x01]) })),
    ).resolves.toBe("image/jpeg");
  });

  it("checks the wall-time bound while skipping JPEG fill bytes", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2);
    await expect(
      validate(
        jpeg({
          prefix: Buffer.concat([
            Buffer.alloc(8_192, 0xff),
            Buffer.from([0x01]),
          ]),
        }),
        { ...limits, timeoutMs: 1 },
      ),
    ).rejects.toBeInstanceOf(DocumentValidationTimeoutError);
    now.mockRestore();
  });

  it("rejects encrypted, incomplete, over-page, and timed-out PDFs", async () => {
    for (const bytes of [
      pdf({ encrypt: true }),
      pdf({ pages: 3 }),
      pdf({ pages: 0 }),
      pdf({ xref: false }),
      pdf({ startxref: false }),
      pdf({ eof: false }),
    ])
      await expect(validate(bytes)).rejects.toBeInstanceOf(
        MalformedDocumentError,
      );
    await expect(
      validate(pdf(), { ...limits, timeoutMs: -1 }),
    ).rejects.toBeInstanceOf(DocumentValidationTimeoutError);
  });
});

describe("display filename sanitization", () => {
  it("removes paths and control characters without creating storage input", () => {
    expect(sanitizeOriginalFilename(undefined)).toBeNull();
    expect(sanitizeOriginalFilename("../folder\\safe.png")).toBe("safe.png");
    expect(sanitizeOriginalFilename(" %0Dline\n.pdf ")).toBe("line.pdf");
    expect(sanitizeOriginalFilename("\u0000\t")).toBeNull();
    expect(sanitizeOriginalFilename("x".repeat(300))).toHaveLength(255);
  });
});
