import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import {
  type OnePasswordAssets,
  onePasswordNetworkError,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";

/** Verify exact owned raw WASM bytes before the SDK can instantiate them. */
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
    let size = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        check();
        combined.throwIfAborted();
        size += chunk.byteLength;
        if (size > artifacts.sdk.wasmBytes) throw onePasswordNetworkError();
        controller.enqueue(chunk);
      },
    });
    const bytes = await new Response(
      response.body.pipeThrough(bounded, { signal: combined }),
    ).arrayBuffer();
    check();
    combined.throwIfAborted();
    if (bytes.byteLength !== artifacts.sdk.wasmBytes)
      throw onePasswordNetworkError();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    check();
    combined.throwIfAborted();
    const hex = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (hex !== artifacts.sdk.wasmHash) throw onePasswordNetworkError();
    return new Response(bytes, {
      headers: { "Content-Type": "application/wasm" },
    });
  };
}
