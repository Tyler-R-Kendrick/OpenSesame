/** Checks the actual backing-store brand across realms without copying bytes.
 * Detached buffers still pass this check; consumers must handle API rejection. */
export function isArrayBufferBackedBytes(
  bytes: Uint8Array,
): bytes is Uint8Array<ArrayBuffer> {
  const typedArrayBuffer = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "buffer",
  )?.get;
  const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )?.get;
  if (!typedArrayBuffer || !arrayBufferLength) return false;
  try {
    const buffer = typedArrayBuffer.call(bytes);
    arrayBufferLength.call(buffer);
    return true;
  } catch {
    return false;
  }
}
