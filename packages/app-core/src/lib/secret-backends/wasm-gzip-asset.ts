/** Bounded authenticated gzip transport shared by isolated browser WASM loaders. */
import type { SecretBackendFetch } from "./types.js";

export type WasmAssetPin = Readonly<{ bytes: number; hash: string }>;
export type GzipWasmAsset = Readonly<{
  url: string;
  compressed: WasmAssetPin;
  raw: WasmAssetPin;
}>;
type AssetFailure = () => Error;
const MAX_BYTES = 64 * 1024 * 1024;
function capturedPin(pin: WasmAssetPin, failure: AssetFailure): WasmAssetPin {
  const { bytes, hash } = pin;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    throw failure();
  return Object.freeze({ bytes, hash });
}
async function boundedBytes(
  body: ReadableStream<Uint8Array>,
  pin: WasmAssetPin,
  signal: AbortSignal,
  check: () => void,
  failure: AssetFailure,
): Promise<ArrayBuffer> {
  let size = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      check();
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > pin.bytes) throw failure();
      controller.enqueue(chunk);
    },
  });
  const bytes = await new Response(
    body.pipeThrough(bounded, { signal }),
  ).arrayBuffer();
  check();
  signal.throwIfAborted();
  if (bytes.byteLength !== pin.bytes) throw failure();
  return bytes;
}
async function verifiedBuffer(
  bytes: ArrayBuffer,
  pin: WasmAssetPin,
  signal: AbortSignal,
  check: () => void,
  failure: AssetFailure,
): Promise<ArrayBuffer> {
  if (bytes.byteLength !== pin.bytes) throw failure();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  check();
  signal.throwIfAborted();
  const hex = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== pin.hash) throw failure();
  return bytes;
}

async function verifiedBytes(
  body: ReadableStream<Uint8Array>,
  pin: WasmAssetPin,
  signal: AbortSignal,
  check: () => void,
  failure: AssetFailure,
): Promise<ArrayBuffer> {
  return verifiedBuffer(
    await boundedBytes(body, pin, signal, check, failure),
    pin,
    signal,
    check,
    failure,
  );
}
async function verifiedNetworkBytes(
  response: Response,
  pin: WasmAssetPin,
  signal: AbortSignal,
  check: () => void,
  failure: AssetFailure,
): Promise<ArrayBuffer> {
  const copy = response.clone();
  let complete = false;
  try {
    if (!copy.body) throw failure();
    await boundedBytes(copy.body, pin, signal, check, failure);
    const bytes = await response.arrayBuffer();
    complete = true;
    check();
    signal.throwIfAborted();
    return await verifiedBuffer(bytes, pin, signal, check, failure);
  } finally {
    if (!complete)
      await Promise.allSettled([copy.body?.cancel(), response.body?.cancel()]);
  }
}
/** Authenticate bounded gzip transport, then the official raw WASM, before instantiation. */
export function createGzipWasmAssetFetch(
  asset: GzipWasmAsset,
  signal: AbortSignal,
  check: () => void,
  nativeFetch: SecretBackendFetch,
  failure: AssetFailure,
): SecretBackendFetch {
  const url = asset.url;
  const compressedPin = capturedPin(asset.compressed, failure);
  const rawPin = capturedPin(asset.raw, failure);
  return async (input, init) => {
    check();
    const request = new Request(input, init);
    if (request.url !== url || request.method !== "GET") throw failure();
    const combined = AbortSignal.any([signal, request.signal]);
    const response = await nativeFetch(request.url, {
      signal: combined,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    check();
    combined.throwIfAborted();
    if (
      !response.ok ||
      response.redirected ||
      response.url !== url ||
      !response.body
    )
      throw failure();
    const compressed = await verifiedNetworkBytes(
      response,
      compressedPin,
      combined,
      check,
      failure,
    );
    check();
    combined.throwIfAborted();
    let bytes: ArrayBuffer;
    try {
      const decoded = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"), { signal: combined });
      bytes = await verifiedBytes(decoded, rawPin, combined, check, failure);
    } catch {
      throw failure();
    }
    check();
    combined.throwIfAborted();
    return new Response(bytes, {
      headers: { "Content-Type": "application/wasm" },
    });
  };
}
