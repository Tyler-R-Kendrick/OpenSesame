import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { SecretBackendError } from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4096;

/** Only a received HTTP response supplies status; provider payloads are never retained. */
export class SecretBackendHttpError extends SecretBackendError {
  private constructor(
    code: SecretBackendError["code"],
    message: string,
    readonly status: number,
    readonly responseKind: "token-error" | null,
  ) {
    super(code, message);
  }
  static async fromResponse(
    response: Response,
    code: SecretBackendError["code"],
    message: string,
    signal: AbortSignal,
  ): Promise<SecretBackendError> {
    const status = response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599)
      return new SecretBackendError(code, message);
    const kind = status === 403 ? await tokenErrorKind(response, signal) : null;
    return new SecretBackendHttpError(
      code,
      message,
      status,
      signal.aborted ? null : kind,
    );
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

function closeErrorReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  complete: boolean,
): void {
  try {
    try {
      if (!complete) void reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  } catch {
    return;
  }
}

function jsonErrorMedia(response: Response): boolean {
  const media = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    media === "application/json" ||
    /^application\/[a-z0-9!#$%&'*+.^_`|~-]+\+json$/.test(media ?? "")
  );
}

async function tokenErrorKind(
  response: Response,
  signal: AbortSignal,
): Promise<"token-error" | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort: (() => void) | undefined;
  let complete = false;
  try {
    signal.throwIfAborted();
    reader = response.body?.getReader();
    if (!reader) return null;
    if (!jsonErrorMedia(response)) return null;
    const ended = new Promise<null>((resolve) => {
      abort = () => resolve(null);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const bytes = new Uint8Array(MAX_ERROR_RESPONSE_BYTES);
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), ended]);
      if (!part || signal.aborted) return null;
      if (part.done) {
        complete = true;
        break;
      }
      if (!part.value.byteLength || part.value.byteLength > bytes.length - size)
        return null;
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    const parsed: BoundaryValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    return signal.aborted ? null : parsedTokenErrorKind(parsed);
  } catch {
    return null;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (reader) closeErrorReader(reader, complete);
  }
}

function parsedTokenErrorKind(parsed: BoundaryValue): "token-error" | null {
  return isJsonObject(parsed) &&
    Object.hasOwn(parsed, "statusCode") &&
    parsed.statusCode === 403 &&
    Object.hasOwn(parsed, "error") &&
    parsed.error === "TokenError"
    ? "token-error"
    : null;
}

async function checkStatus(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw await SecretBackendHttpError.fromResponse(
      response,
      "authentication",
      "The backend refused these credentials or permissions.",
      signal,
    );
  if (response.status === 404)
    throw await SecretBackendHttpError.fromResponse(
      response,
      "not-found",
      "The requested backend item was not found.",
      signal,
    );
  throw await SecretBackendHttpError.fromResponse(
    response,
    "response",
    `The backend request failed (HTTP ${response.status}).`,
    signal,
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

async function readReply(
  response: Response,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  await checkStatus(response, signal);
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
    let signal: AbortSignal;
    try {
      const caller = init.signal;
      const timeout = AbortSignal.timeout(20_000);
      signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
      response = await fetcher(target.href, {
        ...init,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (error instanceof SecretBackendError) throw error;
      throw new SecretBackendError(
        "network",
        "Could not reach this backend. Check its URL, TLS, browser permissions and CORS access for this origin.",
      );
    }
    return readReply(response, signal);
  };
}
