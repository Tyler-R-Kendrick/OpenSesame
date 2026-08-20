import http from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import {
  evaluateTokenCors,
  parseOriginClientId,
} from "@opensesame/oauth-provider";
import { createControlPlane } from "./create-app.js";

function applyHeaders(
  res: http.ServerResponse,
  headers: Record<string, string>,
) {
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
}

/** Ensure CORS headers are applied even when oidc-provider skips writeHead. */
function attachTokenCors(
  res: http.ServerResponse,
  headers: Record<string, string>,
): void {
  applyHeaders(res, headers);
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
    applyHeaders(res, headers);
    return originalWriteHead(statusCode, ...(rest as []));
  }) as typeof res.writeHead;
  const originalEnd = res.end.bind(res);
  res.end = ((...args: unknown[]) => {
    applyHeaders(res, headers);
    return originalEnd(...(args as Parameters<typeof res.end>));
  }) as typeof res.end;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The CORS gate must read the form body to learn the client_id, so the
 * request stream handed to oidc-provider is replayed from the buffer.
 */
function replayRequest(
  req: http.IncomingMessage,
  body: Buffer,
): http.IncomingMessage {
  const forwarded = Readable.from([body]) as unknown as http.IncomingMessage;
  forwarded.headers = req.headers;
  forwarded.rawHeaders = req.rawHeaders;
  forwarded.method = req.method;
  forwarded.url = req.url;
  forwarded.httpVersion = req.httpVersion;
  forwarded.httpVersionMajor = req.httpVersionMajor;
  forwarded.httpVersionMinor = req.httpVersionMinor;
  forwarded.socket = req.socket;
  return forwarded;
}

export async function startServer(
  options: Parameters<typeof createControlPlane>[0] = {},
): Promise<{
  server: http.Server;
  port: number;
  host: string;
  app: ReturnType<typeof createControlPlane>["app"];
  ctx: ReturnType<typeof createControlPlane>["ctx"];
}> {
  const { app, ctx, config } = createControlPlane(options);
  const honoListener = getRequestListener(app.fetch);
  const oidcCallback = ctx.oauth.provider.callback();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    // Mount panva oidc-provider for protocol endpoints + OIDC discovery.
    // Use path-segment boundaries so product routes like /auth.md are not captured.
    const isOidcPath =
      path === "/auth" ||
      path.startsWith("/auth/") ||
      path === "/token" ||
      path.startsWith("/token/") ||
      path === "/me" ||
      path.startsWith("/me/") ||
      path === "/jwks" ||
      path.startsWith("/jwks/") ||
      path === "/device" ||
      path.startsWith("/device/") ||
      path === "/session" ||
      path.startsWith("/session/") ||
      path === "/reg" ||
      path.startsWith("/reg/") ||
      path === "/request" ||
      path.startsWith("/request/") ||
      path === "/introspect" ||
      path.startsWith("/introspect/") ||
      path === "/revocation" ||
      path.startsWith("/revocation/") ||
      path === "/.well-known/openid-configuration" ||
      path === "/.well-known/oauth-authorization-server";
    if (!isOidcPath) {
      honoListener(req, res);
      return;
    }

    // Exact-origin CORS for browser public-client token exchange (ADR 0050 F3).
    // Enforced at the raw split, before oidc-provider, and lookup-only so
    // unauthenticated /token probes can never insert origin rows (F2).
    if (path === "/token") {
      void (async () => {
        const requestOrigin = req.headers.origin ?? null;

        if (req.method === "OPTIONS") {
          // Preflights carry no body: resolve the client by request origin.
          let clientOrigin: string | null = null;
          if (requestOrigin) {
            try {
              const meta = await ctx.oauth.lookupOriginClient(requestOrigin);
              clientOrigin = meta
                ? (parseOriginClientId(meta.client_id) ?? null)
                : null;
            } catch {
              clientOrigin = null;
            }
          }
          const decision = evaluateTokenCors(requestOrigin, clientOrigin);
          applyHeaders(res, decision.headers);
          res.statusCode = decision.allowed ? 204 : 403;
          res.end();
          return;
        }

        if (req.method === "POST") {
          const body = await readBody(req);
          const clientId = new URLSearchParams(body.toString("utf8")).get(
            "client_id",
          );
          let record: Awaited<
            ReturnType<typeof ctx.oauth.clientStore.findById>
          >;
          try {
            record = clientId
              ? await ctx.oauth.clientStore.findById(clientId)
              : undefined;
          } catch {
            record = undefined;
          }
          if (record?.origin) {
            // Origin-profile client: the Origin header must byte-equal the
            // persisted canonical origin — the substitute for the client
            // secret a static site cannot hold. Suspended/revoked or
            // flag-disabled records fail closed.
            let admissible = true;
            try {
              ctx.oauth.admission.assertAdmissible(record);
            } catch {
              admissible = false;
            }
            const decision = evaluateTokenCors(
              requestOrigin,
              admissible ? record.origin : null,
            );
            if (!decision.allowed) {
              applyHeaders(res, decision.headers);
              res.statusCode = 403;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  error: "unauthorized_client",
                  error_description: "origin_cors_denied",
                }),
              );
              return;
            }
            attachTokenCors(res, decision.headers);
          }
          // Non-origin-profile clients (pre_registered, server-to-server calls
          // without an Origin header) are not CORS-restricted — forward as-is.
          oidcCallback(replayRequest(req, body), res);
          return;
        }

        oidcCallback(req, res);
      })().catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
      return;
    }

    // Auto-admit first-seen origin clients on the authorization path (ADR 0050
    // F2): the only server-internal admission route. Failures fall through to
    // oidc-provider, which rejects the unknown client.
    if (path === "/auth") {
      void (async () => {
        try {
          const u = new URL(url, `http://${req.headers.host ?? "127.0.0.1"}`);
          const clientId = u.searchParams.get("client_id");
          if (clientId && parseOriginClientId(clientId) !== undefined) {
            await ctx.oauth.ensureOriginClient(clientId);
          }
        } catch {
          /* oidc-provider will reject */
        }
        oidcCallback(req, res);
      })().catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
      return;
    }

    oidcCallback(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null
      ? address.port
      : config.port;

  ctx.log.info(
    { host: config.host, port: boundPort, issuer: config.issuer },
    "control-plane listening",
  );

  return { server, port: boundPort, host: config.host, app, ctx };
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
