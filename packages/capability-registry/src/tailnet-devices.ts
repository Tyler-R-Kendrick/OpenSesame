import { ADR_TAILNET_DEVICES } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Tailnet device management (ADR 0169): the daemon holds the Tailscale
 * credential and makes every call; a page manages the tailnet's machines
 * through it with an origin- and role-bound bearer, and the operator does the
 * same from a terminal with `opensesame daemon tailnet`.
 */

/** Admitting, re-keying and removing machines is a human-plane act. */
const DEVICE_ADMIN_HUMAN: CapabilityExclusion = {
  reason:
    "approving, re-keying and removing a tailnet's machines decides who reaches the network; it is a human-plane act, never an agent tool",
  adr: ADR_TAILNET_DEVICES,
};

/** The Tailscale credential is configured where it is kept: on the daemon. */
const CREDENTIAL_ON_THE_DAEMON: CapabilityExclusion = {
  reason:
    "the Tailscale credential is written into the daemon's own state from its terminal and never reaches a browser",
  adr: ADR_TAILNET_DEVICES,
};

const AGENTS_WITHHELD = {
  mcp_host: DEVICE_ADMIN_HUMAN,
  mcp_client: DEVICE_ADMIN_HUMAN,
  webmcp: DEVICE_ADMIN_HUMAN,
} as const;

const CLIENT = "lib/tailnet-admin/client.ts:tailnetAdmin";

export const tailnetDeviceCapabilities: readonly Capability[] = [
  {
    id: "tailnet.connect",
    title: "Connect the daemon to a tailnet with a Tailscale credential",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame daemon tailnet connect",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { ...AGENTS_WITHHELD, pwa: CREDENTIAL_ON_THE_DAEMON },
  },
  {
    id: "tailnet.devices.pair",
    title: "Pair a page with the daemon for tailnet device management",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame daemon tailnet pair",
      pwa: CLIENT,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "tailnet.devices.read",
    title: "List the tailnet's devices and what about each needs someone",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame daemon tailnet devices",
      pwa: CLIENT,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "tailnet.devices.manage",
    title:
      "Approve, rename, tag, re-key, route and remove the tailnet's devices",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame daemon tailnet approve",
      pwa: CLIENT,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "tailnet.keys.manage",
    title: "Add a device with a Tailscale auth key, list and revoke keys",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame daemon tailnet mint",
      pwa: CLIENT,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "tailnet.audit.read",
    title: "Read what was changed on the tailnet through the daemon",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame daemon tailnet audit",
      pwa: CLIENT,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
];
