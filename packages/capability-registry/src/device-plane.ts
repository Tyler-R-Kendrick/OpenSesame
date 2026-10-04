import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * What the device does as its own Identity plane (ADR 0160, ADR 0162): the
 * receipts of its decisions and, in Settings, how it tells its person that a
 * request is waiting. Both are the person's own: neither has an agent surface.
 */
const ADR_DEVICE_INBOX =
  "0162-device-receipts-inbox-and-local-notifications.md";

/**
 * The trail records which of a principal's requests were refused. An agent
 * that could read it could learn what to route around, one refusal at a time.
 */
const RECEIPTS_ARE_THE_PERSONS: CapabilityExclusion = {
  reason:
    "the device's receipts record which requests were approved and which refused; an agent that could read them could learn what to route around",
  adr: ADR_DEVICE_INBOX,
};

/**
 * Where a request is announced is who hears of it first. An agent that could
 * turn the doorbell off, or aim it elsewhere, could keep its own principal's
 * requests from being seen; the same reason as for a remote destination
 * (`APPROVAL_ROUTING`, ADR 0084), for the device's own.
 */
const LOCAL_DOORBELL: CapabilityExclusion = {
  reason:
    "choosing how this device announces a waiting request decides who notices it; an agent that could change that could keep its own requests from being seen",
  adr: ADR_DEVICE_INBOX,
};

export const devicePlaneCapabilities: readonly Capability[] = [
  {
    id: "identity.notification.local.manage",
    title: "Choose how this device tells its person a request is waiting",
    plane: "client_local",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: LOCAL_DOORBELL,
      mcp_client: LOCAL_DOORBELL,
      webmcp: LOCAL_DOORBELL,
    },
  },
  {
    id: "identity.local.receipts.read",
    title: "Read the receipts of what this device decided for its person",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: RECEIPTS_ARE_THE_PERSONS,
      mcp_client: RECEIPTS_ARE_THE_PERSONS,
      webmcp: RECEIPTS_ARE_THE_PERSONS,
    },
  },
];
