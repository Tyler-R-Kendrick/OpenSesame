/**
 * Reference virtual-network relay: performs the real HTTP requests for
 * WASM-hosted drivers, one cookie jar per session, redirects followed
 * relay-side. This is user-controlled infrastructure by design — it sees
 * reset traffic in plaintext, so it must never be a shared public proxy.
 * The bearer token gates every request; request hosts must be on the
 * session allowlist derived when the session first fetches.
 */

import { type Server, createServer } from "node:http";
import {
  type VirtualFetchRequest,
  type VirtualFetchResponse,
  virtualFetchRequestSchema,
} from "./vnet.js";

export interface VirtualNetworkRelayOptions {
  port?: number;
  host?: string;
  token: string;
  /** Hostnames any session may reach. Empty means same-host as first fetch. */
  allowedDomains?: readonly string[];
  fetchImpl?: typeof fetch;
}

export interface RunningVirtualNetworkRelay {
  url: string;
  port: number;
  close(): Promise<void>;
}

type CookieJar = Map<string, Map<string, string>>;

function cookieHeader(jar: CookieJar, hostname: string): string {
  const host = jar.get(hostname);
  if (!host) return "";
  return [...host.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(jar: CookieJar, hostname: string, headers: Headers) {
  const raw = headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const host = jar.get(hostname) ?? new Map<string, string>();
    host.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    jar.set(hostname, host);
  }
}

function assertHostAllowed(
  url: URL,
  allowed: ReadonlySet<string>,
  pinnedHost: string | null,
): void {
  if (pinnedHost !== null && url.hostname !== pinnedHost)
    throw new Error("virtual network: host left the session origin");
  if (allowed.size > 0 && !allowed.has(url.hostname))
    throw new Error("virtual network: host is not allowlisted");
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
    if (method !== "GET" && method !== "HEAD") next.method = "GET";
    if (response.status === 303) next.body = undefined;
  }
  return next;
}

async function performFetch(
  fetchImpl: typeof fetch,
  jar: CookieJar,
  allowed: ReadonlySet<string>,
  pinnedHost: string | null,
  request: VirtualFetchRequest,
): Promise<VirtualFetchResponse> {
  let url = new URL(request.url);
  let method = request.method.toUpperCase();
  let body = request.body;
  for (let hop = 0; hop <= 10; hop += 1) {
    assertHostAllowed(url, allowed, pinnedHost);
    const headers = { ...(request.headers ?? {}) };
    const cookies = cookieHeader(jar, url.hostname);
    if (cookies) headers.cookie = cookies;
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined && method !== "GET" && method !== "HEAD")
      init.body = body;
    const response = await fetchImpl(url, init);
    storeCookies(jar, url.hostname, response.headers);
    const redirect = redirectTarget(response, url, method, body);
    if (redirect) {
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

export async function startVirtualNetworkRelay(
  options: VirtualNetworkRelayOptions,
): Promise<RunningVirtualNetworkRelay> {
  const jars = new Map<string, CookieJar>();
  const pinnedHosts = new Map<string, string>();
  const allowed = new Set(options.allowedDomains ?? []);
  const fetchImpl = options.fetchImpl ?? fetch;
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/fetch") {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      try {
        const parsed = virtualFetchRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        const jar = jars.get(parsed.sessionId) ?? new Map();
        jars.set(parsed.sessionId, jar);
        const pinned =
          allowed.size === 0
            ? (pinnedHosts.get(parsed.sessionId) ??
              new URL(parsed.url).hostname)
            : null;
        if (pinned) pinnedHosts.set(parsed.sessionId, pinned);
        const result = await performFetch(
          fetchImpl,
          jar,
          allowed,
          pinned,
          parsed,
        );
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
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    address instanceof Object && "port" in address ? address.port : 0;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
