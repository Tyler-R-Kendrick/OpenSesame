/** Framing and allocation bounds; browser presentation must still verify decoding. */
import { AiConnectionError } from "./types.js";
export type AiRasterMime = "image/png" | "image/jpeg" | "image/webp";
export const MAX_AI_IMAGE_BYTES = 3_000_000;
export const MAX_AI_IMAGE_SIDE = 2048;
export const MAX_AI_IMAGE_PIXELS = 4_194_304;
export function invalidAiImage(): never {
  throw new AiConnectionError(
    "response",
    "The AI service returned an invalid or unsupported raster image.",
  );
}
function dimensions(width: number, height: number) {
  if (
    !width ||
    !height ||
    width > MAX_AI_IMAGE_SIDE ||
    height > MAX_AI_IMAGE_SIDE ||
    width * height > MAX_AI_IMAGE_PIXELS
  )
    invalidAiImage();
  return { width, height };
}
function text(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const depth = bytes[24];
  const color = bytes[25];
  const validDepth =
    color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
  if (
    bytes.length < 45 ||
    view.getUint32(8) !== 13 ||
    text(bytes, 12, 4) !== "IHDR" ||
    ![0, 2, 3, 4, 6].includes(color) ||
    !validDepth.includes(depth) ||
    bytes[26] ||
    bytes[27] ||
    bytes[28] > 1
  )
    invalidAiImage();
  return { ...dimensions(view.getUint32(16), view.getUint32(20)), color };
}
type PngProgress = {
  image: boolean;
  palette: boolean;
  afterImage: boolean;
  color: number;
  idatSeen: boolean;
};
function pngChunk(bytes: Uint8Array, view: DataView, offset: number) {
  const length = view.getUint32(offset);
  const end = offset + 12 + length;
  if (end > bytes.length) invalidAiImage();
  const type = text(bytes, offset + 4, 4);
  if (
    !/^[A-Za-z]{4}$/.test(type) ||
    crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
  )
    invalidAiImage();
  if (
    ["acTL", "fcTL", "fdAT"].includes(type) ||
    type[2] !== type[2].toUpperCase()
  )
    invalidAiImage();
  if (type === "IHDR" && offset !== 8) invalidAiImage();
  if (
    !["IHDR", "PLTE", "IDAT", "IEND"].includes(type) &&
    type[0] === type[0].toUpperCase()
  )
    invalidAiImage();
  return { length, end, type };
}
function pngProgress(state: PngProgress, type: string, length: number) {
  if (type === "PLTE") {
    if (
      state.idatSeen ||
      state.palette ||
      !length ||
      length > 768 ||
      length % 3 ||
      [0, 4].includes(state.color)
    )
      invalidAiImage();
    state.palette = true;
  } else if (type === "IDAT") {
    if (state.afterImage || (state.color === 3 && !state.palette))
      invalidAiImage();
    state.idatSeen = true;
    state.image ||= length > 0;
  } else if (state.idatSeen) state.afterImage = true;
}
function png(bytes: Uint8Array) {
  const size = pngHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = {
    image: false,
    palette: false,
    afterImage: false,
    color: size.color,
    idatSeen: false,
  };
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const { length, end, type } = pngChunk(bytes, view, offset);
    pngProgress(state, type, length);
    if (type === "IEND") {
      if (length || !state.image || end !== bytes.length) invalidAiImage();
      return dimensions(size.width, size.height);
    }
    offset = end;
  }
  return invalidAiImage();
}
function jpegFrame(bytes: Uint8Array, offset: number, length: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = bytes[offset + 7];
  if (
    length < 11 ||
    bytes[offset + 2] !== 8 ||
    ![1, 3, 4].includes(channels) ||
    length !== 8 + channels * 3
  )
    invalidAiImage();
  return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
}
function jpegSegment(bytes: Uint8Array, start: number) {
  let offset = start;
  if (bytes[offset++] !== 255) invalidAiImage();
  while (bytes[offset] === 255) offset++;
  const marker = bytes[offset++];
  if (marker === 217) return { marker, offset, length: 0 };
  if (
    !marker ||
    marker === 216 ||
    (marker >= 208 && marker <= 215) ||
    offset + 2 > bytes.length
  )
    invalidAiImage();
  const length = bytes[offset] * 256 + bytes[offset + 1];
  if (length < 2 || offset + length > bytes.length) invalidAiImage();
  return { marker, offset, length };
}
function jpegEntropyEnd(bytes: Uint8Array, start: number) {
  let offset = start;
  while (offset < bytes.length) {
    if (bytes[offset] !== 255) {
      offset++;
      continue;
    }
    const next = bytes[offset + 1];
    if (!next || (next >= 208 && next <= 215)) {
      offset += 2;
      continue;
    }
    break;
  }
  return offset;
}
function unsupportedJpegFrame(marker: number) {
  return marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker);
}
function jpeg(bytes: Uint8Array) {
  let offset = 2;
  let frame: { width: number; height: number } | undefined;
  let scan = false;
  while (offset < bytes.length) {
    const segment = jpegSegment(bytes, offset);
    const { marker, length } = segment;
    offset = segment.offset;
    if (marker === 217) {
      if (!frame || !scan || offset !== bytes.length) invalidAiImage();
      return frame;
    }
    if ([192, 193, 194].includes(marker)) {
      if (frame) invalidAiImage();
      frame = jpegFrame(bytes, offset, length);
    } else if (unsupportedJpegFrame(marker)) invalidAiImage();
    if (marker === 218) {
      if (!frame || length < 6 || length !== 6 + bytes[offset + 2] * 2)
        invalidAiImage();
      scan = true;
      offset = jpegEntropyEnd(bytes, offset + length);
    } else offset += length;
  }
  return invalidAiImage();
}
function webpFrame(
  bytes: Uint8Array,
  type: string,
  offset: number,
  length: number,
) {
  if (type === "VP8 ") {
    if (
      length < 10 ||
      bytes[offset] & 1 ||
      text(bytes, offset + 3, 3) !== "\x9d\x01\x2a"
    )
      invalidAiImage();
    return dimensions(
      (bytes[offset + 6] | (bytes[offset + 7] << 8)) & 0x3fff,
      (bytes[offset + 8] | (bytes[offset + 9] << 8)) & 0x3fff,
    );
  }
  if (length < 5 || bytes[offset] !== 47 || bytes[offset + 4] >> 5)
    invalidAiImage();
  const bits = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset + 1,
    4,
  ).getUint32(0, true);
  return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}
