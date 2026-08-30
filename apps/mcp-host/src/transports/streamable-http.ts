import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  MCP_BEARER_PROFILE,
  assertBearerScheme,
  parseBearerAuthorization,
} from "../auth/bearer.js";
import { PROTECTED_RESOURCE_WELL_KNOWN } from "../auth/protected-resource.js";
import { hostApiBase } from "../host-api.js";

/**
 * Streamable HTTP transport (ADR 0023, ADR 0065).
 *
 * Loopback-only: the listener refuses any non-loopback host fail-closed —
 * TLS termination is out of scope for this binary, so it never accepts a
 * routable bind. Callers authenticate with the Bearer profile
 * `mcp-authorization-2026-07-28-bearer`; the inbound bearer authenticates the
 * transport ONLY and is never read by any tool nor forwarded downstream —
 * tools keep using their own operator/session environment credentials.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MIN_TOKEN_LENGTH = 16;

export interface HttpTransportConfig {
  host: string;
  port: number;
  token: string;
}

export function resolveHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpTransportConfig {
  const listen = env.OPENSESAME_MCP_HTTP_LISTEN?.trim() || "127.0.0.1:18791";
  const at = listen.lastIndexOf(":");
  if (at <= 0) {
    throw new Error("mcp_http_listen_invalid");
  }
  const host = listen.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(listen.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("mcp_http_listen_invalid");
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("mcp_http_loopback_required");
  }
  const token = env.OPENSESAME_MCP_HTTP_TOKEN?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new Error("mcp_http_token_required");
  }
  return { host, port, token };
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function unauthorized(res: ServerResponse, reason: string): void {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": `Bearer resource_metadata="${hostApiBase()}${PROTECTED_RESOURCE_WELL_KNOWN}", error="invalid_token"`,
  });
  res.end(JSON.stringify({ error: reason, profile: MCP_BEARER_PROFILE }));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const parsed = parseBearerAuthorization(req.headers.authorization);
  if (!parsed) {
    return false;
  }
  try {
    assertBearerScheme(parsed.scheme);
  } catch {
    return false;
  }
  return tokenMatches(parsed.token, token);
}

export interface RunningHttpTransport {
  server: Server;
  close(): Promise<void>;
}

/**
 * Holds the transport between `listen` and the first request.
 *
 * The transport cannot be constructed until the server is bound, because the
 * DNS-rebinding allowlist needs the real port, but the request handler is
 * installed before that. A named owner contract keeps the slot's shape in one
 * place rather than restating it at the binding.
 */
interface TransportSlot {
  current?: StreamableHTTPServerTransport;
}

/**
 * The bound TCP port, parsed at the `net` boundary.
 *
 * `Server.address()` is a union of `AddressInfo`, a pipe path, and `null`.
 * Parsing it into a port here means the caller branches on a domain value — a
 * port or nothing — instead of narrowing the representation at the use site.
 */
function parseBoundPort(address: ReturnType<Server["address"]>): number | null {
  const parsed = BoundAddress.safeParse(address);
  return parsed.success ? parsed.data.port : null;
}

const BoundAddress = z.object({ port: z.number().int().min(0).max(65_535) });

export async function connectStreamableHttp(
  server: McpServer,
  config: HttpTransportConfig = resolveHttpConfig(),
): Promise<RunningHttpTransport> {
  // The transport is created after listen so the DNS-rebinding Host-header
  // allowlist carries the actual bound port (config.port may be 0 in tests).
  const transportRef: TransportSlot = {};

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: "streamable-http" }));
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (!authorized(req, config.token)) {
      unauthorized(res, "unauthorized");
      return;
    }
    const transport = transportRef.current;
    if (!transport) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "transport_starting" }));
      return;
    }
    transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "transport_failure" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, resolve);
  });

  const boundPort = parseBoundPort(httpServer.address()) ?? config.port;
  const connected = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts: [
      `${config.host}:${boundPort}`,
      `127.0.0.1:${boundPort}`,
      `localhost:${boundPort}`,
      `[::1]:${boundPort}`,
    ],
  });
  // The SDK types `onclose` as `(() => void) | undefined`; under
  // exactOptionalPropertyTypes that is not assignable to `Transport`'s
  // `onclose?: () => void`, so the direct call does not compile. A single
  // narrowing is enough — widening through `unknown` first would discard the
  // rest of the type evidence for nothing.
  // SAFETY: `connected` structurally implements every Transport member called.
  await server.connect(connected as Transport);
  transportRef.current = connected;

  return {
    server: httpServer,
    close: async () => {
      await connected.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
