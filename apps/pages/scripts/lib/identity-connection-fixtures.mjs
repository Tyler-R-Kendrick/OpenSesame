/** Real pinned IdP servers: Chromium talks to their sockets without response mocks. */
import { createServer } from "node:http";
import { createRequire } from "node:module";

const root = new URL("../../../../", import.meta.url);
const authRequire = createRequire(
  new URL("packages/auth-upstream/package.json", root),
);
const oidcRequire = createRequire(
  new URL("packages/oauth-provider/package.json", root),
);
const load = (require, name) => import(require.resolve(name));

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://localhost:${server.address().port}`;
}
function close(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startBetterAuth(appOrigin) {
  const [{ betterAuth }, { memoryAdapter }, { jwt }] = await Promise.all([
    load(authRequire, "better-auth"),
    load(authRequire, "better-auth/adapters/memory"),
    load(authRequire, "better-auth/plugins"),
  ]);
  const requests = [];
  const errors = [];
  const server = createServer(async (incoming, outgoing) => {
    const cors = {
      "access-control-allow-origin": appOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    };
    if (incoming.method === "OPTIONS") {
      outgoing.writeHead(204, cors).end();
      return;
    }
    requests.push({
      method: incoming.method,
      path: new URL(incoming.url, issuer).pathname,
    });
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      // Neon exposes this same JWT plugin at the documented signing-key path.
      const requestPath =
        incoming.url === "/api/auth/.well-known/jwks.json"
          ? "/api/auth/jwks"
          : incoming.url;
      const response = await auth.handler(
        new Request(`${issuer}${requestPath}`, {
          method: incoming.method,
          headers: incoming.headers,
          body: body.length ? body : undefined,
        }),
      );
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      outgoing.writeHead(response.status, { ...headers, ...cors });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      errors.push(String(error));
      outgoing.writeHead(500, cors).end("fixture error");
    }
  });
  const issuer = await listening(server);
  const auth = betterAuth({
    baseURL: issuer,
    basePath: "/api/auth",
    secret: "browser-identity-verification-secret-for-real-betterauth",
    trustedOrigins: [appOrigin],
    emailAndPassword: { enabled: true },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
    }),
    plugins: [jwt()],
    logger: { disabled: true },
  });
  const credentials = {
    email: "browser-identity@example.test",
    password: "test-password-identity-2026",
  };
  const user = await auth.api.signUpEmail({
    body: { ...credentials, name: "Browser Identity" },
  });
  return {
    issuer,
    baseUrl: `${issuer}/api/auth`,
    credentials,
    user: user.user,
    requests,
    errors,
    close: () => close(server),
  };
}

export async function startOidc(appOrigin, base) {
  const { default: Provider } = await load(oidcRequire, "oidc-provider");
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      path: new URL(request.url, issuer).pathname,
    });
    try {
      if (request.url.startsWith("/interaction/")) {
        const details = await provider.interactionDetails(request, response);
        if (details.prompt.name === "login") {
          await provider.interactionFinished(
            request,
            response,
            { login: { accountId: "oidc-browser-user" } },
            { mergeWithLastSubmission: false },
          );
        } else {
          const grant = details.grantId
            ? await provider.Grant.find(details.grantId)
            : new provider.Grant({
                accountId: details.session.accountId,
                clientId: details.params.client_id,
              });
          grant.addOIDCScope("openid profile email");
          await provider.interactionFinished(
            request,
            response,
            { consent: { grantId: await grant.save() } },
            { mergeWithLastSubmission: true },
          );
        }
      } else {
        await provider.callback()(request, response);
      }
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500).end("fixture error");
    }
  });
  const issuer = await listening(server);
  const clientId = "browser-identity-public-client";
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        redirect_uris: [`${appOrigin}${base}`],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
      },
    ],
    features: { devInteractions: { enabled: false } },
    conformIdTokenClaims: false,
    pkce: { required: () => true },
    interactions: {
      url: (_context, interaction) => `/interaction/${interaction.uid}`,
    },
    claims: {
      openid: ["sub"],
      profile: ["name"],
      email: ["email", "email_verified"],
    },
    findAccount: async (_context, id) => ({
      accountId: id,
      claims: async () => ({
        sub: id,
        name: "OIDC Browser Identity",
        email: "oidc-browser@example.test",
        email_verified: true,
      }),
    }),
    clientBasedCORS: (_context, _origin, _client) => true,
    cookies: { keys: ["browser-identity-cookie-signing-key"] },
  });
  provider.on("server_error", (_context, error) => errors.push(String(error)));
  return { issuer, clientId, requests, errors, close: () => close(server) };
}
