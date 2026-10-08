/**
 * Relay HTTP harness for ADR 0181.
 *
 * The in-process routes match `crates/gateway/src/vault_relay.rs`: health,
 * snapshot compare-and-set, and the org-vault directory. Host routes are
 * absent. `/join.html` is the page two browser contexts use to join one
 * session. The snapshot this page publishes has no item name.
 *
 * `startVaultRelay({ live: true })` does not use that process. It spawns
 * `opensesame host run --profile relay` when one is not already named by
 * `OPENSESAME_RELAY_URL`, and serves the join page beside it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = "opensesame-vault-drive-snapshot";
const MAX_BYTES = 16 * 1024 * 1024;

const JOIN_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Relay session</title>
<main>
  <h1>Relay session</h1>
  <label>
    <input type="checkbox" id="consent">
    <span id="consent-label">I consent to publish this vault</span>
  </label>
  <button type="button" id="join" disabled>Join session</button>
  <section id="joined" hidden aria-label="Joined session">
    <p>Create status <span id="create-status"></span></p>
    <p>Generation <span id="generation"></span></p>
    <p>Ciphertext <span id="ct"></span></p>
  </section>
</main>
<script type="module">
const params = new URLSearchParams(location.search);
const owner = params.get("owner") ?? "";
const slug = params.get("slug") ?? "";
const principal = params.get("principal") ?? "";
const ownerKind = params.get("ownerKind") || "organization";
const slotKey = params.get("slotKey") ?? "";
const role = params.get("role") ?? "";
const relay = (params.get("relay") ?? "").replace(/\\/$/, "");
const api = (path) => (relay ? relay + path : path);
const snapshot = {
  format: "opensesame-vault-drive-snapshot",
  v: 1,
  tomb: slug,
  header: { v: 1, createdAt: "2026-10-07T00:00:00Z" },
  body: { ivB64: "aXY", ctB64: "Y2lwaGVydGV4dA" },
  rev: 1,
};
document.getElementById("consent-label").textContent = role === "a"
  ? "I consent to publish this vault"
  : "I consent to join this vault";
const consent = document.getElementById("consent");
const button = document.getElementById("join");
consent.addEventListener("change", () => {
  button.disabled = !consent.checked;
});
const show = (status, generation, ct) => {
  document.getElementById("create-status").textContent = status;
  document.getElementById("generation").textContent = generation;
  document.getElementById("ct").textContent = ct;
  document.getElementById("joined").hidden = false;
};
button.addEventListener("click", async () => {
  if (!consent.checked) return;
  button.disabled = true;
  try {
    const created = await fetch(api("/v1/org-vaults"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-principal": principal,
        "x-opensesame-org-role": role === "a" ? "owner" : "member",
      },
      body: JSON.stringify({ ownerKind, owner, slug }),
    });
    if (role === "a") {
      const put = await fetch(api("/v1/vault-relay/" + owner + "/" + slug + "/snapshot"), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-opensesame-slot-key": slotKey,
          "x-opensesame-principal": principal,
          "x-opensesame-owner-kind": ownerKind,
          "x-opensesame-org-role": "owner",
        },
        body: JSON.stringify({ expected_generation: 0, snapshot }),
      });
      const body = await put.json();
      show(String(created.status), String(body.generation ?? ""), snapshot.body.ctB64);
      return;
    }
    const got = await fetch(api("/v1/vault-relay/" + owner + "/" + slug + "/snapshot"), {
      headers: { "x-opensesame-slot-key": slotKey },
    });
    const body = await got.json();
    const ct = body && body.snapshot && body.snapshot.body ? body.snapshot.body.ctB64 : "";
    show(String(created.status), String(body.generation ?? ""), ct ?? "");
  } catch (error) {
    show("error", "", String(error));
  }
});
</script>
`;

function validSegment(value) {
  if (typeof value !== "string" || value === "guest") return false;
  if (value.length < 1 || value.length > 63) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(value);
}

function addressOf(owner, slug) {
  if (!validSegment(owner) || !validSegment(slug)) return null;
  return `${owner}/${slug}`;
}

/** Same admission as `member_allows` / `publish_allows` in the gateway. */
function memberAllows(action, ownerKind, principal, owner, role) {
  if (ownerKind === "user") {
    if (action === "list") return principal === "" || principal === owner;
    return principal === owner;
  }
  if (ownerKind !== "organization") return false;
  if (action === "list") return true;
  return role !== "member";
}

function publishAllows(ownerKind, principal, owner, role) {
  if (ownerKind === "user") return principal === "" || principal === owner;
  if (ownerKind !== "organization") return false;
  return role !== "member";
}

