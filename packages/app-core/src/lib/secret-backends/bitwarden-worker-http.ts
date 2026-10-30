import type { BitwardenSdkSettings } from "./bitwarden-wasm-loader.js";
import type {
  BitwardenFetchRequest,
  BitwardenFetchResult,
} from "./bitwarden-worker-protocol.js";
import { secretBackendUrl } from "./http.js";
import { SecretBackendError, type SecretBackendFetch } from "./types.js";

const MAX_BYTES = 4 * 1024 * 1024;
async function boundedBody(response: Response) {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES)
    throw new Error("Response too large");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Main-realm SDK transport uses the same captured capability lease as every other backend. */
export function createBitwardenWorkerHttp(
  settings: BitwardenSdkSettings,
  fetcher: SecretBackendFetch,
  signal?: AbortSignal,
) {
  const endpoints = [
    secretBackendUrl(settings.apiUrl),
    secretBackendUrl(settings.identityUrl),
  ];
  return async (
    request: BitwardenFetchRequest,
  ): Promise<BitwardenFetchResult> => {
    signal?.throwIfAborted();
    const url = new URL(request.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !endpoints.some(
        (base) =>
          base.origin === url.origin && url.pathname.startsWith(base.pathname),
      )
    ) {
      throw new SecretBackendError(
        "configuration",
        "Bitwarden requests must stay within the configured API and identity endpoints.",
      );
    }
    if (new TextEncoder().encode(request.body).byteLength > MAX_BYTES)
      throw new SecretBackendError(
        "response",
        "The Bitwarden request exceeds the supported size.",
      );
    const timeout = AbortSignal.timeout(20_000);
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
    if (request.method !== "GET") init.body = request.body;
    const response = await fetcher(url.href, init);
    const bytes = await boundedBody(response);
    signal?.throwIfAborted();
    return {
      type: "fetch-result",
      id: request.id,
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url: url.href,
      headers: [...response.headers.entries()],
      body: bytes,
    };
  };
}
