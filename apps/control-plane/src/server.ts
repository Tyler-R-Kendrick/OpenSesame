import http from "node:http";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { createControlPlane } from "./create-app.js";

export async function startServer(
  options: Parameters<typeof createControlPlane>[0] = {},
): Promise<{ server: http.Server; port: number; host: string }> {
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
    if (isOidcPath) {
      oidcCallback(req, res);
      return;
    }
    honoListener(req, res);
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

  return { server, port: boundPort, host: config.host };
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
