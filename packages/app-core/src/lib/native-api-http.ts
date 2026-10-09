/** Capability-fenced JSON transport; response errors never expose upstream material. */
import type { BoundaryValue } from "@opensesame/os-domain";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export class NativeApiError extends Error {
  constructor(
    readonly code:
      | "authorization"
      | "permission"
      | "rate-limit"
      | "response"
      | "network",
    readonly status = 0,
  ) {
    super(
      {
        authorization:
          "Provider authorization was refused; verify or replace the saved credential",
        permission: "Provider permissions do not allow this operation",
        "rate-limit": "Provider rate limit reached; try again later",
        response: "Provider did not return the expected response",
        network:
          "Could not reach the provider from this browser; check its CORS policy and your connection",
      }[code],
    );
    this.name = "NativeApiError";
  }
}
export type NativeApiHttpRequest = {
  url: string | URL;
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
  signal?: AbortSignal;
};

async function reply(response: Response): Promise<BoundaryValue> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeApiError("response", response.status);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024)
        throw new NativeApiError("response", response.status);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return result;
  } catch {
    throw new NativeApiError("response", response.status);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function nativeApiHttp(
  request: NativeApiHttpRequest,
  transport: NativeProviderTransport,
): Promise<BoundaryValue> {
  transport.assertCurrent();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const deadline = setTimeout(abort, 15_000);
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await transport.fetch(request.url, init);
    transport.assertCurrent();
    if (response.status === 401) throw new NativeApiError("authorization", 401);
    if (response.status === 403) throw new NativeApiError("permission", 403);
    if (response.status === 429) throw new NativeApiError("rate-limit", 429);
    if (!response.ok || response.redirected)
      throw new NativeApiError("response", response.status);
    const body = await reply(response);
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    return body;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    throw new NativeApiError("network");
  } finally {
    clearTimeout(deadline);
    request.signal?.removeEventListener("abort", abort);
  }
}
