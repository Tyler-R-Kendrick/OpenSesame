import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import {
  type OnePasswordAssets,
  onePasswordNetworkError,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";

type AssetPin = { bytes: number; hash: string };
async function boundedBytes(
  body: ReadableStream<Uint8Array>,
  pin: AssetPin,
  signal: AbortSignal,
  check: () => void,
): Promise<ArrayBuffer> {
  let size = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      check();
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > pin.bytes) throw onePasswordNetworkError();
      controller.enqueue(chunk);
    },
  });
  const bytes = await new Response(
    body.pipeThrough(bounded, { signal }),
  ).arrayBuffer();
  check();
  signal.throwIfAborted();
  if (bytes.byteLength !== pin.bytes) throw onePasswordNetworkError();
  return bytes;
}
async function verifiedBuffer(
  bytes: ArrayBuffer,
  pin: AssetPin,
  signal: AbortSignal,
  check: () => void,
): Promise<ArrayBuffer> {
  if (bytes.byteLength !== pin.bytes) throw onePasswordNetworkError();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  check();
  signal.throwIfAborted();
  const hex = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== pin.hash) throw onePasswordNetworkError();
  return bytes;
}

async function verifiedBytes(
  body: ReadableStream<Uint8Array>,
  pin: AssetPin,
  signal: AbortSignal,
  check: () => void,
): Promise<ArrayBuffer> {
  return verifiedBuffer(
    await boundedBytes(body, pin, signal, check),
    pin,
    signal,
    check,
  );
}
async function verifiedNetworkBytes(
  response: Response,
  pin: AssetPin,
  signal: AbortSignal,
  check: () => void,
): Promise<ArrayBuffer> {
  const copy = response.clone();
  let complete = false;
  try {
    if (!copy.body) throw onePasswordNetworkError();
    await boundedBytes(copy.body, pin, signal, check);
    const bytes = await response.arrayBuffer();
    complete = true;
    check();
    signal.throwIfAborted();
    return await verifiedBuffer(bytes, pin, signal, check);
  } finally {
    if (!complete)
      await Promise.allSettled([copy.body?.cancel(), response.body?.cancel()]);
  }
}
/** Authenticate bounded gzip transport, then the official raw WASM, before instantiation. */
export function createOnePasswordAssetFetch(
  assets: OnePasswordAssets,
  signal: AbortSignal,
  check: () => void,
  nativeFetch: SecretBackendFetch,
): SecretBackendFetch {
  return async (input, init) => {
    check();
    const request = new Request(input, init);
    if (request.url !== assets.wasmUrl || request.method !== "GET")
      throw onePasswordNetworkError();
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
      response.url !== assets.wasmUrl ||
      !response.body
    )
      throw onePasswordNetworkError();
    const compressed = await verifiedNetworkBytes(
      response,
      {
        bytes: artifacts.sdk.wasmGzipBytes,
        hash: artifacts.sdk.wasmGzipHash,
      },
      combined,
      check,
    );
    check();
    combined.throwIfAborted();
    let bytes: ArrayBuffer;
    try {
      const decoded = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"), { signal: combined });
      bytes = await verifiedBytes(
        decoded,
        {
          bytes: artifacts.sdk.wasmBytes,
          hash: artifacts.sdk.wasmHash,
        },
        combined,
        check,
      );
    } catch {
      throw onePasswordNetworkError();
    }
    check();
    combined.throwIfAborted();
    return new Response(bytes, {
      headers: { "Content-Type": "application/wasm" },
    });
  };
}
