/** Capture intrinsics; caller-controlled views never supply methods or getters. */
const prototype = Object.getPrototypeOf(Uint8Array.prototype);
const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)?.get;
const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
const length = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const values = Uint8Array.prototype.values;
const set = Uint8Array.prototype.set;

/** Make a private copy of an attached, non-shared Uint8Array's exact view. */
export function copyPrfBytes(bytes: Uint8Array): ArrayBuffer {
  if (
    !tag ||
    !buffer ||
    !length ||
    !arrayBufferLength ||
    tag.call(bytes) !== "Uint8Array"
  ) {
    throw new TypeError("Expected a Uint8Array");
  }
  // Validate attached, in-bounds views before reading intrinsic metadata.
  values.call(bytes);
  const actualBuffer: unknown = buffer.call(bytes);
  arrayBufferLength.call(actualBuffer);
  const size: number = length.call(bytes);
  const copy = new Uint8Array(size);
  set.call(copy, bytes);
  return copy.buffer;
}
