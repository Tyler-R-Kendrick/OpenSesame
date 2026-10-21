import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  AiImageOutput,
  MAX_AI_IMAGE_BYTES,
  decodeAiImage,
} from "./image-output.js";
import type { AiRasterMime } from "./image-raster.js";
import {
  RASTER_FIXTURES,
  STABILITY_KEY,
  pngChunk,
  pngWithComment,
} from "./stability-tls.test-support.js";
const PNG = Buffer.from(RASTER_FIXTURES.png, "base64");
function pngSize(width: number, height: number) {
  const bytes = Buffer.from(PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}
describe("bounded copied raster output, independently generated real files", () => {
  const cases: [keyof typeof RASTER_FIXTURES, AiRasterMime][] = [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ];
  it.each(cases)(
    "accepts %s framing with exact metadata and copied bytes",
    (format, mime) => {
      const bytes = Buffer.from(RASTER_FIXTURES[format], "base64");
      const result = AiImageOutput.fromBytes(bytes, mime, 23);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).toMatchObject({
        mimeType: mime,
        width: 2,
        height: 3,
        seed: 23,
      });
      expect(result.copyBytes()).toEqual(new Uint8Array(bytes));
      bytes.fill(0);
      expect(result.copyBytes().some((byte) => byte !== 0)).toBe(true);
      const copy = result.copyBytes();
      copy.fill(0);
      expect(result.copyBytes().some((byte) => byte !== 0)).toBe(true);
      result.release();
      result.release();
      expect(() => result.copyBytes()).toThrow("invalid");
    },
  );
  it("validates actual PNG fixture independently, not just a made-up header", () => {
    let offset = 8;
    const data: Buffer[] = [];
    while (offset < PNG.length) {
      const length = PNG.readUInt32BE(offset);
      if (PNG.toString("ascii", offset + 4, offset + 8) === "IDAT")
        data.push(PNG.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect(inflateSync(Buffer.concat(data)).byteLength).toBe(3 * (1 + 2 * 3));
  });
  it.each([
    "",
    "AA=",
    "AA-_",
    "data:image/png;base64,AA==",
    "A A=",
    "AB==",
    "AAB=",
  ])("rejects malformed or noncanonical base64 %s", (encoded) => {
    expect(() => decodeAiImage(encoded, "image/png", STABILITY_KEY)).toThrow(
      "invalid",
    );
  });
  it("rejects encoded allocation excess before decoding or image inspection", () => {
    expect(() =>
      decodeAiImage("A".repeat(4_000_004), "image/png", STABILITY_KEY),
    ).toThrow("invalid");
    expect(() =>
      AiImageOutput.fromBytes(
        new Uint8Array(MAX_AI_IMAGE_BYTES + 1),
        "image/png",
      ),
    ).toThrow("invalid");
  });
  it.each([
    [0, 1],
    [1, 0],
    [2049, 1],
    [1, 2049],
    [0xffffffff, 0xffffffff],
  ])("rejects out-of-bound PNG dimensions %s/%s", (w, h) => {
    expect(() => AiImageOutput.fromBytes(pngSize(w, h), "image/png")).toThrow(
      "invalid",
    );
  });
  it("rejects wrong MIME, corrupt CRC, truncated and trailing PNG data", () => {
    const corrupt = Buffer.from(PNG);
    corrupt[30] ^= 1;
    for (const bytes of [
      corrupt,
      PNG.subarray(0, -1),
      Buffer.concat([PNG, Buffer.from([0])]),
    ])
      expect(() => AiImageOutput.fromBytes(bytes, "image/png")).toThrow(
        "invalid",
      );
    expect(() => AiImageOutput.fromBytes(PNG, "image/jpeg")).toThrow("invalid");
  });
  it("rejects animation and credential reflection in otherwise framed PNG", () => {
    const animated = Buffer.concat([
      PNG.subarray(0, -12),
      pngChunk("acTL", new Uint8Array(8)),
      PNG.subarray(-12),
    ]);
    expect(() => AiImageOutput.fromBytes(animated, "image/png")).toThrow(
      "invalid",
    );
    const reflected = pngWithComment(STABILITY_KEY).toString("base64");
    expect(() => decodeAiImage(reflected, "image/png", STABILITY_KEY)).toThrow(
      "invalid",
    );
    expect(() =>
      decodeAiImage(STABILITY_KEY, "image/png", STABILITY_KEY),
    ).toThrow("invalid");
  });
  it("rejects illegal reserved chunk names and nonconsecutive IDAT, including empty IDAT", () => {
    const reserved = Buffer.concat([
      PNG.subarray(0, -12),
      pngChunk("tExt", new Uint8Array([0])),
      PNG.subarray(-12),
    ]);
    expect(() => AiImageOutput.fromBytes(reserved, "image/png")).toThrow(
      "invalid",
    );
    const split = Buffer.concat([
      PNG.subarray(0, 33),
      pngChunk("IDAT", new Uint8Array()),
      pngChunk("tEXt", new Uint8Array([0])),
      PNG.subarray(33),
    ]);
    expect(() => AiImageOutput.fromBytes(split, "image/png")).toThrow(
      "invalid",
    );
  });
  it.each(["jpeg", "webp"] as const)(
    "rejects truncated/trailing %s",
    (format) => {
      const bytes = Buffer.from(RASTER_FIXTURES[format], "base64");
      const mime: AiRasterMime =
        format === "jpeg" ? "image/jpeg" : "image/webp";
      expect(() =>
        AiImageOutput.fromBytes(bytes.subarray(0, -1), mime),
      ).toThrow("invalid");
      expect(() =>
        AiImageOutput.fromBytes(Buffer.concat([bytes, Buffer.from([0])]), mime),
      ).toThrow("invalid");
    },
  );
  it("rejects animation flag and huge canvas on extended WebP", () => {
    const frame = Buffer.from(RASTER_FIXTURES.webp, "base64");
    const extended = Buffer.alloc(18);
    extended.write("VP8X");
    extended.writeUInt32LE(10, 4);
    extended[8] = 2;
    const animated = Buffer.concat([
      frame.subarray(0, 12),
      extended,
      frame.subarray(12),
    ]);
    animated.writeUInt32LE(animated.length - 8, 4);
    expect(() => AiImageOutput.fromBytes(animated, "image/webp")).toThrow(
      "invalid",
    );
    animated[20] = 0;
    animated.fill(255, 24, 30);
    expect(() => AiImageOutput.fromBytes(animated, "image/webp")).toThrow(
      "invalid",
    );
  });
  it.each([-1, 1.1, 4294967295, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid seed %s",
    (seed) => {
      expect(() => AiImageOutput.fromBytes(PNG, "image/png", seed)).toThrow(
        "invalid",
      );
    },
  );
});
