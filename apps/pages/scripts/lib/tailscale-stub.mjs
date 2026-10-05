// A stand-in for api.tailscale.com on a loopback port, for the end-to-end
// tailnet device harness (ADR 0166). It keeps one tailnet in memory and
// answers the v2 routes the daemon calls the way Tailscale does — the same
// shapes spec/conformance/tailnet-admin-protocol.json records — so a change
// made in the page lands here and the next read shows it.
//
// What it checks: every call carries the API token the daemon was given, a
// tag is one the tailnet's policy owns, and routes are ones the device
// advertised. What it records: every call, so the harness can say exactly
// what reached Tailscale.
import http from "node:http";

export const TAILNET = "example.com";
export const API_TOKEN = "tskey-api-kVERIFY1CNTRL-0123456789abcdef";
const DOMAIN = "tail4c2e.ts.net";
/** Tags the tailnet policy file owns; any other is refused, as Tailscale does. */
const OWNED_TAGS = new Set(["tag:ci", "tag:web", "tag:edge", "tag:server"]);
const EXIT = ["0.0.0.0/0", "::/0"];

function device(fields) {
  const hostname = fields.hostname;
  return {
    addresses: ["100.64.0.1"],
    id: String(Math.floor(Math.random() * 1e11)),
    user: "amelie@example.com",
    name: `${hostname.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}.${DOMAIN}`,
    clientVersion: "1.82.0",
    updateAvailable: false,
    os: "linux",
    created: "2026-09-01T05:23:30Z",
    connectedToControl: true,
    lastSeen: new Date().toISOString(),
    keyExpiryDisabled: false,
    expires: "2027-03-01T05:23:30Z",
    authorized: true,
    isExternal: false,
    machineKey: "mkey:not-forwarded",
    nodeKey: "nodekey:not-forwarded",
    blocksIncomingConnections: false,
    enabledRoutes: [],
    advertisedRoutes: [],
    tags: [],
    tailnetLockError: "",
    sshEnabled: false,
    isEphemeral: false,
    multipleConnections: false,
    ...fields,
  };
}

/** The tailnet a fresh harness starts from: one of each thing a person handles. */
function seed() {
  return [
    device({
      nodeId: "nPANGOLINCNTRL",
      hostname: "pangolin",
      addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"],
      tags: ["tag:web"],
      advertisedRoutes: ["10.0.0.0/16", ...EXIT],
      enabledRoutes: ["10.0.0.0/16"],
      updateAvailable: true,
      clientVersion: "1.80.2",
      sshEnabled: true,
    }),
    device({
      nodeId: "nSAMSPHONECNTRL",
      hostname: "sams-phone",
      addresses: ["100.88.1.2"],
      user: "sam@example.com",
      os: "iOS",
      authorized: false,
      connectedToControl: false,
      lastSeen: undefined,
      created: new Date().toISOString(),
    }),
    device({
      nodeId: "nBUILDBOXCNTRL",
      hostname: "build-box",
      addresses: ["100.77.3.4"],
      user: "",
      tags: ["tag:ci"],
      os: "linux",
      expires: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    }),
    device({
      nodeId: "nLAPTOPCNTRL",
      hostname: "amelies-laptop",
      addresses: ["100.90.5.6"],
      os: "macOS",
      connectedToControl: false,
      lastSeen: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    }),
  ];
}

function refuse(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ message }));
}

