/** Real HTTP protocol fixture. Only the hosted account consent page is synthetic. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./tailnet-connect-fixture-process.mjs";
function htmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}
async function bodyOf(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error("Fixture request exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function consentPage(state, authorizationUrl) {
  const url = new URL(authorizationUrl);
  const app = state.app;
  if (
    url.origin !== "https://login.tailscale.com" ||
    url.pathname !== "/a/oauth_authorize" ||
    !app
  )
    throw new Error("Unexpected Tailscale consent target");
  if (
    url.searchParams.get("client_id") !== app.id ||
    url.searchParams.get("redirect_uri") !== app.redirectURIs[0] ||
    url.searchParams.get("scope") !== "auth_keys:create:once" ||
    url.searchParams.get("response_type") !== "code"
  )
    throw new Error("Unexpected Tailscale consent contract");
  const csrf = url.searchParams.get("state");
  if (!csrf || csrf.length < 32) throw new Error("Missing unpredictable state");
  state.stats.consents++;
  const callback = new URL(app.redirectURIs[0]);
  callback.searchParams.set(
    "state",
    state.consentMode === "wrong-state" ? "wrong-fixture-state" : csrf,
  );
  if (state.consentMode === "deny")
    callback.searchParams.set("error", "access_denied");
  else {
    const code = randomUUID();
    state.codes.add(code);
    callback.searchParams.set("code", code);
  }
  state.consentMode = "accept";
  return `<!doctype html><html lang="en"><title>Synthetic Tailscale consent fixture</title><body><h1>Synthetic Tailscale consent fixture</h1><p>No hosted account is contacted.</p><a href="${htmlAttribute(callback.href)}">Approve fixture device</a></body></html>`;
}
function admin(state, request, response) {
  if (
    request.headers.authorization ===
    `Basic ${Buffer.from(`${state.adminToken}:`).toString("base64")}`
  )
    return true;
  json(response, 401, { error: "wrong_admin" });
  return false;
}
async function register(state, request, response) {
  if (!admin(state, request, response)) return;
  const body = JSON.parse(await bodyOf(request));
  if (
    JSON.stringify(body.scopes) !== '["auth_keys:create:once"]' ||
    body.redirectUris?.length !== 1 ||
    !body.name?.startsWith("OpenSesame ")
  )
    throw new Error("Wrong app registration body");
  const callback = new URL(body.redirectUris[0]);
  if (
    callback.origin !== state.allowedOrigin ||
    callback.search ||
    callback.hash
  )
    throw new Error("Wrong callback origin");
  state.stats.registrations++;
  state.app = {
    id: `fixture-${randomUUID()}`,
    name: body.name,
    clientSecret: `fixture-private-${randomUUID()}`,
    redirectURIs: body.redirectUris,
    scopes: body.scopes,
  };
  json(response, 201, state.app);
}
function verify(state, request, response) {
  if (!admin(state, request, response)) return;
  state.stats.verifications++;
  const { clientSecret, ...metadata } = state.app;
  json(response, 200, metadata);
}
function validExchange(state, body) {
  const app = state.app;
  return (
    app &&
    body.get("grant_type") === "authorization_code" &&
    body.get("client_id") === app.id &&
    body.get("client_secret") === app.clientSecret &&
    body.get("redirect_uri") === app.redirectURIs[0] &&
    state.codes.delete(body.get("code"))
  );
}
async function exchange(state, request, response) {
  const body = new URLSearchParams(await bodyOf(request));
  if (!validExchange(state, body)) {
    json(response, 400, { error: "invalid_grant" });
    return;
  }
  state.stats.exchanges++;
  const key = `fixture-one-use-${randomUUID()}`;
  state.issued.add(key);
  json(response, 200, {
    access_token: key,
    token_type: "Bearer",
    expires_in: 3600,
  });
}
function cors(state, request, response) {
  if (
    request.headers.origin &&
    request.headers.origin !== state.allowedOrigin
  ) {
    json(response, 403, { error: "wrong_origin" });
    return false;
  }
  if (!state.corsEnabled) return true;
  response.setHeader("access-control-allow-origin", state.allowedOrigin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization,content-type",
  );
  return true;
}
async function handle(state, request, response) {
  const url = new URL(request.url, "http://fixture.invalid");
  if (!url.pathname.startsWith(`${state.prefix}/`)) return false;
  if (!cors(state, request, response)) return true;
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }
  const path = url.pathname.slice(state.prefix.length);
  try {
    if (path === "/api/v2/tailnet/-/oauth-apps" && request.method === "POST")
      await register(state, request, response);
    else if (
      state.app &&
      path === `/api/v2/tailnet/-/oauth-apps/${state.app.id}` &&
      request.method === "GET"
    )
      verify(state, request, response);
    else if (path === "/api/v2/oauth/token" && request.method === "POST")
      await exchange(state, request, response);
    else json(response, 404, { error: "not_found" });
  } catch {
    json(response, 400, { error: "invalid_fixture_contract" });
  }
  return true;
}
export function createTailscaleProvisioningFixture({
  allowedOrigin,
  prefix = "/tailscale-fixture",
}) {
  const state = {
    allowedOrigin,
    prefix,
    app: null,
    consentMode: "accept",
    codes: new Set(),
    issued: new Set(),
    corsEnabled: true,
    adminToken: "fixture-tailscale-admin",
    stats: {
      registrations: 0,
      verifications: 0,
      consents: 0,
      exchanges: 0,
      consumedDeviceKeys: 0,
    },
  };
  return {
    adminToken: state.adminToken,
    get stats() {
      return { ...state.stats };
    },
    get app() {
      return state.app ? structuredClone(state.app) : null;
    },
    setNextConsent(mode) {
      state.consentMode = mode;
    },
    seedRegisteredApp({ name, redirectUri }) {
      state.app = {
        id: `fixture-${randomUUID()}`,
        name,
        clientSecret: `fixture-private-${randomUUID()}`,
        redirectURIs: [redirectUri],
        scopes: ["auth_keys:create:once"],
      };
      return structuredClone(state.app);
    },
    setCorsEnabled(enabled) {
      state.corsEnabled = enabled;
    },
    consentPage: (url) => consentPage(state, url),
    consumeDeviceKey(key) {
      if (!state.issued.delete(key)) return false;
      state.stats.consumedDeviceKeys++;
      return true;
    },
    handle: (request, response) => handle(state, request, response),
  };
}

async function consentTls(directory) {
  const keyPath = join(directory, "consent.key");
  const certPath = join(directory, "consent.pem");
  const spkiPath = join(directory, "spki.der");
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=login.tailscale.com",
    "-addext",
    "subjectAltName=DNS:login.tailscale.com",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "extendedKeyUsage=serverAuth",
  ]);
  await command("openssl", [
    "pkey",
    "-in",
    keyPath,
    "-pubout",
    "-outform",
    "DER",
    "-out",
    spkiPath,
  ]);
  return {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
    spki: createHash("sha256")
      .update(await readFile(spkiPath))
      .digest("base64"),
  };
}
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}
function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/** Consent is a real local TLS socket with a per-run SPKI pin, never interception. */
export async function startTailscaleProvisioningServer({
  allowedOrigin,
  port = 41913,
  consentPort = 41930,
}) {
  const directory = await mkdtemp(join(tmpdir(), "opensesame-consent-"));
  const fixture = createTailscaleProvisioningFixture({ allowedOrigin });
  const requests = [];
  const consentRequests = [];
  let api;
  let consent;
  try {
    const tls = await consentTls(directory);
    api = createServer(async (request, response) => {
      requests.push({
        method: request.method,
        path: new URL(request.url, "http://fixture").pathname,
        originAllowed:
          !request.headers.origin || request.headers.origin === allowedOrigin,
      });
      if (!(await fixture.handle(request, response)))
        response.writeHead(404).end();
    });
    consent = createHttpsServer(tls, (request, response) => {
      const url = new URL(request.url, "https://login.tailscale.com");
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      consentRequests.push({ method: request.method, path: url.pathname });
      try {
        const html = fixture.consentPage(url.href);
        response.writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-store",
        });
        response.end(html);
      } catch {
        response.writeHead(400).end("Invalid synthetic consent request");
      }
    });
    await listen(api, port);
    await listen(consent, consentPort);
    return {
      fixture,
      requests,
      consentRequests,
      chromiumArgs: [
        "--no-proxy-server",
        `--host-resolver-rules=MAP login.tailscale.com 127.0.0.1:${consentPort}`,
        `--ignore-certificate-errors-spki-list=${tls.spki}`,
      ],
      close: async () => {
        await close(api);
        await close(consent);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (api) await close(api);
    if (consent) await close(consent);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
