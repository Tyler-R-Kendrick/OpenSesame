/** Passwordstate standard API: list metadata, individual passwords, and scoped mutations. */
import assert from "node:assert/strict";
import {
  FIXTURE_SCOPE,
  FIXTURE_TOKEN,
  refused,
  reply,
  startSecretBackendFixture,
} from "./secret-backend-fixture-http.mjs";

export function startPasswordstateFixture(origin, port = 41904) {
  const items = new Map();
  let nextId = 100;
  function list(url) {
    if (
      url.pathname !== `/api/passwords/${FIXTURE_SCOPE.passwordListId}` ||
      url.searchParams.get("ExcludePassword") !== "True"
    )
      return refused("Expected the configured list and password exclusion");
    return reply(
      [...items.values()].map(
        ({ PasswordID, Title, UserName, URL, Notes }) => ({
          PasswordID,
          Title,
          UserName,
          URL,
          Notes,
        }),
      ),
    );
  }
  function write(body, updating) {
    if (
      !updating &&
      String(body.PasswordListID) !== FIXTURE_SCOPE.passwordListId
    )
      return refused("Password list scope mismatch");
    const id = updating ? String(body.PasswordID) : String(nextId++);
    if (updating && !items.has(id)) return refused("Missing password", 404);
    assert.match(body.Password, /^[\s\S]*$/u, "Expected a string password");
    assert.match(body.Title, /^[\s\S]*$/u, "Expected a string title");
    const row = {
      ...body,
      PasswordID: Number(id),
      PasswordListID: Number(FIXTURE_SCOPE.passwordListId),
    };
    items.set(id, row);
    return reply([row], updating ? 200 : 201);
  }
  function handle({ request, url, body }) {
    if (request.headers.apikey !== FIXTURE_TOKEN)
      return refused("Passwordstate API key refused", 401);
    if (url.pathname === "/api/passwords") {
      if (request.method === "POST") return write(body, false);
      if (request.method === "PUT") return write(body, true);
    }
    if (!url.pathname.startsWith("/api/passwords/"))
      return refused("Unknown Passwordstate route", 404);
    if (request.method === "GET" && url.searchParams.has("QueryAll"))
      return list(url);
    const id = url.pathname.slice("/api/passwords/".length);
    if (!items.has(id)) return refused("Missing password", 404);
    if (request.method === "GET") return reply([items.get(id)]);
    if (request.method === "DELETE") {
      if (url.searchParams.get("MoveToRecycleBin") !== "True")
        return refused("Expected explicit recycle-bin deletion");
      items.delete(id);
      return reply({ success: true });
    }
    return refused("Unsupported Passwordstate method", 405);
  }
  return startSecretBackendFixture({
    origin,
    port,
    name: "Passwordstate protocol fixture",
    handle,
    items,
  });
}
