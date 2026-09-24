import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  type MetadataDnsLookup,
  assertSafeMetadataUrl,
  resolveSafeMetadataAddresses,
} from "@opensesame/oauth-provider/metadata/safe-fetcher";
import { isString } from "@opensesame/os-domain";

/**
 * The one outbound fetch for URLs a tenant, a visitor, or a document they
 * control chose: BYO and organization discovery, the JWKS a discovery
 * document names, SAML metadata, and every request openid-client makes on
 * behalf of such an issuer.
 *
 * `assertSafeMetadataUrl` judges only the URL as written, so a public name
 * that resolves to `10.0.0.1` or `169.254.169.254` walks straight past it.
 * With `blockPrivateHosts` on, this module therefore resolves the name, refuses
 * if ANY address is private or special (`resolveSafeMetadataAddresses`, the
 * same policy app-claim and webhooks use), and connects to the verified
 * address with the original name as Host and SNI — so a second, different DNS
 * answer at connect time cannot be what we talk to. Redirects are never
 * followed and the body is bounded.
 *
 * With `blockPrivateHosts` off — a deployment running with dev defaults,
 * where the reference IdP lives on loopback — it is a plain fetch that still
 * refuses redirects, exactly as before.
 */

/** Refusal of a destination. Callers map it to their own error vocabulary. */
export class UnsafeUpstreamError extends Error {
  override readonly name = "UnsafeUpstreamError";
}

type RequestBody = string | URLSearchParams | Uint8Array | ArrayBuffer;

export type GuardedFetchInit = {
  method?: string | undefined;
  headers?: HeadersInit | undefined;
  body?: RequestBody | null | undefined;
  signal?: AbortSignal | null | undefined;
  /** Response body ceiling in bytes. Default 512 KiB. */
  maxBytes?: number | undefined;
};

export type PinnedRequest = {
  url: URL;
  address: string;
  method: string;
  headers: Headers;
  body: Buffer | undefined;
  signal: AbortSignal;
  maxBytes: number;
};

export type PinnedTransport = (request: PinnedRequest) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The literal half of the fence: http(s), no userinfo, and no private,
 * loopback, link-local or metadata host as written. Throws
 * `UnsafeUpstreamError`.
 */
export function assertPublicUpstreamUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = assertSafeMetadataUrl(String(raw));
  } catch (error) {
    throw new UnsafeUpstreamError(
      error instanceof Error ? error.message : "Upstream refused",
    );
  }
  if (url.username || url.password) {
    throw new UnsafeUpstreamError("Upstream URL must not carry credentials");
  }
  return url;
}

function responseFrom(message: http.IncomingMessage, body: Buffer): Response {
  const raw = message.statusCode ?? 502;
  const status = raw >= 200 && raw <= 599 ? raw : 502;
  const headers = new Headers();
  const pairs = message.rawHeaders;
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    try {
      headers.append(pairs[index] ?? "", pairs[index + 1] ?? "");
    } catch {
      // A header the fetch API cannot represent is dropped, not fatal.
    }
  }
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    headers,
  });
}

/** One GET/POST to an already-verified address. Never follows a redirect. */
function pinnedTransport(request: PinnedRequest): Promise<Response> {
  const { url, address } = request;
  const secure = url.protocol === "https:";
  const name = url.hostname.replace(/^\[|\]$/g, "");
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers.host = url.host;
  if (request.body) headers["content-length"] = String(request.body.length);
  return new Promise((resolve, reject) => {
    const outgoing = (secure ? https : http).request(
      {
        hostname: address,
        family: isIP(address),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent: false,
        signal: request.signal,
        ...(secure
          ? {
              servername: isIP(name) ? undefined : name,
              rejectUnauthorized: true,
            }
          : undefined),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > request.maxBytes) {
            incoming.destroy();
            reject(new UnsafeUpstreamError("Upstream response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve(responseFrom(incoming, Buffer.concat(chunks))),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
}

/** Seams for tests: stub DNS and the wire, never the policy between them. */
export interface GuardedFetchSeams {
  lookup: MetadataDnsLookup;
  transport: PinnedTransport;
}

export const guardedFetchSeams: GuardedFetchSeams = {
  lookup: (hostname, options) => dnsLookup(hostname, options),
  transport: pinnedTransport,
};

function encodeBody(
  body: RequestBody | null | undefined,
  headers: Headers,
): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) {
      headers.set(
        "content-type",
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
    }
    return Buffer.from(body.toString(), "utf8");
  }
  if (isString(body)) return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new UnsafeUpstreamError("Unsupported request body");
}

export async function guardedFetch(
  target: string | URL,
  blockPrivateHosts: boolean,
  init: GuardedFetchInit = {},
): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  const body = encodeBody(init.body, headers);
  const method = init.method ?? "GET";
  if (!blockPrivateHosts) {
    return fetch(target, {
      method,
      headers,
      redirect: "error",
      signal,
      ...(body ? { body: new Uint8Array(body) } : undefined),
    });
  }
  const url = assertPublicUpstreamUrl(target);
  let addresses: string[];
  try {
    addresses = await resolveSafeMetadataAddresses(
      url,
      guardedFetchSeams.lookup,
    );
  } catch (error) {
    throw new UnsafeUpstreamError(
      error instanceof Error ? error.message : "Upstream refused",
    );
  }
  signal.throwIfAborted();
  const address = addresses[0];
  if (!address) throw new UnsafeUpstreamError("Upstream has no address");
  return guardedFetchSeams.transport({
    url,
    address,
    method,
    headers,
    body,
    signal,
    maxBytes: init.maxBytes ?? DEFAULT_MAX_BYTES,
  });
}

/** The init shape jose's and openid-client's `customFetch` hands over. */
type LibraryFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: RequestBody | ReadableStream | null | undefined;
  signal?: AbortSignal | null;
};

/**
 * A `customFetch` for jose or openid-client that routes every request the
 * library makes through {@link guardedFetch}. `extraHeaders` are layered on
 * top of the library's own (the origin-profile `Origin` pin). A streamed body
 * is refused: nothing these libraries send to an issuer is one.
 */
export function guardedLibraryFetch(
  blockPrivateHosts: boolean,
  extraHeaders?: Record<string, string>,
): (url: string | URL, options: LibraryFetchInit) => Promise<Response> {
  return (url, options) => {
    const headers = new Headers(options.headers);
    for (const [key, value] of Object.entries(extraHeaders ?? {})) {
      headers.set(key, value);
    }
    const body = options.body;
    if (body instanceof ReadableStream) {
      return Promise.reject(new UnsafeUpstreamError("Unsupported body"));
    }
    return guardedFetch(url, blockPrivateHosts, {
      method: options.method,
      headers,
      body,
      signal: options.signal,
    });
  };
}
