/** Infisical Universal Auth and scoped v4 secrets served over real HTTP with CORS. */
import assert from "node:assert/strict";
import {
  FIXTURE_SCOPE,
  FIXTURE_TOKEN,
  bearer,
  refused,
  reply,
  startSecretBackendFixture,
} from "./secret-backend-fixture-http.mjs";

export const INFISICAL_CLIENT = {
  id: "browser-machine",
  secret: "browser-machine-fixture",
};
function scoped(source) {
  return ["projectId", "environment", "secretPath"].every(
    (name) => source[name] === FIXTURE_SCOPE[name],
  );
}
export function startInfisicalFixture(origin, port = 41903) {
  const items = new Map();
  let nextId = 1;
  function login(body, record) {
    record.credentialValid =
      body.clientId === INFISICAL_CLIENT.id &&
      body.clientSecret === INFISICAL_CLIENT.secret;
    return record.credentialValid
      ? reply({
          accessToken: FIXTURE_TOKEN,
          expiresIn: 3600,
          tokenType: "Bearer",
        })
      : refused("Universal Auth refused", 401);
  }
  function write(name, body, update) {
    if (!scoped(body) || body.type !== "shared")
      return refused("Expected a scoped shared secret");
    assert.match(body.secretValue, /^[\s\S]*$/u, "Expected a string secret");
    const previous = items.get(name);
    if (update && !previous) return refused("Missing Infisical secret", 404);
    if (!update && previous) return refused("Duplicate Infisical secret", 409);
    const secretKey = body.newSecretName ?? name;
    const secret = {
      id: previous?.id ?? `infisical-${nextId++}`,
      secretKey,
      secretValue: body.secretValue,
      secretComment: body.secretComment ?? "",
      ...FIXTURE_SCOPE,
    };
    items.delete(name);
    items.set(secretKey, secret);
    return reply({ secret }, update ? 200 : 201);
  }
  function list(url) {
    if (
      !scoped(Object.fromEntries(url.searchParams)) ||
      url.searchParams.get("viewSecretValue") !== "false"
    )
      return refused("List scope or redaction missing");
    return reply({
      secrets: [...items.values()].map(({ id, secretKey }) => ({
        id,
        secretKey,
        secretValueHidden: true,
      })),
    });
  }
  function handle({ request, url, body, record }) {
    if (
      url.pathname === "/api/v1/auth/universal-auth/login" &&
      request.method === "POST"
    )
      return login(body, record);
    if (!bearer(request)) return refused("Infisical token refused", 401);
    if (url.pathname === "/api/v4/secrets" && request.method === "GET")
      return list(url);
    if (!url.pathname.startsWith("/api/v4/secrets/"))
      return refused("Unknown Infisical route", 404);
    const name = decodeURIComponent(
      url.pathname.slice("/api/v4/secrets/".length),
    );
    if (request.method === "POST") return write(name, body, false);
    if (request.method === "PATCH") return write(name, body, true);
    return readOrDelete(request, url, body, name);
  }
  function readOrDelete(request, url, body, name) {
    if (!items.has(name)) return refused("Missing Infisical secret", 404);
    if (request.method === "GET") {
      if (
        !scoped(Object.fromEntries(url.searchParams)) ||
        url.searchParams.get("viewSecretValue") !== "true"
      )
        return refused("Secret read scope missing");
      return reply({ secret: items.get(name) });
    }
    if (request.method === "DELETE") {
      if (!scoped(body) || body.type !== "shared")
        return refused("Delete scope missing");
      items.delete(name);
      return reply({ secret: { secretKey: name } });
    }
    return refused("Unsupported Infisical method", 405);
  }
  return startSecretBackendFixture({
    origin,
    port,
    name: "Infisical protocol fixture",
    handle,
    items,
  });
}