function webpChunk(bytes: Uint8Array, view: DataView, offset: number) {
  const type = text(bytes, offset, 4);
  const length = view.getUint32(offset + 4, true);
  const start = offset + 8;
  const end = start + length;
  if (end + (length & 1) > bytes.length || (length & 1 && bytes[end] !== 0))
    invalidAiImage();
  return { type, length, start, end };
}
function webpExtended(
  bytes: Uint8Array,
  offset: number,
  start: number,
  length: number,
) {
  if (
    offset !== 12 ||
    length !== 10 ||
    bytes[start] & 0xc3 ||
    bytes[start + 1] ||
    bytes[start + 2] ||
    bytes[start + 3]
  )
    invalidAiImage();
  const width =
    bytes[start + 4] | (bytes[start + 5] << 8) | (bytes[start + 6] << 16);
  const height =
    bytes[start + 7] | (bytes[start + 8] << 8) | (bytes[start + 9] << 16);
  return dimensions(width + 1, height + 1);
}
function webp(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(4, true) !== bytes.length - 8)
    invalidAiImage();
  let offset = 12;
  let frame: { width: number; height: number } | undefined;
  let extended: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const { type, length, start, end } = webpChunk(bytes, view, offset);
    if (type === "VP8X") extended = webpExtended(bytes, offset, start, length);
    else if (type === "VP8 " || type === "VP8L") {
      if (frame) invalidAiImage();
      frame = webpFrame(bytes, type, start, length);
    } else if (!extended || !["ALPH", "ICCP", "EXIF", "XMP "].includes(type))
      invalidAiImage();
    offset = end + (length & 1);
  }
  if (offset !== bytes.length || !frame) invalidAiImage();
  if (
    extended &&
    (extended.width !== frame.width || extended.height !== frame.height)
  )
    invalidAiImage();
  return frame;
}
export function inspectAiRaster(bytes: Uint8Array, mimeType: AiRasterMime) {
  if (!bytes.length || bytes.length > MAX_AI_IMAGE_BYTES) invalidAiImage();
  if (mimeType === "image/png" && text(bytes, 0, 8) === "\x89PNG\r\n\x1a\n")
    return png(bytes);
  if (mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216)
    return jpeg(bytes);
  if (
    mimeType === "image/webp" &&
    text(bytes, 0, 4) === "RIFF" &&
    text(bytes, 8, 4) === "WEBP"
  )
    return webp(bytes);
  return invalidAiImage();
}
