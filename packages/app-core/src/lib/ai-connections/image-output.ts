/** A bounded copied raster; it grants no remote URL, download or ready-preview authority. */
import { base64ToBytes } from "../native-base64.js";
import {
  type AiRasterMime,
  MAX_AI_IMAGE_BYTES,
  inspectAiRaster,
  invalidAiImage,
} from "./image-raster.js";
export type { AiRasterMime } from "./image-raster.js";
export {
  MAX_AI_IMAGE_BYTES,
  MAX_AI_IMAGE_PIXELS,
  MAX_AI_IMAGE_SIDE,
} from "./image-raster.js";

export class AiImageOutput {
  #bytes: Uint8Array | null;
  private constructor(
    bytes: Uint8Array,
    readonly mimeType: AiRasterMime,
    readonly width: number,
    readonly height: number,
    readonly seed?: number,
  ) {
    this.#bytes = bytes;
  }
  copyBytes(): Uint8Array {
    if (!this.#bytes) return invalidAiImage();
    return new Uint8Array(this.#bytes);
  }
  /** The result owner must release bytes on withdrawal or replacement. */
  release(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }
  static fromBytes(bytes: Uint8Array, mimeType: AiRasterMime, seed?: number) {
    if (
      seed !== undefined &&
      (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967294)
    )
      invalidAiImage();
    if (!bytes.length || bytes.length > MAX_AI_IMAGE_BYTES) invalidAiImage();
    const owned = new Uint8Array(bytes);
    try {
      const { width, height } = inspectAiRaster(owned, mimeType);
      const result = new AiImageOutput(owned, mimeType, width, height, seed);
      Object.freeze(result);
      return result;
    } catch (error) {
      owned.fill(0);
      throw error;
    }
  }
}
function base64Size(encoded: string, secret: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (
    !encoded.length ||
    encoded.length % 4 ||
    encoded.length > Math.ceil(MAX_AI_IMAGE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    (secret && encoded.includes(secret))
  )
    invalidAiImage();
  const length = (encoded.length / 4) * 3 - padding;
  if (length > MAX_AI_IMAGE_BYTES) invalidAiImage();
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(encoded[encoded.length - padding - 1]);
  if ((padding === 2 && last & 15) || (padding === 1 && last & 3))
    invalidAiImage();
  return length;
}
export function decodeAiImage(
  encoded: string,
  mimeType: AiRasterMime,
  secret: string,
  seed?: number,
): AiImageOutput {
  const length = base64Size(encoded, secret);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    return invalidAiImage();
  }
  try {
    if (
      bytes.length !== length ||
      (secret && new TextDecoder().decode(bytes).includes(secret))
    )
      invalidAiImage();
    return AiImageOutput.fromBytes(bytes, mimeType, seed);
  } finally {
    bytes.fill(0);
  }
}