function ok(response, body = null) {
  if (body === null) {
    response.writeHead(200);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function setTags(found, body, response) {
  const bad = (body?.tags ?? []).find((tag) => !OWNED_TAGS.has(tag));
  if (bad) return refuse(response, 400, `${bad} is not a valid tag`);
  found.tags = body.tags;
  if (found.tags.length > 0) found.user = "";
  return ok(response);
}

function setRoutes(found, body, response) {
  found.enabledRoutes = (body?.routes ?? []).filter((r) =>
    found.advertisedRoutes.includes(r),
  );
  return ok(response, {
    advertisedRoutes: found.advertisedRoutes,
    enabledRoutes: found.enabledRoutes,
  });
}

/** The plain setters: each writes one field and answers 200 with no body. */
const SETTERS = {
  authorized: (found, body) => {
    found.authorized = body?.authorized === true;
  },
  name: (found, body) => {
    found.name = `${body?.name}.${DOMAIN}`;
  },
  key: (found, body) => {
    found.keyExpiryDisabled = body?.keyExpiryDisabled;
  },
  expire: (found) => {
    found.expires = new Date().toISOString();
  },
};

function changeDevice(found, what, body, response) {
  if (what === "tags") return setTags(found, body, response);
  if (what === "routes") return setRoutes(found, body, response);
  const set = Object.hasOwn(SETTERS, what) ? SETTERS[what] : null;
  if (!set) return refuse(response, 404, "not found");
  set(found, body);
  return ok(response);
}

function keyView(key) {
  const { secret: _secret, ...view } = key;
  return view;
}

function routeKeys(tailnet, method, rest, body, response) {
  if (method === "GET" && rest.length === 0)
    return ok(response, {
      keys: tailnet.keys.map((k) => ({ id: k.id, keyType: "auth" })),
    });
  if (method === "POST" && rest.length === 0) {
    const id = `k${Math.random().toString(36).slice(2, 10).toUpperCase()}CNTRL`;
    const created = new Date();
    const key = {
      id,
      keyType: "auth",
      description: body?.description ?? "",
      created: created.toISOString(),
      expires: new Date(
        created.getTime() + (body?.expirySeconds ?? 7_776_000) * 1000,
      ).toISOString(),
      invalid: false,
      capabilities: body?.capabilities,
      secret: `tskey-auth-${id}-${crypto.randomUUID().replaceAll("-", "")}`,
    };
    tailnet.keys.push(key);
    return ok(response, { ...keyView(key), key: key.secret });
  }
  const found = tailnet.keys.find((k) => k.id === rest[0]);
  if (!found) return refuse(response, 404, "not found");
  if (method === "GET") return ok(response, keyView(found));
  if (method === "DELETE") {
    tailnet.keys = tailnet.keys.filter((k) => k !== found);
    return ok(response);
  }
  return refuse(response, 405, "method not allowed");
}

function route(tailnet, method, path, body, response) {
  const parts = path.split("/").filter(Boolean).slice(2);
  if (parts[0] === "tailnet") {
    if (parts[1] !== TAILNET) return refuse(response, 404, "tailnet not found");
    if (parts[2] === "devices" && method === "GET")
      return ok(response, { devices: tailnet.devices });
    if (parts[2] === "keys")
      return routeKeys(tailnet, method, parts.slice(3), body, response);
  }
  if (parts[0] === "device") {
    const found = tailnet.devices.find((d) => d.nodeId === parts[1]);
    if (!found) return refuse(response, 404, "not found");
    if (method === "GET" && parts.length === 2) return ok(response, found);
    if (method === "DELETE" && parts.length === 2) {
      tailnet.devices = tailnet.devices.filter((d) => d !== found);
      return ok(response);
    }
    if (method === "POST") return changeDevice(found, parts[2], body, response);
  }
  return refuse(response, 404, "not found");
}

/**
 * Start the stub. `join` is a machine running `tailscale up --auth-key`: it
 * spends the key the page minted and the new device appears as Tailscale
 * would add it — approved when the key was pre-approved, with its tags.
 */
export async function startTailscaleStub() {
  const tailnet = { devices: seed(), keys: [], calls: [] };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const body = await readJson(request);
    tailnet.calls.push({ method: request.method, path: url.pathname, body });
    if (request.headers.authorization !== `Bearer ${API_TOKEN}`)
      return refuse(response, 401, "invalid API key");
    route(tailnet, request.method, url.pathname, body, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    tailnet,
    join(secret, hostname) {
      const key = tailnet.keys.find((k) => k.secret === secret);
      if (!key) throw new Error("join: no such auth key");
      const create = key.capabilities?.devices?.create ?? {};
      tailnet.devices.push(
        device({
          nodeId: `n${hostname.replaceAll("-", "").toUpperCase()}CNTRL`,
          hostname,
          addresses: ["100.70.8.9"],
          authorized: create.preauthorized === true,
          isEphemeral: create.ephemeral === true,
          tags: create.tags ?? [],
          user: create.tags?.length ? "" : "amelie@example.com",
        }),
      );
      if (!create.reusable) key.invalid = true;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
