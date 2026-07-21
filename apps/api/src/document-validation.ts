import { fileTypeFromBuffer } from "file-type";
import type { FilesystemDocumentStorage } from "@receipt-report/database";

export type SupportedDocumentMediaType =
  "image/jpeg" | "image/png" | "application/pdf";

export type DocumentValidationLimits = {
  maxPdfPages: number;
  maxImageWidth: number;
  maxImageHeight: number;
  maxDecodedPixels: number;
  timeoutMs: number;
};

export class UnsupportedDocumentError extends Error {}
export class MalformedDocumentError extends Error {}
export class DocumentValidationTimeoutError extends Error {}

function deadlineGuard(deadline: number): void {
  if (Date.now() > deadline) throw new DocumentValidationTimeoutError();
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function updateCrc32(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes)
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return crc >>> 0;
}

async function validatePngCrc(
  storage: FilesystemDocumentStorage,
  path: string,
  position: number,
  length: number,
  typeBytes: Buffer,
  deadline: number,
): Promise<void> {
  let crc = updateCrc32(0xffffffff, typeBytes);
  let offset = 0;
  while (offset < length) {
    deadlineGuard(deadline);
    const blockLength = Math.min(64 * 1024, length - offset);
    const block = await storage.readAt(
      path,
      position + 8 + offset,
      blockLength,
    );
    if (block.length !== blockLength) throw new MalformedDocumentError();
    crc = updateCrc32(crc, block);
    offset += blockLength;
  }
  const expected = await storage.readAt(path, position + 8 + length, 4);
  if (
    expected.length !== 4 ||
    expected.readUInt32BE(0) !== (crc ^ 0xffffffff) >>> 0
  )
    throw new MalformedDocumentError();
}

function validateDimensions(
  width: number,
  height: number,
  limits: DocumentValidationLimits,
): void {
  if (
    width < 1 ||
    height < 1 ||
    width > limits.maxImageWidth ||
    height > limits.maxImageHeight ||
    BigInt(width) * BigInt(height) > BigInt(limits.maxDecodedPixels)
  ) {
    throw new MalformedDocumentError("Image dimensions exceed limits");
  }
}

async function validatePng(
  storage: FilesystemDocumentStorage,
  path: string,
  byteSize: number,
  limits: DocumentValidationLimits,
  deadline: number,
): Promise<void> {
  let position = 8;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (position < byteSize) {
    deadlineGuard(deadline);
    const header = await storage.readAt(path, position, 8);
    if (header.length !== 8) throw new MalformedDocumentError();
    const length = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString("ascii");
    const next = position + 12 + length;
    if (next > byteSize) throw new MalformedDocumentError();
    await validatePngCrc(
      storage,
      path,
      position,
      length,
      header.subarray(4, 8),
      deadline,
    );
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new MalformedDocumentError();
      const data = await storage.readAt(path, position + 8, 13);
      if (data.length !== 13) throw new MalformedDocumentError();
      validateDimensions(data.readUInt32BE(0), data.readUInt32BE(4), limits);
      const bitDepth = data[8];
      const colorType = data[9];
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        bitDepth === undefined ||
        colorType === undefined ||
        !validDepths[colorType]?.includes(bitDepth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        throw new MalformedDocumentError();
      sawHeader = true;
    } else if (type === "IHDR") {
      throw new MalformedDocumentError();
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || next !== byteSize) throw new MalformedDocumentError();
      sawEnd = true;
      break;
    }
    position = next;
  }
  if (!sawHeader || !sawImageData || !sawEnd)
    throw new MalformedDocumentError();
}

const jpegSofMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

