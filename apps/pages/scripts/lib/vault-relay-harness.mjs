/**
 * In-process relay routes. They match `crates/gateway/src/vault_relay`:
 * health, snapshot compare-and-set, and the org-vault directory. Host
 * routes are absent. The CI shard uses this. The live walk does not.
 */

import { createServer } from "node:http";
import {
  addressOf,
  knownRole,
  memberAllows,
  presentedKey,
  publishAllows,
  remember,
  snapshotOk,
} from "./vault-relay-admit.mjs";
import { closeServer, listen, readBody, send } from "./vault-relay-io.mjs";
import { JOIN_HTML } from "./vault-relay-join-page.mjs";

const RELAY_HEALTH = {
  profile: "relay",
  purpose: "vault_relay",
  bindings: "vault_relay",
  document: "empty",
  durable: true,
};

const EXACT = {
  "GET /health/live": () => ({ status: 200, body: "ok" }),
  "GET /health/relay": () => ({ status: 200, body: RELAY_HEALTH }),
  "GET /join.html": () => ({
    status: 200,
    body: JOIN_HTML,
    type: "text/html; charset=utf-8",
  }),
};

function headerText(request, name) {
  return String(request.headers[name] ?? "");
}

async function readJson(request) {
  try {
    return JSON.parse(String(await readBody(request)) || "{}");
  } catch (error) {
    if (error && error.status === 413) throw error;
    return null;
  }
}

function listOrgVaults(url, directory) {
  const principal = url.searchParams.get("principal") ?? "";
  const owner = url.searchParams.get("owner") ?? "";
  if (!principal && !owner) return { status: 200, body: { vaults: [] } };
  const vaults = [];
  for (const entry of directory.values()) {
    if (principal && entry.principal !== principal) continue;
    if (owner && entry.owner !== owner) continue;
    vaults.push({
      ownerKind: entry.ownerKind,
      owner: entry.owner,
      slug: entry.slug,
    });
  }
  return { status: 200, body: { vaults } };
}

function malformed() {
  return { status: 400, body: { error: "malformed" } };
}

function admitCreate(parsed, principal, role) {
  const ownerKind = parsed.ownerKind;
  if (ownerKind !== "user" && ownerKind !== "organization") return malformed();
  const address = addressOf(parsed.owner, parsed.slug);
  if (!address || !principal || !knownRole(role)) return malformed();
  if (!memberAllows("create", ownerKind, principal, parsed.owner, role)) {
    return { status: 403, body: { error: "forbidden" } };
  }
  return { address, ownerKind };
}

async function createOrgVault(request, directory) {
  const parsed = await readJson(request);
  if (!parsed || typeof parsed !== "object") return malformed();
  const principal = headerText(request, "x-opensesame-principal");
  const role = headerText(request, "x-opensesame-org-role");
  const admitted = admitCreate(parsed, principal, role);
  if (admitted.status) return admitted;
  const current = directory.get(admitted.address);
  if (current && current.principal !== principal) {
    return { status: 409, body: { error: "claimed" } };
  }
  if (current) {
    return {
      status: 200,
      body: {
        vault: {
          ownerKind: current.ownerKind,
          owner: current.owner,
          slug: current.slug,
        },
      },
    };
  }
  remember(directory, admitted.address, admitted.ownerKind, principal);
  return {
    status: 201,
    body: {
      vault: {
        ownerKind: admitted.ownerKind,
        owner: parsed.owner,
        slug: parsed.slug,
      },
    },
  };
}

function readSnapshot(slots, address, key) {
  const slot = slots.get(address);
  if (!slot) return { status: 404, body: { error: "not_found" } };
  if (slot.key !== key) return { status: 401, body: { error: "unauthorized" } };
  return {
    status: 200,
    body: { generation: slot.generation, snapshot: slot.snapshot },
  };
}

