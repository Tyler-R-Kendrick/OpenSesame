import {
  ADR,
  HANDOFF,
  NATIVE_ONLY,
  WALLET_ONLY,
} from "./password-workflows.js";
import type { Capability } from "./types.js";

const NATIVE_APPROVAL = {
  reason:
    "native provider requests and leases require the human CLI and its terminal approval; the PWA holds neither the lease store nor the provider session, and no MCP surface grants authority over them",
  adr: ADR,
};

/** Requests and leases belong to the native CLI; the browser has no custody of either. */
export const passwordRequestCapabilities: readonly Capability[] = [
  {
    id: "password_provider.request",
    title: "Send a bound native request",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id request",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: NATIVE_ONLY,
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "password_provider.lease_approve",
    title: "Approve a bounded native lease",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id lease approve",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: NATIVE_ONLY,
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "password_provider.lease_status",
    title: "Inspect native lease metadata",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id lease status",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: NATIVE_ONLY,
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "password_provider.lease_revoke",
    title: "Revoke a native lease",
    plane: "client_local",
    kind: "admin",
    surfaces: {
      cli: "opensesame-id lease revoke",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: NATIVE_ONLY,
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
];
