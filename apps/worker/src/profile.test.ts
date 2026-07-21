import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  normalizationProfile,
  normalizeRasterBytes,
  sharpRendererIdentity,
} from "./profile.js";

describe("normalization profile", () => {
  it("applies orientation, strips metadata, and is deterministic", async () => {
    const input = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const first = await normalizeRasterBytes(input, 100);
    const second = await normalizeRasterBytes(input, 100);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      width: 3,
      height: 2,
      byteSize: first.bytes.length,
    });
    const metadata = await sharp(first.bytes).metadata();
    expect(metadata).toMatchObject({ format: "png", space: "srgb" });
    expect(metadata.orientation).toBeUndefined();
  });

  it("bounds dimensions without enlargement and rejects pixel bombs", async () => {
    const large = await sharp({
      create: {
        width: 3000,
        height: 1000,
        channels: 3,
        background: "white",
      },
    })
      .png()
      .toBuffer();
    const normalized = await normalizeRasterBytes(large, 4_000_000);
    expect(normalized).toMatchObject({ width: 2048, height: 683 });
    await expect(normalizeRasterBytes(large, 100)).rejects.toThrow();
  });

  it("records the stable profile and native renderer versions", () => {
    expect(normalizationProfile).toEqual({
      version: "receipt-page-v1",
      mediaType: "image/png",
      colorSpace: "srgb",
      maxDimension: 2048,
      pngCompressionLevel: 9,
      adaptiveFiltering: false,
      metadata: "stripped",
      orientation: "applied",
    });
    expect(sharpRendererIdentity()).toMatch(/^sharp\/0\.34\.5\+libvips\//);
  });
});
