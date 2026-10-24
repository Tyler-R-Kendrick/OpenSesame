/** Independent encrypted personal-account provider, never the obsolete bw-serve CLI API. */
import { randomUUID } from "node:crypto";
import { createServer, request as sendRequest } from "node:http";
import {
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "../../../../packages/app-core/src/lib/secret-backends/bitwarden-native-http.test-support.ts";

const METHODS = ["GET", "POST", "PUT"];
const HEADERS = ["accept", "authorization", "content-type"];
async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw new Error("Native fixture request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function credentialsValid(path, body, headers, credentials) {
  if (path === "/identity/accounts/prelogin/password") {
    try {
      return JSON.parse(body.toString()).email === credentials.email;
    } catch {
      return false;
    }
  }
  if (path === "/identity/connect/token") {
    const form = new URLSearchParams(body.toString());
    return (
      form.get("client_id") === credentials.clientId &&
      form.get("client_secret") === credentials.clientSecret &&
      form.get("scope") === "api"
    );
  }
  return headers.authorization === "Bearer owned.native-token";
}
function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": METHODS.join(", "),
    "access-control-allow-headers": HEADERS.join(", "),
    "access-control-max-age": "0",
    "cache-control": "no-store",
    vary: "Origin",
  };
}
function preflight(request) {
  const names = String(request.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return (
    METHODS.includes(request.headers["access-control-request-method"]) &&
    names.every((name) => HEADERS.includes(name))
  );
}
function forward(request, response, upstream, body, record, errors) {
  const destination = new URL(upstream);
  const source = new URL(request.url, "http://fixture.invalid");
  const outgoing = sendRequest(
    destination,
    {
      method: request.method,
      headers: request.headers,
      path: `${source.pathname}${source.search}`,
    },
    (reply) => {
      record.status = reply.statusCode;
      response.writeHead(reply.statusCode, {
        ...response.getHeaders(),
        "content-type": "application/json",
      });
      reply.on("error", () => {
        errors.push("Native fixture upstream response failed");
        response.destroy();
      });
      reply.pipe(response);
    },
  );
  outgoing.on("error", () => {
    errors.push("Native fixture upstream request failed");
    response.destroy();
  });
  response.once("close", () => {
    if (!response.writableFinished) outgoing.destroy();
  });
  outgoing.end(body);
}
export async function startBitwardenFixture(origin, port = 41905) {
  const source = await nativeHttpFixture(false);
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const record = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      originAllowed: request.headers.origin === origin,
      credentialValid: false,
    };
    requests.push(record);
    if (!record.originAllowed) return response.writeHead(403).end();
    for (const [name, value] of Object.entries(corsHeaders(origin)))
      response.setHeader(name, value);
    if (request.method === "OPTIONS") {
      record.preflightAllowed = preflight(request);
      return response.writeHead(record.preflightAllowed ? 204 : 403).end();
    }
    try {
      const body = await requestBody(request);
      const valid = credentialsValid(
        url.pathname,
        body,
        request.headers,
        source.credentials,
      );
      record.publicPrelogin =
        valid && url.pathname === "/identity/accounts/prelogin/password";
      record.credentialValid = valid && !record.publicPrelogin;
      if (!valid) return response.writeHead(401).end();
      return forward(
        request,
        response,
        source.credentials.baseUrl,
        body,
        record,
        errors,
      );
    } catch {
      errors.push("Native fixture could not read the request");
      return response.writeHead(400).end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await source.close();
    throw error;
  }
  const endpoint = `http://localhost:${server.address().port}`;
  let closing;
  return {
    name: "Bitwarden encrypted personal-account protocol fixture",
    origin: endpoint,
    nativePersonal: true,
    credentials: {
      ...source.credentials,
      baseUrl: `${endpoint}/api`,
      identityUrl: `${endpoint}/identity`,
      deviceIdentifier: randomUUID(),
    },
    password: NATIVE_PASSWORD,
    requests,
    errors,
    items: source.items,
    decoded: source.decoded,
    wire: source.requests,
    close() {
      closing ??= (async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await source.close();
      })();
      return closing;
    },
  };
}
