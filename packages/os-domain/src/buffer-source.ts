/** Checks the actual backing-store brand and view validity across realms without copying bytes. */
export function isArrayBufferBackedBytes(
  bytes: Uint8Array,
): bytes is Uint8Array<ArrayBuffer> {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayBuffer = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "buffer",
  )?.get;
  const typedArrayValues = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "values",
  )?.value;
  const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
  )?.get;
  const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )?.get;
  if (
    !typedArrayBuffer ||
    !typedArrayValues ||
    !typedArrayTag ||
    !arrayBufferLength
  )
    return false;
  try {
    if (typedArrayTag.call(bytes) !== "Uint8Array") return false;
    typedArrayValues.call(bytes);
    const buffer = typedArrayBuffer.call(bytes);
    arrayBufferLength.call(buffer);
    return true;
  } catch {
    return false;
  }
}
