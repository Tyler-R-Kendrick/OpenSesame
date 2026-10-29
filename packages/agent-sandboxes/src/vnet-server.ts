/**
 * Reference virtual-network relay: performs the real HTTP requests for
 * WASM-hosted drivers, one cookie jar per session, redirects followed
 * relay-side. This is user-controlled infrastructure by design — it sees
 * reset traffic in plaintext, so it must never be a shared public proxy.
 * The bearer token grants access to all sessions: use it only among mutually
 * trusted clients. Session IDs and cookie jars do not provide tenant isolation.
 * Origins are bound on first use and
 * redirects stay within the session's approved origins. DNS uses checked, pinned
 * IPv4 addresses; loopback target access is an explicit development option.
 */

import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { CookieJar } from "./vnet-cookie-jar.js";
import { pinnedFetch } from "./vnet-pinned-fetch.js";
import {
  type VirtualFetchRequest,
  type VirtualFetchResponse,
  virtualFetchRequestSchema,
} from "./vnet.js";

export interface VirtualNetworkRelayOptions {
  port?: number;
  host?: string;
  token: string;
  /** Additional server-wide hostname restriction; session origins still apply. */
  allowedDomains?: readonly string[];
  /** Test/development only: allow literal localhost and 127.0.0.1 targets. */
  allowLoopbackTargets?: boolean;
  /** Idle sessions expire after this interval; default 30 minutes, maximum one day. */
  sessionIdleTtlMs?: number;
  /** Trusted monotonic clock override for tests. */
  now?: () => number;
  /** Trusted transport override; the caller is responsible for destination enforcement. */
  fetchImpl?: typeof fetch;
}

export interface RunningVirtualNetworkRelay {
  url: string;
  port: number;
  close(): Promise<void>;
}

type Session = {
  jar: CookieJar;
  origins: string[];
  lastUsed: number;
  active: number;
  closing: boolean;
};

type RelayContext = {
  options: VirtualNetworkRelayOptions;
  sessions: Map<string, Session>;
  ttl: number;
  now: () => number;
  allowed: ReadonlySet<string>;
  fetchImpl: typeof fetch;
};

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error(
      "virtual network: only HTTPS or loopback HTTP is permitted",
    );
  return url.origin;
}

function assertAllowed(
  url: URL,
  allowed: ReadonlySet<string>,
  session: Session,
): void {
  if (allowed.size > 0 && !allowed.has(url.hostname))
    throw new Error("virtual network: host is not allowlisted");
  if (!session.origins.includes(normalizedOrigin(url.href)))
    throw new Error("virtual network: origin is not allowed for this session");
}

function redirectTarget(
  response: Response,
  url: URL,
  method: string,
  body: string | undefined,
): { url: URL; method: string; body: string | undefined } | null {
  const location = response.headers.get("location");
  if (![301, 302, 303, 307, 308].includes(response.status) || !location)
    return null;
  const next = { url: new URL(location, url), method, body };
  if (
    response.status === 303 ||
    response.status === 301 ||
    response.status === 302
  ) {
    if (method !== "GET" && method !== "HEAD") {
      next.method = "GET";
      next.body = undefined;
    }
  }
  return next;
}

function requestHeaders(
  request: VirtualFetchRequest,
  forward: boolean,
  jar: CookieJar,
  url: URL,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    forward ? (request.headers ?? {}) : {},
  )) {
    const lower = name.toLowerCase();
    if (!["accept", "accept-language", "content-type"].includes(lower))
      throw new Error("virtual network: request header is not permitted");
    headers[lower] = value;
  }
  const cookies = jar.header(url);
  if (cookies) headers.cookie = cookies;
  return headers;
}

function isCrossOriginRedirect(
  redirect: { url: URL; method: string },
  url: URL,
  allowed: ReadonlySet<string>,
  session: Session,
): boolean {
  if (normalizedOrigin(redirect.url.href) === normalizedOrigin(url.href))
    return false;
  assertAllowed(redirect.url, allowed, session);
  if (
    (url.protocol === "https:" && redirect.url.protocol !== "https:") ||
    (redirect.method !== "GET" && redirect.method !== "HEAD")
  )
    throw new Error("virtual network: unsafe cross-origin redirect");
  return true;
}