function snapshotOk(value) {
  return (
    !!value &&
    typeof value === "object" &&
    value.format === FORMAT &&
    value.v === 1
  );
}

function presentedKey(raw) {
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) return null;
  return raw;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error("too_large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response, status, body, type) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type":
      type ?? (typeof body === "string" ? "text/plain" : "application/json"),
    "cache-control": "no-store",
  });
  response.end(payload);
}

/**
 * @returns {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>}
 */
export function createRelayHandler() {
  /** @type {Map<string, { key: string, generation: number, snapshot: unknown, principal: string, ownerKind: string }>} */
  const slots = new Map();
  /** @type {Map<string, { ownerKind: string, owner: string, slug: string, principal: string }>} */
  const directory = new Map();

  const remember = (address, ownerKind, principal) => {
    const [owner, slug] = address.split("/");
    const current = directory.get(address);
    if (current) {
      current.ownerKind = ownerKind;
      if (principal) current.principal = principal;
      return;
    }
    directory.set(address, {
      ownerKind,
      owner: owner ?? "",
      slug: slug ?? "",
      principal,
    });
  };

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/health/live") {
      send(response, 200, "ok");
      return;
    }
    if (method === "GET" && url.pathname === "/health/relay") {
      send(response, 200, {
        profile: "relay",
        purpose: "vault_relay",
        bindings: "vault_relay",
        document: "empty",
        durable: true,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/join.html") {
      send(response, 200, JOIN_HTML, "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/v1/org-vaults" && method === "GET") {
      const principal = url.searchParams.get("principal") ?? "";
      const owner = url.searchParams.get("owner") ?? "";
      if (!principal && !owner) {
        send(response, 200, { vaults: [] });
        return;
      }
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
      send(response, 200, { vaults });
      return;
    }
    if (url.pathname === "/v1/org-vaults" && method === "POST") {
      let parsed;
      try {
        parsed = JSON.parse(String(await readBody(request)) || "{}");
      } catch {
        send(response, 400, { error: "malformed" });
        return;
      }
      const ownerKind = parsed.ownerKind;
      if (ownerKind !== "user" && ownerKind !== "organization") {
        send(response, 400, { error: "malformed" });
        return;
      }
      const address = addressOf(parsed.owner, parsed.slug);
      const principal = String(request.headers["x-opensesame-principal"] ?? "");
      const role = String(request.headers["x-opensesame-org-role"] ?? "");
      if (!address || !principal) {
        send(response, 400, { error: "malformed" });
        return;
      }
      if (role && role !== "owner" && role !== "admin" && role !== "member") {
        send(response, 400, { error: "malformed" });
        return;
      }
      if (!memberAllows("create", ownerKind, principal, parsed.owner, role)) {
        send(response, 403, { error: "forbidden" });
        return;
      }
      const current = directory.get(address);
      if (current && current.principal !== principal) {
        send(response, 409, { error: "claimed" });
        return;
      }
      if (current) {
        send(response, 200, {
          vault: {
            ownerKind: current.ownerKind,
            owner: current.owner,
            slug: current.slug,
          },
        });
        return;
      }
      remember(address, ownerKind, principal);
      send(response, 201, {
        vault: { ownerKind, owner: parsed.owner, slug: parsed.slug },
      });
      return;
    }
    const slotMatch = url.pathname.match(
      /^\/v1\/vault-relay\/([^/]+)\/([^/]+)\/snapshot$/,
    );
    if (slotMatch) {
      const owner = decodeURIComponent(slotMatch[1] ?? "");
      const slug = decodeURIComponent(slotMatch[2] ?? "");
      const address = addressOf(owner, slug);
      if (!address) {
        send(response, 404, { error: "not_found" });
        return;
      }
      const key = presentedKey(request.headers["x-opensesame-slot-key"]);
      if (!key) {
        send(response, 401, { error: "unauthorized" });
        return;
      }
      if (method === "GET") {
        const slot = slots.get(address);
        if (!slot) {
          send(response, 404, { error: "not_found" });
          return;
        }
        if (slot.key !== key) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        send(response, 200, {
          generation: slot.generation,
          snapshot: slot.snapshot,
        });
        return;
      }
      if (method === "PUT") {
        let parsed;
        try {
          parsed = JSON.parse(String(await readBody(request)) || "{}");
        } catch {
          send(response, 400, { error: "malformed" });
          return;
        }
        if (!snapshotOk(parsed.snapshot)) {
          send(response, 400, { error: "malformed" });
          return;
        }
        const principal = String(
          request.headers["x-opensesame-principal"] ?? "",
        ).slice(0, 128);
        const ownerKindHeader = request.headers["x-opensesame-owner-kind"];
        const ownerKind =
          ownerKindHeader === "organization" ? "organization" : "user";
        const role = String(request.headers["x-opensesame-org-role"] ?? "");
        if (role && role !== "owner" && role !== "admin" && role !== "member") {
          send(response, 400, { error: "malformed" });
          return;
        }
        if (!publishAllows(ownerKind, principal, owner, role)) {
          send(response, 403, { error: "forbidden" });
          return;
        }
        const claimed = directory.get(address);
        if (
          claimed?.principal &&
          principal &&
          claimed.principal !== principal
        ) {
          send(response, 409, { error: "claimed" });
          return;
        }
        const slot = slots.get(address);
        if (slot) {
          if (slot.key !== key) {
            send(response, 401, { error: "unauthorized" });
            return;
          }
          if (slot.generation !== parsed.expected_generation) {
            send(response, 409, { generation: slot.generation });
            return;
          }
          slot.generation += 1;
          slot.snapshot = parsed.snapshot;
          remember(address, ownerKind, principal);
          send(response, 200, { generation: slot.generation });
          return;
        }
        if (parsed.expected_generation !== 0) {
          send(response, 404, { error: "not_found" });
          return;
        }
        slots.set(address, {
          key,
          generation: 1,
          snapshot: parsed.snapshot,
          principal,
          ownerKind,
        });
        remember(address, ownerKind, principal);
        send(response, 200, { generation: 1 });
        return;
      }
    }
    send(response, 404, { error: "not_found" });
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((done, fail) => {
    server.close((error) => (error ? fail(error) : done()));
  });
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

function repoRoot() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function relayCommand(root, listenAddr) {
  const args = ["host", "run", "--profile", "relay", "--listen", listenAddr];
  const named = process.env.OPENSESAME_RELAY_BIN;
  if (named) return { cmd: named, args };
  const built = path.join(root, "target/debug/opensesame");
  if (existsSync(built)) return { cmd: built, args };
  return {
    cmd: "cargo",
    args: [
      "run",
      "-q",
      "-p",
      "opensesame-cli",
      "--bin",
      "opensesame",
      "--",
      ...args,
    ],
  };
}

async function waitForLive(origin, child, timeoutMs) {
  const started = Date.now();
  let log = "";
  const take = (chunk) => {
    log = `${log}${chunk}`.slice(-4000);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`relay exited ${child.exitCode}\n${log}`);
    }
    try {
      const response = await fetch(`${origin}/health/live`);
      if (response.status === 200 && (await response.text()) === "ok") return;
    } catch {
      // The process is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`relay did not answer ${origin}\n${log}`);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Gateway relay profile. Uses `OPENSESAME_RELAY_URL` when a process is
 * already up. Otherwise spawns `opensesame host run --profile relay`.
 */
export async function startLiveRelay() {
  const page = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if ((request.method ?? "GET") === "GET" && url.pathname === "/join.html") {
      send(response, 200, JOIN_HTML, "text/html; charset=utf-8");
      return;
    }
    send(response, 404, { error: "not_found" });
  });
  const pageOrigin = await listen(page);
  const already = process.env.OPENSESAME_RELAY_URL?.replace(/\/$/, "");
  if (already) {
    await waitForLive(already, { exitCode: null }, 5_000);
    return {
      origin: already,
      pageOrigin,
      live: true,
      close: () => closeServer(page),
    };
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const root = repoRoot();
  const command = relayCommand(root, `127.0.0.1:${port}`);
  const env = { ...process.env };
  env.OPENSESAME_SERVICE_BINDINGS_FILE = undefined;
  const child = spawn(command.cmd, command.args, {
    cwd: root,
    env: {
      ...env,
      OPENSESAME_GATEWAY_PROFILE: "relay",
      OPENSESAME_CORS_ORIGINS: pageOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForLive(
      origin,
      child,
      command.cmd === "cargo" ? 180_000 : 30_000,
    );
  } catch (error) {
    await stopChild(child);
    await closeServer(page);
    throw error;
  }
  return {
    origin,
    pageOrigin,
    live: true,
    close: async () => {
      await stopChild(child);
      await closeServer(page);
    },
  };
}

/**
 * Listen on loopback. `live: true` spawns the gateway relay profile.
 * The default is the in-process harness. The journeys-1 shard passes
 * `live: true`.
 */
export function startVaultRelay(options = {}) {
  if (options.live) return startLiveRelay();
  return startRelayHarness();
}