function refusePut(
  parsed,
  principal,
  ownerKind,
  role,
  owner,
  directory,
  address,
) {
  if (!snapshotOk(parsed.snapshot) || !knownRole(role)) return malformed();
  if (!publishAllows(ownerKind, principal, owner, role)) {
    return { status: 403, body: { error: "forbidden" } };
  }
  const claimed = directory.get(address);
  if (claimed?.principal && principal && claimed.principal !== principal) {
    return { status: 409, body: { error: "claimed" } };
  }
  return null;
}

function commitPut(
  slots,
  directory,
  address,
  key,
  parsed,
  principal,
  ownerKind,
) {
  const slot = slots.get(address);
  if (!slot) {
    if (parsed.expected_generation !== 0) {
      return { status: 404, body: { error: "not_found" } };
    }
    slots.set(address, {
      key,
      generation: 1,
      snapshot: parsed.snapshot,
      principal,
      ownerKind,
    });
    remember(directory, address, ownerKind, principal);
    return { status: 200, body: { generation: 1 } };
  }
  if (slot.key !== key) return { status: 401, body: { error: "unauthorized" } };
  if (slot.generation !== parsed.expected_generation) {
    return { status: 409, body: { generation: slot.generation } };
  }
  slot.generation += 1;
  slot.snapshot = parsed.snapshot;
  remember(directory, address, ownerKind, principal);
  return { status: 200, body: { generation: slot.generation } };
}

async function writeSnapshot(request, slots, directory, address, key, owner) {
  const parsed = await readJson(request);
  if (!parsed || typeof parsed !== "object") return malformed();
  const principal = headerText(request, "x-opensesame-principal").slice(0, 128);
  const ownerKindHeader = request.headers["x-opensesame-owner-kind"];
  const ownerKind =
    ownerKindHeader === "organization" ? "organization" : "user";
  const role = headerText(request, "x-opensesame-org-role");
  const refused = refusePut(
    parsed,
    principal,
    ownerKind,
    role,
    owner,
    directory,
    address,
  );
  if (refused) return refused;
  return commitPut(
    slots,
    directory,
    address,
    key,
    parsed,
    principal,
    ownerKind,
  );
}

async function handleSnapshot(request, method, slotMatch, slots, directory) {
  const owner = decodeURIComponent(slotMatch[1] ?? "");
  const slug = decodeURIComponent(slotMatch[2] ?? "");
  const address = addressOf(owner, slug);
  if (!address) return { status: 404, body: { error: "not_found" } };
  const key = presentedKey(request.headers["x-opensesame-slot-key"]);
  if (!key) return { status: 401, body: { error: "unauthorized" } };
  if (method === "GET") return readSnapshot(slots, address, key);
  if (method === "PUT") {
    return writeSnapshot(request, slots, directory, address, key, owner);
  }
  return { status: 404, body: { error: "not_found" } };
}

async function dispatch(request, slots, directory) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const exact = EXACT[`${method} ${url.pathname}`];
  if (exact) return exact();
  if (url.pathname === "/v1/org-vaults" && method === "GET") {
    return listOrgVaults(url, directory);
  }
  if (url.pathname === "/v1/org-vaults" && method === "POST") {
    return createOrgVault(request, directory);
  }
  const slotMatch = url.pathname.match(
    /^\/v1\/vault-relay\/([^/]+)\/([^/]+)\/snapshot$/,
  );
  if (slotMatch) {
    return handleSnapshot(request, method, slotMatch, slots, directory);
  }
  return { status: 404, body: { error: "not_found" } };
}

/**
 * @returns {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>}
 */
export function createRelayHandler() {
  const slots = new Map();
  const directory = new Map();
  return async (request, response) => {
    const result = await dispatch(request, slots, directory);
    send(response, result.status, result.body, result.type);
  };
}

/** In-process routes. The CI shard uses this. The live walk does not. */
export function startRelayHarness() {
  const handler = createRelayHandler();
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error && error.status === 413 ? 413 : 500;
      send(response, status, {
        error: status === 413 ? "too_large" : "malformed",
      });
    });
  });
  return listen(server).then((origin) => ({
    origin,
    pageOrigin: origin,
    live: false,
    close: () => closeServer(server),
  }));
}
