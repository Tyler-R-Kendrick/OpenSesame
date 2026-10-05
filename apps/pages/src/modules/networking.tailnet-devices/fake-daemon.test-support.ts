/**
 * A daemon's tailnet routes in memory, behind a fake egress port, for the
 * panel tests: the real client sends real requests and reads real answers in
 * the daemon's shape (`spec/conformance/tailnet-admin-protocol.json`).
 */

import type { EgressPort } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  type TailnetAdmin,
  tailnetAdmin,
  tailnetAdminSeams,
} from "@opensesame/app-core/lib/tailnet-admin/client.js";
import type { TailnetRole } from "@opensesame/app-core/lib/tailnet-admin/pairing.js";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import { screen } from "@testing-library/react";

export type WireDevice = JsonObject & { id: string };

export function wireDevice(overrides: JsonObject & { id: string }): WireDevice {
  return {
    name: `${String(overrides.id)}.tail4c2e.ts.net`,
    hostname: String(overrides.id),
    os: "linux",
    client_version: "1.80.2",
    update_available: false,
    user: "amelie@example.com",
    addresses: ["100.101.102.103"],
    tags: [],
    authorized: true,
    external: false,
    ephemeral: false,
    key_expiry_disabled: false,
    expires: "2027-03-01T00:00:00Z",
    created: "2026-09-01T00:00:00Z",
    last_seen: "2026-10-05T09:00:00Z",
    connected: true,
    blocks_incoming: false,
    ssh_enabled: false,
    multiple_connections: false,
    advertised_routes: [],
    enabled_routes: [],
    tailnet_lock_error: null,
    ...overrides,
  };
}

export type Call = { method: string; path: string; body: BoundaryValue };

export type FakeDaemon = {
  devices: WireDevice[];
  keys: JsonObject[];
  calls: Call[];
  /** Answer the next matching call with this refusal instead. */
  refuse: { path: string; status: number; body: JsonObject } | null;
  credential: "oauth" | "api_key";
};

function json(status: number, body: BoundaryValue): Response {
  return body === null
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
}

const field = (body: BoundaryValue, name: string) =>
  isJsonObject(body) ? body[name] : null;

function readRoute(daemon: FakeDaemon, path: string): Response | null {
  if (path.endsWith("/status"))
    return json(200, {
      connected: true,
      tailnet: "example.com",
      credential: daemon.credential,
      connected_at: 1,
      role: "manage",
      label: "Ops laptop",
    });
  if (path.endsWith("/devices")) return json(200, { devices: daemon.devices });
  if (path.endsWith("/keys")) return json(200, { keys: daemon.keys });
  if (path.endsWith("/audit")) return json(200, { entries: [] });
  return null;
}

function mintKey(daemon: FakeDaemon, body: BoundaryValue): Response {
  const get = (name: string) => field(body, name);
  const created = {
    id: "kNEW9CNTRL",
    description: get("description"),
    created: "2026-10-05T09:01:00Z",
    expires: "2026-10-06T09:01:00Z",
    revoked: null,
    invalid: false,
    reusable: get("reusable"),
    ephemeral: get("ephemeral"),
    preauthorized: get("preauthorized"),
    tags: get("tags"),
    key: "tskey-auth-kNEW9CNTRL-Secret0Value",
  };
  daemon.keys.push({ ...created, key: null });
  return json(201, created);
}

function changeDevice(device: WireDevice, what: string, body: BoundaryValue) {
  const get = (name: string) => field(body, name);
  if (what === "authorized") device.authorized = get("authorized") === true;
  if (what === "name") device.name = `${String(get("name"))}.tail4c2e.ts.net`;
  if (what === "tags") device.tags = get("tags") ?? [];
  if (what === "key-expiry")
    device.key_expiry_disabled = get("disabled") === true;
  if (what === "expire") device.expires = "2026-10-05T09:59:00Z";
  if (what !== "routes") return json(204, null);
  device.enabled_routes = get("enabled_routes") ?? [];
  return json(200, {
    advertised_routes: device.advertised_routes,
    enabled_routes: device.enabled_routes,
  });
}

function route(daemon: FakeDaemon, call: Call): Response {
  const { method, path, body } = call;
  if (method === "GET") return readRoute(daemon, path) ?? json(404, null);
  const parts = path.replace("/v1/tailnet/", "").split("/");
  if (method === "POST" && path.endsWith("/keys")) return mintKey(daemon, body);
  if (method === "DELETE" && parts[0] === "keys") {
    daemon.keys = daemon.keys.filter((k) => k.id !== parts[1]);
    return json(204, null);
  }
  const device = daemon.devices.find((d) => d.id === parts[1]);
  if (!device) return json(404, { error: "not_found" });
  if (method === "DELETE") {
    daemon.devices = daemon.devices.filter((d) => d !== device);
    return json(204, null);
  }
  return changeDevice(device, parts[2] ?? "", body);
}

/** A client paired with role `role`, talking to `daemon` through a fake egress. */
export function pairedClient(
  daemon: FakeDaemon,
  role: TailnetRole = "manage",
): TailnetAdmin {
  tailnetAdminSeams.pairing = () => ({
    url: "https://desk.tail4c2e.ts.net",
    token: "t".repeat(43),
    origin: "https://ops.example.com",
    role,
    label: "Ops laptop",
  });
  tailnetAdminSeams.revision = () => 1;
  tailnetAdminSeams.subscribe = () => () => undefined;
  const egress: EgressPort = {
    async fetch(input, init) {
      const url = new URL(String(input));
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      daemon.calls.push(call);
      const refusal = daemon.refuse;
      if (refusal && refusal.path === call.path) {
        daemon.refuse = null;
        return json(refusal.status, refusal.body);
      }
      return route(daemon, call);
    },
  };
  return tailnetAdmin(egress, "networking.tailnet-devices");
}

export function fakeDaemon(devices: WireDevice[]): FakeDaemon {
  return { devices, keys: [], calls: [], refuse: null, credential: "api_key" };
}

export const originalSeams = { ...tailnetAdminSeams };

/** A phone that joined and waits for approval. */
export const pending = (): WireDevice =>
  wireDevice({
    id: "nPHONE",
    name: "sams-phone.tail4c2e.ts.net",
    os: "iOS",
    authorized: false,
    connected: false,
    last_seen: null,
  });
/** A subnet router offering an exit node, none of it approved. */
export const router = (): WireDevice =>
  wireDevice({
    id: "nROUTER",
    name: "router.tail4c2e.ts.net",
    update_available: true,
    advertised_routes: ["10.0.0.0/16", "0.0.0.0/0", "::/0"],
    enabled_routes: [],
  });

/** The list item a device's heading is in. */
export function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("heading", { name }).closest("li");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}
