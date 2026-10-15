import type { BoundaryValue } from "@opensesame/os-domain";
import { SecretBackendError } from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Only a received HTTP response supplies status; provider payloads are never retained. */
export class SecretBackendHttpError extends SecretBackendError {
  private constructor(
    code: SecretBackendError["code"],
    message: string,
    readonly status: number,
  ) {
    super(code, message);
  }
  static fromResponse(
    response: Response,
    code: SecretBackendError["code"],
    message: string,
  ): SecretBackendError {
    const status = response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599)
      return new SecretBackendError(code, message);
    return new SecretBackendHttpError(code, message, status);
  }
}

export function secretBackendUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecretBackendError(
      "configuration",
      "Enter a complete secret backend URL.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && loopback);
  const embedded = Boolean(
    url.username || url.password || url.search || url.hash,
  );
  if (!secure || embedded)
    throw new SecretBackendError(
      "configuration",
      "Use an HTTPS backend URL without credentials, query or fragment.",
    );
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function checkStatus(response: Response): void {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw SecretBackendHttpError.fromResponse(
      response,
      "authentication",
      "The backend refused these credentials or permissions.",
    );
  if (response.status === 404)
    throw SecretBackendHttpError.fromResponse(
      response,
      "not-found",
      "The requested backend item was not found.",
    );
  throw SecretBackendHttpError.fromResponse(
    response,
    "response",
    `The backend request failed (HTTP ${response.status}).`,
  );
}

function sizeLimit(size: number): void {
  if (size > MAX_RESPONSE_BYTES)
    throw new SecretBackendError(
      "response",
      "The backend response exceeds the supported size.",
    );
}

async function readBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    try {
      sizeLimit(size);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readReply(response: Response): Promise<BoundaryValue> {
  checkStatus(response);
  if (response.status === 204) return null;
  sizeLimit(Number(response.headers.get("content-length") ?? 0));
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const bytes = await readBytes(reader);
    if (bytes.length === 0) return null;
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parsed;
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw new SecretBackendError(
      "response",
      "The backend returned an unreadable response.",
    );
  } finally {
    reader.releaseLock();
  }
}

/** Credentials follow only the configured origin and base path; redirects are refused. */
export function createBackendHttp(
  baseUrl: string,
  fetcher: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
) {
  const base = secretBackendUrl(baseUrl);
  return async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<BoundaryValue> {
    const target = new URL(path.replace(/^\//, ""), base);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(base.pathname)
    )
      throw new SecretBackendError(
        "configuration",
        "The request must stay within the configured backend.",
      );
    let response: Response;
    try {
      response = await fetcher(target.href, {
        ...init,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof SecretBackendError) throw error;
      throw new SecretBackendError(
        "network",
        "Could not reach this backend. Check its URL, TLS, browser permissions and CORS access for this origin.",
      );
    }
    return readReply(response);
  };
}
