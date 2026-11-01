/**
 * TypeScript 7 types DOM `BufferSource` as ArrayBuffer-backed views only.
 * Node and shared crypto code often holds `Uint8Array<ArrayBufferLike>`;
 * copy at Web Crypto / fetch / WebAuthn boundaries instead of widening types.
 */

/** Fresh ArrayBuffer-backed copy; safe to pass to Web Crypto and fetch bodies. */
export function ownBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(source);
}

export function asBufferSource(source: Uint8Array): BufferSource {
  return ownBytes(source);
}

/** Normalize any BufferSource into an ArrayBuffer-backed view. */
export function bytesFromBufferSource(source: BufferSource): Uint8Array<ArrayBuffer> {
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return Uint8Array.from(view);
}
