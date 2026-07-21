import { createHash } from "node:crypto";
import sharp from "sharp";
import { NORMALIZATION_PROFILE_VERSION } from "@receipt-report/contracts";

export const normalizationProfile = Object.freeze({
  version: NORMALIZATION_PROFILE_VERSION,
  mediaType: "image/png" as const,
  colorSpace: "srgb" as const,
  maxDimension: 2048,
  pngCompressionLevel: 9,
  adaptiveFiltering: false,
  metadata: "stripped" as const,
  orientation: "applied" as const,
});

export type NormalizedPageBytes = {
  bytes: Buffer;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
};

export async function normalizeRasterBytes(
  input: Uint8Array,
  maxInputPixels: number,
): Promise<NormalizedPageBytes> {
  const result = await sharp(input, {
    animated: false,
    failOn: "error",
    limitInputPixels: maxInputPixels,
  })
    .rotate()
    .toColourspace(normalizationProfile.colorSpace)
    .resize({
      width: normalizationProfile.maxDimension,
      height: normalizationProfile.maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({
      compressionLevel: normalizationProfile.pngCompressionLevel,
      adaptiveFiltering: normalizationProfile.adaptiveFiltering,
      palette: false,
      force: true,
    })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = result.info;
  if (!width || !height) throw new Error("normalized_dimensions_missing");
  return {
    bytes: result.data,
    width,
    height,
    byteSize: result.data.byteLength,
    sha256: createHash("sha256").update(result.data).digest("hex"),
  };
}

export function sharpRendererIdentity(): string {
  return `sharp/${sharp.versions.sharp}+libvips/${sharp.versions.vips}`;
}
