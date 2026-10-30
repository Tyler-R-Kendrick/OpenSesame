/** Make a private copy of an attached, non-shared Uint8Array's exact view. */
export function copyPrfBytes(bytes: Uint8Array): ArrayBuffer {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype);
  const tag = Object.getOwnPropertyDescriptor(
    prototype,
    Symbol.toStringTag,
  )?.get;
  const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
  const length = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
  const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )?.get;
  if (
    !tag ||
    !buffer ||
    !length ||
    !arrayBufferLength ||
    Reflect.apply(tag, bytes, []) !== "Uint8Array"
  ) {
    throw new TypeError("Expected a Uint8Array");
  }
  // Validate attached, in-bounds views before reading intrinsic metadata.
  Reflect.apply(Uint8Array.prototype.values, bytes, []);
  const actualBuffer: unknown = Reflect.apply(buffer, bytes, []);
  Reflect.apply(arrayBufferLength, actualBuffer, []);
  const size: number = Reflect.apply(length, bytes, []);
  const copy = new Uint8Array(size);
  Reflect.apply(Uint8Array.prototype.set, copy, [bytes]);
  return copy.buffer;
}
