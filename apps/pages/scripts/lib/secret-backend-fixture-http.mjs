/** Real HTTP fixtures: explicit origin consent, preflights, bounded JSON and retained state. */
import { createServer } from "node:http";

export const FIXTURE_TOKEN = "browser-fixture-access";
export const FIXTURE_SCOPE = {
  vaultId: "0123456789abcdef0123456789",
  projectId: "browser-project",
  environment: "dev",
  secretPath: "/browser",
  passwordListId: "12",
};
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const HEADERS = ["authorization", "content-type", "apikey"];

export function reply(body, status = 200) {
  return { status, body };
}
export function refused(message, status = 400) {
  return reply({ error: message }, status);
}
export function bearer(request) {
  return request.headers.authorization === `Bearer ${FIXTURE_TOKEN}`;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Fixture request exceeds its limit");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
function cors(request, origin) {
  if (request.headers.origin !== origin) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": METHODS.join(", "),
    "access-control-allow-headers": HEADERS.join(", "),
    "access-control-max-age": "0",
    vary: "Origin",
  };
}
function preflight(request) {
  const method = request.headers["access-control-request-method"];
  const headers = String(
    request.headers["access-control-request-headers"] ?? "",
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return (
    METHODS.includes(method) &&
    headers.every((header) => HEADERS.includes(header))
  );
}

export async function startSecretBackendFixture({
  origin,
  port,
  name,
  handle,
  items,
}) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${port}`);
    const headers = cors(request, origin);
    const record = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      originAllowed: !!headers,
      credentialValid:
        bearer(request) || request.headers.apikey === FIXTURE_TOKEN,
    };
    requests.push(record);
    if (!headers) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method === "OPTIONS") {
      record.preflightAllowed = preflight(request);
      response.writeHead(record.preflightAllowed ? 204 : 403, headers);
      response.end();
      return;
    }
    try {
      const body = await readJson(request);
      const result = await handle({ request, url, body, record });
      response.writeHead(result.status, {
        ...headers,
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        result.status === 204 ? undefined : JSON.stringify(result.body),
      );
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
      response.writeHead(500, headers);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    name,
    origin: `http://localhost:${port}`,
    requests,
    errors,
    items,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