async function validateJpeg(
  storage: FilesystemDocumentStorage,
  path: string,
  byteSize: number,
  limits: DocumentValidationLimits,
  deadline: number,
): Promise<void> {
  if (byteSize < 12) throw new MalformedDocumentError();
  let position = 2;
  let sawFrame = false;
  let sawScan = false;
  while (position < byteSize - 2) {
    deadlineGuard(deadline);
    let markerBytes = await storage.readAt(path, position, 2);
    if (markerBytes.length !== 2 || markerBytes[0] !== 0xff)
      throw new MalformedDocumentError();
    while (markerBytes[1] === 0xff) {
      deadlineGuard(deadline);
      position += 1;
      markerBytes = await storage.readAt(path, position, 2);
    }
    const marker = markerBytes[1];
    if (marker === undefined || marker === 0x00 || marker === 0xd8)
      throw new MalformedDocumentError();
    if (marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      position += 2;
      continue;
    }
    const lengthBytes = await storage.readAt(path, position + 2, 2);
    if (lengthBytes.length !== 2) throw new MalformedDocumentError();
    const length = lengthBytes.readUInt16BE(0);
    if (length < 2 || position + 2 + length > byteSize)
      throw new MalformedDocumentError();
    if (jpegSofMarkers.has(marker)) {
      if (length < 8) throw new MalformedDocumentError();
      const frame = await storage.readAt(path, position + 4, 5);
      if (frame.length !== 5) throw new MalformedDocumentError();
      validateDimensions(frame.readUInt16BE(3), frame.readUInt16BE(1), limits);
      sawFrame = true;
    }
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    position += 2 + length;
  }
  const end = await storage.readAt(path, byteSize - 2, 2);
  if (!sawFrame || !sawScan || end[0] !== 0xff || end[1] !== 0xd9)
    throw new MalformedDocumentError();
}

async function validatePdf(
  storage: FilesystemDocumentStorage,
  path: string,
  limits: DocumentValidationLimits,
  deadline: number,
): Promise<void> {
  let pageCount = 0;
  let sawXref = false;
  let sawStartXref = false;
  let sawEof = false;
  let tail = "";
  for await (const chunk of storage.createReadStream(path, {
    highWaterMark: 64 * 1024,
  })) {
    deadlineGuard(deadline);
    const text = tail + Buffer.from(chunk).toString("latin1");
    if (/\/Encrypt\b/.test(text)) throw new MalformedDocumentError();
    for (const match of text.matchAll(/\/Type\s*\/Page\b/g)) {
      if ((match.index ?? 0) + match[0].length > tail.length) pageCount += 1;
    }
    if (pageCount > limits.maxPdfPages) throw new MalformedDocumentError();
    sawXref ||= /\bxref\b/.test(text);
    sawStartXref ||= /\bstartxref\b/.test(text);
    sawEof ||= /%%EOF/.test(text);
    tail = text.slice(-128);
  }
  if (pageCount < 1 || !sawXref || !sawStartXref || !sawEof)
    throw new MalformedDocumentError();
}

export async function validateStagedDocument(
  storage: FilesystemDocumentStorage,
  path: string,
  byteSize: number,
  limits: DocumentValidationLimits,
): Promise<SupportedDocumentMediaType> {
  const deadline = Date.now() + limits.timeoutMs;
  const head = await storage.readHead(path, Math.min(4100, byteSize));
  const detected = await fileTypeFromBuffer(head);
  const mediaType = detected?.mime;
  if (
    mediaType !== "image/jpeg" &&
    mediaType !== "image/png" &&
    mediaType !== "application/pdf"
  )
    throw new UnsupportedDocumentError();
  if (mediaType === "image/png")
    await validatePng(storage, path, byteSize, limits, deadline);
  else if (mediaType === "image/jpeg")
    await validateJpeg(storage, path, byteSize, limits, deadline);
  else await validatePdf(storage, path, limits, deadline);
  return mediaType;
}

export function sanitizeOriginalFilename(
  value: string | undefined,
): string | null {
  if (!value) return null;
  const basename = value.split(/[\\/]/).at(-1) ?? "";
  const decoded = basename
    .normalize("NFC")
    .replace(/%(?:0[0-9a-f]|1[0-9a-f]|7f)/gi, "");
  const sanitized = [...decoded]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim()
    .slice(0, 255);
  return sanitized || null;
}
