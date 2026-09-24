import http from "node:http";
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import {
  evaluateTokenCors,
  parseOriginClientId,
} from "@opensesame/oauth-provider";
import {
  type BoundaryValue,
  isFunction,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { createControlPlane } from "./create-app.js";
import { loadTransportMaterial } from "./transport/config.js";
import {
  PLAIN_LISTENER_ID,
  TLS_LISTENER_ID,
  type TransportListener,
  createTransportListener,
  preparePlainRequest,
} from "./transport/listener.js";
import { readBody, replayRequest } from "./transport/replay.js";
import { rejectMismatchedBoundBearer } from "./transport/resource-binding.js";
import { EMPTY_BINDINGS } from "./transport/service-admission.js";

export interface StartedControlPlane {
  server: http.Server;
  port: number;
  host: string;
  app: ReturnType<typeof createControlPlane>["app"];
  ctx: ReturnType<typeof createControlPlane>["ctx"];
  /**
   * The optional native TLS listener (`OPENSESAME_TLS_LISTEN`), serving the
   * same dispatcher with verified peer evidence. Absent when unconfigured;
   * the plain listener above keeps its existing scope either way.
   */
  transport?: TransportListener & { port: number; host: string };
}

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
  res.writeHead = function writeHead(
    statusCode: number,
    statusMessageOrHeaders?:
      | string
      | OutgoingHttpHeaders
      | OutgoingHttpHeader[],
    responseHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) {
    applyHeaders(res, headers);
    const statusMessage: string | undefined = isString(
      overlapCast(statusMessageOrHeaders),
    )
      ? overlapCast(statusMessageOrHeaders)
      : undefined;
    if (statusMessage !== undefined) {
      return originalWriteHead(statusCode, statusMessage, responseHeaders);
    }
    const outgoingHeaders:
      | OutgoingHttpHeaders
      | OutgoingHttpHeader[]
      | undefined = overlapCast(statusMessageOrHeaders);
    return originalWriteHead(statusCode, outgoingHeaders);
  };
  const originalEnd = res.end.bind(res);
  res.end = function end(
    chunk?: BoundaryValue,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) {
    applyHeaders(res, headers);
    if (chunk === undefined) {
      return isFunction(encodingOrCallback)
        ? originalEnd(encodingOrCallback)
        : originalEnd();
    }
    if (isFunction(encodingOrCallback)) {
      return originalEnd(chunk, encodingOrCallback);
    }
    return encodingOrCallback === undefined
      ? originalEnd(chunk, callback)
      : originalEnd(chunk, encodingOrCallback, callback);
  };
}

type RawDispatcher = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

/**
 * The raw split shared by the plain and TLS listeners. Peer evidence for
 * the request is already recorded by the listener that received it; both
 * the oidc-provider branch and Hono read it from the same request object.
 */
function createDispatcher(
  ctx: ReturnType<typeof createControlPlane>["ctx"],
  honoListener: RawDispatcher,
  oidcCallback: RawDispatcher,
): RawDispatcher {
  return (req, res) => {
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
      path === "/.well-known/openid-configuration";
    if (!isOidcPath) {
      // A certificate-bound bearer is refused before any Hono route unless
      // this request's binding peer matches it (ID-RESOURCE).
      if (rejectMismatchedBoundBearer(req, res)) return;
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
          const grantType = new URLSearchParams(body.toString("utf8")).get(
            "grant_type",
          );
          if (
            grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
            grantType === "urn:workos:agent-auth:grant-type:claim"
          ) {
            const forwarded = replayRequest(req, body);
            forwarded.url = "/oauth2/token";
            if (rejectMismatchedBoundBearer(forwarded, res)) return;
            honoListener(forwarded, res);
            return;
          }
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
  };
}

export async function startServer(
  options: Parameters<typeof createControlPlane>[0] = {},
): Promise<StartedControlPlane> {
  const { app, ctx, config } = createControlPlane(options);
  const honoListener = getRequestListener(app.fetch);
  const oidcCallback = ctx.oauth.provider.callback();
  const dispatch = createDispatcher(ctx, honoListener, oidcCallback);

  // Optional native TLS listener (ID-LISTENER). Material was validated by
  // assertSecureConfig; a failure here is still a refused boot, never a
  // fallback to the plain listener.
  const listenerConfig = config.transport.listener;
  const transport: TransportListener | undefined = listenerConfig
    ? createTransportListener({
        config: listenerConfig,
        material: loadTransportMaterial(listenerConfig),
        dispatch,
        onPeerError: (code) =>
          ctx.log.warn({ listener: TLS_LISTENER_ID, code }, "peer_refused"),
      })
    : undefined;
  const bindings = () => transport?.bindings() ?? EMPTY_BINDINGS;

  const server = http.createServer((req, res) => {
    // Plain provenance, no peer: a header on this listener can never become
    // evidence (AT-TLS-FAKECONTEXT).
    preparePlainRequest(req, bindings());
    dispatch(req, res);
  });

  // The system owner principal row must exist before the first /auth prefetch
  // auto-admits an origin client owned by it (ADR 0050 R-A; the FK is real on
  // Postgres). Fail startup rather than fail the first admission.
  await ctx.systemPrincipalReady;

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  const addressInfo: AddressInfo | null = isString(overlapCast(address))
    ? null
    : overlapCast(address);
  const boundPort = addressInfo?.port ?? config.port;

  ctx.log.info(
    {
      host: config.host,
      port: boundPort,
      issuer: config.issuer,
      listener: PLAIN_LISTENER_ID,
    },
    "control-plane listening",
  );

  const started: StartedControlPlane = {
    server,
    port: boundPort,
    host: config.host,
    app,
    ctx,
  };
  if (transport && listenerConfig) {
    let tlsAddress: AddressInfo;
    try {
      tlsAddress = await transport.start();
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    ctx.log.info(
      {
        host: listenerConfig.host,
        port: tlsAddress.port,
        policy: listenerConfig.policy,
        listener: TLS_LISTENER_ID,
      },
      "control-plane tls listening",
    );
    started.transport = {
      ...transport,
      port: tlsAddress.port,
      host: listenerConfig.host,
    };
  }
  return started;
}

const isDirectRun =
  isString(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
