/** A local protocol fixture for the documented 1Password Connect v1 item API. */
import {
  FIXTURE_SCOPE,
  bearer,
  refused,
  reply,
  startSecretBackendFixture,
} from "./secret-backend-fixture-http.mjs";

export function startConnectFixture(origin, port = 41902) {
  const items = new Map();
  const vault = { id: FIXTURE_SCOPE.vaultId, name: "Browser fixture vault" };
  const root = `/v1/vaults/${vault.id}`;
  let nextId = 1;
  const list = () =>
    [...items.values()].map(
      ({ id, title, category, version, vault, state }) => ({
        id,
        title,
        category,
        version,
        vault,
        state,
      }),
    );
  function create(body) {
    if (body.vault?.id !== vault.id || !Array.isArray(body.fields))
      return refused("Expected a vault-scoped Connect item");
    const item = {
      ...body,
      id: `browserconnectitem${String(nextId++).padStart(8, "0")}`,
      version: 1,
      state: "ACTIVE",
    };
    items.set(item.id, item);
    return reply(item, 201);
  }
  function update(id, body) {
    const previous = items.get(id);
    if (!previous) return refused("Missing Connect item", 404);
    if (
      body.id !== id ||
      body.version !== previous.version ||
      body.vault?.id !== vault.id
    )
      return refused("Connect update must preserve ID, version and vault", 409);
    const item = { ...body, version: previous.version + 1, state: "ACTIVE" };
    items.set(id, item);
    return reply(item);
  }
  function handle({ request, url, body }) {
    if (!bearer(request)) return refused("Connect token refused", 401);
    if (url.pathname === root && request.method === "GET") return reply(vault);
    if (url.pathname === `${root}/items`) {
      if (request.method === "GET") return reply(list());
      if (request.method === "POST") return create(body);
    }
    if (!url.pathname.startsWith(`${root}/items/`))
      return refused("Unknown Connect route", 404);
    const id = decodeURIComponent(url.pathname.slice(`${root}/items/`.length));
    if (request.method === "PUT") return update(id, body);
    if (!items.has(id)) return refused("Missing Connect item", 404);
    if (request.method === "GET") return reply(items.get(id));
    if (request.method === "DELETE") {
      items.delete(id);
      return reply(null, 204);
    }
    return refused("Unsupported Connect method", 405);
  }
  return startSecretBackendFixture({
    origin,
    port,
    name: "Connect protocol fixture",
    handle,
    items,
  });
}
