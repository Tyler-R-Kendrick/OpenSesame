/**
 * One request, sent (ADR 0199): with the extension's own fetch, no cookie, no
 * redirect followed, bounded in time and in size, and answered as text. What
 * the provider says is passed back as it is; it is never logged and never kept.
 */
import {
  type BridgeErrorCode,
  type BridgeFetchResponse,
  MAX_RESPONSE_BODY,
  REQUEST_TIMEOUT_MS,
  responseHeaders,
} from "@opensesame/connector-bridge";
import type {
  BridgeFetchRequest,
  HeaderPair,
} from "@opensesame/connector-bridge";
import type { BridgePorts } from "./ports.js";

export type Forwarded =
  | { ok: true; response: BridgeFetchResponse }
  | { ok: false; code: BridgeErrorCode };

const EMPTY_STATUS = new Set([204, 205, 304]);

async function readBounded(
  response: Response,
): Promise<string | "too_large" | "network"> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BODY) return "too_large";
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "network";
  }
}

function failure(error: Error): BridgeErrorCode {
  return error.name === "AbortError" ? "timeout" : "network";
}

export async function forward(
  ports: BridgePorts,
  url: URL,
  request: BridgeFetchRequest,
  headers: readonly HeaderPair[],
): Promise<Forwarded> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await ports.fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      signal: controller.signal,
    });
    if (response.redirected) return { ok: false, code: "redirect_refused" };
    const empty =
      request.method === "HEAD" || EMPTY_STATUS.has(response.status);
    const body = empty ? "" : await readBounded(response);
    if (body === "too_large" || body === "network")
      return { ok: false, code: body };
    return {
      ok: true,
      response: {
        status: response.status,
        headers: responseHeaders(response.headers),
        body,
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error ? failure(error) : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}
