import { ADR, HANDOFF, WALLET_ONLY } from "./password-workflows.js";
import type { Capability } from "./types.js";

const NATIVE_APPROVAL = {
  reason:
    "native provider requests and leases require the human CLI; PWA prepares reviewable commands only, and the MCP guide grants neither state access nor authority",
  adr: ADR,
};

/** PWA exposure is an explicit human command handoff, never native execution. */
export const passwordRequestCapabilities: readonly Capability[] = [
  {
    id: "password_provider.request",
    title: "Send a bound native request (PWA command handoff)",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id request",
      pwa: "lib/password-agent/native-handoff.ts:nativeRequestCommands",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "password_provider.lease_approve",
    title: "Approve a bounded native lease (PWA command handoff)",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id lease approve",
      pwa: "lib/password-agent/native-handoff.ts:nativeRequestCommands",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "password_provider.lease_status",
    title: "Inspect native lease metadata (PWA command handoff)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id lease status",
      pwa: "lib/password-agent/native-handoff.ts:nativeRequestCommands",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "password_provider.lease_revoke",
    title: "Revoke a native lease (PWA command handoff)",
    plane: "client_local",
    kind: "admin",
    surfaces: {
      cli: "opensesame-id lease revoke",
      pwa: "lib/password-agent/native-handoff.ts:nativeRequestCommands",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NATIVE_APPROVAL,
      mcp_client: NATIVE_APPROVAL,
      webmcp: NATIVE_APPROVAL,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
];
