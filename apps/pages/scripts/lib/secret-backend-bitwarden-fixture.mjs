/** The documented bw-serve Vault Management API; not an encrypted Vaultwarden server. */
import {
  refused,
  reply,
  startSecretBackendFixture,
} from "./secret-backend-fixture-http.mjs";

export function startBitwardenFixture(origin, port = 41905) {
  const items = new Map();
  let nextId = 1;
  const envelope = (data) => ({ success: true, data });
  function write(id, body, status) {
    if (body.folderId !== null || ![1, 2].includes(body.type))
      return refused("Expected an unfiled Vault Management item");
    const item = { ...body, id };
    items.set(id, item);
    return reply(envelope(item), status);
  }
  function handle({ request, url, body, record }) {
    record.serviceUnlocked = true;
    if (url.pathname === "/status")
      return reply(envelope({ status: "unlocked" }));
    if (url.pathname === "/list/object/items")
      return reply(envelope({ data: [...items.values()] }));
    if (url.pathname === "/object/item" && request.method === "POST")
      return write(
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
        body,
        201,
      );
    if (!url.pathname.startsWith("/object/item/"))
      return refused("Unknown Vault API route", 404);
    const id = decodeURIComponent(url.pathname.slice("/object/item/".length));
    if (!items.has(id)) return refused("Missing Vault API item", 404);
    if (request.method === "GET") return reply(envelope(items.get(id)));
    if (request.method === "PUT") {
      if (body.id !== id) return refused("Vault API update must preserve ID");
      return write(id, body, 200);
    }
    if (request.method === "DELETE") {
      items.delete(id);
      return reply(envelope(null));
    }
    return refused("Unsupported Vault API method", 405);
  }
  return startSecretBackendFixture({
    origin,
    port,
    name: "Bitwarden Vault Management protocol fixture",
    handle,
    items,
  });
}