async function performFetch(
  fetchImpl: typeof fetch,
  jar: CookieJar,
  allowed: ReadonlySet<string>,
  session: Session,
  request: VirtualFetchRequest,
): Promise<VirtualFetchResponse> {
  let url = new URL(request.url);
  let method = request.method.toUpperCase();
  let body = request.body;
  let forwardRequestHeaders = true;
  for (let hop = 0; hop <= 10; hop += 1) {
    assertAllowed(url, allowed, session);
    const headers = requestHeaders(request, forwardRequestHeaders, jar, url);
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined && method !== "GET" && method !== "HEAD")
      init.body = body;
    const response = await fetchImpl(url, init);
    jar.store(url, response.headers);
    const redirect = redirectTarget(response, url, method, body);
    if (redirect) {
      if (isCrossOriginRedirect(redirect, url, allowed, session)) {
        forwardRequestHeaders = false;
        redirect.body = undefined;
      }
      url = redirect.url;
      method = redirect.method;
      body = redirect.body;
      continue;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") responseHeaders[key] = value;
    });
    return {
      status: response.status,
      url: url.href,
      headers: responseHeaders,
      bodyText: await response.text(),
    };
  }
  throw new Error("virtual network: too many redirects");
}

async function readRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 1_000_000) {
        response.writeHead(413).end();
        return null;
      }
      chunks.push(bytes);
    }
  } catch {
    response.destroy();
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeSession(data: unknown, sessions: Map<string, Session>): void {
  if (
    !data ||
    typeof data !== "object" ||
    !("sessionId" in data) ||
    typeof data.sessionId !== "string" ||
    !data.sessionId ||
    data.sessionId.length > 128
  )
    throw new Error("virtual network: invalid session id");
  const session = sessions.get(data.sessionId);
  if (session) {
    session.closing = true;
    if (session.active === 0) sessions.delete(data.sessionId);
  }
}

function sessionFor(
  parsed: VirtualFetchRequest,
  context: RelayContext,
): Session {
  const currentTime = context.now();
  for (const [id, existing] of context.sessions) {
    if (
      existing.active === 0 &&
      (existing.closing || currentTime - existing.lastUsed >= context.ttl)
    )
      context.sessions.delete(id);
  }
  const origins = [
    ...new Set((parsed.allowedOrigins ?? [parsed.url]).map(normalizedOrigin)),
  ].sort();
  let session = context.sessions.get(parsed.sessionId);
  if (!session) {
    if (context.sessions.size >= 500)
      throw new Error("virtual network: session limit reached");
    session = {
      jar: new CookieJar(),
      origins,
      lastUsed: currentTime,
      active: 0,
      closing: false,
    };
    context.sessions.set(parsed.sessionId, session);
  } else if (session.closing) {
    throw new Error("virtual network: session is closing");
  } else if (
    parsed.allowedOrigins &&
    JSON.stringify(origins) !== JSON.stringify(session.origins)
  ) {
    throw new Error("virtual network: session policy changed");
  }
  return session;
}

async function fetchSession(
  parsed: VirtualFetchRequest,
  context: RelayContext,
): Promise<VirtualFetchResponse> {
  const session = sessionFor(parsed, context);
  session.active += 1;
  try {
    return await performFetch(
      context.fetchImpl,
      session.jar,
      context.allowed,
      session,
      parsed,
    );
  } finally {
    session.active -= 1;
    session.lastUsed = context.now();
    if (session.closing && session.active === 0)
      context.sessions.delete(parsed.sessionId);
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RelayContext,
): Promise<void> {
  if (
    request.method !== "POST" ||
    !["/fetch", "/close"].includes(request.url ?? "")
  ) {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${context.options.token}`) {
    response.writeHead(401).end();
    return;
  }
  const body = await readRequestBody(request, response);
  if (body === null) return;
  try {
    const data: unknown = JSON.parse(body);
    if (request.url === "/close") {
      closeSession(data, context.sessions);
      response.writeHead(204).end();
      return;
    }
    const parsed = virtualFetchRequestSchema.parse(data);
    const result = await fetchSession(parsed, context);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "fetch failed",
      }),
    );
  }
}

export async function startVirtualNetworkRelay(
  options: VirtualNetworkRelayOptions,
): Promise<RunningVirtualNetworkRelay> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1")
    throw new Error(
      "virtual network: plaintext listener must bind literal loopback",
    );
  if (!options.token) throw new Error("virtual network: token is required");
  const sessions = new Map<string, Session>();
  const ttl = options.sessionIdleTtlMs ?? 30 * 60_000;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60_000)
    throw new Error("virtual network: invalid session idle timeout");
  const now = options.now ?? (() => performance.now());
  const allowed = new Set(options.allowedDomains ?? []);
  const fetchImpl =
    options.fetchImpl ?? pinnedFetch(options.allowLoopbackTargets === true);
  const context: RelayContext = {
    options,
    sessions,
    ttl,
    now,
    allowed,
    fetchImpl,
  };
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response, context);
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const port =
    address instanceof Object && "port" in address ? address.port : 0;
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
