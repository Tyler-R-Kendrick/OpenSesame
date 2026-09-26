import { APPROVAL_ROUTING } from "./exclusions.js";
import type { Capability } from "./index.js";

/**
 * Where a person hears about requests (ADR 0084): the Identity API's
 * channels, the destinations a person binds, and the order each kind of
 * prompt tries them. The PWA carries all three in Settings › Notifications,
 * the optional `notifications.routing` capability (ADR 0140 D9). No agent
 * surface does: where a prompt appears is who gets to approve it.
 */
export const notificationRoutingCapabilities: readonly Capability[] = [
  {
    id: "identity.notification.channels.read",
    title: "List notification channels and what each can do",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_ROUTING,
      mcp_client: APPROVAL_ROUTING,
      webmcp: APPROVAL_ROUTING,
    },
  },
  {
    id: "identity.notification.bindings.manage",
    title: "Bind, verify, or revoke a notification destination",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_ROUTING,
      mcp_client: APPROVAL_ROUTING,
      webmcp: APPROVAL_ROUTING,
    },
  },
  {
    id: "identity.notification.preferences.manage",
    title: "Read or change where authorization prompts are delivered",
    plane: "identity",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_ROUTING,
      mcp_client: APPROVAL_ROUTING,
      webmcp: APPROVAL_ROUTING,
    },
  },
];
