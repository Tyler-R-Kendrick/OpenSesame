/** Independent GoTrue-compatible HTTP fixture, not a hosted Supabase tenant. */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../../../packages/control-plane/package.json", import.meta.url),
);

async function passwordToken(request, state, json) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const supplied = JSON.parse(Buffer.concat(chunks).toString());
  if (
    supplied.email !== state.credentials.email ||
    supplied.password !== state.credentials.password
  )
    return json(400, { error: "invalid credentials" });
  const accessToken = await new state.SignJWT({
    email: state.user.email,
    name: state.user.name,
  })
    .setProtectedHeader({ alg: "ES256", kid: state.jwk.kid })
    .setIssuer(`${state.origin}/auth/v1`)
    .setAudience("authenticated")
    .setSubject(state.user.id)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(state.key.privateKey);
  return json(200, {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    user: state.user,
  });
}
async function sessionRoute(request, url, state, json) {
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  if (!token || state.revoked.has(token))
    return json(401, { error: "invalid session" });
  await state.jwtVerify(token, state.key.publicKey, {
    issuer: `${state.origin}/auth/v1`,
    audience: "authenticated",
    algorithms: ["ES256"],
  });
  if (url.pathname === "/auth/v1/user") return json(200, state.user);
  if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
    state.revoked.add(token);
    return json(200, {});
  }
  return json(404, { error: "not found" });
}
async function route(request, url, state, json) {
  if (request.headers.apikey !== state.publicKey)
    return json(401, { error: "invalid public key" });
  if (url.pathname === "/auth/v1/settings")
    return json(200, { external: { email: true } });
  if (url.pathname === "/auth/v1/.well-known/jwks.json")
    return json(200, { keys: [state.jwk] });
  if (
    url.pathname === "/auth/v1/token" &&
    request.method === "POST" &&
    url.searchParams.get("grant_type") === "password"
  )
    return passwordToken(request, state, json);
  return sessionRoute(request, url, state, json);
}
function requestHandler(state, appOrigin) {
  return async (request, response) => {
    const url = new URL(request.url, state.origin);
    const cors = {
      "access-control-allow-origin": appOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, apikey",
    };
    if (request.method === "OPTIONS")
      return response.writeHead(204, cors).end();
    state.requests.push({
      method: request.method,
      path: url.pathname,
      publicKeyValid: request.headers.apikey === state.publicKey,
    });
    const json = (status, value) => {
      response.writeHead(status, {
        ...cors,
        "content-type": "application/json",
      });
      response.end(JSON.stringify(value));
    };
    try {
      return await route(request, url, state, json);
    } catch (error) {
      state.errors.push(String(error));
      return json(500, { error: "fixture error" });
    }
  };
}
export async function startSupabaseWireFixture(appOrigin) {
  const { SignJWT, jwtVerify } = await import(require.resolve("jose"));
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentials = {
    email: "supabase-browser@example.test",
    password: "supabase-wire-fixture-password-2026",
  };
  const state = {
    SignJWT,
    jwtVerify,
    key,
    credentials,
    jwk: {
      ...key.publicKey.export({ format: "jwk" }),
      kid: "gotrue-fixture",
      alg: "ES256",
      use: "sig",
    },
    user: {
      id: randomUUID(),
      email: credentials.email,
      name: "Supabase Wire Identity",
    },
    publicKey: "sb_publishable_browser_protocol_fixture",
    requests: [],
    errors: [],
    revoked: new Set(),
    origin: "",
  };
  const server = createServer(requestHandler(state, appOrigin));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  state.origin = `http://localhost:${server.address().port}`;
  return {
    ...state,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
