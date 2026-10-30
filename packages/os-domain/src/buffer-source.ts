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
  const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )?.get;
  if (!typedArrayBuffer || !typedArrayValues || !arrayBufferLength)
    return false;
  try {
    typedArrayValues.call(bytes);
    const buffer = typedArrayBuffer.call(bytes);
    arrayBufferLength.call(buffer);
    return true;
  } catch {
    return false;
  }
}
